#!/usr/bin/env node
// Operator-only, packaged beside the already compiled native adapter. No
// credentials in arguments/environment, arbitrary Incus authority, or migration.
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const MAC = /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i;
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const requireFact = (value, code) => { if (!value) throw new Error(code); };

// One fixed guest-only probe, not a packet service or host networking API.
// AF_PACKET observes admission before IP martian checks/replies. The socket
// never logs unrelated bytes and expires independently of the controller.
export const CANARY_PACKET_SCRIPT = String.raw`
import json,os,select,socket,struct,sys,time
mode,spec=sys.argv[1],json.loads(sys.argv[2]);nonce=spec['nonce'];cases={c['label']:c for c in spec['cases']}
prefix=('agentor-incus-canary:'+nonce+':').encode();port=39009
def mac(s):return bytes.fromhex(s.replace(':',''))
def checksum(b):
 if len(b)%2:b+=b'\0'
 s=sum(struct.unpack('!'+str(len(b)//2)+'H',b))
 while s>>16:s=(s&65535)+(s>>16)
 return (~s)&65535
def frame(c):
 family=socket.AF_INET6 if c['family']==6 else socket.AF_INET
 source=socket.inet_pton(family,c['source']);target=socket.inet_pton(family,c['target']);body=prefix+c['label'].encode()
 udp=struct.pack('!HHHH',39010,port,8+len(body),0)+body
 if c['family']==6:
  pseudo=source+target+struct.pack('!I3xB',len(udp),17)
  udp=udp[:6]+struct.pack('!H',checksum(pseudo+udp) or 65535)+udp[8:]
  ip=struct.pack('!IHBB16s16s',6<<28,len(udp),17,64,source,target);ether=0x86dd
 else:
  ip=struct.pack('!BBHHHBBH4s4s',69,0,20+len(udp),1,0,64,17,0,source,target)
  ip=ip[:10]+struct.pack('!H',checksum(ip))+ip[12:];ether=0x0800
 return mac(spec['destinationMac'])+mac(c['mac'])+struct.pack('!H',ether)+ip+udp
def label(data):
 if len(data)<14 or data[:6]!=mac(spec['destinationMac']):return None
 ether=struct.unpack('!H',data[12:14])[0]
 if ether==0x0800 and len(data)>=42 and data[14]==69 and data[23]==17:
  family=4;offset=34;source=socket.inet_ntop(socket.AF_INET,data[26:30]);target=socket.inet_ntop(socket.AF_INET,data[30:34])
 elif ether==0x86dd and len(data)>=62 and data[14]>>4==6 and data[20]==17:
  family=6;offset=54;source=socket.inet_ntop(socket.AF_INET6,data[22:38]);target=socket.inet_ntop(socket.AF_INET6,data[38:54])
 else:return None
 if struct.unpack('!H',data[offset+2:offset+4])[0]!=port:return None
 body=data[offset+8:];length=struct.unpack('!H',data[offset+4:offset+6])[0]
 body=body[:length-8]
 if not body.startswith(prefix):return None
 name=body[len(prefix):].decode(errors='replace');c=cases.get(name)
 if not c or c['family']!=family or mac(c['mac'])!=data[6:12]:return None
 af=socket.AF_INET6 if family==6 else socket.AF_INET
 if socket.inet_pton(af,c['source'])!=socket.inet_pton(af,source) or socket.inet_pton(af,c['target'])!=socket.inet_pton(af,target):return None
 return name
if mode=='selftest':
 print(json.dumps([label(frame(c)) for c in cases.values()]));sys.exit(0)
if mode=='send':
 s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW);s.bind(('eth0',0))
 try:
  packet=frame(cases[sys.argv[3]])
  for _ in range(4):s.send(packet);time.sleep(.05)
 finally:s.close()
 sys.exit(0)
if mode!='observe':raise ValueError('Fixed canary mode required')
s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(3));s.bind(('eth0',0));seen=set();deadline=time.monotonic()+60
try:
 print(json.dumps({'type':'ready','nonce':nonce}),flush=True)
 while time.monotonic()<deadline:
  ready,_,_=select.select([s,sys.stdin],[],[],.1)
  if sys.stdin in ready:
   if os.read(0,64)!=b'finish\n':raise ValueError('Unsettled observer input')
   print(json.dumps({'type':'result','nonce':nonce,'seen':sorted(seen)}),flush=True);sys.exit(0)
  if s in ready:
   data,address=s.recvfrom(65536)
   if address[2]==4:continue
   name=label(data)
   if name and name not in seen:
    seen.add(name);print(json.dumps({'type':'seen','nonce':nonce,'label':name}),flush=True)
 raise TimeoutError('Canary observer expired')
finally:s.close()
`;

export function validateCanaryInput(input) {
  requireFact(input && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).every(key => ['sessionCookie', 'dockerEnabled'].includes(key)), 'INVALID_INPUT');
  requireFact(typeof input.sessionCookie === 'string' && input.sessionCookie.length > 0 && input.sessionCookie.length <= 8192 &&
    !/[\x00-\x1f\x7f]/.test(input.sessionCookie), 'INVALID_SESSION');
  requireFact(input.dockerEnabled === undefined || typeof input.dockerEnabled === 'boolean', 'INVALID_CAPABILITY');
  return { sessionCookie: input.sessionCookie, dockerEnabled: input.dockerEnabled === true };
}

export function canaryApiHeaders(authUrl, cookie) {
  const publicUrl = new URL(authUrl || 'http://127.0.0.1:3000');
  requireFact(['http:', 'https:'].includes(publicUrl.protocol) && !publicUrl.username && !publicUrl.password, 'INVALID_PUBLIC_ORIGIN');
  // Connect locally but preserve the configured public Host/Origin pair; the
  // existing relay deliberately compares Origin to Host, not socket address.
  return { Host: publicUrl.host, Origin: publicUrl.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) };
}

async function productionDependencies(signal) {
  const adapterUrl = new URL('./instance-restore-native/index.mjs', import.meta.url);
  const adapter = await import(adapterUrl.href), config = adapter.loadConfig();
  const runtime = new adapter.IncusWorkerRuntime(config), client = runtime.client;
  const installation = await adapter.readBackupInstallationId(config.dataDir);
  const WebSocket = createRequire(adapterUrl)('ws');
  const request = async (path, body, method, cookie) => {
    const response = await fetch('http://127.0.0.1:3000' + path, { method, redirect: 'manual',
      headers: canaryApiHeaders(config.betterAuthUrl, cookie),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(330_000)]) });
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body ?? []) { bytes += chunk.length; requireFact(bytes <= 1024 * 1024, 'RESPONSE_LIMIT'); chunks.push(chunk); }
    const text = Buffer.concat(chunks).toString();
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text };
  };
  const rfb = (id, cookie) => new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket('ws://127.0.0.1:3000/ws/desktop/' + id, { headers: canaryApiHeaders(config.betterAuthUrl, cookie) });
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', cancel); socket.terminate(); error ? reject(error) : resolve(value); };
    const cancel = () => finish(new Error('CANCELLED'));
    const timer = setTimeout(() => finish(new Error('RFB_TIMEOUT')), 15_000);
    signal.addEventListener('abort', cancel, { once: true });
    socket.once('message', bytes => finish(undefined, bytes.toString()));
    socket.once('error', () => finish(new Error('RFB_FAILED')));
    socket.once('close', () => finish(new Error('RFB_CLOSED')));
  });
  return { config, installation, client, request, rfb,
    primary: owner => runtime.resolvePrimaryAddress(owner), close: () => client.dispose() };
}

export async function runIncusCanary(rawInput, dependencies, signal = new AbortController().signal) {
  const nonce = randomUUID(), workers = [], environments = [];
  let stage = 'input', deps, owner;
  const retained = () => ({ nonce, environments: environments.map(item => item.id),
    workers: workers.map(item => ({ id: item.id, ...(item.uuid ? { incarnation: item.uuid } : {}) })) });
  try {
    const input = validateCanaryInput(rawInput);
    deps = dependencies ?? await productionDependencies(signal);
    requireFact(deps.config.incusEnabled && deps.config.incusEndpoint.startsWith('https://') &&
      /^[A-Za-z0-9_-]{1,63}$/.test(deps.config.incusProject) && deps.config.incusProject !== 'default' && UUID.test(deps.installation), 'PLATFORM_NOT_ENABLED');
    const api = async (path, body, method = body === undefined ? 'GET' : 'POST', authenticated = true) => {
      signal.throwIfAborted(); return deps.request(path, body, method, authenticated ? input.sessionCookie : undefined);
    };
    const admin = async () => {
      const result = await api('/api/auth/get-session');
      requireFact(result.status === 200 && result.body?.user?.role === 'admin' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(result.body.user.id) && result.body.session?.userId === result.body.user.id &&
        Date.parse(result.body.session.expiresAt) > Date.now(), 'ADMIN_SESSION_REQUIRED');
      requireFact(!owner || owner === result.body.user.id, 'ADMIN_IDENTITY_CHANGED'); owner = result.body.user.id;
    };
    stage = 'auth'; await admin();
    stage = 'readiness'; requireFact((await deps.client.getReadiness()).ready, 'INCUS_NOT_READY');
    const project = await deps.client.request('GET', '/1.0/projects/' + encodeURIComponent(deps.config.incusProject));
    requireFact(project.config?.restricted === 'true' && project.config['restricted.devices.nic'] === 'managed' &&
      project.config['restricted.networks.access']?.split(',').includes(deps.config.incusNetwork), 'RESTRICTED_PROJECT_REQUIRED');
    const gateway = new URL(deps.config.incusInternalGatewayUrl);
    requireFact(gateway.protocol === 'http:' && isIP(gateway.hostname) === 4 && gateway.port &&
      !gateway.username && !gateway.password && gateway.pathname === '/' && !gateway.search && !gateway.hash, 'INTERNAL_ENDPOINT_REQUIRED');
    const fence = async worker => {
      await admin();
      const listed = await api('/api/containers');
      requireFact(listed.status === 200 && Array.isArray(listed.body), 'RECORD_LOOKUP_FAILED');
      const current = listed.body.find(item => item.id === worker.id);
      requireFact(current?.userId === owner && current.runtimeKind === 'incus-vm' && current.containerName === worker.name &&
        current.containerId === 'incus:' + worker.uuid && current.environmentId === worker.environmentId, 'WORKER_RECORD_CHANGED');
      const instance = await deps.client.getInstance(worker.name);
      requireFact(instance.type === 'virtual-machine' && instance.config['volatile.uuid'] === worker.uuid &&
        instance.config['user.agentor.installation'] === deps.installation && instance.config['user.agentor.id'] === worker.id &&
        instance.config['user.agentor.owner'] === owner, 'WORKER_INCARNATION_CHANGED');
      return instance;
    };
    const checked = async (worker, command, seconds = 40) => {
      await fence(worker); signal.throwIfAborted();
      const result = await deps.client.exec(worker.name, ['timeout', '-k', '2s', String(seconds) + 's', 'bash', '-ec', command], { user: 0, group: 0 });
      signal.throwIfAborted(); await fence(worker); requireFact(result.returnCode === 0, 'GUEST_PROBE_FAILED'); return result.stdout.trim();
    };
    const create = async dockerEnabled => {
      await admin();
      let env = environments.find(item => item.dockerEnabled === dockerEnabled);
      if (!env) {
        const created = await api('/api/environments', { name: 'Incus canary ' + nonce, dockerEnabled,
          networkMode: 'full', cpuLimit: 1, memoryLimit: '1024m' });
        if (created.status === 201 && UUID.test(created.body?.id ?? '')) {
          env = { id: created.body.id, createdAt: created.body.createdAt, dockerEnabled }; environments.push(env);
        }
        requireFact(created.status === 201 && env && created.body.userId === owner && !created.body.builtIn, 'ENVIRONMENT_CREATE_UNACKNOWLEDGED');
      }
      const created = await api('/api/containers', { displayName: 'Incus canary ' + nonce, environmentId: env.id, workerSelfApiAccess: 'allow' });
      const value = created.body;
      const worker = { id: value?.id, name: value?.containerName, environmentId: env.id, uuid: value?.containerId?.startsWith('incus:') ? value.containerId.slice(6) : undefined };
      if (created.status === 201 && UUID.test(worker.id ?? '')) workers.push(worker);
      requireFact(created.status === 201 && value?.runtimeKind === 'incus-vm' && value.userId === owner && UUID.test(worker.uuid ?? '') &&
        worker.name === deps.config.containerPrefix + '-' + worker.id, 'WORKER_CREATE_UNACKNOWLEDGED');
      const vm = await fence(worker); const nic = vm.devices.eth0;
      requireFact(nic?.network === deps.config.incusNetwork && nic.name === 'eth0' &&
        ['security.ipv4_filtering', 'security.ipv6_filtering', 'security.mac_filtering'].every(key => nic[key] === 'true'), 'NIC_FILTERING_REQUIRED');
      return worker;
    };
    stage = 'create'; const victim = await create(input.dockerEnabled), attacker = await create(false);
    for (const worker of input.dockerEnabled ? [attacker] : [victim, attacker])
      await checked(worker, 'if systemctl is-active --quiet docker.service; then exit 1; fi');
    const self = async worker => {
      const deadline = Date.now() + 30_000;
      while (true) {
        try {
          const value = JSON.parse(await checked(worker, 'curl --noproxy "*" -fsS --connect-timeout 2 --max-time 5 ' + quote(gateway.href + 'api/worker-self/info')));
          requireFact(value.workerId === worker.id && value.userId === owner, 'WORKER_SELF_MISMATCH'); return;
        } catch (error) {
          signal.throwIfAborted(); if (Date.now() >= deadline) throw error;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
    };
    stage = 'services-proxies';
    for (const worker of workers) {
      await checked(worker, 'test "$(cat /proc/1/comm)" = systemd; systemctl is-active --quiet incus-agent agentor-worker; ' +
        'test -f /run/agentor/provisioned; runuser -u agent -- sudo -n true; runuser -u agent -- tmux has-session -t main; ' +
        'test ! -e /run/agentor-incus/client.key; test ! -e /run/agentor-incus/client.crt');
      await self(worker);
      requireFact([200, 302].includes((await api('/editor/' + worker.id + '/?folder=/workspace')).status), 'EDITOR_FAILED');
      requireFact((await api('/desktop/' + worker.id + '/agentor.html')).status === 200 &&
        /^RFB 003\./.test(await deps.rfb(worker.id, input.sessionCookie)), 'DESKTOP_FAILED');
      requireFact((await api('/editor/' + worker.id + '/', undefined, 'GET', false)).status === 401, 'ANONYMOUS_PROXY_ALLOWED');
    }
    stage = 'ipv4-mac-spoof';
    const v4 = await deps.primary({ id: victim.id, userId: owner, containerName: victim.name });
    const a4 = await deps.primary({ id: attacker.id, userId: owner, containerName: attacker.name });
    requireFact(v4.incarnation === victim.uuid && a4.incarnation === attacker.uuid && isIP(v4.address) === 4 && isIP(a4.address) === 4 && v4.address !== a4.address, 'PRIMARY_IDENTITY_INVALID');
    const vm = await fence(victim), am = await fence(attacker), victimMac = vm.config['volatile.eth0.hwaddr'], attackerMac = am.config['volatile.eth0.hwaddr'];
    requireFact(MAC.test(victimMac ?? '') && MAC.test(attackerMac ?? '') && victimMac !== attackerMac, 'MAC_IDENTITY_INVALID');
    const state = await deps.client.getInstanceState(attacker.name);
    const prefix = state.network?.eth0?.addresses.find(item => item.address === a4.address)?.netmask;
    requireFact(/^\d{1,2}$/.test(prefix ?? '') && Number(prefix) <= 32, 'PRIMARY_PREFIX_UNAVAILABLE');
    // A dev-filtered iproute2 query omits the dev field in its JSON output.
    // Query defaults, then require the captured authoritative route is eth0.
    const routeOutput = await checked(attacker, 'ip -j -4 route show default');
    requireFact(Buffer.byteLength(routeOutput) <= 8192, 'PRIMARY_ROUTE_LIMIT');
    const routes = JSON.parse(routeOutput);
    requireFact(Array.isArray(routes) && routes.length === 1 && routes[0].dst === 'default' && routes[0].dev === 'eth0' &&
      isIP(routes[0].gateway) === 4 && !['0', '127'].includes(routes[0].gateway.split('.')[0]) && Number(routes[0].gateway.split('.')[0]) < 224 &&
      (routes[0].metric === undefined || Number.isSafeInteger(routes[0].metric) && routes[0].metric >= 0 && routes[0].metric <= 0xffffffff), 'PRIMARY_ROUTE_UNAVAILABLE');
    const primaryRoute = Object.freeze({ gateway: routes[0].gateway, dev: routes[0].dev, metric: routes[0].metric });
    const manualRoute = 'ip -4 addr replace ' + a4.address + '/' + prefix + ' dev eth0; ip -4 route replace default via ' + primaryRoute.gateway +
      ' dev ' + primaryRoute.dev + (primaryRoute.metric === undefined ? '' : ' metric ' + primaryRoute.metric);
    const restore = 'ip link set eth0 down; ip link set eth0 address ' + attackerMac + '; ip link set eth0 up; ' + manualRoute + '; systemctl start systemd-networkd';
    const control = JSON.parse(await checked(attacker, 'trap ' + quote(restore) + ' EXIT; systemctl stop systemd-networkd; ip link set eth0 down; ' +
      'ip link set eth0 address ' + attackerMac + '; ip link set eth0 up; ' + manualRoute +
      '; curl --noproxy "*" --interface ' + a4.address + ' -fsS --connect-timeout 2 --max-time 5 ' + quote(gateway.href + 'api/worker-self/info')));
    requireFact(control.workerId === attacker.id && control.userId === owner, 'MANUAL_ROUTE_POSITIVE_FAILED');
    await self(attacker);
    const leases = await deps.client.getNetworkLeases(deps.config.incusNetwork);
    const ipv6 = mac => leases.filter(item => item.hwaddr.toLowerCase() === mac.toLowerCase() && isIP(item.address) === 6 && ['dynamic', 'static'].includes(item.type));
    const v6 = ipv6(victimMac), a6 = ipv6(attackerMac);
    const globals = state.network?.eth0?.addresses.filter(item => item.family === 'inet6' && item.scope === 'global') ?? [];
    const forgedMac = '02:' + createHash('sha256').update(nonce).digest('hex').slice(0, 10).match(/../g).join(':');
    requireFact(forgedMac !== victimMac && forgedMac !== attackerMac, 'DISTINCT_FORGED_MAC_REQUIRED');
    const packetCases = [];
    const addCases = (kind, family, allowedSource, deniedSource, deniedMac = attackerMac, target = v4.address) => {
      for (const [suffix, source, mac] of [['before', allowedSource, attackerMac], ['denied', deniedSource, deniedMac], ['after', allowedSource, attackerMac]])
        packetCases.push({ label: kind + '-' + suffix, family, source, target, mac });
    };
    addCases('ipv4', 4, a4.address, v4.address);
    addCases('mac', 4, a4.address, a4.address, forgedMac);
    if (v6.length || a6.length || globals.length) {
      requireFact(v6.length === 1 && a6.length === 1 && v6[0].address !== a6[0].address, 'AUTHORITATIVE_IPV6_REQUIRED');
      addCases('ipv6', 6, a6[0].address, v6[0].address, attackerMac, v6[0].address);
    }
    stage = 'one-way-nic-filtering';
    const spec = { nonce, destinationMac: victimMac, cases: packetCases }, specJson = JSON.stringify(spec);
    await fence(victim);
    const observer = await deps.client.execStream(victim.name, ['python3', '-u', '-c', CANARY_PACKET_SCRIPT, 'observe', specJson],
      { user: 0, group: 0, signal, timeoutMs: 75_000 });
    const seen = new Set(); let ready = false, summary, observerError, buffer = '', outputBytes = 0;
    observer.stderr.resume(); observer.stdout.on('error', () => { observerError = new Error('OBSERVER_STREAM_FAILED'); });
    observer.result.catch(() => { observerError = new Error('OBSERVER_UNSETTLED'); });
    observer.stdout.on('data', bytes => {
      try {
        outputBytes += bytes.length; requireFact(outputBytes <= 65536, 'OBSERVER_OUTPUT_LIMIT'); buffer += bytes.toString();
        let end;
        while ((end = buffer.indexOf('\n')) !== -1) {
          const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          requireFact(value.nonce === nonce, 'OBSERVER_IDENTITY_CHANGED');
          if (value.type === 'ready') ready = true;
          else if (value.type === 'seen' && packetCases.some(item => item.label === value.label)) seen.add(value.label);
          else if (value.type === 'result' && Array.isArray(value.seen)) summary = value.seen;
          else throw new Error('INVALID_OBSERVER_RESPONSE');
        }
      } catch { observerError = new Error('INVALID_OBSERVER_RESPONSE'); observer.close(); }
    });
    const waitObservation = async predicate => {
      const deadline = Date.now() + 5_000;
      while (!predicate()) {
        signal.throwIfAborted(); if (observerError) throw observerError;
        requireFact(Date.now() < deadline, 'ONE_WAY_POSITIVE_MISSING'); await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    try {
      await waitObservation(() => ready); await fence(victim);
      for (const item of packetCases) {
        await checked(attacker, 'python3 -u -c ' + quote(CANARY_PACKET_SCRIPT) + ' send ' + quote(specJson) + ' ' + quote(item.label));
        if (item.label.endsWith('-denied')) await new Promise(resolve => setTimeout(resolve, 750));
        else await waitObservation(() => seen.has(item.label));
        requireFact(![...seen].some(label => label.endsWith('-denied')), 'SPOOFED_FRAME_ADMITTED');
      }
      observer.stdin.end('finish\n'); requireFact(await observer.result === 0, 'OBSERVER_UNSETTLED');
      requireFact(summary && summary.length === packetCases.filter(item => !item.label.endsWith('-denied')).length &&
        packetCases.every(item => item.label.endsWith('-denied') ? !summary.includes(item.label) : summary.includes(item.label)), 'ONE_WAY_FILTERING_FAILED');
      await fence(victim);
    } finally { observer.close(); }
    await self(attacker); await self(victim);
    stage = 'persistence';
    await checked(victim, 'printf ' + quote(nonce) + ' >/workspace/incus-canary; printf ' + quote(nonce) + ' >/home/agent/.agent-data/incus-canary');
    if (input.dockerEnabled) await checked(victim, 'test "$(docker info --format "{{.Driver}}")" = overlay2; docker pull busybox:1.37.0; ' +
      'docker run --rm -v incus-canary:/data busybox:1.37.0 sh -ec ' + quote('printf ' + quote(nonce) + ' >/data/proof'), 120);
    await fence(victim); requireFact((await api('/api/containers/' + victim.id + '/stop', {})).status === 200, 'STOP_UNACKNOWLEDGED');
    await fence(victim); requireFact((await api('/api/containers/' + victim.id + '/restart', {})).status === 200, 'START_UNACKNOWLEDGED');
    await checked(victim, 'test "$(cat /workspace/incus-canary)" = ' + quote(nonce) + '; test "$(cat /home/agent/.agent-data/incus-canary)" = ' + quote(nonce) +
      '; systemctl is-active --quiet agentor-worker; test -f /run/agentor/provisioned'); await self(victim);
    if (input.dockerEnabled) requireFact(await checked(victim, 'docker run --rm -v incus-canary:/data busybox:1.37.0 cat /data/proof') === nonce, 'DOCKER_PERSISTENCE_FAILED');
    stage = 'cleanup';
    for (const worker of [...workers].reverse()) {
      await fence(worker); requireFact((await api('/api/containers/' + worker.id, undefined, 'DELETE')).status === 200, 'DELETE_UNACKNOWLEDGED');
      workers.splice(workers.indexOf(worker), 1);
    }
    for (const env of [...environments].reverse()) {
      await admin(); const current = await api('/api/environments/' + env.id), remaining = await api('/api/containers');
      requireFact(current.status === 200 && current.body.userId === owner && current.body.createdAt === env.createdAt &&
        remaining.status === 200 && !remaining.body.some(item => item.environmentId === env.id), 'ENVIRONMENT_AUTHORITY_CHANGED');
      requireFact((await api('/api/environments/' + env.id, undefined, 'DELETE')).status === 200, 'ENVIRONMENT_DELETE_UNACKNOWLEDGED');
      environments.splice(environments.indexOf(env), 1);
    }
    return { status: 'passed', stage: 'complete', ...retained(), docker: input.dockerEnabled };
  } catch {
    return { status: 'failed', stage, ...retained(), retained: environments.length > 0 || workers.length > 0 };
  } finally { deps?.close?.(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const controller = new AbortController(), cancel = () => { controller.abort(); process.stdin.destroy(); };
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  const deadline = setTimeout(cancel, 20 * 60_000); deadline.unref();
  try {
    requireFact(process.argv.length === 2, 'NO_ARGUMENT_CREDENTIALS');
    const parts = []; let size = 0;
    for await (const part of process.stdin) { size += part.length; requireFact(size <= 16_384, 'INPUT_LIMIT'); parts.push(part); }
    const result = await runIncusCanary(JSON.parse(Buffer.concat(parts).toString()), undefined, controller.signal);
    process.stdout.write(JSON.stringify(result) + '\n'); process.exitCode = result.status === 'passed' ? 0 : 1;
  } catch { process.stdout.write('{"status":"failed","stage":"input"}\n'); process.exitCode = 1; }
  finally { clearTimeout(deadline); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
}
