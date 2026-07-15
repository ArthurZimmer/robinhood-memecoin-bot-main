import type { CheckResult, RiskCheck } from './checks/base.check.js'
import type { RiskLevel, RiskResult } from '../events/event-types.js'

// ── Aggregator ────────────────────────────────────────────────────────────────
// Weighted average of check scores, mapped to risk level.

interface CheckRun {
  check: RiskCheck
  result: CheckResult
}

export function aggregate(runs: CheckRun[]): RiskResult {
  let weightSum = 0
  let weightedScore = 0
  const flags: string[] = []
  const checks: RiskResult['checks'] = {}

  let criticalFail = false

  for (const { check, result } of runs) {
    checks[check.name] = {
      passed: result.passed,
      score: result.score,
      ...(result.detail && { detail: result.detail }),
    }
    weightSum += check.weight
    weightedScore += result.score * check.weight

    if (!result.passed) {
      flags.push(check.name)
      if (result.severity === 'critical') criticalFail = true
    }
  }

  const riskScore = weightSum > 0 ? Math.round(weightedScore / weightSum) : 0
  const riskLevel = scoreToLevel(riskScore, criticalFail)
  const passed = !criticalFail && riskScore < 70

  return {
    passed,
    riskScore,
    riskLevel,
    flags,
    checks,
    evaluatedAt: Date.now(),
  }
}

function scoreToLevel(score: number, criticalFail: boolean): RiskLevel {
  if (criticalFail) return 'critical'
  if (score >= 70) return 'high'
  if (score >= 40) return 'medium'
  return 'low'
}
