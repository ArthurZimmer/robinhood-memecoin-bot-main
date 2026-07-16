import { z } from 'zod'
import { config } from 'dotenv'

// Load .env before validation — safe to call multiple times
config()

const envSchema = z.object({
  // ── Runtime ──────────────────────────────────────────────────────────────────
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),
  PORT: z.coerce.number().int().positive().default(3000),

  // ── Trading mode ─────────────────────────────────────────────────────────────
  TRADING_MODE: z.enum(['paper', 'real']).default('paper'),
  PAPER_BALANCE_NATIVE: z.coerce.number().positive().default(10),
  /** Simulated tx inclusion latency (ms) — paper fills are re-quoted on live reserves after this delay. */
  PAPER_LATENCY_MS: z.coerce.number().int().nonnegative().default(300),

  // ── Trade parameters ─────────────────────────────────────────────────────────
  TRADE_SIZE_NATIVE: z.coerce.number().positive().default(0.05),
  TAKE_PROFIT_PCT: z.coerce.number().positive().default(100),
  // Safety policy: full exit at take-profit (no moonbag) — see PositionManager.decide()
  SELL_PCT_AT_TP: z.coerce.number().positive().max(100).default(100),
  STOP_LOSS_PCT: z.coerce.number().positive().default(50),
  MAX_OPEN_POSITIONS: z.coerce.number().int().positive().default(5),
  DAILY_LOSS_LIMIT_NATIVE: z.coerce.number().positive().default(0.5),
  /**
   * Anti-copycat: skip a candidate whose symbol matches a position closed IN
   * PROFIT within this window (minutes). Rug factories relaunch just-pumped
   * tickers and pull the LP minutes later. 0 disables the gate.
   */
  COPYCAT_SYMBOL_COOLDOWN_MIN: z.coerce.number().nonnegative().default(60),

  // ── Multi-tier entry filter ──────────────────────────────────────────────────
  /** Absolute floor market cap (USD). Tokens below this are ALWAYS rejected. */
  MIN_ENTRY_MC_USD: z.coerce.number().nonnegative().default(3_000),
  /** Minimum ETH liquidity in the Uniswap V2 pair to consider trading. */
  MIN_LIQUIDITY_NATIVE: z.coerce.number().nonnegative().default(0.1),
  /** Tier 1 threshold (USD). MC ≥ this: easiest entry requirements. */
  TIER1_MC_USD: z.coerce.number().positive().default(8_000),
  /** Tier 2 threshold (USD). MC ≥ this: moderate entry requirements. */
  TIER2_MC_USD: z.coerce.number().positive().default(5_000),
  /** Minimum detector score for Tier 1 (high MC, low bar). */
  MIN_DETECTOR_SCORE: z.coerce.number().int().min(0).max(100).default(35),
  /** Minimum detector score for Tier 2 (medium MC, medium bar). */
  MIN_DETECTOR_SCORE_TIER2: z.coerce.number().int().min(0).max(100).default(50),
  /** Minimum detector score for Tier 3 (low MC, high bar — requires strong signals). */
  MIN_DETECTOR_SCORE_TIER3: z.coerce.number().int().min(0).max(100).default(65),
  /**
   * @deprecated Social links come from token metadata URI, which does not exist
   * for plain ERC-20s on Uniswap V2 — the gate rejected every token. Kept in the
   * schema so existing .env files don't break; no longer read by the strategy.
   * Replaced by TIER2/TIER3_MIN_SUPPLY_IN_POOL_PCT (on-chain anti-dump signal).
   */
  REQUIRE_SOCIAL_TIER2: z.coerce.boolean().default(false),
  /**
   * Tier 2: minimum % of token total supply that must sit in the Uniswap pool.
   * Anti-dump signal — the LOWER this is, the more supply is held off-pool by
   * dev/insiders and available to dump. Calibrated to the Robinhood chain, where
   * the median launch keeps only ~22% of supply in-pool, so these gates filter
   * the dump-risk tail (very little supply seeded) rather than requiring most of
   * it in-pool (which would reject the typical legitimate launch).
   */
  TIER2_MIN_SUPPLY_IN_POOL_PCT: z.coerce.number().min(0).max(100).default(15),
  /** Tier 3: minimum % of token total supply that must sit in the Uniswap pool (~chain median). */
  TIER3_MIN_SUPPLY_IN_POOL_PCT: z.coerce.number().min(0).max(100).default(25),
  /** Honeypot probe: reject if simulated buy tax (fee-on-transfer) exceeds this %. */
  HONEYPOT_MAX_BUY_TAX_PCT: z.coerce.number().min(0).max(100).default(10),
  /** Honeypot probe: reject if simulated sell tax exceeds this %. */
  HONEYPOT_MAX_SELL_TAX_PCT: z.coerce.number().min(0).max(100).default(10),
  /** Require deployer to be first-timer for Tier 3 (low MC). */
  REQUIRE_FRESH_DEPLOYER_TIER3: z.coerce.boolean().default(true),
  /** Minimum token age (ms) before entry — prevents instant rug where deployer pulls in <5s. */
  MIN_TOKEN_AGE_MS: z.coerce.number().int().nonnegative().default(3_000),
  /** Minimum dev buy (ETH) for deployer commitment — overrides detector's default. */
  MIN_DEV_BUY_NATIVE: z.coerce.number().nonnegative().default(0.05),
  /** Absolute floor wallet balance (ETH). Refuse trades if wallet drops below this. */
  MIN_WALLET_BALANCE_NATIVE: z.coerce.number().nonnegative().default(0.1),
  /** Percentage of initial tokens the dev can sell before we abandon the position (rug-pull guard). */
  DEV_SELL_ABANDON_PCT: z.coerce.number().positive().max(100).default(10),

  // ── Robinhood Chain RPC ──────────────────────────────────────────────────────
  /** Robinhood Chain RPC URL (HTTP). QuickNode or equivalent. */
  ROBBINHOOD_RPC_URL: z.string().url('ROBBINHOOD_RPC_URL must be a valid URL'),
  /** Robinhood Chain WebSocket URL (wss://...). Used for event subscriptions. */
  ROBBINHOOD_WS_URL: z
    .string()
    .refine(
      (v) => v.startsWith('wss://') || v.startsWith('ws://'),
      'ROBBINHOOD_WS_URL must be a WebSocket URL (wss:// or ws://)',
    )
    .optional(),
  /** Robinhood Chain ID (4663). */
  ROBBINHOOD_CHAIN_ID: z.coerce.number().int().positive().default(4663),

  // ── Uniswap V2 on Robinhood ────────────────────────────────────────────────────
  /** Uniswap V2 Factory contract address on Robinhood Chain. */
  UNISWAP_FACTORY_ADDRESS: z.string().min(1, 'UNISWAP_FACTORY_ADDRESS is required'),
  /** Uniswap V2 Router02 address (for swap execution). */
  UNISWAP_ROUTER_ADDRESS: z.string().min(1, 'UNISWAP_ROUTER_ADDRESS is required'),
  /** WETH address on Robinhood Chain. */
  WETH_ADDRESS: z.string().min(1, 'WETH_ADDRESS is required'),

  // ── Database ─────────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // ── Redis ────────────────────────────────────────────────────────────────────
  REDIS_URL: z.string().min(1, 'REDIS_URL is required').default('redis://localhost:6379'),

  // ── Telegram ─────────────────────────────────────────────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
  TELEGRAM_CHAT_ID: z.string().min(1, 'TELEGRAM_CHAT_ID is required'),

  // ── Wallet (required for real trading) ───────────────────────────────────────
  /** Bot wallet private key (hex, with or without 0x prefix). */
  WALLET_PRIVATE_KEY: z.string().optional(),

  // ── MEV Protection (optional) ────────────────────────────────────────────────
  /** Flashbots / MEV relay endpoint for private transaction submission. */
  MEV_RELAY_URL: z.string().url().optional(),
})

export type Env = z.infer<typeof envSchema>

function validateEnv(): Env {
  const result = envSchema.safeParse(process.env)

  if (!result.success) {
    // Flatten errors for human-readable output
    const errors = result.error.flatten()
    const fieldErrors = Object.entries(errors.fieldErrors)
      .map(([field, msgs]) => `  ${field}: ${(msgs ?? []).join(', ')}`)
      .join('\n')

    console.error('╔══════════════════════════════════════════════════╗')
    console.error('║  ENV VALIDATION FAILED — bot cannot start        ║')
    console.error('╚══════════════════════════════════════════════════╝')
    if (fieldErrors) console.error(fieldErrors)
    if (errors.formErrors.length > 0) console.error(errors.formErrors.join('\n'))
    console.error('\nCopy .env.example → .env and fill in the required values.\n')

    process.exit(1)
  }

  const data = result.data

  // Cross-field validation: real mode requires a wallet private key
  if (data.TRADING_MODE === 'real' && !data.WALLET_PRIVATE_KEY) {
    console.error('╔══════════════════════════════════════════════════╗')
    console.error('║  WALLET_PRIVATE_KEY is required when             ║')
    console.error('║  TRADING_MODE=real — bot cannot start            ║')
    console.error('╚══════════════════════════════════════════════════╝')
    console.error('\nSet WALLET_PRIVATE_KEY=<hex> in your .env file.\n')
    process.exit(1)
  }

  return data
}

// Singleton — validated once at module load, fails fast if invalid
export const env = validateEnv()
