'use strict';

// decisions.json에 판정 1건을 append하는 CLI.
// 용도: /floor 세션 커맨드가 node -e 대신 이 스크립트를 쓰면
// 권한 allowlist를 정적 명령 하나로 좁힐 수 있다.
// 사용: node server/append-decision.js '{"ts":"...","symbol":"...","mode":"...","action":"...","confidence":62,"scalpBias":null,"source":"session"}'

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'reports', 'decisions.json');

const raw = process.argv[2];
if (!raw) {
  console.error('사용법: node server/append-decision.js \'<판정 JSON 1건>\'');
  process.exit(1);
}

let entry;
try {
  entry = JSON.parse(raw);
} catch (e) {
  console.error('JSON 파싱 실패:', e.message);
  process.exit(1);
}

let arr = [];
try {
  const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (Array.isArray(parsed)) arr = parsed;
} catch (_) {}

arr.push(entry);
fs.mkdirSync(path.dirname(FILE), { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(arr, null, 2), 'utf8');
console.log(`decisions.json에 추가됨 (총 ${arr.length}건)`);
