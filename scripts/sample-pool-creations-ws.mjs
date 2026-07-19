// Amostra criações de pool na Robinhood Chain via WebSocket push, por versão
// do Uniswap (topic0), durante N minutos. Push é barato no QuickNode (paga por
// notificação, e criações de pool são raras) — contorna o limite de 5 blocos
// do eth_getLogs no plano free.
import { WebSocketProvider, id } from 'ethers'
import { config } from 'dotenv'

config()

const MINUTES = Number(process.argv[2] ?? 45)
const provider = new WebSocketProvider(process.env.ROBBINHOOD_WS_URL)

const TOPICS = {
  v2: id('PairCreated(address,address,address,uint256)'),
  v3: id('PoolCreated(address,address,uint24,int24,address)'),
  v4: id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'),
}

const counts = { v2: 0, v3: 0, v4: 0 }
const factories = { v2: new Map(), v3: new Map(), v4: new Map() }

for (const [ver, topic] of Object.entries(TOPICS)) {
  await provider.on({ topics: [topic] }, (log) => {
    counts[ver] += 1
    factories[ver].set(log.address, (factories[ver].get(log.address) ?? 0) + 1)
    console.log(`${new Date().toISOString()} ${ver} pool novo — factory ${log.address} tx ${log.transactionHash.slice(0, 18)}`)
  })
}
console.log(`${new Date().toISOString()} sampler ativo por ${MINUTES} min (v2 PairCreated / v3 PoolCreated / v4 Initialize)`)

setTimeout(async () => {
  console.log('=== RESUMO DA AMOSTRA ===')
  for (const ver of Object.keys(counts)) {
    const f = [...factories[ver].entries()].map(([a, c]) => `${a}(${c})`).join(' ')
    console.log(`${ver}: ${counts[ver]} pools novos em ${MINUTES} min ${f ? '| factories: ' + f : ''}`)
  }
  await provider.destroy()
  process.exit(0)
}, MINUTES * 60_000)
