# PrimeReturns Railway Variables Setup

Use this checklist to create the Railway variables needed for login, admin tracking, Paystack, and MySQL persistence.

## 1. Add MySQL

In Railway:

1. Open your PrimeReturns project.
2. Click **New**.
3. Click **Database**.
4. Choose **MySQL**.
5. Open the MySQL service.
6. Go to **Connect**.
7. Copy the value that starts with `mysql://`.
8. Add it to your app service as:

```txt
DATABASE_URL=mysql://...
```

## 2. Generate Secrets

On your computer, inside the project folder, run:

```bash
node scripts/generate-secrets.cjs
```

Copy the output into Railway Variables.

## 3. Required Railway Variables

Add these to your app service, not the MySQL service:

```txt
NODE_ENV=production
PORT=3000
DATABASE_URL=mysql://copy_from_railway_mysql_connect_tab
APP_URL=https://your-app-name.up.railway.app
JWT_SECRET=copy_from_generator
CRON_SECRET=copy_from_generator
ADMIN_NAME=PrimeReturns Admin
ADMIN_EMAIL=admin@primereturns.co.ke
ADMIN_PASSWORD=copy_from_generator_or_your_own_strong_password
PAYSTACK_PUBLIC_KEY=pk_test_or_pk_live_from_paystack
PAYSTACK_SECRET_KEY=sk_test_or_sk_live_from_paystack
GOOGLE_CLIENT_ID=your_google_oauth_web_client_id.apps.googleusercontent.com
```

## 4. Paystack Mode Rule

Do not mix key modes.

For testing:

```txt
PAYSTACK_PUBLIC_KEY=pk_test_...
PAYSTACK_SECRET_KEY=sk_test_...
```

For live payments:

```txt
PAYSTACK_PUBLIC_KEY=pk_live_...
PAYSTACK_SECRET_KEY=sk_live_...
```

If you use live keys, users need real payment methods and your Paystack account must be activated for Kenya/KES collections.

## 5. Verify Setup

After Railway redeploys, open:

```txt
https://your-app-name.up.railway.app/api/health
```

Expected:

```json
{
  "ok": true,
  "database": "online"
}
```

Then open:

```txt
https://your-app-name.up.railway.app/api/paystack/config
```

Expected:

```json
{
  "ok": true,
  "publicKey": "pk_test_or_pk_live..."
}
```

## 6. Admin Login

After redeploy, login with:

```txt
Email: ADMIN_EMAIL value
Password: ADMIN_PASSWORD value
```

Then open:

```txt
/admin
```

The admin dashboard shows users, logins, payments, withdrawals, and activity logs.

## 7. Google Sign-In Setup

In Google Cloud Console:

1. Create an OAuth 2.0 Client ID.
2. Choose **Web application**.
3. Add your live domain under **Authorized JavaScript origins**:

```txt
https://your-app-name.up.railway.app
```

4. Copy the web client ID.
5. Add it to Railway as:

```txt
GOOGLE_CLIENT_ID=your_google_oauth_web_client_id.apps.googleusercontent.com
```

If this variable is missing, email/password login still works, but Google Sign-In will be hidden.