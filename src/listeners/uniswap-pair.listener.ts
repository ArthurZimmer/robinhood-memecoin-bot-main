import { Contract, type EventLog, type Log } from 'ethers'
import { randomUUID } from 'node:crypto'
import { createChildLogger } from '../utils/logger.js'
import {
  rhProvider,
  UNISWAP_FACTORY_ADDRESS,
  WETH_ADDRESS,
  NATIVE_ETH_ADDRESS,
} from '../utils/robbinhood.utils.js'
import { wsManager } from '../utils/ws-manager.js'
import { eventBus } from '../events/event-bus.js'
import { STREAMS, type PoolCreatedEvent } from '../events/event-types.js'
import { ERC20_ABI } from '../executor/uniswap-math.js'

const log = createChildLogger('uniswap-pair-listener')

// ── Uniswap V2 Factory ABI (PairCreated event) ────────────────────────────────
// Emitted when a new pair is created via createPair().
// We filter for pairs where one token is WETH — those are ETH-denominated memecoins.
const FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint allPairsLength)',
]

// ── Uniswap V2 Pair ABI (getReserves only — view call after creation) ─────────
const PAIR_ABI = [
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function totalSupply() external view returns (uint256)',
]

const WS_SUBSCRIPTION_KEY = 'uniswap-pair-created'

// ── Polling fallback config (only used when ROBBINHOOD_WS_URL is not set) ─────
const POLL_INTERVAL_MS = 3_000
// QuickNode Discover plan limits eth_getLogs to 5 blocks per request.
const MAX_BLOCKS_PER_POLL = 5
const CHUNK_INTERVAL_MS = 200

// ── Gap-fill config (WS mode — runs only after a reconnect) ───────────────────
// Cap how far back we scan so a long outage can't burn the daily budget:
// 100 blocks ≈ 10s of chain at ~10 blocks/s → at most 20 eth_getLogs calls.
const GAP_FILL_MAX_BLOCKS = 100

/** Decoded PairCreated fields — shared by the WS push and getLogs paths. */
interface PairCreatedArgs {
  token0: string
  token1: string
  pair: string
  allPairsLength?: number | undefined
  txHash?: string | undefined
  blockNumber?: number | undefined
}

export class UniswapPairListener {
  private running = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastBlock = 0
  private factoryContract: Contract | null = null
  private disabled = false

  async start(): Promise<void> {
    if (this.running) {
      log.warn('start() called but already running')
      return
    }

    // Guard: validate the factory address is set
    if (!UNISWAP_FACTORY_ADDRESS) {
      log.warn('UNISWAP_FACTORY_ADDRESS not set — listener DISABLED')
      this.disabled = true
      return
    }

    this.running = true

    if (wsManager.enabled) {
      this.startWsSubscription()
      return
    }

    log.warn('No WebSocket configured — falling back to eth_getLogs polling (high RPC cost)')
    await this.startPolling()
  }

  async stop(): Promise<void> {
    this.running = false
    wsManager.unregister(WS_SUBSCRIPTION_KEY)
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    log.info('Uniswap V2 pair listener stopped')
  }

  // ── WS push path (primary) ───────────────────────────────────────────────────
  // eth_subscribe on the factory's PairCreated topic: the node pushes the event
  // the moment the block lands — no polling delay on the buy path, and requests
  // are only consumed when a pair is actually created.

  private startWsSubscription(): void {
    wsManager.register(WS_SUBSCRIPTION_KEY, (provider, isReconnect) => {
      const factory = new Contract(UNISWAP_FACTORY_ADDRESS, FACTORY_ABI, provider)

      const handler = (
        token0: string,
        token1: string,
        pair: string,
        allPairsLength: bigint,
        payload?: { log?: Log },
      ) => {
        const eventLog = payload?.log
        if (eventLog?.blockNumber && eventLog.blockNumber > this.lastBlock) {
          this.lastBlock = eventLog.blockNumber
        }
        void this.processPairCreated({
          token0,
          token1,
          pair,
          allPairsLength: typeof allPairsLength === 'bigint' ? Number(allPairsLength) : undefined,
          txHash: eventLog?.transactionHash,
          blockNumber: eventLog?.blockNumber,
        }).catch((err) => {
          log.error({ err, pair }, 'Failed to process PairCreated push — continuing')
        })
      }

      // .catch: a rejected subscribe (e.g. socket died mid-handshake) must not
      // become an unhandledRejection — main.ts treats those as fatal
      factory.on('PairCreated', handler).catch((err) => {
        log.warn({ err }, 'PairCreated subscribe failed — wsManager will retry on reconnect')
      })

      log.info(
        { factoryAddress: UNISWAP_FACTORY_ADDRESS, wethAddress: WETH_ADDRESS, isReconnect },
        'Subscribed to PairCreated via WebSocket push',
      )

      // After a reconnect, scan the blocks we missed while offline (bounded).
      if (isReconnect && this.lastBlock > 0) {
        void this.gapFill().catch((err) => {
          log.warn({ err }, 'Gap-fill after reconnect failed — resuming from live events')
        })
      }

      return () => {
        factory.off('PairCreated', handler).catch(() => { /* socket already dead */ })
      }
    })
  }

  /**
   * Fetch PairCreated events missed during a WS outage via HTTP eth_getLogs.
   * Bounded to GAP_FILL_MAX_BLOCKS so a long outage can't drain the daily quota.
   */
  private async gapFill(): Promise<void> {
    const currentBlock = await rhProvider.getBlockNumber()
    let fromBlock = this.lastBlock + 1
    if (fromBlock > currentBlock) return

    if (currentBlock - fromBlock + 1 > GAP_FILL_MAX_BLOCKS) {
      log.warn(
        { missedBlocks: currentBlock - fromBlock + 1, cap: GAP_FILL_MAX_BLOCKS },
        'WS outage longer than gap-fill cap — skipping older blocks',
      )
      fromBlock = currentBlock - GAP_FILL_MAX_BLOCKS + 1
    }

    const factory = new Contract(UNISWAP_FACTORY_ADDRESS, FACTORY_ABI, rhProvider)
    const filter = factory.getEvent('PairCreated')
    let totalLogs = 0

    while (fromBlock <= currentBlock) {
      const toBlock = Math.min(currentBlock, fromBlock + MAX_BLOCKS_PER_POLL - 1)
      try {
        const logs = await factory.queryFilter(filter, fromBlock, toBlock)
        for (const rawLog of logs) {
          await this.processEventLog(rawLog)
        }
        totalLogs += logs.length
      } catch (err) {
        log.warn({ err, fromBlock, toBlock }, 'Gap-fill eth_getLogs failed — skipping range')
      }
      this.lastBlock = toBlock
      fromBlock = toBlock + 1
    }

    if (totalLogs > 0) {
      log.info({ count: totalLogs, upToBlock: currentBlock }, 'Gap-fill recovered missed PairCreated events')
    }
  }

  // ── Polling fallback (no WS configured) ──────────────────────────────────────

  // 10 chunks × 200ms = 2s ≤ POLL_INTERVAL_MS — stays within QuickNode 15 req/s free tier
  private static readonly MAX_CHUNKS_PER_TICK = 10

  private async startPolling(): Promise<void> {
    try {
      this.lastBlock = await rhProvider.getBlockNumber()
      log.info(
        {
          factoryAddress: UNISWAP_FACTORY_ADDRESS,
          wethAddress: WETH_ADDRESS,
          fromBlock: this.lastBlock,
          pollIntervalMs: POLL_INTERVAL_MS,
        },
        'Uniswap V2 pair listener starting in POLLING mode',
      )
    } catch (err) {
      // Daily limit or transient RPC failure — retry on next interval instead of
      // permanently disabling the listener. On QuickNode free tier the daily
      // limit resets at 00:00 UTC.
      log.warn(
        { err },
        'Failed to fetch initial block number — will retry on next poll interval (daily limit may be exhausted)',
      )
      this.lastBlock = 0
    }

    this.factoryContract = new Contract(
      UNISWAP_FACTORY_ADDRESS,
      FACTORY_ABI,
      rhProvider,
    )

    // Kick off first poll immediately, then on a steady interval
    this.poll().catch((err) => {
      log.error({ err }, 'Initial poll failed — will retry on next interval')
    })

    this.pollTimer = setInterval(() => {
      this.poll().catch((err) => {
        log.error({ err }, 'Poll tick failed')
      })
    }, POLL_INTERVAL_MS)
  }

  private async poll(): Promise<void> {
    const factory = this.factoryContract
    if (!this.running || this.disabled || !factory) return

    let currentBlock: number
    try {
      currentBlock = await rhProvider.getBlockNumber()
    } catch (err) {
      log.warn({ err }, 'getBlockNumber failed — skipping poll tick')
      return
    }

    if (currentBlock <= this.lastBlock) return

    // If lastBlock is 0 (e.g. retry after failed init), start from current block
    if (this.lastBlock === 0) {
      this.lastBlock = currentBlock
      log.info({ fromBlock: currentBlock }, 'Listener recovered — resuming from current block')
      return
    }

    const filter = factory.getEvent('PairCreated')
    let totalLogs = 0

    for (let i = 0; i < UniswapPairListener.MAX_CHUNKS_PER_TICK; i++) {
      const fromBlock = this.lastBlock + 1
      if (fromBlock > currentBlock) break

      const toBlock = Math.min(currentBlock, fromBlock + MAX_BLOCKS_PER_POLL - 1)

      // Rate-limit: pause between chunks to stay within QuickNode's 15 req/s limit
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, CHUNK_INTERVAL_MS))
      }

      let logs: Array<EventLog | Log>
      try {
        logs = await factory.queryFilter(filter, fromBlock, toBlock)
      } catch (err) {
        log.warn(
          { err, fromBlock, toBlock },
          'eth_getLogs query failed — advancing past range',
        )
        this.lastBlock = toBlock
        continue
      }

      for (const rawLog of logs) {
        await this.processEventLog(rawLog)
      }

      totalLogs += logs.length
      this.lastBlock = toBlock
    }

    if (totalLogs > 0) {
      log.info(
        { count: totalLogs, lastBlock: this.lastBlock, targetBlock: currentBlock },
        'Processed Uniswap V2 PairCreated events from chain',
      )
    }
  }

  // ── Shared event processing ──────────────────────────────────────────────────

  /** Decode an EventLog (getLogs path) and route into processPairCreated. */
  private async processEventLog(rawLog: Log | EventLog): Promise<void> {
    const args = (rawLog as EventLog).args
    if (!args) {
      log.warn({ txHash: rawLog.transactionHash }, 'Log has no parsed args — skipping')
      return
    }

    await this.processPairCreated({
      token0: typeof args.token0 === 'string' ? args.token0 : '',
      token1: typeof args.token1 === 'string' ? args.token1 : '',
      pair: typeof args.pair === 'string' ? args.pair : '',
      allPairsLength: typeof args.allPairsLength === 'bigint'
        ? Number(args.allPairsLength)
        : undefined,
      txHash: rawLog.transactionHash,
      blockNumber: rawLog.blockNumber,
    }).catch((err) => {
      log.error(
        { err, txHash: rawLog.transactionHash, blockNumber: rawLog.blockNumber },
        'Failed to process individual PairCreated event — continuing',
      )
    })
  }

  private async processPairCreated(args: PairCreatedArgs): Promise<void> {
    const { token0, token1, pair, allPairsLength, txHash, blockNumber } = args

    if (!token0 || !token1 || !pair) {
      log.warn(
        {
          hasToken0: Boolean(token0),
          hasToken1: Boolean(token1),
          hasPair: Boolean(pair),
          txHash,
        },
        'PairCreated event missing required fields — skipping',
      )
      return
    }

    // ── Determine which token is WETH ──────────────────────────────────────────
    const wethLower = WETH_ADDRESS.toLowerCase()
    const isToken0Eth = token0.toLowerCase() === wethLower
    const isToken1Eth = token1.toLowerCase() === wethLower

    // Skip pairs that don't involve WETH (e.g., USDC/DAI pairs) — we only want
    // ETH-denominated memecoins. Zero RPC spent on them.
    if (!isToken0Eth && !isToken1Eth) {
      log.debug(
        { token0: token0.slice(0, 12), token1: token1.slice(0, 12), pair: pair.slice(0, 12) },
        'Skipping non-WETH pair',
      )
      return
    }

    const memecoinAddress = isToken0Eth ? token1 : token0

    // ── Fetch metadata + reserves + deployer in ONE parallel round-trip ────────
    // These were sequential (3 awaits) — parallelizing shaves ~2 RTTs off the
    // detection → entry critical path.
    const tokenContract = new Contract(memecoinAddress, ERC20_ABI, rhProvider)
    const pairContract = new Contract(pair, PAIR_ABI, rhProvider)

    const [
      fetchedName,
      fetchedSymbol,
      fetchedDecimals,
      fetchedReserves,
      fetchedPairSupply,
      fetchedTx,
    ] = await Promise.all([
      tokenContract.name!().catch(() => null),
      tokenContract.symbol!().catch(() => null),
      tokenContract.decimals!().catch(() => null),
      pairContract.getReserves!().catch(() => null),
      pairContract.totalSupply!().catch(() => null),
      txHash ? rhProvider.getTransaction(txHash).catch(() => null) : Promise.resolve(null),
    ])

    const name: string | undefined = fetchedName ?? undefined
    const symbol: string | undefined = fetchedSymbol ?? undefined
    const tokenDecimals = fetchedDecimals !== null ? Number(fetchedDecimals) : undefined

    let reserve0: string | undefined
    let reserve1: string | undefined
    if (fetchedReserves) {
      reserve0 = fetchedReserves[0].toString()
      reserve1 = fetchedReserves[1].toString()
    }
    const pairTotalSupply: string | undefined = fetchedPairSupply?.toString()

    // Fallback: the token's own address. token0 could be WETH — shared across
    // every launch, which poisoned deployer-burst tracking and the blacklist.
    // The token address is unique per launch, so deployer-specific checks
    // become neutral no-ops instead of firing on the wrong wallet.
    const deployerAddress = fetchedTx?.from ?? memecoinAddress

    // ── Build and publish event ────────────────────────────────────────────────
    const event: PoolCreatedEvent = {
      eventId: randomUUID(),
      type: 'pool_created',
      protocol: 'uniswap',
      timestamp: Date.now(),
      poolAddress: pair,
      tokenAddress: memecoinAddress,
      quoteTokenAddress: NATIVE_ETH_ADDRESS,
      deployerAddress,
      ...(txHash && { txHash }),
      token0,
      token1,
      ...(reserve0 && { reserve0 }),
      ...(reserve1 && { reserve1 }),
      ...(pairTotalSupply && { totalSupply: pairTotalSupply }),
      ...(tokenDecimals !== undefined && { tokenDecimals }),
      ...(allPairsLength !== undefined && { allPairsLength }),
      ...(name || symbol
        ? {
            tokenMetadata: {
              ...(name && { name }),
              ...(symbol && { symbol }),
            },
          }
        : {}),
      ...(blockNumber && { blockNumber }),
    }

    await eventBus.publish(
      STREAMS.PARSED,
      event as unknown as Record<string, unknown>,
    )

    log.info(
      {
        token: memecoinAddress.slice(0, 12),
        pair: pair.slice(0, 12),
        deployer: deployerAddress.slice(0, 12),
        symbol: symbol ?? '(none)',
        name: name?.slice(0, 30) ?? '(none)',
        blockNumber,
        txHash: txHash?.slice(0, 12),
        pairIndex: allPairsLength,
      },
      '🎯 New Uniswap V2 pair detected on Robinhood Chain',
    )
  }
}

export const uniswapPairListener = new UniswapPairListener()
