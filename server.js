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

// ═══════════════════════════════════════════════════
//  USD/INR RATE  (cache 10 min)
// ═══════════════════════════════════════════════════
let INR_RATE = 84.0;
let rateAt   = 0;

async function getInrRate() {
  if (Date.now() - rateAt < 10 * 60 * 1000) return INR_RATE;
  try {
    const r = await axios.get('https://open.er-api.com/v6/latest/USD', { timeout: 5000 });
    if (r.data?.rates?.INR) { INR_RATE = r.data.rates.INR; rateAt = Date.now(); }
  } catch (_) {}
  return INR_RATE;
}

// ═══════════════════════════════════════════════════
//  DELTA EXCHANGE INDIA
//  IP whitelist: set to 0.0.0.0 on Delta dashboard
//  → works from any IP including Railway
// ═══════════════════════════════════════════════════
const DELTA = 'https://api.india.delta.exchange';

function dSign(secret, method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', secret)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function dGet(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA + ep + qs, {
    timeout: 12000,
    headers: { Accept: 'application/json', 'User-Agent': 'FundArb/11' }
  });
  return r.data;
}

async function dAuth(key, secret, method, ep, query = {}, body = null) {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const qs  = Object.keys(query).length ? '?' + new URLSearchParams(query) : '';
  const bs  = body ? JSON.stringify(body) : '';
  const sig = dSign(secret, method, ep, qs, bs, ts);
  const cfg = {
    method,
    url: DELTA + ep + qs,
    timeout: 12000,
    headers: {
      'api-key':       key,
      'timestamp':     ts,
      'signature':     sig,
      'Content-Type':  'application/json',
      'User-Agent':    'FundArb/11'
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
    // Delta returns funding_rate as decimal: 0.0001 = 0.01%
    const fr = parseFloat(t.funding_rate || t.funding_rate_8h || 0);
    map[base] = {
      symbol:      t.symbol || '',
      productId:   t.id || t.product_id,
      price,                           // USD
      fundingRate: +(fr * 100).toFixed(6), // convert to % e.g. 0.01
      volume24h:   parseFloat(t.volume || t.turnover_usd || 0),
      change24h:   parseFloat(t.price_change_percent || 0),
      nextFunding: t.next_funding_realization || null
    };
  }
  return map;
}

// ═══════════════════════════════════════════════════
//  PI42
//  IP whitelist: set to 0.0.0.0 on Pi42 dashboard
//  → works from any IP including Railway
//  Pi42 prices are in INR — we convert to USD
// ═══════════════════════════════════════════════════
const PI42 = 'https://fapi.pi42.com';

function pSign(secret, params) {
  const qs = Object.keys(params).sort()
    .map(k => `${k}=${params[k]}`).join('&');
  return crypto.createHmac('sha256', secret).update(qs).digest('hex');
}

async function pGet(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(PI42 + ep + qs, {
    timeout: 10000,
    headers: {
      Accept:       'application/json',
      'User-Agent': 'FundArb/11',
      Origin:       'https://pi42.com',
      Referer:      'https://pi42.com/'
    }
  });
  return r.data;
}

async function pAuth(key, secret, method, ep, params = {}) {
  const ts   = Date.now().toString();
  const all  = { ...params, timestamp: ts };
  const sig  = pSign(secret, all);
  const hdrs = {
    'api-key':    key,
    Accept:       'application/json',
    'User-Agent': 'FundArb/11',
    Origin:       'https://pi42.com'
  };

  if (method === 'GET') {
    const r = await axios.get(PI42 + ep, {
      params:  { ...all, signature: sig },
      headers: hdrs,
      timeout: 12000
    });
    return r.data;
  } else {
    const r = await axios.post(PI42 + ep,
      { ...all, signature: sig },
      { headers: { ...hdrs, 'Content-Type': 'application/json' }, timeout: 12000 }
    );
    return r.data;
  }
}

async function fetchPi42(key, secret, inrRate) {
  const result = { map: {}, ok: false, source: 'none', total: 0, withFunding: 0 };

  const endpoints = [
    '/v1/exchange/futures/contracts',
    '/v1/market/tickers',
    '/v1/ticker/24hr'
  ];

  for (const ep of endpoints) {
    try {
      // Try authenticated (works with 0.0.0.0 whitelist from any IP)
      let data = null;
      if (key && secret) {
        try { data = await pAuth(key, secret, 'GET', ep); } catch (_) {}
      }
      // Fallback to public
      if (!data) {
        try { data = await pGet(ep); } catch (_) {}
      }
      if (!data) continue;

      // Flatten response into array
      let list = [];
      if (Array.isArray(data))                  list = data;
      else if (Array.isArray(data.data))         list = data.data;
      else if (Array.isArray(data.result))       list = data.result;
      else if (Array.isArray(data.tickers))      list = data.tickers;
      else if (data.data && typeof data.data === 'object' && !Array.isArray(data.data))
        list = Object.values(data.data);
      else if (typeof data === 'object') {
        const vals = Object.values(data);
        if (vals.length && typeof vals[0] === 'object') list = vals;
      }

      if (!list.length) continue;

      result.total  = list.length;
      result.source = ep;

      for (const t of list) {
        const sym = (t.symbol || t.contractName || t.pair || t.s || '').toUpperCase();

        // Extract base asset
        let base = (t.baseAsset || t.baseCurrency || t.baseSymbol || '').toUpperCase();
        if (!base && sym) base = sym.replace(/INR$|USDT$|USDC$/, '');
        if (!base || base.length < 2 || base.length > 10) continue;

        // Price in INR — convert to USD for comparison
        const priceInr = parseFloat(
          t.lastPrice || t.last_price || t.markPrice || t.mark_price ||
          t.price || t.close || t.c || t.lp || 0
        );
        if (priceInr <= 0) continue;

        const priceUsd = inrRate > 0 ? priceInr / inrRate : 0;

        // Funding rate normalization
        let fr = parseFloat(
          t.lastFundingRate || t.last_funding_rate ||
          t.fundingRate     || t.funding_rate      ||
          t.currentFundingRate || t.fr || 0
        );
        // If very small decimal (fraction), convert to percent
        if (fr !== 0 && Math.abs(fr) < 0.01) fr = fr * 100;

        result.map[base] = {
          symbol:      sym,
          priceInr,
          priceUsd,
          fundingRate: +fr.toFixed(6),
          volume24h:   parseFloat(t.volume24h || t.baseVolume || t.volume || t.v || 0),
          change24h:   parseFloat(t.priceChangePercent || t.change24h || t.P || 0),
          nextFunding: t.nextFundingTime || t.next_funding_time || null
        };
      }

      if (Object.keys(result.map).length > 0) {
        result.ok          = true;
        result.withFunding = Object.values(result.map).filter(v => v.fundingRate !== 0).length;
        return result;
      }
    } catch (_) {}
  }

  return result;
}

// ═══════════════════════════════════════════════════
//  STRATEGY LOGIC
//
//  Both negative  (e.g. Delta -0.8%, Pi42 -0.4%):
//    Long more-negative (Delta -0.8%) → earn 0.8% per 8h
//    Short less-negative (Pi42 -0.4%) → pay 0.4%, hedges price
//    Net = 0.8 - 0.4 - 0.10 (fees) = 0.3%
//
//  Both positive (e.g. Delta +0.5%, Pi42 +0.2%):
//    Short more-positive (Delta +0.5%) → earn 0.5% per 8h
//    Long less-positive (Pi42 +0.2%)  → pay 0.2%, hedges price
//    Net = 0.5 - 0.2 - 0.10 = 0.2%
//
//  GOLDMINE — one positive, one negative:
//    Short positive exchange → earn funding
//    Long negative exchange  → earn funding
//    Net = |pos| + |neg| - 0.10
// ═══════════════════════════════════════════════════
function calcStrategy(dR, pR) {
  const diff = Math.abs(dR - pR);
  const net  = +(diff - 0.10).toFixed(6);
  let longEx, shortEx, scenario, scenarioType;

  if (dR >= 0 && pR >= 0) {
    scenarioType = 'positive';
    scenario     = 'Both Positive';
    if (dR >= pR) { shortEx = 'Delta'; longEx = 'Pi42'; }
    else           { shortEx = 'Pi42';  longEx = 'Delta'; }
  } else if (dR <= 0 && pR <= 0) {
    scenarioType = 'negative';
    scenario     = 'Both Negative';
    if (dR < pR) { longEx = 'Delta'; shortEx = 'Pi42'; }  // Delta more negative
    else          { longEx = 'Pi42';  shortEx = 'Delta'; }
  } else {
    scenarioType = 'goldmine';
    scenario     = 'GOLDMINE';
    if (dR > 0) { shortEx = 'Delta'; longEx = 'Pi42'; }
    else         { shortEx = 'Pi42';  longEx = 'Delta'; }
  }

  return { longEx, shortEx, scenario, scenarioType, diff: +diff.toFixed(6), net };
}

// ═══════════════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════════════
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: '11.0.0', ts: Date.now(), port: PORT, inrRate: INR_RATE }));

// ═══════════════════════════════════════════════════
//  DEBUG
// ═══════════════════════════════════════════════════
app.get('/debug/delta', async (_req, res) => {
  try {
    const d    = await dGet('/v2/tickers', { contract_types: 'perpetual_futures' });
    const map  = parseDelta(d);
    const list = d?.result || d?.data || [];
    res.json({
      ok:     true,
      count:  list.length,
      parsed: Object.keys(map).length,
      sample: Object.entries(map).slice(0, 5).map(([b, v]) => ({
        base: b, priceUsd: v.price, fundingRate: v.fundingRate
      }))
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post('/debug/pi42', async (req, res) => {
  const { pi42Key, pi42Secret } = req.body;
  try {
    const inrRate = await getInrRate();
    const r       = await fetchPi42(pi42Key, pi42Secret, inrRate);
    res.json({
      ok:          r.ok,
      source:      r.source,
      total:       r.total,
      parsed:      Object.keys(r.map).length,
      withFunding: r.withFunding,
      inrRate,
      sampleCoins: Object.keys(r.map).slice(0, 10),
      sample:      Object.entries(r.map).slice(0, 5).map(([b, v]) => ({
        base: b, symbol: v.symbol,
        priceInr: v.priceInr, priceUsd: +v.priceUsd.toFixed(4),
        fundingRate: v.fundingRate
      }))
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════
//  SCAN
// ═══════════════════════════════════════════════════
app.post('/api/scan', async (req, res) => {
  try {
    const { pi42Key, pi42Secret } = req.body;
    const inrRate = await getInrRate();

    const [dRaw, pRaw] = await Promise.allSettled([
      dGet('/v2/tickers', { contract_types: 'perpetual_futures' }),
      fetchPi42(pi42Key, pi42Secret, inrRate)
    ]);

    const deltaMap = dRaw.status === 'fulfilled' ? parseDelta(dRaw.value) : {};
    const pi42Map  = pRaw.status === 'fulfilled' && pRaw.value.ok ? pRaw.value.map : {};
    const deltaOk  = Object.keys(deltaMap).length > 0;
    const pi42Ok   = Object.keys(pi42Map).length  > 0;

    const FEES = 0.10; // 0.05% per side × 2 = 0.10%
    const opps = [];

    for (const [base, d] of Object.entries(deltaMap)) {
      const p = pi42Map[base];
      if (!p) continue;
      if (d.price <= 0 || p.priceUsd <= 0) continue;

      const dR  = d.fundingRate;
      const pR  = p.fundingRate;
      const { longEx, shortEx, scenario, scenarioType, diff, net } = calcStrategy(dR, pR);

      // Spread: both prices now in USD
      const avgUsd = (d.price + p.priceUsd) / 2;
      const spread = avgUsd > 0
        ? +((Math.abs(d.price - p.priceUsd) / avgUsd) * 100).toFixed(4)
        : 0;

      // Urgency
      const now  = new Date();
      const sec  = now.getUTCHours()*3600 + now.getUTCMinutes()*60 + now.getUTCSeconds();
      const rem  = 8*3600 - (sec % (8*3600));
      const urg  = rem <= 1800 ? 'urgent' : rem <= 3600 ? 'soon' : 'normal';
      const urgW = urg === 'urgent' ? 2.0 : urg === 'soon' ? 1.5 : 1.0;
      const scW  = scenarioType === 'goldmine' ? 2.5 : 1.0;
      const score = diff * scW * urgW;

      opps.push({
        base,
        deltaSymbol:    d.symbol,
        pi42Symbol:     p.symbol,
        deltaProductId: d.productId,
        // Prices
        deltaPrice:     d.price,      // USD
        pi42PriceUsd:   +p.priceUsd.toFixed(6),
        pi42PriceInr:   p.priceInr,
        // Funding
        deltaFunding:   dR,
        pi42Funding:    pR,
        fundingDiff:    diff,
        netYield:       net,
        spread,
        // Meta
        volume:         +(Math.max(d.volume24h, p.volume24h)).toFixed(2),
        deltaChange24h: d.change24h,
        pi42Change24h:  p.change24h,
        // Strategy
        longExchange:   longEx,
        shortExchange:  shortEx,
        scenario, scenarioType, urgency: urg, score,
        inrRate
      });
    }

    opps.sort((a, b) => b.score - a.score);

    res.json({
      success: true,
      data:    opps,
      count:   opps.length,
      deltaCount: Object.keys(deltaMap).length,
      pi42Count:  Object.keys(pi42Map).length,
      deltaOk, pi42Ok,
      inrRate,
      ts: Date.now()
    });
  } catch (e) {
    console.error('[SCAN]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════
//  ORDER — fire both simultaneously
// ═══════════════════════════════════════════════════
app.post('/api/order', async (req, res) => {
  const {
    deltaKey, deltaSecret, pi42Key, pi42Secret,
    deltaProductId, pi42Symbol, longExchange,
    quantity, leverage, orderType,
    limitPriceDelta, limitPricePi42
  } = req.body;

  if (!deltaKey || !pi42Key)
    return res.status(400).json({ success: false, error: 'API keys not set. Open Settings.' });

  const dSide = longExchange === 'Delta' ? 'buy'  : 'sell';
  const pSide = longExchange === 'Pi42'  ? 'BUY'  : 'SELL';

  const dBody = {
    product_id: parseInt(deltaProductId),
    size:       parseFloat(quantity),
    side:       dSide,
    order_type: orderType === 'limit' ? 'limit_order' : 'market_order',
    ...(orderType === 'limit' && limitPriceDelta && { limit_price: String(limitPriceDelta) })
  };
  if (leverage) dBody.leverage = String(leverage);

  const pBody = {
    symbol:   pi42Symbol,
    side:     pSide,
    type:     orderType === 'limit' ? 'LIMIT' : 'MARKET',
    quantity: String(quantity),
    leverage: leverage ? String(leverage) : '1',
    ...(orderType === 'limit' && limitPricePi42 && { price: String(limitPricePi42) })
  };

  const t0 = Date.now();
  const [dr, pr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, dBody),
    pAuth(pi42Key, pi42Secret, 'POST', '/v1/order', pBody)
  ]);

  res.json({
    success:   true,
    latencyMs: Date.now() - t0,
    bothOk:    dr.status === 'fulfilled' && pr.status === 'fulfilled',
    delta: dr.status === 'fulfilled'
      ? { ok: true,  orderId: dr.value?.result?.id || dr.value?.id }
      : { ok: false, error:   dr.reason?.response?.data || dr.reason?.message },
    pi42: pr.status === 'fulfilled'
      ? { ok: true,  orderId: pr.value?.data?.orderId || pr.value?.orderId }
      : { ok: false, error:   pr.reason?.response?.data || pr.reason?.message }
  });
});

// ═══════════════════════════════════════════════════
//  EXIT
// ═══════════════════════════════════════════════════
app.post('/api/exit', async (req, res) => {
  const {
    deltaKey, deltaSecret, pi42Key, pi42Secret,
    deltaProductId, pi42Symbol, longExchange, quantity
  } = req.body;

  const t0 = Date.now();
  const [dr, pr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, {
      product_id:  parseInt(deltaProductId),
      size:        parseFloat(quantity),
      side:        longExchange === 'Delta' ? 'sell' : 'buy',
      order_type:  'market_order',
      reduce_only: true
    }),
    pAuth(pi42Key, pi42Secret, 'POST', '/v1/order', {
      symbol:     pi42Symbol,
      side:       longExchange === 'Pi42' ? 'SELL' : 'BUY',
      type:       'MARKET',
      quantity:   String(quantity),
      reduceOnly: 'true'
    })
  ]);

  res.json({
    success:   true,
    latencyMs: Date.now() - t0,
    delta: dr.status === 'fulfilled' ? { ok: true } : { ok: false, error: dr.reason?.message },
    pi42:  pr.status === 'fulfilled' ? { ok: true } : { ok: false, error: pr.reason?.message }
  });
});

// ═══════════════════════════════════════════════════
//  POSITIONS
// ═══════════════════════════════════════════════════
app.post('/api/positions', async (req, res) => {
  const { deltaKey, deltaSecret, pi42Key, pi42Secret } = req.body;
  const [dr, pr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'GET', '/v2/positions', { page_size: '50' }),
    pAuth(pi42Key, pi42Secret, 'GET', '/v1/account/positions')
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: dr.reason?.message },
    pi42:  pr.status === 'fulfilled' ? pr.value : { error: pr.reason?.message }
  });
});

// ═══════════════════════════════════════════════════
//  HISTORY
// ═══════════════════════════════════════════════════
app.post('/api/history', async (req, res) => {
  const { deltaKey, deltaSecret, pi42Key, pi42Secret } = req.body;
  const [dr, pr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'GET', '/v2/orders', { state: 'closed', page_size: '50' }),
    pAuth(pi42Key, pi42Secret, 'GET', '/v1/order/history', { limit: '50' })
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: dr.reason?.message },
    pi42:  pr.status === 'fulfilled' ? pr.value : { error: pr.reason?.message }
  });
});

// ═══════════════════════════════════════════════════
//  BALANCE — Pi42 INR converted to USD
// ═══════════════════════════════════════════════════
app.post('/api/balance', async (req, res) => {
  const { deltaKey, deltaSecret, pi42Key, pi42Secret } = req.body;
  const inrRate = await getInrRate();

  const [dr, pr] = await Promise.allSettled([
    dAuth(deltaKey, deltaSecret, 'GET', '/v2/wallet/balances'),
    pAuth(pi42Key, pi42Secret, 'GET', '/v1/account/balance')
  ]);

  let deltaUsd = 0;
  if (dr.status === 'fulfilled') {
    const bals = dr.value?.result || [];
    const usdt = Array.isArray(bals) ? bals.find(b => b.asset_symbol === 'USDT') : null;
    deltaUsd   = parseFloat(usdt?.balance || 0);
  }

  let pi42Inr = 0, pi42Usd = 0;
  if (pr.status === 'fulfilled') {
    const d  = pr.value?.data || pr.value;
    pi42Inr  = parseFloat(d?.availableBalance || d?.balance || d?.walletBalance || 0);
    pi42Usd  = inrRate > 0 ? pi42Inr / inrRate : 0;
  }

  res.json({
    deltaUsd,
    pi42Usd:  +pi42Usd.toFixed(2),
    pi42Inr:  +pi42Inr.toFixed(2),
    totalUsd: +(deltaUsd + pi42Usd).toFixed(2),
    inrRate:  +inrRate.toFixed(2)
  });
});

// ═══════════════════════════════════════════════════
//  SERVE FRONTEND
// ═══════════════════════════════════════════════════
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () =>
  console.log(`FundArb v11 | Delta + Pi42 | Port ${PORT}`));
