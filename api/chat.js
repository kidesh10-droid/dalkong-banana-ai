// Vercel 함수 타임아웃 최대로 설정
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  try {
    const { apiKey, model, messages, systemPrompt } = req.body;
    if (!apiKey) return res.status(400).json({ error: { message: 'API 키가 없습니다.' } });

    // 히스토리 최대 20개로 제한
    const trimmed = messages && messages.length > 20 ? messages.slice(-20) : (messages || []);

    const body = {
      system_instruction: { parts: [{ text: systemPrompt || '' }] },
      contents: trimmed,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 8192,
        topP: 0.95
      }
    };

    // 1차: 스트리밍 방식 (타임아웃 방지)
    try {
      const sRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${apiKey}&alt=sse`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      );

      if (sRes.ok) {
        const reader = sRes.body.getReader();
        const dec = new TextDecoder();
        let full = '', buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const js = line.slice(6).trim();
            if (js === '[DONE]') continue;
            try {
              const chunk = JSON.parse(js);
              // 에러 체크
              if (chunk.error) return res.status(200).json({ error: chunk.error });
              const part = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (part) full += part;
            } catch {}
          }
        }
        if (full) return res.status(200).json({ reply: full });
      }
    } catch (streamErr) {
      console.log('Stream failed, trying standard:', streamErr.message);
    }

    // 2차 fallback: 일반 방식
    const gRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );

    const txt = await gRes.text();
    if (!txt) return res.status(500).json({ error: { message: '빈 응답' } });

    let data;
    try { data = JSON.parse(txt); } catch { return res.status(500).json({ error: { message: txt.slice(0, 200) } }); }

    if (data.error) return res.status(200).json({ error: data.error });
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (reply) return res.status(200).json({ reply });
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: { message: err.message || '서버 오류' } });
  }
}
