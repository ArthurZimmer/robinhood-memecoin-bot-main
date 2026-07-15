import { eq } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { deployerBlacklist } from '../../database/schema.js'
import { eventBus } from '../../events/event-bus.js'
import { createChildLogger } from '../../utils/logger.js'
import type { CandidateOpportunity } from '../../events/event-types.js'
import { fail, pass, skipped, type RiskCheck, type CheckResult } from './base.check.js'

const log = createChildLogger('check:deployer-blacklist')

// ── Deployer blacklist check ─────────────────────────────────────────────────
// Layered lookup: Redis (sub-ms) → DB (1-5ms) → cache result back in Redis.
// Redis cache uses a single hash key 'blacklist:deployers' with severity values,
// so cache lookup is O(1) without scanning DB on every candidate.

const REDIS_KEY = 'blacklist:deployers' // hash: address -> severity
const REDIS_TTL_SECONDS = 60 * 60 // 1h
const REDIS_LOADED_KEY = 'blacklist:loaded_at' // tracks last full refresh

export class DeployerBlacklistCheck implements RiskCheck {
  readonly name = 'deployer-blacklist'
  readonly weight = 0.25

  private cacheLoadedAt = 0
  private readonly cacheTtlMs = REDIS_TTL_SECONDS * 1000

  async evaluate(candidate: CandidateOpportunity): Promise<CheckResult> {
    const deployer = candidate.deployerAddress
    try {
      await this.ensureCacheFresh()
      const severity = await eventBus.client.hget(REDIS_KEY, deployer)

      if (!severity) return pass('deployer not on blacklist')

      const score = severityToScore(severity)
      const sev = severity as 'low' | 'medium' | 'high' | 'critical'

      return fail(sev, score, `deployer blacklisted: ${severity}`)
    } catch (err) {
      log.error({ err, deployer }, 'Blacklist check failed — defaulting to pass')
      return skipped('redis/db unavailable')
    }
  }

  private async ensureCacheFresh(): Promise<void> {
    const now = Date.now()
    if (now - this.cacheLoadedAt < this.cacheTtlMs) return

    // Check Redis-level marker — another instance may have already loaded
    const lastLoadedRaw = await eventBus.client.get(REDIS_LOADED_KEY)
    const lastLoaded = lastLoadedRaw ? parseInt(lastLoadedRaw, 10) : 0
    if (now - lastLoaded < this.cacheTtlMs) {
      this.cacheLoadedAt = lastLoaded
      return
    }

    await this.refreshCache()
  }

  private async refreshCache(): Promise<void> {
    log.debug('Refreshing blacklist cache from DB')
    const rows = await db.select().from(deployerBlacklist)

    const pipeline = eventBus.client.pipeline()
    pipeline.del(REDIS_KEY)
    for (const row of rows) {
      pipeline.hset(REDIS_KEY, row.address, row.severity)
    }
    pipeline.expire(REDIS_KEY, REDIS_TTL_SECONDS + 60) // grace window
    pipeline.set(REDIS_LOADED_KEY, String(Date.now()), 'EX', REDIS_TTL_SECONDS)
    await pipeline.exec()

    this.cacheLoadedAt = Date.now()
    log.info({ count: rows.length }, 'Blacklist cache refreshed')
  }
}

function severityToScore(severity: string): number {
  switch (severity) {
    case 'critical':
      return 100
    case 'high':
      return 80
    case 'medium':
      return 50
    case 'low':
      return 25
    default:
      return 50
  }
}

export const deployerBlacklistCheck = new DeployerBlacklistCheck()
