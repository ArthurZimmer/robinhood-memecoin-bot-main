# Robinhood Memecoin Bot

Hybrid sniper bot for **Pump.fun v1** memecoins (classic bonding curve) on **Robinhood Chain** (EVM, Chain ID 4663). Auto-entry + partial take-profit + moonbag + auto stop-loss. Runs in **paper** (simulated) or **real** (live on-chain) mode.

Stack: Node 22, TypeScript, PostgreSQL (Drizzle), Redis Streams, Pino, ethers.js v6, PumpPortal WSS.

## Quick start

**Full stack in Docker** (Postgres + Redis + bot — how it runs on a VPS):

```bash
cp .env.example .env   # fill ROBBINHOOD_RPC_URL (and WALLET_PRIVATE_KEY for real mode)
docker compose up -d --build    # builds, migrates, and starts everything
docker compose logs -f bot      # dashboard on http://localhost:3000 (localhost only)
```

**Local dev** (bot on the host, only infra in Docker):

```bash
docker compose up -d postgres redis
npm install
cp .env.example .env
npm run db:migrate
npm run dev            # bot + dashboard at http://localhost:3000
```

VPS deployment guide: **[DEPLOY.md](./DEPLOY.md)**.
Reset between runs: `npm run dev:reset` · Force-close stale positions: `npm run cleanup:stale`

---

## Pipeline

```
PumpPortal WSS ─► Listener ─► Parser ─► Detector ─► Risk Engine ─► Strategy ─► Executor ─► DB
                              (v1-only)                                            │
                                                                            Position Manager
                                                                       (WebSocketProvider per
                                                                        position → TP / SL /
                                                                        graduation / stale)
```

Every stage decouples via Redis Streams. Each stage owns one decision.

---

## Buy filters — what the bot actually checks before buying

Tokens flow through several filter stages. A token must survive ALL of them to trigger a buy. Most events die in the first two.

### Stage 0 — Parser v1 gate (`src/parsers/pumpfun.parser.ts`)

PumpPortal's `subscribeNewToken` streams launches from **multiple venues** (classic pump.fun, pump-amm, bonk, launchlab, uniswap…). The bot's direct executor + bonding-curve math only work on the **classic pump.fun v1 curve**, so the parser accepts **only** events whose `pool === 'pump'` and discards everything else. (A missing `pool` field is treated as v1 for older payload shapes.)

### Stage 1 — Detector (`src/detectors/pumpfun-launch.detector.ts`)

Cheap, in-process filters. No RPC, no DB.

| Filter | Default | Reject if |
|---|---|---|
| Address validity | 0x hex regex (40 chars) | `tokenAddress`, `poolAddress`, or `deployerAddress` invalid |
| Event freshness | **90 000 ms** (`maxAgeMs`) | `Date.now() - event.timestamp > maxAgeMs` |
| Mint dedup | LRU 5 000, TTL 1 h | Same `tokenAddress` seen in last hour |
| **Symbol+name spam dedup** | **60 000 ms** (`spamWindowMs`) | Same `(symbol, name)` seen in window → rejects 2nd+ spam clone |
| **Dev-buy floor** | **0.05 ETH** (`MIN_DEV_BUY_NATIVE`) | Creator bought `< 0.05 ETH` of their own token (throwaway spam) |
| Liquidity floor | `initialLiquidityNative > 0` | Bonding curve reports 0 ETH (malformed payload) |

Output: `CandidateOpportunity` published to `events:candidates`.

### Stage 2 — Risk Engine (`src/risk/risk-engine.ts`)

3 sequential checks, cheap → expensive. **Fail-fast**: critical severity short-circuits remaining checks.

| Check | Weight | File | Pass criteria |
|---|---|---|---|
| **liquidity** | 0.15 | `checks/liquidity.check.ts` | `initialLiquidityNative ≥ 5 ETH` AND `trade_size / LP ≤ 5%` |
| **deployer-blacklist** | 0.25 | `checks/deployer-blacklist.check.ts` | Deployer NOT in `deployer_blacklist` (Redis hash, cached 1 h) |
| **ownership-check** | 0.35 | `checks/mint-freeze-authority.check.ts` | ERC-20 `owner()` returns `0x0000…0000` (ownership renounced) |

**Protocol-trust fallback:** Pump.fun token ownership is renounced atomically at creation time. On RPC failure for a `pumpfun` candidate the check returns `pass` with flag `protocol-trust` (audited in `risk_evaluations.flags`).

Aggregation (`src/risk/risk-score.ts`): weighted score 0-100 (higher = riskier). `passed = !criticalFail && riskScore < 70`. A `critical` severity fail → instant reject.

Output: `ApprovedOpportunity` on `events:approved`. Persisted to `risk_evaluations` for audit.

### Stage 3 — Strategy (`src/strategies/pumpfun-snipe.strategy.ts`)

Risk-approved ≠ buy. Portfolio-level gates:

| Gate | Default | Env | Reject if |
|---|---|---|---|
| Signal staleness | **30 000 ms** (`MAX_SIGNAL_AGE_MS`) | hardcoded | `Date.now() - opportunity.timestamp > 30 s` |
| Max open positions | **5** | `MAX_OPEN_POSITIONS` | Open positions ≥ cap |
| Daily loss limit | **0.5 ETH** | `DAILY_LOSS_LIMIT_NATIVE` | Today's realized PnL ≤ `-DAILY_LOSS_LIMIT_NATIVE` (kill switch) |
| **Min entry market cap** | **$6 000** | `MIN_ENTRY_MC_USD` | Live MC (fetched via RPC) `< MIN_ENTRY_MC_USD` — token still at launch floor, no buy pressure. Fails **open** if RPC/price unavailable |

The MC gate reads `cache:eth_usd` (populated by the dashboard server, 120 s TTL) and the **live** bonding-curve reserves via RPC — not the launch snapshot.

If all gates pass, it builds a `TradeSignal`:

```typescript
{
  amountNative: env.TRADE_SIZE_NATIVE,   // default 0.05 ETH
  slippageBps: 1_500,                    // 15% (SLIPPAGE_BPS)
  maxFeePerGas: 10_000_000_000n,         // 10 gwei
  maxPriorityFeePerGas: 2_000_000_000n,  // 2 gwei
  maxRetries: 1,
  expiresAt: now + 5_000,                // 5 s TTL
}
```

### Stage 4 — Executor

The active executor is chosen by `TRADING_MODE` (`paper` → `PaperExecutor`, `real` → `RealExecutor`).

**Paper** (`src/executor/paper.executor.ts`) — simulates the fill with constant-product math (`src/executor/pumpfun-curve.ts`), persists `positions` + `paper_trades`. No network:

```
fee = ethIn × 1%
k = vNative × vTokens
newVNative = vNative + (ethIn - fee)
tokensOut = vTokens - (k / newVNative)
```

**Real** (`src/executor/real.executor.ts`) — builds, signs and sends a real transaction:
- **Buy:** direct call against the pump.fun v1 bonding-curve contract (`src/executor/pumpfun-direct.ts`) — no router round-trips.
- **Sell:** direct pump.fun contract while on the curve; **Uniswap V2** once the token graduated.
- **PnL from real fills:** after each tx confirms, the executor reads the confirmed transaction's ERC-20 Transfer events (`src/executor/tx-fill.ts`) to record the **actual** tokens received (buy) and **actual** ETH received (sell), instead of the pre-trade quote. Falls back to the quote only if the tx can't be fetched.
- Sends use the RPC provider configured in `ROBBINHOOD_RPC_URL`.

---

## Exit logic — Position Manager (`src/positions/position-manager.ts`)

Hybrid, not polling:
- **WebSocketProvider subscription per position** — fires on new blocks to detect curve changes. Handles TP / SL / graduation in real time.
- **Slow sync every 5 s** (`syncIntervalMs`) — discovers new positions from the DB, manages subscriptions, and handles stale / dead curves.

For each curve update it reads the on-chain reserves, computes `pnlPct = (spot - entry) / entry × 100`, and decides:

| Trigger | Action | Reason |
|---|---|---|
| `pnlPct ≤ -stopLossPct` | Sell 100%, status `stopped` | `stop-loss` |
| `pnlPct ≥ takeProfitPct` AND status `open` | Sell `sellPctAtTp`% (default 50%), status `partial_exit`, flag moonbag | `take-profit` |
| Curve `complete` (graduated to Uniswap) | Sell 100% via Uniswap at graduation price | `manual` |
| `age > 90 s` (`staleKillAgeMs`) AND `vNative ≈ entry vNative` (no volume) | Sell 100% | `stale-flat` (frees cap from spam) |
| Curve gone AND `age > 90 s` | Force-close | dead curve |

TP/SL/sellPct values are read **per position** from the DB (snapshotted from env at entry). `staleVNativeToleranceNative` default 0.005 ETH.

---

## Configurable parameters (`.env`)

```env
TRADE_SIZE_NATIVE=0.05          # ETH per buy
TAKE_PROFIT_PCT=100             # Sell at +100%
SELL_PCT_AT_TP=50               # Sell 50% on TP (moonbag = remaining 50%)
STOP_LOSS_PCT=50                # Sell all at -50%
MAX_OPEN_POSITIONS=5            # Cap on concurrent positions
DAILY_LOSS_LIMIT_NATIVE=0.5     # Kill switch
MIN_ENTRY_MC_USD=6000           # Skip tokens below this live market cap (0 = disable)
```

---

## RPC configuration

Transactions **broadcasts** and contract reads use `ROBBINHOOD_RPC_URL`. WebSocket subscriptions (block polling, event monitoring) use `ROBBINHOOD_WS_URL` (optional — falls back to HTTP polling if unset).

Wiring: `src/utils/robbinhood.utils.ts` (`rhProvider`, `rhWsProvider`). No API key needed for Robinhood Chain RPC endpoints.

---

## How to refine the filters

### "Bot buys too much trash" → tighten

- Detector `seenTokensTtlMs`: raise from 1 h (block repeats longer)
- Detector `spamWindowMs`: raise from 60 s (longer spam memory)
- Detector `MIN_DEV_BUY_NATIVE`: raise from 0.05 ETH (require more dev skin-in-the-game)
- Risk `liquidity.check.ts`: raise `MIN_LIQUIDITY_NATIVE` from 5 to 10
- Strategy `MIN_ENTRY_MC_USD`: raise to require more proven buy pressure

### "Bot misses too many pumps" → loosen

- Strategy `MAX_SIGNAL_AGE_MS`: raise from 30 s (tolerate slower risk eval)
- Strategy `MIN_ENTRY_MC_USD`: lower (enter earlier)
- Strategy: raise `MAX_OPEN_POSITIONS` to capture more parallel opportunities

### "Stop loss firing too often" → adjust

- `STOP_LOSS_PCT`: raise (tolerate deeper drawdown)

### "Cap stays full forever" → adjust stale killer

- Position Manager `staleKillAgeMs`: default 90 s — lower for aggressive cap rotation
- `staleVNativeToleranceNative`: default 0.005 ETH — raise if curve has tiny noise

### New checks to consider (not implemented)

| Check | Purpose | Effort |
|---|---|---|
| Holder concentration | Reject if top 10 wallets hold >X% supply | Medium (ERC-20 `balanceOf` calls) |
| Deployer wallet age | Reject deployers <N days old | Medium (block explorer API) |
| Initial buy sanity | Reject if dev-buy > X% of supply | Easy (already in payload) |
| Metadata heuristics | Reject failed URI / obvious scam names | Medium (HTTP + regex) |

Each new check goes in `src/risk/checks/` and is registered in `src/risk/risk-engine.ts:checks[]`. Ordering matters — cheap first.

---

## Audit your filter performance

```sql
-- How many tokens passed risk today?
SELECT
  COUNT(*) AS evaluated,
  COUNT(*) FILTER (WHERE passed) AS approved,
  ROUND(100.0 * COUNT(*) FILTER (WHERE passed) / NULLIF(COUNT(*), 0), 1) AS pass_pct
FROM risk_evaluations
WHERE evaluated_at >= CURRENT_DATE;

-- Which flags rejected the most?
SELECT jsonb_array_elements_text(flags) AS flag, COUNT(*) AS hits
FROM risk_evaluations
WHERE NOT passed AND evaluated_at >= CURRENT_DATE
GROUP BY flag ORDER BY hits DESC;

-- Win/loss breakdown of closed positions
SELECT status, COUNT(*) AS n,
  ROUND(AVG(realized_pnl_native)::numeric, 6) AS avg_pnl,
  ROUND(SUM(realized_pnl_native)::numeric, 6) AS total_pnl
FROM positions
WHERE closed_at IS NOT NULL
GROUP BY status;
```

---

## File map for refinement

| Want to change | Edit |
|---|---|
| v1-only venue filter | `src/parsers/pumpfun.parser.ts` (`PUMPFUN_V1_POOL`) |
| What counts as "spam" | `src/detectors/pumpfun-launch.detector.ts` |
| Dev-buy floor | `src/detectors/pumpfun-launch.detector.ts` (`MIN_DEV_BUY_NATIVE`) |
| Minimum liquidity | `src/risk/checks/liquidity.check.ts` (`MIN_LIQUIDITY_NATIVE`) |
| Add a new risk check | New file in `src/risk/checks/` + register in `src/risk/risk-engine.ts` |
| Trade size, TP, SL, min MC | `.env` |
| Slippage / gas fees | `src/strategies/pumpfun-snipe.strategy.ts` (`SLIPPAGE_BPS`, `GAS_CONFIG`) |
| Stale killer threshold | `src/positions/position-manager.ts` (`staleKillAgeMs`) |
| Pricing math | `src/executor/pumpfun-curve.ts` |
| Real buy/sell contract calls | `src/executor/pumpfun-direct.ts` |
| On-chain PnL parsing | `src/executor/tx-fill.ts` |
| RPC provider configuration | `src/utils/robbinhood.utils.ts` (`rhProvider`, `rhWsProvider`) |

---

## Real mode

**Implemented.** `TRADING_MODE=real` executes live swaps with real ETH:
- Direct pump.fun v1 bonding-curve buy/sell (`pumpfun-direct.ts`), Uniswap V2 for graduated tokens.
- PnL recorded from **actual on-chain fills** (`tx-fill.ts`), not the quote.

Requires `WALLET_PRIVATE_KEY` (0x-prefixed hex). **Use a dedicated throwaway wallet** funded only with what you can lose. See [REAL_MODE.md](./REAL_MODE.md) for the hardening checklist and remaining risks (MEV, slippage, graduation). Validate paper mode with positive PnL before going live.
