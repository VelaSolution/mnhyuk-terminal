'use strict';

/**
 * Portfolio Engine — AI Hedge Fund OS 핵심
 *
 * 1. Portfolio Health Score (0-100)
 * 2. Allocation Rules Engine (섹터/상관/분산)
 * 3. Auto Rebalancer (강한 종목으로 자본 이동)
 * 4. Strategy Sweeper (수천 조합 대량 테스트)
 * 5. Fund Performance Metrics (Sharpe, Calmar, Sortino, 에쿼티 커브)
 */

const quantSignals = require('./quant-signals');
const backtester = require('./backtester');
const riskManager = require('./risk-manager');

// ═══════════════════════════════════════════
// 1. PORTFOLIO HEALTH SCORE (0-100)
// ═══════════════════════════════════════════

function calculateHealthScore(state, history) {
  let score = 100;
  const reasons = [];

  // ── 수익성 (30점) ──
  const returnPct = state.startCapital > 0 ? (state.capital - state.startCapital) / state.startCapital * 100 : 0;
  if (returnPct >= 10) { /* 만점 */ }
  else if (returnPct >= 5) score -= 5;
  else if (returnPct >= 0) score -= 10;
  else if (returnPct >= -5) { score -= 20; reasons.push('소폭 손실'); }
  else { score -= 30; reasons.push('큰 손실'); }

  // ── 승률 (15점) ──
  const winRate = state.totalTrades > 0 ? state.wins / state.totalTrades : 0;
  if (state.totalTrades >= 10) {
    if (winRate >= 0.5) { /* OK */ }
    else if (winRate >= 0.4) { score -= 5; }
    else if (winRate >= 0.3) { score -= 10; reasons.push('낮은 승률'); }
    else { score -= 15; reasons.push('매우 낮은 승률'); }
  }

  // ── MDD (20점) ──
  const mdd = state.maxDrawdown || 0;
  if (mdd < 0.05) { /* 건강 */ }
  else if (mdd < 0.10) score -= 5;
  else if (mdd < 0.15) { score -= 10; reasons.push('MDD 주의'); }
  else if (mdd < 0.20) { score -= 15; reasons.push('MDD 위험'); }
  else { score -= 20; reasons.push('MDD 심각'); }

  // ── 연패 (10점) ──
  const consLoss = state.consecutiveLosses || 0;
  if (consLoss >= 4) { score -= 10; reasons.push(`${consLoss}연패`); }
  else if (consLoss >= 3) { score -= 7; reasons.push('3연패'); }
  else if (consLoss >= 2) score -= 3;

  // ── 포지션 집중도 (10점) ──
  const allPos = [...(state.positions || []), ...(state.swingPositions || [])];
  if (allPos.length > 0) {
    const totalExposure = allPos.reduce((s, p) => s + (p.costBasis || 0), 0);
    const maxSingle = Math.max(...allPos.map(p => p.costBasis || 0));
    const concentration = totalExposure > 0 ? maxSingle / totalExposure : 0;
    if (concentration > 0.6) { score -= 10; reasons.push('포지션 집중'); }
    else if (concentration > 0.4) score -= 5;

    // 방향 편향
    const longExp = allPos.filter(p => p.direction === 'BUY').reduce((s, p) => s + (p.costBasis || 0), 0);
    const shortExp = allPos.filter(p => p.direction === 'SELL').reduce((s, p) => s + (p.costBasis || 0), 0);
    const bias = totalExposure > 0 ? Math.abs(longExp - shortExp) / totalExposure : 0;
    if (bias > 0.8) { score -= 5; reasons.push('방향 편향'); }
  }

  // ── 서킷브레이커/드로다운 중단 (5점) ──
  const now = Date.now();
  if ((state.circuitBreakerUntil || 0) > now) { score -= 5; reasons.push('서킷 활성'); }
  if ((state.drawdownHaltUntil || 0) > now) { score -= 10; reasons.push('MDD 중단'); }

  // ── 최근 트레이드 품질 (10점) ──
  if (history && history.length >= 5) {
    const recent10 = history.slice(-10);
    const recentPnl = recent10.reduce((s, t) => s + (t.pnl || 0), 0);
    if (recentPnl < -100) { score -= 10; reasons.push('최근 손실 과다'); }
    else if (recentPnl < -50) { score -= 5; reasons.push('최근 손실'); }
    else if (recentPnl > 100) score += 5; // 보너스
  }

  score = Math.max(0, Math.min(100, score));

  let status;
  if (score >= 80) status = 'HEALTHY';
  else if (score >= 60) status = 'CAUTION';
  else if (score >= 40) status = 'WARNING';
  else status = 'CRITICAL';

  return { score, status, reasons, returnPct: Math.round(returnPct * 10) / 10, winRate: Math.round(winRate * 1000) / 10, mdd: Math.round(mdd * 1000) / 10, consecutiveLosses: consLoss };
}

// ═══════════════════════════════════════════
// 2. ALLOCATION RULES ENGINE
// ═══════════════════════════════════════════

const ALLOCATION_RULES = {
  maxPositionPct: 0.25,       // 단일 포지션 최대 25%
  maxSectorExposure: 0.40,    // 같은 그룹 최대 40%
  maxDirectionBias: 0.70,     // 롱/숏 편향 최대 70%
  minDiversification: 3,      // 최소 3개 코인 분산
  maxTotalExposure: 0.80,     // 전체 자본 대비 최대 노출 80%
  reserveCash: 0.20,          // 최소 현금 유보 20%
};

function checkAllocationRules(state) {
  const allPos = [...(state.positions || []), ...(state.swingPositions || [])];
  const violations = [];
  const capital = state.capital || 3000;

  if (allPos.length === 0) return { compliant: true, violations: [], metrics: {} };

  const totalExposure = allPos.reduce((s, p) => s + (p.costBasis || 0), 0);
  const leveragedExposure = totalExposure; // 이미 레버리지 포함된 costBasis

  // 단일 포지션 비중
  for (const pos of allPos) {
    const weight = totalExposure > 0 ? (pos.costBasis || 0) / totalExposure : 0;
    if (weight > ALLOCATION_RULES.maxPositionPct) {
      violations.push({ rule: 'MAX_POSITION', symbol: pos.symbol, value: Math.round(weight * 100), limit: Math.round(ALLOCATION_RULES.maxPositionPct * 100), action: 'REDUCE' });
    }
  }

  // 그룹별 노출
  const GROUPS = [['BTC', 'ETH'], ['SOL', 'AVAX', 'SUI'], ['DOGE', 'PEPE', 'WIF']];
  for (const group of GROUPS) {
    const groupExposure = allPos.filter(p => group.includes(p.symbol)).reduce((s, p) => s + (p.costBasis || 0), 0);
    const groupPct = totalExposure > 0 ? groupExposure / totalExposure : 0;
    if (groupPct > ALLOCATION_RULES.maxSectorExposure) {
      violations.push({ rule: 'SECTOR_EXPOSURE', group: group.join('/'), value: Math.round(groupPct * 100), limit: Math.round(ALLOCATION_RULES.maxSectorExposure * 100), action: 'DIVERSIFY' });
    }
  }

  // 방향 편향
  const longExp = allPos.filter(p => p.direction === 'BUY').reduce((s, p) => s + (p.costBasis || 0), 0);
  const shortExp = allPos.filter(p => p.direction === 'SELL').reduce((s, p) => s + (p.costBasis || 0), 0);
  const longPct = totalExposure > 0 ? longExp / totalExposure : 0;
  if (longPct > ALLOCATION_RULES.maxDirectionBias) {
    violations.push({ rule: 'DIRECTION_BIAS', direction: 'LONG', value: Math.round(longPct * 100), limit: Math.round(ALLOCATION_RULES.maxDirectionBias * 100), action: 'HEDGE' });
  }
  if ((1 - longPct) > ALLOCATION_RULES.maxDirectionBias && allPos.length > 0) {
    violations.push({ rule: 'DIRECTION_BIAS', direction: 'SHORT', value: Math.round((1 - longPct) * 100), limit: Math.round(ALLOCATION_RULES.maxDirectionBias * 100), action: 'HEDGE' });
  }

  // 전체 노출 대비 자본
  const leverage = state.leverage || 20;
  const marginUsed = totalExposure / leverage;
  const marginPct = marginUsed / capital;
  if (marginPct > ALLOCATION_RULES.maxTotalExposure) {
    violations.push({ rule: 'TOTAL_EXPOSURE', value: Math.round(marginPct * 100), limit: Math.round(ALLOCATION_RULES.maxTotalExposure * 100), action: 'REDUCE_ALL' });
  }

  const uniqueCoins = new Set(allPos.map(p => p.symbol)).size;

  return {
    compliant: violations.length === 0,
    violations,
    metrics: {
      totalExposure: Math.round(totalExposure),
      marginUsed: Math.round(marginUsed),
      marginPct: Math.round(marginPct * 100),
      longPct: Math.round(longPct * 100),
      shortPct: Math.round((1 - longPct) * 100),
      positionCount: allPos.length,
      uniqueCoins,
      cashReserve: Math.round((1 - marginPct) * 100),
    },
  };
}

// ═══════════════════════════════════════════
// 3. AUTO REBALANCER
// ═══════════════════════════════════════════

function generateRebalanceActions(state, history) {
  const allPos = [...(state.positions || []), ...(state.swingPositions || [])];
  if (allPos.length < 2) return { actions: [], reason: '포지션 2개 미만' };

  const actions = [];

  // 코인별 최근 성과 계산
  const coinPerf = {};
  if (history && history.length > 0) {
    for (const t of history.slice(-50)) {
      if (!t.symbol) continue;
      if (!coinPerf[t.symbol]) coinPerf[t.symbol] = { pnl: 0, trades: 0, wins: 0 };
      coinPerf[t.symbol].pnl += t.pnl || 0;
      coinPerf[t.symbol].trades++;
      if ((t.pnl || 0) > 0) coinPerf[t.symbol].wins++;
    }
  }

  // 현재 포지션의 미실현 수익률 기준
  const posPerformance = allPos.map(p => {
    const hist = coinPerf[p.symbol] || { pnl: 0, trades: 0, wins: 0 };
    const winRate = hist.trades > 0 ? hist.wins / hist.trades : 0.5;
    return {
      ...p,
      historicalPnl: hist.pnl,
      historicalWinRate: winRate,
      historicalTrades: hist.trades,
    };
  });

  // 약한 포지션 → 축소 제안
  for (const pos of posPerformance) {
    if (pos.historicalTrades >= 5 && pos.historicalWinRate < 0.3) {
      actions.push({
        type: 'REDUCE',
        symbol: pos.symbol,
        reason: `${pos.symbol} 승률 ${(pos.historicalWinRate * 100).toFixed(0)}% (${pos.historicalTrades}건) — 축소 권장`,
        suggestedPct: 50,
        priority: 'HIGH',
      });
    }
  }

  // 강한 코인 → 확대 제안
  const strongCoins = Object.entries(coinPerf)
    .filter(([, v]) => v.trades >= 5 && v.wins / v.trades >= 0.6 && v.pnl > 0)
    .sort((a, b) => b[1].pnl - a[1].pnl);

  for (const [sym, perf] of strongCoins.slice(0, 2)) {
    const hasPos = allPos.find(p => p.symbol === sym);
    if (!hasPos) {
      actions.push({
        type: 'ADD',
        symbol: sym,
        reason: `${sym} 승률 ${(perf.wins / perf.trades * 100).toFixed(0)}% PnL +$${perf.pnl.toFixed(0)} — 진입 고려`,
        priority: 'MEDIUM',
      });
    }
  }

  // 포지션 비중 불균형 → 리밸런스
  const totalCost = allPos.reduce((s, p) => s + (p.costBasis || 0), 0);
  const avgWeight = totalCost > 0 ? 1 / allPos.length : 0;
  for (const pos of allPos) {
    const weight = totalCost > 0 ? (pos.costBasis || 0) / totalCost : 0;
    if (weight > avgWeight * 2 && allPos.length >= 3) {
      actions.push({
        type: 'REBALANCE',
        symbol: pos.symbol,
        reason: `${pos.symbol} 비중 ${(weight * 100).toFixed(0)}% (평균 ${(avgWeight * 100).toFixed(0)}%) — 과다`,
        currentWeight: Math.round(weight * 100),
        targetWeight: Math.round(avgWeight * 100),
        priority: 'LOW',
      });
    }
  }

  return { actions, timestamp: new Date().toISOString() };
}

// ═══════════════════════════════════════════
// 4. STRATEGY SWEEPER (대량 테스트)
// ═══════════════════════════════════════════

async function sweepStrategies(symbols, days = 60, options = {}) {
  if (!symbols) symbols = ['BTC', 'ETH', 'SOL'];
  const allStrategies = Object.keys(backtester.strategies);
  const results = [];
  let tested = 0;

  console.log(`[sweeper] ${symbols.length}코인 × ${allStrategies.length}전략 = ${symbols.length * allStrategies.length}건 스위프 시작`);

  for (const sym of symbols) {
    for (const strat of allStrategies) {
      try {
        const r = await backtester.backtest(sym, strat, days, { leverage: options.leverage || 20 });
        if (r && r.totalTrades > 0) {
          // 종합 점수: Sharpe × 0.3 + PF × 0.25 + WinRate × 0.2 + (1-MDD/100) × 0.25
          const compositeScore =
            (r.sharpeRatio || 0) * 0.3 +
            Math.min(r.profitFactor || 0, 5) * 0.25 +
            (r.winRate / 100) * 0.2 +
            (1 - (r.maxDrawdown || 0) / 100) * 0.25;

          results.push({
            symbol: sym,
            strategy: strat,
            name: backtester.strategies[strat].name,
            trades: r.totalTrades,
            winRate: r.winRate,
            totalPnl: r.totalPnl,
            sharpe: r.sharpeRatio,
            profitFactor: r.profitFactor,
            maxDrawdown: r.maxDrawdown,
            expectancy: r.expectancy,
            compositeScore: Math.round(compositeScore * 1000) / 1000,
          });
        }
        tested++;
      } catch {}
    }
  }

  results.sort((a, b) => b.compositeScore - a.compositeScore);

  // Buy & Hold 비교
  const bnh = {};
  for (const sym of symbols) {
    try {
      const candles = await backtester.fetchHistoricalCandles(sym, '1d', days);
      if (candles.length >= 2) {
        const startPrice = candles[0].c;
        const endPrice = candles[candles.length - 1].c;
        bnh[sym] = Math.round((endPrice - startPrice) / startPrice * 10000) / 100;
      }
    } catch {}
  }

  // 전략 vs B&H 비교
  const beatsBnH = results.filter(r => {
    const bnhReturn = bnh[r.symbol] || 0;
    const stratReturn = r.totalPnl / 3000 * 100; // $3000 기준 수익률
    return stratReturn > bnhReturn;
  });

  return {
    totalTested: tested,
    totalWithTrades: results.length,
    beatsBuyAndHold: beatsBnH.length,
    buyAndHold: bnh,
    top10: results.slice(0, 10),
    bottom5: results.slice(-5).reverse(),
    bestPerSymbol: symbols.map(sym => {
      const best = results.find(r => r.symbol === sym);
      return best ? { symbol: sym, strategy: best.strategy, name: best.name, score: best.compositeScore, pnl: best.totalPnl, sharpe: best.sharpe } : null;
    }).filter(Boolean),
    timestamp: new Date().toISOString(),
  };
}

// ═══════════════════════════════════════════
// 5. FUND PERFORMANCE METRICS
// ═══════════════════════════════════════════

function calculateFundMetrics(state, history) {
  if (!history || history.length < 3) return null;

  const returns = history.map(t => (t.pnlPct || 0) / 100);
  const pnls = history.map(t => t.pnl || 0);

  // Sharpe Ratio (연환산)
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / (returns.length - 1 || 1);
  const stdReturn = Math.sqrt(variance);
  const sharpe = stdReturn > 0 ? Math.round(meanReturn / stdReturn * Math.sqrt(252) * 100) / 100 : 0;

  // Sortino Ratio (하방 변동성만)
  const downReturns = returns.filter(r => r < 0);
  const downVariance = downReturns.length > 0 ? downReturns.reduce((a, b) => a + b ** 2, 0) / downReturns.length : 0;
  const downDev = Math.sqrt(downVariance);
  const sortino = downDev > 0 ? Math.round(meanReturn / downDev * Math.sqrt(252) * 100) / 100 : 0;

  // Calmar Ratio (연환산 수익 / MDD)
  const totalReturn = (state.capital - state.startCapital) / state.startCapital;
  const mdd = state.maxDrawdown || 0.001;
  const calmar = Math.round(totalReturn / mdd * 100) / 100;

  // Profit Factor
  const grossProfit = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0);
  const grossLoss = Math.abs(pnls.filter(p => p <= 0).reduce((a, b) => a + b, 0));
  const profitFactor = grossLoss > 0 ? Math.round(grossProfit / grossLoss * 100) / 100 : grossProfit > 0 ? 999 : 0;

  // 기대값
  const winTrades = pnls.filter(p => p > 0);
  const lossTrades = pnls.filter(p => p <= 0);
  const avgWin = winTrades.length > 0 ? winTrades.reduce((a, b) => a + b, 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((a, b) => a + b, 0) / lossTrades.length) : 0;
  const winRate = history.length > 0 ? winTrades.length / history.length : 0;
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  // 최대 연승/연패
  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const t of history) {
    if ((t.pnl || 0) > 0) { curWin++; curLoss = 0; if (curWin > maxWinStreak) maxWinStreak = curWin; }
    else { curLoss++; curWin = 0; if (curLoss > maxLossStreak) maxLossStreak = curLoss; }
  }

  // 월별 수익
  const monthlyPnl = {};
  for (const t of history) {
    const month = (t.exitTime || t.entryTime || '').slice(0, 7);
    if (month) monthlyPnl[month] = Math.round(((monthlyPnl[month] || 0) + (t.pnl || 0)) * 100) / 100;
  }

  // 에쿼티 커브
  const equityCurve = [];
  let running = state.startCapital;
  for (const t of history) {
    running += t.pnl || 0;
    equityCurve.push({ time: t.exitTime || t.entryTime, capital: Math.round(running * 100) / 100, pnl: t.pnl || 0 });
  }

  return {
    // 핵심 지표
    sharpeRatio: sharpe,
    sortinoRatio: sortino,
    calmarRatio: calmar,
    profitFactor,
    expectancy: Math.round(expectancy * 100) / 100,
    // 수익
    totalReturn: Math.round(totalReturn * 10000) / 100,
    totalPnl: Math.round(state.totalPnl * 100) / 100,
    // 거래 통계
    totalTrades: history.length,
    winRate: Math.round(winRate * 1000) / 10,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    maxWinStreak,
    maxLossStreak,
    // 위험
    maxDrawdown: Math.round(mdd * 1000) / 10,
    grossProfit: Math.round(grossProfit * 100) / 100,
    grossLoss: Math.round(grossLoss * 100) / 100,
    // 시계열
    monthlyPnl,
    equityCurve,
    // 메타
    startCapital: state.startCapital,
    currentCapital: Math.round(state.capital * 100) / 100,
    tradingDays: Object.keys(monthlyPnl).length * 30 || 1,
  };
}

// ═══════════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════════

module.exports = {
  // Health Score
  calculateHealthScore,
  // Allocation
  ALLOCATION_RULES,
  checkAllocationRules,
  // Rebalancer
  generateRebalanceActions,
  // Strategy Sweeper
  sweepStrategies,
  // Fund Metrics
  calculateFundMetrics,
};
