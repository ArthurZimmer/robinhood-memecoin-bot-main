import { Wallet } from 'ethers'
import { env } from '../config/env.js'
import { rhProvider } from './robbinhood.utils.js'
import { createChildLogger } from './logger.js'

const log = createChildLogger('wallet')

// ── Bot Wallet ───────────────────────────────────────────────────────────────
// Handles EVM private key loading for the Robinhood Chain bot wallet.
// Supports hex keys (with or without 0x prefix, 64 hex chars = 32 bytes).
// In paper mode, wallet is null — no on-chain signing needed.

let cachedWallet: Wallet | null | undefined

/**
 * Returns an ethers Wallet connected to the Robinhood Chain provider.
 * Cached after first call. Returns null if no private key is configured
 * (valid in paper mode).
 */
export function getBotWallet(): Wallet | null {
  if (cachedWallet !== undefined) return cachedWallet

  if (!env.WALLET_PRIVATE_KEY) {
    if (env.TRADING_MODE === 'real') {
      throw new Error('WALLET_PRIVATE_KEY is required for real trading mode')
    }
    cachedWallet = null
    return null
  }

  const raw = env.WALLET_PRIVATE_KEY.trim()
  // Normalize: strip 0x prefix if present, then re-add
  const stripped = raw.startsWith('0x') ? raw.slice(2) : raw

  if (!/^[0-9a-fA-F]{64}$/.test(stripped)) {
    throw new Error(
      'WALLET_PRIVATE_KEY must be a 64-character hex string (32 bytes), with or without 0x prefix',
    )
  }

  cachedWallet = new Wallet(`0x${stripped}`, rhProvider)
  log.info({ address: cachedWallet.address }, 'Bot wallet loaded')
  return cachedWallet
}

/**
 * Returns the bot's Ethereum address (0x-prefixed, checksummed).
 * Returns null if no wallet is configured (paper mode).
 */
export function getBotAddress(): string | null {
  const wallet = getBotWallet()
  return wallet?.address ?? null
}
