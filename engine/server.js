'use strict';

// PIXEL TRADING FLOOR — HTTP 서버 (Node 내장 http, 외부 의존성 0)
// 라우트:
//   GET  /                정적 index.html
//   GET  /<static>        public/ 정적 파일 (html/css/js/png)
//   GET  /api/stream      SSE — 접속 시 engine.history replay 후 실시간 구독
//   POST /api/analyze     {symbol, demo} → engine.run 비동기 시작(202) / 진행 중이면 409 / 심볼 없으면 400
//   GET  /api/tape        fetchTape 결과 (서버 60초 캐시)

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// .env 로드 (dotenv 없이 직접 파싱)
try {
  const envPath = path.join(__dirname, '..', '.env');
  const envContent = fs.readFileSync(envPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch (_) {}

const { Engine } = require('./engine');
const { resolveSymbol, fetchTape, fetchVenueBoard, KR_STOCKS } = require('./market');
const paperTrader = require('./paper-trader-v2');
const priceFeed = require('./price-feed');
const backtester = require('./backtester');
const quantSignals = require('./quant-signals');
const learner = require('./learner');
const riskManager = require('./risk-manager');

// ── 외부 서비스 URL ──
const BILLION_URL = process.env.BILLION_URL || 'http://localhost:3847';
const TERMINAL_URL = process.env.TERMINAL_URL || 'http://localhost:3000';
const GATEWAY_SECRET = process.env.GATEWAY_SECRET;
if (!GATEWAY_SECRET) console.warn('[SECURITY] GATEWAY_SECRET 환경변수 미설정 — 게이트웨이 인증이 작동하지 않습니다');

// 기본 8000. 이미 8000이 쓰이는 중이면 PORT=8123 처럼 덮어쓸 수 있다.
const PORT = Number(process.env.PORT) || 8000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TAPE_TTL_MS = 60 * 1000;
const BOARD_TTL_MS = 15 * 1000;
const PING_INTERVAL_MS = 15 * 1000; // 25→15초 (프록시 연결 유지)

const engine = new Engine();

// ══════════════════════════════════════════════
// Billion/Terminal 알림 훅 — 분석 이벤트를 외부 서비스에 자동 전달
// ══════════════════════════════════════════════
(function setupBridgeHooks() {
  let currentSymbol = '';

  async function notifyBillion(type, data) {
    try {
      await fetch(`${BILLION_URL}/api/motera`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Key': GATEWAY_SECRET,
        },
        body: JSON.stringify({ action: 'push_data', data: { type, ...data } }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (_) { /* Billion 오프라인 — 무시 */ }
  }

  async function notifyTerminal(type, data) {
    try {
      await fetch(`${TERMINAL_URL}/api/gateway`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Key': GATEWAY_SECRET,
        },
        body: JSON.stringify({ action: 'push_event', data: { type, ...data } }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (_) { /* Terminal 오프라인 — 무시 */ }
  }

  engine.on('event', (evt) => {
    if (evt.type === 'run:start') {
      currentSymbol = evt.display || evt.symbol || '';
      const payload = {
        symbol: currentSymbol,
        mode: evt.mode,
        mock: evt.mock,
        timestamp: new Date().toISOString(),
      };
      notifyBillion('trading:started', payload);
      notifyTerminal('trading:started', payload);
    }

    if (evt.type === 'decision') {
      const payload = {
        symbol: currentSymbol,
        action: evt.action,
        confidence: evt.confidence,
        entry: evt.entry,
        stop: evt.stop,
        target: evt.target,
        verdict: evt.verdict,
        grade: evt.grade,
        scalp: evt.scalp,
        timestamp: new Date().toISOString(),
      };
      notifyBillion('trading:decision', payload);
      notifyTerminal('trading:decision', payload);
    }

    if (evt.type === 'run:end') {
      const payload = { symbol: currentSymbol, timestamp: new Date().toISOString() };
      notifyBillion('trading:completed', payload);
      notifyTerminal('trading:completed', payload);
    }

    if (evt.type === 'run:error') {
      const payload = { symbol: currentSymbol, error: evt.message, timestamp: new Date().toISOString() };
      notifyBillion('trading:error', payload);
      notifyTerminal('trading:error', payload);
    }

    if (evt.type === 'run:busy') {
      const payload = { symbol: currentSymbol, message: evt.message, timestamp: new Date().toISOString() };
      notifyBillion('trading:busy', payload);
      notifyTerminal('trading:busy', payload);
    }
  });

  console.log('[bridge] Billion/Terminal 알림 훅 활성화');
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

// ---- /api/tape 60초 캐시 ----
let tapeCache = null; // { ts, data }
async function getTape() {
  const now = Date.now();
  if (tapeCache && now - tapeCache.ts < TAPE_TTL_MS) return tapeCache.data;
  const data = await fetchTape();
  tapeCache = { ts: now, data };
  return data;
}

// ---- 유틸 ----
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---- SSE ----
function handleStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const write = (evt) => {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  };

  // 1) 현재 히스토리 전부 replay
  for (const evt of engine.history) write(evt);

  // 2) 실시간 구독
  const onEvent = (evt) => write(evt);
  engine.on('event', onEvent);

  // 3) keep-alive 핑 (SSE 주석)
  const ping = setInterval(() => {
    res.write(':ping\n\n');
  }, PING_INTERVAL_MS);

  const cleanup = () => {
    clearInterval(ping);
    engine.removeListener('event', onEvent);
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
}

// ---- POST /api/analyze ----
async function handleAnalyze(req, res) {
  let body = {};
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (_) {
    return sendJson(res, 400, { error: '잘못된 요청 본문(JSON 파싱 실패).' });
  }

  const symbol = body && typeof body.symbol === 'string' ? body.symbol.trim() : '';
  if (!symbol) {
    return sendJson(res, 400, { error: '심볼(symbol)이 필요합니다.' });
  }
  if (engine.running) {
    return sendJson(res, 409, { error: '이미 분석이 진행 중입니다.' });
  }

  const mock = !!body.demo;
  const mode =
    body.mode === 'scalp' || body.mode === 'attack' ? body.mode : 'algo';
  // 비동기로 실행 시작 후 즉시 202. 내부 오류는 run:error 이벤트로 방송된다.
  engine.run(symbol, { mock, mode }).catch((err) => {
    console.error('[engine] run 오류:', err && err.message ? err.message : err);
  });
  return sendJson(res, 202, { ok: true, symbol, mock, mode });
}

// ---- GET /api/board?symbol=… — 다중 거래소 전광판 (심볼별 15초 캐시) ----
const boardCache = new Map(); // symbolKey -> { ts, data }

async function handleBoard(res, searchParams) {
  const raw = (searchParams && searchParams.get('symbol')) || 'SKHYNIX';
  const key = String(raw).trim().toUpperCase();
  const hit = boardCache.get(key);
  const now = Date.now();
  if (hit && now - hit.ts < BOARD_TTL_MS) return sendJson(res, 200, hit.data);
  try {
    const data = await fetchVenueBoard(raw);
    if (!data) {
      return sendJson(res, 200, {
        rows: [],
        lines: [],
        note: '무기한 선물 페어가 있는 심볼(하이닉스·삼성전자)만 전광판을 제공합니다.',
        supported: Object.keys(KR_STOCKS),
      });
    }
    boardCache.set(key, { ts: now, data });
    return sendJson(res, 200, data);
  } catch (err) {
    // 실패해도 캐시가 있으면 캐시를 준다 (전광판은 끊기지 않는 편이 낫다).
    if (hit) return sendJson(res, 200, hit.data);
    console.error('[board] 조회 실패:', err && err.message ? err.message : err);
    return sendJson(res, 200, { rows: [], lines: [], error: '전광판 조회 실패' });
  }
}

// ---- GET /api/tape ----
async function handleTape(res) {
  try {
    const data = await getTape();
    return sendJson(res, 200, data);
  } catch (err) {
    // 실패해도 캐시가 있으면 캐시를, 없으면 빈 배열을 반환한다.
    if (tapeCache) return sendJson(res, 200, tapeCache.data);
    console.error('[tape] 조회 실패:', err && err.message ? err.message : err);
    return sendJson(res, 200, []);
  }
}

// ---- GET /reports (목록) · /reports/<파일> (열람/다운로드) ----
const REPORTS_DIR = path.join(__dirname, '..', 'reports');

// --- 최소 ZIP 생성기 (무압축 store 방식, 외부 의존성 없음) ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0xf) << 5) |
    (d.getDate() & 0x1f);
  return { time, date };
}

// entries: [{name, data(Buffer), mtime(Date)}] → 단일 ZIP Buffer
function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const { time, date } = dosDateTime(e.mtime || new Date());
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 이름 플래그
    local.writeUInt16LE(0, 8);           // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.data.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, e.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);        // made by
    central.writeUInt16LE(20, 6);        // needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(e.data.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    // extra/comment/disk/attrs 전부 0
    central.writeUInt32LE(offset, 42);   // local header offset
    centralParts.push(Buffer.concat([central, nameBuf]));

    offset += local.length + nameBuf.length + e.data.length;
  }
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDir, end]);
}

async function handleReportsZip(res) {
  let names = [];
  try {
    names = (await fsp.readdir(REPORTS_DIR)).filter(
      (n) => n.endsWith('.md') || n === 'decisions.json'
    );
  } catch (_) {}
  const entries = [];
  for (const n of names) {
    try {
      const full = path.join(REPORTS_DIR, n);
      const [data, stat] = await Promise.all([fsp.readFile(full), fsp.stat(full)]);
      entries.push({ name: n, data, mtime: stat.mtime });
    } catch (_) {}
  }
  const zip = buildZip(entries);
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad2z(d.getMonth() + 1)}${pad2z(d.getDate())}`;
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': `attachment; filename=trading-floor-reports-${stamp}.zip`,
  });
  res.end(zip);
}

function pad2z(n) {
  return String(n).padStart(2, '0');
}

// ---- GET /project.zip — 새 PC 이식용 / 공유용 소스 번들 ----
// 포함: 소스·커맨드·문서. 제외: vendor 대용량(venv·클론), .git, node_modules,
//       그리고 남에게 넘어가면 안 되는 개인 데이터 — 분석 리포트(매매 판정 이력)와
//       .claude/settings.local.json(로컬 절대경로·권한 허용 목록).
const PROJECT_ROOT = path.join(__dirname, '..');
const BUNDLE_EXCLUDE_DIRS = new Set([
  '.git',
  'node_modules',
  path.join('vendor', 'ta-venv'),
  path.join('vendor', 'TradingAgents'),
]);

// 개인 데이터 — 번들에서 뺀다.
function isPrivateBundleFile(rel) {
  if (rel === '.claude/settings.local.json') return true;
  if (rel === '.env') return true;
  if (rel.startsWith('reports/') && (rel.endsWith('.md') || rel.endsWith('decisions.json'))) {
    return true;
  }
  return false;
}

async function collectBundleFiles(dir, relBase, out) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    const relNorm = rel.split('/').join(path.sep);
    if (e.isDirectory()) {
      if (BUNDLE_EXCLUDE_DIRS.has(relNorm) || BUNDLE_EXCLUDE_DIRS.has(e.name)) continue;
      await collectBundleFiles(path.join(dir, e.name), rel, out);
    } else if (e.isFile()) {
      if (isPrivateBundleFile(rel)) continue;
      out.push(rel);
    }
  }
}

async function handleProjectZip(res) {
  const rels = [];
  await collectBundleFiles(PROJECT_ROOT, '', rels);
  const entries = [];
  for (const rel of rels) {
    try {
      const full = path.join(PROJECT_ROOT, rel);
      const [data, stat] = await Promise.all([fsp.readFile(full), fsp.stat(full)]);
      entries.push({ name: `trading-floor/${rel}`, data, mtime: stat.mtime });
    } catch (_) {}
  }
  const zip = buildZip(entries);
  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Length': zip.length,
    'Content-Disposition': 'attachment; filename=trading-floor-portable.zip',
  });
  res.end(zip);
}

async function handleReports(req, res, pathname, searchParams) {
  const rel = decodeURIComponent(pathname.replace(/^\/reports\/?/, ''));

  // 목록 페이지
  if (!rel) {
    let names = [];
    try {
      names = (await fsp.readdir(REPORTS_DIR))
        .filter((n) => n.endsWith('.md') || n === 'decisions.json')
        .sort()
        .reverse();
    } catch (_) {}
    const rows = names
      .map(
        (n) =>
          `<li><a href="/reports/${encodeURIComponent(n)}">${n}</a>` +
          ` <a class="dl" href="/reports/${encodeURIComponent(n)}?dl=1">[다운로드]</a></li>`
      )
      .join('\n');
    const html =
      '<!doctype html><html lang="ko"><head><meta charset="utf-8">' +
      '<title>리포트 — PIXEL TRADING FLOOR</title>' +
      '<style>body{background:#1a1a24;color:#eee;font-family:monospace;padding:24px}' +
      'a{color:#e8c84a}a.dl{color:#3fb950;text-decoration:none;margin-left:8px}' +
      'li{margin:6px 0}h1{font-size:18px;color:#e8c84a}' +
      '.zip{display:inline-block;background:#3fb950;color:#08160b;font-weight:bold;' +
      'padding:8px 14px;margin:8px 0 16px;text-decoration:none;border:2px solid #000;' +
      'box-shadow:3px 3px 0 #000}</style></head><body>' +
      `<h1>◆ 분석 리포트 (${names.length}건) ◆</h1>` +
      '<a class="zip" href="/reports/all.zip">⬇ 전체 다운로드 (.zip)</a>' +
      `<ul>${rows}</ul>` +
      '<p><a href="/">← 플로어로 돌아가기</a></p></body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(html);
  }

  // 전체 ZIP
  if (rel === 'all.zip') {
    return handleReportsZip(res);
  }

  // 개별 파일 — 경로 탈출 방지 + 확장자 화이트리스트
  const target = path.normalize(path.join(REPORTS_DIR, rel));
  if (
    !target.startsWith(REPORTS_DIR) ||
    !(target.endsWith('.md') || target.endsWith('decisions.json'))
  ) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  try {
    const data = await fsp.readFile(target);
    const isMd = target.endsWith('.md');
    const headers = {
      'Content-Type': isMd
        ? 'text/plain; charset=utf-8'
        : 'application/json; charset=utf-8',
      'Content-Length': data.length,
    };
    // ?dl=1 이면 저장 대화상자를 띄운다
    if (searchParams && searchParams.get('dl') === '1') {
      headers['Content-Disposition'] =
        `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
    }
    res.writeHead(200, headers);
    return res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
}

// ---- 정적 파일 ----
async function handleStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 경로 탈출 방지
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(target);
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': data.length,
    });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

// ---- CORS 허용 도메인 (환경변수 또는 기본값) ----
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || '*').split(',').map(s => s.trim());

function getCorsOrigin(req) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes('*')) return '*';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  return ALLOWED_ORIGINS[0] || '';
}

// ---- 간단한 레이트 리밋 (IP당 분석 요청 1분 1회) ----
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 60 * 1000;
function checkRateLimit(ip, path) {
  if (!path.includes('/api/analyze') && !path.includes('/api/pipeline')) return true;
  const key = `${ip}:${path}`;
  const last = rateLimitMap.get(key) || 0;
  if (Date.now() - last < RATE_LIMIT_MS) return false;
  rateLimitMap.set(key, Date.now());
  // 오래된 엔트리 정리 (5분 이상)
  if (rateLimitMap.size > 500) {
    const cutoff = Date.now() - 5 * 60 * 1000;
    for (const [k, v] of rateLimitMap) { if (v < cutoff) rateLimitMap.delete(k); }
  }
  return true;
}

// ---- 라우터 ----
const server = http.createServer(async (req, res) => {
  // CORS headers (환경변수 기반 제한)
  res.setHeader('Access-Control-Allow-Origin', getCorsOrigin(req));
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Gateway-Key, Authorization');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Rate limit check (POST 분석 요청)
  if (req.method === 'POST') {
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '';
    const url = req.url || '/';
    if (!checkRateLimit(clientIp, url)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Rate limit exceeded. 1분 후 재시도.', retryAfter: 60 }));
      return;
    }
  }

  let pathname = '/';
  let searchParams = null;
  try {
    const u = new URL(req.url, 'http://localhost');
    pathname = u.pathname;
    searchParams = u.searchParams;
  } catch (_) {
    pathname = req.url || '/';
  }

  try {
    if (req.method === 'GET' && pathname === '/api/stream') {
      return handleStream(req, res);
    }
    if (req.method === 'GET' && (pathname === '/reports' || pathname.startsWith('/reports/'))) {
      return await handleReports(req, res, pathname, searchParams);
    }
    if (req.method === 'GET' && pathname === '/project.zip') {
      return await handleProjectZip(res);
    }
    if (req.method === 'POST' && pathname === '/api/analyze') {
      return await handleAnalyze(req, res);
    }
    if (req.method === 'GET' && pathname === '/api/tape') {
      return await handleTape(res);
    }
    // ── /api/context: 통합 컨텍스트 (Billion 통합 상황 인식용) ──
    // ── Paper Trading API ──
    if (req.method === 'GET' && pathname === '/api/paper/status') {
      return sendJson(res, 200, paperTrader.getStatus());
    }
    if (req.method === 'GET' && pathname === '/api/paper/history') {
      return sendJson(res, 200, paperTrader.getHistory());
    }
    if (req.method === 'POST' && pathname === '/api/paper/reset') {
      return sendJson(res, 200, paperTrader.reset());
    }
    if (req.method === 'POST' && pathname === '/api/paper/start') {
      paperTrader.start();
      return sendJson(res, 200, { success: true, message: '가상매매 시작' });
    }
    if (req.method === 'POST' && pathname === '/api/paper/stop') {
      paperTrader.stop();
      return sendJson(res, 200, { success: true, message: '가상매매 중지' });
    }

    // ── Paper Trading API: 에쿼티 커브 ──
    if (req.method === 'GET' && pathname === '/api/paper/equity-curve') {
      const detailed = paperTrader.getDetailedStats();
      return sendJson(res, 200, {
        curve: detailed.dailyEquityCurve || [],
        startCapital: 3000,
        timestamp: new Date().toISOString(),
      });
    }

    // ── Paper Trading API: 실시간 PnL (현재가 포함) ──
    if (req.method === 'GET' && pathname === '/api/paper/live') {
      const status = paperTrader.getStatus();
      const positions = status.positions || [];
      const livePositions = [];
      for (const pos of positions) {
        const rawPair = (pos.symbol || '').replace('/', '');
        const pair = rawPair.endsWith('USDT') ? rawPair : rawPair + 'USDT';
        let currentPrice = priceFeed.getPrice(pair) || null;
        if (!currentPrice) {
          try {
            const pr = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`, { signal: AbortSignal.timeout(3000) });
            if (pr.ok) { const d = await pr.json(); currentPrice = parseFloat(d.price) || null; }
          } catch {}
        }
        const isLong = pos.direction === 'BUY' || pos.direction === 'LONG' || !pos.direction;
        let unrealizedPnl = 0, unrealizedPnlPct = 0;
        if (currentPrice && pos.entryPrice) {
          unrealizedPnl = isLong
            ? (currentPrice - pos.entryPrice) * (pos.quantity || 0)
            : (pos.entryPrice - currentPrice) * (pos.quantity || 0);
          unrealizedPnlPct = pos.costBasis > 0 ? (unrealizedPnl / pos.costBasis * 100) : 0;
        }
        const hoursHeld = pos.entryTs ? ((Date.now() - pos.entryTs) / 3600000) : 0;
        // Trail level calculation
        let trailLevel = 0;
        if (currentPrice && pos.entryPrice && pos.tpPrice) {
          const totalDist = pos.tpPrice - pos.entryPrice;
          if (totalDist > 0) {
            trailLevel = Math.max(0, Math.min(100, ((currentPrice - pos.entryPrice) / totalDist) * 100));
          }
        }
        livePositions.push({
          symbol: pos.symbol,
          direction: pos.direction || 'LONG',
          pattern: pos.pattern,
          entryPrice: pos.entryPrice,
          currentPrice,
          slPrice: pos.slPrice,
          tpPrice: pos.tpPrice,
          quantity: pos.quantity,
          costBasis: pos.costBasis,
          unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
          unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
          hoursHeld: Math.round(hoursHeld * 10) / 10,
          trailLevel: Math.round(trailLevel),
          maxHoldHours: pos.maxHoldHours,
          entryTime: pos.entryTime,
        });
      }
      // Swing 포지션도 동일하게 실시간 가격 적용
      const swingPositions = status.swingPositions || [];
      const liveSwing = [];
      for (const pos of swingPositions) {
        const rawPair = (pos.symbol || '').replace('/', '');
        const pair = rawPair.endsWith('USDT') ? rawPair : rawPair + 'USDT';
        let cp = priceFeed.getPrice(pair) || null;
        if (!cp) { try { const pr = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`, { signal: AbortSignal.timeout(3000) }); if (pr.ok) { const d = await pr.json(); cp = parseFloat(d.price) || null; } } catch {} }
        const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
        const upnl = cp ? (isLong ? (cp - pos.entryPrice) * (pos.quantity || 0) : (pos.entryPrice - cp) * (pos.quantity || 0)) : 0;
        const upnlPct = pos.costBasis > 0 ? (upnl / pos.costBasis * 100) : 0;
        liveSwing.push({ ...pos, currentPrice: cp, unrealizedPnl: Math.round(upnl * 100) / 100, unrealizedPnlPct: Math.round(upnlPct * 100) / 100, hoursHeld: pos.entryTs ? Math.round((Date.now() - pos.entryTs) / 3600000 * 10) / 10 : 0, posType: 'swing' });
      }

      return sendJson(res, 200, {
        positions: livePositions,
        swingPositions: liveSwing,
        recentTrades: status.recentTrades || [],
        capital: status.capital,
        totalPnl: status.totalPnl,
        todayPnl: status.todayPnl,
        returnPct: status.returnPct,
        winRate: status.winRate,
        wins: status.wins || 0,
        losses: status.losses || 0,
        running: status.running,
        timestamp: new Date().toISOString(),
      });
    }

    // ── Paper Trading API: 코인별/시간대별 성과 ──
    if (req.method === 'GET' && pathname === '/api/paper/performance') {
      const detailed = paperTrader.getDetailedStats();
      const history = paperTrader.getHistory();
      const status = paperTrader.getStatus();

      // 시간대별 승률 (0-23시)
      const hourlyStats = {};
      for (let h = 0; h < 24; h++) hourlyStats[h] = { wins: 0, losses: 0, total: 0 };
      for (const t of history) {
        const hour = new Date(t.entryTime || t.exitTime).getHours();
        hourlyStats[hour].total++;
        if ((t.pnl || 0) > 0) hourlyStats[hour].wins++;
        else hourlyStats[hour].losses++;
      }
      const hourlyWinRate = {};
      for (let h = 0; h < 24; h++) {
        hourlyWinRate[h] = {
          winRate: hourlyStats[h].total > 0 ? Math.round(hourlyStats[h].wins / hourlyStats[h].total * 100) : 0,
          total: hourlyStats[h].total,
        };
      }

      // R:R 통계
      const wins = history.filter(t => (t.pnl || 0) > 0);
      const losses = history.filter(t => (t.pnl || 0) <= 0);
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
      const rrRatio = avgLoss > 0 ? Math.round(avgWin / avgLoss * 100) / 100 : 0;

      // 청산 사유별 통계
      const closeReasonStats = {};
      for (const t of history) {
        const r = t.closeReason || 'UNKNOWN';
        if (!closeReasonStats[r]) closeReasonStats[r] = { count: 0, totalPnl: 0 };
        closeReasonStats[r].count++;
        closeReasonStats[r].totalPnl += t.pnl || 0;
      }
      for (const r of Object.keys(closeReasonStats)) {
        closeReasonStats[r].totalPnl = Math.round(closeReasonStats[r].totalPnl * 100) / 100;
      }

      return sendJson(res, 200, {
        coinStats: detailed.winRateByCoin,
        hourlyWinRate,
        rrRatio,
        avgWin: Math.round(avgWin * 100) / 100,
        avgLoss: Math.round(avgLoss * 100) / 100,
        closeReasonStats,
        bestTrade: detailed.bestTrade,
        worstTrade: detailed.worstTrade,
        avgHoldTime: detailed.avgHoldTime,
        currentStreak: detailed.currentStreak,
        totalTrades: status.totalTrades,
        timestamp: new Date().toISOString(),
      });
    }

    // ── Paper Trading API: 대시보드 (종합) ──
    if (req.method === 'GET' && pathname === '/api/paper/dashboard') {
      const status = paperTrader.getStatus();
      const detailed = paperTrader.getDetailedStats();
      const history = paperTrader.getHistory();

      // 에쿼티 커브
      const equityCurve = detailed.dailyEquityCurve || [];

      // 일별 PnL
      const dailyPnl = detailed.dailyPnl || {};

      // 전략별 성과 (코인별 통계 기반)
      const strategyPerf = {};
      for (const t of history) {
        const strat = t.strategy || 'scalp';
        if (!strategyPerf[strat]) strategyPerf[strat] = { trades: 0, wins: 0, totalPnl: 0 };
        strategyPerf[strat].trades++;
        if ((t.pnl || 0) > 0) strategyPerf[strat].wins++;
        strategyPerf[strat].totalPnl += t.pnl || 0;
      }
      for (const key of Object.keys(strategyPerf)) {
        const s = strategyPerf[key];
        s.winRate = s.trades > 0 ? Math.round(s.wins / s.trades * 1000) / 10 : 0;
        s.totalPnl = Math.round(s.totalPnl * 100) / 100;
      }

      // 현재 퀀트 시그널 (TOP 5)
      const quantSignalsData = {};
      const topSymbols = ['BTC', 'ETH', 'SOL', 'AVAX', 'DOGE'];
      try {
        const sigPromises = topSymbols.map(async (sym) => {
          try {
            const sig = await quantSignals.getSignalForSymbol(sym);
            return { symbol: sym, action: sig.action, grade: sig.grade, score: sig.totalScore, confidence: sig.confidence };
          } catch { return { symbol: sym, action: 'ERR', grade: 'D', score: 0 }; }
        });
        const sigResults = await Promise.all(sigPromises);
        for (const r of sigResults) quantSignalsData[r.symbol] = r;
      } catch {}

      // 앙상블 (BTC 기준)
      let ensembleData = null;
      try {
        const btcRes = await fetch('https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=200', { signal: AbortSignal.timeout(8000) });
        if (btcRes.ok) {
          const raw = await btcRes.json();
          const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
          ensembleData = quantSignals.ensembleVote(candles);
        }
      } catch {}

      // 리스크 지표
      const wins = history.filter(t => (t.pnl || 0) > 0);
      const losses = history.filter(t => (t.pnl || 0) <= 0);
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
      const rrRatio = avgLoss > 0 ? Math.round(avgWin / avgLoss * 100) / 100 : 0;
      const profitFactor = avgLoss > 0 ? Math.round(avgWin * wins.length / (avgLoss * losses.length) * 100) / 100 : 0;
      const riskMetrics = {
        maxDrawdown: status.maxDrawdown,
        currentDrawdown: status.currentDrawdown,
        circuitBreakerActive: status.circuitBreakerActive,
        drawdownHaltActive: status.drawdownHaltActive,
        consecutiveLosses: status.consecutiveLosses,
        consecutiveWins: status.consecutiveWins,
        rrRatio,
        profitFactor,
        avgWin: Math.round(avgWin * 100) / 100,
        avgLoss: Math.round(avgLoss * 100) / 100,
      };

      // 학습 상태
      let learningStatus = { lessonsCount: 0, rulesCount: 0, lastLearn: null };
      try {
        const learner = require('./learner');
        const lessons = learner.loadLessons();
        const rules = learner.loadRules();
        learningStatus = {
          lessonsCount: lessons.length,
          rulesCount: (rules.rules || []).length,
          bestPatternsCount: (rules.bestPatterns || []).length,
          worstPatternsCount: (rules.worstPatterns || []).length,
          lastLearn: rules.lastAnalyzed || null,
        };
      } catch {}

      return sendJson(res, 200, {
        equity: equityCurve,
        dailyPnl,
        strategyPerf,
        quantSignals: quantSignalsData,
        ensemble: ensembleData,
        riskMetrics,
        learningStatus,
        capital: status.capital,
        startCapital: status.startCapital,
        totalPnl: status.totalPnl,
        todayPnl: status.todayPnl,
        returnPct: status.returnPct,
        winRate: status.winRate,
        totalTrades: status.totalTrades,
        positionCount: status.positionCount,
        swingPositionCount: status.swingPositionCount,
        running: status.running,
        marketRegime: status.marketRegime?.regime || status.marketRegime || 'UNKNOWN',
        coinPerformance: status.coinPerformance,
        recentTrades: status.recentTrades || [],
        timestamp: new Date().toISOString(),
      });
    }

    // ── Paper Trading API: 분석 로그 ──
    if (req.method === 'GET' && pathname === '/api/paper/log') {
      // analysisLog: 최근 엔진 이벤트 중 에이전트 로그
      const logs = engine.history
        .filter(e => e.type === 'agent:done' || e.type === 'agent:start' || e.type === 'run:end' || e.type === 'saved')
        .slice(-50)
        .map(e => ({
          type: e.type,
          who: e.id || e.who || null,
          text: e.bubble || e.report || e.text || e.action || null,
          confidence: e.confidence || null,
          ts: e.ts || null,
        }));
      return sendJson(res, 200, { logs, count: logs.length, timestamp: new Date().toISOString() });
    }

    // ── Paper Trading API: 특정 코인 즉시 분석 트리거 ──
    if (req.method === 'POST' && pathname.startsWith('/api/paper/analyze/')) {
      const sym = pathname.replace('/api/paper/analyze/', '').toUpperCase();
      if (!sym) return sendJson(res, 400, { error: '심볼이 필요합니다.' });
      if (engine.running) return sendJson(res, 409, { error: '이미 분석이 진행 중입니다.' });
      engine.run(sym, { mock: false, mode: 'algo' }).catch((err) => {
        console.error('[engine] analyze 오류:', err && err.message ? err.message : err);
      });
      return sendJson(res, 202, { ok: true, symbol: sym, message: `${sym} 분석 시작` });
    }

    // ── Paper Trading API: 포지션 상세 (현재가 포함) ──
    if (req.method === 'GET' && pathname === '/api/paper/positions') {
      const status = paperTrader.getStatus();
      const positions = status.positions || [];
      const detailed = [];
      for (const pos of positions) {
        const pair = (pos.symbol || '').replace('/', '') + ((pos.symbol || '').includes('USDT') ? '' : 'USDT');
        let currentPrice = null;
        try {
          const pr = priceFeed.getPrice(pair);
          if (pr) { currentPrice = pr; }
          else {
            const pRes = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`, { signal: AbortSignal.timeout(3000) });
            if (pRes.ok) { const d = await pRes.json(); currentPrice = parseFloat(d.price) || null; }
          }
        } catch {}
        const isLong = pos.direction === 'BUY' || pos.direction === 'LONG';
        let unrealizedPnl = 0, unrealizedPnlPct = 0;
        if (currentPrice && pos.entryPrice) {
          unrealizedPnl = isLong
            ? (currentPrice - pos.entryPrice) * (pos.quantity || 0)
            : (pos.entryPrice - currentPrice) * (pos.quantity || 0);
          unrealizedPnlPct = pos.costBasis > 0 ? (unrealizedPnl / pos.costBasis * 100) : 0;
        }
        const hoursHeld = pos.entryTs ? ((Date.now() - pos.entryTs) / 3600000) : 0;
        detailed.push({
          ...pos,
          currentPrice,
          unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
          unrealizedPnlPct: Math.round(unrealizedPnlPct * 100) / 100,
          hoursHeld: Math.round(hoursHeld * 10) / 10,
          trailLevel: pos.trailLevel || 0,
          partialClosed: pos.partialClosed || false,
        });
      }
      return sendJson(res, 200, {
        positions: detailed,
        capital: status.capital,
        totalPnl: status.totalPnl,
        positionCount: detailed.length,
        timestamp: new Date().toISOString(),
      });
    }

    // ── Paper Trading API: 특정 코인 최근 분석 결과 ──
    if (req.method === 'GET' && pathname.startsWith('/api/paper/signal/')) {
      const sym = pathname.replace('/api/paper/signal/', '').toUpperCase();
      // decisions.json에서 해당 심볼의 최근 판정을 찾는다
      let decisions = [];
      try {
        const decPath = path.join(__dirname, '..', 'reports', 'decisions.json');
        const raw = await fsp.readFile(decPath, 'utf8');
        decisions = JSON.parse(raw);
      } catch {}
      const symDecisions = (Array.isArray(decisions) ? decisions : [])
        .filter(d => {
          const s = (d.symbol || d.display || '').toUpperCase().replace('USDT', '');
          return s === sym || s === sym + 'USDT';
        })
        .slice(-5)
        .reverse();
      const latest = symDecisions[0] || null;
      return sendJson(res, 200, {
        symbol: sym,
        latest,
        recent: symDecisions,
        timestamp: new Date().toISOString(),
      });
    }

    // ── Real-time WebSocket Prices ──
    if (req.method === 'GET' && pathname === '/api/prices') {
      return sendJson(res, 200, {
        prices: priceFeed.getAllPrices(),
        connected: priceFeed.isConnected(),
        source: 'websocket',
        timestamp: Date.now(),
      });
    }

    if (req.method === 'GET' && pathname === '/api/context') {
      const lastDecision = engine.history.filter(e => e.type === 'decision').pop() || null;
      const lastRun = engine.history.filter(e => e.type === 'run:start').pop() || null;

      // 최근 5개 판정 (메모리)
      const recentFromHistory = engine.history
        .filter(e => e.type === 'decision')
        .slice(-5)
        .map(d => ({
          action: d.action,
          confidence: d.confidence,
          grade: d.grade || null,
          symbol: d.symbol || lastRun?.display || lastRun?.symbol || null,
          entry: d.entry,
          stop: d.stop,
          target: d.target,
          timestamp: d.ts || null,
        }));

      // 디스크 판정 파일에서도 읽기
      let fileDecisions = [];
      try {
        const decPath = path.join(__dirname, '..', 'reports', 'decisions.json');
        const raw = await fsp.readFile(decPath, 'utf8');
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          fileDecisions = arr.slice(-5).map(d => ({
            action: d.action,
            confidence: d.confidence,
            grade: d.grade || null,
            symbol: d.symbol || null,
            entry: d.entry,
            stop: d.stop,
            target: d.target,
            timestamp: d.ts || d.timestamp || null,
          }));
        }
      } catch {}

      // 메모리 이력이 있으면 우선, 없으면 파일
      const recentDecisions = recentFromHistory.length > 0 ? recentFromHistory : fileDecisions;

      const uptimeSeconds = process.uptime();
      const hours = Math.floor(uptimeSeconds / 3600);
      const minutes = Math.floor((uptimeSeconds % 3600) / 60);
      const engineUptime = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      // 마켓 레짐 계산 (BTC 기준, 실시간)
      let marketRegime = null;
      try {
        const { computeIndicators: ctxComputeInd } = require('./indicators');
        const { resolveSymbol: ctxResolve, fetchMarket: ctxFetch } = require('./market');

        // 마지막 분석 심볼이 있으면 그것을, 없으면 BTC
        const regimeSymbol = lastRun?.display || lastRun?.symbol || 'BTC';
        const regimeResolved = ctxResolve(regimeSymbol);

        // 캔들 데이터 직접 가져와서 인디케이터 계산
        const candleRes = await fetch(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${regimeResolved.pair}&interval=4h&limit=120`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (candleRes.ok) {
          const candleRaw = await candleRes.json();
          if (Array.isArray(candleRaw) && candleRaw.length > 30) {
            const candlesParsed = candleRaw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
            const regimeInd = ctxComputeInd(candlesParsed);
            marketRegime = {
              symbol: regimeSymbol,
              regime: regimeInd.regime,
              label: regimeInd.regimeLabel,
              suggestedStrategy: regimeInd.suggestedStrategy,
              adx: regimeInd.adx,
              atr14: regimeInd.atr14,
              price: regimeInd.price,
              rsi14: regimeInd.rsi14 ? Math.round(regimeInd.rsi14 * 10) / 10 : null,
            };
          }
        }
      } catch {
        // 마켓 레짐 조회 실패는 무시 — context API가 깨지면 안됨
      }

      // Paper Trader 현황 통합
      let paperSummary = null;
      try {
        const ps = paperTrader.getStatus();
        paperSummary = {
          running: ps.running,
          capital: ps.capital,
          returnPct: ps.returnPct,
          winRate: ps.winRate,
          positionCount: ps.positionCount,
          todayPnl: ps.todayPnl,
          mode: ps.mode,
        };
      } catch {}

      // Billion AI 피드백 요약
      const billionFeedback = (engine.billionFeedback || []).slice(-5);

      return sendJson(res, 200, {
        status: engine.running ? 'RUNNING' : 'IDLE',
        currentSymbol: lastRun?.display || lastRun?.symbol || null,
        lastDecision: lastDecision ? {
          action: lastDecision.action,
          confidence: lastDecision.confidence,
          grade: lastDecision.grade || null,
          symbol: lastDecision.symbol || lastRun?.display || lastRun?.symbol || null,
          entry: lastDecision.entry,
          stop: lastDecision.stop,
          target: lastDecision.target,
          timestamp: lastDecision.ts || new Date().toISOString(),
        } : null,
        recentDecisions,
        marketRegime,
        paperTrader: paperSummary,
        billionFeedback,
        engineUptime,
        agentCount: 13,
        version: '1.2',
        timestamp: new Date().toISOString(),
      });
    }
    // ── /api/status: 엔진 상태 + 최근 판정 ──
    if (req.method === 'GET' && pathname === '/api/status') {
      const lastDecision = engine.history.filter(e => e.type === 'decision').pop() || null;
      const lastRun = engine.history.filter(e => e.type === 'run:start').pop() || null;
      return sendJson(res, 200, {
        status: engine.running ? 'RUNNING' : 'IDLE',
        currentSymbol: lastRun?.display || lastRun?.symbol || null,
        lastDecision: lastDecision ? {
          action: lastDecision.action,
          confidence: lastDecision.confidence,
          entry: lastDecision.entry,
          stop: lastDecision.stop,
          target: lastDecision.target,
          verdict: lastDecision.verdict,
          scalp: lastDecision.scalp,
        } : null,
        historyCount: engine.history.length,
        timestamp: new Date().toISOString(),
      });
    }
    // ── /api/decisions: 과거 판정 이력 ──
    if (req.method === 'GET' && pathname === '/api/decisions') {
      try {
        const decPath = path.join(__dirname, '..', 'reports', 'decisions.json');
        const raw = await fsp.readFile(decPath, 'utf8');
        const arr = JSON.parse(raw);
        return sendJson(res, 200, { decisions: Array.isArray(arr) ? arr : [] });
      } catch {
        return sendJson(res, 200, { decisions: [] });
      }
    }
    // ── /api/health: 서비스 상태 (Billion full_briefing용) ──
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'PIXEL TRADING FLOOR',
        running: engine.running,
        uptime: process.uptime(),
        port: PORT,
      });
    }
    if (req.method === 'GET' && pathname === '/api/board') {
      return await handleBoard(res, searchParams);
    }
    if (req.method === 'GET' && pathname === '/api/auth/check') {
      return sendJson(res, 200, { ok: true });
    }

    // ── /api/positions: Paper Trader 포지션 + 통계 (Billion 프록시용) ──
    if (req.method === 'GET' && pathname === '/api/positions') {
      return sendJson(res, 200, paperTrader.getStatus());
    }

    // ── /api/learn: Paper Trader 상세 통계 (Billion 프록시용) ──
    if (req.method === 'GET' && pathname === '/api/learn') {
      return sendJson(res, 200, paperTrader.getDetailedStats());
    }

    // ── /api/ohlc: Binance 캔들 데이터 (Billion 차트용) ──
    if (req.method === 'GET' && pathname === '/api/ohlc') {
      const rawSymbol = (searchParams && searchParams.get('symbol')) || 'BTC';
      const interval = (searchParams && searchParams.get('interval')) || '1h';
      const limit = Math.min(Number((searchParams && searchParams.get('limit')) || 100), 1500);
      try {
        const resolved = resolveSymbol(rawSymbol);
        const pair = resolved.pair;
        const ohlcRes = await fetch(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!ohlcRes.ok) {
          return sendJson(res, 502, { error: `Binance API 오류: ${ohlcRes.status}` });
        }
        const raw = await ohlcRes.json();
        const candles = raw.map(k => ({ t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
        return sendJson(res, 200, candles);
      } catch (err) {
        return sendJson(res, 500, { error: `OHLC 조회 실패: ${err.message || err}` });
      }
    }

    // ── /api/signal: 기술적 시그널 스코어 (Billion trading_team_signal용) ──
    if (req.method === 'GET' && pathname === '/api/signal') {
      const rawSymbol = (searchParams && searchParams.get('symbol')) || 'BTC';
      try {
        const resolved = resolveSymbol(rawSymbol);
        const pair = resolved.pair;

        // 1h 캔들 200개 가져오기
        const candleRes = await fetch(
          `https://fapi.binance.com/fapi/v1/klines?symbol=${pair}&interval=1h&limit=200`,
          { signal: AbortSignal.timeout(8000) }
        );
        if (!candleRes.ok) {
          return sendJson(res, 502, { error: `Binance API 오류: ${candleRes.status}` });
        }
        const candleRaw = await candleRes.json();
        const closes = candleRaw.map(k => +k[4]);

        // EMA 계산
        function ema(arr, period) {
          const k = 2 / (period + 1);
          const result = [arr[0]];
          for (let i = 1; i < arr.length; i++) {
            result.push(arr[i] * k + result[i - 1] * (1 - k));
          }
          return result;
        }
        const ema9 = ema(closes, 9);
        const ema21 = ema(closes, 21);
        const ema200 = ema(closes, 200);

        // RSI 14
        let gains = 0, losses = 0;
        for (let i = closes.length - 14; i < closes.length; i++) {
          const diff = closes[i] - closes[i - 1];
          if (diff > 0) gains += diff; else losses -= diff;
        }
        const avgGain = gains / 14;
        const avgLoss = losses / 14;
        const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

        // MACD (12, 26, 9)
        const ema12 = ema(closes, 12);
        const ema26 = ema(closes, 26);
        const macdLine = ema12.map((v, i) => v - ema26[i]);
        const signalLine = ema(macdLine, 9);
        const macdHist = macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1];

        // Funding rate
        let funding = 0;
        try {
          const fundingRes = await fetch(
            `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${pair}&limit=1`,
            { signal: AbortSignal.timeout(5000) }
          );
          if (fundingRes.ok) {
            const fundArr = await fundingRes.json();
            if (fundArr.length > 0) funding = +fundArr[0].fundingRate;
          }
        } catch {}

        // 스코어 계산
        const last = closes.length - 1;

        // RSI 점수 (-30 ~ +30)
        let rsiScore = 0;
        if (rsi < 30) rsiScore = 30;        // 과매도 → 매수 시그널
        else if (rsi > 70) rsiScore = -30;   // 과매수 → 매도 시그널
        else rsiScore = (50 - rsi) * 0.6;    // 중립 구간

        // EMA 정렬 점수 (-30 ~ +30)
        let emaScore = 0;
        if (ema9[last] > ema21[last] && ema21[last] > ema200[last]) emaScore = 30;
        else if (ema9[last] < ema21[last] && ema21[last] < ema200[last]) emaScore = -30;
        else if (ema9[last] > ema21[last]) emaScore = 15;
        else if (ema9[last] < ema21[last]) emaScore = -15;

        // MACD 점수 (-20 ~ +20)
        let macdScore = Math.max(-20, Math.min(20, macdHist * 100));

        // Funding 점수 (-20 ~ +20) — 높은 양의 펀딩 = 과열(매도 시그널)
        let fundingScore = Math.max(-20, Math.min(20, -funding * 20000));

        const totalScore = Math.round(Math.max(-100, Math.min(100, rsiScore + emaScore + macdScore + fundingScore)));
        const direction = totalScore > 15 ? 'LONG' : totalScore < -15 ? 'SHORT' : 'NEUTRAL';

        return sendJson(res, 200, {
          symbol: rawSymbol.toUpperCase(),
          score: totalScore,
          direction,
          indicators: {
            rsi: Math.round(rsi * 10) / 10,
            ema_trend: emaScore > 0 ? 'BULLISH' : emaScore < 0 ? 'BEARISH' : 'MIXED',
            macd_signal: macdHist > 0 ? 'BULLISH' : 'BEARISH',
            funding: Math.round(funding * 10000) / 10000,
          },
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        return sendJson(res, 500, { error: `시그널 조회 실패: ${err.message || err}` });
      }
    }

    // ── /api/backtest/:symbol/:strategy/:days — 백테스트 실행 ──
    if (req.method === 'POST' && pathname.startsWith('/api/backtest/')) {
      const parts = pathname.replace('/api/backtest/', '').split('/');
      const sym = (parts[0] || 'BTC').toUpperCase();
      const strategy = parts[1] || 'confluence';
      const days = parseInt(parts[2]) || 90;
      try {
        const result = await backtester.backtest(sym, strategy, Math.min(days, 365));
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ── /api/backtest/compare/:symbol/:days — 전략 비교 ──
    if (req.method === 'GET' && pathname.startsWith('/api/backtest/compare/')) {
      const parts = pathname.replace('/api/backtest/compare/', '').split('/');
      const sym = (parts[0] || 'BTC').toUpperCase();
      const days = parseInt(parts[1]) || 90;
      try {
        const result = await backtester.compareAll(sym, Math.min(days, 365));
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // ── /api/backtest/strategies — 사용 가능한 전략 목록 ──
    if (req.method === 'GET' && pathname === '/api/backtest/strategies') {
      const list = Object.entries(backtester.strategies).map(([key, s]) => ({
        key,
        name: s.name,
        description: s.description,
        slPct: s.slPct,
        tpPct: s.tpPct,
      }));
      return sendJson(res, 200, { strategies: list });
    }

    // ── /api/quant/signal/:symbol — 퀀트 시그널 조회 ──
    if (req.method === 'GET' && pathname.startsWith('/api/quant/signal/')) {
      const sym = pathname.replace('/api/quant/signal/', '').toUpperCase();
      try {
        const signal = await quantSignals.getSignalForSymbol(sym);
        return sendJson(res, 200, signal);
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // ── /api/webhook/billion — Billion AI 피드백 수신 ──
    if (req.method === 'POST' && pathname === '/api/webhook/billion') {
      let webhookBody = {};
      try { const raw = await readBody(req); webhookBody = raw ? JSON.parse(raw) : {}; } catch {}
      const { type, symbol, action, confidence, reasoning, timestamp } = webhookBody;
      const entry = {
        source: 'billion-ai',
        type: type || 'feedback',
        symbol: symbol || null,
        action: action || null,
        confidence: confidence || null,
        reasoning: reasoning || null,
        ts: timestamp || new Date().toISOString(),
      };

      // 분석 로그에 기록
      if (!engine.billionFeedback) engine.billionFeedback = [];
      engine.billionFeedback.push(entry);
      if (engine.billionFeedback.length > 50) engine.billionFeedback = engine.billionFeedback.slice(-50);

      // AI의 판정과 TT의 최근 판정을 비교하여 일치율 기록
      let alignment = null;
      if (symbol && action) {
        const lastDec = (engine.lastDecisions || {})[symbol];
        if (lastDec) {
          const ttAction = (lastDec.action || '').toUpperCase();
          const billionAction = action.toUpperCase();
          alignment = ttAction === billionAction ? 'AGREE' : 'DISAGREE';
        }
      }

      console.log(`[webhook] Billion AI 피드백: ${symbol || '?'} ${action || '?'} (alignment: ${alignment || 'N/A'})`);
      return sendJson(res, 200, { received: true, alignment, ts: new Date().toISOString() });
    }

    // 레거시 백테스트 엔드포인트 호환
    if (req.method === 'GET' && (pathname === '/api/backtest' || pathname === '/api/backtest-full' || pathname === '/api/backtest-scalp')) {
      const sym = (searchParams && searchParams.get('symbol')) || 'BTC';
      const strategy = (searchParams && searchParams.get('strategy')) || 'confluence';
      const days = parseInt((searchParams && searchParams.get('days')) || '90');
      try {
        const result = await backtester.backtest(sym, strategy, Math.min(days, 365));
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // ── /api/learn — 학습 엔진 ──
    // GET /api/learn/rules — 학습된 규칙
    if (req.method === 'GET' && pathname === '/api/learn/rules') {
      return sendJson(res, 200, { rules: learner.loadRules(), timestamp: new Date().toISOString() });
    }

    // GET /api/learn/patterns — 최고/최악 패턴
    if (req.method === 'GET' && pathname === '/api/learn/patterns') {
      return sendJson(res, 200, {
        best: learner.checkBestPatterns(),
        worst: learner.checkWorstPatterns(),
        timestamp: new Date().toISOString()
      });
    }

    // GET /api/learn/strategies — AI 자동생성 전략
    if (req.method === 'GET' && pathname === '/api/learn/strategies') {
      return sendJson(res, 200, { strategies: learner.loadCustomStrategies(), timestamp: new Date().toISOString() });
    }

    // POST /api/learn/analyze — 학습 재분석 실행
    if (req.method === 'POST' && pathname === '/api/learn/analyze') {
      const result = learner.analyzeLessons();
      return sendJson(res, 200, { result, timestamp: new Date().toISOString() });
    }

    // ── /api/quant — 퀀트 시그널 ──
    // GET /api/quant/regime/:symbol — 시장 레짐 분류
    if (req.method === 'GET' && pathname.startsWith('/api/quant/regime/')) {
      const sym = pathname.split('/').pop();
      try {
        const candles = await backtester.fetchHistoricalCandles(sym + 'USDT', '1h', 100);
        const regime = quantSignals.classifyRegime(candles);
        return sendJson(res, 200, { symbol: sym, regime, timestamp: new Date().toISOString() });
      } catch(e) { return sendJson(res, 500, { error: e.message }); }
    }

    // GET /api/quant/patterns/:symbol — 캔들 패턴 감지
    if (req.method === 'GET' && pathname.startsWith('/api/quant/patterns/')) {
      const sym = pathname.split('/').pop();
      try {
        const candles = await backtester.fetchHistoricalCandles(sym + 'USDT', '1h', 50);
        const patterns = quantSignals.detectCandlePatterns(candles);
        return sendJson(res, 200, { symbol: sym, patterns, timestamp: new Date().toISOString() });
      } catch(e) { return sendJson(res, 500, { error: e.message }); }
    }

    // GET /api/quant/ensemble/:symbol — 앙상블 투표
    if (req.method === 'GET' && pathname.startsWith('/api/quant/ensemble/')) {
      const sym = pathname.split('/').pop();
      try {
        const candles = await backtester.fetchHistoricalCandles(sym + 'USDT', '1h', 200);
        const result = quantSignals.ensembleVote(candles);
        return sendJson(res, 200, { symbol: sym, ...result, timestamp: new Date().toISOString() });
      } catch(e) { return sendJson(res, 500, { error: e.message }); }
    }

    // ── /api/risk — 리스크 관리 ──
    // GET /api/risk/portfolio — 포트폴리오 분석
    if (req.method === 'GET' && pathname === '/api/risk/portfolio') {
      try {
        const status = paperTrader.getStatus();
        const correlation = riskManager.getPortfolioCorrelation ? riskManager.getPortfolioCorrelation() : null;
        const attribution = riskManager.getPerformanceAttribution ? riskManager.getPerformanceAttribution() : null;
        return sendJson(res, 200, { correlation, attribution, positions: (status.positions||[]).length, timestamp: new Date().toISOString() });
      } catch(e) { return sendJson(res, 200, { correlation: null, attribution: null, error: e.message }); }
    }

    // GET /api/risk/check — 리스크 체크
    if (req.method === 'GET' && pathname === '/api/risk/check') {
      try {
        const status = paperTrader.getStatus();
        const drawdownOk = riskManager.checkDrawdownProtection ? riskManager.checkDrawdownProtection(status) : { ok: true };
        return sendJson(res, 200, { drawdown: drawdownOk, capital: status.capital, maxDrawdown: status.maxDrawdown, timestamp: new Date().toISOString() });
      } catch(e) { return sendJson(res, 200, { drawdown: { ok: true }, error: e.message }); }
    }

    // ── /api/paper — 페이퍼 트레이더 확장 ──
    // POST /api/paper/close/:symbol — 특정 포지션 청산
    if (req.method === 'POST' && pathname.startsWith('/api/paper/close/')) {
      const sym = pathname.split('/').pop();
      try {
        // Find and close the position
        const status = paperTrader.getStatus();
        const allPos = [...(status.positions||[]), ...(status.swingPositions||[])];
        const pos = allPos.find(p => p.symbol === sym || p.symbol === sym + 'USDT');
        if (!pos) return sendJson(res, 404, { error: `${sym} 포지션 없음` });
        // Use the paper trader's close mechanism
        if (typeof paperTrader.closePosition === 'function') {
          paperTrader.closePosition(pos, 'MANUAL_CLOSE');
        }
        return sendJson(res, 200, { success: true, symbol: sym, message: `${sym} 포지션 청산됨` });
      } catch(e) { return sendJson(res, 500, { error: e.message }); }
    }

    // POST /api/paper/close-all — 전체 포지션 청산
    if (req.method === 'POST' && pathname === '/api/paper/close-all') {
      try {
        const status = paperTrader.getStatus();
        const allPos = [...(status.positions||[]), ...(status.swingPositions||[])];
        let closed = 0;
        for (const pos of allPos) {
          if (typeof paperTrader.closePosition === 'function') {
            paperTrader.closePosition(pos, 'MANUAL_CLOSE_ALL');
            closed++;
          }
        }
        return sendJson(res, 200, { success: true, closed, message: `${closed}개 포지션 청산 완료` });
      } catch(e) { return sendJson(res, 500, { error: e.message }); }
    }

    // ── /api/chat — AI 채팅 (Billion 프록시 or 로컬) ──
    if (req.method === 'POST' && pathname === '/api/chat') {
      const body = await readBody(req);
      const messages = body.messages || [];
      const context = body.context || '';

      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return sendJson(res, 200, { text: 'ANTHROPIC_API_KEY 미설정 — AI 기능 비활성화 상태입니다.' });

      try {
        // Collect market context
        const status = paperTrader.getStatus();
        const systemPrompt = `당신은 BILLION AI — 암호화폐 헤지펀드 AI 비서입니다.
현재 상태: 자본 $${(status.capital||3000).toFixed(0)}, 수익률 ${(status.returnPct||0).toFixed(1)}%, 승률 ${(status.winRate||0)}%, 포지션 ${(status.positions||[]).length}개
추가 컨텍스트: ${context}
간결하고 전문적으로 답하세요. 한국어로 답변하세요.`;

        // messages 검증 — 최소 1개, role은 user/assistant만
        const validMsgs = messages
          .filter(m => m.content && (m.role === 'user' || m.role === 'assistant'))
          .map(m => ({ role: m.role, content: String(m.content) }));
        if (!validMsgs.length) validMsgs.push({ role: 'user', content: '안녕하세요' });

        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            system: systemPrompt,
            messages: validMsgs,
          }),
          signal: AbortSignal.timeout(25000),
        });

        if (!claudeRes.ok) {
          const err = await claudeRes.text();
          console.error('[chat] Claude API error:', claudeRes.status, err);
          return sendJson(res, 200, { text: 'AI 응답 실패 (' + claudeRes.status + '): ' + (err || '').slice(0, 200) });
        }

        const claudeData = await claudeRes.json();
        const text = claudeData.content?.[0]?.text || '응답 없음';
        return sendJson(res, 200, { text });
      } catch (e) {
        return sendJson(res, 200, { text: 'AI 연결 실패: ' + e.message });
      }
    }

    // ── /api/scan/quick — 전 코인 퀀트 빠른 스캔 ──
    if (req.method === 'GET' && pathname === '/api/scan/quick') {
      try {
        const symbols = ['BTC','ETH','SOL','AVAX','DOGE','LINK','SUI','PEPE','WIF','TON'];
        const results = [];
        for (const sym of symbols) {
          try {
            const signal = await quantSignals.getSignalForSymbol(sym + 'USDT');
            results.push({
              symbol: sym,
              action: signal?.action || 'HOLD',
              confidence: signal?.confidence || 0,
              grade: signal?.grade || '?',
              score: signal?.totalScore || signal?.score || 0,
            });
          } catch { results.push({ symbol: sym, action: 'ERROR', confidence: 0, grade: '?', score: 0 }); }
        }
        results.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
        return sendJson(res, 200, { results, timestamp: new Date().toISOString() });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ── /api/fund/metrics — 펀드 상세 메트릭스 ──
    if (req.method === 'GET' && pathname === '/api/fund/metrics') {
      try {
        const status = paperTrader.getStatus();
        const detailed = paperTrader.getDetailedStats();
        const history = paperTrader.getHistory();
        const trades = history.trades || history || [];

        // Calculate additional metrics
        const wins = trades.filter(t => (t.pnl || 0) > 0);
        const losses = trades.filter(t => (t.pnl || 0) <= 0);
        const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length) : 0;
        const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;
        const expectancy = trades.length > 0 ? trades.reduce((s, t) => s + (t.pnl || 0), 0) / trades.length : 0;

        return sendJson(res, 200, {
          capital: status.capital || 3000,
          startCapital: status.startCapital || 3000,
          returnPct: status.returnPct || 0,
          totalPnl: status.totalPnl || 0,
          todayPnl: status.todayPnl || 0,
          totalTrades: trades.length,
          wins: wins.length,
          losses: losses.length,
          winRate: trades.length > 0 ? (wins.length / trades.length * 100) : 0,
          maxDrawdown: status.maxDrawdown || 0,
          avgWin,
          avgLoss,
          profitFactor,
          expectancy,
          sharpe: detailed?.sharpe || 0,
          sortino: detailed?.sortino || 0,
          calmar: detailed?.calmar || 0,
          positions: (status.positions || []).length,
          swingPositions: (status.swingPositions || []).length,
          running: status.running || false,
          regime: status.marketRegime?.regime || 'UNKNOWN',
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ── /api/paper/adjust — 포지션 SL/TP 조정 ──
    if (req.method === 'POST' && pathname === '/api/paper/adjust') {
      const body = await readBody(req);
      const { symbol, sl, tp } = body;
      if (!symbol) return sendJson(res, 400, { error: 'symbol 필요' });
      try {
        const status = paperTrader.getStatus();
        const allPos = [...(status.positions || []), ...(status.swingPositions || [])];
        const pos = allPos.find(p => p.symbol === symbol || p.symbol === symbol + 'USDT');
        if (!pos) return sendJson(res, 404, { error: symbol + ' 포지션 없음' });
        if (sl !== undefined) pos.slPrice = parseFloat(sl);
        if (tp !== undefined) pos.tpPrice = parseFloat(tp);
        return sendJson(res, 200, { success: true, symbol, sl: pos.slPrice, tp: pos.tpPrice, message: symbol + ' SL/TP 조정 완료' });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ── /api/market/summary — 시장 요약 ──
    if (req.method === 'GET' && pathname === '/api/market/summary') {
      try {
        const status = paperTrader.getStatus();
        const prices = priceFeed.getAllPrices ? priceFeed.getAllPrices() : {};
        const regime = status.marketRegime || {};

        return sendJson(res, 200, {
          regime: regime.regime || 'UNKNOWN',
          btcChange: regime.btcChange || 0,
          capital: status.capital || 3000,
          returnPct: status.returnPct || 0,
          totalPnl: status.totalPnl || 0,
          positions: (status.positions || []).length + (status.swingPositions || []).length,
          running: status.running || false,
          winRate: status.winRate || 0,
          totalTrades: status.totalTrades || 0,
          lastAnalysis: status.lastAnalysis || null,
          circuitBreaker: status.circuitBreakerActive || false,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ── /api/signals/all — 전 코인 시그널 스캔 ──
    if (req.method === 'GET' && pathname === '/api/signals/all') {
      try {
        const symbols = ['BTC','ETH','SOL','AVAX','DOGE','LINK','SUI','PEPE','WIF','TON'];
        const results = [];

        // Get latest decisions from paper trader
        const status = paperTrader.getStatus();
        const recentTrades = status.recentTrades || [];
        const positions = [...(status.positions || []), ...(status.swingPositions || [])];

        for (const sym of symbols) {
          const pos = positions.find(p => p.symbol === sym);
          const lastTrade = recentTrades.find(t => t.symbol === sym);

          let signal = null;
          try {
            signal = await quantSignals.getSignalForSymbol(sym + 'USDT');
          } catch {}

          results.push({
            symbol: sym,
            action: signal?.action || (pos ? pos.direction : 'HOLD'),
            confidence: signal?.confidence || (pos ? pos.confidence : 0),
            grade: signal?.grade || (pos ? pos.grade : '?'),
            score: signal?.totalScore || signal?.score || 0,
            hasPosition: !!pos,
            posDirection: pos?.direction || null,
            lastTradeResult: lastTrade ? (lastTrade.pnl >= 0 ? 'WIN' : 'LOSS') : null,
          });
        }

        return sendJson(res, 200, { results, timestamp: new Date().toISOString() });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ── /api/paper/stats — 거래 통계 상세 ──
    if (req.method === 'GET' && pathname === '/api/paper/stats') {
      try {
        const history = paperTrader.getHistory();
        const trades = history.trades || history || [];

        // Coin-by-coin stats
        const coinStats = {};
        trades.forEach(t => {
          const sym = t.symbol || 'UNKNOWN';
          if (!coinStats[sym]) coinStats[sym] = { wins: 0, losses: 0, totalPnl: 0, trades: [] };
          if ((t.pnl || 0) > 0) coinStats[sym].wins++;
          else coinStats[sym].losses++;
          coinStats[sym].totalPnl += (t.pnl || 0);
          coinStats[sym].trades.push({ pnl: t.pnl || 0, direction: t.direction, reason: t.closeReason });
        });

        // Hourly performance
        const hourlyStats = {};
        trades.forEach(t => {
          const hour = t.entryTime ? new Date(t.entryTime).getHours() : 0;
          if (!hourlyStats[hour]) hourlyStats[hour] = { wins: 0, losses: 0 };
          if ((t.pnl || 0) > 0) hourlyStats[hour].wins++;
          else hourlyStats[hour].losses++;
        });

        // Direction stats
        const longTrades = trades.filter(t => t.direction === 'BUY' || t.direction === 'LONG');
        const shortTrades = trades.filter(t => t.direction === 'SELL' || t.direction === 'SHORT');
        const longWR = longTrades.length > 0 ? (longTrades.filter(t => (t.pnl||0) > 0).length / longTrades.length * 100) : 0;
        const shortWR = shortTrades.length > 0 ? (shortTrades.filter(t => (t.pnl||0) > 0).length / shortTrades.length * 100) : 0;

        // Close reason stats
        const reasons = {};
        trades.forEach(t => {
          const r = t.closeReason || 'OTHER';
          if (!reasons[r]) reasons[r] = 0;
          reasons[r]++;
        });

        return sendJson(res, 200, {
          totalTrades: trades.length,
          coinStats,
          hourlyStats,
          longTrades: longTrades.length,
          shortTrades: shortTrades.length,
          longWinRate: longWR,
          shortWinRate: shortWR,
          closeReasons: reasons,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ── /api/engine/config — 엔진 설정 조회/변경 ──
    if (req.method === 'GET' && pathname === '/api/engine/config') {
      try {
        const status = paperTrader.getStatus();
        return sendJson(res, 200, {
          symbols: status.symbols || [],
          swingSymbols: status.swingSymbols || [],
          config: status.config || {},
          strategyMode: status.strategyMode || 'both',
          analysisInterval: status.analysisInterval || '',
          running: status.running || false,
        });
      } catch (e) {
        return sendJson(res, 500, { error: e.message });
      }
    }

    // ── /api/calendar — 경제 캘린더 (FCS v4 전용, 캐시 6시간) ──
    if (req.method === 'GET' && pathname === '/api/calendar') {
      const calCache = global.__calCache || {};
      if (calCache.data && Date.now() - calCache.ts < 6 * 3600000) {
        return sendJson(res, 200, calCache.data);
      }
      const FCS_KEY = process.env.FCS_API_KEY || '';
      if (!FCS_KEY) return sendJson(res, 500, { source: 'none', events: [], error: 'FCS_API_KEY 미설정' });
      try {
        const fcsRes = await fetch(`https://api-v4.fcsapi.com/forex/economy_cal?access_key=${FCS_KEY}`, {
          signal: AbortSignal.timeout(10000)
        });
        if (!fcsRes.ok) throw new Error('FCS API 응답 실패: ' + fcsRes.status);
        const fcsData = await fcsRes.json();
        const rawEvents = fcsData.response || fcsData.data || [];
        if (!Array.isArray(rawEvents) || !rawEvents.length) throw new Error('FCS 데이터 없음');
        // 주요국 필터: US, UK, EU, CA, AU, CH(중국), JP, NZD, CHF
        const majorCurrencies = new Set(['USD','GBP','EUR','CAD','AUD','CNY','JPY','NZD','CHF']);
        const events = rawEvents
          .filter(e => {
            const cur = e.currency || e.country || '';
            const imp = e.importance || '';
            // 주요국 High+Medium만
            return majorCurrencies.has(cur) && (imp === '3' || imp === '2' || imp === 'High' || imp === 'Medium');
          })
          .map(e => ({
            title: e.title || e.event || '',
            country: e.currency || e.country || '',
            date: e.date || '',
            impact: (e.importance === '3' || e.importance === 'High') ? 'High' : 'Medium',
            actual: e.actual || '',
            forecast: e.forecast || e.estimate || '',
            previous: e.previous || '',
          }));
        const result = { source: 'fcs-v4', events };
        global.__calCache = { data: result, ts: Date.now() };
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 500, { source: 'none', events: [], error: 'FCS 캘린더 로드 실패: ' + e.message });
      }
    }

    // ── /api/rss — RSS 뉴스 프록시 ──
    if (req.method === 'GET' && pathname === '/api/rss') {
      const feed = searchParams?.get('feed') || 'kr';
      const FEEDS = {
        kr: 'https://www.blockmedia.co.kr/feed/',
        coindesk: 'https://www.coindesk.com/arc/outboundfeeds/rss/',
        cointelegraph: 'https://cointelegraph.com/rss',
        theblock: 'https://www.theblock.co/rss.xml',
        decrypt: 'https://decrypt.co/feed',
      };
      const feedUrl = FEEDS[feed];
      if (!feedUrl) return sendJson(res, 400, { error: 'Unknown feed' });
      try {
        const r = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        const text = await r.text();
        const items = [];
        const itemRegex = /<item>([\s\S]*?)<\/item>/g;
        let match;
        while ((match = itemRegex.exec(text)) !== null && items.length < 15) {
          const xml = match[1];
          const title = (xml.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/) || [])[1] || '';
          const link = (xml.match(/<link>(.*?)<\/link>/) || [])[1] || '';
          const pubDate = (xml.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1] || '';
          if (title && link) items.push({ title: title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>'), url: link, ts: pubDate ? Date.parse(pubDate) : Date.now(), source: feed.toUpperCase() });
        }
        return sendJson(res, 200, { items });
      } catch (e) { return sendJson(res, 500, { error: e.message, items: [] }); }
    }

    // ── /api/auth-config — Supabase 인증 설정 ──
    if (req.method === 'GET' && pathname === '/api/auth-config') {
      const url = process.env.TERMINAL_SUPABASE_URL;
      const key = process.env.TERMINAL_SUPABASE_ANON_KEY;
      if (!url || !key) return sendJson(res, 200, { error: 'Supabase not configured' });
      return sendJson(res, 200, { url, key });
    }

    // ── /api/health — 헬스 체크 ──
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
    }

    // ── /dashboard 라우트 ──
    if (req.method === 'GET' && pathname === '/dashboard') {
      return await handleStatic(req, res, '/dashboard.html');
    }

    if (req.method === 'GET') {
      return await handleStatic(req, res, pathname);
    }
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
  } catch (err) {
    console.error('[server] 처리 오류:', err && err.message ? err.message : err);
    if (!res.headersSent) sendJson(res, 500, { error: '서버 내부 오류.' });
    else res.end();
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log('====================================');
  console.log('  ◆ PIXEL TRADING FLOOR ◆');
  console.log(`  서버 실행 중: ${url}`);
  console.log(`  데모 모드: ${url}/?demo=1`);
  console.log('  종료: Ctrl+C');
  console.log('====================================');

  // 실시간 가격 피드 시작
  priceFeed.start();

  // 가상매매 자동 시작
  paperTrader.start((type, data) => {
    // 매매 이벤트를 Billion/Terminal에 알림
    const msg = type === 'trade_opened'
      ? `[PAPER] ${data.symbol} LONG @ $${data.entryPrice} | ${data.pattern}`
      : `[PAPER] ${data.symbol} ${data.closeReason} | PnL $${data.pnl} | 자본 $${data.capitalAfter}`;
    console.log(msg);
    // Bridge hook으로 Billion + Terminal에 전달
    const pushPayload = { action: 'push_data', data: { type: `paper:${type}`, ...data, timestamp: new Date().toISOString() } };
    try {
      fetch(`${BILLION_URL}/api/motera`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Gateway-Key': GATEWAY_SECRET },
        body: JSON.stringify(pushPayload),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } catch {}
    try {
      fetch(`${TERMINAL_URL}/api/gateway`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Gateway-Key': GATEWAY_SECRET },
        body: JSON.stringify({ action: 'push_event', data: { type: `paper:${type}`, ...data, timestamp: new Date().toISOString() } }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    } catch {}
  });
  console.log('  ◆ PAPER TRADER 자동 시작 ◆');
});

module.exports = { server, engine };
