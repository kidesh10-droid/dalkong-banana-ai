module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  try {
    const { apiKey, messages, systemPrompt } = req.body;
    if (!apiKey) return res.status(400).json({ error: { message: 'API 키가 없습니다.' } });

    const trimmed = (messages || []).slice(-20);
    const lastMsg = trimmed[trimmed.length - 1]?.parts?.[0]?.text || '';

    // systemPrompt를 첫 메시지 앞에 붙임 (system_instruction 미사용)
    const sysPrefix = systemPrompt ? `[역할] ${systemPrompt}\n\n` : '';
    const contents = trimmed.map((msg, idx) => {
      if (idx === trimmed.length - 1 && msg.role === 'user') {
        return { role: 'user', parts: [{ text: sysPrefix + (msg.parts?.[0]?.text || '') }] };
      }
      return msg;
    });

    // 2026.04 실제 동작 모델 목록
    const MODELS = [
      { ver: 'v1beta', name: 'gemini-2.5-flash-preview-05-20' },
      { ver: 'v1beta', name: 'gemini-2.5-pro-preview-05-06' },
      { ver: 'v1beta', name: 'gemini-2.0-flash-lite-001' },
      { ver: 'v1',     name: 'gemini-1.5-flash-001' },
      { ver: 'v1',     name: 'gemini-1.5-flash-002' },
      { ver: 'v1',     name: 'gemini-1.5-pro-001' },
      { ver: 'v1',     name: 'gemini-1.5-pro-002' },
    ];

    const body = {
      contents,
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048, topP: 0.95 }
    };

    const errors = [];

    for (const { ver, name } of MODELS) {
      try {
        const url = `https://generativelanguage.googleapis.com/${ver}/models/${name}:generateContent?key=${apiKey}`;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        });
        const d = await r.json();

        if (d.error) {
          const msg = d.error.message || '';
          errors.push(`${name}: ${msg.slice(0, 60)}`);
          if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('429')) {
            return res.status(200).json({ error: { message: '⚠️ API 사용량 한도 초과\n잠시 후 다시 시도해주세요.' } });
          }
          if (msg.includes('API_KEY_INVALID') || msg.includes('401')) {
            return res.status(200).json({ error: { message: '❌ API 키가 올바르지 않아요.' } });
          }
          // 모델 없음 → 다음 시도
          continue;
        }

        const reply = d?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (reply) return res.status(200).json({ reply });

        errors.push(`${name}: empty response`);
      } catch (e) {
        errors.push(`${name}: ${e.message.slice(0, 40)}`);
      }
    }

    return res.status(200).json({
      error: { message: `모든 모델 실패\n시도: ${errors.slice(0, 3).join(' / ')}` }
    });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}
