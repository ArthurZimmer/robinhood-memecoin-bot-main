import './helpers/test-env.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ethSideReserveNative, quoteBuy, quoteSell } from '../../src/executor/uniswap-math.js'

const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'
const TOKEN = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'

// ── ethSideReserveNative — the WETH-side reserve, never the token side ────────
// Regression: the detector used max(reserve0, reserve1)/1e18, which picks the
// TOKEN reserve for any normal memecoin pair and disabled the liquidity check.

test('token0 = WETH → returns reserve0 in whole ETH', () => {
  const lp = ethSideReserveNative(
    {
      token0: WETH,
      token1: TOKEN,
      reserve0: (5n * 10n ** 17n).toString(), // 0.5 ETH
      reserve1: (10n ** 27n).toString(), // 1B tokens (18 dec) — must be ignored
    },
    WETH,
  )
  assert.equal(lp, 0.5)
})

test('token1 = WETH → returns reserve1 in whole ETH', () => {
  const lp = ethSideReserveNative(
    {
      token0: TOKEN,
      token1: WETH.toLowerCase(), // case-insensitive
      reserve0: (10n ** 27n).toString(),
      reserve1: (2n * 10n ** 18n).toString(), // 2 ETH
    },
    WETH,
  )
  assert.equal(lp, 2)
})

test('neither side is WETH → 0', () => {
  const lp = ethSideReserveNative(
    { token0: TOKEN, token1: TOKEN, reserve0: '1', reserve1: '2' },
    WETH,
  )
  assert.equal(lp, 0)
})

test('missing reserves or token ordering → 0', () => {
  assert.equal(ethSideReserveNative({}, WETH), 0)
  assert.equal(ethSideReserveNative({ token0: WETH, token1: TOKEN }, WETH), 0)
  assert.equal(
    ethSideReserveNative({ reserve0: '1', reserve1: '2' }, WETH),
    0,
  )
})

// ── Sanity anchors for the AMM math the whole simulation rests on ─────────────

test('quoteBuy preserves the constant product and charges the 0.3% fee', () => {
  const state = { ethReserve: 1, tokenReserve: 1_000_000, tokenDecimals: 18 }
  const q = quoteBuy(state, 0.05)
  assert.ok(q.tokensOut > 0)
  assert.ok(Math.abs(q.feeNative - 0.05 * 0.003) < 1e-12)
  const kBefore = state.ethReserve * state.tokenReserve
  const kAfter = q.newState.ethReserve * q.newState.tokenReserve
  assert.ok(Math.abs(kBefore - kAfter) / kBefore < 1e-9)
})

test('quoteSell of the just-bought tokens returns less ETH than spent (fees + impact)', () => {
  const state = { ethReserve: 1, tokenReserve: 1_000_000, tokenDecimals: 18 }
  const buy = quoteBuy(state, 0.05)
  const sell = quoteSell(buy.newState, buy.tokensOut)
  assert.ok(sell.nativeOut < 0.05)
  assert.ok(sell.nativeOut > 0.04) // round trip loses fees+impact, not half the value
})
