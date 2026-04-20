// 포트폴리오 클라우드 동기화 API
// 비밀번호로 암호화된 데이터를 파일시스템에 저장 (Vercel KV 없이도 동작)
// Vercel은 /tmp 디렉토리만 쓰기 가능 → 재배포 시 초기화됨
// → Gemini API를 통해 Google Drive/외부 저장 없이 URL 공유 방식 사용

const crypto = require('crypto');

function encrypt(text, pass) {
  const key = crypto.scryptSync(pass, 'salt_dalkong', 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decrypt(text, pass) {
  const [ivHex, encHex] = text.split(':');
  const key = crypto.scryptSync(pass, 'salt_dalkong', 32);
  const iv = Buffer.from(ivHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// 간단한 인메모리 스토리지 (Vercel 서버리스는 인스턴스 재시작 가능)
// → URL 파라미터 방식으로 데이터 자체를 주고받음 (서버 저장 없음)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.method === 'GET' ? req.query : (req.body || {});

  try {
    // 포트폴리오 암호화 내보내기
    if (action === 'encode') {
      const { data, pin } = req.body;
      if (!data || !pin) return res.status(400).json({ error: 'data and pin required' });
      if (pin.length < 4) return res.status(400).json({ error: 'PIN must be 4+ digits' });
      const json = JSON.stringify(data);
      const encrypted = encrypt(json, pin);
      // 공유 코드: base64 URL safe
      const shareCode = Buffer.from(encrypted).toString('base64url');
      return res.status(200).json({ shareCode, length: shareCode.length });
    }

    // 포트폴리오 복호화 가져오기
    if (action === 'decode') {
      const { shareCode, pin } = req.body;
      if (!shareCode || !pin) return res.status(400).json({ error: 'shareCode and pin required' });
      try {
        const encrypted = Buffer.from(shareCode, 'base64url').toString('utf8');
        const json = decrypt(encrypted, pin);
        const data = JSON.parse(json);
        return res.status(200).json({ data });
      } catch(e) {
        return res.status(200).json({ error: 'PIN이 틀렸거나 코드가 잘못됐어요.' });
      }
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
