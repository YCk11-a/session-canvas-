// mcp.js — convo-canvas as an MCP server (stdio transport)
// Tools: list_sessions / generate_canvas / canvas_status
// Works with any MCP-capable client (DeepSeek Harness, Cherry Studio, Claude Desktop, Cursor, ...)
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { generate, findSessionsDir, listSessions } = require('../src/gen.js');

const BASE_PORT = +(process.env.CONVO_CANVAS_PORT || 8791);
let sessionsDir = null;
try { sessionsDir = findSessionsDir(process.env.OPENCLAW_SESSIONS); } catch {}
const OUT_DIR = process.env.CONVO_CANVAS_OUT || path.join(require('os').homedir(), 'convo-canvases');
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------- tiny static server for generated canvases ---------- */
let httpServer = null, httpPort = null;
function ensureHttpServer() {
  if (httpServer) return httpServer;
  httpServer = http.createServer((q, s) => {
    const url = decodeURIComponent(q.url.split('?')[0]);
    if (url === '/' || url === '/index.html') {
      const items = fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.html'))
        .map(f => ({ f, t: fs.statSync(path.join(OUT_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      s.end('<!DOCTYPE html><meta charset="utf-8"><title>Convo Canvas</title>' +
        '<body style="background:#12141a;color:#d7dae0;font-family:system-ui;padding:40px">' +
        '<h2>Convo Canvas</h2><p>' + items.length + ' canvas(es)</p>' +
        items.map(x => '<p><a style="color:#6ea8fe" href="/' + encodeURIComponent(x.f) + '">' + x.f + '</a> ' +
          '<span style="color:#666;font-size:12px">' + new Date(x.t).toLocaleString() + '</span></p>').join('') +
        '</body>');
      return;
    }
    const safe = url.replace(/^\//, '').replace(/[\\/]/g, '');
    try {
      const b = fs.readFileSync(path.join(OUT_DIR, safe));
      s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      s.end(b);
    } catch { s.writeHead(404); s.end('404'); }
  });
  // Port walk: if 8791 is taken (e.g. another viewer running), try the next port.
  let port = BASE_PORT;
  httpServer.on('error', e => {
    if (e.code === 'EADDRINUSE' && port < BASE_PORT + 20) {
      port++;
      httpServer.listen(port, '127.0.0.1');
    }
  });
  httpServer.on('listening', () => { httpPort = port; });
  httpServer.listen(port, '127.0.0.1');
  return httpServer;
}
function viewerUrl() { return 'http://localhost:' + (httpPort || BASE_PORT) + '/'; }

/* ---------- MCP server ---------- */
const server = new Server(
  { name: 'convo-canvas', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_sessions',
      description: 'List recent chat sessions available for canvas export, from both OpenClaw and DeepSeek Harness (~/.dsh/sessions). Most recent first.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max sessions per source (default 20)' },
          source: { type: 'string', enum: ['all', 'openclaw', 'dsh'], description: 'Which source to list (default all)' },
        },
      },
    },
    {
      name: 'generate_canvas',
      description: 'Export a chat session into a self-contained interactive canvas HTML (semantic zoom, minimap, search, merge & branch with any LLM). Returns a local URL. Use source="dsh" for DeepSeek Harness sessions, source="openclaw" for OpenClaw sessions, or "auto" (default) prefers DeepSeek Harness sessions when present, else OpenClaw.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Session id (or prefix), or "latest" (default)' },
          source: { type: 'string', enum: ['auto', 'openclaw', 'dsh'], description: 'Session source (default auto)' },
          open: { type: 'boolean', description: 'Also start the local viewer server and return http URL (default true)' },
        },
      },
    },
    {
      name: 'canvas_status',
      description: 'Check the local canvas viewer: running state, URL, and generated canvases.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'list_sessions') {
      const r = listSessions({ source: args.source || 'all', limit: args.limit || 20 });
      return { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }] };
    }
    if (name === 'generate_canvas') {
      const r = generate({ session: args.session_id || 'latest', source: args.source || 'auto', outDir: OUT_DIR });
      let url = 'file:///' + r.outPath.replace(/\\/g, '/');
      if (args.open !== false) {
        ensureHttpServer();
        await new Promise(r2 => setTimeout(r2, 400)); // let port resolve
        url = viewerUrl() + encodeURIComponent(path.basename(r.outPath));
      }
      return { content: [{ type: 'text', text: JSON.stringify({
        url, file: r.outPath, nodes: r.counts.nodes, kb: r.kb,
        note: 'Open the URL in a browser. Canvas LLM calls are configured inside the page (⚙ API settings) — keys stay in your browser.',
      }, null, 2) }] };
    }
    if (name === 'canvas_status') {
      return { content: [{ type: 'text', text: JSON.stringify({
        viewer_running: !!httpServer,
        viewer_url: httpServer ? viewerUrl() : null,
        out_dir: OUT_DIR,
        canvases: fs.readdirSync(OUT_DIR).filter(f => f.endsWith('.html')),
      }, null, 2) }] };
    }
    return { content: [{ type: 'text', text: 'Unknown tool: ' + name }], isError: true };
  } catch (e) {
    return { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('convo-canvas MCP server running on stdio');
}
main().catch(e => { console.error(e); process.exit(1); });
