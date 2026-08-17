// VPS Trading Team 엔진 프록시
const TT_URL = process.env.TRADING_TEAM_URL || 'http://158.247.252.39:8000';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // /api/tt?p=/paper/status → VPS /api/paper/status
  const apiPath = req.query.p || '/health';
  const url = TT_URL + '/api' + apiPath;

  try {
    const opts = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(25000),
    };

    if (req.method === 'POST' && req.body) {
      opts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url, opts);
    const data = await upstream.text();
    const ct = upstream.headers.get('content-type') || 'application/json';
    res.setHeader('Content-Type', ct);
    res.status(upstream.status).end(data);
  } catch (e) {
    res.status(502).json({ error: 'VPS 연결 실패', detail: e.message, url });
  }
}
