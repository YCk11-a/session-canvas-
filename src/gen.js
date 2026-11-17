// gen.js — chat session → self-contained interactive canvas HTML
// Sources: OpenClaw (~/.openclaw or ~/.kimi_openclaw agents/*/sessions/*.jsonl)
//          DeepSeek Harness (~/.dsh/sessions/**/session.v4.jsonl.zstd)
// Library mode: const { generate, findSessionsDir } = require('./gen')
// CLI mode:     node src/gen.js [sessionId|"latest"] [-o out.html] [--source auto|openclaw|dsh] [--sessions-dir <dir>]
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

function home(){ return process.env.USERPROFILE || os.homedir(); }

/* ---------- OpenClaw session discovery ---------- */
function findSessionsDir(explicit){
  const cands = [];
  if (explicit) cands.push(explicit);
  if (process.env.OPENCLAW_SESSIONS) cands.push(process.env.OPENCLAW_SESSIONS);
  const h = home();
  cands.push(path.join(h, '.openclaw', 'agents', 'main', 'sessions'));
  cands.push(path.join(h, '.kimi_openclaw', 'agents', 'main', 'sessions'));
  for (const c of cands){ try { if (fs.statSync(c).isDirectory()) return c; } catch {} }
  throw new Error('OpenClaw session directory not found. Use --sessions-dir or set OPENCLAW_SESSIONS.');
}

function listOpenclawFiles(dir){
  if (!dir) return [];
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'))
      .map(f => ({ file: path.join(dir, f), sessionId: f.replace(/\.jsonl$/, ''), mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

/* ---------- DeepSeek Harness session discovery ---------- */
function findDshSessionsRoot(){
  const cands = [process.env.DSH_SESSIONS, path.join(home(), '.dsh', 'sessions')].filter(Boolean);
  for (const c of cands){ try { if (fs.statSync(c).isDirectory()) return c; } catch {} }
  return null;
}

function listDshFiles(root){
  if (!root) return [];
  const out = [];
  let workspaces = [];
  try { workspaces = fs.readdirSync(root); } catch { return out; }
  for (const ws of workspaces) {
    const wsDir = path.join(root, ws);
    let st; try { st = fs.statSync(wsDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const s of fs.readdirSync(wsDir)) {
      const f = path.join(wsDir, s, 'session.v4.jsonl.zstd');
      try { out.push({ file: f, sessionId: s.replace(/^session-/, ''), workspace: ws, mtime: fs.statSync(f).mtimeMs }); } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/* ---------- shared helpers ---------- */
function fmtTime(t) {
  try {
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const md = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5);
    const hm = d.toLocaleTimeString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }).slice(0, 5);
    return md + ' ' + hm;
  } catch { return ''; }
}

function stripEnvelope(t) {
  return String(t)
    .replace(/^\s*Sender \(untrusted metadata\)[^\n]*\n(?:```json[\s\S]*?```\s*\n?)?/i, '')
    .replace(/^\[\w{3} [^\]]*GMT[+-]?\d*\]\s*/i, '')
    .trim();
}

const EMOJI_RE = /(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}\u{2300}-\u{23FF}]|\u{FE0F}|\u{1F3FB}-\u{1F3FF})(?:\u{200D}(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2B00}-\u{2BFF}]|\u{FE0F}))*/gu;
function stripEmoji(t) {
  return String(t)
    .replace(EMOJI_RE, '')
    .replace(/\u{200D}/gu, '')
    .split('\n')
    .map(l => l.replace(/ {2,}/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const textOf = c => (Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text || '').join('\n') : (typeof c === 'string' ? c : ''));

function capText(text, nodes, role, time){
  if (!text) return null;
  if (text.length > 20000) text = text.slice(0, 20000) + '\n\n…[truncated]';
  const node = { id: nodes.length + 1, role, text, time, x: 0, y: 0, parents: [], gen: false };
  nodes.push(node);
  return node;
}

/* ---------- OpenClaw parser (jsonl with id/parentId) ---------- */
function parseOpenclawSession(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
  const nodes = [];
  let skippedTools = 0, skippedEmpty = 0, skippedSys = 0;
  const msgId2node = new Map();
  const byMsgId = new Map();   // jsonl message id → its parentId
  for (const ln of lines) {
    let j; try { j = JSON.parse(ln); } catch { continue; }
    if (j.type === 'compaction') {
      nodes.push({ id: nodes.length + 1, role: 'mark', text: '上下文压缩点（此前的对话已被压缩摘要）', time: fmtTime(j.timestamp), x: 0, y: 0, parents: [], mark: true, gen: false });
      continue;
    }
    if (j.type !== 'message' || !j.message) continue;
    const role = j.message.role;
    if (role !== 'user' && role !== 'assistant') continue;
    byMsgId.set(j.id, j.parentId || null);
    let text = textOf(j.message.content);
    const hasTool = Array.isArray(j.message.content)
      && j.message.content.some(b => b.type === 'toolCall' || b.type === 'tool_result');
    if (hasTool) { skippedTools++; continue; }
    if (role === 'user') text = stripEnvelope(text);
    text = stripEmoji(text).trim();
    if (role === 'user' && /^System:\s*\[\d{4}-\d{2}-\d{2}/.test(text)) { skippedSys++; continue; }
    if (!text) { skippedEmpty++; continue; }
    const n = capText(text, nodes, role, fmtTime(j.timestamp));
    if (n) msgId2node.set(j.id, n.id);
  }
  function nearestKeptAncestor(msgId) {
    let cur = byMsgId.get(msgId) || null, guard = 0;
    while (cur && guard++ < 1000) {
      const hit = msgId2node.get(cur);
      if (hit != null) return hit;
      cur = byMsgId.get(cur) || null;
    }
    return null;
  }
  // re-walk jsonl to know each kept node's own message id
  const keptIds = [];
  for (const ln of lines) {
    let j; try { j = JSON.parse(ln); } catch { continue; }
    if (j.type === 'message' && j.message && (j.message.role === 'user' || j.message.role === 'assistant') && msgId2node.has(j.id)) keptIds.push(j.id);
  }
  keptIds.forEach((msgId, i) => {
    const nodeId = msgId2node.get(msgId);
    const node = nodes.find(n => n.id === nodeId);
    let kept = nearestKeptAncestor(msgId);
    if (kept == null && i > 0) kept = msgId2node.get(keptIds[i - 1]) || null;  // time-order fallback
    if (kept != null) node.parents = [kept];
  });
  return { nodes, skippedTools, skippedEmpty, skippedSys };
}

/* ---------- DeepSeek Harness parser (zstd jsonl, seq-ordered) ---------- */
function parseDshSession(file) {
  let raw;
  try {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('zstd not available');
    raw = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
  } catch (e) {
    throw new Error('Cannot read DSH session (Node >= 22.15 required for zstd): ' + e.message);
  }
  const lines = raw.split('\n').filter(Boolean);
  const nodes = [];
  let skippedTools = 0, skippedEmpty = 0, skippedSys = 0;
  let prevId = null;
  for (const ln of lines) {
    let j; try { j = JSON.parse(ln); } catch { continue; }
    if (j.type !== 'user/message' && j.type !== 'assistant/message') continue;
    const time = fmtTime(j.time);
    if (j.type === 'user/message') {
      const kind = (j.data && j.data.source && j.data.source.kind) || '';
      if (kind !== 'user') { skippedSys++; continue; }          // runtime context / skill catalog / plugin injections
      const text = stripEmoji(stripEnvelope(textOf(j.data.content))).trim();
      if (!text) { skippedEmpty++; continue; }
      const n = capText(text, nodes, 'user', time);
      if (n) { n.parents = prevId != null ? [prevId] : []; prevId = n.id; }
      continue;
    }
    // assistant/message
    const blocks = (j.data && j.data.message && j.data.message.content) || [];
    if (blocks.some(b => b.type === 'tool-call' || b.type === 'tool_use')) { skippedTools++; continue; }
    const text = stripEmoji(blocks.filter(b => b.type === 'text').map(b => b.text || '').join('\n')).trim();
    if (!text) { skippedEmpty++; continue; }
    const n = capText(text, nodes, 'assistant', time);
    if (n) { n.parents = prevId != null ? [prevId] : []; prevId = n.id; }
  }
  return { nodes, skippedTools, skippedEmpty, skippedSys };
}

/* ---------- generate ---------- */
function defaultTemplatePath(){ return path.join(__dirname, 'template.html'); }
function defaultOutDir(){ return path.join(home(), 'convo-canvases'); }

function resolveTarget(opts){
  let source = opts.source || 'auto';
  const ocDir = (() => { try { return opts.sessionsDir || findSessionsDir(opts.sessionsDir); } catch { return null; } })();
  const dshRoot = findDshSessionsRoot();
  const ocFiles = listOpenclawFiles(ocDir);
  const dshFiles = listDshFiles(dshRoot);

  if (source === 'auto') {
    // Prefer DSH when it has sessions: this MCP server is normally called from
    // DeepSeek Harness, so "latest" should mean the DSH side, never silently
    // jumping to an OpenClaw session that merely has a newer mtime.
    if (!ocFiles.length && !dshFiles.length) throw new Error('No sessions found (OpenClaw: ' + (ocDir || 'n/a') + ', DSH: ' + (dshRoot || 'n/a') + ')');
    source = dshFiles.length ? 'dsh' : 'openclaw';
  }
  const pool = source === 'dsh' ? dshFiles : ocFiles;
  if (!pool.length) throw new Error('No ' + source + ' sessions found' + (source === 'dsh' ? ' in ' + (dshRoot || '~/.dsh/sessions') : ' in ' + (ocDir || 'n/a')));
  const arg = opts.session || 'latest';
  if (arg === 'latest') return { source, pool, index: 0, dshRoot, ocDir };
  const idx = pool.findIndex(f => f.sessionId === arg);
  const idx2 = idx >= 0 ? idx : pool.findIndex(f => f.sessionId.startsWith(arg));
  if (idx2 < 0) throw new Error('Session not found: ' + arg + ' (source: ' + source + ')');
  return { source, pool, index: idx2, dshRoot, ocDir };
}

function generate(opts = {}) {
  const { source, pool, index } = resolveTarget(opts);
  const parse = source === 'dsh' ? parseDshSession : parseOpenclawSession;
  let pick = pool[index];
  let parsed = parse(pick.file);
  // latest: skip empty/just-created sessions (0-byte files etc.), walk up to 10 back
  if ((opts.session || 'latest') === 'latest') {
    let i = index;
    while (parsed.nodes.length === 0 && i + 1 < pool.length && i - index < 10) {
      i++; pick = pool[i]; parsed = parse(pick.file);
    }
  }
  const { nodes } = parsed;
  const dateStr = new Date(pick.mtime).toISOString().slice(0, 10);
  const meta = {
    sessionId: pick.sessionId,
    source,
    workspace: pick.workspace ? pick.workspace.replace(/^--|--$/g, '') : undefined,
    messageCount: nodes.length,
    generatedAt: new Date().toISOString(),
    date: dateStr,
    title: dateStr.slice(5) + ' ' + pick.sessionId.slice(0, 8),
  };
  const template = fs.readFileSync(opts.templatePath || defaultTemplatePath(), 'utf8');
  const escT = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = template
    .replace('__TITLE__', escT(meta.title))
    .replace('__META__', JSON.stringify(meta).replace(/<\//g, '<\\/'))
    .replace('__NODES__', JSON.stringify(nodes).replace(/<\//g, '<\\/'));
  const outDir = opts.outDir || defaultOutDir();
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = opts.outPath || path.join(outDir, source + '_' + dateStr.replace(/-/g, '').slice(2) + '_' + pick.sessionId.slice(0, 8) + '.html');
  fs.writeFileSync(outPath, html, 'utf8');
  return {
    outPath, meta,
    kb: Math.round(fs.statSync(outPath).size / 1024),
    counts: {
      nodes: nodes.length,
      users: nodes.filter(n => n.role === 'user').length,
      assistant: nodes.filter(n => n.role === 'assistant').length,
      marks: nodes.filter(n => n.role === 'mark').length,
      branched: nodes.filter(n => n.parents && n.parents.length).length,
      skippedTools: parsed.skippedTools, skippedEmpty: parsed.skippedEmpty, skippedSys: parsed.skippedSys,
    },
  };
}

/* ---------- listing helpers (for MCP) ---------- */
function listSessions({ source = 'all', limit = 20 } = {}) {
  const out = { openclaw: [], dsh: [] };
  if (source === 'all' || source === 'openclaw') {
    let dir = null; try { dir = findSessionsDir(); } catch {}
    out.openclaw = listOpenclawFiles(dir).slice(0, limit).map(f => ({
      id: f.sessionId, modified: new Date(f.mtime).toISOString(), source: 'openclaw',
    }));
    out.openclawDir = dir;
  }
  if (source === 'all' || source === 'dsh') {
    const root = findDshSessionsRoot();
    out.dsh = listDshFiles(root).slice(0, limit).map(f => ({
      id: f.sessionId, modified: new Date(f.mtime).toISOString(), source: 'dsh',
      workspace: f.workspace.replace(/^--|--$/g, ''),
    }));
    out.dshDir = root;
  }
  return out;
}

module.exports = { generate, findSessionsDir, findDshSessionsRoot, listSessions, parseOpenclawSession, parseDshSession };

// CLI entry
if (require.main === module) {
  const args = process.argv.slice(2);
  let session = 'latest', outPath = null, sessionsDir = null, source = 'auto';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') outPath = args[++i];
    else if (args[i] === '--sessions-dir') sessionsDir = args[++i];
    else if (args[i] === '--source') source = args[++i];
    else session = args[i];
  }
  try {
    const r = generate({ session, outPath, sessionsDir, source });
    console.log(JSON.stringify({ ok: true, out: r.outPath, source: r.meta.sessionSource, ...r.counts, kb: r.kb }, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
}
