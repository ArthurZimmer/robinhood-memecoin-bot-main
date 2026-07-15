// Standalone honeypot-probe tester — no DB/Redis required.
//
// Usage:
//   node scripts/probe-token.mjs <tokenAddress>
//   node scripts/probe-token.mjs --scan [count]   # scan recent factory pairs
//
// Reads ROBBINHOOD_RPC_URL, UNISWAP_ROUTER_ADDRESS, WETH_ADDRESS,
// UNISWAP_FACTORY_ADDRESS from .env.

import 'dotenv/config'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Interface, id } from 'ethers'

const RPC = process.env.ROBBINHOOD_RPC_URL
const ROUTER = process.env.UNISWAP_ROUTER_ADDRESS
const WETH = process.env.WETH_ADDRESS
const FACTORY = process.env.UNISWAP_FACTORY_ADDRESS
const PROBE_ADDRESS = '0x00000000000000000000000000000000DeaDBeef'
const AMOUNT_WEI = 10_000_000_000_000_000n // 0.01 ETH

if (!RPC || !ROUTER || !WETH) {
  console.error('Missing ROBBINHOOD_RPC_URL / UNISWAP_ROUTER_ADDRESS / WETH_ADDRESS in .env')
  process.exit(1)
}

// Vendored runtime bytecode — extract from the TS module to stay in sync.
const here = dirname(fileURLToPath(import.meta.url))
const tsSrc = readFileSync(join(here, '../src/risk/honeypot-probe.ts'), 'utf8')
const bytecode = (tsSrc.match(/"(0x)?([0-9a-f]{60,})"/gi) ?? [])
  .map((s) => s.replace(/"/g, ''))
  .join('')
  .replace(/0x/g, '')
const RUNTIME = '0x' + bytecode
if (bytecode.length < 2000) {
  console.error('Could not extract probe bytecode from honeypot-probe.ts')
  process.exit(1)
}

const iface = new Interface([
  'function probe(address router, address weth, address token, uint256 amountIn) returns (uint256 tokensQuoted, uint256 tokensReceived, uint256 ethQuoted, uint256 ethReceived)',
])

const pad = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0')

async function ethCall(to, data, overrides) {
  const params = [{ to, data }, 'latest']
  if (overrides) params.push(overrides)
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params }),
  })
  return res.json()
}

async function probe(token) {
  const data = iface.encodeFunctionData('probe', [ROUTER, WETH, token, AMOUNT_WEI])
  const overrides = {
    [PROBE_ADDRESS]: { code: RUNTIME, balance: '0x' + (AMOUNT_WEI * 3n).toString(16) },
  }
  const out = await ethCall(PROBE_ADDRESS, data, overrides)
  if (out.error) {
    return { ok: false, reason: out.error.message?.slice(0, 120) }
  }
  const d = iface.decodeFunctionResult('probe', out.result)
  const [tq, tr, eq, er] = d
  const buyTax = tq > 0n ? Number(((tq - tr) * 10000n) / tq) / 100 : 0
  const sellTax = eq > 0n ? Number(((eq - er) * 10000n) / eq) / 100 : 0
  const roundTrip = Number((er * 10000n) / AMOUNT_WEI) / 100
  return { ok: true, buyTax, sellTax, roundTrip, tq, tr, eq, er }
}

async function findWethToken(idx) {
  const p = '0x' + (await ethCall(FACTORY, '0x1e3dd18b' + pad('0x' + idx.toString(16)))).result.slice(-40)
  const t0 = '0x' + (await ethCall(p, '0x0dfe1681')).result.slice(-40)
  const t1 = '0x' + (await ethCall(p, '0xd21220a7')).result.slice(-40)
  const wethL = WETH.toLowerCase()
  const token = t0.toLowerCase() === wethL ? t1 : t1.toLowerCase() === wethL ? t0 : null
  return token ? { token, pair: p } : null
}

async function main() {
  const arg = process.argv[2]
  if (arg && arg !== '--scan') {
    const r = await probe(arg)
    console.log(arg, '->', r.ok ? `buyTax ${r.buyTax}% sellTax ${r.sellTax}% roundTrip ${r.roundTrip}%` : `REVERT: ${r.reason}`)
    return
  }

  // scan mode
  const count = Number(process.argv[3] ?? 8)
  const total = Number(BigInt((await ethCall(FACTORY, '0x574f2ba3')).result))
  console.log(`factory allPairsLength=${total}, scanning last WETH pairs for ${count} results...`)
  let found = 0
  for (let idx = total - 1; idx >= 0 && found < count; idx--) {
    const hit = await findWethToken(idx)
    if (!hit) continue
    const r = await probe(hit.token)
    found++
    if (r.ok) {
      const verdict = r.sellTax > 50 ? '🍯 HONEYPOT' : r.roundTrip > 95 ? '✅ clean' : '⚠️ taxed'
      console.log(`idx ${idx} ${hit.token.slice(0, 12)} ${verdict} buyTax ${r.buyTax}% sellTax ${r.sellTax}% roundTrip ${r.roundTrip}%`)
    } else {
      console.log(`idx ${idx} ${hit.token.slice(0, 12)} 🚫 REVERT (no-LP or honeypot): ${r.reason}`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
