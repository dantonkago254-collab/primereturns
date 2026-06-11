# PrimeReturns QA Strategy, Automated Tests, and Financial Validation Checklist

## 1. Scope and Risk Model

PrimeReturns handles KSh-denominated financial movements with referral payouts, deposits, withdrawals, and daily returns. The test plan prioritizes the paths that can create irreversible ledger errors.

### Critical Invariants

- Money must be calculated in cents using integer or decimal-safe arithmetic, never floating-point balance math.
- Every financial movement must create a transaction audit row.
- A Paystack client callback is not a source of truth; server-side verification or webhook signature validation is required.
- Withdrawal requests must enforce referral gate, 14-day cooldown, minimum KSh 500, maximum KSh 500,000, and full-balance cashout semantics.
- Cron runs must be idempotent per UTC date and must create a `cron_logs` row before allowing another same-day run.
- Referral commissions are paid only after a verified investment deposit, never at registration.

## 2. Automated Test Suites

### Unit and Integration Tests - Vitest

Files:

- `tests/utils/financialHarness.ts`
- `tests/unit/withdrawalGate.test.ts`
- `tests/unit/commissionDistribution.test.ts`
- `tests/unit/dailyReturnsCron.test.ts`

Run locally:

```bash
npx vitest run
```

Coverage areas:

- `requestWithdrawal` guard conditions and successful pending withdrawal path.
- `verifyDeposit` tier payouts at 10%, 5%, and 2% for a KSh 10,000 deposit.
- Daily returns cron final-day investment completion and duplicate-run idempotency.

### E2E Tests - Playwright

Files:

- `playwright.config.ts`
- `tests/e2e/primereturns.spec.ts`

Install browsers once:

```bash
npx playwright install chromium
```

Run locally:

```bash
npx playwright test
```

Coverage areas:

- Referral capture through `/ref/REFCODE123` and transmission of `referrerCode` during registration.
- Dashboard live balance component visibility and dynamic update with seeded active investment node.

## 3. Live Manual Verification Checklist

| Step | Action | Expected Technical Result | Status (Pass/Fail) |
| :--- | :--- | :--- | :--- |
| 1 | Trigger Paystack popup using an approved test/staging payment method. | Paystack returns `charge.success`; `/api/paystack/webhook` receives signed event; `/api/paystack/verify` accepts the reference; active investment row is instantiated in DB; deposit transaction is marked `completed`. |  |
| 2 | Attempt manual manipulation of deposit amount via browser console before Paystack callback. | Server verifies Paystack reference and amount using `PAYSTACK_SECRET_KEY`; amount mismatch is rejected; no investment row and no commission rows are created. |  |
| 3 | Access `/admin` using a standard `user` authenticated session. | Frontend redirects away from `/admin`; backend admin tRPC procedures return `UNAUTHORIZED`; no admin data is returned. |  |
| 4 | Trigger manual cron execution from the Admin panel or Railway Scheduler. | Active investments receive exactly one daily return; final-day investments change to `completed`; `cron_logs` receives one row for the run date. |  |
| 5 | Trigger the same cron date twice. | Second run is skipped due to idempotency guard; user balances and transaction counts remain unchanged. |  |
| 6 | Create a new user through `/ref/{code}`. | `primereturns_referrer_code` is written to localStorage, included in registration payload, and removed only after successful registration. |  |
| 7 | Deposit KSh 10,000 from the referred user. | L1 referrer earns KSh 1,000; L2 earns KSh 500; L3 earns KSh 200; exactly three `referral_commission` transactions exist. |  |
| 8 | Try withdrawing with balance but zero active direct referrals. | tRPC mutation rejects with `BAD_REQUEST` and message `Withdrawal locked. You must have at least 1 active active referral to unlock withdrawals.` |  |
| 9 | Try withdrawing KSh 300 or KSh 600,000. | Below-minimum and above-maximum requests reject before any ledger mutation occurs. |  |
| 10 | Try withdrawing with valid amount but last withdrawal was 10 days ago. | Mutation rejects with cooldown error; no pending withdrawal is created. |  |
| 11 | Try valid withdrawal after referral gate and cooldown pass. | User balance immediately becomes KSh 0; one `withdrawal` transaction is created with status `pending`; admin payout queue shows request. |  |
| 12 | Remove or misconfigure `PAYSTACK_SECRET_KEY` in staging. | `/api/paystack/verify` returns 500 and deposits are not trusted by the backend. |  |

## 4. Production Deployment Gates

Before Railway production release, the deployment team must verify:

- `DATABASE_URL`, `PAYSTACK_SECRET_KEY`, `PAYSTACK_PUBLIC_KEY`, `JWT_SECRET`, `CRON_SECRET`, and `APP_URL` are present in Railway Variables.
- Paystack webhook URL is set to `https://<railway-domain>/api/paystack/webhook`.
- Railway cron/scheduler calls `POST /api/cron/daily-returns` with the `X-Cron-Secret` header.
- `/api/health` returns `{ "ok": true }` on the Railway domain.
- Admin account is not created through normal public registration.
- Database backups are enabled before accepting real deposits.

## 5. Financial Regression Rules

Every change touching deposits, withdrawals, referrals, cron, or balances must run:

```bash
npx vitest run
npx playwright test
npm run build
```

Any failed financial test is a release blocker.