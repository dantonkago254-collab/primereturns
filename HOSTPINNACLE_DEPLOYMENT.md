# HostPinnacle Deployment Guide For PrimeReturns

This project is a full-stack Node app. It serves the React frontend and the Express backend from one process.

## 1. Required Server Type

Use a VPS, not basic shared hosting.

Minimum:

```txt
Ubuntu 22.04 or 24.04
1 vCPU
1GB RAM
20GB SSD
Node.js 20
MySQL 8
Nginx
PM2
SSL certificate
```

## 2. Production Environment File

Create this file on the server only:

```txt
/var/www/primereturns/.env
```

Do not commit `.env` to GitHub.

Template:

```env
NODE_ENV=production
PORT=3000
APP_URL=https://your-domain.co.ke

DATABASE_URL=mysql://primereturns_user:YOUR_DB_PASSWORD@localhost:3306/primereturns

JWT_SECRET=replace_with_32_plus_character_random_secret
CRON_SECRET=replace_with_32_plus_character_random_secret

MYSQL_CONNECTION_LIMIT=10
CRON_BATCH_SIZE=500

ADMIN_NAME=PrimeReturns Admin
ADMIN_EMAIL=admin@primereturns.co.ke
ADMIN_PASSWORD=replace_with_strong_admin_password

SUPER_ADMIN_NAME=PrimeReturns Owner
SUPER_ADMIN_EMAIL=superadmin@primereturns.co.ke
SUPER_ADMIN_PASSWORD=replace_with_strong_super_admin_password

PAYSTACK_PUBLIC_KEY=pk_live_or_pk_test_here
PAYSTACK_SECRET_KEY=sk_live_or_sk_test_here

GOOGLE_CLIENT_ID=optional_google_oauth_client_id.apps.googleusercontent.com
```

## 3. Paystack Key Rule

Do not hardcode Paystack keys into source code.

Use test keys together:

```txt
PAYSTACK_PUBLIC_KEY=pk_test_...
PAYSTACK_SECRET_KEY=sk_test_...
```

Use live keys together:

```txt
PAYSTACK_PUBLIC_KEY=pk_live_...
PAYSTACK_SECRET_KEY=sk_live_...
```

Never mix test and live keys.

## 4. Build And Start

```bash
cd /var/www/primereturns
npm install
npm run build
pm2 start server.cjs --name primereturns
pm2 save
pm2 startup
```

Because `server.cjs` now loads `.env` using `dotenv`, PM2 will read the environment variables from `/var/www/primereturns/.env` automatically.

## 5. Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name your-domain.co.ke www.your-domain.co.ke;

    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 6. SSL

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d your-domain.co.ke -d www.your-domain.co.ke
```

## 7. Paystack Webhook

In Paystack dashboard, set webhook URL:

```txt
https://your-domain.co.ke/api/paystack/webhook
```

## 8. Cron Daily Returns

```bash
crontab -e
```

Add:

```cron
0 0 * * * curl -X POST https://your-domain.co.ke/api/cron/daily-returns -H "X-Cron-Secret: YOUR_CRON_SECRET"
```

## 9. Health Checks

Open:

```txt
https://your-domain.co.ke/api/health
```

Expected:

```json
{
  "ok": true,
  "database": "online"
}
```

Open:

```txt
https://your-domain.co.ke/api/paystack/config
```

Expected:

```json
{
  "ok": true,
  "publicKey": "pk_live_or_pk_test..."
}
```

## 10. Pre-Launch Manual Tests

1. Register a normal user.
2. Login as that user.
3. Open dashboard.
4. Start Paystack deposit.
5. Complete test payment if using test keys.
6. Confirm transaction appears in dashboard.
7. Confirm investment appears.
8. Login as admin.
9. Open `/admin`.
10. Confirm user, payment, and activity records are visible.
11. Login as super admin.
12. Test audited manual balance adjustment.