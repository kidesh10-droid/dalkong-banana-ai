// 카카오 API 프록시 (CORS 우회)
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  let body = {};
  try {
    if (req.body && typeof req.body === 'object') body = req.body;
    else {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    }
  } catch(e) {}

  const { action } = body;

  // 인가 코드 → 액세스 토큰 교환
  if (action === 'token') {
    const { code, restKey, redirectUri } = body;
    if (!code || !restKey) return res.status(400).json({ error: 'code and restKey required' });
    try {
      const r = await fetch('https://kauth.kakao.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: restKey,
          redirect_uri: redirectUri || 'https://dalkong-banana-ai.vercel.app',
          code: code
        })
      });
      const d = await r.json();
      return res.status(200).json(d);
    } catch(e) {
      return res.status(200).json({ error: e.message });
    }
  }

  // 토큰 갱신
  if (action === 'refresh') {
    const { refreshToken, restKey } = body;
    if (!refreshToken || !restKey) return res.status(400).json({ error: 'params required' });
    try {
      const r = await fetch('https://kauth.kakao.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: restKey,
          refresh_token: refreshToken
        })
      });
      const d = await r.json();
      return res.status(200).json(d);
    } catch(e) {
      return res.status(200).json({ error: e.message });
    }
  }

  // 나에게 메시지 전송
  if (action === 'send') {
    const { token, text } = body;
    if (!token || !text) return res.status(400).json({ error: 'token and text required' });
    try {
      const template = {
        object_type: 'text',
        text: text.slice(0, 200), // 카카오 200자 제한
        link: { web_url: 'https://dalkong-banana-ai.vercel.app', mobile_web_url: 'https://dalkong-banana-ai.vercel.app' }
      };
      // 200자 초과시 여러 메시지로 분할
      const messages = [];
      const lines = text.split('\n');
      let current = '';
      for (const line of lines) {
        if ((current + '\n' + line).length > 190) {
          messages.push(current);
          current = line;
        } else {
          current = current ? current + '\n' + line : line;
        }
      }
      if (current) messages.push(current);

      // 첫 번째 메시지 전송
      const r = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          template_object: JSON.stringify({
            object_type: 'text',
            text: messages[0] || text.slice(0, 190),
            link: { web_url: 'https://dalkong-banana-ai.vercel.app' }
          })
        })
      });
      const d = await r.json();

      // 나머지 메시지 순차 전송
      for (let i = 1; i < Math.min(messages.length, 4); i++) {
        await new Promise(resolve => setTimeout(resolve, 300));
        await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            template_object: JSON.stringify({
              object_type: 'text',
              text: messages[i],
              link: { web_url: 'https://dalkong-banana-ai.vercel.app' }
            })
          })
        });
      }

      return res.status(200).json({ success: d.result_code === 0, result_code: d.result_code, error: d.msg });
    } catch(e) {
      return res.status(200).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
