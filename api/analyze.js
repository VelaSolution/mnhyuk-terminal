export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { symbol, marketData } = req.body || {};
  const sym = (symbol || 'BTC').toUpperCase();

  // 시장 데이터 수집
  let priceData = marketData;
  if (!priceData) {
    try {
      const ids = { BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple', DOGE: 'dogecoin', ADA: 'cardano', AVAX: 'avalanche-2', LINK: 'chainlink' };
      const id = ids[sym] || sym.toLowerCase();
      const [priceRes, fgRes] = await Promise.all([
        fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`),
        fetch('https://api.alternative.me/fng/?limit=1'),
      ]);
      const prices = await priceRes.json();
      const fg = await fgRes.json();
      priceData = { prices, fearGreed: fg?.data?.[0] };
    } catch { priceData = {}; }
  }

  const prompt = `당신은 암호화폐 트레이딩 분석가입니다.
아래 시장 데이터를 기반으로 ${sym} 종합 분석을 해주세요.

시장 데이터:
${JSON.stringify(priceData, null, 2)}

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "decision": "BUY" 또는 "SELL" 또는 "HOLD",
  "confidence": 1~10 숫자,
  "entry": 추천 진입가 (숫자),
  "sl": 손절가 (숫자),
  "tp1": 1차 익절가 (숫자),
  "tp2": 2차 익절가 (숫자),
  "summary": "한줄 요약 (한국어)",
  "reasons": ["근거1", "근거2", "근거3"]
}`;

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
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    // JSON 파싱
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const analysis = JSON.parse(jsonMatch[0]);
        analysis.symbol = sym;
        analysis.timestamp = new Date().toISOString();
        return res.json(analysis);
      }
    } catch {}

    res.json({ decision: 'HOLD', confidence: 5, summary: text.slice(0, 200), symbol: sym, timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
