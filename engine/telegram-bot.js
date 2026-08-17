'use strict';

/**
 * Telegram Bot — 텔레그램 알림 + 명령어 봇
 *
 * paper-trader-v2.js에서 분리.
 * 모든 텔레그램 통신, 명령어 처리, 리포트 전송 담당.
 */

const https = require('https');

// ── 외부에서 주입되는 의존성 ──
let _deps = {
  getStatus: null,
  getDetailedStats: null,
  loadState: null,
  saveState: null,
  loadHistory: null,
  fetchPrice: null,
  runAnalysis: null,
  getVolatilityRanking: null,
  getDynamicRisk: null,
  start: null,
  stop: null,
  reset: null,
  getRecentDecision: null,
  getOrderFlowScore: null,
  estimateSlippage: null,
  getPortfolioCorrelation: null,
  getPerformanceAttribution: null,
  getOptimalTimeframe: null,
  // 모듈 참조
  learner: null,
  quantSignals: null,
  backtester: null,
  CONFIG: null,
  SYMBOLS: null,
  DAILY_LOSS_LIMIT: null,
  WEEKLY_MAX_LOSS: null,
  TOTAL_MAX_DD: null,
  SL_PATTERN_BLOCK_HOURS: null,
  DASHBOARD_URL: null,
  TERMINAL_URL: null,
  _state: null,
  getState: null,
};

function inject(deps) {
  Object.assign(_deps, deps);
}

// ── 텔레그램 메시지 전송 ──
function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const payload = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (res) => {
    if (res.statusCode !== 200) console.log(`[telegram] 전송 실패: ${res.statusCode}`);
  });
  req.on('error', (e) => console.log(`[telegram] 에러: ${e.message}`));
  req.write(payload);
  req.end();
}

// ── 텔레그램 인라인 키보드 버튼 포함 메시지 ──
function sendTelegramWithButtons(text, buttons) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const payload = JSON.stringify({
    chat_id: chatId, text, parse_mode: 'HTML',
    reply_markup: { inline_keyboard: buttons },
  });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
  }, (res) => {
    if (res.statusCode !== 200) console.log(`[telegram] 버튼 전송 실패: ${res.statusCode}`);
  });
  req.on('error', (e) => console.log(`[telegram] 버튼 에러: ${e.message}`));
  req.write(payload);
  req.end();
}

// ── 유니코드 바 차트 헬퍼 ──
function makeBar(value, maxValue, barLength = 10) {
  const filled = Math.max(0, Math.min(barLength, Math.round(Math.abs(value) / (maxValue || 1) * barLength)));
  const empty = barLength - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function makePnlBar(pnlPct) {
  const clamped = Math.max(-10, Math.min(10, pnlPct));
  const filled = Math.round(Math.abs(clamped) / 10 * 8);
  if (clamped >= 0) {
    return '░'.repeat(8 - filled) + '█'.repeat(filled) + ` ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
  } else {
    return '█'.repeat(filled) + '░'.repeat(8 - filled) + ` ${pnlPct.toFixed(1)}%`;
  }
}

// ── 텔레그램 봇 폴링 ──
let _lastUpdateId = 0;
let _botPollingInterval = null;
let _posReportInterval = null;

function startTelegramBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  console.log('[telegram] 명령어 봇 시작');
  _botPollingInterval = setInterval(() => pollTelegramUpdates(), 3000);

  _posReportInterval = setInterval(() => {
    const state = _deps.getState ? _deps.getState() : (_deps._state || _deps.loadState());
    const allPos = [...(state.positions || []), ...(state.swingPositions || [])];
    if (allPos.length > 0) {
      sendPositionReport(state);
    }
  }, 15 * 60 * 1000);
}

function stopTelegramBot() {
  if (_botPollingInterval) { clearInterval(_botPollingInterval); _botPollingInterval = null; }
  if (_posReportInterval) { clearInterval(_posReportInterval); _posReportInterval = null; }
}

function pollTelegramUpdates() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;

  const url = `https://api.telegram.org/bot${token}/getUpdates?offset=${_lastUpdateId + 1}&timeout=0&limit=10`;
  https.get(url, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.ok && Array.isArray(parsed.result)) {
          for (const update of parsed.result) {
            _lastUpdateId = update.update_id;
            const msg = update.message;
            if (msg && msg.text) handleCommand(msg.text.trim(), msg.chat.id);
          }
        }
      } catch {}
    });
  }).on('error', () => {});
}

// ── 명령어 처리 ──
async function handleCommand(text, chatId) {
  const parts = text.split(/\s+/).map(p => p.replace(/USDT$/i, ''));
  const cmd = parts.map(p => p.toLowerCase());
  const state = _deps.getState ? _deps.getState() : (_deps._state || _deps.loadState());
  const { CONFIG, SYMBOLS, learner, quantSignals, backtester } = _deps;
  const DASHBOARD_URL = _deps.DASHBOARD_URL || '';
  const TERMINAL_URL = _deps.TERMINAL_URL || '';

  if (!state.priceAlerts) state.priceAlerts = [];
  if (!state.skipList) state.skipList = [];
  if (!state.analysisLog) state.analysisLog = [];

  switch (cmd[0]) {
    case '/start':
    case '/help':
    case '/명령어': {
      sendTelegram(
        `🤖 <b>Paper Trader 명령어</b>\n\n` +
        `<b>[상태]</b>\n` +
        `/status — 현재 상태\n` +
        `/positions — 보유 포지션 상세\n` +
        `/balance — 자본 상세\n` +
        `/equity — 자본금 변동 그래프\n\n` +
        `<b>[거래]</b>\n` +
        `/close [코인] — 수동 청산\n` +
        `/closeall — 전체 청산\n` +
        `/history — 최근 5건 거래\n` +
        `/pnl — 오늘 PnL\n\n` +
        `<b>[통계]</b>\n` +
        `/stats — 상세 통계\n` +
        `/profit — 전체 수익 보고서\n` +
        `/top — 수익 TOP 3\n` +
        `/worst — 손실 TOP 3\n` +
        `/today — 오늘 활동 요약\n` +
        `/week — 이번 주 요약\n\n` +
        `<b>[분석]</b>\n` +
        `/analyze [코인] — 즉시 분석\n` +
        `/ranking — 변동성 순위\n` +
        `/market — 시장 현황\n` +
        `/risk — 리스크 현황\n\n` +
        `<b>[알림]</b>\n` +
        `/alert [코인] [가격] — 가격 알림\n` +
        `/alerts — 알림 목록\n` +
        `/cancelalert [번호] — 알림 취소\n\n` +
        `<b>[퀀트]</b>\n` +
        `/backtest [코인] [전략] [일수] — 백테스트\n` +
        `/signal [코인] — 퀀트 시그널\n` +
        `/scan — TOP 10 퀀트 스캔\n` +
        `/ensemble [코인] — 앙상블 투표 상세\n` +
        `/optimize — 전략 최적화\n` +
        `/strategies — 전략 목록\n` +
        `/compare [코인] — 전략 비교\n\n` +
        `<b>[학습]</b>\n` +
        `/learn — 즉시 학습 실행\n` +
        `/rules — 학습된 규칙\n` +
        `/patterns — 최고/최악 패턴\n\n` +
        `<b>[고급 분석]</b>\n` +
        `/ai [코인] — AI+퀀트+앙상블 종합 분석\n` +
        `/watchlist — 10코인 전체 현황\n` +
        `/daily — 오늘 상세 활동 로그\n` +
        `/winrate — 조건별 승률 상세\n` +
        `/next — 다음 분석 예정 정보\n` +
        `/regime [코인] — 마켓 레짐 분류\n` +
        `/funding — 10코인 펀딩레이트\n` +
        `/momentum — 크로스 모멘텀 순위\n` +
        `/orderflow [코인] — 오더북 불균형\n` +
        `/perf — 전략별/지표별 성과 attribution\n` +
        `/depth [코인] — 오더북 불균형 + 슬리피지\n` +
        `/portfolio — 포트폴리오 상관관계 + 분산도\n` +
        `/tf [코인] — 타임프레임별 백테스트 비교\n` +
        `/report — 종합 성과 리포트\n\n` +
        `<b>[설정]</b>\n` +
        `/mode [scalp|attack] — 모드 전환\n` +
        `/auto — 자동 모드 복귀\n` +
        `/set [항목] [값] — 런타임 설정 변경\n` +
        `/skip [코인] — 분석 제외\n` +
        `/unskip [코인] — 제외 해제\n` +
        `/leverage [배수] — 레버리지 변경\n` +
        `/maxpos [숫자] — 최대 포지션 수\n` +
        `/interval [분] — 분석 간격 변경\n` +
        `/config — 현재 설정값\n\n` +
        `<b>[수동 트레이딩]</b>\n` +
        `/long [코인] [리스크%] [SL%] [TP%] — 롱 진입\n` +
        `/short [코인] [리스크%] [SL%] [TP%] — 숏 진입\n` +
        `/sl [코인] [가격] — SL 변경\n` +
        `/tp [코인] [가격] — TP 변경\n` +
        `/be [코인] — SL을 손익분기로\n` +
        `/add [코인] [%] — 추가 매수 (스케일인)\n` +
        `/reduce [코인] [%] — 부분 청산 (스케일아웃)\n` +
        `/flip [코인] — 방향 전환\n\n` +
        `<b>[전략/설정 실시간 수정]</b>\n` +
        `/strategy [이름] — 전략 변경\n` +
        `/set — 전체 설정 목록\n` +
        `/set risk/sl/tp/confidence/maxhold/maxpos/circuit... [값]\n\n` +
        `<b>[AI Hedge Fund OS]</b>\n` +
        `/health — 포트폴리오 헬스 스코어\n` +
        `/fund — 펀드 퍼포먼스 (Sharpe/Sortino/Calmar)\n` +
        `/allocation — 배분 규칙 체크\n` +
        `/rebalance — 리밸런스 권고\n` +
        `/sweep — 전략 대량 스위프\n\n` +
        `<b>[v3 강화]</b>\n` +
        `/crash [코인] — 급락 반등 P1-P4\n` +
        `/grid [코인] — 그리드 레벨\n` +
        `/hedge — 헷지 권고\n` +
        `/tune [코인] [전략] — 파라미터 튜닝\n` +
        `/scan — 급변동 감지\n` +
        `/dashboard — 성과 대시보드\n\n` +
        `<b>[시스템]</b>\n` +
        `/stop — 중지\n` +
        `/resume — 재개\n` +
        `/reset — 초기화\n` +
        `/health — 시스템 상태\n` +
        `/whoami — 시스템 정보`
      );
      break;
    }

    case '/status':
    case '/상태': {
      const s = _deps.getStatus();
      const posLines = s.positions.map(p => `  [S] ${p.symbol} ${p.direction} @ $${p.entryPrice}`).join('\n') || '  없음';
      const swingLines = (s.swingPositions || []).map(p => `  [W] ${p.symbol} ${p.direction} @ $${p.entryPrice}`).join('\n');
      const winBar = makeBar(s.winRate, 100, 10);
      const winBarLine = `<pre>승률: ${winBar} ${s.winRate}%</pre>`;
      const hist = _deps.loadHistory();
      const dailyMap = {};
      for (const t of hist) {
        const day = (t.exitTime || '').slice(0, 10);
        if (day) dailyMap[day] = (dailyMap[day] || 0) + (t.pnl || 0);
      }
      const recentDays = Object.keys(dailyMap).sort().slice(-7);
      let eqRunning = s.startCapital;
      const allDaysSorted = Object.keys(dailyMap).sort();
      const eqByDay = [];
      for (const d of allDaysSorted) {
        eqRunning += dailyMap[d];
        if (recentDays.includes(d)) eqByDay.push({ day: d, capital: eqRunning, pnl: dailyMap[d] });
      }
      let eqChart = '';
      if (eqByDay.length > 0) {
        const maxPnl = Math.max(...eqByDay.map(e => Math.abs(e.pnl)), 1);
        eqChart = '\n<b>에쿼티 추이 (7일):</b>\n<pre>' +
          eqByDay.map(e => {
            const bar = makeBar(e.pnl, maxPnl, 8);
            return `${e.day.slice(5)} ${e.pnl >= 0 ? '+' : ''}$${e.pnl.toFixed(0).padStart(4)} ${bar}`;
          }).join('\n') + '</pre>';
      }

      sendTelegramWithButtons(
        `📊 <b>Paper Trader 상태</b>\n\n` +
        `자본: <b>$${s.capital.toFixed(0)}</b> (${s.returnPct > 0 ? '+' : ''}${s.returnPct}%)\n` +
        `총 PnL: $${s.totalPnl.toFixed(2)}\n` +
        `오늘 PnL: $${s.todayPnl.toFixed(2)}\n` +
        `거래: ${s.totalTrades}건 (${s.wins}승 ${s.losses}패)\n` +
        winBarLine +
        `최대 낙폭: ${s.maxDrawdown}%\n` +
        `연승: ${s.consecutiveWins} | Scalp: ${s.positionCount}/${s.effectiveMaxPositions} | Swing: ${s.swingPositionCount}/${s.maxSwingPositions}\n` +
        `전략: <b>${s.strategyMode.toUpperCase()}</b>\n` +
        `시장: ${s.marketRegime.regime || 'NORMAL'} (BTC ${s.marketRegime.btcChange >= 0 ? '+' : ''}${(s.marketRegime.btcChange || 0).toFixed(1)}%)\n\n` +
        `<b>Scalp 포지션:</b>\n${posLines}\n` +
        (swingLines ? `<b>Swing 포지션:</b>\n${swingLines}\n` : '') +
        eqChart,
        [[{ text: '📊 상세 대시보드', url: DASHBOARD_URL }]]
      );
      break;
    }

    case '/positions':
    case '/포지션': {
      const allPos = [...state.positions, ...(state.swingPositions || [])];
      if (!allPos.length) { sendTelegram('📭 보유 포지션 없음'); break; }
      let totalUnreal = 0;
      const posLines = [];
      for (const pos of allPos) {
        let price = null;
        try { price = await _deps.fetchPrice(pos.symbol); } catch (e) { console.warn(`[tg] fetchPrice ${pos.symbol}: ${e.message}`); }
        const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
        let unrealPnl = 0;
        if (price) {
          unrealPnl = isLong ? (price - pos.entryPrice) * pos.quantity : (pos.entryPrice - price) * pos.quantity;
        }
        totalUnreal += unrealPnl;
        const pnlPct = pos.costBasis > 0 ? (unrealPnl / pos.costBasis * 100).toFixed(2) : '0';
        const hours = ((Date.now() - pos.entryTs) / 3600000).toFixed(1);
        const trail = pos.trailLevel ? ` T${pos.trailLevel}` : '';
        const partial = pos.partialClosed ? ' ½' : '';
        const emoji = unrealPnl >= 0 ? '🟢' : '🔴';
        const stratTag = pos.strategy === 'swing' ? ' [W]' : ' [S]';
        posLines.push(
          `${emoji} <b>${pos.symbol} ${pos.direction}</b>${stratTag}${trail}${partial}\n` +
          `   진입 $${pos.entryPrice} → 현재 $${price || '?'}\n` +
          `   SL $${pos.slPrice} | TP $${pos.tpPrice}\n` +
          `   PnL <b>$${unrealPnl.toFixed(2)}</b> (${pnlPct}%) | ${hours}h`
        );
      }
      sendTelegram(
        `📌 <b>보유 포지션 (${allPos.length}개: S=${state.positions.length} W=${(state.swingPositions||[]).length})</b>\n\n` +
        posLines.join('\n\n') +
        `\n\n━━━━━━━━━━━━━━━\n` +
        `합계: <b>$${totalUnreal.toFixed(2)}</b> | 자본: $${state.capital.toFixed(0)}`
      );
      break;
    }

    case '/history':
    case '/내역': {
      const hist = _deps.loadHistory().slice(-5).reverse();
      if (!hist.length) { sendTelegram('📭 거래 내역 없음'); break; }
      const lines = hist.map(t => {
        const emoji = (t.pnl || 0) > 0 ? '✅' : '❌';
        return `${emoji} ${t.symbol} ${t.direction} | $${(t.pnl || 0).toFixed(2)} (${t.closeReason}) | ${t.hoursHeld}h`;
      });
      sendTelegram(`📜 <b>최근 거래</b>\n\n${lines.join('\n')}`);
      break;
    }

    case '/stats':
    case '/통계': {
      const stats = _deps.getDetailedStats();
      const coinLines = Object.entries(stats.winRateByCoin)
        .sort((a, b) => b[1].totalPnl - a[1].totalPnl)
        .map(([sym, s]) => `${sym}: ${s.winRate}% (${s.wins}W/${s.losses}L) $${s.totalPnl}`);
      sendTelegram(
        `📈 <b>상세 통계</b>\n\n` +
        `평균 보유: ${stats.avgHoldTime}h\n` +
        `연속: ${stats.currentStreak.count}${stats.currentStreak.type === 'wins' ? '연승' : '연패'}\n` +
        (stats.bestTrade ? `최고: $${stats.bestTrade.pnl} (${stats.bestTrade.symbol})` : '') + '\n' +
        (stats.worstTrade ? `최악: $${stats.worstTrade.pnl} (${stats.worstTrade.symbol})` : '') + '\n\n' +
        `<b>코인별:</b>\n${coinLines.join('\n') || '데이터 없음'}`
      );
      break;
    }

    case '/pnl': {
      const hist = _deps.loadHistory();
      const today = new Date().toISOString().slice(0, 10);
      const todayTrades = hist.filter(t => (t.exitTime || '').slice(0, 10) === today);
      const pnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const lines = todayTrades.map(t => {
        const emoji = (t.pnl || 0) > 0 ? '✅' : '❌';
        return `${emoji} ${t.symbol} ${t.direction} $${(t.pnl || 0).toFixed(2)}`;
      });
      sendTelegram(
        `💰 <b>오늘 PnL (${today})</b>\n\n` +
        `${lines.join('\n') || '거래 없음'}\n\n` +
        `합계: <b>$${pnl.toFixed(2)}</b>`
      );
      break;
    }

    case '/analyze':
    case '/분석': {
      const sym = (cmd[1] || '').toUpperCase();
      if (!sym || !SYMBOLS.includes(sym)) {
        sendTelegram(`❌ 사용법: /analyze BTC\n가능: ${SYMBOLS.join(', ')}`);
        break;
      }
      sendTelegram(`🔍 ${sym} 분석 시작...`);
      try {
        const decision = await _deps.runAnalysis(sym, 'scalp');
        if (decision) {
          sendTelegram(
            `📊 <b>${sym} 분석 결과</b>\n\n` +
            `판정: <b>${decision.action}</b> (${decision.confidence}%)\n` +
            `등급: ${decision.grade || '?'}\n` +
            `진입: ${decision.entry || '-'}\n` +
            `손절: ${decision.stop || '-'}\n` +
            `목표: ${decision.target || '-'}\n` +
            `${decision.multiTfConfirmed ? '✅ 멀티TF 확인됨' : ''}\n` +
            `근거: ${(decision.rationale || '').slice(0, 200)}`
          );
        } else {
          sendTelegram(`❌ ${sym} 분석 실패`);
        }
      } catch (e) {
        sendTelegram(`❌ ${sym} 분석 에러: ${e.message}`);
      }
      break;
    }

    case '/ranking':
    case '/순위': {
      try {
        const ranked = await _deps.getVolatilityRanking();
        const lines = ranked.map((r, i) => `${i + 1}. ${r.symbol} — ${r.changePct.toFixed(2)}%`);
        sendTelegram(`📊 <b>변동성 순위 (24h)</b>\n\n${lines.join('\n')}`);
      } catch {
        sendTelegram('❌ 순위 조회 실패');
      }
      break;
    }

    case '/market':
    case '/시장': {
      const prices = [];
      for (const sym of ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE']) {
        const p = await _deps.fetchPrice(sym);
        if (p) prices.push(`${sym}: $${p.toLocaleString()}`);
      }
      sendTelegram(`🌐 <b>시장 현황</b>\n\n${prices.join('\n')}`);
      break;
    }

    case '/risk':
    case '/리스크': {
      const s = _deps.getStatus();
      const dynRisk = _deps.getDynamicRisk(state);
      const blocked = (state.slPatterns || []).filter(p => (Date.now() - p.ts) < (_deps.SL_PATTERN_BLOCK_HOURS || 48) * 3600000);
      sendTelegram(
        `⚠️ <b>리스크 현황</b>\n\n` +
        `동적 리스크: ${(dynRisk * 100).toFixed(1)}%\n` +
        `연승: ${s.consecutiveWins} | 연패: ${s.consecutiveLosses}\n` +
        `최대 낙폭: ${s.maxDrawdown}%\n` +
        `서킷브레이커: ${s.circuitBreakerActive ? '🔴 활성' : '🟢 비활성'}\n` +
        `낙폭 중단: ${s.drawdownHaltActive ? '🔴 활성' : '🟢 비활성'}\n` +
        `차단 패턴: ${blocked.length}개\n` +
        `재진입 큐: ${s.reentryQueue}개\n` +
        `일일 손실 한도: $${_deps.DAILY_LOSS_LIMIT} | 주간: $${_deps.WEEKLY_MAX_LOSS} | DD: ${_deps.TOTAL_MAX_DD * 100}%`
      );
      break;
    }

    case '/config':
    case '/설정': {
      sendTelegram(
        `⚙️ <b>설정</b>\n\n` +
        `시작 자본: $${CONFIG.startCapital}\n` +
        `리스크/거래: ${CONFIG.riskPerTrade * 100}%\n` +
        `최대 포지션: ${CONFIG.maxPositions} (연승 시 최대 5)\n` +
        `최소 확신도: ${CONFIG.minConfidence}%\n` +
        `최소 등급: ${CONFIG.minGrade}\n` +
        `최대 보유: ${CONFIG.maxHoldHours}h\n` +
        `서킷브레이커: ${CONFIG.circuitBreakerLosses}연패 → ${CONFIG.circuitBreakerHours}h\n` +
        `일일 손실 한도: $${_deps.DAILY_LOSS_LIMIT}\n` +
        `분석 간격: 15분\n` +
        `AI: ACE/BLITZ/GUARD=Sonnet, 나머지=Haiku`
      );
      break;
    }

    case '/stop':
    case '/중지': {
      _deps.stop();
      sendTelegram('⏹ Paper Trader 중지됨');
      break;
    }

    case '/resume':
    case '/재개': {
      const running = _deps.getStatus().running;
      if (!running) {
        _deps.start();
        sendTelegram('▶️ Paper Trader 재개됨');
      } else {
        sendTelegram('이미 실행 중');
      }
      break;
    }

    case '/reset':
    case '/초기화': {
      const result = _deps.reset();
      sendTelegram(`🔄 ${result.message}`);
      _deps.start();
      break;
    }

    case '/syshealth':
    case '/시스템': {
      const uptime = process.uptime();
      const mem = process.memoryUsage();
      const s = _deps.getStatus();
      sendTelegram(
        `🏥 <b>시스템 상태</b>\n\n` +
        `업타임: ${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m\n` +
        `메모리: ${Math.round(mem.heapUsed / 1024 / 1024)}MB / ${Math.round(mem.heapTotal / 1024 / 1024)}MB\n` +
        `분석 루프: ${s.running ? '🟢 실행중' : '🔴 중지'}\n` +
        `텔레그램 봇: 🟢 실행중`
      );
      break;
    }

    case '/close':
    case '/청산': {
      const sym = (parts[1] || '').toUpperCase();
      if (!sym) { sendTelegram('❌ 사용법: /close BTC'); break; }
      let posIdx = state.positions.findIndex(p => p.symbol === sym);
      let posArray = state.positions;
      if (posIdx === -1 && state.swingPositions) {
        posIdx = state.swingPositions.findIndex(p => p.symbol === sym);
        posArray = state.swingPositions;
      }
      if (posIdx === -1) { sendTelegram(`❌ ${sym} 포지션 없음`); break; }
      const pos = posArray[posIdx];
      const price = await _deps.fetchPrice(sym);
      if (!price) { sendTelegram(`❌ ${sym} 현재가 조회 실패`); break; }
      const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
      const pnl = isLong ? (price - pos.entryPrice) * pos.quantity : (pos.entryPrice - price) * pos.quantity;
      const fee = pos.quantity * price * CONFIG.feeMaker * 2;
      const netPnl = pnl - fee;
      const hoursHeld = (Date.now() - pos.entryTs) / 3600000;

      state.capital += netPnl;
      state.totalPnl += netPnl;
      state.totalTrades++;
      if (netPnl > 0) { state.wins++; state.consecutiveLosses = 0; state.consecutiveWins = (state.consecutiveWins || 0) + 1; }
      else { state.losses++; state.consecutiveLosses++; state.consecutiveWins = 0; }
      if (state.capital > state.peakCapital) state.peakCapital = state.capital;
      const dd = (state.peakCapital - state.capital) / state.peakCapital;
      if (dd > state.maxDrawdown) state.maxDrawdown = dd;

      const trade = {
        symbol: sym, direction: pos.direction, grade: pos.grade, confidence: pos.confidence,
        entryPrice: pos.entryPrice, exitPrice: price, slPrice: pos.slPrice, tpPrice: pos.tpPrice,
        quantity: pos.quantity, pnl: Math.round(netPnl * 100) / 100,
        pnlPct: Math.round(netPnl / pos.costBasis * 10000) / 100,
        closeReason: 'MANUAL', entryTime: pos.entryTime, exitTime: new Date().toISOString(),
        hoursHeld: Math.round(hoursHeld * 10) / 10, capitalAfter: Math.round(state.capital * 100) / 100,
      };
      posArray.splice(posIdx, 1);
      _deps.saveState(state);

      const emoji = netPnl > 0 ? '✅' : '❌';
      const stratLabel = pos.strategy === 'swing' ? ' [Swing]' : '';
      sendTelegram(
        `${emoji} <b>${sym} 수동 청산${stratLabel}</b>\n` +
        `진입: $${pos.entryPrice} → 현재: $${price}\n` +
        `PnL: <b>$${netPnl.toFixed(2)}</b> (${trade.pnlPct}%)\n` +
        `보유: ${trade.hoursHeld}h\n` +
        `자본: $${state.capital.toFixed(0)}`
      );
      break;
    }

    case '/closeall':
    case '/전체청산': {
      const allClosePos = [...state.positions, ...(state.swingPositions || [])];
      if (!allClosePos.length) { sendTelegram('📭 보유 포지션 없음'); break; }
      let totalNetPnl = 0;
      const closedList = [];
      for (const swPos of (state.swingPositions || [])) { state.positions.push(swPos); }
      state.swingPositions = [];
      for (let i = state.positions.length - 1; i >= 0; i--) {
        const pos = state.positions[i];
        const price = await _deps.fetchPrice(pos.symbol);
        if (!price) continue;
        const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
        const pnl = isLong ? (price - pos.entryPrice) * pos.quantity : (pos.entryPrice - price) * pos.quantity;
        const fee = pos.quantity * price * CONFIG.feeMaker * 2;
        const netPnl = pnl - fee;
        state.capital += netPnl;
        state.totalPnl += netPnl;
        state.totalTrades++;
        if (netPnl > 0) { state.wins++; state.consecutiveLosses = 0; state.consecutiveWins = (state.consecutiveWins || 0) + 1; }
        else { state.losses++; state.consecutiveLosses++; state.consecutiveWins = 0; }
        closedList.push(`${netPnl > 0 ? '✅' : '❌'} ${pos.symbol} $${netPnl.toFixed(2)}`);
        totalNetPnl += netPnl;
      }
      state.positions = [];
      if (state.capital > state.peakCapital) state.peakCapital = state.capital;
      const ddAll = (state.peakCapital - state.capital) / state.peakCapital;
      if (ddAll > state.maxDrawdown) state.maxDrawdown = ddAll;
      _deps.saveState(state);

      sendTelegram(
        `🔴 <b>전체 청산 완료</b>\n\n` +
        `${closedList.join('\n')}\n\n` +
        `합계: <b>$${totalNetPnl.toFixed(2)}</b> (${closedList.length}건)\n` +
        `자본: $${state.capital.toFixed(0)}`
      );
      break;
    }

    case '/profit':
    case '/수익': {
      const hist = _deps.loadHistory();
      if (!hist.length) { sendTelegram('📭 거래 내역 없음'); break; }
      const returnPct = ((state.capital - state.startCapital) / state.startCapital * 100).toFixed(1);
      const winRate = state.totalTrades > 0 ? (state.wins / state.totalTrades * 100).toFixed(1) : '0';
      const dailyMap = {};
      for (const t of hist) {
        const day = (t.exitTime || '').slice(0, 10);
        if (day) dailyMap[day] = (dailyMap[day] || 0) + (t.pnl || 0);
      }
      const days = Object.keys(dailyMap).sort().slice(-10);
      const maxAbsPnl = Math.max(...days.map(d => Math.abs(dailyMap[d])), 1);
      const barLines = days.map(d => {
        const pnl = dailyMap[d];
        const barLen = Math.round(Math.abs(pnl) / maxAbsPnl * 10);
        const bar = pnl >= 0 ? '█'.repeat(barLen) : '░'.repeat(barLen);
        return `${d.slice(5)} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${bar}`;
      });
      sendTelegram(
        `💰 <b>전체 수익 보고서</b>\n\n` +
        `시작: $${state.startCapital} → 현재: <b>$${state.capital.toFixed(0)}</b>\n` +
        `수익률: <b>${returnPct}%</b>\n` +
        `총 PnL: $${state.totalPnl.toFixed(2)}\n` +
        `거래: ${state.totalTrades}건 (${state.wins}W/${state.losses}L)\n` +
        `승률: ${winRate}%\n` +
        `최대 낙폭: ${(state.maxDrawdown * 100).toFixed(1)}%\n\n` +
        `<b>일별 PnL (최근 10일):</b>\n<pre>${barLines.join('\n') || '데이터 없음'}</pre>`
      );
      break;
    }

    case '/top': {
      const hist = _deps.loadHistory();
      if (!hist.length) { sendTelegram('📭 거래 내역 없음'); break; }
      const coinPnl = {};
      for (const t of hist) { coinPnl[t.symbol] = (coinPnl[t.symbol] || 0) + (t.pnl || 0); }
      const top3 = Object.entries(coinPnl).sort((a, b) => b[1] - a[1]).slice(0, 3);
      const lines = top3.map(([sym, pnl], i) => `${['🥇', '🥈', '🥉'][i]} ${sym}: <b>$${pnl.toFixed(2)}</b>`);
      sendTelegram(`🏆 <b>수익 TOP 3</b>\n\n${lines.join('\n') || '데이터 없음'}`);
      break;
    }

    case '/worst': {
      const hist = _deps.loadHistory();
      if (!hist.length) { sendTelegram('📭 거래 내역 없음'); break; }
      const coinPnl = {};
      for (const t of hist) { coinPnl[t.symbol] = (coinPnl[t.symbol] || 0) + (t.pnl || 0); }
      const worst3 = Object.entries(coinPnl).sort((a, b) => a[1] - b[1]).slice(0, 3);
      const lines = worst3.map(([sym, pnl], i) => `${i + 1}. ${sym}: <b>$${pnl.toFixed(2)}</b>`);
      sendTelegram(`📉 <b>손실 TOP 3</b>\n\n${lines.join('\n') || '데이터 없음'}`);
      break;
    }

    case '/alert':
    case '/알림': {
      const sym = (parts[1] || '').toUpperCase();
      const targetPrice = parseFloat(parts[2]);
      if (!sym || isNaN(targetPrice)) { sendTelegram('❌ 사용법: /alert BTC 65000'); break; }
      const curPrice = await _deps.fetchPrice(sym);
      if (!curPrice) { sendTelegram(`❌ ${sym} 현재가 조회 실패`); break; }
      const direction = targetPrice > curPrice ? 'above' : 'below';
      state.priceAlerts.push({ symbol: sym, targetPrice, direction, createdAt: new Date().toISOString() });
      _deps.saveState(state);
      sendTelegram(
        `🔔 <b>가격 알림 설정</b>\n\n` +
        `${sym} $${targetPrice.toLocaleString()} ${direction === 'above' ? '이상' : '이하'} 도달 시 알림\n` +
        `현재가: $${curPrice.toLocaleString()}\n` +
        `총 알림: ${state.priceAlerts.length}개`
      );
      break;
    }

    case '/alerts':
    case '/알림목록': {
      if (!state.priceAlerts.length) { sendTelegram('📭 설정된 알림 없음'); break; }
      const lines = state.priceAlerts.map((a, i) =>
        `${i + 1}. ${a.symbol} $${a.targetPrice.toLocaleString()} (${a.direction === 'above' ? '▲이상' : '▼이하'})`
      );
      sendTelegram(`🔔 <b>가격 알림 목록</b>\n\n${lines.join('\n')}`);
      break;
    }

    case '/cancelalert':
    case '/알림취소': {
      const num = parseInt(parts[1]);
      if (isNaN(num) || num < 1 || num > state.priceAlerts.length) {
        sendTelegram(`❌ 사용법: /cancelalert [번호] (1~${state.priceAlerts.length})`);
        break;
      }
      const removed = state.priceAlerts.splice(num - 1, 1)[0];
      _deps.saveState(state);
      sendTelegram(`🔕 알림 취소: ${removed.symbol} $${removed.targetPrice}`);
      break;
    }

    case '/mode':
    case '/모드': {
      const mode = (parts[1] || '').toLowerCase();
      if (mode !== 'scalp' && mode !== 'attack') {
        sendTelegram('❌ 사용법: /mode scalp 또는 /mode attack');
        break;
      }
      state.forceMode = mode;
      _deps.saveState(state);
      sendTelegram(`⚙️ 분석 모드 → <b>${mode.toUpperCase()}</b> (강제)`);
      break;
    }

    case '/auto':
    case '/자동': {
      delete state.forceMode;
      _deps.saveState(state);
      sendTelegram('⚙️ 분석 모드 → <b>AUTO</b> (시장 상황 자동 판단)');
      break;
    }

    case '/skip':
    case '/제외': {
      const sym = (parts[1] || '').toUpperCase();
      if (!sym) { sendTelegram('❌ 사용법: /skip BTC'); break; }
      if (!state.skipList.includes(sym)) {
        state.skipList.push(sym);
        _deps.saveState(state);
      }
      sendTelegram(`🚫 ${sym} 분석 제외됨\n제외 목록: ${state.skipList.join(', ')}`);
      break;
    }

    case '/unskip':
    case '/제외해제': {
      const sym = (parts[1] || '').toUpperCase();
      const idx = state.skipList.indexOf(sym);
      if (idx === -1) { sendTelegram(`❌ ${sym}은 제외 목록에 없음`); break; }
      state.skipList.splice(idx, 1);
      _deps.saveState(state);
      sendTelegram(`✅ ${sym} 제외 해제\n제외 목록: ${state.skipList.join(', ') || '없음'}`);
      break;
    }

    case '/leverage':
    case '/레버리지': {
      const lev = parseInt(parts[1]);
      if (isNaN(lev) || lev < 1 || lev > 125) { sendTelegram('❌ 사용법: /leverage 20 (1~125)'); break; }
      state.leverage = lev;
      _deps.saveState(state);
      sendTelegram(`⚙️ 레버리지 → <b>${lev}x</b>`);
      break;
    }

    case '/maxpos': {
      const num = parseInt(parts[1]);
      if (isNaN(num) || num < 1 || num > 10) { sendTelegram('❌ 사용법: /maxpos 3 (1~10)'); break; }
      CONFIG.maxPositions = num;
      const state = _deps.getState ? _deps.getState() : _deps.loadState();
      if (_deps.saveState) _deps.saveState(state);
      sendTelegram(`⚙️ 최대 포지션 수 → <b>${num}</b>`);
      break;
    }

    case '/interval':
    case '/간격': {
      const min = parseInt(parts[1]);
      if (isNaN(min) || min < 5 || min > 120) { sendTelegram('❌ 사용법: /interval 15 (5~120분)'); break; }
      if (_deps.setAnalysisInterval) _deps.setAnalysisInterval(min);
      sendTelegram(`⚙️ 분석 간격 → <b>${min}분</b>`);
      break;
    }

    case '/balance':
    case '/잔고': {
      const returnPct = ((state.capital - state.startCapital) / state.startCapital * 100).toFixed(1);
      const hist = _deps.loadHistory();
      let minCap = state.startCapital;
      let runCap = state.startCapital;
      for (const t of hist) {
        runCap += (t.pnl || 0);
        if (runCap < minCap) minCap = runCap;
      }
      sendTelegram(
        `💼 <b>자본 상세</b>\n\n` +
        `시작: $${state.startCapital}\n` +
        `현재: <b>$${state.capital.toFixed(2)}</b>\n` +
        `최고: $${state.peakCapital.toFixed(2)}\n` +
        `최저: $${minCap.toFixed(2)}\n` +
        `수익률: <b>${returnPct}%</b>\n` +
        `최대 낙폭: ${(state.maxDrawdown * 100).toFixed(1)}%`
      );
      break;
    }

    case '/today':
    case '/오늘': {
      const hist = _deps.loadHistory();
      const today = new Date().toISOString().slice(0, 10);
      const todayTrades = hist.filter(t => (t.exitTime || '').slice(0, 10) === today);
      const todayEntries = hist.filter(t => (t.entryTime || '').slice(0, 10) === today);
      const todayPnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const wins = todayTrades.filter(t => (t.pnl || 0) > 0).length;
      const todayLogs = (state.analysisLog || []).filter(l => (l.ts || '').slice(0, 10) === today);
      const buyCount = todayLogs.filter(l => l.action === 'BUY').length;
      const sellCount = todayLogs.filter(l => l.action === 'SELL').length;
      const holdCount = todayLogs.filter(l => l.action === 'HOLD').length;
      sendTelegram(
        `📅 <b>오늘 활동 (${today})</b>\n\n` +
        `분석: ${todayLogs.length}회\n` +
        `  BUY: ${buyCount} | SELL: ${sellCount} | HOLD: ${holdCount}\n` +
        `진입: ${todayEntries.length}건\n` +
        `청산: ${todayTrades.length}건 (${wins}승 ${todayTrades.length - wins}패)\n` +
        `PnL: <b>$${todayPnl.toFixed(2)}</b>\n` +
        `현재 포지션: ${state.positions.length}개`
      );
      break;
    }

    case '/week':
    case '/주간': {
      const hist = _deps.loadHistory();
      const now = new Date();
      const weekStart = new Date(now);
      weekStart.setDate(now.getDate() - now.getDay());
      weekStart.setHours(0, 0, 0, 0);
      const weekStartStr = weekStart.toISOString().slice(0, 10);
      const weekTrades = hist.filter(t => (t.exitTime || '') >= weekStartStr);
      const weekPnl = weekTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const weekWins = weekTrades.filter(t => (t.pnl || 0) > 0).length;
      const dailyMap = {};
      for (const t of weekTrades) {
        const day = (t.exitTime || '').slice(0, 10);
        if (!dailyMap[day]) dailyMap[day] = { pnl: 0, count: 0 };
        dailyMap[day].pnl += (t.pnl || 0);
        dailyMap[day].count++;
      }
      const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
      const dayLines = Object.keys(dailyMap).sort().map(d => {
        const dow = dayNames[new Date(d + 'T00:00:00').getDay()];
        const dp = dailyMap[d];
        return `${d.slice(5)}(${dow}) ${dp.count}건 ${dp.pnl >= 0 ? '+' : ''}$${dp.pnl.toFixed(0)}`;
      });
      sendTelegram(
        `📆 <b>이번 주 요약</b>\n\n` +
        `거래: ${weekTrades.length}건 (${weekWins}승 ${weekTrades.length - weekWins}패)\n` +
        `PnL: <b>$${weekPnl.toFixed(2)}</b>\n` +
        `승률: ${weekTrades.length > 0 ? (weekWins / weekTrades.length * 100).toFixed(0) : 0}%\n\n` +
        `<b>일별:</b>\n${dayLines.join('\n') || '거래 없음'}`
      );
      break;
    }

    case '/equity':
    case '/자본': {
      const hist = _deps.loadHistory();
      if (!hist.length) { sendTelegram('📭 거래 내역 없음'); break; }
      const dailyMap = {};
      for (const t of hist) {
        const day = (t.exitTime || '').slice(0, 10);
        if (day) dailyMap[day] = (dailyMap[day] || 0) + (t.pnl || 0);
      }
      const days = Object.keys(dailyMap).sort().slice(-14);
      let running = state.startCapital;
      const allDays = Object.keys(dailyMap).sort();
      const equityByDay = [];
      for (const d of allDays) {
        running += dailyMap[d];
        if (days.includes(d)) equityByDay.push({ day: d, capital: running });
      }
      const minCap = Math.min(...equityByDay.map(e => e.capital));
      const maxCap = Math.max(...equityByDay.map(e => e.capital));
      const range = maxCap - minCap || 1;
      const barLines = equityByDay.map(e => {
        const barLen = Math.round((e.capital - minCap) / range * 15) + 1;
        return `${e.day.slice(5)} $${e.capital.toFixed(0)} ${'█'.repeat(barLen)}`;
      });
      sendTelegram(
        `📊 <b>자본금 변동 (최근 14일)</b>\n\n` +
        `<pre>${barLines.join('\n')}</pre>\n\n` +
        `최저: $${minCap.toFixed(0)} | 최고: $${maxCap.toFixed(0)}`
      );
      break;
    }

    case '/whoami': {
      const uptime = process.uptime();
      const uptimeStr = `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`;
      sendTelegram(
        `🤖 <b>시스템 정보</b>\n\n` +
        `버전: Paper Trader v2-AI\n` +
        `업타임: ${uptimeStr}\n` +
        `VPS: ${process.env.HOSTNAME || 'vultr-vps'}\n` +
        `Node: ${process.version}\n` +
        `메인 모델: Claude Sonnet (ACE/BLITZ/GUARD)\n` +
        `서브 모델: Claude Haiku (나머지)\n` +
        `분석 코인: ${SYMBOLS.length}개\n` +
        `제외 코인: ${state.skipList.length > 0 ? state.skipList.join(', ') : '없음'}\n` +
        `모드: ${state.forceMode ? state.forceMode.toUpperCase() + ' (강제)' : 'AUTO'}\n` +
        `레버리지: ${state.leverage || 20}x\n` +
        `최대 포지션: ${CONFIG.maxPositions}\n` +
        `PID: ${process.pid}`
      );
      break;
    }

    case '/learn':
    case '/학습': {
      const lessons = learner.loadLessons();
      if (lessons.length < 5) {
        sendTelegram(`📭 학습 데이터 부족 (${lessons.length}/5건)\n거래가 더 필요합니다.`);
        break;
      }
      const result = learner.analyzeLessons(lessons);
      sendTelegram(learner.formatLearnResultForTelegram(result));
      break;
    }

    case '/rules':
    case '/규칙': {
      sendTelegram(learner.formatRulesForTelegram());
      break;
    }

    case '/patterns':
    case '/패턴': {
      sendTelegram(learner.formatPatternsForTelegram());
      break;
    }

    case '/backtest':
    case '/백테스트': {
      const sym = (parts[1] || 'BTC').toUpperCase();
      const strategy = (parts[2] || 'confluence').toLowerCase();
      const days = parseInt(parts[3]) || 90;
      sendTelegram(`🔬 ${sym} ${strategy} ${days}일 백테스트 시작...`);
      try {
        const result = await backtester.backtest(sym, strategy, Math.min(days, 365));
        const emoji = result.totalPnl > 0 ? '📈' : '📉';
        sendTelegram(
          `${emoji} <b>백테스트 결과</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `전략: <b>${result.strategyName}</b>\n` +
          `코인: ${result.symbol} | 기간: ${result.days}일\n` +
          `━━━━━━━━━━━━━━━\n` +
          `거래: ${result.totalTrades}건 (${result.wins}승 ${result.losses}패)\n` +
          `승률: <b>${result.winRate}%</b>\n` +
          `총 PnL: <b>$${result.totalPnl}</b>\n` +
          `수익률: ${result.returnPct}%\n` +
          `최대 낙폭: ${result.maxDrawdown}%\n` +
          `━━━━━━━━━━━━━━━\n` +
          `샤프 비율: ${result.sharpeRatio}\n` +
          `Profit Factor: ${result.profitFactor}\n` +
          `기대값: $${result.expectancy}/trade\n` +
          `평균 수익: $${result.avgWin} (${result.avgWinPct}%)\n` +
          `평균 손실: $${result.avgLoss} (${result.avgLossPct}%)\n` +
          `━━━━━━━━━━━━━━━\n` +
          `$${result.startCapital} → $${result.endCapital}`
        );
      } catch (e) {
        sendTelegram(`❌ 백테스트 실패: ${e.message}`);
      }
      break;
    }

    case '/signal':
    case '/시그널': {
      const sym = (parts[1] || 'BTC').toUpperCase();
      sendTelegram(`📡 ${sym} 퀀트 시그널 조회...`);
      try {
        const signal = await quantSignals.getSignalForSymbol(sym);
        const dirEmoji = signal.action === 'BUY' ? '🟢' : signal.action === 'SELL' ? '🔴' : '⚪';
        const ind = signal.indicators || {};
        const bd = signal.breakdown || {};
        sendTelegram(
          `${dirEmoji} <b>${sym} 퀀트 시그널</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `판정: <b>${signal.action}</b> (확신 ${signal.confidence}%)\n` +
          `종합 점수: <b>${signal.totalScore}</b> / ${signal.maxScore}\n` +
          `━━━━━━━━━━━━━━━\n` +
          `<b>지표별 점수:</b>\n` +
          `  RSI: ${bd.rsi || 0} (${ind.rsi || '?'})\n` +
          `  EMA: ${bd.ema || 0}\n` +
          `  MACD: ${bd.macd || 0}\n` +
          `  BB: ${bd.bb || 0}\n` +
          `  거래량: ${bd.volume || 0}\n` +
          `  모멘텀: ${bd.momentum || 0}\n` +
          `━━━━━━━━━━━━━━━\n` +
          `가격: $${ind.price || '?'}\n` +
          `EMA: 9=${ind.ema9 || '?'} / 21=${ind.ema21 || '?'} / 50=${ind.ema50 || '?'}`
        );
      } catch (e) {
        sendTelegram(`❌ 시그널 조회 실패: ${e.message}`);
      }
      break;
    }

    case '/strategies':
    case '/전략': {
      const strats = Object.entries(backtester.strategies).map(([key, s]) =>
        `  <b>${key}</b> — ${s.name}\n    ${s.description}\n    SL ${s.slPct * 100}% / TP ${s.tpPct * 100}%`
      );
      sendTelegram(
        `📋 <b>사용 가능한 전략</b>\n\n${strats.join('\n\n')}\n\n` +
        `사용법: /backtest BTC [전략명] [일수]`
      );
      break;
    }

    case '/compare':
    case '/비교': {
      const sym = (parts[1] || 'BTC').toUpperCase();
      const days = parseInt(parts[2]) || 90;
      sendTelegram(`🔬 ${sym} 전략 비교 시작 (${days}일)... 잠시 기다려주세요.`);
      try {
        const result = await backtester.compareAll(sym, Math.min(days, 365));
        const rankLines = result.ranking.map((r, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
          return `${medal} <b>${r.name}</b>\n   승률 ${r.winRate}% | PnL $${r.totalPnl} | PF ${r.profitFactor}\n   샤프 ${r.sharpeRatio} | 기대값 $${r.expectancy} | ${r.trades}건`;
        });
        sendTelegram(
          `📊 <b>${sym} 전략 비교 (${days}일)</b>\n` +
          `━━━━━━━━━━━━━━━\n\n` +
          `${rankLines.join('\n\n')}\n\n` +
          `━━━━━━━━━━━━━━━\n` +
          `최적 전략: <b>${result.bestName || '없음'}</b>`
        );
      } catch (e) {
        sendTelegram(`❌ 전략 비교 실패: ${e.message}`);
      }
      break;
    }

    case '/qscan':
    case '/퀀트스캔': {
      sendTelegram('📡 TOP 10 퀀트 스캔 중...');
      try {
        const scanResults = [];
        for (const sym of SYMBOLS) {
          try {
            const sig = await quantSignals.getSignalForSymbol(sym);
            const ind = sig.indicators || {};
            scanResults.push({
              symbol: sym, action: sig.action || 'HOLD', grade: sig.grade || 'D',
              score: sig.totalScore || 0,
              rsi: ind.rsi != null ? Math.round(ind.rsi) : '-',
              macd: ind.macdHist != null ? (ind.macdHist > 0 ? '+' : '') + Math.round(ind.macdHist * 100) : '-',
            });
          } catch {
            scanResults.push({ symbol: sym, action: 'ERR', grade: '-', score: 0, rsi: '-', macd: '-' });
          }
        }
        scanResults.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
        const header = '코인  | 판정 | 등급 | 점수  | RSI | MACD';
        const sep = '------+------+------+-------+-----+------';
        const rows = scanResults.map(r => {
          const sym = r.symbol.padEnd(5);
          const act = r.action.padEnd(4);
          const gr = String(r.grade).padEnd(4);
          const sc = String(r.score > 0 ? '+' + r.score : r.score).padStart(5);
          const rsi = String(r.rsi).padStart(3);
          const macd = String(r.macd).padStart(4);
          return `${sym} | ${act} | ${gr} | ${sc} | ${rsi} | ${macd}`;
        });
        sendTelegram(
          `📡 <b>TOP 10 퀀트 시그널 스캔</b>\n\n` +
          `<pre>${header}\n${sep}\n${rows.join('\n')}</pre>`
        );
      } catch (e) {
        sendTelegram(`❌ 스캔 실패: ${e.message}`);
      }
      break;
    }

    case '/ensemble':
    case '/앙상블': {
      const sym = (parts[1] || 'BTC').toUpperCase();
      sendTelegram(`🗳 ${sym} 앙상블 투표 분석 중...`);
      try {
        const pair = sym + 'USDT';
        const candleRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=1h&limit=200`, { signal: AbortSignal.timeout(10000) });
        if (!candleRes.ok) throw new Error(`Binance API ${candleRes.status}`);
        const raw = await candleRes.json();
        const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
        const vote = quantSignals.ensembleVote(candles);
        const total = vote.votes.buy + vote.votes.sell + vote.votes.hold;
        const buyBar = makeBar(vote.votes.buy, total, 10);
        const sellBar = makeBar(vote.votes.sell, total, 10);
        const holdBar = makeBar(vote.votes.hold, total, 10);
        const voterLines = (vote.voters || []).map(v => {
          const [name, dir] = v.split(':');
          const emoji = dir === 'BUY' ? '🟢' : dir === 'SELL' ? '🔴' : '⚪';
          return `  ${emoji} ${name}: ${dir}`;
        });
        sendTelegram(
          `🗳 <b>${sym} 앙상블 투표 결과</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `판정: <b>${vote.action}</b> (확신 ${vote.confidence}%)\n\n` +
          `<pre>BUY  ${vote.votes.buy.toString().padStart(2)} ${buyBar}\nSELL ${vote.votes.sell.toString().padStart(2)} ${sellBar}\nHOLD ${vote.votes.hold.toString().padStart(2)} ${holdBar}</pre>\n\n` +
          `전략 수: ${vote.totalStrategies} | 과반: ${vote.majorityThreshold}\n\n` +
          `<b>전략별 투표:</b>\n${voterLines.join('\n')}`
        );
      } catch (e) {
        sendTelegram(`❌ 앙상블 분석 실패: ${e.message}`);
      }
      break;
    }

    case '/optimize':
    case '/최적화': {
      sendTelegram('🔧 전략 최적화 중... (백테스트 + 리밸런싱, 1~2분 소요)');
      try {
        const result = await backtester.selectBestStrategy(['BTC', 'ETH', 'SOL'], 30);
        const prev = state.activeStrategy || 'confluence';
        if (result.best) {
          state.activeStrategy = result.best;
          state.activeStrategyUpdated = new Date().toISOString();
          _deps.saveState(state);
        }
        const scoreLines = Object.entries(result.scores)
          .filter(([, s]) => s.count > 0)
          .sort(([, a], [, b]) => (b.sharpeSum + b.pfSum) / b.count - (a.sharpeSum + a.pfSum) / a.count)
          .map(([key, s], i) => {
            const avg = (s.sharpeSum + s.pfSum) / s.count;
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
            return `${medal} ${key}: avg=${avg.toFixed(2)} (${s.count}심볼)`;
          });
        const weightLines = Object.entries(result.strategyWeights || {})
          .sort(([, a], [, b]) => b - a)
          .slice(0, 5)
          .map(([k, w]) => `  ${k}: ${(w * 100).toFixed(1)}%`);
        sendTelegram(
          `🔧 <b>전략 최적화 완료</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `이전: ${prev}\n` +
          `최적: <b>${result.best || '없음'}</b> (${result.bestName || '?'})\n\n` +
          `<b>전략별 점수:</b>\n${scoreLines.join('\n')}\n\n` +
          `<b>리스크 패리티 가중치:</b>\n${weightLines.join('\n') || '  데이터 부족'}`
        );
      } catch (e) {
        sendTelegram(`❌ 최적화 실패: ${e.message}`);
      }
      break;
    }

    // ═══ 새 명령어: /perf ═══
    case '/perf': {
      try {
        const attr = _deps.getPerformanceAttribution ? _deps.getPerformanceAttribution() : null;
        if (!attr || !attr.totalTrades) {
          sendTelegram('📭 성과 attribution 데이터 부족 (최소 5건 거래 필요)');
          break;
        }
        const indLines = Object.entries(attr.indicatorAccuracy || {})
          .sort(([, a], [, b]) => b.accuracy - a.accuracy)
          .slice(0, 8)
          .map(([ind, data]) => {
            const bar = makeBar(data.accuracy, 100, 6);
            return `  ${ind}: ${bar} ${data.accuracy.toFixed(0)}% (${data.correct}/${data.total})`;
          });
        const stratLines = Object.entries(attr.strategyPnl || {})
          .sort(([, a], [, b]) => b - a)
          .map(([strat, pnl]) => `  ${strat}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
        sendTelegram(
          `📊 <b>성과 Attribution</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `총 거래: ${attr.totalTrades}건\n` +
          `AI 판정 승률: ${attr.aiWinRate.toFixed(1)}%\n` +
          `퀀트 시그널 승률: ${attr.quantWinRate.toFixed(1)}%\n` +
          `멀티TF 확인 승률: ${attr.multiTfWinRate.toFixed(1)}%\n\n` +
          `<b>지표별 정확도:</b>\n<pre>${indLines.join('\n') || '데이터 없음'}</pre>\n\n` +
          `<b>전략별 PnL:</b>\n${stratLines.join('\n') || '데이터 없음'}`
        );
      } catch (e) {
        sendTelegram(`❌ 성과 분석 실패: ${e.message}`);
      }
      break;
    }

    // ═══ 새 명령어: /depth ═══
    case '/depth': {
      const sym = (parts[1] || 'BTC').toUpperCase();
      sendTelegram(`📊 ${sym} 오더북 분석 중...`);
      try {
        const flow = await (_deps.getOrderFlowScore ? _deps.getOrderFlowScore(sym) : null);
        const slip = _deps.estimateSlippage ? await _deps.estimateSlippage(sym, 1000, 'BUY') : null;
        if (!flow) { sendTelegram(`❌ ${sym} 오더북 조회 실패`); break; }
        const bidBar = makeBar(flow.bidRatio * 100, 100, 10);
        const askBar = makeBar(flow.askRatio * 100, 100, 10);
        let msg =
          `📊 <b>${sym} 오더북 분석</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `<pre>BID ${bidBar} ${(flow.bidRatio * 100).toFixed(1)}%\nASK ${askBar} ${(flow.askRatio * 100).toFixed(1)}%</pre>\n\n` +
          `불균형 점수: <b>${flow.score > 0 ? '+' : ''}${flow.score}</b>\n` +
          `해석: ${flow.interpretation}\n` +
          `━━━━━━━━━━━━━━━\n` +
          `Bid 총량: ${flow.bidVolume.toFixed(2)}\n` +
          `Ask 총량: ${flow.askVolume.toFixed(2)}\n`;
        if (slip) {
          msg += `\n<b>슬리피지 추정 ($1000):</b>\n` +
            `  BUY: ${slip.slippagePct.toFixed(3)}% ($${slip.slippageUsd.toFixed(2)})\n` +
            `  추정 체결가: $${slip.estimatedPrice.toFixed(2)}\n` +
            `  사이즈 조정: ${slip.sizeRecommendation}`;
        }
        sendTelegram(msg);
      } catch (e) {
        sendTelegram(`❌ 오더북 분석 실패: ${e.message}`);
      }
      break;
    }

    // ═══ 새 명령어: /portfolio ═══
    case '/portfolio': {
      try {
        const corr = _deps.getPortfolioCorrelation ? _deps.getPortfolioCorrelation() : null;
        if (!corr || !corr.positions || corr.positions.length === 0) {
          sendTelegram('📭 보유 포지션 없음 — 포트폴리오 분석 불가');
          break;
        }
        const divBar = makeBar(corr.diversificationScore, 100, 10);
        let msg =
          `📊 <b>포트폴리오 분석</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `보유: ${corr.positions.length}개\n` +
          `<pre>분산도: ${divBar} ${corr.diversificationScore}/100</pre>\n\n`;
        if (corr.warnings && corr.warnings.length > 0) {
          msg += `<b>경고:</b>\n` + corr.warnings.map(w => `  ⚠️ ${w}`).join('\n') + '\n\n';
        }
        if (corr.matrix && corr.matrix.length > 0) {
          msg += `<b>상관관계:</b>\n`;
          for (const row of corr.matrix) {
            msg += `  ${row.pair}: ${row.correlation.toFixed(2)} ${row.correlation > 0.7 ? '⚠️ 높음' : row.correlation < -0.3 ? '✅ 역상관' : ''}\n`;
          }
        }
        sendTelegram(msg);
      } catch (e) {
        sendTelegram(`❌ 포트폴리오 분석 실패: ${e.message}`);
      }
      break;
    }

    // ═══ 새 명령어: /tf ═══
    case '/tf': {
      const sym = (parts[1] || 'BTC').toUpperCase();
      sendTelegram(`🔬 ${sym} 타임프레임 비교 시작... (1~2분 소요)`);
      try {
        const tfResult = _deps.getOptimalTimeframe ? await _deps.getOptimalTimeframe(sym) : null;
        if (!tfResult) { sendTelegram(`❌ ${sym} TF 비교 실패`); break; }
        const tfLines = tfResult.results.map((r, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i+1}.`;
          return `${medal} <b>${r.timeframe}</b>\n   승률 ${r.winRate}% | PnL $${r.totalPnl} | 샤프 ${r.sharpe}\n   거래 ${r.trades}건 | PF ${r.profitFactor}`;
        });
        sendTelegram(
          `🔬 <b>${sym} 타임프레임 비교</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `최적 TF: <b>${tfResult.optimal}</b>\n\n` +
          `${tfLines.join('\n\n')}`
        );
      } catch (e) {
        sendTelegram(`❌ TF 비교 실패: ${e.message}`);
      }
      break;
    }

    // ═══ 새 명령어: /report ═══
    case '/report': {
      try {
        const s = _deps.getStatus();
        const stats = _deps.getDetailedStats();
        const hist = _deps.loadHistory();
        const returnPct = ((s.capital - s.startCapital) / s.startCapital * 100).toFixed(1);
        const winRate = s.totalTrades > 0 ? (s.wins / s.totalTrades * 100).toFixed(1) : '0';

        // 최근 7일 PnL
        const dailyMap = {};
        for (const t of hist) {
          const day = (t.exitTime || '').slice(0, 10);
          if (day) dailyMap[day] = (dailyMap[day] || 0) + (t.pnl || 0);
        }
        const recentDays = Object.keys(dailyMap).sort().slice(-7);
        const maxAbsPnl = Math.max(...recentDays.map(d => Math.abs(dailyMap[d] || 0)), 1);
        const dayLines = recentDays.map(d => {
          const pnl = dailyMap[d] || 0;
          const bar = makeBar(pnl, maxAbsPnl, 8);
          return `${d.slice(5)} ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)} ${bar}`;
        });

        // 코인별 PnL
        const coinPnl = {};
        for (const t of hist) { coinPnl[t.symbol] = (coinPnl[t.symbol] || 0) + (t.pnl || 0); }
        const coinLines = Object.entries(coinPnl)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([sym, pnl]) => `  ${pnl >= 0 ? '✅' : '❌'} ${sym}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);

        // attribution
        let attrLine = '';
        try {
          const attr = _deps.getPerformanceAttribution ? _deps.getPerformanceAttribution() : null;
          if (attr && attr.totalTrades) {
            attrLine = `\n<b>Attribution:</b>\n` +
              `  AI 승률: ${attr.aiWinRate.toFixed(1)}%\n` +
              `  퀀트 승률: ${attr.quantWinRate.toFixed(1)}%\n` +
              `  멀티TF 승률: ${attr.multiTfWinRate.toFixed(1)}%\n`;
          }
        } catch {}

        sendTelegramWithButtons(
          `📋 <b>종합 성과 리포트</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `자본: <b>$${s.capital.toFixed(0)}</b> (${returnPct}%)\n` +
          `총 PnL: $${s.totalPnl.toFixed(2)}\n` +
          `거래: ${s.totalTrades}건 (${s.wins}승 ${s.losses}패)\n` +
          `승률: ${winRate}% | 최대 DD: ${s.maxDrawdown}%\n` +
          `연승: ${s.consecutiveWins} | 연패: ${s.consecutiveLosses}\n` +
          `시장: ${s.marketRegime.regime || 'NORMAL'}\n\n` +
          `<b>일별 PnL (7일):</b>\n<pre>${dayLines.join('\n') || '데이터 없음'}</pre>\n\n` +
          `<b>코인별 PnL:</b>\n${coinLines.join('\n') || '데이터 없음'}\n` +
          attrLine +
          `\n<b>최고:</b> ${stats.bestTrade ? `$${stats.bestTrade.pnl} (${stats.bestTrade.symbol})` : '-'}` +
          `\n<b>최악:</b> ${stats.worstTrade ? `$${stats.worstTrade.pnl} (${stats.worstTrade.symbol})` : '-'}`,
          [[{ text: '📊 대시보드', url: DASHBOARD_URL }]]
        );
      } catch (e) {
        sendTelegram(`❌ 리포트 생성 실패: ${e.message}`);
      }
      break;
    }

    // ═══ /regime — 마켓 레짐 ═══
    case '/regime':
    case '/레짐': {
      try {
        const symbols = cmd[1] ? [cmd[1].toUpperCase()] : ['BTC', 'ETH', 'SOL'];
        const lines = [];
        for (const sym of symbols) {
          const pair = sym.replace('USDT', '') + 'USDT';
          const res = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=1h&limit=100`, { signal: AbortSignal.timeout(8000) });
          if (!res.ok) { lines.push(`${sym}: 조회 실패`); continue; }
          const raw = await res.json();
          if (!Array.isArray(raw) || raw.length < 60) { lines.push(`${sym}: 캔들 부족`); continue; }
          const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
          const regime = quantSignals.classifyRegime(candles);
          const emoji = { TRENDING_UP: '📈', TRENDING_DOWN: '📉', RANGING: '↔️', VOLATILE: '⚡', NORMAL: '➖', UNKNOWN: '❓' }[regime.regime] || '❓';
          lines.push(
            `${emoji} <b>${sym}: ${regime.regime}</b>\n` +
            `   ${regime.label}\n` +
            `   ADX: ${regime.adx || '?'} | BB폭: ${regime.bbWidth}% | ATR: ${regime.atrRatio}x\n` +
            `   추천: ${regime.suggestedStrategy}`
          );
        }
        sendTelegram(`🔍 <b>마켓 레짐 분석</b>\n━━━━━━━━━━━━━━━\n\n${lines.join('\n\n')}`);
      } catch (e) {
        sendTelegram(`❌ 레짐 분석 실패: ${e.message}`);
      }
      break;
    }

    // ═══ /funding — 멀티코인 펀딩레이트 ═══
    case '/funding':
    case '/펀딩': {
      try {
        const result = await quantSignals.getMultiFunding();
        if (!result.rates.length) { sendTelegram('❌ 펀딩레이트 조회 실패'); break; }
        const lines = result.rates.map(r => {
          const emoji = r.signal === 'short_opportunity' ? '🔴' : r.signal === 'long_opportunity' ? '🟢' : r.signal === 'slightly_overheated' ? '🟡' : r.signal === 'slightly_oversold' ? '🟡' : '⚪';
          return `${emoji} <b>${r.symbol}</b>: ${r.rate >= 0 ? '+' : ''}${r.rate.toFixed(4)}% (연 ${r.annualized >= 0 ? '+' : ''}${r.annualized.toFixed(1)}%)`;
        });
        sendTelegram(`💰 <b>펀딩레이트 (10코인)</b>\n━━━━━━━━━━━━━━━\n\n${lines.join('\n')}\n\n🔴 숏기회 | 🟢 롱기회 | ⚪ 중립`);
      } catch (e) {
        sendTelegram(`❌ 펀딩레이트 조회 실패: ${e.message}`);
      }
      break;
    }

    // ═══ /momentum — 크로스 모멘텀 순위 ═══
    case '/momentum':
    case '/모멘텀': {
      try {
        const result = await quantSignals.getCrossMomentum();
        if (!result.ranking.length) { sendTelegram('❌ 모멘텀 순위 조회 실패'); break; }
        const lines = result.ranking.map((r, i) => {
          const emoji = i < 3 ? '🟢' : i >= result.ranking.length - 3 ? '🔴' : '⚪';
          return `${emoji} ${(i + 1).toString().padStart(2)}. <b>${r.symbol}</b>: 7일 ${r.roc7d >= 0 ? '+' : ''}${r.roc7d}% | 3일 ${r.roc3d >= 0 ? '+' : ''}${r.roc3d}% | 점수 ${r.momentum}`;
        });
        const topLong = result.topLong.map(r => r.symbol).join(', ');
        const topShort = result.topShort.map(r => r.symbol).join(', ');
        sendTelegram(
          `📊 <b>크로스 모멘텀 순위</b>\n━━━━━━━━━━━━━━━\n\n${lines.join('\n')}\n\n` +
          `🟢 롱 후보: <b>${topLong}</b>\n🔴 숏 후보: <b>${topShort}</b>`
        );
      } catch (e) {
        sendTelegram(`❌ 모멘텀 순위 조회 실패: ${e.message}`);
      }
      break;
    }

    // ═══ /orderflow — 오더북 불균형 ═══
    case '/orderflow':
    case '/오더북': {
      try {
        const sym = (cmd[1] || 'BTC').toUpperCase();
        const ob = await quantSignals.getOrderbookImbalance(sym);
        const emoji = ob.score > 0 ? '🟢' : ob.score < 0 ? '🔴' : '⚪';
        const barLen = 20;
        const bidPct = Math.round((ob.bidRatio || 0.5) * barLen);
        const askPct = barLen - bidPct;
        const bar = '🟩'.repeat(bidPct) + '🟥'.repeat(askPct);

        sendTelegram(
          `${emoji} <b>${sym} 오더북 불균형</b>\n━━━━━━━━━━━━━━━\n\n` +
          `Bid 총량: <b>${ob.bidTotal}</b>\n` +
          `Ask 총량: <b>${ob.askTotal}</b>\n` +
          `Bid/Ask 비율: <b>${ob.ratio}</b>\n\n` +
          `${bar}\n\n` +
          `점수: <b>${ob.score}</b> | ${ob.interpretation}\n\n` +
          `> Bid/Ask > 1.5 → 매수 우세\n> Bid/Ask < 0.67 → 매도 우세`
        );
      } catch (e) {
        sendTelegram(`❌ 오더북 조회 실패: ${e.message}`);
      }
      break;
    }

    // ═══ /ai — AI+퀀트+앙상블 종합 분석 ═══
    case '/ai': {
      const sym = (parts[1] || 'BTC').toUpperCase();
      if (!SYMBOLS.includes(sym)) {
        sendTelegram(`❌ 사용법: /ai BTC\n가능: ${SYMBOLS.join(', ')}`);
        break;
      }
      sendTelegram(`🧠 ${sym} AI+퀀트+앙상블 종합 분석 중...`);
      try {
        // 1) AI 분석
        const aiDecision = await _deps.runAnalysis(sym, 'scalp');
        // 2) 퀀트 시그널
        const qSig = await quantSignals.getSignalForSymbol(sym);
        // 3) 앙상블 투표
        const pair = sym + 'USDT';
        const candleRes = await fetch(`https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=1h&limit=200`, { signal: AbortSignal.timeout(10000) });
        let vote = null;
        if (candleRes.ok) {
          const raw = await candleRes.json();
          const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
          vote = quantSignals.ensembleVote(candles);
        }
        // 4) 병합
        let merged = null;
        if (aiDecision && qSig) {
          merged = quantSignals.mergeSignals(aiDecision, qSig);
        }

        const aiEmoji = !aiDecision ? '❓' : aiDecision.action === 'BUY' ? '🟢' : aiDecision.action === 'SELL' ? '🔴' : '⚪';
        const qEmoji = qSig.action === 'BUY' ? '🟢' : qSig.action === 'SELL' ? '🔴' : '⚪';
        const mismatch = aiDecision && qSig && aiDecision.action !== qSig.action && aiDecision.action !== 'HOLD' && qSig.action !== 'HOLD';

        let msg =
          `🧠 <b>${sym} 종합 분석</b>\n` +
          `━━━━━━━━━━━━━━━\n\n`;

        // AI
        if (aiDecision) {
          msg += `${aiEmoji} <b>AI 판정:</b> ${aiDecision.action} ${aiDecision.confidence}% ${aiDecision.grade || '?'}등급\n`;
        } else {
          msg += `❓ <b>AI 판정:</b> 분석 실패\n`;
        }

        // 퀀트
        msg += `${qEmoji} <b>퀀트:</b> ${qSig.action} ${qSig.confidence}% ${qSig.grade || '?'}등급 (점수 ${qSig.totalScore})\n`;

        // 앙상블
        if (vote) {
          msg += `🗳 <b>앙상블:</b> BUY ${vote.votes.buy} / SELL ${vote.votes.sell} / HOLD ${vote.votes.hold}\n`;
        }

        msg += `━━━━━━━━━━━━━━━\n`;

        // 병합 결과
        if (merged) {
          const mergedEmoji = merged.action === 'BUY' ? '🟢' : merged.action === 'SELL' ? '🔴' : '⚪';
          msg += `${mergedEmoji} <b>병합 결과:</b> ${merged.action} (확신 ${merged.confidence}%)`;
          if (mismatch) msg += ` ⚠️ AI vs 퀀트 불일치`;
          msg += `\n`;
          if (merged.reason) msg += `사유: ${merged.reason}\n`;
        }

        // 근거 요약
        if (aiDecision && aiDecision.rationale) {
          msg += `\n<b>근거:</b>\n${(aiDecision.rationale || '').slice(0, 300)}`;
        }

        sendTelegram(msg);
      } catch (e) {
        sendTelegram(`❌ ${sym} 종합 분석 실패: ${e.message}`);
      }
      break;
    }

    // ═══ /watchlist — 10코인 전체 현황 ═══
    case '/watchlist': {
      sendTelegram('📋 워치리스트 조회 중...');
      try {
        const posMap = {};
        for (const p of [...state.positions, ...(state.swingPositions || [])]) {
          posMap[p.symbol] = p;
        }

        const rows = [];
        for (const sym of SYMBOLS) {
          const price = await _deps.fetchPrice(sym);
          const recentDec = _deps.getRecentDecision(sym);
          const action = recentDec ? recentDec.action : 'HOLD';
          const grade = recentDec ? (recentDec.grade || '?') : '?';
          const actionEmoji = action === 'BUY' ? '🟢' : action === 'SELL' ? '🔴' : '⚪';
          const hasPos = posMap[sym] ? ' ← 보유' : '';
          const priceStr = price ? `$${price.toLocaleString()}` : '$?';

          rows.push(`${actionEmoji} ${sym.padEnd(5)} ${priceStr.padStart(10)}  ${action.padEnd(4)} ${grade}${hasPos}`);
        }

        sendTelegram(
          `📋 <b>워치리스트 (${SYMBOLS.length}코인)</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `<pre>${rows.join('\n')}</pre>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `보유: ${Object.keys(posMap).length}개 | 제외: ${(state.skipList || []).join(', ') || '없음'}`
        );
      } catch (e) {
        sendTelegram(`❌ 워치리스트 조회 실패: ${e.message}`);
      }
      break;
    }

    // ═══ /daily — 오늘 상세 활동 로그 ═══
    case '/daily': {
      const hist = _deps.loadHistory();
      const today = new Date().toISOString().slice(0, 10);
      const todayLogs = (state.analysisLog || []).filter(l => (l.ts || '').slice(0, 10) === today);
      const todayTrades = hist.filter(t => (t.exitTime || '').slice(0, 10) === today);
      const todayEntries = hist.filter(t => (t.entryTime || '').slice(0, 10) === today);
      const todayPnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const wins = todayTrades.filter(t => (t.pnl || 0) > 0).length;

      const buyCount = todayLogs.filter(l => l.action === 'BUY').length;
      const sellCount = todayLogs.filter(l => l.action === 'SELL').length;
      const holdCount = todayLogs.filter(l => l.action === 'HOLD').length;

      // 퀀트 필터로 스킵된 건수 (grade D로 HOLD된 것)
      const quantSkipped = todayLogs.filter(l => l.action === 'HOLD' && l.confidence === 0 && (l.grade === 'D' || !l.grade)).length;

      // 멀티TF 다이버전스로 거부된 건 (BUY/SELL이지만 진입 안 된 것)
      const signalCount = todayLogs.filter(l => l.action === 'BUY' || l.action === 'SELL').length;
      const entryCount = todayEntries.length;
      const rejectedCount = Math.max(0, signalCount - entryCount);

      // 시간대별 분포
      const hourMap = {};
      for (const l of todayLogs) {
        const hr = (l.ts || '').slice(11, 13);
        if (hr) hourMap[hr] = (hourMap[hr] || 0) + 1;
      }
      const hourLine = Object.entries(hourMap).sort().map(([h, c]) => `${h}:00(${c}건)`).join(' ');

      // 코인별 분석
      const coinAnalysis = {};
      for (const l of todayLogs) {
        if (!coinAnalysis[l.symbol]) coinAnalysis[l.symbol] = { buy: 0, sell: 0, hold: 0 };
        if (l.action === 'BUY') coinAnalysis[l.symbol].buy++;
        else if (l.action === 'SELL') coinAnalysis[l.symbol].sell++;
        else coinAnalysis[l.symbol].hold++;
      }
      const coinLines = Object.entries(coinAnalysis)
        .map(([sym, c]) => `  ${sym}: B${c.buy}/S${c.sell}/H${c.hold}`)
        .join('\n');

      sendTelegram(
        `📊 <b>오늘 상세 로그 (${today})</b>\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `<b>분석:</b> ${todayLogs.length}회\n` +
        `  🟢 BUY: ${buyCount} | 🔴 SELL: ${sellCount} | ⚪ HOLD: ${holdCount}\n\n` +
        `<b>실행:</b>\n` +
        `  진입: ${entryCount}건 | 청산: ${todayTrades.length}건 (${wins}승 ${todayTrades.length - wins}패)\n` +
        `  PnL: <b>$${todayPnl.toFixed(2)}</b>\n\n` +
        `<b>필터링:</b>\n` +
        `  퀀트 스킵 (D등급): ${quantSkipped}건\n` +
        `  시그널→미진입: ${rejectedCount}건\n\n` +
        `<b>코인별:</b>\n${coinLines || '  분석 없음'}\n\n` +
        `<b>시간대:</b>\n  ${hourLine || '없음'}`
      );
      break;
    }

    // ═══ /winrate — 조건별 승률 상세 ═══
    case '/winrate': {
      const hist = _deps.loadHistory();
      if (hist.length < 5) { sendTelegram('📭 거래 데이터 부족 (최소 5건 필요)'); break; }

      // RSI 구간별 승률 (거래에 기록된 지표 기반)
      const rsiRanges = { '0-30': { w: 0, t: 0 }, '30-50': { w: 0, t: 0 }, '50-70': { w: 0, t: 0 }, '70-100': { w: 0, t: 0 } };
      for (const t of hist) {
        const rsi = t.rsi || (t.indicators && t.indicators.rsi);
        if (rsi != null) {
          const key = rsi < 30 ? '0-30' : rsi < 50 ? '30-50' : rsi < 70 ? '50-70' : '70-100';
          rsiRanges[key].t++;
          if ((t.pnl || 0) > 0) rsiRanges[key].w++;
        }
      }
      const rsiLines = Object.entries(rsiRanges)
        .filter(([, v]) => v.t > 0)
        .map(([range, v]) => {
          const wr = (v.w / v.t * 100).toFixed(0);
          const bar = makeBar(v.w / v.t * 100, 100, 6);
          return `  RSI ${range}: ${bar} ${wr}% (${v.w}/${v.t})`;
        });

      // 시간대별 승률
      const hourWin = {};
      for (const t of hist) {
        const hr = (t.entryTime || '').slice(11, 13);
        if (!hr) continue;
        if (!hourWin[hr]) hourWin[hr] = { w: 0, t: 0 };
        hourWin[hr].t++;
        if ((t.pnl || 0) > 0) hourWin[hr].w++;
      }
      const hourLines = Object.entries(hourWin)
        .sort()
        .filter(([, v]) => v.t >= 2)
        .map(([hr, v]) => `  ${hr}시: ${(v.w / v.t * 100).toFixed(0)}% (${v.w}/${v.t})`)
        .slice(0, 8);

      // 코인별 승률
      const coinWin = {};
      for (const t of hist) {
        if (!coinWin[t.symbol]) coinWin[t.symbol] = { w: 0, t: 0, pnl: 0 };
        coinWin[t.symbol].t++;
        coinWin[t.symbol].pnl += (t.pnl || 0);
        if ((t.pnl || 0) > 0) coinWin[t.symbol].w++;
      }
      const coinLines = Object.entries(coinWin)
        .sort((a, b) => (b[1].w / b[1].t) - (a[1].w / a[1].t))
        .map(([sym, v]) => `  ${sym}: ${(v.w / v.t * 100).toFixed(0)}% (${v.w}/${v.t}) $${v.pnl.toFixed(1)}`);

      // 등급별 승률
      const gradeWin = {};
      for (const t of hist) {
        const g = t.grade || '?';
        if (!gradeWin[g]) gradeWin[g] = { w: 0, t: 0 };
        gradeWin[g].t++;
        if ((t.pnl || 0) > 0) gradeWin[g].w++;
      }
      const gradeLines = Object.entries(gradeWin)
        .sort()
        .filter(([, v]) => v.t > 0)
        .map(([g, v]) => `  ${g}등급: ${(v.w / v.t * 100).toFixed(0)}% (${v.w}/${v.t})`);

      // TOP 3 / WORST 3 조건 계산
      const allConditions = [];
      for (const [sym, v] of Object.entries(coinWin)) {
        if (v.t >= 3) allConditions.push({ label: `코인 ${sym}`, wr: v.w / v.t, count: v.t });
      }
      for (const [g, v] of Object.entries(gradeWin)) {
        if (v.t >= 3) allConditions.push({ label: `등급 ${g}`, wr: v.w / v.t, count: v.t });
      }
      for (const [hr, v] of Object.entries(hourWin)) {
        if (v.t >= 3) allConditions.push({ label: `${hr}시`, wr: v.w / v.t, count: v.t });
      }
      allConditions.sort((a, b) => b.wr - a.wr);
      const top3 = allConditions.slice(0, 3).map(c => `  🟢 ${c.label}: ${(c.wr * 100).toFixed(0)}% (${c.count}건)`);
      const worst3 = allConditions.slice(-3).reverse().map(c => `  🔴 ${c.label}: ${(c.wr * 100).toFixed(0)}% (${c.count}건)`);

      sendTelegram(
        `📈 <b>조건별 승률 분석</b> (${hist.length}건)\n` +
        `━━━━━━━━━━━━━━━\n\n` +
        `<b>RSI 구간별:</b>\n${rsiLines.join('\n') || '  데이터 없음'}\n\n` +
        `<b>시간대별:</b>\n${hourLines.join('\n') || '  데이터 없음'}\n\n` +
        `<b>코인별:</b>\n${coinLines.join('\n') || '  데이터 없음'}\n\n` +
        `<b>등급별:</b>\n${gradeLines.join('\n') || '  데이터 없음'}\n\n` +
        `━━━━━━━━━━━━━━━\n` +
        `🏆 <b>TOP 3 조건:</b>\n${top3.join('\n') || '  데이터 부족'}\n\n` +
        `💀 <b>WORST 3 조건:</b>\n${worst3.join('\n') || '  데이터 부족'}`
      );
      break;
    }

    // ═══ /next — 다음 분석 예정 정보 ═══
    case '/next': {
      try {
        const s = _deps.getStatus();
        const lastTs = s.lastAnalysis ? new Date(s.lastAnalysis).getTime() : 0;
        const intervalMs = 15 * 60 * 1000; // ANALYSIS_INTERVAL
        const nextTs = lastTs + intervalMs;
        const remainMs = Math.max(0, nextTs - Date.now());
        const remainMin = Math.ceil(remainMs / 60000);

        const lastSwingTs = s.lastSwingAnalysis ? new Date(s.lastSwingAnalysis).getTime() : 0;
        const swingIntervalMs = 30 * 60 * 1000;
        const nextSwingTs = lastSwingTs + swingIntervalMs;
        const swingRemainMs = Math.max(0, nextSwingTs - Date.now());
        const swingRemainMin = Math.ceil(swingRemainMs / 60000);

        // 퀀트 사전 필터 결과
        const skipSet = new Set(state.skipList || []);
        const openSyms = new Set([...state.positions, ...(state.swingPositions || [])].map(p => p.symbol));
        const candidates = SYMBOLS.filter(sym => !openSyms.has(sym) && !skipSet.has(sym));

        let prefilterLines = '';
        if (candidates.length > 0) {
          const prefilterResults = [];
          for (const sym of candidates.slice(0, 5)) {
            try {
              const qSig = await quantSignals.getSignalForSymbol(sym);
              const pass = (qSig.grade || 'D') !== 'D';
              const emoji = pass ? '✅' : '❌';
              prefilterResults.push(`  ${emoji} ${sym}: ${qSig.action} ${qSig.grade || 'D'}등급 (${qSig.totalScore}점)`);
            } catch {
              prefilterResults.push(`  ❓ ${sym}: 조회 실패`);
            }
          }
          prefilterLines = prefilterResults.join('\n');
        }

        sendTelegram(
          `⏰ <b>다음 분석 예정</b>\n` +
          `━━━━━━━━━━━━━━━\n\n` +
          `<b>Scalp:</b>\n` +
          `  다음 분석: <b>${remainMin}분</b> 후\n` +
          `  다음 코인: ${s.nextSymbol || '?'}\n` +
          `  마지막: ${s.lastAnalysis ? s.lastAnalysis.slice(11, 19) : '없음'}\n\n` +
          `<b>Swing:</b>\n` +
          `  다음 분석: <b>${swingRemainMin}분</b> 후\n` +
          `  다음 코인: ${s.nextSwingSymbol || '?'}\n` +
          `  마지막: ${s.lastSwingAnalysis ? s.lastSwingAnalysis.slice(11, 19) : '없음'}\n\n` +
          `<b>분석 대상 (${candidates.length}코인):</b>\n` +
          `  후보: ${candidates.join(', ') || '없음'}\n` +
          `  보유 중: ${[...openSyms].join(', ') || '없음'}\n` +
          `  제외: ${(state.skipList || []).join(', ') || '없음'}\n\n` +
          `<b>퀀트 사전 필터 (TOP 5):</b>\n${prefilterLines || '  후보 없음'}`
        );
      } catch (e) {
        sendTelegram(`❌ 다음 분석 정보 조회 실패: ${e.message}`);
      }
      break;
    }

    // ═══════════════════════════════════════════
    // ══ 수동 진입 / 전략 실시간 수정 ══
    // ═══════════════════════════════════════════

    case '/long':
    case '/롱': {
      // /long BTC [수량%] [SL%] [TP%]
      // 예: /long BTC → 기본 리스크로 롱
      // 예: /long ETH 3 2 4 → 자본 3% 리스크, SL 2%, TP 4%
      const sym = (parts[1] || '').toUpperCase();
      if (!sym) { sendTelegram('❌ 사용법: /long BTC [리스크%] [SL%] [TP%]\n예: /long ETH 3 2 4'); break; }

      const price = await _deps.fetchPrice(sym);
      if (!price) { sendTelegram(`❌ ${sym} 현재가 조회 실패`); break; }

      // 이미 보유 중인지 체크
      const existing = state.positions.find(p => p.symbol === sym);
      if (existing) { sendTelegram(`❌ ${sym} 이미 ${existing.direction} 포지션 보유 중`); break; }

      const riskPct = parseFloat(parts[2]) || (CONFIG.riskPerTrade * 100);
      const slPct = parseFloat(parts[3]) || null;
      const tpPct = parseFloat(parts[4]) || null;

      let slPrice, tpPrice;
      if (slPct && tpPct) {
        slPrice = price * (1 - slPct / 100);
        tpPrice = price * (1 + tpPct / 100);
      } else {
        // ATR 기반 자동 계산
        try {
          const atr = await quantSignals.getATRStops(sym, 'BUY');
          if (atr) { slPrice = atr.slPrice; tpPrice = atr.tpPrice; }
        } catch {}
        if (!slPrice) { slPrice = price * 0.98; tpPrice = price * (1 + 0.02 * 1.75); }
      }

      const LEVERAGE = state.leverage || 20;
      const riskAmt = state.capital * (riskPct / 100);
      const slDist = Math.abs(price - slPrice);
      const quantity = slDist > 0 ? riskAmt / slDist : 0;
      const costBasis = quantity * price;
      const margin = costBasis / LEVERAGE;

      if (margin > state.capital * 0.6 || quantity <= 0) { sendTelegram(`❌ 마진 부족 (필요: $${margin.toFixed(0)}, 보유: $${state.capital.toFixed(0)})`); break; }

      const position = {
        symbol: sym, direction: 'BUY', grade: 'M', confidence: 100,
        strategy: 'manual', entryPrice: price,
        slPrice: Math.round(slPrice * 100) / 100, tpPrice: Math.round(tpPrice * 100) / 100,
        quantity: Math.round(quantity * 1000) / 1000, costBasis: Math.round(costBasis * 100) / 100,
        maxHoldHours: CONFIG.maxHoldHours || 24, entryTs: Date.now(), entryTime: new Date().toISOString(),
        rationale: '수동 진입',
      };
      state.positions.push(position);
      _deps.saveState(state);

      const rr = slDist > 0 ? (Math.abs(tpPrice - price) / slDist).toFixed(1) : '?';
      sendTelegramWithButtons(
        `🟢 <b>수동 LONG 진입</b>\n━━━━━━━━━━━━━━━\n` +
        `코인: <b>${sym}</b> | 진입: <b>$${price}</b>\n` +
        `SL: $${position.slPrice} (${(slDist / price * 100).toFixed(1)}%)\n` +
        `TP: $${position.tpPrice} (${(Math.abs(tpPrice - price) / price * 100).toFixed(1)}%)\n` +
        `R:R = ${rr}:1\n━━━━━━━━━━━━━━━\n` +
        `수량: ${position.quantity} | 포지션: $${costBasis.toFixed(0)}\n` +
        `마진: $${margin.toFixed(0)} | 레버: ${LEVERAGE}x\n` +
        `리스크: ${riskPct.toFixed(1)}% ($${riskAmt.toFixed(0)})`,
        [[{ text: '📊 Terminal', url: `${TERMINAL_URL}/?coin=${sym}` }]]
      );
      break;
    }

    case '/short':
    case '/숏': {
      const sym = (parts[1] || '').toUpperCase();
      if (!sym) { sendTelegram('❌ 사용법: /short BTC [리스크%] [SL%] [TP%]\n예: /short ETH 3 2 4'); break; }

      const price = await _deps.fetchPrice(sym);
      if (!price) { sendTelegram(`❌ ${sym} 현재가 조회 실패`); break; }

      const existing = state.positions.find(p => p.symbol === sym);
      if (existing) { sendTelegram(`❌ ${sym} 이미 ${existing.direction} 포지션 보유 중`); break; }

      const riskPct = parseFloat(parts[2]) || (CONFIG.riskPerTrade * 100);
      const slPct = parseFloat(parts[3]) || null;
      const tpPct = parseFloat(parts[4]) || null;

      let slPrice, tpPrice;
      if (slPct && tpPct) {
        slPrice = price * (1 + slPct / 100);
        tpPrice = price * (1 - tpPct / 100);
      } else {
        try {
          const atr = await quantSignals.getATRStops(sym, 'SELL');
          if (atr) { slPrice = atr.slPrice; tpPrice = atr.tpPrice; }
        } catch {}
        if (!slPrice) { slPrice = price * 1.02; tpPrice = price * (1 - 0.02 * 1.75); }
      }

      const LEVERAGE = state.leverage || 20;
      const riskAmt = state.capital * (riskPct / 100);
      const slDist = Math.abs(slPrice - price);
      const quantity = slDist > 0 ? riskAmt / slDist : 0;
      const costBasis = quantity * price;
      const margin = costBasis / LEVERAGE;

      if (margin > state.capital * 0.6 || quantity <= 0) { sendTelegram(`❌ 마진 부족`); break; }

      const position = {
        symbol: sym, direction: 'SELL', grade: 'M', confidence: 100,
        strategy: 'manual', entryPrice: price,
        slPrice: Math.round(slPrice * 100) / 100, tpPrice: Math.round(tpPrice * 100) / 100,
        quantity: Math.round(quantity * 1000) / 1000, costBasis: Math.round(costBasis * 100) / 100,
        maxHoldHours: CONFIG.maxHoldHours || 24, entryTs: Date.now(), entryTime: new Date().toISOString(),
        rationale: '수동 진입',
      };
      state.positions.push(position);
      _deps.saveState(state);

      const rr = slDist > 0 ? (Math.abs(tpPrice - price) / slDist).toFixed(1) : '?';
      sendTelegramWithButtons(
        `🔴 <b>수동 SHORT 진입</b>\n━━━━━━━━━━━━━━━\n` +
        `코인: <b>${sym}</b> | 진입: <b>$${price}</b>\n` +
        `SL: $${position.slPrice} | TP: $${position.tpPrice}\n` +
        `R:R = ${rr}:1\n━━━━━━━━━━━━━━━\n` +
        `수량: ${position.quantity} | 포지션: $${costBasis.toFixed(0)}\n` +
        `리스크: ${riskPct.toFixed(1)}% ($${riskAmt.toFixed(0)})`,
        [[{ text: '📊 Terminal', url: `${TERMINAL_URL}/?coin=${sym}` }]]
      );
      break;
    }

    case '/sl': {
      // /sl BTC 61000 — 포지션의 SL 변경
      const sym = (parts[1] || '').toUpperCase();
      const newSl = parseFloat(parts[2]);
      if (!sym || isNaN(newSl)) { sendTelegram('❌ 사용법: /sl BTC 61000'); break; }

      const pos = state.positions.find(p => p.symbol === sym) || (state.swingPositions || []).find(p => p.symbol === sym);
      if (!pos) { sendTelegram(`❌ ${sym} 포지션 없음`); break; }

      const prevSl = pos.slPrice;
      pos.slPrice = Math.round(newSl * 100) / 100;
      _deps.saveState(state);
      sendTelegram(`⚙️ <b>${sym} SL 변경</b>\n$${prevSl} → <b>$${pos.slPrice}</b>`);
      break;
    }

    case '/tp': {
      // /tp BTC 65000 — 포지션의 TP 변경
      const sym = (parts[1] || '').toUpperCase();
      const newTp = parseFloat(parts[2]);
      if (!sym || isNaN(newTp)) { sendTelegram('❌ 사용법: /tp BTC 65000'); break; }

      const pos = state.positions.find(p => p.symbol === sym) || (state.swingPositions || []).find(p => p.symbol === sym);
      if (!pos) { sendTelegram(`❌ ${sym} 포지션 없음`); break; }

      const prevTp = pos.tpPrice;
      pos.tpPrice = Math.round(newTp * 100) / 100;
      _deps.saveState(state);
      sendTelegram(`⚙️ <b>${sym} TP 변경</b>\n$${prevTp} → <b>$${pos.tpPrice}</b>`);
      break;
    }

    case '/be': {
      // /be BTC — 포지션 SL을 진입가(BE)로 이동
      const sym = (parts[1] || '').toUpperCase();
      if (!sym) { sendTelegram('❌ 사용법: /be BTC'); break; }

      const pos = state.positions.find(p => p.symbol === sym) || (state.swingPositions || []).find(p => p.symbol === sym);
      if (!pos) { sendTelegram(`❌ ${sym} 포지션 없음`); break; }

      const feeCost = pos.quantity * pos.entryPrice * (CONFIG.feeMaker || 0.0002) * 2;
      const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
      const bePrice = isLong ? pos.entryPrice + feeCost / pos.quantity : pos.entryPrice - feeCost / pos.quantity;
      const prevSl = pos.slPrice;
      pos.slPrice = Math.round(bePrice * 100) / 100;
      _deps.saveState(state);
      sendTelegram(`🔒 <b>${sym} SL → BE (손익분기)</b>\n$${prevSl} → <b>$${pos.slPrice}</b> (수수료 포함)`);
      break;
    }

    case '/add': {
      // /add BTC 20 — 보유 포지션에 20% 추가 (수동 스케일인)
      const sym = (parts[1] || '').toUpperCase();
      const addPct = parseFloat(parts[2]) || 25;
      if (!sym) { sendTelegram('❌ 사용법: /add BTC [추가%]\n예: /add BTC 30 → 현재 수량의 30% 추가'); break; }

      const pos = state.positions.find(p => p.symbol === sym) || (state.swingPositions || []).find(p => p.symbol === sym);
      if (!pos) { sendTelegram(`❌ ${sym} 포지션 없음`); break; }

      const price = await _deps.fetchPrice(sym);
      if (!price) { sendTelegram(`❌ ${sym} 현재가 조회 실패`); break; }

      const addQty = Math.round(pos.quantity * (addPct / 100) * 1000) / 1000;
      const addCost = addQty * price;
      const LEVERAGE = state.leverage || 20;
      const addMargin = addCost / LEVERAGE;

      if (addMargin > state.capital * 0.3) { sendTelegram(`❌ 마진 부족 ($${addMargin.toFixed(0)} 필요)`); break; }

      const totalQty = pos.quantity + addQty;
      const totalCost = pos.costBasis + addCost;
      const newAvg = totalCost / totalQty;

      pos.quantity = Math.round(totalQty * 1000) / 1000;
      pos.costBasis = Math.round(totalCost * 100) / 100;
      pos.entryPrice = Math.round(newAvg * 100) / 100;
      _deps.saveState(state);

      sendTelegram(
        `📈 <b>${sym} 수동 추가 (+${addPct}%)</b>\n━━━━━━━━━━━━━━━\n` +
        `추가: ${addQty} @ $${price}\n` +
        `평균: $${pos.entryPrice}\n총 수량: ${pos.quantity}\n` +
        `SL: $${pos.slPrice} | TP: $${pos.tpPrice}`
      );
      break;
    }

    case '/reduce': {
      // /reduce BTC 50 — 보유 포지션 50% 축소 (수동 스케일아웃)
      const sym = (parts[1] || '').toUpperCase();
      const reducePct = parseFloat(parts[2]) || 50;
      if (!sym) { sendTelegram('❌ 사용법: /reduce BTC [축소%]\n예: /reduce BTC 50 → 50% 정리'); break; }

      let posIdx = state.positions.findIndex(p => p.symbol === sym);
      let posArray = state.positions;
      if (posIdx === -1 && state.swingPositions) {
        posIdx = state.swingPositions.findIndex(p => p.symbol === sym);
        posArray = state.swingPositions;
      }
      if (posIdx === -1) { sendTelegram(`❌ ${sym} 포지션 없음`); break; }

      const pos = posArray[posIdx];
      const price = await _deps.fetchPrice(sym);
      if (!price) { sendTelegram(`❌ ${sym} 현재가 조회 실패`); break; }

      const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
      const reduceQty = Math.round(pos.quantity * (reducePct / 100) * 1000) / 1000;
      const remainQty = pos.quantity - reduceQty;

      if (remainQty <= 0) {
        // 전량 청산
        sendTelegram(`💡 전량 청산은 /close ${sym} 사용`);
        break;
      }

      const pnl = isLong ? (price - pos.entryPrice) * reduceQty : (pos.entryPrice - price) * reduceQty;
      const fee = reduceQty * price * (CONFIG.feeMaker || 0.0002) * 2;
      const netPnl = pnl - fee;

      state.capital += netPnl;
      state.totalPnl += netPnl;
      pos.quantity = remainQty;
      pos.costBasis = Math.round(remainQty * pos.entryPrice * 100) / 100;
      _deps.saveState(state);

      sendTelegram(
        `📉 <b>${sym} 수동 축소 (-${reducePct}%)</b>\n━━━━━━━━━━━━━━━\n` +
        `청산: ${reduceQty} @ $${price}\n` +
        `PnL: <b>$${netPnl.toFixed(2)}</b>\n` +
        `남은: ${remainQty} ${sym}\n` +
        `자본: $${state.capital.toFixed(0)}`
      );
      break;
    }

    case '/flip': {
      // /flip BTC — 현재 포지션 방향 전환 (청산 후 반대 진입)
      const sym = (parts[1] || '').toUpperCase();
      if (!sym) { sendTelegram('❌ 사용법: /flip BTC'); break; }

      let posIdx = state.positions.findIndex(p => p.symbol === sym);
      let posArray = state.positions;
      if (posIdx === -1 && state.swingPositions) {
        posIdx = state.swingPositions.findIndex(p => p.symbol === sym);
        posArray = state.swingPositions;
      }
      if (posIdx === -1) { sendTelegram(`❌ ${sym} 포지션 없음`); break; }

      const pos = posArray[posIdx];
      const price = await _deps.fetchPrice(sym);
      if (!price) { sendTelegram(`❌ ${sym} 현재가 조회 실패`); break; }

      const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
      const pnl = isLong ? (price - pos.entryPrice) * pos.quantity : (pos.entryPrice - price) * pos.quantity;
      const fee = pos.quantity * price * (CONFIG.feeMaker || 0.0002) * 2;
      const netPnl = pnl - fee;

      // 기존 포지션 청산
      state.capital += netPnl;
      state.totalPnl += netPnl;
      state.totalTrades++;
      if (netPnl > 0) { state.wins++; state.consecutiveLosses = 0; } else { state.losses++; state.consecutiveLosses++; }
      posArray.splice(posIdx, 1);

      // 반대 방향 진입
      const newDir = isLong ? 'SELL' : 'BUY';
      let newSl, newTp;
      try {
        const atr = await quantSignals.getATRStops(sym, newDir);
        if (atr) { newSl = atr.slPrice; newTp = atr.tpPrice; }
      } catch {}
      if (!newSl) {
        newSl = newDir === 'BUY' ? price * 0.98 : price * 1.02;
        newTp = newDir === 'BUY' ? price * 1.035 : price * 0.965;
      }

      const riskAmt = state.capital * (CONFIG.riskPerTrade || 0.015);
      const slDist = Math.abs(price - newSl);
      const qty = slDist > 0 ? riskAmt / slDist : 0;

      if (qty > 0) {
        const newPos = {
          symbol: sym, direction: newDir, grade: 'M', confidence: 100,
          strategy: 'manual_flip', entryPrice: price,
          slPrice: Math.round(newSl * 100) / 100, tpPrice: Math.round(newTp * 100) / 100,
          quantity: Math.round(qty * 1000) / 1000, costBasis: Math.round(qty * price * 100) / 100,
          maxHoldHours: CONFIG.maxHoldHours || 24, entryTs: Date.now(), entryTime: new Date().toISOString(),
          rationale: '수동 방향전환',
        };
        state.positions.push(newPos);
        _deps.saveState(state);

        sendTelegram(
          `🔄 <b>${sym} 방향전환 (FLIP)</b>\n━━━━━━━━━━━━━━━\n` +
          `기존: ${isLong ? 'LONG→청산' : 'SHORT→청산'} PnL $${netPnl.toFixed(2)}\n` +
          `신규: <b>${newDir === 'BUY' ? 'LONG 🟢' : 'SHORT 🔴'}</b> @ $${price}\n` +
          `SL: $${newPos.slPrice} | TP: $${newPos.tpPrice}\n` +
          `수량: ${newPos.quantity}\n자본: $${state.capital.toFixed(0)}`
        );
      }
      break;
    }

    // ═══ 전략 실시간 수정 ═══

    case '/strategy': {
      // /strategy — 현재 전략 확인 / /strategy confluence — 전략 변경
      const strat = (parts[1] || '').toLowerCase();
      if (!strat) {
        const stratList = Object.entries(backtester.strategies).map(([k, v]) =>
          `${k === state.activeStrategy ? '▶️' : '  '} <b>${k}</b> — ${v.description ? v.description.slice(0, 40) : v.name}`
        );
        sendTelegram(
          `📋 <b>전략 목록</b> (현재: ${state.activeStrategy || 'confluence'})\n━━━━━━━━━━━━━━━\n` +
          `${stratList.join('\n')}\n━━━━━━━━━━━━━━━\n` +
          `전략 변경: /strategy [이름]`
        );
      } else {
        if (!backtester.strategies[strat]) {
          sendTelegram(`❌ "${strat}" 전략 없음\n사용 가능: ${Object.keys(backtester.strategies).join(', ')}`);
        } else {
          const prev = state.activeStrategy || 'confluence';
          state.activeStrategy = strat;
          _deps.saveState(state);
          sendTelegram(`⚙️ <b>전략 변경</b>\n${prev} → <b>${strat}</b> (${backtester.strategies[strat].name})`);
        }
      }
      break;
    }

    case '/set': {
      const item = (parts[1] || '').toLowerCase();
      const value = parseFloat(parts[2]);

      if (!item) {
        sendTelegram(
          `⚙️ <b>/set 사용법</b>\n\n` +
          `<b>[리스크]</b>\n` +
          `/set risk [%] — 거래당 리스크 (${(CONFIG.riskPerTrade * 100).toFixed(1)}%)\n` +
          `/set sl [%] — 기본 SL (${CONFIG.defaultSL ? (CONFIG.defaultSL * 100).toFixed(1) + '%' : 'ATR 자동'})\n` +
          `/set tp [%] — 기본 TP (${CONFIG.defaultTP ? (CONFIG.defaultTP * 100).toFixed(1) + '%' : 'ATR 자동'})\n\n` +
          `<b>[필터]</b>\n` +
          `/set confidence [%] — 최소 확신 (${CONFIG.minConfidence}%)\n` +
          `/set maxhold [h] — 최대 보유 (${CONFIG.maxHoldHours}h)\n` +
          `/set maxpos [n] — 최대 포지션 (${CONFIG.maxPositions})\n` +
          `/set circuit [n] — 서킷 연패 (${CONFIG.circuitBreakerLosses})\n` +
          `/set circuithours [h] — 서킷 시간 (${CONFIG.circuitBreakerHours}h)\n\n` +
          `<b>[코인]</b>\n` +
          `/set dailyloss [$] — 일일 손실 한도 ($${Math.abs(_deps.DAILY_LOSS_LIMIT || 200)})\n` +
          `/set weeklyloss [$] — 주간 손실 한도 ($${Math.abs(_deps.WEEKLY_MAX_LOSS || 500)})`
        );
        break;
      }

      if (isNaN(value) && item !== 'help') { sendTelegram(`❌ 숫자를 입력하세요: /set ${item} [값]`); break; }

      switch (item) {
        case 'risk': {
          if (value < 0.3 || value > 10) { sendTelegram('❌ risk: 0.3~10'); break; }
          const prev = (CONFIG.riskPerTrade * 100).toFixed(1);
          CONFIG.riskPerTrade = value / 100;
          sendTelegram(`⚙️ riskPerTrade: ${prev}% → <b>${value}%</b>`);
          break;
        }
        case 'sl': {
          if (value < 0.3 || value > 10) { sendTelegram('❌ sl: 0.3~10'); break; }
          CONFIG.defaultSL = value / 100;
          sendTelegram(`⚙️ 기본 SL → <b>${value}%</b>`);
          break;
        }
        case 'tp': {
          if (value < 0.5 || value > 20) { sendTelegram('❌ tp: 0.5~20'); break; }
          CONFIG.defaultTP = value / 100;
          sendTelegram(`⚙️ 기본 TP → <b>${value}%</b>`);
          break;
        }
        case 'confidence': {
          if (value < 20 || value > 90) { sendTelegram('❌ confidence: 20~90'); break; }
          const prev = CONFIG.minConfidence;
          CONFIG.minConfidence = value;
          sendTelegram(`⚙️ 최소 확신: ${prev}% → <b>${value}%</b>`);
          break;
        }
        case 'maxhold': {
          if (value < 1 || value > 168) { sendTelegram('❌ maxhold: 1~168'); break; }
          const prev = CONFIG.maxHoldHours;
          CONFIG.maxHoldHours = value;
          sendTelegram(`⚙️ 최대 보유: ${prev}h → <b>${value}h</b>`);
          break;
        }
        case 'maxpos': {
          if (value < 1 || value > 10) { sendTelegram('❌ maxpos: 1~10'); break; }
          CONFIG.maxPositions = value;
          sendTelegram(`⚙️ 최대 포지션 → <b>${value}개</b>`);
          break;
        }
        case 'circuit': {
          if (value < 2 || value > 10) { sendTelegram('❌ circuit: 2~10'); break; }
          CONFIG.circuitBreakerLosses = value;
          sendTelegram(`⚙️ 서킷 → <b>${value}연패</b> 시 정지`);
          break;
        }
        case 'circuithours': {
          if (value < 1 || value > 48) { sendTelegram('❌ circuithours: 1~48'); break; }
          CONFIG.circuitBreakerHours = value;
          sendTelegram(`⚙️ 서킷 정지 → <b>${value}시간</b>`);
          break;
        }
        case 'dailyloss': {
          if (value < 50 || value > 1000) { sendTelegram('❌ dailyloss: 50~1000'); break; }
          _deps.DAILY_LOSS_LIMIT = -value;
          sendTelegram(`⚙️ 일일 손실 한도 → <b>$${value}</b>`);
          break;
        }
        case 'weeklyloss': {
          if (value < 100 || value > 3000) { sendTelegram('❌ weeklyloss: 100~3000'); break; }
          _deps.WEEKLY_MAX_LOSS = -value;
          sendTelegram(`⚙️ 주간 손실 한도 → <b>$${value}</b>`);
          break;
        }
        default:
          sendTelegram(`❌ 알 수 없는 설정: ${item}\n/set 으로 목록 확인`);
      }
      break;
    }

    // ═══ Portfolio Engine (AI Hedge Fund OS) ═══

    case '/health':
    case '/상태점검': {
      try {
        const h = _deps.getHealthScore();
        const statusEmoji = { HEALTHY: '🟢', CAUTION: '🟡', WARNING: '🟠', CRITICAL: '🔴' }[h.status] || '⚪';
        sendTelegram(
          `${statusEmoji} <b>Portfolio Health: ${h.score}/100 [${h.status}]</b>\n━━━━━━━━━━━━━━━\n` +
          `수익률: ${h.returnPct}% | 승률: ${h.winRate}%\n` +
          `MDD: ${h.mdd}% | 연패: ${h.consecutiveLosses}\n` +
          (h.reasons.length > 0 ? `\n⚠️ ${h.reasons.join(', ')}` : '\n✅ 전 항목 정상')
        );
      } catch (e) { sendTelegram(`❌ ${e.message}`); }
      break;
    }

    case '/allocation':
    case '/배분': {
      try {
        const a = _deps.checkAllocation();
        const m = a.metrics;
        let msg = `📊 <b>Allocation Check</b>\n━━━━━━━━━━━━━━━\n` +
          `포지션: ${m.positionCount}개 (${m.uniqueCoins}코인)\n` +
          `노출: $${m.totalExposure} | 마진: $${m.marginUsed} (${m.marginPct}%)\n` +
          `롱: ${m.longPct}% | 숏: ${m.shortPct}%\n` +
          `현금 유보: ${m.cashReserve}%\n━━━━━━━━━━━━━━━\n`;

        if (a.compliant) {
          msg += '✅ 모든 배분 규칙 준수';
        } else {
          msg += `⚠️ ${a.violations.length}건 위반:\n`;
          for (const v of a.violations) {
            msg += `  • ${v.rule}: ${v.symbol || v.group || v.direction || ''} ${v.value}% (한도 ${v.limit}%) → ${v.action}\n`;
          }
        }
        sendTelegram(msg);
      } catch (e) { sendTelegram(`❌ ${e.message}`); }
      break;
    }

    case '/rebalance':
    case '/리밸런스': {
      try {
        const rb = _deps.getRebalanceActions();
        if (rb.actions.length === 0) {
          sendTelegram('✅ 리밸런스 불필요 — 포트폴리오 균형');
        } else {
          const lines = rb.actions.map(a => {
            const emoji = { HIGH: '🔴', MEDIUM: '🟡', LOW: '🟢' }[a.priority] || '⚪';
            return `${emoji} [${a.type}] ${a.reason}${a.suggestedPct ? ` (${a.suggestedPct}%)` : ''}`;
          });
          sendTelegram(`🔄 <b>Rebalance 권고</b>\n━━━━━━━━━━━━━━━\n${lines.join('\n')}`);
        }
      } catch (e) { sendTelegram(`❌ ${e.message}`); }
      break;
    }

    case '/sweep':
    case '/스위프': {
      const syms = parts[1] ? parts.slice(1).map(s => s.toUpperCase()) : ['BTC', 'ETH', 'SOL'];
      sendTelegram(`🔍 ${syms.length}코인 × 19전략 스위프 시작... (2-3분 소요)`);
      try {
        const sw = await _deps.sweepStrategies(syms, 60);
        let msg = `📋 <b>Strategy Sweep 결과</b>\n━━━━━━━━━━━━━━━\n` +
          `테스트: ${sw.totalTested}건 | 유효: ${sw.totalWithTrades}건\n` +
          `B&H 초과: ${sw.beatsBuyAndHold}건\n\n`;

        msg += `<b>Buy & Hold:</b>\n`;
        for (const [sym, ret] of Object.entries(sw.buyAndHold)) {
          msg += `  ${sym}: ${ret > 0 ? '+' : ''}${ret}%\n`;
        }

        msg += `\n<b>TOP 5:</b>\n`;
        for (const r of sw.top10.slice(0, 5)) {
          const emoji = r.totalPnl > 0 ? '✅' : '❌';
          msg += `${emoji} ${r.symbol} ${r.strategy}: $${r.totalPnl} (샤프 ${r.sharpe}, PF ${r.profitFactor})\n`;
        }

        msg += `\n<b>코인별 최적:</b>\n`;
        for (const b of sw.bestPerSymbol) {
          msg += `  ${b.symbol} → ${b.strategy} (${b.name}) $${b.pnl}\n`;
        }
        sendTelegram(msg);
      } catch (e) { sendTelegram(`❌ 스위프 에러: ${e.message}`); }
      break;
    }

    case '/fund':
    case '/펀드': {
      try {
        const fm = _deps.getFundMetrics();
        if (!fm) { sendTelegram('📭 거래 내역 부족 (3건 이상 필요)'); break; }
        sendTelegram(
          `🏦 <b>Fund Performance</b>\n━━━━━━━━━━━━━━━\n` +
          `💰 $${fm.startCapital} → <b>$${fm.currentCapital}</b> (${fm.totalReturn > 0 ? '+' : ''}${fm.totalReturn}%)\n\n` +
          `<b>핵심 지표:</b>\n` +
          `  샤프: <b>${fm.sharpeRatio}</b> | 소르티노: ${fm.sortinoRatio}\n` +
          `  칼마: ${fm.calmarRatio} | PF: ${fm.profitFactor}\n` +
          `  기대값: $${fm.expectancy}/건\n\n` +
          `<b>거래 통계:</b>\n` +
          `  ${fm.totalTrades}건 | 승률 ${fm.winRate}%\n` +
          `  평균승: $${fm.avgWin} | 평균패: $${fm.avgLoss}\n` +
          `  최대연승: ${fm.maxWinStreak} | 최대연패: ${fm.maxLossStreak}\n\n` +
          `<b>위험:</b>\n` +
          `  MDD: ${fm.maxDrawdown}%\n` +
          `  총수익: $${fm.grossProfit} | 총손실: $${fm.grossLoss}`
        );
      } catch (e) { sendTelegram(`❌ ${e.message}`); }
      break;
    }

    case '/crash':
    case '/급락': {
      const sym = (parts[1] || '').toUpperCase();
      if (sym) {
        // 특정 코인 급락 분석
        try {
          const crash = await _deps.detectCrashBounce(sym);
          if (!crash) { sendTelegram(`❌ ${sym} 급락 분석 실패`); break; }
          if (!crash.detected) {
            sendTelegram(`📊 <b>${sym} 급락 분석</b>\n\n24h 낙폭: ${crash.drop24h}%\n현재 급락 패턴 미감지`);
          } else {
            sendTelegram(
              `🚨 <b>${sym} 급락 반등 ${crash.pattern} 감지!</b>\n━━━━━━━━━━━━━━━\n` +
              `낙폭: ${crash.drop24h}% | 3h반등: ${crash.bounce3h}%\n6h반등: ${crash.bounce6h}% | RSI: ${crash.rsi}\n` +
              `거래량: ${crash.volSpike}x${crash.hasDoubleBottom ? ' | 더블바텀 ✅' : ''}\n━━━━━━━━━━━━━━━\n` +
              `P1: ${crash.p1 ? '✅' : '❌'} | P2: ${crash.p2 ? '✅' : '❌'} | P3: ${crash.p3 ? '✅' : '❌'} | P4: ${crash.p4 ? '✅' : '❌'}\n` +
              `확신: ${crash.confidence}%\n진입: $${crash.entry} | SL: $${crash.sl} | TP: $${crash.tp}`
            );
          }
        } catch (e) { sendTelegram(`❌ 에러: ${e.message}`); }
      } else {
        // 전코인 스캔
        sendTelegram('🔍 전 코인 급락 스캔 중...');
        const results = [];
        for (const s of SYMBOLS) {
          try {
            const c = await _deps.detectCrashBounce(s);
            if (c && c.drop24h <= -5) results.push(c);
          } catch {}
        }
        if (results.length === 0) {
          sendTelegram('✅ 현재 급락 코인 없음');
        } else {
          const lines = results.sort((a, b) => a.drop24h - b.drop24h).map(c =>
            `${c.detected ? '🚨' : '📉'} ${c.symbol}: ${c.drop24h}%${c.pattern ? ` [${c.pattern}]` : ''}`
          );
          sendTelegram(`📊 <b>급락 스캔 결과</b>\n\n${lines.join('\n')}`);
        }
      }
      break;
    }

    case '/grid':
    case '/그리드': {
      const sym = (parts[1] || 'BTC').toUpperCase();
      try {
        const grid = await _deps.getGridLevels(sym);
        if (!grid) { sendTelegram(`❌ ${sym} 그리드 계산 실패`); break; }
        const levelLines = grid.levels.map(l =>
          `L${l.level} $${l.price} (${l.distPct > 0 ? '+' : ''}${l.distPct}%) ${l.action === 'BUY' ? '🟢매수' : l.action === 'SELL' ? '🔴매도' : '⚪'}`
        );
        sendTelegram(
          `📊 <b>${sym} 그리드 레벨</b>\n━━━━━━━━━━━━━━━\n` +
          `현재가: $${grid.currentPrice}\n` +
          `범위: $${grid.gridRange.lower} ~ $${grid.gridRange.upper}\n` +
          `간격: $${grid.gridStep} (${grid.gridStepPct}%)\n` +
          `ADX: ${grid.adx} (${grid.isGoodForGrid ? '횡보장 ✅' : '추세장 ⚠️'})\n━━━━━━━━━━━━━━━\n` +
          `${levelLines.join('\n')}`
        );
      } catch (e) { sendTelegram(`❌ 에러: ${e.message}`); }
      break;
    }

    case '/hedge':
    case '/헷지': {
      try {
        const hedge = _deps.suggestHedge();
        if (!hedge.needsHedge) {
          sendTelegram(`✅ <b>헷지 불필요</b>\n\n포트폴리오 균형 상태\nL: $${hedge.exposure.long} | S: $${hedge.exposure.short}`);
        } else {
          const lines = hedge.suggestions.map(s =>
            `${s.priority === 'HIGH' ? '🔴' : '🟡'} [${s.type}]\n${s.reason}\n→ ${s.action} ${s.candidates.join('/')} ($${s.suggestedSize})`
          );
          sendTelegram(
            `🛡️ <b>헷지 권고</b>\n━━━━━━━━━━━━━━━\n` +
            `${lines.join('\n\n')}\n━━━━━━━━━━━━━━━\n` +
            `노출: L $${hedge.exposure.long} / S $${hedge.exposure.short}\n` +
            `편향: ${hedge.exposure.bias} ${hedge.exposure.biasPct}%`
          );
        }
      } catch (e) { sendTelegram(`❌ 에러: ${e.message}`); }
      break;
    }

    case '/tune':
    case '/튜닝': {
      const sym = (parts[1] || 'BTC').toUpperCase();
      const strat = parts[2] || 'confluence';
      sendTelegram(`⏳ ${sym} ${strat} 파라미터 튜닝 중... (1-2분 소요)`);
      try {
        const result = await _deps.autoTuneParameters(sym, strat, 60);
        if (!result.bestParams) { sendTelegram(`❌ 튜닝 실패 — 유효한 결과 없음`); break; }
        const top = result.top5.slice(0, 3).map((r, i) =>
          `${i + 1}. SL ${r.sl * 100}% TP ${r.tp * 100}% L${r.lev}x → 승률 ${r.winRate}% PnL $${r.pnl} 샤프 ${r.sharpe}`
        );
        sendTelegram(
          `🔧 <b>${sym} ${strat} 파라미터 튜닝 결과</b>\n━━━━━━━━━━━━━━━\n` +
          `최적: SL ${result.bestParams.sl * 100}% | TP ${result.bestParams.tp * 100}% | ${result.bestParams.leverage}x\n` +
          `R:R = ${result.bestParams.rrRatio}:1\n━━━━━━━━━━━━━━━\n` +
          `승률: ${result.bestResult.winRate}% | PnL: $${result.bestResult.totalPnl}\n` +
          `샤프: ${result.bestResult.sharpe} | PF: ${result.bestResult.profitFactor}\n` +
          `MDD: ${result.bestResult.maxDrawdown}% | ${result.bestResult.trades}건\n━━━━━━━━━━━━━━━\n` +
          `<b>TOP 3:</b>\n${top.join('\n')}\n\n총 ${result.totalCombinations}개 조합 테스트`
        );
      } catch (e) { sendTelegram(`❌ 튜닝 에러: ${e.message}`); }
      break;
    }

    case '/scan':
    case '/스캔': {
      try {
        const scan = await _deps.fastScanVolatility();
        if (!scan.alerts || scan.alerts.length === 0) {
          sendTelegram('✅ 현재 급변동 코인 없음');
        } else {
          const lines = scan.alerts.map(a =>
            `${a.direction === 'UP' ? '🟢' : '🔴'} ${a.symbol}: 15m ${a.change15m > 0 ? '+' : ''}${a.change15m}% | 1h ${a.change1h > 0 ? '+' : ''}${a.change1h}% | vol ${a.volRatio}x [${a.alertType}]`
          );
          sendTelegram(`⚡ <b>급변동 감지</b>\n\n${lines.join('\n')}`);
        }
      } catch (e) { sendTelegram(`❌ 에러: ${e.message}`); }
      break;
    }

    case '/dashboard':
    case '/대시보드': {
      const ds = _deps.getDetailedStats();
      const lines = [];
      lines.push(`💰 자본: $${state.capital.toFixed(0)} (${((state.capital - state.startCapital) / state.startCapital * 100).toFixed(1)}%)`);
      lines.push(`📊 거래: ${ds.totalTrades}건 | 승률: ${state.totalTrades > 0 ? (state.wins / state.totalTrades * 100).toFixed(0) : 0}%`);
      lines.push(`📈 샤프: ${ds.sharpeRatio} | PF: ${ds.profitFactor} | 칼마: ${ds.calmarRatio}`);
      lines.push(`💵 기대값: $${ds.expectancy}/건 | R:R: ${ds.avgRR}:1`);
      lines.push(`📉 MDD: ${(state.maxDrawdown * 100).toFixed(1)}%`);
      if (ds.strategyStats && Object.keys(ds.strategyStats).length > 0) {
        lines.push(`\n<b>전략별:</b>`);
        for (const [s, v] of Object.entries(ds.strategyStats)) {
          lines.push(`  ${s}: ${v.total}건 ${v.winRate}% $${v.pnl}`);
        }
      }
      if (ds.gradeStats && Object.keys(ds.gradeStats).length > 0) {
        lines.push(`\n<b>등급별:</b>`);
        for (const [g, v] of Object.entries(ds.gradeStats)) {
          lines.push(`  ${g}급: ${v.total}건 ${v.winRate}% $${v.pnl}`);
        }
      }
      sendTelegram(`📋 <b>성과 대시보드</b>\n━━━━━━━━━━━━━━━\n${lines.join('\n')}`);
      break;
    }

    default: {
      if (cmd[0].startsWith('/')) {
        sendTelegram(`❓ 알 수 없는 명령어: ${cmd[0]}\n/help 로 명령어 확인`);
        break;
      }

      const rawText = text;
      const lowerText = rawText.toLowerCase();

      if (/포지션|상태|현황/.test(lowerText)) {
        await handleCommand('/status', chatId);
        break;
      }

      const coinMatch = SYMBOLS.find(s => lowerText.includes(s.toLowerCase()));

      if (coinMatch && /분석|어때|어떤|전망|볼까|괜찮/.test(lowerText)) {
        await handleCommand(`/analyze ${coinMatch}`, chatId);
        break;
      }

      if (coinMatch) {
        try {
          const price = await _deps.fetchPrice(coinMatch);
          const recentDec = _deps.getRecentDecision(coinMatch);
          const pos = state.positions.find(p => p.symbol === coinMatch);
          let msg = `📊 <b>${coinMatch} 현재 정보</b>\n\n`;
          msg += `현재가: <b>$${price ? price.toLocaleString() : '조회실패'}</b>\n`;
          if (recentDec) {
            const decEmoji = recentDec.action === 'BUY' ? '🟢' : recentDec.action === 'SELL' ? '🔴' : '⚪';
            msg += `\n최근 판정: ${decEmoji} <b>${recentDec.action}</b> (${recentDec.confidence || '?'}%)\n`;
            msg += `등급: ${recentDec.grade || '?'}\n`;
            if (recentDec.timestamp || recentDec.ts) {
              const ts = recentDec.timestamp || recentDec.ts;
              msg += `분석 시각: ${typeof ts === 'string' ? ts.slice(0, 16).replace('T', ' ') : new Date(ts).toISOString().slice(0, 16).replace('T', ' ')}\n`;
            }
            if (recentDec.rationale) {
              msg += `근거: ${(recentDec.rationale || '').slice(0, 150)}\n`;
            }
          } else {
            msg += `\n최근 판정: 데이터 없음\n`;
          }
          if (pos) {
            const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
            let unrealPnl = 0;
            if (price) {
              unrealPnl = isLong ? (price - pos.entryPrice) * pos.quantity : (pos.entryPrice - price) * pos.quantity;
            }
            msg += `\n📌 보유 중: <b>${pos.direction}</b> @ $${pos.entryPrice}\n`;
            msg += `미실현 PnL: <b>$${unrealPnl.toFixed(2)}</b>`;
          } else {
            msg += `\n📌 보유 포지션: 없음`;
          }
          sendTelegram(msg);
        } catch (e) {
          sendTelegram(`❌ ${coinMatch} 정보 조회 실패: ${e.message}`);
        }
        break;
      }

      if (/시장|전망|마켓|market|어떻게/.test(lowerText)) {
        try {
          const prices = [];
          for (const sym of ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE']) {
            const p = await _deps.fetchPrice(sym);
            if (p) prices.push(`${sym}: $${p.toLocaleString()}`);
          }
          let msg = `🌐 <b>시장 현황</b>\n\n${prices.join('\n')}`;
          if (state.positions.length > 0) {
            msg += `\n\n📌 <b>보유 포지션 (${state.positions.length}개)</b>\n`;
            for (const pos of state.positions) {
              const posEmoji = (pos.direction === 'BUY' || pos.direction === 'LONG') ? '🟢' : '🔴';
              msg += `${posEmoji} ${pos.symbol} ${pos.direction} @ $${pos.entryPrice}\n`;
            }
          } else {
            msg += `\n\n📌 보유 포지션: 없음`;
          }
          sendTelegram(msg);
        } catch (e) {
          sendTelegram(`❌ 시장 정보 조회 실패: ${e.message}`);
        }
        break;
      }

      sendTelegram(`❓ 명령어를 인식하지 못했습니다. /help 로 확인해주세요.`);
    }
  }
}

// ── 포지션 보유 중 15분 보고 ──
async function sendPositionReport(state) {
  const allPos = [...(state.positions || []), ...(state.swingPositions || [])];
  if (!allPos.length) return;

  let totalUnreal = 0;
  let totalCost = 0;
  let totalMargin = 0;
  const lines = [];
  const leverage = state.leverage || 20;
  const DASHBOARD_URL = _deps.DASHBOARD_URL || '';

  for (const pos of allPos) {
    const price = await _deps.fetchPrice(pos.symbol);
    const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
    let unrealPnl = 0;
    if (price) {
      unrealPnl = isLong
        ? (price - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - price) * pos.quantity;
    }
    totalUnreal += unrealPnl;
    const margin = pos.costBasis / leverage;
    totalCost += pos.costBasis;
    totalMargin += margin;
    const roePct = margin > 0 ? (unrealPnl / margin * 100).toFixed(1) : '0';
    const pnlPct = pos.costBasis > 0 ? (unrealPnl / pos.costBasis * 100).toFixed(2) : '0';
    const hours = ((Date.now() - pos.entryTs) / 3600000).toFixed(1);
    const emoji = unrealPnl >= 0 ? '🟢' : '🔴';
    const trail = pos.trailLevel ? ` T${pos.trailLevel}` : '';
    const partial = pos.partialClosed ? ' ½' : '';
    const isLongDir = pos.direction === 'BUY' || pos.direction === 'LONG';
    const slDist = isLongDir
      ? ((pos.slPrice - price) / price * 100).toFixed(1)
      : ((price - pos.slPrice) / price * 100).toFixed(1);
    const tpDist = isLongDir
      ? ((pos.tpPrice - price) / price * 100).toFixed(1)
      : ((price - pos.tpPrice) / price * 100).toFixed(1);
    const pnlPctNum = parseFloat(pnlPct);
    const pnlBar = makePnlBar(pnlPctNum);
    const stratTag = pos.strategy === 'swing' ? ' [W]' : ' [S]';
    lines.push(
      `${emoji} <b>${pos.symbol} ${pos.direction}</b>${stratTag} ${leverage}x${trail}${partial}\n` +
      `   $${pos.entryPrice} → <b>$${price || '?'}</b>\n` +
      `   수량: ${pos.quantity} | 포지션: $${pos.costBasis.toFixed(0)}\n` +
      `   PnL: <b>$${unrealPnl.toFixed(2)}</b> ROE ${roePct}%\n` +
      `   <pre>${pnlBar}</pre>\n` +
      `   SL: $${pos.slPrice} (${slDist}%) | TP: $${pos.tpPrice} (${tpDist}%)\n` +
      `   보유: ${hours}h`
    );
  }

  const totalRoePct = totalMargin > 0 ? (totalUnreal / totalMargin * 100).toFixed(1) : '0';
  sendTelegramWithButtons(
    `📋 <b>포지션 보고</b> (${allPos.length}개: S=${state.positions.length} W=${(state.swingPositions||[]).length})\n` +
    `━━━━━━━━━━━━━━━\n\n` +
    lines.join('\n━━━━━━━━━━━━━━━\n') +
    `\n\n━━━━━━━━━━━━━━━\n` +
    `미실현: <b>$${totalUnreal.toFixed(2)}</b> (ROE ${totalRoePct}%)\n` +
    `총 포지션: $${totalCost.toFixed(0)} | 마진: $${totalMargin.toFixed(0)}\n` +
    `자본: <b>$${state.capital.toFixed(0)}</b> | 레버리지: ${leverage}x`,
    [[{ text: '📊 대시보드', url: DASHBOARD_URL }]]
  );
}

// ── 일일 요약 리포트 ──
function sendDailySummary(state, cachedMarketRegime) {
  const history = _deps.loadHistory();
  const today = new Date().toISOString().slice(0, 10);
  const todayTrades = history.filter(t => (t.exitTime || '').slice(0, 10) === today);
  const todayPnl = todayTrades.reduce((s, t) => s + (t.pnl || 0), 0);
  const wins = todayTrades.filter(t => (t.pnl || 0) > 0).length;
  const losses = todayTrades.length - wins;
  const returnPct = ((state.capital - state.startCapital) / state.startCapital * 100).toFixed(1);
  const openPos = state.positions.map(p => `${p.symbol} ${p.direction}`).join(', ') || '없음';
  const DASHBOARD_URL = _deps.DASHBOARD_URL || '';

  const coinPnl = {};
  for (const t of todayTrades) { coinPnl[t.symbol] = (coinPnl[t.symbol] || 0) + (t.pnl || 0); }
  const coinEntries = Object.entries(coinPnl).sort((a, b) => b[1] - a[1]);
  const maxCoinPnl = coinEntries.length > 0 ? Math.max(...coinEntries.map(([, p]) => Math.abs(p)), 1) : 1;
  const coinLines = coinEntries
    .map(([sym, pnl]) => {
      const bar = makeBar(pnl, maxCoinPnl, 8);
      return `  ${pnl >= 0 ? '✅' : '❌'} ${sym}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} ${bar}`;
    })
    .join('\n') || '  거래 없음';

  let bestTrade = null, worstTrade = null;
  for (const t of todayTrades) {
    if (!bestTrade || (t.pnl || 0) > (bestTrade.pnl || 0)) bestTrade = t;
    if (!worstTrade || (t.pnl || 0) < (worstTrade.pnl || 0)) worstTrade = t;
  }
  const bestLine = bestTrade ? `🏆 최고: ${bestTrade.symbol} $${(bestTrade.pnl || 0).toFixed(2)}` : '';
  const worstLine = worstTrade ? `💀 최악: ${worstTrade.symbol} $${(worstTrade.pnl || 0).toFixed(2)}` : '';

  const dailyMap = {};
  for (const t of history) {
    const day = (t.exitTime || '').slice(0, 10);
    if (day) dailyMap[day] = (dailyMap[day] || 0) + (t.pnl || 0);
  }
  const recentDays = Object.keys(dailyMap).sort().slice(-7);
  let eqRunning = state.startCapital;
  const allDaysSorted = Object.keys(dailyMap).sort();
  const eqByDay = [];
  for (const d of allDaysSorted) {
    eqRunning += dailyMap[d];
    if (recentDays.includes(d)) eqByDay.push({ day: d, capital: eqRunning });
  }
  const eqMin = eqByDay.length > 0 ? Math.min(...eqByDay.map(e => e.capital)) : state.startCapital;
  const eqMax = eqByDay.length > 0 ? Math.max(...eqByDay.map(e => e.capital)) : state.startCapital;
  const eqRange = eqMax - eqMin || 1;
  const eqLines = eqByDay.map(e => {
    const barLen = Math.round((e.capital - eqMin) / eqRange * 10) + 1;
    return `${e.day.slice(5)} $${e.capital.toFixed(0)} ${'█'.repeat(barLen)}`;
  }).join('\n') || '데이터 없음';

  const regime = cachedMarketRegime || {};
  let strategyAdvice = '📌 NORMAL — 기본 전략 유지';
  if (regime.regime === 'HIGH_VOLATILITY') {
    strategyAdvice = '⚡ HIGH VOL — 보수적 진입, 리스크 축소, 짧은 보유 권장';
  } else if (regime.regime === 'LOW_VOLATILITY') {
    strategyAdvice = '😴 LOW VOL — 진입 기준 상향, 관망 위주, 브레이크아웃 대기';
  }

  const pnlReturnPct = state.startCapital > 0 ? (todayPnl / state.startCapital * 100) : 0;
  const todayPnlBar = makePnlBar(pnlReturnPct);
  const totalWinRate = state.totalTrades > 0 ? (state.wins / state.totalTrades * 100) : 0;
  const winRateBar = makeBar(totalWinRate, 100, 10);

  sendTelegramWithButtons(
    `📋 <b>일일 요약 (${today})</b>\n\n` +
    `거래: ${todayTrades.length}건 (${wins}승 ${losses}패)\n` +
    `일일 PnL: <b>$${todayPnl.toFixed(2)}</b>\n` +
    `<pre>${todayPnlBar}</pre>\n` +
    `총 자본: <b>$${state.capital.toFixed(0)}</b> (${returnPct}%)\n` +
    `총 PnL: $${state.totalPnl.toFixed(2)}\n` +
    `<pre>승률: ${winRateBar} ${totalWinRate.toFixed(0)}%</pre>\n` +
    `보유 중: ${openPos}\n\n` +
    `<b>코인별 PnL:</b>\n${coinLines}\n\n` +
    (bestLine ? `${bestLine}\n` : '') +
    (worstLine ? `${worstLine}\n` : '') +
    `\n<b>에쿼티 추이 (7일):</b>\n<pre>${eqLines}</pre>\n\n` +
    `<b>내일 전략:</b>\n${strategyAdvice}`,
    [[{ text: '📊 대시보드 보기', url: DASHBOARD_URL }]]
  );
}

module.exports = {
  inject,
  sendTelegram,
  sendTelegramWithButtons,
  makeBar,
  makePnlBar,
  startTelegramBot,
  stopTelegramBot,
  handleCommand,
  sendPositionReport,
  sendDailySummary,
};
