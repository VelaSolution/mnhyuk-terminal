'use strict';

/**
 * Quant Signal Engine — 수학적 조건 기반 진입 시그널 생성
 *
 * 12개 지표 점수 합산 + 신뢰도 등급 + 멀티 타임프레임 퀀트 시그널.
 * Kelly Criterion 기반 포지션 사이징 포함.
 *
 * 사용법:
 *   const quant = require('./quant-signals');
 *   const signal = quant.generateSignal(candles);
 *   const mtf = await quant.getMultiTFSignal('BTC');
 *   const sizing = quant.calculatePositionSize(3000, 0.55, 40, 25);
 */

const { ema, sma, rsi, bollingerBands, macdIndicator, atr, adx, roc, vwap, pivotPoints, stdDev, strategies: backtestStrategies } = require('./backtester');

// ── StochRSI 계산 (14,14,3,3) ──

function stochRsi(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiValues = rsi(closes, rsiPeriod);
  const kValues = new Array(closes.length).fill(null);
  const dValues = new Array(closes.length).fill(null);

  for (let i = rsiPeriod + stochPeriod - 1; i < closes.length; i++) {
    let minRsi = Infinity, maxRsi = -Infinity;
    let valid = true;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (rsiValues[j] === null) { valid = false; break; }
      if (rsiValues[j] < minRsi) minRsi = rsiValues[j];
      if (rsiValues[j] > maxRsi) maxRsi = rsiValues[j];
    }
    if (!valid) continue;
    const range = maxRsi - minRsi;
    kValues[i] = range > 0 ? ((rsiValues[i] - minRsi) / range) * 100 : 50;
  }

  // K smoothing (SMA of raw K)
  const smoothK = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < kSmooth - 1) continue;
    let sum = 0, cnt = 0;
    for (let j = i - kSmooth + 1; j <= i; j++) {
      if (kValues[j] !== null) { sum += kValues[j]; cnt++; }
    }
    if (cnt === kSmooth) smoothK[i] = sum / cnt;
  }

  // D line (SMA of smoothed K)
  for (let i = 0; i < closes.length; i++) {
    if (i < dSmooth - 1) continue;
    let sum = 0, cnt = 0;
    for (let j = i - dSmooth + 1; j <= i; j++) {
      if (smoothK[j] !== null) { sum += smoothK[j]; cnt++; }
    }
    if (cnt === dSmooth) dValues[i] = sum / cnt;
  }

  return { k: smoothK, d: dValues };
}

// ── OBV (On Balance Volume) 기울기 ──

function obvSlope(closes, volumes, period = 10) {
  const obv = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) obv.push(obv[i - 1] + volumes[i]);
    else if (closes[i] < closes[i - 1]) obv.push(obv[i - 1] - volumes[i]);
    else obv.push(obv[i - 1]);
  }

  // 기울기: period 구간 선형 회귀 기울기 (정규화)
  const slopes = new Array(closes.length).fill(null);
  for (let i = period; i < closes.length; i++) {
    const startOBV = obv[i - period];
    const endOBV = obv[i];
    const avgVol = volumes.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
    slopes[i] = avgVol > 0 ? (endOBV - startOBV) / (avgVol * period) : 0; // 정규화된 기울기
  }
  return { obv, slopes };
}

// ── 이치모쿠 구름 (Ichimoku Cloud) ──

function ichimoku(candles, tenkanPeriod = 9, kijunPeriod = 26, senkouBPeriod = 52) {
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const closes = candles.map(c => c.c);
  const len = candles.length;

  const tenkan = new Array(len).fill(null); // 전환선
  const kijun = new Array(len).fill(null);  // 기준선
  const senkouA = new Array(len).fill(null); // 선행스팬A
  const senkouB = new Array(len).fill(null); // 선행스팬B

  const highLow = (arr, arrL, start, period) => {
    let hi = -Infinity, lo = Infinity;
    for (let j = start; j < start + period && j < arr.length; j++) {
      if (arr[j] > hi) hi = arr[j];
      if (arrL[j] < lo) lo = arrL[j];
    }
    return (hi + lo) / 2;
  };

  for (let i = 0; i < len; i++) {
    if (i >= tenkanPeriod - 1) tenkan[i] = highLow(highs, lows, i - tenkanPeriod + 1, tenkanPeriod);
    if (i >= kijunPeriod - 1) kijun[i] = highLow(highs, lows, i - kijunPeriod + 1, kijunPeriod);
    if (i >= senkouBPeriod - 1) senkouB[i] = highLow(highs, lows, i - senkouBPeriod + 1, senkouBPeriod);
    if (tenkan[i] !== null && kijun[i] !== null) senkouA[i] = (tenkan[i] + kijun[i]) / 2;
  }

  return { tenkan, kijun, senkouA, senkouB };
}

// ── 캔들 패턴 인식 ──

function detectCandlePatterns(candles) {
  const patterns = new Array(candles.length).fill(null);

  for (let i = 2; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const pp = candles[i - 2];
    const bodySize = Math.abs(c.c - c.o);
    const upperWick = c.h - Math.max(c.c, c.o);
    const lowerWick = Math.min(c.c, c.o) - c.l;
    const totalRange = c.h - c.l;

    if (totalRange === 0) continue;

    // 망치형 (Hammer) — 하락 후 긴 아래꼬리
    if (lowerWick > bodySize * 2 && upperWick < bodySize * 0.5 && p.c < pp.c) {
      patterns[i] = { type: 'hammer', direction: 'bullish', strength: 1 };
      continue;
    }

    // 교수형 (Shooting Star) — 상승 후 긴 위꼬리
    if (upperWick > bodySize * 2 && lowerWick < bodySize * 0.5 && p.c > pp.c) {
      patterns[i] = { type: 'shooting_star', direction: 'bearish', strength: 1 };
      continue;
    }

    // 강세 장악형 (Bullish Engulfing)
    if (p.c < p.o && c.c > c.o && c.o <= p.c && c.c >= p.o) {
      patterns[i] = { type: 'bullish_engulfing', direction: 'bullish', strength: 2 };
      continue;
    }

    // 약세 장악형 (Bearish Engulfing)
    if (p.c > p.o && c.c < c.o && c.o >= p.c && c.c <= p.o) {
      patterns[i] = { type: 'bearish_engulfing', direction: 'bearish', strength: 2 };
      continue;
    }

    // 도지 (Doji) — 몸통 극소
    if (bodySize < totalRange * 0.1 && totalRange > 0) {
      patterns[i] = { type: 'doji', direction: 'neutral', strength: 0.5 };
      continue;
    }

    // Morning Star (3봉 반전)
    if (i >= 2 && pp.c < pp.o && Math.abs(p.c - p.o) < (pp.h - pp.l) * 0.2 && c.c > c.o && c.c > (pp.o + pp.c) / 2) {
      patterns[i] = { type: 'morning_star', direction: 'bullish', strength: 2 };
      continue;
    }

    // Evening Star (3봉 반전)
    if (i >= 2 && pp.c > pp.o && Math.abs(p.c - p.o) < (pp.h - pp.l) * 0.2 && c.c < c.o && c.c < (pp.o + pp.c) / 2) {
      patterns[i] = { type: 'evening_star', direction: 'bearish', strength: 2 };
      continue;
    }
  }
  return patterns;
}

// ── 퀀트 시그널 생성 (12개 지표) ──

function generateSignal(candles) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return { action: 'HOLD', confidence: 0, totalScore: 0, score: {}, breakdown: {}, grade: 'D' };
  }

  const closes = candles.map(c => c.c);
  const volumes = candles.map(c => c.v);
  const highs = candles.map(c => c.h);
  const lows = candles.map(c => c.l);
  const last = closes.length - 1;
  const price = closes[last];

  const score = {
    rsi: 0,         // -100 ~ +100
    ema: 0,         // -60 ~ +60
    macd: 0,        // -50 ~ +50
    bb: 0,          // -70 ~ +70
    volume: 0,      // 0 ~ +30
    momentum: 0,    // -80 ~ +80
    adx: 0,         // -40 ~ +40
    stochRsi: 0,    // -60 ~ +60
    obv: 0,         // -40 ~ +40
    ichimoku: 0,    // -50 ~ +50
    pivots: 0,      // -30 ~ +30
    patterns: 0,    // -50 ~ +50
    onchain: 0,     // -180 ~ +180 (funding + longShort + oi)
    exchangeFlow: 0, // -60 ~ +60 (거래소 유입/유출 프록시)
  };

  // ── 1. RSI 점수 ──
  const rsiValues = rsi(closes, 14);
  const currentRsi = rsiValues[last];
  if (currentRsi !== null) {
    if (currentRsi < 25) score.rsi = 100;
    else if (currentRsi < 30) score.rsi = 80;
    else if (currentRsi < 40) score.rsi = 40;
    else if (currentRsi > 75) score.rsi = -100;
    else if (currentRsi > 70) score.rsi = -80;
    else if (currentRsi > 60) score.rsi = -40;
  }

  // ── 2. EMA 정렬 점수 ──
  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);
  const e9 = ema9[last], e21 = ema21[last], e50 = ema50[last];

  if (price > e9 && e9 > e21 && e21 > e50) score.ema = 60;
  else if (price > e9 && e9 > e21) score.ema = 40;
  else if (price > e9) score.ema = 20;
  else if (price < e9 && e9 < e21 && e21 < e50) score.ema = -60;
  else if (price < e9 && e9 < e21) score.ema = -40;
  else if (price < e9) score.ema = -20;

  // ── 3. MACD 점수 ──
  const { histogram } = macdIndicator(closes);
  const macdHist = histogram[last];
  const prevMacdHist = histogram[last - 1];

  if (macdHist > 0 && macdHist > prevMacdHist) score.macd = 50;
  else if (macdHist > 0 && macdHist <= prevMacdHist) score.macd = 20;
  else if (macdHist < 0 && macdHist < prevMacdHist) score.macd = -50;
  else if (macdHist < 0 && macdHist >= prevMacdHist) score.macd = -20;

  // ── 4. 볼린저 밴드 점수 ──
  const bb = bollingerBands(closes, 20, 2);
  if (bb.lower[last] !== null) {
    const bbWidth = bb.upper[last] - bb.lower[last];
    const pricePos = (price - bb.lower[last]) / (bbWidth || 1);

    if (price <= bb.lower[last]) score.bb = 70;
    else if (pricePos < 0.2) score.bb = 40;
    else if (price >= bb.upper[last]) score.bb = -70;
    else if (pricePos > 0.8) score.bb = -40;
  }

  // ── 5. 거래량 점수 (가격 방향 결합) ──
  const volPeriod = 20;
  if (volumes.length >= volPeriod) {
    const avgVol = volumes.slice(-volPeriod).reduce((a, b) => a + b, 0) / volPeriod;
    const currentVol = volumes[last];
    if (avgVol > 0) {
      const volRatio = currentVol / avgVol;
      const priceChange = closes.length >= 2 ? (price - closes[last - 1]) / closes[last - 1] * 100 : 0;
      const direction = priceChange > 0 ? 1 : priceChange < 0 ? -1 : 0;
      if (volRatio > 2.0) score.volume = 30 * direction;
      else if (volRatio > 1.5) score.volume = 20 * direction;
      else if (volRatio > 1.2) score.volume = 10 * direction;
      // 거래량 급증 + 가격 하락 = 매도 압력 (음수), 거래량 급증 + 가격 상승 = 매수 압력 (양수)
    }
  }

  // ── 6. 모멘텀 점수 (가격 변화율) ──
  if (closes.length >= 10) {
    const roc5 = (price - closes[last - 5]) / closes[last - 5] * 100;
    const roc10 = (price - closes[last - 10]) / closes[last - 10] * 100;
    if (roc5 > 3) score.momentum = 40;
    else if (roc5 > 1) score.momentum = 20;
    else if (roc5 < -3) score.momentum = -40;
    else if (roc5 < -1) score.momentum = -20;
    if (roc10 > 5) score.momentum += 40;
    else if (roc10 < -5) score.momentum -= 40;
    score.momentum = Math.max(-80, Math.min(80, score.momentum));
  }

  // ── 7. ADX (추세 강도) — EMA+MACD+RSI+모멘텀 종합 방향 결합 ──
  const adxValues = adx(candles, 14);
  const curADX = adxValues[last];
  if (curADX !== null) {
    const dirVotes = [
      score.ema > 0 ? 1 : score.ema < 0 ? -1 : 0,
      score.macd > 0 ? 1 : score.macd < 0 ? -1 : 0,
      score.rsi > 0 ? 1 : score.rsi < 0 ? -1 : 0,
      score.momentum > 0 ? 1 : score.momentum < 0 ? -1 : 0,
    ];
    const dirSum = dirVotes.reduce((a, b) => a + b, 0);
    const direction = dirSum > 0 ? 1 : dirSum < 0 ? -1 : 0;
    if (curADX > 40) score.adx = 40 * direction;       // 매우 강한 추세
    else if (curADX > 25) score.adx = 25 * direction;  // 강한 추세
    else if (curADX > 20) score.adx = 10 * direction;  // 약한 추세
    // ADX < 20: 추세 없음 → 0
  }

  // ── 8. Stochastic RSI ──
  const stRsi = stochRsi(closes, 14, 14, 3, 3);
  const stK = stRsi.k[last];
  const stD = stRsi.d[last];
  if (stK !== null && stD !== null) {
    // 과매도 영역 + K가 D 위로 크로스
    if (stK < 20 && stD < 20) score.stochRsi = 60;
    else if (stK < 30 && stK > stD) score.stochRsi = 30;
    // 과매수 영역 + K가 D 아래로 크로스
    else if (stK > 80 && stD > 80) score.stochRsi = -60;
    else if (stK > 70 && stK < stD) score.stochRsi = -30;
  }

  // ── 9. OBV 기울기 ──
  const obvData = obvSlope(closes, volumes, 10);
  const curOBVSlope = obvData.slopes[last];
  if (curOBVSlope !== null) {
    if (curOBVSlope > 0.5) score.obv = 40;         // 강한 매수 압력
    else if (curOBVSlope > 0.2) score.obv = 20;    // 보통 매수
    else if (curOBVSlope < -0.5) score.obv = -40;  // 강한 매도 압력
    else if (curOBVSlope < -0.2) score.obv = -20;  // 보통 매도
  }

  // ── 10. 이치모쿠 구름 ──
  const ichi = ichimoku(candles);
  const tenkan = ichi.tenkan[last];
  const kijun = ichi.kijun[last];
  const spanA = ichi.senkouA[last];
  const spanB = ichi.senkouB[last];

  if (tenkan !== null && kijun !== null && spanA !== null && spanB !== null) {
    const cloudTop = Math.max(spanA, spanB);
    const cloudBottom = Math.min(spanA, spanB);

    // 가격이 구름 위 + 전환선 > 기준선 → 강세
    if (price > cloudTop && tenkan > kijun) score.ichimoku = 50;
    else if (price > cloudTop) score.ichimoku = 30;
    // 가격이 구름 아래 + 전환선 < 기준선 → 약세
    else if (price < cloudBottom && tenkan < kijun) score.ichimoku = -50;
    else if (price < cloudBottom) score.ichimoku = -30;
    // 구름 내부 → 중립
    else if (tenkan > kijun) score.ichimoku = 10;
    else if (tenkan < kijun) score.ichimoku = -10;
  }

  // ── 11. 피봇 포인트 ──
  const pivots = pivotPoints(candles);
  const curPivot = pivots[last];
  if (curPivot) {
    const { P, S1, R1 } = curPivot;
    const range = Math.abs(R1 - S1);
    const tolerance = range * 0.05;

    if (Math.abs(price - S1) < tolerance && price > S1) score.pivots = 30;       // S1 지지 반등
    else if (price < S1) score.pivots = 20;                                        // S1 아래 → 과매도
    else if (Math.abs(price - R1) < tolerance && price < R1) score.pivots = -30;  // R1 저항
    else if (price > R1) score.pivots = -20;                                       // R1 위 → 과매수 (mean rev 관점)
  }

  // ── 12. 캔들 패턴 ──
  const candlePatterns = detectCandlePatterns(candles);
  const curPattern = candlePatterns[last];
  const prevPattern = candlePatterns[last - 1]; // 직전 봉 패턴도 확인
  const activePattern = curPattern || prevPattern;

  if (activePattern) {
    if (activePattern.direction === 'bullish') score.patterns = 25 * activePattern.strength;
    else if (activePattern.direction === 'bearish') score.patterns = -25 * activePattern.strength;
    score.patterns = Math.max(-50, Math.min(50, score.patterns));
  }

  // ── 13. 온체인 점수 (캔들 데이터 기반 프록시) ──
  // 펀딩레이트 프록시: 최근 봉의 과열 정도 (연속 양/음봉 + 변동률)
  if (closes.length >= 10) {
    let fundingScore = 0, longShortScore = 0, oiScore = 0;

    // 펀딩레이트 프록시: 연속 방향봉 수로 과열 추정
    let consecutiveBull = 0, consecutiveBear = 0;
    for (let ci = last; ci >= Math.max(0, last - 7); ci--) {
      if (candles[ci].c > candles[ci].o) { if (consecutiveBear === 0) consecutiveBull++; else break; }
      else if (candles[ci].c < candles[ci].o) { if (consecutiveBull === 0) consecutiveBear++; else break; }
      else break;
    }
    const recentChange = (closes[last] - closes[Math.max(0, last - 5)]) / closes[Math.max(0, last - 5)] * 100;

    // 5+연속 양봉 + 큰 상승 → 롱 과열 → 역발상 숏 시그널 (가중치 축소: 프록시이므로 ±35 max)
    if (consecutiveBull >= 5 && recentChange > 3) fundingScore = -35;
    else if (consecutiveBull >= 4 && recentChange > 2) fundingScore = -20;
    else if (consecutiveBull >= 3 && recentChange > 1.5) fundingScore = -10;
    // 5+연속 음봉 + 큰 하락 → 숏 과열 → 역발상 롱 시그널
    else if (consecutiveBear >= 5 && recentChange < -3) fundingScore = 35;
    else if (consecutiveBear >= 4 && recentChange < -2) fundingScore = 20;
    else if (consecutiveBear >= 3 && recentChange < -1.5) fundingScore = 10;

    // 롱숏비율 프록시: 거래량 + 가격 방향 불일치로 추정
    const vol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const vol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volSurge = vol20 > 0 ? vol5 / vol20 : 1;
    // 거래량 급증 + 가격 하락 → 매도 압도 → 역발상 롱 (가중치 축소)
    if (volSurge > 1.8 && recentChange < -1) longShortScore = 30;
    else if (volSurge > 1.5 && recentChange < -0.5) longShortScore = 15;
    // 거래량 급증 + 가격 상승 → 매수 과열 → 역발상 숏
    else if (volSurge > 1.8 && recentChange > 1) longShortScore = -30;
    else if (volSurge > 1.5 && recentChange > 0.5) longShortScore = -15;

    // OI 프록시: 거래량 증감 + 가격 방향으로 추세 지속/반전 판단
    const volChange = vol5 > 0 && vol20 > 0 ? (vol5 - vol20) / vol20 : 0;
    // OI 급증(거래량 증가) + 가격 상승 → 추세 지속 롱 (가중치 축소)
    if (volChange > 0.3 && recentChange > 1) oiScore = 15;
    else if (volChange > 0.15 && recentChange > 0.5) oiScore = 8;
    // OI 급증 + 가격 하락 → 추세 지속 숏
    else if (volChange > 0.3 && recentChange < -1) oiScore = -15;
    else if (volChange > 0.15 && recentChange < -0.5) oiScore = -8;

    score.onchain = Math.max(-80, Math.min(80, fundingScore + longShortScore + oiScore));
  }

  // ── 14. 거래소 유입/유출 프록시 ──
  const flowProxy = getExchangeFlowProxy(candles);
  score.exchangeFlow = flowProxy.score;

  // ── 종합 점수 ──
  const totalScore = Object.values(score).reduce((a, b) => a + b, 0);
  // 각 지표별 최대 절대값 (score 객체 키와 정확히 일치)
  const scoreMaxes = { rsi: 100, ema: 60, macd: 50, bb: 70, volume: 30, momentum: 80, adx: 40, stochRsi: 60, obv: 40, ichimoku: 50, pivots: 30, patterns: 50, onchain: 80, exchangeFlow: 60 };
  const maxScore = Object.keys(score).reduce((sum, k) => sum + (scoreMaxes[k] || 50), 0);
  const confidence = Math.round(Math.abs(totalScore) / maxScore * 100);

  // ── 지표 방향 일치도 계산 ──
  const scoreValues = Object.values(score);
  const positiveCount = scoreValues.filter(v => v > 0).length;
  const negativeCount = scoreValues.filter(v => v < 0).length;
  const totalIndicators = scoreValues.filter(v => v !== 0).length;
  const agreementRatio = totalIndicators > 0
    ? Math.max(positiveCount, negativeCount) / totalIndicators
    : 0;

  // ── 신뢰도 등급 (점수 + 일치도 복합 판단) ──
  const absScore = Math.abs(totalScore);
  let grade;
  if (absScore >= 200 && agreementRatio >= 0.7) grade = 'S';      // 극강: 점수 높고 일치도 높음
  else if (absScore >= 150 && agreementRatio >= 0.6) grade = 'A'; // 강함
  else if (absScore >= 150) grade = 'B';                           // 점수 높지만 일치도 낮으면 B
  else if (absScore >= 100 && agreementRatio >= 0.6) grade = 'B'; // 보통
  else if (absScore >= 80) grade = 'C';                            // 약함
  else grade = 'D';                                                 // HOLD

  // 진입 임계값
  let action = 'HOLD';
  if (totalScore > 80) action = 'BUY';
  else if (totalScore < -80) action = 'SELL';

  // D등급이면 강제 HOLD
  if (grade === 'D') action = 'HOLD';

  // 추가 지표 정보
  const indicators = {
    rsi: currentRsi !== null ? Math.round(currentRsi * 10) / 10 : null,
    ema9: Math.round(e9 * 100) / 100,
    ema21: Math.round(e21 * 100) / 100,
    ema50: Math.round(e50 * 100) / 100,
    macdHist: Math.round(macdHist * 10000) / 10000,
    bbUpper: bb.upper[last] ? Math.round(bb.upper[last] * 100) / 100 : null,
    bbLower: bb.lower[last] ? Math.round(bb.lower[last] * 100) / 100 : null,
    adx: curADX !== null ? Math.round(curADX * 10) / 10 : null,
    stochRsiK: stK !== null ? Math.round(stK * 10) / 10 : null,
    stochRsiD: stD !== null ? Math.round(stD * 10) / 10 : null,
    obvSlope: curOBVSlope !== null ? Math.round(curOBVSlope * 1000) / 1000 : null,
    ichimokuTenkan: tenkan ? Math.round(tenkan * 100) / 100 : null,
    ichimokuKijun: kijun ? Math.round(kijun * 100) / 100 : null,
    pattern: activePattern ? activePattern.type : null,
    pivotP: curPivot ? Math.round(curPivot.P * 100) / 100 : null,
    pivotS1: curPivot ? Math.round(curPivot.S1 * 100) / 100 : null,
    pivotR1: curPivot ? Math.round(curPivot.R1 * 100) / 100 : null,
    onchainScore: score.onchain,
    exchangeFlowScore: score.exchangeFlow,
    exchangeFlowInterpretation: flowProxy.interpretation,
    price: Math.round(price * 100) / 100,
    agreementRatio: Math.round(agreementRatio * 100),
    bullIndicators: positiveCount,
    bearIndicators: negativeCount,
  };

  // 마켓 레짐 분류
  const regimeResult = classifyRegime(candles);

  return {
    action,
    confidence,
    totalScore,
    maxScore,
    grade,
    gradeLabel: { S: '극강', A: '강함', B: '보통', C: '약함', D: 'HOLD' }[grade],
    score,
    breakdown: score,
    indicators,
    regime: regimeResult,
    timestamp: new Date().toISOString(),
  };
}

// ── 멀티 타임프레임 퀀트 시그널 ──

async function getMultiTFSignal(symbol) {
  const pair = symbol.toUpperCase().replace('USDT', '') + 'USDT';
  const timeframes = [
    { tf: '1h', limit: 200 },
    { tf: '4h', limit: 200 },
    { tf: '1d', limit: 100 },
  ];

  const tfSignals = {};

  for (const { tf, limit } of timeframes) {
    try {
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${tf}&limit=${limit}`,
        { signal: AbortSignal.timeout(10000) }
      );
      if (!res.ok) throw new Error(`Binance API ${res.status}`);
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length < 60) throw new Error(`캔들 부족 (${tf}: ${raw.length}개)`);
      const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      tfSignals[tf] = generateSignal(candles);
    } catch (e) {
      console.error(`[quant-signals] ${symbol} ${tf} 실패: ${e.message}`);
      tfSignals[tf] = { action: 'HOLD', confidence: 0, totalScore: 0, grade: 'D', error: e.message };
    }
  }

  // 멀티 TF 합산 로직 (점수 크기 가중 의결)
  const actions = Object.values(tfSignals).map(s => s.action).filter(a => a !== 'HOLD');
  const buyCount = actions.filter(a => a === 'BUY').length;
  const sellCount = actions.filter(a => a === 'SELL').length;

  // 각 TF 점수 강도를 고려한 가중 의결
  const buyStrength = Object.values(tfSignals).filter(s => s.action === 'BUY').reduce((sum, s) => sum + Math.abs(s.totalScore || 0), 0);
  const sellStrength = Object.values(tfSignals).filter(s => s.action === 'SELL').reduce((sum, s) => sum + Math.abs(s.totalScore || 0), 0);

  let finalAction = 'HOLD';
  let multiplier = 1.0;
  let reason = '';

  if (buyCount === 3) {
    finalAction = 'BUY';
    multiplier = 1.5;
    reason = '3TF 만장일치 BUY (x1.5)';
  } else if (sellCount === 3) {
    finalAction = 'SELL';
    multiplier = 1.5;
    reason = '3TF 만장일치 SELL (x1.5)';
  } else if (buyCount === 2 && sellCount === 0) {
    finalAction = 'BUY';
    multiplier = 1.0;
    reason = '2TF BUY + 1 HOLD (x1.0)';
  } else if (sellCount === 2 && buyCount === 0) {
    finalAction = 'SELL';
    multiplier = 1.0;
    reason = '2TF SELL + 1 HOLD (x1.0)';
  } else if (buyCount > 0 && sellCount > 0) {
    // 방향 충돌 시 — 점수 강도 차이가 2배 이상이면 강한 쪽으로 결정
    const strongerSide = buyStrength > sellStrength ? 'BUY' : 'SELL';
    const ratio = Math.max(buyStrength, sellStrength) / (Math.min(buyStrength, sellStrength) || 1);
    if (ratio >= 2.0) {
      finalAction = strongerSide;
      multiplier = 0.7; // 충돌이므로 감쇠
      reason = `TF 충돌이나 ${strongerSide} 강도 ${ratio.toFixed(1)}x 우세 (x0.7)`;
    } else {
      finalAction = 'HOLD';
      reason = `TF 방향 불일치 (BUY ${buyStrength} vs SELL ${sellStrength}) → HOLD`;
    }
  } else {
    finalAction = 'HOLD';
    reason = '진입 조건 미달';
  }

  // 종합 점수 (가중 평균: 1h x 0.3, 4h x 0.4, 1d x 0.3)
  const tfWeights = { '1h': 0.3, '4h': 0.4, '1d': 0.3 };
  const weightedScore = Math.round(
    (tfSignals['1h'].totalScore || 0) * tfWeights['1h'] +
    (tfSignals['4h'].totalScore || 0) * tfWeights['4h'] +
    (tfSignals['1d'].totalScore || 0) * tfWeights['1d']
  );

  // 각 TF 시그널 강도를 가중 합산하여 종합 등급 재계산
  const weightedConfidence = Math.round(
    (tfSignals['1h'].confidence || 0) * tfWeights['1h'] +
    (tfSignals['4h'].confidence || 0) * tfWeights['4h'] +
    (tfSignals['1d'].confidence || 0) * tfWeights['1d']
  );

  const absWeightedScore = Math.abs(weightedScore);
  let combinedGrade;
  if (absWeightedScore >= 200) combinedGrade = 'S';
  else if (absWeightedScore >= 150) combinedGrade = 'A';
  else if (absWeightedScore >= 100) combinedGrade = 'B';
  else if (absWeightedScore >= 80) combinedGrade = 'C';
  else combinedGrade = 'D';

  // 최고 등급도 참고 (기존 호환)
  const gradeOrder = { S: 5, A: 4, B: 3, C: 2, D: 1 };
  const bestGrade = Object.values(tfSignals).reduce((best, s) => {
    return (gradeOrder[s.grade] || 0) > (gradeOrder[best] || 0) ? s.grade : best;
  }, 'D');

  // 최종 등급: 가중 합산 등급과 최고 등급 중 높은 것
  const finalGrade = (gradeOrder[combinedGrade] || 0) >= (gradeOrder[bestGrade] || 0) ? combinedGrade : bestGrade;

  // 오더북 불균형 점수 반영 (비동기 추가 신호)
  let orderbookBonus = 0;
  try {
    const ob = await getOrderbookImbalance(symbol);
    if (ob && ob.score !== 0) {
      const obDirection = ob.score > 0 ? 'BUY' : 'SELL';
      if (obDirection === finalAction) {
        orderbookBonus = Math.round(Math.abs(ob.score) * 20); // 오더북 방향 일치 → 가산
      } else if (finalAction !== 'HOLD') {
        orderbookBonus = -Math.round(Math.abs(ob.score) * 10); // 오더북 반대 → 감산
      }
    }
  } catch {}

  return {
    symbol: symbol.toUpperCase(),
    action: finalAction,
    multiplier,
    reason,
    weightedScore: weightedScore + orderbookBonus,
    orderbookBonus,
    weightedConfidence,
    grade: finalGrade,
    combinedGrade,
    timeframes: {
      '1h': { action: tfSignals['1h'].action, score: tfSignals['1h'].totalScore, grade: tfSignals['1h'].grade, confidence: tfSignals['1h'].confidence, weight: tfWeights['1h'] },
      '4h': { action: tfSignals['4h'].action, score: tfSignals['4h'].totalScore, grade: tfSignals['4h'].grade, confidence: tfSignals['4h'].confidence, weight: tfWeights['4h'] },
      '1d': { action: tfSignals['1d'].action, score: tfSignals['1d'].totalScore, grade: tfSignals['1d'].grade, confidence: tfSignals['1d'].confidence, weight: tfWeights['1d'] },
    },
    details: tfSignals,
    timestamp: new Date().toISOString(),
  };
}

// ── Kelly Criterion 기반 포지션 사이징 ──

function calculatePositionSize(capital, winRate, avgWin, avgLoss) {
  const W = typeof winRate === 'number' && winRate <= 1 ? winRate : winRate / 100;
  const R = avgLoss > 0 ? avgWin / avgLoss : 0;

  let kelly = 0;
  if (R > 0) {
    kelly = W - (1 - W) / R;
  }

  const halfKelly = Math.max(0, kelly / 2);
  const expectancy = (W * avgWin) - ((1 - W) * avgLoss);
  const riskAmount = capital * halfKelly;
  const cappedRisk = Math.min(riskAmount, capital * 0.05);

  return {
    kellyFull: Math.round(kelly * 1000) / 10,
    kellyPct: Math.round(halfKelly * 1000) / 10,
    riskAmount: Math.round(cappedRisk * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    isPositive: expectancy > 0,
    winLossRatio: Math.round(R * 100) / 100,
    edgeDescription: expectancy > 0
      ? `+$${expectancy.toFixed(2)}/trade (${(halfKelly * 100).toFixed(1)}% 배팅)`
      : `기대값 음수 — 진입 금지`,
  };
}

// ── AI 판정 + 퀀트 시그널 병합 로직 ──

function mergeSignals(aiDecision, quantSignal) {
  const aiAction = (aiDecision.action || '').toUpperCase();
  const aiConf = aiDecision.confidence || 0;
  const quantAction = quantSignal.action;
  const quantScore = quantSignal.totalScore;
  const quantConf = quantSignal.confidence;
  const quantGrade = quantSignal.grade || 'D';

  let finalAction = 'HOLD';
  let finalConf = 0;
  let reason = '';

  // S/A 등급 퀀트 시그널은 신뢰도 부스트
  const gradeBoost = quantGrade === 'S' ? 1.3 : quantGrade === 'A' ? 1.15 : 1.0;

  // Case 1: AI와 퀀트 같은 방향
  if (aiAction === quantAction && aiAction !== 'HOLD') {
    finalAction = aiAction;
    finalConf = Math.min(Math.round(Math.max(aiConf, quantConf) * 1.2 * gradeBoost), 95);
    reason = `AI+퀀트 합류 [${quantGrade}급] (AI ${aiConf}% + Q ${quantConf}% → ${finalConf}%)`;
  }
  // Case 2: AI만 진입 신호 (퀀트 HOLD)
  else if ((aiAction === 'BUY' || aiAction === 'SELL') && quantAction === 'HOLD') {
    if (quantScore > 0 && aiAction === 'BUY') {
      finalAction = 'BUY';
      finalConf = aiConf;
      reason = `AI BUY + 퀀트 양수(${quantScore}) [${quantGrade}급] → 진입`;
    } else if (quantScore < 0 && aiAction === 'SELL') {
      finalAction = 'SELL';
      finalConf = aiConf;
      reason = `AI SELL + 퀀트 음수(${quantScore}) [${quantGrade}급] → 진입`;
    } else if (aiConf >= 60) {
      // AI 확신 60%+ 이면 퀀트 방향 무관 진입 허용 (기존: 퀀트 반대 40+ → 차단)
      finalAction = aiAction;
      finalConf = Math.round(aiConf * 0.85);
      reason = `AI ${aiAction} 강한 확신 ${aiConf}% (퀀트 ${quantScore}) → 진입`;
    } else if (Math.abs(quantScore) < 60) {
      finalAction = aiAction;
      finalConf = Math.round(aiConf * 0.75);
      reason = `AI ${aiAction} 단독 (퀀트 ${quantScore}, 확신 감소)`;
    } else {
      finalAction = 'HOLD';
      reason = `AI ${aiAction} but 퀀트 강한 반대(${quantScore}) [${quantGrade}급] → 거부`;
    }
  }
  // Case 3: 퀀트만 진입 신호 — AI HOLD여도 퀀트 B+이면 진입
  else if (quantAction !== 'HOLD' && (aiAction === 'HOLD' || !aiAction)) {
    const GRADE_ORD = { S: 5, A: 4, B: 3, C: 2, D: 1 };
    if ((GRADE_ORD[quantGrade] || 0) >= 3) {
      // 퀀트 B등급+ → 단독 진입 허용
      finalAction = quantAction;
      finalConf = Math.round(quantConf * 0.8 * gradeBoost);
      reason = `퀀트 ${quantAction} [${quantGrade}급] 강한 시그널 → 단독 진입`;
    } else if (aiConf >= 40) {
      finalAction = quantAction;
      finalConf = Math.round(quantConf * 0.6 * gradeBoost);
      reason = `퀀트 ${quantAction} [${quantGrade}급] + AI ${aiConf}% → 축소 진입`;
    } else {
      finalAction = 'HOLD';
      reason = `퀀트 ${quantAction} [${quantGrade}급] AI 미지원 → 거부`;
    }
  }
  // Case 4: 반대 방향 — 강도 차이 크면 강한 쪽으로
  else if (
    (aiAction === 'BUY' && quantAction === 'SELL') ||
    (aiAction === 'SELL' && quantAction === 'BUY')
  ) {
    // 퀀트 D/C급이면 AI 우선
    const GRADE_ORD = { S: 5, A: 4, B: 3, C: 2, D: 1 };
    if ((GRADE_ORD[quantGrade] || 0) <= 2 && aiConf >= 65) {
      finalAction = aiAction;
      finalConf = Math.round(aiConf * 0.6);
      reason = `AI ${aiAction} ${aiConf}% > 약한 퀀트 ${quantAction} [${quantGrade}급] → AI 우선`;
    } else {
      finalAction = 'HOLD';
      reason = `AI ${aiAction} vs 퀀트 ${quantAction} [${quantGrade}급] 충돌 → 거부`;
    }
  }
  // Case 5: 둘 다 HOLD
  else {
    finalAction = 'HOLD';
    reason = 'AI + 퀀트 모두 HOLD';
  }

  return {
    action: finalAction,
    confidence: finalConf,
    reason,
    grade: quantGrade,
    aiOriginal: { action: aiAction, confidence: aiConf },
    quantOriginal: { action: quantAction, confidence: quantConf, score: quantScore, grade: quantGrade },
  };
}

// ── 캔들 데이터에서 시그널 생성 (API용 래퍼) ──

async function getSignalForSymbol(symbol) {
  const pair = symbol.toUpperCase().replace('USDT', '') + 'USDT';
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=1h&limit=200`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) throw new Error(`Binance API ${res.status}`);
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length < 60) throw new Error('캔들 부족');
    const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    const signal = generateSignal(candles);
    signal.symbol = symbol.toUpperCase();
    return signal;
  } catch (e) {
    return { action: 'HOLD', confidence: 0, error: e.message, symbol: symbol.toUpperCase(), grade: 'D' };
  }
}

// ── 온체인 점수 (실시간 바이낸스 API) ──

async function getFundingScore(symbol) {
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol.toUpperCase().replace('USDT', '')}USDT&limit=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { score: 0, rate: 0 };
    const [fr] = await res.json();
    const rate = parseFloat(fr.fundingRate);
    let score = 0;
    // rate > 0.05% → 롱 과열 → 숏 시그널
    if (rate > 0.001) score = -80;
    else if (rate > 0.0005) score = -50;
    else if (rate > 0.0003) score = -25;
    // rate < -0.03% → 숏 과열 → 롱 시그널
    else if (rate < -0.0005) score = 80;
    else if (rate < -0.0003) score = 50;
    else if (rate < -0.0001) score = 25;
    return { score, rate };
  } catch (e) {
    return { score: 0, rate: 0, error: e.message };
  }
}

async function getLongShortScore(symbol) {
  try {
    const res = await fetch(
      `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol.toUpperCase().replace('USDT', '')}USDT&period=1h&limit=1`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { score: 0, longRatio: 0.5 };
    const [data] = await res.json();
    const longRatio = parseFloat(data.longAccount);
    let score = 0;
    // longAccount > 70% → 역발상 숏
    if (longRatio > 0.70) score = -60;
    else if (longRatio > 0.65) score = -30;
    // shortAccount > 70% (longAccount < 30%) → 역발상 롱
    else if (longRatio < 0.30) score = 60;
    else if (longRatio < 0.35) score = 30;
    return { score, longRatio };
  } catch (e) {
    return { score: 0, longRatio: 0.5, error: e.message };
  }
}

async function getOIScore(symbol) {
  try {
    const res = await fetch(
      `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol.toUpperCase().replace('USDT', '')}USDT&period=1h&limit=2`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return { score: 0, oiChange: 0 };
    const data = await res.json();
    if (!Array.isArray(data) || data.length < 2) return { score: 0, oiChange: 0 };
    const prevOI = parseFloat(data[0].sumOpenInterest);
    const curOI = parseFloat(data[1].sumOpenInterest);
    const oiChange = prevOI > 0 ? ((curOI - prevOI) / prevOI) * 100 : 0;

    // 별도로 가격 변화 확인 필요 — 여기서는 OI 증감 자체만 리턴
    let score = 0;
    if (oiChange > 5) score = 40;       // OI 급증 (방향은 가격으로 결정)
    else if (oiChange > 2) score = 20;
    else if (oiChange < -5) score = 0;   // OI 감소 → 관망
    else if (oiChange < -2) score = 0;
    return { score, oiChange };
  } catch (e) {
    return { score: 0, oiChange: 0, error: e.message };
  }
}

async function getOnchainScore(symbol) {
  const [funding, longShort, oi] = await Promise.all([
    getFundingScore(symbol),
    getLongShortScore(symbol),
    getOIScore(symbol),
  ]);

  // OI 방향을 funding/longShort 방향과 결합
  let oiDirectional = 0;
  if (oi.oiChange > 2) {
    // OI 증가 시 펀딩 방향의 반대 (과열 역발상)
    oiDirectional = funding.score > 0 ? oi.score : -oi.score;
  }

  const totalScore = Math.max(-180, Math.min(180, funding.score + longShort.score + oiDirectional));

  return {
    totalScore,
    funding: { score: funding.score, rate: funding.rate },
    longShort: { score: longShort.score, ratio: longShort.longRatio },
    oi: { score: oiDirectional, change: oi.oiChange },
  };
}

// ── 앙상블 투표 시스템 (그룹화 독립성 보장) ──

function ensembleVote(candles) {
  if (!Array.isArray(candles) || candles.length < 60) {
    return { action: 'HOLD', confidence: 0, votes: { buy: 0, sell: 0, hold: 0 }, voters: [] };
  }

  // 유사 전략 그룹화: 각 그룹에서 과반 방향 1표만 행사 (독립성 확보)
  const STRATEGY_GROUPS = {
    mean_reversion: ['rsi_reversal', 'bb_bounce', 'mean_reversion', 'pivot_points'],
    trend_following: ['ema_cross', 'macd_signal', 'momentum', 'cross_momentum'],
    breakout: ['breakout', 'volatility_breakout', 'squeeze'],
    composite: ['confluence', 'vol_regime', 'grid_trading'],
    contrarian: ['funding_extreme', 'funding_arb', 'crash_bounce'],
    cross_asset: ['btc_lead'],
  };

  const strategyNames = Object.keys(backtestStrategies);
  const voters = [];
  const rawVotes = {}; // 전략별 원시 투표

  for (const name of strategyNames) {
    const strat = backtestStrategies[name];
    if (strat.needsBtcCandles) {
      rawVotes[name] = 'HOLD';
      voters.push(`${name}:HOLD`);
      continue;
    }

    try {
      const signals = strat.generate(candles);
      if (!signals || signals.length === 0) {
        rawVotes[name] = 'HOLD';
        voters.push(`${name}:HOLD`);
        continue;
      }

      const lastSignal = signals[signals.length - 1];
      if (lastSignal.index >= candles.length - 10) {
        rawVotes[name] = lastSignal.action;
        voters.push(`${name}:${lastSignal.action}`);
      } else {
        rawVotes[name] = 'HOLD';
        voters.push(`${name}:HOLD`);
      }
    } catch {
      rawVotes[name] = 'HOLD';
      voters.push(`${name}:HOLD`);
    }
  }

  // 그룹별 투표 집계: 각 그룹에서 과반 방향 1표
  let buyVotes = 0, sellVotes = 0, holdVotes = 0;
  const groupVotes = {};
  const assignedStrategies = new Set();

  for (const [groupName, members] of Object.entries(STRATEGY_GROUPS)) {
    let gBuy = 0, gSell = 0, gHold = 0;
    for (const m of members) {
      if (rawVotes[m] === 'BUY') gBuy++;
      else if (rawVotes[m] === 'SELL') gSell++;
      else gHold++;
      assignedStrategies.add(m);
    }
    let groupAction = 'HOLD';
    if (gBuy > gSell && gBuy > gHold) groupAction = 'BUY';
    else if (gSell > gBuy && gSell > gHold) groupAction = 'SELL';

    groupVotes[groupName] = groupAction;
    if (groupAction === 'BUY') buyVotes++;
    else if (groupAction === 'SELL') sellVotes++;
    else holdVotes++;
  }

  // 미분류 전략 개별 투표
  for (const [name, vote] of Object.entries(rawVotes)) {
    if (assignedStrategies.has(name)) continue;
    if (vote === 'BUY') buyVotes++;
    else if (vote === 'SELL') sellVotes++;
    else holdVotes++;
  }

  const totalGroups = Object.keys(STRATEGY_GROUPS).length;
  const majorityThreshold = Math.ceil(totalGroups * 0.6); // 6그룹 중 4+ 필요
  const weakMajority = Math.ceil(totalGroups * 0.5);       // 3+ 필요

  let action = 'HOLD';
  let confidence = 0;

  if (buyVotes >= majorityThreshold) {
    action = 'BUY';
    confidence = Math.round((buyVotes / totalGroups) * 100);
  } else if (sellVotes >= majorityThreshold) {
    action = 'SELL';
    confidence = Math.round((sellVotes / totalGroups) * 100);
  } else if (buyVotes >= weakMajority && sellVotes <= 1) {
    action = 'BUY';
    confidence = Math.round((buyVotes / totalGroups) * 60);
  } else if (sellVotes >= weakMajority && buyVotes <= 1) {
    action = 'SELL';
    confidence = Math.round((sellVotes / totalGroups) * 60);
  }

  return {
    action,
    confidence,
    votes: { buy: buyVotes, sell: sellVotes, hold: holdVotes },
    groupVotes,
    voters,
    totalGroups,
    majorityThreshold,
  };
}

// ── 리스크 패리티 ──

function riskParity(strategyResults) {
  if (!Array.isArray(strategyResults) || strategyResults.length === 0) {
    return {};
  }

  const weights = {};
  let sumInvVol = 0;

  for (const result of strategyResults) {
    if (!result || result.error || !result.trades || result.trades.length < 3) {
      weights[result.strategy] = 0;
      continue;
    }

    // 수익률의 표준편차(변동성) 계산
    const returns = result.trades.map(t => t.pnlPct || 0);
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
    const volatility = Math.sqrt(variance);

    if (volatility > 0) {
      const invVol = 1 / volatility;
      weights[result.strategy] = invVol;
      sumInvVol += invVol;
    } else {
      weights[result.strategy] = 0;
    }
  }

  // 정규화: weight = (1/volatility) / sum(1/volatility)
  if (sumInvVol > 0) {
    for (const key of Object.keys(weights)) {
      weights[key] = Math.round((weights[key] / sumInvVol) * 1000) / 1000;
    }
  }

  return weights;
}

// ── 오더북 불균형 점수 (바이낸스 depth API) ──

async function getOrderbookImbalance(symbol) {
  const pair = symbol.toUpperCase().replace('USDT', '') + 'USDT';
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/depth?symbol=${pair}&limit=20`,
      { signal: AbortSignal.timeout(2000) }
    );
    if (!res.ok) return { score: 0, bidTotal: 0, askTotal: 0, ratio: 1.0, interpretation: '조회 실패' };
    const data = await res.json();

    let bidTotal = 0, askTotal = 0;
    for (const [, qty] of (data.bids || [])) bidTotal += parseFloat(qty);
    for (const [, qty] of (data.asks || [])) askTotal += parseFloat(qty);

    const ratio = askTotal > 0 ? bidTotal / askTotal : 1.0;
    let score = 0;
    let interpretation = '균형';

    if (ratio > 2.0) { score = 70; interpretation = '강한 매수 압력 (bid 2x+)'; }
    else if (ratio > 1.5) { score = 50; interpretation = '매수 우세 (bid 1.5x+)'; }
    else if (ratio > 1.2) { score = 25; interpretation = '약간 매수 우세'; }
    else if (ratio < 0.5) { score = -70; interpretation = '강한 매도 압력 (ask 2x+)'; }
    else if (ratio < 0.67) { score = -50; interpretation = '매도 우세 (ask 1.5x+)'; }
    else if (ratio < 0.83) { score = -25; interpretation = '약간 매도 우세'; }

    return {
      score,
      bidTotal: Math.round(bidTotal * 100) / 100,
      askTotal: Math.round(askTotal * 100) / 100,
      ratio: Math.round(ratio * 1000) / 1000,
      bidRatio: bidTotal / (bidTotal + askTotal || 1),
      askRatio: askTotal / (bidTotal + askTotal || 1),
      interpretation,
    };
  } catch (e) {
    return { score: 0, bidTotal: 0, askTotal: 0, ratio: 1.0, interpretation: `에러: ${e.message}` };
  }
}

// ── 거래소 유입/유출 프록시 ──

function getExchangeFlowProxy(candles) {
  if (!candles || candles.length < 20) return { score: 0, interpretation: '데이터 부족' };

  const last = candles.length - 1;
  const recentVol = candles.slice(-5).reduce((s, c) => s + c.v, 0) / 5;
  const avgVol = candles.slice(-20).reduce((s, c) => s + c.v, 0) / 20;
  const volSpike = avgVol > 0 ? recentVol / avgVol : 1;

  const recentChange = ((candles[last].c - candles[last - 4].c) / candles[last - 4].c) * 100;

  let score = 0;
  let interpretation = '정상';

  // 대량 거래 + 가격 하락 = 거래소 유입 추정 → 약세
  if (volSpike > 1.8 && recentChange < -1.5) {
    score = -60;
    interpretation = `거래소 유입 추정 (볼륨 ${volSpike.toFixed(1)}x, ${recentChange.toFixed(1)}%)`;
  } else if (volSpike > 1.5 && recentChange < -1) {
    score = -35;
    interpretation = `약한 유입 추정 (볼륨 ${volSpike.toFixed(1)}x, ${recentChange.toFixed(1)}%)`;
  }
  // 대량 거래 + 가격 상승 = 거래소 유출 추정 → 강세
  else if (volSpike > 1.8 && recentChange > 1.5) {
    score = 60;
    interpretation = `거래소 유출 추정 (볼륨 ${volSpike.toFixed(1)}x, +${recentChange.toFixed(1)}%)`;
  } else if (volSpike > 1.5 && recentChange > 1) {
    score = 35;
    interpretation = `약한 유출 추정 (볼륨 ${volSpike.toFixed(1)}x, +${recentChange.toFixed(1)}%)`;
  }

  return { score, volSpike: Math.round(volSpike * 100) / 100, priceChange: Math.round(recentChange * 100) / 100, interpretation };
}

// ── 마켓 레짐 분류기 (ADX + 볼린저 + 거래량) ──

function classifyRegime(candles) {
  if (!candles || candles.length < 60) return { regime: 'UNKNOWN', label: '데이터 부족', suggestedStrategy: 'hold' };

  const closes = candles.map(c => c.c);
  const volumes = candles.map(c => c.v);
  const last = closes.length - 1;

  // ADX 계산
  const { adx: adxFn } = require('./backtester');
  const adxValues = adxFn(candles, 14);
  const curADX = adxValues[last];

  // EMA20
  const { ema: emaFn } = require('./backtester');
  const ema20 = emaFn(closes, 20);

  // 볼린저 밴드
  const bb = bollingerBands(closes, 20, 2);
  const bbWidth = bb.upper[last] && bb.lower[last] ? (bb.upper[last] - bb.lower[last]) / bb.middle[last] * 100 : 0;

  // 볼린저 폭 평균 (50봉)
  let bbWidthAvg = 0, bbWidthCount = 0;
  for (let i = Math.max(0, last - 50); i < last; i++) {
    if (bb.upper[i] && bb.lower[i] && bb.middle[i]) {
      bbWidthAvg += (bb.upper[i] - bb.lower[i]) / bb.middle[i] * 100;
      bbWidthCount++;
    }
  }
  bbWidthAvg = bbWidthCount > 0 ? bbWidthAvg / bbWidthCount : bbWidth;

  // ATR 비율
  const { atr: atrFn } = require('./backtester');
  const atrValues = atrFn(candles, 14);
  const curATR = atrValues[last];
  let atrAvg = 0, atrCount = 0;
  for (let i = Math.max(0, last - 50); i < last; i++) {
    if (atrValues[i] !== null) { atrAvg += atrValues[i]; atrCount++; }
  }
  atrAvg = atrCount > 0 ? atrAvg / atrCount : curATR;
  const atrRatio = atrAvg > 0 ? curATR / atrAvg : 1;

  // 거래량 추세
  const vol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const vol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  const volTrend = vol20 > 0 ? vol5 / vol20 : 1;

  const priceAboveEma20 = closes[last] > ema20[last];

  let regime, label, suggestedStrategy;

  if (curADX !== null && curADX > 25 && priceAboveEma20 && volTrend > 1.0) {
    regime = 'TRENDING_UP';
    label = `상승 추세 (ADX ${curADX.toFixed(0)}, 가격>EMA20, 거래량 증가)`;
    suggestedStrategy = 'trend_follow_long';
  } else if (curADX !== null && curADX > 25 && !priceAboveEma20 && volTrend > 1.0) {
    regime = 'TRENDING_DOWN';
    label = `하락 추세 (ADX ${curADX.toFixed(0)}, 가격<EMA20, 거래량 증가)`;
    suggestedStrategy = 'trend_follow_short';
  } else if (curADX !== null && curADX < 20 && bbWidth < bbWidthAvg * 0.7) {
    regime = 'RANGING';
    label = `횡보장 (ADX ${curADX ? curADX.toFixed(0) : '?'}, BB 폭 좁음 ${bbWidth.toFixed(1)}%)`;
    suggestedStrategy = 'mean_reversion';
  } else if (atrRatio > 1.8 || bbWidth > bbWidthAvg * 1.5) {
    regime = 'VOLATILE';
    label = `고변동성 (ATR ${atrRatio.toFixed(1)}x, BB ${bbWidth.toFixed(1)}%)`;
    suggestedStrategy = 'volatility_breakout';
  } else {
    regime = 'NORMAL';
    label = `보통 (ADX ${curADX ? curADX.toFixed(0) : '?'}, BB ${bbWidth.toFixed(1)}%)`;
    suggestedStrategy = 'balanced';
  }

  return {
    regime,
    label,
    suggestedStrategy,
    adx: curADX ? Math.round(curADX * 10) / 10 : null,
    bbWidth: Math.round(bbWidth * 100) / 100,
    bbWidthAvg: Math.round(bbWidthAvg * 100) / 100,
    atrRatio: Math.round(atrRatio * 100) / 100,
    volTrend: Math.round(volTrend * 100) / 100,
    priceAboveEma20,
  };
}

// ── 멀티코인 모멘텀 순위 ──

async function getCrossMomentum(symbols) {
  if (!symbols) symbols = ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE', 'LINK', 'SUI', 'PEPE', 'WIF', 'TON'];

  const results = [];
  for (const sym of symbols) {
    try {
      const pair = sym.toUpperCase().replace('USDT', '') + 'USDT';
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=1d&limit=8`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) continue;
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length < 2) continue;

      const firstClose = parseFloat(raw[0][4]);
      const lastClose = parseFloat(raw[raw.length - 1][4]);
      const roc7d = firstClose > 0 ? ((lastClose - firstClose) / firstClose) * 100 : 0;

      // 3일 ROC
      const mid = raw.length >= 4 ? parseFloat(raw[raw.length - 4][4]) : firstClose;
      const roc3d = mid > 0 ? ((lastClose - mid) / mid) * 100 : 0;

      results.push({
        symbol: sym,
        price: lastClose,
        roc7d: Math.round(roc7d * 100) / 100,
        roc3d: Math.round(roc3d * 100) / 100,
        momentum: Math.round((roc7d * 0.6 + roc3d * 0.4) * 100) / 100,
      });
    } catch {}
  }

  results.sort((a, b) => b.momentum - a.momentum);

  return {
    ranking: results,
    topLong: results.slice(0, 3),
    topShort: results.slice(-3).reverse(),
    timestamp: new Date().toISOString(),
  };
}

// ── 멀티코인 펀딩레이트 조회 ──

async function getMultiFunding(symbols) {
  if (!symbols) symbols = ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE', 'LINK', 'SUI', 'PEPE', 'WIF', 'TON'];

  const results = [];
  for (const sym of symbols) {
    try {
      const pair = sym.toUpperCase().replace('USDT', '') + 'USDT';
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${pair}`,
        { signal: AbortSignal.timeout(3000) }
      );
      if (!res.ok) continue;
      const data = await res.json();
      const rate = parseFloat(data.lastFundingRate || 0);
      const nextTime = data.nextFundingTime ? new Date(data.nextFundingTime).toISOString() : null;

      let signal = 'neutral';
      if (rate > 0.001) signal = 'short_opportunity';
      else if (rate > 0.0005) signal = 'slightly_overheated';
      else if (rate < -0.001) signal = 'long_opportunity';
      else if (rate < -0.0005) signal = 'slightly_oversold';

      results.push({
        symbol: sym,
        rate: Math.round(rate * 10000) / 100, // 백분율
        annualized: Math.round(rate * 3 * 365 * 10000) / 100, // 연환산 %
        signal,
        nextFunding: nextTime,
      });
    } catch {}
  }

  results.sort((a, b) => Math.abs(b.rate) - Math.abs(a.rate));
  return { rates: results, timestamp: new Date().toISOString() };
}

// ── 시간대별 승률 (learner 데이터 기반) ──

function getHourlyWinRates() {
  try {
    const learnerMod = require('./learner');
    const lessons = learnerMod.loadLessons();
    if (!lessons || lessons.length < 10) return null;

    const hourStats = {};
    for (const l of lessons) {
      if (l.hourUtc == null) continue;
      if (!hourStats[l.hourUtc]) hourStats[l.hourUtc] = { wins: 0, total: 0 };
      hourStats[l.hourUtc].total++;
      if (l.isWin) hourStats[l.hourUtc].wins++;
    }

    const result = {};
    for (const [hour, s] of Object.entries(hourStats)) {
      if (s.total >= 3) {
        result[hour] = {
          winRate: Math.round(s.wins / s.total * 1000) / 10,
          total: s.total,
          wins: s.wins,
        };
      }
    }

    // 최적/최악 시간대 판별
    const entries = Object.entries(result).sort((a, b) => b[1].winRate - a[1].winRate);
    const bestHours = entries.filter(([, s]) => s.winRate >= 55).map(([h]) => parseInt(h));
    const worstHours = entries.filter(([, s]) => s.winRate < 35 && s.total >= 5).map(([h]) => parseInt(h));

    return { hourStats: result, bestHours, worstHours };
  } catch {
    return null;
  }
}

// ── 시간 가중 진입 점수 ──

function getTimeWeightScore() {
  const hourData = getHourlyWinRates();
  if (!hourData) return { score: 0, isBestHour: false, isWorstHour: false, currentHour: new Date().getUTCHours() };

  const currentHour = new Date().getUTCHours();
  const isBestHour = hourData.bestHours.includes(currentHour);
  const isWorstHour = hourData.worstHours.includes(currentHour);

  let score = 0;
  if (isBestHour) score = 10;
  if (isWorstHour) score = -10;

  return { score, isBestHour, isWorstHour, currentHour, bestHours: hourData.bestHours, worstHours: hourData.worstHours };
}

// ── ATR 기반 동적 SL/TP 계산 ──

async function getATRStops(symbol, direction) {
  const pair = symbol.toUpperCase().replace('USDT', '') + 'USDT';
  try {
    // 4h 캔들로 ATR 계산 (1h는 ATR이 너무 작아 SL 0.2%로 노이즈에 걸림)
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=4h&limit=50`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length < 20) return null;

    const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    const { atr: atrFn } = require('./backtester');
    const atrValues = atrFn(candles, 14);
    const lastATR = atrValues[candles.length - 1];
    if (!lastATR || lastATR <= 0) return null;

    const price = candles[candles.length - 1].c;
    // 4h ATR 기반 → 자연스럽게 넓은 SL (BTC 기준 ~1-2%)
    const slDist = lastATR * 1.5; // 4h ATR × 1.5
    const tpDist = lastATR * 2.5; // 4h ATR × 2.5 (R:R ~1.67)

    let slPrice, tpPrice;
    if (direction === 'BUY') {
      slPrice = price - slDist;
      tpPrice = price + tpDist;
    } else {
      slPrice = price + slDist;
      tpPrice = price - tpDist;
    }

    return {
      atr14: Math.round(lastATR * 100) / 100,
      slDist: Math.round(slDist * 100) / 100,
      tpDist: Math.round(tpDist * 100) / 100,
      slPrice: Math.round(slPrice * 100) / 100,
      tpPrice: Math.round(tpPrice * 100) / 100,
      slPct: Math.round(slDist / price * 10000) / 100,
      tpPct: Math.round(tpDist / price * 10000) / 100,
      price: Math.round(price * 100) / 100,
    };
  } catch (e) {
    return null;
  }
}

// ── 급락 반등 감지기 (실시간 P1-P4) ──

async function detectCrashBounce(symbol) {
  const pair = symbol.toUpperCase().replace('USDT', '') + 'USDT';
  try {
    // 1h 캔들 48봉 (2일)
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=1h&limit=48`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return null;
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length < 24) return null;

    const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    const closes = candles.map(c => c.c);
    const lows = candles.map(c => c.l);
    const highs = candles.map(c => c.h);
    const volumes = candles.map(c => c.v);
    const last = candles.length - 1;
    const price = closes[last];

    // 24h 고점에서 낙폭
    const h24Start = Math.max(0, last - 24);
    let peak24h = -Infinity;
    for (let j = h24Start; j <= last; j++) { if (highs[j] > peak24h) peak24h = highs[j]; }
    const drop24h = ((price - peak24h) / peak24h) * 100;

    if (drop24h > -6) return { detected: false, drop24h, symbol }; // 최소 6% 하락

    // 3h 저점에서 반등률
    const low3h = Math.min(lows[last], lows[last - 1] || Infinity, lows[last - 2] || Infinity);
    const bounce3h = low3h > 0 ? ((price - low3h) / low3h) * 100 : 0;

    // 6h 저점에서 반등률
    let low6h = Infinity;
    for (let j = Math.max(0, last - 6); j <= last; j++) { if (lows[j] < low6h) low6h = lows[j]; }
    const bounce6h = low6h > 0 ? ((price - low6h) / low6h) * 100 : 0;

    // 거래량 급증
    const vol5 = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;
    const vol20 = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const volSpike = vol20 > 0 ? vol5 / vol20 : 1;

    // RSI
    const { rsi: rsiFn } = require('./backtester');
    const rsiValues = rsiFn(closes, 14);
    const curRsi = rsiValues[last];

    // 더블바텀
    const { atr: atrFn } = require('./backtester');
    const atrValues = atrFn(candles, 14);
    const curATR = atrValues[last] || price * 0.02;
    let hasDoubleBottom = false;
    for (let j = 0; j < last - 6; j++) {
      if (Math.abs(lows[j] - low6h) < curATR * 0.5) { hasDoubleBottom = true; break; }
    }

    // P1-P4 판정
    const p1 = drop24h <= -8 && bounce3h >= 1;
    const p2 = drop24h <= -10 && bounce6h >= 2 && volSpike >= 1.5;
    const p3 = drop24h <= -8 && hasDoubleBottom && curRsi !== null && curRsi < 35;
    const p4 = p1 && p2 && p3;

    let pattern = null;
    if (p4) pattern = 'P4';
    else if (p3) pattern = 'P3';
    else if (p2) pattern = 'P2';
    else if (p1) pattern = 'P1';

    // 진입 레벨 계산
    let entry = null, sl = null, tp = null;
    if (pattern) {
      const rrMult = { P1: 1.0, P2: 1.2, P3: 1.3, P4: 1.5 }[pattern];
      entry = price;
      sl = price - curATR * 1.5;
      tp = price + curATR * 3.0 * rrMult;
    }

    return {
      detected: !!pattern,
      symbol,
      pattern,
      drop24h: Math.round(drop24h * 100) / 100,
      bounce3h: Math.round(bounce3h * 100) / 100,
      bounce6h: Math.round(bounce6h * 100) / 100,
      volSpike: Math.round(volSpike * 100) / 100,
      rsi: curRsi !== null ? Math.round(curRsi * 10) / 10 : null,
      hasDoubleBottom,
      p1, p2, p3, p4,
      entry, sl, tp,
      confidence: pattern === 'P4' ? 85 : pattern === 'P3' ? 75 : pattern === 'P2' ? 65 : 55,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    return { detected: false, error: e.message, symbol };
  }
}

// ── 급등락 실시간 감지 (5분 패스트스캔) ──

async function fastScanVolatility(symbols) {
  if (!symbols) symbols = ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE', 'LINK', 'SUI', 'PEPE', 'WIF', 'TON'];

  const alerts = [];
  for (const sym of symbols) {
    try {
      const pair = sym + 'USDT';
      const res = await fetch(
        `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=5m&limit=12`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) continue;
      const raw = await res.json();
      if (!Array.isArray(raw) || raw.length < 6) continue;

      const candles = raw.map(k => ({ o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
      const last = candles.length - 1;
      const price = candles[last].c;

      // 15분 변동 (3봉)
      const price15m = candles[Math.max(0, last - 3)].o;
      const change15m = ((price - price15m) / price15m) * 100;

      // 30분 변동 (6봉)
      const price30m = candles[Math.max(0, last - 6)].o;
      const change30m = ((price - price30m) / price30m) * 100;

      // 1시간 변동 (12봉)
      const price1h = candles[0].o;
      const change1h = ((price - price1h) / price1h) * 100;

      // 거래량 급증
      const recentVol = candles.slice(-3).reduce((s, c) => s + c.v, 0) / 3;
      const avgVol = candles.reduce((s, c) => s + c.v, 0) / candles.length;
      const volRatio = avgVol > 0 ? recentVol / avgVol : 1;

      let alertType = null;
      if (Math.abs(change15m) >= 2) alertType = 'FLASH_MOVE';
      else if (Math.abs(change30m) >= 3) alertType = 'RAPID_MOVE';
      else if (Math.abs(change1h) >= 5) alertType = 'HOURLY_CRASH';
      else if (volRatio >= 3) alertType = 'VOL_SPIKE';

      if (alertType) {
        alerts.push({
          symbol: sym,
          alertType,
          price,
          change15m: Math.round(change15m * 100) / 100,
          change30m: Math.round(change30m * 100) / 100,
          change1h: Math.round(change1h * 100) / 100,
          volRatio: Math.round(volRatio * 100) / 100,
          direction: change15m > 0 ? 'UP' : 'DOWN',
          suggestedAction: change15m < -2 ? 'WATCH_LONG' : change15m > 2 ? 'WATCH_SHORT' : 'MONITOR',
        });
      }
    } catch {}
  }

  alerts.sort((a, b) => Math.abs(b.change15m) - Math.abs(a.change15m));
  return { alerts, scannedAt: new Date().toISOString() };
}

// ── 그리드 레벨 계산 ──

async function getGridLevels(symbol, gridCount = 5) {
  const pair = symbol.toUpperCase().replace('USDT', '') + 'USDT';
  try {
    const res = await fetch(
      `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=1h&limit=100`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const raw = await res.json();
    if (!Array.isArray(raw) || raw.length < 60) return null;

    const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    const closes = candles.map(c => c.c);
    const last = closes.length - 1;
    const price = closes[last];

    const bb = bollingerBands(closes, 20, 2);
    if (!bb.upper[last] || !bb.lower[last]) return null;

    const { adx: adxFn } = require('./backtester');
    const adxValues = adxFn(candles, 14);
    const curAdx = adxValues[last];

    const upper = bb.upper[last];
    const lower = bb.lower[last];
    const range = upper - lower;
    const step = range / gridCount;

    const levels = [];
    for (let g = 0; g <= gridCount; g++) {
      const levelPrice = lower + step * g;
      const pct = ((levelPrice - price) / price * 100);
      levels.push({
        level: g,
        price: Math.round(levelPrice * 100) / 100,
        distPct: Math.round(pct * 100) / 100,
        action: g <= 1 ? 'BUY' : g >= gridCount - 1 ? 'SELL' : 'HOLD',
      });
    }

    return {
      symbol,
      currentPrice: Math.round(price * 100) / 100,
      gridRange: { upper: Math.round(upper * 100) / 100, lower: Math.round(lower * 100) / 100 },
      gridStep: Math.round(step * 100) / 100,
      gridStepPct: Math.round(step / price * 10000) / 100,
      levels,
      adx: curAdx ? Math.round(curAdx * 10) / 10 : null,
      isGoodForGrid: curAdx !== null && curAdx < 25, // 횡보장에서만 그리드 추천
    };
  } catch (e) {
    return null;
  }
}

module.exports = {
  generateSignal,
  calculatePositionSize,
  mergeSignals,
  getSignalForSymbol,
  getMultiTFSignal,
  // 온체인 점수
  getFundingScore,
  getLongShortScore,
  getOIScore,
  getOnchainScore,
  // 앙상블 & 리스크 패리티
  ensembleVote,
  riskParity,
  // 지표 함수 내보내기
  stochRsi,
  obvSlope,
  ichimoku,
  detectCandlePatterns,
  // 2026 신규: 오더북, 유입유출, 레짐, 크로스모멘텀, 펀딩
  getOrderbookImbalance,
  getExchangeFlowProxy,
  classifyRegime,
  getCrossMomentum,
  getMultiFunding,
  // 시간 가중 + ATR 동적 SL/TP
  getHourlyWinRates,
  getTimeWeightScore,
  getATRStops,
  // 강화: 급락반등 + 패스트스캔 + 그리드
  detectCrashBounce,
  fastScanVolatility,
  getGridLevels,
};
