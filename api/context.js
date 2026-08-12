// ══════════════════════════════════════════════
// TERMINAL CONTEXT — 터미널의 모든 정보를 한 번에 반환
// Billion(비서)이 통합 상황 인식에 사용
// ══════════════════════════════════════════════

const TRADING_TEAM_URL = process.env.TRADING_TEAM_URL || 'http://localhost:8000';

async function fetchWithTimeout(url, opts = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

// ── 시세 테이프 (Trading Team 또는 CoinGecko 폴백) ──
async function fetchPrices() {
  try {
    const ttRes = await fetchWithTimeout(`${TRADING_TEAM_URL}/api/tape`, {}, 4000);
    if (ttRes.ok) {
      const tape = await ttRes.json();
      if (Array.isArray(tape)) {
        return tape.slice(0, 8).map(t => ({
          symbol: t.symbol,
          price: t.price,
          change24h: typeof t.change24h === 'number' ? Number(t.change24h.toFixed(2)) : t.changePct,
          volume: t.volume,
        }));
      }
    }
  } catch {}

  // CoinGecko 폴백
  try {
    const ids = 'bitcoin,ethereum,solana,ripple,dogecoin,cardano,avalanche-2,chainlink';
    const cgRes = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
      {}, 5000
    );
    const data = await cgRes.json();
    const idMap = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP', dogecoin: 'DOGE', cardano: 'ADA', 'avalanche-2': 'AVAX', chainlink: 'LINK' };
    return Object.entries(data).map(([id, d]) => ({
      symbol: idMap[id] || id.toUpperCase(),
      price: d.usd,
      change24h: typeof d.usd_24h_change === 'number' ? Number(d.usd_24h_change.toFixed(2)) : null,
      volume: d.usd_24h_vol,
    }));
  } catch {}

  return [];
}

// ── 뉴스 (RSS) ──
async function fetchNews() {
  const feeds = [
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
    { url: 'https://cointelegraph.com/rss', source: 'CoinTelegraph' },
    { url: 'https://www.blockmedia.co.kr/feed/', source: 'BlockMedia' },
  ];

  for (const feed of feeds) {
    try {
      const r = await fetchWithTimeout(feed.url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }, 5000);
      const text = await r.text();

      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(text)) !== null && items.length < 5) {
        const xml = match[1];
        const title = (xml.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
        const pubDate = (xml.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';

        if (title) {
          const cleanTitle = title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;/g, "'").replace(/&quot;/g, '"');
          const ts = pubDate ? Date.parse(pubDate) : Date.now();
          const ageMin = Math.round((Date.now() - ts) / 60000);
          const age = ageMin < 60 ? `${ageMin}분 전` : ageMin < 1440 ? `${Math.round(ageMin / 60)}시간 전` : `${Math.round(ageMin / 1440)}일 전`;

          items.push({ title: cleanTitle, source: feed.source, age, ts });
        }
      }

      if (items.length > 0) return items;
    } catch {}
  }

  return [];
}

// ── 공포탐욕지수 ──
async function fetchFearGreed() {
  try {
    const res = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', {}, 4000);
    const data = await res.json();
    const entry = data?.data?.[0];
    if (entry) {
      return {
        value: parseInt(entry.value),
        label: entry.value_classification,
        timestamp: entry.timestamp,
      };
    }
  } catch {}
  return null;
}

// ── 경제 캘린더 (하드코딩 + 동적 계산) ──
function getEconomicCalendar() {
  const events = [
    { date: '2026-08-13', event: 'CPI (소비자물가지수)', importance: 'high' },
    { date: '2026-08-14', event: 'PPI (생산자물가지수)', importance: 'medium' },
    { date: '2026-08-27', event: 'Consumer Confidence', importance: 'medium' },
    { date: '2026-09-04', event: 'ADP 고용보고서', importance: 'medium' },
    { date: '2026-09-05', event: 'NFP (비농업고용)', importance: 'high' },
    { date: '2026-09-10', event: 'CPI (소비자물가지수)', importance: 'high' },
    { date: '2026-09-16', event: 'FOMC 회의 시작', importance: 'high' },
    { date: '2026-09-17', event: 'FOMC 금리결정', importance: 'critical' },
    { date: '2026-10-03', event: 'NFP (비농업고용)', importance: 'high' },
    { date: '2026-10-14', event: 'CPI (소비자물가지수)', importance: 'high' },
    { date: '2026-11-04', event: 'FOMC 회의 시작', importance: 'high' },
    { date: '2026-11-05', event: 'FOMC 금리결정', importance: 'critical' },
    { date: '2026-11-12', event: 'CPI (소비자물가지수)', importance: 'high' },
    { date: '2026-12-10', event: 'CPI (소비자물가지수)', importance: 'high' },
    { date: '2026-12-16', event: 'FOMC 회의 시작', importance: 'high' },
    { date: '2026-12-17', event: 'FOMC 금리결정', importance: 'critical' },
  ];

  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // 오늘 이후 + 오늘 포함 최대 5개
  return events
    .filter(e => e.date >= todayStr)
    .slice(0, 5)
    .map(e => {
      const eventDate = new Date(e.date + 'T00:00:00');
      const diffDays = Math.ceil((eventDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
      const daysLabel = diffDays === 0 ? '오늘' : diffDays === 1 ? '내일' : `${diffDays}일 후`;
      return { ...e, daysUntil: diffDays, daysLabel };
    });
}

// ── 터미널 내부 상태 (gateway에서 공유되는 전역 상태는 없으므로 기본값) ──
function getTerminalStatus() {
  return {
    status: 'LIVE',
    role: 'TERMINAL (컨트롤 타워)',
    uptime: process.uptime?.() || 0,
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // 병렬 fetch
  const [prices, news, fearGreed] = await Promise.allSettled([
    fetchPrices(),
    fetchNews(),
    fetchFearGreed(),
  ]);

  const calendar = getEconomicCalendar();
  const terminal = getTerminalStatus();

  res.json({
    prices: prices.status === 'fulfilled' ? prices.value : [],
    news: news.status === 'fulfilled' ? news.value : [],
    calendar,
    fearGreed: fearGreed.status === 'fulfilled' ? fearGreed.value : null,
    alerts: [], // 향후 시장 알림 시스템 확장용
    terminal,
    timestamp: new Date().toISOString(),
  });
}
