// One-off: retroactively apply the LP-pull guard to yesterday's 45 paper entries.
// For each position: re-read on-chain deployer LP concentration NOW, and cross-
// check against the actual realized outcome. Then recompute PnL with/without the
// entries the guard would have blocked.
import { config } from 'dotenv'
import pg from 'pg'
import { JsonRpcProvider, Network, Contract } from 'ethers'

config()

const LP_MAX = Number(process.env.LP_MAX_DEPLOYER_PCT ?? 20)
const ENTRY = 0.005
// A near-total loss ≈ liquidity vanished after entry = the LP-pull signature the
// guard targets. Threshold: lost >= 88% of the 0.005 entry.
const RUG_PNL = -0.0044

const network = new Network('robinhood', Number(process.env.ROBBINHOOD_CHAIN_ID ?? 4663))
const provider = new JsonRpcProvider(process.env.ROBBINHOOD_RPC_URL, network, { staticNetwork: network })
const PAIR_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
]

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const { rows } = await pool.query(`
  SELECT token_symbol, pool_address,
         metadata->>'deployerAddress' AS deployer,
         realized_pnl_native::float8 AS pnl, status, opened_at
  FROM positions ORDER BY opened_at ASC
`)

async function lpPctNow(poolAddr, deployer) {
  if (!poolAddr || !deployer) return { pct: null, err: 'missing addr' }
  try {
    const c = new Contract(poolAddr, PAIR_ABI, provider)
    const [bal, sup] = await Promise.all([c.balanceOf(deployer), c.totalSupply()])
    if (sup <= 0n) return { pct: null, err: 'supply 0' }
    return { pct: Number((bal * 10000n) / sup) / 100, err: null }
  } catch (e) {
    return { pct: null, err: String(e.message ?? e).slice(0, 40) }
  }
}

let netAll = 0, netGuardOnchain = 0, netGuardOutcome = 0
let blockedOnchain = 0, blockedOutcome = 0, rpcFail = 0
const detail = []

for (const r of rows) {
  netAll += r.pnl
  const { pct, err } = await lpPctNow(r.pool_address, r.deployer)
  // Guard behaviour: block if deployer LP% > max, OR fail-closed on read error.
  const blockOnchain = pct === null ? true : pct > LP_MAX
  if (pct === null) rpcFail++
  if (blockOnchain) blockedOnchain++; else netGuardOnchain += r.pnl
  // Outcome proxy: treat near-total losses as the LP-pull rugs the guard exists for.
  const isRug = r.pnl <= RUG_PNL
  if (isRug) blockedOutcome++; else netGuardOutcome += r.pnl
  detail.push({ sym: r.token_symbol, pnl: r.pnl, pct, err, isRug, blockOnchain })
}

const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(5)
console.log('\n=== POR POSIÇÃO (ordem cronológica) ===')
console.log('symbol'.padEnd(14), 'pnl'.padStart(9), 'LP%_now'.padStart(9), 'rug?'.padStart(6), 'guard_onchain')
for (const d of detail) {
  const lp = d.pct === null ? (d.err ?? 'null') : d.pct.toFixed(2) + '%'
  console.log(
    (d.sym ?? '?').slice(0, 13).padEnd(14),
    fmt(d.pnl).padStart(9),
    lp.padStart(9),
    (d.isRug ? 'RUG' : '·').padStart(6),
    d.blockOnchain ? 'BLOCK' : 'pass',
  )
}

const winners = detail.filter((d) => d.pnl > 0)
const rugs = detail.filter((d) => d.isRug)
const faders = detail.filter((d) => d.pnl <= 0 && !d.isRug)

console.log('\n=== DISTRIBUIÇÃO POR RESULTADO (45 entradas, 0.005 ETH cada) ===')
console.log(`  ganhadoras (pnl>0):        ${winners.length}  soma ${fmt(winners.reduce((s, d) => s + d.pnl, 0))}`)
console.log(`  rugs (perda ~total):       ${rugs.length}  soma ${fmt(rugs.reduce((s, d) => s + d.pnl, 0))}`)
console.log(`  faders (perda parcial):    ${faders.length}  soma ${fmt(faders.reduce((s, d) => s + d.pnl, 0))}`)

console.log('\n=== CENÁRIOS DE PnL ===')
console.log(`  SEM guard (real de ontem):                 ${fmt(netAll)} ETH  (45 entradas)`)
console.log(`  COM guard [proxy por resultado]:           ${fmt(netGuardOutcome)} ETH  (bloquearia ${blockedOutcome}, restam ${45 - blockedOutcome})`)
console.log(`  COM guard [releitura on-chain agora]:       ${fmt(netGuardOnchain)} ETH  (bloquearia ${blockedOnchain}, restam ${45 - blockedOnchain})`)
console.log(`\n  * releitura on-chain: ${rpcFail} leituras falharam/indisponíveis (fail-closed=block).`)
console.log('  * ATENÇÃO: rug que já puxou o LP zera o balance do deployer AGORA,')
console.log('    então a releitura on-chain SUBESTIMA os rugs (lower bound). O proxy')
console.log('    por resultado é o mais fiel ao que o LP-pull custou de fato.')

await pool.end()
process.exit(0)
