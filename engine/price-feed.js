'use strict';

/**
 * Price Feed — Binance Futures REST 실시간 가격 폴링
 *
 * - 외부 의존성 0
 * - 동적 심볼 추가/제거
 * - 가격 staleness(신선도) 추적
 * - Paper Trader SL/TP 실시간 체크용
 */

// Paper Trader가 10코인을 트레이드하므로 전부 추적
const symbols = new Set([
  'btcusdt', 'ethusdt', 'solusdt', 'avaxusdt', 'dogeusdt',
  'linkusdt', 'suiusdt', 'pepeusdt', 'wifusdt', 'tonusdt',
]);
const prices = {}; // { BTCUSDT: 63450.5, ... }
const priceTimestamps = {}; // { BTCUSDT: 1723XXX, ... }
let _started = false;

function start() {
  if (_started) return;
  _started = true;

  let consecutiveErrors = 0;
  async function poll() {
    try {
      const syms = [...symbols].map(s => s.toUpperCase());
      const url = `https://fapi.binance.com/fapi/v1/ticker/price`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const now = Date.now();
        for (const t of data) {
          if (syms.includes(t.symbol)) {
            prices[t.symbol] = parseFloat(t.price);
            priceTimestamps[t.symbol] = now;
          }
        }
        consecutiveErrors = 0;
      } else {
        consecutiveErrors++;
        if (consecutiveErrors <= 3) console.warn(`[price-feed] Binance HTTP ${res.status} (attempt ${consecutiveErrors})`);
      }
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors <= 3) console.warn(`[price-feed] poll error (attempt ${consecutiveErrors}):`, e.message);
    }
  }

  // 즉시 1회 + 10초 주기
  poll();
  setInterval(poll, 10000);
  console.log('[price-feed] REST polling 시작 —', symbols.size, '개 심볼 (10초 주기)');
}

function getPrice(symbol) {
  // 대소문자 정규화: 'btc' → 'BTCUSDT', 'BTC' → 'BTCUSDT'
  const upper = symbol.toUpperCase();
  const pair = upper.includes('USDT') ? upper : upper + 'USDT';
  return prices[pair] || prices[upper] || null;
}

function getAllPrices() {
  return { ...prices };
}

// 가격 신선도 확인 (기본 30초 이상이면 stale)
function isPriceStale(symbol, maxAgeMs = 30000) {
  const pair = symbol.includes('USDT') ? symbol : symbol + 'USDT';
  const ts = priceTimestamps[pair] || priceTimestamps[symbol];
  return !ts || Date.now() - ts > maxAgeMs;
}

function getPriceAge(symbol) {
  const pair = symbol.includes('USDT') ? symbol : symbol + 'USDT';
  const ts = priceTimestamps[pair] || priceTimestamps[symbol];
  return ts ? Date.now() - ts : Infinity;
}

function isConnected() {
  return Object.keys(prices).length > 0;
}

// 런타임에 심볼 추가/제거
function addSymbol(sym) {
  const lower = sym.toLowerCase().replace(/usdt$/i, '') + 'usdt';
  if (!symbols.has(lower)) {
    symbols.add(lower);
    console.log(`[price-feed] 심볼 추가: ${lower} (총 ${symbols.size}개)`);
  }
}

function removeSymbol(sym) {
  const lower = sym.toLowerCase().replace(/usdt$/i, '') + 'usdt';
  if (symbols.delete(lower)) {
    const upper = lower.toUpperCase();
    delete prices[upper];
    delete priceTimestamps[upper];
    console.log(`[price-feed] 심볼 제거: ${lower} (총 ${symbols.size}개)`);
  }
}

function getTrackedSymbols() {
  return [...symbols];
}

module.exports = { start, getPrice, getAllPrices, isConnected, isPriceStale, getPriceAge, addSymbol, removeSymbol, getTrackedSymbols };
