import { db } from '../database/client.js'
import { riskEvaluations } from '../database/schema.js'
import { eventBus } from '../events/event-bus.js'
import { createChildLogger } from '../utils/logger.js'
import {
  STREAMS,
  type ApprovedOpportunity,
  type CandidateOpportunity,
  type RiskResult,
} from '../events/event-types.js'
import { liquidityCheck } from './checks/liquidity.check.js'
import { deployerBlacklistCheck } from './checks/deployer-blacklist.check.js'
import { mintFreezeAuthorityCheck } from './checks/mint-freeze-authority.check.js'
import { tokenQualityCheck } from './checks/token-quality.check.js'
import type { RiskCheck, CheckResult } from './checks/base.check.js'
import { aggregate } from './risk-score.js'

const log = createChildLogger('risk-engine')

interface RiskEngineOptions {
  blockMs?: number
  count?: number
  consumerGroup?: string
}

// ── Risk Engine ──────────────────────────────────────────────────────────────
// Sequential fail-fast pipeline:
//   1. token-quality  — payload only, 0ms (NEW: symbol/name/devBuy heuristic)
//   2. liquidity      — payload only, 0ms
//   3. blacklist      — Redis hash lookup, <1ms cached
//   4. mint+freeze    — 1 RPC call, ~150ms cached
// On critical fail: short-circuit, persist audit row, do not publish approved.
// On pass: publish ApprovedOpportunity to events:approved.

export class RiskEngine {
  // Order matters — cheapest first, expensive checks only if cheap ones pass
  private readonly checks: RiskCheck[] = [
    tokenQualityCheck,
    liquidityCheck,
    deployerBlacklistCheck,
    mintFreezeAuthorityCheck,
  ]

  private running = false
  private readonly blockMs: number
  private readonly count: number
  private readonly consumerGroup: string

  constructor(options: RiskEngineOptions = {}) {
    this.blockMs = options.blockMs ?? 2_000
    this.count = options.count ?? 10
    this.consumerGroup = options.consumerGroup ?? 'risk-engine'
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn('start() called but already running')
      return
    }

    await eventBus.subscribe(
      STREAMS.CANDIDATES,
      this.consumerGroup,
      `risk-${process.pid}`,
      async (data, messageId) => {
        await this.evaluate(data as unknown as CandidateOpportunity, messageId)
      },
      { blockMs: this.blockMs, count: this.count },
    )

    this.running = true
    log.info(
      { stream: STREAMS.CANDIDATES, checks: this.checks.map((c) => c.name) },
      'RiskEngine subscribed',
    )
  }

  async stop(): Promise<void> {
    this.running = false
    log.info('RiskEngine stopped')
  }

  // ── Evaluation ─────────────────────────────────────────────────────────────

  private async evaluate(
    candidate: CandidateOpportunity,
    messageId: string,
  ): Promise<void> {
    const startedAt = Date.now()
    const runs: { check: RiskCheck; result: CheckResult }[] = []

    try {
      for (const check of this.checks) {
        const t0 = Date.now()
        let result: CheckResult
        try {
          result = await check.evaluate(candidate)
        } catch (err) {
          // Check must never throw — but if it does, treat as skipped (safe default)
          log.error({ err, check: check.name }, 'Check threw — treating as skipped')
          result = {
            passed: true,
            score: 0,
            severity: null,
            detail: `error: ${(err as Error).message}`,
          }
        }
        result.durationMs = Date.now() - t0
        runs.push({ check, result })

        // Fail-fast: critical severity short-circuits remaining checks
        if (!result.passed && result.severity === 'critical') {
          log.debug(
            { check: check.name, detail: result.detail, tokenAddress: candidate.tokenAddress },
            'Critical fail — short-circuiting remaining checks',
          )
          break
        }
      }

      const risk = aggregate(runs)
      const totalMs = Date.now() - startedAt

      // Persist audit row (async, never blocks the decision)
      void this.persistAudit(candidate, risk, totalMs)

      if (risk.passed) {
        const approved: ApprovedOpportunity = { ...candidate, risk }
        await eventBus.publish(
          STREAMS.APPROVED,
          approved as unknown as Record<string, unknown>,
        )
        log.debug(
          {
            tokenAddress: candidate.tokenAddress,
            riskScore: risk.riskScore,
            riskLevel: risk.riskLevel,
            durationMs: totalMs,
          },
          'APPROVED — published to executor',
        )
      } else {
        log.debug(
          {
            tokenAddress: candidate.tokenAddress,
            riskScore: risk.riskScore,
            riskLevel: risk.riskLevel,
            flags: risk.flags,
            durationMs: totalMs,
          },
          'REJECTED',
        )
      }
    } catch (err) {
      log.error(
        { err, messageId, tokenAddress: candidate.tokenAddress },
        'RiskEngine evaluation failed — acked, no retry',
      )
    }
  }

  private async persistAudit(
    candidate: CandidateOpportunity,
    risk: RiskResult,
    durationMs: number,
  ): Promise<void> {
    try {
      await db.insert(riskEvaluations).values({
        candidateId: candidate.candidateId,
        tokenAddress: candidate.tokenAddress,
        poolAddress: candidate.poolAddress,
        deployerAddress: candidate.deployerAddress,
        protocol: candidate.protocol,
        passed: risk.passed,
        riskScore: risk.riskScore,
        riskLevel: risk.riskLevel,
        flags: risk.flags,
        checksDetail: risk.checks,
        evaluationDurationMs: durationMs,
      })
    } catch (err) {
      log.error({ err }, 'Failed to persist risk evaluation — non-fatal')
    }
  }
}

export const riskEngine = new RiskEngine()
