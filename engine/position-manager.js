'use strict';

/**
 * Position Manager — 포지션 체크/청산/트레일링/부분청산/재진입 관리
 *
 * paper-trader-v2.js에서 분리.
 * SL/TP 체크, 트레일링 스탑, 부분 청산, 비상 청산,
 * Swing 포지션, 15분 재검토, 재진입 큐 처리.
 */

const learner = require('./learner');
const quantSignals = require('./quant-signals');

// ── 외부 주입 의존성 ──
let _deps = {
  fetchPrice: null,
  saveState: null,
  loadHistory: null,
  appendTrade: null,
  recordLesson: null,
  runSingleAnalysis: null,
  runAnalysis: null,
  updateCoinPerformance: null,
  getEffectiveMaxPositions: null,
  sendTelegram: null,
  sendTelegramWithButtons: null,
  CONFIG: null,
  DASHBOARD_URL: '',
  TERMINAL_URL: '',
  POSITION_REVIEW_INTERVAL: 15 * 60 * 1000,
};

function inject(deps) {
  Object.assign(_deps, deps);
}

// ── 포지션 실시간 데이터 계산 ──
function calcLiveData(pos, currentPrice) {
  const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
  const unrealPnl = isLong
    ? (currentPrice - pos.entryPrice) * pos.quantity
    : (pos.entryPrice - currentPrice) * pos.quantity;
  const leverage = pos.leverage || 20;
  const margin = pos.costBasis / leverage;
  const roePct = margin > 0 ? (unrealPnl / margin * 100) : 0;
  const pnlPct = pos.costBasis > 0 ? (unrealPnl / pos.costBasis * 100) : 0;
  const hoursHeld = (Date.now() - pos.entryTs) / 3600000;

  return { isLong, unrealPnl, margin, roePct, pnlPct, hoursHeld };
}

// ── 메인 Scalp 포지션 체크 (SL/TP/시간 만료) ──
async function checkPositions(state, notifyFn) {
  const now = Date.now();
  const CONFIG = _deps.CONFIG;
  const { sendTelegram, sendTelegramWithButtons, fetchPrice, saveState, appendTrade, recordLesson, updateCoinPerformance } = _deps;

  for (let i = state.positions.length - 1; i >= 0; i--) {
    const pos = state.positions[i];
    let currentPrice;
    try { currentPrice = await fetchPrice(pos.symbol); } catch { continue; }
    if (!currentPrice) continue;

    const { isLong, unrealPnl, margin, roePct, hoursHeld } = calcLiveData(pos, currentPrice);
    let closeReason = null;
    const leverage = state.leverage || 20;

    // ── Funding Fee 반영 (8시간마다) ──
    if (!pos.lastFundingTs) pos.lastFundingTs = pos.entryTs;
    const hoursSinceLastFunding = (now - pos.lastFundingTs) / 3600000;
    if (hoursSinceLastFunding >= 8) {
      try {
        const frRes = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pos.symbol}USDT`, { signal: AbortSignal.timeout(3000) });
        if (frRes.ok) {
          const fr = await frRes.json();
          const fundingRate = parseFloat(fr.lastFundingRate || 0);
          // 롱이면 양수 펀딩 = 비용, 숏이면 양수 펀딩 = 수익
          const fundingCost = pos.costBasis * Math.abs(fundingRate) * (isLong ? (fundingRate > 0 ? -1 : 1) : (fundingRate > 0 ? 1 : -1));
          const fundingPeriods = Math.floor(hoursSinceLastFunding / 8);

          if (Math.abs(fundingCost * fundingPeriods) > 0.01) {
            const totalFunding = fundingCost * fundingPeriods;
            state.capital += totalFunding;
            state.totalPnl += totalFunding;
            if (!pos.totalFundingPaid) pos.totalFundingPaid = 0;
            pos.totalFundingPaid += totalFunding;
            pos.lastFundingTs = now;

            if (Math.abs(totalFunding) > 1) {
              console.log(`[paper-v2] ${pos.symbol} 펀딩비 ${totalFunding > 0 ? '+' : ''}$${totalFunding.toFixed(2)} (rate ${(fundingRate * 100).toFixed(4)}%, ${fundingPeriods}회)`);
            }
            saveState(state);
          } else {
            pos.lastFundingTs = now;
          }
        }
      } catch {}
    }

    console.log(`[paper-v2] 📊 ${pos.symbol} ${pos.direction} | 현재 $${currentPrice} | PnL $${unrealPnl.toFixed(2)} | ROE ${roePct.toFixed(1)}% | ${hoursHeld.toFixed(1)}h${pos.totalFundingPaid ? ' | 펀딩 $' + pos.totalFundingPaid.toFixed(2) : ''}`);

    // ── 퀀트 시그널 기반 모니터링 ──
    if (!closeReason) {
      try {
        const posQuantSig = await quantSignals.getSignalForSymbol(pos.symbol);
        const posQuantAction = posQuantSig.action;
        const posQuantGrade = posQuantSig.grade || 'D';
        const isQuantReverse = (isLong && posQuantAction === 'SELL') || (!isLong && posQuantAction === 'BUY');

        if (isQuantReverse) {
          const GRADE_ORD = { S: 5, A: 4, B: 3, C: 2, D: 1 };
          if ((GRADE_ORD[posQuantGrade] || 0) >= 4) {
            console.log(`[paper-v2] ⚠️ ${pos.symbol} 퀀트 ${posQuantAction} [${posQuantGrade}급] 반대 → 즉시 청산!`);
            closeReason = 'QUANT_REVERSE';
            sendTelegram(
              `🚨 <b>${pos.symbol} 퀀트 반대 시그널 — 즉시 청산</b>\n` +
              `보유: ${pos.direction} | 퀀트: ${posQuantAction} [${posQuantGrade}급]\n` +
              `점수: ${posQuantSig.totalScore} | 현재가: $${currentPrice}`
            );
          } else if ((GRADE_ORD[posQuantGrade] || 0) >= 2) {
            if (!pos._lastQuantWarnTs || (now - pos._lastQuantWarnTs) > 30 * 60 * 1000) {
              pos._lastQuantWarnTs = now;
              sendTelegram(
                `⚠️ <b>${pos.symbol} 퀀트 경고</b>\n` +
                `보유: ${pos.direction} | 퀀트: ${posQuantAction} [${posQuantGrade}급]\n` +
                `점수: ${posQuantSig.totalScore} | PnL: $${unrealPnl.toFixed(2)}\n` +
                `주의: 방향 전환 조짐 — 주시 필요`
              );
            }
          }
        }
      } catch {}
    }

    // ── ROE -50% 비상 청산 ──
    if (roePct <= -50) {
      console.log(`[paper-v2] 🚨 ${pos.symbol} ROE ${roePct.toFixed(1)}% <= -50% — 비상 청산!`);
      closeReason = 'EMERGENCY_ROE';
    }

    // ── 스마트 손절 이동: 6시간 경과 + 수익 중 → SL을 BE+로 이동 ──
    if (!closeReason && hoursHeld >= 6 && !pos.smartSlApplied) {
      if (unrealPnl > 0) {
        const feeCost = pos.quantity * pos.entryPrice * CONFIG.feeMaker * 2;
        const bePrice = isLong
          ? pos.entryPrice + feeCost / pos.quantity
          : pos.entryPrice - feeCost / pos.quantity;
        const shouldUpdate = isLong ? pos.slPrice < bePrice : pos.slPrice > bePrice;
        if (shouldUpdate) {
          pos.slPrice = Math.round(bePrice * 100) / 100;
          pos.smartSlApplied = true;
          console.log(`[paper-v2] ⏰ ${pos.symbol} 6h 경과 + 수익 → SL BE+ $${pos.slPrice}`);
          sendTelegram(
            `⏰ <b>${pos.symbol} 스마트 SL 이동</b>\n` +
            `6시간 경과 + 수익 중 → SL을 <b>BE+ $${pos.slPrice}</b>로 이동\n` +
            `현재가: $${currentPrice} | PnL: $${unrealPnl.toFixed(2)}`
          );
          saveState(state);
        }
      }
    }

    // ── 12시간 경과 + 손실 중 → 포지션 50% 축소 ──
    if (!closeReason && hoursHeld >= 12 && unrealPnl < 0 && !pos.timeReduceApplied) {
      const reduceQty = Math.round(pos.quantity * 500) / 1000;
      const remainQty = pos.quantity - reduceQty;
      if (remainQty > 0) {
        const reducePnl = isLong
          ? (currentPrice - pos.entryPrice) * reduceQty
          : (pos.entryPrice - currentPrice) * reduceQty;
        const reduceFee = reduceQty * currentPrice * CONFIG.feeMaker * 2;
        const netReducePnl = reducePnl - reduceFee;
        state.capital += netReducePnl;
        state.totalPnl += netReducePnl;
        pos.quantity = remainQty;
        pos.costBasis = remainQty * pos.entryPrice;
        pos.timeReduceApplied = true;
        console.log(`[paper-v2] ⏰ ${pos.symbol} 12h 경과 + 손실 → 50% 축소 | 축소 PnL $${netReducePnl.toFixed(2)}`);
        sendTelegram(
          `⏰ <b>${pos.symbol} 리스크 축소 (50%)</b>\n` +
          `12시간 경과 + 손실 중 → 포지션 50% 축소\n` +
          `축소 PnL: <b>$${netReducePnl.toFixed(2)}</b>\n` +
          `남은 수량: ${remainQty} ${pos.symbol}\n` +
          `현재가: $${currentPrice} | 자본: $${state.capital.toFixed(0)}`
        );
        saveState(state);
      }
    }

    // ── 프로그레시브 트레일링 스탑 5단계 ──
    const targetDist = Math.abs(pos.tpPrice - pos.entryPrice);
    const trailLevel = pos.trailLevel || 0;
    const TRAIL_STEPS = [
      { threshold: 0.20, slAt: 0 },      // 20% 도달 → BE
      { threshold: 0.40, slAt: 0.20 },    // 40% 도달 → 20% 확보
      { threshold: 0.60, slAt: 0.40 },    // 60% 도달 → 40% 확보
      { threshold: 0.80, slAt: 0.60 },    // 80% 도달 → 60% 확보
      { threshold: 0.95, slAt: 0.80 },    // 95% 도달 → 80% 확보
    ];
    for (let s = trailLevel; s < TRAIL_STEPS.length; s++) {
      const step = TRAIL_STEPS[s];
      const thresholdPrice = isLong
        ? pos.entryPrice + targetDist * step.threshold
        : pos.entryPrice - targetDist * step.threshold;
      const newSlPrice = isLong
        ? pos.entryPrice + targetDist * step.slAt
        : pos.entryPrice - targetDist * step.slAt;
      const reached = isLong ? currentPrice >= thresholdPrice : currentPrice <= thresholdPrice;
      if (reached && s >= trailLevel) {
        pos.slPrice = Math.round(newSlPrice * 100) / 100;
        pos.trailLevel = s + 1;
        const pctLocked = Math.round(step.slAt * 100);
        console.log(`[paper-v2] ${pos.symbol} 트레일 ${s + 1}단계 — SL $${pos.slPrice} (${pctLocked}% 수익 확보)`);
        sendTelegram(
          `🔒 <b>${pos.symbol} 트레일 ${s + 1}/${TRAIL_STEPS.length}단계</b>\n` +
          `SL → $${pos.slPrice} (${pctLocked}% 수익 확보)\n` +
          `현재가: $${currentPrice}`
        );
        saveState(state);
        break; // 한 호출당 한 단계씩만 진행
      }
    }

    // ── DCA 물타기: 손실 2%+ & 시그널 유효 & 미적용 → 추가 매수 ──
    if (!closeReason && !pos.dcaApplied && hoursHeld >= 2 && hoursHeld <= 24) {
      const pnlPct = pos.costBasis > 0 ? (unrealPnl / pos.costBasis * 100) : 0;
      if (pnlPct <= -2 && pnlPct > -5) {
        try {
          const qSig = await quantSignals.getSignalForSymbol(pos.symbol);
          const sigDirection = qSig.action;
          const sigGrade = qSig.grade || 'D';
          const GRADE_ORD = { S: 5, A: 4, B: 3, C: 2, D: 1 };
          const isSameDir = (isLong && sigDirection === 'BUY') || (!isLong && sigDirection === 'SELL');

          if (isSameDir && (GRADE_ORD[sigGrade] || 0) >= 3) {
            // 현재 포지션의 25% 만큼 추가 매수 (물타기)
            const dcaQty = Math.round(pos.quantity * 250) / 1000;
            const dcaCost = dcaQty * currentPrice;
            const dcaMargin = dcaCost / (state.leverage || 20);

            if (dcaMargin <= state.capital * 0.15) {
              // 평균 진입가 재계산
              const totalQty = pos.quantity + dcaQty;
              const totalCost = pos.costBasis + dcaCost;
              const newAvgEntry = totalCost / totalQty;

              pos.quantity = Math.round(totalQty * 1000) / 1000;
              pos.costBasis = Math.round(totalCost * 100) / 100;
              pos.entryPrice = Math.round(newAvgEntry * 100) / 100;
              pos.dcaApplied = true;
              pos.dcaPrice = currentPrice;
              pos.dcaQty = dcaQty;

              // SL 유지, TP는 새 진입가 기준 재계산
              const origTpDist = targetDist;
              pos.tpPrice = isLong
                ? Math.round((newAvgEntry + origTpDist) * 100) / 100
                : Math.round((newAvgEntry - origTpDist) * 100) / 100;

              console.log(`[paper-v2] ${pos.symbol} DCA 물타기 +${dcaQty} @ $${currentPrice} → 평균 $${newAvgEntry.toFixed(2)}`);
              sendTelegram(
                `📉 <b>${pos.symbol} DCA 물타기</b>\n` +
                `━━━━━━━━━━━━━━━\n` +
                `추가: ${dcaQty} ${pos.symbol} @ $${currentPrice}\n` +
                `평균가: $${pos.entryPrice} → $${newAvgEntry.toFixed(2)}\n` +
                `퀀트: ${sigDirection} [${sigGrade}급] — 방향 유효\n` +
                `새 목표: $${pos.tpPrice}\n` +
                `총 수량: ${pos.quantity} ${pos.symbol}`
              );
              saveState(state);
            }
          }
        } catch {}
      }
    }

    // ── 스케일 인: 수익 3%+ & 강한 시그널 → 추가 진입 ──
    if (!closeReason && !pos.scaleInApplied && hoursHeld >= 1) {
      const pnlPct = pos.costBasis > 0 ? (unrealPnl / pos.costBasis * 100) : 0;
      if (pnlPct >= 3) {
        try {
          const qSig = await quantSignals.getSignalForSymbol(pos.symbol);
          const isSameDir = (isLong && qSig.action === 'BUY') || (!isLong && qSig.action === 'SELL');
          const GRADE_ORD = { S: 5, A: 4, B: 3, C: 2, D: 1 };

          if (isSameDir && (GRADE_ORD[qSig.grade] || 0) >= 4) {
            const scaleQty = Math.round(pos.quantity * 200) / 1000; // 20% 추가
            const scaleCost = scaleQty * currentPrice;
            const scaleMargin = scaleCost / (state.leverage || 20);

            if (scaleMargin <= state.capital * 0.1) {
              const totalQty = pos.quantity + scaleQty;
              const totalCost = pos.costBasis + scaleCost;

              pos.quantity = Math.round(totalQty * 1000) / 1000;
              pos.costBasis = Math.round(totalCost * 100) / 100;
              pos.scaleInApplied = true;

              // SL을 BE+로 이동 (수익 보호)
              const feeCost = pos.quantity * pos.entryPrice * CONFIG.feeMaker * 2;
              const bePrice = isLong
                ? pos.entryPrice + feeCost / pos.quantity
                : pos.entryPrice - feeCost / pos.quantity;
              if ((isLong && pos.slPrice < bePrice) || (!isLong && pos.slPrice > bePrice)) {
                pos.slPrice = Math.round(bePrice * 100) / 100;
              }

              console.log(`[paper-v2] ${pos.symbol} 스케일인 +${scaleQty} @ $${currentPrice}`);
              sendTelegram(
                `📈 <b>${pos.symbol} 스케일 인 (추세 강화)</b>\n` +
                `추가: ${scaleQty} ${pos.symbol} @ $${currentPrice}\n` +
                `퀀트: ${qSig.action} [${qSig.grade}급] — 추세 지속\n` +
                `총 수량: ${pos.quantity} | SL: $${pos.slPrice}\n` +
                `미실현: +$${unrealPnl.toFixed(2)} (+${pnlPct.toFixed(1)}%)`
              );
              saveState(state);
            }
          }
        } catch {}
      }
    }

    // ── 모멘텀 소멸 조기 청산: 수익이었다가 0 근처로 돌아오면 보호 ──
    if (!closeReason && hoursHeld >= 3 && !pos.momentumExitChecked) {
      const pnlPct = pos.costBasis > 0 ? (unrealPnl / pos.costBasis * 100) : 0;
      // 한때 2%+ 수익이었는데 0.3% 이하로 줄어들면 → 모멘텀 소멸
      if (pos.peakPnlPct && pos.peakPnlPct >= 2 && pnlPct <= 0.3) {
        closeReason = 'MOMENTUM_FADE';
        console.log(`[paper-v2] ${pos.symbol} 모멘텀 소멸 — peak ${pos.peakPnlPct.toFixed(1)}% → 현재 ${pnlPct.toFixed(1)}%`);
      }
      // 최고 수익률 기록
      if (!pos.peakPnlPct || pnlPct > pos.peakPnlPct) {
        pos.peakPnlPct = pnlPct;
      }
    }

    // ── SL/TP 체크 ──
    if (!closeReason) {
      if (isLong) {
        if (currentPrice <= pos.slPrice) closeReason = 'SL';
        else if (currentPrice >= pos.tpPrice) closeReason = 'TP';
      } else {
        if (currentPrice >= pos.slPrice) closeReason = 'SL';
        else if (currentPrice <= pos.tpPrice) closeReason = 'TP';
      }
    }
    // 시간 초과 + 손실 중 → 빨리 정리
    if (!closeReason && hoursHeld >= CONFIG.maxHoldHours) closeReason = 'TIMEOUT';
    else if (!closeReason && hoursHeld >= CONFIG.maxHoldHours * 0.7 && unrealPnl < 0) closeReason = 'TIMEOUT_LOSS';

    // ── 부분 청산: TP 도달 시 40% 먼저 청산 (나머지 60% 달리기) ──
    if (closeReason === 'TP' && !pos.partialClosed && pos.quantity > 0) {
      const halfQty = Math.round(pos.quantity * 400) / 1000; // 50→40%
      const remainQty = pos.quantity - halfQty;
      const halfPnl = isLong
        ? (currentPrice - pos.entryPrice) * halfQty
        : (pos.entryPrice - currentPrice) * halfQty;
      const halfFee = halfQty * currentPrice * CONFIG.feeMaker * 2;
      const netHalfPnl = halfPnl - halfFee;

      state.capital += netHalfPnl;
      state.totalPnl += netHalfPnl;

      const extTarget = isLong
        ? pos.entryPrice + targetDist * 1.5
        : pos.entryPrice - targetDist * 1.5;

      pos.quantity = remainQty;
      pos.costBasis = remainQty * pos.entryPrice;
      pos.tpPrice = Math.round(extTarget * 100) / 100;
      pos.slPrice = isLong
        ? Math.round((pos.entryPrice + targetDist * 0.66) * 100) / 100
        : Math.round((pos.entryPrice - targetDist * 0.66) * 100) / 100;
      pos.partialClosed = true;

      console.log(`[paper-v2] ${pos.symbol} 부분청산 50% | PnL $${netHalfPnl.toFixed(2)} | 나머지 목표 $${pos.tpPrice}`);
      sendTelegram(
        `💰 <b>${pos.symbol} 부분청산 (50%)</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `청산 수량: ${halfQty} ${pos.symbol}\n` +
        `청산 PnL: <b>$${netHalfPnl.toFixed(2)}</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `남은 수량: ${remainQty} ${pos.symbol}\n` +
        `남은 포지션: $${(remainQty * pos.entryPrice).toFixed(0)} (${leverage}x)\n` +
        `새 목표: $${pos.tpPrice} (확장 1.5x)\n` +
        `새 SL: $${pos.slPrice} (66% 수익 확보)\n` +
        `━━━━━━━━━━━━━━━\n` +
        `자본: <b>$${state.capital.toFixed(0)}</b>`
      );
      saveState(state);
      closeReason = null;
    }

    // ── 전체 청산 ──
    if (closeReason) {
      const pnl = isLong
        ? (currentPrice - pos.entryPrice) * pos.quantity
        : (pos.entryPrice - currentPrice) * pos.quantity;
      const fee = pos.quantity * currentPrice * CONFIG.feeMaker * 2;
      const netPnl = pnl - fee;

      state.capital += netPnl;
      state.totalPnl += netPnl;
      state.totalTrades++;
      updateCoinPerformance(state, pos.symbol, netPnl > 0);

      if (netPnl > 0) {
        state.wins++;
        state.consecutiveLosses = 0;
        state.consecutiveWins = (state.consecutiveWins || 0) + 1;
      } else {
        state.losses++;
        state.consecutiveLosses++;
        state.consecutiveWins = 0;
        if (state.consecutiveLosses >= CONFIG.circuitBreakerLosses) {
          state.circuitBreakerUntil = now + CONFIG.circuitBreakerHours * 3600000;
          state.consecutiveLosses = 0;
          if (_deps.triggerStrategyReview) _deps.triggerStrategyReview('3연패').catch(() => {});
        }
      }

      // SL 패턴 기록
      if (closeReason === 'SL') {
        if (!state.slPatterns) state.slPatterns = [];
        state.slPatterns.push({
          symbol: pos.symbol, direction: pos.direction, grade: pos.grade,
          confidence: pos.confidence, hour: new Date().getUTCHours(), ts: now,
        });
        if (state.slPatterns.length > 100) state.slPatterns = state.slPatterns.slice(-100);
      }

      // TP 재진입 큐
      if (closeReason === 'TP') {
        if (!state.reentryQueue) state.reentryQueue = [];
        const REENTRY_DELAY_MS = 30 * 60 * 1000;
        state.reentryQueue.push({ symbol: pos.symbol, direction: pos.direction, afterTs: now + REENTRY_DELAY_MS });
      }

      if (state.capital > state.peakCapital) state.peakCapital = state.capital;
      const dd = (state.peakCapital - state.capital) / state.peakCapital;
      if (dd > state.maxDrawdown) state.maxDrawdown = dd;

      const trade = {
        symbol: pos.symbol, direction: pos.direction, grade: pos.grade, confidence: pos.confidence,
        entryPrice: pos.entryPrice, exitPrice: currentPrice, slPrice: pos.slPrice, tpPrice: pos.tpPrice,
        quantity: pos.quantity, pnl: Math.round(netPnl * 100) / 100,
        pnlPct: Math.round(netPnl / pos.costBasis * 10000) / 100,
        closeReason, entryTime: pos.entryTime, exitTime: new Date().toISOString(),
        hoursHeld: Math.round(hoursHeld * 10) / 10, capitalAfter: Math.round(state.capital * 100) / 100,
      };
      appendTrade(trade);
      state.positions.splice(i, 1);
      recordLesson(pos, currentPrice, netPnl, closeReason, hoursHeld).catch(() => {});
      if (notifyFn) notifyFn('trade_closed', trade);

      const pnlEmoji = netPnl > 0 ? '✅' : '❌';
      const roeFormatted = pos.costBasis > 0 ? (netPnl / (pos.costBasis / 20) * 100).toFixed(1) : '0';
      const fundingLine = pos.totalFundingPaid ? `\n펀딩비: $${pos.totalFundingPaid.toFixed(2)}` : '';
      sendTelegramWithButtons(
        `${pnlEmoji} <b>Paper Trade 청산 (${closeReason})</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `코인: <b>${pos.symbol}</b> | ${pos.direction}\n` +
        `진입: $${pos.entryPrice} → 청산: $${currentPrice}\n` +
        `━━━━━━━━━━━━━━━\n` +
        `PnL: <b>$${netPnl.toFixed(2)}</b>${fundingLine}\n` +
        `수익률: ${trade.pnlPct}% (ROE ${roeFormatted}%)\n` +
        `수량: ${pos.quantity} ${pos.symbol}\n` +
        `보유: ${trade.hoursHeld}h\n` +
        `━━━━━━━━━━━━━━━\n` +
        `자본: <b>$${state.capital.toFixed(0)}</b> | 승률: ${state.totalTrades > 0 ? (state.wins / state.totalTrades * 100).toFixed(0) : 0}%`,
        [[
          { text: '📊 Terminal', url: `${_deps.TERMINAL_URL}/?coin=${pos.symbol}` },
          { text: '📋 Dashboard', url: _deps.DASHBOARD_URL },
        ]]
      );
    }
  }

  // ── 자동 이익 실현: 전체 미실현 PnL >= 자본 5% ──
  if (state.positions.length > 0) {
    let totalUnrealPnl = 0;
    let bestPosIdx = -1;
    let bestPosPnl = -Infinity;
    for (let j = 0; j < state.positions.length; j++) {
      const p = state.positions[j];
      let pPrice;
      try { pPrice = await fetchPrice(p.symbol); } catch { continue; }
      if (!pPrice) continue;
      const pIsLong = p.direction === 'BUY' || p.direction === 'LONG';
      const pUnreal = pIsLong ? (pPrice - p.entryPrice) * p.quantity : (p.entryPrice - pPrice) * p.quantity;
      totalUnrealPnl += pUnreal;
      if (pUnreal > bestPosPnl) { bestPosPnl = pUnreal; bestPosIdx = j; }
    }
    const profitThreshold = state.capital * 0.05;
    if (totalUnrealPnl >= profitThreshold && bestPosIdx >= 0 && bestPosPnl > 0) {
      const bp = state.positions[bestPosIdx];
      if (!bp.autoProfitTaken) {
        let bpPrice;
        try { bpPrice = await fetchPrice(bp.symbol); } catch {}
        if (bpPrice) {
          const bpIsLong = bp.direction === 'BUY' || bp.direction === 'LONG';
          const halfQty = Math.round(bp.quantity * 500) / 1000;
          const remainQty = bp.quantity - halfQty;
          if (remainQty > 0) {
            const halfPnl = bpIsLong
              ? (bpPrice - bp.entryPrice) * halfQty
              : (bp.entryPrice - bpPrice) * halfQty;
            const halfFee = halfQty * bpPrice * CONFIG.feeMaker * 2;
            const netHalfPnl = halfPnl - halfFee;
            state.capital += netHalfPnl;
            state.totalPnl += netHalfPnl;
            bp.quantity = remainQty;
            bp.costBasis = remainQty * bp.entryPrice;
            bp.autoProfitTaken = true;
            sendTelegram(
              `💰 <b>이익 보존 — ${bp.symbol} 부분청산 (50%)</b>\n` +
              `━━━━━━━━━━━━━━━\n` +
              `전체 미실현: <b>$${totalUnrealPnl.toFixed(2)}</b> (자본 ${(totalUnrealPnl / state.capital * 100).toFixed(1)}%)\n` +
              `${bp.symbol} 부분청산 PnL: <b>$${netHalfPnl.toFixed(2)}</b>\n` +
              `남은 수량: ${remainQty} ${bp.symbol}\n` +
              `━━━━━━━━━━━━━━━\n` +
              `자본: <b>$${state.capital.toFixed(0)}</b>`
            );
            saveState(state);
          }
        }
      }
    }
  }

  // ── 가격 알림 체크 ──
  if (state.priceAlerts && state.priceAlerts.length > 0) {
    for (let i = state.priceAlerts.length - 1; i >= 0; i--) {
      const alert = state.priceAlerts[i];
      let alertPrice;
      try { alertPrice = await fetchPrice(alert.symbol); } catch { continue; }
      if (!alertPrice) continue;
      const triggered = (alert.direction === 'above' && alertPrice >= alert.targetPrice)
        || (alert.direction === 'below' && alertPrice <= alert.targetPrice);
      if (triggered) {
        sendTelegram(
          `🔔 <b>가격 알림!</b>\n\n` +
          `${alert.symbol} $${alertPrice.toLocaleString()}\n` +
          `목표: $${alert.targetPrice.toLocaleString()} (${alert.direction === 'above' ? '▲도달' : '▼도달'})\n` +
          `설정일: ${alert.createdAt.slice(0, 10)}`
        );
        state.priceAlerts.splice(i, 1);
      }
    }
  }

  saveState(state);
}

// ── Swing 포지션 체크 ──
async function checkSwingPositions(state, notifyFn) {
  if (!state.swingPositions || state.swingPositions.length === 0) return;
  const now = Date.now();
  const CONFIG = _deps.CONFIG;
  const { sendTelegram, sendTelegramWithButtons, fetchPrice, saveState, appendTrade, recordLesson, updateCoinPerformance } = _deps;

  for (let i = state.swingPositions.length - 1; i >= 0; i--) {
    const pos = state.swingPositions[i];
    let currentPrice;
    try { currentPrice = await fetchPrice(pos.symbol); } catch { continue; }
    if (!currentPrice) continue;

    const { isLong, unrealPnl, margin, roePct, hoursHeld } = calcLiveData(pos, currentPrice);
    let closeReason = null;
    const leverage = state.leverage || 20;

    // ── Swing Funding Fee (8시간마다) ──
    if (!pos.lastFundingTs) pos.lastFundingTs = pos.entryTs;
    const hoursSinceLastFunding = (now - pos.lastFundingTs) / 3600000;
    if (hoursSinceLastFunding >= 8) {
      try {
        const frRes = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pos.symbol}USDT`, { signal: AbortSignal.timeout(3000) });
        if (frRes.ok) {
          const fr = await frRes.json();
          const fundingRate = parseFloat(fr.lastFundingRate || 0);
          const fundingCost = pos.costBasis * Math.abs(fundingRate) * (isLong ? (fundingRate > 0 ? -1 : 1) : (fundingRate > 0 ? 1 : -1));
          const fundingPeriods = Math.floor(hoursSinceLastFunding / 8);
          if (Math.abs(fundingCost * fundingPeriods) > 0.01) {
            const totalFunding = fundingCost * fundingPeriods;
            state.capital += totalFunding;
            state.totalPnl += totalFunding;
            if (!pos.totalFundingPaid) pos.totalFundingPaid = 0;
            pos.totalFundingPaid += totalFunding;
            pos.lastFundingTs = now;
            saveState(state);
          } else { pos.lastFundingTs = now; }
        }
      } catch {}
    }

    console.log(`[paper-v2] 📊 Swing ${pos.symbol} ${pos.direction} | $${currentPrice} | PnL $${unrealPnl.toFixed(2)} | ROE ${roePct.toFixed(1)}% | ${hoursHeld.toFixed(1)}h${pos.totalFundingPaid ? ' | 펀딩 $' + pos.totalFundingPaid.toFixed(2) : ''}`);

    if (roePct <= -50) closeReason = 'EMERGENCY_ROE';

    // 트레일링 스탑 5단계
    const targetDist = Math.abs(pos.tpPrice - pos.entryPrice);
    const trailLevel = pos.trailLevel || 0;
    const TRAIL_STEPS = [
      { threshold: 0.20, slAt: 0 },
      { threshold: 0.40, slAt: 0.20 },
      { threshold: 0.60, slAt: 0.40 },
      { threshold: 0.80, slAt: 0.60 },
      { threshold: 0.95, slAt: 0.80 },
    ];
    for (let s = trailLevel; s < TRAIL_STEPS.length; s++) {
      const step = TRAIL_STEPS[s];
      const thresholdPrice = isLong ? pos.entryPrice + targetDist * step.threshold : pos.entryPrice - targetDist * step.threshold;
      const newSlPrice = isLong ? pos.entryPrice + targetDist * step.slAt : pos.entryPrice - targetDist * step.slAt;
      const reached = isLong ? currentPrice >= thresholdPrice : currentPrice <= thresholdPrice;
      if (reached && s >= trailLevel) {
        pos.slPrice = Math.round(newSlPrice * 100) / 100;
        pos.trailLevel = s + 1;
        sendTelegram(`🔒 <b>Swing ${pos.symbol} 트레일 ${s + 1}/${TRAIL_STEPS.length}단계</b>\nSL → $${pos.slPrice} (${Math.round(step.slAt * 100)}% 확보)\n현재가: $${currentPrice}`);
        saveState(state);
        break; // 한 호출당 한 단계씩만 진행
      }
    }

    if (isLong) {
      if (currentPrice <= pos.slPrice) closeReason = 'SL';
      else if (currentPrice >= pos.tpPrice) closeReason = 'TP';
    } else {
      if (currentPrice >= pos.slPrice) closeReason = 'SL';
      else if (currentPrice <= pos.tpPrice) closeReason = 'TP';
    }
    if (hoursHeld >= CONFIG.maxSwingHoldHours) closeReason = 'TIMEOUT';

    if (closeReason) {
      const pnl = isLong ? (currentPrice - pos.entryPrice) * pos.quantity : (pos.entryPrice - currentPrice) * pos.quantity;
      const fee = pos.quantity * currentPrice * CONFIG.feeMaker * 2;
      const netPnl = pnl - fee;

      state.capital += netPnl;
      state.totalPnl += netPnl;
      state.totalTrades++;
      updateCoinPerformance(state, pos.symbol, netPnl > 0);
      if (netPnl > 0) { state.wins++; state.consecutiveLosses = 0; state.consecutiveWins = (state.consecutiveWins || 0) + 1; }
      else { state.losses++; state.consecutiveLosses++; state.consecutiveWins = 0; }
      if (state.capital > state.peakCapital) state.peakCapital = state.capital;
      const dd = (state.peakCapital - state.capital) / state.peakCapital;
      if (dd > state.maxDrawdown) state.maxDrawdown = dd;

      const trade = {
        symbol: pos.symbol, direction: pos.direction, grade: pos.grade, confidence: pos.confidence,
        strategy: 'swing', entryPrice: pos.entryPrice, exitPrice: currentPrice,
        slPrice: pos.slPrice, tpPrice: pos.tpPrice, quantity: pos.quantity,
        pnl: Math.round(netPnl * 100) / 100,
        pnlPct: Math.round(netPnl / pos.costBasis * 10000) / 100,
        closeReason, entryTime: pos.entryTime, exitTime: new Date().toISOString(),
        hoursHeld: Math.round(hoursHeld * 10) / 10, capitalAfter: Math.round(state.capital * 100) / 100,
      };
      appendTrade(trade);
      state.swingPositions.splice(i, 1);
      recordLesson({ ...pos, strategy: 'swing' }, currentPrice, netPnl, closeReason, hoursHeld).catch(() => {});
      if (notifyFn) notifyFn('trade_closed', trade);

      const pnlEmoji = netPnl > 0 ? '✅' : '❌';
      sendTelegramWithButtons(
        `${pnlEmoji} <b>Swing Trade 청산 (${closeReason})</b>\n` +
        `━━━━━━━━━━━━━━━\n` +
        `코인: <b>${pos.symbol}</b> | ${pos.direction}\n` +
        `진입: $${pos.entryPrice} → 청산: $${currentPrice}\n` +
        `PnL: <b>$${netPnl.toFixed(2)}</b> (${trade.pnlPct}%)\n` +
        `보유: ${trade.hoursHeld}h\n` +
        `━━━━━━━━━━━━━━━\n` +
        `자본: <b>$${state.capital.toFixed(0)}</b>`,
        [[{ text: '📊 Dashboard', url: _deps.DASHBOARD_URL }]]
      );
      saveState(state);
    }
  }
}

// ── 15분 포지션 재검토 (방향 전환 감지 시 청산) ──
async function reviewPositions(state, notifyFn) {
  const now = Date.now();
  if (!state.lastReviewTs) state.lastReviewTs = 0;
  if (now - state.lastReviewTs < _deps.POSITION_REVIEW_INTERVAL) return;
  state.lastReviewTs = now;

  if (!state.positions || state.positions.length === 0) return;
  console.log(`[paper-v2] 포지션 재검토 시작 (${state.positions.length}개)`);

  const { sendTelegram, fetchPrice, saveState, appendTrade, recordLesson, updateCoinPerformance, runSingleAnalysis } = _deps;
  const CONFIG = _deps.CONFIG;

  for (let i = state.positions.length - 1; i >= 0; i--) {
    const pos = state.positions[i];
    try {
      const decision = await runSingleAnalysis(pos.symbol, 'scalp');
      if (!decision) continue;

      const reviewAction = (decision.action || '').toUpperCase();
      const reviewConf = decision.confidence || 0;
      const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
      const isReverse = (isLong && reviewAction === 'SELL') || (!isLong && reviewAction === 'BUY');

      if (isReverse && reviewConf >= 65) {
        const price = await fetchPrice(pos.symbol);
        if (!price) continue;

        const pnl = isLong ? (price - pos.entryPrice) * pos.quantity : (pos.entryPrice - price) * pos.quantity;
        const fee = pos.quantity * price * CONFIG.feeMaker * 2;
        const netPnl = pnl - fee;
        const hoursHeld = (now - pos.entryTs) / 3600000;

        state.capital += netPnl;
        state.totalPnl += netPnl;
        state.totalTrades++;
        updateCoinPerformance(state, pos.symbol, netPnl > 0);
        if (netPnl > 0) { state.wins++; state.consecutiveLosses = 0; state.consecutiveWins = (state.consecutiveWins || 0) + 1; }
        else { state.losses++; state.consecutiveLosses++; state.consecutiveWins = 0; }
        if (state.capital > state.peakCapital) state.peakCapital = state.capital;
        const dd = (state.peakCapital - state.capital) / state.peakCapital;
        if (dd > state.maxDrawdown) state.maxDrawdown = dd;

        const trade = {
          symbol: pos.symbol, direction: pos.direction, grade: pos.grade, confidence: pos.confidence,
          entryPrice: pos.entryPrice, exitPrice: price, slPrice: pos.slPrice, tpPrice: pos.tpPrice,
          quantity: pos.quantity, pnl: Math.round(netPnl * 100) / 100,
          pnlPct: Math.round(netPnl / pos.costBasis * 10000) / 100,
          closeReason: 'REVIEW_REVERSE', entryTime: pos.entryTime, exitTime: new Date().toISOString(),
          hoursHeld: Math.round(hoursHeld * 10) / 10, capitalAfter: Math.round(state.capital * 100) / 100,
        };
        appendTrade(trade);
        state.positions.splice(i, 1);
        recordLesson(pos, price, netPnl, 'REVIEW_REVERSE', hoursHeld).catch(() => {});
        if (notifyFn) notifyFn('trade_closed', trade);

        sendTelegram(
          `⚠️ <b>방향 전환 감지 — ${pos.symbol} 포지션 청산</b>\n` +
          `━━━━━━━━━━━━━━━\n` +
          `${netPnl > 0 ? '✅' : '❌'} 기존: <b>${pos.direction}</b> → 재분석: <b>${reviewAction}</b> (${reviewConf}%)\n` +
          `진입: $${pos.entryPrice} → 청산: $${price}\n` +
          `PnL: <b>$${netPnl.toFixed(2)}</b> (${trade.pnlPct}%)\n` +
          `보유: ${trade.hoursHeld}h\n` +
          `━━━━━━━━━━━━━━━\n` +
          `자본: <b>$${state.capital.toFixed(0)}</b>`
        );
        saveState(state);
        break;
      }
    } catch (e) {
      console.error(`[paper-v2] ${pos.symbol} 재검토 에러:`, e.message);
    }
  }
}

// ── 스마트 재진입 큐 처리 ──
async function processReentryQueue(state, notifyFn) {
  if (!state.reentryQueue || state.reentryQueue.length === 0) return;
  const now = Date.now();
  // 회로차단 중이면 재진입 중단
  if (state.circuitBreakerUntil && now < state.circuitBreakerUntil) return;
  if (state.drawdownHaltUntil && now < state.drawdownHaltUntil) return;
  const { runAnalysis, saveState } = _deps;
  const getEffectiveMaxPositions = _deps.getEffectiveMaxPositions;

  state.reentryQueue = state.reentryQueue.filter(r => (now - r.afterTs) < 2 * 3600000);

  for (let i = state.reentryQueue.length - 1; i >= 0; i--) {
    const re = state.reentryQueue[i];
    if (now < re.afterTs) continue;
    if (state.positions.find(p => p.symbol === re.symbol)) {
      state.reentryQueue.splice(i, 1);
      continue;
    }
    const effectiveMax = getEffectiveMaxPositions(state);
    if (state.positions.length >= effectiveMax) continue;

    console.log(`[paper-v2] 재진입 분석: ${re.symbol} (이전 방향: ${re.direction})`);
    try {
      // 퀀트 시그널로 빠르게 판단 (AI 호출 비용 절약)
      const qSig = await quantSignals.getSignalForSymbol(re.symbol);
      const qAction = (qSig.action || '').toUpperCase();
      const GRADE_ORD = { S: 5, A: 4, B: 3, C: 2, D: 1 };

      if (qAction === re.direction && (GRADE_ORD[qSig.grade] || 0) >= 2) {
        // 추세 지속 확인 → 실제 재진입 실행
        const price = await _deps.fetchPrice(re.symbol);
        if (price) {
          const CONFIG = _deps.CONFIG || { riskPerTrade: 0.015, maxHoldHours: 24, feeMaker: 0.0002 };
          const riskAmt = state.capital * (CONFIG.riskPerTrade || 0.015) * 0.8; // 재진입은 80% 사이즈

          // ATR 기반 SL/TP
          let slPrice, tpPrice;
          try {
            const atrStops = await quantSignals.getATRStops(re.symbol, re.direction);
            if (atrStops && atrStops.atr14 > 0) {
              const slDist = atrStops.atr14 * 2.0;
              const tpDist = atrStops.atr14 * 3.5;
              slPrice = re.direction === 'BUY' ? price - slDist : price + slDist;
              tpPrice = re.direction === 'BUY' ? price + tpDist : price - tpDist;
            }
          } catch {}

          if (!slPrice || !tpPrice) {
            const defaultPct = 0.02;
            slPrice = re.direction === 'BUY' ? price * (1 - defaultPct) : price * (1 + defaultPct);
            tpPrice = re.direction === 'BUY' ? price * (1 + defaultPct * 1.75) : price * (1 - defaultPct * 1.75);
          }

          const slDist = Math.abs(price - slPrice);
          const quantity = slDist > 0 ? riskAmt / slDist : 0;
          const costBasis = quantity * price;
          const LEVERAGE = state.leverage || 20;
          const marginRequired = costBasis / LEVERAGE;

          if (quantity > 0 && marginRequired <= state.capital * 0.4) {
            const position = {
              symbol: re.symbol, direction: re.direction, grade: qSig.grade || 'C',
              confidence: qSig.confidence || 50, strategy: 'reentry',
              entryPrice: price, slPrice: Math.round(slPrice * 100) / 100,
              tpPrice: Math.round(tpPrice * 100) / 100,
              quantity: Math.round(quantity * 1000) / 1000,
              costBasis: Math.round(costBasis * 100) / 100,
              maxHoldHours: CONFIG.maxHoldHours || 24,
              entryTs: Date.now(), entryTime: new Date().toISOString(),
              rationale: `재진입: TP 후 추세 지속 확인 (퀀트 ${qAction} [${qSig.grade}급])`,
            };
            state.positions.push(position);
            console.log(`[paper-v2] ${re.symbol} 재진입 성공! ${re.direction} @ $${price}`);

            const { sendTelegramWithButtons, DASHBOARD_URL, TERMINAL_URL } = _deps;
            sendTelegramWithButtons(
              `🔄 <b>${re.symbol} 재진입 (추세 지속)</b>\n━━━━━━━━━━━━━━━\n` +
              `방향: ${re.direction === 'BUY' ? 'LONG 🟢' : 'SHORT 🔴'}\n` +
              `진입: $${price} | SL: $${position.slPrice} | TP: $${position.tpPrice}\n` +
              `퀀트: ${qAction} [${qSig.grade}급]\n수량: ${position.quantity} (80% 사이즈)`,
              [[{ text: '📊 Terminal', url: `${TERMINAL_URL}/?coin=${re.symbol}` }, { text: '📋 Dashboard', url: DASHBOARD_URL }]]
            );
          }
        }
      } else {
        console.log(`[paper-v2] ${re.symbol} 재진입 취소 — 추세 변경 (${re.direction} → ${qAction} [${qSig.grade}급])`);
      }
    } catch (e) {
      console.log(`[paper-v2] ${re.symbol} 재진입 분석 실패: ${e.message}`);
    }
    state.reentryQueue.splice(i, 1);
    saveState(state);
    break;
  }
}

module.exports = {
  inject,
  calcLiveData,
  checkPositions,
  checkSwingPositions,
  reviewPositions,
  processReentryQueue,
};
