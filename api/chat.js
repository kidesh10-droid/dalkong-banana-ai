module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  try {
    const { apiKey, model, messages, systemPrompt } = req.body;

    if (!apiKey) {
      return res.status(400).json({ error: { message: 'API 키가 없습니다.' } });
    }

    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: messages,
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 2048
          }
        })
      }
    );

    const text = await geminiRes.text();

    if (!text || text.trim() === '') {
      return res.status(500).json({ error: { message: 'Gemini API 응답이 비어있습니다.' } });
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return res.status(500).json({ error: { message: `JSON 파싱 오류: ${text.slice(0, 200)}` } });
    }

    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: { message: err.message || '서버 오류' } });
  }
}
