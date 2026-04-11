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
//  USD/INR CACHE
// ═══════════════════════════════════════════════════
let INR_RATE = 84.0, rateAt = 0;
async function getRate() {
  if (Date.now() - rateAt < 10*60*1000) return INR_RATE;
  try {
    const r = await axios.get('https://open.er-api.com/v6/latest/USD',{timeout:5000});
    if (r.data?.rates?.INR) { INR_RATE = r.data.rates.INR; rateAt = Date.now(); }
  } catch(_){}
  return INR_RATE;
}

// ═══════════════════════════════════════════════════
//  DELTA EXCHANGE INDIA
// ═══════════════════════════════════════════════════
const DELTA = 'https://api.india.delta.exchange';

function dSign(secret, method, ep, qs, body, ts) {
  return crypto.createHmac('sha256', secret)
    .update(method + ts + ep + qs + body).digest('hex');
}

async function deltaGet(ep, params={}) {
  const qs = Object.keys(params).length ? '?'+new URLSearchParams(params) : '';
  const r  = await axios.get(DELTA+ep+qs, {
    timeout:12000,
    headers:{ 'User-Agent':'Mozilla/5.0','Accept':'application/json' }
  });
  return r.data;
}

async function deltaAuth(key, secret, method, ep, query={}, body=null) {
  const ts  = Math.floor(Date.now()/1000).toString();
  const qs  = Object.keys(query).length ? '?'+new URLSearchParams(query) : '';
  const bs  = body ? JSON.stringify(body) : '';
  const sig = dSign(secret, method, ep, qs, bs, ts);
  const cfg = {
    method, url: DELTA+ep+qs, timeout:12000,
    headers:{ 'api-key':key, 'timestamp':ts, 'signature':sig,
              'Content-Type':'application/json', 'User-Agent':'Mozilla/5.0' }
  };
  if (body) cfg.data = body;
  const r = await axios(cfg);
  return r.data;
}

// ═══════════════════════════════════════════════════
//  PI42 — MULTI-STRATEGY
//  Pi42 blocks non-Indian IPs on some endpoints.
//  We try: authenticated endpoints, then public ones.
//  Best fix = Railway India/Singapore region.
// ═══════════════════════════════════════════════════
const PI42 = 'https://fapi.pi42.com';
const PI42B = 'https://api.pi42.com';

function p42Sign(secret, params) {
  const qs = Object.keys(params).sort().map(k=>`${k}=${params[k]}`).join('&');
  return crypto.createHmac('sha256',secret).update(qs).digest('hex');
}

function p42Headers(key) {
  return {
    'User-Agent':'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept':'application/json, text/plain, */*',
    'Accept-Language':'en-IN,en;q=0.9,hi;q=0.8',
    'Accept-Encoding':'gzip, deflate, br',
    'Origin':'https://pi42.com',
    'Referer':'https://pi42.com/',
    'sec-ch-ua':'"Chromium";v="120"',
    'sec-ch-ua-mobile':'?1',
    'sec-ch-ua-platform':'"Android"',
    ...(key ? {'api-key': key} : {})
  };
}

async function pi42Market(key, secret) {
  const h = p42Headers(key);

  // ── Strategy A: Authenticated signed requests ──────
  if (key && secret) {
    const endpoints_auth = [
      '/v1/market/tickers',
      '/v1/ticker/24hr',
      '/v1/exchange/futures/contracts',
      '/v1/exchangeInfo',
    ];
    for (const ep of endpoints_auth) {
      try {
        const ts  = Date.now().toString();
        const sig = p42Sign(secret, { timestamp: ts });
        const r   = await axios.get(PI42+ep, {
          params:{ timestamp:ts, signature:sig },
          headers:h, timeout:10000
        });
        if (r.data) {
          const parsed = tryParsePi42(r.data);
          if (Object.keys(parsed).length > 0)
            return { map: parsed, ok:true, endpoint: PI42+ep+' (auth)' };
        }
      } catch(_){}
    }
    // alt base
    for (const ep of ['/v1/market/tickers','/v1/ticker/24hr']) {
      try {
        const ts  = Date.now().toString();
        const sig = p42Sign(secret, { timestamp: ts });
        const r   = await axios.get(PI42B+ep, {
          params:{ timestamp:ts, signature:sig },
          headers:h, timeout:10000
        });
        if (r.data) {
          const parsed = tryParsePi42(r.data);
          if (Object.keys(parsed).length > 0)
            return { map: parsed, ok:true, endpoint: PI42B+ep+' (auth)' };
        }
      } catch(_){}
    }
  }

  // ── Strategy B: Public with browser headers ────────
  const endpoints_pub = [
    [PI42,  '/v1/market/tickers'],
    [PI42,  '/v1/ticker/24hr'],
    [PI42,  '/v1/exchangeInfo'],
    [PI42,  '/v1/exchange/futures/contracts'],
    [PI42B, '/v1/market/tickers'],
    [PI42B, '/v1/ticker/24hr'],
    [PI42B, '/v1/exchange/futures/contracts'],
  ];
  for (const [base, ep] of endpoints_pub) {
    try {
      const r = await axios.get(base+ep, { headers:h, timeout:8000 });
      if (r.data) {
        const parsed = tryParsePi42(r.data);
        if (Object.keys(parsed).length > 0)
          return { map: parsed, ok:true, endpoint: base+ep+' (public)' };
      }
    } catch(_){}
  }

  return { map:{}, ok:false, endpoint:'none — all failed' };
}

// ═══════════════════════════════════════════════════
//  PARSE HELPERS
// ═══════════════════════════════════════════════════
function parseDelta(raw) {
  const list = raw?.result || raw?.data?.result || raw?.data || [];
  const map  = {};
  for (const t of (Array.isArray(list)?list:[])) {
    const base = (t.underlying_asset_symbol||'').toUpperCase();
    if (!base) continue;
    map[base] = {
      symbol:      t.symbol||'',
      productId:   t.id||t.product_id,
      price:       parseFloat(t.mark_price||t.last_price||t.close||0),
      fundingRate: parseFloat(t.funding_rate||0) * 100,
      volume24h:   parseFloat(t.volume||t.turnover_usd||0),
      change24h:   parseFloat(t.price_change_percent||0),
      nextFunding: t.next_funding_realization||null
    };
  }
  return map;
}

function tryParsePi42(raw) {
  // Try to flatten whatever structure Pi42 returns into an array
  let list = [];
  if (Array.isArray(raw))               list = raw;
  else if (Array.isArray(raw?.data))    list = raw.data;
  else if (Array.isArray(raw?.result))  list = raw.result;
  else if (Array.isArray(raw?.tickers)) list = raw.tickers;
  else if (raw?.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) {
    list = Object.values(raw.data);
  } else if (typeof raw === 'object') {
    const vals = Object.values(raw);
    if (vals.length && typeof vals[0] === 'object') list = vals;
  }
  // If still empty, return empty — caller will try next endpoint
  return list.length ? list : {};
}

function pi42ListToMap(list, inrRate) {
  const map = {};
  if (!Array.isArray(list)) return map;
  for (const t of list) {
    const sym  = (t.symbol||t.contractName||t.pair||t.s||'').toUpperCase();
    let base   = (t.baseAsset||t.baseCurrency||t.baseSymbol||'').toUpperCase().replace(/INR|USDT?/g,'');
    if (!base && sym) base = sym.replace(/INR$|USDT?$/,'');
    if (!base) continue;

    const priceInr = parseFloat(
      t.lastPrice||t.last_price||t.markPrice||t.mark_price||t.price||t.close||t.c||0
    );
    let fr = parseFloat(
      t.lastFundingRate||t.last_funding_rate||t.fundingRate||t.funding_rate||t.fr||0
    );
    if (fr !== 0 && Math.abs(fr) < 0.001) fr *= 100;

    map[base] = {
      symbol:      sym||base+'INR',
      priceInr,
      price:       inrRate>0 ? priceInr/inrRate : 0,
      fundingRate: fr,
      volume24h:   parseFloat(t.volume24h||t.baseVolume||t.volume||t.v||0) / (inrRate||1),
      change24h:   parseFloat(t.priceChangePercent||t.change24h||t.P||0),
      nextFunding: t.nextFundingTime||null
    };
  }
  return map;
}

// ═══════════════════════════════════════════════════
//  HEALTH
// ═══════════════════════════════════════════════════
app.get('/health', (_req,res) =>
  res.json({ status:'ok', version:'4.2.0', ts:Date.now(), inrRate:INR_RATE }));

// ═══════════════════════════════════════════════════
//  DEBUG
// ═══════════════════════════════════════════════════
app.get('/debug/delta', async(_req,res) => {
  try {
    const d    = await deltaGet('/v2/tickers',{ contract_types:'perpetual_futures' });
    const list = d?.result||d?.data||[];
    res.json({
      ok: true, totalCount: list.length,
      sample: list.slice(0,3).map(t=>({
        base:t.underlying_asset_symbol, symbol:t.symbol,
        price:t.mark_price, funding:t.funding_rate
      }))
    });
  } catch(e) { res.json({ok:false, error:e.message, status:e.response?.status}); }
});

app.post('/debug/pi42', async(req,res) => {
  const { pi42Key:key, pi42Secret:secret } = req.body;
  const inrRate = await getRate();
  const result  = await pi42Market(key, secret);

  if (!result.ok) {
    res.json({
      ok: false,
      endpoint: result.endpoint,
      error: 'Pi42 API blocked. Railway US IP is rejected by Pi42 (India-only exchange).',
      fix: 'IMPORTANT: In Railway dashboard, go to your service Settings > Region > Change to ap-southeast-1 (Singapore) or ap-south-1 (Mumbai). Then redeploy. Singapore/Mumbai IPs are NOT blocked by Pi42.',
      hasKeys: !!(key && secret)
    });
    return;
  }

  const rawList = result.map;
  const map     = Array.isArray(rawList)
    ? pi42ListToMap(rawList, inrRate)
    : rawList; // already parsed

  res.json({
    ok: true, endpoint: result.endpoint,
    coinsFound: Object.keys(map).length,
    sample: Object.entries(map).slice(0,5).map(([b,v])=>({
      base:b, symbol:v.symbol, priceUsd:v.price?.toFixed(4),
      priceInr:v.priceInr, fundingRate:v.fundingRate
    }))
  });
});

// ═══════════════════════════════════════════════════
//  SCAN
// ═══════════════════════════════════════════════════
app.post('/api/scan', async(req,res) => {
  try {
    const { pi42Key:key, pi42Secret:secret } = req.body;
    const inrRate = await getRate();
    const TAKER   = 0.0005;

    const [dRaw, pResult] = await Promise.allSettled([
      deltaGet('/v2/tickers',{ contract_types:'perpetual_futures' }),
      pi42Market(key, secret)
    ]);

    // Delta
    let deltaMap = {}, deltaOk = false;
    if (dRaw.status==='fulfilled' && dRaw.value) {
      deltaMap = parseDelta(dRaw.value);
      deltaOk  = Object.keys(deltaMap).length > 0;
    }

    // Pi42
    let pi42Map = {}, pi42Ok = false, pi42Ep = 'none';
    if (pResult.status==='fulfilled' && pResult.value?.ok) {
      const rawList = pResult.value.map;
      pi42Map = Array.isArray(rawList)
        ? pi42ListToMap(rawList, inrRate)
        : rawList;
      pi42Ok  = Object.keys(pi42Map).length > 0;
      pi42Ep  = pResult.value.endpoint;
    }

    // Match
    const FEES = TAKER*2*100;
    const opps = [];
    for (const [base, d] of Object.entries(deltaMap)) {
      const p = pi42Map[base];
      if (!p || d.price<=0 || p.price<=0) continue;

      const dR   = d.fundingRate, pR = p.fundingRate;
      const diff = Math.abs(dR-pR);
      const avg  = (d.price+p.price)/2;
      const spr  = avg>0 ? Math.abs(d.price-p.price)/avg*100 : 0;
      const net  = diff-FEES;

      let longEx,shortEx,scenario,scenarioType;
      if (dR>=0 && pR>=0) {
        scenarioType='positive'; scenario='Both Positive';
        dR>=pR ? (shortEx='Delta',longEx='Pi42') : (shortEx='Pi42',longEx='Delta');
      } else if (dR<=0 && pR<=0) {
        scenarioType='negative'; scenario='Both Negative';
        dR>pR  ? (shortEx='Delta',longEx='Pi42') : (shortEx='Pi42',longEx='Delta');
      } else {
        scenarioType='goldmine'; scenario='GOLDMINE';
        dR>0   ? (shortEx='Delta',longEx='Pi42') : (shortEx='Pi42',longEx='Delta');
      }

      const now  = new Date();
      const sec  = now.getUTCHours()*3600+now.getUTCMinutes()*60+now.getUTCSeconds();
      const rem  = 8*3600-(sec%(8*3600));
      const urg  = rem<=1800?'urgent':rem<=3600?'soon':'normal';
      const score= diff*(scenarioType==='goldmine'?2.5:1)*(urg==='urgent'?2:urg==='soon'?1.5:1);

      opps.push({
        base,
        deltaSymbol:d.symbol, pi42Symbol:p.symbol,
        deltaProductId:d.productId,
        deltaPrice:d.price, pi42Price:p.price, pi42PriceInr:p.priceInr,
        deltaFunding:+dR.toFixed(6), pi42Funding:+pR.toFixed(6),
        fundingDiff:+diff.toFixed(6), netYield:+net.toFixed(6),
        spread:+spr.toFixed(4), feesDeducted:+FEES.toFixed(4),
        volume:Math.max(d.volume24h,p.volume24h),
        deltaChange24h:d.change24h, pi42Change24h:p.change24h,
        longExchange:longEx, shortExchange:shortEx,
        scenario, scenarioType, urgency:urg, score
      });
    }
    opps.sort((a,b)=>b.score-a.score);

    res.json({
      success:true, data:opps, count:opps.length,
      deltaCount:Object.keys(deltaMap).length,
      pi42Count:Object.keys(pi42Map).length,
      matchedCount:opps.length,
      deltaOk, pi42Ok, pi42Endpoint:pi42Ep,
      inrRate, ts:Date.now(),
      pi42Blocked: !pi42Ok
    });
  } catch(err) {
    console.error('[SCAN]',err.message);
    res.status(500).json({success:false, error:err.message});
  }
});

// ═══════════════════════════════════════════════════
//  ORDER
// ═══════════════════════════════════════════════════
app.post('/api/order', async(req,res) => {
  const { deltaKey,deltaSecret,pi42Key,pi42Secret,
    deltaSymbol,pi42Symbol,deltaProductId,longExchange,
    quantity,leverage,orderType,limitPriceDelta,limitPricePi42 } = req.body;

  if (!deltaKey||!pi42Key)
    return res.status(400).json({success:false,error:'API keys required in Settings.'});

  const dSide = longExchange==='Delta'?'buy':'sell';
  const pSide = longExchange==='Pi42' ?'BUY':'SELL';

  const dBody = {
    product_id:parseInt(deltaProductId), size:parseInt(quantity),
    side:dSide, order_type:orderType==='limit'?'limit_order':'market_order',
    ...(orderType==='limit'&&limitPriceDelta&&{limit_price:String(limitPriceDelta)})
  };
  if (leverage) dBody.leverage = String(leverage);

  const pBody = {
    symbol:pi42Symbol, side:pSide,
    type:orderType==='limit'?'LIMIT':'MARKET',
    quantity:String(quantity), leverage:leverage?String(leverage):'1',
    ...(orderType==='limit'&&limitPricePi42&&{price:String(limitPricePi42)})
  };

  const t0 = Date.now();
  const [dr,pr] = await Promise.allSettled([
    deltaAuth(deltaKey,deltaSecret,'POST','/v2/orders',{},dBody),
    (async()=>{
      const ts  = Date.now().toString();
      const all = {...pBody, timestamp:ts};
      const sig = p42Sign(pi42Secret, all);
      const r   = await axios.post(PI42+'/v1/order',{...all,signature:sig},{
        headers:p42Headers(pi42Key), timeout:12000
      });
      return r.data;
    })()
  ]);

  res.json({
    success:true, latencyMs:Date.now()-t0,
    bothOk:dr.status==='fulfilled'&&pr.status==='fulfilled',
    delta:dr.status==='fulfilled'
      ?{ok:true,data:dr.value,orderId:dr.value?.result?.id||dr.value?.id}
      :{ok:false,error:dr.reason?.response?.data||dr.reason?.message},
    pi42:pr.status==='fulfilled'
      ?{ok:true,data:pr.value,orderId:pr.value?.data?.orderId||pr.value?.orderId}
      :{ok:false,error:pr.reason?.response?.data||pr.reason?.message}
  });
});

// ═══════════════════════════════════════════════════
//  EXIT
// ═══════════════════════════════════════════════════
app.post('/api/exit', async(req,res) => {
  const { deltaKey,deltaSecret,pi42Key,pi42Secret,
    deltaProductId,pi42Symbol,longExchange,quantity } = req.body;

  const t0 = Date.now();
  const [dr,pr] = await Promise.allSettled([
    deltaAuth(deltaKey,deltaSecret,'POST','/v2/orders',{},{
      product_id:parseInt(deltaProductId), size:parseInt(quantity),
      side:longExchange==='Delta'?'sell':'buy',
      order_type:'market_order', reduce_only:true
    }),
    (async()=>{
      const pBody = { symbol:pi42Symbol, side:longExchange==='Pi42'?'SELL':'BUY',
        type:'MARKET', quantity:String(quantity), reduceOnly:'true' };
      const ts  = Date.now().toString();
      const all = {...pBody, timestamp:ts};
      const sig = p42Sign(pi42Secret, all);
      const r   = await axios.post(PI42+'/v1/order',{...all,signature:sig},{
        headers:p42Headers(pi42Key), timeout:12000
      });
      return r.data;
    })()
  ]);

  res.json({
    success:true, latencyMs:Date.now()-t0,
    delta:dr.status==='fulfilled'?{ok:true,data:dr.value}:{ok:false,error:dr.reason?.message},
    pi42: pr.status==='fulfilled'?{ok:true,data:pr.value}:{ok:false,error:pr.reason?.message}
  });
});

// ═══════════════════════════════════════════════════
//  POSITIONS
// ═══════════════════════════════════════════════════
app.post('/api/positions', async(req,res) => {
  const { deltaKey,deltaSecret,pi42Key,pi42Secret } = req.body;
  const [dr,pr] = await Promise.allSettled([
    deltaAuth(deltaKey,deltaSecret,'GET','/v2/positions',{page_size:'50'}),
    (async()=>{
      const ts=Date.now().toString(), all={timestamp:ts};
      const sig=p42Sign(pi42Secret,all);
      const r=await axios.get(PI42+'/v1/account/positions',{
        params:{...all,signature:sig}, headers:p42Headers(pi42Key), timeout:12000
      });
      return r.data;
    })()
  ]);
  res.json({
    delta:dr.status==='fulfilled'?dr.value:{error:dr.reason?.message},
    pi42: pr.status==='fulfilled'?pr.value:{error:pr.reason?.message}
  });
});

// ═══════════════════════════════════════════════════
//  HISTORY
// ═══════════════════════════════════════════════════
app.post('/api/history', async(req,res) => {
  const { deltaKey,deltaSecret,pi42Key,pi42Secret } = req.body;
  const [dr,pr] = await Promise.allSettled([
    deltaAuth(deltaKey,deltaSecret,'GET','/v2/orders',{state:'closed',page_size:'50'}),
    (async()=>{
      const ts=Date.now().toString(), all={limit:'50',timestamp:ts};
      const sig=p42Sign(pi42Secret,all);
      const r=await axios.get(PI42+'/v1/order/history',{
        params:{...all,signature:sig}, headers:p42Headers(pi42Key), timeout:12000
      });
      return r.data;
    })()
  ]);
  res.json({
    delta:dr.status==='fulfilled'?dr.value:{error:dr.reason?.message},
    pi42: pr.status==='fulfilled'?pr.value:{error:pr.reason?.message}
  });
});

// ═══════════════════════════════════════════════════
//  BALANCE
// ═══════════════════════════════════════════════════
app.post('/api/balance', async(req,res) => {
  const { deltaKey,deltaSecret,pi42Key,pi42Secret } = req.body;
  const inrRate = await getRate();

  const [dr,pr] = await Promise.allSettled([
    deltaAuth(deltaKey,deltaSecret,'GET','/v2/wallet/balances'),
    (async()=>{
      const ts=Date.now().toString(), all={timestamp:ts};
      const sig=p42Sign(pi42Secret,all);
      const r=await axios.get(PI42+'/v1/account/balance',{
        params:{...all,signature:sig}, headers:p42Headers(pi42Key), timeout:12000
      });
      return r.data;
    })()
  ]);

  let deltaUsd=0;
  if (dr.status==='fulfilled') {
    const bals=dr.value?.result||[];
    const usdt=Array.isArray(bals)?bals.find(b=>b.asset_symbol==='USDT'):null;
    deltaUsd=parseFloat(usdt?.balance||0);
  }
  let pi42Inr=0,pi42Usd=0;
  if (pr.status==='fulfilled') {
    const d=pr.value?.data||pr.value;
    pi42Inr=parseFloat(d?.availableBalance||d?.balance||d?.walletBalance||0);
    pi42Usd=inrRate>0?pi42Inr/inrRate:0;
  }
  res.json({deltaUsd,pi42Usd,pi42Inr,inrRate,total:deltaUsd+pi42Usd});
});

// ═══════════════════════════════════════════════════
//  SERVE FRONTEND
// ═══════════════════════════════════════════════════
app.get('*',(_req,res) =>
  res.sendFile(path.join(__dirname,'public','index.html')));

app.listen(PORT,()=>console.log(`FundingArb v4.2 on port ${PORT}`));
