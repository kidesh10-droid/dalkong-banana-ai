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
    const lastMsg = trimmed[trimmed.length - 1]?.parts?.[0]?.text || '';

    // google_search는 일반 채팅에서만, 긴 분석 프롬프트엔 사용 안 함
    const isShortChat = lastMsg.length < 200;
    const needsSearch = isShortChat && [
      '날씨','기온','내일','뉴스','속보','실시간','지금 주가','현재 환율'
    ].some(k => lastMsg.includes(k));

    const baseBody = {
      system_instruction: { parts: [{ text: systemPrompt || '' }] },
      contents: trimmed,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048,
        topP: 0.95
      }
    };

    // 사용 가능한 모델 목록 (2026.04 기준 v1beta 확인됨)
    const MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro'];
    const startModel = (model && (model.includes('1.5') || model.includes('flash') || model.includes('pro')))
      ? (model.includes('1.5') ? model : 'gemini-1.5-flash')
      : 'gemini-1.5-flash';
    const fallbacks = [startModel, ...MODELS].filter((v,i,a) => v && a.indexOf(v) === i);

    for (const mdl of fallbacks) {
      // tools 없이 먼저 시도 (안정성 우선)
      const body = { ...baseBody };
      if (needsSearch) body.tools = [{ google_search: {} }];

      const result = await tryCall(mdl, body, apiKey);

      // tools 오류 → tools 없이 재시도
      if (result && result.toolError) {
        const result2 = await tryCall(mdl, { ...baseBody }, apiKey);
        if (result2 && result2.reply) return res.status(200).json({ reply: result2.reply });
        if (result2 === null) continue;
      }

      if (result === null) continue;
      if (result.reply) return res.status(200).json({ reply: result.reply });

      if (result.error) {
        const msg = result.error.message || '';
        // 모델 없음/미지원 → 다음 모델
        if (msg.includes('not found') || msg.includes('not supported') ||
            msg.includes('no longer') || msg.includes('deprecated')) continue;
        // 과부하 → 다음 모델
        if (msg.includes('overloaded') || msg.includes('503')) continue;
        // 할당량 초과 → 즉시 명확한 메시지 반환 (다른 모델도 같은 키라 의미없음)
        if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') ||
            msg.includes('rate limit') || msg.includes('429')) {
          return res.status(200).json({ error: { message: '⚠️ API 사용량 한도 초과\n\nGemini 무료 한도에 도달했어요.\n잠시 기다리거나 내일 다시 시도해주세요.\n(무료: 분당 15회 / 일 1,500회)' } });
        }
        // 잘못된 API 키
        if (msg.includes('API_KEY_INVALID') || msg.includes('invalid') || msg.includes('401')) {
          return res.status(200).json({ error: { message: '❌ API 키가 올바르지 않아요. AI채팅 탭에서 키를 다시 확인해주세요.' } });
        }
        // 그 외 → 실제 오류 메시지 전달
        return res.status(200).json({ error: result.error });
      }
    }

    return res.status(200).json({ error: { message: '잠시 후 다시 시도해주세요 🐻' } });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}

async function tryCall(mdl, body, apiKey) {
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    );
    const txt = await r.text();
    if (!txt) return null;
    let d;
    try { d = JSON.parse(txt); } catch { return null; }

    if (d.error) {
      const msg = d.error.message || '';
      // tools 관련 오류 → 특별 처리
      if (msg.includes('tool') || msg.includes('INVALID_ARGUMENT')) {
        return { toolError: true };
      }
      // 과부하 → null
      if (msg.includes('overloaded') || msg.includes('RESOURCE_EXHAUSTED') ||
          msg.includes('quota') || msg.includes('503')) return null;
      return { error: d.error };
    }

    const reply = d?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (reply) return { reply };
    return null;
  } catch (e) {
    return null;
  }
}
