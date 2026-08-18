// Morning Brief 자동 생성 API — 강화판
// GET /api/morning-brief → 실시간 데이터로 채운 HTML 반환

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const TT = process.env.TRADING_TEAM_URL || 'http://158.247.252.39:8000';

  try {
    // 병렬 데이터 수집
    const [paperRes, calRes, tapeRes, fngRes, globalRes, upbitRes, krwRes, newsRes, fundingRes] = await Promise.allSettled([
      fetch(`${TT}/api/paper/status`, {signal: AbortSignal.timeout(8000)}).then(r=>r.json()),
      fetch(`${TT}/api/calendar`, {signal: AbortSignal.timeout(8000)}).then(r=>r.json()),
      fetch(`${TT}/api/tape`, {signal: AbortSignal.timeout(8000)}).then(r=>r.json()),
      fetch('https://api.alternative.me/fng/?limit=1', {signal: AbortSignal.timeout(5000)}).then(r=>r.json()),
      fetch('https://api.coingecko.com/api/v3/global', {signal: AbortSignal.timeout(8000)}).then(r=>r.json()),
      fetch('https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-ETH', {signal: AbortSignal.timeout(5000)}).then(r=>r.json()),
      fetch('https://api.exchangerate-api.com/v4/latest/USD', {signal: AbortSignal.timeout(5000)}).then(r=>r.json()),
      fetch('https://min-api.cryptocompare.com/data/v2/news/?lang=EN&limit=6', {signal: AbortSignal.timeout(8000)}).then(r=>r.json()),
      fetch('https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT', {signal: AbortSignal.timeout(5000)}).then(r=>r.json()),
    ]);

    const paper = paperRes.status === 'fulfilled' ? paperRes.value : {};
    const cal = calRes.status === 'fulfilled' ? calRes.value : {};
    const tape = tapeRes.status === 'fulfilled' && Array.isArray(tapeRes.value) ? tapeRes.value : [];
    const fng = fngRes.status === 'fulfilled' ? fngRes.value : {};
    const gdata = globalRes.status === 'fulfilled' ? globalRes.value : {};
    const upbit = upbitRes.status === 'fulfilled' && Array.isArray(upbitRes.value) ? upbitRes.value : [];
    const krwData = krwRes.status === 'fulfilled' ? krwRes.value : {};
    const newsData = newsRes.status === 'fulfilled' ? newsRes.value : {};
    const funding = fundingRes.status === 'fulfilled' ? fundingRes.value : {};

    // 가격 (tape 형식)
    const tp = (sym) => tape.find(x => x.sym === sym) || {};
    const btcRaw = tp('BTC').price || 0;
    const ethRaw = tp('ETH').price || 0;
    const solRaw = tp('SOL').price || 0;
    const btcChg = tp('BTC').changePct || 0;
    const ethChg = tp('ETH').changePct || 0;
    const solChg = tp('SOL').changePct || 0;
    const fmtP = (p) => p > 100 ? '$' + Math.round(p).toLocaleString() : p > 0 ? '$' + p.toFixed(2) : '—';

    // 글로벌
    const gd = gdata?.data || {};
    const btcDom = gd?.market_cap_percentage?.btc?.toFixed(1) || '—';
    const totalMcap = gd?.total_market_cap?.usd ? '$' + (gd.total_market_cap.usd / 1e12).toFixed(2) + 'T' : '—';
    const totalVol = gd?.total_volume?.usd ? '$' + (gd.total_volume.usd / 1e9).toFixed(1) + 'B' : '—';

    // Fear & Greed
    const fngVal = fng?.data?.[0]?.value || '—';
    const fngLabel = fng?.data?.[0]?.value_classification || '';
    const fngNum = parseInt(fngVal) || 50;

    // 원/달러
    const usdKrw = krwData?.rates?.KRW || 0;
    const krwStr = usdKrw ? '₩' + Math.round(usdKrw).toLocaleString() : '—';

    // 업비트 KRW-BTC
    const upbtc = upbit.find(u => u.market === 'KRW-BTC') || {};
    const upeth = upbit.find(u => u.market === 'KRW-ETH') || {};
    const upBtcPrice = upbtc.trade_price || 0;
    const upEthPrice = upeth.trade_price || 0;
    const upBtcStr = upBtcPrice ? '₩' + Math.round(upBtcPrice).toLocaleString() : '—';

    // 김프 계산
    let kimchiBtc = '—';
    let kimchiEth = '—';
    if (btcRaw > 0 && upBtcPrice > 0 && usdKrw > 0) {
      const kp = ((upBtcPrice / usdKrw / btcRaw) - 1) * 100;
      kimchiBtc = (kp >= 0 ? '+' : '') + kp.toFixed(2) + '%';
    }
    if (ethRaw > 0 && upEthPrice > 0 && usdKrw > 0) {
      const kp = ((upEthPrice / usdKrw / ethRaw) - 1) * 100;
      kimchiEth = (kp >= 0 ? '+' : '') + kp.toFixed(2) + '%';
    }

    // 전통 시장 (tape에서)
    const nasdaq = tp('SNDK'); // 나스닥 추종 ETF
    const gold = tp('XAU');
    const oil = tp('CL');
    const dxy = tp('DXY');

    // 펀딩
    const fundingRate = funding?.lastFundingRate ? (parseFloat(funding.lastFundingRate) * 100).toFixed(4) + '%' : '—';
    const fundingApr = funding?.lastFundingRate ? (parseFloat(funding.lastFundingRate) * 3 * 365 * 100).toFixed(1) + '%' : '—';

    // 펀드 상태
    const capital = paper.capital || 3000;
    const returnPct = paper.returnPct || 0;
    const winRate = paper.winRate || 0;
    const positions = (paper.positions || []).length + (paper.swingPositions || []).length;

    // 스탠스
    const stance = fngNum < 25 || btcChg < -3 ? 'RISK_OFF' : fngNum > 65 && btcChg > 2 ? 'RISK_ON' : 'NEUTRAL';

    // 날짜
    const now = new Date();
    const dayNames = ['일','월','화','수','목','금','토'];
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} (${dayNames[now.getDay()]})`;
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} KST`;

    // 레벨 계산
    const r1 = Math.round(btcRaw * 1.015 / 100) * 100;
    const r2 = Math.round(btcRaw * 1.035 / 100) * 100;
    const s1 = Math.round(btcRaw * 0.985 / 100) * 100;
    const s2 = Math.round(btcRaw * 0.965 / 100) * 100;
    const er1 = Math.round(ethRaw * 1.02);
    const er2 = Math.round(ethRaw * 1.04);
    const es1 = Math.round(ethRaw * 0.98);
    const es2 = Math.round(ethRaw * 0.96);

    // 캘린더 (오늘 + 이번 주 7개)
    const events = (cal.events || []).slice(0, 7).map(e => {
      const d = new Date(e.date?.includes('T') ? e.date : (e.date || '').replace(' ','T') + 'Z');
      const isToday = d.toDateString() === now.toDateString();
      const dayLabel = isToday ? '오늘' : `${dayNames[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`;
      const time = isNaN(d) ? '—' : `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      return { d: dayLabel, t: time, e: e.title || '', imp: e.impact === 'High' ? 3 : e.impact === 'Medium' ? 2 : 1 };
    });

    // 뉴스 (CryptoCompare)
    const rawNews = Array.isArray(newsData?.Data) ? newsData.Data : [];
    const newsItems = rawNews.slice(0, 6).map(n => {
      const title = n.title || '';
      const bullish = /surge|soar|rally|bull|approve|adopt|etf|inflow|record/i.test(title);
      const bearish = /crash|plunge|dump|bear|hack|ban|lawsuit|outflow|warning/i.test(title);
      const dir = bullish ? '+' : bearish ? '-' : 'o';
      const src = (n.source_info && n.source_info.name) || n.source || 'CryptoCompare';
      return { dir, t: title.slice(0, 60), impact: (n.body || '').slice(0, 40), src };
    });

    // TL;DR
    const moodWord = fngNum < 25 ? '극심한 공포' : fngNum < 40 ? '공포' : fngNum < 55 ? '중립' : fngNum < 70 ? '탐욕' : '극심한 탐욕';
    const tldr = `BTC ${fmtP(btcRaw)} (${btcChg>=0?'+':''}${btcChg.toFixed(1)}%) · FNG ${fngVal} (${moodWord}) · 김프 ${kimchiBtc} · 펀드 $${Math.round(capital)} (${returnPct>=0?'+':''}${returnPct.toFixed(1)}%)`;

    const DATA = {
      meta: { date: dateStr, issue: Math.floor((now - new Date('2026-01-01')) / 86400000), snapshot: timeStr, by: 'BILLION AI', stance, tldr },
      overnight: [
        { k: 'BTC/USDT', v: fmtP(btcRaw), chg: btcChg || null, note: '' },
        { k: 'ETH/USDT', v: fmtP(ethRaw), chg: ethChg || null, note: `ETH/BTC ${btcRaw ? (ethRaw/btcRaw).toFixed(5) : '—'}` },
        { k: 'SOL/USDT', v: fmtP(solRaw), chg: solChg || null, note: '' },
        { k: 'GOLD', v: gold.price ? '$' + gold.price.toFixed(0) : '—', chg: gold.changePct || null, note: '' },
        { k: 'WTI 유가', v: oil.price ? '$' + oil.price.toFixed(2) : '—', chg: oil.changePct || null, note: '' },
        { k: 'Total MCap', v: totalMcap, chg: null, note: `BTC.D ${btcDom}%` },
        { k: '24H Volume', v: totalVol, chg: null, note: '' },
      ],
      metrics: [
        { k: 'BTC 펀딩 (8h)', v: fundingRate, tone: 'fl', note: `연 ${fundingApr}` },
        { k: 'Fear & Greed', v: `${fngVal} · ${fngLabel}`, tone: fngNum < 30 ? 'dn' : fngNum > 60 ? 'up' : 'am', note: '' },
        { k: 'BTC Dominance', v: btcDom + '%', tone: 'fl', note: '' },
        { k: '펀드 자본', v: `$${Math.round(capital)}`, tone: returnPct >= 0 ? 'up' : 'dn', note: `${returnPct>=0?'+':''}${returnPct.toFixed(1)}%` },
        { k: '승률', v: `${winRate.toFixed(0)}%`, tone: winRate >= 50 ? 'up' : 'dn', note: `${paper.totalTrades||0}건` },
        { k: 'ETH/BTC', v: btcRaw ? (ethRaw/btcRaw).toFixed(5) : '—', tone: 'fl', note: '' },
        { k: '포지션', v: `${positions}개`, tone: positions > 0 ? 'am' : 'fl', note: paper.strategyMode || '' },
      ],
      levels: {
        btc: { sym: 'BTC', r: [r1.toLocaleString(), r2.toLocaleString()], s: [s1.toLocaleString(), s2.toLocaleString()] },
        eth: { sym: 'ETH', r: [er1.toLocaleString(), er2.toLocaleString()], s: [es1.toLocaleString(), es2.toLocaleString()] },
      },
      krw: [
        { k: '원/달러', v: krwStr, tone: 'fl', note: '' },
        { k: '업비트 BTC', v: upBtcStr, tone: 'fl', note: `김프 ${kimchiBtc}` },
        { k: 'BTC 김치프리미엄', v: kimchiBtc, tone: kimchiBtc.startsWith('+') ? 'up' : kimchiBtc.startsWith('-') ? 'dn' : 'fl', note: `ETH 김프 ${kimchiEth}` },
      ],
      news: newsItems.length > 0 ? newsItems : [
        { dir: 'o', t: '뉴스 수집 실패 — 수동 확인 필요', impact: '', src: '—' },
      ],
      schedule: events.length > 0 ? events : [
        { d: '오늘', t: '—', e: '주요 일정 없음', imp: 1 },
      ],
      playbook: {
        up: { trigger: `${r1.toLocaleString()} 4H 종가 돌파`, plan: `리테스트 확인 후 진입 · 1차 ${r2.toLocaleString()} · 손절 ${Math.round(btcRaw*0.99).toLocaleString()}` },
        down: { trigger: `${s1.toLocaleString()} 이탈`, plan: `반등 실패 확인 후 진입 · 1차 ${s2.toLocaleString()} · 손절 ${Math.round(btcRaw*1.01).toLocaleString()}` },
        notrade: ['주요 지표 발표 전후 30분 진입 금지', `${s1.toLocaleString()}~${r1.toLocaleString()} 박스 내부 추격 금지`, '유가 ±3% 급변 시 신규 진입 보류'],
      },
      sources: 'Binance · CoinGecko · Upbit · Alternative.me · CryptoCompare · FCS API · ExchangeRate-API · BILLION AI',
    };

    // 템플릿 가져오기
    let template = '';
    try {
      const host = req.headers.host || 'terminal.mot-era.com';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const tplRes = await fetch(`${proto}://${host}/morning-brief-template.html`, {signal: AbortSignal.timeout(5000)});
      if (tplRes.ok) template = await tplRes.text();
    } catch {}
    if (!template) {
      try { const fs = require('fs'), path = require('path'); template = fs.readFileSync(path.join(process.cwd(), 'public', 'morning-brief-template.html'), 'utf8'); } catch {}
    }
    if (!template) return res.json(DATA);

    const output = template.replace(/const DATA = \{[\s\S]*?\n\};/, 'const DATA = ' + JSON.stringify(DATA, null, 2) + ';');
    res.send(output);
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,5).join(' | ') });
  }
}
