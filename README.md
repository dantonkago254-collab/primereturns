# PrimeReturns

A production-ready high-yield investment referral platform built for the Kenyan market.

**Stack:** React + Vite + Tailwind (Wouter routing) + Node.js Express + Paystack (M-Pesa / cards) + MySQL (Drizzle ORM) → deployed on Railway.

---

## Live Features

*   🚀 React SPA with animated landing page and Kenyan testimonials
*   🔐 Login / Registration with localStorage referral-code capture (`/ref/:XXXXXXXX`)
*   📊 User dashboard with backend-sourced balance, investments, transactions, and referrals
*   🎯 Backend cron engine for scheduled daily returns
*   💸 Paystack hosted checkout integration for KES deposits
*   📝 Express backend (`server.cjs`) with auth, dashboard, Paystack, withdrawal, admin, and cron APIs
*   🤝 3-Tier Referral Commission Engine (10% / 5% / 2%) wired in `src/server/api/auth.ts`
*   🧱 Drizzle-ORM MySQL schemas in `src/server/db/schema.ts`
*   🛡️ Withdrawal gate — enforces "at least 1 active referral" rule

---

## Local Development

```bash
npm install
npm run dev
```

Then open http://localhost:5173

---

## Production Build

```bash
npm run build       # produces dist/
npm start           # starts Express server (server.cjs) on port 3000
```

The Express server (`server.cjs`):
*   Serves `dist/` as static files
*   SPA fallback — every unmatched GET (except `/api/*`) returns `index.html`
*   Exposes `/api/health`, `/api/paystack/webhook`, `/api/cron/daily-returns`

---

## Railway Deployment

This repo is a single-service Node + Vite build, auto-detected by Railway's Nixpacks.

### 1. Push to GitHub

```bash
git init
git add .
git commit -m "PrimeReturns launch"
git branch -M main
git remote add origin https://github.com/YOU/primereturns.git
git push -u origin main
```

### 2. Deploy on Railway

*   Go to https://railway.app → **New Project** → **Deploy from GitHub repo** → select your repo.
*   Railway auto-detects Node. Default build command will be `npm run build`; start command `npm start`.
*   Inside the project, click **New → Database → MySQL** — copy the `DATABASE_URL`.

### 3. Add variables

In the deployed service → **Variables** tab, add:

| Key | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `DATABASE_URL` | paste from MySQL Connect tab |
| `APP_URL` | (leave blank, then fill in after step 4) |
| `JWT_SECRET` | `openssl rand -hex 32` output |
| `ADMIN_NAME` | `PrimeReturns Admin` |
| `ADMIN_EMAIL` | your admin login email |
| `ADMIN_PASSWORD` | strong 8+ character password |
| `SUPER_ADMIN_NAME` | `PrimeReturns Owner` |
| `SUPER_ADMIN_EMAIL` | super admin login email |
| `SUPER_ADMIN_PASSWORD` | strong 12+ character password for balance adjustments |
| `PAYSTACK_PUBLIC_KEY` | `pk_live_...` |
| `PAYSTACK_SECRET_KEY` | `sk_live_...` |
| `GOOGLE_CLIENT_ID` | Google OAuth web client ID for Google sign-in |
| `CRON_SECRET` | another long random string |

The server creates or updates the admin account automatically on startup when `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set. Use that account to log in and open `/admin`.

The server also creates or updates a super admin account when `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` are set. The super admin can use `/admin -> Users -> Adjust Balance` to perform audited manual balance corrections without Paystack deposits or withdrawals. Every adjustment creates a `balance_adjustment` transaction and an `audit_logs` record.

### 4. Generate public URL

Settings → **Networking** → Generate Domain. You'll get `https://your-app.up.railway.app`. Paste this into `APP_URL`.

### Admin tracking

After deployment, log in with your `ADMIN_EMAIL` and `ADMIN_PASSWORD`, then open:

```
https://your-app.up.railway.app/admin
```

The admin panel shows:

* Total registered users
* Users who logged in during the last 24 hours
* All recent login and registration logs
* Paystack payment attempts and successful payments
* Deposit, referral commission, and withdrawal ledger records
* Pending M-Pesa withdrawal requests

### 5. Paystack webhook

In your Paystack dashboard → Settings → Developer → Webhooks → add:

```
https://your-app.up.railway.app/api/paystack/webhook
```

### 6. Midnight cron (daily returns)

In Railway → **New → Scheduler** → or use the built-in "Cron Jobs" feature (Beta):

*   URL: `https://your-app.up.railway.app/api/cron/daily-returns`
*   Method: `POST`
*   Header: `X-Cron-Secret` = value of `CRON_SECRET`
*   Schedule: `0 0 * * *` (every day at midnight UTC)

---

## Project Files

| File | Purpose |
| --- | --- |
| `src/App.tsx` | SPA router — `/`, `/login`, `/dashboard`, `/ref/:code`, `/admin` |
| `src/pages/LandingPage.tsx` | Kenyan-market marketing landing + plans + testimonials |
| `src/pages/LoginPage.tsx` | Login / Register UI |
| `src/pages/Dashboard.tsx` | User dashboard + Paystack deposit flow |
| `src/pages/ReferralPage.tsx` | `/ref/:XXXXXXXX` handler (uses `useReferralTracking` hook) |
| `src/pages/AdminPanel.tsx` | Admin panel with M-Pesa payout approvals + cron logs |
| `src/components/ReferralDashboard.tsx` | Full 3-tier referral UI — link card, stats grid, network table |
| `src/hooks/useReferralTracking.ts` | Captures referrer code from `/ref/:code` into `localStorage` |
| `src/store/useAuthStore.ts` | Zustand user/auth store |
| `src/server/db/schema.ts` | Drizzle-ORM MySQL schemas (users, investments, referrals, transactions, cron_logs) |
| `src/server/api/auth.ts` | tRPC-style mutations: register, 3-tier link, awardReferralCommissions, checkWithdrawalGate |
| `server.cjs` | Express production server |
| `railway.json` | Railway build config |
| `Dockerfile` | Optional — if you prefer Docker over Nixpacks |
| `.env.example` | Template for environment variables |

---

## Kenyan market specifics

*   Currency: **KES** (KSh)
*   Payments: **Paystack hosted checkout** (cards + M-Pesa mobile money, depending on account configuration).
*   Referral commissions: 10% (L1) / 5% (L2) / 2% (L3) — paid instantly on verified deposit.
*   Withdrawal rules: full balance + 14-day cooldown + at least 1 active referral.

---

## Safety & disclaimers

*   **Never commit** `.env` or real Paystack secret keys to Git — they're in `.gitignore`.
*   `PAYSTACK_SECRET_KEY` must live server-side ONLY.
*   Rotate keys any time they are shared in a public context.
*   This application uses the Kenyan Paystack keys you provided earlier — replace those with your own production keys.

