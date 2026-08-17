'use strict';

/**
 * Learner v2 — 극한 자기학습 트레이딩 패턴 분석 엔진
 *
 * trade-lessons.json에서 거래 데이터를 분석하여
 * learned-rules.json에 패턴/규칙/자동조정 제안을 저장.
 * ACE/BLITZ/GUARD 프롬프트에 주입되어 AI가 점점 똑똑해지는 구조.
 *
 * v2 추가:
 * - 캔들 패턴 학습 (연속봉, 도지, 해머, 핀바, 엔걸핑)
 * - 지지/저항 레벨 학습
 * - 연속 거래 패턴 (연승/연패 후 승률)
 * - R:R 최적화 (실제 달성 R:R vs 설정)
 * - 보유 시간 최적화
 * - 멀티TF 확인 학습
 * - 자동 전략 조정 제안 (suggestions)
 * - 시간 가중치 (최근 30일 2x, 90일+ 0.5x)
 * - BLITZ/GUARD 프롬프트 주입
 * - 학습 리포트 강화 (추이, 개선/약점)
 */

const fs = require('fs');
const path = require('path');

const LESSONS_FILE = path.join(__dirname, '..', 'reports', 'trade-lessons.json');
const RULES_FILE = path.join(__dirname, '..', 'reports', 'learned-rules.json');

// ── Lesson 저장/로드 ──
function loadLessons() {
  try {
    if (fs.existsSync(LESSONS_FILE)) {
      return JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[learner] lesson 로드 실패:', e.message);
  }
  return [];
}

function saveLessons(lessons) {
  try {
    const dir = path.dirname(LESSONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(lessons, null, 2), 'utf-8');
  } catch (e) {
    console.error('[learner] lesson 저장 실패:', e.message);
  }
}

function appendLesson(lesson) {
  const lessons = loadLessons();
  lessons.push(lesson);
  // 90일 이상 오래된 데이터 아카이브 + 최근 300건만 유지
  const cutoff90d = Date.now() - 90 * 86400000;
  const archivable = lessons.filter(l => l.exitTs && l.exitTs < cutoff90d);
  if (archivable.length > 0) {
    try {
      const archivePath = path.join(path.dirname(LESSONS_FILE), 'trade-lessons-archive.json');
      let archive = [];
      if (fs.existsSync(archivePath)) { try { archive = JSON.parse(fs.readFileSync(archivePath, 'utf-8')); } catch {} }
      archive.push(...archivable);
      fs.writeFileSync(archivePath, JSON.stringify(archive, null, 2), 'utf-8');
    } catch {}
  }
  const active = lessons.filter(l => !l.exitTs || l.exitTs >= cutoff90d);
  if (active.length > 300) active.splice(0, active.length - 300);
  lessons.length = 0;
  lessons.push(...active);
  saveLessons(lessons);
  console.log(`[learner] 학습 데이터 기록: ${lesson.symbol} ${lesson.direction} ${lesson.isWin ? 'WIN' : 'LOSS'} (총 ${lessons.length}건)`);
  return lessons.length;
}

// ── Rules 저장/로드 ──
function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[learner] rules 로드 실패:', e.message);
  }
  return null;
}

function saveRules(rules) {
  try {
    const dir = path.dirname(RULES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), 'utf-8');
  } catch (e) {
    console.error('[learner] rules 저장 실패:', e.message);
  }
}

// ── 헬퍼 ──
const isLongDir = d => d === 'BUY' || d === 'LONG';
const isShortDir = d => d === 'SELL' || d === 'SHORT';

function winRate(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.filter(l => l.isWin).length / arr.length * 1000) / 10;
}

// 시간 가중 승률: 최근 30일 2x, 30-90일 1x, 90일+ 0.5x
function weightedWinRate(arr) {
  if (!arr.length) return 0;
  const now = Date.now();
  let wWins = 0, wTotal = 0;
  for (const l of arr) {
    const ageDays = l.timestamp ? (now - new Date(l.timestamp).getTime()) / 86400000 : 60;
    const w = ageDays <= 30 ? 2.0 : ageDays <= 90 ? 1.0 : 0.5;
    wTotal += w;
    if (l.isWin) wWins += w;
  }
  return wTotal > 0 ? Math.round(wWins / wTotal * 1000) / 10 : 0;
}

function avgPnl(arr) {
  if (!arr.length) return 0;
  return Math.round(arr.reduce((s, l) => s + (l.pnl || 0), 0) / arr.length * 100) / 100;
}

// ── 시간대 분류 ──
function getSessionKey(hourUtc) {
  if (hourUtc >= 0 && hourUtc < 8) return 'asia';
  if (hourUtc >= 8 && hourUtc < 16) return 'europe';
  return 'us';
}

// ── 캔들 패턴 분석 (진입 시점 최근 5봉) ──
function analyzeCandlePattern(candles) {
  if (!candles || candles.length < 2) return null;

  const recent = candles.slice(-5);
  const last = recent[recent.length - 1];
  const prev = recent.length >= 2 ? recent[recent.length - 2] : null;

  const body = Math.abs(last.c - last.o);
  const range = last.h - last.l;
  if (range === 0) return null;

  const bodyRatio = Math.round(body / range * 100) / 100;
  const upperWick = Math.round((last.h - Math.max(last.o, last.c)) / range * 100) / 100;
  const lowerWick = Math.round((Math.min(last.o, last.c) - last.l) / range * 100) / 100;
  const isBullish = last.c > last.o;

  // 연속 양봉/음봉 카운트
  let consecutive = 0;
  let consecutiveDir = null;
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i];
    const bull = c.c > c.o;
    if (consecutiveDir === null) {
      consecutiveDir = bull ? 'bull' : 'bear';
      consecutive = 1;
    } else if ((bull && consecutiveDir === 'bull') || (!bull && consecutiveDir === 'bear')) {
      consecutive++;
    } else {
      break;
    }
  }

  // 패턴 분류
  let pattern = 'normal';
  if (bodyRatio < 0.1) {
    pattern = 'doji'; // 도지: 몸통 < 10%
  } else if (lowerWick >= 0.6 && bodyRatio <= 0.3) {
    pattern = 'hammer'; // 해머: 아래꼬리 60%+, 몸통 30% 이하
  } else if (upperWick >= 0.6 && bodyRatio <= 0.3) {
    pattern = 'inverted_hammer'; // 역해머/슈팅스타
  } else if (lowerWick >= 0.5 && upperWick <= 0.1 && bodyRatio <= 0.4) {
    pattern = 'pin_bar_bull'; // 불리시 핀바
  } else if (upperWick >= 0.5 && lowerWick <= 0.1 && bodyRatio <= 0.4) {
    pattern = 'pin_bar_bear'; // 베어리시 핀바
  }

  // 엔걸핑 체크
  if (prev && bodyRatio > 0.5) {
    const prevBody = Math.abs(prev.c - prev.o);
    if (body > prevBody * 1.2) {
      const prevBull = prev.c > prev.o;
      if (isBullish && !prevBull) pattern = 'engulfing_bull';
      if (!isBullish && prevBull) pattern = 'engulfing_bear';
    }
  }

  return {
    consecutive,
    consecutiveDir,
    pattern,
    bodyRatio,
    upperWick,
    lowerWick,
  };
}

// ── 지지/저항 레벨 계산 (최근 20봉) ──
function findSupportResistance(candles) {
  if (!candles || candles.length < 10) return { supports: [], resistances: [] };

  const recent = candles.slice(-20);
  const tolerance = 0.003; // 0.3% 이내를 같은 레벨로

  // 저점 클러스터 (지지)
  const lows = recent.map(c => c.l).sort((a, b) => a - b);
  const supports = [];
  let i = 0;
  while (i < lows.length) {
    const level = lows[i];
    let count = 1;
    let sum = level;
    let j = i + 1;
    while (j < lows.length && (lows[j] - level) / level <= tolerance) {
      count++;
      sum += lows[j];
      j++;
    }
    if (count >= 2) {
      supports.push({ level: Math.round(sum / count * 100) / 100, touches: count });
    }
    i = j;
  }

  // 고점 클러스터 (저항)
  const highs = recent.map(c => c.h).sort((a, b) => a - b);
  const resistances = [];
  i = 0;
  while (i < highs.length) {
    const level = highs[i];
    let count = 1;
    let sum = level;
    let j = i + 1;
    while (j < highs.length && (highs[j] - level) / level <= tolerance) {
      count++;
      sum += highs[j];
      j++;
    }
    if (count >= 2) {
      resistances.push({ level: Math.round(sum / count * 100) / 100, touches: count });
    }
    i = j;
  }

  return {
    supports: supports.sort((a, b) => b.touches - a.touches).slice(0, 3),
    resistances: resistances.sort((a, b) => b.touches - a.touches).slice(0, 3),
  };
}

// 진입가가 지지/저항 근처인지 판단
function classifySRPosition(entryPrice, sr) {
  if (!sr || !entryPrice) return null;
  const tol = 0.005; // 0.5% 이내

  for (const s of (sr.supports || [])) {
    const dist = (entryPrice - s.level) / s.level;
    if (Math.abs(dist) <= tol) return 'near_support';
    if (dist < -tol) return 'below_support'; // 지지 이탈
  }
  for (const r of (sr.resistances || [])) {
    const dist = (entryPrice - r.level) / r.level;
    if (Math.abs(dist) <= tol) return 'near_resistance';
    if (dist > tol) return 'above_resistance'; // 저항 돌파
  }
  return 'mid_range';
}

// ── 메인 분석 엔진 ──
function analyzeLessons(lessons) {
  if (!lessons) lessons = loadLessons();
  const total = lessons.length;

  if (total < 5) {
    console.log(`[learner] 학습 데이터 부족 (${total}건 < 5건)`);
    return null;
  }

  const rules = [];
  const bestPatterns = [];
  const worstPatterns = [];
  const coinRules = {};

  // ═══ 1. RSI 구간별 승률 ═══
  const rsiBands = [
    { label: 'RSI < 30 (과매도)', filter: l => l.rsi != null && l.rsi < 30 },
    { label: 'RSI 30-45', filter: l => l.rsi != null && l.rsi >= 30 && l.rsi < 45 },
    { label: 'RSI 45-55 (중립)', filter: l => l.rsi != null && l.rsi >= 45 && l.rsi < 55 },
    { label: 'RSI 55-70', filter: l => l.rsi != null && l.rsi >= 55 && l.rsi < 70 },
    { label: 'RSI > 70 (과매수)', filter: l => l.rsi != null && l.rsi >= 70 },
  ];

  for (const band of rsiBands) {
    const longInBand = lessons.filter(l => band.filter(l) && isLongDir(l.direction));
    const shortInBand = lessons.filter(l => band.filter(l) && isShortDir(l.direction));

    if (longInBand.length >= 3) {
      const wr = weightedWinRate(longInBand);
      const action = wr >= 60 ? '적극 진입' : wr >= 45 ? '보통' : '진입 자제';
      rules.push(`${band.label}에서 롱 진입 시 승률 ${wr}% (${longInBand.length}건) — ${action}`);
      if (wr >= 65) bestPatterns.push({ condition: `${band.label} + 롱`, winRate: wr, samples: longInBand.length, avgPnl: avgPnl(longInBand) });
      if (wr <= 35) worstPatterns.push({ condition: `${band.label} + 롱`, winRate: wr, samples: longInBand.length, avgPnl: avgPnl(longInBand) });
    }
    if (shortInBand.length >= 3) {
      const wr = weightedWinRate(shortInBand);
      const action = wr >= 60 ? '적극 진입' : wr >= 45 ? '보통' : '진입 자제';
      rules.push(`${band.label}에서 숏 진입 시 승률 ${wr}% (${shortInBand.length}건) — ${action}`);
      if (wr >= 65) bestPatterns.push({ condition: `${band.label} + 숏`, winRate: wr, samples: shortInBand.length, avgPnl: avgPnl(shortInBand) });
      if (wr <= 35) worstPatterns.push({ condition: `${band.label} + 숏`, winRate: wr, samples: shortInBand.length, avgPnl: avgPnl(shortInBand) });
    }
  }

  // ═══ 2. 시간대별 승률 ═══
  const sessions = ['asia', 'europe', 'us'];
  const sessionLabels = { asia: '아시아(0-8 UTC)', europe: '유럽(8-16 UTC)', us: '미국(16-24 UTC)' };
  for (const sess of sessions) {
    const inSession = lessons.filter(l => l.hourUtc != null && getSessionKey(l.hourUtc) === sess);
    if (inSession.length >= 3) {
      const wr = weightedWinRate(inSession);
      const action = wr >= 60 ? '최적 시간대' : wr >= 45 ? '보통' : '주의';
      rules.push(`${sessionLabels[sess]} 거래 승률 ${wr}% (${inSession.length}건) — ${action}`);

      const longInSess = inSession.filter(l => isLongDir(l.direction));
      const shortInSess = inSession.filter(l => isShortDir(l.direction));
      if (longInSess.length >= 3 && shortInSess.length >= 3) {
        const longWr = weightedWinRate(longInSess);
        const shortWr = weightedWinRate(shortInSess);
        if (Math.abs(longWr - shortWr) >= 15) {
          const better = longWr > shortWr ? '롱' : '숏';
          rules.push(`${sessionLabels[sess]}에서 ${better} 선호 (롱 ${longWr}% vs 숏 ${shortWr}%)`);
        }
      }
    }
  }

  // ═══ 3. 코인별 방향 승률 ═══
  const coins = [...new Set(lessons.map(l => l.symbol))];
  for (const coin of coins) {
    const coinLessons = lessons.filter(l => l.symbol === coin);
    if (coinLessons.length < 3) continue;

    const longs = coinLessons.filter(l => isLongDir(l.direction));
    const shorts = coinLessons.filter(l => isShortDir(l.direction));
    const longWr = longs.length >= 2 ? weightedWinRate(longs) : null;
    const shortWr = shorts.length >= 2 ? weightedWinRate(shorts) : null;
    const totalWr = weightedWinRate(coinLessons);

    const hourCounts = {};
    for (const l of coinLessons.filter(l => l.isWin && l.hourUtc != null)) {
      hourCounts[l.hourUtc] = (hourCounts[l.hourUtc] || 0) + 1;
    }
    const bestHours = Object.entries(hourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([h]) => parseInt(h));

    // 패 시간대 찾기
    const lossHourCounts = {};
    for (const l of coinLessons.filter(l => !l.isWin && l.hourUtc != null)) {
      lossHourCounts[l.hourUtc] = (lossHourCounts[l.hourUtc] || 0) + 1;
    }
    const avoidHours = Object.entries(lossHourCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([h]) => parseInt(h))
      .filter(h => !bestHours.includes(h));

    const winTrades = coinLessons.filter(l => l.isWin);
    const avgWinPct = winTrades.length > 0
      ? Math.round(winTrades.reduce((s, l) => s + Math.abs(l.pnl || 0), 0) / winTrades.length * 100) / 100
      : 0;

    coinRules[coin] = {
      preferLong: longWr != null && shortWr != null ? longWr > shortWr : null,
      longWinRate: longWr,
      shortWinRate: shortWr,
      totalWinRate: totalWr,
      bestHours,
      avoidHours,
      avgWinPnl: avgWinPct,
      totalTrades: coinLessons.length,
    };

    if (longWr != null && shortWr != null && Math.abs(longWr - shortWr) >= 15) {
      const better = longWr > shortWr ? '롱' : '숏';
      const betterWr = longWr > shortWr ? longWr : shortWr;
      rules.push(`${coin}은 ${better} 선호 (롱 ${longWr}% vs 숏 ${shortWr}%)`);
      if (betterWr >= 65) bestPatterns.push({ condition: `${coin} + ${better}`, winRate: betterWr, samples: (longWr > shortWr ? longs : shorts).length, avgPnl: avgPnl(longWr > shortWr ? longs : shorts) });
    }
  }

  // ═══ 4. 변동성별 승률 ═══
  const highVol = lessons.filter(l => l.volatility24h != null && l.volatility24h > 5);
  const lowVol = lessons.filter(l => l.volatility24h != null && l.volatility24h < 2);

  if (highVol.length >= 3) {
    const wr = weightedWinRate(highVol);
    rules.push(`고변동성(>5%) 거래 승률 ${wr}% (${highVol.length}건) — ${wr >= 50 ? '기회 활용' : '리스크 주의'}`);
    if (wr <= 35) worstPatterns.push({ condition: '고변동성(>5%)', winRate: wr, samples: highVol.length, avgPnl: avgPnl(highVol) });
  }
  if (lowVol.length >= 3) {
    const wr = weightedWinRate(lowVol);
    rules.push(`저변동성(<2%) 거래 승률 ${wr}% (${lowVol.length}건) — ${wr >= 50 ? '안정적' : '관망 권장'}`);
    if (wr <= 35) worstPatterns.push({ condition: '저변동성(<2%)', winRate: wr, samples: lowVol.length, avgPnl: avgPnl(lowVol) });
  }

  // ═══ 5. 등급/확신도별 실제 승률 ═══
  for (const g of ['A', 'B', 'C', 'D']) {
    const graded = lessons.filter(l => l.grade === g);
    if (graded.length >= 3) {
      const wr = weightedWinRate(graded);
      rules.push(`등급 ${g} 실제 승률 ${wr}% (${graded.length}건)`);
    }
  }

  const confBands = [
    { label: '확신도 50-60%', filter: l => l.confidence >= 50 && l.confidence < 60 },
    { label: '확신도 60-70%', filter: l => l.confidence >= 60 && l.confidence < 70 },
    { label: '확신도 70%+', filter: l => l.confidence >= 70 },
  ];
  for (const band of confBands) {
    const filtered = lessons.filter(band.filter);
    if (filtered.length >= 3) {
      const wr = weightedWinRate(filtered);
      rules.push(`${band.label} 거래의 실제 승률 ${wr}% (${filtered.length}건)`);
      if (wr >= 70) bestPatterns.push({ condition: band.label, winRate: wr, samples: filtered.length, avgPnl: avgPnl(filtered) });
      if (wr <= 35) worstPatterns.push({ condition: band.label, winRate: wr, samples: filtered.length, avgPnl: avgPnl(filtered) });
    }
  }

  // ═══ 6. SMA 위치별 승률 ═══
  const aboveSma20 = lessons.filter(l => l.sma20Dist != null && l.sma20Dist > 0);
  const belowSma20 = lessons.filter(l => l.sma20Dist != null && l.sma20Dist < 0);

  if (aboveSma20.length >= 3) {
    const longAbove = aboveSma20.filter(l => isLongDir(l.direction));
    const shortAbove = aboveSma20.filter(l => isShortDir(l.direction));
    if (longAbove.length >= 2) rules.push(`가격 > SMA20에서 롱 승률 ${weightedWinRate(longAbove)}% (${longAbove.length}건)`);
    if (shortAbove.length >= 2) rules.push(`가격 > SMA20에서 숏 승률 ${weightedWinRate(shortAbove)}% (${shortAbove.length}건)`);
  }
  if (belowSma20.length >= 3) {
    const longBelow = belowSma20.filter(l => isLongDir(l.direction));
    const shortBelow = belowSma20.filter(l => isShortDir(l.direction));
    if (longBelow.length >= 2) rules.push(`가격 < SMA20에서 롱 승률 ${weightedWinRate(longBelow)}% (${longBelow.length}건)`);
    if (shortBelow.length >= 2) rules.push(`가격 < SMA20에서 숏 승률 ${weightedWinRate(shortBelow)}% (${shortBelow.length}건)`);
  }

  // ═══ 7. MACD 히스토그램 방향별 ═══
  const macdNeg = lessons.filter(l => l.macdHist != null && l.macdHist < 0);
  const macdPos = lessons.filter(l => l.macdHist != null && l.macdHist > 0);

  if (macdNeg.length >= 3) {
    const longInNeg = macdNeg.filter(l => isLongDir(l.direction));
    if (longInNeg.length >= 2) {
      const wr = weightedWinRate(longInNeg);
      rules.push(`MACD 히스토그램 음수에서 롱 진입 → 승률 ${wr}% (${longInNeg.length}건)${wr <= 35 ? ' — 매우 위험' : ''}`);
      if (wr <= 35) worstPatterns.push({ condition: 'MACD음수 + 롱', winRate: wr, samples: longInNeg.length, avgPnl: avgPnl(longInNeg) });
    }
  }
  if (macdPos.length >= 3) {
    const shortInPos = macdPos.filter(l => isShortDir(l.direction));
    if (shortInPos.length >= 2) {
      const wr = weightedWinRate(shortInPos);
      rules.push(`MACD 히스토그램 양수에서 숏 진입 → 승률 ${wr}% (${shortInPos.length}건)${wr <= 35 ? ' — 매우 위험' : ''}`);
      if (wr <= 35) worstPatterns.push({ condition: 'MACD양수 + 숏', winRate: wr, samples: shortInPos.length, avgPnl: avgPnl(shortInPos) });
    }
  }

  // ═══ 8. 청산 사유별 통계 ═══
  const closeReasons = {};
  for (const l of lessons) {
    const reason = l.closeReason || 'UNKNOWN';
    if (!closeReasons[reason]) closeReasons[reason] = { count: 0, totalPnl: 0 };
    closeReasons[reason].count++;
    closeReasons[reason].totalPnl += l.pnl || 0;
  }
  for (const [reason, stats] of Object.entries(closeReasons)) {
    if (stats.count >= 3) {
      rules.push(`청산 사유 ${reason}: ${stats.count}건, 평균 PnL $${(stats.totalPnl / stats.count).toFixed(2)}`);
    }
  }

  // ═══ 9. 복합 실패 패턴 감지 (20건 이상부터) ═══
  if (total >= 20) {
    const neutralLowVol = lessons.filter(l =>
      l.rsi != null && l.rsi >= 45 && l.rsi <= 55 &&
      l.volatility24h != null && l.volatility24h < 2
    );
    if (neutralLowVol.length >= 3) {
      const wr = weightedWinRate(neutralLowVol);
      if (wr <= 40) {
        rules.push(`RSI 중립(45-55) + 저변동성(<2%) 진입 시 승률 ${wr}% — 절대 금지`);
        worstPatterns.push({ condition: 'RSI중립 + 저변동성', winRate: wr, samples: neutralLowVol.length, avgPnl: avgPnl(neutralLowVol) });
      }
    }

    const fundingOverheat = lessons.filter(l =>
      l.fundingRate != null && Math.abs(l.fundingRate) > 0.05 &&
      ((l.fundingRate > 0 && isLongDir(l.direction)) ||
       (l.fundingRate < 0 && isShortDir(l.direction)))
    );
    if (fundingOverheat.length >= 3) {
      const wr = weightedWinRate(fundingOverheat);
      rules.push(`펀딩 과열 방향 진입 승률 ${wr}% (${fundingOverheat.length}건)${wr <= 40 ? ' — 역펀딩 진입 고려' : ''}`);
      if (wr <= 35) worstPatterns.push({ condition: '펀딩과열 + 같은방향', winRate: wr, samples: fundingOverheat.length, avgPnl: avgPnl(fundingOverheat) });
    }

    const extremeFear = lessons.filter(l => l.fearGreed != null && l.fearGreed <= 25);
    const extremeGreed = lessons.filter(l => l.fearGreed != null && l.fearGreed >= 75);
    if (extremeFear.length >= 3) {
      const longInFear = extremeFear.filter(l => isLongDir(l.direction));
      if (longInFear.length >= 2) {
        const wr = weightedWinRate(longInFear);
        rules.push(`극단적 공포(FG<=25)에서 롱 승률 ${wr}% (${longInFear.length}건)`);
        if (wr >= 65) bestPatterns.push({ condition: '극단공포 + 롱(역발상)', winRate: wr, samples: longInFear.length, avgPnl: avgPnl(longInFear) });
      }
    }
    if (extremeGreed.length >= 3) {
      const shortInGreed = extremeGreed.filter(l => isShortDir(l.direction));
      if (shortInGreed.length >= 2) {
        const wr = weightedWinRate(shortInGreed);
        rules.push(`극단적 탐욕(FG>=75)에서 숏 승률 ${wr}% (${shortInGreed.length}건)`);
        if (wr >= 65) bestPatterns.push({ condition: '극단탐욕 + 숏(역발상)', winRate: wr, samples: shortInGreed.length, avgPnl: avgPnl(shortInGreed) });
      }
    }

    const quickTrades = lessons.filter(l => l.holdHours != null && l.holdHours < 2);
    const longTrades = lessons.filter(l => l.holdHours != null && l.holdHours >= 12);
    if (quickTrades.length >= 3) {
      rules.push(`단기(<2h) 보유 승률 ${weightedWinRate(quickTrades)}% (${quickTrades.length}건)`);
    }
    if (longTrades.length >= 3) {
      rules.push(`장기(12h+) 보유 승률 ${weightedWinRate(longTrades)}% (${longTrades.length}건)`);
    }
  }

  // ═══ 10. 캔들 패턴별 승률 (NEW) ═══
  const candlePatternStats = {};
  for (const l of lessons) {
    if (!l.candlePattern || !l.candlePattern.pattern) continue;
    const cp = l.candlePattern;
    const key = cp.pattern;
    if (!candlePatternStats[key]) candlePatternStats[key] = [];
    candlePatternStats[key].push(l);
  }

  const patternLabels = {
    doji: '도지', hammer: '해머', inverted_hammer: '역해머',
    pin_bar_bull: '불리시 핀바', pin_bar_bear: '베어리시 핀바',
    engulfing_bull: '불리시 엔걸핑', engulfing_bear: '베어리시 엔걸핑',
    normal: '일반',
  };

  for (const [pat, pLessons] of Object.entries(candlePatternStats)) {
    if (pat === 'normal' || pLessons.length < 3) continue;
    const label = patternLabels[pat] || pat;

    // 방향별 분리
    const longInPat = pLessons.filter(l => isLongDir(l.direction));
    const shortInPat = pLessons.filter(l => isShortDir(l.direction));

    if (longInPat.length >= 2) {
      const wr = weightedWinRate(longInPat);
      rules.push(`캔들 ${label} 후 롱 승률 ${wr}% (${longInPat.length}건)`);
      if (wr >= 65) bestPatterns.push({ condition: `캔들 ${label} + 롱`, winRate: wr, samples: longInPat.length, avgPnl: avgPnl(longInPat) });
      if (wr <= 35) worstPatterns.push({ condition: `캔들 ${label} + 롱`, winRate: wr, samples: longInPat.length, avgPnl: avgPnl(longInPat) });
    }
    if (shortInPat.length >= 2) {
      const wr = weightedWinRate(shortInPat);
      rules.push(`캔들 ${label} 후 숏 승률 ${wr}% (${shortInPat.length}건)`);
      if (wr >= 65) bestPatterns.push({ condition: `캔들 ${label} + 숏`, winRate: wr, samples: shortInPat.length, avgPnl: avgPnl(shortInPat) });
      if (wr <= 35) worstPatterns.push({ condition: `캔들 ${label} + 숏`, winRate: wr, samples: shortInPat.length, avgPnl: avgPnl(shortInPat) });
    }
  }

  // 연속봉 패턴
  const consecutive3Bull = lessons.filter(l => l.candlePattern && l.candlePattern.consecutive >= 3 && l.candlePattern.consecutiveDir === 'bull');
  const consecutive3Bear = lessons.filter(l => l.candlePattern && l.candlePattern.consecutive >= 3 && l.candlePattern.consecutiveDir === 'bear');
  if (consecutive3Bull.length >= 3) {
    const longAfter = consecutive3Bull.filter(l => isLongDir(l.direction));
    const shortAfter = consecutive3Bull.filter(l => isShortDir(l.direction));
    if (longAfter.length >= 2) rules.push(`3연속 양봉 후 롱 승률 ${weightedWinRate(longAfter)}% (${longAfter.length}건)`);
    if (shortAfter.length >= 2) rules.push(`3연속 양봉 후 숏 승률 ${weightedWinRate(shortAfter)}% (${shortAfter.length}건)`);
  }
  if (consecutive3Bear.length >= 3) {
    const longAfter = consecutive3Bear.filter(l => isLongDir(l.direction));
    const shortAfter = consecutive3Bear.filter(l => isShortDir(l.direction));
    if (longAfter.length >= 2) rules.push(`3연속 음봉 후 롱 승률 ${weightedWinRate(longAfter)}% (${longAfter.length}건)`);
    if (shortAfter.length >= 2) rules.push(`3연속 음봉 후 숏 승률 ${weightedWinRate(shortAfter)}% (${shortAfter.length}건)`);
  }

  // ═══ 11. 지지/저항 레벨 학습 (NEW) ═══
  const srStats = { near_support: [], below_support: [], near_resistance: [], above_resistance: [], mid_range: [] };
  for (const l of lessons) {
    if (l.srPosition && srStats[l.srPosition]) {
      srStats[l.srPosition].push(l);
    }
  }

  if (srStats.near_support.length >= 3) {
    const longNearSup = srStats.near_support.filter(l => isLongDir(l.direction));
    if (longNearSup.length >= 2) {
      const wr = weightedWinRate(longNearSup);
      rules.push(`지지선 근처 롱 승률 ${wr}% (${longNearSup.length}건)`);
      if (wr >= 65) bestPatterns.push({ condition: '지지선 근처 + 롱', winRate: wr, samples: longNearSup.length, avgPnl: avgPnl(longNearSup) });
    }
  }
  if (srStats.below_support.length >= 3) {
    const longBelowSup = srStats.below_support.filter(l => isLongDir(l.direction));
    if (longBelowSup.length >= 2) {
      const wr = weightedWinRate(longBelowSup);
      rules.push(`지지선 이탈 롱 승률 ${wr}% (${longBelowSup.length}건)${wr <= 35 ? ' — 위험' : ''}`);
      if (wr <= 35) worstPatterns.push({ condition: '지지선이탈 + 롱', winRate: wr, samples: longBelowSup.length, avgPnl: avgPnl(longBelowSup) });
    }
  }
  if (srStats.near_resistance.length >= 3) {
    const shortNearRes = srStats.near_resistance.filter(l => isShortDir(l.direction));
    if (shortNearRes.length >= 2) {
      const wr = weightedWinRate(shortNearRes);
      rules.push(`저항선 근처 숏 승률 ${wr}% (${shortNearRes.length}건)`);
      if (wr >= 65) bestPatterns.push({ condition: '저항선 근처 + 숏', winRate: wr, samples: shortNearRes.length, avgPnl: avgPnl(shortNearRes) });
    }
  }
  if (srStats.above_resistance.length >= 3) {
    const longAboveRes = srStats.above_resistance.filter(l => isLongDir(l.direction));
    if (longAboveRes.length >= 2) {
      const wr = weightedWinRate(longAboveRes);
      rules.push(`저항 돌파 롱 승률 ${wr}% (${longAboveRes.length}건)`);
      if (wr >= 65) bestPatterns.push({ condition: '저항돌파 + 롱', winRate: wr, samples: longAboveRes.length, avgPnl: avgPnl(longAboveRes) });
    }
  }

  // ═══ 12. 연속 거래 패턴 (NEW) ═══
  const streakAnalysis = analyzeStreaks(lessons);

  if (streakAnalysis.afterLoss2.length >= 3) {
    const wr = weightedWinRate(streakAnalysis.afterLoss2);
    rules.push(`2연패 후 다음 거래 승률 ${wr}% (${streakAnalysis.afterLoss2.length}건)${wr >= 55 ? ' — 연패 후 오히려 기회' : ''}`);
  }
  if (streakAnalysis.afterLoss3.length >= 3) {
    const wr = weightedWinRate(streakAnalysis.afterLoss3);
    rules.push(`3연패 후 다음 거래 승률 ${wr}% (${streakAnalysis.afterLoss3.length}건)`);
  }
  if (streakAnalysis.afterWin3.length >= 3) {
    const wr = weightedWinRate(streakAnalysis.afterWin3);
    rules.push(`3연승 후 다음 거래 승률 ${wr}% (${streakAnalysis.afterWin3.length}건)${wr <= 45 ? ' — 과신 경고' : ''}`);
  }
  if (streakAnalysis.afterWin5.length >= 3) {
    const wr = weightedWinRate(streakAnalysis.afterWin5);
    rules.push(`5연승 후 다음 거래 승률 ${wr}% (${streakAnalysis.afterWin5.length}건)${wr <= 40 ? ' — 강한 과신 경고' : ''}`);
    if (wr <= 40) worstPatterns.push({ condition: '5연승 후 과신', winRate: wr, samples: streakAnalysis.afterWin5.length, avgPnl: avgPnl(streakAnalysis.afterWin5) });
  }

  // ═══ 13. R:R 최적화 (NEW) ═══
  const rrAnalysis = analyzeRR(lessons);

  if (rrAnalysis.avgActualRR != null) {
    rules.push(`실제 달성 R:R 평균 ${rrAnalysis.avgActualRR.toFixed(2)}:1 (설정 대비 ${rrAnalysis.rrAchievementPct.toFixed(0)}% 달성)`);
  }

  // SL 폭별 승률
  for (const band of rrAnalysis.slBands) {
    if (band.count >= 3) {
      rules.push(`SL ${band.label} 설정 시 승률 ${band.winRate}% (${band.count}건, 평균PnL $${band.avgPnl})`);
    }
  }

  // ═══ 14. 보유 시간 최적화 (NEW) ═══
  const holdAnalysis = analyzeHoldTime(lessons);

  if (holdAnalysis.bestBand) {
    rules.push(`최적 보유시간: ${holdAnalysis.bestBand.label} (승률 ${holdAnalysis.bestBand.winRate}%, ${holdAnalysis.bestBand.count}건)`);
  }
  if (holdAnalysis.worstBand) {
    rules.push(`최악 보유시간: ${holdAnalysis.worstBand.label} (승률 ${holdAnalysis.worstBand.winRate}%, ${holdAnalysis.worstBand.count}건)`);
  }

  // ═══ 15. 멀티TF 확인 학습 (NEW) ═══
  const multiTfConfirmed = lessons.filter(l => l.multiTfConfirmed === true);
  const multiTfUnconfirmed = lessons.filter(l => l.multiTfConfirmed === false);

  if (multiTfConfirmed.length >= 3 && multiTfUnconfirmed.length >= 3) {
    const confirmedWr = weightedWinRate(multiTfConfirmed);
    const unconfirmedWr = weightedWinRate(multiTfUnconfirmed);
    rules.push(`멀티TF 확인 시 승률 ${confirmedWr}% (${multiTfConfirmed.length}건) vs 미확인 ${unconfirmedWr}% (${multiTfUnconfirmed.length}건)`);
    if (confirmedWr - unconfirmedWr >= 15) {
      bestPatterns.push({ condition: '멀티TF 확인', winRate: confirmedWr, samples: multiTfConfirmed.length, avgPnl: avgPnl(multiTfConfirmed) });
    }
    if (unconfirmedWr <= 35) {
      worstPatterns.push({ condition: '멀티TF 미확인', winRate: unconfirmedWr, samples: multiTfUnconfirmed.length, avgPnl: avgPnl(multiTfUnconfirmed) });
    }
  }

  // 패턴 정렬
  bestPatterns.sort((a, b) => b.winRate - a.winRate);
  worstPatterns.sort((a, b) => a.winRate - b.winRate);

  // ═══ 자동 전략 조정 제안 (NEW) ═══
  const suggestions = buildSuggestions(lessons, holdAnalysis, rrAnalysis, coinRules);

  // ═══ 추이 분석 (NEW) ═══
  const trend = analyzeTrend(lessons);

  const result = {
    lastUpdated: new Date().toISOString(),
    totalLessons: total,
    overallWinRate: weightedWinRate(lessons),
    overallAvgPnl: avgPnl(lessons),
    rules: rules.slice(0, 50),
    bestPatterns: bestPatterns.slice(0, 10),
    worstPatterns: worstPatterns.slice(0, 10),
    coinRules,
    suggestions,
    trend,
    streakAnalysis: {
      afterLoss2WR: streakAnalysis.afterLoss2.length >= 3 ? weightedWinRate(streakAnalysis.afterLoss2) : null,
      afterLoss3WR: streakAnalysis.afterLoss3.length >= 3 ? weightedWinRate(streakAnalysis.afterLoss3) : null,
      afterWin3WR: streakAnalysis.afterWin3.length >= 3 ? weightedWinRate(streakAnalysis.afterWin3) : null,
      afterWin5WR: streakAnalysis.afterWin5.length >= 3 ? weightedWinRate(streakAnalysis.afterWin5) : null,
    },
    holdTimeOptimal: holdAnalysis.bestBand ? holdAnalysis.bestBand.label : null,
    rrStats: {
      avgActualRR: rrAnalysis.avgActualRR,
      rrAchievementPct: rrAnalysis.rrAchievementPct,
      optimalSlPct: suggestions.optimalSlPct,
    },
  };

  saveRules(result);
  console.log(`[learner] 분석 완료: ${total}건 → ${rules.length}개 규칙, ${bestPatterns.length}개 최고패턴, ${worstPatterns.length}개 최악패턴, 자동조정 ${Object.keys(suggestions).length}항목`);
  return result;
}

// ── 연속 거래 패턴 분석 ──
function analyzeStreaks(lessons) {
  const sorted = [...lessons].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  const afterLoss2 = [];
  const afterLoss3 = [];
  const afterWin3 = [];
  const afterWin5 = [];

  for (let i = 2; i < sorted.length; i++) {
    // 2연패 후
    if (!sorted[i - 1].isWin && !sorted[i - 2].isWin) {
      afterLoss2.push(sorted[i]);
    }
    // 3연패 후
    if (i >= 3 && !sorted[i - 1].isWin && !sorted[i - 2].isWin && !sorted[i - 3].isWin) {
      afterLoss3.push(sorted[i]);
    }
    // 3연승 후 (i >= 3 필수)
    if (i >= 3 && sorted[i - 1].isWin && sorted[i - 2].isWin && sorted[i - 3].isWin) {
      afterWin3.push(sorted[i]);
    }
    // 5연승 후
    if (i >= 5 && sorted[i - 1].isWin && sorted[i - 2].isWin && sorted[i - 3].isWin && sorted[i - 4].isWin && sorted[i - 5].isWin) {
      afterWin5.push(sorted[i]);
    }
  }

  return { afterLoss2, afterLoss3, afterWin3, afterWin5 };
}

// ── R:R 최적화 분석 ──
function analyzeRR(lessons) {
  const withRR = lessons.filter(l => l.entry && l.exit && l.slPrice && l.tpPrice);

  let totalActualRR = 0;
  let totalSetRR = 0;
  let rrCount = 0;

  for (const l of withRR) {
    const isLong = isLongDir(l.direction);
    const slDist = Math.abs(l.entry - l.slPrice);
    const tpDist = Math.abs(l.tpPrice - l.entry);
    const actualDist = Math.abs(l.exit - l.entry);

    if (slDist > 0) {
      const setRR = tpDist / slDist;
      const actualRR = l.isWin ? actualDist / slDist : -(actualDist / slDist);
      totalSetRR += setRR;
      totalActualRR += Math.max(0, actualRR);
      rrCount++;
    }
  }

  // SL 폭별 승률
  const slBands = [
    { label: '1-2%', min: 1, max: 2, lessons: [] },
    { label: '2-3%', min: 2, max: 3, lessons: [] },
    { label: '3-5%', min: 3, max: 5, lessons: [] },
    { label: '5%+', min: 5, max: 100, lessons: [] },
  ];

  for (const l of lessons) {
    if (!l.entry || !l.slPrice) continue;
    const slPct = Math.abs(l.entry - l.slPrice) / l.entry * 100;
    for (const band of slBands) {
      if (slPct >= band.min && slPct < band.max) {
        band.lessons.push(l);
        break;
      }
    }
  }

  return {
    avgActualRR: rrCount > 0 ? totalActualRR / rrCount : null,
    avgSetRR: rrCount > 0 ? totalSetRR / rrCount : null,
    rrAchievementPct: rrCount > 0 && totalSetRR > 0 ? (totalActualRR / totalSetRR) * 100 : 0,
    slBands: slBands.map(b => ({
      label: b.label,
      count: b.lessons.length,
      winRate: b.lessons.length >= 3 ? weightedWinRate(b.lessons) : null,
      avgPnl: avgPnl(b.lessons).toFixed(2),
    })),
  };
}

// ── 보유 시간 최적화 분석 ──
function analyzeHoldTime(lessons) {
  const bands = [
    { label: '0-1h', min: 0, max: 1, lessons: [] },
    { label: '1-2h', min: 1, max: 2, lessons: [] },
    { label: '2-4h', min: 2, max: 4, lessons: [] },
    { label: '4-8h', min: 4, max: 8, lessons: [] },
    { label: '8-12h', min: 8, max: 12, lessons: [] },
    { label: '12-24h', min: 12, max: 24, lessons: [] },
    { label: '24h+', min: 24, max: 99999, lessons: [] },
  ];

  for (const l of lessons) {
    if (l.holdHours == null) continue;
    for (const band of bands) {
      if (l.holdHours >= band.min && l.holdHours < band.max) {
        band.lessons.push(l);
        break;
      }
    }
  }

  const analyzed = bands
    .filter(b => b.lessons.length >= 3)
    .map(b => ({
      label: b.label,
      count: b.lessons.length,
      winRate: weightedWinRate(b.lessons),
      avgPnl: avgPnl(b.lessons),
    }));

  const bestBand = analyzed.length > 0 ? analyzed.reduce((best, b) => b.winRate > best.winRate ? b : best) : null;
  const worstBand = analyzed.length > 0 ? analyzed.reduce((worst, b) => b.winRate < worst.winRate ? b : worst) : null;

  return { bands: analyzed, bestBand, worstBand };
}

// ── 자동 전략 조정 제안 생성 ──
function buildSuggestions(lessons, holdAnalysis, rrAnalysis, coinRules) {
  const suggestions = {};

  // 최적 SL%: SL 밴드 중 가장 승률 높은 구간의 중앙값
  const bestSlBand = rrAnalysis.slBands
    .filter(b => b.count >= 3 && b.winRate != null)
    .sort((a, b) => b.winRate - a.winRate)[0];

  if (bestSlBand) {
    const slMap = { '1-2%': 1.5, '2-3%': 2.5, '3-5%': 4.0, '5%+': 6.0 };
    suggestions.optimalSlPct = slMap[bestSlBand.label] || 2.5;
  }

  // 최적 TP 배수: 실제 달성 R:R 기반
  if (rrAnalysis.avgActualRR != null && rrAnalysis.avgActualRR > 0) {
    suggestions.optimalTpMultiple = Math.round(Math.max(1.5, Math.min(4.0, rrAnalysis.avgActualRR * 1.2)) * 10) / 10;
  }

  // 최적/피할 거래 시간
  const hourStats = {};
  for (const l of lessons) {
    if (l.hourUtc == null) continue;
    if (!hourStats[l.hourUtc]) hourStats[l.hourUtc] = { wins: 0, total: 0 };
    hourStats[l.hourUtc].total++;
    if (l.isWin) hourStats[l.hourUtc].wins++;
  }

  const hourEntries = Object.entries(hourStats)
    .filter(([, s]) => s.total >= 3)
    .map(([h, s]) => ({ hour: parseInt(h), winRate: Math.round(s.wins / s.total * 1000) / 10, count: s.total }))
    .sort((a, b) => b.winRate - a.winRate);

  if (hourEntries.length > 0) {
    suggestions.bestHours = hourEntries.filter(h => h.winRate >= 55).slice(0, 5).map(h => h.hour);
    suggestions.avoidHours = hourEntries.filter(h => h.winRate <= 40).slice(0, 5).map(h => h.hour);
  }

  // 최적/피할 코인
  const coinEntries = Object.entries(coinRules)
    .filter(([, cr]) => cr.totalTrades >= 3)
    .sort((a, b) => b[1].totalWinRate - a[1].totalWinRate);

  if (coinEntries.length > 0) {
    suggestions.bestCoins = coinEntries.filter(([, cr]) => cr.totalWinRate >= 55).slice(0, 5).map(([c]) => c);
    suggestions.avoidCoins = coinEntries.filter(([, cr]) => cr.totalWinRate <= 40).slice(0, 3).map(([c]) => c);
  }

  // 최적 보유시간 제안
  if (holdAnalysis.bestBand) {
    const holdMap = { '0-1h': 1, '1-2h': 2, '2-4h': 4, '4-8h': 8, '8-12h': 12, '12-24h': 24, '24h+': 48 };
    suggestions.optimalMaxHoldHours = holdMap[holdAnalysis.bestBand.label] || 12;
  }

  return suggestions;
}

// ── 추이 분석 (최근 20건 vs 이전 20건) ──
function analyzeTrend(lessons) {
  if (lessons.length < 20) return null;

  const sorted = [...lessons].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  const recent20 = sorted.slice(-20);
  const prev20 = sorted.length >= 40 ? sorted.slice(-40, -20) : sorted.slice(0, -20);

  const recentWR = weightedWinRate(recent20);
  const prevWR = prev20.length >= 5 ? weightedWinRate(prev20) : null;
  const wrChange = prevWR != null ? Math.round((recentWR - prevWR) * 10) / 10 : null;

  const recentAvgPnl = avgPnl(recent20);
  const prevAvgPnl = prev20.length >= 5 ? avgPnl(prev20) : null;

  // 가장 많이 개선된 패턴 vs 약한 패턴 (이전 대비)
  let improvedPattern = null;
  let weakPattern = null;

  // RSI 구간별 비교
  const rsiRanges = [
    { label: 'RSI<30 롱', filter: l => l.rsi != null && l.rsi < 30 && isLongDir(l.direction) },
    { label: 'RSI>70 숏', filter: l => l.rsi != null && l.rsi > 70 && isShortDir(l.direction) },
    { label: '고변동성', filter: l => l.volatility24h != null && l.volatility24h > 5 },
    { label: '저변동성', filter: l => l.volatility24h != null && l.volatility24h < 2 },
  ];

  let bestImprovement = -Infinity;
  let worstDecline = Infinity;

  for (const range of rsiRanges) {
    const recentFiltered = recent20.filter(range.filter);
    const prevFiltered = prev20.filter(range.filter);
    if (recentFiltered.length >= 2 && prevFiltered.length >= 2) {
      const rWR = winRate(recentFiltered);
      const pWR = winRate(prevFiltered);
      const diff = rWR - pWR;
      if (diff > bestImprovement) {
        bestImprovement = diff;
        improvedPattern = { label: range.label, recentWR: rWR, prevWR: pWR, change: Math.round(diff * 10) / 10 };
      }
      if (diff < worstDecline) {
        worstDecline = diff;
        weakPattern = { label: range.label, recentWR: rWR, prevWR: pWR, change: Math.round(diff * 10) / 10 };
      }
    }
  }

  return {
    recentWinRate: recentWR,
    prevWinRate: prevWR,
    winRateChange: wrChange,
    recentAvgPnl,
    prevAvgPnl,
    improving: wrChange != null && wrChange > 0,
    improvedPattern,
    weakPattern,
  };
}

// ── 현재 시장 상태가 worstPattern과 매칭되는지 체크 ──
function checkWorstPatterns(marketState) {
  const rules = loadRules();
  if (!rules || !rules.worstPatterns || rules.worstPatterns.length === 0) return { blocked: false };

  const { rsi, macdHist, volatility24h, direction, symbol, confidence, fearGreed, fundingRate, sma20Dist } = marketState;

  for (const pattern of rules.worstPatterns) {
    if (pattern.samples < 3) continue;
    if (pattern.winRate > 35) continue;

    const cond = pattern.condition.toLowerCase();

    if (cond.includes('rsi중립') && cond.includes('저변동성')) {
      if (rsi != null && rsi >= 45 && rsi <= 55 && volatility24h != null && volatility24h < 2) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }

    if (cond.includes('macd음수') && cond.includes('롱')) {
      if (macdHist != null && macdHist < 0 && isLongDir(direction)) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }

    if (cond.includes('macd양수') && cond.includes('숏')) {
      if (macdHist != null && macdHist > 0 && isShortDir(direction)) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }

    if (cond === '저변동성(<2%)') {
      if (volatility24h != null && volatility24h < 2) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }

    if (cond === '고변동성(>5%)') {
      if (volatility24h != null && volatility24h > 5) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }

    if (cond.includes('펀딩과열')) {
      if (fundingRate != null && Math.abs(fundingRate) > 0.05) {
        if ((fundingRate > 0 && isLongDir(direction)) ||
            (fundingRate < 0 && isShortDir(direction))) {
          return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
        }
      }
    }

    // 지지선 이탈 + 롱
    if (cond.includes('지지선이탈') && cond.includes('롱')) {
      if (marketState.srPosition === 'below_support' && isLongDir(direction)) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }

    // 멀티TF 미확인
    if (cond.includes('멀티tf 미확인')) {
      if (marketState.multiTfConfirmed === false) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }

    // 5연승 후 과신
    if (cond.includes('5연승') && cond.includes('과신')) {
      if (marketState.consecutiveWins >= 5) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }

    // 캔들 패턴 매칭
    if (cond.includes('캔들') && marketState.candlePattern) {
      const patLabels = {
        doji: '도지', hammer: '해머', inverted_hammer: '역해머',
        pin_bar_bull: '불리시 핀바', pin_bar_bear: '베어리시 핀바',
        engulfing_bull: '불리시 엔걸핑', engulfing_bear: '베어리시 엔걸핑',
      };
      const mLabel = patLabels[marketState.candlePattern.pattern] || '';
      if (mLabel && cond.includes(mLabel.toLowerCase())) {
        const isL = isLongDir(direction);
        if ((cond.includes('롱') && isL) || (cond.includes('숏') && !isL)) {
          return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
        }
      }
    }

    if (symbol && cond.includes(symbol.toLowerCase())) {
      const isL = isLongDir(direction);
      if ((cond.includes('롱') && isL) || (cond.includes('숏') && !isL)) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }

    if (cond.includes('확신도') && confidence != null) {
      if (cond.includes('50-60') && confidence >= 50 && confidence < 60) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
      if (cond.includes('60-70') && confidence >= 60 && confidence < 70) {
        return { blocked: true, reason: `학습 차단: ${pattern.condition} (승률 ${pattern.winRate}%, ${pattern.samples}건)` };
      }
    }
  }

  return { blocked: false };
}

// ── bestPattern 매칭 시 confidence 부스트 ──
function checkBestPatterns(marketState) {
  const rules = loadRules();
  if (!rules || !rules.bestPatterns || rules.bestPatterns.length === 0) return { boost: 0 };

  const { rsi, direction, symbol, fearGreed, confidence } = marketState;
  let boost = 0;
  const matchedPatterns = [];

  for (const pattern of rules.bestPatterns) {
    if (pattern.samples < 3) continue;
    if (pattern.winRate < 60) continue;

    const cond = pattern.condition.toLowerCase();
    const isL = isLongDir(direction);

    if (cond.includes('rsi') && cond.includes('30') && cond.includes('롱')) {
      if (rsi != null && rsi < 30 && isL) { boost = Math.max(boost, 5); matchedPatterns.push(pattern.condition); }
    }

    if (cond.includes('rsi') && cond.includes('70') && cond.includes('숏')) {
      if (rsi != null && rsi > 70 && !isL) { boost = Math.max(boost, 5); matchedPatterns.push(pattern.condition); }
    }

    if (symbol && cond.includes(symbol.toLowerCase())) {
      if ((cond.includes('롱') && isL) || (cond.includes('숏') && !isL)) {
        boost = Math.max(boost, 5); matchedPatterns.push(pattern.condition);
      }
    }

    if (cond.includes('극단공포') && cond.includes('롱')) {
      if (fearGreed != null && fearGreed <= 25 && isL) { boost = Math.max(boost, 5); matchedPatterns.push(pattern.condition); }
    }

    if (cond.includes('극단탐욕') && cond.includes('숏')) {
      if (fearGreed != null && fearGreed >= 75 && !isL) { boost = Math.max(boost, 5); matchedPatterns.push(pattern.condition); }
    }

    if (cond.includes('확신도 70%') && confidence >= 70) {
      boost = Math.max(boost, 3); matchedPatterns.push(pattern.condition);
    }

    // 지지선 근처 + 롱
    if (cond.includes('지지선') && cond.includes('롱') && marketState.srPosition === 'near_support' && isL) {
      boost = Math.max(boost, 5); matchedPatterns.push(pattern.condition);
    }

    // 저항 돌파 + 롱
    if (cond.includes('저항돌파') && cond.includes('롱') && marketState.srPosition === 'above_resistance' && isL) {
      boost = Math.max(boost, 5); matchedPatterns.push(pattern.condition);
    }

    // 멀티TF 확인
    if (cond.includes('멀티tf 확인') && marketState.multiTfConfirmed === true) {
      boost = Math.max(boost, 5); matchedPatterns.push(pattern.condition);
    }

    // 캔들 패턴
    if (cond.includes('캔들') && marketState.candlePattern) {
      const patLabels = { doji: '도지', hammer: '해머', pin_bar_bull: '불리시 핀바', pin_bar_bear: '베어리시 핀바', engulfing_bull: '불리시 엔걸핑', engulfing_bear: '베어리시 엔걸핑' };
      const mLabel = patLabels[marketState.candlePattern.pattern] || '';
      if (mLabel && cond.includes(mLabel.toLowerCase())) {
        if ((cond.includes('롱') && isL) || (cond.includes('숏') && !isL)) {
          boost = Math.max(boost, 5); matchedPatterns.push(pattern.condition);
        }
      }
    }
  }

  return { boost, matchedPatterns };
}

// ── ACE 프롬프트에 주입할 학습 텍스트 생성 ──
function buildLearningPromptSection(symbol) {
  const rules = loadRules();
  if (!rules || rules.totalLessons < 5) return '';

  let text = `\n═══ 과거 학습 (실전 데이터 기반, ${rules.totalLessons}건, 시간가중) ═══\n`;
  text += `전체 승률: ${rules.overallWinRate}% | 평균 PnL: $${rules.overallAvgPnl}\n\n`;

  // 핵심 규칙 (최대 12개)
  text += '발견된 패턴:\n';
  for (const rule of rules.rules.slice(0, 12)) {
    text += `- ${rule}\n`;
  }

  if (rules.bestPatterns.length > 0) {
    text += '\n최고 패턴 (적극 진입):\n';
    for (const bp of rules.bestPatterns.slice(0, 5)) {
      text += `- ${bp.condition}: 승률 ${bp.winRate}% (${bp.samples}건)\n`;
    }
  }

  if (rules.worstPatterns.length > 0) {
    text += '\n최악 패턴 (절대 금지):\n';
    for (const wp of rules.worstPatterns.slice(0, 5)) {
      text += `- ${wp.condition}: 승률 ${wp.winRate}% (${wp.samples}건) -> 진입 금지\n`;
    }
  }

  // 코인별 규칙
  if (symbol && rules.coinRules && rules.coinRules[symbol]) {
    const cr = rules.coinRules[symbol];
    text += `\n이 코인(${symbol})의 과거:\n`;
    if (cr.preferLong != null) {
      text += `- ${cr.preferLong ? '롱' : '숏'} 선호 (롱 ${cr.longWinRate}% vs 숏 ${cr.shortWinRate}%)\n`;
    }
    if (cr.bestHours.length > 0) {
      text += `- 최적 시간대: ${cr.bestHours.map(h => h + 'h UTC').join(', ')}\n`;
    }
    if (cr.avoidHours && cr.avoidHours.length > 0) {
      text += `- 피할 시간대: ${cr.avoidHours.map(h => h + 'h UTC').join(', ')}\n`;
    }
    text += `- 전체 승률: ${cr.totalWinRate}% (${cr.totalTrades}건)\n`;
  }

  // 자동 조정 제안
  if (rules.suggestions) {
    const s = rules.suggestions;
    text += '\n전략 최적화 제안:\n';
    if (s.optimalSlPct) text += `- 최적 SL: ${s.optimalSlPct}%\n`;
    if (s.optimalTpMultiple) text += `- 최적 TP 배수(SL 대비): ${s.optimalTpMultiple}x\n`;
    if (s.optimalMaxHoldHours) text += `- 최적 보유시간: ${s.optimalMaxHoldHours}h 이내\n`;
    if (s.bestHours && s.bestHours.length > 0) text += `- 최적 거래시간(UTC): ${s.bestHours.join(', ')}시\n`;
    if (s.avoidHours && s.avoidHours.length > 0) text += `- 피할 시간(UTC): ${s.avoidHours.join(', ')}시\n`;
  }

  // 추이
  if (rules.trend) {
    const t = rules.trend;
    if (t.winRateChange != null) {
      text += `\n추이: 승률 ${t.winRateChange > 0 ? '+' : ''}${t.winRateChange}%p (최근20건 ${t.recentWinRate}% vs 이전 ${t.prevWinRate}%)`;
      text += t.improving ? ' — 개선 중\n' : ' — 하락 중\n';
    }
  }

  text += '\n이 패턴을 반드시 참고하여 판정하라. 승률 낮은 패턴은 피하고, 승률 높은 패턴에서 적극 진입하라.\n';

  return text;
}

// ── BLITZ 프롬프트에 주입할 학습 텍스트 (NEW) ──
function buildBlitzLearningSection(symbol) {
  const rules = loadRules();
  if (!rules || rules.totalLessons < 5) return '';

  let text = '\n═══ 스캘핑 학습 데이터 ═══\n';

  // 코인별 스캘핑 최적값
  if (symbol && rules.coinRules && rules.coinRules[symbol]) {
    const cr = rules.coinRules[symbol];
    text += `${symbol} 역사적 승률: ${cr.totalWinRate}% (${cr.totalTrades}건)\n`;
    if (cr.preferLong != null) text += `선호: ${cr.preferLong ? '롱' : '숏'} (롱${cr.longWinRate}% / 숏${cr.shortWinRate}%)\n`;
  }

  if (rules.suggestions) {
    const s = rules.suggestions;
    if (s.optimalSlPct) text += `학습된 최적 SL: ${s.optimalSlPct}%\n`;
    if (s.optimalTpMultiple) text += `학습된 최적 TP 배수: ${s.optimalTpMultiple}x\n`;
  }

  if (rules.holdTimeOptimal) {
    text += `최적 보유시간: ${rules.holdTimeOptimal}\n`;
  }

  // 캔들 패턴 참고
  const candleRules = (rules.rules || []).filter(r => r.includes('캔들'));
  if (candleRules.length > 0) {
    text += '\n캔들 패턴:\n';
    for (const r of candleRules.slice(0, 3)) text += `- ${r}\n`;
  }

  text += '이 데이터를 스캘핑 판단에 반영하라.\n';
  return text;
}

// ── GUARD 프롬프트에 주입할 학습 텍스트 (NEW) ──
function buildGuardLearningSection(symbol) {
  const rules = loadRules();
  if (!rules || rules.totalLessons < 5) return '';

  let text = '\n═══ 리스크 학습 데이터 ═══\n';

  if (symbol && rules.coinRules && rules.coinRules[symbol]) {
    const cr = rules.coinRules[symbol];
    text += `${symbol} 역사적 승률: ${cr.totalWinRate}% (${cr.totalTrades}건)\n`;
  }

  // R:R 달성률
  if (rules.rrStats) {
    const rr = rules.rrStats;
    if (rr.avgActualRR != null) text += `실제 R:R 평균: ${rr.avgActualRR.toFixed(2)}:1 (달성률 ${rr.rrAchievementPct.toFixed(0)}%)\n`;
    if (rr.optimalSlPct) text += `학습된 최적 SL: ${rr.optimalSlPct}%\n`;
  }

  // 최악 패턴 경고
  if (rules.worstPatterns.length > 0) {
    text += '\n주의 패턴:\n';
    for (const wp of rules.worstPatterns.slice(0, 3)) {
      text += `- ${wp.condition}: 승률 ${wp.winRate}% (${wp.samples}건)\n`;
    }
  }

  // 연승 과신 데이터
  if (rules.streakAnalysis) {
    const sa = rules.streakAnalysis;
    if (sa.afterWin3WR != null) text += `3연승 후 승률: ${sa.afterWin3WR}%\n`;
    if (sa.afterWin5WR != null) text += `5연승 후 승률: ${sa.afterWin5WR}% (과신 주의)\n`;
  }

  text += '이 데이터를 리스크 검증에 반영하라.\n';
  return text;
}

// ── 텔레그램 표시용 포맷 ──
function formatRulesForTelegram() {
  const rules = loadRules();
  if (!rules) return '학습 데이터 없음 (최소 5건 거래 필요)';

  let text = `<b>학습 규칙</b> (${rules.totalLessons}건 기반)\n`;
  text += `최종 학습: ${rules.lastUpdated.slice(0, 16).replace('T', ' ')}\n`;
  text += `전체 승률: <b>${rules.overallWinRate}%</b>\n\n`;

  text += '<b>핵심 규칙:</b>\n';
  for (const rule of rules.rules.slice(0, 10)) {
    text += `- ${rule}\n`;
  }

  // 자동 조정 제안
  if (rules.suggestions && Object.keys(rules.suggestions).length > 0) {
    text += '\n<b>전략 자동 조정 제안:</b>\n';
    const s = rules.suggestions;
    if (s.optimalSlPct) text += `- 최적 SL: ${s.optimalSlPct}%\n`;
    if (s.optimalTpMultiple) text += `- 최적 TP배수: ${s.optimalTpMultiple}x\n`;
    if (s.bestHours && s.bestHours.length) text += `- 최적 시간(UTC): ${s.bestHours.join(',')}시\n`;
    if (s.avoidHours && s.avoidHours.length) text += `- 피할 시간(UTC): ${s.avoidHours.join(',')}시\n`;
    if (s.bestCoins && s.bestCoins.length) text += `- 추천 코인: ${s.bestCoins.join(', ')}\n`;
    if (s.avoidCoins && s.avoidCoins.length) text += `- 회피 코인: ${s.avoidCoins.join(', ')}\n`;
  }

  return text;
}

function formatPatternsForTelegram() {
  const rules = loadRules();
  if (!rules) return '학습 데이터 없음';

  let text = `<b>패턴 분석</b> (${rules.totalLessons}건)\n\n`;

  if (rules.bestPatterns.length > 0) {
    text += '<b>최고 패턴:</b>\n';
    for (const bp of rules.bestPatterns.slice(0, 5)) {
      text += `  + ${bp.condition} — 승률 ${bp.winRate}% (${bp.samples}건)\n`;
    }
  }

  if (rules.worstPatterns.length > 0) {
    text += '\n<b>최악 패턴:</b>\n';
    for (const wp of rules.worstPatterns.slice(0, 5)) {
      text += `  - ${wp.condition} — 승률 ${wp.winRate}% (${wp.samples}건)\n`;
    }
  }

  if (Object.keys(rules.coinRules).length > 0) {
    text += '\n<b>코인별:</b>\n';
    for (const [coin, cr] of Object.entries(rules.coinRules)) {
      const pref = cr.preferLong != null ? (cr.preferLong ? '롱' : '숏') : '?';
      text += `  ${coin}: ${pref} 승률 ${cr.totalWinRate}% (${cr.totalTrades}건)\n`;
    }
  }

  return text;
}

function formatLearnResultForTelegram(result) {
  if (!result) return '학습 데이터 부족 (최소 5건 필요)';

  let text = `<b>학습 완료!</b>\n\n`;
  text += `분석 건수: <b>${result.totalLessons}건</b>\n`;
  text += `전체 승률: <b>${result.overallWinRate}%</b> (시간가중)\n`;
  text += `발견 규칙: ${result.rules.length}개\n`;
  text += `최고 패턴: ${result.bestPatterns.length}개\n`;
  text += `최악 패턴: ${result.worstPatterns.length}개\n\n`;

  if (result.rules.length > 0) {
    text += '<b>주요 발견:</b>\n';
    for (const rule of result.rules.slice(0, 5)) {
      text += `- ${rule}\n`;
    }
  }

  // 추이 (NEW)
  if (result.trend) {
    const t = result.trend;
    text += '\n<b>추이 분석:</b>\n';
    if (t.winRateChange != null) {
      text += `최근20건 승률: ${t.recentWinRate}% (이전: ${t.prevWinRate}%) → ${t.winRateChange > 0 ? '+' : ''}${t.winRateChange}%p ${t.improving ? '(개선)' : '(하락)'}\n`;
    }
    if (t.improvedPattern) {
      text += `가장 개선: ${t.improvedPattern.label} (+${t.improvedPattern.change}%p)\n`;
    }
    if (t.weakPattern && t.weakPattern.change < 0) {
      text += `아직 약한: ${t.weakPattern.label} (${t.weakPattern.change}%p)\n`;
    }
  }

  // 자동 조정 제안 (NEW)
  if (result.suggestions && Object.keys(result.suggestions).length > 0) {
    text += '\n<b>전략 자동 조정 제안:</b>\n';
    const s = result.suggestions;
    if (s.optimalSlPct) text += `- SL: ${s.optimalSlPct}%\n`;
    if (s.optimalTpMultiple) text += `- TP배수: ${s.optimalTpMultiple}x\n`;
    if (s.optimalMaxHoldHours) text += `- 최대보유: ${s.optimalMaxHoldHours}h\n`;
    if (s.bestCoins && s.bestCoins.length) text += `- 추천: ${s.bestCoins.join(', ')}\n`;
    if (s.avoidCoins && s.avoidCoins.length) text += `- 회피: ${s.avoidCoins.join(', ')}\n`;
  }

  return text;
}

// ── AI 자체 전략 생성 ──

const CUSTOM_STRATEGIES_FILE = path.join(__dirname, '..', 'reports', 'custom-strategies.json');

function loadCustomStrategies() {
  try {
    if (fs.existsSync(CUSTOM_STRATEGIES_FILE)) {
      return JSON.parse(fs.readFileSync(CUSTOM_STRATEGIES_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[learner] custom strategies 로드 실패:', e.message);
  }
  return [];
}

function saveCustomStrategies(strategies) {
  try {
    const dir = path.dirname(CUSTOM_STRATEGIES_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CUSTOM_STRATEGIES_FILE, JSON.stringify(strategies, null, 2), 'utf-8');
  } catch (e) {
    console.error('[learner] custom strategies 저장 실패:', e.message);
  }
}

function generateCustomStrategy(lessons) {
  if (!lessons) lessons = loadLessons();
  if (lessons.length < 20) {
    console.log(`[learner] 커스텀 전략 생성 불가: 데이터 부족 (${lessons.length}건 < 20건)`);
    return null;
  }

  // 조건 조합 정의
  const conditions = [
    { label: 'RSI<35', test: l => l.rsi != null && l.rsi < 35 },
    { label: 'RSI>65', test: l => l.rsi != null && l.rsi > 65 },
    { label: 'RSI<30', test: l => l.rsi != null && l.rsi < 30 },
    { label: 'RSI>70', test: l => l.rsi != null && l.rsi > 70 },
    { label: 'MACD양전환', test: l => l.macdHist != null && l.macdHist > 0 && l.prevMacdHist != null && l.prevMacdHist <= 0 },
    { label: 'MACD음전환', test: l => l.macdHist != null && l.macdHist < 0 && l.prevMacdHist != null && l.prevMacdHist >= 0 },
    { label: 'MACD양수', test: l => l.macdHist != null && l.macdHist > 0 },
    { label: 'MACD음수', test: l => l.macdHist != null && l.macdHist < 0 },
    { label: 'SMA20위', test: l => l.sma20Dist != null && l.sma20Dist > 0 },
    { label: 'SMA20아래', test: l => l.sma20Dist != null && l.sma20Dist < 0 },
    { label: '미국장시간', test: l => l.hourUtc != null && l.hourUtc >= 13 && l.hourUtc <= 21 },
    { label: '아시아장시간', test: l => l.hourUtc != null && l.hourUtc >= 0 && l.hourUtc < 8 },
    { label: '고변동성', test: l => l.volatility24h != null && l.volatility24h > 3 },
    { label: '저변동성', test: l => l.volatility24h != null && l.volatility24h < 2 },
    { label: '지지선근처', test: l => l.srPosition === 'near_support' },
    { label: '저항선근처', test: l => l.srPosition === 'near_resistance' },
    { label: '확신도70+', test: l => l.confidence != null && l.confidence >= 70 },
    { label: '등급A', test: l => l.grade === 'A' },
  ];

  const directions = [
    { label: '롱', test: l => isLongDir(l.direction) },
    { label: '숏', test: l => isShortDir(l.direction) },
  ];

  const discoveredStrategies = [];

  // 2-3개 조건 조합 탐색
  for (let i = 0; i < conditions.length; i++) {
    for (let j = i + 1; j < conditions.length; j++) {
      for (const dir of directions) {
        const matched = lessons.filter(l =>
          conditions[i].test(l) && conditions[j].test(l) && dir.test(l)
        );

        if (matched.length >= 5) {
          const wr = weightedWinRate(matched);
          const avg = avgPnl(matched);
          if (wr >= 65) {
            discoveredStrategies.push({
              name: `${conditions[i].label} + ${conditions[j].label} → ${dir.label}`,
              conditions: [conditions[i].label, conditions[j].label],
              direction: dir.label,
              winRate: wr,
              avgPnl: avg,
              samples: matched.length,
              discoveredAt: new Date().toISOString(),
            });
          }
        }

        // 3개 조합
        for (let k = j + 1; k < conditions.length; k++) {
          const matched3 = lessons.filter(l =>
            conditions[i].test(l) && conditions[j].test(l) && conditions[k].test(l) && dir.test(l)
          );

          if (matched3.length >= 4) {
            const wr = weightedWinRate(matched3);
            const avg = avgPnl(matched3);
            if (wr >= 70) {
              discoveredStrategies.push({
                name: `${conditions[i].label} + ${conditions[j].label} + ${conditions[k].label} → ${dir.label}`,
                conditions: [conditions[i].label, conditions[j].label, conditions[k].label],
                direction: dir.label,
                winRate: wr,
                avgPnl: avg,
                samples: matched3.length,
                discoveredAt: new Date().toISOString(),
              });
            }
          }
        }
      }
    }
  }

  // 승률 순 정렬, 상위 10개만 저장
  discoveredStrategies.sort((a, b) => b.winRate - a.winRate || b.samples - a.samples);
  const topStrategies = discoveredStrategies.slice(0, 10);

  if (topStrategies.length > 0) {
    saveCustomStrategies(topStrategies);
    console.log(`[learner] 커스텀 전략 ${topStrategies.length}개 생성 완료`);
    for (const s of topStrategies.slice(0, 3)) {
      console.log(`  - ${s.name}: 승률 ${s.winRate}% (${s.samples}건, 평균 $${s.avgPnl})`);
    }
  } else {
    console.log('[learner] 승률 65%+ 조건 조합 없음');
  }

  return topStrategies;
}

module.exports = {
  loadLessons,
  appendLesson,
  loadRules,
  analyzeLessons,
  checkWorstPatterns,
  checkBestPatterns,
  buildLearningPromptSection,
  buildBlitzLearningSection,
  buildGuardLearningSection,
  formatRulesForTelegram,
  formatPatternsForTelegram,
  formatLearnResultForTelegram,
  // AI 자체 전략 생성
  generateCustomStrategy,
  loadCustomStrategies,
  // 유틸리티 (paper-trader에서 사용)
  analyzeCandlePattern,
  findSupportResistance,
  classifySRPosition,
};
