import { createChildLogger } from './logger.js'
import { eventBus } from '../events/event-bus.js'

const log = createChildLogger('eth-price')

// ── ETH/USD price refresher ───────────────────────────────────────────────────
// Keeps `cache:eth_usd` warm 24/7. The strategy reads this key to compute
// market cap (MC = price × supply × ETH/USD) for tier decisions.
//
// Without this loop the cache was only seeded once at startup (TTL 120s) and
// lazily refreshed by dashboard requests — running headless, the cache expired
// after 2 minutes and the strategy silently fell back to $3,000, corrupting
// every MC/tier decision.
//
// Interval 120s + TTL 360s: tolerates 2 consecutive CoinGecko failures before
// the cache goes cold. Zero RPC cost (plain HTTP to CoinGecko).

const REFRESH_INTERVAL_MS = 120_000
const CACHE_TTL_S = 360
const FETCH_TIMEOUT_MS = 5_000

export const ETH_USD_CACHE_KEY = 'cache:eth_usd'

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'

let timer: ReturnType<typeof setInterval> | null = null

async function refreshOnce(): Promise<void> {
  try {
    const res = await fetch(COINGECKO_URL, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`coingecko HTTP ${res.status}`)

    const json = (await res.json()) as { ethereum?: { usd?: number } }
    const price = json.ethereum?.usd
    if (typeof price !== 'number' || price <= 0) {
      throw new Error(`invalid price payload: ${JSON.stringify(json).slice(0, 120)}`)
    }

    await eventBus.client.set(ETH_USD_CACHE_KEY, String(price), 'EX', CACHE_TTL_S)
    log.debug({ ethUsd: price }, 'ETH/USD cache refreshed')
  } catch (err) {
    // Non-fatal — previous cached value (TTL 360s) covers short outages.
    log.warn({ err }, 'ETH/USD refresh failed — keeping previous cache')
  }
}

/**
 * Start the background refresh loop. The first fetch runs immediately so the
 * cache is warm before the pipeline starts consuming events.
 */
export async function startEthPriceRefresher(): Promise<void> {
  if (timer) {
    log.warn('startEthPriceRefresher() called but already running')
    return
  }

  await refreshOnce()

  timer = setInterval(() => {
    void refreshOnce()
  }, REFRESH_INTERVAL_MS)
  // Don't hold the process open just for this loop
  timer.unref()

  log.info(
    { intervalMs: REFRESH_INTERVAL_MS, cacheTtlS: CACHE_TTL_S },
    'ETH/USD price refresher started',
  )
}

export function stopEthPriceRefresher(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
    log.info('ETH/USD price refresher stopped')
  }
}
