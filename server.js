const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { syncData, getCachedData, getLastSyncTime, startAutoSync } = require('./api-sync');

const app = express();
const PORT = process.env.PORT || 3000;

// ===== DATABASE SETUP =====
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'app.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'analyst',
    analyst_id TEXT,
    display_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id TEXT,
    sym TEXT NOT NULL,
    an TEXT NOT NULL,
    dir TEXT NOT NULL,
    d TEXT,
    reason TEXT,
    flagged_by TEXT,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id TEXT,
    sym TEXT NOT NULL,
    an TEXT NOT NULL,
    dir TEXT NOT NULL,
    d TEXT,
    entry REAL,
    exit_val REAL,
    rr REAL,
    overridden_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// ===== MIDDLEWARE =====
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'acuity-dashboard-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS === 'true',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Force HTTPS on Heroku
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect('https://' + req.hostname + req.url);
  }
  next();
});

// Serve static files - but protect index.html behind auth
app.use(express.static(path.join(__dirname, 'public'), {
  index: false  // Don't auto-serve index.html for /
}));

// Favicon - no auth needed
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ===== AUTH MIDDLEWARE =====
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  if (req.headers.accept && req.headers.accept.includes('text/html')) {
    return res.redirect('/login');
  }
  res.status(401).json({ error: 'Not authenticated' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  res.status(403).json({ error: 'Admin access required' });
}

// ===== AUTH ROUTES =====
app.get('/login', (req, res) => {
  if (req.session && req.session.user) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.session.user = {
    id: user.id,
    username: user.username,
    role: user.role,
    analyst_id: user.analyst_id,
    display_name: user.display_name
  };
  res.json({ success: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// ===== DATA ROUTES =====
app.get('/api/data', requireAuth, (req, res) => {
  const D = getCachedData();
  if (!D) {
    // Fallback to file if sync hasn't completed yet
    const dataPath = path.join(__dirname, 'data', 'dashboard_data.json');
    if (!fs.existsSync(dataPath)) {
      return res.status(503).json({ error: 'Dashboard data not yet loaded. Sync in progress...' });
    }
    const raw = fs.readFileSync(dataPath, 'utf8');
    const fallback = JSON.parse(raw);
    if (req.session.user.role === 'analyst') {
      return res.json(filterForAnalyst(fallback, req.session.user.analyst_id));
    }
    return res.json(fallback);
  }

  // If analyst, filter the data to only their stats
  if (req.session.user.role === 'analyst') {
    const aid = req.session.user.analyst_id;
    const filtered = filterForAnalyst(D, aid);
    return res.json(filtered);
  }

  // Admin gets everything
  res.json(D);
});

// Manual sync trigger (admin only)
app.post('/api/sync', requireAdmin, async (req, res) => {
  try {
    const data = await syncData();
    res.json({
      success: true,
      trades: data.o.trades,
      months: data.mpnl.length,
      lastMonth: data.mpnl[data.mpnl.length - 1].mu,
      lastSync: getLastSyncTime()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync status
app.get('/api/sync-status', requireAuth, (req, res) => {
  const data = getCachedData();
  res.json({
    synced: !!data,
    lastSync: getLastSyncTime(),
    trades: data ? data.o.trades : 0,
    lastMonth: data ? data.mpnl[data.mpnl.length - 1].mu : null
  });
});

// ===== ADMIN: USER MANAGEMENT =====
app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, analyst_id, display_name, created_at FROM users').all();
  res.json(users);
});

app.post('/api/users', requireAdmin, (req, res) => {
  const { username, password, role, analyst_id, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare('INSERT INTO users (username, password, role, analyst_id, display_name) VALUES (?, ?, ?, ?, ?)').run(
      username, hash, role || 'analyst', analyst_id || null, display_name || username
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: 'Username already exists' });
  }
});

app.put('/api/users/:id', requireAdmin, (req, res) => {
  const { password, role, analyst_id, display_name } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (password) {
    const hash = bcrypt.hashSync(password, 10);
    db.prepare('UPDATE users SET password = ?, role = ?, analyst_id = ?, display_name = ? WHERE id = ?').run(
      hash, role || user.role, analyst_id || user.analyst_id, display_name || user.display_name, req.params.id
    );
  } else {
    db.prepare('UPDATE users SET role = ?, analyst_id = ?, display_name = ? WHERE id = ?').run(
      role || user.role, analyst_id || user.analyst_id, display_name || user.display_name, req.params.id
    );
  }
  res.json({ success: true });
});

app.delete('/api/users/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== FLAGS & OVERRIDES =====

// GET all flags
app.get('/api/flags', requireAuth, (req, res) => {
  const flags = db.prepare('SELECT * FROM flags ORDER BY created_at DESC').all();
  res.json(flags);
});

// POST a new flag (any user can flag)
app.post('/api/flags', requireAuth, (req, res) => {
  const { trade_id, sym, an, dir, d, reason } = req.body;
  if (!sym || !an || !dir) return res.status(400).json({ error: 'sym, an, dir required' });
  const flaggedBy = req.session.user.display_name || req.session.user.username;
  db.prepare('INSERT INTO flags (trade_id, sym, an, dir, d, reason, flagged_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    trade_id || null, sym, an, dir, d || null, reason || '', flaggedBy
  );
  res.json({ success: true });
});

// DELETE a flag (admin only)
app.delete('/api/flags/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM flags WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Update flag status (admin only)
app.put('/api/flags/:id', requireAdmin, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE flags SET status = ? WHERE id = ?').run(status || 'resolved', req.params.id);
  res.json({ success: true });
});

// GET all overrides
app.get('/api/overrides', requireAuth, (req, res) => {
  const overrides = db.prepare('SELECT * FROM overrides ORDER BY created_at DESC').all();
  res.json(overrides);
});

// POST a new override (admin only)
app.post('/api/overrides', requireAdmin, (req, res) => {
  const { trade_id, sym, an, dir, d, entry, exit_val, rr } = req.body;
  if (!sym || !an || !dir) return res.status(400).json({ error: 'sym, an, dir required' });
  const overriddenBy = req.session.user.display_name || req.session.user.username;
  // Remove any existing override for same trade
  db.prepare('DELETE FROM overrides WHERE sym = ? AND an = ? AND dir = ? AND d = ?').run(sym, an, dir, d || null);
  db.prepare('INSERT INTO overrides (trade_id, sym, an, dir, d, entry, exit_val, rr, overridden_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    trade_id || null, sym, an, dir, d || null, entry || 0, exit_val || 0, rr || 0, overriddenBy
  );
  // Mark matching flag as resolved
  db.prepare("UPDATE flags SET status = 'resolved' WHERE sym = ? AND an = ? AND dir = ? AND (d = ? OR d IS NULL)").run(sym, an, dir, d || null);
  res.json({ success: true });
});

// DELETE an override (admin only)
app.delete('/api/overrides/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM overrides WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ===== ANALYST DATA FILTERING =====
function filterForAnalyst(D, aid) {
  const F = JSON.parse(JSON.stringify(D)); // deep clone

  // Overview: keep mpnl, eq, yr, o, mdc, mde but remove analyst identifiers
  // Remove analyst leaderboard from md
  if (F.md) {
    Object.keys(F.md).forEach(k => {
      if (F.md[k].lb) F.md[k].lb = [];
    });
  }

  // AM: only this analyst
  if (F.am) {
    const myAm = F.am[aid] || [];
    F.am = {};
    F.am[aid] = myAm;
  }

  // AD: only this analyst
  if (F.ad) {
    const myAd = F.ad[aid] || [];
    F.ad = {};
    F.ad[aid] = myAd;
  }

  // AEQ: only this analyst
  if (F.aeq) {
    const myAeq = F.aeq[aid] || [];
    F.aeq = {};
    F.aeq[aid] = myAeq;
  }

  // REC: only this analyst
  if (F.rec) {
    const myRec = F.rec[aid] || [];
    F.rec = {};
    F.rec[aid] = myRec;
  }

  // KH: only this analyst
  if (F.kh) {
    const myKh = F.kh[aid] || [];
    F.kh = {};
    F.kh[aid] = myKh;
  }

  // AS (analyst seasonals): only this analyst
  if (F.as) {
    const myAs = F.as[aid] || {};
    F.as = {};
    F.as[aid] = myAs;
  }

  // ATGR: only this analyst
  if (F.atgr) {
    const myAtgr = F.atgr[aid] || 0;
    F.atgr = {};
    F.atgr[aid] = myAtgr;
  }

  // COV: only this analyst
  if (F.cov) {
    const myCov = F.cov[aid] || [];
    F.cov = {};
    F.cov[aid] = myCov;
  }

  // DD: filter trades to only this analyst (so monitor only shows their trades)
  if (F.dd) {
    Object.keys(F.dd).forEach(dk => {
      const dd = F.dd[dk];
      dd.t = dd.t.filter(t => t.an === aid);
      // Rebuild ba for this analyst only
      dd.ba = {};
      const live = dd.t.filter(t => t.st === 'live');
      if (live.length > 0) {
        dd.ba[aid] = {
          n: live.length,
          w: live.filter(t => t.rr > 0).length,
          rr: Math.round(live.reduce((s, t) => s + t.rr, 0) * 100) / 100
        };
      }
    });
  }

  // N: keep all names (needed for Schedule to show coverage assignments)
  // F.n is preserved as-is

  // A: only this analyst's overall stats
  if (F.a) {
    F.a = F.a.filter(a => a.id === aid);
  }

  // Keep realloc data so analysts can see Schedule (market allocations & holidays)
  // F.realloc is preserved as-is

  // Flag which tabs are hidden
  F._role = 'analyst';
  F._analyst_id = aid;

  return F;
}

// ===== CATCH-ALL: Serve the app =====
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`Acuity Dashboard running on port ${PORT}`);

  // Check if admin user exists
  const admin = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
  if (!admin) {
    console.log('\n⚠️  No admin user found. Run: node setup-admin.js');
    console.log('   Or set ADMIN_PASSWORD env var and restart.\n');

    // Auto-create admin if ADMIN_PASSWORD is set
    if (process.env.ADMIN_PASSWORD) {
      const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
      db.prepare('INSERT OR IGNORE INTO users (username, password, role, display_name) VALUES (?, ?, ?, ?)').run(
        'admin', hash, 'admin', 'Administrator'
      );
      console.log('✅ Admin user created from ADMIN_PASSWORD env var');
    }
  }

  // Auto-create analyst users with individual passwords
  const analysts = [
    { username: 'ian.coleman', password: 'Acuity_Ian2026!', analyst_id: 'IAN', display_name: 'Ian Coleman' },
    { username: 'khaled.gad', password: 'Acuity_Khaled2026!', analyst_id: 'KG', display_name: 'Khaled Gad' },
    { username: 'maged.darwish', password: 'Acuity_Maged2026!', analyst_id: 'MAG', display_name: 'Maged Darwish' },
    { username: 'mona.hassan', password: 'Acuity_Mona2026!', analyst_id: 'MOH', display_name: 'Mona Hassan' },
    { username: 'tibor.vrbovsky', password: 'Acuity_Tibor2026!', analyst_id: 'TIV', display_name: 'Tibor Vrbovsky' }
  ];

  analysts.forEach(a => {
    const existing = db.prepare('SELECT id FROM users WHERE analyst_id = ?').get(a.analyst_id);
    if (!existing) {
      const pw = process.env['PW_' + a.analyst_id] || a.password;
      const hash = bcrypt.hashSync(pw, 10);
      db.prepare('INSERT INTO users (username, password, role, analyst_id, display_name) VALUES (?, ?, ?, ?, ?)').run(
        a.username, hash, 'analyst', a.analyst_id, a.display_name
      );
      console.log('  ✅ Created ' + a.display_name + ' (' + a.username + ')');
    }
  });
  console.log('Analyst accounts ready');

  // Start API auto-sync
  startAutoSync();
});
