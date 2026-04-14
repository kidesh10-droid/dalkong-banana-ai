const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

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

async function sj(r) { try { return await r.json(); } catch(e) { return { error: e.message }; } }

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const action = req.method === 'GET'
      ? req.query.action
      : (req.body && req.body.action) || req.query.action;

    // ── KIS 토큰 ──
    if (action === 'token') {
      const { mode } = req.body || {};
      const c = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${c.base}/oauth2/tokenP`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: c.key, appsecret: c.secret })
      });
      return res.status(200).json(await sj(r));
    }

    // ── 국내 시황 ──
    if (action === 'market_kr') {
      const [kospi, kosdaq, usdkrw, btc] = await Promise.all([
        fetch('https://finance.yahoo.com/quote/%5EKS11/').then(r=>r.text()).catch(()=>''),
        fetch('https://finance.yahoo.com/quote/%5EKQ11/').then(r=>r.text()).catch(()=>''),
        fetch('https://api.exchangerate-api.com/v4/latest/USD').then(r=>r.json()).catch(()=>({})),
        fetch('https://api.upbit.com/v1/ticker?markets=KRW-BTC').then(r=>r.json()).catch(()=>[])
      ]);
      const extractYahoo = (html, sym) => {
        const m = html.match(/regularMarketPrice[^>]*?([0-9,]+\.?[0-9]*)/);
        const m2 = html.match(/regularMarketChangePercent[^>]*?([+-]?[0-9]+\.?[0-9]*)/);
        return { price: m ? parseFloat(m[1].replace(/,/g,'')) : null, chg: m2 ? parseFloat(m2[1]) : 0 };
      };
      const btcData = Array.isArray(btc) && btc[0] ? { price: btc[0].trade_price, chg: btc[0].signed_change_rate*100 } : null;
      const usdRate = usdkrw.rates && usdkrw.rates.KRW ? usdkrw.rates.KRW : null;

      // Yahoo 파싱 대신 간단한 API
      const [ks, kq] = await Promise.all([
        fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=2d').then(r=>r.json()).catch(()=>({})),
        fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EKQ11?interval=1d&range=2d').then(r=>r.json()).catch(()=>({}))
      ]);
      const parseYQ = d => {
        try {
          const q = d.chart.result[0];
          const closes = q.indicators.quote[0].close;
          const last = closes[closes.length-1];
          const prev = closes[closes.length-2]||last;
          return { price: Math.round(last), chg: ((last-prev)/prev*100) };
        } catch { return null; }
      };
      return res.status(200).json({
        kospi: parseYQ(ks),
        kosdaq: parseYQ(kq),
        usdkrw: usdRate ? { price: usdRate } : null,
        btc: btcData
      });
    }

    // ── 미국 시황 ──
    if (action === 'market_us') {
      const symbols = ['^GSPC','^IXIC','^DJI','AAPL','TSLA','NVDA','MSFT','AMZN'];
      const results = await Promise.all(symbols.map(async sym => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2d`);
          const d = await r.json();
          const q = d.chart.result[0];
          const closes = q.indicators.quote[0].close;
          const last = closes[closes.length-1];
          const prev = closes[closes.length-2]||last;
          return { symbol: sym, price: last, change: ((last-prev)/prev*100) };
        } catch { return { symbol: sym, error: true }; }
      }));
      return res.status(200).json({ results });
    }

    // ── 차트 (Yahoo) ──
    if (action === 'chart') {
      const { symbol, range } = req.method==='GET' ? req.query : req.body;
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${range==='1d'?'5m':range==='5d'?'30m':'1d'}&range=${range||'1mo'}`);
      const d = await r.json();
      const q = d.chart && d.chart.result && d.chart.result[0];
      if (!q) return res.status(200).json({ error: 'No data' });
      return res.status(200).json({
        timestamps: q.timestamp,
        closes: q.indicators.quote[0].close,
        highs: q.indicators.quote[0].high,
        lows: q.indicators.quote[0].low
      });
    }

    // ── 국내 현재가 (KIS) ──
    if (action === 'price_kr') {
      const { token, ticker, mode } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${ticker}`,
        { headers: {'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':'FHKST01010100'} });
      return res.status(200).json(await sj(r));
    }

    // ── KIS 차트 ──
    if (action === 'chart_kr') {
      const { token, ticker, period, mode } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const today = new Date();
      const from = new Date(today); from.setMonth(from.getMonth()-3);
      const fmt = d => d.getFullYear()+(d.getMonth()+1).toString().padStart(2,'0')+d.getDate().toString().padStart(2,'0');
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/quotations/inquire-daily-chartprice?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${ticker}&FID_INPUT_DATE_1=${fmt(from)}&FID_INPUT_DATE_2=${fmt(today)}&FID_PERIOD_DIV_CODE=D`,
        { headers: {'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':'FHKST03010100'} });
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
      const { token, type, mode } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const fid = type==='vol' ? '0' : type==='rise' ? '0' : '0';
      const sortCode = type==='vol' ? '1' : type==='rise' ? '0' : '1';
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/ranking/fluctuation?fid_aply_rang_prc_5=0&fid_aply_rang_prc_4=0&fid_cond_mrkt_div_code=J&fid_cond_scr_div_code=20170&fid_input_iscd=0000&fid_rank_sort_cls_code=${sortCode}&fid_input_cnt_1=0&fid_prc_cls_code=1&fid_rank_sort_cls_code2=&fid_blng_cls_code=0`,
        { headers: {'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':'FHPST01700000','custtype':'P'} });
      return res.status(200).json(await sj(r));
    }

    // ── 호가 ──
    if (action === 'hoga') {
      const { token, ticker, mode } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn?FID_COND_MRKT_DIV_CODE=J&FID_INPUT_ISCD=${ticker}`,
        { headers: {'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':'FHKST01010200'} });
      return res.status(200).json(await sj(r));
    }

    // ── 잔고 조회 ──
    if (action === 'balance') {
      const { token, mode, accountNo, accountProduct } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const tr = mode==='real' ? 'TTTC8434R' : 'VTTC8434R';
      const no = (accountNo||'').replace(/-/g,'');
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/trading/inquire-balance?CANO=${no}&ACNT_PRDT_CD=${accountProduct||'01'}&AFHR_FLPR_YN=N&OFL_YN=&INQR_DVSN=02&UNPR_DVSN=01&FUND_STTL_ICLD_YN=N&FNCG_AMT_AUTO_RDPT_YN=N&PRCS_DVSN=01&CTX_AREA_FK100=&CTX_AREA_NK100=`,
        { headers: {'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':tr} });
      return res.status(200).json(await sj(r));
    }

    // ── 매수 ──
    if (action === 'buy_kr') {
      const { token, ticker, price, qty, orderType, mode, accountNo, accountProduct } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const tr = mode==='real' ? 'TTTC0802U' : 'VTTC0802U';
      const no = (accountNo||'').replace(/-/g,'');
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/trading/order-cash`,
        { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':tr},
          body: JSON.stringify({CANO:no,ACNT_PRDT_CD:accountProduct||'01',PDNO:ticker,ORD_DVSN:orderType||'00',ORD_QTY:String(qty),ORD_UNPR:String(price)}) });
      return res.status(200).json(await sj(r));
    }

    // ── 매도 ──
    if (action === 'sell_kr') {
      const { token, ticker, price, qty, orderType, mode, accountNo, accountProduct } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const tr = mode==='real' ? 'TTTC0801U' : 'VTTC0801U';
      const no = (accountNo||'').replace(/-/g,'');
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/trading/order-cash`,
        { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':tr},
          body: JSON.stringify({CANO:no,ACNT_PRDT_CD:accountProduct||'01',PDNO:ticker,ORD_DVSN:orderType||'00',ORD_QTY:String(qty),ORD_UNPR:String(price)}) });
      return res.status(200).json(await sj(r));
    }

    // ── 네이버 검색/뉴스 ──
    if (action === 'news' || action === 'naver_search') {
      const { query } = req.body;
      const cid = process.env.NAVER_CLIENT_ID;
      const csec = process.env.NAVER_CLIENT_SECRET;
      if (!cid || !csec) return res.status(200).json({ items: [] });
      const type = action === 'news' ? 'news' : 'webkr';
      const r = await fetch(`https://openapi.naver.com/v1/search/${type}.json?query=${encodeURIComponent(query)}&display=10&sort=date`,
        { headers: { 'X-Naver-Client-Id': cid, 'X-Naver-Client-Secret': csec } });
      return res.status(200).json(await sj(r));
    }

    // ── 네이버 데이터랩 (키워드 검색량) ──
    if (action === 'datalab_keyword') {
      const { keyword, startDate, endDate, timeUnit } = req.body;
      const cid = process.env.NAVER_CLIENT_ID;
      const csec = process.env.NAVER_CLIENT_SECRET;
      if (!cid || !csec) return res.status(200).json({ error: 'NAVER_API_NOT_SET' });
      const now = new Date();
      const sd = startDate || (() => { const d=new Date(); d.setMonth(d.getMonth()-12); return d.toISOString().slice(0,10); })();
      const ed = endDate || now.toISOString().slice(0,10);
      const body = {
        startDate: sd, endDate: ed,
        timeUnit: timeUnit || 'month',
        keywordGroups: [{ groupName: keyword, keywords: [keyword] }]
      };
      const r = await fetch('https://openapi.naver.com/v1/datalab/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Naver-Client-Id': cid, 'X-Naver-Client-Secret': csec },
        body: JSON.stringify(body)
      });
      const d = await sj(r);
      return res.status(200).json(d);
    }

    // ── 네이버 쇼핑 검색 ──
    if (action === 'shopping_keyword') {
      const { keyword } = req.body;
      const cid = process.env.NAVER_CLIENT_ID;
      const csec = process.env.NAVER_CLIENT_SECRET;
      if (!cid || !csec) return res.status(200).json({ error: 'NAVER_API_NOT_SET' });
      const r = await fetch(`https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=30&sort=sim`,
        { headers: { 'X-Naver-Client-Id': cid, 'X-Naver-Client-Secret': csec } });
      const d = await sj(r);
      return res.status(200).json(d);
    }

    // ── 네이버 광고 API (키워드 통계) ──
    if (action === 'naver_ad_keyword') {
      const { keyword } = req.body;
      // 네이버 검색광고 API는 별도 키 필요 - 우선 쇼핑 API로 대체
      const cid = process.env.NAVER_CLIENT_ID;
      const csec = process.env.NAVER_CLIENT_SECRET;
      if (!cid || !csec) return res.status(200).json({ error: 'NAVER_API_NOT_SET' });
      const [shop, news] = await Promise.all([
        fetch(`https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(keyword)}&display=10`,
          { headers: {'X-Naver-Client-Id':cid,'X-Naver-Client-Secret':csec} }).then(r=>r.json()).catch(()=>({})),
        fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(keyword)}&display=5&sort=date`,
          { headers: {'X-Naver-Client-Id':cid,'X-Naver-Client-Secret':csec} }).then(r=>r.json()).catch(()=>({}))
      ]);
      return res.status(200).json({ shop, news });
    }

    // ── Imagen 3 이미지 생성 ──
    if (action === 'imagen') {
      const { apiKey, prompt, aspectRatio, sampleCount, negativePrompt } = req.body;
      if (!apiKey) return res.status(200).json({ error: 'API 키 없음' });
      const count = Math.min(parseInt(sampleCount)||1, 4);
      // 지원 모델: imagen-3.0-generate-001 또는 imagen-3.0-fast-generate-001
      const model = 'imagen-3.0-generate-001';
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instances: [{ prompt, ...(negativePrompt ? { negativePrompt } : {}) }],
            parameters: {
              sampleCount: count,
              aspectRatio: aspectRatio || '1:1',
              safetyFilterLevel: 'BLOCK_SOME',
              personGeneration: 'ALLOW_ADULT'
            }
          })
        }
      );
      const d = await sj(r);
      if (d.error) return res.status(200).json({ error: d.error.message || JSON.stringify(d.error) });
      if (d.predictions && d.predictions.length > 0) {
        return res.status(200).json({
          images: d.predictions.map(p => ({ base64: p.bytesBase64Encoded, mimeType: 'image/png' }))
        });
      }
      return res.status(200).json({ error: '이미지 생성 실패', raw: JSON.stringify(d).slice(0,300) });
    }

    // ── Gemini Vision 이미지 합성/편집 ──
    if (action === 'gemini_image_edit') {
      const { apiKey, prompt, imageBase64, mimeType } = req.body;
      if (!apiKey) return res.status(200).json({ error: 'API 키 없음' });
      // Gemini 2.0 flash experimental - 이미지 생성/편집 가능
      const model = 'gemini-2.0-flash-exp';
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              parts: [
                { inline_data: { mime_type: mimeType || 'image/jpeg', data: imageBase64 } },
                { text: prompt }
              ]
            }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
          })
        }
      );
      const d = await sj(r);
      if (d.error) return res.status(200).json({ error: d.error.message });
      const parts = d.candidates && d.candidates[0] && d.candidates[0].content && d.candidates[0].content.parts;
      if (parts) {
        const imgPart = parts.find(p => p.inlineData);
        const textPart = parts.find(p => p.text);
        if (imgPart) return res.status(200).json({ imageBase64: imgPart.inlineData.data, mimeType: imgPart.inlineData.mimeType, text: textPart && textPart.text });
        if (textPart) return res.status(200).json({ text: textPart.text, noImage: true });
      }
      return res.status(200).json({ error: '결과 없음', raw: JSON.stringify(d).slice(0,300) });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch(err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
