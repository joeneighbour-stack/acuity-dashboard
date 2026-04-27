# Acuity Trading Dashboard - Deployment Guide

## Quick Start (5 minutes)

### Prerequisites
- [Heroku CLI](https://devcenter.heroku.com/articles/heroku-cli) installed
- [Git](https://git-scm.com/) installed
- Heroku account (you have this)

### Step 1: Unzip and initialise
```bash
unzip acuity-dashboard.zip
cd acuity-dashboard
git init
git add .
git commit -m "Initial deploy"
```

### Step 2: Create Heroku app
```bash
heroku login
heroku create acuity-dashboard    # or your preferred name
```

### Step 3: Set environment variables
```bash
heroku config:set SESSION_SECRET="pick-a-long-random-string-here"
heroku config:set ADMIN_PASSWORD="your-admin-password"
heroku config:set NODE_ENV="production"
```

### Step 4: Deploy
```bash
git push heroku main
```

### Step 5: Open and login
```bash
heroku open
```
Login with username `admin` and the password you set in Step 3.

---

## User Accounts

### Default accounts created on first start

| Username | Password | Role | Sees |
|----------|----------|------|------|
| admin | (set via ADMIN_PASSWORD env var) | Admin | Full dashboard |
| ian.coleman | Acuity_Ian2026! | Analyst | Own stats + overview (no analyst names) |
| khaled.gad | Acuity_Khaled2026! | Analyst | Own stats + overview (no analyst names) |
| maged.darwish | Acuity_Maged2026! | Analyst | Own stats + overview (no analyst names) |
| mona.hassan | Acuity_Mona2026! | Analyst | Own stats + overview (no analyst names) |
| tibor.vrbovsky | Acuity_Tibor2026! | Analyst | Own stats + overview (no analyst names) |

To override any analyst password via env var, set `PW_IAN`, `PW_KG`, `PW_MAG`, `PW_MOH`, or `PW_TIV` before first start.

### Managing users after deployment

**Option A: Interactive CLI**
```bash
heroku run node setup-admin.js
```

**Option B: Change passwords via env vars**
```bash
heroku config:set ADMIN_PASSWORD="new-password"
heroku restart
```

---

## What each role sees

### Admin (you)
- Full dashboard: Overview, Analysts, KPIs, Monitor, Schedule, Trades
- CSV upload and override system
- All analyst data visible

### Analysts
- Overview: Monthly P&L grid, equity curve, asset class leaderboard (NO analyst leaderboard)
- My Stats: Only their own analyst drill-down
- My KPI: Only their own KPI card
- My Monitor: Only their own trades, equity, recent trades
- No access to: Schedule, Trades/CSV upload, other analysts' data, overrides

---

## Updating data

1. Login as admin
2. Go to the Trades tab
3. Upload your CSV as before
4. The system detects the month from the CSV and updates accordingly

---

## Troubleshooting

**App crashes on start:**
```bash
heroku logs --tail
```

**Reset database:**
```bash
heroku run rm data/app.db
heroku restart
```
Users will be recreated from env vars on restart.

**Custom domain:**
```bash
heroku domains:add dashboard.yourdomain.com
```
Then add a CNAME record pointing to your Heroku app URL.
