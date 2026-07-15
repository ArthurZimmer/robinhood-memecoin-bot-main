# Architectural Migration Plan: Solana/Pump.fun → Robbinhood Network

**Status:** Pending Approval  
**Date:** 2026-07-12  
**Scope:** Full pipeline conversion — listener → parser → detector → risk engine → strategy → executor → position manager → dashboard

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [What Stays, What Changes](#2-what-stays-what-changes)
3. [Layer-by-Layer Migration](#3-layer-by-layer-migration)
   - [A. Configuration & Environment](#a-configuration--environment)
   - [B. Utilities & Infrastructure](#b-utilities--infrastructure)
   - [C. Database Schema](#c-database-schema)
   - [D. Event System](#d-event-system)
   - [E. Listeners](#e-listeners)
   - [F. Parsers](#f-parsers)
   - [G. Detectors](#g-detectors)
   - [H. Risk Engine](#h-risk-engine)
   - [I. Strategy](#i-strategy)
   - [J. Executors](#j-executors)
   - [K. Position Manager](#k-position-manager)
   - [L. Dev Wallet Monitor](#l-dev-wallet-monitor)
   - [M. Dashboard](#m-dashboard)
   - [N. Bootstrap](#n-bootstrap)
4. [Migration Phases & Timeline](#4-migration-phases--timeline)
5. [File Change Inventory](#5-file-change-inventory)
6. [Open Questions Requiring User Confirmation](#6-open-questions-requiring-user-confirmation)

---

## 1. Executive Summary

The current bot is a **Solana/Pump.fun memecoin sniping bot** operating over a 7-stage Redis Streams pipeline. It detects Pump.fun token launches, evaluates risk, enters positions with configurable TP/SL, monitors positions in real-time via WebSocket, and supports both paper and real on-chain trading.

This plan details **every file, function, and integration point** that must change to convert the bot from Solana to the Robbinhood network. The pipeline structure (Redis Streams) and core architecture (event-driven, dual-mode execution, multi-tier scoring) remain intact — only the blockchain-specific layers are replaced.

### Key Principles

- **Preserve the pipeline**: Redis Streams, consumer groups, and the 7-stage event flow stay exactly as-is
- **Replace the blockchain layer**: Everything touching Solana (RPC, WS, transactions, accounts, AMM math) gets a Robbinhood equivalent
- **Keep the trading logic**: TP/SL, multi-tier entry, scoring algorithms, risk evaluation logic are blockchain-agnostic
- **Paper mode first**: Implement and test everything in paper mode before touching real on-chain execution
- **Dual-mode throughout**: Both paper and real modes must work end-to-end before the migration is considered complete

---

## 2. What Stays, What Changes

### Preserved (No Changes)

| Component | Reason |
|-----------|--------|
| Redis Streams (`eventBus`) | Chain-agnostic message bus |
| PostgreSQL + Drizzle ORM | No schema changes needed besides enum additions |
| Pino Logger + redaction | Generic Node.js logging |
| Telegram alerts (`src/utils/telegram.ts`) | Generic HTTP call |
| Dotenv + Zod config | Validation pattern preserved, values replaced |
| CoinGecko SOL/USD → token/USD | Only the token symbol changes |
| Dashboard HTTP server structure | Only connection details and links change |
| Token analyzer scoring logic | Symbol/name/metadata scoring is chain-agnostic |
| Multi-tier entry gates | Concept preserved, MC calculation changes |
| Scam buzzwords / Levenshtein | Pure string analysis, no chain deps |
| Redis caching patterns | TTLs, prefixes preserved |

### Replaced (All Solana-specific Layers)

| Current (Solana/Pump.fun) | Replacement (Robbinhood) |
|---------------------------|--------------------------|
| `@solana/web3.js` Connection/Keypair/PublicKey/Transaction/VersionedTransaction | Robbinhood SDK equivalent (RPC client, wallet, transaction builder) |
| `@solana/spl-token` (Associated Token Accounts, AccountLayout) | Robbinhood token standard (ERC-20 equivalent or native token model) |
| `bs58` (base58 encoding) | Robbinhood address encoding (likely hex/bech32) |
| PumpPortal WebSocket (`wss://pumpportal.fun/api/data`) | Robbinhood event source (WebSocket or polling API) |
| Helius RPC/WS (`HELIUS_API_KEY`, `HELIUS_RPC_URL`, `HELIUS_WS_URL`, `HELIUS_SENDER_URL`) | Robbinhood RPC/WS provider |
| Pump.fun bonding curve (`PUMPFUN_PROGRAM_ID`, constant-product AMM) | Robbinhood AMM / bonding curve contract |
| Jupiter API v6 swap integration | Robbinhood DEX aggregator or direct router swap |
| Solana-specific addresses (base58, 32-44 chars) | Robbinhood addresses (hex/EVM or custom format) |
| `ComputeBudgetProgram` / priority fees in lamports | Robbinhood fee model (gas in native token) |
| Solana `onAccountChange` WebSocket | Robbinhood equivalent (event logs, balance subscription) |
| Solana `getTokenAccountBalance` / `getMint` / `getParsedTransaction` | Robbinhood equivalent on-chain queries |
| Dev wallet ATA monitoring | Robbinhood balance/approval monitoring |
| `WALLET_PRIVATE_KEY` (base58 Solana keypair) | Robbinhood private key format |
| Pump.fun anchor instruction parsing (create, buy, sell discriminators) | Robbinhood smart contract event/log parsing |
| Pump.fun PDAs (`bondingCurvePda`, `globalPda`, `eventAuthorityPda`) | Robbinhood contract addresses |
| Transaction simulation (`simulateAndSend`) | Robbinhood gas estimation / callStatic |
| Lamports → SOL conversion (1e9) | Robbinhood native unit → token conversion |
| Pump.fun 1% fee model | Robbinhood fee structure |

---

## 3. Layer-by-Layer Migration

### A. Configuration & Environment

**File:** `src/config/env.ts`

**Changes:**

```typescript
// REMOVE these Solana-specific fields from envSchema:
HELIUS_API_KEY       // z.string()
HELIUS_RPC_URL       // z.string().url()
HELIUS_WS_URL        // z.string().refine(wss) — optional
HELIUS_SENDER_URL    // z.string().url() — optional
WALLET_PRIVATE_KEY   // z.string().optional() — Solana base58 keypair
JITO_BLOCK_ENGINE_URL // z.string().url() — optional
JITO_TIP_LAMPORTS     // z.coerce.number().int().positive()

// ADD these Robbinhood-specific fields:
ROBBINHOOD_RPC_URL           // z.string().url() — primary RPC endpoint
ROBBINHOOD_WS_URL            // z.string() — WebSocket endpoint (wss://...)
ROBBINHOOD_CHAIN_ID          // z.coerce.number().int() — chain ID
ROBBINHOOD_PRIVATE_KEY       // z.string() — private key for bot wallet
ROBBINHOOD_EXPLORER_URL      // z.string().url() — block explorer base URL
ROBBINHOOD_DEX_ROUTER        // z.string() — DEX router contract address
ROBBINHOOD_EVENT_SOURCE_URL  // z.string().url() — token launch event source (WebSocket or polling API)
ROBBINHOOD_EVENT_SOURCE_TYPE // z.enum(['websocket', 'polling', 'rpc_logs'])
ROBBINHOOD_LAUNCH_FACTORY    // z.string() — factory/launch contract address
ROBBINHOOD_NATIVE_SYMBOL     // z.string().default('ETH') — native token symbol
ROBBINHOOD_NATIVE_DECIMALS   // z.coerce.number().int().default(18)
ROBBINHOOD_TOKEN_DECIMALS    // z.coerce.number().int().default(18)

// RENAME / REPURPOSE:
// TRADE_SIZE_SOL → TRADE_SIZE_NATIVE (still in native units, not lamports)
// PAPER_BALANCE_SOL → PAPER_BALANCE_NATIVE
// DAILY_LOSS_LIMIT_SOL → DAILY_LOSS_LIMIT_NATIVE
// MIN_WALLET_BALANCE_SOL → MIN_WALLET_BALANCE_NATIVE
// MIN_DEV_BUY_SOL → MIN_DEV_BUY_NATIVE
```

**Validation cross-checks to update:**
- Remove `TRADING_MODE==='real' && !WALLET_PRIVATE_KEY` check
- Add `TRADING_MODE==='real' && !ROBBINHOOD_PRIVATE_KEY` check

---

### B. Utilities & Infrastructure

#### B1. `src/utils/solana.utils.ts` → `src/utils/robbinhood.utils.ts`

**Current content (31 lines):**
- Creates Solana `Connection` with `HELIUS_RPC_URL`
- Creates dedicated `sendConnection` for `HELIUS_SENDER_URL`
- Exports `NATIVE_SOL_MINT`

**New content:**
```typescript
// Robbinhood connection management
import { RobbinhoodProvider } from 'robbinhood-sdk' // or ethers/web3 equivalent

export const rhProvider = new RobbinhoodProvider(env.ROBBINHOOD_RPC_URL)
export const rhWsProvider = new RobbinhoodProvider(env.ROBBINHOOD_WS_URL) // if WebSocket-based
export const NATIVE_TOKEN_ADDRESS = '0xEeeeeEeeeE...' // or native token marker
```

**Key differences from Solana:**
- Solana `Connection` → Robbinhood `Provider` / `JsonRpcProvider`
- Solana accounts are queried by address → Robbinhood uses contract calls / eth_call
- No separate "sender" connection needed (RPC is stateless, unlike Solana's leader-aware sends)

#### B2. `src/utils/wallet.ts`

**Changes:**
```typescript
// REMOVE:
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
// PublicKey handling, base58 decode, format detection (base58/hex/JSON array)

// ADD:
import { Wallet } from 'ethers' // or robbinhood-sdk Wallet
// Private key detection: hex with/without 0x prefix (64 hex chars)
// Mnemonic support (optional but recommended)
export function getBotWallet(): Wallet {
  // Cache in module scope
  // Auto-detect: hex (64 chars) → new Wallet(privateKey)
  //              mnemonic (12/24 words) → Wallet.fromMnemonic()
  // Connect to provider: wallet.connect(provider)
}
export function getBotAddress(): string {
  // Returns wallet.address (hex, checksummed)
}
```

#### B3. `src/utils/telegram.ts`

**No changes.** HTTP call to Telegram Bot API is chain-agnostic.

#### B4. `src/utils/logger.ts`

**Changes:**
- Update secret redaction paths: `WALLET_PRIVATE_KEY` → `ROBBINHOOD_PRIVATE_KEY`
- Remove `HELIUS_API_KEY` from redaction list
- Add any new Robbinhood secrets

---

### C. Database Schema

**File:** `src/database/schema.ts`

**Changes (minimal):**

```typescript
// protocolEnum — ADD 'robbinhood' as a new value
export const protocolEnum = pgEnum('protocol', [
  'pumpfun',    // KEEP for historical data
  'raydium',    // KEEP
  'meteora',    // KEEP
  'jupiter',    // KEEP
  'robbinhood', // NEW
])

// positions table:
// - poolAddress: was Solana bonding curve PDA → now Robbinhood pool/pair address
// - tokenAddress: was Solana mint (base58) → now Robbinhood token (hex)
// - deployerAddress: was Solana creator (base58) → now Robbinhood deployer (hex)
// - metadata.bondingCurveSnapshot: { vSol, vTokens } → { nativeReserves, tokenReserves }
// - metadata.deployerAddress: was base58 → hex
// - entryPriceSol: was string → keep as string but rename meaningfully? Or keep name as "price per token in native"
//   DECISION: Keep column name entryPriceSol but it now stores "entry price in native token"
//   Alternative: rename to entryPriceNative — requires migration

// ADD to NewPosition:
// - pairAddress: string (the Robbinhood pair/liquidity pool address)

// risk_evaluations table:
// - poolAddress was Solana bonding curve → Robbinhood pair address
// - deployerAddress was base58 → hex
```

**Minimal schema changes needed.** Most columns are semantic (address strings, prices, percentages) and work for any chain by just storing different address formats.

---

### D. Event System

#### D1. `src/events/event-bus.ts`

**No changes.** Redis XADD/XREADGROUP is chain-agnostic. The serialize/deserialize logic (JSON) handles any data shape.

#### D2. `src/events/event-types.ts`

**Changes:**

```typescript
// protocols: ADD 'robbinhood'
export type Protocol = 'pumpfun' | 'raydium' | 'meteora' | 'jupiter' | 'robbinhood'

// RawEvent:
// - source: was 'pumpportal' | 'helius' → now 'robbinhood_ws' | 'robbinhood_rpc'

// PoolCreatedEvent (replace Pump.fun specific fields):
export interface PoolCreatedEvent {
  // KEEP (chain-agnostic):
  tokenAddress: string       // hex token address
  symbol: string
  name: string
  uri?: string
  deployerAddress: string    // hex deployer address
  protocol: 'robbinhood'
  sourceEvent: {
    txSignature: string      // tx hash (0x...)
    blockNumber: number
    timestamp: number
    initialBuyNative: number // initial buy amount in native token
    pairAddress: string      // pair/liquidity pool address
    // REMOVE: bondingCurveKey, vTokensInBondingCurve, vSolInBondingCurve
    // ADD: any Robbinhood-specific pool metadata
    initialNativeReserves?: number
    initialTokenReserves?: number
    metadata?: Record<string, unknown>
  }
}

// ApprovedOpportunity — add Robbinhood-specific fields:
// - pairAddress: string
// - initialNativeReserves: number
// - initialTokenReserves: number

// TradeSignal — update:
// - poolAddress → pairAddress
// - ADD: chainId, gasLimit, maxFeePerGas, maxPriorityFeePerGas
// - REMOVE: bondingCurveState
```

---

### E. Listeners

#### E1. `src/listeners/pumpportal.listener.ts` → `src/listeners/robbinhood.listener.ts`

**Complete rewrite.** This is the entry point for token launch events.

**Options for event ingestion (depends on Robbinhood's API):**

1. **WebSocket (preferred, like PumpPortal):**
   ```typescript
   // Connect to Robbinhood event WebSocket
   // Subscribe to token creation events
   // Parse and publish to events:raw
   ```

2. **RPC log subscription (like Helius logsSubscribe):**
   ```typescript
   // Subscribe to contract event logs (Transfer, PairCreated, etc.)
   // Filter by factory/launch contract address
   // Parse event logs into RawEvent
   ```

3. **Polling (fallback):**
   ```typescript
   // Poll API endpoint or RPC for recent blocks
   // Scan for token creation events
   // Dedup by tx hash
   ```

**Implementation template:**

```typescript
import WebSocket from 'ws'
import { randomUUID } from 'node:crypto'
import { createChildLogger } from '../utils/logger.js'
import { eventBus } from '../events/event-bus.js'
import { STREAMS } from '../events/event-types.js'
import type { BaseListener } from './base.listener.js'

const log = createChildLogger('robbinhood-listener')

interface RobbinhoodCreatePayload {
  transactionHash: string
  tokenAddress: string
  deployerAddress: string
  pairAddress: string
  initialBuyAmount: string // in wei or native units
  name: string
  symbol: string
  // ... other Robbinhood-specific fields
}

export class RobbinhoodListener implements BaseListener {
  private ws: WebSocket | null = null
  // ... same lifecycle pattern as PumpPortalListener:
  //     start/stop, connect/reconnect with backoff, watchdog, handleMessage

  private handleMessage(raw: WebSocket.Data): void {
    const msg = JSON.parse(raw.toString())
    
    // Validate required fields
    if (!msg.tokenAddress || !msg.pairAddress || !msg.deployerAddress) {
      log.warn({ msg }, 'Create event missing required fields — skipping')
      return
    }

    const rawEvent = {
      eventId: randomUUID(),
      type: 'raw',
      source: 'robbinhood_ws',
      protocol: 'robbinhood',
      timestamp: Date.now(),
      rawData: msg as RobbinhoodCreatePayload,
    }

    eventBus.publish(STREAMS.RAW, rawEvent).catch((err) => {
      log.error({ err, tx: msg.transactionHash }, 'Failed to publish raw event')
    })
  }
}

export const robbinhoodListener = new RobbinhoodListener()
```

**Reuse:** The entire WebSocket lifecycle (reconnect with exponential backoff, silence watchdog, subscription handling) is identical to PumpPortalListener — keep the same class structure.

---

### F. Parsers

#### F1. `src/parsers/pumpfun.parser.ts` → `src/parsers/robbinhood.parser.ts`

**Complete rewrite** of the parsing logic, keeping the parser class structure.

**Current pumpfun.parser does:**
1. PumpPortal path (instant, pre-decoded) — extracts mint, bondingCurve, creator, solAmount, metadata
2. Helius path (logsSubscribe → fetch tx → decode anchor instruction) — decodes Anchor CREATE discriminator `[24, 30, 200, 40, 5, 28, 7, 119]`, parses base58 instruction data, reads u32-length-prefixed strings

**New robbinhood.parser does:**
1. Primary path (WebSocket payload — already decoded, like PumpPortal)
2. Fallback path (RPC tx fetch + event log decode — for missed events)

```typescript
export class RobbinhoodParser implements BaseParser {
  async parse(raw: RawEvent): Promise<TokenLaunchEvent | null> {
    if (raw.protocol !== 'robbinhood') return null

    // PATH 1: Pre-decoded WebSocket payload (fast, no RPC)
    if (raw.source === 'robbinhood_ws') {
      return this.parseFromWsPayload(raw.rawData as RobbinhoodCreatePayload)
    }

    // PATH 2: Fallback — fetch tx from RPC and decode event logs
    if (raw.source === 'robbinhood_rpc') {
      return this.parseFromRpc(raw.rawData)
    }

    return null
  }

  private parseFromWsPayload(payload: RobbinhoodCreatePayload): TokenLaunchEvent | null {
    // Extract and validate fields
    // Build TokenLaunchEvent with:
    //   - tokenAddress, symbol, name, uri (metadata)
    //   - deployerAddress
    //   - poolAddress → pairAddress  
    //   - initialBuyNative
    //   - protocol: 'robbinhood'
    //   - sourceEvent with tx, block, initial reserves
    return { /* TokenLaunchEvent */ }
  }

  private async parseFromRpc(raw: unknown): Promise<TokenLaunchEvent | null> {
    // Fetch transaction receipt from RPC
    // Decode event logs (topic0 = keccak256("TokenCreated(address,address,address,uint256,string,string)"))
    // Extract fields from decoded log
    // Build TokenLaunchEvent
  }
}
```

**Key differences from pumpfun.parser:**
- No Anchor discriminator byte matching → EVM event topic matching (keccak256 hash of event signature)
- No base58 instruction data → ABI-encoded event logs
- No u32-length-prefixed strings → Solidity strings are ABI-encoded (offset + length + data)
- No pump-amm/bonk/launchlab venue filtering → Robbinhood equivalent venue filtering if multiple launch platforms exist

---

### G. Detectors

#### G1. `src/detectors/pumpfun-launch.detector.ts` → `src/detectors/robbinhood-launch.detector.ts`

**Heavy rewrite needed.** The detector is the most logic-dense file (533 lines).

**What stays (chain-agnostic):**
- Token age gate (`MAX_SIGNAL_AGE_MS`)
- Mint dedup with LRU cache
- Exact symbol+name duplicate detection
- Fuzzy symbol spam detection (Levenshtein similarity ≥ 0.8, cluster ≥ 3 within 2 min)
- Deployer burst detection (> 5 tokens in 5 min)
- Symbol quality scoring (0.25)
- Name quality scoring (0.15)
- Metadata signal detection (0.20) — socials, image, description quality
- Deployer reputation tracking (0.20)
- Dev buy commitment scoring (0.20)
- Weighted composite scoring (0-100)
- All token analyzer calls (`analyzeToken`, `trackDeployer`, etc.)

**What changes:**
- Address validation: was base58 (32-44 chars) → Robbinhood format (hex with 0x prefix, 42 chars)
- No `initialBuySol` = `solAmount / 1e9` → `initialBuyNative` = `amount / 10^{ROBBINHOOD_NATIVE_DECIMALS}`
- All Solana-specific extraction from event payload → Robbinhood extraction
- MC calculation: was `(vSol/vTokens) * 1B * SOL_USD` → new formula based on Robbinhood pool model

**MC calculation changes:**
```typescript
// OLD (Pump.fun bonding curve):
// spotPriceSol = virtualSolReserves / virtualTokenReserves
// mcUsd = spotPriceSol * TOTAL_SUPPLY * solUsdPrice

// NEW (Robbinhood):
// If Robbinhood uses a similar bonding curve:
// spotPriceNative = nativeReserves / tokenReserves
// mcUsd = spotPriceNative * TOTAL_SUPPLY * nativeUsdPrice

// If Robbinhood uses Uniswap V2 style:
// spotPriceNative = nativeReserves / tokenReserves
// mcUsd = spotPriceNative * TOTAL_SUPPLY * nativeUsdPrice
```

**Minimum score check:** Keep the < 15 floor but recalibrate after testing with real Robbinhood token data.

---

### H. Risk Engine

#### H1. `src/risk/risk-engine.ts`

**Minimal changes.** The engine itself (sequential fail-fast pipeline, aggregate scoring) is chain-agnostic.

**Changes:**
- Import Robbinhood checks instead of Solana checks
- Candidates now have `robbinhood` protocol → checks need protocol-awareness

#### H2. `src/risk/checks/token-quality.check.ts`

**Changes:**
- Address format validation: hex instead of base58
- Update thresholds — same concept, may need recalibration for Robbinhood token naming conventions
- Weight stays at 0.10

#### H3. `src/risk/checks/liquidity.check.ts`

**Changes:**
- `MIN_LIQUIDITY_NATIVE` instead of `MIN_LIQUIDITY_SOL`
- Pool/reserve queries go to Robbinhood contracts instead of Solana accounts
- Weight stays at 0.15

#### H4. `src/risk/checks/deployer-blacklist.check.ts`

**Changes:**
- Address format in Redis hash keys: `blacklist:deployers` → same key, but deployer addresses are hex
- DB query: same table, addresses stored as hex
- Severity/weight logic unchanged (0.25)

#### H5. `src/risk/checks/mint-freeze-authority.check.ts` → `src/risk/checks/token-ownership.check.ts`

**Complete rewrite.** Solana's mint authority + freeze authority is Solana-specific (SPL Token program).

**Robbinhood equivalent:**
- Check if token has a proxy/upgradeable contract pattern
- Check if ownership is renounced (transferOwnership to address(0))
- Check if the token has a mint function accessible by deployer
- Check for honeypot patterns (can sell = true?)
- Check liquidity lock status
- Weight stays at 0.35

```typescript
export const tokenOwnershipCheck: RiskCheck = {
  name: 'token-ownership',
  weight: 0.35,
  async evaluate(candidate) {
    // 1. Check if ownership is renounced (owner() = address(0))
    // 2. Check if token has a pause/unpause mechanism
    // 3. Check if there are mint/burn capabilities
    // 4. Check liquidity lock (if applicable to Robbinhood)
    // 5. Check for transfer fees / tax tokens
    // Pass: ownership renounced OR locked, no mint capability, no pause
    // Critical fail: owner can mint OR pause transfers
  }
}
```

#### H6. `src/risk/risk-score.ts`

**No changes.** The aggregation logic (weighted average, critical fail → auto-reject, pass threshold < 70) is chain-agnostic.

---

### I. Strategy

#### I1. `src/strategies/pumpfun-snipe.strategy.ts` → `src/strategies/robbinhood-snipe.strategy.ts`

**Major rewrite of blockchain-specific parts, logic preserved.**

```typescript
export class RobbinhoodSnipeStrategy implements BaseStrategy {
  readonly name = 'robbinhood-snipe'
  private readonly executor: BaseExecutor // paper or real

  async decide(opp: ApprovedOpportunity): Promise<TradeSignal | null> {
    // 1. Fetch current on-chain state (reserves, MC) — was fetchBondingCurveState, now fetchPoolState
    // 2. Calculate current MC in USD
    // 3. Determine tier based on MC
    // 4. Check tier gates
    // 5. Build TradeSignal with Robbinhood-specific params
    //    - gasLimit instead of computeUnitLimit
    //    - maxFeePerGas / maxPriorityFeePerGas instead of priorityFeeLamports
    //    - poolState: { nativeReserves, tokenReserves } instead of bondingCurveState
    //    - slippageBps → same concept
    //    - signalTtlMs → same
  }

  private async fetchPoolState(pairAddress: string): Promise<PoolState> {
    // Call pair contract to get reserves
    // For UniswapV2: getReserves() → (reserve0, reserve1, blockTimestampLast)
    // For bonding curve: contract.reserves()
  }

  private async fetchCurrentMcUsd(tokenAddress: string, poolState: PoolState): Promise<number> {
    const spotPriceNative = poolState.nativeReserves / poolState.tokenReserves
    const nativeUsd = await this.getNativeUsdPrice()
    return spotPriceNative * TOTAL_SUPPLY * nativeUsd
  }

  // determineTier, checkTierGates — logic preserved (MC thresholds, scoring gates)
}
```

**Key differences:**
- Slippage model: Solana fixed 1500bps → Robbinhood may use `amountOutMin` pattern (same concept)
- Gas: Solana priority fees + compute units → EIP-1559 maxFeePerGas + maxPriorityFeePerGas + gasLimit
- Pool state: Solana account data → contract call (eth_call)
- Transaction building: Was `VersionedTransaction + ComputeBudgetProgram` → Now contract interaction via ethers/viem

---

### J. Executors

This is the **largest single migration area**. Both paper and real executors touch Solana at every line.

#### J1. `src/executor/base.executor.ts`

**Changes:**
```typescript
export interface ExecutionResult {
  success: boolean
  positionId?: string
  outputAmount: number      // was in SOL/lamports → now in native token
  executionPrice: number    // price per token in native
  realizedSlippagePct?: number
  txSignature?: string      // was base58 Solana sig → now 0x tx hash
  blockNumber?: number      // NEW: block number
  durationMs: number
  error?: string
}

export interface BaseExecutor {
  readonly mode: 'paper' | 'real'
  execute(signal: TradeSignal): Promise<ExecutionResult>
  // ADD: sell method for position manager (was separate, consolidate)
  sell(req: SellRequest): Promise<ExecutionResult>
}
```

#### J2. `src/executor/pumpfun-curve.ts` → `src/executor/robbinhood-amm.ts`

**Complete rewrite of AMM math.**

**Current (Pump.fun constant-product bonding curve):**
- `k = virtualSolReserves * virtualTokenReserves`
- `PUMPFUN_FEE_BPS = 100` (1%)
- `quoteBuy(state, solIn)` — constant product
- `quoteSell(state, tokensIn)` — constant product
- `parseBondingCurveData(data: Buffer)` — Anchor account layout with 8-byte discriminator
- `fetchBondingCurveState(connection, address)` — Solana getAccountInfo

**New (Robbinhood AMM):**

Two possible models depending on Robbinhood's architecture:

**Model A: Similar bonding curve with on-chain state (most likely for a Pump.fun clone)**
```typescript
// If Robbinhood uses a bonding curve contract with similar math:
export interface PoolState {
  nativeReserves: number
  tokenReserves: number
  complete: boolean       // graduated yes/no
}

// Constant product: k = nativeReserves * tokenReserves
export function quoteBuy(state: PoolState, nativeIn: number): BuyQuote { ... }
export function quoteSell(state: PoolState, tokensIn: number): SellQuote { ... }

// Fetch from on-chain contract storage
export async function fetchPoolState(provider: Provider, pairAddress: string): Promise<PoolState | null> {
  // eth_call to get reserves
  const data = await provider.call({
    to: pairAddress,
    data: iface.encodeFunctionData('getReserves'),
  })
  const [reserve0, reserve1] = iface.decodeFunctionResult('getReserves', data)
  return { nativeReserves: ..., tokenReserves: ... }
}
```

**Model B: Uniswap V2-style AMM**
```typescript
// Standard Uniswap V2 constant product with 0.3% fee
export function quoteBuy(reserves: [bigint, bigint], amountIn: bigint): { amountOut: bigint, priceImpact: number } {
  const amountInWithFee = amountIn * 997n / 1000n
  const [reserveIn, reserveOut] = isNativeToken0 ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]]
  const amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee)
  const spotPrice = Number(reserveIn) / Number(reserveOut)
  const executionPrice = Number(amountIn) / Number(amountOut)
  const priceImpact = ((executionPrice - spotPrice) / spotPrice) * 100
  return { amountOut, priceImpact }
}
```

**On-chain parsing (was Anchor discriminator → now event logs):**
```typescript
// Parse event log from transaction receipt
// Example: event Trade(address indexed trader, bool isBuy, uint256 amountIn, uint256 amountOut, uint256 newReserve0, uint256 newReserve1)
export function parseTradeEvent(log: Log): TradeEvent | null {
  if (log.topics[0] !== TRADE_EVENT_SIGNATURE) return null
  return iface.decodeEventLog('Trade', log.data, log.topics)
}
```

#### J3. `src/executor/paper.executor.ts`

**Heavy rewrite (459 lines).**

**Changes:**
1. Replace `PUMPFUN_DECIMALS = 6` → `ROBBINHOOD_TOKEN_DECIMALS` (likely 18)
2. Replace `quoteBuy`/`quoteSell` from `pumpfun-curve.ts` → `robbinhood-amm.ts`
3. Replace `CurveState` → `PoolState`
4. `validateBuyQuote()` — keep all 6 sanity checks, adapt to new math:
   - tokensOut > 0
   - executionPrice > 0
   - priceImpactPct ≥ 0
   - feeNative > 0 (was feeSol)
   - constant-product preservation still applies
   - reserve conservation still applies
5. Redis buy lock: `buy_lock:${tokenAddress}` — same key, tokenAddress is now hex
6. Idempotency check: `findOpenPositionByToken` — same DB query, tokenAddress format changes
7. `sell()` method — was specific to bonding curve, now uses AMM sell math
8. `insertPaperTrade` / `closePosition` — same DB calls, just different field values

**Volume of change:** ~60% of the file changes. The structure (validate → execute → persist) stays. Only the math and data shapes change.

#### J4. `src/executor/real.executor.ts`

**Complete rewrite (792 lines → ~700 lines).** This is the most Solana-specific file.

**Current Solana-specific operations (ALL replaced):**
1. Jupiter API integration (`JUP_QUOTE_URL`, `JUP_SWAP_URL`, `SOL_MINT`) → Robbinhood DEX
2. `simulateAndSend()` with `VersionedTransaction`, `simulateTransaction`, `sendRawTransaction` → `estimateGas` + `sendTransaction`
3. Buy path: wallet balance check (`getBalance` → `getBalance` on Robbinhood), build pump.fun buy tx (`buildPumpfunBuyTx` → build Robbinhood buy tx)
4. Two sell paths: pump.fun direct + Jupiter → Robbinhood direct + aggregator
5. `fetchTxFill()`: Solana pre/post balances → Robbinhood event logs / transfer logs
6. `isRetryableTxError()`: Solana error codes → EVM revert reasons
7. Priority fees in lamports → EIP-1559 gas pricing

**New structure:**

```typescript
export class RealExecutor implements BaseExecutor {
  readonly mode = 'real'
  private readonly wallet: Wallet
  private readonly provider: JsonRpcProvider

  async execute(signal: TradeSignal): Promise<ExecutionResult> {
    // 1. Check wallet balance (native token)
    const balance = await this.provider.getBalance(this.wallet.address)
    if (balance < signal.amountInNative + estimatedGas) return fail('insufficient balance')

    // 2. Build buy transaction
    const tx = await this.buildBuyTx(signal)
    
    // 3. Gas estimation
    const gasLimit = await this.provider.estimateGas(tx).catch(() => signal.gasLimit)
    
    // 4. Send transaction
    const txResponse = await this.wallet.sendTransaction({
      ...tx,
      gasLimit,
      maxFeePerGas: signal.maxFeePerGas,
      maxPriorityFeePerGas: signal.maxPriorityFeePerGas,
    })

    // 5. Wait for confirmation
    const receipt = await txResponse.wait(1)
    
    // 6. Extract actual fill from receipt logs
    const fill = this.extractFillFromReceipt(receipt, signal.tokenAddress)

    // 7. Persist position
    return { success: true, positionId, outputAmount: fill.tokens, ... }
  }

  async sell(req: SellRequest): Promise<ExecutionResult> {
    // Similar structure to buy path
    // 1. Build sell tx (direct or via aggregator)
    // 2. Estimate gas + send
    // 3. Extract fill from receipt
    // 4. Close/update position
  }

  private extractFillFromReceipt(receipt: TransactionReceipt, tokenAddress: string): TxFill {
    // Parse Transfer event logs
    // Find token transfer to/from bot address
    // Calculate SOL delta from receipt + gas costs
    // Return { nativeDelta, tokenDelta, feeNative }
  }
}
```

**Key Solana → Robbinhood transaction model changes:**

| Solana | Robbinhood (EVM) |
|--------|-----------------|
| `VersionedTransaction` | `TransactionRequest` (ethers) / `Transaction` (viem) |
| `ComputeBudgetProgram.setComputeUnitPrice` | `maxPriorityFeePerGas` |
| `ComputeBudgetProgram.setComputeUnitLimit` | `gasLimit` |
| `sendRawTransaction(serialized)` | `wallet.sendTransaction(tx)` |
| `simulateTransaction` | `eth_call` / `estimateGas` / Tenderly simulation |
| `confirmTransaction` (polling) | `txResponse.wait(confirmations)` |
| Priority fees in lamports | Gas in gwei |
| No nonce (blockhash is recent) | Nonce management (provider.getTransactionCount) |

#### J5. `src/executor/pumpfun-direct.ts` → `src/executor/robbinhood-direct.ts`

**Complete rewrite.** This file builds raw Solana transactions with Anchor instruction discriminators. The Robbinhood equivalent uses ethers/viem contract interfaces.

**Current (281 lines):**
- `PUMP_FUN_PROGRAM_ID` — Solana program public key
- Anchor discriminator constants (8-byte arrays for buy/sell)
- PDA derivation functions
- `buildPumpfunBuyTx` / `buildPumpfunSellTx` — raw Solana instructions
- 12-account buy layout, 11-account sell layout

**New (shorter, ~150 lines):**
```typescript
// Use ethers Contract or viem for type-safe contract interaction
import { Contract } from 'ethers'

const LAUNCH_CONTRACT_ABI = [
  'function buy(address token, uint256 minTokensOut) external payable returns (uint256)',
  'function sell(address token, uint256 tokensIn, uint256 minNativeOut) external returns (uint256)',
]

export async function buildBuyTx(
  contract: Contract,
  tokenAddress: string,
  nativeAmount: bigint,
  minTokensOut: bigint,
): Promise<TransactionRequest> {
  const data = contract.interface.encodeFunctionData('buy', [tokenAddress, minTokensOut])
  return {
    to: await contract.getAddress(),
    data,
    value: nativeAmount,
  }
}

export async function buildSellTx(
  contract: Contract,
  tokenAddress: string,
  tokensIn: bigint,
  minNativeOut: bigint,
): Promise<TransactionRequest> {
  const data = contract.interface.encodeFunctionData('sell', [tokenAddress, tokensIn, minNativeOut])
  return {
    to: await contract.getAddress(),
    data,
  }
}
```

#### J6. `src/executor/tx-fill.ts` → `src/executor/tx-fill.ts`

**Rewrite.** Solana fill extraction (pre/post balance deltas from tx meta) → EVM event log parsing.

```typescript
export interface TxFill {
  nativeDeltaWei: bigint   // was solDeltaLamports
  feeWei: bigint           // was feeLamports (gasUsed * effectiveGasPrice)
  tokenDeltaRaw: bigint    // was tokenDeltaRaw
}

export function extractTxFill(
  receipt: TransactionReceipt,
  botAddress: string,
  tokenAddress: string,
): TxFill | null {
  // 1. Parse token Transfer events: topic0 = keccak256("Transfer(address,address,uint256)")
  // 2. Find transfers where from=bot (sell) or to=bot (buy)
  // 3. Calculate native spent/received from receipt
  //    - Buy: value sent - (gasUsed * effectiveGasPrice) for tx cost
  //    - Sell: native received - (gasUsed * effectiveGasPrice) for tx cost
  const fee = receipt.gasUsed * receipt.effectiveGasPrice  // (BigInt)
  // ... parse logs
}
```

---

### K. Position Manager

#### K1. `src/positions/position-manager.ts`

**Major rewrite of WebSocket monitoring layer (466 lines).**

**Current monitoring approach:**
- `onAccountChange` WebSocket per position on bonding curve PDA
- Fires <100ms after any trade
- Slow poll every 5s for DB sync + dead curve detection
- Bonding curve data parsed from Anchor account layout

**New monitoring approach:**

Options depend on Robbinhood's architecture:

**Option A: Pool reserve monitoring via WebSocket logs**
```typescript
// Subscribe to contract event logs instead of account changes
private subscribePosition(position: Position): void {
  const pairContract = new Contract(position.pairAddress, PAIR_ABI, this.provider)
  
  // Listen for Swap/ Trade events on the pair
  pairContract.on('Swap', (sender, amount0In, amount1In, amount0Out, amount1Out, event) => {
    void this.onSwap(position.id, { amount0In, amount1In, amount0Out, amount1Out })
  })
  
  // Also listen for Sync/Reserves events (UniswapV2: Sync(uint112 reserve0, uint112 reserve1))
  pairContract.on('Sync', (reserve0, reserve1, event) => {
    void this.onReservesChanged(position.id, { reserve0, reserve1 })
  })
}
```

**Option B: Polling reserves**
```typescript
// Poll pair contract for reserves at fixed interval (e.g. every 1-2s)
private async pollReserves(position: Position): Promise<void> {
  const reserves = await this.pairContract.getReserves()
  void this.onReservesChanged(position.id, reserves)
}
```

**Option C: Hybrid (WebSocket for events + polling fallback)**
```typescript
// WebSocket for real-time trade events
// Polling every 5s as fallback for missed events + dead pool detection
```

**What changes in position-manager.ts:**
1. `subscribePosition()`: `onAccountChange(publicKey)` → event log subscription or polling
2. `onCurveChange(data: Buffer)`: Anchor layout parse → event log decode
3. `checkStaleOrDead()`: `fetchBondingCurveState` → `fetchPoolState` (eth_call)
4. `isStaleFlat()`: `vSol/reserves` comparison → native reserves comparison (same logic)
5. `decide()`: Spot price calculation `virtualSolReserves/virtualTokenReserves` → `nativeReserves/tokenReserves` (same math)
6. Graduation handling: `curve.complete === true` → Robbinhood graduation signal (event or state flag)
7. `devWalletMonitor`: ATA monitoring → balanceOf monitoring (see Section L)
8. `executorSell()`: delegates to executor — executor interface changes
9. Metadata bond curve snapshot: `{ vSol, vTokens }` → `{ nativeReserves, tokenReserves }`

**What stays:**
- DB sync loop (5s interval, same pattern)
- Subscription lifecycle management
- Inflight set for concurrency control
- TP/SL decision logic (`decide()` math is identical)
- Stale-flat age threshold (default 90s)
- Dev dump emergency handler structure
- `executorSell()` delegation pattern

---

### L. Dev Wallet Monitor

#### L1. `src/monitor/dev-wallet.monitor.ts`

**Rewrite monitoring approach (187 lines).**

**Current:**
- Gets deployer's token ATA (Associated Token Account) via `getAssociatedTokenAddressSync`
- Fetches initial balance via `getTokenAccountBalance`
- Subscribes to ATA changes via `onAccountChange`
- Parses `AccountLayout` to read amount at offset 64-71 (u64 LE)
- Detects sells: balance < initialBalance → emergency abandon

**New:**

```typescript
export class DevWalletMonitor {
  private readonly watches = new Map<string, DevWatch>()
  private readonly onDevDump: DevDumpCallback

  async watch(position: Position): Promise<void> {
    const deployerAddress = position.metadata?.deployerAddress as string
    if (!deployerAddress) return
    if (this.watches.has(position.id)) return

    const tokenContract = new Contract(position.tokenAddress, ERC20_ABI, this.provider)
    
    // Fetch initial balance
    const initialBalanceRaw = await tokenContract.balanceOf(deployerAddress)
    if (initialBalanceRaw === 0n) return

    // Subscribe to Transfer events FROM deployer
    const filter = tokenContract.filters.Transfer(deployerAddress, null)
    tokenContract.on(filter, (from, to, amount, event) => {
      void this.handleTransfer(position.id, deployerAddress, amount)
    })

    this.watches.set(position.id, {
      tokenContract,
      filter,
      deployerAddress,
      initialBalanceRaw,
    })
  }

  unwatch(positionId: string): void {
    const watch = this.watches.get(positionId)
    if (!watch) return
    watch.tokenContract.off(watch.filter, this.handleTransfer)
    this.watches.delete(positionId)
  }

  // In Robbinhood/EVM, we can track cumulative sold by summing Transfer(from=deployer) events
  // OR we can query balanceOf periodically
  // OR we can use balanceOf on each Transfer event (gas-free via event log data)
  
  private async handleTransfer(positionId: string, deployerAddress: string, amount: bigint): Promise<void> {
    const watch = this.watches.get(positionId)
    if (!watch) return

    // Query current balance to check cumulative sold
    const currentBalance = await watch.tokenContract.balanceOf(deployerAddress)
    
    if (currentBalance >= watch.initialBalanceRaw) return // no net sell
    
    const soldRaw = watch.initialBalanceRaw - currentBalance
    const soldPct = Number(soldRaw * 10_000n / watch.initialBalanceRaw) / 100

    if (soldPct < env.DEV_SELL_ABANDON_PCT) {
      log.debug({ positionId, soldPct: soldPct.toFixed(2) }, 'Dev sold below threshold')
      return
    }

    // THRESHOLD BREACHED — abandon
    log.warn({ positionId, soldPct }, 'DEV DUMP DETECTED')
    this.unwatch(positionId)
    void sendTelegramAlert(/* ... */)
    this.onDevDump(positionId, deployerAddress, soldPct)
  }
}
```

**Key differences:**
- No ATA derivation (Solana-specific concept) → direct `balanceOf()` call
- No `AccountLayout` binary parsing → ERC-20 `balanceOf` return value (uint256)
- `onAccountChange` → ERC-20 `Transfer` event subscription (filtered by from=deployer)
- `getTokenAccountBalance(devAta)` → `tokenContract.balanceOf(deployerAddress)`

---

### M. Dashboard

#### M1. `src/dashboard/server.ts`

**Changes:**

1. **SOL/USD price → native/USD price:**
   ```typescript
   // OLD: CoinGecko 'solana' → cache:sol_usd
   // NEW: CoinGecko for Robbinhood native token → cache:native_usd
   const nativeUsdPrice = await fetchCoinGeckoPrice('robbinhood-native-id') // TBD
   ```

2. **Wallet balance:**
   ```typescript
   // OLD: solanaConnection.getBalance(botPubkey) / LAMPORTS_PER_SOL
   // NEW: rhProvider.getBalance(botAddress) / 10**ROBBINHOOD_NATIVE_DECIMALS
   ```

3. **Position endpoints:** Mostly unchanged — only address format changes (base58 → hex)

4. **Sell endpoint:** Delegates to executor — executor interface changes propagate here

#### M2. `src/dashboard/ui.ts`

**Changes:**

1. **Explorer links:**
   ```html
   <!-- OLD: -->
   <a href="https://pump.fun/${tokenAddress}">Pump.fun</a>
   <a href="https://solscan.io/token/${tokenAddress}">Solscan</a>
   
   <!-- NEW: -->
   <a href="${ROBBINHOOD_EXPLORER_URL}/token/${tokenAddress}">Explorer</a>
   <a href="${ROBBINHOOD_EXPLORER_URL}/tx/${txHash}">Tx</a>
   ```

2. **Labels:**
   - "SOL" → native symbol (e.g., "ETH", "BNB", etc.)
   - "Lamports" → "Wei" or native unit name

3. **Wallet address display:** base58 with truncation → hex with `0x${first6}...${last4}`

---

### N. Bootstrap

#### N1. `src/main.ts`

**Changes (233 lines):**

```typescript
// REMOVE these imports:
import { solanaConnection, sendConnection } from './utils/solana.utils.js'
import { getBotKeypair, getBotPublicKey } from './utils/wallet.js'
import { pumpPortalListener } from './listeners/pumpportal.listener.js'
import { pumpfunParser } from './parsers/pumpfun.parser.js'
import { pumpfunLaunchDetector } from './detectors/pumpfun-launch.detector.js'
import { pumpfunSnipeStrategy } from './strategies/pumpfun-snipe.strategy.js'

// ADD these imports:
import { rhProvider, rhWsProvider } from './utils/robbinhood.utils.js'
import { getBotWallet, getBotAddress } from './utils/wallet.js'
import { robbinhoodListener } from './listeners/robbinhood.listener.js'
import { robbinhoodParser } from './parsers/robbinhood.parser.js'
import { robbinhoodLaunchDetector } from './detectors/robbinhood-launch.detector.js'
import { robbinhoodSnipeStrategy } from './strategies/robbinhood-snipe.strategy.js'

// Bootstrap sequence stays the same:
// 1. Validate wallet (real mode check)
// 2. Verify RPC connection
// 3. Start EventBus
// 4. Start consumers (positionManager → strategy → riskEngine → detector → parser)
// 5. Start producer (robbinhoodListener)
// 6. Start dashboard

// Key changes:
// - Jupiter health check → Robbinhood DEX health check (or remove)
// - Solana connection validation → Robbinhood RPC validation
// - Wallet validation: Keypair → Wallet
// - Listener: PumpPortal → Robbinhood event source
```

---

## 4. Migration Phases & Timeline

### Phase 0: Research & Discovery (1-2 days)
**Goal:** Confirm Robbinhood network specifics before writing code

- [ ] Confirm Robbinhood network type (EVM-compatible? Custom L1?)
- [ ] Identify Robbinhood SDK / web3 library
- [ ] Map token launch flow (how are tokens created? Event format? Contract addresses?)
- [ ] Identify AMM type (bonding curve? Uniswap V2 fork? Custom?)
- [ ] Map DEX aggregators (if any)
- [ ] Confirm address format, native token, decimals
- [ ] Confirm RPC/WS endpoints
- [ ] Test basic RPC calls (getBalance, getBlockNumber, eth_call)

### Phase 1: Infrastructure Foundation (2-3 days)
**Goal:** Get the bot connected to Robbinhood — no trading yet

1. **Environment config** (`env.ts`): Replace Solana env vars with Robbinhood vars
2. **Utilities** (`robbinhood.utils.ts`, `wallet.ts`): RPC connection, wallet setup
3. **Event types** (`event-types.ts`): Add Robbinhood protocol, update interfaces
4. **Database** (`schema.ts`): Add 'robbinhood' to protocol enum
5. **Smoke test**: Connect to RPC, read a block, query a balance

### Phase 2: Data Pipeline (3-4 days)
**Goal:** Events flow through the pipeline end-to-end

1. **Listener** (`robbinhood.listener.ts`): Ingest token creation events
2. **Parser** (`robbinhood.parser.ts`): Parse events into TokenLaunchEvent
3. **Detector** (`robbinhood-launch.detector.ts`): Score and filter tokens
4. **Risk Engine**: Update checks for Robbinhood (token-ownership instead of mint-freeze)
5. **Pipeline test**: Raw event → parsed → candidate → approved (verify at each stage)

### Phase 3: Paper Trading (2-3 days)
**Goal:** Simulated trading works end-to-end

1. **AMM math** (`robbinhood-amm.ts`): Implement Robbinhood AMM math
2. **Paper executor** (`paper.executor.ts`): Rewrite buy/sell with new AMM
3. **Strategy** (`robbinhood-snipe.strategy.ts`): Decision logic with new pool state
4. **Position manager**: Update monitoring (reserves polling or event logs)
5. **Dev wallet monitor**: Update to Robbinhood token model
6. **End-to-end paper test**: Detect token → enter position → TP hit → sell → verify PnL

### Phase 4: Real Trading (3-5 days)
**Goal:** Real on-chain trading works

1. **Real executor** (`real.executor.ts`): Full rewrite for Robbinhood transactions
2. **Transaction building** (`robbinhood-direct.ts`): Contract interaction for buy/sell
3. **Fill extraction** (`tx-fill.ts`): Parse receipts for actual fill
4. **Gas management**: EIP-1559 fee estimation, nonce management
5. **Error handling**: Revert reason parsing, retry logic, nonce recovery
6. **Integration test**: Paper vs real — same signal, compare execution quality

### Phase 5: Dashboard & Polish (1-2 days)
**Goal:** Monitoring and operations

1. **Dashboard server**: Update balances, links, labels
2. **Dashboard UI**: Explorer links, address formatting, native symbol
3. **Telegram alerts**: Update message templates (SOL → native, base58 → hex)
4. **Logger redaction**: Update secret paths
5. **`.env.example`**: Create new template
6. **Documentation**: Update README with Robbinhood setup

### Total: ~11-17 days of focused development

---

## 5. File Change Inventory

### New Files (Created)
```
src/utils/robbinhood.utils.ts          — RPC/WS connection management
src/listeners/robbinhood.listener.ts   — Token creation event source
src/parsers/robbinhood.parser.ts       — Event parser
src/detectors/robbinhood-launch.detector.ts — Token scoring & filtering
src/strategies/robbinhood-snipe.strategy.ts — Entry strategy
src/executor/robbinhood-amm.ts         — AMM math & on-chain state
src/executor/robbinhood-direct.ts      — Contract interaction (buy/sell tx)
src/risk/checks/token-ownership.check.ts — Ownership/security check
```

### Modified Files (Updated In-Place)
```
src/config/env.ts                      — Solana → Robbinhood env vars
src/utils/wallet.ts                    — Keypair → Wallet
src/utils/logger.ts                    — Secret redaction paths
src/database/schema.ts                 — Protocol enum + column updates
src/events/event-types.ts              — Protocol, event interfaces
src/executor/base.executor.ts          — ExecutionResult fields
src/executor/paper.executor.ts         — AMM math, decimals
src/executor/real.executor.ts          — Complete rewrite
src/executor/tx-fill.ts                — Solana balances → event logs
src/risk/risk-engine.ts                — Import paths, protocol awareness
src/positions/position-manager.ts      — WS monitoring, pool state
src/monitor/dev-wallet.monitor.ts      — ATA → balanceOf + Transfer events
src/dashboard/server.ts                — Prices, balances, links
src/dashboard/ui.ts                    — Explorer links, labels, formatting
src/main.ts                            — Imports, bootstrap
.env.example                           — New env template
package.json                           — Dependencies
```

### Deleted Files (Removed)
```
src/utils/solana.utils.ts              — Replaced by robbinhood.utils.ts
src/listeners/pumpportal.listener.ts   — Replaced by robbinhood.listener.ts
src/parsers/pumpfun.parser.ts          — Replaced by robbinhood.parser.ts
src/detectors/pumpfun-launch.detector.ts — Replaced by robbinhood-launch.detector.ts
src/strategies/pumpfun-snipe.strategy.ts — Replaced by robbinhood-snipe.strategy.ts
src/executor/pumpfun-curve.ts          — Replaced by robbinhood-amm.ts
src/executor/pumpfun-direct.ts         — Replaced by robbinhood-direct.ts
src/risk/checks/mint-freeze-authority.check.ts — Replaced by token-ownership.check.ts
```

### Unchanged Files (No Modifications)
```
src/events/event-bus.ts                — Redis Streams is chain-agnostic
src/risk/risk-score.ts                 — Weighted average math
src/risk/checks/base.check.ts          — Check interface
src/risk/checks/liquidity.check.ts     — Minor: threshold constant name
src/risk/checks/deployer-blacklist.check.ts — Minor: address format
src/risk/checks/token-quality.check.ts — Minor: address validation
src/analysis/token-analyzer.ts         — Chain-agnostic string analysis
src/utils/telegram.ts                  — HTTP call, no changes
src/listeners/base.listener.ts         — Interface unchanged
src/strategies/base.strategy.ts        — Interface unchanged
src/database/client.ts                 — PostgreSQL, no changes
src/positions/position.repository.ts   — DB queries, address format only
src/database/schema.sql                — Minimal: enum addition
```

---

## 6. Open Questions Requiring User Confirmation

These must be answered before Phase 0 can complete:

### Network Fundamentals
1. **What is the Robbinhood network?** EVM-compatible (like BSC, Avalanche)? Custom L1 (like Solana)? L2 (like Arbitrum)?
   - This determines: RPC library, address format, transaction model, SDK
2. **What is the native token?** (ETH on Ethereum, BNB on BSC, SOL on Solana, etc.)
   - This determines: CoinGecko ID, decimals, gas token
3. **What is the chain ID?** (for EIP-155 or equivalent)
4. **RPC endpoint URL?** Both HTTP and WebSocket if available
5. **Block explorer URL?**

### Token Launch Mechanics
6. **How are tokens launched on Robbinhood?**
   - Factory contract (everyone deploys through same factory)?
   - Individual deployments?
   - What events/logs are emitted on creation?
7. **Is there a bonding curve?** If so, what's the math model?
   - Constant product (like Pump.fun)?
   - Linear?
   - Other?
8. **What are the AMM parameters?**
   - Initial virtual reserves?
   - Fee percentage?
   - Graduation threshold (when does it migrate to DEX)?
9. **Token contract standard?**
   - ERC-20? Custom standard?
   - Are there standard features (mint, burn, transfer fee, ownership)?
10. **Are there any Robbinhood-specific SDKs or APIs** for event ingestion (like PumpPortal)?

### Trading Infrastructure
11. **What DEX does Robbinhood use?** (Uniswap V2, V3, custom fork?)
    - What's the router/aggregator contract address?
12. **Is there a dedicated mempool/transaction service** (like Helius Sender, Jito, Flashbots)?
13. **What's the typical gas environment?**
    - EIP-1559? Legacy gas?
    - Typical gas prices for fast inclusion?
    - Any MEV protection options?
14. **Are there any Robbinhood-specific token launch platforms or launchpads?**
    - If multiple, which ones should the bot monitor?

### Additional Context
15. **Is there existing documentation, an API reference, or a developer portal?**
16. **Do you have example transactions** (token creation, buy, sell) that I can analyze?
17. **Is the token deployed on mainnet or testnet?** Testnet RPC URL for development?

---

## Appendix A: Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| Robbinhood uses fundamentally different tx model than EVM or Solana | High — would require custom integration | Phase 0 discovery to confirm before writing code |
| No real-time event source (no WebSocket) | Medium — latency penalty | Fall back to RPC log polling (acceptable for 5-10s windows) |
| Contract not verified / no ABI | High — can't build txs | Reverse-engineer from bytecode, use transaction traces |
| Low liquidity / few tokens launching | Medium — fewer opportunities | Adjust tier thresholds down |
| Gas model uncertainty | Low — EVM gas is well-understood | Just needs correct gas price parameters |

## Appendix B: Rollback Strategy

The old Solana code is preserved in git history. The migration is a series of **new files** + **modifications to existing files**. To roll back:

1. Revert modified files to pre-migration state
2. Delete new Robbinhood files
3. Restore `.env` to Solana config
4. Run `npm install` to restore Solana dependencies

**No database migration is destructive** — the `protocol` enum gets a new value, existing data is unchanged. Historical Solana positions remain queryable.

---

*End of plan. Awaiting user answers to open questions before Phase 0 implementation begins.*
