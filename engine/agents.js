// ═══════════════════════════════════════
// AGENTS — 13명 AI 에이전트 + Anthropic API
// 코인 선물 전용 (논문 아키텍처 반영)
// 퀀트 시그널 + 마켓 레짐 주입 강화 (v2)
// ═══════════════════════════════════════

let learner;
try { learner = require('./learner'); } catch { learner = null; }

let quantSignals;
try { quantSignals = require('./quant-signals'); } catch { quantSignals = null; }

// 원본 프론트(app.js)의 스프라이트 ID와 일치시킴
const AGENTS = [
  { id:'taro',    name:'TARO',    nameKo:'타로',     role:'기술적 분석',   roomKo:'애널리스트 룸' },
  { id:'diana',   name:'DIANA',   nameKo:'다이애나', role:'온체인/펀더멘탈',roomKo:'애널리스트 룸' },
  { id:'nova',    name:'NOVA',    nameKo:'노바',     role:'매크로/펀딩',   roomKo:'애널리스트 룸' },
  { id:'vibe',    name:'VIBE',    nameKo:'바이브',   role:'센티먼트/OI',   roomKo:'애널리스트 룸' },
  { id:'bull',    name:'BULL',    nameKo:'불',       role:'매수 논거',     roomKo:'리서치 룸' },
  { id:'bear',    name:'BEAR',    nameKo:'베어',     role:'매도 논거',     roomKo:'리서치 룸' },
  { id:'blitz',   name:'BLITZ',   nameKo:'블리츠',   role:'스캘퍼',        roomKo:'스캘핑 데스크' },
  { id:'guard',   name:'GUARD',   nameKo:'가드',     role:'리스크 관리',   roomKo:'스캘핑 데스크' },
  { id:'risky',   name:'RISKY',   nameKo:'리스키',   role:'공격적 리스크', roomKo:'리스크 위원회' },
  { id:'neutral', name:'NEUTRAL', nameKo:'뉴트럴',   role:'중립적 리스크', roomKo:'리스크 위원회' },
  { id:'safe',    name:'SAFE',    nameKo:'세이프',   role:'보수적 리스크', roomKo:'리스크 위원회' },
  { id:'ace',     name:'ACE',     nameKo:'에이스',   role:'수석 트레이더', roomKo:'트레이딩 룸' },
  { id:'pm',      name:'PM',      nameKo:'피엠',     role:'포트폴리오 매니저',roomKo:'트레이딩 룸' },
];

function extractJson(text) {
  // 0) 전처리: 모든 코드 펜스 제거
  let stripped = text.replace(/```(?:json)?[\s\S]*?```/gi, (m) => {
    // 펜스 안의 내용만 남김
    return m.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  });
  stripped = stripped.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/im, '');

  // 1) 균형 맞춘 브레이스 스캔 (문자열 내부 브레이스 무시)
  for (let i = 0; i < stripped.length; i++) {
    if (stripped[i] !== '{') continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < stripped.length; j++) {
      const ch = stripped[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const raw = stripped.slice(i, j + 1);
          try { return _sanitizeJsonValues(JSON.parse(raw)); }
          catch (_) {
            // 숫자 필드에 콤마/텍스트가 있으면 정제 후 재시도
            try { return _sanitizeJsonValues(JSON.parse(_fixJsonString(raw))); }
            catch (__) { break; }
          }
        }
      }
    }
  }
  // 2) 폴백: 첫 { ~ 마지막 }
  try {
    const s = stripped.indexOf('{'), e = stripped.lastIndexOf('}');
    if (s !== -1 && e > s) {
      const raw = stripped.slice(s, e + 1);
      try { return _sanitizeJsonValues(JSON.parse(raw)); }
      catch (_) { return _sanitizeJsonValues(JSON.parse(_fixJsonString(raw))); }
    }
  } catch {}
  return null;
}

// JSON 문자열 내부 수치 필드 정제: "64,200" → "64200", "약 $64,000" → "64000"
function _fixJsonString(raw) {
  return raw
    // "entry": "약 $64,200" → "entry": "64200"
    .replace(/"(entry|stop|target|scalp_entry|scalp_stop|scalp_target|confidence)"\s*:\s*"([^"]+)"/gi,
      (m, key, val) => {
        const num = _extractNumber(val);
        return num !== null ? `"${key}":${num}` : m;
      })
    // 숫자 값에 콤마: "entry": 64,200 → "entry": 64200
    .replace(/"(entry|stop|target|scalp_entry|scalp_stop|scalp_target)"\s*:\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?)/gi,
      (m, key, val) => `"${key}":${val.replace(/,/g, '')}`)
    // trailing comma before }
    .replace(/,\s*}/g, '}')
    .replace(/,\s*]/g, ']');
}

// "약 $64,200.5" → 64200.5, 추출 실패시 null
function _extractNumber(str) {
  if (str == null) return null;
  const cleaned = String(str).replace(/[$,\s약~대략원]/g, '');
  const match = cleaned.match(/([\d]+(?:\.[\d]+)?)/);
  return match ? parseFloat(match[1]) : null;
}

// 파싱된 JSON 객체의 숫자 필드 자동 정제
function _sanitizeJsonValues(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const numFields = ['entry', 'stop', 'confidence', 'scalp_entry', 'scalp_stop', 'scalp_target'];
  for (const f of numFields) {
    if (obj[f] !== undefined && typeof obj[f] === 'string') {
      const n = _extractNumber(obj[f]);
      if (n !== null) obj[f] = n;
    }
  }
  // target은 "66500 / 68000" 같은 멀티 타겟이 올 수 있으므로 문자열 내 콤마만 정리
  if (typeof obj.target === 'string') {
    obj.target = obj.target.replace(/(\d),(\d{3})/g, '$1$2');
  }
  return obj;
}

// ── Mock responses (데모용) — 원본 engine.js는 taro/diana/nova/vibe ID로 호출 ──
const MOCK = {
  taro:      (sym) => ({ bubble: `${sym} 단기 조정 중이나 주요 지지선 부근에서 매수 관심 재개 모색 국면`, report: `${sym}USDT 4시간봉 기준 기술적 분석입니다.\n\n현재가는 SMA20($${Math.round(62000+Math.random()*3000).toLocaleString()}) 아래에 위치하며 단기 하락 추세입니다. RSI(14)는 ${Math.round(35+Math.random()*20)}로 중립~과매도 구간입니다. MACD는 시그널선 아래에서 수렴 중이며, 히스토그램이 축소되고 있어 모멘텀 약화가 관찰됩니다.\n\nATR(14) 기준 변동성은 $${Math.round(800+Math.random()*400)}로 평균 수준이고, 볼린저 밴드 하단($${Math.round(60000+Math.random()*3000).toLocaleString()}) 근처에서 지지 시도 중입니다. 20일 고가 대비 ${(Math.random()*5+2).toFixed(1)}% 하락한 상태이며, 슈퍼트렌드는 하방 전환 직전입니다.\n\n핵심 레벨 — 지지: $${Math.round(60000+Math.random()*3000).toLocaleString()}, 저항: $${Math.round(66000+Math.random()*3000).toLocaleString()}.` }),
  diana:     (sym) => ({ bubble: `${sym} 거래소 유출 증가, 온체인 지표 중립적 — 강한 약세 신호 제한적`, report: `${sym} 온체인/펀더멘탈 분석 결과:\n\n거래소 잔고가 지난 7일간 소폭 감소(-${(Math.random()*2+0.5).toFixed(1)}%)하여 매도 압력 완화 신호입니다. 대형 지갑(고래 1000+ BTC)의 순매수가 관찰되나 규모는 제한적입니다.\n\n활성 주소 수는 일평균 ${Math.round(700000+Math.random()*200000).toLocaleString()}개로 평균 수준을 유지합니다. 네트워크 해시레이트는 사상 최고치 근방이며, 채굴 난이도도 상승 중입니다.\n\nMVRV 비율은 ${(1.2+Math.random()*0.8).toFixed(2)}로 중립 구간입니다. 시가총액 대비 실현가치(Realized Cap)는 안정적입니다.` }),
  nova:      (sym) => ({ bubble: `${sym} 매크로 환경 약세 편향 — 펀딩레이트 과열 주의, OI 증가로 변동성 확대 가능`, report: `${sym} 매크로/파생상품 분석:\n\n펀딩레이트가 +${(Math.random()*0.01+0.002).toFixed(4)}%로 롱 포지션 우세이나 극단적 과열은 아닙니다. 미결제약정(OI)은 $${(Math.random()*2+5).toFixed(1)}B로 증가 추세 — 변동성 확대 가능성이 있습니다.\n\nBTC 도미넌스는 ${(56+Math.random()*4).toFixed(1)}%로 상승 중이어서 알트코인 대비 BTC 선호 경향이 보입니다. DXY(달러인덱스)는 ${(103+Math.random()*3).toFixed(1)}로 보합이며, 거시 환경은 중립입니다.\n\n미국 CPI 발표(내일)를 앞두고 시장이 관망 모드에 돌입한 상태입니다. 글로벌 유동성 지표는 소폭 개선 중입니다.` }),
  vibe:      (sym) => ({ bubble: `${sym} 시장 심리 중립~약세 — 공포탐욕 30대, 소셜 센티먼트 하락`, report: `${sym} 센티먼트/OI 분석:\n\n공포탐욕지수 ${Math.round(25+Math.random()*15)} (공포) — 시장 참여자들의 불안감이 높은 상태입니다. 역발상 관점에서는 매수 기회일 수 있으나, 추가 하락 가능성도 존재합니다.\n\n롱/숏 비율은 ${(58+Math.random()*8).toFixed(1)}/${(34+Math.random()*8).toFixed(1)}로 롱 우세이나 극단적이지는 않습니다. 최근 24시간 청산 규모는 롱 $${Math.round(50+Math.random()*80)}M / 숏 $${Math.round(20+Math.random()*40)}M입니다.\n\n소셜 미디어 센티먼트는 지난 주 대비 하락했으며, 트레이더들의 관망 심리가 강해지고 있습니다. 크립토 트위터(CT)에서는 "바닥은 아직" vs "여기서 롱" 의견이 팽팽합니다.` }),
  bull:      (sym,ctx) => ({ bubble: `${sym} 지지선 방어 성공 시 반등 여력 충분 — 매수 기회`, report: `매수(BULL) 논거:\n\n1. RSI 42는 과매도 근접 구간으로 반등 가능성이 높습니다.\n2. 거래소 유출 증가는 장기 보유 의지를 나타냅니다.\n3. 공포탐욕 30대는 역사적으로 바닥권 매수 구간이었습니다.\n4. 볼린저 밴드 하단 지지가 유효합니다.\n5. 펀딩레이트가 정상 범위로 과열 청산 리스크가 낮습니다.` }),
  bear:      (sym,ctx) => ({ bubble: `${sym} 하락 추세 지속 가능성 — 단기 이동평균 아래, 매도 압력 우세`, report: `매도(BEAR) 논거:\n\nBULL 측의 "RSI 반등" 주장에 대해 — RSI는 아직 30 이하가 아니며, 추가 하락 여지가 있습니다.\n\n1. SMA20, SMA50 모두 아래에 위치한 하락 추세입니다.\n2. MACD 히스토그램이 아직 음(-)이며 반전 신호가 없습니다.\n3. OI 증가 + 가격 하락은 새로운 숏 포지션 유입을 의미합니다.\n4. 롱 비율이 61%로 청산 사냥 하방 가능성이 있습니다.` }),
  ace:       (sym) => ({ bubble: `최종 판정: BUY ${sym}`, report: `전체 분석을 종합한 판정입니다.\n\n기술적으로 하락 추세이나 과매도 구간 진입 중이고, 온체인은 중립, 매크로는 혼조, 심리는 공포 구간입니다. 역발상 매수 관점과 추세 추종 매도 관점이 대립합니다.\n\n현 시점에서는 핵심 지지선 방어 여부를 확인한 후 조건부 매수가 적절합니다.`, action:'BUY', confidence:68, entry:64200, stop:62800, target:'66500 / 68000', rationale:'과매도 반등 + 거래소 유출 + 공포 구간 역발상. 단, 지지선 이탈 시 즉시 손절.' }),
  blitz:     (sym) => ({ bubble: `15분봉 스캘핑 — 되돌림 매수 대기`, report: `스캘핑 플랜 (20x):\n\n진입: $64,100~64,300 되돌림 구간 분할 매수\n손절: $63,800 (15분 종가 이탈)\n목표: $64,800 (1차), $65,200 (2차)\n\n20배 격리 청산가 $61,000은 손절선 대비 충분한 버퍼입니다. 지정가 손절 필수.` }),
  guard:     (sym) => ({ bubble: `[리스크 경고] 손익비 확인 필요 — 청산 버퍼 검증`, report: `리스크 관리 검증:\n\n1. 20배 격리 청산 $61,000은 손절선($62,800)에서 2.8% 아래 → 버퍼 적정\n2. ATR 대비 손절 폭: 1.8 ATR → 정상 범위\n3. 권장 비중: 자본의 2% 리스크 기준 → 0.14 BTC\n4. 수수료+슬리피지+펀딩 예상: $12.40\n5. 순수익 기대값: $282 (Net R:R 1.41)\n\n결론: 진입 가능. 단, 지정가 손절 반드시 설정. 시장가 손절 시 슬리피지 2배 가능.` }),
  risky:     (sym) => ({ bubble: `기회비용 관점 — 현재 진입은 합리적, 비중 확대 고려`, report: `공격적 리스크 심사:\n\n확신도 68%에서 자본 2% 리스크는 보수적입니다. Kelly 기준으로는 5.2% 리스크까지 허용 가능합니다.\n\n현재 시장 상황에서 과매도 반등은 빈도가 높으며, 놓치면 기회비용이 큽니다. 비중을 3%로 상향 검토를 권장합니다.\n\n판정: 승인 (비중 상향 권고)` }),
  safe:      (sym) => ({ bubble: `보수적 관점 — 추세 반전 확인 전 진입은 위험`, report: `보수적 리스크 심사:\n\n하락 추세에서의 역추세 매수는 성공률이 낮습니다. 확신도 68%는 "거의 동전 던지기" 수준입니다.\n\n최악 시나리오: 지지선 이탈 → 추가 10% 하락 → 20배 기준 자본 전액 손실 가능.\n\n손절이 작동하지 않을 경우(급락, 슬리피지)를 고려하면 레버리지를 10배로 낮추는 것이 안전합니다.\n\n판정: 조건부 승인 (레버리지 10배 제한)` }),
  neutral:   (sym) => ({ bubble: `중재안 — 분할 진입 + 레버리지 15배 + 엄격한 손절`, report: `중립 리스크 심사:\n\nRISKY의 비중 상향 vs SAFE의 레버리지 제한을 종합합니다.\n\n중재안:\n1. 레버리지 15배 (20배→15배 하향)\n2. 분할 진입 (50%+50%)\n3. 1차 진입 후 지지 확인 시 2차 진입\n4. 손절 $62,800 엄수\n\n이렇게 하면 RISKY의 기회비용 우려와 SAFE의 리스크 우려를 모두 수용합니다.\n\n판정: 조건부 승인` }),
  pm:        (sym,ctx) => ({ bubble: `수정승인 — 레버리지 15배, 분할 진입 조건`, report: `최종 승인 심사:\n\nACE 판정(LONG, 68%)과 리스크 위원회 심사를 종합합니다.\n\n리스크 위원회 3인 중 2인이 조건부 승인이므로 수정승인합니다.\n\n수정 사항:\n- 레버리지: 20배 → 15배\n- 진입: 분할 (50%+50%)\n- 1차 진입 후 15분봉 종가 확인 후 2차\n- 손절 $62,800 지정가 필수\n\n승인 이유: 확신도는 충분하나 리스크 위원회의 레버리지 제한 의견을 수용합니다.`, verdict:'수정승인', adjustments:'레버리지 15배, 분할 진입' }),
};

// ACE/GUARD는 Sonnet(정확한 판정), 나머지는 Haiku(빠른 분석)
const MODEL_FAST = 'claude-haiku-4-5-20251001';
const MODEL_SMART = 'claude-sonnet-4-6';
const SMART_AGENTS = new Set(['ace', 'guard', 'blitz']);

async function callClaude(system, prompt, apiKey, agentId) {
  const model = SMART_AGENTS.has(agentId) ? MODEL_SMART : MODEL_FAST;
  const maxTokens = SMART_AGENTS.has(agentId) ? 1500 : 1000;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${await res.text()}`);
  const d = await res.json();
  return d.content?.[0]?.text || '';
}

function buildPrompt(id, context) {
  const { market } = context;
  const sym = market?.symbol || 'BTC';
  const ind = market?.indicators;
  const common = `너는 CRYPTO TRADING TEAM의 에이전트다. 코인 선물(USDT 무기한) 전문가로서 아래 데이터만 사용해 분석하라. 도구·검색을 쓰지 마라.
반드시 JSON 하나만 출력: {"bubble":"말풍선 한 줄(한국어, 50자 이내)","report":"상세 분석(한국어, 5-10문장)"}
주의: JSON 내 숫자 필드(entry, stop, target 등)는 반드시 콤마 없는 순수 숫자로 작성하라. 예: 64200 (O), "64,200" (X)`;

  const indText = ind?.summaryLines?.join('\n') || '';
  const fundText = market?.fundamentals?.lines?.join('\n') || '';
  const derivText = market?.derivatives?.lines?.join('\n') || '';
  const sentText = market?.sentiment?.lines?.join('\n') || '';
  const newsText = market?.news?.headlines?.map(h => `- ${h.title} (${h.age})`).join('\n') || '';

  // engine.js가 넘기는 context 구조에 맞게 직렬화
  const fmtAnalyst = typeof context.analystReports === 'object' && context.analystReports !== null
    ? Object.entries(context.analystReports).map(([k,v]) => `[${k.toUpperCase()}] ${v}`).join('\n\n')
    : (context.analystReports || '');
  const fmtDebate = Array.isArray(context.debateLog)
    ? context.debateLog.map(d => `[${d.name || d.id}] ${d.report || d.bubble}`).join('\n\n')
    : (context.debateLog || '');
  const aceData = context.traderPlan || context.aceReport || null;
  // R:R 비율 자동 계산 (target이 문자열 "66500 / 68000" 형태 대응)
  let aceRR = 'N/A';
  if (typeof aceData === 'object' && aceData !== null && aceData.entry && aceData.stop && aceData.target) {
    const targetNum = typeof aceData.target === 'string'
      ? parseFloat(aceData.target.replace(/[^0-9.]/g, ''))
      : aceData.target;
    const entryNum = typeof aceData.entry === 'number' ? aceData.entry : parseFloat(String(aceData.entry).replace(/[^0-9.]/g, ''));
    const stopNum = typeof aceData.stop === 'number' ? aceData.stop : parseFloat(String(aceData.stop).replace(/[^0-9.]/g, ''));
    if (entryNum && stopNum && targetNum) {
      const riskDist = Math.abs(entryNum - stopNum);
      const rewardDist = Math.abs(targetNum - entryNum);
      if (riskDist > 0) aceRR = (rewardDist / riskDist).toFixed(1) + ':1';
    }
  }
  const fmtAce = typeof aceData === 'object' && aceData !== null
    ? `액션: ${aceData.action}, 확신도: ${aceData.confidence}%, 진입: ${aceData.entry}, 손절: ${aceData.stop}, 목표: ${aceData.target}, R:R = ${aceRR}\n근거: ${aceData.rationale || ''}`
    : (aceData || '');
  const fmtRisky = (typeof context.riskReports === 'object' && context.riskReports?.risky) || context.riskyReport || '';
  const fmtSafe = (typeof context.riskReports === 'object' && context.riskReports?.safe) || context.safeReport || '';
  const fmtRiskAll = typeof context.riskReports === 'object' && context.riskReports !== null
    ? Object.entries(context.riskReports).map(([k,v]) => `[${k.toUpperCase()}] ${v}`).join('\n\n')
    : (context.riskReports || '');

  // ═══ 캔들 50봉으로 확대 + 피보나치 레벨 자동 계산 ═══
  const candleData = market?.candles?.slice(-50) || [];
  const candlePrices = candleData.map(c => `O:${c.o} H:${c.h} L:${c.l} C:${c.c}`).join(' | ');
  const allHighs = candleData.map(c => c.h);
  const allLows = candleData.map(c => c.l);
  const currentPrice = ind?.price || candleData[candleData.length - 1]?.c || 0;

  // 피보나치 레벨 계산 (50봉 기준 고저)
  const swingHigh = allHighs.length ? Math.max(...allHighs) : 0;
  const swingLow = allLows.length ? Math.min(...allLows) : 0;
  const fiboRange = swingHigh - swingLow;
  const fiboLevels = fiboRange > 0 ? {
    '0.0% (고점)': swingHigh.toFixed(1),
    '23.6%': (swingHigh - fiboRange * 0.236).toFixed(1),
    '38.2%': (swingHigh - fiboRange * 0.382).toFixed(1),
    '50.0%': (swingHigh - fiboRange * 0.500).toFixed(1),
    '61.8%': (swingHigh - fiboRange * 0.618).toFixed(1),
    '78.6%': (swingHigh - fiboRange * 0.786).toFixed(1),
    '100.0% (저점)': swingLow.toFixed(1),
  } : null;
  const fiboText = fiboLevels
    ? Object.entries(fiboLevels).map(([k, v]) => `  ${k}: $${v}`).join('\n')
    : '(피보나치 데이터 부족)';

  // ═══ ATR(14) 실제 계산 ═══
  let atrVal = null;
  let atrText = '';
  if (quantSignals && candleData.length >= 15) {
    try {
      const { atr: atrFn } = require('./backtester');
      const atrValues = atrFn(candleData, 14);
      atrVal = atrValues[candleData.length - 1];
      if (atrVal) {
        const atrPct = (atrVal / currentPrice * 100).toFixed(2);
        atrText = `ATR(14): $${atrVal.toFixed(2)} (현재가의 ${atrPct}%)`;
      }
    } catch {}
  }
  if (!atrText && ind?.volatilityPct) {
    atrText = `연환산 변동성 ${ind.volatilityPct.toFixed(1)}%`;
  }

  // ═══ 퀀트 시그널 생성 (quant-signals.js 연동) ═══
  let quantSignalData = null;
  let quantText = '';
  let regimeText = '';
  let regimeStrategyHint = '';
  if (quantSignals && candleData.length >= 60) {
    try {
      quantSignalData = quantSignals.generateSignal(candleData);
      const qs = quantSignalData;
      const sc = qs.score || {};
      quantText = `═══ 퀀트 시그널 데이터 ═══
종합 점수: ${qs.totalScore > 0 ? '+' : ''}${qs.totalScore} (${qs.grade}등급, ${qs.action} 방향)
- RSI: ${sc.rsi > 0 ? '+' : ''}${sc.rsi}${qs.indicators?.rsi != null ? ` (RSI ${qs.indicators.rsi})` : ''}
- EMA: ${sc.ema > 0 ? '+' : ''}${sc.ema}${sc.ema > 0 ? ' (상승 정렬)' : sc.ema < 0 ? ' (하락 정렬)' : ' (중립)'}
- MACD: ${sc.macd > 0 ? '+' : ''}${sc.macd}${sc.macd > 0 ? ' (양수 확대)' : sc.macd < 0 && sc.macd > -30 ? ' (음수이지만 수렴 중)' : sc.macd < -30 ? ' (음수 확대)' : ''}
- BB: ${sc.bb > 0 ? '+' : ''}${sc.bb}${sc.bb > 40 ? ' (하단 터치)' : sc.bb < -40 ? ' (상단 터치)' : ''}
- 볼륨: ${sc.volume > 0 ? '+' : ''}${sc.volume}
- 모멘텀: ${sc.momentum > 0 ? '+' : ''}${sc.momentum}
- ADX: ${sc.adx > 0 ? '+' : ''}${sc.adx}
- StochRSI: ${sc.stochRsi > 0 ? '+' : ''}${sc.stochRsi}
- OBV: ${sc.obv > 0 ? '+' : ''}${sc.obv}
- 이치모쿠: ${sc.ichimoku > 0 ? '+' : ''}${sc.ichimoku}
- 피봇: ${sc.pivots > 0 ? '+' : ''}${sc.pivots}
- 패턴: ${sc.patterns > 0 ? '+' : ''}${sc.patterns}${qs.indicators?.pattern ? ` (${qs.indicators.pattern})` : ''}
- 온체인: ${sc.onchain > 0 ? '+' : ''}${sc.onchain}
- 거래소유출입: ${sc.exchangeFlow > 0 ? '+' : ''}${sc.exchangeFlow}${qs.indicators?.exchangeFlowInterpretation ? ` (${qs.indicators.exchangeFlowInterpretation})` : ''}`;

      // 마켓 레짐 정보
      const regime = qs.regime || {};
      const regimeMap = {
        'TRENDING_UP': '→ 추세 추종 롱 전략이 유리. 눌림목 매수, 추세선 기반 진입 권장',
        'TRENDING_DOWN': '→ 추세 추종 숏 전략이 유리. 반등 시 숏, 추세선 기반 진입 권장',
        'RANGING': '→ 추세 추종 전략보다 평균 회귀 전략이 유리. 좁은 범위 내 SL/TP 설정 권장. BB 상하단 반전 매매 유효',
        'VOLATILE': '→ 변동성 돌파 전략 유리. SL을 넓게, 포지션 사이즈를 줄여라. 브레이크아웃 트레이딩 유효',
        'NORMAL': '→ 복합 전략 가능. 기술적 신호와 온체인 데이터를 균형있게 참조하라',
      };
      regimeText = `═══ 마켓 레짐 ═══
현재 마켓 레짐: ${regime.regime || 'UNKNOWN'} (${regime.label || 'N/A'})
${regimeMap[regime.regime] || '→ 신중한 접근 권장'}
ADX: ${regime.adx ?? '?'} | BB폭: ${regime.bbWidth ?? '?'}% (평균 ${regime.bbWidthAvg ?? '?'}%) | ATR비율: ${regime.atrRatio ?? '?'}x`;
      regimeStrategyHint = regimeMap[regime.regime] || '';
    } catch (e) {
      quantText = '(퀀트 시그널 생성 실패)';
    }
  }

  // ═══ 멀티타임프레임 신호 (engine.js에서 시장 데이터에 포함) ═══
  let multiTFText = '';
  if (market?.multiTF) {
    const mtf = market.multiTF;
    const tfLines = mtf.timeframes ? Object.entries(mtf.timeframes).map(([tf, d]) =>
      `  ${tf}: ${d.action} [${d.grade}] 점수 ${d.score} (신뢰도 ${d.confidence}%)`
    ).join('\n') : '';
    multiTFText = `═══ 멀티타임프레임 분석 ═══
종합: ${mtf.action} [${mtf.grade}급] — ${mtf.reason}
가중 점수: ${mtf.weightedScore}
${tfLines}
→ 3TF 합의면 신뢰도 높음, 충돌이면 신중하게 접근하라.`;
  }

  // ═══ 백테스트 요약 주입 (context.backtestSummary로 전달받음) ═══
  let backtestText = '';
  if (context.backtestSummary) {
    const bt = context.backtestSummary;
    backtestText = `═══ 백테스트 참고 (최근 30일) ═══
승률: ${bt.winRate}% (${bt.totalTrades}건)
수익: $${bt.totalPnl} | 프로핏팩터: ${bt.profitFactor}
샤프: ${bt.sharpeRatio} | 최대낙폭: ${bt.maxDrawdown}%
→ 백테스트 결과를 참고하되, 현재 시장 상황을 우선시하라.`;
  }

  // 파생 데이터에서 정확한 수치 추출
  const deriv = market?.derivatives || {};
  const sent = market?.sentiment || {};
  const fundingRate = deriv.fundingRate != null ? (deriv.fundingRate * 100).toFixed(4) : '?';
  const openInterest = deriv.openInterest != null ? deriv.openInterest.toLocaleString() : '?';
  const oiUsdB = deriv.openInterest && currentPrice ? (deriv.openInterest * currentPrice / 1e9).toFixed(2) : '?';
  const longRatio = deriv.longRatio != null ? (deriv.longRatio * 100).toFixed(1) : '?';
  const shortRatio = deriv.longRatio != null ? ((1 - deriv.longRatio) * 100).toFixed(1) : '?';
  const fearGreed = sent.fearGreed != null ? sent.fearGreed : '?';
  const fgClass = sent.fgClass || '?';

  // 펀딩레이트 비용 계산
  const fundingCostText = fundingRate !== '?' ? (() => {
    const fr = parseFloat(fundingRate);
    const daily = (fr * 3).toFixed(4);
    const weekly = (fr * 3 * 7).toFixed(3);
    const annual = (fr * 3 * 365).toFixed(1);
    return `펀딩 비용: 8시간당 ${fundingRate}% | 일간 ${daily}% | 주간 ${weekly}% | 연환산 ${annual}%`;
  })() : '';

  // 메모리(과거 판정 결과) 직렬화
  const memoryText = Array.isArray(context.memory) ? `\n\n과거 판정 회고:\n${context.memory.join('\n')}` : '';

  // ATR 기반 SL/TP 참조값 (BLITZ/GUARD용)
  const atrSlTpText = atrVal ? (() => {
    const sl_1x = atrVal.toFixed(1);
    const sl_15x = (atrVal * 1.5).toFixed(1);
    const tp_2x = (atrVal * 2).toFixed(1);
    const tp_3x = (atrVal * 3).toFixed(1);
    const minSlPct = (currentPrice * 0.005).toFixed(1);
    return `═══ ATR 기반 SL/TP 참조 ═══
ATR(14) = $${atrVal.toFixed(2)}
SL 권장 범위: $${sl_1x} ~ $${sl_15x} (ATR 1.0x ~ 1.5x)
TP 권장 범위: $${tp_2x} ~ $${tp_3x} (ATR 2.0x ~ 3.0x)
최소 SL 금액: $${minSlPct} (현재가의 0.5%)
LONG SL 예시: $${(currentPrice - atrVal * 1.2).toFixed(1)} | TP 예시: $${(currentPrice + atrVal * 2.5).toFixed(1)}
SHORT SL 예시: $${(currentPrice + atrVal * 1.2).toFixed(1)} | TP 예시: $${(currentPrice - atrVal * 2.5).toFixed(1)}`;
  })() : '';

  const prompts = {
    taro: `${common}\n너는 TARO(기술적 분석가)다. ${sym}USDT 무기한 선물을 분석하라.

${regimeText}

반드시 아래 형식으로 구체적인 가격 수치를 포함하라:
1. 정확한 지지선 가격(최소 3개): 최근 50봉 저점들에서 여러 번 지지를 받은 레벨. 캔들 데이터의 저점(L)에서 클러스터를 찾고, 피보나치 레벨과 교차하는 지점을 우선하라.
2. 정확한 저항선 가격(최소 3개): 최근 50봉 고점들에서 여러 번 저항을 받은 레벨. 캔들 데이터의 고점(H)에서 클러스터를 찾고, 피보나치 레벨과 교차하는 지점을 우선하라.
3. RSI 정확한 수치와 다이버전스 여부 — RSI와 가격의 방향이 다르면 다이버전스로 판정
4. MACD 히스토그램의 정확한 값과 방향(수렴/발산 중) — 시그널선 크로스 임박 여부
5. SMA20, SMA50 대비 현재가의 정확한 괴리율(%)
6. ATR(14) 기반 현재 변동성 수치와 "변동성이 평균 대비 높은지 낮은지" 판단
7. 피보나치 되돌림 레벨 중 현재가에 가장 가까운 지지/저항 레벨을 명시하라

"지지선 부근", "저항 근처" 같은 모호한 표현 금지. 반드시 "$XX,XXX" 형태의 구체적 가격을 기재하라.

지표:
${indText}

${atrText}

피보나치 되돌림 레벨 (50봉 기준):
${fiboText}

최근 50봉 캔들(O:시가 H:고가 L:저가 C:종가):
${candlePrices}

${quantText}`,

    diana: `${common}\n너는 DIANA(온체인/펀더멘탈 분석가)다. ${sym}의 온체인 지표와 펀더멘탈을 분석하라.

${regimeText}

반드시 아래 수치를 정확하게 보고하라:
1. 현재 펀딩레이트: 정확한 % (${fundingRate}%) — 양수면 롱 과밀, 음수면 숏 과밀. 0.01% 이상이면 과열
   ${fundingCostText}
2. 미결제약정(OI): ${openInterest} ${sym} ($${oiUsdB}B) — 이 수치가 최근 7일 대비 높은지/낮은지 판단
3. 펀딩레이트와 OI 조합 해석: OI 증가 + 높은 펀딩 = 레버리지 과열, OI 감소 + 음수 펀딩 = 숏 청산 가능
4. 거래대금과 시가총액 비율 — 과열/침체 판단
5. ATH 대비 현재 위치(%)

"중립적", "보통" 같은 모호한 판단 금지. 수치를 제시하고 그 수치가 의미하는 바를 명확히 하라.

${fundText}
${derivText}
${quantText}`,

    nova: `${common}\n너는 NOVA(매크로/펀딩 분석가)다. ${sym}의 매크로 환경과 파생 지표를 분석하라.

${regimeText}

반드시 아래 사항을 구체적으로 보고하라:
1. DXY(달러 인덱스) 레벨 인식: 100 이하 = 크립토 우호, 103-105 = 중립, 105 이상 = 크립토 불리. 현재 추세 방향도 언급
2. BTC 도미넌스 컨텍스트: 50% 이상이면 알트 약세, 45% 이하면 알트시즌. ${sym}이 BTC가 아니면 BTC 도미넌스 변화가 이 코인에 미치는 영향
3. 펀딩레이트 ${fundingRate}% 해석:
   ${fundingCostText}
   10x 레버리지 포지션 $10,000 기준 8시간당 펀딩 비용을 정확히 계산하라
4. OI $${oiUsdB}B가 시장 규모 대비 적정한지
5. 다음 주요 매크로 이벤트(FOMC, CPI 등) 예상과 시장 영향
6. 글로벌 유동성 방향(긴축/완화)이 크립토에 미치는 영향

${derivText}
${indText}
${quantText}`,

    vibe: `${common}\n너는 VIBE(센티먼트/OI 분석가)다. ${sym}의 시장 심리와 미결제약정을 분석하라.

${regimeText}

반드시 아래 정확한 수치를 포함하라:
1. 공포탐욕지수: 정확히 ${fearGreed} (${fgClass}) — 0-25 극단적 공포(역발상 매수), 25-45 공포, 45-55 중립, 55-75 탐욕, 75-100 극단적 탐욕(역발상 매도)
2. 롱/숏 비율: 정확히 롱 ${longRatio}% / 숏 ${shortRatio}%
   ★ 롱 비율 65% 이상이면: "청산 사냥 시나리오"를 반드시 분석하라 — 대형 거래소가 롱 포지션 청산을 유발할 수 있는 가격 레벨($XX,XXX)을 제시하라
   ★ 숏 비율 65% 이상이면: "숏스퀴즈 시나리오"를 반드시 분석하라 — 숏 커버링이 폭발할 가격 레벨을 제시하라
3. 펀딩레이트 ${fundingRate}%가 시사하는 포지션 편향
   ${fundingCostText}
   20x 포지션 $10,000 기준 8시간당 수수료 부담: $${fundingRate !== '?' ? (10000 * parseFloat(fundingRate) / 100).toFixed(2) : '?'}
4. 최근 24시간 청산 규모 추정: 롱 과밀이면 하방 청산 사냥 가능성, 숏 과밀이면 상방 숏스퀴즈 가능성. 예상 청산 트리거 가격을 제시하라
5. 뉴스 심리 종합: 강세/약세/중립 뉴스 비중

수치 없이 "심리가 좋다/나쁘다"는 금지. 반드시 숫자와 함께 해석하라.

${sentText}
뉴스:
${newsText}
${quantText}`,

    bull: `${common}\n너는 BULL(매수 논거 담당)이다. 애널리스트 리포트를 바탕으로 ${sym} 매수 근거를 5가지 이상 제시하라.

${regimeText}

규칙:
- 반드시 리포트에서 구체적 수치를 인용하라 (예: "RSI 32는 과매도 구간", "$64,200 지지선 테스트 3회 성공")
- 각 근거에 확률적 판단을 붙여라 (예: "이 패턴에서 반등 확률은 역사적으로 ~65%")
- 퀀트 시그널이 BUY라면 그 점수를 인용하고, SELL이라면 퀀트와 다른 매수 근거를 제시하라
- 모호한 "상승 여력이 있다" 같은 표현 금지

${fmtAnalyst}
${quantText}`,

    bear: `${common}\n너는 BEAR(매도 논거 담당)이다. BULL의 주장을 직접 반박하며 ${sym} 매도 근거를 5가지 이상 제시하라.

${regimeText}

규칙:
- BULL이 인용한 수치에 대해 반대 해석을 제시하라 (예: "RSI 32이지만 추세 하락에서는 20까지 갈 수 있다")
- 반드시 구체적 하방 타겟 가격을 제시하라
- 퀀트 시그널이 SELL이라면 그 점수를 인용하고, BUY라면 퀀트가 놓치는 리스크를 지적하라
- 모호한 "더 떨어질 수 있다" 금지. "$XX,XXX까지 추가 하락 가능" 식으로 써라

${fmtAnalyst}

BULL 주장:
${fmtDebate}
${quantText}`,

    ace: `${common.replace('{"bubble"', '{"bubble"')}\n너는 ACE(수석 트레이더)다. 전체 분석과 토론을 종합해 최종 판정하라.
JSON에 추가: "action":"LONG|SHORT|HOLD","confidence":0-100,"entry":진입가(정확한 숫자 1개),"stop":손절가(정확한 숫자 1개),"target":"목표가","rationale":"근거 2-3문장"

${regimeText}

${quantText}

${multiTFText}

═══ AI vs 퀀트 크로스체크 ═══
위 퀀트 시그널 데이터를 너의 정성적 분석과 직접 비교하라:
1. 퀀트가 BUY인데 너도 LONG이면 → 확신도 +5~10 가산
2. 퀀트가 BUY인데 너는 SHORT이면 → 반드시 "왜 퀀트와 다른 판단인지" 근거를 report에 명시
3. 퀀트 등급이 S/A이면 → 해당 방향으로의 진입을 매우 강하게 고려하라
4. 퀀트 등급이 D이면 → HOLD 경향이 강하지만, 정성적 우위가 있으면 진입 가능

═══ 진입 편향 원칙 ═══
시장에 항상 기회가 있다. HOLD는 명확한 위험이 있을 때만 선택하라. 약간이라도 우위가 있으면 진입하라.
너는 수익을 만드는 트레이더다. 관망은 수익을 만들지 않는다. 방향이 조금이라도 보이면 LONG 또는 SHORT를 선택하라.

═══ HOLD 제한 조건 ═══
HOLD를 선택할 경우 반드시 다음 중 하나를 만족해야 한다:
(1) RSI가 45-55 완전 중립 구간에 있어 방향성 제로
(2) 모든 지표(기술적/온체인/매크로/센티먼트)가 서로 상충하여 어떤 방향으로도 우위 없음
(3) 주요 뉴스 이벤트(FOMC, CPI 등)가 30분 이내로 임박
(4) 퀀트 등급이 D이고 정성적 분석도 중립
위 조건 어느 것도 해당하지 않으면 반드시 LONG 또는 SHORT를 선택하라.

═══ 확신도-포지션 매핑 ═══
- 확신도 40-50: 약한 신호지만 진입 가능 (최소 사이즈)
- 확신도 50-65: 표준 진입 (기본 사이즈)
- 확신도 65-80: 강한 진입 (사이즈 1.5배)
- 확신도 80+: 풀 사이즈 진입 (최대 허용)
확신도 40 이상이면 진입하라. 40 미만일 때만 HOLD를 고려하라.

${atrSlTpText}

핵심 규칙:
1. entry는 정확한 가격 1개만 (범위 금지). 현재가 $${currentPrice}를 기준으로 설정. 콤마 없이 순수 숫자로: 예) 64200
2. stop은 ATR 기반으로 설정. ATR의 1.0~1.5배. SL이 진입가의 0.5% 미만이면 너무 좁다 — 최소 0.5% 이상으로 설정
3. target은 SL의 2배 이상 거리. R:R 최소 2:1 이상을 목표로 하되, 시장 구조에 따라 1.5:1까지 허용
4. report에 "R:R = X.X:1, 리스크 $XXX, 리워드 $XXX" 형태로 명시
5. HOLD를 선택할 때도 "어떤 조건이 충족되면 진입" 트리거를 반드시 제시
6. 마켓 레짐에 맞는 전략을 선택하라: RANGING이면 평균회귀, TRENDING이면 추세추종
${backtestText}${memoryText}
${learner ? learner.buildLearningPromptSection(sym) : ''}
${fmtAnalyst}
${fmtDebate}`,

    blitz: `${common}\n너는 BLITZ(스캘퍼)다. ${sym}USDT 15분봉 기준 스캘핑 플랜을 제시하라. 20배 레버리지 기준.
JSON에 추가: "direction":"LONG|SHORT","scalp_entry":진입가(숫자),"scalp_stop":손절가(숫자),"scalp_target":목표가(숫자)

${regimeText}

${atrSlTpText}

═══ 스캘핑 원칙 ═══
1. 진입 타이밍: 현재가 $${currentPrice}에서 즉시 진입 가능한 가격을 제시하라. 대기 주문이 아닌 시장가 기준. scalp_entry는 현재가와 0.1% 이내여야 한다.
2. 손절 정밀도 (ATR 필수):
   - 반드시 ATR(14) 값 $${atrVal ? atrVal.toFixed(2) : '?'}을 기반으로 SL을 설정하라
   - SL = ATR × 1.0~1.5배. 너무 타이트하면(0.5배 미만) 노이즈에 걸린다. 너무 넓으면(2.0배 이상) 스캘핑이 아니다
   - ★ SL이 진입가의 0.5% 미만이면 너무 좁다. 최소 0.5% 이상으로 설정하라
   - ★ SL이 진입가의 2% 이상이면 너무 넓다. 스캘핑에 적합하지 않다
3. 목표가 정밀도:
   - ★ TP는 SL의 2배 이상. R:R 최소 2:1. 이보다 낮으면 스캘핑 기대값이 음수
   - TP = ATR × 2.0~3.0배 권장
4. 마켓 레짐 적용: ${regimeStrategyHint || '현재 시장에 맞는 전략 적용'}
5. 스캘핑 편향: 단기 모멘텀이 있으면 적극 진입하라. 관망보다 작은 손실이 낫다.

진입가/손절가/목표가 모두 정확한 1개 가격(콤마 없는 숫자). 범위 금지.
${learner ? learner.buildBlitzLearningSection(sym) : ''}
${indText}
최근 50봉 캔들: ${candlePrices}
${quantText}`,

    guard: (() => {
      const scalpBlitz = context.scalpReports?.blitz || '';
      const planText = fmtAce || (scalpBlitz ? `[BLITZ 스캘핑 판정]\n${scalpBlitz}` : '(판정 데이터 없음)');
      return `${common}\n너는 GUARD(리스크 관리)다. 트레이더의 판정을 리스크 관점에서 검증하라.

${regimeText}

═══ 데이터 추출 원칙 ═══
"데이터 부족"이라고 절대 말하지 마라. 아래 판정 텍스트에서 진입가, 손절가, 목표가를 직접 파싱하라.
숫자가 "$64,200" 또는 "64200" 형태로 있으면 그것을 사용하라.
BLITZ 리포트의 텍스트에서도 가격을 추출하여 검증에 사용하라.

${atrSlTpText}

반드시 아래를 정확히 계산하라 (구체적 숫자로):
주의: 레버리지는 기본 20배이나, PM이 조정할 수 있다. 리스크 심사에서 레버리지 변경 의견이 있으면 그 값을 사용하라.
실제 적용 레버리지: ${context.riskReports?.neutral?.match?.(/(\d+)배/) ? context.riskReports.neutral.match(/(\d+)배/)[1] : '20'}배
1. 격리 청산가 = 진입가 × (1 - 1/레버리지) — 롱 기준. 숏이면 진입가 × (1 + 1/레버리지). 정확한 달러 금액을 계산하라
2. 손절가와 청산가의 버퍼 = (손절가 - 청산가) / 진입가 × 100 (%). 구체적 %를 계산하라
3. ATR 대비 손절 폭 = |진입가 - 손절가| / ATR(14)=$${atrVal ? atrVal.toFixed(2) : '?'}. 구체적 배수를 계산하라
   ★ 1.0배 미만이면 "SL 너무 좁음 — 노이즈 히트 위험" 경고
   ★ 2.0배 이상이면 "SL 너무 넓음 — 스캘핑에 부적합" 경고
4. SL이 진입가의 0.5% 미만이면 "SL 부적절 — 최소 0.5% 이상 필요" 경고를 반드시 발하라
5. 권장 비중: 자본의 2% 리스크 기준 → 수량 = (자본 × 0.02) / |진입가 - 손절가|. $10,000 자본 기준으로 계산하라
6. 총 비용 = (수량 × 진입가 × 0.04%) × 2(진입+청산) + 펀딩(${fundingRate}% × 포지션). 정확한 달러 금액을 계산하라
7. 순 Risk:Reward = (목표수익 - 총비용) / (리스크 + 총비용). 소수점 2자리까지 계산하라
   ★ R:R < 1.5이면 "기대값 부족 — R:R 2:1 이상 권장" 경고

모든 계산은 반드시 구체적 숫자를 넣어서 보여줘라. "약 ~", "대략" 금지.
${learner ? learner.buildGuardLearningSection(sym) : ''}
트레이더 판정:
${planText}`;
    })(),

    risky: `${common}\n너는 RISKY(공격적 리스크 심사자)다. 기회비용 관점에서 ACE 계획이 충분히 공격적인지 평가하라.
JSON에 추가: "verdict":"승인|수정|기각"

${regimeText}

ACE 판정:
${fmtAce}
${quantText}`,

    safe: `${common}\n너는 SAFE(보수적 리스크 심사자)다. 최악 시나리오와 꼬리 위험 관점에서 평가하라. 20배 청산 위험을 반드시 검증하라.
JSON에 추가: "verdict":"승인|수정|기각"

${regimeText}

ACE 판정:
${fmtAce}
${quantText}`,

    neutral: `${common}\n너는 NEUTRAL(중립 리스크 심사자)다. RISKY와 SAFE의 주장을 중재하여 조건부 승인안을 제시하라.
JSON에 추가: "verdict":"조건부승인|승인|기각","condition":"조건"

${regimeText}

ACE 판정:
${fmtAce}
RISKY: ${fmtRisky}
SAFE: ${fmtSafe}
${quantText}`,

    pm: `${common}\n너는 PM(포트폴리오 매니저)이다. ACE 판정과 리스크 위원회 심사를 종합해 최종 승인/수정승인/기각을 결정하라.
JSON에 추가: "verdict":"승인|수정승인|기각","adjustments":"수정사항","sizing":"권장 포지션 크기","leverage":숫자

${regimeText}

핵심 규칙:
1. Kelly Criterion 포지션 사이징을 계산하라:
   - 과거 승률(winRate)이 있으면 사용, 없으면 확신도 기반으로 추정 (확신도 60% → 승률 55% 가정)
   - R:R(Risk:Reward) = ${aceRR} ← ACE 판정에서 자동 계산된 값
   - Kelly% = W - (1-W)/R, 여기서 W=승률, R=Risk:Reward ratio
   - Half-Kelly 적용 (보수적): Kelly% / 2
   - "sizing" 필드에 "자본의 X% (Half-Kelly, R:R=${aceRR})" 형태로 기재
2. 리스크 위원회 3인 중 다수결 따르되, 이유가 타당하면 소수 의견도 반영 가능
3. 최종 조정 사항(레버리지, 분할 진입 등)을 구체적으로 명시. leverage 필드에 최종 레버리지 숫자 기재
4. 퀀트 시그널과 AI 판정이 일치하면 확신도 가산, 불일치하면 그 이유를 sizing에 반영${memoryText}

ACE 판정:
${fmtAce}
리스크 심사:
${fmtRiskAll}
${quantText}`,
  };

  return prompts[id] || common;
}

async function runAgent(id, context, opts = {}) {
  if (opts.mock) {
    const mockFn = MOCK[id];
    if (mockFn) {
      await new Promise(r => setTimeout(r, 500 + Math.random() * 1500)); // 시뮬레이션 딜레이
      return mockFn(context.market?.symbol || 'BTC', context);
    }
    return { bubble: '분석 완료', report: '(mock 데이터 없음)' };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { bubble: 'API 키 미설정', report: 'ANTHROPIC_API_KEY를 .env에 설정하세요.' };

  const prompt = buildPrompt(id, context);
  let lastText = '';
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const text = await callClaude('', prompt, apiKey, id);
      lastText = text;
      const parsed = extractJson(text);
      if (parsed && parsed.bubble) return parsed;
      // JSON은 파싱됐지만 bubble이 없으면 report에서 생성
      if (parsed && parsed.report) return { bubble: (parsed.report || '').slice(0, 50), ...parsed };
    } catch (e) {
      lastErr = e.message;
    }
  }
  // 마지막 시도: raw text에서 의미있는 내용 추출
  if (lastText && lastText.length > 10) {
    const lines = lastText.split('\n').filter(l => l.trim());
    return { bubble: lines[0]?.slice(0, 50) || '분석 완료', report: lastText.slice(0, 2000) };
  }
  return { bubble: '분석 실패', report: lastErr ? `(API 오류) ${lastErr}` : '(JSON 파싱 실패 — Claude 응답 비어있음)' };
}

// 원본 engine.js 호환용 — claude CLI 대신 API 사용하므로 항상 true
async function checkClaudeAvailable() {
  const hasKey = !!process.env.ANTHROPIC_API_KEY;
  return { ok: hasKey, message: hasKey ? 'Anthropic API 키 설정됨' : 'ANTHROPIC_API_KEY 미설정 — 데모만 가능' };
}

module.exports = { AGENTS, extractJson, runAgent, buildPrompt, checkClaudeAvailable };
