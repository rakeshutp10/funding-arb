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

// ═══════════════════════════════════════════════════════════
//  CONSTANTS
// ═══════════════════════════════════════════════════════════
const DELTA_BASE = 'https://api.india.delta.exchange';
const DCX_BASE   = 'https://api.coindcx.com';

// ═══════════════════════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════════════════════
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: '5.0.0', ts: Date.now() }));

// ═══════════════════════════════════════════════════════════
//  DELTA EXCHANGE INDIA — HMAC SHA256
//  Docs: https://docs.india.delta.exchange
// ═══════════════════════════════════════════════════════════
function deltaSign(secret, method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', secret)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function deltaPublic(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA_BASE + ep + qs, {
    timeout: 12000,
    headers: { 'Accept': 'application/json', 'User-Agent': 'FundingArb/5.0' }
  });
  return r.data;
}

async function deltaPrivate(key, secret, method, ep, query = {}, body = null) {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const qs  = Object.keys(query).length ? '?' + new URLSearchParams(query) : '';
  const bs  = body ? JSON.stringify(body) : '';
  const sig = deltaSign(secret, method, ep, qs, bs, ts);
  const cfg = {
    method, url: DELTA_BASE + ep + qs, timeout: 12000,
    headers: {
      'api-key': key, 'timestamp': ts, 'signature': sig,
      'Content-Type': 'application/json', 'User-Agent': 'FundingArb/5.0'
    }
  };
  if (body) cfg.data = body;
  return (await axios(cfg)).data;
}

// ═══════════════════════════════════════════════════════════
//  COINDCX — HMAC SHA256
//  Docs: https://docs.coindcx.com
//  Auth: X-AUTH-APIKEY header + X-AUTH-SIGNATURE (HMAC of JSON body)
//  Indian exchange — NO IP blocking on Railway
// ═══════════════════════════════════════════════════════════
function dcxSign(secret, bodyObj) {
  const bodyStr = JSON.stringify(bodyObj);
  return crypto.createHmac('sha256', secret).update(bodyStr).digest('hex');
}

async function dcxPublic(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DCX_BASE + ep + qs, {
    timeout: 12000,
    headers: { 'Accept': 'application/json', 'User-Agent': 'FundingArb/5.0' }
  });
  return r.data;
}

async function dcxPrivate(key, secret, ep, bodyObj = {}) {
  const body = { ...bodyObj, timestamp: Date.now() };
  const sig  = dcxSign(secret, body);
  const r    = await axios.post(DCX_BASE + ep, body, {
    timeout: 12000,
    headers: {
      'X-AUTH-APIKEY': key,
      'X-AUTH-SIGNATURE': sig,
      'Content-Type': 'application/json',
      'User-Agent': 'FundingArb/5.0'
    }
  });
  return r.data;
}

// ═══════════════════════════════════════════════════════════
//  PARSE DELTA TICKERS
// ═══════════════════════════════════════════════════════════
function parseDelta(raw) {
  const list = raw?.result || raw?.data?.result || raw?.data || [];
  const map  = {};
  for (const t of (Array.isArray(list) ? list : [])) {
    const base = (t.underlying_asset_symbol || '').toUpperCase();
    if (!base) continue;
    // funding_rate comes as decimal e.g. 0.0001 = 0.01%
    const fr = parseFloat(t.funding_rate || t.funding_rate_8h || 0);
    map[base] = {
      symbol:      t.symbol || '',
      productId:   t.id || t.product_id,
      price:       parseFloat(t.mark_price || t.last_price || t.close || 0),
      fundingRate: fr * 100,   // stored as percent e.g. 0.01
      volume24h:   parseFloat(t.volume || t.turnover_usd || 0),
      change24h:   parseFloat(t.price_change_percent || 0),
      nextFunding: t.next_funding_realization || null,
      oi:          parseFloat(t.open_interest || 0)
    };
  }
  return map;
}

// ═══════════════════════════════════════════════════════════
//  PARSE COINDCX TICKERS
//  CoinDCX ticker endpoint returns array of all markets.
//  Futures/perpetual symbols end with "_PERP" or have
//  market_type = "futures" or "perpetual"
// ═══════════════════════════════════════════════════════════
function parseDCX(tickerArr, marketsArr, fundingMap) {
  const map = {};
  if (!Array.isArray(tickerArr)) return map;

  // Build a quick lookup for market details
  const mktDetails = {};
  if (Array.isArray(marketsArr)) {
    for (const m of marketsArr) {
      mktDetails[m.market || m.symbol || ''] = m;
    }
  }

  for (const t of tickerArr) {
    const sym = (t.market || t.symbol || '').toUpperCase();

    // Filter: only perpetual futures markets
    // CoinDCX futures symbols look like: "BTCUSDT_PERP", "ETHUSDT_PERP"
    // or sometimes just "BTC_USDT_FUTURES"
    const mInfo = mktDetails[sym] || mktDetails[t.market] || {};
    const mType = (mInfo.market_type || mInfo.type || '').toLowerCase();
    const isFutures = sym.includes('PERP') || sym.includes('FUTURES') ||
                      sym.includes('_FUT') || mType === 'futures' ||
                      mType === 'perpetual' || mType === 'derivatives';
    if (!isFutures) continue;

    // Extract base asset
    let base = '';
    if (sym.includes('_PERP')) base = sym.split('_PERP')[0].replace(/_USDT?$/, '').replace(/USDT?$/, '');
    else if (sym.includes('_FUTURES')) base = sym.split('_FUTURES')[0].replace(/USDT?$/, '').replace(/_/g, '');
    else base = (mInfo.base_currency_short_name || mInfo.base || '').toUpperCase();

    if (!base) continue;

    const price = parseFloat(t.last_price || t.lastPrice || t.mark_price || t.close || 0);
    if (price <= 0) continue;

    // Funding rate: from dedicated endpoint or ticker
    let fr = parseFloat(
      fundingMap?.[sym] ||
      t.funding_rate || t.fundingRate ||
      t.predicted_funding_rate || 0
    );
    // Normalize if needed
    if (fr !== 0 && Math.abs(fr) < 0.001) fr = fr * 100;

    map[base] = {
      symbol:      sym,
      price,
      fundingRate: fr,
      volume24h:   parseFloat(t.volume || t.baseVolume || t.quote_volume || 0),
      change24h:   parseFloat(t.change_24_hour || t.priceChangePercent || t.change || 0),
      nextFunding: t.next_funding_time || null
    };
  }
  return map;
}

// ═══════════════════════════════════════════════════════════
//  FETCH COINDCX MARKET DATA
// ═══════════════════════════════════════════════════════════
async function fetchDCXData() {
  let tickers = [], markets = [], fundingMap = {};

  // Tickers — multiple endpoint fallback
  const tickerEndpoints = [
    '/exchange/ticker',
    '/exchange/v1/markets_details',
    '/market-data/orderbooks',
  ];

  for (const ep of tickerEndpoints) {
    try {
      const r = await dcxPublic(ep);
      const list = Array.isArray(r) ? r : (r?.data || r?.markets || []);
      if (list.length > 0) { tickers = list; break; }
    } catch (_) {}
  }

  // Market details (for type info)
  try {
    const r = await dcxPublic('/exchange/v1/markets_details');
    markets = Array.isArray(r) ? r : (r?.markets || []);
  } catch (_) {}

  // Funding rates — dedicated endpoint if available
  const fundingEndpoints = [
    '/exchange/v1/futures/funding_rates',
    '/exchange/v1/derivatives/funding_rates',
    '/exchange/v1/futures/funding_rate',
  ];
  for (const ep of fundingEndpoints) {
    try {
      const r = await dcxPublic(ep);
      if (r && typeof r === 'object') {
        // might be { "BTCUSDT_PERP": 0.0001, ... } or array
        if (Array.isArray(r)) {
          r.forEach(x => { if (x.symbol && x.rate !== undefined) fundingMap[x.symbol] = x.rate; });
        } else {
          fundingMap = r;
        }
        break;
      }
    } catch (_) {}
  }

  return { tickers, markets, fundingMap };
}

// ═══════════════════════════════════════════════════════════
//  DEBUG ENDPOINTS
// ═══════════════════════════════════════════════════════════
app.get('/debug/delta', async (_req, res) => {
  try {
    const d = await deltaPublic('/v2/tickers', { contract_types: 'perpetual_futures' });
    const list = d?.result || d?.data || [];
    res.json({
      ok: true, count: list.length,
      sample: list.slice(0, 3).map(t => ({
        base:    t.underlying_asset_symbol,
        symbol:  t.symbol,
        price:   t.mark_price,
        funding: t.funding_rate
      }))
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/debug/dcx', async (_req, res) => {
  try {
    const { tickers, markets, fundingMap } = await fetchDCXData();
    const parsed = parseDCX(tickers, markets, fundingMap);
    const count  = Object.keys(parsed).length;

    // Show raw ticker sample (first 3) so we can see structure
    const rawSample = tickers.slice(0, 5).map(t => ({
      market: t.market || t.symbol,
      last_price: t.last_price,
      type: (markets.find(m => m.market === t.market) || {}).market_type
    }));

    res.json({
      ok: true,
      totalTickers: tickers.length,
      futuresParsed: count,
      fundingEntries: Object.keys(fundingMap).length,
      parsedCoins: Object.keys(parsed).slice(0, 10),
      rawSample,
      parsedSample: Object.entries(parsed).slice(0, 3).map(([b, v]) => ({
        base: b, symbol: v.symbol, price: v.price, fundingRate: v.fundingRate
      }))
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  SCAN — main data endpoint
// ═══════════════════════════════════════════════════════════
app.post('/api/scan', async (req, res) => {
  try {
    const TAKER = 0.0005; // 0.05% per side

    const [deltaRaw, dcxRaw] = await Promise.allSettled([
      deltaPublic('/v2/tickers', { contract_types: 'perpetual_futures' }),
      fetchDCXData()
    ]);

    // Parse Delta
    let deltaMap = {}, deltaOk = false;
    if (deltaRaw.status === 'fulfilled') {
      deltaMap = parseDelta(deltaRaw.value);
      deltaOk  = Object.keys(deltaMap).length > 0;
    }

    // Parse CoinDCX
    let dcxMap = {}, dcxOk = false;
    if (dcxRaw.status === 'fulfilled') {
      const { tickers, markets, fundingMap } = dcxRaw.value;
      dcxMap = parseDCX(tickers, markets, fundingMap);
      dcxOk  = Object.keys(dcxMap).length > 0;
    }

    // Match coins present on BOTH exchanges
    const FEES = TAKER * 2 * 100; // 0.10%
    const opps = [];

    for (const [base, d] of Object.entries(deltaMap)) {
      const c = dcxMap[base];
      if (!c || d.price <= 0 || c.price <= 0) continue;

      const dR   = d.fundingRate;
      const cR   = c.fundingRate;
      const diff = Math.abs(dR - cR);
      const avg  = (d.price + c.price) / 2;
      const spr  = avg > 0 ? Math.abs(d.price - c.price) / avg * 100 : 0;
      const net  = diff - FEES;

      // Strategy
      let longEx, shortEx, scenario, scenarioType;
      if (dR >= 0 && cR >= 0) {
        scenarioType = 'positive'; scenario = 'Both Positive';
        dR >= cR
          ? (shortEx = 'Delta', longEx = 'CoinDCX')
          : (shortEx = 'CoinDCX', longEx = 'Delta');
      } else if (dR <= 0 && cR <= 0) {
        scenarioType = 'negative'; scenario = 'Both Negative';
        dR > cR
          ? (shortEx = 'Delta', longEx = 'CoinDCX')
          : (shortEx = 'CoinDCX', longEx = 'Delta');
      } else {
        scenarioType = 'goldmine'; scenario = 'GOLDMINE';
        dR > 0
          ? (shortEx = 'Delta', longEx = 'CoinDCX')
          : (shortEx = 'CoinDCX', longEx = 'Delta');
      }

      // Urgency score
      const now  = new Date();
      const sec  = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
      const rem8 = 8*3600 - (sec % (8*3600));
      const urg  = rem8 <= 1800 ? 'urgent' : rem8 <= 3600 ? 'soon' : 'normal';
      const score= diff * (scenarioType === 'goldmine' ? 2.5 : 1) *
                   (urg === 'urgent' ? 2 : urg === 'soon' ? 1.5 : 1);

      opps.push({
        base,
        deltaSymbol:    d.symbol,
        dcxSymbol:      c.symbol,
        deltaProductId: d.productId,
        deltaPrice:     d.price,
        dcxPrice:       c.price,
        deltaFunding:   +dR.toFixed(6),
        dcxFunding:     +cR.toFixed(6),
        fundingDiff:    +diff.toFixed(6),
        netYield:       +net.toFixed(6),
        spread:         +spr.toFixed(4),
        feesDeducted:   +FEES.toFixed(4),
        volume:         Math.max(d.volume24h, c.volume24h),
        deltaChange24h: d.change24h,
        dcxChange24h:   c.change24h,
        longExchange:   longEx,
        shortExchange:  shortEx,
        scenario, scenarioType, urgency: urg, score
      });
    }

    opps.sort((a, b) => b.score - a.score);

    res.json({
      success: true, data: opps, count: opps.length,
      deltaCount: Object.keys(deltaMap).length,
      dcxCount:   Object.keys(dcxMap).length,
      matchedCount: opps.length,
      deltaOk, dcxOk,
      ts: Date.now()
    });
  } catch (err) {
    console.error('[SCAN]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  ORDER — fire both exchanges simultaneously
// ═══════════════════════════════════════════════════════════
app.post('/api/order', async (req, res) => {
  const {
    deltaKey, deltaSecret, dcxKey, dcxSecret,
    deltaSymbol, dcxSymbol, deltaProductId, longExchange,
    quantity, leverage, orderType, limitPriceDelta, limitPriceDcx
  } = req.body;

  if (!deltaKey || !dcxKey)
    return res.status(400).json({ success: false, error: 'API keys required in Settings.' });

  const deltaSide = longExchange === 'Delta'   ? 'buy'  : 'sell';
  const dcxSide   = longExchange === 'CoinDCX' ? 'buy'  : 'sell';

  const deltaBody = {
    product_id: parseInt(deltaProductId),
    size: parseInt(quantity), side: deltaSide,
    order_type: orderType === 'limit' ? 'limit_order' : 'market_order',
    ...(orderType === 'limit' && limitPriceDelta && { limit_price: String(limitPriceDelta) })
  };
  if (leverage) deltaBody.leverage = String(leverage);

  // CoinDCX futures order
  // Docs: https://docs.coindcx.com/#place-an-order
  const dcxOrderBody = {
    market:    dcxSymbol,
    side:      dcxSide,
    order_type: orderType === 'limit' ? 'limit_order' : 'market_order',
    quantity:  parseFloat(quantity),
    ...(leverage && { leverage: parseInt(leverage) }),
    ...(orderType === 'limit' && limitPriceDcx && { price: parseFloat(limitPriceDcx) })
  };

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    deltaPrivate(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, deltaBody),
    dcxPrivate(dcxKey, dcxSecret, '/exchange/v1/orders/create', dcxOrderBody)
  ]);
  const latency = Date.now() - t0;

  res.json({
    success: true, latencyMs: latency,
    bothOk: dr.status === 'fulfilled' && cr.status === 'fulfilled',
    delta: dr.status === 'fulfilled'
      ? { ok: true, data: dr.value, orderId: dr.value?.result?.id || dr.value?.id }
      : { ok: false, error: dr.reason?.response?.data || dr.reason?.message },
    dcx: cr.status === 'fulfilled'
      ? { ok: true, data: cr.value, orderId: cr.value?.orders?.[0]?.id || cr.value?.id }
      : { ok: false, error: cr.reason?.response?.data || cr.reason?.message }
  });
});

// ═══════════════════════════════════════════════════════════
//  EXIT — close both positions simultaneously
// ═══════════════════════════════════════════════════════════
app.post('/api/exit', async (req, res) => {
  const { deltaKey, deltaSecret, dcxKey, dcxSecret,
    deltaProductId, dcxSymbol, longExchange, quantity } = req.body;

  const deltaExitSide = longExchange === 'Delta'   ? 'sell' : 'buy';
  const dcxExitSide   = longExchange === 'CoinDCX' ? 'sell' : 'buy';

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    deltaPrivate(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, {
      product_id: parseInt(deltaProductId), size: parseInt(quantity),
      side: deltaExitSide, order_type: 'market_order', reduce_only: true
    }),
    dcxPrivate(dcxKey, dcxSecret, '/exchange/v1/orders/create', {
      market: dcxSymbol, side: dcxExitSide,
      order_type: 'market_order', quantity: parseFloat(quantity)
    })
  ]);

  res.json({
    success: true, latencyMs: Date.now() - t0,
    delta: dr.status === 'fulfilled'
      ? { ok: true,  data: dr.value }
      : { ok: false, error: dr.reason?.message },
    dcx:   cr.status === 'fulfilled'
      ? { ok: true,  data: cr.value }
      : { ok: false, error: cr.reason?.message }
  });
});

// ═══════════════════════════════════════════════════════════
//  POSITIONS
// ═══════════════════════════════════════════════════════════
app.post('/api/positions', async (req, res) => {
  const { deltaKey, deltaSecret, dcxKey, dcxSecret } = req.body;
  const [dr, cr] = await Promise.allSettled([
    deltaPrivate(deltaKey, deltaSecret, 'GET', '/v2/positions', { page_size: '50' }),
    dcxPrivate(dcxKey, dcxSecret, '/exchange/v1/orders/active_orders')
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: dr.reason?.message },
    dcx:   cr.status === 'fulfilled' ? cr.value : { error: cr.reason?.message }
  });
});

// ═══════════════════════════════════════════════════════════
//  HISTORY
// ═══════════════════════════════════════════════════════════
app.post('/api/history', async (req, res) => {
  const { deltaKey, deltaSecret, dcxKey, dcxSecret } = req.body;
  const [dr, cr] = await Promise.allSettled([
    deltaPrivate(deltaKey, deltaSecret, 'GET', '/v2/orders', { state: 'closed', page_size: '50' }),
    dcxPrivate(dcxKey, dcxSecret, '/exchange/v1/orders/trade_history', { limit: 50 })
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: dr.reason?.message },
    dcx:   cr.status === 'fulfilled' ? cr.value : { error: cr.reason?.message }
  });
});

// ═══════════════════════════════════════════════════════════
//  BALANCE — both in USD
// ═══════════════════════════════════════════════════════════
app.post('/api/balance', async (req, res) => {
  const { deltaKey, deltaSecret, dcxKey, dcxSecret } = req.body;
  const [dr, cr] = await Promise.allSettled([
    deltaPrivate(deltaKey, deltaSecret, 'GET', '/v2/wallet/balances'),
    dcxPrivate(dcxKey, dcxSecret, '/exchange/v1/users/balances')
  ]);

  let deltaUsd = 0;
  if (dr.status === 'fulfilled') {
    const bals = dr.value?.result || [];
    const usdt = Array.isArray(bals) ? bals.find(b => b.asset_symbol === 'USDT') : null;
    deltaUsd   = parseFloat(usdt?.balance || 0);
  }

  let dcxUsd = 0;
  if (cr.status === 'fulfilled') {
    const bals = cr.value?.balance || cr.value || [];
    // CoinDCX balances: find USDT or INR and convert
    const arr  = Array.isArray(bals) ? bals : Object.values(bals);
    const usdt = arr.find(b => b.currency === 'USDT' || b.short_name === 'USDT');
    dcxUsd     = parseFloat(usdt?.balance || usdt?.available_balance || 0);
  }

  res.json({ deltaUsd, dcxUsd, total: deltaUsd + dcxUsd });
});

// ═══════════════════════════════════════════════════════════
//  SERVE FRONTEND
// ═══════════════════════════════════════════════════════════
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () =>
  console.log(`FundingArb v5.0 | Delta Exchange India + CoinDCX | Port ${PORT}`));
