// Load env vars before anything else imports them
import 'dotenv/config'

import { env } from './config/env.js'
import { logger } from './utils/logger.js'
import { getBotAddress } from './utils/wallet.js'
import { eventBus } from './events/event-bus.js'
import { checkDatabaseConnection, closeDatabasePool } from './database/client.js'
import { uniswapPairListener } from './listeners/uniswap-pair.listener.js'
import { uniswapPairParser } from './parsers/uniswap-pair.parser.js'
import { uniswapLaunchDetector } from './detectors/uniswap-launch.detector.js'
import { riskEngine } from './risk/risk-engine.js'
import { uniswapSnipeStrategy } from './strategies/uniswap-snipe.strategy.js'
import { positionManager } from './positions/position-manager.js'
import { dashboardServer } from './dashboard/server.js'
import { startEthPriceRefresher, stopEthPriceRefresher } from './utils/eth-price.js'
import { wsManager } from './utils/ws-manager.js'

const log = logger.child({ component: 'bootstrap' })

// ── Graceful shutdown ─────────────────────────────────────────────────────────

let shuttingDown = false

async function shutdown(signal: string, exitCode = 0): Promise<never> {
  if (shuttingDown) {
    log.warn({ signal }, 'Shutdown already in progress — ignoring duplicate signal')
    // Let the original shutdown complete
    await new Promise<never>(() => {})
  }

  shuttingDown = true
  log.warn({ signal }, 'Shutdown signal received — draining connections')

  const errors: Error[] = []

  stopEthPriceRefresher()

  // Drain producers BEFORE consumers so no in-flight messages get stranded
  try {
    await uniswapPairListener.stop()
  } catch (err) {
    log.error({ err }, 'UniswapPairListener stop error')
    errors.push(err as Error)
  }

  try {
    await uniswapLaunchDetector.stop()
  } catch (err) {
    log.error({ err }, 'UniswapLaunchDetector stop error')
    errors.push(err as Error)
  }

  try {
    await dashboardServer.stop()
  } catch (err) {
    log.error({ err }, 'DashboardServer stop error')
    errors.push(err as Error)
  }

  try {
    await positionManager.stop()
  } catch (err) {
    log.error({ err }, 'PositionManager stop error')
    errors.push(err as Error)
  }

  try {
    await uniswapSnipeStrategy.stop()
  } catch (err) {
    log.error({ err }, 'UniswapSnipeStrategy stop error')
    errors.push(err as Error)
  }

  try {
    await riskEngine.stop()
  } catch (err) {
    log.error({ err }, 'RiskEngine stop error')
    errors.push(err as Error)
  }

  try {
    await uniswapPairParser.stop()
  } catch (err) {
    log.error({ err }, 'UniswapPairParser stop error')
    errors.push(err as Error)
  }

  // WS manager after all subscribers — they unregister their subscriptions first
  try {
    await wsManager.stop()
  } catch (err) {
    log.error({ err }, 'WsManager stop error')
    errors.push(err as Error)
  }

  try {
    await eventBus.stop()
  } catch (err) {
    log.error({ err }, 'EventBus stop error')
    errors.push(err as Error)
  }

  try {
    await closeDatabasePool()
  } catch (err) {
    log.error({ err }, 'Database pool close error')
    errors.push(err as Error)
  }

  if (errors.length > 0) {
    log.error({ errorCount: errors.length }, 'Shutdown completed with errors')
    process.exit(1)
  }

  log.info('Shutdown complete')
  process.exit(exitCode)
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  log.info(
    {
      nodeVersion: process.version,
      mode: env.TRADING_MODE,
      nodeEnv: env.NODE_ENV,
      logLevel: env.LOG_LEVEL,
    },
    'Robinhood Memecoin Bot starting',
  )

  if (env.TRADING_MODE === 'real') {
    log.warn(
      '⚠️  TRADING_MODE=real — live swaps WILL be executed with real ETH',
    )
  } else {
    log.info(
      {
        paperBalanceNative: env.PAPER_BALANCE_NATIVE,
        tradeSizeNative: env.TRADE_SIZE_NATIVE,
      },
      'Paper mode active — no on-chain execution',
    )
  }

  // ── 0a. Validate wallet at startup (real mode only) ──────────────────────────
  if (env.TRADING_MODE === 'real') {
    try {
      const address = getBotAddress()
      log.info({ address }, 'Wallet address validated ✓')
    } catch (err) {
      log.fatal({ err }, 'Invalid WALLET_PRIVATE_KEY — cannot start in real mode')
      process.exit(1)
    }
  }

  // ── 0b. Robinhood RPC pre-flight (real mode only) ────────────────────────────
  if (env.TRADING_MODE === 'real') {
    try {
      const { rhProvider } = await import('./utils/robbinhood.utils.js')
      const blockNumber = await rhProvider.getBlockNumber()
      log.info({ blockNumber }, 'Robinhood RPC reachable ✓')
    } catch {
      log.warn(
        'Cannot reach Robinhood RPC — check ROBBINHOOD_RPC_URL. Bot will start but real buys will fail until resolved.',
      )
    }
  }

  // ── 1. Verify database ──────────────────────────────────────────────────────
  try {
    await checkDatabaseConnection()
  } catch (err) {
    log.fatal({ err }, 'PostgreSQL connection failed — run migrations and check DATABASE_URL')
    process.exit(1)
  }

  // ── 2. Start event bus ──────────────────────────────────────────────────────
  try {
    await eventBus.start()
  } catch (err) {
    log.fatal({ err }, 'EventBus start failed — check REDIS_URL')
    await closeDatabasePool()
    process.exit(1)
  }

  // ── 2b. ETH/USD price refresher ──────────────────────────────────────────────
  // Background loop keeps cache:eth_usd warm 24/7. The strategy needs this to
  // compute market cap for tier decisions. First fetch runs before the pipeline
  // starts so the cache is warm; failures fall back to the strategy's $3000 guard.
  await startEthPriceRefresher()

  // ── 2c. Resilient WebSocket manager ──────────────────────────────────────────
  // Owns the WS connection + auto-reconnect. Must start BEFORE the pipeline so
  // PairCreated/Sync/Transfer subscriptions attach to a live provider.
  wsManager.start()

  // ── 3. Start pipeline (consumer-first order — handlers must be ready before producers) ──
  try {
    // Consumers first: register subscriptions on Redis Streams (downstream → upstream)
    await positionManager.start() // independent poller — start anytime
    await uniswapSnipeStrategy.start()
    await riskEngine.start()
    await uniswapLaunchDetector.start()
    await uniswapPairParser.start()

    // Producer last: only emit events once full pipeline is consuming.
    // Uniswap pair listener publishes directly to PARSED stream.
    await uniswapPairListener.start()

    // Dashboard HTTP server — read-only, can start anytime
    await dashboardServer.start()
  } catch (err) {
    log.fatal({ err }, 'Pipeline start failed — aborting')
    await shutdown('pipeline-start-failure', 1)
  }

  log.info(
    {
      tradeSizeNative: env.TRADE_SIZE_NATIVE,
      takeProfitPct: env.TAKE_PROFIT_PCT,
      sellPctAtTp: env.SELL_PCT_AT_TP,
      stopLossPct: env.STOP_LOSS_PCT,
      trailingStopPct: env.TRAILING_STOP_PCT,
      trailingArmPct: env.TRAILING_ARM_PCT,
      maxOpenPositions: env.MAX_OPEN_POSITIONS,
    },
    'Bot initialized — pipeline running (UniswapPairListener → Parser → Detector → RiskEngine → Strategy → Executor + PositionManager)',
  )
}

// ── Signal handlers ───────────────────────────────────────────────────────────

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

process.on('uncaughtException', (err) => {
  log.fatal({ err }, 'Uncaught exception — shutting down')
  void shutdown('uncaughtException', 1)
})

process.on('unhandledRejection', (reason) => {
  log.fatal({ reason }, 'Unhandled rejection — shutting down')
  void shutdown('unhandledRejection', 1)
})

// ── Entry point ───────────────────────────────────────────────────────────────

bootstrap().catch((err) => {
  log.fatal({ err }, 'Bootstrap failed')
  process.exit(1)
})
