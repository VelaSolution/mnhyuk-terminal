'use strict';

/**
 * Risk Manager — 리스크 관리 + 진입 검증 + 포트폴리오 분석
 *
 * paper-trader-v2.js에서 분리.
 * 동적 리스크 계산, 진입 전 시장 검증, SL 패턴 차단,
 * Kelly Criterion 사이징, 포트폴리오 상관관계, 성과 attribution.
 */

const quantSignals = require('./quant-signals');
const backtester = require('./backtester');

// ── 외부 주입 의존성 ──
let _deps = {
  loadHistory: null,
  CONFIG: null,
  CORRELATION_GROUPS: null,
  SL_PATTERN_BLOCK_HOURS: 48,
};

function inject(deps) {
  Object.assign(_deps, deps);
}

// ── 동적 리스크 계산 (과도한 축소 방지) ──
function getDynamicRisk(state) {
  const CONFIG = _deps.CONFIG;
  const baseRisk = CONFIG.riskPerTrade;
  const history = _deps.loadHistory();
  const recent = history.slice(-8); // 5→8건 (더 안정적 판단)
  if (recent.length < 5) return baseRisk; // 5건 미만이면 기본 리스크

  const recentWins = recent.filter(t => (t.pnl || 0) > 0).length;
  const winRate = recentWins / recent.length;

  if (winRate >= 0.75) return Math.min(baseRisk * 1.4, 0.025); // 연승 → 소폭 확대
  if (winRate >= 0.5) return baseRisk; // 반반 → 기본
  if (winRate >= 0.35) return Math.max(baseRisk * 0.8, 0.012); // 약간 줄임 (0.75→0.8)
  return Math.max(baseRisk * 0.6, 0.01); // 최소 0.6배 (0.5→0.6)
}

// ── 연승 보너스: maxPositions 동적 조정 ──
function getEffectiveMaxPositions(state) {
  const CONFIG = _deps.CONFIG || { maxPositions: 4 };
  const wins = state.consecutiveWins || 0;
  if (wins >= 5) return 5;
  if (wins >= 3) return 4;
  return CONFIG.maxPositions;
}

// ── 진입 전 시장 검증 (펀딩레이트/거래량 체크) ──
async function validateEntry(symbol, action) {
  const pair = symbol + 'USDT';
  try {
    // 펀딩레이트 체크
    const frRes = await fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&limit=1`, { signal: AbortSignal.timeout(3000) });
    if (frRes.ok) {
      const [fr] = await frRes.json();
      const rate = parseFloat(fr.fundingRate);
      if (action === 'BUY' && rate > 0.0005) {
        console.log(`[risk] ${symbol} 펀딩레이트 과열 ${(rate * 100).toFixed(3)}% — 롱 위험`);
        return { ok: false, reason: `펀딩 과열 ${(rate * 100).toFixed(3)}%` };
      }
      if (action === 'SELL' && rate < -0.0005) {
        console.log(`[risk] ${symbol} 펀딩레이트 음수 과열 ${(rate * 100).toFixed(3)}% — 숏 위험`);
        return { ok: false, reason: `펀딩 음수 과열 ${(rate * 100).toFixed(3)}%` };
      }
    }

    // 24h 거래량 체크
    const tkRes = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${pair}`, { signal: AbortSignal.timeout(3000) });
    if (tkRes.ok) {
      const tk = await tkRes.json();
      const volUsd = parseFloat(tk.quoteVolume);
      if (volUsd < 10_000_000) {
        console.log(`[risk] ${symbol} 거래량 부족 $${(volUsd / 1e6).toFixed(1)}M`);
        return { ok: false, reason: `거래량 $${(volUsd / 1e6).toFixed(1)}M 부족` };
      }
    }
  } catch (e) {
    console.log(`[risk] ${symbol} 검증 API 실패: ${e.message} — 통과 처리`);
  }
  return { ok: true };
}

// ── SL 패턴 차단 체크 (만료 자동 정리 포함) ──
function isPatternBlocked(state, symbol, direction) {
  if (!state.slPatterns) return false;
  const now = Date.now();
  const hour = new Date().getUTCHours();
  const hourBand = Math.floor(hour / 4);
  const SL_PATTERN_BLOCK_HOURS = _deps.SL_PATTERN_BLOCK_HOURS || 48;

  // 48시간 초과 패턴 자동 제거
  const cutoff = SL_PATTERN_BLOCK_HOURS * 3600000;
  state.slPatterns = state.slPatterns.filter(p => (now - p.ts) < cutoff);

  const matching = state.slPatterns.filter(p =>
    p.symbol === symbol &&
    p.direction === direction &&
    Math.floor(p.hour / 4) === hourBand
  );

  if (matching.length >= 2) {
    console.log(`[risk] ${symbol} ${direction} 패턴 차단 — 같은 시간대 ${matching.length}회 연속 SL`);
    return true;
  }
  return false;
}

// ── 코인 승률 가중치 ──
function getCoinWeight(state, symbol) {
  if (!state.coinPerformance || !state.coinPerformance[symbol]) return 1.0;
  const cp = state.coinPerformance[symbol];
  if (cp.total < 3) return 1.0;
  const winRate = cp.wins / cp.total;
  if (winRate >= 0.6) return 1.2;
  if (winRate >= 0.4) return 1.0;
  return 0.8;
}

// ── 포지션 히트맵 업데이트 ──
function updateCoinPerformance(state, symbol, isWin) {
  if (!state.coinPerformance) state.coinPerformance = {};
  if (!state.coinPerformance[symbol]) {
    state.coinPerformance[symbol] = { wins: 0, losses: 0, total: 0 };
  }
  const cp = state.coinPerformance[symbol];
  cp.total++;
  if (isWin) cp.wins++; else cp.losses++;
}

// ── 드로다운 보호 로직 ──
function checkDrawdownProtection(state, now) {
  const TOTAL_MAX_DD = 0.20;
  const currentDD = state.peakCapital > 0 ? (state.peakCapital - state.capital) / state.peakCapital : 0;
  if (currentDD >= TOTAL_MAX_DD) {
    return { halt: true, reason: `최대 낙폭 ${(currentDD * 100).toFixed(1)}% 도달`, currentDD };
  }
  if (state.drawdownHaltUntil && state.drawdownHaltUntil > now) {
    const remaining = Math.round((state.drawdownHaltUntil - now) / 3600000 * 10) / 10;
    return { halt: true, reason: `낙폭 중단 ${remaining}h 남음`, currentDD };
  }
  return { halt: false, currentDD };
}

// ── 주간 낙폭 체크 (전략 재검토 트리거) ──
function checkWeeklyDrawdownReview(state) {
  const history = _deps.loadHistory();
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const weekStartStr = weekStart.toISOString().slice(0, 10);
  let weeklyPnl = 0;
  for (const t of history) {
    if ((t.exitTime || '').slice(0, 10) >= weekStartStr) weeklyPnl += t.pnl || 0;
  }
  return { weeklyPnl, needsReview: weeklyPnl <= -200 };
}

// ═══════════════════════════════════════════
// ══ 새 기능: 오더 플로우 불균형 분석 ══
// ═══════════════════════════════════════════

async function getOrderFlowScore(symbol) {
  const pair = symbol + 'USDT';
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${pair}&limit=20`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`Binance depth API ${res.status}`);
    const { bids, asks } = await res.json();

    const bidVolume = bids.reduce((s, [, q]) => s + parseFloat(q), 0);
    const askVolume = asks.reduce((s, [, q]) => s + parseFloat(q), 0);
    const total = bidVolume + askVolume;
    const bidRatio = total > 0 ? bidVolume / total : 0.5;
    const askRatio = total > 0 ? askVolume / total : 0.5;

    let score = 0;
    let interpretation = '균형';

    if (bidRatio > 0.65) {
      score = Math.round((bidRatio - 0.5) * 200);  // max ~100
      interpretation = '매수벽 강함 — 롱 유리';
    } else if (bidRatio > 0.55) {
      score = Math.round((bidRatio - 0.5) * 100);  // max ~50
      interpretation = '매수 우세';
    } else if (askRatio > 0.65) {
      score = -Math.round((askRatio - 0.5) * 200);
      interpretation = '매도벽 강함 — 숏 유리';
    } else if (askRatio > 0.55) {
      score = -Math.round((askRatio - 0.5) * 100);
      interpretation = '매도 우세';
    }

    // 청산 맵: 최근 대량 청산 가격대 감지
    let liquidationZones = [];
    try {
      // 최근 강제 청산 조회 (API로 직접은 불가하므로 오더북 갭으로 추정)
      const topBidPrice = parseFloat(bids[0][0]);
      const topAskPrice = parseFloat(asks[0][0]);
      const spread = topAskPrice - topBidPrice;
      const spreadPct = spread / topBidPrice * 100;

      // 큰 주문 감지 (상위 5개에서 평균의 3배 이상)
      const bidQtys = bids.map(([, q]) => parseFloat(q));
      const askQtys = asks.map(([, q]) => parseFloat(q));
      const avgBidQty = bidQtys.reduce((a, b) => a + b, 0) / bidQtys.length;
      const avgAskQty = askQtys.reduce((a, b) => a + b, 0) / askQtys.length;

      for (let j = 0; j < bids.length; j++) {
        if (parseFloat(bids[j][1]) > avgBidQty * 3) {
          liquidationZones.push({ price: parseFloat(bids[j][0]), side: 'support', size: parseFloat(bids[j][1]) });
        }
      }
      for (let j = 0; j < asks.length; j++) {
        if (parseFloat(asks[j][1]) > avgAskQty * 3) {
          liquidationZones.push({ price: parseFloat(asks[j][0]), side: 'resistance', size: parseFloat(asks[j][1]) });
        }
      }
    } catch {}

    return {
      symbol,
      bidVolume,
      askVolume,
      bidRatio,
      askRatio,
      score,
      interpretation,
      liquidationZones: liquidationZones.slice(0, 5),
    };
  } catch (e) {
    console.log(`[risk] ${symbol} 오더플로우 조회 실패: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════
// ══ 새 기능: 실시간 슬리피지 추정 ══
// ═══════════════════════════════════════════

async function estimateSlippage(symbol, sizeUsd, side = 'BUY') {
  const pair = symbol + 'USDT';
  try {
    const res = await fetch(`https://fapi.binance.com/fapi/v1/depth?symbol=${pair}&limit=20`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const { bids, asks } = await res.json();

    // BUY → asks를 먹어가며 체결, SELL → bids를 먹어가며 체결
    const book = side === 'BUY' ? asks : bids;
    let remainingSize = sizeUsd;
    let totalCost = 0;
    let totalQty = 0;

    for (const [priceStr, qtyStr] of book) {
      const price = parseFloat(priceStr);
      const qty = parseFloat(qtyStr);
      const levelUsd = price * qty;

      if (remainingSize <= 0) break;

      if (levelUsd >= remainingSize) {
        const fillQty = remainingSize / price;
        totalCost += fillQty * price;
        totalQty += fillQty;
        remainingSize = 0;
      } else {
        totalCost += levelUsd;
        totalQty += qty;
        remainingSize -= levelUsd;
      }
    }

    if (totalQty === 0) return null;

    const avgFillPrice = totalCost / totalQty;
    const bestPrice = parseFloat(book[0][0]);
    const slippagePct = Math.abs(avgFillPrice - bestPrice) / bestPrice * 100;
    const slippageUsd = slippagePct / 100 * sizeUsd;

    let sizeRecommendation = '100%';
    if (slippagePct > 0.3) sizeRecommendation = '25% (슬리피지 과다)';
    else if (slippagePct > 0.1) sizeRecommendation = '50% (슬리피지 주의)';
    else if (slippagePct > 0.05) sizeRecommendation = '75%';

    return {
      symbol,
      side,
      sizeUsd,
      estimatedPrice: Math.round(avgFillPrice * 100) / 100,
      bestPrice,
      slippagePct: Math.round(slippagePct * 1000) / 1000,
      slippageUsd: Math.round(slippageUsd * 100) / 100,
      sizeRecommendation,
      filled: remainingSize <= 0,
    };
  } catch (e) {
    console.log(`[risk] ${symbol} 슬리피지 추정 실패: ${e.message}`);
    return null;
  }
}

// ═══════════════════════════════════════════
// ══ 새 기능: 포트폴리오 상관관계 분석 ══
// ═══════════════════════════════════════════

function getPortfolioCorrelation(state) {
  const allPos = [...(state.positions || []), ...(state.swingPositions || [])];
  if (allPos.length === 0) return { positions: [], diversificationScore: 0, warnings: [], matrix: [] };

  const CORRELATION_GROUPS = _deps.CORRELATION_GROUPS || [
    ['BTC', 'ETH'], ['SOL', 'AVAX', 'SUI'], ['DOGE', 'PEPE', 'WIF'],
  ];

  const warnings = [];
  const matrix = [];

  // 같은 그룹 내 같은 방향 체크
  for (const group of CORRELATION_GROUPS) {
    const groupPositions = allPos.filter(p => group.includes(p.symbol));
    if (groupPositions.length >= 2) {
      const directions = groupPositions.map(p => p.direction);
      const allSame = directions.every(d => d === directions[0]);
      if (allSame) {
        warnings.push(`${groupPositions.map(p => p.symbol).join('+')} 같은 방향 (${directions[0]}) — 리스크 집중!`);
      }
    }
  }

  // 상관관계 매트릭스 (그룹 기반 추정)
  for (let i = 0; i < allPos.length; i++) {
    for (let j = i + 1; j < allPos.length; j++) {
      const a = allPos[i];
      const b = allPos[j];
      let correlation = 0.3; // 기본 약한 상관
      for (const group of CORRELATION_GROUPS) {
        if (group.includes(a.symbol) && group.includes(b.symbol)) {
          correlation = 0.85; // 같은 그룹: 높은 상관
          break;
        }
      }
      // 같은 방향이면 양의 상관, 반대면 음의 상관 (헤지)
      if (a.direction !== b.direction) correlation = -correlation;

      matrix.push({
        pair: `${a.symbol}-${b.symbol}`,
        correlation: Math.round(correlation * 100) / 100,
        sameDirection: a.direction === b.direction,
      });
    }
  }

  // 분산도 점수 (0~100)
  let diversificationScore = 100;
  // 같은 그룹 패널티
  for (const group of CORRELATION_GROUPS) {
    const inGroup = allPos.filter(p => group.includes(p.symbol));
    if (inGroup.length >= 2) {
      const sameDir = inGroup.filter(p => p.direction === inGroup[0].direction).length;
      if (sameDir >= 2) diversificationScore -= 25;
    }
  }
  // 전부 같은 방향 패널티
  if (allPos.length >= 2) {
    const allSameDir = allPos.every(p => p.direction === allPos[0].direction);
    if (allSameDir) diversificationScore -= 20;
  }
  // 코인 수 보너스
  const uniqueCoins = new Set(allPos.map(p => p.symbol)).size;
  diversificationScore += uniqueCoins * 5;
  diversificationScore = Math.max(0, Math.min(100, diversificationScore));

  return {
    positions: allPos.map(p => ({ symbol: p.symbol, direction: p.direction, strategy: p.strategy || 'scalp' })),
    diversificationScore,
    warnings,
    matrix,
  };
}

// ═══════════════════════════════════════════
// ══ 새 기능: 성과 Attribution ══
// ═══════════════════════════════════════════

function getPerformanceAttribution() {
  const history = _deps.loadHistory();
  if (!history || history.length < 5) return null;

  let aiWins = 0, aiTotal = 0;
  let quantWins = 0, quantTotal = 0;
  let multiTfWins = 0, multiTfTotal = 0;
  const strategyPnl = {};
  const indicatorAccuracy = {};

  for (const t of history) {
    // AI 판정 기여
    aiTotal++;
    if ((t.pnl || 0) > 0) aiWins++;

    // 퀀트 시그널 기여 (quantGrade 기록이 있는 경우)
    if (t.quantGrade) {
      quantTotal++;
      if ((t.pnl || 0) > 0) quantWins++;
    }

    // 멀티TF 확인 승률
    if (t.multiTfConfirmed) {
      multiTfTotal++;
      if ((t.pnl || 0) > 0) multiTfWins++;
    }

    // 전략별 PnL
    const strat = t.strategy || t.closeReason || 'scalp';
    if (!strategyPnl[strat]) strategyPnl[strat] = 0;
    strategyPnl[strat] += t.pnl || 0;

    // 등급별 추적
    const grade = t.grade || 'D';
    if (!indicatorAccuracy[`Grade_${grade}`]) indicatorAccuracy[`Grade_${grade}`] = { correct: 0, total: 0 };
    indicatorAccuracy[`Grade_${grade}`].total++;
    if ((t.pnl || 0) > 0) indicatorAccuracy[`Grade_${grade}`].correct++;

    // 청산 사유별
    const cr = t.closeReason || 'UNKNOWN';
    if (!indicatorAccuracy[cr]) indicatorAccuracy[cr] = { correct: 0, total: 0 };
    indicatorAccuracy[cr].total++;
    if ((t.pnl || 0) > 0) indicatorAccuracy[cr].correct++;
  }

  // 정확도 계산
  for (const key of Object.keys(indicatorAccuracy)) {
    const data = indicatorAccuracy[key];
    data.accuracy = data.total > 0 ? (data.correct / data.total * 100) : 0;
  }

  return {
    totalTrades: history.length,
    aiWinRate: aiTotal > 0 ? (aiWins / aiTotal * 100) : 0,
    quantWinRate: quantTotal > 0 ? (quantWins / quantTotal * 100) : 0,
    multiTfWinRate: multiTfTotal > 0 ? (multiTfWins / multiTfTotal * 100) : 0,
    strategyPnl,
    indicatorAccuracy,
  };
}

// ═══════════════════════════════════════════
// ══ 새 기능: 타임프레임 자동 최적화 ══
// ═══════════════════════════════════════════

async function getOptimalTimeframe(symbol) {
  const timeframes = [
    { tf: '1h', interval: '1h', days: 30 },
    { tf: '4h', interval: '4h', days: 60 },
    { tf: '1d', interval: '1d', days: 90 },
  ];

  const results = [];
  for (const { tf, days } of timeframes) {
    try {
      const result = await backtester.backtest(symbol, 'confluence', days, { interval: tf });
      if (result && result.totalTrades > 0) {
        results.push({
          timeframe: tf,
          winRate: parseFloat(result.winRate) || 0,
          totalPnl: parseFloat(result.totalPnl) || 0,
          sharpe: parseFloat(result.sharpeRatio) || 0,
          profitFactor: parseFloat(result.profitFactor) || 0,
          trades: result.totalTrades,
          maxDD: parseFloat(result.maxDrawdown) || 0,
        });
      }
    } catch (e) {
      console.log(`[risk] ${symbol} ${tf} 백테스트 실패: ${e.message}`);
    }
  }

  // 종합 점수로 정렬: sharpe * 0.4 + PF * 0.3 + winRate/100 * 0.3
  results.sort((a, b) => {
    const scoreA = (a.sharpe * 0.4) + (a.profitFactor * 0.3) + (a.winRate / 100 * 0.3);
    const scoreB = (b.sharpe * 0.4) + (b.profitFactor * 0.3) + (b.winRate / 100 * 0.3);
    return scoreB - scoreA;
  });

  return {
    symbol,
    optimal: results.length > 0 ? results[0].timeframe : '1h',
    results,
  };
}

// ═══════════════════════════════════════════
// ══ 자동 헷지 제안 ══
// ═══════════════════════════════════════════

function suggestHedge(state) {
  const allPos = [...(state.positions || []), ...(state.swingPositions || [])];
  if (allPos.length === 0) return { needsHedge: false, suggestions: [] };

  const CORRELATION_GROUPS = _deps.CORRELATION_GROUPS || [
    ['BTC', 'ETH'], ['SOL', 'AVAX', 'SUI'], ['DOGE', 'PEPE', 'WIF'],
  ];

  const suggestions = [];
  let totalExposure = 0;
  let longExposure = 0;
  let shortExposure = 0;

  for (const pos of allPos) {
    const cost = pos.costBasis || 0;
    totalExposure += cost;
    if (pos.direction === 'BUY' || pos.direction === 'LONG') longExposure += cost;
    else shortExposure += cost;
  }

  const netExposure = longExposure - shortExposure;
  const exposureRatio = totalExposure > 0 ? Math.abs(netExposure) / totalExposure : 0;

  // 편향도 70%+ → 헷지 필요
  if (exposureRatio >= 0.7 && allPos.length >= 2) {
    const dominantDir = netExposure > 0 ? 'LONG' : 'SHORT';
    const hedgeDir = dominantDir === 'LONG' ? 'SELL' : 'BUY';
    const hedgeAmount = Math.abs(netExposure) * 0.3; // 30% 헷지

    // 현재 보유하지 않은 코인 중 반대 그룹에서 헷지 코인 추천
    const openSymbols = new Set(allPos.map(p => p.symbol));
    const hedgeCandidates = [];

    for (const group of CORRELATION_GROUPS) {
      const inGroup = allPos.filter(p => group.includes(p.symbol));
      if (inGroup.length === 0) {
        // 이 그룹에 포지션 없으면 여기서 헷지
        for (const sym of group) {
          if (!openSymbols.has(sym)) {
            hedgeCandidates.push(sym);
          }
        }
      }
    }

    // 보유 그룹과 다른 그룹의 코인 추천
    if (hedgeCandidates.length > 0) {
      suggestions.push({
        type: 'DIRECTIONAL_HEDGE',
        reason: `포트폴리오 ${dominantDir} 편향 ${(exposureRatio * 100).toFixed(0)}%`,
        action: hedgeDir,
        candidates: hedgeCandidates.slice(0, 3),
        suggestedSize: Math.round(hedgeAmount),
        priority: exposureRatio >= 0.9 ? 'HIGH' : 'MEDIUM',
      });
    }
  }

  // 같은 그룹에 같은 방향 2개+ → 그룹 내 헷지 경고
  for (const group of CORRELATION_GROUPS) {
    const groupPos = allPos.filter(p => group.includes(p.symbol));
    if (groupPos.length >= 2) {
      const dirs = groupPos.map(p => p.direction);
      const allSame = dirs.every(d => d === dirs[0]);
      if (allSame) {
        const hedgeDir = dirs[0] === 'BUY' ? 'SELL' : 'BUY';
        const totalGroupCost = groupPos.reduce((s, p) => s + (p.costBasis || 0), 0);
        suggestions.push({
          type: 'GROUP_CONCENTRATION',
          reason: `${groupPos.map(p => p.symbol).join('+')} 같은 방향 집중 (${dirs[0]})`,
          action: hedgeDir,
          candidates: group.filter(s => !allPos.find(p => p.symbol === s)),
          suggestedSize: Math.round(totalGroupCost * 0.2),
          priority: 'MEDIUM',
        });
      }
    }
  }

  // 단일 포지션 비중 50%+ → 분산 필요
  for (const pos of allPos) {
    const weight = totalExposure > 0 ? (pos.costBasis || 0) / totalExposure : 0;
    if (weight >= 0.5 && allPos.length >= 2) {
      suggestions.push({
        type: 'CONCENTRATION_RISK',
        reason: `${pos.symbol} 단일 비중 ${(weight * 100).toFixed(0)}%`,
        action: 'REDUCE',
        candidates: [pos.symbol],
        suggestedSize: Math.round((pos.costBasis || 0) * (weight - 0.3)),
        priority: weight >= 0.7 ? 'HIGH' : 'MEDIUM',
      });
    }
  }

  return {
    needsHedge: suggestions.length > 0,
    suggestions,
    exposure: {
      total: Math.round(totalExposure),
      long: Math.round(longExposure),
      short: Math.round(shortExposure),
      net: Math.round(netExposure),
      bias: exposureRatio > 0.5 ? (netExposure > 0 ? 'LONG' : 'SHORT') : 'BALANCED',
      biasPct: Math.round(exposureRatio * 100),
    },
  };
}

// ═══════════════════════════════════════════
// ══ 동적 SL 조정 (변동성 기반) ══
// ═══════════════════════════════════════════

async function adjustDynamicSL(symbol, currentSl, direction, entryPrice) {
  try {
    const pair = symbol + 'USDT';
    // 4h ATR 사용 (메인 진입과 동일 타임프레임)
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=4h&limit=30`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { adjusted: false };
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length < 15) return { adjusted: false };

    const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    const { atr: atrFn } = require('./backtester');
    const atrValues = atrFn(candles, 14);
    const curATR = atrValues[candles.length - 1];
    if (!curATR || curATR <= 0) return { adjusted: false };

    const price = candles[candles.length - 1].c;
    const isLong = direction === 'BUY' || direction === 'LONG';

    // ATR 기반 최적 SL 거리
    const optimalSlDist = curATR * 1.5;
    const optimalSl = isLong ? price - optimalSlDist : price + optimalSlDist;

    // 현재 SL이 진입가 대비 너무 가까우면 (0.3% 미만) 확장
    const currentSlDist = Math.abs(currentSl - entryPrice);
    const minSlDist = entryPrice * 0.003;

    if (currentSlDist < minSlDist) {
      const newSl = isLong ? entryPrice - optimalSlDist : entryPrice + optimalSlDist;
      return {
        adjusted: true,
        reason: 'SL too tight',
        oldSl: currentSl,
        newSl: Math.round(newSl * 100) / 100,
        atr: Math.round(curATR * 100) / 100,
      };
    }

    // 현재 SL이 ATR 대비 너무 넓으면 (3x ATR+) 축소
    if (currentSlDist > curATR * 3) {
      const tighterSl = isLong
        ? Math.max(currentSl, price - curATR * 2)
        : Math.min(currentSl, price + curATR * 2);
      // BE 이하로는 축소하지 않음
      if ((isLong && tighterSl >= entryPrice) || (!isLong && tighterSl <= entryPrice)) {
        return { adjusted: false, reason: 'Would move below BE' };
      }
      return {
        adjusted: true,
        reason: 'SL too wide',
        oldSl: currentSl,
        newSl: Math.round(tighterSl * 100) / 100,
        atr: Math.round(curATR * 100) / 100,
      };
    }

    return { adjusted: false };
  } catch {
    return { adjusted: false };
  }
}

module.exports = {
  inject,
  getDynamicRisk,
  getEffectiveMaxPositions,
  validateEntry,
  isPatternBlocked,
  getCoinWeight,
  updateCoinPerformance,
  checkDrawdownProtection,
  checkWeeklyDrawdownReview,
  // 기존 기능
  getOrderFlowScore,
  estimateSlippage,
  getPortfolioCorrelation,
  getPerformanceAttribution,
  getOptimalTimeframe,
  // 강화: 헷지 + 동적SL
  suggestHedge,
  adjustDynamicSL,
};
