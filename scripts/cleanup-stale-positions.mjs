// Cleanup script — closes all open paper positions whose Uniswap V2 pairs are
// flat (no trades since entry). Uses on-chain pair reserves to compute realized PnL.
//
// Safe to run while bot is up — only modifies DB, doesn't touch streams.
//
// Usage: node scripts/cleanup-stale-positions.mjs
// Requires: ROBBINHOOD_RPC_URL, DATABASE_URL in .env

import { Contract, JsonRpcProvider } from 'ethers'
import 'dotenv/config'
import { Client } from 'pg'
import { randomUUID } from 'node:crypto'

const FEE_BPS = 30 // Uniswap V2 0.3%
const TOLERANCE_NATIVE = 0.001 // ETH — flat if delta < this

// Uniswap V2 Pair ABI — read real reserves + token ordering
const UNISWAP_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]

// Process env WETH_ADDRESS or fall back to Robinhood Chain default
const WETH_ADDRESS = (process.env.WETH_ADDRESS || '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73').toLowerCase()

const provider = new JsonRpcProvider(process.env.ROBBINHOOD_RPC_URL)
const pg = new Client({ connectionString: process.env.DATABASE_URL })
await pg.connect()

const { rows } = await pg.query(`
  SELECT id, token_address, pool_address,
         entry_amount_native::text as entry_amount,
         entry_price_native::text as entry_price,
         tokens_received::text as tokens_raw,
         metadata
    FROM positions
   WHERE mode='paper' AND closed_at IS NULL
`)

console.log(`\nFound ${rows.length} open paper positions. Checking on-chain...\n`)

let closed = 0
let kept = 0

for (const r of rows) {
  let contract
  try {
    contract = new Contract(r.pool_address, UNISWAP_PAIR_ABI, provider)
  } catch {
    console.log(`  ${r.token_address.slice(0, 14)}  SKIP (invalid pool address)`)
    continue
  }

  let ethReserve, tokenReserve
  try {
    const [reserves, t0, t1] = await Promise.all([
      contract.getReserves(),
      contract.token0(),
      contract.token1(),
    ])

    const isWethToken0 = t0.toLowerCase() === WETH_ADDRESS
    const tokenDecimals = r.metadata?.tokenDecimals ?? 18

    if (isWethToken0) {
      ethReserve = Number(reserves[0]) / 1e18
      tokenReserve = Number(reserves[1]) / 10 ** tokenDecimals
    } else if (t1.toLowerCase() === WETH_ADDRESS) {
      ethReserve = Number(reserves[1]) / 1e18
      tokenReserve = Number(reserves[0]) / 10 ** tokenDecimals
    } else {
      console.log(`  ${r.token_address.slice(0, 14)}  SKIP (WETH not in pair)`)
      continue
    }
  } catch {
    console.log(`  ${r.token_address.slice(0, 14)}  SKIP (contract call failed)`)
    continue
  }

  // Check if stale-flat — compare current ethReserve with entry snapshot
  const entryEthReserve = r.metadata?.pairReservesSnapshot?.ethReserve
  const isFlat =
    typeof entryEthReserve === 'number' &&
    Math.abs(ethReserve - entryEthReserve) < TOLERANCE_NATIVE

  if (!isFlat) {
    console.log(
      `  ${r.token_address.slice(0, 14)}  KEEP (active, ethReserve moved ${Math.abs(ethReserve - (entryEthReserve ?? 0)).toFixed(6)} ETH)`,
    )
    kept++
    continue
  }

  // Compute current sell quote (sell 100% of tokens) using Uniswap V2 x*y=k with 0.3% fee
  const tokensRaw = BigInt(r.tokens_raw)
  const tokenDecimals = r.metadata?.tokenDecimals ?? 18
  const tokensWhole = Number(tokensRaw) / 10 ** tokenDecimals

  // Constant-product: k = ethReserve × tokenReserve
  // Selling tokensWhole: newTokenReserve = tokenReserve + tokensWhole
  // newEthReserve = k / newTokenReserve
  // ethOutGross = ethReserve - newEthReserve
  // fee = ethOutGross × 0.003
  // ethOut = ethOutGross - fee
  const k = ethReserve * tokenReserve
  const newTokenReserve = tokenReserve + tokensWhole
  const newEthReserve = k / newTokenReserve
  const ethOutGross = ethReserve - newEthReserve
  const fee = ethOutGross * (FEE_BPS / 10_000)
  const ethOut = ethOutGross - fee

  const entryAmount = parseFloat(r.entry_amount)
  const realizedPnl = ethOut - entryAmount

  const txSig = `paper:${randomUUID()}`
  const status = 'stopped' // stale-flat → stopped, not closed (token could revive)

  await pg.query('BEGIN')
  try {
    await pg.query(
      `UPDATE positions
          SET status=$1, exit_amount_native=$2, realized_pnl_native=$3,
              exit_tx_hash=$4, moonbag_tokens='0', closed_at=NOW(), updated_at=NOW()
        WHERE id=$5`,
      [status, ethOut.toFixed(18), realizedPnl.toFixed(18), txSig, r.id],
    )
    await pg.query('COMMIT')
    console.log(
      `  ${r.token_address.slice(0, 14)}  CLOSED  pnl=${realizedPnl.toFixed(6)} ETH  (entry ${entryAmount}, exit ${ethOut.toFixed(6)})`,
    )
    closed++
  } catch (err) {
    await pg.query('ROLLBACK')
    console.error(`  ${r.token_address.slice(0, 14)}  ERROR: ${err.message}`)
  }
}

console.log(`\nDone: ${closed} closed, ${kept} kept.`)
await pg.end()
process.exit(0)
