// ══════════════════════════════════════════════
// GATEWAY EVENTS — SSE 스트림 (Billion → Terminal → Trading Team)
//
// Billion 프론트엔드가 EventSource로 구독.
// Trading Team의 SSE(/api/stream)를 릴레이하여 실시간 분석 이벤트를 전달.
// ══════════════════════════════════════════════

const GATEWAY_SECRET = process.env.GATEWAY_SECRET || 'motera-billion-bridge-2026';
const TRADING_TEAM_URL = process.env.TRADING_TEAM_URL || 'http://localhost:8000';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Gateway-Key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // ── POST: 이벤트 수신 (Billion이 분석 완료 등을 푸시) ──
  if (req.method === 'POST') {
    const key = req.headers['x-gateway-key'];
    if (key !== GATEWAY_SECRET) {
      return res.status(401).json({ error: 'Invalid gateway key' });
    }
    const { type, data } = req.body || {};
    // 이벤트 저장 (Vercel 서버리스는 stateless이므로 로그만)
    console.log(`[gateway/events] Received: ${type}`, JSON.stringify(data).slice(0, 200));
    return res.json({ received: true, type, timestamp: new Date().toISOString() });
  }

  // ── GET: SSE 스트림 ──
  if (req.method === 'GET') {
    const key = req.query?.key || req.headers['x-gateway-key'];
    if (key !== GATEWAY_SECRET) {
      return res.status(401).json({ error: 'Invalid gateway key' });
    }

    // Vercel Serverless에서는 장시간 SSE가 제한적 (최대 ~25초)
    // 대안: Trading Team의 최근 이벤트를 폴링하여 전달
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Trading Team SSE에서 이벤트를 가져와 릴레이
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000); // Vercel 제한

      const ttRes = await fetch(`${TRADING_TEAM_URL}/api/stream`, {
        signal: controller.signal,
        headers: { Accept: 'text/event-stream' },
      });

      if (!ttRes.ok) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Trading Team 연결 실패' })}\n\n`);
        clearTimeout(timeout);
        return res.end();
      }

      const reader = ttRes.body?.getReader();
      if (!reader) {
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream reader 생성 실패' })}\n\n`);
        clearTimeout(timeout);
        return res.end();
      }

      // 연결 성공 알림
      res.write(`data: ${JSON.stringify({ type: 'gateway:connected', tradingTeam: 'LIVE', timestamp: new Date().toISOString() })}\n\n`);

      const decoder = new TextDecoder();
      let buffer = '';

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                // Trading Team 이벤트를 그대로 릴레이
                res.write(line + '\n\n');
              } else if (line.startsWith(':ping')) {
                res.write(':ping\n\n');
              }
            }
          }
        } catch (err) {
          if (err.name !== 'AbortError') {
            res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
          }
        } finally {
          clearTimeout(timeout);
          reader.releaseLock();
          res.end();
        }
      };

      // 클라이언트 연결 종료 감지
      req.on('close', () => {
        controller.abort();
        clearTimeout(timeout);
      });

      await pump();
    } catch (err) {
      // Trading Team에 연결할 수 없는 경우 — 상태만 알리고 종료
      res.write(`data: ${JSON.stringify({ type: 'gateway:standalone', message: 'Trading Team 오프라인, 독립 모드', timestamp: new Date().toISOString() })}\n\n`);

      // 10초 keepalive 후 종료 (Vercel 제한)
      let count = 0;
      const interval = setInterval(() => {
        count++;
        if (count > 5) {
          clearInterval(interval);
          res.end();
          return;
        }
        res.write(':ping\n\n');
      }, 2000);

      req.on('close', () => clearInterval(interval));
    }
  }
}
