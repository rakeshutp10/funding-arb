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

// public.coindcx.com base for market data endpoints
const DCX_PUBLIC = 'https://public.coindcx.com';

async function fetchDCX() {
  const result = { map: {}, ok: false, source: 'none', total: 0, errors: [], steps: [] };
  const log    = (m) => { result.steps.push(m); console.log('[DCX]', m); };

  // ── STEP 1: Primary — futures realtime prices (public.coindcx.com) ──────────
  // Docs: GET https://public.coindcx.com/market_data/v3/current_prices/futures/rt
  // Returns: { ts, vs, prices: { "B-BTC_USDT": { ls, fr, mp, v, pc, ... } } }
  log('STEP 1 — futures realtime prices endpoint...');
  try {
    const start = Date.now();
    const r = await axios.get(`${DCX_PUBLIC}/market_data/v3/current_prices/futures/rt`, {
      timeout: 12000, headers: { Accept: 'application/json' }
    });
    const pricesObj = r.data?.prices || r.data || {};
    const entries   = Object.entries(pricesObj);
    log(`  HTTP ${r.status} — ${entries.length} instruments (${Date.now()-start}ms)`);
    if (entries.length > 0) {
      result.source = 'public.coindcx.com/market_data/v3/current_prices/futures/rt';
      result.total  = entries.length;
      for (const [sym, c] of entries) {
        // Only USDT-margined perpetuals: symbol like B-BTC_USDT
        if (!sym.startsWith('B-') || !sym.endsWith('_USDT')) continue;
        const base = sym.slice(2, -5); // strip "B-" prefix and "_USDT" suffix
        if (!base || base.length < 2 || base.length > 12) continue;
        const price = parseFloat(c.ls || c.mp || 0);  // ls = last price, mp = mark price
        if (price <= 0) continue;
        // fr = funding rate (already as decimal e.g. 0.0001 = 0.01%)
        let fr = parseFloat(c.fr || c.efr || 0);
        // Convert to percentage: 0.0001 → 0.01
        fr = +(fr * 100).toFixed(6);
        result.map[base] = {
          symbol:      sym,
          price,
          fundingRate: fr,
          volume24h:   parseFloat(c.v || 0),
          change24h:   parseFloat(c.pc || 0),
          nextFunding: null
        };
      }
      const parsed = Object.keys(result.map).length;
      log(`  Parsed ${parsed} USDT futures coins`);
      if (parsed > 0) { result.ok = true; return result; }
      log('  public market data returned no usable futures rows; switching to fallback flow');
    }
  } catch (e) {
    const m = `realtime prices FAILED: ${errMsg(e)}`;
    log(`  ⚠ ${m}`); result.errors.push(m);
  }

  // ── STEP 2: Fallback — active_instruments (USDT + INR) ───────────────────
  // Docs: GET https://api.coindcx.com/exchange/v1/derivatives/futures/data/active_instruments
  log('STEP 2 — active_instruments fallback...');
  let instruments = [];
  for (const mode of ['USDT', 'INR']) {
    const url = `${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=${mode}`;
    try {
      const start = Date.now();
      const r     = await axios.get(url, { timeout: 12000, headers: { Accept: 'application/json' } });
      const list  = Array.isArray(r.data) ? r.data
                  : (r.data?.data || r.data?.instruments || r.data?.result || []);
      log(`  [${mode}] ${list.length} items fetched`);
      if (list.length) instruments = instruments.concat(list);
    } catch (e) {
      const m = `active_instruments[${mode}]: ${errMsg(e)}`;
      log(`  [${mode}] FAILED: ${errMsg(e)}`); result.errors.push(m);
    }
  }

  if (instruments.length > 0) {
    result.source = '/exchange/v1/derivatives/futures/data/active_instruments';
    result.total  = instruments.length;
    // Get price data from instrument detail endpoint for each pair
    // Docs: GET https://api.coindcx.com/exchange/v1/derivatives/futures/data/instrument?pair={pair}&margin_currency_short_name=USDT
    log(`STEP 3 — instrument details fallback for ${instruments.length} pairs...`);
    let hits = 0;
    for (const c of instruments) {
      const sym  = (c.symbol || c.coindcx_name || c.pair || c.market || '').toUpperCase();
      if (!sym || !sym.startsWith('B-') || !sym.endsWith('_USDT')) continue;
      const base = sym.slice(2, -5);
      if (!base || base.length < 2 || base.length > 12) continue;
      // Try price from the active_instruments data directly first
      let price = parseFloat(c.mark_price ?? c.last_price ?? c.ltp ?? c.close ?? c.price ?? 0);
      if (price <= 0) {
        // Fetch individual instrument detail
        try {
          const dr = await axios.get(
            `${DCX_BASE}/exchange/v1/derivatives/futures/data/instrument?pair=${sym}&margin_currency_short_name=USDT`,
            { timeout: 8000, headers: { Accept: 'application/json' } }
          );
          const d = dr.data?.data || dr.data || {};
          price = parseFloat(d.mark_price ?? d.last_price ?? d.ltp ?? 0);
        } catch (_) {}
      }
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
      hits++;
    }
    log(`  Fallback hits: ${hits}`);
    if (hits > 0) { result.ok = true; return result; }
    result.errors.push('CoinDCX market data unavailable after fallback retries.');
    log('  ✗ CoinDCX market data unavailable after fallback retries.');
  } else {
    result.errors.push('No CoinDCX futures records were retrievable. Check API availability / IP restrictions / network egress rules.');
    log('  ✗ CoinDCX market data unavailable after fallback retries. Errors: △ No CoinDCX futures records were retrievable. Check API availability / IP restrictions / network egress rules.');
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
    { name:'rt_prices (public)',     url:`${DCX_PUBLIC}/market_data/v3/current_prices/futures/rt` },
    { name:'active_instruments[USDT]', url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT` },
    { name:'active_instruments[INR]',  url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=INR` },
    { name:'instrument_detail[BTC]', url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/instrument?pair=B-BTC_USDT&margin_currency_short_name=USDT` },
    { name:'funding_rates',          url:`${DCX_BASE}/exchange/v1/derivatives/futures/funding_rates` },
    { name:'trades[BTC]',            url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/trades?pair=B-BTC_USDT` },
    { name:'orderbook[BTC]',         url:`${DCX_PUBLIC}/market_data/v3/orderbook/B-BTC_USDT-futures/10` },
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
app.all('/api/scan', async (_req, res) => {
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
app.all('/api/order', async (req, res) => {
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
app.all('/api/exit', async (req, res) => {
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
app.all('/api/positions', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET','/v2/positions',{page_size:'50'}),
    cAuth('/exchange/v1/orders/active_orders')
  ]);
  res.json({
    delta:dr.status==='fulfilled'?dr.value:{error:errMsg(dr.reason)},
    dcx:cr.status==='fulfilled'?cr.value:{error:errMsg(cr.reason)}
  });
});

app.all('/api/history', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET','/v2/orders',{state:'closed',page_size:'50'}),
    cAuth('/exchange/v1/orders/trade_history',{limit:50})
  ]);
  res.json({
    delta:dr.status==='fulfilled'?dr.value:{error:errMsg(dr.reason)},
    dcx:cr.status==='fulfilled'?cr.value:{error:errMsg(cr.reason)}
  });
});

app.all('/api/balance', async (_req, res) => {
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

// ─────────────────────────────────────────────────────
//  DEBUG — Field dump: raw fields from CoinDCX rt endpoint
// ─────────────────────────────────────────────────────
app.get('/debug/fields', async (_req, res) => {
  try {
    const r = await axios.get(`${DCX_PUBLIC}/market_data/v3/current_prices/futures/rt`, {
      timeout: 12000, headers: { Accept: 'application/json' }
    });
    const prices = r.data?.prices || r.data || {};
    const keys   = Object.keys(prices);
    const sample = keys.slice(0, 3).map(k => ({ sym: k, fields: Object.keys(prices[k]), data: prices[k] }));
    const usdtKeys = keys.filter(k => k.startsWith('B-') && k.endsWith('_USDT'));
    res.json({ ok: true, total: keys.length, usdtFutures: usdtKeys.length,
      fieldNames: sample[0]?.fields || [], sample });
  } catch(e) {
    res.json({ ok: false, error: errMsg(e) });
  }
});

// 404 fallback — JSON only (HTML is served from GitHub Pages, not here)
app.use((_req, res) => res.status(404).json({ error: 'Not found', hint: 'This is the FundArb API server. Frontend is on GitHub Pages.' }));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`FundArb v15 | Delta + CoinDCX | Port ${PORT}`)
);
