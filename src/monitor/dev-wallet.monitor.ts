import { Contract } from 'ethers'
import { rhProvider } from '../utils/robbinhood.utils.js'
import { wsManager } from '../utils/ws-manager.js'
import { env } from '../config/env.js'
import { createChildLogger } from '../utils/logger.js'
import { sendTelegramAlert } from '../utils/telegram.js'
import type { Position } from '../database/schema.js'

const log = createChildLogger('dev-wallet-monitor')

// ── Dev wallet monitor (EVM) ─────────────────────────────────────────────────
// Watches the deployer's ERC-20 token balance for dump activity.
// If the dev transfers/sells more than DEV_SELL_ABANDON_PCT % of their initial
// tokens, fires the onDevDump callback to trigger an emergency position abandon.
//
// EVM approach (replaces Solana onAccountChange):
//   1. On watch(): query initial balance via balanceOf(deployerAddress)
//   2. Subscribe to Transfer events with `from = deployer` as an INDEXED TOPIC
//      FILTER — the node filters server-side, so only the deployer's own
//      transfers generate (billed) push notifications, not every trade on the
//      token. Managed by wsManager so subscriptions survive reconnects.
//   3. On each Transfer from deployer → re-query balance, compute %
//   4. Fallback: poll balanceOf every POLL_INTERVAL_MS when WS is unavailable
//
// This catches rug pulls BEFORE the pair price adjusts:
//   dev sends tokens → balance drops (this catches it ASAP)
//                     → pair reserves update (PositionManager catches it later)

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]

/** Polling interval when WebSocket is unavailable (ms). */
const POLL_INTERVAL_MS = 3_000

interface DevWatch {
  tokenContract: Contract
  deployerAddress: string
  initialBalanceRaw: bigint
  /** Cleanup: clears the polling timer (WS cleanup lives in wsManager). */
  unsubscribe: () => void
}

export type DevDumpCallback = (positionId: string, deployerAddress: string, soldPct: number) => void

export class DevWalletMonitor {
  private readonly watches = new Map<string, DevWatch>()
  private readonly onDevDump: DevDumpCallback

  constructor(onDevDump: DevDumpCallback) {
    this.onDevDump = onDevDump
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /**
   * Start monitoring the deployer's token balance for a newly opened position.
   * Safe to call even if deployerAddress is missing — silently skips.
   */
  async watch(position: Position): Promise<void> {
    const deployerAddress = position.metadata?.deployerAddress as string | undefined
    if (!deployerAddress) return

    // Idempotency — already watching this position
    if (this.watches.has(position.id)) return

    try {
      const tokenContract = new Contract(position.tokenAddress, ERC20_ABI, rhProvider)
      const initialBalanceRaw: bigint = await tokenContract.balanceOf!(deployerAddress)

      if (initialBalanceRaw === 0n) {
        log.debug(
          { positionId: position.id, deployerAddress },
          'Dev has no tokens — skipping monitor',
        )
        return
      }

      // Set up monitoring — prefers WebSocket push, falls back to polling
      let unsubscribe: () => void

      if (wsManager.enabled) {
        unsubscribe = this.subscribeWs(
          position.id,
          position.tokenAddress,
          deployerAddress,
          tokenContract,
          initialBalanceRaw,
        )
      } else {
        unsubscribe = this.subscribePoll(
          position.id,
          tokenContract,
          deployerAddress,
          initialBalanceRaw,
        )
      }

      this.watches.set(position.id, {
        tokenContract,
        deployerAddress,
        initialBalanceRaw,
        unsubscribe,
      })

      log.info(
        {
          positionId: position.id,
          deployerAddress,
          tokenAddress: position.tokenAddress.slice(0, 10),
          initialBalance: initialBalanceRaw.toString(),
        },
        'Dev wallet monitor started',
      )
    } catch (err) {
      log.warn(
        { err, positionId: position.id, deployerAddress },
        'Failed to start dev wallet monitor — non-fatal',
      )
    }
  }

  /** Stop monitoring a position (e.g. when it closes). */
  unwatch(positionId: string): void {
    const watch = this.watches.get(positionId)
    if (!watch) return

    try {
      watch.unsubscribe()
    } catch {
      // Connection may already be closed — safe to ignore
    }
    this.watches.delete(positionId)
    log.debug({ positionId }, 'Dev wallet monitor stopped')
  }

  /** Unsubscribe all watchers. Call on shutdown. */
  async stop(): Promise<void> {
    for (const [positionId] of this.watches) {
      this.unwatch(positionId)
    }
    log.info('DevWalletMonitor stopped')
  }

  // ── WebSocket path (fast, preferred) ───────────────────────────────────────

  private wsKey(positionId: string): string {
    return `dev-wallet:${positionId}`
  }

  private subscribeWs(
    positionId: string,
    tokenAddress: string,
    deployerAddress: string,
    tokenContract: Contract,
    initialBalanceRaw: bigint,
  ): () => void {
    const key = this.wsKey(positionId)
    const deployerLower = deployerAddress.toLowerCase()

    // Registered through wsManager so the subscription is re-created after a
    // WS reconnect instead of dying silently.
    wsManager.register(key, (provider) => {
      const wsContract = new Contract(tokenAddress, ERC20_ABI, provider)

      const handler = async (from: string, _to: string, _value: bigint) => {
        // Server-side topic filter already narrows to the deployer; keep a
        // cheap guard in case of a stale/misrouted event.
        if (typeof from === 'string' && from.toLowerCase() !== deployerLower) return
        await this.checkBalance(positionId, tokenContract, deployerAddress, initialBalanceRaw)
      }

      // Indexed topic filter: eth_subscribe with topics [Transfer, from=deployer].
      // Only the deployer's outgoing transfers generate push notifications.
      // .catch: a rejected subscribe must not become a fatal unhandledRejection
      const filter = wsContract.filters.Transfer!(deployerAddress)
      wsContract.on(filter, handler).catch((err) => {
        log.warn({ err, positionId }, 'Transfer subscribe failed — wsManager will retry on reconnect')
      })

      return () => {
        wsContract.off(filter, handler).catch(() => { /* socket already dead */ })
      }
    })

    return () => {
      wsManager.unregister(key)
    }
  }

  // ── Polling fallback (when WebSocket unavailable) ──────────────────────────

  private subscribePoll(
    positionId: string,
    tokenContract: Contract,
    deployerAddress: string,
    initialBalanceRaw: bigint,
  ): () => void {
    const intervalId = setInterval(() => {
      void this.checkBalance(positionId, tokenContract, deployerAddress, initialBalanceRaw)
    }, POLL_INTERVAL_MS)

    return () => clearInterval(intervalId)
  }

  // ── Balance check + threshold logic (shared) ───────────────────────────────

  private async checkBalance(
    positionId: string,
    tokenContract: Contract,
    deployerAddress: string,
    initialBalanceRaw: bigint,
  ): Promise<void> {
    // Guard: watch may have been removed between event and handler execution
    const watch = this.watches.get(positionId)
    if (!watch) return

    let currentBalanceRaw: bigint
    try {
      currentBalanceRaw = await tokenContract.balanceOf!(deployerAddress)
    } catch {
      return // RPC hiccup — skip this check, next one will catch up
    }

    // No net sell (balance same or increased)
    if (currentBalanceRaw >= initialBalanceRaw) return

    const soldRaw = initialBalanceRaw - currentBalanceRaw
    // Calculate percentage with 2 decimal precision using bigint arithmetic
    const soldPct = Number(soldRaw * 10_000n / initialBalanceRaw) / 100

    if (soldPct < env.DEV_SELL_ABANDON_PCT) {
      // Below threshold — log at debug level so operators can see the pattern
      log.debug(
        {
          positionId,
          soldPct: soldPct.toFixed(2),
          threshold: env.DEV_SELL_ABANDON_PCT,
          initialBalance: initialBalanceRaw.toString(),
          currentBalance: currentBalanceRaw.toString(),
        },
        'Dev sold below threshold — monitoring continues',
      )
      return
    }

    // ── THRESHOLD BREACHED ──────────────────────────────────────────────────
    log.warn(
      {
        positionId,
        soldPct: soldPct.toFixed(2),
        thresholdPct: env.DEV_SELL_ABANDON_PCT,
        initialBalance: initialBalanceRaw.toString(),
        currentBalance: currentBalanceRaw.toString(),
      },
      'DEV DUMP DETECTED — emergency abandoning position',
    )

    // Unsubscribe immediately — only trigger once per position
    this.unwatch(positionId)

    // Telegram alert (fire-and-forget — must not block the sell path)
    void sendTelegramAlert(
      `🚨 <b>DEV DUMP ALERT — EMERGENCY ABANDON</b>\n\n` +
        `Dev sold <b>${soldPct.toFixed(1)}%</b> of initial tokens\n` +
        `Threshold: ${env.DEV_SELL_ABANDON_PCT}%\n` +
        `Position: <code>${positionId}</code>\n\n` +
        `⚡ Abandoning position NOW at best available price.`,
    )

    // Trigger emergency sell via PositionManager callback
    this.onDevDump(positionId, deployerAddress, soldPct)
  }
}
