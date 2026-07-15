import { WebSocketProvider } from 'ethers'
import { env } from '../config/env.js'
import { createChildLogger } from './logger.js'

const log = createChildLogger('ws-manager')

// ── Resilient WebSocket manager ───────────────────────────────────────────────
// ethers v6 WebSocketProvider does NOT auto-reconnect: if the socket drops, every
// eth_subscribe dies silently and the bot goes blind. Since the whole pipeline is
// push-based (PairCreated + Sync + Transfer subscriptions), this manager:
//
//   1. Owns the WebSocketProvider lifecycle (create → monitor → destroy → recreate)
//   2. Re-applies registered subscription factories after every reconnect
//   3. Detects dead connections with WS ping/pong frames — protocol frames, NOT
//      JSON-RPC requests, so the heartbeat costs ZERO QuickNode credits
//   4. Reconnects with exponential backoff (1s → 15s)
//
// Consumers register a factory keyed by a stable id. The factory receives the
// live provider and may return a cleanup fn (used on unregister/disconnect).

const PING_INTERVAL_MS = 30_000
const PONG_TIMEOUT_MS = 10_000
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 15_000

/** Structural type for the Node `ws` socket ethers wraps — avoids a direct dep on `ws`. */
interface NodeWebSocketLike {
  on(event: 'open' | 'close' | 'pong' | 'error', listener: (...args: unknown[]) => void): void
  ping(): void
  terminate(): void
}

export type SubscriptionCleanup = () => void

export type SubscriptionFactory = (
  provider: WebSocketProvider,
  isReconnect: boolean,
) => void | SubscriptionCleanup | Promise<void | SubscriptionCleanup>

export class WsManager {
  private currentProvider: WebSocketProvider | null = null
  private readonly factories = new Map<string, SubscriptionFactory>()
  private readonly cleanups = new Map<string, SubscriptionCleanup>()
  private started = false
  private stopped = false
  private everConnected = false
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private pongTimer: NodeJS.Timeout | null = null

  /** WS is configured — consumers use this to pick push vs polling-fallback mode. */
  get enabled(): boolean {
    return Boolean(env.ROBBINHOOD_WS_URL)
  }

  /** Current live provider, or null while disconnected. */
  get provider(): WebSocketProvider | null {
    return this.currentProvider
  }

  start(): void {
    if (!this.enabled) {
      log.warn('ROBBINHOOD_WS_URL not set — WS manager disabled, consumers fall back to polling')
      return
    }
    if (this.started) return
    this.started = true
    this.stopped = false
    this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.started = false
    this.clearTimers()
    this.runCleanups()
    const provider = this.currentProvider
    this.currentProvider = null
    if (provider) {
      try {
        await provider.destroy()
      } catch {
        // socket may already be closed
      }
    }
    log.info('WS manager stopped')
  }

  /**
   * Register a subscription factory. Applied immediately if connected, and
   * re-applied after every reconnect. The factory may return a cleanup fn.
   */
  register(key: string, factory: SubscriptionFactory): void {
    this.factories.set(key, factory)
    if (this.currentProvider) {
      void this.applyFactory(key, factory, this.currentProvider, false)
    }
  }

  /** Remove a subscription and run its cleanup (e.g. contract.off). */
  unregister(key: string): void {
    this.factories.delete(key)
    const cleanup = this.cleanups.get(key)
    if (cleanup) {
      this.cleanups.delete(key)
      try {
        cleanup()
      } catch {
        // provider may already be dead — cleanup is best-effort
      }
    }
  }

  // ── Connection lifecycle ─────────────────────────────────────────────────────

  private connect(): void {
    if (this.stopped) return

    let provider: WebSocketProvider
    try {
      provider = new WebSocketProvider(env.ROBBINHOOD_WS_URL!, env.ROBBINHOOD_CHAIN_ID, {
        // Skip eth_chainId network detection on every (re)connect
        staticNetwork: true,
      })
    } catch (err) {
      log.error({ err }, 'Failed to construct WebSocketProvider — scheduling retry')
      this.scheduleReconnect()
      return
    }

    this.currentProvider = provider
    const isReconnect = this.everConnected

    const ws = provider.websocket as unknown as NodeWebSocketLike

    ws.on('open', () => {
      this.everConnected = true
      this.reconnectAttempt = 0
      this.startHeartbeat(ws)
      log.info({ isReconnect }, 'WebSocket connected')
    })

    // ethers installs its own onerror handler; 'close' always follows a fatal error
    ws.on('close', () => {
      this.handleDisconnect('socket closed')
    })

    // Apply all registered subscriptions. ethers queues sends until the socket
    // opens, so subscriptions land the instant the connection is established —
    // no extra latency on the detection path.
    for (const [key, factory] of this.factories) {
      void this.applyFactory(key, factory, provider, isReconnect)
    }
  }

  private async applyFactory(
    key: string,
    factory: SubscriptionFactory,
    provider: WebSocketProvider,
    isReconnect: boolean,
  ): Promise<void> {
    try {
      const cleanup = await factory(provider, isReconnect)
      // Guard: connection may have died while the factory was running
      if (this.currentProvider !== provider) {
        if (cleanup) {
          try {
            cleanup()
          } catch { /* stale provider */ }
        }
        return
      }
      if (cleanup) this.cleanups.set(key, cleanup)
    } catch (err) {
      log.error({ err, key }, 'Subscription factory failed — will retry on next reconnect')
    }
  }

  private handleDisconnect(reason: string): void {
    if (this.stopped) return
    // Ignore close events from an already-replaced provider
    this.clearTimers()
    this.runCleanups()

    const provider = this.currentProvider
    this.currentProvider = null
    if (provider) {
      try {
        void provider.destroy()
      } catch {
        // already closed
      }
    }

    log.warn({ reason, attempt: this.reconnectAttempt + 1 }, 'WebSocket disconnected — reconnecting')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    )
    this.reconnectAttempt++
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  // ── Zero-cost heartbeat (WS protocol frames, not JSON-RPC) ──────────────────

  private startHeartbeat(ws: NodeWebSocketLike): void {
    ws.on('pong', () => {
      if (this.pongTimer) {
        clearTimeout(this.pongTimer)
        this.pongTimer = null
      }
    })

    this.pingTimer = setInterval(() => {
      try {
        ws.ping()
      } catch {
        // send failed — terminate triggers 'close' → reconnect
        try {
          ws.terminate()
        } catch { /* already dead */ }
        return
      }
      if (this.pongTimer) return // previous ping still pending — timeout will fire
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null
        log.warn('WebSocket pong timeout — terminating stale connection')
        try {
          ws.terminate()
        } catch { /* already dead */ }
      }, PONG_TIMEOUT_MS)
    }, PING_INTERVAL_MS)
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private runCleanups(): void {
    for (const cleanup of this.cleanups.values()) {
      try {
        cleanup()
      } catch {
        // dead provider — ignore
      }
    }
    this.cleanups.clear()
  }
}

export const wsManager = new WsManager()
