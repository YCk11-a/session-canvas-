// Smoke test: generate a canvas from the bundled fixture and check the artifact.
// Usage: npm test   (or: node test/smoke.js)
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'cli.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const OUT = path.join(os.tmpdir(), 'convo-canvas-smoke.html');

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

if (!fs.existsSync(CLI)) fail('bin/cli.js not found at ' + CLI);
if (!fs.existsSync(FIXTURES)) fail('test/fixtures not found');

const r = spawnSync(process.execPath, [
  CLI, 'sample-session', '--source', 'openclaw',
  '--sessions-dir', FIXTURES, '-o', OUT,
], { encoding: 'utf8', timeout: 60000 });

const out = (r.stdout || '') + (r.stderr || '');
if (r.status !== 0) fail('CLI exited ' + r.status + '\n' + out);
if (!/Nodes: 6/.test(out)) fail('expected 6 nodes, got:\n' + out);
if (!fs.existsSync(OUT)) fail('output html not written');

const html = fs.readFileSync(OUT, 'utf8');
const checks = {
  'nodes embedded': /const EMBED_NODES = \[\{"id":1/.test(html),
  'meta embedded': /const EMBED_META = \{/.test(html),
  'tree layout': html.includes('placeTree'),
  'manual links': html.includes('startLink'),
  'no unresolved placeholders': !html.includes('__NODES__') && !html.includes('__META__'),
};
let bad = 0;
for (const [k, v] of Object.entries(checks)) {
  console.log((v ? 'ok   ' : 'MISS ') + k);
  if (!v) bad++;
}
try { fs.unlinkSync(OUT); } catch {}
if (bad) fail(bad + ' template checks failed');
console.log('SMOKE OK — canvas generated from fixture (' + Math.round(html.length / 1024) + ' KB)');
