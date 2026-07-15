import { Redis } from 'ioredis'
import { env } from '../config/env.js'
import { createChildLogger } from '../utils/logger.js'
import type { StreamName } from './event-types.js'

const log = createChildLogger('event-bus')

// ── Types ─────────────────────────────────────────────────────────────────────

export type StreamHandler<T = Record<string, unknown>> = (
  data: T,
  messageId: string,
) => Promise<void>

interface RegisteredConsumer {
  stream: StreamName
  group: string
  consumer: string
  handler: StreamHandler
  blockMs: number
  count: number
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function serializeFields(data: Record<string, unknown>): string[] {
  return Object.entries(data).flatMap(([k, v]) => [
    k,
    typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v),
  ])
}

function parseFields(fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (let i = 0; i < fields.length; i += 2) {
    const key = fields[i]
    const raw = fields[i + 1]
    if (key === undefined || raw === undefined) continue
    try {
      result[key] = JSON.parse(raw)
    } catch {
      result[key] = raw
    }
  }
  return result
}

// ── EventBus ──────────────────────────────────────────────────────────────────

export class EventBus {
  private publisher: Redis
  private subscriber: Redis
  private consumers = new Map<string, RegisteredConsumer>()
  private pollers = new Map<string, ReturnType<typeof setTimeout>>()
  private running = false

  constructor() {
    this.publisher = this.createRedisClient('publisher')
    this.subscriber = this.createRedisClient('subscriber')
  }

  private createRedisClient(name: string): Redis {
    const client = new Redis(env.REDIS_URL, {
      // Disable per-command retry — we handle reconnect at the stream poll level
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      lazyConnect: false,
      retryStrategy(times: number) {
        // Exponential backoff capped at 2 s
        const delay = Math.min(times * 100, 2_000)
        log.warn({ client: name, attempt: times, delayMs: delay }, 'Redis reconnecting')
        return delay
      },
    })

    client.on('connect', () => log.debug({ client: name }, 'Redis connected'))
    client.on('ready', () => log.debug({ client: name }, 'Redis ready'))
    client.on('close', () => log.warn({ client: name }, 'Redis connection closed'))
    client.on('error', (err: Error) =>
      log.error({ client: name, err }, 'Redis error'),
    )

    return client
  }

  // ── Publish ────────────────────────────────────────────────────────────────

  /**
   * Publish a message to a Redis Stream.
   * Returns the auto-generated message ID (e.g. "1718000000000-0").
   */
  async publish(stream: StreamName, data: Record<string, unknown>): Promise<string> {
    const fields = serializeFields(data)
    const messageId = await this.publisher.xadd(stream, '*', ...fields)

    if (messageId === null) {
      throw new Error(`XADD returned null for stream "${stream}" — Redis MAXLEN may have rejected the message`)
    }

    log.debug({ stream, messageId }, 'Event published')
    return messageId
  }

  // ── Consumer groups ────────────────────────────────────────────────────────

  private async ensureConsumerGroup(stream: StreamName, group: string): Promise<void> {
    try {
      // '$' means: only process messages arriving AFTER group creation
      // MKSTREAM creates the stream if it doesn't exist yet
      await this.subscriber.xgroup('CREATE', stream, group, '$', 'MKSTREAM')
      log.info({ stream, group }, 'Consumer group created')
    } catch (err: unknown) {
      const e = err as { message?: string }
      if (e.message?.includes('BUSYGROUP')) {
        // Group already exists — expected on restart
        log.debug({ stream, group }, 'Consumer group already exists')
        return
      }
      throw err
    }
  }

  // ── Subscribe ──────────────────────────────────────────────────────────────

  /**
   * Register a consumer on a stream.
   * If the EventBus is already running, the poller starts immediately.
   * If not yet running, pollers start on `eventBus.start()`.
   *
   * @param stream   - Redis Stream key (use STREAMS constants from event-types.ts)
   * @param group    - Consumer group name (e.g. 'risk-engine')
   * @param consumer - Unique consumer name within the group (e.g. 'risk-engine-1')
   * @param handler  - Async function called for each message; must not throw (ack skipped on error)
   * @param options  - blockMs: how long to block waiting for messages (default 2000ms)
   *                   count:   max messages per XREADGROUP call (default 10)
   */
  async subscribe<T = Record<string, unknown>>(
    stream: StreamName,
    group: string,
    consumer: string,
    handler: StreamHandler<T>,
    options: { blockMs?: number; count?: number } = {},
  ): Promise<void> {
    await this.ensureConsumerGroup(stream, group)

    const key = `${stream}::${group}::${consumer}`
    const registered: RegisteredConsumer = {
      stream,
      group,
      consumer,
      handler: handler as StreamHandler,
      blockMs: options.blockMs ?? 2_000,
      count: options.count ?? 10,
    }

    this.consumers.set(key, registered)
    log.debug({ stream, group, consumer }, 'Consumer registered')

    if (this.running) {
      this.startPoller(key, registered)
    }
  }

  // ── Polling loop ───────────────────────────────────────────────────────────

  private startPoller(key: string, cfg: RegisteredConsumer): void {
    const poll = async () => {
      if (!this.running) return

      try {
        // '>' = only new, undelivered messages
        const results = (await this.subscriber.xreadgroup(
          'GROUP',
          cfg.group,
          cfg.consumer,
          'COUNT',
          cfg.count,
          'BLOCK',
          cfg.blockMs,
          'STREAMS',
          cfg.stream,
          '>',
        )) as [string, [string, string[]][]][] | null

        if (results !== null) {
          for (const [, messages] of results) {
            for (const [messageId, fields] of messages) {
              const data = parseFields(fields)

              try {
                await cfg.handler(data, messageId)
                // Only ack after successful handler execution
                await this.subscriber.xack(cfg.stream, cfg.group, messageId)
                log.debug({ stream: cfg.stream, messageId }, 'Message acked')
              } catch (handlerErr) {
                // Message stays in PEL (Pending Entry List) for reprocessing
                log.error(
                  { err: handlerErr, messageId, stream: cfg.stream, group: cfg.group },
                  'Handler threw — message NOT acked, will be redelivered',
                )
              }
            }
          }
        }
      } catch (pollErr) {
        log.error({ err: pollErr, stream: cfg.stream }, 'XREADGROUP error')
        // Back off 1 s before retrying to avoid Redis hammer on transient errors
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000))
      }

      // Re-schedule immediately (BLOCK already provides the sleep)
      if (this.running) {
        this.pollers.set(key, setTimeout(poll, 0))
      }
    }

    this.pollers.set(key, setTimeout(poll, 0))
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) {
      log.warn('EventBus already running — start() called twice')
      return
    }

    this.running = true

    for (const [key, cfg] of this.consumers) {
      this.startPoller(key, cfg)
    }

    log.info({ consumers: this.consumers.size }, 'EventBus started')
  }

  async stop(): Promise<void> {
    if (!this.running) return

    this.running = false

    for (const timer of this.pollers.values()) {
      clearTimeout(timer)
    }
    this.pollers.clear()

    await Promise.allSettled([this.publisher.quit(), this.subscriber.quit()])

    log.info('EventBus stopped')
  }

  // ── Accessors ──────────────────────────────────────────────────────────────

  /** Raw publisher Redis client — use for XLEN, XRANGE, XTRIM etc. */
  get client(): Redis {
    return this.publisher
  }

  get isRunning(): boolean {
    return this.running
  }
}

// Singleton — imported by all pipeline stages
export const eventBus = new EventBus()
