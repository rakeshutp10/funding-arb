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

// API KEYS from Railway environment variables
const DELTA_KEY    = process.env.DELTA_KEY    || '';
const DELTA_SECRET = process.env.DELTA_SECRET || '';
const DCX_KEY      = process.env.DCX_KEY      || '';
const DCX_SECRET   = process.env.DCX_SECRET   || '';

function errMsg(e) {
  if (!e) return 'Unknown error';
  if (e.response?.data) return JSON.stringify(e.response.data);
  return e.message || String(e);
}

// DELTA EXCHANGE INDIA
const DELTA = 'https://api.india.delta.exchange';

async function dPub(ep, params = {}) {
  const qs = Object.keys(params).length ? '?' + new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA + ep + qs, { timeout: 12000 });
  return r.data;
}

function parseDelta(raw) {
  const list = raw?.result || raw?.data?.result || raw?.data || [];
  const map  = {};
  for (const t of (Array.isArray(list) ? list : [])) {
    const base = (t.underlying_asset_symbol || '').toUpperCase();
    if (!base) continue;
    const price = parseFloat(t.mark_price || t.last_price || 0);
    const fr = parseFloat(t.funding_rate || 0);
    map[base] = {
      symbol: t.symbol, productId: t.id,
      price, fundingRate: +(fr * 100).toFixed(6)
    };
  }
  return map;
}

// COINDCX - UPDATED LOGIC
const DCX = 'https://api.coindcx.com';

async function fetchDCX() {
  const result = { map: {}, ok: false, source: 'none', errors: [] };
  const targetEp = '/exchange/v1/futures/funding_rate'; 

  try {
    const r = await axios.get(DCX + targetEp, { timeout: 10000 });
    const list = Array.isArray(r.data) ? r.data : (r.data?.data || []);

    if (list.length > 0) {
      result.source = targetEp;
      for (const c of list) {
        const sym = (c.symbol || '').toUpperCase();
        if (!sym) continue;

        let base = sym.split('USDT')[0].replace('B-', '');
        const price = parseFloat(c.mark_price || c.last_price || 0);
        if (price <= 0) continue;

        let fr = parseFloat(c.funding_rate || 0);
        if (fr !== 0 && Math.abs(fr) < 0.001) fr = fr * 100;

        result.map[base] = {
          symbol: sym,
          price,
          fundingRate: +fr.toFixed(6)
        };
      }
      result.ok = Object.keys(result.map).length > 0;
    }
  } catch (e) {
    result.errors.push(errMsg(e));
  }
  return result;
}

// API SCAN
app.post('/api/scan', async (req, res) => {
  try {
    const [dR, cR] = await Promise.allSettled([
      dPub('/v2/tickers', { contract_types: 'perpetual_futures' }),
      fetchDCX()
    ]);

    const deltaMap = dR.status === 'fulfilled' ? parseDelta(dR.value) : {};
    const dcxMap   = cR.status === 'fulfilled' ? cR.value.map : {};
    
    const opps = [];
    for (const [base, d] of Object.entries(deltaMap)) {
      const c = dcxMap[base];
      if (!c) continue;

      const diff = Math.abs(d.fundingRate - c.fundingRate);
      opps.push({
        base,
        deltaPrice: d.price,
        dcxPrice: c.price,
        deltaFunding: d.fundingRate,
        dcxFunding: c.fundingRate,
        fundingDiff: +diff.toFixed(6),
        netYield: +(diff - 0.10).toFixed(6)
      });
    }
    opps.sort((a, b) => b.fundingDiff - a.fundingDiff);
    res.json({ success: true, data: opps, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ success: false, error: errMsg(e) });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', deltaKey: !!DELTA_KEY, dcxKey: !!DCX_KEY });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, '0.0.0.0', () => console.log(`Server Fixed | Port ${PORT}`));
