// Funnel summary — aggregates the bot's decision pipeline from its log file.
// Shows, at each stage, how many pairs were seen and why they were dropped:
//   detected → detector → risk engine → strategy (tier + honeypot) → bought.
//
// Usage:
//   node scripts/funnel.mjs                 # reads /tmp/bot-run.log
//   node scripts/funnel.mjs path/to/log     # custom log path
//   node scripts/funnel.mjs --watch         # refresh every 5s
//
// NOTE: the detector-stage breakdown (score too low, spam, burst) is logged at
// DEBUG level, so run the bot with LOG_LEVEL=debug to see it. The strategy stage
// (tier / honeypot decisions) and approvals are logged at INFO.

import { readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const watch = args.includes('--watch')
const logPath = args.find((a) => !a.startsWith('--')) ?? '/tmp/bot-run.log'

const count = (log, re) => (log.match(re) ?? []).length

function reasonBreakdown(log) {
  // Each "ENTRY REJECTED — <stage>" line is followed a few lines later by a
  // `reason: "..."` field (for tier/honeypot). Pair them up.
  const out = new Map()
  const lines = log.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/ENTRY REJECTED — (.+?)(?:\x1b|$)/)
    if (!m) continue
    const stage = m[1].trim()
    let reason = ''
    for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
      if (/ENTRY (REJECTED|APPROVED)/.test(lines[j])) break
      const rm = lines[j].match(/reason: "(.+?)"/)
      if (rm) { reason = rm[1]; break }
    }
    const key = reason ? `${stage} — ${reason}` : stage
    out.set(key, (out.get(key) ?? 0) + 1)
  }
  return out
}

function render() {
  let log
  try {
    log = readFileSync(logPath, 'utf8')
  } catch {
    console.error(`Cannot read log: ${logPath} — is the bot running and writing there?`)
    process.exit(1)
  }

  const detected = count(log, /New Uniswap V2 pair detected/g)
  const detLow = count(log, /Composite score too low/g)
  const detSpam = count(log, /SPAM PATTERN|FUZZY SYMBOL SPAM/g)
  const detBurst = count(log, /DEPLOYER BURST/g)
  const detDup = count(log, /Duplicate token/g)
  const detOld = count(log, /Event too old/g)
  const candidates = count(log, /Candidate opportunity published/g)
  const approvedRisk = count(log, /APPROVED — published to executor/g)
  const entryApproved = count(log, /ENTRY APPROVED/g)
  const reasons = reasonBreakdown(log)

  const lines = []
  lines.push('═══════════ FUNIL DO BOT ═══════════')
  lines.push(`Pares detectados on-chain:       ${detected}`)
  lines.push('  descartados no detector:')
  lines.push(`    score muito baixo:           ${detLow}`)
  lines.push(`    spam (símbolo/nome):         ${detSpam}`)
  lines.push(`    burst de deployer:           ${detBurst}`)
  lines.push(`    duplicados / antigos:        ${detDup + detOld}`)
  lines.push(`  → viraram candidatos:          ${candidates}`)
  lines.push(`  → aprovados no risk engine:    ${approvedRisk}`)
  lines.push('  decisão da estratégia (tier + honeypot):')
  if (reasons.size === 0) {
    lines.push('    (nenhuma chegou à estratégia ainda)')
  } else {
    for (const [reason, c] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`    ✗ ${reason}: ${c}`)
    }
  }
  lines.push(`  ✓ ENTRADAS APROVADAS (compras): ${entryApproved}`)
  lines.push('════════════════════════════════════')

  if (watch) console.clear()
  console.log(lines.join('\n'))
  if (watch) console.log(`\n(atualizando a cada 5s — Ctrl+C para sair) — ${new Date().toLocaleTimeString()}`)
}

render()
if (watch) setInterval(render, 5_000)
