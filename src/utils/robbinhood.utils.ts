import { JsonRpcProvider, Network } from 'ethers'
import { env } from '../config/env.js'
import { createChildLogger } from './logger.js'

const log = createChildLogger('robbinhood-utils')

// ── Robinhood Chain Providers ─────────────────────────────────────────────────
// Uses ethers.js v6 for EVM-compatible Robinhood Chain (chain ID 4663).
//
//   • rhProvider — HTTP JSON-RPC for queries and transaction submission
//   • WebSocket subscriptions live in ws-manager.ts (resilient, auto-reconnect)
//
// staticNetwork pins the chain and stops ethers from sending an eth_chainId
// probe with every request batch — that alone was ~13% of the QuickNode bill.

const network = Network.from({
  chainId: env.ROBBINHOOD_CHAIN_ID,
  name: 'robinhood-chain',
})

/** Primary HTTP JSON-RPC provider for queries and transactions. */
export const rhProvider = new JsonRpcProvider(env.ROBBINHOOD_RPC_URL, network, {
  staticNetwork: network,
})

// Log provider config at startup
log.info(
  {
    rpcUrl: env.ROBBINHOOD_RPC_URL,
    chainId: env.ROBBINHOOD_CHAIN_ID,
    hasWs: Boolean(env.ROBBINHOOD_WS_URL),
  },
  'Robinhood Chain HTTP provider initialized (staticNetwork)',
)

// ── Well-known addresses ──────────────────────────────────────────────────────

/** WETH on Robinhood Chain (used for routing swaps). */
export const WETH_ADDRESS = env.WETH_ADDRESS

/** Uniswap V2 Factory contract (monitors PairCreated events). */
export const UNISWAP_FACTORY_ADDRESS = env.UNISWAP_FACTORY_ADDRESS

/** Uniswap V2 Router02 (swap execution). */
export const UNISWAP_ROUTER_ADDRESS = env.UNISWAP_ROUTER_ADDRESS

/** Addresses used for native ETH swaps (WETH unwrap — sentinel value). */
export const NATIVE_ETH_ADDRESS = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
