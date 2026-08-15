let cache = { data: null, ts: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5분 캐시

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL) {
    return res.json(cache.data);
  }

  const ttUrl = process.env.TRADING_TEAM_URL || 'https://trading-team.mot-era.com';
  let live = false;
  let ttHealth = null;

  try {
    const r = await fetch(`${ttUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) {
      ttHealth = await r.json();
      live = true;
    }
  } catch {}

  const result = {
    ok: true,
    live,
    order: !!process.env.BINANCE_API_KEY,
    tg: !!process.env.TELEGRAM_BOT_TOKEN,
    pin: !!process.env.ANTHROPIC_API_KEY,
    tradingTeam: ttHealth,
    ts: new Date().toISOString(),
  };

  cache = { data: result, ts: now };
  res.json(result);
}
