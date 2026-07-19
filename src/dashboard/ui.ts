// Single-file HTML dashboard — vanilla JS, no build step, no runtime deps.
// Polls /api/* endpoints every 2s.

// Real trading dashboard — dark theme with green accents, live wallet, tx hashes.
export const dashboardHtmlReal = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Robinhood Bot</title>
<style>
  :root {
    --bg: #000;
    --bg-card: #0a0a0a;
    --bg-elev: #141414;
    --border: #1f1f1f;
    --text: #e6e6e6;
    --text-dim: #707070;
    --green: #4ade80;
    --red: #f87171;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 13px;
    line-height: 1.4;
    padding: 20px;
    max-width: 1400px;
    margin: 0 auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 24px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  h1 { font-size: 14px; color: var(--text); font-weight: 600; letter-spacing: 1px; }
  h2 { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; font-weight: 500; }
  .live { display: flex; align-items: center; gap: 6px; color: var(--green); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: pulse 1.5s infinite; }
  .mode-switch { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); text-decoration: none; border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; transition: all 0.15s; }
  .mode-switch:hover { color: var(--text); border-color: var(--text-dim); background: var(--bg-elev); }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

  .metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 28px;
  }
  .metric { padding: 14px 16px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; }
  .metric-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .metric-value { font-size: 20px; font-weight: 600; color: var(--text); }
  .metric-value.green { color: var(--green); }
  .metric-value.red { color: var(--red); }
  .metric-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }

  section { margin-bottom: 28px; }
  .section-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 6px 8px; color: var(--text-dim); border-bottom: 1px solid var(--border); font-weight: 500; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
  td { padding: 8px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: var(--bg-elev); }

  .badge { padding: 1px 6px; border-radius: 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; background: var(--bg-elev); color: var(--text-dim); }
  .badge.stopped { background: rgba(248,113,113,0.15); color: var(--red); }
  .badge.partial_exit { background: var(--bg-elev); color: var(--text); }
  .green { color: var(--green); }
  .red { color: var(--red); }
  .mono { font-variant-numeric: tabular-nums; }
  .dim { color: var(--text-dim); }
  .empty { color: var(--text-dim); font-style: italic; padding: 24px; text-align: center; }
  a { color: var(--text); text-decoration: none; border-bottom: 1px dotted var(--text-dim); }
  a:hover { border-bottom-style: solid; }
  .updated { font-size: 10px; color: var(--text-dim); }
  .sell-btn {
    padding: 2px 8px; border: 1px solid var(--red); background: transparent;
    color: var(--red); cursor: pointer; border-radius: 3px; font-size: 10px;
    font-family: inherit; letter-spacing: 0.5px; text-transform: uppercase;
  }
  .sell-btn:hover { background: rgba(248,113,113,0.15); }
  .sell-btn:disabled { opacity: 0.4; cursor: default; }

  @media (max-width: 800px) {
    .metrics { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>

<header>
  <div>
    <h1>ROBINHOOD BOT</h1>
    <div class="dim" style="font-size: 11px; margin-top: 4px;" id="modeline">—</div>
  </div>
  <div style="display:flex;align-items:center;gap:12px;">
    <a href="/paper" class="mode-switch">&#x1F4CA; PAPER DASHBOARD</a>
    <div class="live mode-real"><span class="dot"></span> LIVE TRADING</div>
  </div>
</header>

<div class="metrics">
  <div class="metric">
    <div class="metric-label">Wallet</div>
    <div class="metric-value mono" id="wallet">—</div>
    <div class="metric-sub" id="wallet-sub">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">PnL today</div>
    <div class="metric-value mono" id="pnl">—</div>
    <div class="metric-sub" id="pnl-sub">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Open</div>
    <div class="metric-value mono" id="open-count">—</div>
    <div class="metric-sub" id="open-sub">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Uptime</div>
    <div class="metric-value mono" style="font-size: 16px;" id="uptime">—</div>
    <div class="metric-sub" id="approved-sub">—</div>
  </div>
</div>

<section>
  <div class="section-head">
    <h2>Open positions</h2>
    <span class="updated" id="open-updated"></span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Token</th>
        <th>Entry MC</th>
        <th>Current MC</th>
        <th>PnL %</th>
        <th title="ETH que uma saída de 100% realizaria agora (impacto + fee + tax + gas de entrada)">Exit now (est)</th>
        <th>Entry Tx</th>
        <th>Age</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="open-rows"><tr><td colspan="8" class="empty">No open positions</td></tr></tbody>
  </table>
</section>

<section>
  <div class="section-head">
    <h2>Recent closed</h2>
    <span class="updated" id="closed-updated"></span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Token</th>
        <th>Status</th>
        <th>In / Out</th>
        <th title="Gas total (compra + venda) — derivado exato: saída − entrada − PnL">Gas</th>
        <th>PnL</th>
        <th>PnL %</th>
        <th>Duration</th>
        <th>Exit Tx</th>
      </tr>
    </thead>
    <tbody id="closed-rows"><tr><td colspan="8" class="empty">Nothing closed yet</td></tr></tbody>
  </table>
</section>

<script>
// Positions refresh at 2s (live MC). Stats/wallet refresh at 8s (less critical).
const POSITIONS_POLL_MS = 2000
const STATS_POLL_MS = 8000

function fmtEth(n) {
  if (n === null || n === undefined) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 0.0001 && abs > 0) return sign + abs.toExponential(2)
  return sign + abs.toFixed(6).replace(/0+$/, '').replace(/\\.$/, '')
}
function fmtPct(n) {
  if (n === null || n === undefined) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}
function fmtMC(usd, eth) {
  if (usd !== null && usd !== undefined && usd > 0) {
    if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(2) + 'M'
    if (usd >= 1_000) return '$' + (usd / 1_000).toFixed(2) + 'k'
    return '$' + usd.toFixed(2)
  }
  if (eth !== null && eth !== undefined) {
    return eth.toFixed(6) + ' ETH'
  }
  return '—'
}
function fmtAge(ms) {
  if (ms === null || ms === undefined) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h + 'h' + (m % 60) + 'm'
}
function pnlClass(n) {
  if (n === null || n === undefined) return ''
  return n > 0 ? 'green' : n < 0 ? 'red' : ''
}
function truncate(s, n) {
  if (!s) return '—'
  return s.length > n ? s.slice(0, n) + '…' : s
}
function explorer(addr) { return 'https://explorer.robinhoodchain.com/address/' + addr }
function explorerTx(h) { return 'https://explorer.robinhoodchain.com/tx/' + h }
// Real hashes only — synthetic markers (recovered:, honeypot:) get no link
function txLink(h) {
  if (!h || !h.startsWith('0x')) return '<span class="dim">—</span>'
  return '<a href="' + explorerTx(h) + '" target="_blank" title="' + h + '">' + h.slice(0, 8) + '…↗</a>'
}

async function load(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) throw new Error(r.status + '')
    return await r.json()
  } catch (e) {
    return null
  }
}

// Cached status for the open-count cap display (avoids extra request in positions poll)
let cachedStatus = null

async function refreshPositions() {
  const [open, closed] = await Promise.all([
    load('/api/positions/open'),
    load('/api/positions/closed'),
  ])

  if (open) {
    document.getElementById('open-count').textContent = open.length
    const maxOpen = cachedStatus?.maxOpenPositions ?? '?'
    document.getElementById('open-sub').textContent = 'cap ' + maxOpen
    const tbody = document.getElementById('open-rows')
    if (open.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">No open positions</td></tr>'
    } else {
      tbody.innerHTML = open.map(p => {
        const sym = p.tokenSymbol || truncate(p.tokenAddress, 10)
        const estMC = p.isEstimated
          ? '<span class="dim">~' + fmtMC(p.currentMarketCapUsd, p.currentMarketCapNative) + '</span>'
          : '<span class="' + pnlClass(p.pnlPct) + '">' + fmtMC(p.currentMarketCapUsd, p.currentMarketCapNative) + '</span>'
        return '<tr>' +
          '<td><a href="' + explorer(p.tokenAddress) + '" target="_blank">' + sym + '</a></td>' +
          '<td class="mono dim">' + fmtMC(p.entryMarketCapUsd, p.entryMarketCapNative) + '</td>' +
          '<td class="mono">' + estMC + '</td>' +
          '<td class="mono ' + pnlClass(p.pnlPct) + '">' + fmtPct(p.pnlPct) + '</td>' +
          '<td class="mono ' + pnlClass(p.unrealizedPnlNative) + '">' + fmtEth(p.unrealizedPnlNative) + ' ETH</td>' +
          '<td class="mono">' + txLink(p.entryTxHash) + '</td>' +
          '<td class="dim">' + fmtAge(p.ageMs) + '</td>' +
          '<td><button class="sell-btn" onclick="sellPosition(\\'' + p.id + '\\',this)">SELL</button></td>' +
        '</tr>'
      }).join('')
    }
    document.getElementById('open-updated').textContent = new Date().toLocaleTimeString()
  }

  if (closed) {
    const tbody = document.getElementById('closed-rows')
    if (closed.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">Nothing closed yet</td></tr>'
    } else {
      tbody.innerHTML = closed.map(p => {
        const sym = p.tokenSymbol || truncate(p.tokenAddress, 10)
        return '<tr>' +
          '<td><a href="' + explorer(p.tokenAddress) + '" target="_blank">' + sym + '</a></td>' +
          '<td><span class="badge ' + p.status + '">' + p.status + '</span></td>' +
          '<td class="mono dim">' + fmtEth(p.entryAmountNative) + ' / ' + fmtEth(p.exitAmountNative) + '</td>' +
          '<td class="mono dim">' + fmtEth(p.gasNative) + '</td>' +
          '<td class="mono ' + pnlClass(p.realizedPnlNative) + '">' + fmtEth(p.realizedPnlNative) + ' ETH</td>' +
          '<td class="mono ' + pnlClass(p.pnlPct) + '">' + fmtPct(p.pnlPct) + '</td>' +
          '<td class="dim">' + fmtAge(p.durationMs) + '</td>' +
          '<td class="mono">' + txLink(p.exitTxHash || p.entryTxHash) + '</td>' +
        '</tr>'
      }).join('')
    }
    document.getElementById('closed-updated').textContent = new Date().toLocaleTimeString()
  }
}

async function refreshStats() {
  const [status, today] = await Promise.all([
    load('/api/status'),
    load('/api/stats/today'),
  ])

  if (status) {
    cachedStatus = status
    const walletUsd = status.walletBalanceUsd
    const walletStr = walletUsd ? '$' + walletUsd.toFixed(2) : fmtEth(status.walletBalanceNative) + ' ETH'
    document.getElementById('wallet').textContent = walletStr
    document.getElementById('wallet-sub').textContent =
      fmtEth(status.walletBalanceNative) + ' ETH · ' + status.mode + ' · trade ' + fmtEth(status.tradeSizeNative) + ' ETH' +
      (status.walletAddress ? ' · ' + status.walletAddress.slice(0, 6) + '…' + status.walletAddress.slice(-4) : '')
    document.getElementById('uptime').textContent = status.uptimeHuman
    document.getElementById('modeline').textContent =
      status.mode + ' · ' + status.nodeEnv +
      ' · TP +' + status.takeProfitPct + '%' +
      (status.sellPctAtTp && status.sellPctAtTp < 100 ? ' (sell ' + status.sellPctAtTp + '%)' : '') +
      ' / SL -' + status.stopLossPct + '%' +
      (status.trailingStopPct > 0 ? ' · Trail ' + status.trailingStopPct + '%@+' + status.trailingArmPct + '%' : '') +
      ' · MC min $' + (status.minEntryMcUsd ?? 0) +
      (status.ethUsd ? ' · ETH $' + status.ethUsd.toFixed(2) : '')
  }

  if (today) {
    const pnlEl = document.getElementById('pnl')
    pnlEl.textContent = fmtEth(today.realizedPnlNative) + ' ETH'
    pnlEl.className = 'metric-value mono ' + pnlClass(today.realizedPnlNative)
    document.getElementById('pnl-sub').textContent = today.buys + ' buys · ' + today.sells + ' sells'
    document.getElementById('approved-sub').textContent = today.tokensApproved + ' / ' + today.tokensEvaluated + ' approved'
  }
}

async function sellPosition(id, btn) {
  if (!confirm('Sell 100% of this position?')) return
  btn.disabled = true
  btn.textContent = '...'
  try {
    const r = await fetch('/api/positions/' + id + '/sell?pct=100', { method: 'POST' })
    const data = await r.json()
    if (data.success) {
      btn.textContent = 'SOLD'
      setTimeout(refreshPositions, 500)
    } else {
      alert('Sell failed: ' + (data.error ?? 'unknown error'))
      btn.disabled = false
      btn.textContent = 'SELL'
    }
  } catch (e) {
    alert('Network error')
    btn.disabled = false
    btn.textContent = 'SELL'
  }
}

// Initial load — both together so dashboard appears fully populated immediately
refreshStats()
refreshPositions()

// Split intervals: positions update fast, stats are slow-changing
setInterval(refreshPositions, POSITIONS_POLL_MS)
setInterval(refreshStats, STATS_POLL_MS)
</script>

</body>
</html>`

// ── Paper Trading Dashboard ────────────────────────────────────────────────────
// Blue/cyan theme — visually distinct from real trading dashboard.
// Clear SIMULATED indicators on every position row.
export const dashboardHtmlPaper = /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Robinhood Bot — Paper Trading</title>
<style>
  :root {
    --bg: #000;
    --bg-card: #0a0a0a;
    --bg-elev: #141414;
    --border: #1f1f1f;
    --text: #e6e6e6;
    --text-dim: #707070;
    --accent: #22d3ee;
    --accent-dim: rgba(34,211,238,0.15);
    --green: #4ade80;
    --red: #f87171;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'SF Mono', Menlo, monospace;
    font-size: 13px;
    line-height: 1.4;
    padding: 20px;
    max-width: 1400px;
    margin: 0 auto;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 24px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--border);
  }
  h1 { font-size: 14px; color: var(--accent); font-weight: 600; letter-spacing: 1px; }
  h2 { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 10px; font-weight: 500; }
  .live { display: flex; align-items: center; gap: 6px; color: var(--accent); font-size: 10px; text-transform: uppercase; letter-spacing: 1px; }
  .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
  .mode-switch { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-dim); text-decoration: none; border: 1px solid var(--border); border-radius: 4px; padding: 3px 8px; transition: all 0.15s; }
  .mode-switch:hover { color: var(--accent); border-color: var(--accent); background: var(--accent-dim); }

  .paper-banner {
    background: var(--accent-dim);
    border: 1px solid var(--accent);
    border-radius: 6px;
    padding: 8px 14px;
    margin-bottom: 20px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11px;
    color: var(--accent);
    letter-spacing: 0.5px;
  }
  .paper-banner strong { text-transform: uppercase; }

  .metrics {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 28px;
  }
  .metrics-row-2 {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 28px;
  }
  .metric { padding: 14px 16px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; }
  .metric-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px; }
  .metric-value { font-size: 20px; font-weight: 600; color: var(--text); }
  .metric-value.green { color: var(--green); }
  .metric-value.red { color: var(--red); }
  .metric-value.accent { color: var(--accent); }
  .metric-sub { font-size: 11px; color: var(--text-dim); margin-top: 2px; }

  section { margin-bottom: 28px; }
  .section-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 8px; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 6px 8px; color: var(--text-dim); border-bottom: 1px solid var(--border); font-weight: 500; text-transform: uppercase; font-size: 10px; letter-spacing: 0.5px; }
  td { padding: 8px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: var(--bg-elev); }

  .badge { padding: 1px 6px; border-radius: 3px; font-size: 10px; text-transform: uppercase; letter-spacing: 0.5px; background: var(--bg-elev); color: var(--text-dim); }
  .badge.stopped { background: rgba(248,113,113,0.15); color: var(--red); }
  .badge.partial_exit { background: var(--bg-elev); color: var(--text); }
  .badge.paper { background: var(--accent-dim); color: var(--accent); }
  .green { color: var(--green); }
  .red { color: var(--red); }
  .accent { color: var(--accent); }
  .mono { font-variant-numeric: tabular-nums; }
  .dim { color: var(--text-dim); }
  .empty { color: var(--text-dim); font-style: italic; padding: 24px; text-align: center; }
  a { color: var(--text); text-decoration: none; border-bottom: 1px dotted var(--text-dim); }
  a:hover { border-bottom-style: solid; }
  .updated { font-size: 10px; color: var(--text-dim); }
  .sell-btn {
    padding: 2px 8px; border: 1px solid var(--accent); background: transparent;
    color: var(--accent); cursor: pointer; border-radius: 3px; font-size: 10px;
    font-family: inherit; letter-spacing: 0.5px; text-transform: uppercase;
  }
  .sell-btn:hover { background: var(--accent-dim); }
  .sell-btn:disabled { opacity: 0.4; cursor: default; }

  @media (max-width: 800px) {
    .metrics { grid-template-columns: repeat(2, 1fr); }
    .metrics-row-2 { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>

<header>
  <div>
    <h1>&#x1F4CA; ROBINHOOD BOT</h1>
    <div class="dim" style="font-size: 11px; margin-top: 4px;" id="modeline">—</div>
  </div>
  <div style="display:flex;align-items:center;gap:12px;">
    <a href="/real" class="mode-switch">&#x1F4C8; REAL DASHBOARD</a>
    <div class="live"><span class="dot"></span> PAPER TRADING</div>
  </div>
</header>

<div class="paper-banner">
  <span>&#x1F9EA;</span>
  <span><strong>PAPER TRADING MODE</strong> — Todas as operações são simulações. Nenhum trade real está sendo executado on-chain.</span>
</div>

<div class="metrics">
  <div class="metric">
    <div class="metric-label">Paper Balance</div>
    <div class="metric-value mono accent" id="wallet">—</div>
    <div class="metric-sub" id="wallet-sub">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Sim PnL Today</div>
    <div class="metric-value mono" id="pnl">—</div>
    <div class="metric-sub" id="pnl-sub">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">All-Time PnL</div>
    <div class="metric-value mono" id="alltime-pnl">—</div>
    <div class="metric-sub" id="alltime-pnl-sub">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Uptime</div>
    <div class="metric-value mono" style="font-size: 16px;" id="uptime">—</div>
    <div class="metric-sub" id="approved-sub">—</div>
  </div>
</div>

<div class="metrics-row-2">
  <div class="metric">
    <div class="metric-label">Win Rate</div>
    <div class="metric-value mono accent" id="winrate">—</div>
    <div class="metric-sub" id="winrate-sub">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Total Sim Trades</div>
    <div class="metric-value mono" id="total-trades">—</div>
    <div class="metric-sub" id="total-trades-sub">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Open</div>
    <div class="metric-value mono" id="open-count">—</div>
    <div class="metric-sub" id="open-sub">—</div>
  </div>
  <div class="metric">
    <div class="metric-label">Trade Size</div>
    <div class="metric-value mono" style="font-size: 16px;" id="trade-size">—</div>
    <div class="metric-sub" id="trade-size-sub">—</div>
  </div>
</div>

<section>
  <div class="section-head">
    <h2>&#x1F4C8; Open Positions (Simulated)</h2>
    <span class="updated" id="open-updated"></span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Token</th>
        <th>Entry MC</th>
        <th>Current MC</th>
        <th>PnL %</th>
        <th>Unrealized</th>
        <th>Age</th>
        <th></th>
      </tr>
    </thead>
    <tbody id="open-rows"><tr><td colspan="7" class="empty">No open paper positions</td></tr></tbody>
  </table>
</section>

<section>
  <div class="section-head">
    <h2>&#x1F4CB; Recent Closed (Simulated)</h2>
    <span class="updated" id="closed-updated"></span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Token</th>
        <th>Status</th>
        <th>In / Out</th>
        <th>PnL</th>
        <th>PnL %</th>
        <th>Duration</th>
      </tr>
    </thead>
    <tbody id="closed-rows"><tr><td colspan="6" class="empty">Nothing closed yet</td></tr></tbody>
  </table>
</section>

<script>
const POSITIONS_POLL_MS = 2000
const STATS_POLL_MS = 8000

function fmtEth(n) {
  if (n === null || n === undefined) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs < 0.0001 && abs > 0) return sign + abs.toExponential(2)
  return sign + abs.toFixed(6).replace(/0+$/, '').replace(/\\.$/, '')
}
function fmtPct(n) {
  if (n === null || n === undefined) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'
}
function fmtMC(usd, eth) {
  if (usd !== null && usd !== undefined && usd > 0) {
    if (usd >= 1_000_000) return '$' + (usd / 1_000_000).toFixed(2) + 'M'
    if (usd >= 1_000) return '$' + (usd / 1_000).toFixed(2) + 'k'
    return '$' + usd.toFixed(2)
  }
  if (eth !== null && eth !== undefined) {
    return eth.toFixed(6) + ' ETH'
  }
  return '—'
}
function fmtAge(ms) {
  if (ms === null || ms === undefined) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60)
  return h + 'h' + (m % 60) + 'm'
}
function pnlClass(n) {
  if (n === null || n === undefined) return ''
  return n > 0 ? 'green' : n < 0 ? 'red' : ''
}
function truncate(s, n) {
  if (!s) return '—'
  return s.length > n ? s.slice(0, n) + '…' : s
}
function explorer(addr) { return 'https://explorer.robinhoodchain.com/address/' + addr }

async function load(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) throw new Error(r.status + '')
    return await r.json()
  } catch (e) {
    return null
  }
}

let cachedStatus = null

async function refreshPositions() {
  const [open, closed] = await Promise.all([
    load('/api/positions/open'),
    load('/api/positions/closed'),
  ])

  if (open) {
    document.getElementById('open-count').textContent = open.length
    const maxOpen = cachedStatus?.maxOpenPositions ?? '?'
    document.getElementById('open-sub').textContent = 'cap ' + maxOpen
    const tbody = document.getElementById('open-rows')
    if (open.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="empty">No open paper positions</td></tr>'
    } else {
      tbody.innerHTML = open.map(p => {
        const sym = p.tokenSymbol || truncate(p.tokenAddress, 10)
        const estMC = p.isEstimated
          ? '<span class="dim">~' + fmtMC(p.currentMarketCapUsd, p.currentMarketCapNative) + '</span>'
          : '<span class="' + pnlClass(p.pnlPct) + '">' + fmtMC(p.currentMarketCapUsd, p.currentMarketCapNative) + '</span>'
        return '<tr>' +
          '<td><a href="' + explorer(p.tokenAddress) + '" target="_blank">' + sym + '</a> <span class="badge paper">SIM</span></td>' +
          '<td class="mono dim">' + fmtMC(p.entryMarketCapUsd, p.entryMarketCapNative) + '</td>' +
          '<td class="mono">' + estMC + '</td>' +
          '<td class="mono ' + pnlClass(p.pnlPct) + '">' + fmtPct(p.pnlPct) + '</td>' +
          '<td class="mono ' + pnlClass(p.unrealizedPnlNative) + '">' + fmtEth(p.unrealizedPnlNative) + ' ETH</td>' +
          '<td class="dim">' + fmtAge(p.ageMs) + '</td>' +
          '<td><button class="sell-btn" onclick="sellPosition(\\'' + p.id + '\\',this)">SIM SELL</button></td>' +
        '</tr>'
      }).join('')
    }
    document.getElementById('open-updated').textContent = new Date().toLocaleTimeString()
  }

  if (closed) {
    const tbody = document.getElementById('closed-rows')
    if (closed.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty">Nothing closed yet</td></tr>'
    } else {
      tbody.innerHTML = closed.map(p => {
        const sym = p.tokenSymbol || truncate(p.tokenAddress, 10)
        return '<tr>' +
          '<td><a href="' + explorer(p.tokenAddress) + '" target="_blank">' + sym + '</a> <span class="badge paper">SIM</span></td>' +
          '<td><span class="badge ' + p.status + '">' + p.status + '</span></td>' +
          '<td class="mono dim">' + fmtEth(p.entryAmountNative) + ' / ' + fmtEth(p.exitAmountNative) + '</td>' +
          '<td class="mono ' + pnlClass(p.realizedPnlNative) + '">' + fmtEth(p.realizedPnlNative) + ' ETH</td>' +
          '<td class="mono ' + pnlClass(p.pnlPct) + '">' + fmtPct(p.pnlPct) + '</td>' +
          '<td class="dim">' + fmtAge(p.durationMs) + '</td>' +
        '</tr>'
      }).join('')
    }
    document.getElementById('closed-updated').textContent = new Date().toLocaleTimeString()
  }
}

async function refreshStats() {
  const [status, today] = await Promise.all([
    load('/api/status'),
    load('/api/stats/today'),
  ])

  if (status) {
    cachedStatus = status
    const walletUsd = status.walletBalanceUsd
    const walletStr = walletUsd ? '$' + walletUsd.toFixed(2) : fmtEth(status.walletBalanceNative) + ' ETH'
    document.getElementById('wallet').textContent = walletStr
    document.getElementById('wallet-sub').textContent =
      fmtEth(status.walletBalanceNative) + ' ETH · simulado · trade ' + fmtEth(status.tradeSizeNative) + ' ETH'

    document.getElementById('uptime').textContent = status.uptimeHuman
    document.getElementById('trade-size').textContent = fmtEth(status.tradeSizeNative) + ' ETH'
    document.getElementById('trade-size-sub').textContent =
      'TP +' + status.takeProfitPct + '%' +
      (status.sellPctAtTp && status.sellPctAtTp < 100 ? ' (sell ' + status.sellPctAtTp + '%)' : '') +
      ' / SL -' + status.stopLossPct + '%' +
      (status.trailingStopPct > 0 ? ' · Trail ' + status.trailingStopPct + '%@+' + status.trailingArmPct + '%' : '')

    const allTimePnLEl = document.getElementById('alltime-pnl')
    if (status.allTimePaperPnl !== undefined) {
      allTimePnLEl.textContent = fmtEth(status.allTimePaperPnl) + ' ETH'
      allTimePnLEl.className = 'metric-value mono ' + pnlClass(status.allTimePaperPnl)
    }

    if (status.paperWinRate !== null && status.paperWinRate !== undefined) {
      document.getElementById('winrate').textContent = status.paperWinRate + '%'
    }
    document.getElementById('winrate-sub').textContent =
      (status.totalPaperTrades ?? 0) + ' simulated trades'

    document.getElementById('alltime-pnl-sub').textContent =
      'paper balance ' + fmtEth(status.paperBalanceNative) + ' ETH'

    document.getElementById('modeline').textContent =
      '📊 PAPER · ' + status.nodeEnv +
      ' · TP +' + status.takeProfitPct + '%' +
      (status.sellPctAtTp && status.sellPctAtTp < 100 ? ' (sell ' + status.sellPctAtTp + '%)' : '') +
      ' / SL -' + status.stopLossPct + '%' +
      (status.trailingStopPct > 0 ? ' · Trail ' + status.trailingStopPct + '%@+' + status.trailingArmPct + '%' : '') +
      ' · MC min $' + (status.minEntryMcUsd ?? 0) +
      (status.ethUsd ? ' · ETH $' + status.ethUsd.toFixed(2) : '')

    document.getElementById('total-trades').textContent = status.totalPaperTrades ?? '0'
    document.getElementById('total-trades-sub').textContent = 'all-time paper trades'
  }

  if (today) {
    const pnlEl = document.getElementById('pnl')
    pnlEl.textContent = fmtEth(today.realizedPnlNative) + ' ETH'
    pnlEl.className = 'metric-value mono ' + pnlClass(today.realizedPnlNative)
    document.getElementById('pnl-sub').textContent = today.buys + ' buys · ' + today.sells + ' sells (sim)'
    document.getElementById('approved-sub').textContent = today.tokensApproved + ' / ' + today.tokensEvaluated + ' approved'
  }
}

async function sellPosition(id, btn) {
  if (!confirm('Simulated sell: 100% of this paper position?')) return
  btn.disabled = true
  btn.textContent = '...'
  try {
    const r = await fetch('/api/positions/' + id + '/sell?pct=100', { method: 'POST' })
    const data = await r.json()
    if (data.success) {
      btn.textContent = 'SIM SOLD'
      setTimeout(refreshPositions, 500)
    } else {
      alert('Sim sell failed: ' + (data.error ?? 'unknown error'))
      btn.disabled = false
      btn.textContent = 'SIM SELL'
    }
  } catch (e) {
    alert('Network error')
    btn.disabled = false
    btn.textContent = 'SIM SELL'
  }
}

refreshStats()
refreshPositions()

setInterval(refreshPositions, POSITIONS_POLL_MS)
setInterval(refreshStats, STATS_POLL_MS)
</script>

</body>
</html>`
