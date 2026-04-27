const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { syncData, getCachedData, getLastSyncTime, startAutoSync } = require('./api-sync');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== DATABASE SETUP =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
});

async function dbInit() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'analyst',
      analyst_id TEXT,
      display_name TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flags (
      id SERIAL PRIMARY KEY,
      trade_id TEXT,
      sym TEXT NOT NULL,
      an TEXT NOT NULL,
      dir TEXT NOT NULL,
      d TEXT,
      reason TEXT,
      flagged_by TEXT,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS overrides (
      id SERIAL PRIMARY KEY,
      trade_id TEXT,
      sym TEXT NOT NULL,
      an TEXT NOT NULL,
      dir TEXT NOT NULL,
      d TEXT,
      entry REAL,
      exit_val REAL,
      rr REAL,
      overridden_by TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

async function dbAll(sql, params) { const r = await pool.query(sql, params); return r.rows; }
async function dbGet(sql, params) { const r = await pool.query(sql, params); return r.rows[0] || null; }
async function dbRun(sql, params) { await pool.query(sql, params); }

// ===== MIDDLEWARE =====
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'acuity-dashboard-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS === 'true', httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') return res.redirect('https://' + req.hostname + req.url);
  next();
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ===== AUTH =====
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.headers.accept && req.headers.accept.includes('text/html')) return res.redirect('/login');
  res.status(401).json({ error: 'Not authenticated' });
}
function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await dbGet('SELECT * FROM users WHERE username = $1', [username]);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
  req.session.user = { id: user.id, username: user.username, role: user.role, analyst_id: user.analyst_id, display_name: user.display_name };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/me', requireAuth, (req, res) => { res.json({ user: req.session.user }); });

// ===== DATA =====
app.get('/api/data', requireAuth, (req, res) => {
  const D = getCachedData();
  if (!D) {
    const dataPath = path.join(__dirname, 'data', 'dashboard_data.json');
    if (!fs.existsSync(dataPath)) return res.status(503).json({ error: 'Dashboard data not yet loaded.' });
    const fallback = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    if (req.session.user.role === 'analyst') return res.json(filterForAnalyst(fallback, req.session.user.analyst_id));
    return res.json(fallback);
  }
  if (req.session.user.role === 'analyst') return res.json(filterForAnalyst(D, req.session.user.analyst_id));
  res.json(D);
});

app.post('/api/sync', requireAdmin, async (req, res) => {
  try {
    const overrides = await dbAll('SELECT * FROM overrides');
    const data = await syncData(overrides);
    res.json({ success: true, trades: data.o.trades, months: data.mpnl.length, lastMonth: data.mpnl[data.mpnl.length - 1].mu, lastSync: getLastSyncTime() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/sync-status', requireAuth, (req, res) => {
  const data = getCachedData();
  res.json({ synced: !!data, lastSync: getLastSyncTime(), trades: data ? data.o.trades : 0, lastMonth: data ? data.mpnl[data.mpnl.length - 1].mu : null });
});

// ===== USERS =====
app.get('/api/users', requireAdmin, async (req, res) => { res.json(await dbAll('SELECT id, username, role, analyst_id, display_name, created_at FROM users')); });

app.post('/api/users', requireAdmin, async (req, res) => {
  const { username, password, role, analyst_id, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    await dbRun('INSERT INTO users (username, password, role, analyst_id, display_name) VALUES ($1,$2,$3,$4,$5)', [username, bcrypt.hashSync(password, 10), role || 'analyst', analyst_id || null, display_name || username]);
    res.json({ success: true });
  } catch (err) { res.status(400).json({ error: 'Username already exists' }); }
});

app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const { password, role, analyst_id, display_name } = req.body;
  const user = await dbGet('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (password) {
    await dbRun('UPDATE users SET password=$1, role=$2, analyst_id=$3, display_name=$4 WHERE id=$5', [bcrypt.hashSync(password, 10), role || user.role, analyst_id || user.analyst_id, display_name || user.display_name, req.params.id]);
  } else {
    await dbRun('UPDATE users SET role=$1, analyst_id=$2, display_name=$3 WHERE id=$4', [role || user.role, analyst_id || user.analyst_id, display_name || user.display_name, req.params.id]);
  }
  res.json({ success: true });
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => { await dbRun('DELETE FROM users WHERE id = $1', [req.params.id]); res.json({ success: true }); });

// ===== FLAGS =====
app.get('/api/flags', requireAuth, async (req, res) => { res.json(await dbAll('SELECT * FROM flags ORDER BY created_at DESC')); });

app.post('/api/flags', requireAuth, async (req, res) => {
  const { trade_id, sym, an, dir, d, reason } = req.body;
  if (!sym || !an || !dir) return res.status(400).json({ error: 'sym, an, dir required' });
  await dbRun('INSERT INTO flags (trade_id, sym, an, dir, d, reason, flagged_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [trade_id || null, sym, an, dir, d || null, reason || '', req.session.user.display_name || req.session.user.username]);
  res.json({ success: true });
});

app.delete('/api/flags/:id', requireAdmin, async (req, res) => { await dbRun('DELETE FROM flags WHERE id = $1', [req.params.id]); res.json({ success: true }); });

app.put('/api/flags/:id', requireAdmin, async (req, res) => {
  await dbRun('UPDATE flags SET status = $1 WHERE id = $2', [req.body.status || 'resolved', req.params.id]);
  res.json({ success: true });
});

// ===== OVERRIDES =====
app.get('/api/overrides', requireAuth, async (req, res) => { res.json(await dbAll('SELECT * FROM overrides ORDER BY created_at DESC')); });

app.post('/api/overrides', requireAdmin, async (req, res) => {
  const { trade_id, sym, an, dir, d, entry, exit_val, rr } = req.body;
  if (!sym || !an || !dir) return res.status(400).json({ error: 'sym, an, dir required' });
  await dbRun('DELETE FROM overrides WHERE sym=$1 AND an=$2 AND dir=$3 AND d=$4', [sym, an, dir, d || null]);
  await dbRun('INSERT INTO overrides (trade_id, sym, an, dir, d, entry, exit_val, rr, overridden_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [trade_id || null, sym, an, dir, d || null, entry || 0, exit_val || 0, rr || 0, req.session.user.display_name || req.session.user.username]);
  await dbRun("UPDATE flags SET status = 'resolved' WHERE sym=$1 AND an=$2 AND dir=$3 AND (d=$4 OR d IS NULL)", [sym, an, dir, d || null]);
  res.json({ success: true });
  const allOverrides = await dbAll('SELECT * FROM overrides');
  syncData(allOverrides).catch(err => console.error('[API-SYNC] Post-override sync error:', err));
});

app.delete('/api/overrides/:id', requireAdmin, async (req, res) => {
  await dbRun('DELETE FROM overrides WHERE id = $1', [req.params.id]);
  res.json({ success: true });
  const allOverrides = await dbAll('SELECT * FROM overrides');
  syncData(allOverrides).catch(err => console.error('[API-SYNC] Post-delete-override sync error:', err));
});

// ===== ANALYST DATA FILTERING =====
function filterForAnalyst(D, aid) {
  const F = JSON.parse(JSON.stringify(D));
  
  // Replace global month drill with analyst-specific data
  if (F.amd && F.amd[aid]) {
    const myAmd = F.amd[aid];
    Object.keys(F.md).forEach(k => {
      if (myAmd[k]) {
        F.md[k] = myAmd[k];
      } else {
        // No data for this analyst in this month - show empty
        F.md[k] = { lb: [], b5: [], w5: [], eq: [], tgr: 0 };
      }
    });
  } else {
    // Fallback: just hide analyst names
    Object.keys(F.md).forEach(k => { if (F.md[k].lb) F.md[k].lb = []; });
  }
  delete F.amd; // Don't send all analysts' data to client

  // Replace mpnl with analyst's own monthly data so Overview drill-down shows their stats
  if (F.am && F.am[aid]) {
    const myAm = F.am[aid];
    F.mpnl = myAm.map(m => ({
      m: '20' + m.m.substring(0, 2) + '-' + m.m.substring(3, 5),
      mu: m.mu,
      ret: m.ret,
      n: m.n,
      w: m.w,
      wr: m.wr,
      dd: m.dd,
      rr: m.rr,
      tgr: m.tgr,
      y: '20' + m.m.substring(0, 2)
    }));
  }

  if (F.am) { const my = F.am[aid] || []; F.am = {}; F.am[aid] = my; }
  if (F.aeq) { const my = F.aeq[aid] || []; F.aeq = {}; F.aeq[aid] = my; }
  if (F.rec) { const my = F.rec[aid] || []; F.rec = {}; F.rec[aid] = my; }
  if (F.kh) { const my = F.kh[aid] || []; F.kh = {}; F.kh[aid] = my; }
  if (F.as) { const my = F.as[aid] || {}; F.as = {}; F.as[aid] = my; }
  if (F.atgr) { const my = F.atgr[aid] || 0; F.atgr = {}; F.atgr[aid] = my; }
  if (F.cov) { const my = F.cov[aid] || []; F.cov = {}; F.cov[aid] = my; }
  if (F.a) F.a = F.a.filter(a => a.id === aid);
  F._role = 'analyst';
  F._analyst_id = aid;
  return F;
}

// ===== CATCH-ALL =====
app.get('/', requireAuth, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });
app.get('*', requireAuth, (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ===== START =====
async function start() {
  await dbInit();
  console.log('✅ Database tables ready');

  const admin = await dbGet("SELECT * FROM users WHERE role = 'admin'");
  if (!admin && process.env.ADMIN_PASSWORD) {
    await dbRun('INSERT INTO users (username, password, role, display_name) VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING', ['admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10), 'admin', 'Administrator']);
    console.log('✅ Admin user created');
  }

  const analysts = [
    { username: 'ian.coleman', password: 'Acuity_Ian2026!', analyst_id: 'IAN', display_name: 'Ian Coleman' },
    { username: 'khaled.gad', password: 'Acuity_Khaled2026!', analyst_id: 'KG', display_name: 'Khaled Gad' },
    { username: 'maged.darwish', password: 'Acuity_Maged2026!', analyst_id: 'MAG', display_name: 'Maged Darwish' },
    { username: 'mona.hassan', password: 'Acuity_Mona2026!', analyst_id: 'MOH', display_name: 'Mona Hassan' },
    { username: 'tibor.vrbovsky', password: 'Acuity_Tibor2026!', analyst_id: 'TIV', display_name: 'Tibor Vrbovsky' }
  ];
  for (const a of analysts) {
    const existing = await dbGet('SELECT id FROM users WHERE analyst_id = $1', [a.analyst_id]);
    if (!existing) {
      const pw = process.env['PW_' + a.analyst_id] || a.password;
      await dbRun('INSERT INTO users (username, password, role, analyst_id, display_name) VALUES ($1,$2,$3,$4,$5)', [a.username, bcrypt.hashSync(pw, 10), 'analyst', a.analyst_id, a.display_name]);
      console.log('  ✅ Created ' + a.display_name);
    }
  }
  console.log('Analyst accounts ready');

  app.listen(PORT, () => {
    console.log(`Acuity Dashboard running on port ${PORT}`);
    startAutoSync(async function() { return await dbAll('SELECT * FROM overrides'); });
  });
}

start().catch(err => { console.error('Failed to start:', err); process.exit(1); });
