import { randomUUID } from 'node:crypto'
import { Contract } from 'ethers'
import { createChildLogger } from '../utils/logger.js'
import { eventBus } from '../events/event-bus.js'
import { STREAMS, type PoolCreatedEvent } from '../events/event-types.js'
import { rhProvider, WETH_ADDRESS, NATIVE_ETH_ADDRESS } from '../utils/robbinhood.utils.js'
import { ERC20_ABI } from '../executor/uniswap-math.js'

const log = createChildLogger('uniswap-pair-parser')

// ── Constants ────────────────────────────────────────────────────────────────

/** EVM address validator — standard 0x-prefixed 40-char hex address. */
const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/

function isValidEvmAddress(addr: unknown): addr is string {
  return typeof addr === 'string' && EVM_ADDRESS_RE.test(addr)
}

// ── Types ────────────────────────────────────────────────────────────────────

interface UniswapPairParserOptions {
  blockMs?: number
  count?: number
  consumerGroup?: string
}

// ── Parser ───────────────────────────────────────────────────────────────────

export class UniswapPairParser {
  private running = false
  private readonly blockMs: number
  private readonly count: number
  private readonly consumerGroup: string

  constructor(options: UniswapPairParserOptions = {}) {
    this.blockMs = options.blockMs ?? 2_000
    this.count = options.count ?? 10
    this.consumerGroup = options.consumerGroup ?? 'uniswap-pair-parser'
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn('start() called but already running')
      return
    }

    await eventBus.subscribe(
      STREAMS.RAW,
      this.consumerGroup,
      `parser-${process.pid}`,
      async (data, messageId) => {
        await this.handleRawEvent(data, messageId)
      },
      { blockMs: this.blockMs, count: this.count },
    )

    this.running = true
    log.info(
      { stream: STREAMS.RAW, group: this.consumerGroup },
      'UniswapPairParser subscribed (EVM — Uniswap V2 PairCreated)',
    )
  }

  async stop(): Promise<void> {
    this.running = false
    log.info('UniswapPairParser stopped')
  }

  // ── Message handler ────────────────────────────────────────────────────────

  private async handleRawEvent(
    data: Record<string, unknown>,
    messageId: string,
  ): Promise<void> {
    // Only handle Uniswap protocol events — skip anything else
    if (data.protocol !== 'uniswap') return

    const rawData = data.rawData as Record<string, unknown> | undefined
    if (!rawData) {
      log.warn({ messageId }, 'Raw event missing rawData — discarding')
      return
    }

    try {
      const parsed = await this.parseRawPayload(rawData, data)
      if (!parsed) {
        log.debug({ messageId }, 'Parsed event was null — discarded')
        return
      }

      await eventBus.publish(
        STREAMS.PARSED,
        parsed as unknown as Record<string, unknown>,
      )
      log.debug(
        {
          tokenAddress: parsed.tokenAddress,
          poolAddress: parsed.poolAddress,
        },
        'Uniswap pair parsed and published',
      )
    } catch (err) {
      log.error({ err, messageId }, 'Parse failed — acked, no retry')
    }
  }

  /**
   * Parse a raw PairCreated payload into a PoolCreatedEvent.
   * Validates addresses and enriches with token metadata from chain.
   */
  private async parseRawPayload(
    payload: Record<string, unknown>,
    envelope: Record<string, unknown>,
  ): Promise<PoolCreatedEvent | null> {
    const token0 = payload['token0']
    const token1 = payload['token1']
    const pair = payload['pair']
    const allPairsLength = payload['allPairsLength']

    // Validate required fields
    if (typeof token0 !== 'string' || typeof token1 !== 'string' || typeof pair !== 'string') {
      log.warn({ payload }, 'Raw payload missing required fields (token0, token1, pair)')
      return null
    }

    // Validate EVM addresses
    if (!isValidEvmAddress(token0) || !isValidEvmAddress(token1) || !isValidEvmAddress(pair)) {
      log.debug({ token0, token1, pair }, 'Invalid EVM address in raw payload — discarding')
      return null
    }

    // Determine which token is WETH
    const wethLower = WETH_ADDRESS.toLowerCase()
    const isToken0Eth = token0.toLowerCase() === wethLower
    const isToken1Eth = token1.toLowerCase() === wethLower

    if (!isToken0Eth && !isToken1Eth) {
      log.debug({ token0, token1 }, 'Skipping non-WETH pair')
      return null
    }

    const memecoinAddress = isToken0Eth ? token1 : token0

    // Enrich with token metadata from chain
    let tokenMetadata: { name?: string; symbol?: string; uri?: string } | undefined
    let tokenDecimals: number | undefined

    try {
      const tokenContract = new Contract(memecoinAddress, ERC20_ABI, rhProvider)
      const [name, symbol, decimals] = await Promise.all([
        tokenContract.name!().catch(() => null),
        tokenContract.symbol!().catch(() => null),
        tokenContract.decimals!().catch(() => null),
      ])

      if (name || symbol) {
        tokenMetadata = {
          ...(typeof name === 'string' && { name }),
          ...(typeof symbol === 'string' && { symbol }),
        }
      }
      if (decimals !== null) {
        tokenDecimals = Number(decimals)
      }
    } catch (err) {
      log.warn({ err, token: memecoinAddress }, 'Failed to enrich token metadata')
    }

    const event: PoolCreatedEvent = {
      eventId: randomUUID(),
      type: 'pool_created',
      protocol: 'uniswap',
      timestamp:
        typeof envelope['timestamp'] === 'number' ? envelope['timestamp'] : Date.now(),
      poolAddress: pair,
      tokenAddress: memecoinAddress,
      quoteTokenAddress: NATIVE_ETH_ADDRESS,
      // Fallback: the token's own address (unique per launch) — token0 could be
      // WETH, which would poison deployer-burst tracking and the blacklist.
      deployerAddress:
        typeof payload['deployer'] === 'string' ? payload['deployer'] : memecoinAddress,
      token0,
      token1,
      ...(typeof allPairsLength === 'number' && { allPairsLength }),
      ...(tokenMetadata && { tokenMetadata }),
      ...(tokenDecimals !== undefined && { tokenDecimals }),
      ...(typeof payload['reserve0'] === 'string' && { reserve0: payload['reserve0'] }),
      ...(typeof payload['reserve1'] === 'string' && { reserve1: payload['reserve1'] }),
      ...(typeof payload['totalSupply'] === 'string' && { totalSupply: payload['totalSupply'] }),
    }

    return event
  }
}

export const uniswapPairParser = new UniswapPairParser()
