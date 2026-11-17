#!/usr/bin/env node
// convo-canvas CLI — export a chat session to a self-contained canvas HTML
// Usage: convo-canvas [sessionId|"latest"] [-o out.html] [--source auto|openclaw|dsh] [--sessions-dir <dir>]
const { generate } = require('../src/gen.js');
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
  console.log('Canvas written: ' + r.outPath);
  console.log('Source: ' + r.meta.source + ' | Nodes: ' + r.counts.nodes +
    ' (' + r.counts.users + ' user / ' + r.counts.assistant + ' assistant / ' + r.counts.marks + ' marks), ' + r.kb + ' KB');
  console.log('Open it directly in a browser (double-click, or file://). Zero dependencies.');
} catch (e) {
  console.error('Failed: ' + e.message);
  process.exit(1);
}
