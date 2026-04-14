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

// ─────────────────────────────────────────────────────
//  COINDCX
// ─────────────────────────────────────────────────────
const DCX_BASE = 'https://api.coindcx.com';

function cSign(bodyObj) {
  return crypto.createHmac('sha256', DCX_SECRET)
    .update(JSON.stringify(bodyObj)).digest('hex');
}

async function cPub(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DCX_BASE + ep + qs, {
    timeout: 12000, headers: { Accept: 'application/json' }
  });
  return r.data;
}

async function cAuth(ep, bodyObj = {}) {
  const body = { ...bodyObj, timestamp: Date.now() };
  const sig  = cSign(body);
  const r    = await axios.post(DCX_BASE + ep, body, {
    timeout: 12000,
    headers: { 'X-AUTH-APIKEY': DCX_KEY, 'X-AUTH-SIGNATURE': sig, 'Content-Type': 'application/json' }
  });
  return r.data;
}

function dcxBase(sym, c) {
  const short = (c.base_currency_short_name || c.base_currency || c.base || '').toUpperCase();
  if (short && short.length >= 2 && short.length <= 10) return short;
  const s = sym.toUpperCase();
  if (s.startsWith('B-'))  return s.slice(2).split(/[_-]/)[0];
  if (s.includes('PERP'))  return s.replace(/_?PERP.*/,'').replace(/_?USDT?$/,'').replace(/_/g,'');
  if (s.includes('FUT'))   return s.replace(/_?FUT.*/,'').replace(/_?USDT?$/,'').replace(/_/g,'');
  if (s.includes('_USDT')) return s.split('_USDT')[0].replace(/_/g,'');
  if (s.endsWith('USDT'))  return s.slice(0,-4);
  if (s.includes('_USD'))  return s.split('_USD')[0].replace(/_/g,'');
  if (s.endsWith('USD'))   return s.slice(0,-3);
  return '';
}

async function fetchDCX() {
  const result = { map: {}, ok: false, source: 'none', total: 0, errors: [], steps: [] };
  const log    = (m) => { result.steps.push(m); console.log('[DCX]', m); };

  // ── STEP 1: New primary endpoint ─────────────────────────
  log('STEP 1 — active_instruments endpoint...');
  let instruments = [];
  for (const mode of ['USDT', 'BTC']) {
    const url = `${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=${mode}`;
    try {
      const start = Date.now();
      const r     = await axios.get(url, { timeout: 12000, headers: { Accept: 'application/json' } });
      const list  = Array.isArray(r.data) ? r.data
                  : (r.data?.data || r.data?.instruments || r.data?.result || []);
      log(`  [${mode}] HTTP ${r.status} — ${list.length} items (${Date.now()-start}ms)`);
      if (list.length) instruments = instruments.concat(list);
    } catch (e) {
      const msg = `  [${mode}] FAILED: ${errMsg(e)}`;
      log(msg); result.errors.push(`active_instruments[${mode}]: ${errMsg(e)}`);
    }
  }

  if (instruments.length) {
    result.source = '/exchange/v1/derivatives/futures/data/active_instruments';
    result.total  = instruments.length;
    for (const c of instruments) {
      const sym  = (c.symbol || c.coindcx_name || c.pair || c.market || '').toUpperCase();
      if (!sym) continue;
      const base = dcxBase(sym, c);
      if (!base || base.length < 2 || base.length > 10) continue;
      let price = parseFloat(c.mark_price ?? c.last_price ?? c.ltp ?? c.close ?? c.price ?? 0);
      if (price <= 0) continue;
      let fr = parseFloat(
        c.funding_rate ?? c.current_funding_rate ?? c.predicted_funding_rate ??
        c.predicted_rate ?? c.next_funding_rate ?? 0
      );
      if (fr !== 0 && Math.abs(fr) < 0.0001) fr = fr * 100;
      result.map[base] = {
        symbol: sym, price,
        fundingRate: +fr.toFixed(6),
        volume24h:   parseFloat(c.volume_24h ?? c.volume ?? c.turnover ?? 0),
        change24h:   parseFloat(c.change_24h ?? c.price_change_24h ?? 0),
        nextFunding: c.next_funding_time ?? c.next_funding_at ?? null
      };
    }
    const parsed = Object.keys(result.map).length;
    log(`  Parsed ${parsed} coins.`);
    if (parsed > 0) { result.ok = true; return result; }
    log('  0 coins parsed — falling to legacy endpoints.');
  } else {
    log('  0 items returned — falling to legacy endpoints.');
  }

  // ── STEP 2: Funding supplement ────────────────────────────
  log('STEP 2 — standalone funding_rates...');
  let fundingMap = {};
  try {
    const r = await cPub('/exchange/v1/derivatives/futures/funding_rates');
    if (Array.isArray(r)) {
      r.forEach(x => { const k=(x.symbol||x.market||'').toUpperCase(); if(k) fundingMap[k]=parseFloat(x.funding_rate||x.rate||0); });
    } else if (r && typeof r==='object') {
      Object.entries(r).forEach(([k,v]) => { fundingMap[k.toUpperCase()] = typeof v==='object'?parseFloat(v.rate||v.funding_rate||0):parseFloat(v); });
    }
    log(`  ${Object.keys(fundingMap).length} funding entries`);
  } catch (e) { const m=`funding_rates FAILED: ${errMsg(e)}`; log(`  ${m}`); result.errors.push(m); }

  // ── STEP 3: Ticker fallback ───────────────────────────────
  log('STEP 3 — live ticker...');
  let tickerMap = {};
  try {
    const arr = await cPub('/exchange/ticker');
    if (Array.isArray(arr)) arr.forEach(t => { tickerMap[(t.market||'').toUpperCase()] = t; });
    log(`  ${Object.keys(tickerMap).length} tickers`);
  } catch (e) { const m=`ticker FAILED: ${errMsg(e)}`; log(`  ${m}`); result.errors.push(m); }

  // ── STEP 4: Legacy contract endpoints ────────────────────
  log('STEP 4 — legacy contract endpoints...');
  for (const ep of [
    '/exchange/v1/derivatives/futures/contracts',
    '/exchange/v1/derivatives/contracts',
    '/exchange/v1/futures/contracts'
  ]) {
    try {
      const r    = await cPub(ep);
      const list = Array.isArray(r) ? r : (r?.contracts || r?.data || []);
      log(`  ${ep} → ${list.length} items`);
      if (!list.length) continue;
      result.source = ep; result.total = list.length;
      for (const c of list) {
        const sym  = (c.coindcx_code||c.symbol||c.market||'').toUpperCase();
        if (!sym) continue;
        const base = dcxBase(sym, c);
        if (!base||base.length<2||base.length>10) continue;
        const ticker = tickerMap[sym] || tickerMap[base+'USDT'];
        let price = parseFloat(c.mark_price||c.last_price||c.price||c.close||0);
        if (price<=0&&ticker) price = parseFloat(ticker.last_price||0);
        if (price<=0) continue;
        let fr = parseFloat(c.funding_rate||c.current_funding_rate||c.predicted_funding_rate||0);
        if (fr===0) fr = fundingMap[sym]||fundingMap[base+'USDT']||0;
        if (fr===0&&ticker) fr = parseFloat(ticker.funding_rate||0);
        if (fr!==0&&Math.abs(fr)<0.001) fr = fr*100;
        result.map[base] = {
          symbol: sym, price, fundingRate: +fr.toFixed(6),
          volume24h: parseFloat(c.volume_24h||c.base_volume||ticker?.volume||0),
          change24h: parseFloat(c.price_change_24h||ticker?.change_24_hour||0),
          nextFunding: c.next_funding_time||null
        };
      }
      const parsed = Object.keys(result.map).length;
      log(`  ${ep} → parsed ${parsed} coins`);
      if (parsed>0) { result.ok=true; break; }
    } catch (e) {
      const m = `${ep} FAILED: ${errMsg(e)}`; log(`  ${m}`); result.errors.push(m);
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────
//  STRATEGY
// ─────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────
//  HEALTH
// ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status:'ok', version:'13.0.0', port:PORT,
  deltaKeySet:!!DELTA_KEY, dcxKeySet:!!DCX_KEY, ts:Date.now()
}));

// ─────────────────────────────────────────────────────
//  DEBUG — Delta
// ─────────────────────────────────────────────────────
app.get('/debug/delta', async (_req, res) => {
  const steps = [];
  const log   = (m) => { steps.push(m); console.log('[DBG-DELTA]', m); };
  try {
    log('Calling /v2/tickers?contract_types=perpetual_futures ...');
    const d   = await dPub('/v2/tickers', { contract_types:'perpetual_futures' });
    const raw = d?.result || d?.data || [];
    log(`Raw tickers received: ${raw.length}`);
    const map = parseDelta(d);
    log(`Parsed: ${Object.keys(map).length} coins`);
    res.json({
      ok:true, count:raw.length, parsed:Object.keys(map).length, steps,
      sample:Object.entries(map).slice(0,5).map(([b,v])=>({base:b,price:v.price,fundingRate:v.fundingRate,symbol:v.symbol}))
    });
  } catch(e) {
    log('ERROR: '+errMsg(e));
    res.json({ ok:false, error:errMsg(e), steps });
  }
});

// ─────────────────────────────────────────────────────
//  DEBUG — CoinDCX (full step-by-step diagnostics)
// ─────────────────────────────────────────────────────
app.get('/debug/dcx', async (_req, res) => {
  try {
    const r  = await fetchDCX();
    const wf = Object.values(r.map).filter(v=>v.fundingRate!==0).length;
    res.json({
      ok:r.ok, source:r.source, total:r.total,
      parsed:Object.keys(r.map).length, withFunding:wf,
      steps:r.steps, errors:r.errors,
      sampleCoins:Object.keys(r.map).slice(0,12),
      sample:Object.entries(r.map).slice(0,5).map(([b,v])=>({base:b,symbol:v.symbol,price:v.price,fundingRate:v.fundingRate}))
    });
  } catch(e) {
    res.json({ ok:false, error:errMsg(e), steps:[], errors:[errMsg(e)] });
  }
});

// ─────────────────────────────────────────────────────
//  DEBUG — Raw probe of every DCX endpoint
// ─────────────────────────────────────────────────────
app.get('/debug/dcx-raw', async (_req, res) => {
  const probes = [
    { name:'active_instruments[USDT]', url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT` },
    { name:'active_instruments[BTC]',  url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=BTC` },
    { name:'funding_rates',            url:`${DCX_BASE}/exchange/v1/derivatives/futures/funding_rates` },
    { name:'contracts (futures)',      url:`${DCX_BASE}/exchange/v1/derivatives/futures/contracts` },
    { name:'contracts (derivatives)',  url:`${DCX_BASE}/exchange/v1/derivatives/contracts` },
    { name:'ticker',                   url:`${DCX_BASE}/exchange/ticker` },
  ];
  const results = [];
  for (const p of probes) {
    try {
      const start = Date.now();
      const r     = await axios.get(p.url, { timeout:12000, headers:{ Accept:'application/json' } });
      const data  = r.data;
      const len   = Array.isArray(data) ? data.length
                  : (data?.data?.length||data?.result?.length||data?.instruments?.length||'(object)');
      const peek  = Array.isArray(data)&&data[0] ? Object.keys(data[0]).slice(0,8).join(', ') : 'n/a';
      results.push({ name:p.name, ok:true, status:r.status, ms:Date.now()-start, items:len, fields:peek });
    } catch(e) {
      results.push({ name:p.name, ok:false, status:e.response?.status||'NO_RESPONSE', error:errMsg(e) });
    }
  }
  res.json({ ts:Date.now(), probes:results });
});

// ─────────────────────────────────────────────────────
//  SCAN
// ─────────────────────────────────────────────────────
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
  console.log(`FundArb v13 | Delta + CoinDCX | Port ${PORT}`)
);
