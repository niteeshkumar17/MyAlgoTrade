# AegisQuant — Self-Learning Indian NSE F&O Paper-Trading Options Bot & Monorepo

> **MANDATORY HONESTY & SEBI F&O RISK DISCLOSURE (PAPER TRADING ONLY)**
> - **This system is strictly for PAPER TRADING on Indian NSE F&O (`NIFTY`, `BANKNIFTY`, `FINNIFTY`, and liquid Stock Options).** There is no live order-execution code path anywhere in this repository, and the bot refuses to start if `PAPER_TRADING_ONLY` is disabled or pointed at any live brokerage endpoint.
> - **Never assume this bot will be profitable.** Official SEBI studies on Indian equity F&O traders show that **~9 out of 10 individual F&O traders in India incur net losses** after accounting for bid-ask spreads, Securities Transaction Tax (STT), NSE exchange turnover charges, SEBI fees, GST, and brokerage. Paper-trading results almost always overstate live results because paper fills do not move the order book or suffer adverse selection.

---

## Go / No-Go Checklist Before Anyone Ever Considers Real Money

Do **not** consider building a live execution adapter unless **every single criterion below** is satisfied in unbroken out-of-sample NSE paper trading:

- [ ] **Minimum Sample Size:** `>= 200` closed NSE paper trades logged in the `trades` table.
- [ ] **Minimum Calendar Duration:** `>= 8 to 12 weeks` of continuous forward operation across weekly and monthly NSE expiries.
- [ ] **Positive Conservative Expectancy:** Expectancy `> ₹0 / trade` on the **Conservative Simulation** curve (`mid ± 35% of bid-ask spread` + `₹35/lot` per leg statutory & brokerage charges)—not the optimistic broker mid/LTP fill curve.
- [ ] **Profit Factor:** Conservative Profit Factor `> 1.30`.
- [ ] **Drawdown Compliance:** Maximum peak-to-trough drawdown strictly `< 10.0%` (`< ₹1,00,000` on `₹10,00,000` virtual capital) with zero unhandled reconciliation mismatches.
- [ ] **Multi-Regime Robustness:** Positive conservative expectancy demonstrated across **at least two distinct Indian market regimes** (e.g., `trending_up` and `range` or `high_volatility` when `INDIA VIX >= 20`).

---

## Indian Market Configuration (`config.yaml`)

- **Exchange & Hours:** NSE India (`09:15 IST – 15:30 IST`, `Asia/Kolkata`, `XBOM` calendar skipping Indian market holidays via `pandas_market_calendars`). Intraday flatten window runs at `15:15 IST` (15 minutes before the `15:30 IST` close).
- **Universe & NSE Lot Sizes:**
  - **Index Options:** `NIFTY` (Lot: `75`), `BANKNIFTY` (Lot: `30`), `FINNIFTY` (Lot: `65`)
  - **Liquid Stock Options:** `RELIANCE` (Lot: `500`), `TCS` (Lot: `175`), `HDFCBANK` (Lot: `550`), `INFY` (Lot: `400`), `ICICIBANK` (Lot: `700`), `SBIN` (Lot: `750`)
- **Benchmarks:** `NIFTY 50` Buy-and-Hold (`NIFTY_BENCHMARK`) and **`INDIA VIX`** (`^INDIAVIX`).
- **Contract Nomenclature:** NSE standard `CE` (Call European) and `PE` (Put European), e.g., `NIFTY26NOV24500CE`, `BANKNIFTY26NOV52000PE`.
- **Starting Paper Capital:** `₹10,00,000` (`₹10 Lakhs` virtual capital).
- **Pessimistic Fill & Statutory Cost Model:**
  - Buy at `mid + 35% of bid-ask spread`, Sell at `mid - 35% of spread`.
  - Plus **`₹35 per lot per leg`** (`₹20` flat discount brokerage + `~₹15/lot` covering STT on options sell, NSE exchange turnover charges, Stamp Duty, SEBI fees, and 18% GST).

---

## Step-by-Step Deployment Guide (Oracle Cloud Mumbai/Hyderabad VM + Neon + Vercel)

### Step A: Configure Indian NSE Paper Sandbox & Optional Free Market Feed
1. The bot runs out of the box using the built-in **NSE Paper Sandbox (`https://paper-sandbox.nseindia-sim.local`)** and free NSE indicative option-chain quotes (`₹0/month`).
2. *(Optional)* If you have a free read-only market-data API key from **Dhan**, **AngelOne SmartAPI**, or **Flattrade**, you can paste `NSE_DATA_API_KEY` into `/etc/aegis-bot/bot.env` solely for fetching option chain quotes. **Never enable live order permissions.**

### Step B: Create the Free Hosted Postgres Database (Neon Mumbai/Singapore or Supabase)
1. Create a free project on **Neon** (select `ap-southeast-1` Singapore or Mumbai region for low latency to India) or **Supabase**.
2. Open the SQL Editor and run `deploy/migrations/001_initial_schema.sql` to create all 12 tables and indexes.
3. Edit `deploy/migrations/002_roles_and_permissions.sql` with strong passwords for `bot_rw` and `web_ro`, then execute it:
   - `bot_rw`: Full R/W access used **only** by the Oracle Cloud VM.
   - `web_ro`: `SELECT` on all tables + `UPDATE (new_entries_enabled, updated_at, updated_by)` on `control` (`id=1`) **only** (used by Vercel).

### Step C: Provision & Harden the Oracle Cloud Always Free VM (Mumbai or Hyderabad Region)
1. In Oracle Cloud Infrastructure (OCI), create an Ubuntu 22.04/24.04 instance in **Mumbai (`ap-mumbai-1`)** or **Hyderabad (`ap-hyderabad-1`)**.
2. **Shape:** Choose `VM.Standard.A1.Flex` (Ampere ARM64) or fallback `VM.Standard.E2.1.Micro` (AMD 1 GB RAM). Our `deploy/install.sh` automatically creates a **2 GB `/swapfile`** and caps memory under `380 MB`.
3. **Security List:** Allow inbound **TCP Port 22 (SSH) ONLY**. Open zero other inbound ports.
4. SSH into your VM and run:
   ```bash
   git clone https://github.com/YOUR_USERNAME/aegis-options-bot.git
   sudo bash aegis-options-bot/deploy/install.sh
   sudo nano /etc/aegis-bot/bot.env
   sudo chmod 600 /etc/aegis-bot/bot.env
   ```

### Step D: Push `/web` to GitHub and Deploy on Vercel
1. Import the repo into Vercel with **Root Directory** = `web`.
2. Add environment variables: `DATABASE_URL_WEB_RO` (pooled `-pooler` connection string using `web_ro`), `CONTROL_PAUSE_SECRET`, and optional `DASHBOARD_PASSCODE`.
3. Click **Deploy**.

### Step E & F: Dry Run, Start Service & Verify Offline Banner
1. Run a single NSE dry-run cycle on the VM:
   ```bash
   sudo -u aegisbot /opt/aegis-options-bot/bot/.venv/bin/python -m src.main --dry-run-once
   ```
2. Start the systemd service:
   ```bash
   sudo systemctl enable --now aegis-options-bot
   sudo journalctl -u aegis-options-bot -f
   ```
3. Verify on your Vercel dashboard that heartbeats appear in **IST (`Asia/Kolkata`)**, test trades log in `₹` INR with lot sizes (`75` for `NIFTY`, `30` for `BANKNIFTY`), and stopping the service triggers the red **`BOT OFFLINE`** banner when the heartbeat exceeds 10 minutes during `09:15–15:30 IST`.
