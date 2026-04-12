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
//  DELTA EXCHANGE INDIA  (Futures perpetual)
//  Public: GET /v2/tickers?contract_types=perpetual_futures
//  Auth: HMAC-SHA256 on method+ts+path+qs+body
// ─────────────────────────────────────────────────────
const DELTA = 'https://api.india.delta.exchange';

function dSign(secret, method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', secret)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function dPub(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA + ep + qs, {
    timeout: 12000,
    headers: { Accept: 'application/json', 'User-Agent': 'FundArb/7' }
  });
  return r.data;
}

async function dAuth(key, secret, method, ep, query = {}, body = null) {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const qs  = Object.keys(query).length ? '?' + new URLSearchParams(query) : '';
  const bs  = body ? JSON.stringify(body) : '';
  const sig = dSign(secret, method, ep, qs, bs, ts);
  const cfg = {
    method, url: DELTA + ep + qs, timeout: 12000,
    headers: {
      'api-key': key, timestamp: ts, signature: sig,
      'Content-Type': 'application/json', 'User-Agent': 'FundArb/7'
    }
  };
  if (body) cfg.data = body;
  return (await axios(cfg)).data;
}

function parseDelta(raw) {
  const list = raw?.result || raw?.data?.result || raw?.data || [];
  const map  = {};
  for (const t of (Array.isArray(list) ? list : [])) {
    const base = (t.underlying_asset_symbol || '').toUpperCase();
    if (!base) continue;
    const fr = parseFloat(t.funding_rate || t.funding_rate_8h || 0);
    const price = parseFloat(t.mark_price || t.last_price || t.close || 0);
    if (price <= 0) continue;
    map[base] = {
      symbol:       t.symbol || '',
      productId:    t.id || t.product_id,
      price,
      fundingRate:  +(fr * 100).toFixed(6),   // store as % e.g. 0.01
      volume24h:    parseFloat(t.volume || t.turnover_usd || 0),
      change24h:    parseFloat(t.price_change_percent || 0),
      nextFunding:  t.next_funding_realization || null,
      openInterest: parseFloat(t.open_interest || 0)
    };
  }
  return map;
}

// ─────────────────────────────────────────────────────
//  COINDCX  (Futures / Derivatives perpetual)
//  CoinDCX futures API uses USDT-settled perpetuals.
//  Contracts endpoint: /exchange/v1/derivatives/futures/contracts
//  Each contract contains: funding_rate, mark_price, last_price, symbol
//  Auth: POST body + HMAC-SHA256 of JSON body string
// ─────────────────────────────────────────────────────
const DCX = 'https://api.coindcx.com';

function cSign(secret, bodyObj) {
  return crypto.createHmac('sha256', secret)
    .update(JSON.stringify(bodyObj)).digest('hex');
}

async function cGet(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DCX + ep + qs, {
    timeout: 10000,
    headers: { Accept: 'application/json', 'User-Agent': 'FundArb/7' }
  });
  return r.data;
}

async function cAuth(key, secret, ep, bodyObj = {}) {
  const body = { ...bodyObj, timestamp: Date.now() };
  const sig  = cSign(secret, body);
  const r    = await axios.post(DCX + ep, body, {
    timeout: 12000,
    headers: {
      'X-AUTH-APIKEY': key, 'X-AUTH-SIGNATURE': sig,
      'Content-Type': 'application/json', 'User-Agent': 'FundArb/7'
    }
  });
  return r.data;
}

// Fetch CoinDCX futures contracts and funding rates
// Tries multiple endpoints in order of reliability
async function fetchDCX() {
  let contracts = [];
  let source    = 'none';

  // Primary: derivatives futures contracts (most complete)
  const tryEndpoints = [
    '/exchange/v1/derivatives/futures/contracts',
    '/exchange/v1/derivatives/contracts',
    '/exchange/v1/futures/contracts',
  ];

  for (const ep of tryEndpoints) {
    try {
      const r    = await cGet(ep);
      const list = Array.isArray(r) ? r
                 : Array.isArray(r?.contracts) ? r.contracts
                 : Array.isArray(r?.data) ? r.data
                 : [];
      if (list.length > 0) { contracts = list; source = ep; break; }
    } catch (_) {}
  }

  // Fallback: markets_details filtered for futures type
  if (contracts.length === 0) {
    try {
      const r   = await cGet('/exchange/v1/markets_details');
      const all = Array.isArray(r) ? r : [];
      contracts = all.filter(m => {
        const code = (m.coindcx_code || m.symbol || '').toUpperCase();
        const type = (m.market_type  || '').toLowerCase();
        return code.startsWith('B-') || type.includes('futures') ||
               type.includes('deriv') || type.includes('perp') ||
               code.includes('PERP') || code.includes('_FUT');
      });
      source = 'markets_details (filtered)';
    } catch (_) {}
  }

  // Also try to get live ticker prices for better price data
  const tickerMap = {};
  try {
    const r   = await cGet('/exchange/ticker');
    const all = Array.isArray(r) ? r : [];
    for (const t of all) {
      const sym = (t.market || '').toUpperCase();
      tickerMap[sym] = t;
    }
  } catch (_) {}

  // Also try dedicated funding rate endpoint
  const fundingMap = {};
  try {
    const r = await cGet('/exchange/v1/derivatives/futures/funding_rates');
    if (r && typeof r === 'object') {
      if (Array.isArray(r)) {
        r.forEach(x => {
          if (x.symbol || x.market) {
            fundingMap[(x.symbol || x.market).toUpperCase()] =
              parseFloat(x.funding_rate || x.rate || 0);
          }
        });
      } else {
        Object.entries(r).forEach(([k, v]) => {
          fundingMap[k.toUpperCase()] = typeof v === 'object'
            ? parseFloat(v.rate || v.funding_rate || 0)
            : parseFloat(v);
        });
      }
    }
  } catch (_) {}

  // Parse all contracts into standardised map
  const map = {};
  for (const c of contracts) {
    const sym = (c.coindcx_code || c.symbol || c.market || '').toUpperCase();
    if (!sym) continue;

    // Extract base asset
    let base = '';
    if (sym.startsWith('B-'))       base = sym.slice(2).split('_')[0].replace(/USDT?$/i, '');
    else if (sym.includes('_PERP')) base = sym.split('_PERP')[0].replace(/USDT?$/i, '').replace(/_/g, '');
    else if (sym.includes('_FUT'))  base = sym.split('_FUT')[0].replace(/USDT?$/i, '').replace(/_/g, '');
    else if (sym.endsWith('USDT'))  base = sym.replace(/USDT$/, '');
    else if (sym.includes('_USDT')) base = sym.split('_USDT')[0].replace(/_/g, '');
    else base = (c.target_currency_short_name || c.base_currency_short_name || c.base || '').toUpperCase();

    if (!base || base.length < 2 || base.length > 10) continue;

    // Price: try mark_price → last_price → ticker → close
    let price = parseFloat(c.mark_price || c.markPrice || c.last_price || c.lastPrice || c.price || c.close || 0);
    const ticker = tickerMap[sym] || tickerMap[base + 'USDT'];
    if (price <= 0 && ticker) price = parseFloat(ticker.last_price || 0);
    if (price <= 0) continue;

    // Funding rate: contract field → dedicated fundingMap → ticker field
    let fr = parseFloat(
      c.funding_rate || c.fundingRate || c.current_funding_rate ||
      c.predicted_funding_rate || 0
    );
    if (fr === 0) fr = fundingMap[sym] || fundingMap[base + 'USDT'] || 0;
    if (fr === 0 && ticker) fr = parseFloat(ticker.funding_rate || ticker.predicted_funding_rate || 0);
    // Normalize: if very small decimal it's a fraction → convert to %
    if (fr !== 0 && Math.abs(fr) < 0.001) fr = fr * 100;

    // Volume
    const vol = parseFloat(c.volume_24h || c.base_volume || ticker?.volume || 0);

    // 24h change
    const chg = parseFloat(c.price_change_24h || c.change_24h || ticker?.change_24_hour || 0);

    map[base] = {
      symbol:      sym,
      price,
      fundingRate: +fr.toFixed(6),
      volume24h:   vol,
      change24h:   chg,
      nextFunding: c.next_funding_time || c.next_funding_settlement || null
    };
  }

  return { map, ok: Object.keys(map).length > 0, source, total: contracts.length };
}

// ─────────────────────────────────────────────────────
//  STRATEGY LOGIC
//  Given deltaFundingRate (dR) and dcxFundingRate (cR):
//
//  Both negative (e.g., -0.8 and -0.4):
//    Long on more-negative (-0.8): receive 0.8% every 8h
//    Short on less-negative (-0.4): pay 0.4% but hedge
//    Net funding earned = 0.8 - 0.4 = 0.4% per period
//    Market direction doesn't matter (delta neutral)
//
//  Both positive (e.g., +0.5 and +0.2):
//    Short on more-positive (+0.5): receive 0.5% every 8h
//    Long on less-positive (+0.2): pay 0.2% but hedge
//    Net = 0.5 - 0.2 = 0.3%
//
//  One positive, one negative (GOLDMINE):
//    Short on positive exchange: receive funding
//    Long on negative exchange: receive funding
//    Net = |positive| + |negative| = total from BOTH sides
// ─────────────────────────────────────────────────────
function calcStrategy(dR, cR) {
  const FEES = 0.10; // 0.05% taker * 2 sides = 0.10% round-trip
  const diff = Math.abs(dR - cR);
  const net  = diff - FEES;

  let longEx, shortEx, scenario, scenarioType;

  if (dR >= 0 && cR >= 0) {
    // Both positive → Short higher, Long lower
    scenarioType = 'positive';
    scenario     = 'Both Positive';
    if (dR >= cR) { shortEx = 'Delta'; longEx = 'CoinDCX'; }
    else           { shortEx = 'CoinDCX'; longEx = 'Delta'; }
  } else if (dR <= 0 && cR <= 0) {
    // Both negative → Long more-negative (lower), Short less-negative (higher)
    scenarioType = 'negative';
    scenario     = 'Both Negative';
    if (dR < cR) { longEx = 'Delta'; shortEx = 'CoinDCX'; }  // dR more negative → Long Delta
    else          { longEx = 'CoinDCX'; shortEx = 'Delta'; }
  } else {
    // GOLDMINE: one positive, one negative → Short positive, Long negative
    scenarioType = 'goldmine';
    scenario     = 'GOLDMINE';
    if (dR > 0) { shortEx = 'Delta'; longEx = 'CoinDCX'; }
    else         { shortEx = 'CoinDCX'; longEx = 'Delta'; }
  }

  return { longEx, shortEx, scenario, scenarioType, diff: +diff.toFixed(6), net: +net.toFixed(6) };
}

// ─────────────────────────────────────────────────────
//  HEALTH
// ─────────────────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: '7.0.0', ts: Date.now() }));

// ─────────────────────────────────────────────────────
//  DEBUG
// ─────────────────────────────────────────────────────
app.get('/debug/delta', async (_req, res) => {
  try {
    const d    = await dPub('/v2/tickers', { contract_types: 'perpetual_futures' });
    const map  = parseDelta(d);
    const list = d?.result || d?.data || [];
    res.json({
      ok: true, count: list.length, parsedCount: Object.keys(map).length,
      sample: Object.entries(map).slice(0, 5).map(([b, v]) => ({
        base: b, symbol: v.symbol, price: v.price, fundingRate: v.fundingRate
      }))
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/debug/dcx', async (_req, res) => {
  try {
    const r  = await fetchDCX();
    const wf = Object.values(r.map).filter(v => v.fundingRate !== 0).length;
    res.json({
      ok: r.ok, source: r.source,
      totalContracts: r.total, parsedCoins: Object.keys(r.map).length,
      withFundingRate: wf,
      sampleCoins: Object.keys(r.map).slice(0, 10),
      sample: Object.entries(r.map).slice(0, 5).map(([b, v]) => ({
        base: b, symbol: v.symbol, price: v.price, fundingRate: v.fundingRate
      }))
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ─────────────────────────────────────────────────────
//  SCAN  — main endpoint
// ─────────────────────────────────────────────────────
app.post('/api/scan', async (_req, res) => {
  try {
    const [dRaw, cRaw] = await Promise.allSettled([
      dPub('/v2/tickers', { contract_types: 'perpetual_futures' }),
      fetchDCX()
    ]);

    const deltaMap = dRaw.status === 'fulfilled' ? parseDelta(dRaw.value) : {};
    const dcxMap   = cRaw.status  === 'fulfilled' && cRaw.value.ok ? cRaw.value.map : {};
    const deltaOk  = Object.keys(deltaMap).length > 0;
    const dcxOk    = Object.keys(dcxMap).length > 0;

    const opps = [];

    for (const [base, d] of Object.entries(deltaMap)) {
      const c = dcxMap[base];
      if (!c || d.price <= 0 || c.price <= 0) continue;

      const dR = d.fundingRate, cR = c.fundingRate;
      const { longEx, shortEx, scenario, scenarioType, diff, net } = calcStrategy(dR, cR);
      const avg = (d.price + c.price) / 2;
      const spr = avg > 0 ? +((Math.abs(d.price - c.price) / avg) * 100).toFixed(4) : 0;

      // Urgency scoring: more diff + closer to funding = higher score
      const now  = new Date();
      const sec  = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
      const rem  = 8*3600 - (sec % (8*3600));
      const urg  = rem <= 1800 ? 'urgent' : rem <= 3600 ? 'soon' : 'normal';
      const urgW = urg === 'urgent' ? 2.0 : urg === 'soon' ? 1.5 : 1.0;
      const scW  = scenarioType === 'goldmine' ? 2.5 : 1.0;
      const score = diff * scW * urgW;

      opps.push({
        base,
        deltaSymbol: d.symbol, dcxSymbol: c.symbol,
        deltaProductId: d.productId,
        deltaPrice: d.price, dcxPrice: c.price,
        deltaFunding: dR, dcxFunding: cR,
        fundingDiff: diff, netYield: net,
        spread: spr,
        volume: +(Math.max(d.volume24h, c.volume24h)).toFixed(2),
        deltaChange24h: d.change24h, dcxChange24h: c.change24h,
        longExchange: longEx, shortExchange: shortEx,
        scenario, scenarioType, urgency: urg, score
      });
    }

    opps.sort((a, b) => b.score - a.score);

    res.json({
      success: true, data: opps, count: opps.length,
      deltaCount: Object.keys(deltaMap).length,
      dcxCount:   Object.keys(dcxMap).length,
      deltaOk, dcxOk, ts: Date.now()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─────────────────────────────────────────────────────
//  ORDER  — fire both simultaneously
// ─────────────────────────────────────────────────────
app.post('/api/order', async (req, res) => {
  const {
    deltaKey, deltaSecret, dcxKey, dcxSecret,
    deltaProductId, dcxSymbol, longExchange,
    quantity, leverage, orderType,
    limitPriceDelta, limitPriceDcx
  } = req.body;

  if (!deltaKey || !dcxKey)
    return res.status(400).json({ success: false, error: 'API keys not set. Open Settings.' });

  // Delta order
  const dSide  = longExchange === 'Delta' ? 'buy' : 'sell';
  const dBody  = {
    product_id: parseInt(deltaProductId),
    size:       parseFloat(quantity),
    side:       dSide,
    order_type: orderType === 'limit' ? 'limit_order' : 'market_order',
    ...(orderType === 'limit' && limitPriceDelta && { limit_price: String(limitPriceDelta) })
  };
  if (leverage) dBody.leverage = String(leverage);

  // CoinDCX order
  const cSide  = longExchange === 'CoinDCX' ? 'buy' : 'sell';
  const cBody  = {
    market:     dcxSymbol,
    side:       cSide,
    order_type: orderType === 'limit' ? 'limit_order' : 'market_order',
    quantity:   parseFloat(quantity),
    ...(leverage && { leverage: parseInt(leverage) }),
    ...(orderType === 'limit' && limitPriceDcx && { price: parseFloat(limitPriceDcx) })
  };

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, dBody),
    cAuth(dcxKey, dcxSecret, '/exchange/v1/orders/create', cBody)
  ]);

  res.json({
    success: true, latencyMs: Date.now() - t0,
    bothOk:  dr.status === 'fulfilled' && cr.status === 'fulfilled',
    delta: dr.status === 'fulfilled'
      ? { ok: true,  orderId: dr.value?.result?.id || dr.value?.id }
      : { ok: false, error: dr.reason?.response?.data || dr.reason?.message },
    dcx: cr.status === 'fulfilled'
      ? { ok: true,  orderId: cr.value?.orders?.[0]?.id || cr.value?.id }
      : { ok: false, error: cr.reason?.response?.data || cr.reason?.message }
  });
});

// ─────────────────────────────────────────────────────
//  EXIT  — close both simultaneously (reduce-only)
// ─────────────────────────────────────────────────────
app.post('/api/exit', async (req, res) => {
  const { deltaKey, deltaSecret, dcxKey, dcxSecret,
    deltaProductId, dcxSymbol, longExchange, quantity } = req.body;

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, {
      product_id: parseInt(deltaProductId), size: parseFloat(quantity),
      side: longExchange === 'Delta' ? 'sell' : 'buy',
      order_type: 'market_order', reduce_only: true
    }),
    cAuth(dcxKey, dcxSecret, '/exchange/v1/orders/create', {
      market: dcxSymbol, side: longExchange === 'CoinDCX' ? 'sell' : 'buy',
      order_type: 'market_order', quantity: parseFloat(quantity)
    })
  ]);

  res.json({
    success: true, latencyMs: Date.now() - t0,
    delta: dr.status === 'fulfilled' ? { ok: true }  : { ok: false, error: dr.reason?.message },
    dcx:   cr.status === 'fulfilled' ? { ok: true }  : { ok: false, error: cr.reason?.message }
  });
});

// ─────────────────────────────────────────────────────
//  POSITIONS
// ─────────────────────────────────────────────────────
app.post('/api/positions', async (req, res) => {
  const { deltaKey, deltaSecret, dcxKey, dcxSecret } = req.body;
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'GET', '/v2/positions', { page_size: '50' }),
    cAuth(dcxKey, dcxSecret, '/exchange/v1/orders/active_orders')
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: dr.reason?.message },
    dcx:   cr.status === 'fulfilled' ? cr.value : { error: cr.reason?.message }
  });
});

// ─────────────────────────────────────────────────────
//  HISTORY
// ─────────────────────────────────────────────────────
app.post('/api/history', async (req, res) => {
  const { deltaKey, deltaSecret, dcxKey, dcxSecret } = req.body;
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'GET', '/v2/orders', { state: 'closed', page_size: '50' }),
    cAuth(dcxKey, dcxSecret, '/exchange/v1/orders/trade_history', { limit: 50 })
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: dr.reason?.message },
    dcx:   cr.status === 'fulfilled' ? cr.value : { error: cr.reason?.message }
  });
});

// ─────────────────────────────────────────────────────
//  BALANCE
// ─────────────────────────────────────────────────────
app.post('/api/balance', async (req, res) => {
  const { deltaKey, deltaSecret, dcxKey, dcxSecret } = req.body;
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'GET', '/v2/wallet/balances'),
    cAuth(dcxKey, dcxSecret, '/exchange/v1/users/balances')
  ]);

  let deltaUsd = 0;
  if (dr.status === 'fulfilled') {
    const bals = dr.value?.result || [];
    const usdt = Array.isArray(bals) ? bals.find(b => b.asset_symbol === 'USDT') : null;
    deltaUsd   = parseFloat(usdt?.balance || 0);
  }
  let dcxUsd = 0;
  if (cr.status === 'fulfilled') {
    const arr  = Array.isArray(cr.value) ? cr.value : (cr.value?.balance || []);
    const usdt = arr.find?.(b => (b.currency || b.short_name || '').toUpperCase() === 'USDT');
    dcxUsd     = parseFloat(usdt?.balance || usdt?.available_balance || 0);
  }

  res.json({ deltaUsd, dcxUsd, total: deltaUsd + dcxUsd });
});

// ─────────────────────────────────────────────────────
//  SERVE FRONTEND
// ─────────────────────────────────────────────────────
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () =>
  console.log(`FundArb v7 | Delta Exchange India + CoinDCX | Port ${PORT}`));
