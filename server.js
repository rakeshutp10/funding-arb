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

const DELTA_KEY    = process.env.DELTA_KEY    || '';
const DELTA_SECRET = process.env.DELTA_SECRET || '';
const DCX_KEY      = process.env.DCX_KEY      || '';
const DCX_SECRET   = process.env.DCX_SECRET   || '';

function errMsg(e) {
  if (!e) return 'Unknown error';
  if (e.response) {
    const s = e.response.status;
    const b = typeof e.response.data === 'object'
      ? JSON.stringify(e.response.data) : String(e.response.data || '');
    return `HTTP ${s} — ${b.slice(0, 300)}`;
  }
  return e.code ? `${e.code}: ${e.message}` : (e.message || String(e));
}

// ─── DELTA EXCHANGE INDIA ────────────────────────────
const DELTA_BASE = 'https://api.india.delta.exchange';

function dSign(method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', DELTA_SECRET)
    .update(method + ts + ep + qs + body).digest('hex');
}
async function dPub(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  return (await axios.get(DELTA_BASE + ep + qs, { timeout: 12000, headers: { Accept: 'application/json' } })).data;
}
async function dAuth(method, ep, query = {}, body = null) {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const qs  = Object.keys(query).length ? '?' + new URLSearchParams(query) : '';
  const bs  = body ? JSON.stringify(body) : '';
  const sig = dSign(method, ep, qs, bs, ts);
  const cfg = { method, url: DELTA_BASE + ep + qs, timeout: 12000,
    headers: { 'api-key': DELTA_KEY, timestamp: ts, signature: sig, 'Content-Type': 'application/json' } };
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
      symbol: t.symbol || '', productId: t.id || t.product_id, price,
      fundingRate: +(fr * 100).toFixed(6),
      volume24h: parseFloat(t.volume || t.turnover_usd || 0),
      change24h: parseFloat(t.price_change_percent || 0),
      nextFunding: t.next_funding_realization || null
    };
  }
  return map;
}

// ─── COINDCX ─────────────────────────────────────────
const DCX_BASE = 'https://api.coindcx.com';

function cSign(bodyObj) {
  return crypto.createHmac('sha256', DCX_SECRET).update(JSON.stringify(bodyObj)).digest('hex');
}
async function cGet(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  return (await axios.get(DCX_BASE + ep + qs, { timeout: 12000, headers: { Accept: 'application/json' } })).data;
}
async function cAuth(ep, bodyObj = {}) {
  const body = { ...bodyObj, timestamp: Date.now() };
  const sig  = cSign(body);
  return (await axios.post(DCX_BASE + ep, body, {
    timeout: 12000,
    headers: { 'X-AUTH-APIKEY': DCX_KEY, 'X-AUTH-SIGNATURE': sig, 'Content-Type': 'application/json' }
  })).data;
}

// Extract base coin from CoinDCX pair name e.g. "B-1000CAT_USDT" → "1000CAT"
function pairToBase(pair) {
  // "B-BTC_USDT" → strip "B-" prefix → "BTC_USDT" → split on "_" → "BTC"
  let s = pair.toUpperCase();
  if (s.startsWith('B-')) s = s.slice(2);                  // "BTC_USDT"
  const parts = s.split('_');
  const base  = parts[0];                                    // "BTC"
  return base && base.length >= 2 && base.length <= 15 ? base : '';
}

// ── fetchDCX: correct approach based on actual API structure ──
async function fetchDCX() {
  const result = { map: {}, ok: false, source: 'none', total: 0, errors: [], steps: [] };
  const log    = (m) => { result.steps.push(m); console.log('[DCX]', m); };

  // ══ STEP 1: Build spot ticker map (price source) ══════════
  // /exchange/ticker has SPOT pairs like "BTCUSDT", "ETHUSDT"
  // Perpetuals track spot closely — use spot price as proxy
  log('STEP 1 — /exchange/ticker for spot price lookup...');
  const tickerMap = {};  // key: "BTCUSDT" → ticker object
  try {
    const start = Date.now();
    const arr   = await cGet('/exchange/ticker');
    if (Array.isArray(arr)) {
      arr.forEach(t => {
        const m = (t.market || '').toUpperCase();
        tickerMap[m] = t;
      });
    }
    log(`  ✅ ${Object.keys(tickerMap).length} spot tickers (${Date.now()-start}ms)`);
    // Debug: show a few BTC pairs to confirm key format
    const btcPairs = Object.keys(tickerMap).filter(k => k.startsWith('BTC')).slice(0,5);
    log(`  Sample BTC keys: ${btcPairs.join(', ')}`);
  } catch (e) {
    const m = `ticker FAILED: ${errMsg(e)}`; log(`  ❌ ${m}`); result.errors.push(m);
  }

  // ══ STEP 2: Get active futures pair list ═════════════════
  // Returns string[] like ["B-BTC_USDT", "B-ETH_USDT", ...]
  log('STEP 2 — active_instruments for futures pair list...');
  let pairList = [];
  for (const mode of ['USDT', 'INR']) {
    const url = `${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=${mode}`;
    try {
      const r = await axios.get(url, { timeout: 12000, headers: { Accept: 'application/json' } });
      const raw = r.data;
      // Response is string[] OR object[]
      if (Array.isArray(raw)) {
        raw.forEach(item => {
          const pairStr = typeof item === 'string' ? item : (item.pair || item.symbol || item.coindcx_name || '');
          if (pairStr && pairStr.startsWith('B-')) pairList.push(pairStr.toUpperCase());
        });
        log(`  [${mode}] HTTP ${r.status} → ${raw.length} items → ${pairList.length} valid B-* pairs so far`);
        if (raw.length > 0) log(`  [${mode}] Sample: ${raw.slice(0,3).map(x=>typeof x==='string'?x:JSON.stringify(x)).join(', ')}`);
      }
    } catch (e) {
      const m = `active_instruments[${mode}]: ${errMsg(e)}`;
      log(`  ❌ ${m}`); result.errors.push(m);
    }
  }

  // ══ STEP 3: Try bulk funding rate endpoint ════════════════
  // CoinDCX might have a bulk endpoint — try several
  log('STEP 3 — trying bulk funding rate endpoints...');
  const fundingMap = {};  // base → funding rate %
  const bulkFundingEps = [
    '/exchange/v1/derivatives/futures/data/funding_rates',
    '/exchange/v1/derivatives/futures/data/ltp',
    '/exchange/v1/derivatives/futures/data/current_prices',
    '/exchange/v1/derivatives/futures/data/pair_stats',
  ];
  for (const ep of bulkFundingEps) {
    try {
      const r = await axios.get(DCX_BASE + ep, { timeout: 8000, headers: { Accept: 'application/json' } });
      const d = r.data;
      log(`  ${ep} → HTTP ${r.status}, type=${typeof d}, len=${Array.isArray(d)?d.length:'obj'}`);
      if (Array.isArray(d) && d.length > 0) {
        log(`  Fields: ${Object.keys(d[0]).join(', ')}`);
        d.forEach(item => {
          const pair = (item.pair || item.symbol || item.market || '').toUpperCase();
          const base = pair.startsWith('B-') ? pairToBase(pair) : '';
          const fr   = parseFloat(item.funding_rate || item.current_funding_rate || item.fr || 0);
          if (base && fr !== 0) fundingMap[base] = fr;
        });
        log(`  Got ${Object.keys(fundingMap).length} funding rates`);
        if (Object.keys(fundingMap).length > 0) break;
      }
    } catch (e) {
      log(`  ${ep} → ${errMsg(e).slice(0,80)}`);
    }
  }

  // ══ STEP 4: Try per-instrument details (batch, for funding) ══
  // Only if we have pairs but no funding rates yet
  if (pairList.length > 0 && Object.keys(fundingMap).length === 0) {
    log(`STEP 4 — per-instrument details for funding (sampling first 5)...`);
    const samplePairs = pairList.filter(p => p.endsWith('_USDT')).slice(0, 5);
    for (const pair of samplePairs) {
      try {
        const ep = `/exchange/v1/derivatives/futures/data/instrument_details`;
        const r  = await axios.get(DCX_BASE + ep, {
          params: { pair, margin_currency_short_name: 'USDT' },
          timeout: 8000, headers: { Accept: 'application/json' }
        });
        const d = r.data;
        log(`  ${pair} → HTTP ${r.status} fields: ${Object.keys(d?.instrument||d||{}).join(', ').slice(0,100)}`);
        const instr = d?.instrument || d;
        const fr = parseFloat(instr?.funding_rate || instr?.current_funding_rate || 0);
        const base = pairToBase(pair);
        if (fr !== 0 && base) fundingMap[base] = fr;
      } catch (e) {
        log(`  ${pair} details → ${errMsg(e).slice(0,80)}`);
      }
    }
  }

  // ══ STEP 5: Build result map ══════════════════════════════
  // Map each "B-X_USDT" pair to a price from spot ticker
  log(`STEP 5 — building result from ${pairList.length} pairs...`);
  let hits = 0, misses = 0;

  for (const pair of pairList) {
    const base = pairToBase(pair);
    if (!base) { misses++; continue; }

    // Try to find price in spot ticker
    // "B-BTC_USDT" → base="BTC" → try "BTCUSDT", "BTCINR" etc.
    const suffix = pair.endsWith('_USDT') ? 'USDT' : pair.endsWith('_INR') ? 'INR' : 'USDT';
    const spotKey = base + suffix;                        // e.g. "BTCUSDT"
    const ticker  = tickerMap[spotKey] || tickerMap[base + 'USDT'];

    let price = 0;
    if (ticker) price = parseFloat(ticker.last_price || 0);
    if (price <= 0) { misses++; continue; }

    const fr = fundingMap[base] || 0;
    hits++;

    result.map[base] = {
      symbol:      pair,
      price,
      fundingRate: +fr.toFixed(6),
      volume24h:   parseFloat(ticker?.volume || 0),
      change24h:   parseFloat(ticker?.change_24_hour || 0),
      nextFunding: null
    };
  }

  result.total = pairList.length;
  log(`  Price hits: ${hits} | Misses (no spot ticker): ${misses}`);

  if (hits > 0) {
    result.ok     = true;
    result.source = 'active_instruments + /exchange/ticker (spot proxy)';
    log(`  ✅ ${hits} coins ready`);
  } else {
    log(`  ❌ 0 coins — check spot ticker key format vs pair base names`);
    // Debug: show what keys exist in ticker for investigation
    const sampleKeys = Object.keys(tickerMap).slice(0, 10).join(', ');
    log(`  Ticker sample keys: ${sampleKeys}`);
    if (pairList.length > 0) {
      log(`  First 5 pairs: ${pairList.slice(0,5).join(', ')}`);
      log(`  First 5 derived spotKeys: ${pairList.slice(0,5).map(p => pairToBase(p)+'USDT').join(', ')}`);
    }
    result.errors.push(`No price match found. ${pairList.length} pairs, ${Object.keys(tickerMap).length} ticker keys.`);
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
  status:'ok', version:'14.0.0', port:PORT,
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
    { name:'instrument_details[BTC]',  url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/instrument_details?pair=B-BTC_USDT&margin_currency_short_name=USDT` },
    { name:'funding_rates',            url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/funding_rates` },
    { name:'ltp',                      url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/ltp` },
    { name:'current_prices',           url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/current_prices` },
    { name:'pair_stats',               url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/pair_stats` },
    { name:'trades[BTC]',              url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/trades?pair=B-BTC_USDT` },
    { name:'ticker',                   url:`${DCX_BASE}/exchange/ticker` },
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
      if (!c || d.price<=0 || c.price<=0) continue;
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
      dcxSteps: dcxRaw.steps||[], dcxErrors: dcxRaw.errors||[],
      dcxSource: dcxRaw.source||'none',
      deltaError: dR.status==='rejected' ? errMsg(dR.reason) : null,
      dcxError:   (!dcxOk && dcxRaw.errors?.length) ? dcxRaw.errors.join(' | ') : null,
      ts: Date.now()
    });
  } catch(e) { res.status(500).json({ success:false, error:errMsg(e) }); }
});

// ─── ORDER ───────────────────────────────────────────
app.post('/api/order', async (req, res) => {
  const { deltaProductId, dcxSymbol, longExchange, quantity, leverage, orderType, limitPriceDelta, limitPriceDcx } = req.body;
  if (!DELTA_KEY||!DCX_KEY) return res.status(400).json({ success:false, error:'API keys not set in Railway Variables.' });
  const dSide = longExchange==='Delta'?'buy':'sell';
  const cSide = longExchange==='CoinDCX'?'buy':'sell';
  const dBody = { product_id:parseInt(deltaProductId), size:parseFloat(quantity), side:dSide,
    order_type:orderType==='limit'?'limit_order':'market_order',
    ...(orderType==='limit'&&limitPriceDelta&&{limit_price:String(limitPriceDelta)}) };
  if (leverage) dBody.leverage = String(leverage);
  const cBody = { pair:dcxSymbol, side:cSide,
    order_type:orderType==='limit'?'limit_order':'market_order',
    total_quantity:parseFloat(quantity), ...(leverage&&{leverage:parseInt(leverage)}),
    ...(orderType==='limit'&&limitPriceDcx&&{price:parseFloat(limitPriceDcx)}) };
  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth('POST','/v2/orders',{},dBody),
    cAuth('/exchange/v1/derivatives/futures/orders/create', cBody)
  ]);
  res.json({
    success:true, latencyMs:Date.now()-t0,
    bothOk: dr.status==='fulfilled'&&cr.status==='fulfilled',
    delta: dr.status==='fulfilled'?{ok:true,orderId:dr.value?.result?.id||dr.value?.id}:{ok:false,error:errMsg(dr.reason)},
    dcx:   cr.status==='fulfilled'?{ok:true,orderId:cr.value?.id}:{ok:false,error:errMsg(cr.reason)}
  });
});

// ─── EXIT ────────────────────────────────────────────
app.post('/api/exit', async (req, res) => {
  const { deltaProductId, dcxSymbol, longExchange, quantity } = req.body;
  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth('POST','/v2/orders',{},{product_id:parseInt(deltaProductId),size:parseFloat(quantity),
      side:longExchange==='Delta'?'sell':'buy',order_type:'market_order',reduce_only:true}),
    cAuth('/exchange/v1/derivatives/futures/orders/create',{pair:dcxSymbol,
      side:longExchange==='CoinDCX'?'sell':'buy',order_type:'market_order',total_quantity:parseFloat(quantity)})
  ]);
  res.json({
    success:true, latencyMs:Date.now()-t0,
    delta: dr.status==='fulfilled'?{ok:true}:{ok:false,error:errMsg(dr.reason)},
    dcx:   cr.status==='fulfilled'?{ok:true}:{ok:false,error:errMsg(cr.reason)}
  });
});

// ─── POSITIONS / HISTORY / BALANCE ───────────────────
app.post('/api/positions', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET','/v2/positions',{page_size:'50'}),
    cAuth('/exchange/v1/derivatives/futures/positions',{page:'1',size:'50'})
  ]);
  res.json({
    delta: dr.status==='fulfilled'?dr.value:{error:errMsg(dr.reason)},
    dcx:   cr.status==='fulfilled'?cr.value:{error:errMsg(cr.reason)}
  });
});

app.post('/api/history', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET','/v2/orders',{state:'closed',page_size:'50'}),
    cAuth('/exchange/v1/derivatives/futures/orders',{page:'1',size:'50'})
  ]);
  res.json({
    delta: dr.status==='fulfilled'?dr.value:{error:errMsg(dr.reason)},
    dcx:   cr.status==='fulfilled'?cr.value:{error:errMsg(cr.reason)}
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
  console.log(`FundArb v14 | Delta + CoinDCX | Port ${PORT}`)
);
