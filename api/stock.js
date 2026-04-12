module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  // KIS API 설정
  const KIS_MOCK = {
    key: process.env.KIS_MOCK_APP_KEY,
    secret: process.env.KIS_MOCK_APP_SECRET,
    base: 'https://openapivts.koreainvestment.com:29443'
  };
  const KIS_REAL = {
    key: process.env.KIS_REAL_APP_KEY,
    secret: process.env.KIS_REAL_APP_SECRET,
    base: 'https://openapi.koreainvestment.com:9443'
  };

  try {
    // 1. 토큰 발급
    if (action === 'token') {
      const { mode } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${cfg.base}/oauth2/tokenP`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ grant_type: 'client_credentials', appkey: cfg.key, appsecret: cfg.secret })
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 2. 국내 주식 현재가
    if (action === 'price_kr') {
      const { token, ticker, mode } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${cfg.base}/uapi/domestic-stock/v1/quotations/inquire-price?fid_cond_mrkt_div_code=J&fid_input_iscd=${ticker}`, {
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
          'appkey': cfg.key,
          'appsecret': cfg.secret,
          'tr_id': 'FHKST01010100'
        }
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 3. 해외 주식 현재가 (미국)
    if (action === 'price_us') {
      const { token, ticker, mode } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const r = await fetch(`${cfg.base}/uapi/overseas-price/v1/quotations/price?AUTH=&EXCD=NAS&SYMB=${ticker}`, {
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
          'appkey': cfg.key,
          'appsecret': cfg.secret,
          'tr_id': 'HHDFS00000300'
        }
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 4. 국내 주식 매수
    if (action === 'buy_kr') {
      const { token, ticker, qty, price, mode } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const tr_id = mode === 'real' ? 'TTTC0802U' : 'VTTC0802U';
      const r = await fetch(`${cfg.base}/uapi/domestic-stock/v1/trading/order-cash`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
          'appkey': cfg.key,
          'appsecret': cfg.secret,
          'tr_id': tr_id
        },
        body: JSON.stringify({
          CANO: process.env.KIS_ACCOUNT_NO || '',
          ACNT_PRDT_CD: '01',
          PDNO: ticker,
          ORD_DVSN: '00',
          ORD_QTY: String(qty),
          ORD_UNPR: String(price)
        })
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 5. 국내 주식 매도
    if (action === 'sell_kr') {
      const { token, ticker, qty, price, mode } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const tr_id = mode === 'real' ? 'TTTC0801U' : 'VTTC0801U';
      const r = await fetch(`${cfg.base}/uapi/domestic-stock/v1/trading/order-cash`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
          'appkey': cfg.key,
          'appsecret': cfg.secret,
          'tr_id': tr_id
        },
        body: JSON.stringify({
          CANO: process.env.KIS_ACCOUNT_NO || '',
          ACNT_PRDT_CD: '01',
          PDNO: ticker,
          ORD_DVSN: '00',
          ORD_QTY: String(qty),
          ORD_UNPR: String(price)
        })
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 6. 잔고 조회
    if (action === 'balance') {
      const { token, mode } = req.body;
      const cfg = mode === 'real' ? KIS_REAL : KIS_MOCK;
      const tr_id = mode === 'real' ? 'TTTC8434R' : 'VTTC8434R';
      const acno = process.env.KIS_ACCOUNT_NO || '';
      const r = await fetch(`${cfg.base}/uapi/domestic-stock/v1/trading/inquire-balance?CANO=${acno}&ACNT_PRDT_CD=01&AFHR_FLPR_YN=N&OFL_YN=&INQR_DVSN=02&UNPR_DVSN=01&FUND_STTL_ICLD_YN=N&FNCG_AMT_AUTO_RDPT_YN=N&PRCS_DVSN=01&CTX_AREA_FK100=&CTX_AREA_NK100=`, {
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${token}`,
          'appkey': cfg.key,
          'appsecret': cfg.secret,
          'tr_id': tr_id
        }
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    // 7. 야후 파이낸스 미국 시황
    if (action === 'market_us') {
      const symbols = ['%5EGSPC', '%5EIXIC', '%5EDJI', 'AAPL', 'TSLA', 'NVDA', 'MSFT', 'AMZN'];
      const results = await Promise.all(symbols.map(async (sym) => {
        try {
          const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`);
          const d = await r.json();
          const meta = d?.chart?.result?.[0]?.meta;
          return { symbol: sym.replace('%5E','^'), price: meta?.regularMarketPrice, change: meta?.regularMarketChangePercent, name: meta?.shortName };
        } catch { return { symbol: sym, error: true }; }
      }));
      return res.status(200).json({ results });
    }

    // 8. 뉴스 (네이버 금융)
    if (action === 'news') {
      const { query } = req.body;
      const clientId = process.env.NAVER_CLIENT_ID || '';
      const clientSecret = process.env.NAVER_CLIENT_SECRET || '';
      const r = await fetch(`https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query + ' 주식')}&display=10&sort=date`, {
        headers: { 'X-Naver-Client-Id': clientId, 'X-Naver-Client-Secret': clientSecret }
      });
      const data = await r.json();
      return res.status(200).json(data);
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
