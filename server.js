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
//  API KEYS — from Railway environment variables only
//  Set these in Railway → your service → Variables tab
//  Never put real keys in this file
// ─────────────────────────────────────────────────────
const DELTA_KEY    = process.env.DELTA_KEY    || '';
const DELTA_SECRET = process.env.DELTA_SECRET || '';
const DCX_KEY      = process.env.DCX_KEY      || '';
const DCX_SECRET   = process.env.DCX_SECRET   || '';

function errMsg(e) {
  if (!e) return 'Unknown error';
  if (e.response?.data) return JSON.stringify(e.response.data);
  if (e.message) return e.message;
  return String(e);
}

// ─────────────────────────────────────────────────────
//  DELTA EXCHANGE INDIA
// ─────────────────────────────────────────────────────
const DELTA = 'https://api.india.delta.exchange';

function dSign(method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', DELTA_SECRET)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function dPub(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA + ep + qs, { timeout: 12000, headers: { Accept: 'application/json' } });
  return r.data;
}

async function dAuth(method, ep, query = {}, body = null) {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const qs  = Object.keys(query).length ? '?' + new URLSearchParams(query) : '';
  const bs  = body ? JSON.stringify(body) : '';
  const sig = dSign(method, ep, qs, bs, ts);
  const cfg = { method, url: DELTA + ep + qs, timeout: 12000,
    headers: { 'api-key': DELTA_KEY, timestamp: ts, signature: sig,
      'Content-Type': 'application/json' } };
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
      symbol: t.symbol || '', productId: t.id || t.product_id,
      price, fundingRate: +(fr * 100).toFixed(6),
      volume24h: parseFloat(t.volume || t.turnover_usd || 0),
      change24h: parseFloat(t.price_change_percent || 0),
      nextFunding: t.next_funding_realization || null
    };
  }
  return map;
}

// ─────────────────────────────────────────────────────
//  COINDCX  (Futures perpetual)
// ─────────────────────────────────────────────────────
const DCX = 'https://api.coindcx.com';

function cSign(bodyObj) {
  return crypto.createHmac('sha256', DCX_SECRET)
    .update(JSON.stringify(bodyObj)).digest('hex');
}

async function cPub(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DCX + ep + qs, { timeout: 10000, headers: { Accept: 'application/json' } });
  return r.data;
}

async function cAuth(ep, bodyObj = {}) {
  const body = { ...bodyObj, timestamp: Date.now() };
  const sig  = cSign(body);
  const r    = await axios.post(DCX + ep, body, { timeout: 12000,
    headers: { 'X-AUTH-APIKEY': DCX_KEY, 'X-AUTH-SIGNATURE': sig, 'Content-Type': 'application/json' } });
  return r.data;
}

async function fetchDCX() {
  const result = { map: {}, ok: false, source: 'none', total: 0, errors: [] };

  // Live ticker map for price fallback
  let tickerMap = {};
  try {
    const arr = await cPub('/exchange/ticker');
    if (Array.isArray(arr)) arr.forEach(t => { tickerMap[(t.market||'').toUpperCase()] = t; });
  } catch (_) {}

  // Funding rate map
  let fundingMap = {};
  const fundingEps = [
    '/exchange/v1/derivatives/futures/funding_rates',
    '/exchange/v1/derivatives/funding_rates',
  ];
  for (const ep of fundingEps) {
    try {
      const r = await cPub(ep);
      if (r && typeof r === 'object') {
        if (Array.isArray(r)) r.forEach(x => { fundingMap[(x.symbol||x.market||'').toUpperCase()] = parseFloat(x.funding_rate||x.rate||0); });
        else Object.entries(r).forEach(([k,v]) => { fundingMap[k.toUpperCase()] = typeof v==='object' ? parseFloat(v.rate||v.funding_rate||0) : parseFloat(v); });
        if (Object.keys(fundingMap).length) break;
      }
    } catch (_) {}
  }

  // Main contract endpoints
  const contractEps = [
    '/exchange/v1/derivatives/futures/contracts',
    '/exchange/v1/derivatives/contracts',
    '/exchange/v1/futures/contracts',
  ];

  for (const ep of contractEps) {
    try {
      const r    = await cPub(ep);
      const list = Array.isArray(r) ? r : (r?.contracts || r?.data || []);
      if (!list.length) continue;
      result.source = ep;
      result.total  = list.length;

      for (const c of list) {
        const sym = (c.coindcx_code || c.symbol || c.market || '').toUpperCase();
        if (!sym) continue;

        let base = '';
        if      (sym.startsWith('B-'))       base = sym.slice(2).split('_')[0];
        else if (sym.includes('_PERP'))      base = sym.split('_PERP')[0].replace(/USDT?$/,'');
        else if (sym.includes('_FUT'))       base = sym.split('_FUT')[0].replace(/USDT?$/,'');
        else if (sym.endsWith('USDT'))       base = sym.replace(/USDT$/,'');
        else if (sym.includes('_USDT'))      base = sym.split('_USDT')[0];
        else base = (c.base_currency_short_name || c.base || '').toUpperCase();
        base = base.replace(/_/g,'');
        if (!base || base.length < 2 || base.length > 10) continue;

        const ticker = tickerMap[sym] || tickerMap[base+'USDT'];
        let price = parseFloat(c.mark_price || c.last_price || c.price || c.close || 0);
        if (price <= 0 && ticker) price = parseFloat(ticker.last_price || 0);
        if (price <= 0) continue;

        let fr = parseFloat(c.funding_rate || c.current_funding_rate || c.predicted_funding_rate || 0);
        if (fr === 0) fr = fundingMap[sym] || fundingMap[base+'USDT'] || 0;
        if (fr === 0 && ticker) fr = parseFloat(ticker.funding_rate || 0);
        if (fr !== 0 && Math.abs(fr) < 0.001) fr = fr * 100;

        result.map[base] = {
          symbol:      sym,
          price,
          fundingRate: +fr.toFixed(6),
          volume24h:   parseFloat(c.volume_24h || c.base_volume || ticker?.volume || 0),
          change24h:   parseFloat(c.price_change_24h || ticker?.change_24_hour || 0),
          nextFunding: c.next_funding_time || null
        };
      }

      if (Object.keys(result.map).length > 0) { result.ok = true; break; }
    } catch (e) { result.errors.push(ep + ': ' + errMsg(e)); }
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
  status:'ok', version:'12.0.0', port:PORT,
  deltaKeySet: !!DELTA_KEY, dcxKeySet: !!DCX_KEY, ts:Date.now()
}));

// ─────────────────────────────────────────────────────
//  DEBUG
// ─────────────────────────────────────────────────────
app.get('/debug/delta', async (_req, res) => {
  try {
    const d   = await dPub('/v2/tickers', { contract_types:'perpetual_futures' });
    const map = parseDelta(d);
    res.json({ ok:true, count:(d?.result||d?.data||[]).length, parsed:Object.keys(map).length,
      sample:Object.entries(map).slice(0,5).map(([b,v])=>({base:b,price:v.price,fundingRate:v.fundingRate})) });
  } catch(e) { res.json({ ok:false, error:errMsg(e) }); }
});

app.get('/debug/dcx', async (_req, res) => {
  try {
    const r  = await fetchDCX();
    const wf = Object.values(r.map).filter(v=>v.fundingRate!==0).length;
    res.json({ ok:r.ok, source:r.source, total:r.total,
      parsed:Object.keys(r.map).length, withFunding:wf,
      errors:r.errors, sampleCoins:Object.keys(r.map).slice(0,10),
      sample:Object.entries(r.map).slice(0,5).map(([b,v])=>({base:b,symbol:v.symbol,price:v.price,fundingRate:v.fundingRate})) });
  } catch(e) { res.json({ ok:false, error:errMsg(e) }); }
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
    const dcxMap   = cR.status==='fulfilled' && cR.value.ok ? cR.value.map : {};
    const deltaOk  = Object.keys(deltaMap).length > 0;
    const dcxOk    = Object.keys(dcxMap).length   > 0;

    const opps = [];
    for (const [base, d] of Object.entries(deltaMap)) {
      const c = dcxMap[base];
      if (!c || d.price<=0 || c.price<=0) continue;
      const { longEx, shortEx, scenario, scenarioType, diff, net } = calcStrat(d.fundingRate, c.fundingRate);
      const avg = (d.price+c.price)/2;
      const spr = avg>0 ? +((Math.abs(d.price-c.price)/avg)*100).toFixed(4) : 0;
      const now = new Date();
      const sec = now.getUTCHours()*3600+now.getUTCMinutes()*60+now.getUTCSeconds();
      const rem = 8*3600-(sec%(8*3600));
      const urg = rem<=1800?'urgent':rem<=3600?'soon':'normal';
      const score = diff*(scenarioType==='goldmine'?2.5:1)*(urg==='urgent'?2:urg==='soon'?1.5:1);
      opps.push({ base, deltaSymbol:d.symbol, dcxSymbol:c.symbol, deltaProductId:d.productId,
        deltaPrice:d.price, dcxPrice:c.price, deltaFunding:d.fundingRate, dcxFunding:c.fundingRate,
        fundingDiff:diff, netYield:net, spread:spr,
        volume:+(Math.max(d.volume24h,c.volume24h)).toFixed(2),
        deltaChange24h:d.change24h, dcxChange24h:c.change24h,
        longExchange:longEx, shortExchange:shortEx,
        scenario, scenarioType, urgency:urg, score });
    }
    opps.sort((a,b)=>b.score-a.score);
    res.json({ success:true, data:opps, count:opps.length,
      deltaCount:Object.keys(deltaMap).length, dcxCount:Object.keys(dcxMap).length,
      deltaOk, dcxOk, ts:Date.now() });
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
  const [dr, cr] = await Promise.allSettled([dAuth('POST','/v2/orders',{},dBody), cAuth('/exchange/v1/orders/create',cBody)]);
  res.json({ success:true, latencyMs:Date.now()-t0, bothOk:dr.status==='fulfilled'&&cr.status==='fulfilled',
    delta:dr.status==='fulfilled'?{ok:true,orderId:dr.value?.result?.id||dr.value?.id}:{ok:false,error:errMsg(dr.reason)},
    dcx:cr.status==='fulfilled'?{ok:true,orderId:cr.value?.orders?.[0]?.id||cr.value?.id}:{ok:false,error:errMsg(cr.reason)} });
});

// ─────────────────────────────────────────────────────
//  EXIT
// ─────────────────────────────────────────────────────
app.post('/api/exit', async (req, res) => {
  const { deltaProductId, dcxSymbol, longExchange, quantity } = req.body;
  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth('POST','/v2/orders',{},{product_id:parseInt(deltaProductId),size:parseFloat(quantity),side:longExchange==='Delta'?'sell':'buy',order_type:'market_order',reduce_only:true}),
    cAuth('/exchange/v1/orders/create',{market:dcxSymbol,side:longExchange==='CoinDCX'?'sell':'buy',order_type:'market_order',quantity:parseFloat(quantity)})
  ]);
  res.json({ success:true, latencyMs:Date.now()-t0,
    delta:dr.status==='fulfilled'?{ok:true}:{ok:false,error:errMsg(dr.reason)},
    dcx:cr.status==='fulfilled'?{ok:true}:{ok:false,error:errMsg(cr.reason)} });
});

// ─────────────────────────────────────────────────────
//  POSITIONS / HISTORY / BALANCE
// ─────────────────────────────────────────────────────
app.post('/api/positions', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([dAuth('GET','/v2/positions',{page_size:'50'}), cAuth('/exchange/v1/orders/active_orders')]);
  res.json({ delta:dr.status==='fulfilled'?dr.value:{error:errMsg(dr.reason)}, dcx:cr.status==='fulfilled'?cr.value:{error:errMsg(cr.reason)} });
});

app.post('/api/history', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([dAuth('GET','/v2/orders',{state:'closed',page_size:'50'}), cAuth('/exchange/v1/orders/trade_history',{limit:50})]);
  res.json({ delta:dr.status==='fulfilled'?dr.value:{error:errMsg(dr.reason)}, dcx:cr.status==='fulfilled'?cr.value:{error:errMsg(cr.reason)} });
});

app.post('/api/balance', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([dAuth('GET','/v2/wallet/balances'), cAuth('/exchange/v1/users/balances')]);
  let deltaUsd=0, dcxUsd=0;
  if (dr.status==='fulfilled') { const bals=dr.value?.result||[]; const u=Array.isArray(bals)?bals.find(b=>b.asset_symbol==='USDT'):null; deltaUsd=parseFloat(u?.balance||0); }
  if (cr.status==='fulfilled') { const arr=Array.isArray(cr.value)?cr.value:(cr.value?.balance||[]); const u=arr.find?.(b=>(b.currency||b.short_name||'').toUpperCase()==='USDT'); dcxUsd=parseFloat(u?.balance||u?.available_balance||0); }
  res.json({ deltaUsd:+deltaUsd.toFixed(2), dcxUsd:+dcxUsd.toFixed(2), totalUsd:+(deltaUsd+dcxUsd).toFixed(2) });
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`FundArb v12 | Delta + CoinDCX | Port ${PORT}`));
