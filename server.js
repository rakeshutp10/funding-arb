const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const axios   = require('axios');
const path    = require('path');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────────────
//  API KEYS  — set in Railway → your service → Variables
//  NEVER put real keys in this file
// ─────────────────────────────────────────────────────
const DELTA_KEY    = process.env.DELTA_KEY    || '';
const DELTA_SECRET = process.env.DELTA_SECRET || '';
const DCX_KEY      = process.env.DCX_KEY      || '';
const DCX_SECRET   = process.env.DCX_SECRET   || '';

// ─────────────────────────────────────────────────────
//  ERROR HELPER — detailed human-readable error
// ─────────────────────────────────────────────────────
function errMsg(e) {
  if (!e) return 'Unknown error';
  if (e.response) {
    const status = e.response.status;
    const data   = e.response.data;
    const body   = typeof data === 'object' ? JSON.stringify(data) : String(data || '');
    return `HTTP ${status} — ${body.slice(0, 400)}`;
  }
  if (e.code) return `${e.code}: ${e.message}`;
  if (e.message) return e.message;
  return String(e);
}

// ─────────────────────────────────────────────────────
//  DELTA EXCHANGE INDIA
// ─────────────────────────────────────────────────────
const DELTA_BASE = 'https://api.india.delta.exchange';

function dSign(method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', DELTA_SECRET)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function dPub(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA_BASE + ep + qs, {
    timeout: 12000, headers: { Accept: 'application/json' }
  });
  return r.data;
}

async function dAuth(method, ep, query = {}, body = null) {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const qs  = Object.keys(query).length ? '?' + new URLSearchParams(query) : '';
  const bs  = body ? JSON.stringify(body) : '';
  const sig = dSign(method, ep, qs, bs, ts);
  const cfg = {
    method, url: DELTA_BASE + ep + qs, timeout: 12000,
    headers: { 'api-key': DELTA_KEY, timestamp: ts, signature: sig, 'Content-Type': 'application/json' }
  };
  if (body) cfg.data = body;
  return (await axios(cfg)).data;
}

function parseDelta(raw) {
  const list = raw?.result || raw?.data?.result || raw?.data || [];
  const map  = {};
  for (const t of (Array.isArray(list) ? list : [])) {
    const base  = (t.underlying_asset_symbol || '').toUpperCase();
    if (!base) continue;
    const price = parseFloat(t.mark_price || t.last_price || t.close || 0);
    if (price <= 0) continue;
    const fr = parseFloat(t.funding_rate || t.funding_rate_8h || 0);
    map[base] = {
      symbol:      t.symbol || '',
      productId:   t.id || t.product_id,
      price,
      fundingRate: +(fr * 100).toFixed(6),
      volume24h:   parseFloat(t.volume || t.turnover_usd || 0),
      change24h:   parseFloat(t.price_change_percent || 0),
      nextFunding: t.next_funding_realization || null
    };
  }
  return map;
}

// ─── COINDCX ─────────────────────────────────────────
const DCX_BASE        = 'https://api.coindcx.com';
const DCX_PUBLIC_BASE = 'https://public.coindcx.com';

const HTTP_DEFAULTS = {
  timeout: 12000,
  headers: {
    Accept: 'application/json',
    'User-Agent': 'fundarb/14.1.1 (+https://github.com/)'
  }
};

const DCX_MAX_PAIR_PROBES  = parseInt(process.env.DCX_MAX_PAIR_PROBES  || '40', 10);
const DCX_PAIR_CONCURRENCY = parseInt(process.env.DCX_PAIR_CONCURRENCY || '8',  10);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry(fn, label, { retries = 2, baseDelayMs = 400, onRetry = () => {} } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const waitMs = baseDelayMs * (attempt + 1);
      onRetry(`${label} failed (attempt ${attempt + 1}/${retries + 1}): ${errMsg(e)}. Retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

async function cGet(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  return (await axios.get(DCX_BASE + ep + qs, HTTP_DEFAULTS)).data;
}

async function cAuth(ep, bodyObj = {}) {
  const body     = { ...bodyObj, timestamp: Date.now() };
  const jsonBody = JSON.stringify(body);
  const sig      = crypto.createHmac('sha256', DCX_SECRET).update(jsonBody).digest('hex');
  return (await axios.post(DCX_BASE + ep, jsonBody, {
    timeout: 12000,
    headers: {
      ...HTTP_DEFAULTS.headers,
      'X-AUTH-APIKEY':    DCX_KEY,
      'X-AUTH-SIGNATURE': sig,
      'Content-Type':     'application/json'
    }
  })).data;
}

function pairToBase(pair) {
  let s = pair.toUpperCase();
  if (s.startsWith('B-')) s = s.slice(2);          // "BTC_USDT"
  const parts = s.split('_');
  const base  = parts[0];                           // "BTC"
  return base && base.length >= 2 && base.length <= 15 ? base : '';
}

function normalizeFundingRatePct(raw) {
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return 0;
  // Venues send decimal (0.0001 = 0.01%); keep already-percent values as-is
  const pct = Math.abs(n) <= 1 ? n * 100 : n;
  return +pct.toFixed(6);
}

// Very flexible row parser — tries every known field name permutation
// Works for both public.coindcx.com and api.coindcx.com responses
function parseDcxRow(row, knownPair = '') {
  // Resolve pair string from any known field
  let pair = (
    row?.mkt || row?.pair || row?.symbol || row?.coindcx_name ||
    row?.market || row?.name || knownPair || ''
  ).toUpperCase();

  // Normalise pair → must contain USDT or INR, strip B- prefix for base extraction
  if (!pair) return null;
  // Accept B-XXX_USDT, XXX_USDT, XXXUSDT-style
  const isFutures = pair.startsWith('B-') || pair.includes('_USDT') || pair.includes('_INR') || pair.includes('PERP');
  if (!isFutures) return null;

  const base = pairToBase(pair.startsWith('B-') ? pair : 'B-' + pair);
  if (!base) return null;

  const price = parseFloat(
    row?.mp || row?.mark_price || row?.ls || row?.last_price ||
    row?.ltp || row?.close || row?.price || 0
  );
  if (!Number.isFinite(price) || price <= 0) return null;

  const fr = normalizeFundingRatePct(
    row?.fr ?? row?.funding_rate ?? row?.current_funding_rate ??
    row?.predicted_funding_rate ?? row?.next_funding_rate ?? 0
  );

  return {
    base,
    symbol:      pair.startsWith('B-') ? pair : 'B-' + pair,
    price,
    fundingRate: fr,
    volume24h:   parseFloat(row?.v || row?.volume || row?.volume_24h || row?.turnover || 0),
    change24h:   parseFloat(row?.pc || row?.change_24_hour || row?.price_change_24h || 0),
    nextFunding: row?.next_funding_time || row?.next_funding_at || null
  };
}

// ── fetchDCX ─────────────────────────────────────────────────────────────────
async function fetchDCX() {
  const result = { map: {}, ok: false, source: 'none', total: 0, errors: [], steps: [] };
  const log    = (m) => { result.steps.push(m); console.log('[DCX]', m); };

  // ══ STEP 1: public.coindcx.com realtime futures prices ═══════════════════
  log('STEP 1 — public futures realtime endpoint...');
  try {
    const r = await withRetry(
      () => axios.get(`${DCX_PUBLIC_BASE}/market_data/v3/current_prices/futures/rt`, HTTP_DEFAULTS),
      'public futures/rt', { onRetry: log }
    );
    const list = Array.isArray(r.data) ? r.data
               : (Array.isArray(r.data?.data) ? r.data.data : []);
    log(`  Raw rows: ${list.length}${list[0] ? ' | Sample keys: ' + Object.keys(list[0]).join(', ') : ''}`);

    for (const row of list) {
      const parsed = parseDcxRow(row);
      if (!parsed) continue;
      result.map[parsed.base] = {
        symbol: parsed.symbol, price: parsed.price,
        fundingRate: parsed.fundingRate, volume24h: parsed.volume24h,
        change24h: parsed.change24h, nextFunding: parsed.nextFunding
      };
    }
    if (Object.keys(result.map).length > 0) {
      result.ok = true; result.source = 'public futures/rt';
      result.total = Object.keys(result.map).length;
      log(`  ✅ ${result.total} coins from public futures/rt`);
      return result;
    }
    log('  ⚠️ 0 usable rows — trying fallback');
  } catch (e) {
    const m = `public futures/rt failed: ${errMsg(e)}`;
    log(`  ❌ ${m}`); result.errors.push(m);
  }

  // ══ STEP 2: active_instruments → build pair list ══════════════════════════
  log('STEP 2 — active_instruments (pair list)...');
  let pairList = [];
  for (const mode of ['USDT', 'INR']) {
    const url = `${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=${mode}`;
    try {
      const r   = await withRetry(() => axios.get(url, HTTP_DEFAULTS), `active_instruments[${mode}]`, { onRetry: log });
      const raw = r.data;
      if (Array.isArray(raw)) {
        raw.forEach(item => {
          const ps = typeof item === 'string' ? item : (item.pair || item.symbol || item.coindcx_name || '');
          if (ps && ps.toUpperCase().startsWith('B-')) pairList.push(ps.toUpperCase());
        });
        log(`  [${mode}] ${raw.length} items → ${pairList.length} B-* pairs so far`);
      }
    } catch (e) {
      const m = `active_instruments[${mode}]: ${errMsg(e)}`;
      log(`  ❌ ${m}`); result.errors.push(m);
    }
  }
  pairList     = Array.from(new Set(pairList));
  result.total = pairList.length;
  if (!pairList.length) {
    result.errors.push('active_instruments returned 0 pairs — CoinDCX API unreachable from this server.');
    return result;
  }

  // ══ STEP 3: /exchange/ticker — spot prices (bulk, one call) ══════════════
  // This endpoint reliably returns ALL spot tickers; we use it as a price proxy
  log('STEP 3 — /exchange/ticker for spot price lookup...');
  const tickerMap = {}; // "BTCUSDT" → ticker obj
  try {
    const arr = await withRetry(() => cGet('/exchange/ticker'), '/exchange/ticker', { onRetry: log });
    if (Array.isArray(arr)) {
      arr.forEach(t => {
        const m = (t.market || '').toUpperCase();
        if (m) tickerMap[m] = t;
      });
      log(`  ✅ ${Object.keys(tickerMap).length} spot tickers loaded`);
    }
  } catch (e) {
    const m = `/exchange/ticker failed: ${errMsg(e)}`;
    log(`  ❌ ${m}`); result.errors.push(m);
  }

  // ══ STEP 4: Try per-pair /instrument for funding rates (first 20 only) ════
  log('STEP 4 — per-pair funding rates (sample)...');
  const fundingMap = {}; // base → fundingRate %
  const samplePairs = pairList.filter(p => p.endsWith('_USDT')).slice(0, 20);
  const instrUrl    = `${DCX_BASE}/exchange/v1/derivatives/futures/data/instrument`;
  const instrChunks = [];
  for (let i = 0; i < samplePairs.length; i += 5) instrChunks.push(samplePairs.slice(i, i + 5));

  for (const batch of instrChunks) {
    const recs = await Promise.all(batch.map(async (pair) => {
      try {
        const r     = await axios.get(instrUrl, { ...HTTP_DEFAULTS, timeout: 8000, params: { pair, margin_currency_short_name: 'USDT' } });
        const instr = r.data?.instrument || r.data || {};
        const base  = pairToBase(pair);
        const fr    = normalizeFundingRatePct(instr?.funding_rate || instr?.current_funding_rate || 0);
        const price = parseFloat(instr?.mark_price || instr?.last_price || 0);
        return { base, fr, price };
      } catch (_) { return null; }
    }));
    recs.forEach(r => { if (r?.base) fundingMap[r.base] = { fr: r.fr, price: r.price }; });
  }
  log(`  Funding rates fetched for ${Object.keys(fundingMap).length} coins`);

  // ══ STEP 5: Build result map ══════════════════════════════════════════════
  log(`STEP 5 — building map from ${pairList.length} pairs...`);
  let hits = 0, misses = 0;

  for (const pair of pairList) {
    if (!pair.endsWith('_USDT')) continue; // skip INR pairs to avoid duplicates
    const base    = pairToBase(pair);
    if (!base) { misses++; continue; }

    // Price: prefer instrument data, fall back to spot ticker
    const instrData = fundingMap[base];
    let price = instrData?.price || 0;
    if (price <= 0) {
      const spotKey = base + 'USDT';
      const ticker  = tickerMap[spotKey];
      price = parseFloat(ticker?.last_price || 0);
    }
    if (price <= 0) { misses++; continue; }

    const fr = instrData?.fr || 0;
    const spotTicker = tickerMap[base + 'USDT'];

    result.map[base] = {
      symbol:      pair,
      price,
      fundingRate: fr,
      volume24h:   parseFloat(spotTicker?.volume || 0),
      change24h:   parseFloat(spotTicker?.change_24_hour || 0),
      nextFunding: null
    };
    hits++;
  }

  log(`  Hits: ${hits} | Misses (no price): ${misses}`);

  if (hits > 0) {
    result.ok     = true;
    result.source = 'active_instruments + ticker (spot proxy)';
    log(`  ✅ ${hits} coins ready`);
  } else {
    log('  ❌ 0 coins — CoinDCX data unavailable.');
    result.errors.push('No CoinDCX data. Ticker keys sample: ' + Object.keys(tickerMap).slice(0, 5).join(', '));
  }

  return result;
}

// ─── STRATEGY ────────────────────────────────────────
function calcStrat(dR, cR) {
  const diff = Math.abs(dR - cR);
  const net  = +(diff - 0.10).toFixed(6);
  let longEx, shortEx, scenario, scenarioType;
  if (dR >= 0 && cR >= 0) {
    scenarioType='positive'; scenario='Both Positive';
    dR>=cR ? (shortEx='Delta',longEx='CoinDCX') : (shortEx='CoinDCX',longEx='Delta');
  } else if (dR <= 0 && cR <= 0) {
    scenarioType='negative'; scenario='Both Negative';
    dR<cR ? (longEx='Delta',shortEx='CoinDCX') : (longEx='CoinDCX',shortEx='Delta');
  } else {
    scenarioType='goldmine'; scenario='GOLDMINE';
    dR>0 ? (shortEx='Delta',longEx='CoinDCX') : (shortEx='CoinDCX',longEx='Delta');
  }
  return { longEx, shortEx, scenario, scenarioType, diff:+diff.toFixed(6), net };
}

// ─── HEALTH ──────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status:'ok', version:'14.1.1', port:PORT,
  deltaKeySet:!!DELTA_KEY, dcxKeySet:!!DCX_KEY, ts:Date.now()
}));

// ─── DEBUG: Delta ─────────────────────────────────────
app.get('/debug/delta', async (_req, res) => {
  const steps = [];
  const log   = m => { steps.push(m); console.log('[DBG-D]', m); };
  try {
    log('Calling /v2/tickers?contract_types=perpetual_futures ...');
    const d   = await dPub('/v2/tickers', { contract_types: 'perpetual_futures' });
    const raw = d?.result || d?.data || [];
    log(`Raw: ${raw.length}`);
    const map = parseDelta(d);
    log(`Parsed: ${Object.keys(map).length} coins`);
    res.json({ ok:true, count:raw.length, parsed:Object.keys(map).length, steps,
      sample: Object.entries(map).slice(0,5).map(([b,v])=>({base:b,price:v.price,fundingRate:v.fundingRate})) });
  } catch(e) { log('ERROR: '+errMsg(e)); res.json({ ok:false, error:errMsg(e), steps }); }
});

// ─── DEBUG: CoinDCX full diagnostic ──────────────────
app.get('/debug/dcx', async (_req, res) => {
  try {
    const r  = await fetchDCX();
    const wf = Object.values(r.map).filter(v=>v.fundingRate!==0).length;
    res.json({
      ok:r.ok, source:r.source, total:r.total,
      parsed:Object.keys(r.map).length, withFunding:wf,
      steps:r.steps, errors:r.errors,
      sampleCoins: Object.keys(r.map).slice(0,12),
      sample: Object.entries(r.map).slice(0,5).map(([b,v])=>({base:b,symbol:v.symbol,price:v.price,fundingRate:v.fundingRate}))
    });
  } catch(e) { res.json({ ok:false, error:errMsg(e), steps:[], errors:[errMsg(e)] }); }
});

// ─── DEBUG: Raw probe all DCX endpoints ──────────────
app.get('/debug/dcx-raw', async (_req, res) => {
  const probes = [
    { name:'active_instruments[USDT]', url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT` },
    { name:'active_instruments[INR]',  url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=INR` },
    { name:'instrument[BTC]',          url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/instrument?pair=B-BTC_USDT&margin_currency_short_name=USDT` },
    { name:'funding_rates',            url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/funding_rates` },
    { name:'ltp',                      url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/ltp` },
    { name:'current_prices',           url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/current_prices` },
    { name:'pair_stats',               url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/pair_stats` },
    { name:'trades[BTC]',              url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/trades?pair=B-BTC_USDT` },
    { name:'ticker',                   url:`${DCX_BASE}/exchange/ticker` },
    { name:'public_current_prices_rt', url:`${DCX_PUBLIC_BASE}/market_data/v3/current_prices/futures/rt` },
  ];
  const results = [];
  for (const p of probes) {
    try {
      const start = Date.now();
      const r     = await axios.get(p.url, { timeout:10000, headers:{ Accept:'application/json' } });
      const data  = r.data;
      const len   = Array.isArray(data) ? data.length : (typeof data === 'object' ? Object.keys(data).length : '?');
      const first = Array.isArray(data) && data[0]
        ? (typeof data[0]==='string' ? `string: "${data[0]}"` : `object keys: ${Object.keys(data[0]).join(', ')}`)
        : (typeof data==='object' ? `keys: ${Object.keys(data).join(', ')}` : String(data).slice(0,80));
      results.push({ name:p.name, ok:true, status:r.status, ms:Date.now()-start, items:len, first:first.slice(0,200) });
    } catch(e) {
      results.push({ name:p.name, ok:false, status:e.response?.status||'ERR', error:errMsg(e).slice(0,150) });
    }
  }
  res.json({ ts:Date.now(), probes:results });
});

// ─── SCAN ────────────────────────────────────────────
app.post('/api/scan', async (_req, res) => {
  try {
    const [dR, cR] = await Promise.allSettled([
      dPub('/v2/tickers', { contract_types:'perpetual_futures' }),
      fetchDCX()
    ]);
    const deltaMap = dR.status==='fulfilled' ? parseDelta(dR.value) : {};
    const dcxRaw   = cR.status==='fulfilled' ? cR.value : { map:{}, ok:false, steps:[], errors:[] };
    const dcxMap   = dcxRaw.ok ? dcxRaw.map : {};
    const deltaOk  = Object.keys(deltaMap).length > 0;
    const dcxOk    = Object.keys(dcxMap).length   > 0;

    const opps = [];
    for (const [base, d] of Object.entries(deltaMap)) {
      const c = dcxMap[base];
      if (!c||d.price<=0||c.price<=0) continue;
      const { longEx, shortEx, scenario, scenarioType, diff, net } = calcStrat(d.fundingRate, c.fundingRate);
      const avg  = (d.price+c.price)/2;
      const spr  = avg>0 ? +((Math.abs(d.price-c.price)/avg)*100).toFixed(4) : 0;
      const now  = new Date();
      const sec  = now.getUTCHours()*3600+now.getUTCMinutes()*60+now.getUTCSeconds();
      const rem  = 8*3600-(sec%(8*3600));
      const urg  = rem<=1800?'urgent':rem<=3600?'soon':'normal';
      const score= diff*(scenarioType==='goldmine'?2.5:1)*(urg==='urgent'?2:urg==='soon'?1.5:1);
      opps.push({
        base, deltaSymbol:d.symbol, dcxSymbol:c.symbol, deltaProductId:d.productId,
        deltaPrice:d.price, dcxPrice:c.price, deltaFunding:d.fundingRate, dcxFunding:c.fundingRate,
        fundingDiff:diff, netYield:net, spread:spr,
        volume:+(Math.max(d.volume24h,c.volume24h)).toFixed(2),
        deltaChange24h:d.change24h, dcxChange24h:c.change24h,
        longExchange:longEx, shortExchange:shortEx,
        scenario, scenarioType, urgency:urg, score
      });
    }
    opps.sort((a,b)=>b.score-a.score);
    res.json({
      success:true, data:opps, count:opps.length,
      deltaCount:Object.keys(deltaMap).length, dcxCount:Object.keys(dcxMap).length,
      deltaOk, dcxOk,
      dcxSteps:  dcxRaw.steps  || [],
      dcxErrors: dcxRaw.errors || [],
      dcxSource: dcxRaw.source || 'none',
      deltaError: dR.status==='rejected' ? errMsg(dR.reason) : null,
      dcxError:   (!dcxOk&&dcxRaw.errors?.length) ? dcxRaw.errors.join(' | ') : null,
      ts:Date.now()
    });
  } catch(e) { res.status(500).json({ success:false, error:errMsg(e) }); }
});

// ─────────────────────────────────────────────────────
//  ORDER
// ─────────────────────────────────────────────────────
app.post('/api/order', async (req, res) => {
  const { deltaProductId, dcxSymbol, longExchange, quantity, leverage, orderType, limitPriceDelta, limitPriceDcx } = req.body;
  if (!DELTA_KEY||!DCX_KEY) return res.status(400).json({ success:false, error:'API keys not set in Railway Variables.' });
  const dSide = longExchange==='Delta'?'buy':'sell';
  const cSide = longExchange==='CoinDCX'?'buy':'sell';
  const dBody = { product_id:parseInt(deltaProductId), size:parseFloat(quantity), side:dSide,
    order_type:orderType==='limit'?'limit_order':'market_order',
    ...(orderType==='limit'&&limitPriceDelta&&{limit_price:String(limitPriceDelta)}) };
  if (leverage) dBody.leverage = String(leverage);
  const cBody = { market:dcxSymbol, side:cSide, order_type:orderType==='limit'?'limit_order':'market_order',
    quantity:parseFloat(quantity), ...(leverage&&{leverage:parseInt(leverage)}),
    ...(orderType==='limit'&&limitPriceDcx&&{price:parseFloat(limitPriceDcx)}) };
  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth('POST','/v2/orders',{},dBody),
    cAuth('/exchange/v1/orders/create',cBody)
  ]);
  res.json({
    success:true, latencyMs:Date.now()-t0,
    bothOk:dr.status==='fulfilled'&&cr.status==='fulfilled',
    delta:dr.status==='fulfilled'?{ok:true,orderId:dr.value?.result?.id||dr.value?.id}:{ok:false,error:errMsg(dr.reason)},
    dcx:cr.status==='fulfilled'?{ok:true,orderId:cr.value?.orders?.[0]?.id||cr.value?.id}:{ok:false,error:errMsg(cr.reason)}
  });
});

// ─────────────────────────────────────────────────────
//  EXIT
// ─────────────────────────────────────────────────────
app.post('/api/exit', async (req, res) => {
  const { deltaProductId, dcxSymbol, longExchange, quantity } = req.body;
  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth('POST','/v2/orders',{},{product_id:parseInt(deltaProductId),size:parseFloat(quantity),
      side:longExchange==='Delta'?'sell':'buy',order_type:'market_order',reduce_only:true}),
    cAuth('/exchange/v1/orders/create',{market:dcxSymbol,
      side:longExchange==='CoinDCX'?'sell':'buy',order_type:'market_order',quantity:parseFloat(quantity)})
  ]);
  res.json({
    success:true, latencyMs:Date.now()-t0,
    delta:dr.status==='fulfilled'?{ok:true}:{ok:false,error:errMsg(dr.reason)},
    dcx:cr.status==='fulfilled'?{ok:true}:{ok:false,error:errMsg(cr.reason)}
  });
});

// ─────────────────────────────────────────────────────
//  POSITIONS / HISTORY / BALANCE
// ─────────────────────────────────────────────────────
app.post('/api/positions', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET','/v2/positions',{page_size:'50'}),
    cAuth('/exchange/v1/orders/active_orders')
  ]);
  res.json({
    delta:dr.status==='fulfilled'?dr.value:{error:errMsg(dr.reason)},
    dcx:cr.status==='fulfilled'?cr.value:{error:errMsg(cr.reason)}
  });
});

app.post('/api/history', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET','/v2/orders',{state:'closed',page_size:'50'}),
    cAuth('/exchange/v1/orders/trade_history',{limit:50})
  ]);
  res.json({
    delta:dr.status==='fulfilled'?dr.value:{error:errMsg(dr.reason)},
    dcx:cr.status==='fulfilled'?cr.value:{error:errMsg(cr.reason)}
  });
});

app.post('/api/balance', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET','/v2/wallet/balances'),
    cAuth('/exchange/v1/users/balances')
  ]);
  let deltaUsd=0, dcxUsd=0;
  if (dr.status==='fulfilled') {
    const bals=dr.value?.result||[];
    const u=Array.isArray(bals)?bals.find(b=>b.asset_symbol==='USDT'):null;
    deltaUsd=parseFloat(u?.balance||0);
  }
  if (cr.status==='fulfilled') {
    const arr=Array.isArray(cr.value)?cr.value:(cr.value?.balance||[]);
    const u=arr.find?.(b=>(b.currency||b.short_name||'').toUpperCase()==='USDT');
    dcxUsd=parseFloat(u?.balance||u?.available_balance||0);
  }
  res.json({ deltaUsd:+deltaUsd.toFixed(2), dcxUsd:+dcxUsd.toFixed(2), totalUsd:+(deltaUsd+dcxUsd).toFixed(2) });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`FundArb v14.1.1 | Delta + CoinDCX | Port ${PORT}`)
);
