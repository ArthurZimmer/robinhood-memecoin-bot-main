# Deploy — VPS (Ubuntu 22.04, Docker)

Runs the whole stack — Postgres, Redis and the bot — with one `docker compose up`.
The bot container builds the TypeScript, applies DB migrations, then starts.

---

## 1. Install Docker on the VPS

```bash
# Docker Engine + compose plugin (official convenience script)
curl -fsSL https://get.docker.com | sh

# Run docker without sudo (log out/in afterwards for it to take effect)
sudo usermod -aG docker "$USER"

docker --version && docker compose version
```

## 2. Get the code onto the VPS

The repo is **private**, so the VPS needs read access. Easiest: a GitHub **deploy key**.

```bash
# On the VPS — generate a key with no passphrase
ssh-keygen -t ed25519 -C "vps-deploy" -f ~/.ssh/id_ed25519 -N ""
cat ~/.ssh/id_ed25519.pub
```

Add that public key at **GitHub → repo → Settings → Deploy keys → Add deploy key** (read-only is enough). Then:

```bash
git clone git@github.com:lhenzzzz/solana-memecoin-bot.git
cd solana-memecoin-bot
```

## 3. Create the `.env` (starts in PAPER mode)

`.env` is **not** in the repo. Create it from the template:

```bash
cp .env.example .env
nano .env
chmod 600 .env
```

Fill in at minimum:

| Var | Value |
|---|---|
| `TRADING_MODE` | `paper` (validate first — switch to `real` later) |
| `ROBBINHOOD_RPC_URL` | your Robinhood Chain RPC endpoint |
| `ROBBINHOOD_WS_URL` | (optional) Robinhood Chain WebSocket endpoint |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | **must be non-empty** — leave the placeholders; Telegram isn't wired yet, but the config validator rejects empty values |
| `WALLET_PRIVATE_KEY` | only required when `TRADING_MODE=real` |

> **Do not** change `DATABASE_URL` / `REDIS_URL` for Docker — the compose file overrides them to the internal service names (`postgres`, `redis`) automatically. The `localhost` values in `.env` are only for running the bot outside Docker.

## 4. Launch

```bash
docker compose up -d --build
```

This starts `postgres`, `redis` and `bot` (migrations run automatically on the bot's first boot).

## 5. Watch it

```bash
docker compose ps                 # health of all 3 services
docker compose logs -f bot        # live bot logs
```

Look for `Bot initialized — pipeline running` and, in paper mode, `BUY_EXECUTED` / `PAPER SELL filled` lines as launches come through.

## 6. Open the dashboard (safely)

Port 3000 is bound to **localhost only** on the VPS — it is not reachable from the internet. Tunnel to it from your laptop:

```bash
ssh -L 3000:localhost:3000 <user>@<vps-ip>
# then open http://localhost:3000 in your browser
```

## 7. Switch to REAL mode (after validating paper)

```bash
nano .env
#   TRADING_MODE=real
#   WALLET_PRIVATE_KEY=<dedicated throwaway wallet 0x hex key>
#   TRADE_SIZE_NATIVE=0.01      # start tiny
#   MAX_OPEN_POSITIONS=1
#   DAILY_LOSS_LIMIT_NATIVE=0.02

docker compose up -d            # recreates the bot with the new env (no rebuild needed)
```

Fund the wallet with only what you can lose. See [REAL_MODE.md](./REAL_MODE.md) for the hardening checklist.

## 8. Everyday ops

```bash
# Update to the latest code
git pull && docker compose up -d --build

# Stop everything (keeps DB/Redis data in volumes)
docker compose down

# Restart just the bot
docker compose restart bot

# Wipe streams + trade tables between test runs
npm run dev:reset               # requires the containers to be running

# Force-close stale positions
docker compose exec bot npm run cleanup:stale
```

## Notes

- **Data persists** in the `postgres_data` / `redis_data` volumes across restarts. `docker compose down -v` wipes them (fresh start).
- The bot needs outbound internet (PumpPortal WSS, Robinhood RPC, CoinGecko) — allow it in the VPS firewall. Only inbound SSH (22) needs to be open; do **not** open 3000.
- Logs are JSON (Pino). Pipe through `docker compose logs -f bot` and, if you want them pretty, run locally with `npm run dev` which uses `pino-pretty`.
