'use strict';

// server/session-prep.js — CLI analysis-prep for a Claude Code session.
//
//   node server/session-prep.js <심볼>
//
// Resolves the symbol, collects market data via market.js, and prints a
// token-frugal COMPACT JSON blob to stdout. Bulk fields (raw candle arrays,
// 15m candles) are deliberately excluded — only distilled lines plus the last
// 30 daily closes are emitted so a session can reason cheaply.
//
// Node built-ins only. On missing / unusable input, prints usage to stderr and
// exits 1.

const { resolveSymbol, fetchMarket } = require('./market.js');

function usage() {
  process.stderr.write(
    '사용법: node server/session-prep.js <심볼>\n' +
      '예: node server/session-prep.js SKHYNIX\n' +
      '    node server/session-prep.js 삼성전자\n' +
      '    node server/session-prep.js BTC\n' +
      '    node server/session-prep.js AAPL\n'
  );
}

// Epoch ms -> 'MM-DD' (UTC). Used to tag daily closes compactly.
function mmdd(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '';
  return (
    String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getUTCDate()).padStart(2, '0')
  );
}

(async () => {
  const input = process.argv[2];
  if (input == null || String(input).trim() === '') {
    usage();
    process.exit(1);
  }

  let resolved;
  try {
    resolved = resolveSymbol(input);
  } catch {
    resolved = null;
  }
  if (!resolved || !resolved.symbol) {
    usage();
    process.exit(1);
  }

  let m;
  try {
    m = await fetchMarket(resolved);
  } catch (e) {
    process.stderr.write(
      `시장 데이터 수집 실패 (${resolved.display || resolved.symbol}): ` +
        `${e && e.message ? e.message : e}\n`
    );
    process.exit(1);
  }

  const dailyCloses = (Array.isArray(m.candles) ? m.candles : [])
    .slice(-30)
    .map((c) => ({ d: mmdd(c.t), c: Number(c.c) }));

  const newsTitles = (m.news && Array.isArray(m.news.headlines)
    ? m.news.headlines
    : []
  )
    .slice(0, 8)
    .map((h) => h && h.title)
    .filter(Boolean);

  const out = {
    symbol: m.symbol,
    display: m.display,
    kind: m.kind,
    ...(resolved.nameKo ? { nameKo: resolved.nameKo } : {}),
    ...(resolved.tapbitPair ? { tapbitPair: resolved.tapbitPair } : {}),
    priceLine: m.priceLine,
    indicatorLines: (m.indicators && m.indicators.summaryLines) || [],
    fundamentalLines: (m.fundamentals && m.fundamentals.lines) || [],
    newsTitles,
    sentimentLines: (m.sentiment && m.sentiment.lines) || [],
    intradayLines: (m.intraday && m.intraday.summaryLines) || [],
    dailyCloses,
    // Multi-venue price board — KRX spot, the USDT perpetual on every venue
    // that lists it, FX, and the perp-vs-KRX gap.
    ...(m.board && Array.isArray(m.board.lines) ? { boardLines: m.board.lines } : {}),
    // The tapbit-equivalent 24/7 perpetual chart. Scalp mode reads THESE lines
    // instead of indicatorLines/intradayLines, which are KRX-session and KRW.
    ...(m.perp
      ? {
          perp: {
            pair: m.perp.pair,
            source: m.perp.source,
            priceLine: m.perp.priceLine,
            krwPerUsd: m.perp.krwPerUsd,
            indicatorLines: (m.perp.indicators && m.perp.indicators.summaryLines) || [],
            intradayLines: (m.perp.intraday && m.perp.intraday.summaryLines) || [],
            dailyCloses: (m.perp.candles1d || [])
              .slice(-30)
              .map((c) => ({ d: mmdd(c.t), c: Number(c.c) })),
          },
        }
      : {}),
    generatedAt: new Date().toISOString(),
  };

  process.stdout.write(JSON.stringify(out) + '\n');
})().catch((e) => {
  process.stderr.write(`오류: ${e && e.stack ? e.stack : e}\n`);
  process.exit(1);
});
