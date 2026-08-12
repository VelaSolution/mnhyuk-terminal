export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { message, context } = req.body || {};
  if (!message) return res.status(400).json({ error: 'No message' });

  const systemPrompt = `당신은 MNHYUK CRYPTO TERMINAL의 AI 어시스턴트입니다.
트레이더를 위한 크립토 분석 전문가입니다.

=== 규칙 ===
- 반드시 "대표님"이라고 호칭하세요. 이름 부르기 금지.
- 따뜻하고 편안한 해요체 사용. "~습니다" 금지, "~이에요", "~해요" 사용.
- 최대 3~4줄. 핵심만 간결하게.
- 마크다운 금지. 이모지 금지.
- 숫자/데이터는 정확하게.

=== 역할 ===
- 시장 상황 분석, 차트 해석, 매매 전략 조언
- 코인 비교, 진입/손절/익절 의견
- 온체인, 펀딩, 청산, 고래 데이터 해석
- 일반 대화도 자연스럽게 대응

현재 터미널 컨텍스트:
${context || '(없음)'}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    res.json({ text });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
