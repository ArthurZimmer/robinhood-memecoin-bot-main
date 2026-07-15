# Real Mode — Honest Guide

## Current status

**Real executor IS implemented.** Paper mode remains the recommended validation phase before enabling real trading.

What exists now:
- ✅ Detection of new tokens (PumpPortal WSS) — **Pump.fun v1 only** (`pool === 'pump'`)
- ✅ Risk engine (liquidity, blacklist, ownership check with protocol-trust fallback)
- ✅ Strategy + signal generation (with minimum market cap gate `MIN_ENTRY_MC_USD`)
- ✅ Paper executor (simulated via bonding curve math)
- ✅ **Real executor** — wallet loader + build/sign/send tx directly to Pump.fun v1 contract
- ✅ **Sell:** direct on bonding curve; Uniswap V2 for tokens graduated from the curve
- ✅ **PnL from real on-chain fills** (`tx-fill.ts`) — not just curve estimates
- ✅ Position Manager with real-time monitoring via WebSocketProvider — TP / SL / graduation / stale
- ✅ EIP-1559 gas model with priority fee escalation on retry
- ✅ Dashboard

What's **missing / roadmap** for hardening:
- ❌ Flashbots/MEV protection bundles — Phase 5+
- ❌ Multi-RPC failover for redundancy

---

## Real risk — read before anything

Before adding a private key, understand:

| Risk | Mitigation |
|---|---|
| **Tx fails but ETH is spent on gas** | Bot has `maxRetries: 1` in signal + priority fee escalation |
| **Slippage 15% on pump.fun** | Can buy tokens 15% more expensive than expected in frenetic launches |
| **MEV sandwich** | Bot broadcasts to public mempool → other bots can front-run. Flashbots bundles needed for protection (Phase 5+) |
| **Bonding curve graduated** | Token migrates to Uniswap → pumpfun contract sell fails. Exit via Uniswap is a separate path |
| **Rug pull pre-renounce** | Pump.fun guarantees ownership renounce at Create, but if another venue, owner could mint new tokens and dilute |
| **Daily loss limit** | Bot has kill switch in `DAILY_LOSS_LIMIT_NATIVE` — default 0.5 ETH/day |
| **Disk full / DB lock** | Position manager loses state, could duplicate TP |
| **Wallet drain** | Leaked private key = total loss. NEVER commit `.env`, NEVER expose the server to the internet |

---

## Hardening checklist (before first real trade)

1. [ ] Paper mode running **≥ 24h** without crash
2. [ ] Win rate paper ≥ 30% in ≥ 200 trades
3. [ ] Realized PnL paper positive
4. [ ] `.env` with `chmod 600` permissions
5. [ ] Dashboard NOT exposed to internet (firewall or bind 127.0.0.1)
6. [ ] Daily loss limit adjusted to your appetite
7. [ ] Trade size **VERY** small in 1st week (0.01 ETH)
8. [ ] Wallet dedicated, **NEVER** your main wallet
9. [ ] Backup seed phrase offline before funding

---

## Setup real mode

### 1. Create a dedicated wallet for the bot

Generate a new Ethereum wallet. You can use any tool (MetaMask, ethers CLI, cast, etc.). The private key must be a 0x-prefixed hex string.

```bash
# Using cast (Foundry)
cast wallet new

# Or using ethers via Node
node -e "const w = require('ethers').Wallet.createRandom(); console.log('Address:', w.address); console.log('Private Key:', w.privateKey)"
```

### 2. Initial funding

Send ETH to the bot wallet via MetaMask or any EVM wallet. Suggested for 1st test:
- **0.05 ETH for gas** (EIP-1559 fees for Pump.fun buys/sells)
- **0.1 ETH for trades** (2 trades of 0.05 each)
- Total: **0.15 ETH** (~$300-400)

### 3. Configure `.env`

```env
# Mode
TRADING_MODE=real

# Private key as 0x-prefixed hex string
WALLET_PRIVATE_KEY=0x...                   # NEVER version this file

# Very small trade for 1st test
TRADE_SIZE_NATIVE=0.01
MAX_OPEN_POSITIONS=1
DAILY_LOSS_LIMIT_NATIVE=0.02

# Slippage more conservative for real
# (paper uses 15%, real starts higher to guarantee landing)
# Not an env var yet — hardcoded in strategy
```

### 4. Permissions + checks

```bash
chmod 600 .env

# Confirm balance on Robinhood Chain
cast balance <your-wallet-address> --rpc-url $ROBBINHOOD_RPC_URL
```

### 5. Run with supervision

```bash
# Terminal 1 — bot
npm run dev

# Terminal 2 — dashboard
open http://localhost:3000

# Terminal 3 — executor logs
tail -f /tmp/bot.log | grep -E "(REAL|ERROR|FATAL)"
```

---

## What's ready vs. what's remaining

| Component | Status |
|---|---|
| `src/utils/wallet.ts` — load private key from env (0x hex) | ✅ Done |
| `src/executor/pumpfun-direct.ts` — buy/sell contract call builders | ✅ Done |
| `src/executor/real.executor.ts` — build/sign/send + confirm | ✅ Done |
| `src/executor/tx-fill.ts` — PnL from real on-chain fills | ✅ Done |
| Uniswap V2 exit path (graduated tokens) | ✅ Done |
| Priority fee escalation on retry | ✅ Done |
| Flashbots/MEV protection bundles | ❌ Roadmap |
| Multi-RPC failover | ❌ Roadmap |

---

## Recommended next step

**Before enabling real executor, run paper mode for ≥ 24h** and analyze:

1. **Win rate** — what % of positions have realized PnL > 0?
2. **Avg drawdown** — what's the worst position in -X%?
3. **Slippage real** — paper assumes perfect curve; real will be +3-5% worse
4. **Tokens discarded** — how many passed filters but weren't good?

This data decides whether it's worth enabling real mode or refining paper first.

```bash
# Useful query for post-paper analysis
docker exec robinhood_bot_postgres psql -U bot -d robinhood_bot -c "
  SELECT
    COUNT(*) FILTER (WHERE status = 'closed' AND realized_pnl_native > 0) as wins,
    COUNT(*) FILTER (WHERE status = 'stopped') as stops,
    AVG(realized_pnl_native) FILTER (WHERE status = 'closed') as avg_pnl,
    MAX(realized_pnl_native) as best,
    MIN(realized_pnl_native) as worst
  FROM positions WHERE mode='paper' AND closed_at IS NOT NULL;
"
```
