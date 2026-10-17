const fs = require('node:fs');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const original = fs.readFileSync(`${__dirname}/original-function.js`, 'utf8');
const replacement = fs.readFileSync(`${__dirname}/replacement-expression.js`, 'utf8');
const subject = `${original}\nconst tree = new Map(); let accepted = 0;
globalThis.liveAudit = () => ({ pid: process.pid, accepted, implementation: assertTreeEntry.name });
setInterval(() => { for (let i = 0; i < 100; i++) { const name = 'root/file' + accepted;
assertTreeEntry(tree, name, 'file'); tree.set(name, 'file'); accepted++; } }, 5);`;
const child = spawn(process.execPath, ['--inspect=127.0.0.1:0', '--input-type=module', '-e', subject], { stdio: ['ignore', 'pipe', 'pipe'] });
const timeout = setTimeout(() => { child.kill(); console.error('Inspector test timed out'); process.exit(1); }, 15000);
const endpoint = new Promise((resolve, reject) => {
  child.stderr.on('data', data => { const match = data.toString().match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/); if (match) resolve(match[0]); });
  child.on('error', reject);
});
(async () => {
  const socket = new WebSocket(await endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map(), eventQueue = [], waiters = [], scripts = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); }
    else if (message.method === 'Debugger.paused') { const waiter = waiters.shift(); waiter ? waiter(message.params) : eventQueue.push(message.params); }
    else if (message.method === 'Debugger.scriptParsed') scripts.push(message.params);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const request = ++id; pending.set(request, { resolve, reject }); socket.send(JSON.stringify({ id: request, method, params })); });
  const paused = () => eventQueue.length ? Promise.resolve(eventQueue.shift()) : new Promise(resolve => waiters.push(resolve));
  await send('Runtime.enable'); await send('Debugger.enable');
  await new Promise(resolve => setTimeout(resolve, 100));
  const before = (await send('Runtime.evaluate', { expression: 'liveAudit()', returnByValue: true })).result.value;
  let script;
  for (const candidate of scripts.filter(s => s.url.endsWith('[eval1]'))) {
    const source = await send('Debugger.getScriptSource', { scriptId: candidate.scriptId });
    if (source.scriptSource.startsWith(original)) { script = candidate; break; }
  }
  assert.ok(script, 'Expected exact test module source');
  const breakpoint = await send('Debugger.setBreakpoint', { location: { scriptId: script.scriptId, lineNumber: 1 } });
  const pause = await paused();
  let frame;
  for (const f of pause.callFrames) {
    const test = await send('Debugger.evaluateOnCallFrame', { callFrameId: f.callFrameId, expression: 'typeof assertTreeEntry', returnByValue: true });
    if (test.result.value === 'function') { frame = f; break; }
  }
  assert.ok(frame, 'Expected module function lexical binding');
  const old = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: 'assertTreeEntry.toString()', returnByValue: true });
  assert.equal(old.result.value, original.trim());
  const changed = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: `assertTreeEntry = ${replacement}`, returnByValue: false });
  assert.ok(!changed.exceptionDetails, JSON.stringify(changed.exceptionDetails));
  await send('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId });
  await send('Debugger.resume');
  await new Promise(resolve => setTimeout(resolve, 100));
  const after = (await send('Runtime.evaluate', { expression: 'liveAudit()', returnByValue: true })).result.value;
  assert.equal(after.pid, before.pid); assert.equal(after.implementation, 'assertTreeEntryLinear'); assert.ok(after.accepted > before.accepted);
  console.log(JSON.stringify({ status: 'passed', originalPid: before.pid, resumedPid: after.pid, acceptedBefore: before.accepted, acceptedAfter: after.accepted, lexicalFrame: frame.functionName }));
  await send('Debugger.disable'); socket.close(); child.kill(); clearTimeout(timeout);
})().catch(error => { console.error(error); child.kill(); clearTimeout(timeout); process.exitCode = 1; });
