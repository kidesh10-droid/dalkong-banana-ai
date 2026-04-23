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

    // 실시간 검색 필요 여부
    const needsSearch = [
      '날씨','기온','오늘','내일','뉴스','최신','현재','지금','주가','시세',
      '환율','금리','유가','속보','실시간','주식','코스피','비트코인'
    ].some(k => lastMsg.includes(k));

    const baseBody = {
      system_instruction: { parts: [{ text: systemPrompt || '' }] },
      contents: trimmed,
      generationConfig: {
        temperature: 0.8,
        maxOutputTokens: 2048,
        topP: 0.95
      }
    };

    // 2026.04 현재 v1beta generateContent 확실히 동작하는 모델
    // gemini-2.5-flash 계열은 preview 접미사 필요, 없으면 1.5-flash 사용
    const WORKING_MODELS = [
      'gemini-1.5-flash',
      'gemini-1.5-pro',
      'gemini-1.5-flash-latest',
    ];

    // 요청 모델이 1.5 계열이면 그대로 사용, 아니면 1.5-flash 우선
    const startModel = (model && model.includes('1.5')) ? model : 'gemini-1.5-flash';
    const fallbacks = [startModel, ...WORKING_MODELS].filter((v,i,a) => v && a.indexOf(v) === i);

    for (const mdl of fallbacks) {
      const body = { ...baseBody };
      // 검색 도구 추가 (1.5 계열만 지원)
      if (needsSearch) {
        body.tools = [{ google_search: {} }];
      }
      const result = await tryCall(mdl, body, apiKey, needsSearch);
      if (result === null) { console.log(mdl, '과부하/실패, 다음 시도'); continue; }
      if (result.reply) return res.status(200).json({ reply: result.reply });
      if (result.error) {
        // 모델 없음 오류면 다음 모델 시도
        const msg = result.error.message || '';
        if (msg.includes('not found') || msg.includes('not supported') || msg.includes('no longer')) continue;
        return res.status(200).json({ error: result.error });
      }
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
      // 과부하/할당량 → null (다음 모델)
      if (msg.includes('overloaded') || msg.includes('high demand') ||
          msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('503')) {
        return null;
      }
      // tools 미지원 → tools 제거 재시도
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
