const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mysql = require('mysql2/promise');
const { OAuth2Client } = require('google-auth-library');

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET || '';
const EFFECTIVE_JWT_SECRET = JWT_SECRET || 'dev-primereturns-change-this-secret';
const DIST_DIR = path.join(__dirname, 'dist');
const INDEX_HTML = path.join(DIST_DIR, 'index.html');
const DATABASE_URL = process.env.DATABASE_URL || '';
const APP_URL = process.env.APP_URL || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const MYSQL_CONNECTION_LIMIT = Number(process.env.MYSQL_CONNECTION_LIMIT || 10);
const CRON_BATCH_SIZE = Math.min(Number(process.env.CRON_BATCH_SIZE || 500), 1000);

const app = express();
let pool = null;

if (isProduction && (!JWT_SECRET || JWT_SECRET.length < 32)) {
  throw new Error('JWT_SECRET must be set to a strong 32+ character value in production.');
}

if (isProduction && !DATABASE_URL) {
  throw new Error('DATABASE_URL is required in production. Add Railway MySQL and set DATABASE_URL.');
}

if (isProduction && !APP_URL) {
  throw new Error('APP_URL is required in production. Set it to your Railway public URL.');
}

const railwayPublicUrl = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : '';

const allowedOrigins = new Set(
  [APP_URL, railwayPublicUrl, 'http://localhost:5173', 'http://127.0.0.1:5173']
    .filter(Boolean)
    .map((origin) => origin.replace(/\/$/, ''))
);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", 'https://accounts.google.com'],
      "style-src": ["'self'", "'unsafe-inline'"],
      "img-src": ["'self'", 'data:', 'https:'],
      "connect-src": ["'self'", 'https://api.paystack.co', 'https://accounts.google.com'],
      "frame-src": ['https://accounts.google.com'],
      "frame-ancestors": ["'none'"],
    },
  },
}));
app.use(cors((req, callback) => {
  const origin = req.headers.origin;
  const hostOrigin = `${req.protocol}://${req.get('host')}`.replace(/\/$/, '');
  const normalizedOrigin = origin ? origin.replace(/\/$/, '') : '';
  const isSameHost = Boolean(normalizedOrigin && normalizedOrigin === hostOrigin);
  const isAllowed = !origin || isSameHost || allowedOrigins.has(normalizedOrigin);

  callback(null, {
    origin: isAllowed,
    credentials: false,
  });
}));
app.use(compression());
app.use(rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.disable('x-powered-by');
app.set('trust proxy', true);

const toCents = (amount) => {
  const normalized = String(amount).replace(/,/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) {
    const error = new Error('Invalid money amount. Use a positive amount with up to 2 decimal places.');
    error.status = 400;
    throw error;
  }
  const [whole, frac = '00'] = normalized.split('.');
  return Number(BigInt(whole || '0') * 100n + BigInt((frac + '00').slice(0, 2)));
};

const fromCents = (cents) => Number(cents || 0) / 100;

const apiUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone || undefined,
  accountBalance: fromCents(row.account_balance_cents),
  totalInvested: fromCents(row.total_invested_cents),
  totalEarned: fromCents(row.total_earned_cents),
  totalReferralEarnings: fromCents(row.total_referral_earnings_cents),
  referralCode: row.referral_code,
  lastWithdrawalAt: row.last_withdrawal_at ? row.last_withdrawal_at.toISOString?.() || row.last_withdrawal_at : null,
  role: row.role,
});

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const assertEmail = (email) => {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    const error = new Error('A valid email address is required.');
    error.status = 400;
    throw error;
  }
  return normalized;
};

const assertStrongPassword = (password) => {
  if (typeof password !== 'string' || password.length < 8) {
    const error = new Error('Password must be at least 8 characters.');
    error.status = 400;
    throw error;
  }
  return password;
};

const signToken = (user) => jwt.sign({ sub: user.id, role: user.role }, EFFECTIVE_JWT_SECRET, { expiresIn: '7d' });

const requireDb = () => {
  if (!pool) {
    const error = new Error('DATABASE_URL is not configured. Add a Railway MySQL database and set DATABASE_URL.');
    error.status = 503;
    throw error;
  }
  return pool;
};

const asyncRoute = (handler) => async (req, res, next) => {
  try { await handler(req, res, next); } catch (error) { next(error); }
};

const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many authentication attempts. Please wait and try again.' },
});

const paymentLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many payment attempts. Please wait and try again.' },
});

const clampPagination = (query, defaultLimit = 50, maxLimit = 250) => {
  const page = Math.max(Number(query.page || 1), 1);
  const requestedLimit = Math.max(Number(query.limit || defaultLimit), 1);
  const limit = Math.min(requestedLimit, maxLimit);
  return { page, limit, offset: (page - 1) * limit };
};

const auth = asyncRoute(async (req, _res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    const error = new Error('Authentication required.');
    error.status = 401;
    throw error;
  }

  try {
    const decoded = jwt.verify(token, EFFECTIVE_JWT_SECRET);
    const [rows] = await requireDb().query('SELECT * FROM users WHERE id = ? LIMIT 1', [decoded.sub]);
    if (!rows.length) {
      const error = new Error('User session no longer exists.');
      error.status = 401;
      throw error;
    }
    req.user = rows[0];
    next();
  } catch (error) {
    error.status = error.status || 401;
    throw error;
  }
});

const adminOnly = (req, _res, next) => {
  if (!['admin', 'super_admin'].includes(req.user?.role)) {
    const error = new Error('UNAUTHORIZED');
    error.status = 403;
    return next(error);
  }
  next();
};

const superAdminOnly = (req, _res, next) => {
  if (req.user?.role !== 'super_admin') {
    const error = new Error('SUPER_ADMIN_REQUIRED');
    error.status = 403;
    return next(error);
  }
  next();
};

async function initDb() {
  if (!DATABASE_URL) return;
  pool = mysql.createPool({
    uri: DATABASE_URL,
    waitForConnections: true,
    connectionLimit: MYSQL_CONNECTION_LIMIT,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(191) NOT NULL,
      email VARCHAR(191) NOT NULL UNIQUE,
      phone VARCHAR(32),
      google_id VARCHAR(191) UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      account_balance_cents BIGINT NOT NULL DEFAULT 0,
      total_invested_cents BIGINT NOT NULL DEFAULT 0,
      total_earned_cents BIGINT NOT NULL DEFAULT 0,
      total_referral_earnings_cents BIGINT NOT NULL DEFAULT 0,
      referral_code VARCHAR(12) NOT NULL UNIQUE,
      last_withdrawal_at TIMESTAMP NULL,
      role ENUM('user','admin','super_admin') NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_users_created_at (created_at),
      INDEX idx_users_role (role),
      CHECK (account_balance_cents >= 0),
      CHECK (total_invested_cents >= 0),
      CHECK (total_earned_cents >= 0),
      CHECK (total_referral_earnings_cents >= 0)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS investment_plans (
      id INT AUTO_INCREMENT PRIMARY KEY,
      name VARCHAR(100) NOT NULL,
      daily_return_rate_bp INT NOT NULL,
      duration_days INT NOT NULL,
      min_amount_cents BIGINT NOT NULL,
      max_amount_cents BIGINT NOT NULL,
      is_active TINYINT NOT NULL DEFAULT 1,
      CHECK (daily_return_rate_bp >= 0),
      CHECK (duration_days > 0),
      CHECK (min_amount_cents > 0),
      CHECK (max_amount_cents >= min_amount_cents)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS referrals (
      id INT AUTO_INCREMENT PRIMARY KEY,
      referrer_id INT NOT NULL,
      referred_id INT NOT NULL,
      level TINYINT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_referred_level (referred_id, level),
      INDEX idx_referrer_level (referrer_id, level),
      FOREIGN KEY (referrer_id) REFERENCES users(id),
      FOREIGN KEY (referred_id) REFERENCES users(id),
      CHECK (level IN (1, 2, 3)),
      CHECK (referrer_id <> referred_id)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS investments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      plan_id INT NOT NULL,
      plan_name VARCHAR(100) NOT NULL,
      amount_cents BIGINT NOT NULL,
      daily_return_cents BIGINT NOT NULL,
      days_remaining INT NOT NULL,
      status ENUM('active','completed') NOT NULL DEFAULT 'active',
      start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      end_date TIMESTAMP NULL,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (plan_id) REFERENCES investment_plans(id),
      INDEX idx_user_status (user_id, status),
      INDEX idx_status_id (status, id),
      CHECK (amount_cents > 0),
      CHECK (daily_return_cents >= 0),
      CHECK (days_remaining >= 0)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      type ENUM('deposit','withdrawal','daily_return','referral_commission','balance_adjustment') NOT NULL,
      amount_cents BIGINT NOT NULL,
      status ENUM('pending','completed','failed') NOT NULL DEFAULT 'pending',
      description TEXT NOT NULL,
      phone_number VARCHAR(32),
      reference VARCHAR(100) UNIQUE,
      transfer_code VARCHAR(100),
      transfer_recipient_code VARCHAR(100),
      rejection_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      INDEX idx_user_created (user_id, created_at),
      INDEX idx_type_status (type, status),
      INDEX idx_reference (reference),
      CHECK (amount_cents >= 0)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cron_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      run_date VARCHAR(10) NOT NULL UNIQUE,
      investment_count INT NOT NULL DEFAULT 0,
      total_credited_cents BIGINT NOT NULL DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NULL,
      action VARCHAR(100) NOT NULL,
      ip_address VARCHAR(64),
      user_agent TEXT,
      metadata JSON,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_action_created (action, created_at),
      INDEX idx_user_created (user_id, created_at),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    )
  `);

  // Keep existing Railway databases compatible when new enum values are added.
  await pool.query("ALTER TABLE users MODIFY role ENUM('user','admin','super_admin') NOT NULL DEFAULT 'user'").catch(() => {});
  await pool.query("ALTER TABLE transactions MODIFY type ENUM('deposit','withdrawal','daily_return','referral_commission','balance_adjustment') NOT NULL").catch(() => {});
  await pool.query("ALTER TABLE users ADD COLUMN google_id VARCHAR(191) UNIQUE").catch(() => {});
  await pool.query("ALTER TABLE users ADD INDEX idx_users_created_at (created_at)").catch(() => {});
  await pool.query("ALTER TABLE users ADD INDEX idx_users_role (role)").catch(() => {});
  await pool.query("ALTER TABLE investments ADD INDEX idx_status_id (status, id)").catch(() => {});
  await pool.query("ALTER TABLE transactions ADD INDEX idx_reference (reference)").catch(() => {});

  const [plans] = await pool.query('SELECT COUNT(*) AS count FROM investment_plans');
  if (plans[0].count === 0) {
    await pool.query(
      'INSERT INTO investment_plans (name, daily_return_rate_bp, duration_days, min_amount_cents, max_amount_cents) VALUES ?',
      [[
        ['Starter Node', 500, 30, toCents('1000'), toCents('10000')],
        ['Growth Engine', 750, 45, toCents('10001'), toCents('100000')],
        ['Titan Core', 1000, 60, toCents('100001'), toCents('1000000')],
      ]]
    );
  }

  await seedAdminAccount();
  await seedSuperAdminAccount();
}

async function seedAdminAccount() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  const name = process.env.ADMIN_NAME || 'PrimeReturns Admin';

  if (!email || !password) return;
  if (password.length < 8) {
    console.warn('[Admin seed] ADMIN_PASSWORD must be at least 8 characters. Skipping admin seed.');
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [existing] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);

  if (existing.length) {
    await pool.query('UPDATE users SET role = ?, password_hash = ?, name = ? WHERE email = ?', ['admin', passwordHash, name, email]);
    console.log(`[Admin seed] Updated admin account: ${email}`);
    return;
  }

  const referralCode = await generateReferralCode(pool);
  await pool.query(
    'INSERT INTO users (name, email, password_hash, referral_code, role) VALUES (?, ?, ?, ?, ?)',
    [name, email, passwordHash, referralCode, 'admin']
  );
  console.log(`[Admin seed] Created admin account: ${email}`);
}

async function seedSuperAdminAccount() {
  const email = (process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD || '';
  const name = process.env.SUPER_ADMIN_NAME || 'PrimeReturns Super Admin';

  if (!email || !password) return;
  if (password.length < 12) {
    console.warn('[Super admin seed] SUPER_ADMIN_PASSWORD must be at least 12 characters. Skipping super admin seed.');
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const [existing] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);

  if (existing.length) {
    await pool.query('UPDATE users SET role = ?, password_hash = ?, name = ? WHERE email = ?', ['super_admin', passwordHash, name, email]);
    console.log(`[Super admin seed] Updated super admin account: ${email}`);
    return;
  }

  const referralCode = await generateReferralCode(pool);
  await pool.query(
    'INSERT INTO users (name, email, password_hash, referral_code, role) VALUES (?, ?, ?, ?, ?)',
    [name, email, passwordHash, referralCode, 'super_admin']
  );
  console.log(`[Super admin seed] Created super admin account: ${email}`);
}

async function logAudit(userId, action, metadata = {}, req = null) {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO audit_logs (user_id, action, ip_address, user_agent, metadata) VALUES (?, ?, ?, ?, ?)',
      [
        userId || null,
        action,
        req?.ip || null,
        req?.headers?.['user-agent'] || null,
        JSON.stringify(metadata || {}),
      ]
    );
  } catch (error) {
    console.error('[Audit log] failed:', error.message);
  }
}

async function generateReferralCode(conn) {
  for (let i = 0; i < 20; i += 1) {
    const code = crypto.randomBytes(4).toString('hex').toUpperCase();
    const [rows] = await conn.query('SELECT id FROM users WHERE referral_code = ? LIMIT 1', [code]);
    if (!rows.length) return code;
  }
  throw new Error('Could not generate referral code.');
}

async function linkReferralTree(conn, newUserId, referrerCode) {
  if (!referrerCode) return;
  const cleanedCode = String(referrerCode).trim().toUpperCase();
  if (!/^[A-Z0-9]{6,12}$/.test(cleanedCode)) return;

  const [parents] = await conn.query('SELECT id FROM users WHERE referral_code = ? LIMIT 1', [cleanedCode]);
  const parent = parents[0];
  if (!parent || parent.id === newUserId) return;

  await conn.query('INSERT IGNORE INTO referrals (referrer_id, referred_id, level) VALUES (?, ?, ?)', [parent.id, newUserId, 1]);

  const [parentLinks] = await conn.query('SELECT referrer_id FROM referrals WHERE referred_id = ? AND level = 1 LIMIT 1', [parent.id]);
  if (!parentLinks[0]) return;

  await conn.query('INSERT IGNORE INTO referrals (referrer_id, referred_id, level) VALUES (?, ?, ?)', [parentLinks[0].referrer_id, newUserId, 2]);

  const [grandLinks] = await conn.query('SELECT referrer_id FROM referrals WHERE referred_id = ? AND level = 1 LIMIT 1', [parentLinks[0].referrer_id]);
  if (grandLinks[0]) {
    await conn.query('INSERT IGNORE INTO referrals (referrer_id, referred_id, level) VALUES (?, ?, ?)', [grandLinks[0].referrer_id, newUserId, 3]);
  }
}

async function getPlanForAmount(conn, amountCents) {
  const [rows] = await conn.query(
    'SELECT * FROM investment_plans WHERE is_active = 1 AND ? BETWEEN min_amount_cents AND max_amount_cents ORDER BY min_amount_cents ASC LIMIT 1',
    [amountCents]
  );
  return rows[0];
}

async function completeVerifiedDeposit(reference, verifiedAmountCents, verifiedUserId = null) {
  const conn = await requireDb().getConnection();
  try {
    await conn.beginTransaction();
    const [txRows] = await conn.query('SELECT * FROM transactions WHERE reference = ? FOR UPDATE', [reference]);
    if (!txRows.length) throw Object.assign(new Error('Deposit transaction reference was not initialized.'), { status: 404 });

    const depositTx = txRows[0];
    if (verifiedUserId && depositTx.user_id !== verifiedUserId) {
      throw Object.assign(new Error('Deposit does not belong to the authenticated user.'), { status: 403 });
    }

    if (depositTx.amount_cents !== verifiedAmountCents) {
      throw Object.assign(new Error('Payment amount mismatch.'), { status: 400 });
    }

    if (depositTx.status === 'completed') {
      await conn.commit();
      return { alreadyCompleted: true, userId: depositTx.user_id };
    }

    const plan = await getPlanForAmount(conn, verifiedAmountCents);
    if (!plan) throw Object.assign(new Error('No active investment plan matches this amount.'), { status: 400 });

    const dailyReturnCents = Math.floor((verifiedAmountCents * plan.daily_return_rate_bp) / 10000);
    await conn.query('UPDATE transactions SET status = ? WHERE id = ?', ['completed', depositTx.id]);
    await conn.query('UPDATE users SET total_invested_cents = total_invested_cents + ? WHERE id = ?', [verifiedAmountCents, depositTx.user_id]);
    await conn.query(
      'INSERT INTO investments (user_id, plan_id, plan_name, amount_cents, daily_return_cents, days_remaining, status, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))',
      [depositTx.user_id, plan.id, plan.name, verifiedAmountCents, dailyReturnCents, plan.duration_days, 'active', plan.duration_days]
    );

    const [tiers] = await conn.query('SELECT referrer_id, level FROM referrals WHERE referred_id = ? ORDER BY level ASC', [depositTx.user_id]);
    const rates = { 1: 10, 2: 5, 3: 2 };
    for (const tier of tiers) {
      if (!rates[tier.level]) continue;
      const commissionCents = Math.floor((verifiedAmountCents * rates[tier.level]) / 100);
      await conn.query(
        'UPDATE users SET account_balance_cents = account_balance_cents + ?, total_referral_earnings_cents = total_referral_earnings_cents + ?, total_earned_cents = total_earned_cents + ? WHERE id = ?',
        [commissionCents, commissionCents, commissionCents, tier.referrer_id]
      );
      await conn.query(
        'INSERT INTO transactions (user_id, type, amount_cents, status, description) VALUES (?, ?, ?, ?, ?)',
        [tier.referrer_id, 'referral_commission', commissionCents, 'completed', `Level ${tier.level} commission from deposit of User #${depositTx.user_id}`]
      );
    }

    await conn.commit();
    return { alreadyCompleted: false, userId: depositTx.user_id };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

async function loadDashboard(userId) {
  const db = requireDb();
  const [[user]] = await db.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  const [investments] = await db.query('SELECT * FROM investments WHERE user_id = ? ORDER BY id DESC', [userId]);
  const [transactions] = await db.query('SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100', [userId]);
  const [referrals] = await db.query(`
    SELECT r.level, r.created_at, u.id, u.name, u.email,
      EXISTS(SELECT 1 FROM investments i WHERE i.user_id = u.id AND i.status IN ('active','completed')) AS has_invested
    FROM referrals r
    JOIN users u ON u.id = r.referred_id
    WHERE r.referrer_id = ?
    ORDER BY r.level ASC, r.created_at DESC
  `, [userId]);

  return {
    user: apiUser(user),
    investments: investments.map((row) => ({
      id: row.id,
      planName: row.plan_name,
      amount: fromCents(row.amount_cents),
      dailyReturn: fromCents(row.daily_return_cents),
      daysRemaining: row.days_remaining,
      status: row.status,
      startDate: row.start_date,
      endDate: row.end_date,
    })),
    transactions: transactions.map((row) => ({
      id: row.id,
      type: row.type,
      amount: fromCents(row.amount_cents),
      status: row.status,
      description: row.description,
      phoneNumber: row.phone_number,
      createdAt: row.created_at,
    })),
    referrals: referrals.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      level: row.level,
      joinedAt: row.created_at,
      hasInvested: Boolean(row.has_invested),
    })),
  };
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  let database = 'not_configured';
  if (pool) {
    await pool.query('SELECT 1');
    database = 'online';
  }
  res.json({ ok: true, service: 'primereturns', database, uptimeSec: Math.floor(process.uptime()), timestamp: new Date().toISOString() });
}));

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const { name, email, password, phone, referrerCode } = req.body || {};
  if (!name || String(name).trim().length < 2) throw Object.assign(new Error('Name must be at least 2 characters.'), { status: 400 });
  const normalizedEmail = assertEmail(email);
  const cleanPassword = assertStrongPassword(password);

  const conn = await requireDb().getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT id FROM users WHERE email = ? LIMIT 1', [normalizedEmail]);
    if (existing.length) throw Object.assign(new Error('Email already registered.'), { status: 400 });

    const passwordHash = await bcrypt.hash(cleanPassword, 12);
    const referralCode = await generateReferralCode(conn);
    const [result] = await conn.query(
      'INSERT INTO users (name, email, phone, password_hash, referral_code, role) VALUES (?, ?, ?, ?, ?, ?)',
      [String(name).trim(), normalizedEmail, phone || null, passwordHash, referralCode, 'user']
    );
    const newUserId = result.insertId;

    await linkReferralTree(conn, newUserId, referrerCode);

    await conn.commit();
    const [[user]] = await requireDb().query('SELECT * FROM users WHERE id = ?', [newUserId]);
    await logAudit(newUserId, 'auth.register', { email: user.email, referrerCode: referrerCode || null }, req);
    res.json({ ok: true, token: signToken(user), user: apiUser(user) });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = assertEmail(email);
  const [[user]] = await requireDb().query('SELECT * FROM users WHERE email = ? LIMIT 1', [normalizedEmail]);
  if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
    await logAudit(user?.id || null, 'auth.login_failed', { email: normalizedEmail }, req);
    throw Object.assign(new Error('Invalid email or password.'), { status: 401 });
  }
  await logAudit(user.id, 'auth.login_success', { email: user.email }, req);
  res.json({ ok: true, token: signToken(user), user: apiUser(user) });
}));

app.get('/api/auth/google-config', (_req, res) => {
  res.json({ ok: true, enabled: Boolean(GOOGLE_CLIENT_ID), clientId: GOOGLE_CLIENT_ID });
});

app.post('/api/auth/google', authLimiter, asyncRoute(async (req, res) => {
  const { credential, referrerCode } = req.body || {};
  if (!googleClient || !GOOGLE_CLIENT_ID) {
    throw Object.assign(new Error('Google sign-in is not configured. Add GOOGLE_CLIENT_ID in your hosting variables.'), { status: 500 });
  }

  if (!credential || typeof credential !== 'string') {
    throw Object.assign(new Error('Missing Google credential.'), { status: 400 });
  }

  const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
  const payload = ticket.getPayload();

  if (!payload?.sub || !payload.email) {
    throw Object.assign(new Error('Google account did not return a verified profile.'), { status: 400 });
  }

  if (!payload.email_verified) {
    throw Object.assign(new Error('Google email is not verified.'), { status: 400 });
  }

  const normalizedEmail = assertEmail(payload.email);
  const googleId = payload.sub;
  const displayName = payload.name || normalizedEmail.split('@')[0];
  const conn = await requireDb().getConnection();

  try {
    await conn.beginTransaction();

    const [existingByGoogle] = await conn.query('SELECT * FROM users WHERE google_id = ? LIMIT 1 FOR UPDATE', [googleId]);
    let user = existingByGoogle[0];

    if (!user) {
      const [existingByEmail] = await conn.query('SELECT * FROM users WHERE email = ? LIMIT 1 FOR UPDATE', [normalizedEmail]);
      user = existingByEmail[0];

      if (user) {
        await conn.query('UPDATE users SET google_id = ?, name = COALESCE(NULLIF(name, ""), ?) WHERE id = ?', [googleId, displayName, user.id]);
      } else {
        const referralCode = await generateReferralCode(conn);
        const randomPasswordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        const [result] = await conn.query(
          'INSERT INTO users (name, email, google_id, password_hash, referral_code, role) VALUES (?, ?, ?, ?, ?, ?)',
          [displayName, normalizedEmail, googleId, randomPasswordHash, referralCode, 'user']
        );
        const newUserId = result.insertId;
        await linkReferralTree(conn, newUserId, referrerCode);
      }
    }

    await conn.commit();

    const [[freshUser]] = await requireDb().query('SELECT * FROM users WHERE google_id = ? OR email = ? ORDER BY google_id = ? DESC LIMIT 1', [googleId, normalizedEmail, googleId]);
    await logAudit(freshUser.id, 'auth.google_login_success', { email: freshUser.email }, req);
    res.json({ ok: true, token: signToken(freshUser), user: apiUser(freshUser) });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}));

app.get('/api/auth/me', auth, asyncRoute(async (req, res) => res.json({ ok: true, user: apiUser(req.user) })));
app.get('/api/dashboard', auth, asyncRoute(async (req, res) => res.json({ ok: true, ...(await loadDashboard(req.user.id)) })));

app.get('/api/referrals/validate/:code', asyncRoute(async (req, res) => {
  const [[row]] = await requireDb().query('SELECT id FROM users WHERE referral_code = ? LIMIT 1', [String(req.params.code || '').toUpperCase()]);
  res.json({ ok: true, valid: Boolean(row) });
}));

app.get('/api/paystack/config', (_req, res) => res.json({ ok: true, publicKey: process.env.PAYSTACK_PUBLIC_KEY || '' }));

app.post('/api/paystack/initialize', auth, paymentLimiter, asyncRoute(async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || '';
  if (!secret) throw Object.assign(new Error('PAYSTACK_SECRET_KEY is not configured in Railway.'), { status: 500 });

  const amountCents = toCents(req.body.amount);
  if (amountCents < toCents('1000')) throw Object.assign(new Error('Minimum deposit is KSh 1,000.'), { status: 400 });
  const plan = await getPlanForAmount(requireDb(), amountCents);
  if (!plan) throw Object.assign(new Error('Deposit amount does not match any active investment plan.'), { status: 400 });

  const reference = `PR-${Date.now()}-${req.user.id}`;
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  await requireDb().query(
    'INSERT INTO transactions (user_id, type, amount_cents, status, description, reference) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, 'deposit', amountCents, 'pending', `Pending Paystack deposit for ${plan.name}`, reference]
  );
  await logAudit(req.user.id, 'paystack.initialize', { reference, amount: fromCents(amountCents), plan: plan.name }, req);

  const paystackResponse = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: req.user.email,
      amount: amountCents,
      currency: 'KES',
      reference,
      callback_url: `${appUrl}/dashboard`,
      metadata: { user_id: req.user.id, plan_id: plan.id, amount: fromCents(amountCents) },
    }),
  });
  const payload = await paystackResponse.json();
  if (!paystackResponse.ok || !payload.status) {
    await requireDb().query('UPDATE transactions SET status = ? WHERE reference = ?', ['failed', reference]);
    throw Object.assign(new Error(payload.message || 'Paystack initialization failed.'), { status: 400 });
  }

  res.json({ ok: true, reference, authorizationUrl: payload.data.authorization_url, accessCode: payload.data.access_code });
}));

app.post('/api/paystack/verify', auth, paymentLimiter, asyncRoute(async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || '';
  const { reference } = req.body || {};
  if (!secret) throw Object.assign(new Error('PAYSTACK_SECRET_KEY is not configured.'), { status: 500 });
  if (!reference) throw Object.assign(new Error('Missing Paystack reference.'), { status: 400 });

  const paystackResponse = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${secret}` },
  });
  const payload = await paystackResponse.json();
  if (!paystackResponse.ok || !payload.status || payload.data?.status !== 'success') {
    throw Object.assign(new Error(payload.message || 'Payment not verified.'), { status: 400 });
  }

  await completeVerifiedDeposit(reference, Number(payload.data.amount), req.user.id);
  await logAudit(req.user.id, 'paystack.verify_success', { reference, amount: fromCents(Number(payload.data.amount)) }, req);
  res.json({ ok: true, ...(await loadDashboard(req.user.id)) });
}));

app.post('/api/paystack/webhook', asyncRoute(async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY || '';
  const signature = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', secret).update(req.rawBody || '').digest('hex');
  if (!secret || signature !== hash) return res.status(401).json({ ok: false, error: 'Invalid signature' });
  if (req.body?.event === 'charge.success') {
    await completeVerifiedDeposit(req.body.data.reference, Number(req.body.data.amount));
    await logAudit(req.body.data.metadata?.user_id || null, 'paystack.webhook_charge_success', {
      reference: req.body.data.reference,
      amount: fromCents(Number(req.body.data.amount)),
    }, req);
  }
  res.json({ ok: true });
}));

app.post('/api/withdrawals/request', auth, asyncRoute(async (req, res) => {
  const rawPhone = String(req.body.phoneNumber || req.user.phone || '').trim().replace(/\s+/g, '');
  const phone = rawPhone.startsWith('0') ? `254${rawPhone.slice(1)}` : rawPhone.replace(/^\+/, '');
  if (!/^254\d{9}$/.test(phone)) throw Object.assign(new Error('A valid Kenyan M-Pesa phone number is required.'), { status: 400 });

  const conn = await requireDb().getConnection();
  try {
    await conn.beginTransaction();
    const [[lockedUser]] = await conn.query('SELECT * FROM users WHERE id = ? FOR UPDATE', [req.user.id]);
    const balance = Number(lockedUser.account_balance_cents);

    if (balance < toCents('500')) throw Object.assign(new Error('Minimum withdrawal amount is KSh 500.'), { status: 400 });
    if (balance > toCents('500000')) throw Object.assign(new Error('Maximum withdrawal amount is KSh 500,000.'), { status: 400 });
    if (lockedUser.last_withdrawal_at && Date.now() - new Date(lockedUser.last_withdrawal_at).getTime() < 14 * 24 * 60 * 60 * 1000) {
      throw Object.assign(new Error('Withdrawal locked. Please wait 14 days between withdrawals.'), { status: 400 });
    }

    const [[gate]] = await conn.query(`
      SELECT COUNT(DISTINCT r.referred_id) AS count
      FROM referrals r
      WHERE r.referrer_id = ? AND r.level = 1
        AND EXISTS(SELECT 1 FROM investments i WHERE i.user_id = r.referred_id AND i.status IN ('active','completed'))
    `, [req.user.id]);
    if (gate.count < 1) throw Object.assign(new Error('Withdrawal locked. You must have at least 1 active active referral to unlock withdrawals.'), { status: 400 });

    await conn.query('INSERT INTO transactions (user_id, type, amount_cents, status, description, phone_number) VALUES (?, ?, ?, ?, ?, ?)', [req.user.id, 'withdrawal', balance, 'pending', 'Full balance M-Pesa withdrawal request', phone]);
    await conn.query('UPDATE users SET account_balance_cents = 0 WHERE id = ?', [req.user.id]);
    await conn.commit();
    await logAudit(req.user.id, 'withdrawal.requested', { amount: fromCents(balance), phone }, req);
    res.json({ ok: true, ...(await loadDashboard(req.user.id)) });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}));

app.post('/api/cron/daily-returns', asyncRoute(async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) throw Object.assign(new Error('Missing or invalid X-Cron-Secret'), { status: 401 });
  const runDate = new Date().toISOString().slice(0, 10);
  const conn = await requireDb().getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT id FROM cron_logs WHERE run_date = ? FOR UPDATE', [runDate]);
    if (existing.length) {
      await conn.commit();
      return res.json({ ok: true, skipped: true, runDate });
    }
    let total = 0;
    let investmentCount = 0;
    let lastId = 0;

    while (true) {
      const [investments] = await conn.query(
        'SELECT * FROM investments WHERE status = ? AND id > ? ORDER BY id ASC LIMIT ? FOR UPDATE',
        ['active', lastId, CRON_BATCH_SIZE]
      );

      if (!investments.length) break;

      for (const investment of investments) {
        lastId = investment.id;
        total += Number(investment.daily_return_cents);
        investmentCount += 1;
        const nextDays = Math.max(0, investment.days_remaining - 1);
        await conn.query('UPDATE users SET account_balance_cents = account_balance_cents + ?, total_earned_cents = total_earned_cents + ? WHERE id = ?', [investment.daily_return_cents, investment.daily_return_cents, investment.user_id]);
        await conn.query('INSERT INTO transactions (user_id, type, amount_cents, status, description) VALUES (?, ?, ?, ?, ?)', [investment.user_id, 'daily_return', investment.daily_return_cents, 'completed', `Daily return from ${investment.plan_name}`]);
        await conn.query('UPDATE investments SET days_remaining = ?, status = ? WHERE id = ?', [nextDays, nextDays === 0 ? 'completed' : 'active', investment.id]);
      }
    }
    await conn.query('INSERT INTO cron_logs (run_date, investment_count, total_credited_cents) VALUES (?, ?, ?)', [runDate, investmentCount, total]);
    await conn.commit();
    res.json({ ok: true, skipped: false, runDate, investmentCount, totalCredited: fromCents(total) });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}));

app.get('/api/admin/withdrawals', auth, adminOnly, asyncRoute(async (_req, res) => {
  const [rows] = await requireDb().query("SELECT t.*, u.name, u.email FROM transactions t JOIN users u ON u.id = t.user_id WHERE t.type = 'withdrawal' AND t.status = 'pending' ORDER BY t.created_at DESC LIMIT 100");
  res.json({ ok: true, withdrawals: rows.map((row) => ({ ...row, amount: fromCents(row.amount_cents) })) });
}));

app.post('/api/admin/withdrawals/:id/approve', auth, adminOnly, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw Object.assign(new Error('Invalid withdrawal id.'), { status: 400 });
  const conn = await requireDb().getConnection();
  try {
    await conn.beginTransaction();
    const [[withdrawal]] = await conn.query("SELECT * FROM transactions WHERE id = ? AND type = 'withdrawal' FOR UPDATE", [id]);
    if (!withdrawal) throw Object.assign(new Error('Withdrawal not found.'), { status: 404 });
    if (withdrawal.status !== 'pending') throw Object.assign(new Error('Withdrawal is not pending.'), { status: 400 });
    await conn.query('UPDATE transactions SET status = ?, description = CONCAT(description, ?) WHERE id = ?', ['completed', ' | Approved by admin', id]);
    await conn.query('UPDATE users SET last_withdrawal_at = NOW() WHERE id = ?', [withdrawal.user_id]);
    await conn.commit();
    await logAudit(req.user.id, 'admin.withdrawal_approved', { withdrawalId: id, userId: withdrawal.user_id, amount: fromCents(withdrawal.amount_cents) }, req);
    res.json({ ok: true });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}));

app.post('/api/admin/withdrawals/:id/fail', auth, adminOnly, asyncRoute(async (req, res) => {
  const id = Number(req.params.id);
  const reason = String(req.body.reason || 'Rejected by admin').slice(0, 500);
  if (!Number.isInteger(id)) throw Object.assign(new Error('Invalid withdrawal id.'), { status: 400 });
  const conn = await requireDb().getConnection();
  try {
    await conn.beginTransaction();
    const [[withdrawal]] = await conn.query("SELECT * FROM transactions WHERE id = ? AND type = 'withdrawal' FOR UPDATE", [id]);
    if (!withdrawal) throw Object.assign(new Error('Withdrawal not found.'), { status: 404 });
    if (withdrawal.status !== 'pending') throw Object.assign(new Error('Withdrawal is not pending.'), { status: 400 });
    await conn.query('UPDATE transactions SET status = ?, rejection_reason = ? WHERE id = ?', ['failed', reason, id]);
    await conn.query('UPDATE users SET account_balance_cents = account_balance_cents + ? WHERE id = ?', [withdrawal.amount_cents, withdrawal.user_id]);
    await conn.commit();
    await logAudit(req.user.id, 'admin.withdrawal_failed', { withdrawalId: id, userId: withdrawal.user_id, amount: fromCents(withdrawal.amount_cents), reason }, req);
    res.json({ ok: true });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}));

app.get('/api/admin/metrics', auth, adminOnly, asyncRoute(async (_req, res) => {
  const db = requireDb();
  const [[usersMetric]] = await db.query(`
    SELECT
      COUNT(*) AS totalUsers,
      SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR) THEN 1 ELSE 0 END) AS newUsers24h,
      COALESCE(SUM(account_balance_cents), 0) AS totalBalancesCents,
      COALESCE(SUM(total_invested_cents), 0) AS totalInvestedCents,
      COALESCE(SUM(total_referral_earnings_cents), 0) AS totalReferralCents
    FROM users
  `);
  const [[investmentMetric]] = await db.query(`
    SELECT
      COUNT(*) AS totalInvestments,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeInvestments
    FROM investments
  `);
  const [[paymentMetric]] = await db.query(`
    SELECT
      SUM(CASE WHEN type = 'deposit' AND status = 'completed' THEN 1 ELSE 0 END) AS completedDeposits,
      COALESCE(SUM(CASE WHEN type = 'deposit' AND status = 'completed' THEN amount_cents ELSE 0 END), 0) AS paidInCents,
      SUM(CASE WHEN type = 'withdrawal' AND status = 'pending' THEN 1 ELSE 0 END) AS pendingWithdrawals
    FROM transactions
  `);
  const [[loginMetric]] = await db.query(`
    SELECT
      COUNT(*) AS logins24h,
      COUNT(DISTINCT user_id) AS activeUsers24h
    FROM audit_logs
    WHERE action = 'auth.login_success' AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  `);
  const [[gatewayMetric]] = await db.query(`
    SELECT
      COUNT(*) AS paymentAttempts24h,
      SUM(CASE WHEN action IN ('paystack.verify_success', 'paystack.webhook_charge_success') THEN 1 ELSE 0 END) AS successfulPayments24h
    FROM audit_logs
    WHERE action LIKE 'paystack.%' AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
  `);

  res.json({
    ok: true,
    metrics: {
      totalUsers: Number(usersMetric.totalUsers || 0),
      newUsers24h: Number(usersMetric.newUsers24h || 0),
      activeUsers24h: Number(loginMetric.activeUsers24h || 0),
      logins24h: Number(loginMetric.logins24h || 0),
      totalBalances: fromCents(usersMetric.totalBalancesCents),
      totalInvested: fromCents(usersMetric.totalInvestedCents),
      totalReferralEarnings: fromCents(usersMetric.totalReferralCents),
      totalInvestments: Number(investmentMetric.totalInvestments || 0),
      activeInvestments: Number(investmentMetric.activeInvestments || 0),
      completedDeposits: Number(paymentMetric.completedDeposits || 0),
      paidIn: fromCents(paymentMetric.paidInCents),
      pendingWithdrawals: Number(paymentMetric.pendingWithdrawals || 0),
      paymentAttempts24h: Number(gatewayMetric.paymentAttempts24h || 0),
      successfulPayments24h: Number(gatewayMetric.successfulPayments24h || 0),
    },
  });
}));

app.get('/api/admin/activity', auth, adminOnly, asyncRoute(async (_req, res) => {
  const [logRows] = await requireDb().query(`
    SELECT a.id, a.action, a.ip_address, a.user_agent, a.metadata, a.created_at, u.name, u.email
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 100
  `);
  const [paymentRows] = await requireDb().query(`
    SELECT t.id, t.type, t.status, t.amount_cents, t.reference, t.description, t.created_at, u.name, u.email
    FROM transactions t
    JOIN users u ON u.id = t.user_id
    WHERE t.type IN ('deposit', 'withdrawal', 'referral_commission')
    ORDER BY t.created_at DESC, t.id DESC
    LIMIT 100
  `);

  res.json({
    ok: true,
    logs: logRows.map((row) => ({
      ...row,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : row.metadata,
    })),
    payments: paymentRows.map((row) => ({
      ...row,
      amount: fromCents(row.amount_cents),
    })),
  });
}));

app.get('/api/admin/cron-logs', auth, adminOnly, asyncRoute(async (_req, res) => {
  const [rows] = await requireDb().query('SELECT * FROM cron_logs ORDER BY created_at DESC, id DESC LIMIT 100');
  res.json({
    ok: true,
    logs: rows.map((row) => ({
      id: row.id,
      runDate: row.run_date,
      investmentCount: row.investment_count,
      totalCredited: fromCents(row.total_credited_cents),
      createdAt: row.created_at,
    })),
  });
}));

app.get('/api/admin/users', auth, adminOnly, asyncRoute(async (_req, res) => {
  const [rows] = await requireDb().query(`
    SELECT
      u.id,
      u.name,
      u.email,
      u.phone,
      u.role,
      u.referral_code,
      u.account_balance_cents,
      u.total_invested_cents,
      u.total_earned_cents,
      u.total_referral_earnings_cents,
      u.created_at,
      (SELECT MAX(a.created_at) FROM audit_logs a WHERE a.user_id = u.id AND a.action = 'auth.login_success') AS last_login_at,
      (SELECT COUNT(*) FROM investments i WHERE i.user_id = u.id) AS investment_count,
      (SELECT COUNT(*) FROM transactions t WHERE t.user_id = u.id AND t.type = 'deposit' AND t.status = 'completed') AS completed_deposit_count
    FROM users u
    ORDER BY u.created_at DESC
    LIMIT 250
  `);

  res.json({
    ok: true,
    users: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      phone: row.phone,
      role: row.role,
      referralCode: row.referral_code,
      accountBalance: fromCents(row.account_balance_cents),
      totalInvested: fromCents(row.total_invested_cents),
      totalEarned: fromCents(row.total_earned_cents),
      totalReferralEarnings: fromCents(row.total_referral_earnings_cents),
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      investmentCount: Number(row.investment_count || 0),
      completedDepositCount: Number(row.completed_deposit_count || 0),
    })),
  });
}));

app.post('/api/super-admin/users/:id/balance', auth, superAdminOnly, asyncRoute(async (req, res) => {
  const targetUserId = Number(req.params.id);
  const mode = String(req.body.mode || '').trim().toLowerCase();
  const reason = String(req.body.reason || '').trim().slice(0, 500);
  const amountCents = toCents(req.body.amount);

  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw Object.assign(new Error('Invalid target user id.'), { status: 400 });
  }

  if (!['set', 'add', 'subtract'].includes(mode)) {
    throw Object.assign(new Error('Balance adjustment mode must be set, add, or subtract.'), { status: 400 });
  }

  if (mode !== 'set' && amountCents <= 0) {
    throw Object.assign(new Error('Adjustment amount must be greater than zero.'), { status: 400 });
  }

  if (reason.length < 5) {
    throw Object.assign(new Error('A clear reason is required for manual balance adjustments.'), { status: 400 });
  }

  const conn = await requireDb().getConnection();
  try {
    await conn.beginTransaction();
    const [[targetUser]] = await conn.query('SELECT * FROM users WHERE id = ? FOR UPDATE', [targetUserId]);
    if (!targetUser) throw Object.assign(new Error('Target user not found.'), { status: 404 });

    const currentBalance = Number(targetUser.account_balance_cents);
    let nextBalance = currentBalance;

    if (mode === 'set') nextBalance = amountCents;
    if (mode === 'add') nextBalance = currentBalance + amountCents;
    if (mode === 'subtract') nextBalance = currentBalance - amountCents;

    if (nextBalance < 0) {
      throw Object.assign(new Error('Adjustment would make the account balance negative.'), { status: 400 });
    }

    const delta = nextBalance - currentBalance;
    await conn.query('UPDATE users SET account_balance_cents = ? WHERE id = ?', [nextBalance, targetUserId]);
    await conn.query(
      'INSERT INTO transactions (user_id, type, amount_cents, status, description) VALUES (?, ?, ?, ?, ?)',
      [
        targetUserId,
        'balance_adjustment',
        Math.abs(delta),
        'completed',
        `Super admin ${mode} balance adjustment. Previous: KSh ${fromCents(currentBalance)}. New: KSh ${fromCents(nextBalance)}. Delta: KSh ${fromCents(delta)}. Reason: ${reason}`,
      ]
    );

    await conn.commit();

    await logAudit(req.user.id, 'super_admin.balance_adjustment', {
      targetUserId,
      targetEmail: targetUser.email,
      mode,
      amount: fromCents(amountCents),
      previousBalance: fromCents(currentBalance),
      newBalance: fromCents(nextBalance),
      delta: fromCents(delta),
      reason,
    }, req);

    const [[updatedUser]] = await requireDb().query('SELECT * FROM users WHERE id = ?', [targetUserId]);
    res.json({ ok: true, user: apiUser(updatedUser) });
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}));

if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR, { maxAge: '7d', index: false, extensions: ['html'] }));
  app.get(/^\/(?!api).*/, (_req, res) => fs.existsSync(INDEX_HTML) ? res.sendFile(INDEX_HTML) : res.status(500).send('Frontend not built.'));
}

app.use((error, _req, res, _next) => {
  console.error('[PrimeReturns API]', error);
  res.status(error.status || 500).json({ ok: false, error: error.message || 'Server error' });
});

initDb()
  .then(() => http.createServer(app).listen(PORT, () => console.log(`[PrimeReturns] listening on :${PORT}`)))
  .catch((error) => {
    console.error('[PrimeReturns] failed to start:', error);
    process.exit(1);
  });