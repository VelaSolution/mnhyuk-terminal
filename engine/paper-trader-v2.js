'use strict';

/**
 * Paper Trader v2 — 13-Agent AI 가상매매 (리팩토링 완료)
 *
 * Trading Team 13명이 분석 → BUY/SELL 판정 → 자동 진입/청산
 * $3,000 시작, 10코인 로테이션, 15분 간격 분석
 *
 * 분리된 모듈:
 * - telegram-bot.js    : 텔레그램 알림 + 명령어 봇
 * - position-manager.js : 포지션 체크/청산/트레일링/재진입
 * - risk-manager.js     : 리스크 관리/검증/포트폴리오/attribution
 */

const fs = require('fs');
const path = require('path');
const { Engine } = require('./engine');
const learner = require('./learner');
const quantSignals = require('./quant-signals');
const backtester = require('./backtester');
const telegramBot = require('./telegram-bot');
const positionManager = require('./position-manager');
const riskManager = require('./risk-manager');
const portfolioEngine = require('./portfolio-engine');

const STATE_FILE = path.join(__dirname, '..', 'reports', 'paper-trading.json');
const HISTORY_FILE = path.join(__dirname, '..', 'reports', 'paper-trades.json');
const DECISIONS_FILE = path.join(__dirname, '..', 'reports', 'decisions.json');
const POSITION_REVIEW_INTERVAL = 15 * 60 * 1000;

// ── 설정 ──
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE', 'LINK', 'SUI', 'PEPE', 'WIF', 'TON'];
const SWING_SYMBOLS = ['BTC', 'ETH', 'SOL'];
const ANALYSIS_INTERVAL = 10 * 60 * 1000; // 15→10분 (빠른 대응)
const TOP_ANALYZE_COUNT = 4; // 3→4개 더 많이 분석
const SWING_ANALYSIS_INTERVAL = 20 * 60 * 1000; // 30→20분
const POSITION_CHECK_INTERVAL = 45 * 1000; // 60→45초 (빠른 청산)
const FAST_SCAN_INTERVAL = 3 * 60 * 1000; // 5→3분 패스트스캔
const HEDGE_CHECK_INTERVAL = 30 * 60 * 1000;
const HIGH_VOL_HOURS = new Set([0, 1, 2, 3, 13, 14, 15, 16]);

const CONFIG = {
  startCapital: 3000,
  riskPerTrade: 0.015, // 2%→1.5% (작게 자주 = 복리)
  maxPositions: 4, // 3→4 (기회 더 잡기)
  maxSwingPositions: 2,
  minConfidence: 50, // 과다거래 방지
  minGrade: 'D',
  maxHoldHours: 24, // 48→24시간 (안 되면 빨리 손절)
  maxSwingHoldHours: 120, // 168→120시간
  circuitBreakerLosses: 4, // 3→4 (너무 쉽게 멈추지 않기)
  circuitBreakerHours: 12, // 24→12시간 (빨리 복귀)
  feeMaker: 0.0002,
};

const GRADE_ORDER = { 'A': 5, 'B': 4, 'C': 3, 'D': 2, 'F': 1 };
const GRADE_MULTIPLIER = { 'A': 1.5, 'B': 1.3, 'C': 1.0, 'D': 0.5, 'F': 0 };
const DAILY_LOSS_LIMIT = -200; // -150→-200 (여유)
const WEEKLY_MAX_LOSS = -500; // -400→-500
const TOTAL_MAX_DD = 0.20;
const SL_PATTERN_BLOCK_HOURS = 48;
const REENTRY_DELAY_MS = 30 * 60 * 1000;

const CORRELATION_GROUPS = [
  ['BTC', 'ETH'],
  ['SOL', 'AVAX', 'SUI'],
  ['DOGE', 'PEPE', 'WIF'],
];

const DASHBOARD_URL = 'https://trading-team.mot-era.com/dashboard';
const TERMINAL_URL = 'https://terminal.mot-era.com';

// ── 상태 관리 ──
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {}
  return {
    capital: CONFIG.startCapital, startCapital: CONFIG.startCapital,
    positions: [], swingPositions: [],
    totalTrades: 0, wins: 0, losses: 0, totalPnl: 0,
    peakCapital: CONFIG.startCapital, maxDrawdown: 0,
    consecutiveLosses: 0, consecutiveWins: 0,
    circuitBreakerUntil: 0, lastAnalysisIdx: 0, lastAnalysisTs: 0,
    lastSwingAnalysisTs: 0, lastSwingIdx: 0,
    reentryQueue: [], slPatterns: [], coinPerformance: {},
    priceAlerts: [], skipList: [], analysisLog: [],
    lastReviewTs: 0, drawdownHaltUntil: 0,
    startedAt: new Date().toISOString(), lastUpdated: new Date().toISOString(),
    version: 'v2-ai',
  };
}

function saveState(state) {
  state.lastUpdated = new Date().toISOString();
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (e) {
    console.error('[paper-v2] 상태 저장 실패:', e.message);
  }
}

function appendTrade(trade) {
  try {
    let trades = [];
    if (fs.existsSync(HISTORY_FILE)) {
      trades = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
    trades.push(trade);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(trades, null, 2), 'utf-8');
  } catch {}
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

// ── 최근 판정 로드 ──
function loadDecisions() {
  try {
    if (fs.existsSync(DECISIONS_FILE)) {
      return JSON.parse(fs.readFileSync(DECISIONS_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function getRecentDecision(symbol) {
  const decisions = loadDecisions();
  for (let i = decisions.length - 1; i >= 0; i--) {
    const d = decisions[i];
    if (d.symbol === symbol || d.symbol === symbol + 'USDT' || d.symbol === symbol + '/USDT') return d;
  }
  return null;
}

// ── 학습 lesson 기록 (청산 시 호출) ──
async function recordLesson(pos, exitPrice, netPnl, closeReason, hoursHeld) {
  try {
    let rsi = null, macdHist = null, sma20Dist = null, sma50Dist = null;
    let volatility24h = null, fundingRate = null, fearGreed = null;
    let volume24hPct = null, candlePattern = null, srPosition = null;

    try {
      const { computeIndicators } = require('./indicators');
      const pair = pos.symbol + 'USDT';
      const candleRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=4h&limit=120`, { signal: AbortSignal.timeout(5000) });
      if (candleRes.ok) {
        const raw = await candleRes.json();
        if (Array.isArray(raw) && raw.length >= 30) {
          const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
          const ind = computeIndicators(candles);
          rsi = ind.rsi14 != null ? Math.round(ind.rsi14 * 10) / 10 : null;
          macdHist = ind.macd ? Math.round(ind.macd.hist * 100) / 100 : null;
          sma20Dist = ind.sma20 && ind.price ? Math.round((ind.price - ind.sma20) / ind.sma20 * 10000) / 100 : null;
          sma50Dist = ind.sma50 && ind.price ? Math.round((ind.price - ind.sma50) / ind.sma50 * 10000) / 100 : null;
          volatility24h = ind.volatilityPct != null ? Math.round(ind.volatilityPct * 10) / 10 : null;
          candlePattern = learner.analyzeCandlePattern(candles.slice(-5));
          const sr = learner.findSupportResistance(candles);
          srPosition = learner.classifySRPosition(pos.entryPrice, sr);
        }
      }
    } catch {}

    try {
      const frRes = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pos.symbol}USDT`, { signal: AbortSignal.timeout(3000) });
      if (frRes.ok) {
        const fr = await frRes.json();
        fundingRate = Math.round(parseFloat(fr.lastFundingRate || 0) * 10000) / 100;
      }
    } catch {}

    try {
      const fgRes = await fetch('https://api.alternative.me/fng/?limit=1', { signal: AbortSignal.timeout(3000) });
      if (fgRes.ok) {
        const fgData = await fgRes.json();
        fearGreed = fgData?.data?.[0] ? parseInt(fgData.data[0].value) : null;
      }
    } catch {}

    const now = new Date();
    const lesson = {
      symbol: pos.symbol, direction: pos.direction,
      entry: pos.entryPrice, exit: exitPrice,
      slPrice: pos.slPrice || null, tpPrice: pos.tpPrice || null,
      pnl: Math.round(netPnl * 100) / 100, isWin: netPnl > 0,
      grade: pos.grade || 'D', confidence: pos.confidence || 0,
      mode: pos.strategy || 'scalp', multiTfConfirmed: pos.multiTfConfirmed || false,
      candlePattern, srPosition, rsi, macdHist, sma20Dist, sma50Dist,
      volume24hPct, fundingRate, fearGreed,
      hourUtc: now.getUTCHours(), dayOfWeek: now.getUTCDay(),
      volatility24h, closeReason,
      holdHours: Math.round(hoursHeld * 10) / 10,
      rationale: (pos.rationale || '').slice(0, 200),
      timestamp: now.toISOString(),
    };

    const totalLessons = learner.appendLesson(lesson);

    if (totalLessons >= 5 && totalLessons % 10 === 0) {
      console.log(`[learner] ${totalLessons}건 도달 — 자동 학습 실행`);
      const result = learner.analyzeLessons();
      if (result) {
        telegramBot.sendTelegram(
          `🧠 <b>자동 학습 완료 (${totalLessons}건)</b>\n\n` +
          `승률: ${result.overallWinRate}%\n` +
          `규칙: ${result.rules.length}개\n` +
          `최고 패턴: ${result.bestPatterns.length}개\n` +
          `최악 패턴: ${result.worstPatterns.length}개\n\n` +
          (result.rules.slice(0, 3).map(r => `• ${r}`).join('\n') || '')
        );
      }
    }
  } catch (e) {
    console.error('[learner] lesson 기록 실패:', e.message);
  }
}

// ── 실시간 가격 ──
async function fetchPrice(symbol) {
  const pair = symbol.replace('/', '') + (symbol.includes('USDT') ? '' : 'USDT');
  try {
    const url = `https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) { const d = await res.json(); const p = parseFloat(d.price); if (p > 0) return p; }
  } catch (e) { console.log(`[paper-v2] ${symbol} 선물API 실패: ${e.message}`); }
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) { const d = await res.json(); const p = parseFloat(d.price); if (p > 0) return p; }
  } catch (e) { console.log(`[paper-v2] ${symbol} 현물API 실패: ${e.message}`); }
  try { const priceFeed = require('./price-feed'); return priceFeed.getPrice(pair); } catch {}
  return null;
}

// ── 시장 레짐 감지 ──
let _cachedMarketRegime = { regime: 'NORMAL', btcChange: 0, ts: 0 };

async function detectMarketRegime() {
  const now = Date.now();
  if (now - _cachedMarketRegime.ts < 5 * 60 * 1000) return _cachedMarketRegime;
  try {
    const res = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=BTCUSDT', { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const d = await res.json();
      const btcChange = parseFloat(d.priceChangePercent) || 0;
      const absPct = Math.abs(btcChange);
      let regime = 'NORMAL';
      if (absPct > 5) regime = 'HIGH_VOLATILITY';
      else if (absPct < 1) regime = 'LOW_VOLATILITY';
      _cachedMarketRegime = { regime, btcChange, ts: now };
      console.log(`[paper-v2] 시장 레짐: ${regime} (BTC 24h: ${btcChange > 0 ? '+' : ''}${btcChange.toFixed(2)}%)`);
    }
  } catch {}
  return _cachedMarketRegime;
}

// ── 24h 변동성 ──
async function fetch24hVolatility(symbol) {
  try {
    const pair = symbol.replace('/', '') + (symbol.includes('USDT') ? '' : 'USDT');
    const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${pair}`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const d = await res.json();
      const high = parseFloat(d.highPrice), low = parseFloat(d.lowPrice);
      const mid = (high + low) / 2;
      if (mid > 0) return ((high - low) / mid) * 100;
    }
  } catch {}
  return 3.0;
}

// ── 변동성 기반 코인 우선순위 ──
async function getVolatilityRanking() {
  const results = [];
  for (const sym of SYMBOLS) {
    try {
      const res = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${sym}USDT`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const d = await res.json();
        results.push({ symbol: sym, changePct: Math.abs(parseFloat(d.priceChangePercent) || 0) });
      }
    } catch {}
  }
  return results.sort((a, b) => b.changePct - a.changePct);
}

// ── 분석 모드 선택 (시장 레짐 연동) ──
async function selectMode(state) {
  if (state.forceMode) return state.forceMode;
  const hour = new Date().getUTCHours();
  if (HIGH_VOL_HOURS.has(hour) && state.positions.length === 0) return 'attack';
  if (state.positions.length >= 2) return 'scalp';

  // 시장 레짐 기반 모드 전환
  try {
    const sig = await quantSignals.getSignalForSymbol('BTC');
    const regime = sig?.regime?.regime;
    if (regime === 'TRENDING_UP' || regime === 'TRENDING_DOWN') return 'algo';
    if (regime === 'VOLATILE') return 'attack';
    if (regime === 'RANGING') return 'scalp';
  } catch {}

  return 'scalp';
}

// ── 단일 모드 분석 실행 ──
async function runSingleAnalysis(symbol, mode) {
  const engine = new Engine();
  return new Promise((resolve) => {
    let decision = null;
    engine.on('event', (evt) => { if (evt.type === 'decision') decision = evt; });
    engine.run(symbol, { mock: false, mode })
      .then(() => resolve(decision || null))
      .catch((e) => { console.error(`[paper-v2] ${symbol} ${mode} 분석 실패:`, e.message); resolve(null); });
  });
}

// ── 13-agent 분석 실행 + 멀티 타임프레임 확인 ──
async function runAnalysis(symbol, mode) {
  console.log(`[paper-v2] ${symbol} 분석 시작 (${mode} 모드)...`);
  const decision = await runSingleAnalysis(symbol, mode);
  if (!decision) return null;

  const action = (decision.action || '').toUpperCase();
  console.log(`[paper-v2] ${symbol} ${mode} 판정: ${action} (${decision.confidence}%) 등급 ${decision.grade || '?'}`);
  if (action !== 'BUY' && action !== 'SELL') return decision;

  // 퀀트 멀티TF 크로스체크 (에이전트 2회 실행 대신 빠른 지표 기반)
  try {
    const multiTF = await quantSignals.getMultiTFSignal(symbol);
    const mtfAction = (multiTF.action || '').toUpperCase();
    if (mtfAction === action) {
      decision.confidence = Math.min((decision.confidence || 0) + 10, 95);
      decision.multiTfConfirmed = true;
      console.log(`[paper-v2] ${symbol} 멀티TF 확인 ✅ (${action})`);
    } else if ((mtfAction === 'BUY' && action === 'SELL') || (mtfAction === 'SELL' && action === 'BUY')) {
      // 충돌해도 차단 안 함 — 확신도만 낮춤 (기존: HOLD 강제)
      decision.confidence = Math.max((decision.confidence || 0) - 15, 30);
      decision.divergenceFiltered = true;
      console.log(`[paper-v2] ${symbol} 멀티TF 충돌 → 확신 -15 (AI:${action} vs TF:${mtfAction})`);
    }
  } catch (e) {
    console.log(`[paper-v2] ${symbol} 멀티TF 크로스체크 실패: ${e.message}`);
  }
  return decision;
}

// ── 자동 전략 재검토 ──
async function triggerStrategyReview(reason) {
  try {
    console.log(`[paper-v2] 전략 재검토 시작 (사유: ${reason})`);
    const result = await backtester.selectBestStrategy(['BTC', 'ETH', 'SOL'], 30);
    const state = _state || loadState();
    const prev = state.activeStrategy || 'confluence';
    if (result.best) {
      state.activeStrategy = result.best;
      state.activeStrategyUpdated = new Date().toISOString();
      state.lastStrategyReviewTs = Date.now();
      saveState(state);
      const changed = prev !== result.best;
      telegramBot.sendTelegram(
        `🔄 <b>전략 재검토 완료</b> (${reason})\n━━━━━━━━━━━━━━━\n` +
        `이전: ${prev}\n${changed ? '변경' : '유지'}: <b>${result.best}</b> (${result.bestName})\n` +
        (changed ? '⚠️ 전략이 자동 전환되었습니다' : '✅ 기존 전략이 최적으로 확인됨')
      );
    }
  } catch (e) {
    console.error(`[paper-v2] 전략 재검토 실패: ${e.message}`);
  }
}

// ── 일일/주간 PnL 계산 유틸 ──
function calcTodayPnl(history) {
  const today = new Date().toISOString().slice(0, 10);
  let pnl = 0;
  for (const t of history) { if ((t.exitTime || '').slice(0, 10) === today) pnl += t.pnl || 0; }
  return pnl;
}

function calcWeeklyPnl(history) {
  const weekStart = new Date(); weekStart.setDate(weekStart.getDate() - weekStart.getDay()); weekStart.setHours(0, 0, 0, 0);
  let pnl = 0;
  for (const t of history) { if ((t.exitTime || '').slice(0, 10) >= weekStart.toISOString().slice(0, 10)) pnl += t.pnl || 0; }
  return pnl;
}

// ── 자동 skip: 최근 N건에서 연속 실패 코인 감지 ──
function autoSkipCheck(state, history) {
  const CONSECUTIVE_FAIL_THRESHOLD = 5; // 3→5 (너무 빨리 스킵하면 기회 놓침)
  const recentBySymbol = {};
  const recent = history.slice(-100);
  for (const t of recent) {
    if (!t.symbol) continue;
    if (!recentBySymbol[t.symbol]) recentBySymbol[t.symbol] = [];
    recentBySymbol[t.symbol].push(t.pnl > 0);
  }
  let changed = false;
  for (const [sym, results] of Object.entries(recentBySymbol)) {
    const lastN = results.slice(-CONSECUTIVE_FAIL_THRESHOLD);
    if (lastN.length >= CONSECUTIVE_FAIL_THRESHOLD && lastN.every(r => !r)) {
      if (!state.skipList.includes(sym)) {
        state.skipList.push(sym);
        state.autoSkipTs = state.autoSkipTs || {};
        state.autoSkipTs[sym] = Date.now();
        console.log(`[paper-v2] ${sym} ${CONSECUTIVE_FAIL_THRESHOLD}연패 → 자동 skip`);
        changed = true;
      }
    }
  }
  // 24시간 경과한 자동 skip 해제
  if (state.autoSkipTs) {
    for (const [sym, ts] of Object.entries(state.autoSkipTs)) {
      if (Date.now() - ts > 24 * 3600000) {
        const idx = state.skipList.indexOf(sym);
        if (idx !== -1) { state.skipList.splice(idx, 1); console.log(`[paper-v2] ${sym} 자동 skip 해제 (24h 경과)`); }
        delete state.autoSkipTs[sym];
        changed = true;
      }
    }
  }
  return changed;
}

// ── 메인 분석 + 진입 루프 ──
async function analyzeAndTrade(state, notifyFn) {
  const now = Date.now();

  if (state.circuitBreakerUntil > now) { console.log(`[paper-v2] 서킷브레이커 ${Math.round((state.circuitBreakerUntil - now) / 3600000 * 10) / 10}h 남음`); return; }

  const effectiveMax = riskManager.getEffectiveMaxPositions(state);
  if (state.positions.length >= effectiveMax) { console.log(`[paper-v2] 최대 포지션 (${state.positions.length}/${effectiveMax})`); return; }

  const history = loadHistory();

  // 자동 skip 체크
  if (autoSkipCheck(state, history)) saveState(state);
  const todayPnl = calcTodayPnl(history);
  if (todayPnl <= DAILY_LOSS_LIMIT) { console.log(`[paper-v2] 일일 손실 한도 도달`); return; }
  const weeklyPnl = calcWeeklyPnl(history);
  if (weeklyPnl <= WEEKLY_MAX_LOSS) { console.log(`[paper-v2] 주간 손실 한도 도달`); return; }

  // 최대 낙폭 체크
  const ddCheck = riskManager.checkDrawdownProtection(state, now);
  if (ddCheck.halt) {
    if (ddCheck.currentDD >= TOTAL_MAX_DD && (!state.drawdownHaltUntil || state.drawdownHaltUntil <= now)) {
      // 모든 포지션 강제 청산 + 24시간 중단
      const allPos = [...state.positions, ...(state.swingPositions || [])];
      for (const pos of allPos) {
        try {
          const price = await fetchPrice(pos.symbol);
          if (!price) continue;
          const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
          const pnl = isLong ? (price - pos.entryPrice) * pos.quantity : (pos.entryPrice - price) * pos.quantity;
          const fee = pos.quantity * price * CONFIG.feeMaker * 2;
          const netPnl = pnl - fee;
          state.capital += netPnl; state.totalPnl += netPnl; state.totalTrades++;
          if (netPnl > 0) state.wins++; else state.losses++;
          appendTrade({
            symbol: pos.symbol, direction: pos.direction, grade: pos.grade, confidence: pos.confidence,
            entryPrice: pos.entryPrice, exitPrice: price, slPrice: pos.slPrice, tpPrice: pos.tpPrice,
            quantity: pos.quantity, pnl: Math.round(netPnl * 100) / 100,
            pnlPct: Math.round(netPnl / pos.costBasis * 10000) / 100,
            closeReason: 'MAX_DD', entryTime: pos.entryTime, exitTime: new Date().toISOString(),
            hoursHeld: Math.round((Date.now() - pos.entryTs) / 3600000 * 10) / 10,
            capitalAfter: Math.round(state.capital * 100) / 100,
          });
        } catch (e) { console.error(`[paper-v2] DD 청산 실패 ${pos.symbol}: ${e.message}`); }
      }
      state.positions = []; state.swingPositions = [];
      state.drawdownHaltUntil = now + 24 * 3600000;
      saveState(state);
      telegramBot.sendTelegram(
        `⚠️ <b>최대 낙폭 ${(ddCheck.currentDD * 100).toFixed(1)}% 도달</b>\n\n` +
        `모든 포지션 청산 완료\n24시간 거래 중단\n자본: $${state.capital.toFixed(0)}`
      );
      backtester.selectBestStrategy(['BTC', 'ETH', 'SOL'], 30).then(result => {
        if (result && result.best) { state.activeStrategy = result.best; saveState(state); }
      }).catch(() => {});
    }
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) { console.log('[paper-v2] ANTHROPIC_API_KEY 미설정'); return; }

  const regime = await detectMarketRegime();
  let regimeRiskMult = 1.0, regimeMinConf = CONFIG.minConfidence;
  let regimeSlMult = 1.0, regimeTpMult = 1.0; // 레짐별 SL/TP 배율
  if (regime.regime === 'HIGH_VOLATILITY') {
    regimeRiskMult = 0.7; // 사이즈 줄이되 (0.5→0.7 덜 줄임)
    regimeSlMult = 1.3;   // SL 넓게 (변동성 큰 만큼 여유)
    regimeTpMult = 1.5;   // TP도 넓게 (큰 움직임 잡기)
  } else if (regime.regime === 'LOW_VOLATILITY') {
    regimeMinConf = 50;   // 확신 기준 약간만 높임 (60→50)
    regimeSlMult = 0.8;   // SL 타이트 (움직임 적으니)
    regimeTpMult = 0.7;   // TP도 타이트 (작은 수익 빨리 확보)
  }

  const openSymbols = new Set(state.positions.map(p => p.symbol));
  const skipSet = new Set(state.skipList || []);

  let ranked = [];
  try { ranked = await getVolatilityRanking(); } catch { ranked = SYMBOLS.map(s => ({ symbol: s, changePct: 0 })); }
  const available = ranked.filter(r => !openSymbols.has(r.symbol) && !skipSet.has(r.symbol));
  if (available.length === 0) return;

  // TOP 6 → 퀀트 사전 필터링 (D등급도 분석은 하되 사이즈 축소)
  const top6 = available.slice(0, 6);
  const quantFiltered = [];
  for (const coin of top6) {
    try {
      const qSig = await quantSignals.getSignalForSymbol(coin.symbol);
      // D등급도 통과시킴 — 사이즈만 줄여서 기회 놓치지 않기
      quantFiltered.push({ ...coin, quantSignal: qSig });
    } catch (e) {
      quantFiltered.push({ ...coin, quantSignal: null });
    }
  }
  if (quantFiltered.length === 0) { saveState(state); return; }

  const analyzeTargets = quantFiltered.slice(0, TOP_ANALYZE_COUNT);
  const mode = await selectMode(state);
  state.lastAnalysisTs = now; saveState(state);

  const analysisResults = await Promise.all(
    analyzeTargets.map(async (target) => {
      try {
        const decision = await runAnalysis(target.symbol, mode);
        return { symbol: target.symbol, decision, quantSignal: target.quantSignal };
      } catch (e) {
        return { symbol: target.symbol, decision: null, quantSignal: target.quantSignal };
      }
    })
  );

  for (const result of analysisResults) {
    const { symbol, decision, quantSignal } = result;
    if (!decision) continue;

    if (state.positions.length >= riskManager.getEffectiveMaxPositions(state)) break;

    // 퀀트 병합
    if (quantSignal) {
      const merged = quantSignals.mergeSignals(decision, quantSignal);
      decision.action = merged.action; decision.confidence = merged.confidence;
      decision.quantMergeReason = merged.reason; decision.quantScore = quantSignal.totalScore;
      decision.quantGrade = quantSignal.grade; decision.quantBreakdown = quantSignal.breakdown;
    }

    // Kelly Criterion: 기대값 음수면 진입 차단
    let kellyMultiplier = 1.0;
    try {
      const sizeHistory = loadHistory();
      if (sizeHistory.length >= 20) {
        const winTrades = sizeHistory.filter(t => (t.pnl || 0) > 0);
        const lossTrades = sizeHistory.filter(t => (t.pnl || 0) <= 0);
        const sizeWinRate = sizeHistory.length > 0 ? winTrades.length / sizeHistory.length : 0;
        const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length : 0;
        const avgLoss = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length) : 1;
        const sizing = quantSignals.calculatePositionSize(state.capital, sizeWinRate, avgWin, avgLoss);
        if (!sizing.isPositive) {
          console.log(`[paper-v2] ${symbol} Kelly 기대값 음수 ($${sizing.expectancy}) → 진입 차단`);
          continue; // 기대값 음수면 진입 차단
        }
      }
    } catch {}

    const action = (decision.action || '').toUpperCase();
    const confidence = decision.confidence || 0;
    const grade = decision.grade || 'D';

    if (!state.analysisLog) state.analysisLog = [];
    state.analysisLog.push({ symbol, action, confidence, grade, quantScore: decision.quantScore || null, ts: new Date().toISOString() });
    if (state.analysisLog.length > 200) state.analysisLog = state.analysisLog.slice(-200);

    if (action !== 'BUY' && action !== 'SELL') continue;
    if (confidence < Math.max(CONFIG.minConfidence, regimeMinConf)) continue;
    if ((GRADE_ORDER[grade] || 0) < (GRADE_ORDER[CONFIG.minGrade] || 0)) continue;
    if (riskManager.isPatternBlocked(state, symbol, action)) continue;

    // 상관관계 필터 (같은 그룹 같은 방향 1개까지 허용 — 분산 강제)
    const allPositions = [...state.positions, ...(state.swingPositions || [])];
    let corrBlocked = false;
    for (const group of CORRELATION_GROUPS) {
      if (group.includes(symbol)) {
        const sameGroupSameDir = allPositions.filter(p => group.includes(p.symbol) && p.direction === action);
        if (sameGroupSameDir.length >= 1) { corrBlocked = true; break; }
      }
    }
    if (corrBlocked) continue;

    const validation = await riskManager.validateEntry(symbol, action);
    if (!validation.ok) continue;

    const currentPrice = await fetchPrice(symbol);
    if (!currentPrice) continue;

    const volatility = await fetch24hVolatility(symbol);
    let volMultiplier = volatility > 5 ? 1.5 : volatility < 2 ? 0.7 : 1.0;

    // 학습 필터 (충분한 데이터 있을 때만 — 차단 대신 확신도 조정)
    try {
      const totalLessons = learner.loadLessons ? learner.loadLessons().length : 0;
      if (totalLessons >= 30) { // 30건 이상일 때만 학습 필터 적용
        let learnerRsi = null, learnerMacdHist = null;
        try {
          const { computeIndicators } = require('./indicators');
          const candleRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}USDT&interval=4h&limit=120`, { signal: AbortSignal.timeout(5000) });
          if (candleRes.ok) {
            const raw = await candleRes.json();
            if (Array.isArray(raw) && raw.length >= 30) {
              const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
              const ind = computeIndicators(candles);
              learnerRsi = ind.rsi14; learnerMacdHist = ind.macd ? ind.macd.hist : null;
            }
          }
        } catch {}
        const marketState = { rsi: learnerRsi, macdHist: learnerMacdHist, volatility24h: volatility, direction: action, symbol, confidence };
        const worstCheck = learner.checkWorstPatterns(marketState);
        if (worstCheck.blocked) { decision.confidence = Math.max((decision.confidence || 0) - 15, 30); } // 차단→확신감소
        const bestCheck = learner.checkBestPatterns(marketState);
        if (bestCheck.boost > 0) decision.confidence = Math.min((decision.confidence || 0) + bestCheck.boost, 95);
      }
    } catch {}

    // 시간 가중: 최악 시간대 진입 차단 (swing과 동일)
    try {
      const timeWeight = quantSignals.getTimeWeightScore();
      if (timeWeight.isWorstHour) {
        console.log(`[paper-v2] ${symbol} 최악 시간대 ${timeWeight.currentHour}h UTC → 진입 차단`);
        continue;
      }
      if (timeWeight.isBestHour) {
        decision.confidence = Math.min((decision.confidence || 0) + 10, 95);
      }
    } catch {}

    // 진입/손절/목표 설정 (ATR 기반 동적 SL/TP 우선)
    const entry = (typeof decision.entry === 'number' ? decision.entry : parseFloat(String(decision.entry).replace(/[^0-9.]/g, ''))) || currentPrice;
    const stop = (typeof decision.stop === 'number' ? decision.stop : parseFloat(String(decision.stop).replace(/[^0-9.]/g, ''))) || 0;
    const target = parseFloat(String(decision.target || '').replace(/[^0-9.]/g, '')) || 0;
    const defaultSlPct = 0.02 * volMultiplier, defaultTpPct = 0.04 * volMultiplier;

    let slPrice, tpPrice;
    let usedATR = false;

    // ATR 기반 동적 SL/TP (4h ATR + 레짐 연동)
    try {
      const atrStops = await quantSignals.getATRStops(symbol, action);
      if (atrStops && atrStops.atr14 > 0) {
        // getATRStops가 이미 4h ATR × 1.5/2.5를 계산해줌 → 레짐 배율만 적용
        const slDist2 = atrStops.slDist * regimeSlMult;
        const tpDist2 = atrStops.tpDist * regimeTpMult;
        slPrice = action === 'BUY' ? atrStops.price - slDist2 : atrStops.price + slDist2;
        tpPrice = action === 'BUY' ? atrStops.price + tpDist2 : atrStops.price - tpDist2;
        usedATR = true;
        const rr = (tpDist2 / slDist2).toFixed(2);
        console.log(`[paper-v2] ${symbol} ATR SL/TP: ATR=${atrStops.atr14}, SL=${(slDist2/atrStops.price*100).toFixed(2)}%, TP=${(tpDist2/atrStops.price*100).toFixed(2)}%, R:R=${rr} [${regime.regime}]`);
      }
    } catch {}

    if (!usedATR) {
      if (stop > 0 && target > 0) {
        const adjustedSlDist = Math.abs(entry - stop) * volMultiplier;
        slPrice = action === 'BUY' ? entry - adjustedSlDist : entry + adjustedSlDist;
        tpPrice = target;
      } else {
        const slDist = currentPrice * defaultSlPct;
        slPrice = action === 'BUY' ? currentPrice - slDist : currentPrice + slDist;
        tpPrice = action === 'BUY' ? currentPrice + slDist * 2 : currentPrice - slDist * 2;
      }
    }

    if (action === 'BUY') { if (slPrice >= entry) slPrice = entry * (1 - defaultSlPct); if (tpPrice <= entry) tpPrice = entry * (1 + defaultTpPct); }
    else { if (slPrice <= entry) slPrice = entry * (1 + defaultSlPct); if (tpPrice >= entry) tpPrice = entry * (1 - defaultTpPct); }
    if (Math.abs(tpPrice - entry) / entry > 0.50) { const slDist2 = Math.abs(entry - slPrice); tpPrice = action === 'BUY' ? entry + slDist2 * 3 : entry - slDist2 * 3; }
    if (Math.abs(slPrice - entry) / entry < 0.01) { slPrice = action === 'BUY' ? entry * 0.98 : entry * 1.02; } // 최소 SL 1% (노이즈 방지)

    // 최소 R:R 1.2 강제 — 불리한 거래 차단
    const rrCheck = Math.abs(tpPrice - entry) / Math.abs(slPrice - entry);
    if (rrCheck < 1.2) {
      console.log(`[paper-v2] ${symbol} R:R ${rrCheck.toFixed(2)} < 1.2 → 진입 차단`);
      continue;
    }

    const LEVERAGE = state.leverage || 20;
    const dynamicRisk = riskManager.getDynamicRisk(state);
    const gradeMult = GRADE_MULTIPLIER[grade] || 1.0;
    const coinWeight = riskManager.getCoinWeight(state, symbol);
    const adjustedRisk = dynamicRisk * gradeMult * coinWeight * regimeRiskMult * kellyMultiplier;
    const riskAmt = state.capital * adjustedRisk;
    const slDist = Math.abs(entry - slPrice);
    const quantity = slDist > 0 ? riskAmt / slDist : 0;
    const costBasis = quantity * entry;
    const marginRequired = costBasis / LEVERAGE;

    if (marginRequired > state.capital * 0.6 || quantity <= 0) continue; // 50→60% (여유)

    // 슬리피지 체크: 과도하면 사이즈 줄이기
    try {
      const slip = await riskManager.estimateSlippage(symbol, costBasis, action);
      if (slip && slip.slippagePct > 0.3) {
        console.log(`[paper-v2] ${symbol} 슬리피지 ${slip.slippagePct.toFixed(3)}% 과도 — 스킵`);
        continue;
      }
    } catch {}

    // 분할 진입 감지: PM sizing에 "분할" 키워드 → 50% 수량으로 진입, 나머지 재진입 큐
    let actualQty = quantity;
    let isScaleIn = false;
    const sizingStr = String(decision.sizing || '').toLowerCase();
    if (sizingStr.includes('분할') || sizingStr.includes('scale')) {
      actualQty = Math.round(quantity * 0.5 * 1000) / 1000;
      isScaleIn = true;
      console.log(`[paper-v2] ${symbol} 분할 진입 — 1차 50% (${actualQty}), 2차 30분 후 큐`);
    }

    const position = {
      symbol, direction: action, grade, confidence: decision.confidence || confidence,
      entryPrice: entry, slPrice: Math.round(slPrice * 100) / 100, tpPrice: Math.round(tpPrice * 100) / 100,
      quantity: Math.round(actualQty * 1000) / 1000, costBasis: Math.round(actualQty * entry * 100) / 100,
      maxHoldHours: CONFIG.maxHoldHours, entryTs: now, entryTime: new Date().toISOString(),
      rationale: decision.rationale || '', multiTfConfirmed: decision.multiTfConfirmed || false,
      quantGrade: decision.quantGrade || null, quantScore: decision.quantScore || null,
      scaleIn: isScaleIn ? 1 : 0, // 분할 진입 단계 (0=전량, 1=1차)
    };

    state.positions.push(position);

    // 분할 진입 2차 → 재진입 큐에 추가 (30분 후)
    if (isScaleIn) {
      if (!state.reentryQueue) state.reentryQueue = [];
      state.reentryQueue.push({
        symbol, direction: action, afterTs: now + 30 * 60 * 1000,
        reason: `분할 진입 2차 (${symbol} ${action})`,
        grade, confidence: decision.confidence || confidence,
        scaleIn: 2,
      });
    }
    saveState(state);
    if (notifyFn) notifyFn('trade_opened', position);

    const rrRatio = slDist > 0 ? (Math.abs(tpPrice - entry) / slDist).toFixed(1) : '?';
    const dirEmoji = action === 'BUY' ? '🟢' : '🔴';
    const dirLabel = action === 'BUY' ? 'LONG 🟢' : 'SHORT 🔴';
    let quantLine = quantSignal ? `퀀트: ${quantSignal.action} [${quantSignal.grade}급] 점수 ${quantSignal.totalScore}\n` : '';

    telegramBot.sendTelegramWithButtons(
      `${dirEmoji} <b>Paper Trade 진입</b> [${mode}]\n━━━━━━━━━━━━━━━\n` +
      `코인: <b>${symbol}</b> | <b>${dirLabel}</b>\n` +
      `진입: <b>$${entry}</b>\n손절: $${position.slPrice} | 목표: $${position.tpPrice}\n` +
      `R:R = ${rrRatio}:1\n━━━━━━━━━━━━━━━\n` +
      `수량: <b>${position.quantity}</b> ${symbol}\n포지션: <b>$${costBasis.toFixed(0)}</b>\n` +
      `레버리지: <b>${LEVERAGE}x</b> | 마진: $${marginRequired.toFixed(0)}\n━━━━━━━━━━━━━━━\n` +
      `등급: ${grade} | 확신: ${decision.confidence || confidence}%\n` + quantLine +
      `리스크: ${(adjustedRisk * 100).toFixed(1)}% ($${riskAmt.toFixed(0)})`,
      [[{ text: '📊 Terminal', url: `${TERMINAL_URL}/?coin=${symbol}` }, { text: '📋 Dashboard', url: DASHBOARD_URL }]]
    );
  }
}

// ── Swing 전략 분석 + 진입 ──
async function swingAnalyzeAndTrade(state, notifyFn) {
  const now = Date.now();
  if (state.circuitBreakerUntil > now) return;
  if (!state.swingPositions) state.swingPositions = [];
  if (state.swingPositions.length >= CONFIG.maxSwingPositions) return;

  const history = loadHistory();
  const todayPnl = calcTodayPnl(history);
  if (todayPnl <= DAILY_LOSS_LIMIT) return;

  const ddCheck = riskManager.checkDrawdownProtection(state, now);
  if (ddCheck.halt) return;
  if (!process.env.ANTHROPIC_API_KEY) return;

  const openSymbols = new Set([...state.positions.map(p => p.symbol), ...state.swingPositions.map(p => p.symbol)]);
  const skipSet = new Set(state.skipList || []);
  let symbol = null;
  if (!state.lastSwingIdx) state.lastSwingIdx = 0;
  for (let attempt = 0; attempt < SWING_SYMBOLS.length; attempt++) {
    const candidate = SWING_SYMBOLS[state.lastSwingIdx % SWING_SYMBOLS.length];
    state.lastSwingIdx++;
    if (!openSymbols.has(candidate) && !skipSet.has(candidate)) { symbol = candidate; break; }
  }
  if (!symbol) return;

  state.lastSwingAnalysisTs = now; saveState(state);

  // 퀀트 사전 필터 — D등급이면 스킵
  try {
    const qSig = await quantSignals.getSignalForSymbol(symbol);
    if ((qSig.grade || 'D') === 'D') {
      console.log(`[swing] ${symbol} 퀀트 D등급 → 스킵`);
      return;
    }
  } catch {}

  const decision = await runAnalysis(symbol, 'algo');
  if (!decision) return;

  const action = (decision.action || '').toUpperCase();
  const confidence = decision.confidence || 0;
  const grade = decision.grade || 'D';

  if (action !== 'BUY' && action !== 'SELL') return;
  if (confidence < 45) return; // 55→45
  if ((GRADE_ORDER[grade] || 0) < (GRADE_ORDER['D'] || 0)) return; // C→D
  if (riskManager.isPatternBlocked(state, symbol, action)) return;

  const allPositions = [...state.positions, ...state.swingPositions];
  for (const group of CORRELATION_GROUPS) {
    if (group.includes(symbol) && allPositions.find(p => group.includes(p.symbol) && p.direction === action)) return;
  }

  const validation = await riskManager.validateEntry(symbol, action);
  if (!validation.ok) return;

  const currentPrice = await fetchPrice(symbol);
  if (!currentPrice) return;

  const volatility = await fetch24hVolatility(symbol);
  let volMultiplier = volatility > 5 ? 1.5 : volatility < 2 ? 0.7 : 1.0;

  // 시간 가중 진입 필터 (swing)
  try {
    const timeWeight = quantSignals.getTimeWeightScore();
    if (timeWeight.isWorstHour) {
      console.log(`[paper-v2] ${symbol} swing 최악 시간대 ${timeWeight.currentHour}h UTC → 진입 거부`);
      return;
    }
    if (timeWeight.isBestHour) {
      decision.confidence = Math.min((decision.confidence || 0) + 10, 95);
    }
  } catch {}

  const entry = (typeof decision.entry === 'number' ? decision.entry : parseFloat(String(decision.entry).replace(/[^0-9.]/g, ''))) || currentPrice;
  const stop = (typeof decision.stop === 'number' ? decision.stop : parseFloat(String(decision.stop).replace(/[^0-9.]/g, ''))) || 0;
  const target = parseFloat(String(decision.target || '').replace(/[^0-9.]/g, '')) || 0;
  const swingSlPct = 0.04 * volMultiplier, swingTpPct = 0.08 * volMultiplier;

  let slPrice, tpPrice;
  let usedATR = false;

  // ATR 기반 동적 SL/TP (swing: 4h ATR × 2.0=SL, × 3.5=TP)
  try {
    const atrStops = await quantSignals.getATRStops(symbol, action);
    if (atrStops && atrStops.atr14 > 0) {
      const swingSlDist = atrStops.atr14 * 2.0; // 4h ATR × 2.0 (스윙은 더 넓게)
      const swingTpDist = atrStops.atr14 * 3.5; // 4h ATR × 3.5
      slPrice = action === 'BUY' ? atrStops.price - swingSlDist : atrStops.price + swingSlDist;
      tpPrice = action === 'BUY' ? atrStops.price + swingTpDist : atrStops.price - swingTpDist;
      usedATR = true;
      console.log(`[paper-v2] ${symbol} swing ATR SL/TP: ATR=${atrStops.atr14}, SL=${(swingSlDist/atrStops.price*100).toFixed(1)}%, TP=${(swingTpDist/atrStops.price*100).toFixed(1)}%`);
    }
  } catch {}

  if (!usedATR) {
    if (stop > 0 && target > 0) {
      const adjustedSlDist = Math.abs(entry - stop) * volMultiplier;
      slPrice = action === 'BUY' ? entry - adjustedSlDist : entry + adjustedSlDist;
      tpPrice = target;
    } else {
      const slDist = currentPrice * swingSlPct;
      slPrice = action === 'BUY' ? currentPrice - slDist : currentPrice + slDist;
      tpPrice = action === 'BUY' ? currentPrice + slDist * 2 : currentPrice - slDist * 2;
    }
  }
  if (action === 'BUY') { if (slPrice >= entry) slPrice = entry * (1 - swingSlPct); if (tpPrice <= entry) tpPrice = entry * (1 + swingTpPct); }
  else { if (slPrice <= entry) slPrice = entry * (1 + swingSlPct); if (tpPrice >= entry) tpPrice = entry * (1 - swingTpPct); }
  if (Math.abs(tpPrice - entry) / entry > 0.50) { const slDist2 = Math.abs(entry - slPrice); tpPrice = action === 'BUY' ? entry + slDist2 * 3 : entry - slDist2 * 3; }
  if (Math.abs(slPrice - entry) / entry < 0.005) { slPrice = action === 'BUY' ? entry * 0.96 : entry * 1.04; }

  // 최소 R:R 1.2 강제 (swing)
  const swingRR = Math.abs(tpPrice - entry) / Math.abs(slPrice - entry);
  if (swingRR < 1.2) {
    console.log(`[paper-v2] ${symbol} swing R:R ${swingRR.toFixed(2)} < 1.2 → 진입 차단`);
    return;
  }

  const LEVERAGE = state.leverage || 20;
  const dynamicRisk = riskManager.getDynamicRisk(state);
  const gradeMult = GRADE_MULTIPLIER[grade] || 1.0;
  const coinWeight = riskManager.getCoinWeight(state, symbol);
  const adjustedRisk = dynamicRisk * 0.75 * gradeMult * coinWeight;
  const riskAmt = state.capital * adjustedRisk;
  const slDist = Math.abs(entry - slPrice);
  const quantity = slDist > 0 ? riskAmt / slDist : 0;
  const costBasis = quantity * entry;
  const marginRequired = costBasis / LEVERAGE;
  if (marginRequired > state.capital * 0.5 || quantity <= 0) return;

  const position = {
    symbol, direction: action, grade, confidence, strategy: 'swing',
    entryPrice: entry, slPrice: Math.round(slPrice * 100) / 100, tpPrice: Math.round(tpPrice * 100) / 100,
    quantity: Math.round(quantity * 1000) / 1000, costBasis: Math.round(costBasis * 100) / 100,
    maxHoldHours: CONFIG.maxSwingHoldHours, entryTs: now, entryTime: new Date().toISOString(),
    rationale: decision.rationale || '', multiTfConfirmed: decision.multiTfConfirmed || false,
  };
  state.swingPositions.push(position);
  saveState(state);
  if (notifyFn) notifyFn('trade_opened', { ...position, strategy: 'swing' });

  const rrRatio = slDist > 0 ? (Math.abs(tpPrice - entry) / slDist).toFixed(1) : '?';
  const dirEmoji = action === 'BUY' ? '🟢' : '🔴';
  telegramBot.sendTelegramWithButtons(
    `${dirEmoji} <b>Swing Trade 진입</b> [swing/algo]\n━━━━━━━━━━━━━━━\n` +
    `코인: <b>${symbol}</b> | <b>${action === 'BUY' ? 'LONG 🟢' : 'SHORT 🔴'}</b>\n` +
    `진입: <b>$${entry}</b>\n손절: $${position.slPrice} | 목표: $${position.tpPrice}\n` +
    `R:R = ${rrRatio}:1\n━━━━━━━━━━━━━━━\n` +
    `수량: <b>${position.quantity}</b> ${symbol}\n포지션: <b>$${costBasis.toFixed(0)}</b>\n` +
    `레버리지: <b>${LEVERAGE}x</b> | 최대 보유: ${CONFIG.maxSwingHoldHours}h\n━━━━━━━━━━━━━━━\n` +
    `등급: ${grade} | 확신: ${confidence}%`,
    [[{ text: '📊 Terminal', url: `${TERMINAL_URL}/?coin=${symbol}` }, { text: '📋 Dashboard', url: DASHBOARD_URL }]]
  );
}

// ── 급락 반등 감지 (P1-P4) — 전 코인 스캔 ──
async function crashBounceScanner(state, notifyFn) {
  if (state.circuitBreakerUntil > Date.now()) return;
  if ((state.drawdownHaltUntil || 0) > Date.now()) return;

  const effectiveMax = riskManager.getEffectiveMaxPositions(state);
  if (state.positions.length >= effectiveMax) return;

  const openSymbols = new Set([...state.positions.map(p => p.symbol), ...(state.swingPositions || []).map(p => p.symbol)]);

  for (const symbol of SYMBOLS) {
    if (openSymbols.has(symbol)) continue;
    if ((state.skipList || []).includes(symbol)) continue;

    try {
      const crash = await quantSignals.detectCrashBounce(symbol);
      if (!crash || !crash.detected) continue;

      console.log(`[paper-v2] 🚨 ${symbol} 급락 반등 ${crash.pattern} 감지! (${crash.drop24h}% 낙폭, RSI ${crash.rsi})`);

      // P2+ 등급만 자동 진입 (P1은 알림만)
      if (crash.pattern === 'P1') {
        telegramBot.sendTelegram(
          `⚠️ <b>${symbol} 급락 감지 (P1)</b>\n` +
          `낙폭: ${crash.drop24h}% | 반등: ${crash.bounce6h}%\n` +
          `RSI: ${crash.rsi} | Vol: ${crash.volSpike}x\n` +
          `아직 약한 시그널 — 모니터링 중`
        );
        continue;
      }

      // P2-P4: 자동 진입
      if (state.positions.length >= effectiveMax) break;

      const currentPrice = await fetchPrice(symbol);
      if (!currentPrice) continue;

      const validation = await riskManager.validateEntry(symbol, 'BUY');
      if (!validation.ok) continue;

      const LEVERAGE = state.leverage || 20;
      const dynamicRisk = riskManager.getDynamicRisk(state);
      const patternMult = { P2: 1.0, P3: 1.1, P4: 1.3 }[crash.pattern] || 1.0;
      const adjustedRisk = dynamicRisk * patternMult;
      const riskAmt = state.capital * adjustedRisk;
      const slDist = Math.abs(currentPrice - crash.sl);
      const quantity = slDist > 0 ? riskAmt / slDist : 0;
      const costBasis = quantity * currentPrice;
      const marginRequired = costBasis / LEVERAGE;

      if (marginRequired > state.capital * 0.5 || quantity <= 0) continue;

      const position = {
        symbol, direction: 'BUY', grade: crash.pattern === 'P4' ? 'A' : crash.pattern === 'P3' ? 'B' : 'C',
        confidence: crash.confidence, strategy: `crash_bounce_${crash.pattern}`,
        entryPrice: currentPrice, slPrice: Math.round(crash.sl * 100) / 100,
        tpPrice: Math.round(crash.tp * 100) / 100,
        quantity: Math.round(quantity * 1000) / 1000, costBasis: Math.round(costBasis * 100) / 100,
        maxHoldHours: CONFIG.maxHoldHours, entryTs: Date.now(), entryTime: new Date().toISOString(),
        rationale: `급락반등 ${crash.pattern}: ${crash.drop24h}% 낙폭, ${crash.bounce6h}% 반등`,
        crashPattern: crash.pattern, crashData: { drop24h: crash.drop24h, bounce6h: crash.bounce6h, rsi: crash.rsi, volSpike: crash.volSpike, doubleBottom: crash.hasDoubleBottom },
      };

      state.positions.push(position);
      saveState(state);
      if (notifyFn) notifyFn('trade_opened', position);

      const rrRatio = slDist > 0 ? (Math.abs(crash.tp - currentPrice) / slDist).toFixed(1) : '?';
      telegramBot.sendTelegramWithButtons(
        `🚨 <b>급락 반등 진입 [${crash.pattern}]</b>\n━━━━━━━━━━━━━━━\n` +
        `코인: <b>${symbol}</b> | <b>LONG 🟢</b>\n` +
        `낙폭: <b>${crash.drop24h}%</b> | 반등: ${crash.bounce6h}%\n` +
        `RSI: ${crash.rsi} | Vol: ${crash.volSpike}x${crash.hasDoubleBottom ? ' | 더블바텀 ✅' : ''}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `진입: <b>$${currentPrice}</b>\n손절: $${position.slPrice} | 목표: $${position.tpPrice}\n` +
        `R:R = ${rrRatio}:1\n━━━━━━━━━━━━━━━\n` +
        `수량: ${position.quantity} | 포지션: $${costBasis.toFixed(0)}\n` +
        `확신: ${crash.confidence}% | 리스크: ${(adjustedRisk * 100).toFixed(1)}%`,
        [[{ text: '📊 Terminal', url: `${TERMINAL_URL}/?coin=${symbol}` }, { text: '📋 Dashboard', url: DASHBOARD_URL }]]
      );
      break; // 급락 반등은 1건만 진입
    } catch (e) {
      console.error(`[paper-v2] ${symbol} 급락 스캔 에러: ${e.message}`);
    }
  }
}

// ── 5분 패스트스캔 (급등락 실시간 감지) ──
async function fastScanLoop(state, notifyFn) {
  try {
    const scan = await quantSignals.fastScanVolatility(SYMBOLS);
    if (!scan.alerts || scan.alerts.length === 0) return;

    for (const alert of scan.alerts) {
      // FLASH_MOVE 급락 감지 → 급락 반등 스캐너 트리거
      if (alert.alertType === 'FLASH_MOVE' && alert.direction === 'DOWN') {
        console.log(`[paper-v2] ⚡ ${alert.symbol} 급락 감지 (15m ${alert.change15m}%) → 반등 스캐너 호출`);

        // 기존 포지션 없으면 급락 반등 스캐너 실행
        const hasPos = state.positions.find(p => p.symbol === alert.symbol);
        if (!hasPos) {
          const crash = await quantSignals.detectCrashBounce(alert.symbol);
          if (crash && crash.detected) {
            console.log(`[paper-v2] 🚨 ${alert.symbol} 급락 반등 ${crash.pattern} 확인!`);
            // crashBounceScanner에서 처리하도록 둠
          }
        }
      }

      // 대량 거래량 급증 알림
      if (alert.alertType === 'VOL_SPIKE' && alert.volRatio >= 4) {
        if (!state._lastVolAlertTs || (Date.now() - state._lastVolAlertTs) > 30 * 60 * 1000) {
          state._lastVolAlertTs = Date.now();
          telegramBot.sendTelegram(
            `📊 <b>${alert.symbol} 거래량 폭발</b>\n` +
            `볼륨: ${alert.volRatio}x | 15m: ${alert.change15m > 0 ? '+' : ''}${alert.change15m}%\n` +
            `30m: ${alert.change30m > 0 ? '+' : ''}${alert.change30m}% | 1h: ${alert.change1h > 0 ? '+' : ''}${alert.change1h}%`
          );
        }
      }
    }
  } catch (e) {
    console.log(`[paper-v2] 패스트스캔 에러: ${e.message}`);
  }
}

// ── 헷지 체크 루프 ──
async function hedgeCheckLoop(state, notifyFn) {
  try {
    const hedge = riskManager.suggestHedge(state);
    if (!hedge.needsHedge) return;

    const highPriority = hedge.suggestions.filter(s => s.priority === 'HIGH');
    if (highPriority.length > 0 && (!state._lastHedgeAlertTs || (Date.now() - state._lastHedgeAlertTs) > 60 * 60 * 1000)) {
      state._lastHedgeAlertTs = Date.now();

      const lines = highPriority.map(s =>
        `⚠️ ${s.type}: ${s.reason}\n→ ${s.action} ${s.candidates.join('/')} ($${s.suggestedSize})`
      ).join('\n\n');

      telegramBot.sendTelegram(
        `🛡️ <b>헷지 권고</b>\n━━━━━━━━━━━━━━━\n` +
        `${lines}\n━━━━━━━━━━━━━━━\n` +
        `노출: L $${hedge.exposure.long} / S $${hedge.exposure.short}\n` +
        `편향: ${hedge.exposure.bias} ${hedge.exposure.biasPct}%`
      );
    }
  } catch (e) {
    console.log(`[paper-v2] 헷지 체크 에러: ${e.message}`);
  }
}

// ── 자동 실행 루프 ──
let _state = null;
let _analysisInterval = null;
let _swingAnalysisInterval = null;
let _posCheckInterval = null;
let _reentryInterval = null;
let _posReviewInterval = null;
let _fastScanInterval = null;
let _hedgeCheckInterval = null;
let _crashScanInterval = null;
let _notifyFn = null;

function scheduleDailySummary() {
  const now = new Date();
  const nextRun = new Date(now);
  nextRun.setUTCHours(15, 0, 0, 0);
  if (nextRun <= now) nextRun.setDate(nextRun.getDate() + 1);
  setTimeout(() => {
    telegramBot.sendDailySummary(_state || loadState(), _cachedMarketRegime);
    autoSelectStrategy().catch(() => {});
    setInterval(() => {
      telegramBot.sendDailySummary(_state || loadState(), _cachedMarketRegime);
      autoSelectStrategy().catch(() => {});
    }, 24 * 60 * 60 * 1000);
  }, nextRun - now);
}

async function autoSelectStrategy() {
  try {
    const result = await backtester.selectBestStrategy(['BTC', 'ETH', 'SOL'], 30);
    const state = _state || loadState();
    if (result.best) {
      const prev = state.activeStrategy || 'confluence';
      state.activeStrategy = result.best;
      state.activeStrategyUpdated = new Date().toISOString();
      saveState(state);
      if (prev !== result.best) {
        telegramBot.sendTelegram(`🔄 <b>자동 전략 전환</b>\n\n이전: ${prev}\n변경: <b>${result.best}</b> (${result.bestName})`);
      }
    }
  } catch (e) { console.error('[paper-v2] 자동 전략 선택 에러:', e.message); }
}

function start(notifyFn) {
  if (_analysisInterval) return;

  _state = loadState();
  if (_state.version !== 'v2-ai') {
    _state = loadState(); // Reset
    _state.version = 'v2-ai';
    saveState(_state);
  }

  _notifyFn = notifyFn || null;

  // 새 필드 초기화
  if (!_state.activeStrategy || _state.activeStrategy === 'confluence') _state.activeStrategy = 'bb_bounce'; // 백테스트 검증 최고 전략
  if (!_state.reentryQueue) _state.reentryQueue = [];
  if (!_state.slPatterns) _state.slPatterns = [];
  if (!_state.coinPerformance) _state.coinPerformance = {};
  if (_state.consecutiveWins == null) _state.consecutiveWins = 0;
  if (!_state.priceAlerts) _state.priceAlerts = [];
  if (!_state.skipList) _state.skipList = [];
  if (!_state.analysisLog) _state.analysisLog = [];
  if (!_state.lastReviewTs) _state.lastReviewTs = 0;
  if (!_state.drawdownHaltUntil) _state.drawdownHaltUntil = 0;
  if (!_state.swingPositions) _state.swingPositions = [];
  if (!_state.lastSwingAnalysisTs) _state.lastSwingAnalysisTs = 0;
  if (!_state.lastSwingIdx) _state.lastSwingIdx = 0;
  if (!_state.optimalTF) _state.optimalTF = {};

  // ── 모듈 의존성 주입 ──
  const sharedDeps = {
    fetchPrice, saveState, loadHistory, appendTrade, recordLesson,
    runSingleAnalysis, runAnalysis, getVolatilityRanking,
    getRecentDecision, CONFIG, SYMBOLS, DASHBOARD_URL, TERMINAL_URL,
    DAILY_LOSS_LIMIT, WEEKLY_MAX_LOSS, TOTAL_MAX_DD, SL_PATTERN_BLOCK_HOURS,
    learner, quantSignals, backtester,
    getState: () => _state,
    getStatus, getDetailedStats, loadState,
    getDynamicRisk: riskManager.getDynamicRisk,
    getEffectiveMaxPositions: riskManager.getEffectiveMaxPositions,
    getOrderFlowScore: riskManager.getOrderFlowScore,
    estimateSlippage: riskManager.estimateSlippage,
    getPortfolioCorrelation: () => riskManager.getPortfolioCorrelation(_state || loadState()),
    getPerformanceAttribution: riskManager.getPerformanceAttribution,
    getOptimalTimeframe: riskManager.getOptimalTimeframe,
    suggestHedge: () => riskManager.suggestHedge(_state || loadState()),
    detectCrashBounce: quantSignals.detectCrashBounce,
    fastScanVolatility: quantSignals.fastScanVolatility,
    getGridLevels: quantSignals.getGridLevels,
    autoTuneParameters: backtester.autoTuneParameters,
    // Portfolio Engine
    getHealthScore: () => portfolioEngine.calculateHealthScore(_state || loadState(), loadHistory()),
    checkAllocation: () => portfolioEngine.checkAllocationRules(_state || loadState()),
    getRebalanceActions: () => portfolioEngine.generateRebalanceActions(_state || loadState(), loadHistory()),
    sweepStrategies: portfolioEngine.sweepStrategies,
    getFundMetrics: () => portfolioEngine.calculateFundMetrics(_state || loadState(), loadHistory()),
    start: () => start(_notifyFn),
    stop,
    reset,
    setAnalysisInterval: (min) => {
      if (_analysisInterval) {
        clearInterval(_analysisInterval);
        _analysisInterval = setInterval(() => {
          analyzeAndTrade(_state, _notifyFn).catch(e => console.error('[paper-v2] 분석 에러:', e.message));
        }, min * 60 * 1000);
      }
    },
  };

  telegramBot.inject(sharedDeps);

  positionManager.inject({
    ...sharedDeps,
    sendTelegram: telegramBot.sendTelegram,
    sendTelegramWithButtons: telegramBot.sendTelegramWithButtons,
    updateCoinPerformance: riskManager.updateCoinPerformance,
    triggerStrategyReview,
    POSITION_REVIEW_INTERVAL,
  });

  riskManager.inject({
    loadHistory,
    CONFIG,
    CORRELATION_GROUPS,
    SL_PATTERN_BLOCK_HOURS,
  });

  console.log(`[paper-v2] AI 가상매매 v3 시작 | $${_state.capital.toFixed(0)} | ${SYMBOLS.length}코인 | 15분분석 + 5분스캔 + 급락감지`);

  telegramBot.startTelegramBot();
  scheduleDailySummary();

  _posCheckInterval = setInterval(() => {
    positionManager.checkPositions(_state, _notifyFn).catch(e => console.error('[paper-v2] 포지션 체크 에러:', e.message));
    positionManager.checkSwingPositions(_state, _notifyFn).catch(e => console.error('[paper-v2] Swing 포지션 체크 에러:', e.message));
    const weekCheck = riskManager.checkWeeklyDrawdownReview(_state);
    if (weekCheck.needsReview) {
      const lastReview = _state.lastStrategyReviewTs || 0;
      if (Date.now() - lastReview > 3600000) {
        triggerStrategyReview(`주간 낙폭 $${weekCheck.weeklyPnl.toFixed(0)}`).catch(() => {});
      }
    }
  }, POSITION_CHECK_INTERVAL);

  _reentryInterval = setInterval(() => {
    positionManager.processReentryQueue(_state, _notifyFn).catch(e => console.error('[paper-v2] 재진입 큐 에러:', e.message));
  }, 5 * 60 * 1000);

  _posReviewInterval = setInterval(() => {
    positionManager.reviewPositions(_state, _notifyFn).catch(e => console.error('[paper-v2] 포지션 재검토 에러:', e.message));
  }, 5 * 60 * 1000);

  // 5분 패스트스캔 (급등락 실시간 감지)
  _fastScanInterval = setInterval(() => {
    fastScanLoop(_state, _notifyFn).catch(e => console.error('[paper-v2] 패스트스캔 에러:', e.message));
  }, FAST_SCAN_INTERVAL);

  // 10분 급락 반등 스캐너
  _crashScanInterval = setInterval(() => {
    crashBounceScanner(_state, _notifyFn).catch(e => console.error('[paper-v2] 급락 스캐너 에러:', e.message));
  }, 10 * 60 * 1000);

  // 30분 헷지 체크
  _hedgeCheckInterval = setInterval(() => {
    hedgeCheckLoop(_state, _notifyFn).catch(e => console.error('[paper-v2] 헷지 체크 에러:', e.message));
  }, HEDGE_CHECK_INTERVAL);

  analyzeAndTrade(_state, _notifyFn).catch(e => console.error('[paper-v2] 초기 분석 에러:', e.message));
  crashBounceScanner(_state, _notifyFn).catch(e => console.error('[paper-v2] 초기 급락 스캔 에러:', e.message));

  _analysisInterval = setInterval(() => {
    analyzeAndTrade(_state, _notifyFn).catch(e => console.error('[paper-v2] 분석 에러:', e.message));
  }, ANALYSIS_INTERVAL);

  _swingAnalysisInterval = setInterval(() => {
    swingAnalyzeAndTrade(_state, _notifyFn).catch(e => console.error('[paper-v2] Swing 분석 에러:', e.message));
  }, SWING_ANALYSIS_INTERVAL);
}

function stop() {
  if (_analysisInterval) { clearInterval(_analysisInterval); _analysisInterval = null; }
  if (_swingAnalysisInterval) { clearInterval(_swingAnalysisInterval); _swingAnalysisInterval = null; }
  if (_posCheckInterval) { clearInterval(_posCheckInterval); _posCheckInterval = null; }
  if (_reentryInterval) { clearInterval(_reentryInterval); _reentryInterval = null; }
  if (_posReviewInterval) { clearInterval(_posReviewInterval); _posReviewInterval = null; }
  if (_fastScanInterval) { clearInterval(_fastScanInterval); _fastScanInterval = null; }
  if (_crashScanInterval) { clearInterval(_crashScanInterval); _crashScanInterval = null; }
  if (_hedgeCheckInterval) { clearInterval(_hedgeCheckInterval); _hedgeCheckInterval = null; }
  if (_state) saveState(_state);
  console.log('[paper-v2] 중지');
}

function getStatus() {
  const state = _state || loadState();
  const history = loadHistory();
  const winRate = state.totalTrades > 0 ? Math.round(state.wins / state.totalTrades * 1000) / 10 : 0;
  const returnPct = Math.round((state.capital - state.startCapital) / state.startCapital * 1000) / 10;

  const today = new Date().toISOString().slice(0, 10);
  let todayPnl = 0;
  for (const t of history) { const day = (t.exitTime || t.entryTime || '').slice(0, 10); if (day === today) todayPnl += t.pnl || 0; }

  const coinPerformance = {};
  if (state.coinPerformance) {
    for (const [sym, cp] of Object.entries(state.coinPerformance)) {
      coinPerformance[sym] = { ...cp, winRate: cp.total > 0 ? Math.round(cp.wins / cp.total * 1000) / 10 : 0, weight: riskManager.getCoinWeight(state, sym) };
    }
  }

  const effectiveMax = riskManager.getEffectiveMaxPositions(state);
  const swingPositions = state.swingPositions || [];
  const hasScalp = state.positions.length > 0;
  const hasSwing = swingPositions.length > 0;
  const strategyMode = (hasScalp && hasSwing) ? 'both' : hasSwing ? 'swing' : 'scalp';

  return {
    running: !!_analysisInterval, version: 'v3-enhanced', marketRegime: _cachedMarketRegime,
    capital: Math.round(state.capital * 100) / 100, startCapital: state.startCapital, returnPct,
    totalPnl: Math.round(state.totalPnl * 100) / 100, todayPnl: Math.round(todayPnl * 100) / 100,
    totalTrades: state.totalTrades, wins: state.wins, losses: state.losses, winRate,
    maxDrawdown: Math.round(state.maxDrawdown * 1000) / 10,
    positions: state.positions, positionCount: state.positions.length,
    swingPositions, swingPositionCount: swingPositions.length, strategyMode,
    consecutiveLosses: state.consecutiveLosses, consecutiveWins: state.consecutiveWins || 0,
    effectiveMaxPositions: effectiveMax, maxSwingPositions: CONFIG.maxSwingPositions,
    circuitBreakerActive: state.circuitBreakerUntil > Date.now(),
    drawdownHaltActive: (state.drawdownHaltUntil || 0) > Date.now(),
    currentDrawdown: state.peakCapital > 0 ? Math.round((state.peakCapital - state.capital) / state.peakCapital * 1000) / 10 : 0,
    recentTrades: history.slice(-5).reverse(), coinPerformance,
    reentryQueue: (state.reentryQueue || []).length,
    slPatternsCount: (state.slPatterns || []).length,
    symbols: SYMBOLS, swingSymbols: SWING_SYMBOLS,
    analysisInterval: '15분분석 + 5분스캔 + 10분급락 + 30분스윙',
    nextSymbol: SYMBOLS[state.lastAnalysisIdx % SYMBOLS.length],
    nextSwingSymbol: SWING_SYMBOLS[(state.lastSwingIdx || 0) % SWING_SYMBOLS.length],
    config: CONFIG, startedAt: state.startedAt,
    lastAnalysis: state.lastAnalysisTs ? new Date(state.lastAnalysisTs).toISOString() : null,
    lastSwingAnalysis: state.lastSwingAnalysisTs ? new Date(state.lastSwingAnalysisTs).toISOString() : null,
    lastUpdated: state.lastUpdated,
  };
}

function getHistory() { return loadHistory(); }

function getDetailedStats() {
  const history = loadHistory();
  const state = _state || loadState();
  if (!history.length) return { winRateByCoin: {}, avgHoldTime: 0, bestTrade: null, worstTrade: null, currentStreak: { type: 'none', count: 0 }, dailyEquityCurve: [], dailyPnl: {}, todayPnl: 0, sharpeRatio: 0, profitFactor: 0, calmarRatio: 0, hourlyStats: {}, dayOfWeekStats: {}, strategyStats: {}, gradeStats: {}, closeReasonStats: {}, avgRR: 0, expectancy: 0, hedgeStatus: null };

  // ── 코인별 승률 ──
  const coinStats = {};
  for (const t of history) {
    const sym = t.symbol || '?';
    if (!coinStats[sym]) coinStats[sym] = { wins: 0, losses: 0, total: 0, totalPnl: 0 };
    coinStats[sym].total++; coinStats[sym].totalPnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) coinStats[sym].wins++; else coinStats[sym].losses++;
  }
  const winRateByCoin = {};
  for (const [sym, s] of Object.entries(coinStats)) {
    winRateByCoin[sym] = { winRate: s.total > 0 ? Math.round(s.wins / s.total * 1000) / 10 : 0, wins: s.wins, losses: s.losses, total: s.total, totalPnl: Math.round(s.totalPnl * 100) / 100 };
  }

  // ── 기본 통계 ──
  const holdTimes = history.filter(t => t.hoursHeld != null).map(t => t.hoursHeld);
  const avgHoldTime = holdTimes.length > 0 ? Math.round(holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length * 10) / 10 : 0;
  const sorted = [...history].sort((a, b) => (a.pnl || 0) - (b.pnl || 0));
  const worstTrade = sorted[0] || null;
  const bestTrade = sorted[sorted.length - 1] || null;

  let streakType = 'none', streakCount = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const isWin = (history[i].pnl || 0) > 0;
    if (streakCount === 0) { streakType = isWin ? 'wins' : 'losses'; streakCount = 1; }
    else if ((streakType === 'wins' && isWin) || (streakType === 'losses' && !isWin)) streakCount++;
    else break;
  }

  // ── 에쿼티 커브 ──
  const dailyPnl = {};
  for (const t of history) { const day = (t.exitTime || t.entryTime || '').slice(0, 10); if (day) dailyPnl[day] = Math.round(((dailyPnl[day] || 0) + (t.pnl || 0)) * 100) / 100; }
  const today = new Date().toISOString().slice(0, 10);
  const dailyEquityCurve = [];
  let running = state.startCapital;
  for (const day of Object.keys(dailyPnl).sort()) { running += dailyPnl[day]; dailyEquityCurve.push({ date: day, capital: Math.round(running * 100) / 100, dailyPnl: dailyPnl[day] }); }

  // ── 샤프 비율 ──
  const returns = history.map(t => (t.pnlPct || 0) / 100);
  let sharpeRatio = 0;
  if (returns.length > 1) {
    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    sharpeRatio = std > 0 ? Math.round(meanReturn / std * Math.sqrt(252) * 100) / 100 : 0;
  }

  // ── 프로핏 팩터 ──
  const winTrades = history.filter(t => (t.pnl || 0) > 0);
  const lossTrades = history.filter(t => (t.pnl || 0) <= 0);
  const grossProfit = winTrades.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(lossTrades.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : grossProfit > 0 ? 999 : 0;

  // ── 칼마 비율 (연환산 수익 / MDD) ──
  const totalReturn = (state.capital - state.startCapital) / state.startCapital;
  const mdd = state.maxDrawdown || 0.001;
  const calmarRatio = Math.round(totalReturn / mdd * 100) / 100;

  // ── 기대값 ──
  const avgWin = winTrades.length > 0 ? grossProfit / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? grossLoss / lossTrades.length : 0;
  const winRate = history.length > 0 ? winTrades.length / history.length : 0;
  const expectancy = Math.round(((winRate * avgWin) - ((1 - winRate) * avgLoss)) * 100) / 100;

  // ── 평균 R:R ──
  let totalRR = 0, rrCount = 0;
  for (const t of history) {
    if (t.slPrice && t.entryPrice && t.tpPrice) {
      const slDist = Math.abs(t.entryPrice - t.slPrice);
      const tpDist = Math.abs(t.tpPrice - t.entryPrice);
      if (slDist > 0) { totalRR += tpDist / slDist; rrCount++; }
    }
  }
  const avgRR = rrCount > 0 ? Math.round(totalRR / rrCount * 10) / 10 : 0;

  // ── 시간대별 통계 ──
  const hourlyStats = {};
  for (const t of history) {
    const hour = t.entryTime ? new Date(t.entryTime).getUTCHours() : null;
    if (hour === null) continue;
    if (!hourlyStats[hour]) hourlyStats[hour] = { wins: 0, losses: 0, total: 0, pnl: 0 };
    hourlyStats[hour].total++;
    hourlyStats[hour].pnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) hourlyStats[hour].wins++; else hourlyStats[hour].losses++;
  }
  for (const h of Object.keys(hourlyStats)) {
    hourlyStats[h].winRate = Math.round(hourlyStats[h].wins / hourlyStats[h].total * 1000) / 10;
    hourlyStats[h].pnl = Math.round(hourlyStats[h].pnl * 100) / 100;
  }

  // ── 요일별 통계 ──
  const dayOfWeekStats = {};
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const t of history) {
    const day = t.entryTime ? new Date(t.entryTime).getUTCDay() : null;
    if (day === null) continue;
    const dayName = dayNames[day];
    if (!dayOfWeekStats[dayName]) dayOfWeekStats[dayName] = { wins: 0, losses: 0, total: 0, pnl: 0 };
    dayOfWeekStats[dayName].total++;
    dayOfWeekStats[dayName].pnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) dayOfWeekStats[dayName].wins++; else dayOfWeekStats[dayName].losses++;
  }
  for (const d of Object.keys(dayOfWeekStats)) {
    dayOfWeekStats[d].winRate = Math.round(dayOfWeekStats[d].wins / dayOfWeekStats[d].total * 1000) / 10;
    dayOfWeekStats[d].pnl = Math.round(dayOfWeekStats[d].pnl * 100) / 100;
  }

  // ── 전략별 통계 ──
  const strategyStats = {};
  for (const t of history) {
    const strat = t.strategy || (t.closeReason === 'REVIEW_REVERSE' ? 'review' : 'scalp');
    if (!strategyStats[strat]) strategyStats[strat] = { wins: 0, losses: 0, total: 0, pnl: 0 };
    strategyStats[strat].total++;
    strategyStats[strat].pnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) strategyStats[strat].wins++; else strategyStats[strat].losses++;
  }
  for (const s of Object.keys(strategyStats)) {
    strategyStats[s].winRate = Math.round(strategyStats[s].wins / strategyStats[s].total * 1000) / 10;
    strategyStats[s].pnl = Math.round(strategyStats[s].pnl * 100) / 100;
  }

  // ── 등급별 통계 ──
  const gradeStats = {};
  for (const t of history) {
    const grade = t.grade || 'D';
    if (!gradeStats[grade]) gradeStats[grade] = { wins: 0, losses: 0, total: 0, pnl: 0 };
    gradeStats[grade].total++;
    gradeStats[grade].pnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) gradeStats[grade].wins++; else gradeStats[grade].losses++;
  }
  for (const g of Object.keys(gradeStats)) {
    gradeStats[g].winRate = Math.round(gradeStats[g].wins / gradeStats[g].total * 1000) / 10;
    gradeStats[g].pnl = Math.round(gradeStats[g].pnl * 100) / 100;
  }

  // ── 청산 사유별 통계 ──
  const closeReasonStats = {};
  for (const t of history) {
    const cr = t.closeReason || 'UNKNOWN';
    if (!closeReasonStats[cr]) closeReasonStats[cr] = { wins: 0, losses: 0, total: 0, pnl: 0 };
    closeReasonStats[cr].total++;
    closeReasonStats[cr].pnl += t.pnl || 0;
    if ((t.pnl || 0) > 0) closeReasonStats[cr].wins++; else closeReasonStats[cr].losses++;
  }
  for (const cr of Object.keys(closeReasonStats)) {
    closeReasonStats[cr].winRate = Math.round(closeReasonStats[cr].wins / closeReasonStats[cr].total * 1000) / 10;
    closeReasonStats[cr].pnl = Math.round(closeReasonStats[cr].pnl * 100) / 100;
  }

  // ── 헷지 상태 ──
  let hedgeStatus = null;
  try { hedgeStatus = riskManager.suggestHedge(state); } catch {}

  return {
    winRateByCoin, avgHoldTime, bestTrade, worstTrade,
    currentStreak: { type: streakType, count: streakCount },
    dailyEquityCurve, dailyPnl, todayPnl: dailyPnl[today] || 0,
    // 강화 지표
    sharpeRatio, profitFactor, calmarRatio, expectancy, avgRR,
    avgWin: Math.round(avgWin * 100) / 100, avgLoss: Math.round(avgLoss * 100) / 100,
    grossProfit: Math.round(grossProfit * 100) / 100, grossLoss: Math.round(grossLoss * 100) / 100,
    // 다차원 분석
    hourlyStats, dayOfWeekStats, strategyStats, gradeStats, closeReasonStats,
    // 헷지
    hedgeStatus,
    // 메타
    totalTrades: history.length, totalDays: Object.keys(dailyPnl).length,
    tradesPerDay: Object.keys(dailyPnl).length > 0 ? Math.round(history.length / Object.keys(dailyPnl).length * 10) / 10 : 0,
  };
}

function reset() {
  stop();
  try { fs.unlinkSync(STATE_FILE); } catch {}
  try { fs.unlinkSync(HISTORY_FILE); } catch {}
  _state = null;
  return { success: true, message: 'AI 가상매매 리셋 — $3,000으로 초기화' };
}

module.exports = { start, stop, getStatus, getHistory, getDetailedStats, reset };
