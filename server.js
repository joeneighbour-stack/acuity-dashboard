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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS holidays (
      id SERIAL PRIMARY KEY,
      analyst TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      realloc TEXT DEFAULT '{}',
      created_by TEXT,
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

// ===== HOLIDAYS =====
app.get('/api/holidays', requireAuth, async (req, res) => {
  const rows = await dbAll('SELECT * FROM holidays ORDER BY start_date DESC');
  const holidays = rows.map(r => ({
    id: r.id,
    analyst: r.analyst,
    start: r.start_date,
    end: r.end_date,
    realloc: JSON.parse(r.realloc || '{}'),
    created_by: r.created_by
  }));
  res.json(holidays);
});

app.post('/api/holidays', requireAuth, async (req, res) => {
  const { analyst, start, end, realloc } = req.body;
  if (!analyst || !start || !end) return res.status(400).json({ error: 'analyst, start, end required' });
  const createdBy = req.session.user.display_name || req.session.user.username;
  await dbRun('INSERT INTO holidays (analyst, start_date, end_date, realloc, created_by) VALUES ($1,$2,$3,$4,$5)',
    [analyst, start, end, JSON.stringify(realloc || {}), createdBy]);
  res.json({ success: true });
});

app.put('/api/holidays/:id', requireAuth, async (req, res) => {
  const { analyst, start, end, realloc } = req.body;
  await dbRun('UPDATE holidays SET analyst=$1, start_date=$2, end_date=$3, realloc=$4 WHERE id=$5',
    [analyst, start, end, JSON.stringify(realloc || {}), req.params.id]);
  res.json({ success: true });
});

app.delete('/api/holidays/:id', requireAuth, async (req, res) => {
  await dbRun('DELETE FROM holidays WHERE id = $1', [req.params.id]);
  res.json({ success: true });
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
        F.md[k] = { lb: [], b5: [], w5: [], eq: [], tgr: 0 };
      }
    });
  } else {
    Object.keys(F.md).forEach(k => { if (F.md[k].lb) F.md[k].lb = []; });
  }
  delete F.amd;

  // Replace mpnl with analyst's own monthly data
  let myMpnl = [];
  if (F.am && F.am[aid]) {
    const myAm = F.am[aid];
    myMpnl = myAm.map(m => ({
      m: '20' + m.m.substring(0, 2) + '-' + m.m.substring(3, 5),
      mu: m.mu, ret: m.ret, n: m.n, w: m.w, wr: m.wr,
      dd: m.dd, rr: m.rr, tgr: m.tgr, y: '20' + m.m.substring(0, 2)
    }));
    F.mpnl = myMpnl;
  }

  // Rebuild equity curve from analyst's mpnl
  if (myMpnl.length > 0) {
    let eqF = 1000, eqS = 1000, peakF = 1000, peakS = 1000, maxDDF = 0, maxDDS = 0;
    F.eq = [];
    myMpnl.forEach(p => {
      eqF = Math.round((eqF + p.ret * 10) * 100) / 100;
      eqS = Math.round(eqS * (1 + p.ret / 100) * 100) / 100;
      if (eqF > peakF) peakF = eqF;
      if (eqS > peakS) peakS = eqS;
      const ddF = peakF > 0 ? (peakF - eqF) / peakF * 100 : 0;
      const ddS = peakS > 0 ? (peakS - eqS) / peakS * 100 : 0;
      if (ddF > maxDDF) maxDDF = ddF;
      if (ddS > maxDDS) maxDDS = ddS;
      F.eq.push({ d: p.m, f: Math.round(eqF), s: Math.round(eqS) });
    });

    // Rebuild overall stats
    const totalN = myMpnl.reduce((s, p) => s + p.n, 0);
    const totalW = myMpnl.reduce((s, p) => s + p.w, 0);
    const totalRR = Math.round(myMpnl.reduce((s, p) => s + p.rr, 0) * 10) / 10;
    F.o = {
      trades: totalN, wins: totalW, losses: totalN - totalW,
      winRate: totalN > 0 ? Math.round(totalW / totalN * 1000) / 10 : 0,
      sumRR: totalRR,
      fixedReturn: Math.round((eqF / 10 - 100) * 100) / 100,
      sizedReturn: Math.round((eqS / 10 - 100) * 100) / 100,
      fixedDD: Math.round(maxDDF * 100) / 100,
      sizedDD: Math.round(maxDDS * 100) / 100,
      from: myMpnl[0].mu, to: myMpnl[myMpnl.length - 1].mu
    };

    // Rebuild year summary
    const yrMap = {};
    myMpnl.forEach(p => {
      if (!yrMap[p.y]) yrMap[p.y] = { n: 0, w: 0, rr: 0 };
      yrMap[p.y].n += p.n; yrMap[p.y].w += p.w; yrMap[p.y].rr += p.rr;
    });
    F.yr = Object.entries(yrMap).sort().map(([y, d]) => ({
      y, n: d.n, w: d.w, wr: d.n > 0 ? Math.round(d.w / d.n * 1000) / 10 : 0,
      rr: Math.round(d.rr * 10) / 10
    }));

    // Rebuild monthly seasonals from analyst's AS data (full history) + base
    const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    if (F.as && F.as[aid] && F.as[aid].moy) {
      F.sm = F.as[aid].moy.map(m => ({ n: m.n, v: m.v }));
    } else {
      F.sm = MN.map(n => ({ n, v: 0 }));
      myMpnl.forEach(p => {
        const mi = parseInt(p.m.slice(5)) - 1;
        if (mi >= 0 && mi < 12) F.sm[mi].v = Math.round((F.sm[mi].v + p.rr) * 10) / 10;
      });
    }
  }

  // Use AS (analyst seasonals) for day-of-week (full trade history, not just last 30 days)
  if (F.as && F.as[aid] && F.as[aid].dow) {
    F.sd = F.as[aid].dow.map(d => ({ n: d.n, v: d.v }));
  } else if (F.dd) {
    // Fallback: rebuild from dd (last 30 days only)
    F.sd = [{ n: 'Mon', v: 0 }, { n: 'Tue', v: 0 }, { n: 'Wed', v: 0 }, { n: 'Thu', v: 0 }, { n: 'Fri', v: 0 }];
    Object.entries(F.dd).forEach(([dateStr, dayData]) => {
      if (dayData.t) {
        const dow = new Date(dateStr + 'T12:00:00Z').getUTCDay();
        dayData.t.forEach(t => {
          if (t.an === aid && t.st === 'live' && dow >= 1 && dow <= 5) {
            F.sd[dow - 1].v = Math.round((F.sd[dow - 1].v + t.rr) * 10) / 10;
          }
        });
      }
    });
  }

  // Filter DD (day drill) to only this analyst's trades
  if (F.dd) {
    Object.keys(F.dd).forEach(k => {
      const dayData = F.dd[k];
      if (dayData.t) {
        dayData.t = dayData.t.filter(t => t.an === aid);
        // Recalculate ba for this analyst only
        const live = dayData.t.filter(t => t.st === 'live');
        dayData.ba = {};
        if (live.length > 0) {
          dayData.ba[aid] = {
            n: live.length,
            w: live.filter(t => t.rr > 0).length,
            rr: Math.round(live.reduce((s, t) => s + t.rr, 0) * 100) / 100
          };
        }
        dayData.nl = live.length;
        dayData.np = dayData.t.length - live.length;
      }
    });
  }

  // Filter DP (daily performance) to analyst's trades
  if (F.dp) {
    // Rebuild dp from filtered dd
    F.dp = F.dp.map(day => {
      const ddDay = F.dd[day.d];
      if (!ddDay) return day;
      const live = (ddDay.t || []).filter(t => t.st === 'live');
      return {
        d: day.d,
        n: live.length,
        w: live.filter(t => t.rr > 0).length,
        rr: Math.round(live.reduce((s, t) => s + t.rr, 0) * 100) / 100,
        tgr: ddDay.t.length > 0 ? Math.round(live.length / ddDay.t.length * 1000) / 10 : 0,
        nl: live.length,
        np: ddDay.t.length - live.length
      };
    });
  }

  // Clear global mde and mdc so MonthDrill falls back to analyst-specific md.eq from amd
  F.mde = {};
  F.mdc = {};

  // Rebuild SR (asset rankings) from analyst's trades in dd
  if (F.dd) {
    const symRRAll = {};
    const symRRByYr = {};
    Object.entries(F.dd).forEach(([dateStr, dayData]) => {
      const yr = dateStr.substring(0, 4);
      (dayData.t || []).forEach(t => {
        if (t.st === 'live') {
          if (!symRRAll[t.sym]) symRRAll[t.sym] = { n: 0, w: 0, rr: 0 };
          symRRAll[t.sym].n++; if (t.rr > 0) symRRAll[t.sym].w++;
          symRRAll[t.sym].rr = Math.round((symRRAll[t.sym].rr + t.rr) * 10) / 10;
          if (!symRRByYr[yr]) symRRByYr[yr] = {};
          if (!symRRByYr[yr][t.sym]) symRRByYr[yr][t.sym] = { n: 0, w: 0, rr: 0 };
          symRRByYr[yr][t.sym].n++; if (t.rr > 0) symRRByYr[yr][t.sym].w++;
          symRRByYr[yr][t.sym].rr = Math.round((symRRByYr[yr][t.sym].rr + t.rr) * 10) / 10;
        }
      });
    });
    // Also add from mpnl-era ss data if available (pre-API base has ss per symbol)
    // For now, sr from dd covers the last 30 days only, which is limited
    // Better: rebuild from analyst's rec data which has more history
  }

  // Rebuild SR from rec (recent trades - last 30 days per analyst)
  if (F.rec && F.rec[aid]) {
    const symRRAnal = {};
    F.rec[aid].forEach(t => {
      if (t.st === 'live' || t.rr !== 0) {
        if (!symRRAnal[t.sym]) symRRAnal[t.sym] = { n: 0, w: 0, rr: 0 };
        symRRAnal[t.sym].n++; if (t.rr > 0) symRRAnal[t.sym].w++;
        symRRAnal[t.sym].rr = Math.round((symRRAnal[t.sym].rr + t.rr) * 10) / 10;
      }
    });
    // Use ss (symbol stats) which is already built per-analyst in api-sync but not filtered here
    // Actually ss is global - we need to keep it as-is for Asset Drill which uses D.ss
    // For the rankings we'll use what we can from the mpnl period
  }

  // Best approach: use the analyst's AM data to rebuild all-time sr
  // The AM doesn't have per-symbol data but the ss (setup stats) does per-analyst breakdowns
  // For now, filter the global sr to only include symbols the analyst has traded
  // This at least shows their personal RR per symbol
  if (F.ss) {
    // ss has per-analyst breakdown in .ba array
    const mySymRR = {};
    Object.entries(F.ss).forEach(([sym, data]) => {
      if (data.ba) {
        const myBA = data.ba.find(b => b.a === aid);
        if (myBA && myBA.n > 0) {
          mySymRR[sym] = { s: sym, c: data.cat || '', n: myBA.n, w: myBA.w, wr: Math.round(myBA.w / myBA.n * 1000) / 10, rr: myBA.rr };
        }
      }
    });
    const mySorted = Object.values(mySymRR).sort((a, b) => b.rr - a.rr);
    F.sr = { all: mySorted };
    // Add year breakdowns from yr
    if (F.yr) {
      F.yr.forEach(y => { F.sr[y.y] = mySorted; }); // same data for now
    }
  }

  if (F.am) { const my = F.am[aid] || []; F.am = {}; F.am[aid] = my; }
  if (F.aeq) { const my = F.aeq[aid] || []; F.aeq = {}; F.aeq[aid] = my; }
  if (F.rec) { const my = F.rec[aid] || []; F.rec = {}; F.rec[aid] = my; }
  if (F.kh) { const my = F.kh[aid] || []; F.kh = {}; F.kh[aid] = my; }
  if (F.as) { const my = F.as[aid] || {}; F.as = {}; F.as[aid] = my; }
  if (F.atgr) { const my = F.atgr[aid] || 0; F.atgr = {}; F.atgr[aid] = my; }
  // Keep cov (coverage) unfiltered - Schedule needs all analysts' markets
  // if (F.cov) - deliberately NOT filtering
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
