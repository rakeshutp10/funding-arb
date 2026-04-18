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

    // Detect funding interval from next_funding_realization timestamp
    // Check which standard boundary (1H/4H/8H) the timestamp aligns to
    let fundingInterval = 8; // default
    let nextFundingTs   = null;
    if (t.next_funding_realization) {
      const ts = new Date(t.next_funding_realization).getTime();
      nextFundingTs = ts;
      const tsSec = Math.floor(ts / 1000);
      // If timestamp aligns to 1-hour boundary exactly → 1H cycle
      if (tsSec % 3600 === 0) {
        if (tsSec % 28800 === 0)      fundingInterval = 8;  // 8H boundary (also 1H/4H aligned)
        else if (tsSec % 14400 === 0) fundingInterval = 4;  // 4H boundary
        else                          fundingInterval = 1;  // pure 1H
      }
      // Use time-until as secondary signal
      const secUntil = (ts - Date.now()) / 1000;
      if (secUntil > 0 && secUntil <= 3700)  fundingInterval = 1;  // < 1h left → 1H coin
      else if (secUntil <= 14600)            fundingInterval = 4;  // < 4h left → 4H coin
    }

    map[base] = {
      symbol:          t.symbol || '',
      productId:       t.id || t.product_id,
      price,
      fundingRate:     +fr.toFixed(6),
      volume24h:       parseFloat(t.volume || t.turnover_usd || 0),
      change24h:       parseFloat(t.price_change_percent || 0),
      nextFunding:     t.next_funding_realization || null,
      nextFundingTs,
      fundingInterval  // 1, 4, or 8
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
        const price = parseFloat(c.ls || c.mp || 0);  // ls=last price, mp=mark price
        if (price <= 0) continue;
        // CoinDCX docs: fr = current funding rate (decimal), efr = estimated funding rate
        // e.g. fr: 5e-05 → 0.005%,  fr: -0.00011894 → -0.011894%
        // Multiply × 100 to convert decimal → percentage
        const frRaw = c.fr != null ? parseFloat(c.fr) : (c.efr != null ? parseFloat(c.efr) : 0);
        const fr = +(frRaw * 100).toFixed(6);
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
//  STRATEGY LOGIC
//  Both Negative: Long more-negative (you RECEIVE that funding), Short less-negative (hedge)
//  Both Positive: Short more-positive (you RECEIVE), Long less-positive (hedge)
//  Goldmine: Short positive (receive) + Long negative (receive) — collect from BOTH sides
//  Net yield = |rate_difference| - 0.10% round-trip fee estimate
// ─────────────────────────────────────────────────────
function calcStrat(dR, cR) {
  // For goldmine: net = |dR| + |cR| - fees  (since dR-cR already = |dR|+|cR| when signs differ)
  const diff = Math.abs(dR - cR);
  const net  = +(diff - 0.10).toFixed(6);
  let longEx, shortEx, scenario, scenarioType;

  if (dR <= 0 && cR <= 0) {
    // Both negative — long the MORE negative one (receive funding), short the other (hedge)
    scenarioType = 'negative'; scenario = 'Both -';
    if (dR < cR) { longEx = 'Delta';   shortEx = 'CoinDCX'; }
    else          { longEx = 'CoinDCX'; shortEx = 'Delta';   }
  } else if (dR >= 0 && cR >= 0) {
    // Both positive — short the MORE positive one (receive funding), long the other (hedge)
    scenarioType = 'positive'; scenario = 'Both +';
    if (dR > cR) { shortEx = 'Delta';   longEx = 'CoinDCX'; }
    else          { shortEx = 'CoinDCX'; longEx = 'Delta';   }
  } else {
    // Goldmine — one positive, one negative — collect from BOTH sides
    scenarioType = 'goldmine'; scenario = 'GOLDMINE';
    if (dR > 0) { shortEx = 'Delta';   longEx = 'CoinDCX'; }
    else         { shortEx = 'CoinDCX'; longEx = 'Delta';   }
  }
  return { longEx, shortEx, scenario, scenarioType, diff: +diff.toFixed(6), net };
}

// ─────────────────────────────────────────────────────
//  HEALTH
// ─────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status:'ok', version:'15.0.0', port:PORT,
  deltaKeySet:!!DELTA_KEY, dcxKeySet:!!DCX_KEY, ts:Date.now()
}));

// Expose Railway server's outbound IP — needed for Delta API key whitelist
app.get('/api/railwayip', async (_req, res) => {
  try {
    const r = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
    res.json({ ip: r.data.ip, hint: `Add this IP to Delta Exchange API Key whitelist, OR set whitelist to 0.0.0.0 to allow all.` });
  } catch(e) {
    res.json({ ip: 'unknown', error: errMsg(e) });
  }
});

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
    const allVals  = Object.values(r.map);
    const withFR   = allVals.filter(v => v.fundingRate !== 0).length;
    const posCount = allVals.filter(v => v.fundingRate > 0).length;
    const negCount = allVals.filter(v => v.fundingRate < 0).length;
    // Show 5 with non-zero funding for easy verification
    const nonZeroSample = Object.entries(r.map)
      .filter(([,v]) => v.fundingRate !== 0)
      .slice(0,5)
      .map(([b,v]) => ({ base:b, symbol:v.symbol, price:v.price, fundingRate:v.fundingRate }));
    res.json({
      ok: r.ok, source: r.source, total: r.total,
      parsed: Object.keys(r.map).length, withFunding: withFR,
      positive: posCount, negative: negCount,
      fundingNote: 'fr field from rt endpoint × 100 = % (e.g. 5e-05 × 100 = 0.005%)',
      steps: r.steps, errors: r.errors,
      sampleCoins: Object.keys(r.map).slice(0,12),
      sample: nonZeroSample.length ? nonZeroSample : Object.entries(r.map).slice(0,5).map(([b,v])=>({base:b,symbol:v.symbol,price:v.price,fundingRate:v.fundingRate}))
    });
  } catch(e) {
    res.json({ ok:false, error:errMsg(e), steps:[], errors:[errMsg(e)] });
  }
});

// ─────────────────────────────────────────────────────
//  DEBUG — Raw probe of every DCX endpoint
// ─────────────────────────────────────────────────────
app.get('/debug/dcx-raw', async (_req, res) => {
  // NOTE: CoinDCX funding rates come embedded in the rt prices endpoint (fr/efr fields)
  // There is NO standalone funding_rates endpoint — it returns 404
  const probes = [
    { name:'rt_prices — main source',   url:`${DCX_PUBLIC}/market_data/v3/current_prices/futures/rt`,
      note:'Funding: fr=current, efr=estimated (decimal × 100 = %)' },
    { name:'active_instruments[USDT]',  url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/active_instruments?margin_currency_short_name[]=USDT` },
    { name:'instrument_detail[BTC]',    url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/instrument?pair=B-BTC_USDT&margin_currency_short_name=USDT` },
    { name:'trades[BTC]',               url:`${DCX_BASE}/exchange/v1/derivatives/futures/data/trades?pair=B-BTC_USDT` },
    { name:'orderbook[BTC]',            url:`${DCX_PUBLIC}/market_data/v3/orderbook/B-BTC_USDT-futures/10` },
  ];
  const results = [];
  for (const p of probes) {
    try {
      const start = Date.now();
      const r     = await axios.get(p.url, { timeout:12000, headers:{ Accept:'application/json' } });
      const data  = r.data;
      // For rt endpoint, extract funding rate sample
      let frSample = '';
      if (p.name.includes('rt_prices') && data?.prices) {
        const keys = Object.keys(data.prices);
        const sample = keys.slice(0, 2).map(k => {
          const d = data.prices[k];
          return `${k}: fr=${d.fr} efr=${d.efr} → ${+(parseFloat(d.fr||0)*100).toFixed(5)}%`;
        });
        frSample = sample.join(' | ');
      }
      const len  = p.name.includes('rt_prices') && data?.prices
        ? Object.keys(data.prices).length
        : Array.isArray(data) ? data.length
        : (data?.data?.length||data?.result?.length||data?.instruments?.length||'(object)');
      const peek = Array.isArray(data)&&data[0] ? Object.keys(data[0]).slice(0,8).join(', ') : (p.note||'n/a');
      results.push({ name:p.name, ok:true, status:r.status, ms:Date.now()-start, items:len, fields:frSample||peek });
    } catch(e) {
      results.push({ name:p.name, ok:false, status:e.response?.status||'NO_RESPONSE', error:errMsg(e) });
    }
  }
  res.json({
    ts: Date.now(),
    fundingNote: 'CoinDCX funding rates are in the rt_prices endpoint: fr=current funding (decimal), efr=estimated. Multiply × 100 for percentage.',
    probes: results
  });
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
      if (!c || d.price <= 0 || c.price <= 0) continue;

      const { longEx, shortEx, scenario, scenarioType, diff, net } = calcStrat(d.fundingRate, c.fundingRate);
      const avg  = (d.price + c.price) / 2;
      const spr  = avg > 0 ? +((Math.abs(d.price - c.price) / avg) * 100).toFixed(4) : 0;

      // Per-coin: time until next funding
      const fi  = d.fundingInterval || 8;                      // 1, 4, or 8
      const fiSec = fi * 3600;
      let secToFunding;
      if (d.nextFundingTs) {
        secToFunding = Math.max(0, Math.round((d.nextFundingTs - Date.now()) / 1000));
      } else {
        const nowSec = Math.floor(Date.now() / 1000);
        secToFunding = fiSec - (nowSec % fiSec);
      }
      const urg   = secToFunding <= 1800 ? 'urgent' : secToFunding <= 3600 ? 'soon' : 'normal';
      // Score: bigger diff + goldmine bonus + urgency boost
      const score = diff
        * (scenarioType === 'goldmine' ? 2.5 : 1)
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
        fundingDiff:    diff,
        netYield:       net,
        spread:         spr,
        volume:         +(Math.max(d.volume24h, c.volume24h)).toFixed(2),
        deltaChange24h: d.change24h,
        dcxChange24h:   c.change24h,
        longExchange:   longEx,
        shortExchange:  shortEx,
        scenario, scenarioType,
        urgency:        urg,
        fundingInterval: fi,       // 1 / 4 / 8
        secToFunding,              // seconds until next funding for THIS coin
        nextFundingTs:  d.nextFundingTs || null,
        score
      });
    }
    opps.sort((a, b) => b.score - a.score);
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
//  ORDER  — Futures endpoints (correct DCX API)
// ─────────────────────────────────────────────────────
app.all('/api/order', async (req, res) => {
  const { deltaProductId, dcxSymbol, longExchange, quantity, leverage, orderType, limitPriceDelta, limitPriceDcx } = req.body || {};
  if (!DELTA_KEY || !DCX_KEY) return res.status(400).json({ success:false, error:'API keys not set in Railway Variables.' });

  const dSide = longExchange === 'Delta' ? 'buy' : 'sell';
  const cSide = longExchange === 'CoinDCX' ? 'buy' : 'sell';

  // Delta body
  const dBody = {
    product_id: parseInt(deltaProductId),
    size:        parseFloat(quantity),
    side:        dSide,
    order_type:  orderType === 'limit' ? 'limit_order' : 'market_order',
    ...(leverage && { leverage: String(leverage) }),
    ...(orderType === 'limit' && limitPriceDelta && { limit_price: String(limitPriceDelta) })
  };

  // CoinDCX Futures order body — correct format per API docs
  const dcxOrder = {
    side:        cSide,
    pair:        dcxSymbol,                   // e.g. "B-KSM_USDT"
    order_type:  orderType === 'limit' ? 'limit_order' : 'market_order',
    total_quantity: parseFloat(quantity),
    leverage:    parseInt(leverage) || 5,
    margin_currency_short_name: 'USDT',
    notification: 'no_notification',
    time_in_force: 'good_till_cancel',
    ...(orderType === 'limit' && limitPriceDcx && { price: parseFloat(limitPriceDcx) })
  };

  const t0 = Date.now();
  const [dr, cr] = await Promise.allSettled([
    dAuth('POST', '/v2/orders', {}, dBody),
    cAuth('/exchange/v1/derivatives/futures/orders/create', { order: dcxOrder })
  ]);
  res.json({
    success:   true,
    latencyMs: Date.now() - t0,
    bothOk:    dr.status === 'fulfilled' && cr.status === 'fulfilled',
    delta: dr.status === 'fulfilled'
      ? { ok:true, orderId: dr.value?.result?.id || dr.value?.id }
      : { ok:false, error: errMsg(dr.reason) },
    dcx: cr.status === 'fulfilled'
      ? { ok:true, orderId: cr.value?.data?.id || cr.value?.orders?.[0]?.id || cr.value?.id }
      : { ok:false, error: errMsg(cr.reason) }
  });
});

// ─────────────────────────────────────────────────────
//  EXIT — Close both positions at market
// ─────────────────────────────────────────────────────
app.all('/api/exit', async (req, res) => {
  const { deltaProductId, dcxSymbol, longExchange, quantity } = req.body || {};
  const t0 = Date.now();

  const dcxExitOrder = {
    side:        longExchange === 'CoinDCX' ? 'sell' : 'buy',
    pair:        dcxSymbol,
    order_type:  'market_order',
    total_quantity: parseFloat(quantity),
    margin_currency_short_name: 'USDT',
    notification: 'no_notification',
    time_in_force: 'good_till_cancel'
  };

  const [dr, cr] = await Promise.allSettled([
    dAuth('POST', '/v2/orders', {}, {
      product_id: parseInt(deltaProductId),
      size:       parseFloat(quantity),
      side:       longExchange === 'Delta' ? 'sell' : 'buy',
      order_type: 'market_order',
      reduce_only: true
    }),
    cAuth('/exchange/v1/derivatives/futures/orders/create', { order: dcxExitOrder })
  ]);
  res.json({
    success:   true,
    latencyMs: Date.now() - t0,
    delta: dr.status === 'fulfilled' ? { ok:true } : { ok:false, error: errMsg(dr.reason) },
    dcx:   cr.status === 'fulfilled' ? { ok:true } : { ok:false, error: errMsg(cr.reason) }
  });
});

// ─────────────────────────────────────────────────────
//  POSITIONS / HISTORY / BALANCE
// ─────────────────────────────────────────────────────
app.all('/api/positions', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET', '/v2/positions', { page_size:'50' }),
    cAuth('/exchange/v1/derivatives/futures/positions', { margin_currency_short_name: ['USDT'], page:'1', size:'50' })
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: errMsg(dr.reason) },
    dcx:   cr.status === 'fulfilled' ? cr.value : { error: errMsg(cr.reason) }
  });
});

app.all('/api/history', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET', '/v2/orders', { state:'closed', page_size:'50' }),
    cAuth('/exchange/v1/derivatives/futures/orders', {
      status: 'filled,cancelled', margin_currency_short_name: ['USDT'], page:'1', size:'50'
    })
  ]);
  res.json({
    delta: dr.status === 'fulfilled' ? dr.value : { error: errMsg(dr.reason) },
    dcx:   cr.status === 'fulfilled' ? cr.value : { error: errMsg(cr.reason) }
  });
});

app.all('/api/balance', async (_req, res) => {
  const [dr, cr] = await Promise.allSettled([
    dAuth('GET', '/v2/wallet/balances'),
    cAuth('/exchange/v1/users/balances')   // spot+futures combined balance
  ]);
  let deltaUsd = 0, dcxUsd = 0;
  if (dr.status === 'fulfilled') {
    const bals = dr.value?.result || [];
    const u = Array.isArray(bals) ? bals.find(b => b.asset_symbol === 'USDT') : null;
    deltaUsd = parseFloat(u?.balance || 0);
  }
  if (cr.status === 'fulfilled') {
    const arr = Array.isArray(cr.value) ? cr.value : (cr.value?.balance || []);
    const u = arr.find?.(b => (b.currency || b.short_name || '').toUpperCase() === 'USDT');
    dcxUsd = parseFloat(u?.balance || u?.available_balance || 0);
  }
  res.json({
    deltaUsd:  +deltaUsd.toFixed(2),
    dcxUsd:    +dcxUsd.toFixed(2),
    totalUsd:  +(deltaUsd + dcxUsd).toFixed(2),
    deltaKeyOk: !!DELTA_KEY,
    dcxKeyOk:   !!DCX_KEY
  });
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
