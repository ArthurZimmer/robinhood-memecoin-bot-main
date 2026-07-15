# 🎯 Análise Completa de Prontidão para Produção — Robinhood Memecoin Bot v0.2.0

**Objetivo:** Snipar memecoins na Robinhood Chain (Chain ID 4663) e lucrar com a explosão de ATH em pares Uniswap V2.

**Data:** 2026-07-14

---

## ⚠️ Leia Antes de Tudo

**O nome do diretório `solana-memecoin-bot-main` é ENGANOSO.** Este NÃO é um bot Solana. O projeto foi originalmente escrito para Solana/Pump.fun e foi migrado para **Robinhood Chain (EVM) + Uniswap V2**. Todo o código-fonte atual é Uniswap V2 / ethers.js v6 em EVM. A documentação (README.md, REAL_MODE.md) está desatualizada e ainda referencia Pump.fun — ignore essas referências. O código real está correto e funcional para Robinhood Chain.

---

## 📊 Resumo do Status Atual

| Área | Status | Prontidão |
|------|--------|-----------|
| Pipeline de eventos (Redis Streams 7 estágios) | ✅ Completo | 100% |
| Listener Uniswap V2 (eth_getLogs polling) | ✅ Completo | 100% |
| Detector de spam/qualidade multi-dimensional | ✅ Completo | 100% |
| Engine de risco (4 checks ponderados) | ✅ Completo | 100% |
| Estratégia multi-tier (MC + scores) | ✅ Completo | 100% |
| Executor Paper (simulação AMM constante) | ✅ Completo | 100% |
| Executor Real (swap on-chain Router02) | ✅ Completo | 95% |
| Gerenciador de posições (TP/SL/stale/dev dump) | ✅ Completo | 100% |
| Dashboard HTTP em tempo real | ✅ Completo | 100% |
| Notificações Telegram | ✅ Completo | 100% |
| Docker Compose (Postgres + Redis + Bot) | ✅ Completo | 100% |
| Schema PostgreSQL + Migrations | ✅ Completo | 100% |
| Validação de config (Zod, 40+ campos) | ✅ Completo | 100% |
| Logger Pino com redação de secrets | ✅ Completo | 100% |
| Testes automatizados | ❌ Zero testes | 0% |
| Proteção MEV/Front-running | ❌ Não implementado | 0% |
| Failover Multi-RPC | ❌ Apenas 1 RPC | 0% |
| WebSocket em vez de polling | ❌ Polling a cada 3s | 0% |
| Documentação atualizada | ❌ README/REAL_MODE obsoletos | 0% |
| Backtesting histórico | ❌ Não implementado | 0% |
| CI/CD Pipeline | ❌ Não implementado | 0% |
| Monitoramento de infraestrutura | ❌ Não implementado | 0% |

---

## 🔴 GAPS CRÍTICOS — Resolver Antes de Qualquer Operação Real

### 1. CHAVE PRIVADA NÃO CONFIGURADA
**Arquivo:** `.env` linha 69
```
WALLET_PRIVATE_KEY=0xyour_private_key_here
```
O placeholder nunca foi substituído. Sem uma chave privada real, o bot não consegue assinar transações no modo `TRADING_MODE=real`. O `getBotWallet()` em `src/utils/wallet.ts` lança erro se a chave não tiver exatamente 64 caracteres hex.

**Ação:** Gerar uma nova wallet (nunca reutilizar uma existente), financiar com valor mínimo para testes (0.1-0.5 ETH), e colocar a chave privada no `.env`.

---

### 2. CREDENCIAIS REAIS EXPOSTAS NO .ENV
O arquivo `.env` contém credenciais REAIS que NUNCA devem ser commitadas em repositório:
- **QuickNode API Key:** `<REDACTED>` (HTTP + WebSocket)
- **Telegram Bot Token:** `<REDACTED>`
- **Telegram Chat ID:** `<REDACTED>`

⚠️ **ALERTA DE SEGURANÇA:** Se este código já foi commitado em algum repositório Git (público ou privado), as chaves da QuickNode e do Telegram estão comprometidas. Rotacione-as IMEDIATAMENTE.

**Ações:**
1. Verificar se `.env` está no `.gitignore` (está, mas verificar se NUNCA foi commitado)
2. Rodar `git log --all --full-history -- .env` para confirmar que nunca foi commitado
3. Se já foi commitado: rotacionar todas as chaves IMEDIATAMENTE
4. Considerar usar `git filter-branch` ou `bfg` para remover do histórico

---

### 3. ZERO TESTES AUTOMATIZADOS
Não existe NENHUM arquivo de teste no projeto. Rodar dinheiro real com código não testado é extremamente arriscado. Áreas que PRECISAM de testes:

- **Uniswap V2 math (`src/executor/uniswap-math.ts`):** Funções `quoteBuy`, `quoteSell`, `normalizeReserves`, `getMarketCapUSD`. Um bug aqui = prejuízo financeiro direto.
- **Paper Executor (`src/executor/paper.executor.ts`):** 6 sanity checks de validação matemática. Precisam ser testados com valores edge case (reserves zero, slippage 100%, tokens com 0 ou 18 decimals).
- **Real Executor (`src/executor/real.executor.ts`):** Retry logic, approve flow, extração de fill do receipt.
- **Detector de spam (`src/detectors/uniswap-launch.detector.ts`):** Fuzzy matching, dedup, burst detection.
- **Risk Engine (`src/risk/risk-engine.ts`):** Sequenciamento de checks, fail-fast em critical.
- **Estratégia (`src/strategies/uniswap-snipe.strategy.ts`):** Cálculo de MC, tier classification, gates.

**Ação mínima:** Testes unitários para `uniswap-math.ts` e `paper.executor.ts` ANTES de qualquer operação real. Estes são os módulos que lidam diretamente com dinheiro.

---

### 4. DOCUMENTAÇÃO TOTALMENTE DESATUALIZADA
- **README.md:** Referencia Pump.fun, PumpPortal WSS, Jupiter API, bonding curve math, e arquivos que não existem mais (`pumpfun.parser.ts`, `pumpfun-curve.ts`). O mapa de arquivos está errado.
- **REAL_MODE.md:** Fala em Pump.fun bonding curve, PumpPortal, Jupiter — nada disso existe mais. A tabela de riscos menciona "PumpPortal WSS disconnect" e "bonding curve state drift" que são conceitos Solana.
- **REFINAMENTO_FILTRO.md:** Documento em português sobre a migração de filtro binário para multi-dimensional — ainda referencia Pump.fun.

**Ação:** Reescrever README.md e REAL_MODE.md refletindo a arquitetura real: Robinhood Chain, Uniswap V2, ethers.js v6, Redis Streams, constant-product AMM.

---

## 🟠 GAPS ALTOS — Resolver Antes de Aumentar Posições

### 5. PROTEÇÃO CONTRA MEV / FRONT-RUNNING (NÃO IMPLEMENTADA)
No Uniswap V2, transações enviadas via RPC público passam pela mempool onde bots de MEV podem ver, front-run (sandwich attack), e extrair valor da sua operação. O resultado: você compra mais caro e vende mais barato.

O `.env` tem um campo comentado:
```
# MEV_RELAY_URL=https://relay.flashbots.net
```

Mas NÃO EXISTE implementação no código. Nenhum arquivo referencia Flashbots, `eth_sendPrivateTransaction`, ou qualquer relay de MEV.

**Impacto estimado:** Em memecoins de alta volatilidade, um sandwich bot pode extrair 2-5% do valor de cada trade — essencialmente destruindo a margem de lucro.

**Solução:** Integrar Flashbots Protect ou similar:
- Enviar `eth_sendPrivateTransaction` em vez de `eth_sendRawTransaction`
- Ou usar um RPC privado como QuickNode Add-on "Private TX"
- A rota mais simples: usar um provedor RPC que já oferece proteção MEV (ex: bloXroute, ou o add-on "Secure" da QuickNode)

---

### 6. FAILOVER MULTI-RPC (APENAS 1 ENDPOINT)
O bot depende de UM único endpoint QuickNode:
```
ROBBINHOOD_RPC_URL=https://proportionate-convincing-moon.robinhood-mainnet.quiknode.pro/...
```

Se este endpoint:
- Atingir o rate limit diário (plano Discover/Free = ~300 req/dia)
- Ficar fora do ar para manutenção
- Tiver latência alta

O bot INTEIRO para. Não há fallback automático.

**Solução:**
1. Adicionar `ROBBINHOOD_RPC_URL_BACKUP` no `.env`
2. Implementar um wrapper de Provider com retry + failover automático
3. Idealmente 3 endpoints: QuickNode + Alchemy (se suportar Robinhood) + um terceiro

---

### 7. POLLING DE 3 SEGUNDOS = LATÊNCIA ALTA PARA SNIPING
O listener em `src/listeners/uniswap-pair.listener.ts` faz polling via `eth_getLogs` a cada 3 segundos, processando 5 blocos por chunk com delays de 200ms entre chunks.

Para sniping de memecoins, 3 segundos é uma eternidade. Considere:
- Um par Uniswap V2 é criado no bloco N
- O listener detecta no próximo ciclo de polling (até 3s depois)
- Pipeline: Parser → Detector → Risk Engine → Strategy → Executor
- Tempo total até a compra: 4-6 segundos

Nesse intervalo, bots mais rápidos já compraram e o preço já subiu.

**Solução:** O `ethers.js` suporta WebSocket nativamente via `WebSocketProvider`. Implementar `factoryContract.on('PairCreated', callback)` eliminaria a latência de polling e detectaria pares em tempo real (sub-second). A infraestrutura WebSocket JÁ existe (`rhWsProvider` em `src/utils/robbinhood.utils.ts`), mas o listener não a utiliza.

---

### 8. SEM BACKTESTING HISTÓRICO
Paper mode permite testar a estratégia em tempo real, mas não existe mecanismo para backtesting com dados históricos. Você não consegue responder perguntas como:
- "Qual teria sido meu PnL nos últimos 30 dias com estes parâmetros?"
- "Quantos trades esta configuração teria feito?"
- "Qual é a taxa de acerto esperada?"

**Solução:** Implementar um script que lê eventos passados do Uniswap V2 Factory (via `eth_getLogs` com range de blocos histórico) e simula trades usando o Paper Executor com os preços históricos dos pares.

---

## 🟡 GAPS MÉDIOS — Resolver Durante Fase de Paper Trading (1-2 semanas)

### 9. GAS PRICE NÃO OTIMIZADO
O `real.executor.ts` usa:
- **Buy:** `maxFeePerGas` e `maxPriorityFeePerGas` opcionais no signal (normalmente undefined → usa default da rede)
- **Sell:** Priority fees fixos e escalonados (2 → 5 → 10 gwei)

Não há consulta dinâmica de `eth_feeHistory` ou `eth_gasPrice`. Em condições de rede congestionada, a transação pode ficar pendente por minutos ou ser descartada.

**Solução:** Adicionar `eth_feeHistory` antes de cada envio para calcular gas competitivo automaticamente.

---

### 10. SLIPPAGE FIXO (15% BUY / 3% SELL)
O slippage tolerance é hardcoded:
- Buy: `SLIPPAGE_BPS = 1_500` (15%) — estratégia, linha 49
- Sell: `UNISWAP_SELL_SLIPPAGE_PCT = 3` — executor real, linha 57

Para memecoins com liquidez extremamente baixa (0.1 ETH), 15% pode não ser suficiente. Para tokens com liquidez alta (5+ ETH), 15% é excessivo e deixa dinheiro na mesa.

**Solução:** Slippage dinâmico baseado na liquidez do par. Ex: `slippage = max(3%, tradeSize / liquidity * 2)`. Já existe um check no `liquidity.check.ts` que rejeita trades com impacto >5% — mas não ajusta o slippage.

---

### 11. POSTGRESQL E REDIS SEM REPLICAÇÃO
O `docker-compose.yml` configura instâncias únicas de Postgres e Redis. Se qualquer uma cair:
- **Postgres down:** Posições não são persistidas, PnL não é registrado, blacklist não carrega
- **Redis down:** Pipeline de eventos INTEIRO para. Nenhum evento flui entre os estágios.

**Solução para produção:**
- Postgres: Backup automático (pg_dump cron) + streaming replication
- Redis: AOF já está ativado (`redis:7-alpine` com `--appendonly yes`), mas considerar Redis Sentinel para failover

---

### 12. SEM MONITORAMENTO DE INFRAESTRUTURA
Além das notificações Telegram de trades, não há monitoramento de:
- Saúde do processo do bot (CPU, memória, event loop lag)
- Latência RPC
- Tamanho das filas Redis Streams (se acumular, pipeline está gargalando)
- Erros agregados por tipo/frequência

**Solução:** Adicionar um healthcheck endpoint com métricas (já existe o dashboard em `/api/status` mas é básico) e integrar com um serviço como BetterStack, Grafana Cloud, ou um script simples de healthcheck.

---

### 13. SEM CIRCUIT BREAKER POR TOKEN
O `DAILY_LOSS_LIMIT_NATIVE=0.5` é um kill switch global diário. Mas não há proteção por token individual. Se um único token fizer -0.3 ETH em 30 segundos (rug pull), o bot não reage até o stop-loss de -50% ou o dev dump detection (10% threshold).

**Solução:** Adicionar um trailing stop-loss ou um limite de perda máxima por posição (`MAX_LOSS_PER_POSITION_NATIVE`).

---

## 🟢 GAPS BAIXOS — Melhorias para Depois do Lançamento

### 14. CI/CD Pipeline (Não Implementado)
- Sem `tsc --noEmit` automático para checar tipos
- Sem linter (ESLint) configurado
- Sem testes rodando em push/PR
- Deploy manual via Docker Compose

**Solução:** GitHub Actions simples: typecheck → tests → build Docker image → deploy no VPS.

---

### 15. TAMANHO DE POSIÇÃO FIXO
O bot sempre compra `TRADE_SIZE_NATIVE=0.05 ETH` independente da qualidade do sinal. Estratégias mais sofisticadas ajustam o tamanho baseado no score do detector ou na confiança do sinal.

**Solução futura:** `amountNative = TRADE_SIZE_NATIVE * (detectorScore / 50)`, com min e max configuráveis.

---

### 16. TIMEOUT DE IPFS NAS ANÁLISES DE TOKEN
O `token-analyzer.ts` busca metadata via IPFS com timeout de 3 segundos. Se vários tokens forem lançados simultaneamente e todos tiverem metadata IPFS lento, o pipeline pode acumular latência.

**Solução:** Cache em Redis das análises de token (já existe cache em memória LRU de 1000 entradas na estratégia, mas não persiste entre restarts).

---

### 17. ROLLBACK DE MIGRATIONS NÃO IMPLEMENTADO
O `docker/entrypoint.sh` roda `npm run db:migrate` automaticamente. Se uma migration for problemática, o container não inicia e não há rollback automático.

**Solução:** Adicionar um healthcheck que verifica se as migrations foram aplicadas com sucesso e, em caso de falha, notificar o operador.

---

### 18. SEM TRACKING DE PnL CUMULATIVO DE LONGO PRAZO
O PnL é registrado por posição, mas não há agregação cumulativa com time-weighted returns, Sharpe ratio, ou drawdown analysis.

**Solução futura:** Tabela `daily_pnl` para snapshots diários de PnL, e um endpoint `/api/stats/performance` com métricas avançadas.

---

## 🚀 ROTEIRO PARA PRODUÇÃO (ORDEM CRONOLÓGICA)

### Semana 1: Preparação e Paper Trading
- [x] Código base funcional
- [ ] **Dia 1:** Rotacionar credenciais expostas (QuickNode, Telegram)
- [ ] **Dia 1:** Criar wallet nova exclusiva para o bot
- [ ] **Dia 1:** Atualizar `.env` com `WALLET_PRIVATE_KEY` real
- [ ] **Dia 1-2:** Atualizar README.md e REAL_MODE.md com arquitetura correta
- [ ] **Dia 2-3:** Escrever testes unitários para `uniswap-math.ts` e `paper.executor.ts`
- [ ] **Dia 3:** Rodar bot em modo paper por 24h, monitorar dashboard
- [ ] **Dia 4-5:** Implementar WebSocket listener (`factoryContract.on('PairCreated')`)
- [ ] **Dia 5-7:** Paper trading contínuo (mínimo 200 trades)

### Semana 2: Hardening
- [ ] Adicionar `ROBBINHOOD_RPC_URL_BACKUP` com failover automático
- [ ] Implementar Flashbots/MEV protection para real mode
- [ ] Testes de integração (listener → parser → detector → strategy → executor)
- [ ] Deploy em VPS conforme `DEPLOY.md`
- [ ] Configurar backup automático do PostgreSQL
- [ ] Configurar monitoramento de saúde do bot (cron job ou BetterStack)

### Semana 3: Real Mode Controlado
- [ ] Começar com `TRADE_SIZE_NATIVE=0.01`, `MAX_OPEN_POSITIONS=1`
- [ ] `DAILY_LOSS_LIMIT_NATIVE=0.02`
- [ ] Rodar por 3 dias, analisar resultados
- [ ] Se win rate > 30% e PnL positivo: aumentar gradualmente
- [ ] `TRADE_SIZE_NATIVE=0.02`, `MAX_OPEN_POSITIONS=2`
- [ ] `TRADE_SIZE_NATIVE=0.05`, `MAX_OPEN_POSITIONS=3`
- [ ] Alvo final: `TRADE_SIZE_NATIVE=0.05`, `MAX_OPEN_POSITIONS=5`

### Semana 4+: Otimizações e Escala
- [ ] Slippage dinâmico baseado em liquidez
- [ ] Gas price dinâmico via `eth_feeHistory`
- [ ] Tamanho de posição ajustado por score
- [ ] CI/CD pipeline
- [ ] Backtesting com dados históricos
- [ ] Métricas avançadas de PnL (Sharpe, drawdown, win rate por tier)

---

## 📋 Configuração Mínima para Primeiro Deploy

### `.env` de produção (valores recomendados para início):

```env
NODE_ENV=production
LOG_LEVEL=info
TRADING_MODE=paper          # Começar SEMPRE em paper
PAPER_BALANCE_NATIVE=10
TRADE_SIZE_NATIVE=0.01      # Mínimo absoluto
TAKE_PROFIT_PCT=100
SELL_PCT_AT_TP=50
STOP_LOSS_PCT=50
MAX_OPEN_POSITIONS=1        # Começar com 1
DAILY_LOSS_LIMIT_NATIVE=0.02
MIN_ENTRY_MC_USD=5000       # Mais conservador
MIN_LIQUIDITY_NATIVE=0.2    # Mais conservador
TIER1_MC_USD=12000          # Mais conservador
TIER2_MC_USD=8000
MIN_DETECTOR_SCORE=45       # Mais conservador
MIN_DETECTOR_SCORE_TIER2=60
MIN_DETECTOR_SCORE_TIER3=80
REQUIRE_SOCIAL_TIER2=true
REQUIRE_FRESH_DEPLOYER_TIER3=true
MIN_TOKEN_AGE_MS=5000       # 5 segundos (mais seguro)
MIN_DEV_BUY_NATIVE=0.1
MIN_WALLET_BALANCE_NATIVE=0.2
DEV_SELL_ABANDON_PCT=10
```

### Comandos para primeiro deploy:

```bash
# 1. Verificar que .env não está commitado
git check-ignore .env  # Deve retornar ".env"

# 2. Instalar dependências
npm ci

# 3. Rodar typecheck
npx tsc --noEmit

# 4. Subir infraestrutura
docker compose up -d postgres redis

# 5. Rodar migrations
npm run db:migrate

# 6. Iniciar bot em paper mode
npm run dev

# 7. Acessar dashboard
# SSH tunnel: ssh -L 3000:localhost:3000 user@vps
# Abrir http://localhost:3000 no navegador
```

---

## 🔒 Segurança — Checklist

- [ ] Wallet do bot é DEDICADA (nunca usada para outros fins)
- [ ] Wallet do bot tem apenas o ETH necessário para trading (0.1-0.5 ETH inicial)
- [ ] Chave privada NUNCA foi commitada em Git
- [ ] Chave privada NUNCA foi compartilhada em chat, logs, ou screenshots
- [ ] QuickNode API key é dedicada ao bot (não compartilhada com outros projetos)
- [ ] Dashboard NUNCA exposto publicamente (apenas via SSH tunnel)
- [ ] Telegram bot token é dedicado ao bot de trading
- [ ] `.env` está no `.gitignore` e nunca foi commitado
- [ ] `docker-compose.yml` não expõe porta 3000 para `0.0.0.0` (atualmente `127.0.0.1:3000:3000` ✅)

---

## 📊 Estimativa de Lucratividade

Baseado na arquitetura atual e no comportamento típico de memecoins Uniswap V2:

**Premissas:**
- Trade size: 0.05 ETH
- Win rate esperada (multi-tier + filtros): 25-35%
- Take-profit médio: +100%
- Stop-loss médio: -50%
- Slippage + gas: ~2-5% por trade
- Trades por dia: 20-50 (depende do volume de lançamentos na Robinhood Chain)

**Cenário conservador (paper trading realista):**
- 20 trades/dia × 0.05 ETH = 1 ETH volume diário
- 30% win rate: 6 wins × 0.05 ETH profit = +0.30 ETH
- 70% loss rate: 14 losses × 0.025 ETH loss = -0.35 ETH
- **Resultado:** -0.05 ETH/dia → ESTRATÉGIA NÃO LUCRATIVA com estes parâmetros

**Cenário otimista (após otimizações):**
- 30 trades/dia × 0.05 ETH = 1.5 ETH volume diário
- 35% win rate com average win de +200% (ATH explosion): 10.5 wins
- Wins: 10.5 × 0.10 ETH avg profit = +1.05 ETH
- Losses: 19.5 × 0.025 ETH avg loss = -0.49 ETH
- **Resultado:** +0.56 ETH/dia

⚠️ **IMPORTANTE:** Estas são estimativas TEÓRICAS. Só paper trading real com dados da Robinhood Chain pode validar se a estratégia é lucrativa ou não. É perfeitamente possível que a Robinhood Chain tenha volume baixo, poucos lançamentos, ou padrões diferentes de outras chains.

---

## 🏁 Conclusão

**O bot está ~70% pronto para produção.** O código do pipeline core (listener → parser → detector → risk engine → strategy → executor → position manager) está sólido, bem arquitetado, e funcional. A migração de Solana para Robinhood Chain foi bem executada no código.

**Os 30% restantes são críticos para o sucesso:**
1. **Segurança** (credenciais, wallet, MEV) — sem isso, dinheiro some
2. **Testes** — sem isso, bugs vão custar caro
3. **Observabilidade** — sem isso, você não sabe o que está acontecendo
4. **Otimizações de latência** — sem WebSocket, bots mais rápidos ganham

**Recomendação final:** Siga o roteiro de 3 semanas. Não pule etapas. Paper trade por pelo menos 1-2 semanas antes de colocar 1 centavo real. Comece com tamanhos mínimos e escale gradualmente. Memecoins são ativos de altíssimo risco — a maioria vai a zero. A estratégia depende de alguns winners grandes cobrirem muitos losers pequenos. Se a Robinhood Chain não tiver volume suficiente de lançamentos de qualidade, a estratégia pode não ser lucrativa independentemente da qualidade do código.
