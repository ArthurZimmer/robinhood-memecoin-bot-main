import pino, { type Logger } from 'pino'
import { env } from '../config/env.js'

// ── Logger with multi-layer secret protection ────────────────────────────────
//
// Three layers defend against secret leakage in logs:
//
//   1. PATH-based redaction (pino built-in):
//      Any field named in REDACT_PATHS is replaced with [REDACTED] regardless of value.
//
//   2. VALUE-based redaction (custom hook):
//      Every string in every log payload is scanned for known secret VALUES (taken from
//      env vars at boot). If found, replaced with [REDACTED]. This catches:
//        - Secret pasted into a free-form error message
//        - Secret embedded in a URL (e.g. RPC URL with API key in path)
//        - Secret in a stack trace argument
//        - Anyone calling log.info({ key: env.WALLET_PRIVATE_KEY }, ...)
//
//   3. err serializer:
//      Errors are serialized with both message and stack scrubbed.
//
// Active in BOTH dev and prod — accidents happen everywhere.

// Fields that should always be censored by name (regardless of value)
const REDACT_PATHS = [
  // Direct field names
  'WALLET_PRIVATE_KEY',
  'walletPrivateKey',
  'privateKey',
  'secretKey',
  'MEV_RELAY_URL',
  'mevRelayUrl',
  'apiKey',
  'TELEGRAM_BOT_TOKEN',
  'telegramBotToken',
  'botToken',
  'DATABASE_URL',
  'databaseUrl',
  'REDIS_URL',
  'redisUrl',
  // Nested (one level)
  '*.WALLET_PRIVATE_KEY',
  '*.walletPrivateKey',
  '*.privateKey',
  '*.secretKey',
  '*.MEV_RELAY_URL',
  '*.mevRelayUrl',
  '*.apiKey',
  '*.TELEGRAM_BOT_TOKEN',
  '*.botToken',
  '*.DATABASE_URL',
  '*.REDIS_URL',
  // Two levels deep (for err.cause, opts.config, etc.)
  '*.*.WALLET_PRIVATE_KEY',
  '*.*.privateKey',
  '*.*.secretKey',
  '*.*.apiKey',
  '*.*.botToken',
]

// Collect ALL known secret VALUES from env at boot. Any string containing one of these
// gets that substring replaced with [REDACTED].
function collectSecretValues(): string[] {
  const candidates = [
    env.WALLET_PRIVATE_KEY,
    env.MEV_RELAY_URL,
    env.TELEGRAM_BOT_TOKEN,
    env.DATABASE_URL,
    env.REDIS_URL,
  ]
  // Filter out empty/short values — short strings would cause too many false-positive redactions.
  // EVM private keys are 32 bytes (66 chars with 0x prefix), API keys typically 32+ chars.
  return candidates.filter((v): v is string => typeof v === 'string' && v.length >= 16)
}

const SECRET_VALUES = collectSecretValues()

/**
 * Scrub every string in a value tree, replacing any known secret value with [REDACTED].
 * Used as the pino formatters.log hook.
 */
function scrubSecrets(input: unknown): unknown {
  if (SECRET_VALUES.length === 0) return input

  if (typeof input === 'string') {
    let out = input
    for (const secret of SECRET_VALUES) {
      if (out.includes(secret)) {
        out = out.split(secret).join('[REDACTED]')
      }
    }
    return out
  }

  if (Array.isArray(input)) {
    return input.map(scrubSecrets)
  }

  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = scrubSecrets(v)
    }
    return out
  }

  return input
}

// Custom err serializer — scrubs message AND stack trace
function scrubbedErrSerializer(err: unknown): Record<string, unknown> {
  const base = pino.stdSerializers.err(err as Error)
  return scrubSecrets(base) as Record<string, unknown>
}

function buildLogger(): Logger {
  const isDev = env.NODE_ENV === 'development'

  const commonOptions = {
    level: env.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
      remove: false,
    },
    serializers: {
      err: scrubbedErrSerializer,
      error: scrubbedErrSerializer,
    },
    formatters: {
      // Scrub VALUE-level secrets in every log object before it goes to transport.
      log(obj: Record<string, unknown>): Record<string, unknown> {
        return scrubSecrets(obj) as Record<string, unknown>
      },
    },
  }

  if (isDev) {
    return pino({
      ...commonOptions,
      base: { pid: process.pid },
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          messageFormat: '{component} {msg}',
          singleLine: false,
        },
      },
    })
  }

  // Production: structured JSON
  return pino({
    ...commonOptions,
    base: {
      pid: process.pid,
      env: env.NODE_ENV,
      mode: env.TRADING_MODE,
    },
  })
}

export const logger = buildLogger()

/**
 * Create a child logger scoped to a specific component.
 * Each module should call this once at module level.
 *
 * @example
 * const log = createChildLogger('risk-engine')
 * log.info({ tokenAddress }, 'Check started')
 */
export function createChildLogger(component: string): Logger {
  return logger.child({ component })
}
