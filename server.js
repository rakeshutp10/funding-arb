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

// ════════════════════════════════════════════════════════════
//  DELTA EXCHANGE INDIA
//  Public API — no key needed for market data
//  Auth — HMAC-SHA256 of method+ts+path+qs+body
// ════════════════════════════════════════════════════════════
const DELTA = 'https://api.india.delta.exchange';

function dSign(secret, method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', secret)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function dPub(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA + ep + qs, {
    timeout: 12000,
    headers: { Accept: 'application/json', 'User-Agent': 'FundArb/8' }
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
      'Content-Type': 'application/json', 'User-Agent': 'FundArb/8'
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
    const fr    = parseFloat(t.funding_rate || t.funding_rate_8h || 0);
    const price = parseFloat(t.mark_price || t.last_price || t.close || 0);
    if (price <= 0) continue;
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

// ════════════════════════════════════════════════════════════
//  COINSWITCH PRO (Indian Exchange)
//  Base URL  : https://coinswitch.co
//  Auth header: CS-ACCESS-KEY, CS-ACCESS-SIGN, CS-ACCESS-TIMESTAMP
//  Signature : HMAC-SHA256 of (timestamp + method + path + body)
//  Futures tickers: GET /trade/api/v2/futures/ticker
//  Funding rates  : included in ticker or separate endpoint
// ════════════════════════════════════════════════════════════
const CS_BASE = 'https://coinswitch.co';
const CS_ALT  = 'https://api.coinswitch.co';

function csSign(secret, ts, method, path, bodyStr) {
  const msg = ts + method + path + (bodyStr || '');
  return crypto.createHmac('sha256', secret).update(msg).digest('hex');
}

function csHeaders(key, secret, method, path, bodyStr) {
  const ts  = Date.now().toString();
  const sig = csSign(secret, ts, method, path, bodyStr || '');
  return {
    'CS-ACCESS-KEY':       key,
    'CS-ACCESS-SIGN':      sig,
    'CS-ACCESS-TIMESTAMP': ts,
    'Content-Type':        'application/json',
    'Accept':              'application/json',
    'User-Agent':          'FundArb/8',
    'Origin':              'https://pro.coinswitch.co',
    'Referer':             'https://pro.coinswitch.co/'
  };
}

async function csPub(path, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  for (const base of [CS_BASE, CS_ALT]) {
    try {
      const r = await axios.get(base + path + qs, {
        timeout: 10000,
        headers: {
          Accept: 'application/json', 'User-Agent': 'FundArb/8',
          'Origin': 'https://pro.coinswitch.co'
        }
      });
      if (r.data) return { data: r.data, base };
    } catch (_) {}
  }
  return null;
}

async function csAuth(key, secret, method, path, params = {}, body = null) {
  const bodyStr = body ? JSON.stringify(body) : '';
  const qs      = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const fullPath = path + qs;
  const hdrs     = csHeaders(key, secret, method.toUpperCase(), fullPath, bodyStr);

  for (const base of [CS_BASE, CS_ALT]) {
    try {
      const cfg = { method, url: base + fullPath, timeout: 12000, headers: hdrs };
      if (body) cfg.data = body;
      const r = await axios(cfg);
      return r.data;
    } catch (e) {
      if (e.response?.status === 401 || e.response?.status === 403) throw e; // auth error, don't retry
    }
  }
  throw new Error('CoinSwitch Pro unreachable');
}

// ────────────────────────────────────────────────────────────
//  FETCH COINSWITCH PRO FUTURES DATA
//  Strategy: try multiple known endpoints in order
// ────────────────────────────────────────────────────────────
async function fetchCS(key, secret) {
  const result = { map: {}, ok: false, source: 'none', total: 0, withFunding: 0 };

  // All possible futures/ticker endpoints for CoinSwitch Pro
  const pubEndpoints = [
    '/trade/api/v2/futures/ticker',
    '/trade/api/v2/futures/tickers',
    '/trade/api/v2/futures/contracts',
    '/trade/api/v2/futures/market_data',
    '/trade/api/v2/ticker',
    '/trade/api/v2/tickers',
    '/pro/v1/futures/tickers',
    '/pro/v1/futures/ticker',
  ];

  let raw = null;
  for (const ep of pubEndpoints) {
    const r = await csPub(ep);
    if (r?.data) {
      raw = r.data;
      result.source = ep;
      break;
    }
  }

  // Try authenticated endpoints if public failed
  if (!raw && key && secret) {
    const authEndpoints = [
      '/trade/api/v2/futures/ticker',
      '/trade/api/v2/futures/contracts',
      '/pro/v1/futures/tickers',
    ];
    for (const ep of authEndpoints) {
      try {
        const r = await csAuth(key, secret, 'GET', ep);
        if (r) { raw = r; result.source = ep + ' (auth)'; break; }
      } catch (_) {}
    }
  }

  if (!raw) return result;

  // Parse the response — CoinSwitch can return array or object
  let list = [];
  if (Array.isArray(raw))           list = raw;
  else if (Array.isArray(raw.data)) list = raw.data;
  else if (Array.isArray(raw.tickers)) list = raw.tickers;
  else if (Array.isArray(raw.result))  list = raw.result;
  else if (typeof raw === 'object') {
    const vals = Object.values(raw);
    if (vals.length && typeof vals[0] === 'object') list = vals;
  }

  result.total = list.length;

  for (const t of list) {
    // Symbol formats: "BTCUSDT", "BTC-USDT-PERP", "BTCUSDT_PERP"
    const sym = (t.symbol || t.pair || t.market || t.instrument || '').toUpperCase();
    if (!sym) continue;

    // Extract base
    let base = '';
    if (sym.includes('-USDT-PERP') || sym.includes('_USDT_PERP'))
      base = sym.split('-')[0].split('_')[0];
    else if (sym.includes('_PERP'))
      base = sym.replace('_PERP', '').replace(/USDT?$/, '');
    else if (sym.endsWith('USDT'))
      base = sym.replace('USDT', '');
    else if (sym.includes('-USDT'))
      base = sym.split('-USDT')[0];
    else
      base = (t.baseAsset || t.base_asset || t.base_currency || '').toUpperCase();

    if (!base || base.length < 2 || base.length > 10) continue;

    const price = parseFloat(
      t.lastPrice || t.last_price || t.markPrice || t.mark_price ||
      t.price || t.close || t.lp || 0
    );
    if (price <= 0) continue;

    // Funding rate
    let fr = parseFloat(
      t.fundingRate || t.funding_rate || t.currentFundingRate ||
      t.current_funding_rate || t.lastFundingRate || t.last_funding_rate || 0
    );
    if (fr !== 0 && Math.abs(fr) < 0.001) fr = fr * 100; // normalize

    result.map[base] = {
      symbol:      sym,
      price,
      fundingRate: +fr.toFixed(6),
      volume24h:   parseFloat(t.volume || t.volume24h || t.base_volume || t.quoteVolume || 0),
      change24h:   parseFloat(t.priceChangePercent || t.price_change_percent || t.change24h || t.change || 0),
      nextFunding: t.nextFundingTime || t.next_funding_time || null
    };
  }

  result.ok       = Object.keys(result.map).length > 0;
  result.withFunding = Object.values(result.map).filter(v => v.fundingRate !== 0).length;
  return result;
}

// ════════════════════════════════════════════════════════════
//  STRATEGY LOGIC
//  Both negative: Long more-negative, Short less-negative
//  Both positive: Short more-positive, Long less-positive
//  Goldmine:      Short positive (earn), Long negative (earn)
// ════════════════════════════════════════════════════════════
function strategy(dR, cR) {
  const FEES = 0.10; // 0.10% total round-trip
  const diff = Math.abs(dR - cR);
  const net  = +(diff - FEES).toFixed(6);
  let longEx, shortEx, scenario, scenarioType;

  if (dR >= 0 && cR >= 0) {
    scenarioType = 'positive'; scenario = 'Both Positive';
    dR >= cR ? (shortEx='Delta', longEx='CoinSwitch')
             : (shortEx='CoinSwitch', longEx='Delta');
  } else if (dR <= 0 && cR <= 0) {
    scenarioType = 'negative'; scenario = 'Both Negative';
    // Long on more-negative (lower), Short on less-negative (higher)
    dR < cR ? (longEx='Delta', shortEx='CoinSwitch')
            : (longEx='CoinSwitch', shortEx='Delta');
  } else {
    scenarioType = 'goldmine'; scenario = 'GOLDMINE';
    dR > 0 ? (shortEx='Delta', longEx='CoinSwitch')
           : (shortEx='CoinSwitch', longEx='Delta');
  }

  return { longEx, shortEx, scenario, scenarioType, diff: +diff.toFixed(6), net };
}

// ════════════════════════════════════════════════════════════
//  HEALTH
// ════════════════════════════════════════════════════════════
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: '8.0.0', ts: Date.now() }));

// ════════════════════════════════════════════════════════════
//  DEBUG
// ════════════════════════════════════════════════════════════
app.get('/debug/delta', async (_req, res) => {
  try {
    const d   = await dPub('/v2/tickers', { contract_types: 'perpetual_futures' });
    const map = parseDelta(d);
    const list = d?.result || d?.data || [];
    res.json({
      ok: true, count: list.length,
      parsed: Object.keys(map).length,
      sample: Object.entries(map).slice(0, 5).map(([b, v]) => ({
        base: b, price: v.price, fundingRate: v.fundingRate
      }))
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/debug/cs', async (req, res) => {
  const { csKey, csSecret } = req.body;
  try {
    const r = await fetchCS(csKey, csSecret);
    res.json({
      ok: r.ok, source: r.source,
      total: r.total, parsed: Object.keys(r.map).length,
      withFunding: r.withFunding,
      sampleCoins: Object.keys(r.map).slice(0, 10),
      sample: Object.entries(r.map).slice(0, 5).map(([b, v]) => ({
        base: b, symbol: v.symbol, price: v.price, fundingRate: v.fundingRate
      }))
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  SCAN
// ════════════════════════════════════════════════════════════
app.post('/api/scan', async (req, res) => {
  try {
    const { csKey, csSecret } = req.body;
    const TAKER = 0.0005;

    const [dRaw, cRaw] = await Promise.allSettled([
      dPub('/v2/tickers', { contract_types: 'perpetual_futures' }),
      fetchCS(csKey, csSecret)
    ]);

    const deltaMap = dRaw.status === 'fulfilled' ? parseDelta(dRaw.value) : {};
    const csMap    = cRaw.status  === 'fulfilled' && cRaw.value.ok ? cRaw.value.map : {};
    const deltaOk  = Object.keys(deltaMap).length > 0;
    const csOk     = Object.keys(csMap).length > 0;

    const FEES = TAKER * 2 * 100;
    const opps = [];

    for (const [base, d] of Object.entries(deltaMap)) {
      const c = csMap[base];
      if (!c || d.price <= 0 || c.price <= 0) continue;

      const dR = d.fundingRate, cR = c.fundingRate;
      const { longEx, shortEx, scenario, scenarioType, diff, net } = strategy(dR, cR);
      const avg = (d.price + c.price) / 2;
      const spr = avg > 0 ? +((Math.abs(d.price - c.price) / avg) * 100).toFixed(4) : 0;

      const now  = new Date();
      const sec  = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
      const rem  = 8*3600 - (sec % (8*3600));
      const urg  = rem <= 1800 ? 'urgent' : rem <= 3600 ? 'soon' : 'normal';
      const score = diff * (scenarioType === 'goldmine' ? 2.5 : 1)
                        * (urg === 'urgent' ? 2 : urg === 'soon' ? 1.5 : 1);

      opps.push({
        base,
        deltaSymbol: d.symbol, csSymbol: c.symbol,
        deltaProductId: d.productId,
        deltaPrice: d.price, csPrice: c.price,
        deltaFunding: dR, csFunding: cR,
        fundingDiff: diff, netYield: net, spread: spr,
        volume: +(Math.max(d.volume24h, c.volume24h)).toFixed(2),
        deltaChange24h: d.change24h, csChange24h: c.change24h,
        longExchange: longEx, shortExchange: shortEx,
        scenario, scenarioType, urgency: urg, score
      });
    }

    opps.sort((a, b) => b.score - a.score);

    res.json({
      success: true, data: opps, count: opps.length,
      deltaCount: Object.keys(deltaMap).length,
      csCount:    Object.keys(csMap).length,
      deltaOk, csOk, ts: Date.now()
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
//  ORDER — fire both simultaneously
// ════════════════════════════════════════════════════════════
app.post('/api/order', async (req, res) => {
  const {
    deltaKey, deltaSecret, csKey, csSecret,
    deltaProductId, csSymbol, longExchange,
    quantity, leverage, orderType,
    limitPriceDelta, limitPriceCs
  } = req.body;

  if (!deltaKey || !csKey)
    return res.status(400).json({ success: false, error: 'API keys not set. Open Settings.' });

  const dSide = longExchange === 'Delta'      ? 'buy'  : 'sell';
  const cSide = longExchange === 'CoinSwitch' ? 'buy'  : 'sell';

  const dBody = {
    product_id: parseInt(deltaProductId),
    size:       parseFloat(quantity),
    side:       dSide,
    order_type: orderType === 'limit' ? 'limit_order' : 'market_order',
    ...(orderType === 'limit' && limitPriceDelta && { limit_price: String(limitPriceDelta) })
  };
  if (leverage) dBody.leverage = String(leverage);

  // CoinSwitch Pro order endpoint
  const csOrderPath = '/trade/api/v2/futures/order';
  const cBodyObj = {
    symbol:    csSymbol,
    side:      cSide.toUpperCase(),
    type:      orderType === 'limit' ? 'LIMIT' : 'MARKET',
    quantity:  parseFloat(quantity),
    ...(leverage && { leverage: parseInt(leverage) }),
    ...(orderType === 'limit' && limitPriceCs && { price: parseFloat(limitPriceCs) })
  };

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, dBody),
    csAuth(csKey, csSecret, 'POST', csOrderPath, {}, cBodyObj)
  ]);

  res.json({
    success: true, latencyMs: Date.now() - t0,
    bothOk:  dr.status === 'fulfilled' && cr.status === 'fulfilled',
    delta: dr.status === 'fulfilled'
      ? { ok: true,  orderId: dr.value?.result?.id || dr.value?.id }
      : { ok: false, error:   dr.reason?.response?.data || dr.reason?.message },
    cs: cr.status === 'fulfilled'
      ? { ok: true,  orderId: cr.value?.data?.orderId || cr.value?.orderId || cr.value?.id }
      : { ok: false, error:   cr.reason?.response?.data || cr.reason?.message }
  });
});

// ════════════════════════════════════════════════════════════
//  EXIT
// ════════════════════════════════════════════════════════════
app.post('/api/exit', async (req, res) => {
  const { deltaKey, deltaSecret, csKey, csSecret,
    deltaProductId, csSymbol, longExchange, quantity } = req.body;

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, {
      product_id:  parseInt(deltaProductId),
      size:        parseFloat(quantity),
      side:        longExchange === 'Delta' ? 'sell' : 'buy',
      order_type:  'market_order',
      reduce_only: true
    }),
    csAuth(csKey, csSecret, 'POST', '/trade/api/v2/futures/order', {}, {
      symbol:   csSymbol,
      side:     longExchange === 'CoinSwitch' ? 'SELL' : 'BUY',
      type:     'MARKET',
      quantity: parseFloat(quantity),
      reduceOnly: true
    })
  ]);

  res.json({
    success: true, latencyMs: Date.now() - t0,
    delta: dr.status === 'fulfilled' ? { ok: true } : { ok: false, error: dr.reason?.message },
    cs:    cr.status === 'fulfilled' ? { ok: true } : { ok: false, error: cr.reason?.message }
  });
});

// ════════════════════════════════════════════════════════════
//  POSITIONS
// ════════════════════════════════════════════════════════════
app.post('/api/positions', async (req, res) => {
  const { deltaKey, deltaSecret, csKey, csSecret } = req.body;
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'GET', '/v2/positions', { page_size: '50' }),
    csAuth(csKey, csSecret, 'GET', '/trade/api/v2/futures/positions')
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: dr.reason?.message },
    cs:    cr.status === 'fulfilled' ? cr.value : { error: cr.reason?.message }
  });
});

// ════════════════════════════════════════════════════════════
//  HISTORY
// ════════════════════════════════════════════════════════════
app.post('/api/history', async (req, res) => {
  const { deltaKey, deltaSecret, csKey, csSecret } = req.body;
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'GET', '/v2/orders', { state: 'closed', page_size: '50' }),
    csAuth(csKey, csSecret, 'GET', '/trade/api/v2/futures/order/history', { limit: '50' })
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: dr.reason?.message },
    cs:    cr.status === 'fulfilled' ? cr.value : { error: cr.reason?.message }
  });
});

// ════════════════════════════════════════════════════════════
//  BALANCE
// ════════════════════════════════════════════════════════════
app.post('/api/balance', async (req, res) => {
  const { deltaKey, deltaSecret, csKey, csSecret } = req.body;
  const [dr, cr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'GET', '/v2/wallet/balances'),
    csAuth(csKey, csSecret, 'GET', '/trade/api/v2/user/portfolio')
  ]);

  let deltaUsd = 0;
  if (dr.status === 'fulfilled') {
    const bals = dr.value?.result || [];
    const usdt = Array.isArray(bals) ? bals.find(b => b.asset_symbol === 'USDT') : null;
    deltaUsd   = parseFloat(usdt?.balance || 0);
  }

  let csUsd = 0;
  if (cr.status === 'fulfilled') {
    const d = cr.value?.data || cr.value;
    // CoinSwitch may return USDT balance in futures wallet
    csUsd = parseFloat(
      d?.futures_balance || d?.futuresBalance ||
      d?.usdt_balance || d?.usdtBalance ||
      d?.balance || 0
    );
  }

  res.json({ deltaUsd, csUsd, total: deltaUsd + csUsd });
});

// ════════════════════════════════════════════════════════════
//  SERVE FRONTEND
// ════════════════════════════════════════════════════════════
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () =>
  console.log(`FundArb v8 | Delta Exchange India + CoinSwitch Pro | Port ${PORT}`));
