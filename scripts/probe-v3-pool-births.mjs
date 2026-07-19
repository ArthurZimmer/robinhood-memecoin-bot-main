// Sonda os primeiros pools V3/V4 criados após o início: nascem com liquidez
// (snipáveis) ou vazios (esperando graduação da bonding curve)? Quem os cria?
// V4: registra o endereço de hooks (hooks != 0 pode restringir compras).
import { WebSocketProvider, JsonRpcProvider, Contract, Interface, id } from 'ethers'
import { config } from 'dotenv'

config()

const ws = new WebSocketProvider(process.env.ROBBINHOOD_WS_URL)
const http = new JsonRpcProvider(process.env.ROBBINHOOD_RPC_URL)

const V2_TOPIC = id('PairCreated(address,address,address,uint256)')
const V3_TOPIC = id('PoolCreated(address,address,uint24,int24,address)')
const V4_TOPIC = id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)')
const v2Iface = new Interface([
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint256 allPairsLength)',
])
const v3Iface = new Interface([
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
])
const v4Iface = new Interface([
  'event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)',
])
const POOL_ABI = [
  'function liquidity() view returns (uint128)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
]

const v3Pools = []
const v4Inits = []
const v2Pairs = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await ws.on({ address: process.env.UNISWAP_FACTORY_ADDRESS, topics: [V2_TOPIC] }, (log) => {
  if (v2Pairs.length < 8) {
    const ev = v2Iface.parseLog(log)
    v2Pairs.push({ token0: ev.args.token0, token1: ev.args.token1, pair: ev.args.pair })
  }
})

await ws.on({ topics: [V3_TOPIC] }, (log) => {
  if (v3Pools.length < 6) {
    const ev = v3Iface.parseLog(log)
    v3Pools.push({ pool: ev.args.pool, token0: ev.args.token0, token1: ev.args.token1, fee: Number(ev.args.fee), tx: log.transactionHash, block: log.blockNumber })
  }
})
await ws.on({ topics: [V4_TOPIC] }, (log) => {
  if (v4Inits.length < 6) {
    const ev = v4Iface.parseLog(log)
    v4Inits.push({ currency0: ev.args.currency0, currency1: ev.args.currency1, fee: Number(ev.args.fee), hooks: ev.args.hooks, tx: log.transactionHash })
  }
})
console.log('coletando amostras (max 3 min)...')

const start = Date.now()
while ((v3Pools.length < 6 || v4Inits.length < 6) && Date.now() - start < 180_000) await sleep(2000)
await ws.destroy()

console.log(`\n=== V3: ${v3Pools.length} pools ===`)
for (const p of v3Pools) {
  try {
    await sleep(400)
    const c = new Contract(p.pool, POOL_ABI, http)
    // ~30s depois da criação: liquidez já adicionada?
    const [liq, receipt] = await Promise.all([c.liquidity(), http.getTransactionReceipt(p.tx)])
    console.log(`pool ${p.pool.slice(0, 14)} fee ${p.fee} liq=${liq} | tx.to=${receipt?.to ?? '?'} from=${receipt?.from?.slice(0, 14)} logs=${receipt?.logs.length}`)
  } catch (err) {
    console.log(`pool ${p.pool.slice(0, 14)} — probe falhou: ${err.shortMessage ?? err.message}`)
  }
}
const WETH = (process.env.WETH_ADDRESS ?? '').toLowerCase()
console.log(`\n=== V4: ${v4Inits.length} initializes ===`)
for (const i of v4Inits) {
  const vsEth = [i.currency0.toLowerCase(), i.currency1.toLowerCase()].includes(WETH) || i.currency0 === '0x0000000000000000000000000000000000000000'
  console.log(`fee ${i.fee} hooks=${i.hooks} parEth=${vsEth} tx=${i.tx.slice(0, 14)}`)
}
console.log(`\n=== V2 (factory do bot): ${v2Pairs.length} pares ===`)
for (const p of v2Pairs) {
  const vsEth = [p.token0.toLowerCase(), p.token1.toLowerCase()].includes(WETH)
  console.log(`pair ${p.pair.slice(0, 14)} token0=${p.token0.slice(0, 14)} token1=${p.token1.slice(0, 14)} parEth=${vsEth}`)
}
process.exit(0)
