import type { CandidateOpportunity } from '../../events/event-types.js'

// ── Check contract ────────────────────────────────────────────────────────────
// Every risk check returns a uniform result. Engine aggregates these.

export type CheckSeverity = 'low' | 'medium' | 'high' | 'critical' | null

export interface CheckResult {
  /** Did this check pass? */
  passed: boolean
  /** Score this check contributes (0-100). Higher = riskier. */
  score: number
  /** If failed, severity. 'critical' short-circuits the engine. */
  severity: CheckSeverity
  /** Human-readable detail for logs/UI. */
  detail?: string
  /** Wall-clock duration (ms). Filled by engine, not by check itself. */
  durationMs?: number
}

export interface RiskCheck {
  /** Unique check name — used as key in flags and audit table. */
  readonly name: string

  /** Weight in final score aggregation (0-1). */
  readonly weight: number

  /**
   * Evaluate the candidate. Must not throw on transient errors — return
   * `{ passed: true, score: 0, severity: null, detail: 'check skipped: ...' }`
   * so engine doesn't block legit candidates on RPC hiccups.
   */
  evaluate(candidate: CandidateOpportunity): Promise<CheckResult>
}

// ── Helpers for check authors ─────────────────────────────────────────────────

export function pass(detail?: string): Omit<CheckResult, 'durationMs'> {
  return { passed: true, score: 0, severity: null, ...(detail && { detail }) }
}

export function fail(
  severity: Exclude<CheckSeverity, null>,
  score: number,
  detail: string,
): Omit<CheckResult, 'durationMs'> {
  return { passed: false, score, severity, detail }
}

export function skipped(reason: string): Omit<CheckResult, 'durationMs'> {
  // Skipped check counts as pass with zero score — never block on infra failure
  return { passed: true, score: 0, severity: null, detail: `skipped: ${reason}` }
}
