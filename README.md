# funding-arb
# FundingArb — Delta Neutral Funding Rate Arbitrage
Delta Exchange India + Pi42 | Lightweight | Manual Refresh | Railway Backend

---

## FILE STRUCTURE (what goes where on GitHub)

```
funding-arb/                  <-- root of your GitHub repo
├── server.js                 <-- backend (Node.js, runs on Railway)
├── package.json              <-- Node dependencies
├── railway.json              <-- Railway deployment config
├── .gitignore                <-- ignore node_modules and .env
└── public/
    └── index.html            <-- full frontend (served by Express)
```

---

## STEP 1 — CREATE GITHUB REPO (from mobile browser)

1. Open github.com on your phone browser
2. Tap the + icon at top right → "New repository"
3. Name it: funding-arb
4. Set to Public (Railway free tier needs this)
5. Tap "Create repository"
6. Now tap "creating a new file" link on the empty repo page

### Upload each file:
For each file below, tap "Add file" → "Create new file"

File 1: server.js
- Name field: server.js
- Paste the server.js content
- Tap "Commit new file"

File 2: package.json
- Name field: package.json
- Paste the package.json content
- Tap "Commit new file"

File 3: railway.json
- Name field: railway.json
- Paste the railway.json content
- Tap "Commit new file"

File 4: .gitignore
- Name field: .gitignore
- Paste the .gitignore content
- Tap "Commit new file"

File 5: public/index.html (the frontend)
- Name field: public/index.html  <-- TYPE EXACTLY THIS with the slash
- GitHub will auto-create the public/ folder
- Paste the index.html content
- Tap "Commit new file"

Your repo should look like this:
```
funding-arb/
  .gitignore
  package.json
  railway.json
  server.js
  public/
    index.html
```

---

## STEP 2 — DEPLOY TO RAILWAY (free tier)

1. Go to railway.app on your phone
2. Sign up with your GitHub account (use "Login with GitHub")
3. After login, tap "New Project"
4. Select "Deploy from GitHub repo"
5. Connect your GitHub account if asked
6. Select your "funding-arb" repository
7. Railway will auto-detect Node.js and start deploying

### Set Environment Variables on Railway:
1. In your Railway project, tap your service (the box)
2. Tap "Variables" tab
3. Add this variable:
   - Key: PORT
   - Value: 3000
4. Tap "Add"
5. Railway will redeploy automatically

### Get Your Backend URL:
1. In Railway, tap your service
2. Tap "Settings" tab
3. Scroll to "Networking" section
4. Tap "Generate Domain"
5. Railway gives you a URL like: https://funding-arb-production.up.railway.app
6. COPY THIS URL — you will paste it in the app's Settings panel

---

## STEP 3 — USE THE APP

1. Open your Railway URL in any browser: https://your-app.up.railway.app
2. Tap "Settings" button at top right
3. Paste your Railway URL in the "Railway Backend URL" field
4. Tap "Test Connection" — should show "Connected"
5. Enter your Delta Exchange India API Key and Secret
6. Enter your Pi42 API Key and Secret
7. Tap "Save All Settings"
8. Go back to "Opportunities" tab
9. Tap "Refresh Data" — both exchanges are scanned

---

## STEP 4 — GET API KEYS

### Delta Exchange India:
1. Login to india.delta.exchange
2. Go to Account → API Keys
3. Create new key with "Read + Trade" permissions
4. Copy Key and Secret

### Pi42:
1. Login to pi42.com
2. Go to Profile → API Management
3. Create new API key
4. Copy Key and Secret

---

## HOW THE ARBITRAGE LOGIC WORKS

### Scenario A — Both Funding Rates Negative
Exchange A: -0.30%, Exchange B: -0.13%
Action: SHORT Exchange B (higher/less negative), LONG Exchange A (lower/more negative)
You collect: the difference 0.17% per funding period

### Scenario B — Both Funding Rates Positive  
Exchange A: +0.15%, Exchange B: +0.08%
Action: SHORT Exchange A (higher positive), LONG Exchange B (lower positive)
You collect: the difference 0.07% per funding period

### Scenario C — One Positive, One Negative (GOLDMINE)
Exchange A: +0.20% (positive), Exchange B: -0.15% (negative)
Action: SHORT Exchange A (they pay you to be short) + LONG Exchange B (they pay you to be long)
You collect: 0.20% + 0.15% = 0.35% from BOTH sides simultaneously

### Fees Deducted:
The "Net Yield" column already deducts 0.10% (0.05% taker fee per side)
Any row where Net Yield > 0 is theoretically profitable

---

## FUNDING INDICATOR (top right of app)

- FA logo with a small dot next to it
- RED dot = funding settlement is NOT coming soon (more than 10 minutes away)
- GREEN dot = funding settlement within 10 minutes — your positions will earn soon
- The timer shows HH:MM:SS until next funding (8-hour cycle: 00:00, 08:00, 16:00 UTC)

---

## TABLE COLUMNS EXPLAINED

| Column      | Meaning |
|-------------|---------|
| Coin        | Base asset symbol |
| Delta Fund% | Current funding rate on Delta Exchange |
| Pi42 Fund%  | Current funding rate on Pi42 |
| Diff%       | Absolute difference between the two rates |
| Yield(net)  | Diff% minus 0.10% fees |
| Spread%     | Price difference between both exchanges |
| Delta Price | Mark price on Delta |
| Pi42 Price  | Mark price on Pi42 |
| D 24h%      | 24-hour price change on Delta |
| Volume      | Max volume across both exchanges |
| Action      | L = Long exchange, S = Short exchange |
| Scenario    | GOLDMINE / +/+ / -/- |

GOLDMINE rows have a gold left border — highest priority

---

## PLACING ORDERS

1. Click/tap any row in the table
2. A panel slides up showing:
   - Exact funding rates and net yield
   - Which exchange to LONG and which to SHORT
   - Strategy explanation
3. Enter Quantity (number of contracts) and Leverage
4. Choose Market or Limit order type
5. Tap "Execute Both Orders Simultaneously"
   - This fires both API calls at the same time
   - Results show below with order IDs
6. To close: tap "Exit Both Positions" (sends reduce-only market orders)

---

## UPDATING CODE AFTER DEPLOYMENT

If you want to update any file:
1. Go to your GitHub repo
2. Tap the file you want to edit
3. Tap the pencil icon (Edit)
4. Make your changes
5. Tap "Commit changes"
6. Railway auto-detects the GitHub push and redeploys in ~2 minutes

---

## TROUBLESHOOTING

Problem: "Backend not reachable"
Fix: Make sure Railway deployment is successful (no red errors in Railway logs)
     Double-check you pasted the correct Railway URL (include https://)

Problem: Scan returns 0 pairs
Fix: Delta/Pi42 may have changed their public API endpoint paths
     Check Railway logs for the actual error message

Problem: Orders fail
Fix: Check API key permissions (need "Futures Trading" enabled)
     Check if your account has margin/balance on both exchanges

Problem: Railway free tier sleeps
Fix: Railway free tier does not sleep for web services — it stays on
     You only have a monthly usage limit (500 hours free)

---

## IMPORTANT NOTES

1. This system does NOT auto-trade. All actions are manual.
2. "Refresh Data" only fetches when YOU tap it — saves Railway compute credits.
3. Delta-neutral means equal USDT value on both legs, not equal quantity.
4. Always verify orders placed in both exchange apps before assuming fill.
5. Pi42 uses INR, Delta uses USDT — factor in conversion when sizing positions.
6. This is for educational use. Futures trading carries high risk.
