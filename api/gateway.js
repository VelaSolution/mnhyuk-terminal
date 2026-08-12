// ══════════════════════════════════════════════
// TERMINAL GATEWAY — Billion(비서) ↔ Terminal(컨트롤 타워) ↔ Trading Team(엔진)
//
// Billion이 보내는 명령을 받아 처리하거나 Trading Team으로 전달.
// GET: 연결 상태 확인 (heartbeat)
// POST: action 기반 명령 라우팅
// ══════════════════════════════════════════════

const GATEWAY_SECRET = process.env.GATEWAY_SECRET || 'motera-billion-bridge-2026';
const TRADING_TEAM_URL = process.env.TRADING_TEAM_URL || 'http://localhost:8000';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// 간단한 인메모리 상태
let terminalState = {
  locked: false,
  lockReason: '',
  lastAnalysis: null,
  lastEvent: null,
};

function validateKey(req) {
  const key = req.headers['x-gateway-key'];
  return key === GATEWAY_SECRET;
}

async function fetchWithTimeout(url, opts = {}, timeout = 5000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Gateway-Key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET: heartbeat / 상태 확인 ──
  if (req.method === 'GET') {
    if (!validateKey(req)) {
      return res.status(401).json({ error: 'Invalid gateway key' });
    }

    // Trading Team 연결 확인
    let tradingTeamStatus = 'DISCONNECTED';
    try {
      const ttRes = await fetchWithTimeout(`${TRADING_TEAM_URL}/api/tape`, {}, 3000);
      if (ttRes.ok) tradingTeamStatus = 'CONNECTED';
    } catch {}

    return res.json({
      status: 'LIVE',
      role: 'TERMINAL (컨트롤 타워)',
      locked: terminalState.locked,
      tradingTeam: tradingTeamStatus,
      lastAnalysis: terminalState.lastAnalysis,
      timestamp: new Date().toISOString(),
    });
  }

  // ── POST: 명령 라우팅 ──
  if (req.method === 'POST') {
    if (!validateKey(req)) {
      return res.status(401).json({ error: 'Invalid gateway key' });
    }

    const { action, data } = req.body || {};

    switch (action) {
      // ── analyze: Trading Team에 분석 요청 전달 ──
      case 'analyze': {
        const symbol = data?.symbol || 'BTC';
        const mode = data?.mode || 'algo';
        const demo = data?.demo || false;

        try {
          // Trading Team 서버에 분석 요청
          const ttRes = await fetchWithTimeout(`${TRADING_TEAM_URL}/api/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, mode, demo }),
          }, 10000);

          const result = await ttRes.json();
          terminalState.lastAnalysis = {
            symbol, mode, demo,
            status: ttRes.status,
            timestamp: new Date().toISOString(),
          };

          return res.status(ttRes.status).json({
            ...result,
            source: 'trading-team',
            relayed: true,
          });
        } catch (err) {
          // Trading Team 연결 실패 시, Terminal 자체 분석으로 폴백
          try {
            const fallbackRes = await fetch(
              `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}/api/analyze`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ symbol }),
              }
            );
            const fallbackData = await fallbackRes.json();
            terminalState.lastAnalysis = {
              symbol, mode: 'terminal-fallback',
              timestamp: new Date().toISOString(),
            };
            return res.json({
              ...fallbackData,
              source: 'terminal-fallback',
              note: 'Trading Team 연결 불가, Terminal 자체 분석 사용',
            });
          } catch {
            return res.status(502).json({
              error: 'Trading Team 및 Terminal 분석 모두 실패',
              tradingTeamError: err.message,
            });
          }
        }
      }

      // ── status: 전체 시스템 상태 ──
      case 'status': {
        let tradingTeamStatus = null;
        try {
          const ttRes = await fetchWithTimeout(`${TRADING_TEAM_URL}/api/tape`, {}, 3000);
          if (ttRes.ok) {
            const tape = await ttRes.json();
            tradingTeamStatus = {
              status: 'CONNECTED',
              coins: Array.isArray(tape) ? tape.length : 0,
            };
          }
        } catch {}

        return res.json({
          terminal: 'LIVE',
          locked: terminalState.locked,
          tradingTeam: tradingTeamStatus || { status: 'DISCONNECTED' },
          lastAnalysis: terminalState.lastAnalysis,
          timestamp: new Date().toISOString(),
        });
      }

      // ── tape: 시세 테이프 (Trading Team → 캐시) ──
      case 'tape': {
        try {
          const ttRes = await fetchWithTimeout(`${TRADING_TEAM_URL}/api/tape`, {}, 5000);
          const tape = await ttRes.json();
          return res.json(tape);
        } catch {
          // Trading Team 불가 시 CoinGecko 직접 조회
          try {
            const ids = 'bitcoin,ethereum,solana,ripple,dogecoin,cardano,avalanche-2,chainlink';
            const cgRes = await fetchWithTimeout(
              `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`,
              {}, 5000
            );
            const data = await cgRes.json();
            const idMap = { bitcoin: 'BTC', ethereum: 'ETH', solana: 'SOL', ripple: 'XRP', dogecoin: 'DOGE', cardano: 'ADA', 'avalanche-2': 'AVAX', chainlink: 'LINK' };
            const tape = Object.entries(data).map(([id, d]) => ({
              symbol: idMap[id] || id.toUpperCase(),
              price: d.usd,
              change24h: d.usd_24h_change,
              volume: d.usd_24h_vol,
              source: 'coingecko-fallback',
            }));
            return res.json(tape);
          } catch {
            return res.status(502).json({ error: '시세 데이터 조회 실패' });
          }
        }
      }

      // ── chat: Terminal AI 채팅 ──
      case 'chat': {
        const messages = data?.messages || [];
        if (!ANTHROPIC_API_KEY) {
          return res.status(500).json({ error: 'API key not configured' });
        }
        try {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 1000,
              system: '당신은 MOTERA Terminal의 AI 어시스턴트입니다. 크립토 시장 분석, 매매 전략, 기술적 분석에 대해 한국어로 간결하게 답변하세요. 대표님에게 보고하는 톤으로 대화합니다.',
              messages,
            }),
          });
          const result = await response.json();
          return res.json({
            reply: result.content?.[0]?.text || '응답 생성 실패',
            model: 'claude-haiku-4-5',
          });
        } catch (e) {
          return res.status(500).json({ error: e.message });
        }
      }

      // ── info: 시스템 정보 ──
      case 'info': {
        return res.json({
          name: 'MOTERA Terminal',
          version: '2.0',
          role: '크립토 관제 컨트롤 타워',
          endpoints: ['analyze', 'scan', 'chat', 'health', 'rss'],
          tradingTeamUrl: TRADING_TEAM_URL,
          uptime: process.uptime?.() || 0,
        });
      }

      // ── lock: 터미널 잠금 ──
      case 'lock': {
        terminalState.locked = true;
        terminalState.lockReason = data?.reason || 'Remote lock';
        return res.json({
          success: true,
          locked: true,
          reason: terminalState.lockReason,
        });
      }

      // ── unlock: 터미널 잠금 해제 ──
      case 'unlock': {
        terminalState.locked = false;
        terminalState.lockReason = '';
        return res.json({ success: true, locked: false });
      }

      // ── scan: 멀티 코인 스캔 ──
      case 'scan': {
        try {
          // Trading Team의 scan-all 사용 시도
          const ttRes = await fetchWithTimeout(
            `${TRADING_TEAM_URL}/api/scan-all`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' } },
            15000
          );
          if (ttRes.ok) {
            const result = await ttRes.json();
            return res.json({ ...result, source: 'trading-team' });
          }
        } catch {}

        // 폴백: Terminal 자체 scan
        try {
          const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;
          const scanRes = await fetch(`${baseUrl}/api/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
          const result = await scanRes.json();
          return res.json({ ...result, source: 'terminal' });
        } catch (e) {
          return res.status(500).json({ error: e.message });
        }
      }

      // ── push_event: Trading Team에서 이벤트 수신 ──
      case 'push_event': {
        const eventType = data?.type || 'unknown';
        terminalState.lastEvent = {
          type: eventType,
          data,
          timestamp: new Date().toISOString(),
        };

        // Trading Team 판정 이벤트면 Billion에도 전달
        if (eventType === 'trading:decision' || eventType === 'trading:completed') {
          const BILLION_URL = process.env.BILLION_URL || 'http://localhost:3847';
          try {
            await fetchWithTimeout(`${BILLION_URL}/api/motera`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Gateway-Key': GATEWAY_SECRET,
              },
              body: JSON.stringify({
                action: 'push_data',
                data: { type: eventType, ...data },
              }),
            }, 5000);
          } catch {}
        }

        return res.json({
          received: true,
          type: eventType,
          timestamp: new Date().toISOString(),
        });
      }

      // ── recent_events: 최근 이벤트 조회 ──
      case 'recent_events': {
        return res.json({
          lastEvent: terminalState.lastEvent,
          lastAnalysis: terminalState.lastAnalysis,
          timestamp: new Date().toISOString(),
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  }

  res.status(405).json({ error: 'Method not allowed' });
}
