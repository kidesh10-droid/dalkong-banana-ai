// Node 18+ 내장 fetch 사용 (node-fetch 불필요)

const KIS_MOCK = {
  base: 'https://openapivts.koreainvestment.com:29443',
  key: process.env.KIS_MOCK_APP_KEY,
  secret: process.env.KIS_MOCK_APP_SECRET
};
const KIS_REAL = {
  base: 'https://openapi.koreainvestment.com:9443',
  key: process.env.KIS_REAL_APP_KEY,
  secret: process.env.KIS_REAL_APP_SECRET
};

async function sj(r) {
  try { return await r.json(); }
  catch(e) { return { error: e.message }; }
}

// body 파싱 헬퍼
async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (req.body && typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch(e) { return {}; }
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    return raw ? JSON.parse(raw) : {};
  } catch(e) { return {}; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = {};
  if (req.method === 'POST') body = await parseBody(req);
  const action = req.method === 'GET' ? req.query.action : (body.action || req.query.action);

  try {

    // ── KIS 토큰 발급 ──
    if (action === 'token') {
      const { mode } = body;
      const c = mode === 'real' ? KIS_REAL : KIS_MOCK;
      if (!c.key || !c.secret) {
        return res.status(200).json({ error: 'KIS API 키가 설정되지 않았습니다. Vercel 환경변수를 확인해주세요.' });
      }
      const r = await fetch(`${c.base}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: c.key, appsecret: c.secret })
      });
      const d = await sj(r);
      return res.status(200).json(d);
    }

    // ── 한국 시황 ──
    if (action === 'market_kr') {
      const [ks, kq, usd, btc] = await Promise.all([
        fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=2d').then(r=>r.json()).catch(()=>({})),
        fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EKQ11?interval=1d&range=2d').then(r=>r.json()).catch(()=>({})),
        fetch('https://api.exchangerate-api.com/v4/latest/USD').then(r=>r.json()).catch(()=>({})),
        fetch('https://api.upbit.com/v1/ticker?markets=KRW-BTC').then(r=>r.json()).catch(()=>[])
      ]);
      const parseYQ = d => {
        try {
          const q = d.chart.result[0];
          const closes = q.indicators.quote[0].close.filter(Boolean);
          const last = closes[closes.length-1];
          const prev = closes[closes.length-2] || last;
          return { price: Math.round(last), chg: ((last-prev)/prev*100).toFixed(2) };
        } catch { return null; }
      };
      return res.status(200).json({
        kospi: parseYQ(ks),
        kosdaq: parseYQ(kq),
        usdkrw: usd.rates?.KRW ? { price: usd.rates.KRW } : null,
        btc: Array.isArray(btc) && btc[0] ? { price: btc[0].trade_price, chg: (btc[0].signed_change_rate*100).toFixed(2) } : null
      });
    }

    // ── 미국 시황 ──
    if (action === 'market_us') {
      const symbols = ['^GSPC','^IXIC','^DJI','AAPL','TSLA','NVDA','MSFT','AMZN','META','GOOGL'];
      const results = await Promise.all(symbols.map(async sym => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`);
          const d = await r.json();
          const q = d.chart.result[0];
          const closes = q.indicators.quote[0].close.filter(Boolean);
          const last = closes[closes.length-1];
          const prev = closes[closes.length-2] || last;
          return { symbol: sym, price: last, change: ((last-prev)/prev*100) };
        } catch { return { symbol: sym, error: true }; }
      }));
      return res.status(200).json({ results });
    }

    // ── Yahoo 차트 ──
    if (action === 'chart') {
      const { symbol, range } = req.method==='GET' ? req.query : body;
      const interval = range==='1d'?'5m':range==='5d'?'30m':'1d';
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range||'1mo'}`);
      const d = await r.json();
      const q = d.chart?.result?.[0];
      if (!q) return res.status(200).json({ error: 'No data' });
      return res.status(200).json({
        timestamps: q.timestamp,
        closes: q.indicators.quote[0].close,
        highs: q.indicators.quote[0].high,
        lows: q.indicators.quote[0].low
      });
    }

    // ── KIS 국내 현재가 ──
    if (action === 'price_kr') {
      const { token, ticker, mode } = body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(
        `${c.base}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${ticker}`,
        { headers: { 'content-type':'application/json', 'authorization':`Bearer ${token}`, 'appkey':c.key, 'appsecret':c.secret, 'tr_id':'FHKST01010100' } }
      );
      return res.status(200).json(await sj(r));
    }

    // ── KIS 차트 ──
    if (action === 'chart_kr') {
      const { token, ticker, mode } = body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const today = new Date();
      const from = new Date(today); from.setMonth(from.getMonth()-3);
      const fmt = d => d.getFullYear()+(d.getMonth()+1).toString().padStart(2,'0')+d.getDate().toString().padStart(2,'0');
      const r = await fetch(
        `${c.base}/uapi/domestic-stock/v1/quotations/inquire-daily-chartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${ticker}&FID_INPUT_DATE_1=${fmt(from)}&FID_INPUT_DATE_2=${fmt(today)}&FID_PERIOD_DIV_CODE=D`,
        { headers: { 'content-type':'application/json', 'authorization':`Bearer ${token}`, 'appkey':c.key, 'appsecret':c.secret, 'tr_id':'FHKST03010100' } }
      );
      const d = await sj(r);
      if (!d.output2) return res.status(200).json({ error: 'No chart data' });
      const items = d.output2.reverse();
      return res.status(200).json({
        timestamps: items.map(x => new Date(x.stck_bsop_date).getTime()/1000),
        closes: items.map(x => parseInt(x.stck_clpr))
      });
    }

    // ── KIS 랭킹 ──
    if (action === 'rank_kr') {
      const { token, type, mode } = body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const sortCode = type==='rise'?'0':'1';
      const r = await fetch(
        `${c.base}/uapi/domestic-stock/v1/ranking/fluctuation?fid_aply_rang_prc_5=0&fid_aply_rang_prc_4=0&fid_cond_mrkt_div_code=J&fid_cond_scr_div_code=20170&fid_input_iscd=0000&fid_rank_sort_cls_code=${sortCode}&fid_input_cnt_1=0&fid_prc_cls_code=1&fid_rank_sort_cls_code2=&fid_blng_cls_code=0`,
        { headers: { 'content-type':'application/json', 'authorization':`Bearer ${token}`, 'appkey':c.key, 'appsecret':c.secret, 'tr_id':'FHPST01700000', 'custtype':'P' } }
      );
      return res.status(200).json(await sj(r));
    }

    // ── KIS 호가 ──
    if (action === 'hoga') {
      const { token, ticker, mode } = body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(
        `${c.base}/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${ticker}`,
        { headers: { 'content-type':'application/json', 'authorization':`Bearer ${token}`, 'appkey':c.key, 'appsecret':c.secret, 'tr_id':'FHKST01010200' } }
      );
      return res.status(200).json(await sj(r));
    }

    // ── KIS 잔고 ──
    if (action === 'balance') {
      const { token, mode, accountNo, accountProduct } = body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const tr = mode==='real' ? 'TTTC8434R' : 'VTTC8434R';
      const no = (accountNo||'').replace(/-/g,'');
      const r = await fetch(
        `${c.base}/uapi/domestic-stock/v1/trading/inquire-balance?CANO=${no}&ACNT_PRDT_CD=${accountProduct||'01'}&AFHR_FLPR_YN=N&OFL_YN=&INQR_DVSN=02&UNPR_DVSN=01&FUND_STTL_ICLD_YN=N&FNCG_AMT_AUTO_RDPT_YN=N&PRCS_DVSN=01&CTX_AREA_FK100=&CTX_AREA_NK100=`,
        { headers: { 'content-type':'application/json', 'authorization':`Bearer ${token}`, 'appkey':c.key, 'appsecret':c.secret, 'tr_id':tr } }
      );
      return res.status(200).json(await sj(r));
    }

    // ── KIS 매수 ──
    if (action === 'buy_kr') {
      const { token, ticker, price, qty, orderType, mode, accountNo, accountProduct } = body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const tr = mode==='real' ? 'TTTC0802U' : 'VTTC0802U';
      const no = (accountNo||'').replace(/-/g,'');
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/trading/order-cash`, {
        method: 'POST',
        headers: { 'content-type':'application/json', 'authorization':`Bearer ${token}`, 'appkey':c.key, 'appsecret':c.secret, 'tr_id':tr },
        body: JSON.stringify({ CANO:no, ACNT_PRDT_CD:accountProduct||'01', PDNO:ticker, ORD_DVSN:orderType||'00', ORD_QTY:String(qty), ORD_UNPR:String(price) })
      });
      return res.status(200).json(await sj(r));
    }

    // ── KIS 매도 ──
    if (action === 'sell_kr') {
      const { token, ticker, price, qty, orderType, mode, accountNo, accountProduct } = body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const tr = mode==='real' ? 'TTTC0801U' : 'VTTC0801U';
      const no = (accountNo||'').replace(/-/g,'');
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/trading/order-cash`, {
        method: 'POST',
        headers: { 'content-type':'application/json', 'authorization':`Bearer ${token}`, 'appkey':c.key, 'appsecret':c.secret, 'tr_id':tr },
        body: JSON.stringify({ CANO:no, ACNT_PRDT_CD:accountProduct||'01', PDNO:ticker, ORD_DVSN:orderType||'00', ORD_QTY:String(qty), ORD_UNPR:String(price) })
      });
      return res.status(200).json(await sj(r));
    }

    // ── 뉴스 ──
    if (action === 'news' || action === 'naver_search') {
      const { query } = body;
      const cid = process.env.NAVER_CLIENT_ID;
      const csec = process.env.NAVER_CLIENT_SECRET;
      if (!cid || !csec) return res.status(200).json({ items: [] });
      const type = action === 'news' ? 'news' : 'webkr';
      const r = await fetch(
        `https://openapi.naver.com/v1/search/${type}.json?query=${encodeURIComponent(query)}&display=10&sort=date`,
        { headers: { 'X-Naver-Client-Id': cid, 'X-Naver-Client-Secret': csec } }
      );
      return res.status(200).json(await sj(r));
    }

    // ── 네이버 데이터랩 ──
    if (action === 'datalab_keyword') {
      const { keyword, startDate, endDate, timeUnit } = body;
      const cid = process.env.NAVER_CLIENT_ID;
      const csec = process.env.NAVER_CLIENT_SECRET;
      if (!cid || !csec) return res.status(200).json({ error: 'NAVER_API_NOT_SET' });
      const now = new Date();
      const sd = startDate || (() => { const d=new Date(); d.setMonth(d.getMonth()-12); return d.toISOString().slice(0,10); })();
      const ed = endDate || now.toISOString().slice(0,10);
      const r = await fetch('https://openapi.naver.com/v1/datalab/search', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'X-Naver-Client-Id':cid, 'X-Naver-Client-Secret':csec },
        body: JSON.stringify({ startDate:sd, endDate:ed, timeUnit:timeUnit||'month', keywordGroups:[{groupName:keyword,keywords:[keyword]}] })
      });
      return res.status(200).json(await sj(r));
    }

    // ── 네이버 쇼핑 ──
    if (action === 'shopping_keyword') {
      const { keyword } = body;
      const cid = process.env.NAVER_CLIENT_ID;
      const csec = process.env.NAVER_CLIENT_SECRET;
      if (!cid || !csec) return res.status(200).json({ error: 'NAVER_API_NOT_SET' });
      const r = await fetch(
        `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=30&sort=sim`,
        { headers: { 'X-Naver-Client-Id':cid, 'X-Naver-Client-Secret':csec } }
      );
      return res.status(200).json(await sj(r));
    }

    // ── Imagen 3 이미지 생성 ──
    if (action === 'imagen') {
      const { apiKey, prompt, aspectRatio, sampleCount, negativePrompt } = body;
      if (!apiKey) return res.status(200).json({ error: 'API 키 없음' });
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instances: [{ prompt, ...(negativePrompt ? { negativePrompt } : {}) }],
            parameters: { sampleCount: Math.min(parseInt(sampleCount)||1,4), aspectRatio: aspectRatio||'1:1', safetyFilterLevel:'BLOCK_SOME', personGeneration:'ALLOW_ADULT' }
          })
        }
      );
      const d = await sj(r);
      if (d.error) return res.status(200).json({ error: d.error.message || JSON.stringify(d.error) });
      if (d.predictions?.length > 0) {
        return res.status(200).json({ images: d.predictions.map(p => ({ base64: p.bytesBase64Encoded, mimeType: 'image/png' })) });
      }
      return res.status(200).json({ error: '이미지 생성 실패', raw: JSON.stringify(d).slice(0,300) });
    }

    // ── Gemini 이미지 편집 ──
    if (action === 'gemini_image_edit') {
      const { apiKey, prompt, imageBase64, mimeType } = body;
      if (!apiKey) return res.status(200).json({ error: 'API 키 없음' });
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [
              { inline_data: { mime_type: mimeType||'image/jpeg', data: imageBase64 } },
              { text: prompt }
            ]}],
            generationConfig: { responseModalities: ['IMAGE','TEXT'] }
          })
        }
      );
      const d = await sj(r);
      if (d.error) return res.status(200).json({ error: d.error.message });
      const parts = d.candidates?.[0]?.content?.parts;
      if (parts) {
        const imgPart = parts.find(p => p.inlineData);
        const textPart = parts.find(p => p.text);
        if (imgPart) return res.status(200).json({ imageBase64: imgPart.inlineData.data, mimeType: imgPart.inlineData.mimeType, text: textPart?.text });
        if (textPart) return res.status(200).json({ text: textPart.text, noImage: true });
      }
      return res.status(200).json({ error: '결과 없음' });
    }

    // ── 환경변수 설정 확인 (디버그용) ──
    if (action === 'check_env') {
      return res.status(200).json({
        KIS_MOCK_APP_KEY: process.env.KIS_MOCK_APP_KEY ? '✅ 설정됨 ('+process.env.KIS_MOCK_APP_KEY.slice(0,6)+'...)' : '❌ 없음',
        KIS_MOCK_APP_SECRET: process.env.KIS_MOCK_APP_SECRET ? '✅ 설정됨' : '❌ 없음',
        KIS_REAL_APP_KEY: process.env.KIS_REAL_APP_KEY ? '✅ 설정됨 ('+process.env.KIS_REAL_APP_KEY.slice(0,6)+'...)' : '❌ 없음',
        KIS_REAL_APP_SECRET: process.env.KIS_REAL_APP_SECRET ? '✅ 설정됨' : '❌ 없음',
        NAVER_CLIENT_ID: process.env.NAVER_CLIENT_ID ? '✅ 설정됨' : '❌ 없음',
        NAVER_CLIENT_SECRET: process.env.NAVER_CLIENT_SECRET ? '✅ 설정됨' : '❌ 없음',
      });
    }

    // ── 차트분석용 OHLCV 전체 데이터 ──
    if (action === 'ta_chart') {
      const { symbol, range, market } = body;
      // 심볼 변환
      let sym = symbol;
      if (market === 'kr') sym = symbol + '.KS';
      else if (market === 'kr_kosdaq') sym = symbol + '.KQ';

      const rangeMap = { '5d':'15m', '1mo':'1d', '3mo':'1d', '6mo':'1d', '1y':'1d' };
      const interval = rangeMap[range] || '1d';

      try {
        const r = await fetch(
          `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range || '1mo'}`
        );
        const d = await r.json();
        const q = d.chart?.result?.[0];
        if (!q) return res.status(200).json({ error: `${symbol} 데이터를 찾을 수 없어요.` });

        const quotes = q.indicators.quote[0];
        const meta = q.meta || {};
        return res.status(200).json({
          timestamps: q.timestamp,
          close:  quotes.close,
          open:   quotes.open,
          high:   quotes.high,
          low:    quotes.low,
          volume: quotes.volume,
          meta: {
            currency:  meta.currency,
            shortName: meta.shortName || meta.longName || symbol,
            regularMarketPrice: meta.regularMarketPrice,
            previousClose: meta.chartPreviousClose || meta.previousClose,
          }
        });
      } catch(e) {
        return res.status(200).json({ error: e.message });
      }
    }


    // ── KIS 단타 스크리닝 ──
    // ── 장외 종목 스크리닝 (Yahoo Finance 기반) ──
    if (action === 'screening_yahoo') {
      // KIS 없이도 동작 - Yahoo Finance 데이터로 스크리닝
      const KOSPI200 = [
        '005930','000660','035420','005380','051910',
        '006400','028260','012330','066570','017670',
        '000270','032830','105560','055550','086790',
        '034730','018260','011200','024110','316140',
        '003550','010130','326030','009150','096770',
        '003490','011790','033780','034020','015760',
        '047050','030200','003670','000100','011070',
        '021240','009830','010950','012450','011170'
      ];

      try {
        // 병렬로 40종목 데이터 수집
        const results = await Promise.all(
          KOSPI200.slice(0, 40).map(async code => {
            try {
              const sym = code + '.KS';
              const r = await fetch(
                'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?interval=1d&range=60d'
              );
              const d = await r.json();
              const q = d.chart?.result?.[0];
              if (!q) return null;

              const closes  = q.indicators.quote[0].close.filter(Boolean);
              const volumes  = q.indicators.quote[0].volume.filter(Boolean);
              const highs    = q.indicators.quote[0].high.filter(Boolean);
              const lows     = q.indicators.quote[0].low.filter(Boolean);
              if (closes.length < 20) return null;

              const last    = closes[closes.length - 1];
              const prev    = closes[closes.length - 2] || last;
              const pct     = ((last - prev) / prev * 100);
              const vol     = volumes[volumes.length - 1] || 0;
              const avgVol  = volumes.slice(-20).reduce((s,v)=>s+v,0) / 20;
              const volRatio = avgVol > 0 ? vol / avgVol : 0;

              // RSI 계산 (14일)
              const gains = [], losses = [];
              for (let i = closes.length - 15; i < closes.length; i++) {
                const diff = closes[i] - closes[i-1];
                gains.push(diff > 0 ? diff : 0);
                losses.push(diff < 0 ? -diff : 0);
              }
              const avgGain = gains.reduce((s,v)=>s+v,0) / 14;
              const avgLoss = losses.reduce((s,v)=>s+v,0) / 14;
              const rs  = avgLoss > 0 ? avgGain / avgLoss : 100;
              const rsi = 100 - (100 / (1 + rs));

              // 이동평균
              const ma5  = closes.slice(-5).reduce((s,v)=>s+v,0) / 5;
              const ma20 = closes.slice(-20).reduce((s,v)=>s+v,0) / 20;

              // 52주 고점 대비
              const hi52 = Math.max(...closes.slice(-252));
              const hiRatio = last / hi52;

              const meta = q.meta || {};
              const name = meta.shortName || meta.longName || code;

              return { code, name, price: last, pct, volRatio, rsi, ma5, ma20, hi52, hiRatio, vol, avgVol };
            } catch { return null; }
          })
        );

        const valid = results.filter(Boolean);

        // 스크리닝 조건
        // 조건 완화 - 더 많은 종목 포함
        const candidates = valid.filter(s => {
          return s.price >= 2000 && s.price <= 500000  // 가격 범위 확대
            && s.volRatio >= 0.5;                       // 거래량 조건 완화
        });
        // 조건 만족 없으면 전체 사용
        const finalCandidates = candidates.length >= 3 ? candidates : valid;

        // 스코어링
        const scored = finalCandidates.map(s => {
          let score = 0;
          // 거래량 (30점)
          score += Math.min(s.volRatio * 10, 30);
          // RSI 적정 구간 50~65 (20점)
          if (s.rsi >= 50 && s.rsi <= 65) score += 20;
          else if (s.rsi >= 45 && s.rsi < 50) score += 10;
          // MA 정배열 (20점)
          if (s.ma5 > s.ma20) score += 20;
          // 상승 강도 (15점)
          if (s.pct > 3) score += 15;
          else if (s.pct > 1) score += 8;
          else if (s.pct > 0) score += 3;
          // 신고가 근접 (15점)
          if (s.hiRatio >= 0.97) score += 15;
          else if (s.hiRatio >= 0.90) score += 8;

          const targetPct = s.pct > 3 ? 3 : 4;
          const target = Math.round(s.price * (1 + targetPct / 100) / 100) * 100;
          const stop   = Math.round(s.price * 0.97 / 100) * 100;
          const entry  = Math.round(s.price * 1.003 / 100) * 100;

          const reasons = [];
          if (s.volRatio >= 2) reasons.push('거래량 급증(' + s.volRatio.toFixed(1) + '배)');
          else reasons.push('거래량 증가(' + s.volRatio.toFixed(1) + '배)');
          if (s.rsi >= 50 && s.rsi <= 65) reasons.push('RSI 양호(' + s.rsi.toFixed(0) + ')');
          if (s.ma5 > s.ma20) reasons.push('단기MA 상향');
          if (s.hiRatio >= 0.95) reasons.push('52주 고점 근접');
          if (s.pct > 0) reasons.push('당일 '+s.pct.toFixed(1)+'% 상승');

          return { ...s, score: Math.round(score), target, stop, entry, targetPct, reason: reasons.join(' · ') };
        });

        scored.sort((a, b) => b.score - a.score);
        return res.status(200).json({ result: scored.slice(0, 5), total: valid.length, screened: candidates.length });

      } catch(e) {
        return res.status(200).json({ error: e.message });
      }
    }

    if (action === 'kis_screening') {
      const { token, mode } = body;
      const c = mode === 'real' ? KIS_REAL : KIS_MOCK;

      const buildReason = (pct, volRatio, price, hiRatio) => {
        const parts = [];
        if (pct >= 8)  parts.push('강한 급등');
        else if (pct >= 5) parts.push('상승 모멘텀');
        else parts.push('완만한 상승');
        if (volRatio >= 3) parts.push('거래량 폭발('+volRatio.toFixed(0)+'배)');
        else if (volRatio >= 2) parts.push('거래량 급증('+volRatio.toFixed(0)+'배)');
        else parts.push('거래량 증가('+volRatio.toFixed(0)+'배)');
        if (hiRatio >= 0.97) parts.push('신고가 근접');
        if (price >= 10000 && price <= 100000) parts.push('단타 적정 가격대');
        return parts.join(' · ');
      };

      try {
        const [riseRes, volRes] = await Promise.all([
          fetch(
            c.base+'/uapi/domestic-stock/v1/ranking/fluctuation?fid_aply_rang_prc_5=0&fid_aply_rang_prc_4=0&fid_cond_mrkt_div_code=J&fid_cond_scr_div_code=20170&fid_input_iscd=0000&fid_rank_sort_cls_code=0&fid_input_cnt_1=0&fid_prc_cls_code=1&fid_rank_sort_cls_code2=&fid_blng_cls_code=0',
            { headers: { 'content-type':'application/json', 'authorization':'Bearer '+token, 'appkey':c.key, 'appsecret':c.secret, 'tr_id':'FHPST01700000', 'custtype':'P' } }
          ),
          fetch(
            c.base+'/uapi/domestic-stock/v1/ranking/volume?fid_aply_rang_vol=0&fid_cond_mrkt_div_code=J&fid_cond_scr_div_code=20171&fid_input_iscd=0000&fid_rank_sort_cls_code=0&fid_input_cnt_1=0&fid_trgt_cls_code=0&fid_trgt_exls_cls_code=0&fid_div_cls_code=0&fid_blng_cls_code=0&fid_input_price_1=1000&fid_input_price_2=500000&fid_vol_cnt=100000',
            { headers: { 'content-type':'application/json', 'authorization':'Bearer '+token, 'appkey':c.key, 'appsecret':c.secret, 'tr_id':'FHPST01710000', 'custtype':'P' } }
          )
        ]);

        const rise = await sj(riseRes);
        const vol  = await sj(volRes);
        const riseList = (rise.output || []);

        const candidates = riseList.filter(s => {
          const pct      = parseFloat(s.prdy_ctrt || 0);
          const price    = parseInt(s.stck_prpr  || 0);
          const vol2     = parseInt(s.acml_vol   || 0);
          const prevV    = parseInt(s.prdy_vol   || 1);
          const volRatio = prevV > 0 ? vol2 / prevV : 0;
          return pct >= 2 && pct <= 15 && price >= 3000 && price <= 300000 && volRatio >= 1.5;
        });

        const scored = finalCandidates.map(s => {
          const pct      = parseFloat(s.prdy_ctrt || 0);
          const price    = parseInt(s.stck_prpr  || 0);
          const vol2     = parseInt(s.acml_vol   || 0);
          const prevV    = parseInt(s.prdy_vol   || 1);
          const volRatio = prevV > 0 ? vol2 / prevV : 0;
          const hiPrice  = parseInt(s.stck_hgpr  || price);

          let score = 0;
          score += Math.min(pct * 4, 30);
          score += Math.min(volRatio * 10, 30);
          score += pct > 5 ? 20 : pct > 3 ? 10 : 5;
          if (price >= 10000 && price <= 100000) score += 10;
          else if (price >= 5000) score += 5;
          const hiRatio = hiPrice > 0 ? price / hiPrice : 0;
          if (hiRatio >= 0.95) score += 10;

          const targetPct = pct > 8 ? 3 : pct > 5 ? 4 : 5;
          const target = Math.round(price * (1 + targetPct / 100) / 100) * 100;
          const stop   = Math.round(price * 0.97 / 100) * 100;
          const entry  = Math.round(price * 1.005 / 100) * 100;

          return {
            code: s.mksc_shrn_iscd, name: s.hts_kor_isnm,
            price, pct: pct.toFixed(1), volRatio: volRatio.toFixed(1),
            score: Math.round(score), entry, target, stop, targetPct,
            reason: buildReason(pct, volRatio, price, hiRatio)
          };
        });

        scored.sort((a, b) => b.score - a.score);
        return res.status(200).json({ result: scored.slice(0, 5) });

      } catch(e) {
        return res.status(200).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch(err) {
    console.error('stock.js error:', err);
    return res.status(500).json({ error: err.message });
  }
}
