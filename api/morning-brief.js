// Morning Brief 자동 생성 API
// GET /api/morning-brief → 실시간 데이터로 채운 HTML 반환

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const TT = process.env.TRADING_TEAM_URL || 'http://158.247.252.39:8000';

  try {
    // 병렬로 데이터 수집 (VPS 프록시 경유)
    const [paperRes, calRes, pricesRes, fngRes, globalRes] = await Promise.allSettled([
      fetch(`${TT}/api/paper/status`, {signal: AbortSignal.timeout(8000)}).then(r=>r.json()),
      fetch(`${TT}/api/calendar`, {signal: AbortSignal.timeout(8000)}).then(r=>r.json()),
      Promise.all(['BTCUSDT','ETHUSDT','SOLUSDT','DOGEUSDT','AVAXUSDT','LINKUSDT','SUIUSDT','BNBUSDT','XRPUSDT','ADAUSDT'].map(s =>
        fetch('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol='+s, {signal: AbortSignal.timeout(8000)}).then(r=>r.json()).catch(()=>null)
      )).then(arr => arr.filter(Boolean)),
      fetch('https://api.alternative.me/fng/?limit=1', {signal: AbortSignal.timeout(5000)}).then(r=>r.json()),
      fetch('https://api.coingecko.com/api/v3/global', {signal: AbortSignal.timeout(8000)}).then(r=>r.json()),
    ]);

    const paper = paperRes.status === 'fulfilled' ? paperRes.value : {};
    const cal = calRes.status === 'fulfilled' ? calRes.value : {};
    const allPrices = pricesRes.status === 'fulfilled' && Array.isArray(pricesRes.value) ? pricesRes.value : [];
    const fng = fngRes.status === 'fulfilled' ? fngRes.value : {};
    const global = globalRes.status === 'fulfilled' ? globalRes.value : {};

    // 가격 추출
    const getPrice = (sym) => {
      const t = allPrices.find(x => x.symbol === sym + 'USDT');
      if (!t) return { price: '—', chg: null };
      return { price: '$' + parseFloat(t.lastPrice).toLocaleString('en-US', {maximumFractionDigits: t.lastPrice > 100 ? 0 : 2}), chg: parseFloat(t.priceChangePercent) };
    };

    const btc = getPrice('BTC');
    const eth = getPrice('ETH');
    const sol = getPrice('SOL');

    // Fear & Greed
    const fngVal = fng?.data?.[0]?.value || '—';
    const fngLabel = fng?.data?.[0]?.value_classification || '';

    // 글로벌 데이터
    const gd = global?.data || {};
    const btcDom = gd?.market_cap_percentage?.btc?.toFixed(1) || '—';
    const totalMcap = gd?.total_market_cap?.usd ? '$' + (gd.total_market_cap.usd / 1e12).toFixed(2) + 'T' : '—';

    // 펀딩/OI
    const btcTicker = allPrices.find(x => x.symbol === 'BTCUSDT') || {};
    const totalVol = allPrices.reduce((s, t) => s + parseFloat(t.quoteVolume || 0), 0);

    // 스탠스 판단
    const fngNum = parseInt(fngVal) || 50;
    const btcChg = btc.chg || 0;
    const stance = fngNum < 25 || btcChg < -3 ? 'RISK_OFF' : fngNum > 65 && btcChg > 2 ? 'RISK_ON' : 'NEUTRAL';

    // 날짜
    const now = new Date();
    const days = ['일','월','화','수','목','금','토'];
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} (${days[now.getDay()]})`;
    const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')} KST`;

    // 캘린더 이벤트 (오늘 + 이번 주)
    const events = (cal.events || []).slice(0, 7).map(e => {
      const d = new Date(e.date?.includes('T') ? e.date : e.date?.replace(' ','T') + 'Z');
      const isToday = d.toDateString() === now.toDateString();
      const dayLabel = isToday ? '오늘' : `${days[d.getDay()]} ${d.getMonth()+1}/${d.getDate()}`;
      const time = `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
      return { d: dayLabel, t: time, e: e.title, imp: e.impact === 'High' ? 3 : e.impact === 'Medium' ? 2 : 1 };
    });

    // 상위 변동 코인
    const topUp = [...allPrices].sort((a,b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent)).slice(0,3);
    const topDn = [...allPrices].sort((a,b) => parseFloat(a.priceChangePercent) - parseFloat(b.priceChangePercent)).slice(0,3);

    // 펀드 상태
    const capital = paper.capital || 3000;
    const returnPct = paper.returnPct || 0;
    const winRate = paper.winRate || 0;
    const positions = (paper.positions || []).length + (paper.swingPositions || []).length;

    // BTC 레벨 계산
    const btcPrice = parseFloat(btcTicker.lastPrice || 0);
    const btcHigh = parseFloat(btcTicker.highPrice || 0);
    const btcLow = parseFloat(btcTicker.lowPrice || 0);
    const r1 = Math.round(btcPrice * 1.015 / 100) * 100;
    const r2 = Math.round(btcPrice * 1.035 / 100) * 100;
    const s1 = Math.round(btcPrice * 0.985 / 100) * 100;
    const s2 = Math.round(btcPrice * 0.965 / 100) * 100;
    const ethPrice = parseFloat(allPrices.find(x=>x.symbol==='ETHUSDT')?.lastPrice || 0);
    const er1 = Math.round(ethPrice * 1.02);
    const er2 = Math.round(ethPrice * 1.04);
    const es1 = Math.round(ethPrice * 0.98);
    const es2 = Math.round(ethPrice * 0.96);

    // TL;DR 생성
    const tldr = `BTC ${btc.price} (${btcChg>=0?'+':''}${btcChg.toFixed(1)}%) · FNG ${fngVal} ${fngLabel} · 펀드 $${Math.round(capital)} (${returnPct>=0?'+':''}${returnPct.toFixed(1)}%) · 포지션 ${positions}개`;

    // DATA 객체 생성
    const DATA = {
      meta: { date: dateStr, issue: Math.floor((now - new Date('2026-01-01')) / 86400000), snapshot: timeStr, by: 'BILLION AI', stance, tldr },
      overnight: [
        { k: 'BTC/USDT', v: btc.price, chg: btc.chg, note: `24H H:$${Math.round(btcHigh).toLocaleString()} L:$${Math.round(btcLow).toLocaleString()}` },
        { k: 'ETH/USDT', v: eth.price, chg: eth.chg, note: `ETH/BTC ${(ethPrice/btcPrice).toFixed(5)}` },
        { k: 'SOL/USDT', v: sol.price, chg: sol.chg, note: '' },
        { k: 'Total MCap', v: totalMcap, chg: null, note: `BTC.D ${btcDom}%` },
        { k: '24H Volume', v: '$' + (totalVol/1e9).toFixed(1) + 'B', chg: null, note: 'Binance Futures' },
      ],
      metrics: [
        { k: 'Fear & Greed', v: `${fngVal} · ${fngLabel}`, tone: fngNum < 30 ? 'dn' : fngNum > 60 ? 'up' : 'am', note: '' },
        { k: 'BTC Dominance', v: btcDom + '%', tone: 'fl', note: '' },
        { k: '펀드 자본', v: `$${Math.round(capital)}`, tone: returnPct >= 0 ? 'up' : 'dn', note: `${returnPct>=0?'+':''}${returnPct.toFixed(1)}%` },
        { k: '승률', v: `${winRate.toFixed(0)}%`, tone: winRate >= 50 ? 'up' : 'dn', note: `${paper.totalTrades||0}건` },
        { k: '포지션', v: `${positions}개`, tone: positions > 0 ? 'am' : 'fl', note: paper.strategyMode || '' },
      ],
      levels: {
        btc: { sym: 'BTC', r: [r1.toLocaleString(), r2.toLocaleString()], s: [s1.toLocaleString(), s2.toLocaleString()] },
        eth: { sym: 'ETH', r: [er1.toLocaleString(), er2.toLocaleString()], s: [es1.toLocaleString(), es2.toLocaleString()] },
      },
      krw: [
        { k: '업비트 BTC 환산', v: '—', tone: 'fl', note: '실시간 확인 필요' },
        { k: 'BTC 김치프리미엄', v: '—', tone: 'fl', note: 'kimpga.com' },
        { k: 'ETH 김치프리미엄', v: '—', tone: 'fl', note: '' },
      ],
      news: [
        ...topUp.slice(0,2).map(t => ({ dir: '+', t: `${t.symbol.replace('USDT','')} +${parseFloat(t.priceChangePercent).toFixed(1)}% 급등`, impact: `$${(parseFloat(t.quoteVolume)/1e6).toFixed(0)}M 거래량`, src: 'Binance' })),
        ...topDn.slice(0,2).map(t => ({ dir: '-', t: `${t.symbol.replace('USDT','')} ${parseFloat(t.priceChangePercent).toFixed(1)}% 급락`, impact: `$${(parseFloat(t.quoteVolume)/1e6).toFixed(0)}M 거래량`, src: 'Binance' })),
      ],
      schedule: events,
      playbook: {
        up: { trigger: `${r1.toLocaleString()} 4H 종가 돌파`, plan: `리테스트 확인 후 진입 · 1차 ${r2.toLocaleString()} · 손절 ${(btcPrice*0.99).toLocaleString()}` },
        down: { trigger: `${s1.toLocaleString()} 이탈`, plan: `반등 실패 확인 후 진입 · 1차 ${s2.toLocaleString()} · 손절 ${(btcPrice*1.01).toLocaleString()}` },
        notrade: ['주요 지표 발표 전후 30분 진입 금지', `${s1.toLocaleString()}~${r1.toLocaleString()} 박스 내부 추격 금지`],
      },
      sources: 'Binance · CoinGecko · Alternative.me · FCS API · BILLION AI Engine',
    };

    // 템플릿을 자체 호스트에서 가져오기
    let template = '';
    try {
      const host = req.headers.host || 'terminal.mot-era.com';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      const tplRes = await fetch(`${proto}://${host}/morning-brief-template.html`, {signal: AbortSignal.timeout(5000)});
      if (tplRes.ok) template = await tplRes.text();
    } catch {}

    if (!template) {
      // 폴백: fs 시도
      try {
        const fs = require('fs');
        const path = require('path');
        template = fs.readFileSync(path.join(process.cwd(), 'public', 'morning-brief-template.html'), 'utf8');
      } catch {}
    }

    if (!template) {
      // 최종 폴백: JSON만 반환
      return res.json(DATA);
    }

    // DATA 객체를 템플릿에 주입
    const output = template.replace(
      /const DATA = \{[\s\S]*?\n\};/,
      'const DATA = ' + JSON.stringify(DATA, null, 2) + ';'
    );

    res.send(output);
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.split('\n').slice(0,5).join(' | ') });
  }
}
