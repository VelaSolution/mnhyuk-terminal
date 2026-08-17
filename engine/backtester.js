'use strict';

/**
 * Backtester Engine — 바이낸스 과거 캔들 기반 전략 백테스트
 *
 * 사용법:
 *   const { backtest, strategies, compareAll } = require('./backtester');
 *   const result = await backtest('BTC', 'rsi_reversal', 90);
 *   const comparison = await compareAll('BTC', 90);
 */

// ── 기술적 지표 헬퍼 ──

function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function sma(values, period) {
  const out = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { out.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out.push(sum / period);
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function bollingerBands(closes, period = 20, mult = 2) {
  const smaSeries = sma(closes, period);
  const upper = [], lower = [], middle = [];
  for (let i = 0; i < closes.length; i++) {
    if (smaSeries[i] === null) { upper.push(null); lower.push(null); middle.push(null); continue; }
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (closes[j] - smaSeries[i]) ** 2;
    const std = Math.sqrt(sqSum / period);
    middle.push(smaSeries[i]);
    upper.push(smaSeries[i] + mult * std);
    lower.push(smaSeries[i] - mult * std);
  }
  return { upper, middle, lower };
}

function macdIndicator(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = ema(macdLine, signal);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// ATR (Average True Range)
function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trValues = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    trValues.push(tr);
  }
  // First ATR = simple average
  let atrVal = 0;
  for (let i = 0; i < period; i++) atrVal += trValues[i];
  atrVal /= period;
  out[period] = atrVal;
  for (let i = period; i < trValues.length; i++) {
    atrVal = (atrVal * (period - 1) + trValues[i]) / period;
    out[i + 1] = atrVal;
  }
  return out;
}

// ADX (Average Directional Index)
function adx(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period * 2 + 1) return out;

  const plusDM = [], minusDM = [], trArr = [];
  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].h - candles[i - 1].h;
    const downMove = candles[i - 1].l - candles[i].l;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trArr.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    ));
  }

  // Smoothed sums
  let smoothPlusDM = 0, smoothMinusDM = 0, smoothTR = 0;
  for (let i = 0; i < period; i++) {
    smoothPlusDM += plusDM[i];
    smoothMinusDM += minusDM[i];
    smoothTR += trArr[i];
  }

  const dxValues = [];
  for (let i = period; i < trArr.length; i++) {
    if (i > period) {
      smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDM[i];
      smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDM[i];
      smoothTR = smoothTR - smoothTR / period + trArr[i];
    }
    const plusDI = smoothTR > 0 ? (smoothPlusDM / smoothTR) * 100 : 0;
    const minusDI = smoothTR > 0 ? (smoothMinusDM / smoothTR) * 100 : 0;
    const diSum = plusDI + minusDI;
    const dx = diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0;
    dxValues.push(dx);
  }

  // ADX = SMA of DX
  if (dxValues.length >= period) {
    let adxVal = 0;
    for (let i = 0; i < period; i++) adxVal += dxValues[i];
    adxVal /= period;
    out[period * 2] = adxVal;
    for (let i = period; i < dxValues.length; i++) {
      adxVal = (adxVal * (period - 1) + dxValues[i]) / period;
      out[period + i + 1] = adxVal;
    }
  }
  return out;
}

// ROC (Rate of Change)
function roc(closes, period = 12) {
  const out = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    out[i] = ((closes[i] - closes[i - period]) / closes[i - period]) * 100;
  }
  return out;
}

// VWAP (Volume Weighted Average Price) — 24봉(≈24h for 1h candles) 세션 리셋
function vwap(candles, sessionBars = 24) {
  const out = new Array(candles.length).fill(null);
  for (let i = 0; i < candles.length; i++) {
    // 세션 시작점: 현재 봉에서 sessionBars 전 또는 데이터 시작
    const sessionStart = Math.max(0, i - sessionBars + 1);
    let cumVol = 0, cumTP = 0;
    for (let j = sessionStart; j <= i; j++) {
      const tp = (candles[j].h + candles[j].l + candles[j].c) / 3;
      cumVol += candles[j].v;
      cumTP += tp * candles[j].v;
    }
    out[i] = cumVol > 0 ? cumTP / cumVol : (candles[i].h + candles[i].l + candles[i].c) / 3;
  }
  return out;
}

// Pivot Points (24봉 집계 기반 — 1h 캔들이면 24h, 4h면 4일)
function pivotPoints(candles, sessionBars = 24) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < sessionBars) {
      out.push(null);
      continue;
    }
    // 이전 세션(sessionBars개 봉)의 고가/저가/종가 집계
    let sessionHigh = -Infinity, sessionLow = Infinity;
    const sessionClose = candles[i - 1].c;
    for (let j = i - sessionBars; j < i; j++) {
      if (candles[j].h > sessionHigh) sessionHigh = candles[j].h;
      if (candles[j].l < sessionLow) sessionLow = candles[j].l;
    }
    const P = (sessionHigh + sessionLow + sessionClose) / 3;
    const S1 = 2 * P - sessionHigh;
    const R1 = 2 * P - sessionLow;
    const S2 = P - (sessionHigh - sessionLow);
    const R2 = P + (sessionHigh - sessionLow);
    out.push({ P, S1, R1, S2, R2 });
  }
  return out;
}

// Standard deviation helper
function stdDev(values, period, smaSeries) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    if (smaSeries[i] === null) continue;
    let sqSum = 0;
    for (let j = i - period + 1; j <= i; j++) sqSum += (values[j] - smaSeries[i]) ** 2;
    out[i] = Math.sqrt(sqSum / period);
  }
  return out;
}

// ── 전략 정의 ──

const strategies = {
  // 1. RSI 반전: RSI<30 롱, RSI>70 숏
  rsi_reversal: {
    name: 'RSI Reversal',
    description: 'RSI<30 롱, RSI>70 숏 (과매도/과매수 역추세)',
    slPct: 0.02,
    tpPct: 0.04,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const rsiValues = rsi(closes, 14);
      const signals = [];
      for (let i = 1; i < candles.length; i++) {
        if (rsiValues[i] === null) continue;
        if (rsiValues[i - 1] !== null && rsiValues[i - 1] < 30 && rsiValues[i] >= 30) {
          signals.push({ index: i, action: 'BUY', price: closes[i], reason: `RSI ${rsiValues[i].toFixed(1)} 과매도 반전` });
        }
        if (rsiValues[i - 1] !== null && rsiValues[i - 1] > 70 && rsiValues[i] <= 70) {
          signals.push({ index: i, action: 'SELL', price: closes[i], reason: `RSI ${rsiValues[i].toFixed(1)} 과매수 반전` });
        }
      }
      return signals;
    },
  },

  // 2. EMA 크로스: EMA9 > EMA21 골든크로스 롱, 데드크로스 숏
  ema_cross: {
    name: 'EMA Cross',
    description: 'EMA9/EMA21 골든크로스 롱, 데드크로스 숏',
    slPct: 0.015,
    tpPct: 0.03,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const ema9 = ema(closes, 9);
      const ema21 = ema(closes, 21);
      const signals = [];
      for (let i = 22; i < candles.length; i++) {
        if (ema9[i - 1] <= ema21[i - 1] && ema9[i] > ema21[i]) {
          signals.push({ index: i, action: 'BUY', price: closes[i], reason: 'EMA9 > EMA21 골든크로스' });
        }
        if (ema9[i - 1] >= ema21[i - 1] && ema9[i] < ema21[i]) {
          signals.push({ index: i, action: 'SELL', price: closes[i], reason: 'EMA9 < EMA21 데드크로스' });
        }
      }
      return signals;
    },
  },

  // 3. 볼린저 밴드 반등: 하단 터치 롱, 상단 터치 숏
  bb_bounce: {
    name: 'Bollinger Band Bounce',
    description: '볼린저 하단 터치 롱, 상단 터치 숏',
    slPct: 0.02,
    tpPct: 0.03,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const lows = candles.map(c => c.l);
      const highs = candles.map(c => c.h);
      const bb = bollingerBands(closes, 20, 2);
      const signals = [];
      for (let i = 1; i < candles.length; i++) {
        if (bb.lower[i] === null) continue;
        if (lows[i] <= bb.lower[i] && closes[i] > bb.lower[i]) {
          signals.push({ index: i, action: 'BUY', price: closes[i], reason: 'BB 하단 반등' });
        }
        if (highs[i] >= bb.upper[i] && closes[i] < bb.upper[i]) {
          signals.push({ index: i, action: 'SELL', price: closes[i], reason: 'BB 상단 반등' });
        }
      }
      return signals;
    },
  },

  // 4. MACD 시그널 크로스
  macd_signal: {
    name: 'MACD Signal Cross',
    description: 'MACD 시그널 라인 크로스',
    slPct: 0.02,
    tpPct: 0.04,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const { macdLine, signalLine, histogram } = macdIndicator(closes);
      const signals = [];
      for (let i = 27; i < candles.length; i++) {
        if (macdLine[i - 1] <= signalLine[i - 1] && macdLine[i] > signalLine[i]) {
          signals.push({ index: i, action: 'BUY', price: closes[i], reason: `MACD 골든크로스 (hist ${histogram[i].toFixed(2)})` });
        }
        if (macdLine[i - 1] >= signalLine[i - 1] && macdLine[i] < signalLine[i]) {
          signals.push({ index: i, action: 'SELL', price: closes[i], reason: `MACD 데드크로스 (hist ${histogram[i].toFixed(2)})` });
        }
      }
      return signals;
    },
  },

  // 5. 복합 전략: RSI + EMA + MACD 모두 같은 방향
  confluence: {
    name: 'Confluence (2/3 합류)',
    description: 'RSI + EMA + MACD 중 2개 이상 합류 시 진입 (기존 3/3에서 완화)',
    slPct: 0.02,
    tpPct: 0.035,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const rsiValues = rsi(closes, 14);
      const ema9 = ema(closes, 9);
      const ema21 = ema(closes, 21);
      const { histogram } = macdIndicator(closes);
      const signals = [];
      for (let i = 27; i < candles.length; i++) {
        if (rsiValues[i] === null) continue;

        // 각 지표 방향 투표 (추세추종 통일: RSI>50=상승 모멘텀, <50=하락 모멘텀)
        let bullVotes = 0, bearVotes = 0;

        if (rsiValues[i] > 50) bullVotes++; else if (rsiValues[i] < 50) bearVotes++;
        if (ema9[i] > ema21[i]) bullVotes++; else if (ema9[i] < ema21[i]) bearVotes++;
        if (histogram[i] > 0 && histogram[i] > (histogram[i - 1] || 0)) bullVotes++;
        else if (histogram[i] < 0 && histogram[i] < (histogram[i - 1] || 0)) bearVotes++;

        // 2/3 합류 (기존: 3/3 필요 → 시그널 0건)
        // 중복 방지: 이전 봉에서 같은 시그널이면 스킵
        if (bullVotes >= 2 && bearVotes === 0) {
          const lastSig = signals.length > 0 ? signals[signals.length - 1] : null;
          if (!lastSig || lastSig.action !== 'BUY' || lastSig.index < i - 5) {
            signals.push({ index: i, action: 'BUY', price: closes[i], reason: `합류 롱 ${bullVotes}/3 (RSI ${rsiValues[i].toFixed(0)}, EMA ${ema9[i] > ema21[i] ? '+' : '-'}, MACD ${histogram[i] > 0 ? '+' : '-'})` });
          }
        }
        if (bearVotes >= 2 && bullVotes === 0) {
          const lastSig = signals.length > 0 ? signals[signals.length - 1] : null;
          if (!lastSig || lastSig.action !== 'SELL' || lastSig.index < i - 5) {
            signals.push({ index: i, action: 'SELL', price: closes[i], reason: `합류 숏 ${bearVotes}/3 (RSI ${rsiValues[i].toFixed(0)}, EMA ${ema9[i] < ema21[i] ? '-' : '+'}, MACD ${histogram[i] < 0 ? '-' : '+'})` });
          }
        }
      }
      return signals;
    },
  },

  // 6. Breakout: 20봉 고점 돌파 롱, 저점 이탈 숏
  breakout: {
    name: 'Breakout (20-bar)',
    description: '20봉 고점 돌파 롱, 저점 이탈 숏. SL: 돌파 전 레벨, TP: ATR 3배',
    // slPct/tpPct는 동적으로 결정되므로 기본값은 폴백용
    slPct: 0.02,
    tpPct: 0.06,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const highs = candles.map(c => c.h);
      const lows = candles.map(c => c.l);
      const atrValues = atr(candles, 14);
      const signals = [];
      const lookback = 20;

      for (let i = lookback + 1; i < candles.length; i++) {
        if (atrValues[i] === null) continue;

        // 20봉 고점/저점 계산
        let highest = -Infinity, lowest = Infinity;
        for (let j = i - lookback; j < i; j++) {
          if (highs[j] > highest) highest = highs[j];
          if (lows[j] < lowest) lowest = lows[j];
        }

        const curATR = atrValues[i];

        // 고점 돌파 롱 (다음 봉 open으로 슬리피지 반영)
        if (closes[i] > highest && closes[i - 1] <= highest && i + 1 < closes.length) {
          const entryPrice = candles[i + 1]?.o || closes[i];
          const dynamicSl = (entryPrice - highest) / entryPrice + 0.002;
          const dynamicTp = (curATR * 3) / entryPrice;
          signals.push({
            index: i + 1, action: 'BUY', price: entryPrice,
            reason: `20봉 고점 돌파 (${highest.toFixed(1)} → ${closes[i].toFixed(1)}, ATR ${curATR.toFixed(1)})`,
            dynamicSl: Math.max(dynamicSl, 0.005),
            dynamicTp: Math.max(dynamicTp, 0.01),
          });
        }

        // 저점 이탈 숏 (다음 봉 open으로 슬리피지 반영)
        if (closes[i] < lowest && closes[i - 1] >= lowest && i + 1 < closes.length) {
          const entryPrice = candles[i + 1]?.o || closes[i];
          const dynamicSl = (lowest - entryPrice) / entryPrice + 0.002;
          const dynamicTp = (curATR * 3) / entryPrice;
          signals.push({
            index: i + 1, action: 'SELL', price: entryPrice,
            reason: `20봉 저점 이탈 (${lowest.toFixed(1)} → ${closes[i].toFixed(1)}, ATR ${curATR.toFixed(1)})`,
            dynamicSl: Math.max(dynamicSl, 0.005),
            dynamicTp: Math.max(dynamicTp, 0.01),
          });
        }
      }
      return signals;
    },
  },

  // 7. Mean Reversion: SMA20에서 2시그마 이상 벗어나면 반대 진입
  mean_reversion: {
    name: 'Mean Reversion (2σ)',
    description: 'SMA20에서 2σ 이상 벗어나면 반대 진입. SL: 3σ, TP: SMA20 복귀',
    slPct: 0.03,
    tpPct: 0.02,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const sma20 = sma(closes, 20);
      const std20 = stdDev(closes, 20, sma20);
      const signals = [];

      for (let i = 20; i < candles.length; i++) {
        if (sma20[i] === null || std20[i] === null || std20[i] === 0) continue;

        const zScore = (closes[i] - sma20[i]) / std20[i];
        const prevZ = i > 20 && sma20[i - 1] !== null && std20[i - 1] !== null && std20[i - 1] !== 0
          ? (closes[i - 1] - sma20[i - 1]) / std20[i - 1] : 0;

        // 가격이 SMA20 아래 2σ 이상 → 롱 (mean reversion)
        if (zScore <= -2 && prevZ > -2) {
          const dynamicSl = (std20[i] * 3) / closes[i]; // SL at 3σ
          const dynamicTp = Math.abs(closes[i] - sma20[i]) / closes[i]; // TP at SMA20
          signals.push({
            index: i, action: 'BUY', price: closes[i],
            reason: `Mean Rev 롱 (z=${zScore.toFixed(2)}, SMA20 ${sma20[i].toFixed(1)})`,
            dynamicSl: Math.max(dynamicSl, 0.005),
            dynamicTp: Math.max(dynamicTp, 0.005),
          });
        }

        // 가격이 SMA20 위 2σ 이상 → 숏
        if (zScore >= 2 && prevZ < 2) {
          const dynamicSl = (std20[i] * 3) / closes[i];
          const dynamicTp = Math.abs(closes[i] - sma20[i]) / closes[i];
          signals.push({
            index: i, action: 'SELL', price: closes[i],
            reason: `Mean Rev 숏 (z=${zScore.toFixed(2)}, SMA20 ${sma20[i].toFixed(1)})`,
            dynamicSl: Math.max(dynamicSl, 0.005),
            dynamicTp: Math.max(dynamicTp, 0.005),
          });
        }
      }
      return signals;
    },
  },

  // 8. Momentum: ROC(12) > 5% + ADX(14) > 25 → 추세 방향 진입
  momentum: {
    name: 'Momentum (ROC+ADX)',
    description: 'ROC(12)>5% + ADX(14)>25 → 추세 방향 진입. SL: 2%, TP: ROC 절반',
    slPct: 0.02,
    tpPct: 0.025,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const rocValues = roc(closes, 12);
      const adxValues = adx(candles, 14);
      const signals = [];

      for (let i = 30; i < candles.length; i++) {
        if (rocValues[i] === null || adxValues[i] === null) continue;

        const curROC = rocValues[i];
        const prevROC = rocValues[i - 1];
        const curADX = adxValues[i];

        // 강한 상승 모멘텀 + 추세 강도 확인
        if (curROC > 5 && curADX > 25 && (prevROC === null || prevROC <= 5)) {
          const dynamicTp = Math.abs(curROC / 2) / 100; // ROC 절반만큼 TP
          signals.push({
            index: i, action: 'BUY', price: closes[i],
            reason: `모멘텀 롱 (ROC ${curROC.toFixed(1)}%, ADX ${curADX.toFixed(1)})`,
            dynamicTp: Math.max(dynamicTp, 0.01),
          });
        }

        // 강한 하락 모멘텀
        if (curROC < -5 && curADX > 25 && (prevROC === null || prevROC >= -5)) {
          const dynamicTp = Math.abs(curROC / 2) / 100;
          signals.push({
            index: i, action: 'SELL', price: closes[i],
            reason: `모멘텀 숏 (ROC ${curROC.toFixed(1)}%, ADX ${curADX.toFixed(1)})`,
            dynamicTp: Math.max(dynamicTp, 0.01),
          });
        }
      }
      return signals;
    },
  },

  // 9. VWAP Cross: VWAP 위/아래 크로스
  vwap_cross: {
    name: 'VWAP Cross',
    description: 'VWAP 위/아래 크로스. SL: VWAP에서 1ATR, TP: 2ATR',
    slPct: 0.015,
    tpPct: 0.03,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const vwapValues = vwap(candles);
      const atrValues = atr(candles, 14);
      const signals = [];

      for (let i = 15; i < candles.length; i++) {
        if (vwapValues[i] === null || vwapValues[i - 1] === null || atrValues[i] === null) continue;

        const curATR = atrValues[i];
        const price = closes[i];
        const prevPrice = closes[i - 1];
        const curVWAP = vwapValues[i];
        const prevVWAP = vwapValues[i - 1];

        // 가격이 VWAP 위로 크로스 → 롱
        if (prevPrice <= prevVWAP && price > curVWAP) {
          const dynamicSl = curATR / price; // 1 ATR
          const dynamicTp = (curATR * 2) / price; // 2 ATR
          signals.push({
            index: i, action: 'BUY', price: price,
            reason: `VWAP 상향 크로스 (VWAP ${curVWAP.toFixed(1)}, ATR ${curATR.toFixed(1)})`,
            dynamicSl: Math.max(dynamicSl, 0.005),
            dynamicTp: Math.max(dynamicTp, 0.01),
          });
        }

        // 가격이 VWAP 아래로 크로스 → 숏
        if (prevPrice >= prevVWAP && price < curVWAP) {
          const dynamicSl = curATR / price;
          const dynamicTp = (curATR * 2) / price;
          signals.push({
            index: i, action: 'SELL', price: price,
            reason: `VWAP 하향 크로스 (VWAP ${curVWAP.toFixed(1)}, ATR ${curATR.toFixed(1)})`,
            dynamicSl: Math.max(dynamicSl, 0.005),
            dynamicTp: Math.max(dynamicTp, 0.01),
          });
        }
      }
      return signals;
    },
  },

  // 10. Pivot Points: 일간 피봇 S1/R1 레벨에서 반등
  pivot_points: {
    name: 'Pivot Points (S1/R1)',
    description: '일간 피봇 S1에서 반등 롱, R1에서 반등 숏',
    slPct: 0.015,
    tpPct: 0.025,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const lows = candles.map(c => c.l);
      const highs = candles.map(c => c.h);
      const pivots = pivotPoints(candles);
      const signals = [];

      for (let i = 25; i < candles.length; i++) {
        if (!pivots[i]) continue;

        const { P, S1, R1, S2, R2 } = pivots[i];
        const price = closes[i];
        const low = lows[i];
        const high = highs[i];
        const tolerance = Math.abs(R1 - S1) * 0.02; // 2% tolerance of range

        // S1 터치 반등 → 롱
        if (low <= S1 + tolerance && price > S1 && price < P) {
          const dynamicSl = (S1 - S2) / price; // SL at S2
          const dynamicTp = (P - price) / price; // TP at Pivot
          signals.push({
            index: i, action: 'BUY', price: price,
            reason: `Pivot S1 반등 (S1 ${S1.toFixed(1)}, P ${P.toFixed(1)})`,
            dynamicSl: Math.max(dynamicSl, 0.005),
            dynamicTp: Math.max(dynamicTp, 0.005),
          });
        }

        // R1 터치 반등 → 숏
        if (high >= R1 - tolerance && price < R1 && price > P) {
          const dynamicSl = (R2 - R1) / price;
          const dynamicTp = (price - P) / price;
          signals.push({
            index: i, action: 'SELL', price: price,
            reason: `Pivot R1 반등 (R1 ${R1.toFixed(1)}, P ${P.toFixed(1)})`,
            dynamicSl: Math.max(dynamicSl, 0.005),
            dynamicTp: Math.max(dynamicTp, 0.005),
          });
        }
      }
      return signals;
    },
  },

  // 11. Funding Extreme: 펀딩레이트 극단값에서 역방향 진입 (가격 프록시)
  funding_extreme: {
    name: 'Funding Extreme',
    description: '5연속 양/음봉 + 5%+ 변동 시 과열 추정 → 역방향 진입. SL 3%, TP 6%',
    slPct: 0.03,
    tpPct: 0.06,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const signals = [];
      const consecutive = 5;

      for (let i = consecutive; i < candles.length; i++) {
        // 연속 양봉/음봉 체크
        let allBull = true, allBear = true;
        for (let j = i - consecutive + 1; j <= i; j++) {
          if (candles[j].c <= candles[j].o) allBull = false;
          if (candles[j].c >= candles[j].o) allBear = false;
        }

        // 구간 변동률 계산
        const startPrice = closes[i - consecutive];
        const endPrice = closes[i];
        const changePct = ((endPrice - startPrice) / startPrice) * 100;

        // 5연속 양봉 + 5%+ 상승 → 롱 과열 → SELL (역방향)
        if (allBull && changePct >= 5) {
          // 이전 봉이 이미 시그널이었는지 중복 방지
          const lastSig = signals.length > 0 ? signals[signals.length - 1] : null;
          if (!lastSig || lastSig.index < i - 2) {
            signals.push({
              index: i, action: 'SELL', price: endPrice,
              reason: `펀딩과열 숏 (${consecutive}연속 양봉, +${changePct.toFixed(1)}%)`,
            });
          }
        }

        // 5연속 음봉 + 5%+ 하락 → 숏 과열 → BUY (역방향)
        if (allBear && changePct <= -5) {
          const lastSig = signals.length > 0 ? signals[signals.length - 1] : null;
          if (!lastSig || lastSig.index < i - 2) {
            signals.push({
              index: i, action: 'BUY', price: endPrice,
              reason: `패닉반전 롱 (${consecutive}연속 음봉, ${changePct.toFixed(1)}%)`,
            });
          }
        }
      }
      return signals;
    },
  },

  // 12. BTC Lead: BTC 선행 움직임 후 알트코인 추종 (btcCandles 필요)
  btc_lead: {
    name: 'BTC Lead (Alt Follow)',
    description: 'BTC 1-2봉 전 2%+ 움직임 → 알트 추종 진입. SL 2%, TP 4%',
    slPct: 0.02,
    tpPct: 0.04,
    needsBtcCandles: true,
    generate(candles, btcCandles) {
      const closes = candles.map(c => c.c);
      const signals = [];

      if (!btcCandles || btcCandles.length < 3) return signals;

      // BTC 캔들과 알트 캔들의 타임스탬프 매핑
      const btcMap = {};
      for (const bc of btcCandles) {
        btcMap[bc.t] = bc;
      }

      for (let i = 2; i < candles.length; i++) {
        const curCandle = candles[i];
        const prevCandle1 = candles[i - 1];
        const prevCandle2 = candles[i - 2];

        // 매칭되는 BTC 캔들 찾기
        const btcPrev1 = btcMap[prevCandle1.t];
        const btcPrev2 = btcMap[prevCandle2.t];

        if (!btcPrev1 || !btcPrev2) continue;

        // BTC 1-2봉 전 변동률
        const btcChange1 = ((btcPrev1.c - btcPrev1.o) / btcPrev1.o) * 100;
        const btcChange2 = ((btcPrev2.c - btcPrev2.o) / btcPrev2.o) * 100;

        // 알트 현재 봉의 위치 (아직 BTC를 따라가지 않았는지 확인)
        const altChange = ((curCandle.o - prevCandle1.c) / prevCandle1.c) * 100;

        // BTC가 1-2봉 전에 2%+ 상승 + 알트가 아직 크게 안 움직임
        if ((btcChange1 >= 2 || btcChange2 >= 2) && Math.abs(altChange) < 1) {
          const bestBtcChange = Math.max(btcChange1, btcChange2);
          signals.push({
            index: i, action: 'BUY', price: closes[i],
            reason: `BTC선행 롱 (BTC +${bestBtcChange.toFixed(1)}%, 알트 지연)`,
          });
        }

        // BTC가 1-2봉 전에 2%+ 하락 + 알트가 아직 크게 안 움직임
        if ((btcChange1 <= -2 || btcChange2 <= -2) && Math.abs(altChange) < 1) {
          const bestBtcChange = Math.min(btcChange1, btcChange2);
          signals.push({
            index: i, action: 'SELL', price: closes[i],
            reason: `BTC선행 숏 (BTC ${bestBtcChange.toFixed(1)}%, 알트 지연)`,
          });
        }
      }
      return signals;
    },
  },

  // 13. Volatility Breakout: ATR 수축 후 폭발 패턴
  volatility_breakout: {
    name: 'Volatility Breakout',
    description: 'ATR 수축(평균 50% 이하) 후 1%+ 방향 폭발 시 진입. SL: 수축 범위, TP: ATR 2배',
    slPct: 0.015,
    tpPct: 0.03,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const atrValues = atr(candles, 14);
      const signals = [];
      const lookback = 20;

      for (let i = lookback + 14; i < candles.length; i++) {
        if (atrValues[i] === null) continue;

        // 최근 20봉 ATR 평균
        let atrSum = 0, atrCount = 0;
        for (let j = i - lookback; j < i; j++) {
          if (atrValues[j] !== null) { atrSum += atrValues[j]; atrCount++; }
        }
        if (atrCount === 0) continue;
        const avgATR = atrSum / atrCount;

        const curATR = atrValues[i];
        const prevATR = atrValues[i - 1];

        // ATR이 평균의 50% 이하로 수축 상태였다가
        if (prevATR !== null && prevATR <= avgATR * 0.5) {
          // 현재 봉에서 1% 이상 움직임 발생
          const moveUp = (candles[i].c - candles[i].o) / candles[i].o;
          const moveDown = (candles[i].o - candles[i].c) / candles[i].o;

          if (moveUp >= 0.01) {
            // 수축 범위의 반대편을 SL로
            const squeezeLow = candles[i - 1].l;
            const dynamicSl = Math.max((closes[i] - squeezeLow) / closes[i], 0.005);
            const dynamicTp = Math.max((curATR * 2) / closes[i], 0.01);
            signals.push({
              index: i, action: 'BUY', price: closes[i],
              reason: `변동성 폭발 롱 (ATR ${curATR.toFixed(1)} 수축→폭발, +${(moveUp * 100).toFixed(1)}%)`,
              dynamicSl,
              dynamicTp,
            });
          }

          if (moveDown >= 0.01) {
            const squeezeHigh = candles[i - 1].h;
            const dynamicSl = Math.max((squeezeHigh - closes[i]) / closes[i], 0.005);
            const dynamicTp = Math.max((curATR * 2) / closes[i], 0.01);
            signals.push({
              index: i, action: 'SELL', price: closes[i],
              reason: `변동성 폭발 숏 (ATR ${curATR.toFixed(1)} 수축→폭발, -${(moveDown * 100).toFixed(1)}%)`,
              dynamicSl,
              dynamicTp,
            });
          }
        }
      }
      return signals;
    },
  },

  // 14. Squeeze: 볼린저밴드 폭 역대 최소 → 방향 폭발 대기
  // ── 15. Funding Arbitrage: 펀딩레이트 과열 역방향 진입 ──
  funding_arb: {
    name: 'Funding Rate Arbitrage',
    description: '연속 양/음봉 + 급등/급락으로 펀딩 과열 추정 → 역방향 진입. 8시간 보유. SL 3%, TP 펀딩수익+1.5%',
    slPct: 0.03,
    tpPct: 0.025,
    maxLeverage: 5, // 펀딩 아비트라지는 낮은 레버리지가 적합
    generate(candles) {
      const closes = candles.map(c => c.c);
      const signals = [];

      for (let i = 8; i < candles.length; i++) {
        // 최근 8봉 (≈8시간) 분석
        let bullCount = 0, bearCount = 0;
        for (let j = i - 7; j <= i; j++) {
          if (candles[j].c > candles[j].o) bullCount++;
          else if (candles[j].c < candles[j].o) bearCount++;
        }

        const changePct = ((closes[i] - closes[i - 8]) / closes[i - 8]) * 100;

        // 6+/8 양봉 + 2%+ 상승 → 롱 과열 → 숏 진입 (펀딩 수익)
        if (bullCount >= 6 && changePct >= 2) {
          const lastSig = signals.length > 0 ? signals[signals.length - 1] : null;
          if (!lastSig || lastSig.index < i - 8) {
            signals.push({
              index: i, action: 'SELL', price: closes[i],
              reason: `펀딩숏 (${bullCount}/8 양봉, +${changePct.toFixed(1)}%, 펀딩수익 추정)`,
            });
          }
        }

        // 6+/8 음봉 + 2%+ 하락 → 숏 과열 → 롱 진입
        if (bearCount >= 6 && changePct <= -2) {
          const lastSig = signals.length > 0 ? signals[signals.length - 1] : null;
          if (!lastSig || lastSig.index < i - 8) {
            signals.push({
              index: i, action: 'BUY', price: closes[i],
              reason: `펀딩롱 (${bearCount}/8 음봉, ${changePct.toFixed(1)}%, 펀딩수익 추정)`,
            });
          }
        }
      }
      return signals;
    },
  },

  // ── 16. Volatility Regime: ATR 기반 변동성 레짐 자동 전환 ──
  vol_regime: {
    name: 'Volatility Regime',
    description: 'ATR 급등(2x) → 추세추종, ATR 수축(0.5x) → 평균회귀. 자동 전환',
    slPct: 0.02,
    tpPct: 0.04,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const atrValues = atr(candles, 14);
      const ema9 = ema(closes, 9);
      const ema21 = ema(closes, 21);
      const sma20 = sma(closes, 20);
      const signals = [];
      const lookback = 50;

      for (let i = lookback; i < candles.length; i++) {
        if (atrValues[i] === null) continue;

        // ATR 평균 계산
        let atrSum = 0, atrCount = 0;
        for (let j = i - lookback; j < i; j++) {
          if (atrValues[j] !== null) { atrSum += atrValues[j]; atrCount++; }
        }
        if (atrCount === 0) continue;
        const avgATR = atrSum / atrCount;
        const curATR = atrValues[i];
        const atrRatio = curATR / avgATR;

        // 고변동성 레짐 (ATR > 2x 평균) → 추세추종
        if (atrRatio >= 2.0) {
          // EMA 정배열이면 롱, 역배열이면 숏
          if (ema9[i] > ema21[i] && ema9[i - 1] <= ema21[i - 1]) {
            signals.push({
              index: i, action: 'BUY', price: closes[i],
              reason: `고변동성 추세롱 (ATR ${atrRatio.toFixed(1)}x, EMA크로스)`,
              dynamicSl: (curATR * 1.5) / closes[i],
              dynamicTp: (curATR * 3) / closes[i],
            });
          }
          if (ema9[i] < ema21[i] && ema9[i - 1] >= ema21[i - 1]) {
            signals.push({
              index: i, action: 'SELL', price: closes[i],
              reason: `고변동성 추세숏 (ATR ${atrRatio.toFixed(1)}x, EMA크로스)`,
              dynamicSl: (curATR * 1.5) / closes[i],
              dynamicTp: (curATR * 3) / closes[i],
            });
          }
        }
        // 저변동성 레짐 (ATR < 0.5x 평균) → 평균회귀
        else if (atrRatio <= 0.5 && sma20[i] !== null) {
          const zScore = sma20[i] !== 0 ? (closes[i] - sma20[i]) / sma20[i] * 100 : 0;

          // SMA20 1.5%+ 이탈 → 평균회귀
          if (zScore <= -1.5) {
            signals.push({
              index: i, action: 'BUY', price: closes[i],
              reason: `저변동성 회귀롱 (ATR ${atrRatio.toFixed(1)}x, SMA20 ${zScore.toFixed(1)}%)`,
              dynamicSl: (curATR * 2) / closes[i],
              dynamicTp: Math.abs(zScore) / 100,
            });
          }
          if (zScore >= 1.5) {
            signals.push({
              index: i, action: 'SELL', price: closes[i],
              reason: `저변동성 회귀숏 (ATR ${atrRatio.toFixed(1)}x, SMA20 +${zScore.toFixed(1)}%)`,
              dynamicSl: (curATR * 2) / closes[i],
              dynamicTp: Math.abs(zScore) / 100,
            });
          }
        }
      }
      return signals;
    },
  },

  // ── 17. Cross Asset Momentum: 멀티코인 모멘텀 순위 ──
  cross_momentum: {
    name: 'Cross Momentum',
    description: '자체 7일 ROC 상위 → 롱, 하위 → 숏. 모멘텀 지속 활용',
    slPct: 0.025,
    tpPct: 0.05,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const signals = [];
      const lookback = 7 * 24; // 7일 (1h 캔들 기준)

      for (let i = lookback; i < candles.length; i++) {
        // 7일 수익률 계산
        const startIdx = Math.max(0, i - lookback);
        const roc7d = ((closes[i] - closes[startIdx]) / closes[startIdx]) * 100;

        // 이전 봉 ROC
        const prevStartIdx = Math.max(0, i - 1 - lookback);
        const prevRoc = ((closes[i - 1] - closes[prevStartIdx]) / closes[prevStartIdx]) * 100;

        // 모멘텀 가속: ROC가 5%+ 이고 증가 중이면 롱
        if (roc7d >= 5 && roc7d > prevRoc && prevRoc < 5) {
          signals.push({
            index: i, action: 'BUY', price: closes[i],
            reason: `모멘텀 상위 롱 (7일 ROC ${roc7d.toFixed(1)}%, 가속 중)`,
          });
        }

        // 모멘텀 하락: ROC가 -5% 이하이고 하락 가속
        if (roc7d <= -5 && roc7d < prevRoc && prevRoc > -5) {
          signals.push({
            index: i, action: 'SELL', price: closes[i],
            reason: `모멘텀 하위 숏 (7일 ROC ${roc7d.toFixed(1)}%, 하락 가속)`,
          });
        }
      }
      return signals;
    },
  },

  // 18. Crash Bounce (급락 반등 P1-P4)
  crash_bounce: {
    name: 'Crash Bounce (P1-P4)',
    description: '24h -8%+ 급락 후 3h/6h 반등 감지 → LONG. P1(약반등) P2(V자) P3(더블바텀) P4(전체조건)',
    slPct: 0.03,
    tpPct: 0.045,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const lows = candles.map(c => c.l);
      const highs = candles.map(c => c.h);
      const volumes = candles.map(c => c.v);
      const atrValues = atr(candles, 14);
      const rsiValues = rsi(closes, 14);
      const signals = [];

      for (let i = 48; i < candles.length; i++) {
        if (atrValues[i] === null || rsiValues[i] === null) continue;

        // 24h(24봉) 최고점에서 현재까지 낙폭
        let peak24h = -Infinity;
        for (let j = i - 24; j < i; j++) { if (highs[j] > peak24h) peak24h = highs[j]; }
        const drop24h = ((closes[i] - peak24h) / peak24h) * 100;
        if (drop24h > -8) continue; // 최소 8% 하락 필요

        // 3h 반등률
        const low3h = Math.min(lows[i], lows[i-1] || Infinity, lows[i-2] || Infinity);
        const bounce3h = low3h > 0 ? ((closes[i] - low3h) / low3h) * 100 : 0;

        // 6h 반등률
        let low6h = Infinity;
        for (let j = Math.max(0, i - 6); j <= i; j++) { if (lows[j] < low6h) low6h = lows[j]; }
        const bounce6h = low6h > 0 ? ((closes[i] - low6h) / low6h) * 100 : 0;

        // 거래량 급증 (최근 5봉 vs 20봉 평균)
        const vol5 = volumes.slice(i - 4, i + 1).reduce((a, b) => a + b, 0) / 5;
        const vol20 = volumes.slice(Math.max(0, i - 19), i + 1).reduce((a, b) => a + b, 0) / 20;
        const volSpike = vol20 > 0 ? vol5 / vol20 : 1;

        // RSI 과매도
        const curRsi = rsiValues[i];

        // 더블바텀 감지 (48봉 내)
        let hasDoubleBottom = false;
        const tolerance = atrValues[i] * 0.5;
        for (let j = i - 48; j < i - 6; j++) {
          if (j < 0) continue;
          if (Math.abs(lows[j] - low6h) < tolerance) { hasDoubleBottom = true; break; }
        }

        // P1: 기본 급락 반등 (24h -8% + 3h 반등 1%+)
        const p1 = drop24h <= -8 && bounce3h >= 1;
        // P2: V자 반등 (24h -10% + 6h 반등 2%+ + 거래량 급증)
        const p2 = drop24h <= -10 && bounce6h >= 2 && volSpike >= 1.5;
        // P3: 더블바텀 (24h -8% + 더블바텀 + RSI<35)
        const p3 = drop24h <= -8 && hasDoubleBottom && curRsi < 35;
        // P4: 전체 조건 (P1+P2+P3 모두 충족)
        const p4 = p1 && p2 && p3;

        // 중복 방지: 최근 12봉 내 시그널 있으면 스킵
        const lastSig = signals.length > 0 ? signals[signals.length - 1] : null;
        if (lastSig && lastSig.index > i - 12) continue;

        let pattern = null;
        if (p4) pattern = 'P4';
        else if (p3) pattern = 'P3';
        else if (p2) pattern = 'P2';
        else if (p1) pattern = 'P1';

        if (!pattern) continue;

        // P등급별 R:R 조정
        const rrMultiplier = { P1: 1.0, P2: 1.2, P3: 1.3, P4: 1.5 }[pattern];
        const dynamicSl = (atrValues[i] * 1.5) / closes[i];
        const dynamicTp = (atrValues[i] * 3.0 * rrMultiplier) / closes[i];

        signals.push({
          index: i, action: 'BUY', price: closes[i],
          reason: `급락반등 ${pattern} (${drop24h.toFixed(1)}% 낙폭, ${bounce6h.toFixed(1)}% 반등, RSI ${curRsi.toFixed(0)}, vol ${volSpike.toFixed(1)}x)`,
          dynamicSl: Math.max(dynamicSl, 0.01),
          dynamicTp: Math.max(dynamicTp, 0.015),
          pattern,
        });
      }
      return signals;
    },
  },

  // 19. Grid Trading: 가격 범위를 그리드로 나눠 자동 매매
  grid_trading: {
    name: 'Grid Trading',
    description: 'BB 범위를 5단계 그리드로 나눠 하단 매수/상단 매도. 횡보장 최적화',
    slPct: 0.025,
    tpPct: 0.015, // 그리드 간격만큼 TP
    generate(candles) {
      const closes = candles.map(c => c.c);
      const bb = bollingerBands(closes, 20, 2);
      const adxValues = adx(candles, 14);
      const signals = [];
      const GRID_LEVELS = 5;

      for (let i = 30; i < candles.length; i++) {
        if (bb.upper[i] === null || bb.lower[i] === null || adxValues[i] === null) continue;

        // 횡보장에서만 그리드 (ADX < 25)
        if (adxValues[i] > 25) continue;

        const range = bb.upper[i] - bb.lower[i];
        const gridStep = range / GRID_LEVELS;
        const price = closes[i];
        const prevPrice = closes[i - 1];

        // 그리드 레벨별 진입
        for (let g = 0; g < GRID_LEVELS; g++) {
          const gridPrice = bb.lower[i] + gridStep * g;
          const gridPriceNext = bb.lower[i] + gridStep * (g + 1);

          // 가격이 그리드 레벨을 하향 크로스 → 매수
          if (g <= 1 && prevPrice > gridPrice && price <= gridPrice) {
            const dynamicTp = (gridStep * 1.5) / price; // TP를 그리드 1.5배 (기존: 1배)
            const dynamicSl = gridStep / price;           // SL을 그리드 1배 (기존: 1.5배) → R:R 1.5:1
            const lastSig = signals.length > 0 ? signals[signals.length - 1] : null;
            if (lastSig && lastSig.index > i - 5) continue; // 간격 3→5봉
            signals.push({
              index: i, action: 'BUY', price: price,
              reason: `그리드 매수 L${g + 1} (BB ${((price - bb.lower[i]) / range * 100).toFixed(0)}%)`,
              dynamicSl: Math.max(dynamicSl, 0.005),
              dynamicTp: Math.max(dynamicTp, 0.008),
            });
            break;
          }

          // 가격이 그리드 레벨을 상향 크로스 → 매도
          if (g >= 3 && prevPrice < gridPriceNext && price >= gridPriceNext) {
            const dynamicTp = (gridStep * 1.5) / price;
            const dynamicSl = gridStep / price;
            const lastSig = signals.length > 0 ? signals[signals.length - 1] : null;
            if (lastSig && lastSig.index > i - 5) continue;
            signals.push({
              index: i, action: 'SELL', price: price,
              reason: `그리드 매도 L${g + 1} (BB ${((price - bb.lower[i]) / range * 100).toFixed(0)}%)`,
              dynamicSl: Math.max(dynamicSl, 0.005),
              dynamicTp: Math.max(dynamicTp, 0.008),
            });
            break;
          }
        }
      }
      return signals;
    },
  },

  squeeze: {
    name: 'BB Squeeze',
    description: 'BB 폭이 50봉 최소 → 스퀴즈 감지, 돌파 방향 진입. SL 1.5%, TP: BB 반대편',
    slPct: 0.015,
    tpPct: 0.03,
    generate(candles) {
      const closes = candles.map(c => c.c);
      const bb = bollingerBands(closes, 20, 2);
      const signals = [];
      const squeezeLookback = 50;

      for (let i = squeezeLookback; i < candles.length; i++) {
        if (bb.upper[i] === null || bb.lower[i] === null) continue;
        if (bb.upper[i - 1] === null || bb.lower[i - 1] === null) continue;

        const curWidth = bb.upper[i] / bb.lower[i] - 1; // 상대적 BB 폭
        const prevWidth = bb.upper[i - 1] / bb.lower[i - 1] - 1;

        // 최근 50봉 중 BB 폭 최소값 확인
        let minWidth = Infinity;
        for (let j = i - squeezeLookback; j < i; j++) {
          if (bb.upper[j] === null || bb.lower[j] === null) continue;
          const w = bb.upper[j] / bb.lower[j] - 1;
          if (w < minWidth) minWidth = w;
        }

        // 직전 봉이 50봉 최소 BB 폭 (스퀴즈 상태)
        const wasSqueezing = prevWidth <= minWidth * 1.05; // 5% 여유

        if (wasSqueezing) {
          const price = closes[i];

          // 가격이 BB 상단 돌파 → 롱
          if (price > bb.upper[i]) {
            const dynamicTp = Math.max((bb.upper[i] - bb.lower[i]) / price, 0.01);
            signals.push({
              index: i, action: 'BUY', price: price,
              reason: `스퀴즈 롱 (BB폭 ${(prevWidth * 100).toFixed(2)}% → 상단 돌파)`,
              dynamicTp,
            });
          }

          // 가격이 BB 하단 이탈 → 숏
          if (price < bb.lower[i]) {
            const dynamicTp = Math.max((bb.upper[i] - bb.lower[i]) / price, 0.01);
            signals.push({
              index: i, action: 'SELL', price: price,
              reason: `스퀴즈 숏 (BB폭 ${(prevWidth * 100).toFixed(2)}% → 하단 이탈)`,
              dynamicTp,
            });
          }
        }
      }
      return signals;
    },
  },
};

// ── 바이낸스 과거 캔들 데이터 가져오기 ──

async function fetchHistoricalCandles(symbol, interval, days) {
  const pair = symbol.toUpperCase().replace('USDT', '') + 'USDT';
  const candles = [];
  const now = Date.now();
  const startTime = now - days * 24 * 60 * 60 * 1000;

  const intervalMs = interval === '1h' ? 3600000 : interval === '4h' ? 14400000 : interval === '15m' ? 900000 : interval === '1d' ? 86400000 : 3600000;
  const totalCandles = Math.ceil((days * 24 * 3600000) / intervalMs);
  const batchSize = 1500;
  const batches = Math.ceil(totalCandles / batchSize);

  for (let b = 0; b < batches; b++) {
    const batchStart = startTime + b * batchSize * intervalMs;
    const batchEnd = Math.min(batchStart + batchSize * intervalMs, now);
    try {
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${interval}&startTime=${batchStart}&endTime=${batchEnd}&limit=${batchSize}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`Binance API ${res.status}`);
      const raw = await res.json();
      if (!Array.isArray(raw)) continue;
      for (const k of raw) {
        candles.push({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] });
      }
    } catch (e) {
      console.error(`[backtester] 캔들 요청 실패 batch ${b}: ${e.message}`);
    }
  }

  const seen = new Set();
  const unique = [];
  for (const c of candles) {
    if (!seen.has(c.t)) { seen.add(c.t); unique.push(c); }
  }
  unique.sort((a, b) => a.t - b.t);
  return unique;
}

// ── 백테스트 시뮬레이션 엔진 ──

async function backtest(symbol, strategyName, days = 90, options = {}) {
  const strat = strategies[strategyName];
  if (!strat) throw new Error(`전략 "${strategyName}" 없음. 사용 가능: ${Object.keys(strategies).join(', ')}`);

  const interval = options.interval || '1h';
  const startCapital = options.capital || 3000;
  const leverage = options.leverage || 20;
  const feePct = options.fee || 0.0004;

  console.log(`[backtester] ${symbol} ${strategyName} ${days}일 백테스트 시작 (${interval})...`);
  const candles = await fetchHistoricalCandles(symbol, interval, days);
  if (candles.length < 50) throw new Error(`캔들 데이터 부족: ${candles.length}개`);

  // btc_lead 전략: BTC 캔들도 함께 fetch
  let btcCandles = null;
  if (strat.needsBtcCandles && symbol.toUpperCase() !== 'BTC') {
    try {
      btcCandles = await fetchHistoricalCandles('BTC', interval, days);
      console.log(`[backtester] BTC 캔들 ${btcCandles.length}개 로드 (${strategyName}용)`);
    } catch (e) {
      console.error(`[backtester] BTC 캔들 로드 실패: ${e.message}`);
    }
  }

  const signals = strat.generate(candles, btcCandles);
  console.log(`[backtester] ${symbol} ${strategyName}: ${signals.length}개 시그널 생성 (캔들 ${candles.length}개)`);

  let capital = startCapital;
  let peakCapital = startCapital;
  let maxDrawdown = 0;
  const trades = [];
  let inPosition = false;
  let position = null;

  for (const sig of signals) {
    if (inPosition) continue;

    const entryPrice = sig.price;
    // 동적 SL/TP 지원: 시그널에 dynamicSl/dynamicTp가 있으면 사용
    const slPct = sig.dynamicSl || strat.slPct;
    const tpPct = sig.dynamicTp || strat.tpPct;

    let slPrice, tpPrice;
    if (sig.action === 'BUY') {
      slPrice = entryPrice * (1 - slPct);
      tpPrice = entryPrice * (1 + tpPct);
    } else {
      slPrice = entryPrice * (1 + slPct);
      tpPrice = entryPrice * (1 - tpPct);
    }

    const riskAmt = capital * 0.02;
    const slDist = Math.abs(entryPrice - slPrice);
    if (slDist === 0) continue;
    const quantity = riskAmt / slDist;
    const costBasis = quantity * entryPrice;
    const margin = costBasis / leverage;

    if (margin > capital * 0.5 || quantity <= 0) continue;

    inPosition = true;
    position = {
      action: sig.action,
      entryPrice,
      slPrice,
      tpPrice,
      quantity,
      costBasis,
      entryIndex: sig.index,
      entryTime: new Date(candles[sig.index].t).toISOString(),
      reason: sig.reason,
    };

    for (let j = sig.index + 1; j < candles.length; j++) {
      const candle = candles[j];
      let exitPrice = null;
      let closeReason = '';

      // 최대 보유시간 제한 (168시간 = 7일)
      const maxHoldHours = 168;
      const currentHoursHeld = (candle.t - candles[sig.index].t) / 3600000;

      if (sig.action === 'BUY') {
        if (candle.l <= slPrice) { exitPrice = slPrice; closeReason = 'SL'; }
        else if (candle.h >= tpPrice) { exitPrice = tpPrice; closeReason = 'TP'; }
        else if (currentHoursHeld >= maxHoldHours) { exitPrice = candle.c; closeReason = 'TIMEOUT'; }
      } else {
        if (candle.h >= slPrice) { exitPrice = slPrice; closeReason = 'SL'; }
        else if (candle.l <= tpPrice) { exitPrice = tpPrice; closeReason = 'TP'; }
        else if (currentHoursHeld >= maxHoldHours) { exitPrice = candle.c; closeReason = 'TIMEOUT'; }
      }

      if (exitPrice !== null) {
        const rawPnl = sig.action === 'BUY'
          ? (exitPrice - entryPrice) * quantity
          : (entryPrice - exitPrice) * quantity;
        const fee = costBasis * feePct * 2;
        const hoursHeld = (candles[j].t - candles[sig.index].t) / 3600000;
        // Funding fee 추정: 8시간마다 포지션 크기의 0.01% (평균 펀딩레이트)
        const fundingPeriods = Math.floor(hoursHeld / 8);
        const fundingFee = costBasis * 0.0001 * fundingPeriods; // 평균 0.01%/8h
        const netPnl = rawPnl - fee - fundingFee;
        const pnlPct = (netPnl / costBasis) * 100;

        capital += netPnl;
        if (capital > peakCapital) peakCapital = capital;
        const dd = (peakCapital - capital) / peakCapital;
        if (dd > maxDrawdown) maxDrawdown = dd;

        trades.push({
          action: sig.action,
          entryPrice,
          exitPrice,
          slPrice,
          tpPrice,
          quantity: Math.round(quantity * 10000) / 10000,
          pnl: Math.round(netPnl * 100) / 100,
          pnlPct: Math.round(pnlPct * 100) / 100,
          closeReason,
          hoursHeld: Math.round(hoursHeld * 10) / 10,
          entryTime: position.entryTime,
          exitTime: new Date(candles[j].t).toISOString(),
          reason: sig.reason,
          capitalAfter: Math.round(capital * 100) / 100,
        });

        inPosition = false;
        position = null;
        break;
      }
    }

    // 마지막까지 청산 안 됐으면 마지막 봉에서 청산
    if (inPosition && position) {
      const lastCandle = candles[candles.length - 1];
      const exitPrice = lastCandle.c;
      const rawPnl = sig.action === 'BUY'
        ? (exitPrice - entryPrice) * quantity
        : (entryPrice - exitPrice) * quantity;
      const fee = costBasis * feePct * 2;
      const netPnl = rawPnl - fee;
      const pnlPct = (netPnl / costBasis) * 100;
      const hoursHeld = (lastCandle.t - candles[sig.index].t) / 3600000;

      capital += netPnl;
      if (capital > peakCapital) peakCapital = capital;
      const dd = (peakCapital - capital) / peakCapital;
      if (dd > maxDrawdown) maxDrawdown = dd;

      trades.push({
        action: sig.action,
        entryPrice,
        exitPrice,
        slPrice,
        tpPrice,
        quantity: Math.round(quantity * 10000) / 10000,
        pnl: Math.round(netPnl * 100) / 100,
        pnlPct: Math.round(pnlPct * 100) / 100,
        closeReason: 'EXPIRE',
        hoursHeld: Math.round(hoursHeld * 10) / 10,
        entryTime: position.entryTime,
        exitTime: new Date(lastCandle.t).toISOString(),
        reason: sig.reason,
        capitalAfter: Math.round(capital * 100) / 100,
      });
      inPosition = false;
      position = null;
    }
  }

  // 결과 통계 계산
  const totalTrades = trades.length;
  const wins = trades.filter(t => t.pnl > 0).length;
  const losses = trades.filter(t => t.pnl <= 0).length;
  const winRate = totalTrades > 0 ? Math.round(wins / totalTrades * 1000) / 10 : 0;
  const totalPnl = Math.round(trades.reduce((s, t) => s + t.pnl, 0) * 100) / 100;

  const winTrades = trades.filter(t => t.pnl > 0);
  const lossTrades = trades.filter(t => t.pnl <= 0);
  const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnl, 0) / winTrades.length : 0;
  const avgLoss = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((s, t) => s + t.pnl, 0) / lossTrades.length) : 0;
  const avgWinPct = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnlPct, 0) / winTrades.length : 0;
  const avgLossPct = lossTrades.length > 0 ? Math.abs(lossTrades.reduce((s, t) => s + t.pnlPct, 0) / lossTrades.length) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins) / (avgLoss * losses) : avgWin > 0 ? Infinity : 0;

  const winRateDecimal = totalTrades > 0 ? wins / totalTrades : 0;
  const expectancy = (winRateDecimal * avgWin) - ((1 - winRateDecimal) * avgLoss);

  let sharpeRatio = 0;
  if (trades.length > 1) {
    const returns = trades.map(t => t.pnlPct / 100);
    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / (returns.length - 1);
    const std = Math.sqrt(variance);
    sharpeRatio = std > 0 ? Math.round(meanReturn / std * Math.sqrt(252 / (days / totalTrades || 1)) * 100) / 100 : 0;
  }

  const result = {
    strategy: strategyName,
    strategyName: strat.name,
    symbol: symbol.toUpperCase(),
    days,
    interval,
    candleCount: candles.length,
    startCapital,
    endCapital: Math.round(capital * 100) / 100,
    returnPct: Math.round((capital - startCapital) / startCapital * 1000) / 10,
    totalTrades,
    wins,
    losses,
    winRate,
    totalPnl,
    maxDrawdown: Math.round(maxDrawdown * 1000) / 10,
    sharpeRatio,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    avgWinPct: Math.round(avgWinPct * 100) / 100,
    avgLossPct: Math.round(avgLossPct * 100) / 100,
    profitFactor: profitFactor === Infinity ? 999 : Math.round(profitFactor * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    trades,
    timestamp: new Date().toISOString(),
  };

  console.log(`[backtester] ${symbol} ${strategyName} 완료: ${totalTrades}건, 승률 ${winRate}%, PnL $${totalPnl}, 샤프 ${sharpeRatio}, PF ${result.profitFactor}`);
  return result;
}

// ── 모든 전략 비교 ──

async function compareAll(symbol, days = 90, options = {}) {
  const results = [];
  for (const key of Object.keys(strategies)) {
    try {
      const result = await backtest(symbol, key, days, options);
      results.push(result);
    } catch (e) {
      console.error(`[backtester] ${symbol} ${key} 실패: ${e.message}`);
      results.push({ strategy: key, error: e.message });
    }
  }

  const valid = results.filter(r => !r.error && r.totalTrades > 0);
  valid.sort((a, b) => {
    const scoreA = (a.sharpeRatio || 0) + (a.profitFactor || 0);
    const scoreB = (b.sharpeRatio || 0) + (b.profitFactor || 0);
    return scoreB - scoreA;
  });

  // ── 자동 리밸런싱: 수익 전략에 비중 높게 ──
  const strategyWeights = {};
  if (valid.length > 0) {
    // 수익 기준 점수 계산 (음수 전략은 0 가중치)
    const scores = {};
    let totalScore = 0;
    for (const r of valid) {
      // 종합 점수: sharpe * 0.4 + PF * 0.3 + winRate/100 * 0.3, 음수면 0
      const s = Math.max(0,
        (r.sharpeRatio || 0) * 0.4 +
        (r.profitFactor || 0) * 0.3 +
        (r.winRate / 100 || 0) * 0.3
      );
      scores[r.strategy] = s;
      totalScore += s;
    }
    // 비중 정규화
    for (const key of Object.keys(strategies)) {
      if (totalScore > 0 && scores[key] !== undefined) {
        strategyWeights[key] = Math.round((scores[key] / totalScore) * 1000) / 1000;
      } else {
        strategyWeights[key] = 0;
      }
    }
  }

  const best = valid[0] || null;
  return {
    symbol: symbol.toUpperCase(),
    days,
    results,
    ranking: valid.map(r => ({
      strategy: r.strategy,
      name: r.strategyName,
      winRate: r.winRate,
      totalPnl: r.totalPnl,
      sharpeRatio: r.sharpeRatio,
      profitFactor: r.profitFactor,
      expectancy: r.expectancy,
      trades: r.totalTrades,
      score: Math.round(((r.sharpeRatio || 0) + (r.profitFactor || 0)) * 100) / 100,
    })),
    strategyWeights,
    best: best ? best.strategy : null,
    bestName: best ? best.strategyName : null,
    timestamp: new Date().toISOString(),
  };
}

// ── 최적 전략 자동 선택 ──

async function selectBestStrategy(symbols = ['BTC', 'ETH', 'SOL'], days = 30) {
  const stratScores = {};
  for (const key of Object.keys(strategies)) {
    stratScores[key] = { sharpeSum: 0, pfSum: 0, count: 0 };
  }

  let latestWeights = {};

  for (const sym of symbols) {
    try {
      const comparison = await compareAll(sym, days);
      // 마지막 심볼의 weights를 기록 (또는 합산 가능)
      if (comparison.strategyWeights) {
        for (const [k, v] of Object.entries(comparison.strategyWeights)) {
          latestWeights[k] = (latestWeights[k] || 0) + v;
        }
      }
      for (const r of comparison.results) {
        if (r.error || !r.totalTrades) continue;
        stratScores[r.strategy].sharpeSum += r.sharpeRatio || 0;
        stratScores[r.strategy].pfSum += r.profitFactor || 0;
        stratScores[r.strategy].count++;
      }
    } catch (e) {
      console.error(`[backtester] ${sym} 비교 실패: ${e.message}`);
    }
  }

  // 멀티심볼 가중치 정규화
  const totalW = Object.values(latestWeights).reduce((a, b) => a + b, 0);
  if (totalW > 0) {
    for (const k of Object.keys(latestWeights)) {
      latestWeights[k] = Math.round((latestWeights[k] / totalW) * 1000) / 1000;
    }
  }

  let bestKey = null, bestScore = -Infinity;
  for (const [key, s] of Object.entries(stratScores)) {
    if (s.count === 0) continue;
    const avg = (s.sharpeSum + s.pfSum) / s.count;
    if (avg > bestScore) { bestScore = avg; bestKey = key; }
  }

  return {
    best: bestKey,
    bestName: bestKey ? strategies[bestKey].name : null,
    scores: stratScores,
    strategyWeights: latestWeights,
    timestamp: new Date().toISOString(),
  };
}

// ── 자동 파라미터 튜닝 ──

async function autoTuneParameters(symbol, strategyName, days = 60) {
  const strat = strategies[strategyName];
  if (!strat) throw new Error(`전략 "${strategyName}" 없음`);

  console.log(`[backtester] ${symbol} ${strategyName} 파라미터 튜닝 시작...`);

  const slRange = [0.01, 0.015, 0.02, 0.025, 0.03, 0.04];
  const tpRange = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08];
  const levRange = [5, 10, 15, 20];

  let bestResult = null;
  let bestParams = null;
  let bestScore = -Infinity;
  const results = [];

  for (const sl of slRange) {
    for (const tp of tpRange) {
      if (tp <= sl) continue; // R:R < 1 스킵
      for (const lev of levRange) {
        try {
          // 전략의 SL/TP를 임시 오버라이드
          const origSl = strat.slPct;
          const origTp = strat.tpPct;
          strat.slPct = sl;
          strat.tpPct = tp;

          const result = await backtest(symbol, strategyName, days, { leverage: lev });

          strat.slPct = origSl;
          strat.tpPct = origTp;

          if (!result || result.totalTrades < 5) continue;

          // 종합 점수: sharpe * 0.3 + PF * 0.25 + winRate * 0.2 + (1-MDD) * 0.25
          const score =
            (result.sharpeRatio || 0) * 0.3 +
            Math.min(result.profitFactor || 0, 5) * 0.25 +
            (result.winRate / 100) * 0.2 +
            (1 - result.maxDrawdown / 100) * 0.25;

          results.push({ sl, tp, lev, score, winRate: result.winRate, pnl: result.totalPnl, sharpe: result.sharpeRatio, pf: result.profitFactor, mdd: result.maxDrawdown, trades: result.totalTrades });

          if (score > bestScore) {
            bestScore = score;
            bestParams = { sl, tp, leverage: lev, rrRatio: Math.round(tp / sl * 10) / 10 };
            bestResult = result;
          }
        } catch {}
      }
    }
  }

  // 상위 5개 결과
  results.sort((a, b) => b.score - a.score);

  return {
    symbol,
    strategy: strategyName,
    bestParams,
    bestScore: Math.round(bestScore * 1000) / 1000,
    bestResult: bestResult ? {
      winRate: bestResult.winRate,
      totalPnl: bestResult.totalPnl,
      sharpe: bestResult.sharpeRatio,
      profitFactor: bestResult.profitFactor,
      maxDrawdown: bestResult.maxDrawdown,
      trades: bestResult.totalTrades,
    } : null,
    top5: results.slice(0, 5).map(r => ({
      sl: r.sl, tp: r.tp, lev: r.lev, rr: Math.round(r.tp / r.sl * 10) / 10,
      score: Math.round(r.score * 1000) / 1000,
      winRate: r.winRate, pnl: r.pnl, sharpe: r.sharpe, pf: r.pf, mdd: r.mdd,
    })),
    totalCombinations: results.length,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  backtest,
  strategies,
  compareAll,
  selectBestStrategy,
  fetchHistoricalCandles,
  autoTuneParameters,
  // 지표도 내보내기 (quant-signals에서 사용)
  ema, sma, rsi, bollingerBands, macdIndicator,
  atr, adx, roc, vwap, pivotPoints, stdDev,
};
