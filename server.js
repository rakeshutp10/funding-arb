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

// ══════════════════════════════════════════════════════
//  DELTA EXCHANGE INDIA
// ══════════════════════════════════════════════════════
const DELTA = 'https://api.india.delta.exchange';

function deltaSign(secret, method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', secret)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function deltaPublic(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA + ep + qs, {
    timeout: 12000,
    headers: { 'Accept': 'application/json', 'User-Agent': 'FundingArb/5.3' }
  });
  return r.data;
}

async function deltaPrivate(key, secret, method, ep, query = {}, body = null) {
  const ts  = Math.floor(Date.now() / 1000).toString();
  const qs  = Object.keys(query).length ? '?' + new URLSearchParams(query) : '';
  const bs  = body ? JSON.stringify(body) : '';
  const sig = deltaSign(secret, method, ep, qs, bs, ts);
  const cfg = {
    method, url: DELTA + ep + qs, timeout: 12000,
    headers: {
      'api-key': key, 'timestamp': ts, 'signature': sig,
      'Content-Type': 'application/json', 'User-Agent': 'FundingArb/5.3'
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
    map[base] = {
      symbol:      t.symbol || '',
      productId:   t.id || t.product_id,
      price:       parseFloat(t.mark_price || t.last_price || t.close || 0),
      fundingRate: fr * 100,
      volume24h:   parseFloat(t.volume || t.turnover_usd || 0),
      change24h:   parseFloat(t.price_change_percent || 0),
      nextFunding: t.next_funding_realization || null
    };
  }
  return map;
}

// ══════════════════════════════════════════════════════
//  COINDCX FUTURES
//  CoinDCX has TWO market systems:
//  - Spot: api.coindcx.com/exchange/ticker (INR pairs)
//  - Futures: api.coindcx.com/exchange/v1/derivatives/...
//
//  Funding rate is available in perpetual contracts.
//  CoinDCX futures use USDT-settled perpetuals.
//  Their contracts endpoint returns funding_rate per contract.
// ══════════════════════════════════════════════════════
const DCX = 'https://api.coindcx.com';

function dcxSign(secret, body) {
  return crypto.createHmac('sha256', secret)
    .update(JSON.stringify(body)).digest('hex');
}

async function dcxGet(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DCX + ep + qs, {
    timeout: 10000,
    headers: { 'Accept': 'application/json', 'User-Agent': 'FundingArb/5.3' }
  });
  return r.data;
}

async function dcxPrivate(key, secret, ep, bodyObj = {}) {
  const body = { ...bodyObj, timestamp: Date.now() };
  const sig  = dcxSign(secret, body);
  const r    = await axios.post(DCX + ep, body, {
    timeout: 12000,
    headers: {
      'X-AUTH-APIKEY': key, 'X-AUTH-SIGNATURE': sig,
      'Content-Type': 'application/json', 'User-Agent': 'FundingArb/5.3'
    }
  });
  return r.data;
}

// ──────────────────────────────────────────────────────
//  FETCH COINDCX FUTURES + FUNDING RATES
//  Strategy: fetch contracts (with funding_rate field),
//  then cross-reference with live ticker prices.
// ──────────────────────────────────────────────────────
async function fetchDCXFutures() {
  const result = {
    map: {},
    ok: false,
    totalContracts: 0,
    totalParsed: 0,
    fundingSource: 'none',
    priceSource: 'none',
    debug: []
  };

  // ── STEP 1: Get contracts with funding rates ──────
  // CoinDCX returns perpetual contracts here with funding_rate included
  const contractEndpoints = [
    '/exchange/v1/derivatives/futures/contracts',
    '/exchange/v1/derivatives/contracts',
    '/exchange/v1/futures/contracts',
  ];

  let contracts = [];
  for (const ep of contractEndpoints) {
    try {
      const r = await dcxGet(ep);
      const list = Array.isArray(r) ? r :
                   Array.isArray(r?.contracts) ? r.contracts :
                   Array.isArray(r?.data) ? r.data : [];
      if (list.length > 0) {
        contracts = list;
        result.fundingSource = ep;
        result.debug.push(`Contracts from ${ep}: ${list.length}`);
        break;
      }
    } catch (e) {
      result.debug.push(`${ep}: FAIL ${e.response?.status||e.message}`);
    }
  }

  // ── STEP 2: Get markets_details as fallback ───────
  if (contracts.length === 0) {
    try {
      const r = await dcxGet('/exchange/v1/markets_details');
      const all = Array.isArray(r) ? r : [];
      contracts = all.filter(m => {
        const code = (m.coindcx_code || m.symbol || '').toUpperCase();
        const type = (m.market_type || '').toLowerCase();
        return code.startsWith('B-') || type.includes('futures') ||
               type.includes('deriv') || type.includes('perp') ||
               code.includes('PERP') || code.includes('_FUT');
      });
      result.fundingSource = 'markets_details (filtered)';
      result.debug.push(`markets_details filtered: ${contracts.length}`);
    } catch (e) {
      result.debug.push(`markets_details: FAIL ${e.message}`);
    }
  }

  result.totalContracts = contracts.length;

  // ── STEP 3: Get live prices from ticker ──────────
  // CoinDCX futures tickers have live prices
  let tickerMap = {};
  try {
    const r = await dcxGet('/exchange/ticker');
    const all = Array.isArray(r) ? r : [];
    result.priceSource = `/exchange/ticker (${all.length} total)`;

    // Map by market symbol for quick lookup
    for (const t of all) {
      const sym = (t.market || '').toUpperCase();
      tickerMap[sym] = t;
    }

    // Also build a base-asset lookup for fuzzy matching
    result.debug.push(`Ticker map built: ${all.length} entries`);
  } catch (e) {
    result.debug.push(`ticker: FAIL ${e.message}`);
  }

  // ── STEP 4: Parse contracts into standardised map ─
  for (const c of contracts) {
    const sym = (c.coindcx_code || c.symbol || c.market || '').toUpperCase();
    if (!sym) continue;

    // Extract base asset
    let base = '';
    if (sym.startsWith('B-')) {
      // Format: B-BTC_USDT → BTC
      base = sym.replace('B-', '').split('_')[0].replace(/USDT?$/i, '');
    } else if (sym.includes('_PERP')) {
      base = sym.split('_PERP')[0].replace(/USDT?$/i, '').replace(/_/g, '');
    } else if (sym.includes('_FUT')) {
      base = sym.split('_FUT')[0].replace(/USDT?$/i, '').replace(/_/g, '');
    } else if (sym.endsWith('USDT')) {
      base = sym.replace(/USDT$/, '');
    } else {
      base = (c.target_currency_short_name || c.base_currency_short_name || c.base || '').toUpperCase();
    }

    if (!base || base.length < 2 || base.length > 10) continue;

    // Get funding rate from contract (primary source)
    // CoinDCX contracts have funding_rate as a decimal (e.g., 0.0001 = 0.01%)
    let fr = parseFloat(
      c.funding_rate || c.current_funding_rate ||
      c.predicted_funding_rate || c.next_funding_rate || 0
    );
    // Normalize: if very small decimal, it's already a fraction → convert to %
    if (fr !== 0 && Math.abs(fr) < 0.01) fr = fr * 100;

    // Get price from contract fields OR from ticker map
    let price = parseFloat(c.mark_price || c.last_price || c.price || c.close || 0);

    // Try to match with live ticker for better price data
    const ticker = tickerMap[sym] || tickerMap[base + 'USDT'] || tickerMap['B-' + base + '_USDT'];
    if (ticker) {
      const tPrice = parseFloat(ticker.last_price || 0);
      if (tPrice > 0) price = tPrice;
      // Also try to get funding rate from ticker if contract had 0
      if (fr === 0) {
        fr = parseFloat(ticker.funding_rate || ticker.predicted_funding_rate || 0);
        if (fr !== 0 && Math.abs(fr) < 0.01) fr = fr * 100;
      }
    }

    if (price <= 0) continue;

    result.map[base] = {
      symbol:      sym,
      price,
      fundingRate: fr,
      volume24h:   parseFloat(
        c.volume_24h || c.base_volume || ticker?.volume || 0
      ),
      change24h:   parseFloat(
        c.price_change_24h || c.change_24h || ticker?.change_24_hour || 0
      ),
      nextFunding: c.next_funding_time || c.next_funding_settlement || null
    };
  }

  result.totalParsed = Object.keys(result.map).length;
  result.ok = result.totalParsed > 0;
  return result;
}

// ══════════════════════════════════════════════════════
//  HEALTH
// ══════════════════════════════════════════════════════
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: '5.3.0', ts: Date.now() }));

// ══════════════════════════════════════════════════════
//  DEBUG ENDPOINTS
// ══════════════════════════════════════════════════════
app.get('/debug/delta', async (_req, res) => {
  try {
    const d    = await deltaPublic('/v2/tickers', { contract_types: 'perpetual_futures' });
    const list = d?.result || d?.data || [];
    res.json({
      ok: true,
      count: list.length,
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
    const r = await fetchDCXFutures();

    // Show sample with funding rates
    const sample = Object.entries(r.map).slice(0, 5).map(([b, v]) => ({
      base:        b,
      symbol:      v.symbol,
      price:       v.price,
      fundingRate: v.fundingRate
    }));

    // Count how many have non-zero funding rate
    const withFunding = Object.values(r.map).filter(v => v.fundingRate !== 0).length;

    res.json({
      ok:              r.ok,
      totalContracts:  r.totalContracts,
      totalParsed:     r.totalParsed,
      withFundingRate: withFunding,
      fundingSource:   r.fundingSource,
      priceSource:     r.priceSource,
      sampleCoins:     Object.keys(r.map).slice(0, 10),
      sample,
      debugLog:        r.debug
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ══════════════════════════════════════════════════════
//  SCAN
// ══════════════════════════════════════════════════════
app.post('/api/scan', async (req, res) => {
  try {
    const TAKER = 0.0005;

    const [deltaRaw, dcxRaw] = await Promise.allSettled([
      deltaPublic('/v2/tickers', { contract_types: 'perpetual_futures' }),
      fetchDCXFutures()
    ]);

    // Parse Delta
    let deltaMap = {}, deltaOk = false;
    if (deltaRaw.status === 'fulfilled') {
      deltaMap = parseDelta(deltaRaw.value);
      deltaOk  = Object.keys(deltaMap).length > 0;
    }

    // CoinDCX result
    let dcxMap = {}, dcxOk = false, dcxCount = 0;
    if (dcxRaw.status === 'fulfilled' && dcxRaw.value.ok) {
      dcxMap  = dcxRaw.value.map;
      dcxOk   = true;
      dcxCount = dcxRaw.value.totalParsed;
    }

    // Match coins on BOTH exchanges
    const FEES = TAKER * 2 * 100;
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

      let longEx, shortEx, scenario, scenarioType;
      if (dR >= 0 && cR >= 0) {
        scenarioType = 'positive'; scenario = 'Both Positive';
        dR >= cR ? (shortEx='Delta',longEx='CoinDCX') : (shortEx='CoinDCX',longEx='Delta');
      } else if (dR <= 0 && cR <= 0) {
        scenarioType = 'negative'; scenario = 'Both Negative';
        dR > cR  ? (shortEx='Delta',longEx='CoinDCX') : (shortEx='CoinDCX',longEx='Delta');
      } else {
        scenarioType = 'goldmine'; scenario = 'GOLDMINE';
        dR > 0   ? (shortEx='Delta',longEx='CoinDCX') : (shortEx='CoinDCX',longEx='Delta');
      }

      const now  = new Date();
      const sec  = now.getUTCHours()*3600+now.getUTCMinutes()*60+now.getUTCSeconds();
      const rem  = 8*3600-(sec%(8*3600));
      const urg  = rem<=1800?'urgent':rem<=3600?'soon':'normal';
      const score= diff*(scenarioType==='goldmine'?2.5:1)*
                   (urg==='urgent'?2:urg==='soon'?1.5:1);

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
      dcxCount,
      matchedCount: opps.length,
      deltaOk, dcxOk,
      ts: Date.now()
    });
  } catch (err) {
    console.error('[SCAN]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ══════════════════════════════════════════════════════
//  ORDER — fire both simultaneously
// ══════════════════════════════════════════════════════
app.post('/api/order', async (req, res) => {
  const {
    deltaKey, deltaSecret, dcxKey, dcxSecret,
    deltaSymbol, dcxSymbol, deltaProductId, longExchange,
    quantity, leverage, orderType, limitPriceDelta, limitPriceDcx
  } = req.body;

  if (!deltaKey || !dcxKey)
    return res.status(400).json({ success: false, error: 'API keys required in Settings.' });

  const dSide = longExchange === 'Delta'   ? 'buy'  : 'sell';
  const cSide = longExchange === 'CoinDCX' ? 'buy'  : 'sell';

  const dBody = {
    product_id: parseInt(deltaProductId),
    size:       parseInt(quantity),
    side:       dSide,
    order_type: orderType === 'limit' ? 'limit_order' : 'market_order',
    ...(orderType==='limit' && limitPriceDelta && { limit_price: String(limitPriceDelta) })
  };
  if (leverage) dBody.leverage = String(leverage);

  const cBody = {
    market:      dcxSymbol,
    side:        cSide,
    order_type:  orderType === 'limit' ? 'limit_order' : 'market_order',
    quantity:    parseFloat(quantity),
    ...(leverage && { leverage: parseInt(leverage) }),
    ...(orderType==='limit' && limitPriceDcx && { price: parseFloat(limitPriceDcx) })
  };

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    deltaPrivate(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, dBody),
    dcxPrivate(dcxKey, dcxSecret, '/exchange/v1/orders/create', cBody)
  ]);

  res.json({
    success:   true,
    latencyMs: Date.now() - t0,
    bothOk:    dr.status === 'fulfilled' && cr.status === 'fulfilled',
    delta: dr.status === 'fulfilled'
      ? { ok: true,  data: dr.value, orderId: dr.value?.result?.id || dr.value?.id }
      : { ok: false, error: dr.reason?.response?.data || dr.reason?.message },
    dcx: cr.status === 'fulfilled'
      ? { ok: true,  data: cr.value, orderId: cr.value?.orders?.[0]?.id || cr.value?.id }
      : { ok: false, error: cr.reason?.response?.data || cr.reason?.message }
  });
});

// ══════════════════════════════════════════════════════
//  EXIT
// ══════════════════════════════════════════════════════
app.post('/api/exit', async (req, res) => {
  const { deltaKey, deltaSecret, dcxKey, dcxSecret,
    deltaProductId, dcxSymbol, longExchange, quantity } = req.body;

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    deltaPrivate(deltaKey, deltaSecret, 'POST', '/v2/orders', {}, {
      product_id:  parseInt(deltaProductId),
      size:        parseInt(quantity),
      side:        longExchange === 'Delta' ? 'sell' : 'buy',
      order_type:  'market_order',
      reduce_only: true
    }),
    dcxPrivate(dcxKey, dcxSecret, '/exchange/v1/orders/create', {
      market:     dcxSymbol,
      side:       longExchange === 'CoinDCX' ? 'sell' : 'buy',
      order_type: 'market_order',
      quantity:   parseFloat(quantity)
    })
  ]);

  res.json({
    success:   true,
    latencyMs: Date.now() - t0,
    delta: dr.status === 'fulfilled' ? { ok: true, data: dr.value } : { ok: false, error: dr.reason?.message },
    dcx:   cr.status === 'fulfilled' ? { ok: true, data: cr.value } : { ok: false, error: cr.reason?.message }
  });
});

// ══════════════════════════════════════════════════════
//  POSITIONS
// ══════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════
//  HISTORY
// ══════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════
//  BALANCE
// ══════════════════════════════════════════════════════
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
    const arr  = Array.isArray(cr.value) ? cr.value : (cr.value?.balance || cr.value?.balances || []);
    const usdt = arr.find?.(b => (b.currency || b.short_name || '').toUpperCase() === 'USDT');
    dcxUsd     = parseFloat(usdt?.balance || usdt?.available_balance || 0);
  }

  res.json({ deltaUsd, dcxUsd, total: deltaUsd + dcxUsd });
});

// ══════════════════════════════════════════════════════
//  FRONTEND
// ══════════════════════════════════════════════════════
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () =>
  console.log(`FundingArb v5.3 | Delta Exchange India + CoinDCX | Port ${PORT}`));
