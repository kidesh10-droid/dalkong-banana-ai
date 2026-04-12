module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed' } });

  try {
    const { apiKey, model, messages, systemPrompt } = req.body;
    if (!apiKey) return res.status(400).json({ error: { message: 'API 키가 없습니다.' } });

    const trimmed = messages && messages.length > 20 ? messages.slice(-20) : (messages || []);

    // Google Search grounding 활성화 - 실시간 검색 가능
    const body = {
      system_instruction: { parts: [{ text: systemPrompt || '' }] },
      contents: trimmed,
      tools: [
        { google_search: {} }  // Gemini 실시간 구글 검색 grounding
      ],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 8192,
        topP: 0.95
      }
    };

    // 스트리밍 방식
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
              if (chunk.error) return res.status(200).json({ error: chunk.error });
              const part = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
              if (part) full += part;
            } catch {}
          }
        }
        if (full) return res.status(200).json({ reply: full });
      }
    } catch (streamErr) {
      console.log('Stream failed:', streamErr.message);
    }

    // fallback: 일반 방식 (grounding 포함)
    const gRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );

    const txt = await gRes.text();
    if (!txt) return res.status(500).json({ error: { message: '빈 응답' } });

    let data;
    try { data = JSON.parse(txt); } catch { return res.status(500).json({ error: { message: txt.slice(0, 200) } }); }

    if (data.error) {
      // grounding 미지원 모델이면 tools 제거하고 재시도
      if (data.error.message && (data.error.message.includes('tool') || data.error.message.includes('not supported'))) {
        const body2 = { ...body };
        delete body2.tools;
        const r2 = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body2) }
        );
        const txt2 = await r2.text();
        try {
          const d2 = JSON.parse(txt2);
          if (d2.error) return res.status(200).json({ error: d2.error });
          const reply2 = d2?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (reply2) return res.status(200).json({ reply: reply2 });
        } catch {}
      }
      return res.status(200).json({ error: data.error });
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (reply) return res.status(200).json({ reply });
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: { message: err.message || '서버 오류' } });
  }
}
