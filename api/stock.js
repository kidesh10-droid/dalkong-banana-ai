module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  const KIS_MOCK = { key: process.env.KIS_MOCK_APP_KEY, secret: process.env.KIS_MOCK_APP_SECRET, base: 'https://openapivts.koreainvestment.com:29443' };
  const KIS_REAL = { key: process.env.KIS_REAL_APP_KEY, secret: process.env.KIS_REAL_APP_SECRET, base: 'https://openapi.koreainvestment.com:9443' };
  const sj = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t.slice(0,300) }; } };

  try {

    // 토큰
    if (action === 'token') {
      const { mode } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${c.base}/oauth2/tokenP`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ grant_type:'client_credentials', appkey:c.key, appsecret:c.secret }) });
      return res.status(200).json(await sj(r));
    }

    // 코스피/코스닥/환율/비트코인
    if (action === 'market_kr') {
      const yf = async (sym) => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2d`);
          const d = await r.json(); const m = d?.chart?.result?.[0]?.meta;
          return { price: m?.regularMarketPrice, chg: m?.regularMarketChangePercent, prev: m?.previousClose };
        } catch { return null; }
      };
      const [kospi, kosdaq, usdkrw, btc] = await Promise.all([yf('%5EKS11'), yf('%5EKQ11'), yf('KRW%3DX'), yf('BTC-KRW')]);
      return res.status(200).json({ kospi, kosdaq, usdkrw, btc });
    }

    // 미국 시황
    if (action === 'market_us') {
      const syms = ['%5EGSPC','%5EIXIC','%5EDJI','AAPL','TSLA','NVDA','MSFT','AMZN'];
      const results = await Promise.all(syms.map(async sym => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2d`);
          const d = await r.json(); const m = d?.chart?.result?.[0]?.meta;
          return { symbol: sym.replace('%5E','^'), price: m?.regularMarketPrice, change: m?.regularMarketChangePercent };
        } catch { return { symbol: sym, error: true }; }
      }));
      return res.status(200).json({ results });
    }

    // 야후 차트 (미국/글로벌)
    if (action === 'chart') {
      const { symbol, range } = req.query;
      const im = { '1d':'5m','5d':'15m','1mo':'1d','3mo':'1d','6mo':'1wk','1y':'1wk' };
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${im[range]||'1d'}&range=${range}`);
      const d = await r.json(); const rs = d?.chart?.result?.[0];
      if (!rs) return res.status(200).json({ error:'no data' });
      const closes = (rs.indicators?.quote?.[0]?.close||[]).map(v=>v?Math.round(v*100)/100:null).filter(Boolean);
      return res.status(200).json({ timestamps: rs.timestamp||[], closes });
    }

    // KIS 국내 현재가
    if (action === 'price_kr') {
      const { token, ticker, mode } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${ticker}`,
        { headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':'FHKST01010100'} });
      return res.status(200).json(await sj(r));
    }

    // KIS 일봉 차트 (국내주식)
    if (action === 'chart_kr') {
      const { token, ticker, period, mode } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const today = new Date();
      const from = new Date();
      const days = { '1mo':30,'3mo':90,'6mo':180,'1y':365,'5d':5 };
      from.setDate(from.getDate() - (days[period]||90));
      const fmt = d => d.toISOString().slice(0,10).replace(/-/g,'');
      const periodCode = (period==='1d'||period==='5d') ? 'D' : period==='1mo'||period==='3mo' ? 'D' : 'W';
      const r = await fetch(
        `${c.base}/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice?fid_cond_mrkt_div_code=J&fid_input_iscd=${ticker}&fid_input_date_1=${fmt(from)}&fid_input_date_2=${fmt(today)}&fid_period_div_code=${periodCode}&fid_org_adj_prc=0`,
        { headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':'FHKST03010100'} }
      );
      const d = await sj(r);
      if (d.output2 && d.output2.length > 0) {
        const sorted = [...d.output2].reverse();
        const timestamps = sorted.map(x => new Date(x.stck_bsop_date.replace(/(\d{4})(\d{2})(\d{2})/,'$1-$2-$3')).getTime()/1000);
        const closes = sorted.map(x => parseInt(x.stck_clpr||0)).filter(v=>v>0);
        return res.status(200).json({ timestamps, closes, source:'KIS' });
      }
      return res.status(200).json({ error:'no KIS chart data', msg: d.msg1||'' });
    }

    // KIS 국내 랭킹 - 거래대금/상승/하락 완전 분리
    if (action === 'rank_kr') {
      const { token, type, mode } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      // 거래대금: sort=1 / 상승률: sort=2 / 하락률: sort=4
      const sortMap = { vol:'1', rise:'2', fall:'4' };
      const sort = sortMap[type] || '1';
      const url = `${c.base}/uapi/domestic-stock/v1/ranking/fluctuation?fid_cond_mrkt_div_code=J&fid_cond_scr_div_code=20171&fid_input_iscd=0000&fid_rank_sort_cls_code=${sort}&fid_input_cnt_1=10&fid_prc_cls_code=1&fid_input_price_1=500&fid_input_price_2=&fid_vol_cnt=1000&fid_trgt_cls_code=4&fid_trgt_exls_cls_code=0&fid_div_cls_code=0&fid_rsfl_rate1=&fid_rsfl_rate2=`;
      const r = await fetch(url, { headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':'FHPST01720000','custtype':'P'} });
      return res.status(200).json(await sj(r));
    }

    // KIS 호가 조회
    if (action === 'hoga') {
      const { token, ticker, mode } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(
        `${c.base}/uapi/domestic-stock/v1/quotations/inquire-asking-price-exp-ccn?fid_cond_mrkt_div_code=J&fid_input_iscd=${ticker}`,
        { headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':'FHKST01010200'} }
      );
      return res.status(200).json(await sj(r));
    }

    // 국내 매수
    if (action === 'buy_kr') {
      const { token, ticker, price, qty, orderType, mode, accountNo, accountProduct } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/trading/order-cash`, { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':mode==='real'?'TTTC0802U':'VTTC0802U'}, body: JSON.stringify({ CANO:accountNo, ACNT_PRDT_CD:accountProduct||'01', PDNO:ticker, ORD_DVSN:orderType||'00', ORD_QTY:String(qty), ORD_UNPR:String(price) }) });
      return res.status(200).json(await sj(r));
    }

    // 국내 매도
    if (action === 'sell_kr') {
      const { token, ticker, price, qty, orderType, mode, accountNo, accountProduct } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/trading/order-cash`, { method:'POST', headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':mode==='real'?'TTTC0801U':'VTTC0801U'}, body: JSON.stringify({ CANO:accountNo, ACNT_PRDT_CD:accountProduct||'01', PDNO:ticker, ORD_DVSN:orderType||'00', ORD_QTY:String(qty), ORD_UNPR:String(price) }) });
      return res.status(200).json(await sj(r));
    }

    // 잔고 조회
    if (action === 'balance') {
      const { token, mode, accountNo, accountProduct } = req.body;
      const c = mode==='real' ? KIS_REAL : KIS_MOCK;
      const tr = mode==='real'?'TTTC8434R':'VTTC8434R';
      const r = await fetch(`${c.base}/uapi/domestic-stock/v1/trading/inquire-balance?CANO=${accountNo}&ACNT_PRDT_CD=${accountProduct||'01'}&AFHR_FLPR_YN=N&OFL_YN=&INQR_DVSN=02&UNPR_DVSN=01&FUND_STTL_ICLD_YN=N&FNCG_AMT_AUTO_RDPT_YN=N&PRCS_DVSN=01&CTX_AREA_FK100=&CTX_AREA_NK100=`,
        { headers:{'content-type':'application/json','authorization':`Bearer ${token}`,'appkey':c.key,'appsecret':c.secret,'tr_id':tr} });
      return res.status(200).json(await sj(r));
    }

    // 뉴스 (네이버)
    if (action === 'news') {
      const { query } = req.body;
      const r = await fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query+' 주식')}&display=10&sort=date`,
        { headers:{'X-Naver-Client-Id':process.env.NAVER_CLIENT_ID||'','X-Naver-Client-Secret':process.env.NAVER_CLIENT_SECRET||''} });
      return res.status(200).json(await sj(r));
    }

    // 네이버 API 키 진단
    if (action === 'check_naver') {
      const cid = process.env.NAVER_CLIENT_ID||'';
      const csc = process.env.NAVER_CLIENT_SECRET||'';
      if(!cid||!csc) return res.status(200).json({ ok:false, msg:'환경변수 NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET 없음' });
      // 실제 테스트
      try{
        const r = await fetch('https://openapi.naver.com/v1/search/news.json?query=날씨&display=1',
          { headers:{'X-Naver-Client-Id':cid,'X-Naver-Client-Secret':csc} });
        const d = await sj(r);
        if(d.items) return res.status(200).json({ ok:true, msg:'네이버 API 정상 작동', sample: d.items[0]?.title||'' });
        return res.status(200).json({ ok:false, msg: d.errorMessage||JSON.stringify(d) });
      }catch(e){ return res.status(200).json({ ok:false, msg: e.message }); }
    }

    // 날씨 + 네이버 통합 검색 (채팅용)
    if (action === 'naver_search') {
      const { query } = req.body;
      const cid = process.env.NAVER_CLIENT_ID||'';
      const csc = process.env.NAVER_CLIENT_SECRET||'';
      // 키 없으면 즉시 빈 결과
      if(!cid||!csc) return res.status(200).json({ type:'error', msg:'NAVER API 키 미설정' });

      const isWeather = ['날씨','기온','강수','비','눈','맑','흐','황사','미세먼지','예보','기상'].some(k=>query.includes(k));
      const isNews = ['뉴스','최신','속보','오늘'].some(k=>query.includes(k));

      try {
        // ── 날씨: 네이버 검색으로 실제 날씨 정보 가져오기 ──
        if (isWeather) {
          // 네이버 검색 + 지식iN 병렬 조회
          const [r1, r2] = await Promise.all([
            fetch(`https://openapi.naver.com/v1/search/webkr.json?query=${encodeURIComponent(query)}&display=5`,
              { headers:{'X-Naver-Client-Id':cid,'X-Naver-Client-Secret':csc} }),
            fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=5&sort=date`,
              { headers:{'X-Naver-Client-Id':cid,'X-Naver-Client-Secret':csc} })
          ]);
          const d1 = await sj(r1);
          const d2 = await sj(r2);
          // 웹 결과에서 날씨 관련 스니펫 추출
          const webItems = (d1.items||[]).map(x=>({
            title: x.title.replace(/<[^>]*>/g,'').replace(/&[^;]+;/g,''),
            desc: (x.description||'').replace(/<[^>]*>/g,'').replace(/&[^;]+;/g,'').slice(0,150)
          }));
          const newsItems = (d2.items||[]).map(x=>({
            title: x.title.replace(/<[^>]*>/g,'').replace(/&[^;]+;/g,''),
            desc: (x.description||'').replace(/<[^>]*>/g,'').replace(/&[^;]+;/g,'').slice(0,100),
            date: x.pubDate||''
          }));
          return res.status(200).json({
            type: 'weather_search',
            query,
            web: webItems,
            news: newsItems,
            fetchedAt: new Date().toLocaleString('ko-KR', {timeZone:'Asia/Seoul'})
          });
        }

        // ── 뉴스 검색 ──
        if (isNews) {
          const r = await fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=5&sort=date`,
            { headers:{'X-Naver-Client-Id':cid,'X-Naver-Client-Secret':csc} });
          const d = await sj(r);
          return res.status(200).json({ type:'news', items: d.items||[] });
        }

        // ── 일반 검색: 뉴스 + 웹검색 병렬 ──
        const [r1,r2] = await Promise.all([
          fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=4&sort=date`, { headers:{'X-Naver-Client-Id':cid,'X-Naver-Client-Secret':csc} }),
          cid?fetch(`https://openapi.naver.com/v1/search/webkr.json?query=${encodeURIComponent(query)}&display=3`, { headers:{'X-Naver-Client-Id':cid,'X-Naver-Client-Secret':csc} }):Promise.resolve(null)
        ]);
        const d1 = await sj(r1);
        const d2 = r2 ? await sj(r2) : { items:[] };
        return res.status(200).json({ type:'search', items:[...(d1.items||[]),...(d2.items||[])] });

      } catch(e) {
        return res.status(200).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch(err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
