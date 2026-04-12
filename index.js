const axios = require('axios');
const crypto = require('crypto');

function mkClient(base, proxy) {
  const cfg = { baseURL: base, timeout: 12000 };
  if (proxy) {
    try { const { HttpsProxyAgent } = require('https-proxy-agent'); cfg.httpsAgent = new HttpsProxyAgent(proxy); } catch(_) {}
  }
  return axios.create(cfg);
}

/* ─── COINDCX ─────────────────────────────────────────────── */
const DCX_BASE = 'https://api.coindcx.com';

function dcxSign(secret, body) {
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

async function dcxTestConn(key, sec, proxy) {
  try {
    const c = mkClient(DCX_BASE, proxy);
    const body = { timestamp: Date.now() };
    const r = await c.post('/exchange/v1/users/info', body, {
      headers: { 'X-AUTH-APIKEY': key, 'X-AUTH-SIGNATURE': dcxSign(sec, body), 'Content-Type': 'application/json' }
    });
    return { ok: true, data: r.data };
  } catch(e) { return { ok: false, error: e.response?.data || e.message }; }
}

async function dcxBalance(key, sec, proxy) {
  try {
    const c = mkClient(DCX_BASE, proxy);
    const body = { timestamp: Date.now() };
    const r = await c.post('/exchange/v1/users/balances', body, {
      headers: { 'X-AUTH-APIKEY': key, 'X-AUTH-SIGNATURE': dcxSign(sec, body), 'Content-Type': 'application/json' }
    });
    const usdt = (r.data||[]).find(b => b.currency === 'USDT' || b.currency === 'INR');
    return { ok: true, balance: usdt?.balance || 0, locked: usdt?.locked_balance || 0, currency: usdt?.currency || 'USDT' };
  } catch(e) { return { ok: false, error: e.response?.data || e.message, balance: 0 }; }
}

async function dcxTickers(proxy) {
  try {
    const c = mkClient(DCX_BASE, proxy);
    const r = await c.get('/exchange/ticker');
    return { ok: true, data: r.data || [] };
  } catch(e) { return { ok: false, data: [] }; }
}

async function dcxPlaceOrder(key, sec, { symbol, side, orderType, quantity, price }, proxy) {
  try {
    const c = mkClient(DCX_BASE, proxy);
    const body = { market: symbol, side: side.toLowerCase(), order_type: orderType.toLowerCase(), quantity, price_per_unit: orderType === 'limit' ? price : undefined, timestamp: Date.now() };
    const r = await c.post('/exchange/v1/orders/create', body, {
      headers: { 'X-AUTH-APIKEY': key, 'X-AUTH-SIGNATURE': dcxSign(sec, body), 'Content-Type': 'application/json' }
    });
    return { ok: true, order: r.data };
  } catch(e) { return { ok: false, error: e.response?.data || e.message }; }
}

async function dcxOpenOrders(key, sec, proxy) {
  try {
    const c = mkClient(DCX_BASE, proxy);
    const body = { timestamp: Date.now() };
    const r = await c.post('/exchange/v1/orders/active_orders', body, {
      headers: { 'X-AUTH-APIKEY': key, 'X-AUTH-SIGNATURE': dcxSign(sec, body), 'Content-Type': 'application/json' }
    });
    return { ok: true, orders: r.data || [] };
  } catch(e) { return { ok: false, orders: [] }; }
}

async function dcxHistory(key, sec, proxy) {
  try {
    const c = mkClient(DCX_BASE, proxy);
    const body = { timestamp: Date.now(), limit: 50 };
    const r = await c.post('/exchange/v1/orders/trade_history', body, {
      headers: { 'X-AUTH-APIKEY': key, 'X-AUTH-SIGNATURE': dcxSign(sec, body), 'Content-Type': 'application/json' }
    });
    return { ok: true, trades: r.data || [] };
  } catch(e) { return { ok: false, trades: [] }; }
}

/* ─── DELTA EXCHANGE ──────────────────────────────────────── */
const DELTA_BASE = 'https://api.delta.exchange';

function deltaSign(sec, method, path, qs, body, ts) {
  return crypto.createHmac('sha256', sec).update(method + ts + path + qs + body).digest('hex');
}

function deltaHeaders(key, sec, method, path, qs = '', body = '') {
  const ts = Math.floor(Date.now() / 1000).toString();
  return { 'api-key': key, 'signature': deltaSign(sec, method, path, qs, body, ts), 'timestamp': ts, 'Content-Type': 'application/json' };
}

async function deltaTestConn(key, sec, proxy) {
  try {
    const c = mkClient(DELTA_BASE, proxy);
    const r = await c.get('/v2/profile', { headers: deltaHeaders(key, sec, 'GET', '/v2/profile') });
    return { ok: true, data: r.data };
  } catch(e) { return { ok: false, error: e.response?.data || e.message }; }
}

async function deltaBalance(key, sec, proxy) {
  try {
    const c = mkClient(DELTA_BASE, proxy);
    const r = await c.get('/v2/wallet/balances', { headers: deltaHeaders(key, sec, 'GET', '/v2/wallet/balances') });
    const b = (r.data?.result || []).find(x => x.asset_symbol === 'USDT' || x.asset_symbol === 'USD');
    return { ok: true, balance: b?.available_balance || 0, equity: b?.portfolio_margin || 0, currency: 'USDT' };
  } catch(e) { return { ok: false, error: e.response?.data || e.message, balance: 0 }; }
}

async function deltaTickers(proxy) {
  try {
    const c = mkClient(DELTA_BASE, proxy);
    const r = await c.get('/v2/tickers?contract_types=perpetual_futures');
    return { ok: true, data: r.data?.result || [] };
  } catch(e) { return { ok: false, data: [] }; }
}

async function deltaPlaceOrder(key, sec, { productId, side, orderType, size, limitPrice }, proxy) {
  try {
    const c = mkClient(DELTA_BASE, proxy);
    const bodyObj = { product_id: productId, side: side.toLowerCase(), order_type: orderType === 'market' ? 'market_order' : 'limit_order', size, limit_price: orderType === 'limit' ? String(limitPrice) : undefined };
    const bodyStr = JSON.stringify(bodyObj);
    const r = await c.post('/v2/orders', bodyObj, { headers: deltaHeaders(key, sec, 'POST', '/v2/orders', '', bodyStr) });
    return { ok: true, order: r.data?.result };
  } catch(e) { return { ok: false, error: e.response?.data || e.message }; }
}

async function deltaPositions(key, sec, proxy) {
  try {
    const c = mkClient(DELTA_BASE, proxy);
    const r = await c.get('/v2/positions/margined', { headers: deltaHeaders(key, sec, 'GET', '/v2/positions/margined') });
    return { ok: true, positions: r.data?.result || [] };
  } catch(e) { return { ok: false, positions: [] }; }
}

async function deltaOpenOrders(key, sec, proxy) {
  try {
    const c = mkClient(DELTA_BASE, proxy);
    const path = '/v2/orders?state=open&contract_types=perpetual_futures';
    const r = await c.get(path, { headers: deltaHeaders(key, sec, 'GET', path) });
    return { ok: true, orders: r.data?.result || [] };
  } catch(e) { return { ok: false, orders: [] }; }
}

async function deltaHistory(key, sec, proxy) {
  try {
    const c = mkClient(DELTA_BASE, proxy);
    const path = '/v2/orders/history?page_size=50&contract_types=perpetual_futures';
    const r = await c.get(path, { headers: deltaHeaders(key, sec, 'GET', path) });
    return { ok: true, trades: r.data?.result || [] };
  } catch(e) { return { ok: false, trades: [] }; }
}

/* ─── ARBITRAGE LOGIC ─────────────────────────────────────── */
function arbSignal(rA, rB, minDiff = 0.01) {
  const diff = Math.abs(rA - rB);
  if (diff < minDiff) return { signal: 'NONE', diff, netProfit: diff };

  let buyEx, sellEx, reason;

  if (rA <= 0 && rB <= 0) {
    if (rA < rB) { buyEx = 'COINDCX'; sellEx = 'DELTA'; }
    else { buyEx = 'DELTA'; sellEx = 'COINDCX'; }
    reason = `Both negative. Long ${buyEx} receives more funding.`;
  } else if (rA >= 0 && rB >= 0) {
    if (rA > rB) { buyEx = 'DELTA'; sellEx = 'COINDCX'; }
    else { buyEx = 'COINDCX'; sellEx = 'DELTA'; }
    reason = `Both positive. Short ${sellEx} receives more funding.`;
  } else if (rA < 0 && rB > 0) {
    buyEx = 'COINDCX'; sellEx = 'DELTA';
    reason = 'Opposite signs! Both sides receive funding simultaneously.';
  } else {
    buyEx = 'DELTA'; sellEx = 'COINDCX';
    reason = 'Opposite signs! Both sides receive funding simultaneously.';
  }

  const isOpposite = (rA < 0 && rB > 0) || (rA > 0 && rB < 0);
  const netProfit = isOpposite ? (Math.abs(rA) + Math.abs(rB)) : diff;
  const strength = netProfit >= 0.08 ? 'STRONG' : netProfit >= 0.04 ? 'MODERATE' : 'WEAK';

  return { signal: 'TRADE', strength, buyEx, sellEx, reason, diff: +diff.toFixed(6), netProfit: +netProfit.toFixed(6), rA, rB };
}

function nextFunding() {
  const now = new Date();
  const utcH = now.getUTCHours(), utcM = now.getUTCMinutes(), utcS = now.getUTCSeconds();
  const nextH = [0,8,16].find(h => h > utcH) ?? 24;
  const secsLeft = (nextH * 3600) - (utcH * 3600 + utcM * 60 + utcS);
  const h = String(Math.floor(secsLeft / 3600)).padStart(2,'0');
  const m = String(Math.floor((secsLeft % 3600) / 60)).padStart(2,'0');
  const s = String(secsLeft % 60).padStart(2,'0');
  return { countdown: `${h}:${m}:${s}`, msLeft: secsLeft * 1000 };
}

module.exports = {
  dcxTestConn, dcxBalance, dcxTickers, dcxPlaceOrder, dcxOpenOrders, dcxHistory,
  deltaTestConn, deltaBalance, deltaTickers, deltaPlaceOrder, deltaPositions, deltaOpenOrders, deltaHistory,
  arbSignal, nextFunding
};
