'use strict';

// MOTERA TRADING TEAM — 시스템 진단 도구
// 실행: node server/doctor.js
// API 연결, 퀀트 시그널, 마켓 데이터, 에이전트 전부 진단

const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const line = (s = '') => console.log(s);
const ok = (s) => console.log('  [정상] ' + s);
const bad = (s) => console.log('  [문제] ' + s);
const info = (s) => console.log('         ' + s);

(async () => {
  line('====================================');
  line('  MOTERA TRADING TEAM — 시스템 진단');
  line('====================================');
  line(`OS: ${os.platform()} ${os.release()} · Node ${process.version}`);
  line(`프로젝트: ${path.join(__dirname, '..')}`);
  line();

  let problems = 0;

  // 1) 환경변수 점검
  line('[1] 환경변수 점검');
  if (process.env.ANTHROPIC_API_KEY) {
    ok(`ANTHROPIC_API_KEY 설정됨 (${process.env.ANTHROPIC_API_KEY.slice(0, 10)}...)`);
  } else {
    bad('ANTHROPIC_API_KEY 미설정 — AI 에이전트 분석 불가');
    problems += 1;
  }
  if (process.env.TELEGRAM_BOT_TOKEN) {
    ok('TELEGRAM_BOT_TOKEN 설정됨');
  } else {
    info('TELEGRAM_BOT_TOKEN 미설정 — 텔레그램 알림 비활성');
  }
  line();

  // 2) Anthropic API 연결 테스트
  line('[2] Anthropic API 연결');
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const t0 = Date.now();
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 10,
          messages: [{ role: 'user', content: 'Say OK' }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      if (res.ok) {
        ok(`API 응답 정상 (${secs}초)`);
      } else {
        const err = await res.text();
        bad(`API 응답 오류 HTTP ${res.status}: ${err.slice(0, 200)}`);
        problems += 1;
      }
    } catch (e) {
      bad(`API 연결 실패: ${e.message}`);
      problems += 1;
    }
  } else {
    info('API 키 없어 건너뜀');
  }
  line();

  // 3) Binance Futures API 연결
  line('[3] Binance Futures API 연결');
  try {
    const t0 = Date.now();
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/price?symbol=BTCUSDT', {
      signal: AbortSignal.timeout(10000),
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (res.ok) {
      const data = await res.json();
      ok(`BTC 현재가: $${parseFloat(data.price).toLocaleString()} (${secs}초)`);
    } else {
      bad(`Binance API HTTP ${res.status}`);
      problems += 1;
    }
  } catch (e) {
    bad(`Binance 연결 실패: ${e.message}`);
    problems += 1;
  }
  line();

  // 4) 마켓 데이터 수집 테스트
  line('[4] 마켓 데이터 수집 (market.js)');
  try {
    const { resolveSymbol, fetchMarket } = require('./market');
    const t0 = Date.now();
    const resolved = resolveSymbol('BTC');
    const market = await fetchMarket(resolved);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    ok(`BTC 마켓 데이터 수집 성공 (${secs}초)`);
    info(`캔들: ${market.candles?.length || 0}개, 가격: ${market.priceLine || '-'}`);
  } catch (e) {
    bad(`마켓 데이터 실패: ${e.message}`);
    problems += 1;
  }
  line();

  // 5) 퀀트 시그널 생성 테스트
  line('[5] 퀀트 시그널 (quant-signals.js)');
  try {
    const quantSignals = require('./quant-signals');
    const t0 = Date.now();
    const signal = await quantSignals.getSignalForSymbol('BTC');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    ok(`BTC 시그널: ${signal.action} ${signal.grade}등급 (점수 ${signal.totalScore}, ${secs}초)`);
    info(`RSI: ${signal.indicators?.rsi || '-'}, 확신도: ${signal.confidence}%`);
  } catch (e) {
    bad(`퀀트 시그널 실패: ${e.message}`);
    problems += 1;
  }
  line();

  // 6) 실시간 가격 피드 테스트
  line('[6] 실시간 가격 피드 (price-feed.js)');
  try {
    const priceFeed = require('./price-feed');
    const btcPrice = priceFeed.getPrice('BTC');
    if (btcPrice && btcPrice > 0) {
      ok(`BTC 캐시 가격: $${btcPrice.toLocaleString()}`);
    } else {
      info('가격 캐시 비어있음 (서버 시작 전이면 정상)');
    }
  } catch (e) {
    bad(`가격 피드 오류: ${e.message}`);
    problems += 1;
  }
  line();

  // 7) 에이전트 실행 테스트 (TARO)
  line('[7] AI 에이전트 실행 (TARO)');
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      const { resolveSymbol, fetchMarket } = require('./market');
      const { runAgent } = require('./agents');
      const resolved = resolveSymbol('BTC');
      const market = await fetchMarket(resolved);
      const t1 = Date.now();
      const res = await runAgent('taro', { market, mode: 'scalp' }, { mock: false });
      const s2 = ((Date.now() - t1) / 1000).toFixed(1);
      if (String(res.bubble).includes('분석 실패')) {
        bad(`에이전트 실패 (${s2}초)`);
        info(String(res.report).split('\n').slice(0, 5).join('\n         '));
        problems += 1;
      } else {
        ok(`에이전트 정상 (${s2}초, 브리핑 ${String(res.report).length}자)`);
        info(String(res.bubble).slice(0, 80));
      }
    } catch (e) {
      bad('에이전트 실행 오류: ' + (e.message || String(e)));
      problems += 1;
    }
  } else {
    info('API 키 없어 건너뜀');
  }
  line();

  // 8) 외부 서비스 연결
  line('[8] 외부 서비스 연결');
  const services = [
    { name: 'CoinGecko', url: 'https://api.coingecko.com/api/v3/ping' },
    { name: 'Alternative.me (FNG)', url: 'https://api.alternative.me/fng/?limit=1' },
  ];
  for (const svc of services) {
    try {
      const res = await fetch(svc.url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) ok(`${svc.name} 연결 정상`);
      else bad(`${svc.name} HTTP ${res.status}`);
    } catch {
      bad(`${svc.name} 연결 실패`);
    }
  }
  line();

  line('====================================');
  if (problems === 0) {
    line('  결과: 모든 시스템 정상 ✅');
  } else {
    line(`  결과: 문제 ${problems}건 발견 ❌`);
  }
  line('====================================');
})();
