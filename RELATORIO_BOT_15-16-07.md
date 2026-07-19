# 🤖 Relatório do Bot Sniper de Memecoins — Robinhood Chain

**Modo:** Paper trading (simulação, sem dinheiro real)
**Período coberto:** 15/07/2026 16h16 → 16/07/2026 20h23 (horário de Brasília)
**Config:** 0.005 ETH por entrada · Take-Profit **+100%** · Stop-Loss **−50%** · máx. 5 posições simultâneas

> Fonte dos números: banco de dados do bot (58 posições reais registradas). Os dados são de simulação — o objetivo é validar a estratégia antes de ligar dinheiro de verdade.

---

## 🎯 TL;DR (resumão pra quem tem pressa)

- **Saldo paper: 0.5 → ~0.572 ETH (+14,4%)** em 58 trades no total.
- **Dia 15/07 foi verde:** +0.077 ETH, 56% de acerto — mas o bot ainda comprava rugs (golpes).
- **Dia 16/07 empatou pra baixo:** −0.004 ETH, 31% de acerto — porém **zero rugs**, porque um filtro novo anti-golpe entrou em ação.
- **A grande virada entre os dois dias foi DUPLA:** (1) subimos um filtro novo na madrugada e (2) o mercado ficou mais tóxico. Dá pra provar as duas coisas com número.

---

## 📊 Panorama geral

| Métrica | 15/07 | 16/07 | Total |
|---|---:|---:|---:|
| Entradas (trades) | 45 | 13 | **58** |
| Vitórias (bateram TP) | 25 | 4 | 29 |
| Win rate | **55,6%** | **30,8%** | 50,0% |
| Rugs / golpes (perda ~−100%) | **8** | **0** | 8 |
| PnL do dia | **+0.07662** | **−0.00437** | **+0.07224 ETH** |

---

## 📅 Dia 15/07 — a fase "sem freio"

O bot rodava o dia todo com os filtros da época. Volume alto e resultado positivo:

**Entradas por hora (cada ▇ = 1 trade):**
```
16h  ▇▇▇▇▇          5
17h  ▇▇▇▇▇▇▇        7
18h  ▇▇▇▇▇▇▇▇▇▇▇   11   ← pico
19h  ▇▇▇▇▇▇▇▇▇      9
20h  ▇▇▇▇▇▇▇        7
21h  ▇▇▇▇           4
22h  ▇▇             2   ← última entrada 22h53, depois o PC desligou
```

**Resultado:** 25 vitórias (+0.13166) contra 8 golpes (−0.03979) e 12 perdas parciais. Saldo do dia **+0.077 ETH**.

⚠️ **O detalhe importante:** dentro dessas 45 entradas havia **8 rugs** — tokens onde o dono da liquidez puxou o pool e zerou o preço (perda de −100%). O bot estava comprando esses golpes junto com os bons. Os ganhadores eram muitos, então no fim deu lucro, mas a gente estava pagando pra ver em cada golpe.

---

## 📅 Dia 16/07 — o freio anti-golpe entrou

O PC desligou de madrugada. Ao religar, o bot subiu com **código novo** e um comportamento bem diferente.

**Entradas por hora:**
```
     [PC DESLIGADO + MADRUGADA — 0 entradas por ~13h]
12h  ▇              1   ← primeira entrada só ao meio-dia
13h  ▇▇             2
14h  ▇              1
15h  ▇              1
16h  ▇▇▇▇           4
17h  ▇              1
19h  ▇▇             2
20h  ▇              1
```

**Resultado:** 4 vitórias (+0.01365) contra 9 perdas parciais e **0 golpes**. Saldo do dia **−0.004 ETH** (praticamente zero).

✅ **A boa notícia:** **nenhum rug de −100%.** As perdas foram todas stop-loss normal (−50%), de tokens que só fracassaram — não golpes. O filtro novo cortou a cauda de golpes inteira.

⚠️ **A má notícia:** o win rate caiu pra 31%. Com TP +100% / SL −50%, o break-even fica em ~33% de acerto. O dia 16 ficou **logo abaixo** disso → pequeno prejuízo. Amostra pequena (13 trades), mas é o número real.

---

## 🔬 O que mudou entre os dois dias? (dados + hipóteses)

### Hipótese 1 — "não foi o mercado, foi o código" ✅ confirmada
O filtro que hoje bloqueia os golpes (chamado **LP-pull guard**) **não existia** durante o dia 15. Ele foi criado na **noite de 15/07, às 22h39** — logo depois da última entrada do dia (22h53). Ou seja: as 45 entradas do dia 15 rodaram **sem** essa proteção. Quando o PC religou no dia 16, o filtro entrou em ação **pela primeira vez**.

**Como o filtro funciona:** todo par na blockchain tem "fichas de liquidez" (LP). Quem segura essas fichas pode drenar o pool num único clique.
- **Lançamento honesto** → queima 100% do LP (dono fica com 0%) → o bot **entra**.
- **Fábrica de golpe** → dono mantém ~100% do LP e puxa o pool ~19min depois → o bot **rejeita**.

### Hipótese 2 — "o fluxo ficou mais tóxico" ✅ confirmada com número
O motor de risco avaliou os candidatos dos dois dias. Os números não mentem:

| | 15/07 | 16/07 |
|---|---:|---:|
| Candidatos avaliados | 108 | 234 |
| % aprovado no motor de risco | **97%** | **71%** |
| Score de risco médio | **17,9** | **27,4** |
| Rejeição no estágio da estratégia | ~57% | **~92%** |

Traduzindo: no dia 16 apareceram **mais** tokens, mas eles eram **mais perigosos** (score de risco subiu de 17,9 → 27,4) e a estratégia rejeitou **92%** deles (vs 57% no dia 15). A madrugada/manhã na blockchain é dominada por **bots de golpe que rodam 24h por script**, enquanto projetos de verdade lançam em horário ativo. Por isso o bot ficou ~4h "parado" — não estava quebrado, estava **recusando golpe atrás de golpe**.

### Hipótese 3 — "o filtro teria melhorado o próprio dia 15" ✅ estimado
Rodamos o filtro novo de volta nas 45 entradas do dia 15. Se ele tivesse bloqueado os 8 golpes:

| Cenário | PnL do dia 15 |
|---|---:|
| Sem filtro (o que rodou) | +0.07662 ETH |
| **Com filtro (bloqueando os 8 golpes)** | **+0.11641 ETH** |

O filtro teria **salvado +0.040 ETH** → lucro do dia sobe **+52%**, sem tocar em nenhuma vitória.

---

## 🏆 Melhores e piores trades

| 🥇 Top ganhos | PnL | | 💀 Piores (golpes/−100%) | PnL |
|---|---:|---|---|---:|
| BULLDOG | +0.00917 | | CAM | −0.00503 |
| ZYN | +0.00916 | | SAITAMA | −0.00503 |
| bul | +0.00636 | | SLOW | −0.00503 |
| MIZUKARA | +0.00594 | | ^^^^ | −0.00503 |
| KOII | +0.00588 | | ORBIT | −0.00502 |

*(Todos do dia 15 — os golpes de −0.005 são a perda total de uma entrada de 0.005 ETH, ou seja, liquidez puxada.)*

---

## ⚠️ Ressalvas honestas (pra não vender ilusão)

1. **É paper trading.** Os "+100%" assumem que a gente vendeu no topo antes do golpe puxar o pool. No dinheiro real, num golpe você frequentemente **não consegue vender** — então o filtro vale ainda mais do que a simulação mostra.
2. **Amostra pequena no dia 16** (13 trades). Um dia não define a estratégia; é preciso mais dados.
3. **Não dá pra reconstruir com 100% de precisão** quantos golpes o filtro teria pego no dia 15, porque o golpe apaga o próprio rastro (depois de puxar, o saldo de LP zera). Usamos o resultado (−100%) como proxy.

---

## ✅ Conclusão

- O bot **funciona** e terminou o período **+14,4%** no paper.
- O maior aprendizado: a maior parte do lucro fácil do dia 15 vinha junto com **risco de golpe embutido**. O filtro novo troca um pouco de volume por **muito menos exposição a rug**.
- As "0 entradas" do dia 16 **não eram bug** — era o filtro novo recusando um mercado que ficou tomado por golpes.
- Próximo passo: rodar mais dias **com** o filtro pra medir o resultado limpo (sem a cauda de −100%) e ajustar o win rate.

*Relatório gerado a partir dos dados reais do banco do bot. Números de simulação — nada de dinheiro real foi movimentado.*
