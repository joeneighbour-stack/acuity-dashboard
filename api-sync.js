/**
 * API Sync Module
 * Fetches trade data from the n8n webhook API and transforms it into dashboard format.
 * 
 * Architecture:
 * - Base data (2017-2020) is baked in from dashboard_data.json (API only has 2021+)
 * - 2021+ data is rebuilt fresh from the API on every sync
 * - Sync happens on startup, then every SYNC_INTERVAL hours, or on-demand via /api/sync
 */

const fs = require('fs');
const path = require('path');

// ===== CONFIGURATION =====
const API_URL = process.env.TRADE_API_URL || 'https://n8n.srv1104653.hstgr.cloud/webhook/624da439-ad1f-40a5-bc82-f011a54af377';
const API_USER = process.env.TRADE_API_USER || 'product';
const API_PASS = process.env.TRADE_API_PASS || 'barcelona123';
const SYNC_INTERVAL = parseInt(process.env.SYNC_INTERVAL_HOURS || '6') * 60 * 60 * 1000;
const API_START_DATE = '2022-01-01'; // API has reliable data from 2022+ (2021 is incomplete)

// ===== SYMBOL MAPPING =====
const SYM_MAP = {
  'UK100': 'FTSE', 'CHN50': 'China A50', 'NIK225': 'NIKKEI', 'FRA40': 'CAC',
  'US30': 'DOW', 'US100': 'NASDAQ', 'GER40': 'DAX', 'US500': 'SP500',
  'NatGas': 'Natural Gas', 'Natural Gas.1': 'Natural Gas',
  'WTI': 'Oil', 'WTI ': 'Oil',
  'XCUUSD': 'Copper', 'XRP': 'Ripple',
  'BNBUSD': 'Binance Coin', 'BCHUSD': 'Bitcoin Cash',
  'XLMUSD': 'Stellar', 'EOS': 'EOS',
  'S&P 500 Futures': 'SP500',
  'SSE Comp': 'SSE COMP',
  'Advanced Micro Devices': 'AMD', 'Micron Technology': 'MU',
  'Cisco Systems ': 'CSCO', 'Cisco Systems': 'CSCO',
  'Facebook': 'Meta', 'Meta': 'Meta',
  'Apple': 'AAPL', 'Intel Corporation': 'Intel',
  'Palo Alto Networks': 'PANW', 'PayPal': 'PYPL',
  'Salesforce': 'CRM', 'Shopify': 'SHOP',
  'Beyond Meat ': 'BYND', 'Beyond Meat': 'BYND',
  'GameStop': 'GME', 'Moderna': 'MRNA',
  'Plug Power': 'PLUG', 'FuelCell Energy': 'FCEL',
  'Coinbase': 'COIN', 'Roblox': 'RBLX',
  'Netflix': 'Netflix', 'Microsoft': 'MSFT',
  'NVIDIA': 'NVDA', 'Delivery Hero': 'DHER',
  'Walt Disney': 'DIS',
  'Nike Inc': 'Nike', 'Nike': 'Nike',
  'Rolls Royce (RR.)': 'Rolls Royce',
  'BP. (BP.)': 'BP',
  'Unilever (ULVR)': 'Unilever',
  'Abbott Labratories': 'Abbott',
  'Bristol-Myers Squibb Co': 'BMY',
  'Procter and Gamble Co': 'PG',
  'Merck and Company': 'MRK',
  'Johnson and Johnson': 'JNJ',
  'Chevron Corporation': 'CVX',
  'Exxon Mobile': 'XOM',
  'General Electric Company': 'GE',
  'General Motors Company': 'GM',
  'The Boeing Company': 'Boeing',
  'JPMorgan Chase': 'JPM',
  'Charles Schwab Corporation': 'SCHW',
  'Lockheed Martin Corporation': 'LMT',
  'Home Depot Inc': 'HD',
  'Lululemon Athletica': 'LULU', 'Lulumelon Athletica': 'LULU',
  'Waste Management, Inc': 'WM',
  'Neurocrine Biosciences, Inc.': 'NBIX',
  'New York Times Co': 'NYT',
  'Tractor Supply': 'TSCO',
  'The Trade Desk': 'TTD',
  'Dollar General': 'DG',
  'Nextera Energy': 'NEE',
  'Wells Fargo': 'WFC',
  'Morgan Stanley': 'MS',
  'Hecla Mining Company': 'HL',
  'Comerica Incorporated': 'Comerica Incorporated',
  'Wayfair Inc': 'Wayfair Inc',
  'Bank of America Corp': 'Bank of America Corp',
  'Palantir Technology': 'Palantir Technology',
  'Uber Technologies': 'Uber Technologies',
  ' LYFT Inc': 'LYFT', 'LYFT Inc': 'LYFT',
  'TMUS': 'T-Mobile',
  'Humana Inc': 'HUM',
  'PG&E Corporation': 'PCG',
  'LINK': 'LINK',
  'IOTA': 'IOTA',
  'MELI': 'MELI',
  'GNRC': 'GNRC',
  'IFF': 'IFF',
  'AME': 'AME',
  'TXN': 'TXN',
  'BLACKROCK': 'BLK',
};

// ===== AUTHOR NORMALIZATION =====
function normalizeAuthor(raw) {
  if (!raw) return null;
  const a = raw.trim().toUpperCase();
  const map = {
    'IAN': 'IAN', 'IC': 'IAN', 'IAN ': 'IAN',
    'JN': 'JN',
    'JOD': 'JOD',
    'JPW': 'JPW',
    'KG': 'KG',
    'MAG': 'MAG', 'M': 'MAG',
    'MOH': 'MOH', 'MONA': 'MOH', 'MO': 'MOH', 'MPH': 'MOH', 'NOH': 'MOH',
    'MOM': 'MOM',
    'SO': 'SO', 'STEVE TEST': null,
    'TAF': 'TAF',
    'TIV': 'TIV', 'TIVS': 'TIV',
  };
  return map[a] !== undefined ? map[a] : (a.length <= 4 ? a : null);
}

function normalizeSymbol(raw) {
  if (!raw) return null;
  const s = raw.trim();
  return SYM_MAP[s] || s;
}

// ===== CATEGORY MAPPING =====
function categorize(cat, sym) {
  if (cat) return cat;
  // Fallback based on symbol
  const fx = ['EURUSD','GBPUSD','USDJPY','AUDUSD','USDCAD','EURGBP','EURJPY','GBPJPY','USDCHF','EURCHF','EURSEK','GBPAUD','GBPNZD','GBPCHF','AUDJPY','NZDUSD','NZDJPY','EURAUD','EURNZD','USDMXN','USDTRY','AUDCAD','AUDCHF','EURCAD','GBPCAD','NZDCAD','NZDCHF','CADJPY','CHFJPY'];
  const idx = ['SP500','NASDAQ','DOW','FTSE','DAX','CAC','NIKKEI','ASX200','HS50','China A50','SA40','US2000','SSE COMP','EU50'];
  const cmd = ['Gold','Silver','Oil','Brent','Copper','Platinum','Palladium','Natural Gas'];
  const cry = ['Bitcoin','Ethereum','Ripple','Litecoin','Solana','Cardano','Binance Coin','DASH','Monero','LINK','IOTA','EOS','Stellar','NANO','YFI','XTZ','Bitcoin Cash','DOT'];
  if (fx.includes(sym)) return 'FX';
  if (idx.includes(sym)) return 'Indices';
  if (cmd.includes(sym)) return 'Commodities';
  if (cry.includes(sym)) return 'Cryptocurrencies';
  return 'Stocks';
}

// ===== ACTIVE ANALYSTS =====
const ACTIVE = ['IAN', 'KG', 'MAG', 'MOH', 'TIV'];
const NAMES = {
  'IAN': 'Ian Coleman', 'MOH': 'Mona Hassan', 'TIV': 'Tibor Vrbovsky',
  'KG': 'Khaled Gad', 'MAG': 'Maged Darwish', 'JN': 'Joe Neighbour',
  'JOD': 'Joe Damian', 'JPW': 'Jamie Pakenham-Walsh', 'SO': 'Steve OHare',
  'TAF': 'Taf Charlton', 'MOM': 'Mohamed Mohsen'
};

// ===== HELPERS =====
const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function ym(d) { return d.substring(0,7); } // "2026-04-21T..." -> "2026-04"
function ymLabel(m) { return MN[parseInt(m.slice(5))-1] + '-' + m.slice(2,4); } // "2026-04" -> "Apr-26"
function dayOfWeek(ds) { return new Date(ds).getUTCDay(); } // 0=Sun..6=Sat
function dayOfMonth(ds) { return parseInt(ds.substring(8,10)); }
function monthIdx(ds) { return parseInt(ds.substring(5,7)) - 1; } // 0-11
function round1(v) { return Math.round(v * 10) / 10; }
function round2(v) { return Math.round(v * 100) / 100; }

// ===== FETCH FROM API =====
async function fetchTrades(from, to) {
  const auth = Buffer.from(API_USER + ':' + API_PASS).toString('base64');
  console.log(`[API-SYNC] Fetching trades from ${from} to ${to}...`);

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + auth
    },
    body: JSON.stringify({ from, to })
  });

  if (!resp.ok) {
    throw new Error(`API returned ${resp.status}: ${resp.statusText}`);
  }

  const data = await resp.json();
  console.log(`[API-SYNC] Received ${data.length} raw rows`);
  return data;
}

// ===== CLEAN & FILTER ROWS =====
function cleanRows(rawRows) {
  const trades = [];
  const skipped = { noAuthor: 0, badAuthor: 0, noSymbol: 0, testData: 0 };

  for (const r of rawRows) {
    const author = normalizeAuthor(r.Author);
    if (!author) { skipped.badAuthor++; continue; }
    if (!r.Symbol) { skipped.noSymbol++; continue; }
    if (!r.DateStamp) { skipped.noSymbol++; continue; }

    const sym = normalizeSymbol(r.Symbol);
    const cat = categorize(r.Category, sym);
    const rawTriggered = r.Triggered === true || r.Triggered === 'TRUE' || r.Triggered === 'true';
    
    // Only count actually triggered trades - same logic for all years
    const triggered = rawTriggered;
    
    // RR/Ret/Points: only meaningful for triggered trades
    // Non-triggered have garbage exit values from the API
    let rr = 0, pts = 0, ret = 0;
    if (rawTriggered) {
      rr = round2(r.RR || 0);
      pts = round2(r.Points || 0);
      // Cap extreme RR values (data errors in triggered trades)
      if (rr > 50) rr = round2(r.Target_P && r.Stop_P ? r.Target_P / r.Stop_P : 3);
      if (rr < -5) rr = -1;
      // Return: 1% fixed risk model. Each trade risks 1% of equity.
      // Return in equity units (base 1000) = RR * 10
      // e.g., RR=2.0 -> won 2% -> equity adds 20 (from 1000 base)
      ret = round2(rr * 10);
    }

    trades.push({
      id: parseInt(r.Trade_ID) || 0,
      date: r.DateStamp,
      ym: ym(r.DateStamp),
      day: dayOfMonth(r.DateStamp),
      dow: dayOfWeek(r.DateStamp),
      mIdx: monthIdx(r.DateStamp),
      yr: r.DateStamp.substring(0, 4),
      an: author,
      sym: sym,
      cat: cat,
      dir: r.TradeType || 'BUY',
      entry: r.Entry || 0,
      stop: r.Stop || 0,
      target: r.Target || 0,
      exit: r.ExitValue || 0,
      triggered: triggered,
      rawTriggered: rawTriggered, // keep original for trig rate calc
      pts: round2(pts),
      rr: rr,
      stopP: r.Stop_P || 0,
      targetP: r.Target_P || 0,
      ret: ret,
      status: r.StatusText || '',
      st: triggered ? 'live' : 'pending',
    });
  }

  const trigCount = trades.filter(t => t.triggered).length;
  console.log(`[API-SYNC] Cleaned: ${trades.length} valid rows, ${trigCount} triggered. Skipped: ${JSON.stringify(skipped)}`);
  return trades;
}

// ===== BUILD DASHBOARD DATA =====
function buildDashboardData(trades, baseData) {
  // Separate: keep base data for years before API_START_DATE
  const apiStartYear = parseInt(API_START_DATE.substring(0, 4));
  const baseMpnl = baseData.mpnl.filter(p => parseInt(p.m.substring(0, 4)) < apiStartYear);
  const baseYr = baseData.yr.filter(y => parseInt(y.y) < apiStartYear);
  const baseAm = {};
  Object.keys(baseData.am || {}).forEach(a => {
    baseAm[a] = (baseData.am[a] || []).filter(m => {
      const y = parseInt('20' + m.m.substring(0, 2));
      return y < apiStartYear;
    });
  });

  // Count base trades
  let baseTrades = 0, baseWins = 0, baseLosses = 0, baseFlat = 0, baseSumRR = 0;
  let baseLongs = 0, baseShorts = 0;
  baseYr.forEach(y => { baseTrades += y.n; baseWins += y.w; baseSumRR += y.rr; });
  // Use stored base overview for pre-API data
  const baseOverview = {
    trades: baseMpnl.reduce((s, p) => s + p.n, 0),
    wins: baseMpnl.reduce((s, p) => s + p.w, 0),
    sumRR: round1(baseMpnl.reduce((s, p) => s + p.rr, 0)),
  };

  // ===== AGGREGATE API TRADES =====
  // Group by month
  const monthMap = {};
  const analystMonthMap = {}; // { analyst: { ym: [trades] } }
  const symMap = {}; // { symbol: [trades] }
  const yearMap = {}; // { year: [trades] }

  for (const t of trades) {
    // Monthly
    if (!monthMap[t.ym]) monthMap[t.ym] = [];
    monthMap[t.ym].push(t);

    // Analyst-monthly
    if (!analystMonthMap[t.an]) analystMonthMap[t.an] = {};
    if (!analystMonthMap[t.an][t.ym]) analystMonthMap[t.an][t.ym] = [];
    analystMonthMap[t.an][t.ym].push(t);

    // By symbol
    if (!symMap[t.sym]) symMap[t.sym] = [];
    symMap[t.sym].push(t);

    // By year
    if (!yearMap[t.yr]) yearMap[t.yr] = [];
    yearMap[t.yr].push(t);
  }

  // ===== MPNL (Monthly P&L) =====
  const apiMonths = Object.keys(monthMap).sort();
  const apiMpnl = apiMonths.map(m => {
    const mt = monthMap[m];
    const trig = mt.filter(t => t.triggered);
    const n = trig.length;
    const w = trig.filter(t => t.rr > 0).length;
    const wr = n > 0 ? round1(w / n * 100) : 0;
    const rr = round1(trig.reduce((s, t) => s + t.rr, 0));
    // Trig rate: use rawTriggered (actual API field) for 2023+, 0 for pre-2023
    const yearNum = parseInt(m.substring(0, 4));
    const rawTrigCount = mt.filter(t => t.rawTriggered).length;
    const tgr = yearNum >= 2023 ? (mt.length > 0 ? round1(rawTrigCount / mt.length * 100) : 0) : 0;

    // Compute return and drawdown from triggered trades
    // Aggregate by day first, then compute equity curve from daily returns
    const dayRR = {};
    trig.sort((a, b) => a.date.localeCompare(b.date));
    for (const t of trig) {
      const day = t.date.substring(0, 10);
      dayRR[day] = (dayRR[day] || 0) + t.rr;
    }
    const sortedDays = Object.keys(dayRR).sort();
    let eq = 1000, peak = 1000, maxDD = 0;
    for (const day of sortedDays) {
      eq += dayRR[day] * 10; // 1% risk model: RR * 10
      if (eq > peak) peak = eq;
      const dd = peak > 0 ? (peak - eq) / peak * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }
    const ret = round2(eq / 10 - 100);
    const dd = round2(maxDD);

    return {
      m: m,
      mu: ymLabel(m),
      ret: ret,
      n: n,
      w: w,
      wr: wr,
      dd: dd,
      rr: rr,
      tgr: tgr,
      y: m.substring(0, 4)
    };
  });

  const allMpnl = [...baseMpnl, ...apiMpnl];

  // ===== OVERALL STATS =====
  const allTrig = trades.filter(t => t.triggered);
  const apiTrades = allTrig.length;
  const apiWins = allTrig.filter(t => t.rr > 0).length;
  const apiLosses = allTrig.filter(t => t.rr < 0).length;
  const apiFlat = allTrig.filter(t => t.rr === 0).length;
  const apiSumRR = round1(allTrig.reduce((s, t) => s + t.rr, 0));
  const apiLongs = allTrig.filter(t => t.dir === 'BUY').length;
  const apiShorts = allTrig.filter(t => t.dir === 'SELL').length;
  const apiAvgWinP = apiWins > 0 ? round1(allTrig.filter(t => t.rr > 0).reduce((s, t) => s + t.ret, 0) / apiWins) : 0;
  const apiAvgLossP = apiLosses > 0 ? round1(allTrig.filter(t => t.rr < 0).reduce((s, t) => s + t.ret, 0) / apiLosses) : 0;

  const totalTrades = baseOverview.trades + apiTrades;
  const totalWins = baseOverview.wins + apiWins;
  const totalSumRR = round1(baseOverview.sumRR + apiSumRR);

  // Compute equity curve, sharpe, etc from all mpnl
  // Fixed R: each trade risks 1% of INITIAL capital (additive)
  // Sized R: each trade risks 1% of CURRENT equity (multiplicative/compound)
  let eqF = 1000, eqS = 1000, peakF = 1000, peakS = 1000, maxDDF = 0, maxDDS = 0;
  const eqCurve = [];
  const monthRets = [];
  allMpnl.forEach(p => {
    // Fixed R: additive (each month's ret is a percentage of initial 1000)
    eqF = round2(eqF + p.ret * 10); // p.ret is percentage, so +1% = +10 on 1000 base
    // Sized R: compound (each month's ret compounds on current equity)
    eqS = round2(eqS * (1 + p.ret / 100));
    if (eqF > peakF) peakF = eqF;
    if (eqS > peakS) peakS = eqS;
    const ddF = peakF > 0 ? (peakF - eqF) / peakF * 100 : 0;
    const ddS = peakS > 0 ? (peakS - eqS) / peakS * 100 : 0;
    if (ddF > maxDDF) maxDDF = ddF;
    if (ddS > maxDDS) maxDDS = ddS;
    monthRets.push(p.ret);
    eqCurve.push({ d: p.m, f: Math.round(eqF), s: Math.round(eqS) });
  });

  // Win/loss streaks
  let ws = 0, ls = 0, maxWS = 0, maxLS = 0;
  allTrig.sort((a, b) => a.date.localeCompare(b.date));
  for (const t of allTrig) {
    if (t.rr > 0) { ws++; ls = 0; if (ws > maxWS) maxWS = ws; }
    else if (t.rr < 0) { ls++; ws = 0; if (ls > maxLS) maxLS = ls; }
  }

  // Sharpe (annualized from monthly returns)
  const avgRet = monthRets.reduce((s, r) => s + r, 0) / (monthRets.length || 1);
  const stdDev = Math.sqrt(monthRets.reduce((s, r) => s + (r - avgRet) ** 2, 0) / (monthRets.length || 1));
  const sharpe = stdDev > 0 ? round2(avgRet / stdDev * Math.sqrt(12)) : 0;

  const overview = {
    trades: totalTrades,
    wins: totalWins,
    losses: baseMpnl.reduce((s, p) => s + p.n - p.w, 0) + apiLosses + apiFlat,
    flat: apiFlat,
    winRate: round2(totalWins / totalTrades * 100),
    avgWinP: apiAvgWinP,
    avgLossP: apiAvgLossP,
    avgRR: totalTrades > 0 ? round2(totalSumRR / totalTrades * 100) : 0,
    sumRR: totalSumRR,
    longs: apiLongs,
    shorts: apiShorts,
    winStreak: maxWS,
    lossStreak: maxLS,
    fixedReturn: round2(eqF / 10 - 100),
    fixedDD: round2(maxDDF),
    fixedSharpe: sharpe,
    sizedReturn: round2(eqS / 10 - 100),
    sizedDD: round2(maxDDS),
    sizedSharpe: sharpe,
  };

  // ===== ANALYST OVERALL STATS =====
  const analystOverall = {};
  for (const t of trades) {
    if (!analystOverall[t.an]) analystOverall[t.an] = { trig: [], all: [] };
    analystOverall[t.an].all.push(t);
    if (t.triggered) analystOverall[t.an].trig.push(t);
  }

  // Merge with base analyst data
  const allAnalysts = new Set([...(baseData.a || []).map(a => a.id), ...Object.keys(analystOverall)]);
  const analystArray = [];
  for (const aid of allAnalysts) {
    const base = (baseData.a || []).find(a => a.id === aid);
    const api = analystOverall[aid];
    const baseTr = base ? base.tr : 0;
    const apiTr = api ? api.trig.length : 0;
    const baseW = base ? base.w : 0;
    const apiW = api ? api.trig.filter(t => t.rr > 0).length : 0;
    const baseSR = base ? base.sr : 0;
    const apiSR = api ? round1(api.trig.reduce((s, t) => s + t.rr, 0)) : 0;
    const baseTS = base ? base.ts : 0;
    const apiTS = api ? api.all.length : 0;
    const tr = baseTr + apiTr;
    const w = baseW + apiW;

    // Trig rate only from API data (2021+)
    const tgr = apiTS > 0 ? round1(apiTr / apiTS * 100) : (base ? base.tgr : 0);

    analystArray.push({
      id: aid,
      tr: tr,
      w: w,
      wr: tr > 0 ? round1(w / tr * 100) : 0,
      rr: tr > 0 ? round2((baseSR + apiSR) / tr * 100) : 0,
      sr: round1(baseSR + apiSR),
      ts: baseTS + apiTS,
      tgr: tgr,
    });
  }
  analystArray.sort((a, b) => b.sr - a.sr);

  // ===== AM (Analyst Monthly) =====
  const am = {};
  for (const aid of allAnalysts) {
    am[aid] = [...(baseAm[aid] || [])];

    const monthData = analystMonthMap[aid] || {};
    const months = Object.keys(monthData).sort();
    for (const m of months) {
      const mt = monthData[m];
      const trig = mt.filter(t => t.triggered);
      const n = trig.length;
      const w = trig.filter(t => t.rr > 0).length;
      const wr = n > 0 ? round1(w / n * 100) : 0;
      const rr = round1(trig.reduce((s, t) => s + t.rr, 0));
      const allSetups = mt.length;
      const yearNum2 = parseInt(m.substring(0, 4));
      const rawTrigCount2 = mt.filter(t => t.rawTriggered).length;
      const tgr = yearNum2 >= 2023 ? (allSetups > 0 ? round1(rawTrigCount2 / allSetups * 100) : 0) : 0;

      // Compute return & drawdown (aggregate by day first)
      const dayRR2 = {};
      trig.sort((a, b) => a.date.localeCompare(b.date));
      for (const t of trig) {
        const day2 = t.date.substring(0, 10);
        dayRR2[day2] = (dayRR2[day2] || 0) + t.rr;
      }
      const sortedDays2 = Object.keys(dayRR2).sort();
      let eq = 1000, peak = 1000, maxDD = 0;
      for (const day2 of sortedDays2) {
        eq += dayRR2[day2] * 10;
        if (eq > peak) peak = eq;
        const dd = peak > 0 ? (peak - eq) / peak * 100 : 0;
        if (dd > maxDD) maxDD = dd;
      }
      const ret = round2(eq / 10 - 100);
      const dd = round2(maxDD);

      // Best/worst symbol
      const symRR = {};
      trig.forEach(t => { symRR[t.sym] = (symRR[t.sym] || 0) + t.rr; });
      const symEntries = Object.entries(symRR).sort((a, b) => b[1] - a[1]);
      const bs = symEntries.length > 0 ? symEntries[0][0] : '';
      const br = symEntries.length > 0 ? round1(symEntries[0][1]) : 0;
      const ws2 = symEntries.length > 0 ? symEntries[symEntries.length - 1][0] : '';
      const wrs = symEntries.length > 0 ? round1(symEntries[symEntries.length - 1][1]) : 0;

      // Traffic light
      let l = n < 10 ? 'grey' : (wr >= 45 && ret > 0 && dd < 10 && (tgr >= 35 || tgr === 0)) ? 'green' : (wr < 35 || ret < -5 || dd >= 10) ? 'red' : 'amber';

      // Month label: "YY-MM" format
      const mLabel = m.slice(2, 4) + '-' + m.slice(5, 7);

      am[aid].push({
        m: mLabel,
        mu: ymLabel(m),
        ret: ret,
        n: n,
        w: w,
        wr: wr,
        dd: dd,
        rr: rr,
        tgr: tgr,
        l: l,
        bs: bs,
        br: br,
        ws: ws2,
        wrs: wrs,
      });
    }
  }

  // ===== YEAR SUMMARY =====
  const apiYearSummary = [];
  Object.keys(yearMap).sort().forEach(y => {
    const yt = yearMap[y].filter(t => t.triggered);
    const n = yt.length;
    const w = yt.filter(t => t.rr > 0).length;
    apiYearSummary.push({
      y: y,
      n: n,
      w: w,
      wr: n > 0 ? round1(w / n * 100) : 0,
      rr: round1(yt.reduce((s, t) => s + t.rr, 0)),
    });
  });
  const allYr = [...baseYr, ...apiYearSummary];

  // ===== SM/SD (Seasonality - month/day) =====
  const sm = Array(12).fill(null).map((_, i) => ({ n: MN[i], v: 0 }));
  const sd = [{ n: 'Mon', v: 0 }, { n: 'Tue', v: 0 }, { n: 'Wed', v: 0 }, { n: 'Thu', v: 0 }, { n: 'Fri', v: 0 }];
  allMpnl.forEach(p => {
    const mi = parseInt(p.m.slice(5)) - 1;
    sm[mi].v = round1(sm[mi].v + p.rr);
  });
  // Day of week from API trades only
  for (const t of allTrig) {
    const d = t.dow;
    if (d >= 1 && d <= 5) sd[d - 1].v = round1(sd[d - 1].v + t.rr);
  }

  // ===== MD (Month Drill) =====
  const md = {};
  for (const m of apiMonths) {
    const mt = monthMap[m];
    const trig = mt.filter(t => t.triggered);

    // Analyst leaderboard
    const analystMap = {};
    mt.forEach(t => {
      if (!analystMap[t.an]) analystMap[t.an] = { all: [], trig: [] };
      analystMap[t.an].all.push(t);
      if (t.triggered) analystMap[t.an].trig.push(t);
    });

    const lb = Object.entries(analystMap).map(([a, d]) => {
      const at = d.trig;
      const n = at.length;
      const w = at.filter(t => t.rr > 0).length;
      const rr = round1(at.reduce((s, t) => s + t.rr, 0));
      const tgrV = d.all.length > 0 ? round1(n / d.all.length * 100) : 0;
      let eq2 = 1000, peak2 = 1000, maxDD2 = 0;
      at.sort((a2, b) => a2.date.localeCompare(b.date));
      const dayRR3 = {};
      for (const t of at) { const dk = t.date.substring(0, 10); dayRR3[dk] = (dayRR3[dk] || 0) + t.rr; }
      for (const dk of Object.keys(dayRR3).sort()) { eq2 += dayRR3[dk] * 10; if (eq2 > peak2) peak2 = eq2; const dd2 = peak2 > 0 ? (peak2 - eq2) / peak2 * 100 : 0; if (dd2 > maxDD2) maxDD2 = dd2; }
      return {
        a: a,
        n: n,
        w: w,
        wr: n > 0 ? round1(w / n * 100) : 0,
        rr: rr,
        tgr: tgrV,
        dd: round2(maxDD2),
        ret: round2(eq2 / 10 - 100),
      };
    }).sort((a, b) => b.rr - a.rr);

    // Best/worst 5 symbols
    const symRR = {};
    trig.forEach(t => { symRR[t.sym] = (symRR[t.sym] || 0) + t.rr; });
    const sorted = Object.entries(symRR).sort((a, b) => b[1] - a[1]);
    const b5 = sorted.slice(0, 5).map(([s, r]) => ({ s: s, rr: round1(r) }));
    const w5 = sorted.slice(-5).reverse().map(([s, r]) => ({ s: s, rr: round1(r) })).reverse();

    // Daily equity curve
    const dayMap = {};
    trig.sort((a, b) => a.date.localeCompare(b.date));
    let deq = 1000;
    for (const t of trig) {
      deq = round2(deq + t.ret);
      dayMap[t.day] = Math.round(deq);
    }
    const eq = Object.entries(dayMap).map(([d, e]) => ({ d: parseInt(d), eq: e }));

    const allSetups = mt.length;
    const tgrMonth = allSetups > 0 ? round1(trig.length / allSetups * 100) : 0;

    md[m] = { lb, b5, w5, eq, tgr: tgrMonth };
  }

  // Also keep base md
  Object.keys(baseData.md || {}).forEach(k => {
    if (parseInt(k.substring(0, 4)) < apiStartYear) {
      md[k] = baseData.md[k];
    }
  });

  // ===== DD (Day Drill - last 30 calendar days of trading data) =====
  const sortedDates = [...new Set(trades.map(t => t.date.substring(0, 10)))].sort().reverse();
  const last30Days = sortedDates.slice(0, 30);
  const dd = {};
  last30Days.forEach((dateStr) => {
    const dayTrades = trades.filter(t => t.date.substring(0, 10) === dateStr);
    const t = dayTrades.map(t2 => ({
      sym: t2.sym, an: t2.an, dir: t2.dir, pts: t2.pts, rr: t2.rr,
      id: t2.id, st: t2.st, e: t2.entry, ex: t2.exit, stop: t2.stop, tgt: t2.target
    }));

    // BA (by analyst) for triggered trades
    const ba = {};
    const liveTrades = dayTrades.filter(t2 => t2.triggered);
    const analystGroups = {};
    liveTrades.forEach(t2 => {
      if (!analystGroups[t2.an]) analystGroups[t2.an] = [];
      analystGroups[t2.an].push(t2);
    });
    Object.entries(analystGroups).forEach(([a, at]) => {
      ba[a] = {
        n: at.length,
        w: at.filter(t2 => t2.rr > 0).length,
        rr: round2(at.reduce((s, t2) => s + t2.rr, 0))
      };
    });

    const allSetups = dayTrades.length;
    const trigCount = liveTrades.length;
    const pendCount = allSetups - trigCount;

    // Use full date string as key (e.g. "2026-04-22")
    dd[dateStr] = { t, ba, tgr: allSetups > 0 ? round1(trigCount / allSetups * 100) : 0, nl: trigCount, np: pendCount };
  });

  // ===== DP (Daily Performance - last 30 days) =====
  const dp = last30Days.map(dateStr => {
    const dayTrig = trades.filter(t => t.date.substring(0, 10) === dateStr && t.triggered);
    const allDay = trades.filter(t => t.date.substring(0, 10) === dateStr);
    const n = dayTrig.length;
    const w = dayTrig.filter(t => t.rr > 0).length;
    return {
      d: dateStr, // full date string
      n: n,
      w: w,
      rr: round2(dayTrig.reduce((s, t) => s + t.rr, 0)),
      tgr: allDay.length > 0 ? round1(n / allDay.length * 100) : 0,
      nl: n,
      np: allDay.length - n
    };
  }).reverse(); // chronological order

  // ===== AD (Analyst Daily - last 30 days) =====
  const ad = {};
  ACTIVE.forEach(a => {
    ad[a] = last30Days.map(dateStr => {
      const at = trades.filter(t => t.date.substring(0, 10) === dateStr && t.an === a && t.triggered);
      if (at.length === 0) return null;
      return {
        d: dateStr,
        n: at.length,
        w: at.filter(t => t.rr > 0).length,
        rr: round2(at.reduce((s, t) => s + t.rr, 0))
      };
    }).filter(Boolean).reverse();
  });

  // ===== AEQ (Analyst Equity - current month) =====
  const curMonth = apiMonths[apiMonths.length - 1];
  const aeq = {};
  ACTIVE.forEach(a => {
    const mt = (analystMonthMap[a] || {})[curMonth] || [];
    const trig = mt.filter(t => t.triggered);
    trig.sort((a2, b) => a2.date.localeCompare(b.date));
    let eq2 = 1000;
    const points = [{ d: 0, eq: 1000 }];
    const dayEq = {};
    for (const t of trig) {
      eq2 = round2(eq2 + t.ret);
      dayEq[t.day] = Math.round(eq2);
    }
    Object.entries(dayEq).forEach(([d, e]) => {
      points.push({ d: parseInt(d), eq: e });
    });
    aeq[a] = points;
  });

  // ===== REC (Recent recommendations - last 2 days) =====
  const rec = {};
  const recDays = sortedDates.slice(0, 2);
  allAnalysts.forEach(a => {
    rec[a] = [];
    recDays.forEach(dateStr => {
      const dt = trades.filter(t => t.date.substring(0, 10) === dateStr && t.an === a);
      dt.forEach(t => {
        rec[a].push({
          d: dateStr.substring(8, 10) + '/' + dateStr.substring(5, 7) + '/' + dateStr.substring(0, 4),
          sym: t.sym,
          dir: t.dir,
          e: t.entry,
          ex: t.exit || 0,
          stop: t.stop || 0,
          tgt: t.target || 0,
          pts: t.triggered ? t.pts : 0,
          rr: t.triggered ? t.rr : 0,
          id: t.id,
          st: t.st
        });
      });
    });
  });

  // ===== SS (Setup Stats by symbol) =====
  const ss = {};
  // Keep base ss for symbols that might not appear in API
  Object.keys(baseData.ss || {}).forEach(s => { ss[s] = baseData.ss[s]; });
  // Rebuild from API data
  Object.entries(symMap).forEach(([sym, symTrades]) => {
    const trig = symTrades.filter(t => t.triggered);
    const n = trig.length;
    const w = trig.filter(t => t.rr > 0).length;
    const rr = round1(trig.reduce((s2, t) => s2 + t.rr, 0));

    // Equity curve (sampled)
    let eq2 = 1000;
    trig.sort((a, b) => a.date.localeCompare(b.date));
    const eqPoints = [];
    for (let i = 0; i < trig.length; i++) {
      eq2 = round2(eq2 + trig[i].ret);
      if (i % Math.max(1, Math.floor(trig.length / 8)) === 0 || i === trig.length - 1) {
        eqPoints.push({ d: trig[i].ym, eq: Math.round(eq2) });
      }
    }

    // By analyst
    const baMap = {};
    trig.forEach(t => {
      if (!baMap[t.an]) baMap[t.an] = { n: 0, w: 0, rr: 0 };
      baMap[t.an].n++;
      if (t.rr > 0) baMap[t.an].w++;
      baMap[t.an].rr = round1(baMap[t.an].rr + t.rr);
    });
    const ba = Object.entries(baMap)
      .map(([a, d]) => ({ a, n: d.n, w: d.w, wr: round1(d.w / d.n * 100), rr: d.rr }))
      .sort((a, b) => b.rr - a.rr);

    // By year
    const yrMap2 = {};
    trig.forEach(t => {
      if (!yrMap2[t.yr]) yrMap2[t.yr] = { n: 0, w: 0, rr: 0 };
      yrMap2[t.yr].n++;
      if (t.rr > 0) yrMap2[t.yr].w++;
      yrMap2[t.yr].rr = round1(yrMap2[t.yr].rr + t.rr);
    });
    const yr2 = Object.entries(yrMap2).sort(([a], [b]) => a.localeCompare(b))
      .map(([y, d]) => ({ y: parseInt(y), n: d.n, w: d.w, wr: round1(d.w / d.n * 100), rr: d.rr }));

    // Merge with base if exists
    const baseSS = baseData.ss ? baseData.ss[sym] : null;
    const totalN = (baseSS ? baseSS.n : 0) + n;
    const totalW = (baseSS ? baseSS.n * baseSS.wr / 100 : 0) + w;
    const totalRR = (baseSS ? baseSS.rr : 0) + rr;

    ss[sym] = {
      n: totalN,
      w: Math.round(totalW),
      wr: totalN > 0 ? round1(totalW / totalN * 100) : 0,
      rr: round1(totalRR),
      eq: baseSS ? [...(baseSS.eq || []), ...eqPoints] : eqPoints,
      ba: ba,
      yr: baseSS ? [...(baseSS.yr || []).filter(y => !yr2.find(y2 => y2.y === y.y)), ...yr2] : yr2,
    };
  });

  // ===== SR (Symbol Rankings by period) =====
  const sr = {};
  // All-time
  sr.all = Object.entries(ss)
    .map(([s, d]) => ({ s, c: categorize(null, s), n: d.n, w: d.w, wr: d.wr, rr: d.rr }))
    .sort((a, b) => b.rr - a.rr);
  // By year
  allYr.forEach(y => {
    const yearTrig = allTrig.filter(t => t.yr === y.y);
    const yrSymRR = {};
    yearTrig.forEach(t => {
      if (!yrSymRR[t.sym]) yrSymRR[t.sym] = { n: 0, w: 0, rr: 0 };
      yrSymRR[t.sym].n++;
      if (t.rr > 0) yrSymRR[t.sym].w++;
      yrSymRR[t.sym].rr = round1(yrSymRR[t.sym].rr + t.rr);
    });
    sr[y.y] = Object.entries(yrSymRR)
      .map(([s, d]) => ({ s, c: categorize(null, s), n: d.n, w: d.w, wr: round1(d.w / d.n * 100), rr: d.rr }))
      .sort((a, b) => b.rr - a.rr);
  });

  // ===== KH (KPI History) =====
  const kh = {};
  allAnalysts.forEach(a => {
    const amData = am[a] || [];
    kh[a] = amData.slice(-19).map(m => ({
      mu: m.mu, wr: m.wr, ret: m.ret, dd: m.dd, tgr: m.tgr, rr: m.rr
    }));
  });

  // ===== ATGR (Current month trig rate per analyst) =====
  const atgr = {};
  ACTIVE.forEach(a => {
    const curTrades = (analystMonthMap[a] || {})[curMonth] || [];
    const curTrig = curTrades.filter(t => t.rawTriggered).length;
    atgr[a] = curTrades.length > 0 ? round1(curTrig / curTrades.length * 100) : 0;
  });

  // ===== COV (Coverage / instruments per analyst) =====
  const cov = {};
  ACTIVE.forEach(a => {
    const symCount = {};
    (analystOverall[a] || { all: [] }).all.forEach(t => {
      symCount[t.sym] = (symCount[t.sym] || 0) + 1;
    });
    cov[a] = Object.entries(symCount).sort((a2, b) => b[1] - a2[1]).slice(0, 15).map(([s]) => s);
  });

  // ===== MDC (Month Drill by Category) =====
  const mdc = {};
  apiMonths.forEach(m => {
    const mt = monthMap[m];
    const catMap2 = {};
    mt.forEach(t => {
      if (!catMap2[t.cat]) catMap2[t.cat] = { all: [], trig: [] };
      catMap2[t.cat].all.push(t);
      if (t.triggered) catMap2[t.cat].trig.push(t);
    });
    mdc[m] = Object.entries(catMap2).map(([c, d]) => {
      const n = d.trig.length;
      const w = d.trig.filter(t => t.rr > 0).length;
      const rr = round1(d.trig.reduce((s, t) => s + t.rr, 0));
      let eq2 = 1000, peak2 = 1000, maxDD2 = 0;
      d.trig.sort((a, b) => a.date.localeCompare(b.date));
      const dayRR4 = {};
      for (const t of d.trig) { const dk = t.date.substring(0, 10); dayRR4[dk] = (dayRR4[dk] || 0) + t.rr; }
      for (const dk of Object.keys(dayRR4).sort()) { eq2 += dayRR4[dk] * 10; if (eq2 > peak2) peak2 = eq2; const dd2 = peak2 > 0 ? (peak2 - eq2) / peak2 * 100 : 0; if (dd2 > maxDD2) maxDD2 = dd2; }
      return {
        c: c,
        n: n,
        w: w,
        wr: n > 0 ? round1(w / n * 100) : 0,
        ret: round2(eq2 / 10 - 100),
        dd: round2(maxDD2),
        tgr: parseInt(m.substring(0,4)) >= 2023 ? (d.all.length > 0 ? round1(d.all.filter(t => t.rawTriggered).length / d.all.length * 100) : 0) : 0,
        rr: rr,
      };
    }).sort((a, b) => b.ret - a.ret);
  });

  // ===== MDE (Month Drill Equity - daily equity for recent months) =====
  const mde = {};
  const recentMonths = apiMonths.slice(-15);
  recentMonths.forEach(m => {
    const mt = monthMap[m].filter(t => t.triggered);
    // Aggregate RR by day
    const dayRR5 = {};
    const dayTC = {};
    for (const t of mt) {
      const d = t.day;
      dayRR5[d] = (dayRR5[d] || 0) + t.rr;
      dayTC[d] = (dayTC[d] || 0) + 1;
    }
    let eq2 = 1000;
    const points = [{ d: 0, eq: 1000, tc: 0 }];
    Object.keys(dayRR5).sort((a, b) => parseInt(a) - parseInt(b)).forEach(d => {
      eq2 = Math.round(eq2 + dayRR5[d] * 10);
      points.push({ d: parseInt(d), eq: eq2, tc: dayTC[d] || 0 });
    });
    mde[m] = points;
  });

  // ===== SST (Setup Stats Trig Rate) =====
  const sst = {};
  Object.entries(symMap).forEach(([sym, symTrades]) => {
    // Only use 2023+ trades for trig rate calculation
    const post2023 = symTrades.filter(t => parseInt(t.yr) >= 2023);
    const allS = post2023.length;
    const trigS = post2023.filter(t => t.rawTriggered).length;
    sst[sym] = {
      tgr: allS > 0 ? round1(trigS / allS * 100) : 0,
      cat: categorize(null, sym)
    };
  });
  // Keep base sst for symbols not in API
  Object.keys(baseData.sst || {}).forEach(s => {
    if (!sst[s]) sst[s] = baseData.sst[s];
  });

  // ===== AS (Analyst Seasonals) =====
  const as = {};
  ACTIVE.forEach(a => {
    const at = (analystOverall[a] || { trig: [], all: [] });

    // Day of week
    const dowRR = [0, 0, 0, 0, 0];
    const dowN = [0, 0, 0, 0, 0];
    at.trig.forEach(t => {
      if (t.dow >= 1 && t.dow <= 5) { dowRR[t.dow - 1] += t.rr; dowN[t.dow - 1]++; }
    });
    const dow = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((n, i) => ({
      n: n, v: round1(dowRR[i]), t: dowN[i]
    }));

    // Month of year
    const moyRR = Array(12).fill(0);
    const moyN = Array(12).fill(0);
    at.trig.forEach(t => { moyRR[t.mIdx] += t.rr; moyN[t.mIdx]++; });
    const moy = MN.map((n, i) => ({ n: n, v: round1(moyRR[i]), t: moyN[i] }));

    // Best/worst symbols
    const symRR = {};
    at.trig.forEach(t => {
      if (!symRR[t.sym]) symRR[t.sym] = { rr: 0, n: 0 };
      symRR[t.sym].rr += t.rr;
      symRR[t.sym].n++;
    });
    const symSorted = Object.entries(symRR).sort((a2, b) => b[1].rr - a2[1].rr);
    const best = symSorted.slice(0, 5).map(([s, d]) => ({ s, rr: round1(d.rr), n: d.n }));
    const worst = symSorted.slice(-5).map(([s, d]) => ({ s, rr: round1(d.rr), n: d.n }));

    as[a] = { dow, moy, best, worst };
  });
  // Keep base AS for non-active analysts
  Object.keys(baseData.as || {}).forEach(a => {
    if (!as[a]) as[a] = baseData.as[a];
  });

  // ===== REALLOC (Schedule) =====
  const realloc = baseData.realloc || {};

  // ===== FINAL ASSEMBLY =====
  return {
    o: overview,
    a: analystArray,
    n: NAMES,
    sm: sm,
    sd: sd,
    eq: eqCurve,
    mpnl: allMpnl,
    am: am,
    rec: rec,
    dp: dp,
    ad: ad,
    md: md,
    dd: dd,
    aeq: aeq,
    cov: cov,
    ss: ss,
    yr: allYr,
    mdc: mdc,
    sr: sr,
    mde: mde,
    sst: sst,
    kh: kh,
    as: as,
    atgr: atgr,
    realloc: realloc,
  };
}

// ===== MAIN SYNC FUNCTION =====
let cachedData = null;
let lastSyncTime = null;
let syncInProgress = false;

async function syncData(dbOverrides) {
  if (syncInProgress) {
    console.log('[API-SYNC] Sync already in progress, skipping...');
    return cachedData;
  }

  syncInProgress = true;
  try {
    // Load base data
    const basePath = path.join(__dirname, 'data', 'dashboard_data.json');
    const baseData = JSON.parse(fs.readFileSync(basePath, 'utf8'));

    // Fetch from API: 2022 to today
    const today = new Date();
    const toDate = today.toISOString().substring(0, 10);
    const rawRows = await fetchTrades(API_START_DATE, toDate);

    // Clean and transform
    const trades = cleanRows(rawRows);

    // Apply database overrides to trades
    if (dbOverrides && dbOverrides.length > 0) {
      let applied = 0;
      const monthNames = {Jan:'01',Feb:'02',Mar:'03',Apr:'04',May:'05',Jun:'06',Jul:'07',Aug:'08',Sep:'09',Oct:'10',Nov:'11',Dec:'12'};
      
      for (const ov of dbOverrides) {
        // Find matching trade by trade_id first (most reliable)
        let match = null;
        if (ov.trade_id) {
          match = trades.find(t => String(t.id) === String(ov.trade_id));
        }
        
        // Fallback: match by sym+an+dir+date
        if (!match && ov.sym && ov.an && ov.dir) {
          // Parse the d field which might be "22 Apr" or "22/04/2026" or null
          let dateMatch = null;
          if (ov.d) {
            const parts = ov.d.split(' ');
            if (parts.length === 2 && monthNames[parts[1]]) {
              // "22 Apr" format - match day and month
              const day = parts[0].padStart(2, '0');
              const mon = monthNames[parts[1]];
              dateMatch = '-' + mon + '-' + day;
            } else if (ov.d.includes('/')) {
              // "22/04/2026" format
              const dp = ov.d.split('/');
              dateMatch = dp[2] + '-' + dp[1] + '-' + dp[0];
            }
          }
          
          match = trades.find(t => {
            if (t.sym !== ov.sym || t.an !== ov.an || t.dir !== ov.dir) return false;
            if (dateMatch) return t.date.includes(dateMatch);
            return true; // no date filter - match first by sym/an/dir
          });
        }
        
        if (match) {
          // Apply override values
          if (ov.entry && ov.entry > 0) match.entry = ov.entry;
          if (ov.exit_val && ov.exit_val > 0) match.exit = ov.exit_val;
          
          // Recalculate RR from the (possibly amended) entry, exit, stop
          const risk = match.dir === 'BUY' 
            ? Math.abs(match.entry - match.stop) 
            : Math.abs(match.stop - match.entry);
          const reward = match.dir === 'BUY' 
            ? (match.exit - match.entry) 
            : (match.entry - match.exit);
          const newRR = risk > 0 ? round2(reward / risk) : 0;
          
          // Use calculated RR (always recalculate from entry/exit/stop)
          match.rr = newRR;
          match.pts = round2(reward);
          match.ret = round2(match.rr * 10);
          
          // If trade was pending, mark as triggered
          if (!match.triggered) {
            match.triggered = true;
            match.rawTriggered = true;
            match.st = 'live';
          }
          
          applied++;
        }
      }
      if (applied > 0) console.log(`[API-SYNC] Applied ${applied}/${dbOverrides.length} overrides from database`);
    }

    // Build dashboard data
    cachedData = buildDashboardData(trades, baseData);
    lastSyncTime = new Date();

    console.log(`[API-SYNC] Sync complete. ${cachedData.o.trades} total trades, ${cachedData.mpnl.length} months.`);
    console.log(`[API-SYNC] Latest month: ${cachedData.mpnl[cachedData.mpnl.length - 1].mu} (${cachedData.mpnl[cachedData.mpnl.length - 1].n} trades)`);

    return cachedData;
  } catch (err) {
    console.error('[API-SYNC] Sync failed:', err.message);
    // Fall back to base data if available
    if (!cachedData) {
      const basePath = path.join(__dirname, 'data', 'dashboard_data.json');
      cachedData = JSON.parse(fs.readFileSync(basePath, 'utf8'));
      console.log('[API-SYNC] Falling back to base data');
    }
    return cachedData;
  } finally {
    syncInProgress = false;
  }
}

function getCachedData() {
  return cachedData;
}

function getLastSyncTime() {
  return lastSyncTime;
}

function startAutoSync(getOverrides) {
  // Initial sync
  const ovs = getOverrides ? getOverrides() : [];
  syncData(ovs).catch(err => console.error('[API-SYNC] Initial sync error:', err));

  // Periodic sync
  setInterval(() => {
    const ovs2 = getOverrides ? getOverrides() : [];
    syncData(ovs2).catch(err => console.error('[API-SYNC] Periodic sync error:', err));
  }, SYNC_INTERVAL);

  console.log(`[API-SYNC] Auto-sync started. Interval: ${SYNC_INTERVAL / 3600000}h`);
}

module.exports = { syncData, getCachedData, getLastSyncTime, startAutoSync };
