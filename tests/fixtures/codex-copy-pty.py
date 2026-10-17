"""Real Codex TUI fixture. Synthetic local Responses stream, private home and tmux.
Run the test in an isolated network namespace; this helper inherits that isolation.
Only JSON control frames/PTY bytes cross stdin/stdout. Never load ambient auth.
"""
import base64, fcntl, http.server, json, os, pathlib, pty, select, shlex, signal, struct, subprocess, sys, termios, threading, socket

if {name for _, name in socket.if_nameindex()} != {'lo'}:
    raise SystemExit('Real CLI fixture requires an isolated network namespace with only loopback')
binary, root_arg, setup, text_arg = sys.argv[1:]
root = pathlib.Path(root_arg)
home = root / 'home'; home.mkdir()
ch = home / 'codex'; ch.mkdir()
work = root / 'workspace'; work.mkdir()
text = text_arg

def emit(value):
    print(json.dumps(value), flush=True)

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass
    def do_GET(self):
        self.send_response(404); self.end_headers()
    def do_POST(self):
        # Content is only the synthetic test prompt; never forward any request.
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if self.headers.get('Authorization'):
            raise RuntimeError('Local fixture must not receive authentication credentials')
        if self.path != '/v1/responses':
            self.send_response(404); self.end_headers(); return
        item = {'id': 'msg_fixture', 'type': 'message', 'role': 'assistant', 'status': 'completed',
                'content': [{'type': 'output_text', 'text': text, 'annotations': []}]}
        response = {'id': 'resp_fixture', 'object': 'response', 'created_at': 1, 'status': 'completed',
                    'model': 'gpt-5.4', 'output': [item], 'usage': {'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}
        events = [
            ('response.created', {'response': {**response, 'status': 'in_progress', 'output': []}}),
            ('response.output_item.added', {'output_index': 0, 'item': {**item, 'status': 'in_progress', 'content': []}}),
            ('response.content_part.added', {'item_id': 'msg_fixture', 'output_index': 0, 'content_index': 0,
                                            'part': {'type': 'output_text', 'text': '', 'annotations': []}}),
            ('response.output_text.delta', {'item_id': 'msg_fixture', 'output_index': 0, 'content_index': 0, 'delta': text}),
            ('response.output_text.done', {'item_id': 'msg_fixture', 'output_index': 0, 'content_index': 0, 'text': text}),
            ('response.output_item.done', {'output_index': 0, 'item': item}),
            ('response.completed', {'response': response}),
        ]
        self.send_response(200); self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
        for name, payload in events:
            self.wfile.write(('event: ' + name + '\ndata: ' + json.dumps({'type': name, **payload}) + '\n\n').encode())
            self.wfile.flush()
        emit({'type': 'response'})

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
(ch / 'config.toml').write_text(f'''model_provider="fixture"
model="gpt-5.4"
approval_policy="never"
sandbox_mode="read-only"
check_for_update_on_startup=false
web_search="disabled"
[model_providers.fixture]
name="Isolated local test fixture"
base_url="http://127.0.0.1:{server.server_port}/v1"
wire_api="responses"
requires_openai_auth=false
supports_websockets=false
[projects."{work}"]
trust_level="trusted"
''')
# Exact allowlist: no user configuration, API keys, token helpers or host daemon.
env = {'HOME': str(home), 'CODEX_HOME': str(ch), 'PATH': '/usr/bin:/bin', 'TERM': 'xterm-256color',
       'LANG': 'C.UTF-8', 'NO_PROXY': '127.0.0.1,localhost', 'TMUX_TMPDIR': str(root)}
if os.environ.get('AGENTOR_COPY_FIXTURE_DISPLAY'):
    env['DISPLAY'] = os.environ['AGENTOR_COPY_FIXTURE_DISPLAY']
    if os.environ.get('AGENTOR_COPY_FIXTURE_X11_LIBS'):
        env['LD_LIBRARY_PATH'] = os.environ['AGENTOR_COPY_FIXTURE_X11_LIBS']

def tmux(*args):
    return subprocess.run(['tmux', *args], env=env, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

def terminate(_signal, _frame):
    raise SystemExit(0)
signal.signal(signal.SIGTERM, terminate)
master = None
process = None
try:
    version = subprocess.check_output([binary, '--version'], env=env, text=True, stderr=subprocess.PIPE).strip()
    command = shlex.join([binary, '--no-daemon', '--no-alt-screen', '-C', str(work), 'Produce the fixture response.'])
    tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'main', command)
    subprocess.run(['sh', '-ec', setup + 'true'], env=env, check=True)
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
    process = subprocess.Popen(['tmux', 'attach-session', '-t', 'main'], stdin=slave, stdout=slave, stderr=slave,
                               env=env, start_new_session=True,
                               preexec_fn=lambda: fcntl.ioctl(slave, termios.TIOCSCTTY, 0))
    os.close(slave)
    emit({'type': 'ready', 'version': version, 'display': bool(env.get('DISPLAY'))})
    pending = b''
    while process.poll() is None:
        readable, _, _ = select.select([master, 0], [], [], .1)
        if master in readable:
            try:
                chunk = os.read(master, 65536)
            except OSError:
                break
            if not chunk:
                break
            emit({'type': 'output', 'data': base64.b64encode(chunk).decode()})
        if 0 in readable:
            chunk = os.read(0, 65536)
            if not chunk:
                break
            pending += chunk
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                message = json.loads(line)
                if message['type'] == 'input':
                    os.write(master, base64.b64decode(message['data']))
                elif message['type'] == 'resize':
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', message['rows'], message['cols'], 0, 0))
                elif message['type'] == 'clipboard':
                    # Optional independent proof that native X11 copying also succeeded.
                    result = subprocess.run([os.environ['AGENTOR_COPY_FIXTURE_XCLIP'], '-selection', 'clipboard', '-o'],
                                            env=env, capture_output=True, timeout=3)
                    emit({'type': 'clipboard', 'data': base64.b64encode(result.stdout).decode(), 'status': result.returncode})
finally:
    subprocess.run(['tmux', 'kill-server'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if process:
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL); process.wait()
    if master is not None:
        os.close(master)
    server.shutdown()
