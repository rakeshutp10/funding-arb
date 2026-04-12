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
//  DELTA EXCHANGE INDIA
// ═══════════════════════════════════════════════════════════
const DELTA = 'https://api.india.delta.exchange';

function deltaSign(secret, method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', secret)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function deltaPublic(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA + ep + qs, {
    timeout: 12000,
    headers: { 'Accept': 'application/json', 'User-Agent': 'FundingArb/5.1' }
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
      'Content-Type': 'application/json', 'User-Agent': 'FundingArb/5.1'
    }
  };
  if (body) cfg.data = body;
  return (await axios(cfg)).data;
}

// ═══════════════════════════════════════════════════════════
//  COINDCX  — Futures / Derivatives
//
//  CoinDCX has TWO separate market systems:
//  1. Spot: /exchange/ticker  → INR pairs like BTCINR
//  2. Futures: separate endpoints, USDT pairs, with funding
//
//  Futures API base: https://api.coindcx.com
//  Key endpoints for futures market data:
//    GET /exchange/v1/derivatives/futures/funding_rates
//    GET /exchange/v1/derivatives/futures/contracts
//    GET /exchange/v1/derivatives/mark_price
//
//  Auth (private): POST with JSON body + HMAC of stringified body
// ═══════════════════════════════════════════════════════════
const DCX = 'https://api.coindcx.com';

function dcxSign(secret, bodyObj) {
  return crypto.createHmac('sha256', secret)
    .update(JSON.stringify(bodyObj)).digest('hex');
}

async function dcxGet(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DCX + ep + qs, {
    timeout: 12000,
    headers: { 'Accept': 'application/json', 'User-Agent': 'FundingArb/5.1' }
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
      'Content-Type': 'application/json', 'User-Agent': 'FundingArb/5.1'
    }
  });
  return r.data;
}

// ───────────────────────────────────────────────────────────
//  FETCH COINDCX FUTURES DATA
//  CoinDCX futures use USDT-denominated perpetual contracts
//  Symbols: "B-BTC_USDT", "B-ETH_USDT" etc
//  OR they may follow format like "BTCUSDTPERP"
// ───────────────────────────────────────────────────────────
async function fetchDCXFutures() {
  // Strategy 1: dedicated futures contracts endpoint
  const futuresEndpoints = [
    '/exchange/v1/derivatives/futures/contracts',
    '/exchange/v1/derivatives/futures',
    '/exchange/v1/futures/contracts',
    '/exchange/v1/futures',
  ];

  let contracts = null;
  let contractsEp = '';

  for (const ep of futuresEndpoints) {
    try {
      const r = await dcxGet(ep);
      const list = Array.isArray(r) ? r : (r?.contracts || r?.data || r?.result || []);
      if (list.length > 0) {
        contracts = list;
        contractsEp = ep;
        break;
      }
    } catch (_) {}
  }

  // Strategy 2: get all market details, filter for futures type
  if (!contracts) {
    try {
      const r = await dcxGet('/exchange/v1/markets_details');
      const all = Array.isArray(r) ? r : (r?.markets || []);
      // Filter for futures/derivatives markets
      contracts = all.filter(m => {
        const t = (m.market_type || m.type || m.coindcx_code || '').toLowerCase();
        return t.includes('futures') || t.includes('perp') ||
               t.includes('deriv') || t.includes('contract') ||
               (m.coindcx_code || '').startsWith('B-');
      });
      if (contracts.length > 0) contractsEp = '/exchange/v1/markets_details (filtered)';
    } catch (_) {}
  }

  // Strategy 3: ticker endpoint filtered for USDT futures
  // CoinDCX futures tickers often have 'B-' prefix or '_PERP' suffix
  let tickers = [];
  let tickersEp = '';
  try {
    const r = await dcxGet('/exchange/ticker');
    const all = Array.isArray(r) ? r : [];
    // Filter for futures: look for B- prefix, USDT suffix without INR, PERP suffix
    tickers = all.filter(t => {
      const sym = (t.market || '').toUpperCase();
      return sym.startsWith('B-') ||
             sym.includes('PERP') ||
             sym.includes('FUT') ||
             sym.includes('_USDT') ||
             (sym.endsWith('USDT') && !sym.endsWith('INRUSDT'));
    });
    if (tickers.length > 0) tickersEp = '/exchange/ticker (futures filtered)';
  } catch (_) {}

  // Strategy 4: dedicated futures ticker endpoint
  if (tickers.length === 0) {
    const tickerEps = [
      '/exchange/v1/derivatives/futures/ticker',
      '/exchange/v1/derivatives/ticker',
      '/exchange/v1/futures/ticker',
    ];
    for (const ep of tickerEps) {
      try {
        const r = await dcxGet(ep);
        const list = Array.isArray(r) ? r : (r?.tickers || r?.data || []);
        if (list.length > 0) { tickers = list; tickersEp = ep; break; }
      } catch (_) {}
    }
  }

  // Fetch funding rates
  let fundingMap = {};
  const fundingEps = [
    '/exchange/v1/derivatives/futures/funding_rates',
    '/exchange/v1/derivatives/funding_rates',
    '/exchange/v1/futures/funding_rates',
  ];
  for (const ep of fundingEps) {
    try {
      const r = await dcxGet(ep);
      if (r && typeof r === 'object') {
        if (Array.isArray(r)) {
          r.forEach(x => {
            if (x.symbol || x.market) {
              fundingMap[x.symbol || x.market] = parseFloat(x.funding_rate || x.rate || 0);
            }
          });
        } else {
          Object.entries(r).forEach(([k, v]) => {
            fundingMap[k] = typeof v === 'object' ? parseFloat(v.rate || v.funding_rate || 0) : parseFloat(v);
          });
        }
        if (Object.keys(fundingMap).length > 0) break;
      }
    } catch (_) {}
  }

  return { contracts, tickers, fundingMap, contractsEp, tickersEp };
}

// ───────────────────────────────────────────────────────────
//  PARSE COINDCX FUTURES into standard map
// ───────────────────────────────────────────────────────────
function parseDCXFutures(tickers, contracts, fundingMap) {
  const map = {};

  // First try tickers list
  const list = tickers.length > 0 ? tickers : (contracts || []);

  for (const t of list) {
    const sym = (t.market || t.symbol || t.coindcx_code || '').toUpperCase();
    if (!sym) continue;

    // Extract base asset from symbol
    // Possible formats: B-BTC_USDT, BTCUSDT_PERP, BTCUSDTFUT, BTCUSDT
    let base = '';
    if (sym.startsWith('B-')) {
      // B-BTC_USDT or B-ETH_USDT
      base = sym.slice(2).split('_')[0].replace(/USDT?$/i, '');
    } else if (sym.includes('_PERP')) {
      base = sym.split('_PERP')[0].replace(/USDT?$/i, '').replace(/_/g, '');
    } else if (sym.includes('_FUT')) {
      base = sym.split('_FUT')[0].replace(/USDT?$/i, '').replace(/_/g, '');
    } else if (sym.endsWith('USDT')) {
      base = sym.replace(/USDT$/i, '');
    } else if (sym.includes('_USDT')) {
      base = sym.split('_USDT')[0].replace(/_/g, '');
    } else {
      // fallback: use base_currency fields from contracts
      base = (t.base_currency_short_name || t.base || t.base_asset || '').toUpperCase();
    }

    if (!base || base.length < 2) continue;

    const price = parseFloat(
      t.last_price || t.lastPrice || t.mark_price || t.markPrice ||
      t.close || t.price || 0
    );
    if (price <= 0) continue;

    // Get funding rate
    let fr = parseFloat(
      fundingMap[sym] || fundingMap[t.market] ||
      t.funding_rate || t.fundingRate ||
      t.current_funding_rate || 0
    );
    // Normalize
    if (fr !== 0 && Math.abs(fr) < 0.001) fr = fr * 100;

    map[base] = {
      symbol:      sym,
      price,
      fundingRate: fr,
      volume24h:   parseFloat(t.volume || t.baseVolume || t.quote_volume || t.volume_24h || 0),
      change24h:   parseFloat(t.change_24_hour || t.priceChangePercent || t.change || 0),
      nextFunding: t.next_funding_time || null
    };
  }
  return map;
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

// ═══════════════════════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════════════════════
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', version: '5.1.0', ts: Date.now() }));

// ═══════════════════════════════════════════════════════════
//  DEBUG
// ═══════════════════════════════════════════════════════════
app.get('/debug/delta', async (_req, res) => {
  try {
    const d    = await deltaPublic('/v2/tickers', { contract_types: 'perpetual_futures' });
    const list = d?.result || d?.data || [];
    res.json({
      ok: true, count: list.length,
      sample: list.slice(0, 3).map(t => ({
        base: t.underlying_asset_symbol, symbol: t.symbol,
        price: t.mark_price, funding: t.funding_rate
      }))
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.get('/debug/dcx', async (_req, res) => {
  try {
    const result = await fetchDCXFutures();
    const parsed = parseDCXFutures(result.tickers, result.contracts, result.fundingMap);
    const count  = Object.keys(parsed).length;

    // Also show raw ticker samples to help diagnose
    const allTickers = await dcxGet('/exchange/ticker').catch(() => []);
    const allArr = Array.isArray(allTickers) ? allTickers : [];

    // Show first 5 raw tickers AND first 5 that look like futures
    const rawSample  = allArr.slice(0, 5).map(t => t.market);
    const futureLike = allArr.filter(t => {
      const s = (t.market || '').toUpperCase();
      return s.startsWith('B-') || s.includes('PERP') || s.includes('FUT') || s.includes('_USDT');
    }).slice(0, 10).map(t => ({
      market: t.market, price: t.last_price
    }));

    res.json({
      ok: true,
      contractsEndpoint: result.contractsEp || 'none',
      tickersEndpoint:   result.tickersEp   || 'none',
      futuresParsed:     count,
      fundingEntries:    Object.keys(result.fundingMap).length,
      parsedCoins:       Object.keys(parsed).slice(0, 10),
      parsedSample:      Object.entries(parsed).slice(0, 3).map(([b, v]) => ({
        base: b, symbol: v.symbol, price: v.price, fundingRate: v.fundingRate
      })),
      rawFirstFive:    rawSample,
      futureLikeTickers: futureLike.length > 0 ? futureLike : 'none found in ticker endpoint'
    });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ═══════════════════════════════════════════════════════════
//  SCAN
// ═══════════════════════════════════════════════════════════
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

    // Parse CoinDCX Futures
    let dcxMap = {}, dcxOk = false;
    if (dcxRaw.status === 'fulfilled') {
      const { tickers, contracts, fundingMap } = dcxRaw.value;
      dcxMap = parseDCXFutures(tickers, contracts, fundingMap);
      dcxOk  = Object.keys(dcxMap).length > 0;
    }

    // Match coins on BOTH exchanges
    const FEES = TAKER * 2 * 100;
    const opps = [];

    for (const [base, d] of Object.entries(deltaMap)) {
      const c = dcxMap[base];
      if (!c || d.price <= 0 || c.price <= 0) continue;

      const dR   = d.fundingRate, cR = c.fundingRate;
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
      const score= diff*(scenarioType==='goldmine'?2.5:1)*(urg==='urgent'?2:urg==='soon'?1.5:1);

      opps.push({
        base, deltaSymbol:d.symbol, dcxSymbol:c.symbol,
        deltaProductId:d.productId,
        deltaPrice:d.price, dcxPrice:c.price,
        deltaFunding:+dR.toFixed(6), dcxFunding:+cR.toFixed(6),
        fundingDiff:+diff.toFixed(6), netYield:+net.toFixed(6),
        spread:+spr.toFixed(4), feesDeducted:+FEES.toFixed(4),
        volume:Math.max(d.volume24h,c.volume24h),
        deltaChange24h:d.change24h, dcxChange24h:c.change24h,
        longExchange:longEx, shortExchange:shortEx,
        scenario, scenarioType, urgency:urg, score
      });
    }
    opps.sort((a,b)=>b.score-a.score);

    res.json({
      success:true, data:opps, count:opps.length,
      deltaCount:Object.keys(deltaMap).length,
      dcxCount:Object.keys(dcxMap).length,
      matchedCount:opps.length,
      deltaOk, dcxOk, ts:Date.now()
    });
  } catch (err) {
    console.error('[SCAN]', err.message);
    res.status(500).json({ success:false, error:err.message });
  }
});

// ═══════════════════════════════════════════════════════════
//  ORDER
// ═══════════════════════════════════════════════════════════
app.post('/api/order', async (req, res) => {
  const {
    deltaKey, deltaSecret, dcxKey, dcxSecret,
    deltaSymbol, dcxSymbol, deltaProductId, longExchange,
    quantity, leverage, orderType, limitPriceDelta, limitPriceDcx
  } = req.body;

  if (!deltaKey||!dcxKey)
    return res.status(400).json({success:false, error:'API keys required in Settings.'});

  const dSide = longExchange==='Delta'  ?'buy':'sell';
  const cSide = longExchange==='CoinDCX'?'buy':'sell';

  const dBody = {
    product_id:parseInt(deltaProductId), size:parseInt(quantity),
    side:dSide, order_type:orderType==='limit'?'limit_order':'market_order',
    ...(orderType==='limit'&&limitPriceDelta&&{limit_price:String(limitPriceDelta)})
  };
  if (leverage) dBody.leverage = String(leverage);

  // CoinDCX futures order
  const cBody = {
    market:dcxSymbol, side:cSide,
    order_type:orderType==='limit'?'limit_order':'market_order',
    quantity:parseFloat(quantity),
    ...(leverage&&{leverage:parseInt(leverage)}),
    ...(orderType==='limit'&&limitPriceDcx&&{price:parseFloat(limitPriceDcx)})
  };

  const t0 = Date.now();
  const [dr,cr] = await Promise.allSettled([
    deltaPrivate(deltaKey,deltaSecret,'POST','/v2/orders',{},dBody),
    dcxPrivate(dcxKey,dcxSecret,'/exchange/v1/orders/create',cBody)
  ]);

  res.json({
    success:true, latencyMs:Date.now()-t0,
    bothOk:dr.status==='fulfilled'&&cr.status==='fulfilled',
    delta:dr.status==='fulfilled'
      ?{ok:true,data:dr.value,orderId:dr.value?.result?.id||dr.value?.id}
      :{ok:false,error:dr.reason?.response?.data||dr.reason?.message},
    dcx:cr.status==='fulfilled'
      ?{ok:true,data:cr.value,orderId:cr.value?.orders?.[0]?.id||cr.value?.id}
      :{ok:false,error:cr.reason?.response?.data||cr.reason?.message}
  });
});

// ═══════════════════════════════════════════════════════════
//  EXIT
// ═══════════════════════════════════════════════════════════
app.post('/api/exit', async (req, res) => {
  const {deltaKey,deltaSecret,dcxKey,dcxSecret,
    deltaProductId,dcxSymbol,longExchange,quantity} = req.body;

  const t0 = Date.now();
  const [dr,cr] = await Promise.allSettled([
    deltaPrivate(deltaKey,deltaSecret,'POST','/v2/orders',{},{
      product_id:parseInt(deltaProductId), size:parseInt(quantity),
      side:longExchange==='Delta'?'sell':'buy',
      order_type:'market_order', reduce_only:true
    }),
    dcxPrivate(dcxKey,dcxSecret,'/exchange/v1/orders/create',{
      market:dcxSymbol, side:longExchange==='CoinDCX'?'sell':'buy',
      order_type:'market_order', quantity:parseFloat(quantity)
    })
  ]);

  res.json({
    success:true, latencyMs:Date.now()-t0,
    delta:dr.status==='fulfilled'?{ok:true,data:dr.value}:{ok:false,error:dr.reason?.message},
    dcx:  cr.status==='fulfilled'?{ok:true,data:cr.value}:{ok:false,error:cr.reason?.message}
  });
});

// ═══════════════════════════════════════════════════════════
//  POSITIONS
// ═══════════════════════════════════════════════════════════
app.post('/api/positions', async (req, res) => {
  const {deltaKey,deltaSecret,dcxKey,dcxSecret} = req.body;
  const [dr,cr] = await Promise.allSettled([
    deltaPrivate(deltaKey,deltaSecret,'GET','/v2/positions',{page_size:'50'}),
    dcxPrivate(dcxKey,dcxSecret,'/exchange/v1/orders/active_orders')
  ]);
  res.json({
    delta:dr.status==='fulfilled'?dr.value:{error:dr.reason?.message},
    dcx:  cr.status==='fulfilled'?cr.value:{error:cr.reason?.message}
  });
});

// ═══════════════════════════════════════════════════════════
//  HISTORY
// ═══════════════════════════════════════════════════════════
app.post('/api/history', async (req, res) => {
  const {deltaKey,deltaSecret,dcxKey,dcxSecret} = req.body;
  const [dr,cr] = await Promise.allSettled([
    deltaPrivate(deltaKey,deltaSecret,'GET','/v2/orders',{state:'closed',page_size:'50'}),
    dcxPrivate(dcxKey,dcxSecret,'/exchange/v1/orders/trade_history',{limit:50})
  ]);
  res.json({
    delta:dr.status==='fulfilled'?dr.value:{error:dr.reason?.message},
    dcx:  cr.status==='fulfilled'?cr.value:{error:cr.reason?.message}
  });
});

// ═══════════════════════════════════════════════════════════
//  BALANCE
// ═══════════════════════════════════════════════════════════
app.post('/api/balance', async (req, res) => {
  const {deltaKey,deltaSecret,dcxKey,dcxSecret} = req.body;
  const [dr,cr] = await Promise.allSettled([
    deltaPrivate(deltaKey,deltaSecret,'GET','/v2/wallet/balances'),
    dcxPrivate(dcxKey,dcxSecret,'/exchange/v1/users/balances')
  ]);

  let deltaUsd=0;
  if (dr.status==='fulfilled') {
    const bals=dr.value?.result||[];
    const usdt=Array.isArray(bals)?bals.find(b=>b.asset_symbol==='USDT'):null;
    deltaUsd=parseFloat(usdt?.balance||0);
  }

  let dcxUsd=0;
  if (cr.status==='fulfilled') {
    const arr=Array.isArray(cr.value)?cr.value:(cr.value?.balance||cr.value?.balances||[]);
    const usdt=arr.find?.(b=>(b.currency||b.short_name||'').toUpperCase()==='USDT');
    dcxUsd=parseFloat(usdt?.balance||usdt?.available_balance||0);
  }

  res.json({ deltaUsd, dcxUsd, total:deltaUsd+dcxUsd });
});

// ═══════════════════════════════════════════════════════════
//  SERVE FRONTEND
// ═══════════════════════════════════════════════════════════
app.get('*', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () =>
  console.log(`FundingArb v5.1 | Delta Exchange India + CoinDCX Futures | Port ${PORT}`));
