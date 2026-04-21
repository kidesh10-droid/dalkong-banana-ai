// 포트폴리오 기기 동기화 API
// gzip 압축 + base64url → 짧은 공유 코드 생성
const zlib = require('zlib');
const { promisify } = require('util');
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // body 파싱
  let body = {};
  if (req.body && typeof req.body === 'object') body = req.body;
  else if (req.body && typeof req.body === 'string') {
    try { body = JSON.parse(req.body); } catch(e) {}
  } else {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      if (raw) body = JSON.parse(raw);
    } catch(e) {}
  }

  const { action } = body;

  try {
    // ── 내보내기: 데이터 → 짧은 공유 코드 ──
    if (action === 'encode') {
      const { data } = body;
      if (!data || !Array.isArray(data)) {
        return res.status(400).json({ error: 'data 배열이 필요합니다.' });
      }

      // 최소 필드만 추출 (코드 길이 최소화)
      const minimal = data.map(h => ({
        n: h.name || h.n || '',
        c: h.code || h.c || h.ticker || '',
        q: h.qty || h.q || 0,
        p: h.avgPrice || h.p || 0,
        m: h.market || h.m || 'KR',
        d: h.divRate || h.d || 0,
        a: h.acctLabel || h.a || '',
        cp: h.curPrice || h.cp || 0,
      }));

      const json = JSON.stringify(minimal);
      const compressed = await gzip(Buffer.from(json, 'utf-8'), { level: 9 });
      // base64url (padding 제거 → 더 짧음)
      const shareCode = compressed.toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

      return res.status(200).json({
        shareCode,
        length: shareCode.length,
        count: data.length
      });
    }

    // ── 가져오기: 공유 코드 → 데이터 복원 ──
    if (action === 'decode') {
      const { shareCode } = body;
      if (!shareCode) {
        return res.status(400).json({ error: 'shareCode가 필요합니다.' });
      }

      try {
        // base64url → base64 복원
        const b64 = shareCode.replace(/-/g, '+').replace(/_/g, '/');
        const padded = b64 + '=='.slice(0, (4 - b64.length % 4) % 4);
        const buf = Buffer.from(padded, 'base64');
        const decompressed = await gunzip(buf);
        const minimal = JSON.parse(decompressed.toString('utf-8'));

        // 원래 필드명으로 복원
        const data = minimal.map(h => ({
          name: h.n || '',
          code: h.c || '',
          ticker: h.c || '',
          qty: h.q || 0,
          avgPrice: h.p || 0,
          curPrice: h.cp || h.p || 0,
          market: h.m || 'KR',
          divRate: h.d || 0,
          acctLabel: h.a || '',
          evalAmt: (h.q || 0) * (h.cp || h.p || 0),
          buyAmt: (h.q || 0) * (h.p || 0),
          pnlAmt: (h.q || 0) * ((h.cp || h.p || 0) - (h.p || 0)),
          pnlPct: h.p > 0 ? (((h.cp || h.p) - h.p) / h.p * 100) : 0,
        }));

        return res.status(200).json({ data, count: data.length });
      } catch(e) {
        return res.status(200).json({ error: '코드가 올바르지 않습니다. 다시 확인해주세요.' });
      }
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
