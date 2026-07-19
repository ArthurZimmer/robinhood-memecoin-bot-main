import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decideExit, type ExitPolicyInput } from '../../src/positions/exit-policy.js'

// Baseline: the production config — de-risk 50% at +100%, trailing 30% armed
// at +100% peak, hard SL −40%.
function input(overrides: Partial<ExitPolicyInput> = {}): ExitPolicyInput {
  return {
    entryPrice: 1,
    spotPrice: 1,
    peakPrice: 1,
    status: 'open',
    slPct: 40,
    tpPct: 100,
    sellPctAtTp: 50,
    trailingStopPct: 30,
    trailingArmPct: 100,
    ...overrides,
  }
}

// ── Hard stop-loss ────────────────────────────────────────────────────────────

test('SL fires on open position', () => {
  const d = decideExit(input({ spotPrice: 0.6 }))
  assert.deepEqual(d, { sellPct: 100, reason: 'stop-loss', pnlPct: -40 })
})

test('SL fires on partial_exit moonbag too', () => {
  const d = decideExit(input({ status: 'partial_exit', spotPrice: 0.55, peakPrice: 1.5 }))
  assert.equal(d?.reason, 'stop-loss')
  assert.equal(d?.sellPct, 100)
})

test('no SL just above the threshold', () => {
  assert.equal(decideExit(input({ spotPrice: 0.61 })), null)
})

// ── De-risk at TP ─────────────────────────────────────────────────────────────

test('de-risk: open + pnl >= tp sells sellPctAtTp', () => {
  const d = decideExit(input({ spotPrice: 2, peakPrice: 1.9 }))
  assert.deepEqual(d, { sellPct: 50, reason: 'take-profit', pnlPct: 100 })
})

test('de-risk fires only once — partial_exit never re-triggers take-profit', () => {
  // Peak just armed but no drawdown → trailing silent; TP must NOT re-fire.
  const d = decideExit(input({ status: 'partial_exit', spotPrice: 2.1, peakPrice: 2.1 }))
  assert.equal(d, null)
})

test('legacy compat: sellPctAtTp=100 → full exit at TP', () => {
  const d = decideExit(input({ spotPrice: 2, peakPrice: 1.9, sellPctAtTp: 100, trailingStopPct: 0 }))
  assert.deepEqual(d, { sellPct: 100, reason: 'take-profit', pnlPct: 100 })
})

test('sellPctAtTp <= 0 clamps to full exit', () => {
  const d = decideExit(input({ spotPrice: 2, peakPrice: 1.9, sellPctAtTp: 0 }))
  assert.equal(d?.sellPct, 100)
})

// ── Trailing stop ─────────────────────────────────────────────────────────────

test('not armed (peak below arm threshold) → deep drawdown above SL is ignored', () => {
  // Peak +90% (< arm +100%), spot fell 35% from peak but pnl −40% < spot > SL level.
  const d = decideExit(input({ spotPrice: 1.2, peakPrice: 1.9 }))
  assert.equal(d, null)
})

test('armed + drawdown >= trail → full exit', () => {
  // Peak 2.2 (+120% ≥ arm), fire level 2.2×0.7 = 1.54; spot 1.5 ≤ 1.54.
  const d = decideExit(input({ status: 'partial_exit', spotPrice: 1.5, peakPrice: 2.2 }))
  assert.deepEqual(d, { sellPct: 100, reason: 'trailing-stop', pnlPct: 50 })
})

test('armed but drawdown below trail → holds', () => {
  const d = decideExit(input({ status: 'partial_exit', spotPrice: 1.6, peakPrice: 2.2 }))
  assert.equal(d, null)
})

test('ratchet: higher peak raises the fire level', () => {
  // Same spot 2.0: peak 3.0 → fire 2.1 → sells; peak 2.2 → fire 1.54 → holds.
  const fires = decideExit(input({ status: 'partial_exit', spotPrice: 2.0, peakPrice: 3.0 }))
  assert.equal(fires?.reason, 'trailing-stop')
  const holds = decideExit(input({ status: 'partial_exit', spotPrice: 2.0, peakPrice: 2.2 }))
  assert.equal(holds, null)
})

test('trailingStopPct=0 disables trailing', () => {
  // Armed peak, 70% drawdown from it, still above SL → nothing.
  const d = decideExit(input({ status: 'partial_exit', spotPrice: 0.9, peakPrice: 3.0, trailingStopPct: 0 }))
  assert.equal(d, null)
})

test('moonshot capture: +3000% peak exits at ~+2070%', () => {
  // Entry 1, peak 31 (+3000%), fire level 31×0.7 = 21.7 (+2070%).
  const holds = decideExit(input({ status: 'partial_exit', spotPrice: 21.8, peakPrice: 31 }))
  assert.equal(holds, null)
  const fires = decideExit(input({ status: 'partial_exit', spotPrice: 21.7, peakPrice: 31 }))
  assert.equal(fires?.reason, 'trailing-stop')
  assert.ok((fires?.pnlPct ?? 0) > 2000)
})

// ── Precedence ────────────────────────────────────────────────────────────────

test('SL beats trailing on a gap through both levels', () => {
  // Armed (peak 2.5), spot gaps to 0.55: pnl −45 ≤ −40 AND drawdown 78% ≥ 30.
  const d = decideExit(input({ status: 'partial_exit', spotPrice: 0.55, peakPrice: 2.5 }))
  assert.equal(d?.reason, 'stop-loss')
})

test('trailing beats de-risk when both trigger in the same tick', () => {
  // Restart scenario: open, peak 3.0 restored from DB, spot 2.0 → pnl 100 ≥ tp
  // AND drawdown 33% ≥ 30. Full trailing exit in ONE transaction wins.
  const d = decideExit(input({ spotPrice: 2.0, peakPrice: 3.0 }))
  assert.deepEqual(d, { sellPct: 100, reason: 'trailing-stop', pnlPct: 100 })
})

// ── Restart safety ────────────────────────────────────────────────────────────

test('restart with no recorded peak (peak == entry) → not armed', () => {
  const d = decideExit(input({ spotPrice: 1.5, peakPrice: 1 }))
  assert.equal(d, null)
})

test('restart with DB peak already armed + spot below fire → exits on first tick', () => {
  const d = decideExit(input({ status: 'partial_exit', spotPrice: 1.45, peakPrice: 2.2 }))
  assert.equal(d?.reason, 'trailing-stop')
})

// ── Guards ────────────────────────────────────────────────────────────────────

test('terminal statuses never decide', () => {
  for (const status of ['closed', 'stopped', 'failed']) {
    assert.equal(decideExit(input({ status, spotPrice: 0.1 })), null)
  }
})

test('invalid entry/spot → null', () => {
  assert.equal(decideExit(input({ entryPrice: 0 })), null)
  assert.equal(decideExit(input({ entryPrice: NaN })), null)
  assert.equal(decideExit(input({ spotPrice: NaN })), null)
  assert.equal(decideExit(input({ spotPrice: 0 })), null)
})

test('defensive: stale peakPrice below spot is lifted to spot (no false fire)', () => {
  // spot 2.5 > peak 2.2 passed in error → effective peak 2.5, drawdown 0.
  const d = decideExit(input({ status: 'partial_exit', spotPrice: 2.5, peakPrice: 2.2 }))
  assert.equal(d, null)
})
