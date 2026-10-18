// EXPECTED and REPLACEMENT are supplied over stdin by the operator wrapper.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
(async () => {
  const endpoints = await (await fetch('http://127.0.0.1:9229/json/list')).json();
  assert.equal(endpoints.length, 1, 'Expected one explicit main-process inspector');
  const endpoint = new URL(endpoints[0].webSocketDebuggerUrl);
  assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname), 'Inspector must be loopback only');
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0, breakpoint, isPaused = false;
  const pending = new Map(), scripts = [], events = [], waiters = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.id) { const p = pending.get(message.id); if (!p) return; pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); }
    else if (message.method === 'Debugger.scriptParsed') scripts.push(message.params);
    else if (message.method === 'Debugger.paused') { isPaused = true; const waiter = waiters.shift(); waiter ? waiter(message.params) : events.push(message.params); }
    else if (message.method === 'Debugger.resumed') isPaused = false;
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const request = ++id;
    const timer = setTimeout(() => { pending.delete(request); reject(new Error(`Inspector command timeout: ${method}`)); }, 15000);
    pending.set(request, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id: request, method, params }));
  });
  const waitPaused = () => events.length ? Promise.resolve(events.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No verifier function-entry breakpoint within 15 seconds')), 15000);
    waiters.push(value => { clearTimeout(timer); resolve(value); });
  });
  try {
    await send('Runtime.enable'); await send('Debugger.enable');
    const pid = (await send('Runtime.evaluate', { expression: 'process.pid', returnByValue: true })).result.value;
    let script, source;
    for (const candidate of scripts.filter(s => s.url.endsWith('/chunks/nitro/nitro.mjs'))) {
      const text = (await send('Debugger.getScriptSource', { scriptId: candidate.scriptId })).scriptSource;
      if (text.includes(EXPECTED)) { assert.ok(!script, 'Ambiguous verifier script'); script = candidate; source = text; }
    }
    assert.ok(script, 'Exact original verifier source not found; no mutation performed');
    const functionStart = source.indexOf(EXPECTED);
    assert.equal(source.indexOf(EXPECTED, functionStart + 1), -1, 'Original function must occur once');
    const lineNumber = source.slice(0, functionStart).split('\n').length;
    breakpoint = (await send('Debugger.setBreakpoint', { location: { scriptId: script.scriptId, lineNumber } })).breakpointId;
    const pause = await waitPaused();
    const frame = pause.callFrames.find(f => f.functionName === 'assertTreeEntry' && f.location.scriptId === script.scriptId);
    assert.ok(frame, 'Expected verifier function-entry frame');
    const evaluate = async expression => {
      const result = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression, returnByValue: true });
      assert.ok(!result.exceptionDetails, 'Verifier expression raised an exception'); return result.result.value;
    };
    const before = await evaluate('assertTreeEntry.toString()');
    assert.equal(before, EXPECTED.trim(), 'Live function differs; no mutation performed');
    const entriesAtSwap = await evaluate('tree.size');
    const replacement = await send('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId, expression: `assertTreeEntry = ${REPLACEMENT}`, returnByValue: false });
    assert.ok(!replacement.exceptionDetails, 'Function replacement failed');
    const after = await evaluate('assertTreeEntry.toString()');
    assert.ok(after.startsWith('function assertTreeEntryLinear('), 'Unexpected replacement implementation');
    assert.equal(await evaluate('process.pid'), pid, 'Main process changed');
    await send('Debugger.removeBreakpoint', { breakpointId: breakpoint }); breakpoint = undefined;
    await send('Debugger.resume'); isPaused = false;
    await send('Debugger.disable');
    console.log(JSON.stringify({ status: 'applied', mainContainerPid: pid, entriesAtSwap, originalFunctionSha256: digest(before), replacementFunctionSha256: digest(after), timestamp: new Date().toISOString(), restart: false, integrityChecksRemoved: false }));
  } finally {
    if (breakpoint) await send('Debugger.removeBreakpoint', { breakpointId: breakpoint }).catch(() => {});
    if (isPaused) await send('Debugger.resume').catch(() => {});
    await send('Debugger.disable').catch(() => {});
    socket.close();
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
