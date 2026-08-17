#!/usr/bin/env node
/*
 * claude-shim.js — OpenAI-compatible local proxy that delegates to `claude -p`.
 * -----------------------------------------------------------------------------
 * Purpose: let the Python TradingAgents framework (LangChain ChatOpenAI, provider
 * "openai" with backend_url=http://localhost:8787/v1) run WITHOUT paying for an
 * OpenAI API key. Every /v1/chat/completions request is serialized into a single
 * prompt and answered by the local `claude` CLI, which draws on the machine's
 * Claude Max subscription quota (no per-token API billing).
 *
 * Endpoints (Node built-ins only — no npm deps):
 *   POST /v1/chat/completions  (non-streaming + minimal single-chunk SSE)
 *       - Serializes messages (system/user/assistant/tool) + tools into one prompt.
 *       - Tool-call EMULATION: when the request carries `tools`, Claude is asked to
 *         reply with exactly one JSON object — {"tool_call":{name,arguments}} or
 *         {"final":"..."} — which we translate back into OpenAI `tool_calls`
 *         (finish_reason:"tool_calls", arguments as a JSON string) or plain content.
 *   POST /v1/embeddings        (deterministic FAKE hash-based vectors)
 *       - NOTE: this TradingAgents fork uses a markdown decision log (TradingMemoryLog),
 *         NOT vector embeddings, so this endpoint is a harmless safety net for other
 *         callers / older forks. The vectors carry no semantic meaning; they only keep
 *         an embeddings-dependent memory layer from crashing.
 *   GET  /v1/models, GET /healthz  (convenience)
 *
 * Model mapping: the request model name is ignored; every call uses env SHIM_MODEL
 * (default "opus"). Set SHIM_MODEL=haiku or sonnet to run cheaper/faster.
 *
 * Env:
 *   SHIM_PORT      (default 8787)
 *   SHIM_MODEL     (default "opus")   -> passed to `claude --model`
 *   SHIM_TIMEOUT   (default 240000 ms) per claude spawn
 *   SHIM_CLAUDE    (default "claude") claude executable name/path
 *   SHIM_EMBED_DIM (default 1536)     fallback embedding dimension
 */

'use strict';

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.SHIM_PORT || '8787', 10);
const MODEL = process.env.SHIM_MODEL || 'opus';
const TIMEOUT_MS = parseInt(process.env.SHIM_TIMEOUT || '240000', 10);
const CLAUDE_BIN = process.env.SHIM_CLAUDE || 'claude';
const EMBED_DIM = parseInt(process.env.SHIM_EMBED_DIM || '1536', 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function randId(prefix) {
  return prefix + crypto.randomBytes(12).toString('hex');
}

// Rough token estimate (~4 chars/token). Only used to populate the usage block.
function estTokens(str) {
  if (!str) return 0;
  return Math.max(1, Math.ceil(String(str).length / 4));
}

// Flatten OpenAI message content, which may be a plain string or an array of
// typed content blocks (e.g. [{type:"text",text:"..."}]).
function flattenContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (part.type === 'image_url') return '[image omitted]';
        }
        return '';
      })
      .join('');
  }
  if (typeof content === 'object' && typeof content.text === 'string') return content.text;
  return String(content);
}

// Serialize the chat history + optional tool schemas into one prompt string that
// `claude -p` can answer. Returns { prompt, hasTools }.
function buildPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const hasTools = tools.length > 0;

  const lines = [];
  lines.push(
    'You are acting as an OpenAI-compatible chat completion backend for an ' +
      'autonomous multi-agent system. Read the full conversation below and produce ' +
      'the next assistant turn.'
  );
  lines.push('');
  lines.push('=== CONVERSATION ===');

  for (const m of messages) {
    const role = (m && m.role) || 'user';
    if (role === 'system') {
      lines.push('[SYSTEM]');
      lines.push(flattenContent(m.content));
    } else if (role === 'user' || role === 'human') {
      lines.push('[USER]');
      lines.push(flattenContent(m.content));
    } else if (role === 'assistant' || role === 'ai') {
      lines.push('[ASSISTANT]');
      const c = flattenContent(m.content);
      if (c) lines.push(c);
      // Prior tool calls made by the assistant — render so the model has the
      // context of what it already requested in earlier ReAct turns.
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const fn = (tc && tc.function) || {};
          lines.push(
            `(called tool ${fn.name || tc.name || 'unknown'} with arguments ${
              typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {})
            })`
          );
        }
      }
    } else if (role === 'tool' || role === 'function') {
      const name = m.name || m.tool_call_id || 'tool';
      lines.push(`[TOOL RESULT: ${name}]`);
      lines.push(flattenContent(m.content));
    } else {
      lines.push(`[${role.toUpperCase()}]`);
      lines.push(flattenContent(m.content));
    }
    lines.push('');
  }

  if (hasTools) {
    lines.push('=== AVAILABLE TOOLS ===');
    for (const t of tools) {
      const fn = (t && t.function) || t || {};
      const params = fn.parameters ? JSON.stringify(fn.parameters) : '{}';
      lines.push(`- ${fn.name}: ${fn.description || ''}`);
      lines.push(`  parameters (JSON Schema): ${params}`);
    }
    lines.push('');
    lines.push('=== RESPONSE PROTOCOL (STRICT) ===');
    lines.push(
      'You must reply with EXACTLY ONE JSON object and NOTHING else — no prose, no ' +
        'markdown, no code fences before or after it.'
    );
    lines.push(
      '- To call a tool, output: {"tool_call": {"name": "<toolName>", "arguments": { ... }}}'
    );
    lines.push(
      '  Use only tool names from the list above. `arguments` must be a JSON object ' +
        'matching that tool\'s parameters. Call one tool at a time.'
    );
    lines.push(
      '- When you have gathered enough information and are giving your final answer, ' +
        'output: {"final": "<your complete answer as a single string>"}'
    );
    lines.push(
      'Do not wrap the JSON in quotes or code fences. Output the raw JSON object only.'
    );
  }

  return { prompt: lines.join('\n'), hasTools, toolCount: tools.length, msgCount: messages.length };
}

// Run `claude -p --model <MODEL>` with the prompt on stdin. Resolves with stdout text.
function runClaude(prompt) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', MODEL, '--output-format', 'text'];
    const child = spawn(CLAUDE_BIN, args, {
      shell: true,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch (_) {
        /* ignore */
      }
      reject(new Error(`claude timed out after ${TIMEOUT_MS}ms`));
    }, TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0 && !stdout.trim()) {
        reject(new Error(`claude exited ${code}: ${stderr.trim() || '(no output)'}`));
      } else {
        resolve(stdout.trim());
      }
    });

    // Feed the prompt via stdin (avoids command-line length limits & escaping).
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// Strip ```json ... ``` / ``` ... ``` fences from a candidate string.
function stripFences(text) {
  const t = text.trim();
  const fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1].trim() : t;
}

// Find the first balanced-brace JSON object substring and JSON.parse it.
// Returns the parsed object or null. String-aware so braces inside strings
// don't unbalance the scan.
function extractJsonObject(text) {
  const s = text;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = s.slice(i, j + 1);
          try {
            return JSON.parse(candidate);
          } catch (_) {
            break; // malformed; move outer i forward to try the next '{'
          }
        }
      }
    }
  }
  return null;
}

// Parse Claude's raw output into a decision the OpenAI response layer understands.
// Returns { kind: 'tool_call', name, arguments } | { kind: 'final', text }.
function parseToolResponse(raw) {
  const cleaned = stripFences(raw);
  let obj = null;
  try {
    obj = JSON.parse(cleaned);
  } catch (_) {
    obj = extractJsonObject(cleaned);
  }
  if (obj && typeof obj === 'object') {
    if (obj.tool_call && obj.tool_call.name) {
      return {
        kind: 'tool_call',
        name: String(obj.tool_call.name),
        arguments: obj.tool_call.arguments != null ? obj.tool_call.arguments : {},
      };
    }
    if (Object.prototype.hasOwnProperty.call(obj, 'final')) {
      return { kind: 'final', text: String(obj.final) };
    }
  }
  // No parseable protocol object — treat the whole thing as a free-text answer.
  return { kind: 'final', text: raw };
}

// ---------------------------------------------------------------------------
// OpenAI response builders
// ---------------------------------------------------------------------------

function buildChatResponse(decision, promptText) {
  const id = randId('chatcmpl-');
  const created = nowUnix();
  let message;
  let finish;
  let completionText;

  if (decision.kind === 'tool_call') {
    const argStr =
      typeof decision.arguments === 'string'
        ? decision.arguments
        : JSON.stringify(decision.arguments);
    message = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: randId('call_'),
          type: 'function',
          function: { name: decision.name, arguments: argStr },
        },
      ],
    };
    finish = 'tool_calls';
    completionText = argStr;
  } else {
    message = { role: 'assistant', content: decision.text };
    finish = 'stop';
    completionText = decision.text;
  }

  const pt = estTokens(promptText);
  const ct = estTokens(completionText);
  return {
    id,
    object: 'chat.completion',
    created,
    model: MODEL,
    choices: [{ index: 0, message, finish_reason: finish, logprobs: null }],
    usage: { prompt_tokens: pt, completion_tokens: ct, total_tokens: pt + ct },
  };
}

// Minimal single-chunk SSE. LLM token streaming is NOT used by TradingAgents
// (its graph.stream streams node states, while ChatOpenAI.invoke is blocking),
// so a one-delta emission is sufficient if a caller ever sets stream:true.
function writeStream(res, decision) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  const id = randId('chatcmpl-');
  const created = nowUnix();
  const base = { id, object: 'chat.completion.chunk', created, model: MODEL };

  let delta;
  let finish;
  if (decision.kind === 'tool_call') {
    const argStr =
      typeof decision.arguments === 'string'
        ? decision.arguments
        : JSON.stringify(decision.arguments);
    delta = {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          index: 0,
          id: randId('call_'),
          type: 'function',
          function: { name: decision.name, arguments: argStr },
        },
      ],
    };
    finish = 'tool_calls';
  } else {
    delta = { role: 'assistant', content: decision.text };
    finish = 'stop';
  }

  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

// Deterministic pseudo-embedding: seed a counter-mode SHA-256 PRNG from the text
// so identical text always yields the identical unit vector. No semantic meaning.
function fakeEmbedding(text, dim) {
  const vec = new Array(dim);
  let filled = 0;
  let counter = 0;
  const seed = crypto.createHash('sha256').update(String(text)).digest();
  while (filled < dim) {
    const block = crypto
      .createHash('sha256')
      .update(seed)
      .update(Buffer.from([counter & 0xff, (counter >> 8) & 0xff, (counter >> 16) & 0xff, (counter >> 24) & 0xff]))
      .digest();
    for (let i = 0; i + 4 <= block.length && filled < dim; i += 4) {
      const u = block.readUInt32BE(i) / 0xffffffff; // [0,1]
      vec[filled++] = u * 2 - 1; // [-1,1]
    }
    counter++;
  }
  // L2-normalize so downstream cosine/dot-product math behaves.
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] = vec[i] / norm;
  return vec;
}

// ---------------------------------------------------------------------------
// Request plumbing
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2 * 1024 * 1024) { // 2MB 제한 (DoS 방지)
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

function sendError(res, status, message, type) {
  sendJson(res, status, { error: { message, type: type || 'shim_error', code: null, param: null } });
}

async function handleChat(req, res, body) {
  const t0 = Date.now();
  const built = buildPrompt(body);
  let raw;
  try {
    raw = await runClaude(built.prompt);
  } catch (err) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`[chat] model=${MODEL} tools=${built.toolCount} msgs=${built.msgCount} ERROR ${secs}s: ${err.message}`);
    sendError(res, 502, `claude backend failed: ${err.message}`, 'upstream_error');
    return;
  }

  const decision = built.hasTools ? parseToolResponse(raw) : { kind: 'final', text: raw };
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const outcome =
    decision.kind === 'tool_call' ? `tool_call(${decision.name})` : `final(${decision.text.length}ch)`;
  console.log(
    `[chat] model=${MODEL} tools=${built.toolCount} msgs=${built.msgCount} -> ${outcome} ${secs}s`
  );

  if (body.stream) {
    writeStream(res, decision);
  } else {
    sendJson(res, 200, buildChatResponse(decision, built.prompt));
  }
}

function handleEmbeddings(req, res, body) {
  const t0 = Date.now();
  let inputs = body.input;
  if (inputs == null) inputs = [''];
  if (!Array.isArray(inputs)) inputs = [inputs];
  // OpenAI also allows token-id arrays; coerce anything non-string to string.
  const dim = parseInt(body.dimensions || EMBED_DIM, 10) || EMBED_DIM;
  const data = inputs.map((text, index) => ({
    object: 'embedding',
    index,
    embedding: fakeEmbedding(typeof text === 'string' ? text : JSON.stringify(text), dim),
  }));
  const totalChars = inputs.reduce((a, t) => a + estTokens(t), 0);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[embeddings] model=${body.model || 'fake'} n=${inputs.length} dim=${dim} (FAKE) ${secs}s`);
  sendJson(res, 200, {
    object: 'list',
    data,
    model: body.model || 'shim-fake-embedding',
    usage: { prompt_tokens: totalChars, total_tokens: totalChars },
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && (url === '/healthz' || url === '/' || url === '/health')) {
    sendJson(res, 200, { status: 'ok', model: MODEL, port: PORT });
    return;
  }
  if (req.method === 'GET' && url === '/v1/models') {
    sendJson(res, 200, {
      object: 'list',
      data: [{ id: MODEL, object: 'model', created: nowUnix(), owned_by: 'claude-shim' }],
    });
    return;
  }

  if (req.method !== 'POST') {
    sendError(res, 404, `no route for ${req.method} ${url}`, 'not_found');
    return;
  }

  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (err) {
    sendError(res, 400, `invalid JSON body: ${err.message}`, 'invalid_request_error');
    return;
  }

  try {
    if (url === '/v1/chat/completions') {
      await handleChat(req, res, body);
    } else if (url === '/v1/embeddings') {
      handleEmbeddings(req, res, body);
    } else {
      sendError(res, 404, `no route for POST ${url}`, 'not_found');
    }
  } catch (err) {
    console.error(`[error] ${url}: ${err.stack || err.message}`);
    if (!res.headersSent) sendError(res, 500, err.message, 'internal_error');
  }
});

server.listen(PORT, () => {
  console.log(`claude-shim listening on http://localhost:${PORT}/v1`);
  console.log(`  model mapping: ANY -> "${MODEL}" (set SHIM_MODEL to change)`);
  console.log(`  claude bin="${CLAUDE_BIN}"  timeout=${TIMEOUT_MS}ms  embed_dim=${EMBED_DIM}`);
});
