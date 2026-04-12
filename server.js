require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const svc = require('./services/index');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── In-memory config ────────────────────────────────────────
const cfg = {
  dcxKey:    process.env.DCX_API_KEY    || '',
  dcxSec:    process.env.DCX_SECRET_KEY || '',
  deltaKey:  process.env.DELTA_API_KEY  || '',
  deltaSec:  process.env.DELTA_SECRET_KEY || '',
  proxy:     process.env.PROXY_URL      || '',
  minDiff:   parseFloat(process.env.MIN_DIFF || '0.01'),
  leverage:  parseInt(process.env.DEFAULT_LEVERAGE || '3'),
  dcxConn:   false,
  deltaConn: false
};
let localTrades = [];

// ── Config ──────────────────────────────────────────────────
app.get('/api/config', (_req, res) => res.json({
  dcxKey: cfg.dcxKey ? '***' : '', deltaKey: cfg.deltaKey ? '***' : '',
  proxy: cfg.proxy ? '***' : '', minDiff: cfg.minDiff, leverage: cfg.leverage,
  dcxConn: cfg.dcxConn, deltaConn: cfg.deltaConn
}));

app.post('/api/config', (req, res) => {
  const { exchange, apiKey, secretKey, proxy, minDiff, leverage } = req.body;
  if (exchange === 'coindcx')       { cfg.dcxKey = apiKey; cfg.dcxSec = secretKey; cfg.dcxConn = false; }
  else if (exchange === 'delta')    { cfg.deltaKey = apiKey; cfg.deltaSec = secretKey; cfg.deltaConn = false; }
  if (proxy !== undefined)           cfg.proxy = proxy;
  if (minDiff !== undefined)         cfg.minDiff = parseFloat(minDiff);
  if (leverage !== undefined)        cfg.leverage = parseInt(leverage);
  res.json({ ok: true });
});

// ── Debug ────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => res.json({
  dcx:   { conn: cfg.dcxConn,   hasKey: !!cfg.dcxKey },
  delta: { conn: cfg.deltaConn, hasKey: !!cfg.deltaKey },
  proxy: { configured: !!cfg.proxy },
  time:  new Date().toISOString(),
  env:   process.env.NODE_ENV || 'development'
}));

app.post('/api/connect', async (req, res) => {
  const { exchange } = req.body;
  const out = {};
  if (exchange === 'coindcx' || exchange === 'all') {
    out.coindcx = await svc.dcxTestConn(cfg.dcxKey, cfg.dcxSec, cfg.proxy);
    cfg.dcxConn = out.coindcx.ok;
  }
  if (exchange === 'delta' || exchange === 'all') {
    out.delta = await svc.deltaTestConn(cfg.deltaKey, cfg.deltaSec, cfg.proxy);
    cfg.deltaConn = out.delta.ok;
  }
  res.json({ ok: true, results: out });
});

// ── Balances ─────────────────────────────────────────────────
app.get('/api/balances', async (_req, res) => {
  const [dcx, delta] = await Promise.all([
    cfg.dcxKey   ? svc.dcxBalance(cfg.dcxKey, cfg.dcxSec, cfg.proxy)     : { ok: false, balance: 0, error: 'No key' },
    cfg.deltaKey ? svc.deltaBalance(cfg.deltaKey, cfg.deltaSec, cfg.proxy) : { ok: false, balance: 0, error: 'No key' }
  ]);
  res.json({ dcx, delta });
});

// ── Scanner ──────────────────────────────────────────────────
app.get('/api/scanner', async (_req, res) => {
  const [dt, dcxt] = await Promise.all([
    svc.deltaTickers(cfg.proxy),
    svc.dcxTickers(cfg.proxy)
  ]);
  const delta = dt.data || [];
  const dcx   = dcxt.data || [];

  const coins = delta.map(d => {
    if (!d.symbol) return null;
    const sym = d.symbol.replace('PERP','').replace('USD','').replace('USDT','').replace(/-/g,'');
    const dx  = dcx.find(x => (x.market||x.symbol||'').toUpperCase().includes(sym.toUpperCase()));
    const dFr = parseFloat(d.funding_rate || 0) * 100;
    const cFr = parseFloat(dx?.funding_rate || 0) * 100;
    const sig = svc.arbSignal(cFr, dFr, cfg.minDiff);
    return {
      symbol: sym,
      deltaSymbol: d.symbol,
      dcxSymbol: dx?.market || null,
      deltaProductId: d.product_id,
      deltaPrice: parseFloat(d.mark_price || d.close || 0),
      dcxPrice: parseFloat(dx?.last_price || 0),
      deltaChange24h: parseFloat(d.price_change_percent_24h || 0),
      dcxChange24h: parseFloat(dx?.change_24_hour || 0),
      deltaVolume: parseFloat(d.volume || 0),
      deltaFR: dFr,
      dcxFR: cFr,
      diff: Math.abs(dFr - cFr),
      ...sig
    };
  }).filter(Boolean).sort((a,b) => b.diff - a.diff);

  res.json({ ok: true, coins, nextFunding: svc.nextFunding(), total: coins.length, ts: new Date().toISOString() });
});

// ── Opportunities ─────────────────────────────────────────────
app.get('/api/opportunities', async (_req, res) => {
  const dt = await svc.deltaTickers(cfg.proxy);
  const opps = (dt.data||[])
    .filter(d => d.symbol && Math.abs(parseFloat(d.funding_rate||0)*100) >= 0.04)
    .map(d => {
      const sym = d.symbol.replace('PERP','').replace('USD','').replace('USDT','').replace(/-/g,'');
      const fr  = parseFloat(d.funding_rate||0)*100;
      return { symbol: sym, deltaSymbol: d.symbol, deltaProductId: d.product_id,
        price: parseFloat(d.mark_price||0), volume: parseFloat(d.volume||0),
        deltaFR: fr, absRate: Math.abs(fr),
        strength: Math.abs(fr) >= 0.08 ? 'STRONG' : 'MODERATE' };
    })
    .sort((a,b) => b.absRate - a.absRate).slice(0,20);
  res.json({ ok: true, opportunities: opps, nextFunding: svc.nextFunding() });
});

// ── Orders ────────────────────────────────────────────────────
app.post('/api/orders/place', async (req, res) => {
  const { symbol, deltaProductId, dcxSymbol, side, orderType, quantity, price, leverage, mode } = req.body;
  const out = {};
  if (mode === 'arb' || mode === 'coindcx') {
    out.coindcx = cfg.dcxKey
      ? await svc.dcxPlaceOrder(cfg.dcxKey, cfg.dcxSec, { symbol: dcxSymbol, side, orderType, quantity, price }, cfg.proxy)
      : { ok: false, error: 'No DCX key' };
  }
  if (mode === 'arb' || mode === 'delta') {
    const dSide = mode === 'arb' ? (side === 'buy' ? 'sell' : 'buy') : side;
    out.delta = cfg.deltaKey
      ? await svc.deltaPlaceOrder(cfg.deltaKey, cfg.deltaSec, { productId: deltaProductId, side: dSide, orderType, size: quantity, limitPrice: price }, cfg.proxy)
      : { ok: false, error: 'No Delta key' };
  }
  const entry = { id: Date.now(), ts: new Date().toISOString(), symbol, mode, side, orderType, quantity, leverage, dcx: out.coindcx, delta: out.delta, status: 'TRADE' };
  localTrades.unshift(entry);
  if (localTrades.length > 200) localTrades = localTrades.slice(0,200);
  res.json({ ok: true, results: out, trade: entry });
});

app.post('/api/orders/exit', async (req, res) => {
  const { symbol, deltaProductId, dcxSymbol, quantity, orderType, price } = req.body;
  const out = {};
  if (cfg.dcxKey)   out.coindcx = await svc.dcxPlaceOrder(cfg.dcxKey, cfg.dcxSec, { symbol: dcxSymbol, side: 'sell', orderType: orderType||'market', quantity, price }, cfg.proxy);
  if (cfg.deltaKey) out.delta   = await svc.deltaPlaceOrder(cfg.deltaKey, cfg.deltaSec, { productId: deltaProductId, side: 'buy', orderType: orderType||'market', size: quantity, limitPrice: price }, cfg.proxy);
  const entry = { id: Date.now(), ts: new Date().toISOString(), symbol, mode: 'exit', orderType, quantity, dcx: out.coindcx, delta: out.delta, status: 'EXIT' };
  localTrades.unshift(entry);
  res.json({ ok: true, results: out, trade: entry });
});

app.get('/api/orders/open', async (_req, res) => {
  const [dcx, delta, pos] = await Promise.all([
    cfg.dcxKey   ? svc.dcxOpenOrders(cfg.dcxKey, cfg.dcxSec, cfg.proxy)          : { ok: false, orders: [] },
    cfg.deltaKey ? svc.deltaOpenOrders(cfg.deltaKey, cfg.deltaSec, cfg.proxy)      : { ok: false, orders: [] },
    cfg.deltaKey ? svc.deltaPositions(cfg.deltaKey, cfg.deltaSec, cfg.proxy)       : { ok: false, positions: [] }
  ]);
  res.json({ dcx, delta, positions: pos });
});

app.get('/api/orders/history', async (_req, res) => {
  const [dcx, delta] = await Promise.all([
    cfg.dcxKey   ? svc.dcxHistory(cfg.dcxKey, cfg.dcxSec, cfg.proxy)     : { ok: false, trades: [] },
    cfg.deltaKey ? svc.deltaHistory(cfg.deltaKey, cfg.deltaSec, cfg.proxy) : { ok: false, trades: [] }
  ]);
  res.json({ dcx, delta, local: localTrades });
});

// ── Serve frontend ─────────────────────────────────────────
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`DeltaDCX running on :${PORT}`));
