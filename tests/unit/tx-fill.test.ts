import { test } from 'node:test'
import assert from 'node:assert/strict'
import { id, zeroPadValue, toBeHex, type TransactionReceipt } from 'ethers'
import {
  extractTxFill,
  realizedEthOutWei,
  realizedTokensRaw,
} from '../../src/executor/tx-fill.js'

// Ground-truth topics computed with ethers keccak — the implementation must match.
const TRANSFER_TOPIC = id('Transfer(address,address,uint256)')
const WITHDRAWAL_TOPIC = id('Withdrawal(address,uint256)')

const OWNER = '0x1111111111111111111111111111111111111111'
const PAIR = '0x2222222222222222222222222222222222222222'
const ROUTER = '0x3333333333333333333333333333333333333333'
const FEE_WALLET = '0x4444444444444444444444444444444444444444'
const TOKEN = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'
const WETH = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'

interface FakeLog {
  address: string
  topics: string[]
  data: string
}

function transferLog(token: string, from: string, to: string, value: bigint): FakeLog {
  return {
    address: token,
    topics: [TRANSFER_TOPIC, zeroPadValue(from, 32), zeroPadValue(to, 32)],
    data: toBeHex(value, 32),
  }
}

function withdrawalLog(weth: string, src: string, wad: bigint): FakeLog {
  return {
    address: weth,
    topics: [WITHDRAWAL_TOPIC, zeroPadValue(src, 32)],
    data: toBeHex(wad, 32),
  }
}

function fakeReceipt(logs: FakeLog[], gasUsed = 150_000n, gasPrice = 2_000_000_000n): TransactionReceipt {
  return { logs, gasUsed, gasPrice } as unknown as TransactionReceipt
}

// ── extractTxFill: buy ────────────────────────────────────────────────────────

test('buy: token delta comes from the Transfer log to the owner', () => {
  const receipt = fakeReceipt([
    transferLog(TOKEN, PAIR, OWNER, 1_000_000n),
  ])
  const fill = extractTxFill(receipt, OWNER, TOKEN, WETH)
  assert.ok(fill)
  assert.equal(fill.tokenDeltaRaw, 1_000_000n)
  assert.equal(fill.gasFeeWei, 150_000n * 2_000_000_000n)
})

test('buy: fee-on-transfer — only the amount actually credited to the owner counts', () => {
  // Taxed token: pair sends 900k to buyer, 100k to the fee wallet.
  const receipt = fakeReceipt([
    transferLog(TOKEN, PAIR, OWNER, 900_000n),
    transferLog(TOKEN, PAIR, FEE_WALLET, 100_000n),
  ])
  const fill = extractTxFill(receipt, OWNER, TOKEN, WETH)
  assert.ok(fill)
  assert.equal(fill.tokenDeltaRaw, 900_000n)
})

test('buy: Transfer logs from other contracts are ignored', () => {
  const OTHER_TOKEN = '0xBBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'
  const receipt = fakeReceipt([
    transferLog(OTHER_TOKEN, PAIR, OWNER, 555n),
    transferLog(TOKEN, PAIR, OWNER, 777n),
  ])
  const fill = extractTxFill(receipt, OWNER, TOKEN, WETH)
  assert.ok(fill)
  assert.equal(fill.tokenDeltaRaw, 777n)
})

test('buy: no token Transfer touching the owner → tokenDeltaRaw is null (not 0)', () => {
  const receipt = fakeReceipt([
    transferLog(TOKEN, PAIR, FEE_WALLET, 100n),
  ])
  const fill = extractTxFill(receipt, OWNER, TOKEN, WETH)
  assert.ok(fill)
  assert.equal(fill.tokenDeltaRaw, null)
})

// ── extractTxFill: sell ───────────────────────────────────────────────────────

test('sell: ETH out comes from the WETH Withdrawal log; token delta is negative', () => {
  const ethOut = 47_000_000_000_000_000n // 0.047 ETH
  const receipt = fakeReceipt([
    transferLog(TOKEN, OWNER, PAIR, 500_000n),
    withdrawalLog(WETH, ROUTER, ethOut),
  ])
  const fill = extractTxFill(receipt, OWNER, TOKEN, WETH)
  assert.ok(fill)
  assert.equal(fill.wethWithdrawnWei, ethOut)
  assert.equal(fill.tokenDeltaRaw, -500_000n)
})

test('sell: WETH address comparison is case-insensitive', () => {
  const receipt = fakeReceipt([
    withdrawalLog(WETH.toLowerCase(), ROUTER, 123n),
  ])
  const fill = extractTxFill(receipt, OWNER, TOKEN, WETH.toUpperCase().replace('0X', '0x'))
  assert.ok(fill)
  assert.equal(fill.wethWithdrawnWei, 123n)
})

test('sell: no Withdrawal log → wethWithdrawnWei is null', () => {
  const receipt = fakeReceipt([
    transferLog(TOKEN, OWNER, PAIR, 500_000n),
  ])
  const fill = extractTxFill(receipt, OWNER, TOKEN, WETH)
  assert.ok(fill)
  assert.equal(fill.wethWithdrawnWei, null)
})

// ── extractTxFill: degenerate inputs ─────────────────────────────────────────

test('null / malformed receipt → null', () => {
  assert.equal(extractTxFill(null, OWNER, TOKEN, WETH), null)
  assert.equal(extractTxFill(undefined, OWNER, TOKEN, WETH), null)
  const noGas = { logs: [] } as unknown as TransactionReceipt
  assert.equal(extractTxFill(noGas, OWNER, TOKEN, WETH), null)
})

// ── realized* helpers ─────────────────────────────────────────────────────────

test('realizedTokensRaw prefers the on-chain delta, falls back to the quote', () => {
  const fill = extractTxFill(
    fakeReceipt([transferLog(TOKEN, PAIR, OWNER, 900n)]),
    OWNER, TOKEN, WETH,
  )
  assert.equal(realizedTokensRaw(fill, 1_000n), 900n)
  assert.equal(realizedTokensRaw(null, 1_000n), 1_000n)
  // Delta null (no matching Transfer) → fallback
  const noDelta = extractTxFill(fakeReceipt([]), OWNER, TOKEN, WETH)
  assert.equal(realizedTokensRaw(noDelta, 1_000n), 1_000n)
  // Negative delta (a sell receipt passed by mistake) → fallback, never negative
  const sellFill = extractTxFill(
    fakeReceipt([transferLog(TOKEN, OWNER, PAIR, 900n)]),
    OWNER, TOKEN, WETH,
  )
  assert.equal(realizedTokensRaw(sellFill, 1_000n), 1_000n)
})

test('realizedEthOutWei prefers the Withdrawal amount, falls back to the quote', () => {
  const fill = extractTxFill(
    fakeReceipt([withdrawalLog(WETH, ROUTER, 950n)]),
    OWNER, TOKEN, WETH,
  )
  assert.equal(realizedEthOutWei(fill, 1_000n), 950n)
  assert.equal(realizedEthOutWei(null, 1_000n), 1_000n)
  const noWithdrawal = extractTxFill(fakeReceipt([]), OWNER, TOKEN, WETH)
  assert.equal(realizedEthOutWei(noWithdrawal, 1_000n), 1_000n)
})
