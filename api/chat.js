const BILLION_URL = process.env.BILLION_URL || 'https://agent.mot-era.com';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { message, messages, context } = req.body || {};
  if (!message && (!messages || messages.length === 0)) return res.status(400).json({ error: 'No message' });

  // 서버 사이드 컨텍스트 보강 — /api/context에서 풍부한 시장 데이터 수집
  let enrichedContext = context || '';
  try {
    const ctxRes = await fetch(`${new URL(req.url, `http://${req.headers.host}`).origin}/api/context`, {
      signal: AbortSignal.timeout(5000),
    });
    if (ctxRes.ok) {
      const serverCtx = await ctxRes.json();
      // 클라이언트 컨텍스트와 서버 컨텍스트 합치기
      let merged = context || '';
      if (serverCtx.news?.length) {
        merged += '\n\n[최신 뉴스]\n' + serverCtx.news.slice(0, 5).map(n => `- ${n.title} (${n.source}, ${n.age})`).join('\n');
      }
      if (serverCtx.calendar?.length) {
        merged += '\n\n[매크로 일정]\n' + serverCtx.calendar.slice(0, 5).map(e => `- ${e.event} (${e.date}, 중요도:${e.importance})`).join('\n');
      }
      if (serverCtx.fund) {
        const f = serverCtx.fund;
        merged += `\n\n[펀드 상태] 자본:$${f.capital} 수익률:${f.returnPct}% 승률:${f.winRate}% 포지션:${(f.positions||[]).length}개 MDD:${f.maxDrawdown}% 서킷브레이커:${f.circuitBreakerActive?'ON':'OFF'} 레짐:${f.marketRegime}`;
      }
      enrichedContext = merged;
    }
  } catch (_) { /* 서버 컨텍스트 실패 시 클라이언트 컨텍스트만 사용 */ }

  try {
    const response = await fetch(`${BILLION_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messages || [{ role: 'user', content: message }],
        context: enrichedContext,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const data = await response.json();
    // 빌리언의 text + actions 모두 전달
    res.json({
      text: data.text || '',
      actions: data.actions || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
