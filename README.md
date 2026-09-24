# DJN Paper Trader 🚀
### Telegram Memecoin Paper Trading Bot & Deterministic Practice Simulator

A complete, production-ready Telegram paper trading bot for memecoin markets on **Solana, Base, Ethereum, and BNB Chain**, built with **grammY**, **Google Cloud Firestore**, **DEX Screener**, and **sharp**.

---

## 🛑 1. Core Principles & Boundaries
- **Simulated Funds Only**: All balances, fills, and profits are strictly virtual practice credits ($1,000.00 virtual USD initial allocation).
- **Zero Real Blockchain Interaction**: Absolutely no wallet connections, private key generation, deposits, withdrawals, swaps, or blockchain transaction signing.
- **Real Market Feeds**: Prices, volumes, market caps, FDVs, and liquidity are fetched in real-time from DEX Screener without simulated artificial prices.
- **Deterministic Decimal Accounting**: All calculations use `decimal.js` to eliminate IEEE-754 binary floating-point errors.

---

## 🏛️ 2. Architecture Overview
- **Telegram Bot Framework**: `grammY` using webhook ingress (`POST /api/telegram/webhook`) with `X-Telegram-Bot-Api-Secret-Token` validation.
- **Persistence Layer**: Google Cloud Firestore with acid transactions and an in-memory transactional mock fallback for testing and offline development.
- **DEX Screener Integration**: Resilient HTTP adapter with 8-second query cache, in-flight deduplication, rate limit backoff, and safe URL parsing.
- **P&L Card Generation**: Programmatic 1200x675 SVG-to-PNG renderer using `sharp` with Pepe, Doge, and Chad meme illustrations.
- **Web Console & Simulator**: Vite + React 19 + Tailwind CSS interactive console for inspecting token quotes, testing paper trades, and checking server health.

---

## 📋 3. BotFather Setup & Bot Commands

### Step 1: Create Bot with @BotFather
1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`.
3. Provide a display name: `DJN Paper Trader`.
4. Provide a username ending in `_bot` (e.g. `djn_paper_trader_bot`).
5. Save your HTTP API Token securely.

### Step 2: Configure Bot Description & About Text in BotFather
- `/setdescription`:
  ```
  Practise memecoin trading on Solana, Base, Ethereum, and BSC with real market prices and $1,000 in virtual funds. No wallet. No deposits. Zero risk.
  ```
- `/setabouttext`:
  ```
  DJN Paper Trader — Real market data, virtual money. Manual practice tool with shareable 1200x675 P&L cards.
  ```

### Step 3: Register Bot Commands in BotFather
Send `/setcommands` to `@BotFather` and paste:
```text
start - Initialize account and verify $1,000 practice funds
buy - Look up a token contract address and buy
positions - View open positions and manage sells
balance - Check virtual cash and marked equity
history - View recent trade fills
performance - Win rate, total P&L, and trade metrics
settings - Toggle fees/slippage, change theme, or reset
help - How-to guide and documentation
```

---

## ⚙️ 4. Environment Configuration

Define the following environment variables (see `.env.example`):

| Variable | Description |
| :--- | :--- |
| `TELEGRAM_BOT_TOKEN` | HTTP API token from @BotFather |
| `TELEGRAM_WEBHOOK_SECRET` | Secret token string validated via `X-Telegram-Bot-Api-Secret-Token` |
| `PUBLIC_BASE_URL` | Public HTTPS domain of your service (e.g. `https://my-bot.a.run.app`) |
| `ADMIN_SECRET_KEY` | Key to access administrative endpoints (`POST /api/admin/*`) |
| `GCP_PROJECT_ID` | (Optional) GCP Project ID for Google Cloud Firestore |
| `FIRESTORE_DATABASE_ID` | (Optional) Firestore database name (defaults to `(default)`) |
| `QUOTE_EXPIRY_MS` | Quote TTL in milliseconds (defaults to `30000`) |
| `PRICE_DEVIATION_THRESHOLD_PCT` | Maximum price movement before aborting order (defaults to `5.0`) |

---

## 🚀 5. Deployment Guide

### Deploying to Google Cloud Run
1. Ensure your GCP project has Cloud Run and Firestore enabled:
   ```bash
   gcloud services enable run.googleapis.com firestore.googleapis.com
   ```
2. Build and deploy container:
   ```bash
   gcloud run deploy djn-paper-trader \
     --source . \
     --region us-central1 \
     --platform managed \
     --allow-unauthenticated \
     --set-env-vars TELEGRAM_BOT_TOKEN="your_token",TELEGRAM_WEBHOOK_SECRET="your_secret",PUBLIC_BASE_URL="https://djn-paper-trader-xxxx.a.run.app",ADMIN_SECRET_KEY="your_admin_key"
   ```
3. Register the Telegram Webhook:
   ```bash
   curl -X POST "https://djn-paper-trader-xxxx.a.run.app/api/admin/set-webhook" \
     -H "Content-Type: application/json" \
     -H "x-admin-key: your_admin_key"
   ```

---

## 🧪 6. Testing

Run the automated test suite with:
```bash
npm test
```
All 10 test suites test:
- Single-credit initial balance ($1,000 virtual USD).
- Exact Section 12 zero-cost accounting calculation.
- Weighted-average cost basis on multiple buys.
- Full & partial sells with adverse slippage and fees.
- Idempotency & double-clicked confirmation protection.
- Unauthorized user isolation.
- SVG/PNG card generation with sharp.
