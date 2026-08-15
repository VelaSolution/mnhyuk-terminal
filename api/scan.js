export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  // 8개 코인 시세 수집
  const ids = 'bitcoin,ethereum,solana,ripple,dogecoin,cardano,avalanche-2,chainlink';
  const syms = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'ADA', 'AVAX', 'LINK'];

  let marketText = '';
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`, { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    const idMap = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP', dogecoin: 'DOGE', cardano: 'ADA', 'avalanche-2': 'AVAX', chainlink: 'LINK' };
    Object.entries(data).forEach(([id, d]) => {
      const sym = idMap[id] || id;
      marketText += `${sym}: $${d.usd} (${d.usd_24h_change >= 0 ? '+' : ''}${d.usd_24h_change?.toFixed(2)}%) vol=$${(d.usd_24h_vol / 1e6).toFixed(0)}M\n`;
    });
  } catch {
    // Binance Futures 폴백
    try {
      const pairs = syms.map(s => s + 'USDT');
      const bRes = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr`, { signal: AbortSignal.timeout(5000) });
      const bData = await bRes.json();
      for (const sym of syms) {
        const t = bData.find(d => d.symbol === sym + 'USDT');
        if (t) {
          marketText += `${sym}: $${parseFloat(t.lastPrice)} (${parseFloat(t.priceChangePercent) >= 0 ? '+' : ''}${parseFloat(t.priceChangePercent).toFixed(2)}%) vol=$${(parseFloat(t.quoteVolume) / 1e6).toFixed(0)}M\n`;
        }
      }
    } catch {
      return res.status(500).json({ error: 'Market data fetch failed (CoinGecko + Binance)' });
    }
  }

  const prompt = `당신은 암호화폐 스캐너입니다. 8개 코인의 현재 데이터를 보고 매매 기회를 평가하세요.

${marketText}

반드시 아래 JSON 형식으로만 응답하세요:
{
  "coins": [
    {"symbol": "BTC", "score": 1~10, "direction": "LONG" 또는 "SHORT" 또는 "NEUTRAL", "reason": "한줄 이유"},
    ...8개 전부
  ],
  "best": "가장 좋은 기회 종목 심볼",
  "recommendation": "전체 시장 한줄 코멘트 (한국어)"
}

score 기준: 1~3 약세, 4~6 중립, 7~10 강세 기회`;

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
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        result.timestamp = new Date().toISOString();
        return res.json(result);
      }
    } catch {}

    res.json({ coins: syms.map(s => ({ symbol: s, score: 5, direction: 'NEUTRAL', reason: '—' })), recommendation: text.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
