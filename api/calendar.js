export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200'); // 6시간 캐시

  try {
    // Investing.com economic calendar (this week)
    const now = new Date();
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6); // Saturday

    const fmt = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    const dateFrom = fmt(startOfWeek);
    const dateTo = fmt(endOfWeek);

    // FCS API (free tier, accurate economic calendar)
    const FCS_KEY = process.env.FCS_API_KEY || '';
    if (FCS_KEY) {
      try {
        const fcsRes = await fetch(
          `https://fcsapi.com/api-v3/forex/economy_cal?from=${dateFrom}&to=${dateTo}&access_key=${FCS_KEY}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (fcsRes.ok) {
          const fcsData = await fcsRes.json();
          if (fcsData.response && Array.isArray(fcsData.response)) {
            const events = fcsData.response
              .filter(e => e.importance === '3' || e.importance === '2') // high + medium
              .map(e => ({
                title: e.event || '',
                country: e.country || '',
                date: e.date + ' ' + (e.time || '00:00'),
                impact: e.importance === '3' ? 'High' : 'Medium',
                actual: e.actual || '',
                forecast: e.estimate || '',
                previous: e.previous || '',
              }));
            return res.json({ source: 'fcs', events });
          }
        }
      } catch(e) {}
    }

    // Fallback 1: ForexFactory (nfs.faireconomy.media)
    try {
      const ffRes = await fetch(
        'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      );
      if (ffRes.ok) {
        const ffData = await ffRes.json();
        if (Array.isArray(ffData) && ffData.length > 0) {
          const events = ffData
            .filter(e => e.impact === 'High' || e.impact === 'Medium')
            .map(e => ({
              title: e.title || '',
              country: e.country || '',
              date: e.date || '',
              impact: e.impact || '',
              actual: e.actual || '',
              forecast: e.forecast || '',
              previous: e.previous || '',
            }));
          return res.json({ source: 'forexfactory', events });
        }
      }
    } catch(e) {}

    // Fallback 2: TradingEconomics (free scrape, limited)
    try {
      const teRes = await fetch(
        'https://api.tradingeconomics.com/calendar?c=united%20states,euro%20area,united%20kingdom,china,japan,australia,canada&importance=2&f=json',
        { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) }
      );
      if (teRes.ok) {
        const teData = await teRes.json();
        if (Array.isArray(teData)) {
          const events = teData.slice(0, 50).map(e => ({
            title: e.Event || e.Category || '',
            country: e.Country || '',
            date: e.Date || '',
            impact: e.Importance >= 3 ? 'High' : 'Medium',
            actual: e.Actual != null ? String(e.Actual) : '',
            forecast: e.Forecast != null ? String(e.Forecast) : '',
            previous: e.Previous != null ? String(e.Previous) : '',
          }));
          return res.json({ source: 'tradingeconomics', events });
        }
      }
    } catch(e) {}

    res.json({ source: 'none', events: [] });
  } catch (e) {
    res.status(500).json({ error: e.message, events: [] });
  }
}
