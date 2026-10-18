import { test, expect } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installTerminalClipboard, MAX_TERMINAL_COPY_BYTES } from '../../orchestrator/app/composables/terminalClipboard';
import { TMUX_TERMINAL_CLIPBOARD_SETUP } from '../../orchestrator/server/utils/tmux-terminal-clipboard';

function makeFixture() {
  let handler: (data: string) => boolean = () => false;
  const requested: string[] = [], errors: string[] = [];
  const registration = installTerminalClipboard({ parser: { registerOscHandler(id: number, fn: typeof handler) { expect(id).toBe(52); handler = fn; return { dispose() {} }; } } } as any, text => requested.push(text), message => errors.push(message));
  return { requested, errors, registration, receive: (payload: string) => handler(payload) };
}

test('OSC 52 decodes bounded long multiline UTF-8 requests without copying automatically', () => {
  const fixture = makeFixture();
  const text = 'long response\n漢字 é 😀 '.repeat(3000);
  expect(fixture.receive('c;' + Buffer.from(text).toString('base64'))).toBe(true);
  expect(fixture.requested).toEqual([text]);
  expect(fixture.errors).toEqual([]);
});

test('OSC 52 ignores clipboard queries and unsupported selections and rejects malformed/oversized data', () => {
  const fixture = makeFixture();
  for (const payload of ['c;?', ';?', 'p;aGVsbG8=']) fixture.receive(payload);
  expect(fixture.requested).toEqual([]);
  expect(fixture.errors).toEqual([]);
  for (const payload of ['missing-separator', 'c;', 'c;not base64', 'c;/w==', 'c;' + Buffer.alloc(MAX_TERMINAL_COPY_BYTES + 1).toString('base64')]) fixture.receive(payload);
  expect(fixture.requested).toEqual([]);
  expect(fixture.errors).toHaveLength(5);
  expect(fixture.errors.join(' ')).not.toContain('not base64');
});

test('real linked tmux forwards wrapped clipboard requests and attachment setup stays idempotent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-copy-tmux-'));
  try {
    const script = String.raw`
import base64,os,pty,select,subprocess,sys,time
root,setup=sys.argv[1:]
env=dict(os.environ,TMUX_TMPDIR=root,TERM='xterm-256color')
env.pop('TMUX',None)
def tmux(*args): return subprocess.run(['tmux',*args],env=env,check=True,stdout=subprocess.PIPE).stdout
pid=None
try:
 tmux('-f','/dev/null','new-session','-d','-s','main','bash --noprofile --norc')
 subprocess.run(['sh','-ec',setup+'true'],env=env,check=True)
 before=tmux('show-option','-sv','terminal-features')
 subprocess.run(['sh','-ec',setup+'true'],env=env,check=True)
 assert before==tmux('show-option','-sv','terminal-features')
 tmux('new-session','-d','-t','=main','-s','web')
 pid,fd=pty.fork()
 if pid==0: os.execvpe('tmux',['tmux','attach-session','-t','web'],env)
 time.sleep(.2)
 text='known tmux response\nmultiline é'
 command=r"printf '\033Ptmux;\033\033]52;c;%s\007\033\\' '"+base64.b64encode(text.encode()).decode()+"'"
 tmux('send-keys','-t','main','-l',command)
 tmux('send-keys','-t','main','Enter')
 output=b'';deadline=time.monotonic()+3
 while time.monotonic()<deadline:
  if select.select([fd],[],[],.1)[0]: output+=os.read(fd,65536)
  if b'\x1b]52;' in output: break
 assert b'\x1b]52;' in output,repr(output)
 print('clipboard-forwarded-and-idempotent')
finally:
 subprocess.run(['tmux','kill-server'],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 if pid:
  try: os.waitpid(pid,0)
  except ChildProcessError: pass
`;
    const result = spawnSync('python3', ['-c', script, dir, TMUX_TERMINAL_CLIPBOARD_SETUP], { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(result.stdout).toContain('clipboard-forwarded-and-idempotent');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
