// VPS Trading Team 엔진 프록시 — 모든 /api/tt/* 요청을 VPS로 중계
const TT_URL = process.env.TRADING_TEAM_URL || 'http://158.247.252.39:8000';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // /api/tt/paper/status → /api/paper/status
  const path = req.url.replace(/^\/api\/tt/, '/api');

  try {
    const opts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    };

    if (req.method === 'POST' && req.body) {
      opts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(TT_URL + path, opts);
    const contentType = upstream.headers.get('content-type') || '';

    if (contentType.includes('text/event-stream')) {
      // SSE 프록시
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      const reader = upstream.body?.getReader();
      if (!reader) return res.status(502).end();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(decoder.decode(value, { stream: true }));
        }
      } catch (_) {}
      return res.end();
    }

    const data = await upstream.text();
    res.status(upstream.status);
    if (contentType) res.setHeader('Content-Type', contentType);
    res.end(data);
  } catch (e) {
    res.status(502).json({ error: 'VPS 연결 실패', detail: e.message });
  }
}
