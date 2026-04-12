module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  const KIS_MOCK = { key: process.env.KIS_MOCK_APP_KEY, secret: process.env.KIS_MOCK_APP_SECRET, base: 'https://openapivts.koreainvestment.com:29443' };
  const KIS_REAL = { key: process.env.KIS_REAL_APP_KEY, secret: process.env.KIS_REAL_APP_SECRET, base: 'https://openapi.koreainvestment.com:9443' };
  try {
    // 토큰
    if (action === 'token') {
      const { mode } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${cfg.base}/oauth2/tokenP`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', appkey: cfg.key, appsecret: cfg.secret }) });
      return res.status(200).json(await r.json());
    }
    // 국내 현재가
    if (action === 'price_kr') {
      const { token, ticker, mode } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${cfg.base}/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${ticker}`, { headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}`, 'appkey': cfg.key, 'appsecret': cfg.secret, 'tr_id': 'FHKST01010100' } });
      return res.status(200).json(await r.json());
    }
    // 코스피/코스닥/환율/비트코인
    if (action === 'market_kr') {
      try {
        const results = await Promise.all([
          // 코스피
          fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EKS11?interval=1d&range=1d').then(r=>r.json()).then(d=>{
            const m=d?.chart?.result?.[0]?.meta;
            return {type:'kospi',price:m?.regularMarketPrice,prev:m?.previousClose,chg:m?.regularMarketChangePercent};
          }).catch(()=>({type:'kospi',error:true})),
          // 코스닥
          fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EKQ11?interval=1d&range=1d').then(r=>r.json()).then(d=>{
            const m=d?.chart?.result?.[0]?.meta;
            return {type:'kosdaq',price:m?.regularMarketPrice,prev:m?.previousClose,chg:m?.regularMarketChangePercent};
          }).catch(()=>({type:'kosdaq',error:true})),
          // USD/KRW 환율
          fetch('https://query1.finance.yahoo.com/v8/finance/chart/KRW%3DX?interval=1d&range=1d').then(r=>r.json()).then(d=>{
            const m=d?.chart?.result?.[0]?.meta;
            return {type:'usdkrw',price:m?.regularMarketPrice,chg:m?.regularMarketChangePercent};
          }).catch(()=>({type:'usdkrw',error:true})),
          // 비트코인 (KRW)
          fetch('https://query1.finance.yahoo.com/v8/finance/chart/BTC-KRW?interval=1d&range=1d').then(r=>r.json()).then(d=>{
            const m=d?.chart?.result?.[0]?.meta;
            return {type:'btc',price:m?.regularMarketPrice,chg:m?.regularMarketChangePercent};
          }).catch(()=>({type:'btc',error:true})),
        ]);
        const out = {};
        results.forEach(r => { if(!r.error) out[r.type] = r; });
        return res.status(200).json(out);
      } catch(e) {
        return res.status(200).json({ error: e.message });
      }
    }

    // 야후 파이낸스 미국 시황
    if (action === 'market_us') {
      const symbols = ['%5EGSPC', '%5EIXIC', '%5EDJI', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN'];
      const results = await Promise.all(symbols.map(async (sym) => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`);
          const d = await r.json();
          const meta = d?.chart?.result?.[0]?.meta;
          return { symbol: sym.replace('%5E', '^'), price: meta?.regularMarketPrice, change: meta?.regularMarketChangePercent, name: meta?.shortName };
        } catch { return { symbol: sym, error: true }; }
      }));
      return res.status(200).json({ results });
    }
    // 야후 파이낸스 차트
    if (action === 'chart') {
      const { symbol, range } = req.query;
      const intervalMap = { '1d': '5m', '5d': '15m', '1mo': '1d', '3mo': '1d', '6mo': '1wk', '1y': '1wk' };
      const interval = intervalMap[range] || '1d';
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`);
      const d = await r.json();
      const result = d?.chart?.result?.[0];
      if (!result) return res.status(200).json({ error: 'no data' });
      const timestamps = result.timestamp || [];
      const closes = result.indicators?.quote?.[0]?.close || [];
      return res.status(200).json({ timestamps, closes: closes.map(v => v ? Math.round(v * 100) / 100 : null).filter(Boolean) });
    }
    // 국내 매수
    if (action === 'buy_kr') {
      const { token, ticker, price, qty, orderType, mode, accountNo, accountProduct } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const tr_id = mode === 'real' ? 'TTTC0802U' : 'VTTC0802U';
      const r = await fetch(`${cfg.base}/uapi/domestic-stock/v1/trading/order-cash`, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}`, 'appkey': cfg.key, 'appsecret': cfg.secret, 'tr_id': tr_id }, body: JSON.stringify({ CANO: accountNo, ACNT_PRDT_CD: accountProduct || '01', PDNO: ticker, ORD_DVSN: orderType || '00', ORD_QTY: String(qty), ORD_UNPR: String(price) }) });
      return res.status(200).json(await r.json());
    }
    // 국내 매도
    if (action === 'sell_kr') {
      const { token, ticker, price, qty, orderType, mode, accountNo, accountProduct } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const tr_id = mode === 'real' ? 'TTTC0801U' : 'VTTC0801U';
      const r = await fetch(`${cfg.base}/uapi/domestic-stock/v1/trading/order-cash`, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}`, 'appkey': cfg.key, 'appsecret': cfg.secret, 'tr_id': tr_id }, body: JSON.stringify({ CANO: accountNo, ACNT_PRDT_CD: accountProduct || '01', PDNO: ticker, ORD_DVSN: orderType || '00', ORD_QTY: String(qty), ORD_UNPR: String(price) }) });
      return res.status(200).json(await r.json());
    }
    // 국내 랭킹 (거래대금/상승률/하락률) - 장외시간/휴장일 포함
    if (action === 'rank_kr') {
      const { token, type, mode } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      // 정렬: 1=거래대금, 2=상승률, 4=하락률
      const sortMap = { vol: '1', rise: '2', fall: '4' };
      const sortCd = sortMap[type] || '1';
      // 장중/장외 모두 조회 가능한 등락률 순위 API
      const url = `${cfg.base}/uapi/domestic-stock/v1/ranking/fluctuation?fid_cond_mrkt_div_code=J&fid_cond_scr_div_code=20171&fid_input_iscd=0000&fid_rank_sort_cls_code=${sortCd}&fid_input_cnt_1=10&fid_prc_cls_code=1&fid_input_price_1=1000&fid_input_price_2=&fid_vol_cnt=10000&fid_trgt_cls_code=4&fid_trgt_exls_cls_code=0&fid_div_cls_code=0&fid_rsfl_rate1=&fid_rsfl_rate2=`;
      const r = await fetch(url, {
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
          'appkey': cfg.key,
          'appsecret': cfg.secret,
          'tr_id': 'FHPST01720000',
          'custtype': 'P'
        }
      });
      const text = await r.text();
      try {
        const data = JSON.parse(text);
        return res.status(200).json(data);
      } catch(e) {
        return res.status(200).json({ error: text.slice(0, 200) });
      }
    }

    // 잔고 조회
    if (action === 'balance') {
      const { token, mode, accountNo, accountProduct } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const tr_id = mode === 'real' ? 'TTTC8434R' : 'VTTC8434R';
      const r = await fetch(`${cfg.base}/uapi/domestic-stock/v1/trading/inquire-balance?CANO=${accountNo}&ACNT_PRDT_CD=${accountProduct||'01'}&AFHR_FLPR_YN=N&OFL_YN=&INQR_DVSN=02&UNPR_DVSN=01&FUND_STTL_ICLD_YN=N&FNCG_AMT_AUTO_RDPT_YN=N&PRCS_DVSN=01&CTX_AREA_FK100=&CTX_AREA_NK100=`, { headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}`, 'appkey': cfg.key, 'appsecret': cfg.secret, 'tr_id': tr_id } });
      return res.status(200).json(await r.json());
    }
    // 뉴스
    if (action === 'news') {
      const { query } = req.body;
      const clientId = process.env.NAVER_CLIENT_ID || '';
      const clientSecret = process.env.NAVER_CLIENT_SECRET || '';
      const r = await fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query + ' 주식')}&display=10&sort=date`, { headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret } });
      return res.status(200).json(await r.json());
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
