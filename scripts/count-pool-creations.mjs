// Conta eventos de criação de pool na Robinhood Chain, por versão do Uniswap,
// nas últimas N horas — filtro por topic0 (assinatura), sem precisar do
// endereço das factories. Também lista os endereços emissores únicos.
import { JsonRpcProvider, id } from 'ethers'
import { config } from 'dotenv'

config({ path: '/Users/arthurzimmer/Documents/solana-memecoin-bot-main/.env' })

const provider = new JsonRpcProvider(process.env.ROBBINHOOD_RPC_URL)

const TOPICS = {
  'v2 PairCreated': id('PairCreated(address,address,address,uint256)'),
  'v3 PoolCreated': id('PoolCreated(address,address,uint24,int24,address)'),
  'v4 Initialize': id('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'),
}

const HOURS = Number(process.argv[2] ?? 2)
const BLOCKS_PER_SEC = 10 // ~10 blocos/s nesta chain
const CHUNK = 10_000

const latest = await provider.getBlockNumber()
const span = HOURS * 3600 * BLOCKS_PER_SEC
const from = Math.max(0, latest - span)
console.log(`bloco atual ${latest}, varrendo ${span} blocos (~${HOURS}h) em chunks de ${CHUNK}`)

for (const [label, topic] of Object.entries(TOPICS)) {
  let count = 0
  const emitters = new Map()
  for (let start = from; start <= latest; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, latest)
    try {
      const logs = await provider.getLogs({ fromBlock: start, toBlock: end, topics: [topic] })
      count += logs.length
      for (const l of logs) emitters.set(l.address, (emitters.get(l.address) ?? 0) + 1)
    } catch (err) {
      console.log(`  ${label}: chunk ${start}-${end} falhou (${err.shortMessage ?? err.message}) — pulando`)
    }
  }
  const top = [...emitters.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  console.log(`${label}: ${count} eventos | emissores: ${top.map(([a, c]) => `${a} (${c})`).join(', ') || 'nenhum'}`)
}
