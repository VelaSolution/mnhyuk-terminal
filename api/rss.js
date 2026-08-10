export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const feed = req.query.feed || 'kr';

  const FEEDS = {
    kr: 'https://www.blockmedia.co.kr/feed/',
    coindesk: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
    cointelegraph: 'https://cointelegraph.com/rss',
    theblock: 'https://www.theblock.co/rss.xml',
    decrypt: 'https://decrypt.co/feed',
    bitcoinmagazine: 'https://bitcoinmagazine.com/.rss/full/',
  };

  const url = FEEDS[feed];
  if (!url) return res.status(400).json({ error: 'Unknown feed: ' + feed });

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000)
    });
    const text = await r.text();

    // Simple XML parsing for RSS items
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(text)) !== null && items.length < 15) {
      const xml = match[1];
      const title = (xml.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
      const link = (xml.match(/<link>(.*?)<\/link>/) || [])[1] || '';
      const pubDate = (xml.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';

      if (title && link) {
        items.push({
          title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#039;/g, "'").replace(/&quot;/g, '"'),
          url: link,
          ts: pubDate ? Date.parse(pubDate) : Date.now(),
          source: feed.toUpperCase()
        });
      }
    }

    res.json({ items });
  } catch (e) {
    res.status(500).json({ error: e.message, items: [] });
  }
}
