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

    // 마지막 사용자 메시지
    const lastMsg = trimmed[trimmed.length - 1]?.parts?.[0]?.text || '';

    // 실시간 검색이 필요한 질문인지 판단
    const needsSearch = [
      '날씨','기온','오늘','내일','뉴스','최신','현재','지금','주가','시세',
      '환율','금리','유가','속보','실시간','주식','코스피','비트코인'
    ].some(k => lastMsg.includes(k));

    const body = {
      system_instruction: { parts: [{ text: systemPrompt || '' }] },
      contents: trimmed,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 2048,
        topP: 0.95
      }
    };

    // 실시간 정보 필요할 때만 google_search 추가
    if (needsSearch) {
      body.tools = [{ google_search: {} }];
    }

    // 모델 폴백 (과부하 시 자동 전환)
    // 현재 지원 모델 (2026.04 기준) - 2.5-flash만 안정적
    const fallbacks = [model, 'gemini-2.5-flash', 'gemini-2.5-flash-8b'].filter((v,i,a)=>v&&a.indexOf(v)===i);

    for (const mdl of fallbacks) {
      const result = await tryCall(mdl, body, apiKey, needsSearch);
      if (result === null) { console.log(mdl,'과부하, 다음 시도'); continue; }
      if (result.reply) return res.status(200).json({ reply: result.reply });
      if (result.error) return res.status(200).json({ error: result.error });
    }

    return res.status(200).json({ error: { message: '잠시 후 다시 시도해주세요 🐻' } });

  } catch (err) {
    return res.status(500).json({ error: { message: err.message } });
  }
}

async function tryCall(mdl, body, apiKey, withSearch) {
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
      // 과부하/할당량 초과 → null 반환 (다음 모델 시도)
      if (msg.includes('overloaded') || msg.includes('high demand') ||
          msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('503')) {
        return null;
      }
      // tools 미지원 → tools 제거하고 재시도
      if (withSearch && (msg.includes('tool') || msg.includes('INVALID_ARGUMENT') || msg.includes('not supported'))) {
        const body2 = { ...body };
        delete body2.tools;
        return await tryCall(mdl, body2, apiKey, false);
      }
      return { error: d.error };
    }

    const reply = d?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (reply) return { reply };
    return null;
  } catch (e) {
    return null;
  }
}
