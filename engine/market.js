// ═══════════════════════════════════════
// MARKET DATA — Binance Futures + 부가 데이터
// 코인 선물 전용 (USDT 무기한)
// ═══════════════════════════════════════

const { computeIndicators } = require('./indicators');

const COINS = ['BTC','ETH','SOL','XRP','DOGE','ADA','AVAX','LINK','BNB','SUI','PEPE','WIF','TON','LTC','DOT','NEAR'];
const COINGECKO_IDS = {BTC:'bitcoin',ETH:'ethereum',SOL:'solana',XRP:'ripple',DOGE:'dogecoin',ADA:'cardano',AVAX:'avalanche-2',LINK:'chainlink',BNB:'binancecoin',SUI:'sui',PEPE:'pepe',WIF:'dogwifcoin',TON:'the-open-network',LTC:'litecoin',DOT:'polkadot',NEAR:'near'};

function resolveSymbol(input) {
  const sym = (input || 'BTC').toUpperCase().replace('USDT','').replace('-','');
  if (COINS.includes(sym) || sym.length <= 6) {
    return { kind: 'crypto', symbol: sym, display: sym, pair: sym + 'USDT' };
  }
  return { kind: 'crypto', symbol: sym, display: sym, pair: sym + 'USDT' };
}

async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': 'CryptoTradingTeam/1.0', ...opts.headers } });
    return r;
  } finally { clearTimeout(timer); }
}

// CoinGecko 5분 캐시 (Rate Limit 방지)
const cgCache = new Map(); // key: cgId, value: { data, ts }
const CG_CACHE_TTL = 5 * 60 * 1000;

// 파생 데이터 5분 캐시 (Funding/OI/L-S 빈번 호출 방지)
const derivCache = new Map();
const DERIV_CACHE_TTL = 5 * 60 * 1000;

// 뉴스 1시간 캐시 (변동성 낮음)
const newsCache = new Map();
const NEWS_CACHE_TTL = 60 * 60 * 1000;

async function fetchCoinGecko(cgId) {
  const cached = cgCache.get(cgId);
  if (cached && Date.now() - cached.ts < CG_CACHE_TTL) return cached.data;
  const r = await fetchWithTimeout(`https://api.coingecko.com/api/v3/coins/${cgId}?localization=false&tickers=false&community_data=false&developer_data=false&sparkline=false`);
  const data = await r.json();
  cgCache.set(cgId, { data, ts: Date.now() });
  return data;
}

async function fetchMarket(resolved) {
  const { symbol, pair } = resolved;
  const result = { symbol, pair, kind: 'crypto' };

  // 1. Candles (4H, 120봉)
  try {
    const r = await fetchWithTimeout(`https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=4h&limit=120`);
    const raw = await r.json();
    if (!Array.isArray(raw) || raw.length < 30) throw new Error('Insufficient candle data');
    result.candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
  } catch (e) {
    throw new Error(`캔들 데이터 실패: ${e.message}`);
  }

  // 2. Indicators
  result.indicators = computeIndicators(result.candles);
  result.priceLine = `${symbol}USDT $${result.indicators.price.toLocaleString()} (${result.indicators.changePct24h >= 0 ? '+' : ''}${result.indicators.changePct24h}%)`;

  // 3. Fundamentals (CoinGecko)
  try {
    const cgId = COINGECKO_IDS[symbol];
    if (cgId) {
      const d = await fetchCoinGecko(cgId);
      const m = d.market_data || {};
      result.fundamentals = {
        lines: [
          `시가총액: $${(m.market_cap?.usd / 1e9)?.toFixed(2) || '?'}B (#${d.market_cap_rank || '?'})`,
          `24h 거래대금: $${(m.total_volume?.usd / 1e9)?.toFixed(2) || '?'}B`,
          `유통공급: ${(m.circulating_supply / 1e6)?.toFixed(1) || '?'}M / 최대: ${m.max_supply ? (m.max_supply / 1e6).toFixed(1) + 'M' : '무제한'}`,
          `ATH: $${m.ath?.usd?.toLocaleString() || '?'} (${m.ath_change_percentage?.usd?.toFixed(1) || '?'}%)`,
          `7d: ${m.price_change_percentage_7d?.toFixed(1) || '?'}% · 30d: ${m.price_change_percentage_30d?.toFixed(1) || '?'}%`,
        ],
      };
    } else {
      result.fundamentals = { lines: ['데이터 없음'] };
    }
  } catch { result.fundamentals = { lines: ['CoinGecko 조회 실패'] }; }

  // 4. Derivatives (Funding, OI, L/S) — 5분 캐시
  try {
    const derivCached = derivCache.get(pair);
    let fund = {}, oi = {}, ls = [];
    if (derivCached && Date.now() - derivCached.ts < DERIV_CACHE_TTL) {
      fund = derivCached.fund; oi = derivCached.oi; ls = derivCached.ls;
    } else {
      const [fundR, oiR, lsR] = await Promise.all([
        fetchWithTimeout(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pair}`),
        fetchWithTimeout(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${pair}`),
        fetchWithTimeout(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${pair}&period=1h&limit=5`).catch(() => null),
      ]);
      fund = fundR && fundR.ok ? await fundR.json().catch(() => ({})) : {};
      oi = oiR && oiR.ok ? await oiR.json().catch(() => ({})) : {};
      ls = lsR && lsR.ok ? await lsR.json().catch(() => []) : [];
      derivCache.set(pair, { fund, oi, ls, ts: Date.now() });
    }

    result.derivatives = {
      lines: [
        `펀딩레이트: ${(parseFloat(fund.lastFundingRate || 0) * 100).toFixed(4)}%`,
        `미결제약정(OI): ${parseFloat(oi.openInterest || 0).toLocaleString()} ${symbol} ($${(parseFloat(oi.openInterest || 0) * result.indicators.price / 1e9).toFixed(2)}B)`,
        ls[0] ? `롱/숏 비율: ${(parseFloat(ls[0].longAccount) * 100).toFixed(1)}% / ${(parseFloat(ls[0].shortAccount) * 100).toFixed(1)}%` : '롱숏 비율: 데이터 없음',
      ],
      fundingRate: parseFloat(fund.lastFundingRate || 0),
      openInterest: parseFloat(oi.openInterest || 0),
      longRatio: ls[0] ? parseFloat(ls[0].longAccount) : 0.5,
    };
  } catch { result.derivatives = { lines: ['파생 데이터 조회 실패'], fundingRate: 0, openInterest: 0, longRatio: 0.5 }; }

  // 5. Sentiment (F&G)
  try {
    const r = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1');
    const d = await r.json();
    const fg = d?.data?.[0];
    result.sentiment = {
      lines: [
        fg ? `공포탐욕지수: ${fg.value} (${fg.value_classification})` : '공포탐욕: 데이터 없음',
        `펀딩 기울기: ${result.derivatives?.fundingRate > 0.0005 ? '과열(롱 과밀)' : result.derivatives?.fundingRate < -0.0005 ? '냉각(숏 과밀)' : '중립'}`,
        `롱숏: ${result.derivatives?.longRatio > 0.6 ? '롱 우세 — 역발상 숏 주의' : result.derivatives?.longRatio < 0.4 ? '숏 우세 — 역발상 롱 가능' : '균형'}`,
      ],
      fearGreed: fg ? parseInt(fg.value) : 50,
      fgClass: fg?.value_classification || '—',
    };
  } catch { result.sentiment = { lines: ['심리 데이터 조회 실패'], fearGreed: 50, fgClass: '—' }; }

  // 6. News (Google News RSS) — 1시간 캐시
  try {
    const newsCached = newsCache.get(symbol);
    if (newsCached && Date.now() - newsCached.ts < NEWS_CACHE_TTL) {
      result.news = newsCached.data;
    } else {
      const q = encodeURIComponent(`${symbol} crypto`);
      const r = await fetchWithTimeout(`https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`);
      const xml = await r.text();
      const headlines = [];
      const re = /<item>([\s\S]*?)<\/item>/g;
      let m;
      while ((m = re.exec(xml)) && headlines.length < 8) {
        const title = (m[1].match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
        const pubDate = (m[1].match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
        if (title) {
          const age = pubDate ? Math.round((Date.now() - Date.parse(pubDate)) / 3600000) + 'h' : '';
          headlines.push({ title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), age });
        }
      }
      result.news = { headlines };
      newsCache.set(symbol, { data: result.news, ts: Date.now() });
    }
  } catch { result.news = { headlines: [] }; }

  return result;
}

async function fetchTape() {
  try {
    const r = await fetchWithTimeout('https://fapi.binance.com/fapi/v1/ticker/24hr');
    const all = await r.json();
    return all
      .filter(t => t.symbol.endsWith('USDT'))
      .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
      .slice(0, 20)
      .map(t => ({
        sym: t.symbol.replace('USDT', ''),
        price: parseFloat(t.lastPrice),
        changePct: parseFloat(t.priceChangePercent),
      }));
  } catch { return []; }
}

// 원본 server.js 호환용 — 코인 전용이라 한국 주식 전광판 없음
const KR_STOCKS = {};
async function fetchVenueBoard() { return null; }

module.exports = { resolveSymbol, fetchMarket, fetchTape, fetchVenueBoard, KR_STOCKS, COINS };
