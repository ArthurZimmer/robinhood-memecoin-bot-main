// Integration driver: exercises UniswapSnipeStrategy.decide() end-to-end against
// REAL Robinhood-chain data for one clean token and one honeypot, using the live
// snapshot + honeypot probe path. Requires Redis + Postgres up (docker compose).
//
// Run: npx tsx scripts/drive-decide.mts
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { Contract, id } from 'ethers'
import { rhProvider, WETH_ADDRESS, UNISWAP_FACTORY_ADDRESS } from '../src/utils/robbinhood.utils.js'
import { eventBus } from '../src/events/event-bus.js'
import { uniswapSnipeStrategy } from '../src/strategies/uniswap-snipe.strategy.js'
import { probeToken } from '../src/risk/honeypot-probe.js'
import type { ApprovedOpportunity, PoolCreatedEvent, RiskResult } from '../src/events/event-types.js'

const FACTORY = new Contract(UNISWAP_FACTORY_ADDRESS, [
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
], rhProvider)
const PAIR_ABI = [
  'function getReserves() view returns (uint112,uint112,uint32)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
]
const ERC20 = [
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
]
const wethL = WETH_ADDRESS.toLowerCase()

async function pairDetail(idx: number) {
  const pair = await FACTORY.allPairs!(idx)
  const p = new Contract(pair, PAIR_ABI, rhProvider)
  const [t0, t1] = await Promise.all([p.token0!(), p.token1!()])
  let token: string | null = null
  if (t0.toLowerCase() === wethL) token = t1
  else if (t1.toLowerCase() === wethL) token = t0
  else return null
  const res = await p.getReserves!()
  const r0 = BigInt(res[0]), r1 = BigInt(res[1])
  const ethReserve = t0.toLowerCase() === wethL ? r0 : r1
  if (ethReserve === 0n) return null
  const tok = new Contract(token, ERC20, rhProvider)
  const [dec, supply, symbol, name] = await Promise.all([
    tok.decimals!().then(Number).catch(() => 18),
    tok.totalSupply!().then((v: bigint) => v.toString()).catch(() => '0'),
    tok.symbol!().catch(() => ''),
    tok.name!().catch(() => ''),
  ])
  return { idx, pair, token, t0, t1, r0: r0.toString(), r1: r1.toString(), dec, supply, symbol, name, ethReserveEth: Number(ethReserve) / 1e18 }
}

function buildOpp(d: NonNullable<Awaited<ReturnType<typeof pairDetail>>>): ApprovedOpportunity {
  const now = Date.now()
  const source: PoolCreatedEvent = {
    eventId: randomUUID(),
    type: 'pool_created',
    protocol: 'uniswap',
    timestamp: now - 5_000, // older than MIN_TOKEN_AGE_MS
    poolAddress: d.pair,
    tokenAddress: d.token,
    quoteTokenAddress: WETH_ADDRESS,
    deployerAddress: '0x000000000000000000000000000000000000dEaD',
    txHash: '0x' + '0'.repeat(64),
    token0: d.t0,
    token1: d.t1,
    reserve0: d.r0,
    reserve1: d.r1,
    totalSupply: d.supply,
    tokenDecimals: d.dec,
    tokenMetadata: { name: d.name, symbol: d.symbol },
    blockNumber: 0,
  } as PoolCreatedEvent
  const risk: RiskResult = {
    passed: true, riskScore: 20, riskLevel: 'low', flags: [], checks: {}, evaluatedAt: now,
  }
  return {
    candidateId: randomUUID(),
    timestamp: now,
    protocol: 'uniswap',
    tokenAddress: d.token,
    poolAddress: d.pair,
    deployerAddress: source.deployerAddress,
    initialLiquidityNative: d.ethReserveEth,
    detectorScore: 60,
    sourceEvent: source,
    risk,
  }
}

async function main() {
  await eventBus.start()
  const total = Number(await FACTORY.allPairsLength!())
  console.log('allPairsLength', total, '— scanning for one clean + one honeypot...')

  let clean: Awaited<ReturnType<typeof pairDetail>> | null = null
  let honey: Awaited<ReturnType<typeof pairDetail>> | null = null

  for (let idx = total - 1; idx >= 0 && (!clean || !honey); idx--) {
    const d = await pairDetail(idx).catch(() => null)
    if (!d) continue
    const probe = await probeToken(d.token)
    if (probe.ok && probe.sellTaxPct <= 5 && !clean && d.ethReserveEth >= 0.05) {
      clean = d
      console.log(`  clean  candidate idx ${idx} ${d.symbol} ethR ${d.ethReserveEth.toFixed(3)} sellTax ${probe.sellTaxPct}%`)
    } else if ((!probe.ok || probe.sellTaxPct > 50) && !honey && d.ethReserveEth >= 0.02 && d.symbol) {
      // Require liquidity + a symbol so it can clear score/MC gates and actually
      // reach the honeypot probe inside decide().
      honey = d
      console.log(`  honey  candidate idx ${idx} ${d.symbol} ethR ${d.ethReserveEth.toFixed(3)} ${probe.ok ? 'sellTax ' + probe.sellTaxPct + '%' : 'REVERT/' + probe.error}`)
    }
  }

  for (const [label, d] of [['CLEAN', clean], ['HONEYPOT', honey]] as const) {
    if (!d) { console.log(`\n[${label}] none found in scan range`); continue }
    console.log(`\n=== decide() on ${label}: ${d.symbol || d.token.slice(0, 10)} (${d.token}) ===`)
    const signal = await uniswapSnipeStrategy.decide(buildOpp(d))
    if (signal) {
      console.log(`  -> SIGNAL emitted. probe buyTax=${signal.honeypotProbe?.buyTaxPct}% sellTax=${signal.honeypotProbe?.sellTaxPct}% roundTrip=${signal.honeypotProbe?.roundTripPct}%`)
    } else {
      console.log('  -> null (rejected — see strategy logs above)')
    }
  }

  await eventBus.stop()
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
