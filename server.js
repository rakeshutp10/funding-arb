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

// ─────────────────────────────────────────────────────────
//  API KEYS — set in Railway → Variables tab
//  DELTA_KEY    DELTA_SECRET    DCX_KEY    DCX_SECRET
// ─────────────────────────────────────────────────────────
const DELTA_KEY    = process.env.DELTA_KEY    || '';
const DELTA_SECRET = process.env.DELTA_SECRET || '';
const DCX_KEY      = process.env.DCX_KEY      || '';
const DCX_SECRET   = process.env.DCX_SECRET   || '';

function errMsg(e) {
  if (!e) return 'Unknown error';
  if (e.response?.status && e.response?.data)
    return `HTTP ${e.response.status}: ${JSON.stringify(e.response.data).slice(0, 200)}`;
  if (e.message) return e.message;
  return String(e).slice(0, 200);
}

// ═══════════════════════════════════════════════════════════
//  DELTA EXCHANGE INDIA
//  Docs: https://docs.india.delta.exchange
//  Auth: HMAC-SHA256 of (method + timestamp + path + qs + body)
//  IP whitelist: 0.0.0.0 on Delta dashboard
// ═══════════════════════════════════════════════════════════
const DELTA = 'https://api.india.delta.exchange';

function dSign(method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', DELTA_SECRET)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function dGet(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA + ep + qs, {
    timeout: 12000,
    headers: { Accept: 'application/json', 'User-Agent': 'FundArb/14' }
  });
  return r.data;
}

async function dAuth(method, ep, query = {}, body = null) {
  if (!DELTA_KEY) throw new Error('DELTA_KEY not set in Railway Variables');
  const ts  = Math.floor(Date.now() / 1000).toString();
  const qs  = Object.keys(query).length ? '?' + new URLSearchParams(query) : '';
  const bs  = body ? JSON.stringify(body) : '';
  const sig = dSign(method, ep, qs, bs, ts);
  const cfg = {
    method, url: DELTA + ep + qs, timeout: 12000,
    headers: {
      'api-key': DELTA_KEY, timestamp: ts, signature: sig,
      'Content-Type': 'application/json', 'User-Agent': 'FundArb/14'
    }
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
      fundingRate: +(fr * 100).toFixed(6),   // decimal → percent
      volume24h:   parseFloat(t.volume || t.turnover_usd || 0),
      change24h:   parseFloat(t.price_change_percent || 0),
      nextFunding: t.next_funding_realization || null
    };
  }
  return map;
}

// ═══════════════════════════════════════════════════════════
//  COINDCX FUTURES
//  Docs: https://docs.coindcx.com/#futures-end-points
//
//  Base URL: https://api.coindcx.com
//  Pair format: "B-BTC_USDT" (B- prefix for all futures pairs)
//
//  Auth (for private endpoints):
//    Headers: X-AUTH-APIKEY, X-AUTH-SIGNATURE
//    Signature: HMAC-SHA256 of COMPACT JSON body string
//    Body must include: timestamp (milliseconds)
//    IMPORTANT: use JSON.stringify with compact separators
//
//  CoinDCX Futures public endpoints (no auth needed):
//    GET  /exchange/v1/derivatives/futures/instruments
//         → Returns all active perpetual contracts with:
//           pair, mark_price, last_price, predicted_funding_rate,
//           funding_rate, volume_24h, price_change_24h
//
//  Private endpoints:
//    POST /exchange/v1/derivatives/futures/orders/create
//    POST /exchange/v1/derivatives/futures/positions
//    POST /exchange/v1/derivatives/futures/orders/cancel
//    POST /exchange/v1/derivatives/futures/wallet/details
// ═══════════════════════════════════════════════════════════
const DCX = 'https://api.coindcx.com';

// Sign: HMAC-SHA256 of COMPACT JSON body (no spaces)
function dcxSign(bodyObj) {
  const compact = JSON.stringify(bodyObj, null, 0);   // compact — no extra spaces
  return crypto.createHmac('sha256', DCX_SECRET)
    .update(compact).digest('hex');
}

async function dcxPub(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DCX + ep + qs, {
    timeout: 10000,
    headers: { Accept: 'application/json', 'User-Agent': 'FundArb/14' }
  });
  return r.data;
}

async function dcxAuth(ep, bodyObj = {}) {
  if (!DCX_KEY) throw new Error('DCX_KEY not set in Railway Variables');
  const body    = { ...bodyObj, timestamp: Date.now() };
  const compact = JSON.stringify(body, null, 0);
  const sig     = crypto.createHmac('sha256', DCX_SECRET).update(compact).digest('hex');
  const r       = await axios.post(DCX + ep, body, {
    timeout: 12000,
    headers: {
      'X-AUTH-APIKEY':    DCX_KEY,
      'X-AUTH-SIGNATURE': sig,
      'Content-Type':     'application/json',
      'User-Agent':       'FundArb/14'
    }
  });
  return r.data;
}

// ─────────────────────────────────────────────────────────
//  FETCH CoinDCX Futures Market Data
//
//  Primary: GET /exchange/v1/derivatives/futures/instruments
//  This endpoint returns all active futures instruments with
//  funding rates, mark prices, volumes, etc.
//
//  Fallback: POST /exchange/v1/derivatives/futures/pair_stats
//  (authenticated, returns pair-by-pair stats)
// ─────────────────────────────────────────────────────────
async function fetchDCX() {
  const result = { map: {}, ok: false, source: 'none', total: 0, tried: [], errors: [] };

  // ── Step 1: Public instruments endpoint ─────────────────
  const pubEndpoints = [
    '/exchange/v1/derivatives/futures/instruments',
    '/exchange/v1/derivatives/instruments',
  ];

  for (const ep of pubEndpoints) {
    result.tried.push('pub:' + ep);
    try {
      const data = await dcxPub(ep);
      const list = Array.isArray(data) ? data
        : Array.isArray(data?.data) ? data.data
        : Array.isArray(data?.instruments) ? data.instruments
        : Array.isArray(data?.result) ? data.result : [];

      if (list.length > 0) {
        result.source = 'pub:' + ep;
        result.total  = list.length;
        const parsed  = parseDCXList(list);
        if (Object.keys(parsed).length > 0) {
          result.map = parsed;
          result.ok  = true;
          return result;
        }
      }
    } catch (e) {
      result.errors.push('pub:' + ep + ' → ' + errMsg(e));
    }
  }

  // ── Step 2: Authenticated endpoints ─────────────────────
  if (DCX_KEY && DCX_SECRET) {
    const authEndpoints = [
      '/exchange/v1/derivatives/futures/instruments',
      '/exchange/v1/derivatives/futures/market_data',
    ];

    for (const ep of authEndpoints) {
      result.tried.push('auth:' + ep);
      try {
        const data = await dcxAuth(ep);
        const list = Array.isArray(data) ? data
          : Array.isArray(data?.data) ? data.data
          : Array.isArray(data?.instruments) ? data.instruments : [];

        if (list.length > 0) {
          result.source = 'auth:' + ep;
          result.total  = list.length;
          const parsed  = parseDCXList(list);
          if (Object.keys(parsed).length > 0) {
            result.map = parsed;
            result.ok  = true;
            return result;
          }
        }
      } catch (e) {
        result.errors.push('auth:' + ep + ' → ' + errMsg(e));
      }
    }

    // ── Step 3: Get active instrument list then pair stats ─
    result.tried.push('instruments+pairstats');
    try {
      // Get list of all active instruments
      const instrData = await dcxPub('/exchange/v1/derivatives/futures/instruments');
      const instrList = Array.isArray(instrData) ? instrData
        : Array.isArray(instrData?.data) ? instrData.data : [];

      if (instrList.length > 0) {
        // Get pair stats for each instrument (has funding rate)
        const pairs = instrList.map(i => i.pair || i.symbol || i.coindcx_code).filter(Boolean);
        const chunkSize = 20;
        const allStats  = [];

        for (let i = 0; i < Math.min(pairs.length, 100); i += chunkSize) {
          const chunk = pairs.slice(i, i + chunkSize);
          try {
            const statsData = await dcxAuth('/exchange/v1/derivatives/futures/pair_stats', {
              pairs: chunk
            });
            const stats = Array.isArray(statsData) ? statsData
              : Array.isArray(statsData?.data) ? statsData.data : [];
            allStats.push(...stats);
          } catch (_) {}
        }

        if (allStats.length > 0) {
          result.source = 'pair_stats';
          result.total  = allStats.length;
          const parsed  = parseDCXList(allStats);
          if (Object.keys(parsed).length > 0) {
            result.map = parsed;
            result.ok  = true;
            return result;
          }
        }
      }
    } catch (e) {
      result.errors.push('pair_stats → ' + errMsg(e));
    }
  }

  return result;
}

// Parse CoinDCX futures instrument/stats list into standard map
function parseDCXList(list) {
  const map = {};
  for (const t of list) {
    // Pair format: "B-BTC_USDT" or "B-ETH_USDT" etc.
    const pair = (t.pair || t.symbol || t.coindcx_code || t.instrument || '').toUpperCase();

    // Extract base asset from "B-BTC_USDT" → "BTC"
    let base = '';
    if (pair.startsWith('B-')) {
      const inner = pair.slice(2);               // "BTC_USDT"
      base = inner.split('_')[0];                // "BTC"
    } else if (pair.includes('_USDT')) {
      base = pair.split('_USDT')[0].replace(/^B-/, '');
    } else {
      base = (t.base_currency || t.underlying_asset || t.base || '').toUpperCase();
    }
    if (!base || base.length < 2 || base.length > 10) continue;

    // Price: mark_price preferred, fallback to last_price, ltp, close
    const price = parseFloat(
      t.mark_price || t.markPrice ||
      t.last_price || t.lastPrice ||
      t.ltp || t.close || t.price || 0
    );
    if (price <= 0) continue;

    // Funding rate fields (CoinDCX uses percent already, e.g., 0.01 = 0.01%)
    // Some versions return as decimal (0.0001), some as percent (0.01)
    let fr = parseFloat(
      t.predicted_funding_rate || t.predictedFundingRate ||
      t.funding_rate           || t.fundingRate          ||
      t.current_funding_rate   || t.currentFundingRate   || 0
    );
    // Normalize: CoinDCX may return small decimals like 0.0001 (= 0.01%)
    if (fr !== 0 && Math.abs(fr) < 0.001) fr = fr * 100;

    const vol = parseFloat(t.volume_24h || t.volume24h || t.volume || t.base_volume || 0);
    const chg = parseFloat(t.price_change_24h || t.priceChange24h || t.change_24h || 0);

    map[base] = {
      symbol:      pair,
      price,
      fundingRate: +fr.toFixed(6),
      volume24h:   vol,
      change24h:   chg,
      nextFunding: t.next_funding_time || t.nextFundingTime || null
    };
  }
  return map;
}

// ═══════════════════════════════════════════════════════════
//  STRATEGY LOGIC
// ═══════════════════════════════════════════════════════════
function calcStrategy(dR, cR) {
  const diff = Math.abs(dR - cR);
  const net  = +(diff - 0.10).toFixed(6);
  let longEx, shortEx, scenario, scenarioType;

  if (dR >= 0 && cR >= 0) {
    scenarioType = 'positive'; scenario = 'Both Positive';
    dR >= cR ? (shortEx='Delta', longEx='CoinDCX') : (shortEx='CoinDCX', longEx='Delta');
  } else if (dR <= 0 && cR <= 0) {
    scenarioType = 'negative'; scenario = 'Both Negative';
    dR < cR  ? (longEx='Delta',  shortEx='CoinDCX') : (longEx='CoinDCX',  shortEx='Delta');
  } else {
    scenarioType = 'goldmine'; scenario = 'GOLDMINE';
    dR > 0   ? (shortEx='Delta', longEx='CoinDCX') : (shortEx='CoinDCX', longEx='Delta');
  }
  return { longEx, shortEx, scenario, scenarioType, diff: +diff.toFixed(6), net };
}

// ═══════════════════════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════════════════════
app.get('/health', (_req, res) => res.json({
  status: 'ok', version: '14.0.0', port: PORT,
  deltaKeySet: !!DELTA_KEY, dcxKeySet: !!DCX_KEY,
  ts: Date.now()
}));

// ═══════════════════════════════════════════════════════════
//  DEBUG — detailed error output
// ═══════════════════════════════════════════════════════════
app.get('/debug/delta', async (_req, res) => {
  try {
    const d    = await dGet('/v2/tickers', { contract_types: 'perpetual_futures' });
    const map  = parseDelta(d);
    const list = d?.result || d?.data || [];
    res.json({
      ok: true, rawCount: list.length, parsed: Object.keys(map).length,
      sample: Object.entries(map).slice(0, 5).map(([b, v]) => ({
        base: b, price: v.price, fundingRate: v.fundingRate
      }))
    });
  } catch (e) { res.json({ ok: false, error: errMsg(e) }); }
});

app.get('/debug/dcx', async (_req, res) => {
  const dbg = { keySet: !!DCX_KEY };
  try {
    const r  = await fetchDCX();
    const wf = Object.values(r.map).filter(v => v.fundingRate !== 0).length;
    res.json({
      ok: r.ok, source: r.source, total: r.total,
      parsed: Object.keys(r.map).length,
      withFunding: wf,
      keySet: !!DCX_KEY,
      tried: r.tried,
      errors: r.errors,
      sampleCoins: Object.keys(r.map).slice(0, 10),
      sample: Object.entries(r.map).slice(0, 5).map(([b, v]) => ({
        base: b, symbol: v.symbol, price: v.price, fundingRate: v.fundingRate
      }))
    });
  } catch (e) {
    res.json({ ok: false, error: errMsg(e), ...dbg });
  }
});

// ═══════════════════════════════════════════════════════════
//  SCAN
// ═══════════════════════════════════════════════════════════
app.post('/api/scan', async (_req, res) => {
  try {
    const [dRaw, cRaw] = await Promise.allSettled([
      dGet('/v2/tickers', { contract_types: 'perpetual_futures' }),
      fetchDCX()
    ]);

    const deltaMap = dRaw.status === 'fulfilled' ? parseDelta(dRaw.value) : {};
    const dcxMap   = cRaw.status  === 'fulfilled' && cRaw.value.ok ? cRaw.value.map : {};
    const deltaOk  = Object.keys(deltaMap).length > 0;
    const dcxOk    = Object.keys(dcxMap).length   > 0;

    const opps = [];
    for (const [base, d] of Object.entries(deltaMap)) {
      const c = dcxMap[base];
      if (!c || d.price <= 0 || c.price <= 0) continue;

      const { longEx, shortEx, scenario, scenarioType, diff, net } =
        calcStrategy(d.fundingRate, c.fundingRate);
      const avg = (d.price + c.price) / 2;
      const spr = avg > 0 ? +((Math.abs(d.price - c.price) / avg) * 100).toFixed(4) : 0;

      const now  = new Date();
      const sec  = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
      const rem  = 8*3600 - (sec % (8*3600));
      const urg  = rem <= 1800 ? 'urgent' : rem <= 3600 ? 'soon' : 'normal';
      const score = diff * (scenarioType === 'goldmine' ? 2.5 : 1)
                       * (urg === 'urgent' ? 2.0 : urg === 'soon' ? 1.5 : 1.0);

      opps.push({
        base,
        deltaSymbol:    d.symbol,
        dcxSymbol:      c.symbol,
        deltaProductId: d.productId,
        deltaPrice:     d.price,
        dcxPrice:       c.price,
        deltaFunding:   d.fundingRate,
        dcxFunding:     c.fundingRate,
        fundingDiff:    diff, netYield: net, spread: spr,
        volume:         +(Math.max(d.volume24h, c.volume24h)).toFixed(2),
        deltaChange24h: d.change24h, dcxChange24h: c.change24h,
        longExchange:   longEx, shortExchange: shortEx,
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
    res.status(500).json({ success: false, error: errMsg(e) });
  }
});

// ═══════════════════════════════════════════════════════════
//  ORDER — fire both simultaneously
// ═══════════════════════════════════════════════════════════
app.post('/api/order', async (req, res) => {
  const { deltaProductId, dcxSymbol, longExchange, quantity,
    leverage, orderType, limitPriceDelta, limitPriceDcx } = req.body;

  if (!DELTA_KEY || !DCX_KEY)
    return res.status(400).json({ success: false, error: 'API keys not set in Railway Variables.' });

  const dSide = longExchange === 'Delta'  ? 'buy'  : 'sell';
  const cSide = longExchange === 'CoinDCX'? 'buy'  : 'sell';

  const dBody = {
    product_id: parseInt(deltaProductId), size: parseFloat(quantity),
    side: dSide, order_type: orderType === 'limit' ? 'limit_order' : 'market_order',
    ...(orderType === 'limit' && limitPriceDelta && { limit_price: String(limitPriceDelta) })
  };
  if (leverage) dBody.leverage = String(leverage);

  // CoinDCX futures order — pair format "B-BTC_USDT"
  const cBody = {
    side:           cSide,
    pair:           dcxSymbol,          // "B-BTC_USDT"
    order_type:     orderType === 'limit' ? 'limit_order' : 'market_order',
    total_quantity: parseFloat(quantity),
    leverage:       leverage ? parseInt(leverage) : 10,
    ...(orderType === 'limit' && limitPriceDcx && { price: parseFloat(limitPriceDcx) })
  };

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth('POST', '/v2/orders', {}, dBody),
    dcxAuth('/exchange/v1/derivatives/futures/orders/create', cBody)
  ]);

  res.json({
    success: true, latencyMs: Date.now() - t0,
    bothOk:  dr.status === 'fulfilled' && cr.status === 'fulfilled',
    delta: dr.status === 'fulfilled'
      ? { ok: true,  orderId: dr.value?.result?.id || dr.value?.id }
      : { ok: false, error:   errMsg(dr.reason) },
    dcx: cr.status === 'fulfilled'
      ? { ok: true,  orderId: cr.value?.data?.id || cr.value?.id }
      : { ok: false, error:   errMsg(cr.reason) }
  });
});

// ═══════════════════════════════════════════════════════════
//  EXIT
// ═══════════════════════════════════════════════════════════
app.post('/api/exit', async (req, res) => {
  const { deltaProductId, dcxSymbol, longExchange, quantity } = req.body;
  const t0 = Date.now();

  const [dr, cr] = await Promise.allSettled([
    dAuth('POST', '/v2/orders', {}, {
      product_id: parseInt(deltaProductId), size: parseFloat(quantity),
      side: longExchange === 'Delta' ? 'sell' : 'buy',
      order_type: 'market_order', reduce_only: true
    }),
    dcxAuth('/exchange/v1/derivatives/futures/orders/create', {
      side:           longExchange === 'CoinDCX' ? 'sell' : 'buy',
      pair:           dcxSymbol,
      order_type:     'market_order',
      total_quantity: parseFloat(quantity)
    })
  ]);

  res.json({
    success: true, latencyMs: Date.now() - t0,
    delta: dr.status === 'fulfilled' ? { ok: true } : { ok: false, error: errMsg(dr.reason) },
    dcx:   cr.status === 'fulfilled' ? { ok: true } : { ok: false, error: errMsg(cr.reason) }
  });
});

// ═══════════════════════════════════════════════════════════
//  POSITIONS
// ═══════════════════════════════════════════════════════════
app.post('/api/positions', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET', '/v2/positions', { page_size: '50' }),
    dcxAuth('/exchange/v1/derivatives/futures/positions', { page: '1', size: '50' })
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: errMsg(dr.reason) },
    dcx:   cr.status === 'fulfilled' ? cr.value : { error: errMsg(cr.reason) }
  });
});

// ═══════════════════════════════════════════════════════════
//  HISTORY
// ═══════════════════════════════════════════════════════════
app.post('/api/history', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET', '/v2/orders', { state: 'closed', page_size: '50' }),
    dcxAuth('/exchange/v1/derivatives/futures/orders', { page: '1', size: '50', status: 'filled' })
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: errMsg(dr.reason) },
    dcx:   cr.status === 'fulfilled' ? cr.value : { error: errMsg(cr.reason) }
  });
});

// ═══════════════════════════════════════════════════════════
//  BALANCE
// ═══════════════════════════════════════════════════════════
app.post('/api/balance', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET', '/v2/wallet/balances'),
    dcxAuth('/exchange/v1/derivatives/futures/wallet/details')
  ]);

  let deltaUsd = 0;
  if (dr.status === 'fulfilled') {
    const bals = dr.value?.result || [];
    const usdt = Array.isArray(bals) ? bals.find(b => b.asset_symbol === 'USDT') : null;
    deltaUsd   = parseFloat(usdt?.balance || 0);
  }

  let dcxUsd = 0;
  if (cr.status === 'fulfilled') {
    const d = cr.value?.data || cr.value;
    // CoinDCX futures wallet: balance in USDT
    dcxUsd = parseFloat(d?.balance || d?.available_balance || d?.usdt_balance || 0);
  }

  res.json({
    deltaUsd: +deltaUsd.toFixed(2),
    dcxUsd:   +dcxUsd.toFixed(2),
    totalUsd: +(deltaUsd + dcxUsd).toFixed(2)
  });
});

app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`FundArb v14 | Delta Exchange India + CoinDCX Futures | Port ${PORT}`));
