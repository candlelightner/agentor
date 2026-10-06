import { test, expect } from '@playwright/test';
import https from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import { mkdtemp, writeFile, readFile, rm, symlink, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { IncusClient, IncusError, IncusRequestRejected, type IncusImage } from '../../orchestrator/server/utils/incus-client';

let tlsDir: string, certificate: Buffer, key: Buffer;
test.beforeAll(async () => {
  tlsDir = await mkdtemp(join(tmpdir(), 'agentor-image-import-tls-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ed25519', '-nodes', '-days', '1',
    '-keyout', join(tlsDir, 'key.pem'), '-out', join(tlsDir, 'cert.pem'), '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  certificate = await readFile(join(tlsDir, 'cert.pem')); key = await readFile(join(tlsDir, 'key.pem'));
});
test.afterAll(async () => { await rm(tlsDir, { recursive: true, force: true }); });

const fingerprint = 'a'.repeat(64), operationId = 'e2d83d1e-bd86-44e4-8e06-1293a7f3345d';
const operation = '/1.0/operations/' + operationId;
const image: IncusImage = { fingerprint, type: 'virtual-machine', architecture: 'x86_64', size: 4096, aliases: [] };
const envelope = (metadata: unknown) => ({ type: 'sync', metadata });
const accepted = () => ({ type: 'async', operation: operation + '?project=agentor', metadata: {} });
type Protocol = (request: IncomingMessage, reply: ServerResponse) => void;

async function fixture(run: (f: {
  client: IncusClient; metadata: string; disk: string; events: string[]; bodies: Buffer[];
  setProtocol: (protocol: Protocol) => void;
}) => Promise<void>, timeoutMs = 1000) {
  const dir = await mkdtemp(join(tmpdir(), 'agentor-image-import-'));
  const metadata = join(dir, 'metadata.tar.gz'), disk = join(dir, 'disk.qcow2');
  await writeFile(metadata, Buffer.from([0x1f, 0x8b, 0, 0xff, 0x80]));
  await writeFile(disk, Buffer.concat([Buffer.from([0x51, 0x46, 0x49, 0xfb]), Buffer.alloc(128 * 1024, 0x80)]));
  const events: string[] = [], bodies: Buffer[] = [];
  let importedType: IncusImage['type'] = 'container';
  const json = (reply: ServerResponse, value: unknown, code = 200) => {
    reply.writeHead(code, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify(value));
  };
  let protocol: Protocol = (request, reply) => {
    const url = new URL(request.url!, 'https://fixture.invalid');
    expect(url.searchParams.getAll('project')).toEqual(['agentor']);
    if (request.method === 'POST') {
      const chunks: Buffer[] = []; request.on('data', chunk => { chunks.push(Buffer.from(chunk)); });
      request.on('end', () => {
        const body = Buffer.concat(chunks);
        expect(request.headers['content-length']).toBe(String(body.length));
        expect(request.headers['content-type']).toMatch(/^multipart\/form-data; boundary=agentor-vm-/);
        expect(request.headers['x-incus-public']).toBe('false'); expect(request.headers['x-incus-type']).toBe('virtual-machine');
        // Mirror pinned Incus 6.0.6 images.go:759: the form name determines
        // split-image type even when the request advertises a VM header.
        importedType = body.includes(Buffer.from('name="rootfs.img";')) ? 'virtual-machine' : 'container';
        bodies.push(body); json(reply, accepted(), 202);
      });
    } else if (url.pathname === operation) json(reply, envelope({ id: operationId, status: 'Success', status_code: 200, metadata: { fingerprint } }));
    else if (url.pathname === '/1.0/images/' + fingerprint) json(reply, envelope({ ...image, type: importedType }));
    else { reply.writeHead(404); reply.end(); }
  };
  const server = https.createServer({ cert: certificate, key, ca: certificate, requestCert: true, rejectUnauthorized: true }, (request, reply) => {
    request.on('error', () => {}); reply.on('error', () => {}); // Expected disconnect/cancellation fixture paths.
    expect((request.socket as TLSSocket).authorized).toBe(true);
    expect((request.socket as TLSSocket).getPeerCertificate().fingerprint256).toBeTruthy();
    events.push(request.method + ':' + request.url); protocol(request, reply);
  });
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture listener');
  const client = new IncusClient({ endpoint: 'https://127.0.0.1:' + address.port, project: 'agentor',
    clientCert: certificate, clientKey: key, serverCert: certificate, rejectUnauthorized: true, timeoutMs });
  try { await run({ client, metadata, disk, events, bodies, setProtocol: value => { protocol = value; } }); }
  finally { client.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true }); }
}

test('split VM image import streams fixed binary multipart through verified mTLS/project and persists acknowledgement before wait', async () => {
  await fixture(async f => {
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; }), acknowledged = new Promise<void>(resolve => { entered = resolve; });
    const pending = f.client.importImage(f.metadata, f.disk, async path => {
      expect(path).toBe(operation); f.events.push('persist:' + path); entered(); await barrier;
    });
    await acknowledged;
    expect(f.events).toEqual(['POST:/1.0/images?project=agentor', 'persist:' + operation]);
    release(); expect(await pending).toEqual(image);
    expect(f.events).toEqual(['POST:/1.0/images?project=agentor', 'persist:' + operation,
      'GET:' + operation + '?project=agentor', 'GET:/1.0/images/' + fingerprint + '?project=agentor']);
    const body = f.bodies[0]!;
    expect(body.indexOf(Buffer.from('name="metadata"; filename="metadata.tar.gz"'))).toBeGreaterThan(0);
    expect(body.indexOf(Buffer.from('name="rootfs.img"; filename="rootfs.img"'))).toBeGreaterThan(body.indexOf(Buffer.from('name="metadata"')));
    expect(body.indexOf(Buffer.from('name="rootfs";'))).toBe(-1); // Native daemon selects container vs VM by this form name.
    expect(body.indexOf(await readFile(f.metadata))).toBeGreaterThan(0); expect(body.indexOf(await readFile(f.disk))).toBeGreaterThan(0);
    expect(body.toString('latin1')).not.toContain(f.metadata); expect(body.toString('latin1')).not.toContain(f.disk);
  });
});

test('image acknowledgement persistence failure or cancellation never waits, reads an image, or resubmits', async () => {
  for (const failure of ['persist', 'cancel'] as const) await fixture(async f => {
    const controller = new AbortController();
    const pending = f.client.importImage(f.metadata, f.disk, async () => {
      if (failure === 'cancel') controller.abort(); else throw new Error('Accepted receipt persistence failed');
    }, controller.signal);
    await expect(pending).rejects.toThrow();
    expect(f.events).toEqual(['POST:/1.0/images?project=agentor']);
  });
});

test('malformed/foreign image operation replies never acknowledge or adopt any image', async () => {
  for (const response of [{ type: 'async' }, { type: 'async', operation: operation + '?project=other' },
    { type: 'async', operation: operation + '?project=agentor&project=other' },
    { type: 'async', operation: 'https://foreign.invalid' + operation },
    { type: 'async', operation: operation + '?project=agentor&extra=caller' },
    { type: 'async', operation: '/1.0/instances/arbitrary?project=agentor' },
    { type: 'sync', metadata: { fingerprint: [fingerprint] } }, { type: 'unknown' },
    { ...accepted(), httpCode: 302 }]) await fixture(async f => {
      f.setProtocol((request, reply) => { request.resume(); request.on('end', () => {
        reply.writeHead('httpCode' in response ? response.httpCode : 202, { 'Content-Type': 'application/json' }); reply.end(JSON.stringify(response));
      }); });
      let acknowledgements = 0;
      await expect(f.client.importImage(f.metadata, f.disk, async () => { acknowledgements++; })).rejects.not.toBeInstanceOf(IncusRequestRejected);
      expect(acknowledgements).toBe(0); expect(f.events).toHaveLength(1);
    });
});

test('only explicit native rejection is definitive; malformed or oversized error responses remain uncertain', async () => {
  for (const kind of ['native', 'malformed', 'oversized', 'error-200', 'error-202', 'missing-code', 'conflicting-code', 'string-code', 'server-error'] as const) await fixture(async f => {
    f.setProtocol((request, reply) => { request.resume(); request.on('end', () => {
      const code = kind === 'error-200' ? 200 : kind === 'error-202' ? 202 : kind === 'server-error' ? 500 : 403;
      reply.writeHead(code, { 'Content-Type': 'application/json' });
      reply.end(kind === 'malformed' ? 'not JSON' : kind === 'oversized' ? Buffer.alloc(1024 ** 2 + 1, 65)
        : JSON.stringify({ type: 'error', error: 'restricted', error_code: kind === 'missing-code' ? undefined
          : kind === 'conflicting-code' ? 401 : kind === 'string-code' ? '403' : code }));
    }); });
    let acknowledged = 0;
    const rejected = f.client.importImage(f.metadata, f.disk, async () => { acknowledged++; });
    if (kind === 'native') await expect(rejected).rejects.toBeInstanceOf(IncusRequestRejected);
    else await expect(rejected).rejects.not.toBeInstanceOf(IncusRequestRejected);
    expect(f.events).toHaveLength(1); expect(acknowledged).toBe(0);
  });
});

test('successful import requires the operation fingerprint and exact current VM type, never an alias/name fallback', async () => {
  for (const failure of ['fingerprint', 'image-fingerprint', 'image-type', 'operation-failed', 'operation-malformed-status', 'operation-missing-id', 'operation-wrong-id'] as const) await fixture(async f => {
    f.setProtocol((request, reply) => {
      request.resume(); request.on('end', () => {
        reply.writeHead(request.method === 'POST' ? 202 : 200, { 'Content-Type': 'application/json' });
        const value = request.method === 'POST' ? accepted() : request.url!.includes('/operations/')
          ? envelope({ id: failure === 'operation-missing-id' ? undefined : failure === 'operation-wrong-id' ? randomUUID() : operationId,
            status: failure === 'operation-failed' ? 'Failure' : 'Success',
            status_code: failure === 'operation-failed' ? 400 : failure === 'operation-malformed-status' ? undefined : 200,
            metadata: { fingerprint: failure === 'fingerprint' ? 'short' : fingerprint } })
          : envelope({ ...image, fingerprint: failure === 'image-fingerprint' ? 'b'.repeat(64) : fingerprint,
            type: failure === 'image-type' ? 'container' : 'virtual-machine' });
        reply.end(JSON.stringify(value));
      });
    });
    let acceptedCalls = 0;
    await expect(f.client.importImage(f.metadata, f.disk, async () => { acceptedCalls++; })).rejects.toBeInstanceOf(IncusError);
    expect(acceptedCalls).toBe(1); expect(f.events.filter(value => value.startsWith('POST:'))).toHaveLength(1);
    expect(f.events).toHaveLength(failure.startsWith('image-') ? 3 : 2);
    expect(f.events.some(value => value.includes('/aliases'))).toBe(false);
  });
});

test('synchronous HTTPS construction failure preserves original error and closes artifacts without acknowledgement or stray requests', async () => {
  await fixture(async f => {
    const request = https.request, originalError = new Error('Controlled synchronous transport construction failure');
    let acknowledged = false;
    https.request = (() => { throw originalError; }) as typeof https.request;
    try {
      await expect(f.client.importImage(f.metadata, f.disk, async () => { acknowledged = true; })).rejects.toBe(originalError);
      await new Promise<void>(resolve => setImmediate(resolve));
      const targets = await Promise.all((await readdir('/proc/self/fd')).map(fd => readlink('/proc/self/fd/' + fd).catch(() => '')));
      expect(targets.filter(target => target === f.metadata || target === f.disk)).toEqual([]);
      expect(acknowledged).toBe(false); expect(f.events).toEqual([]);
    } finally { https.request = request; }
  });
});

test('image upload cancellation and inactivity deadline close the stream without success/acknowledgement', async () => {
  for (const reason of ['abort', 'timeout'] as const) await fixture(async f => {
    const controller = new AbortController();
    f.setProtocol((request, _reply) => {
      if (reason === 'abort') request.once('data', () => controller.abort());
      request.resume();
    });
    let acknowledged = false;
    await expect(f.client.importImage(f.metadata, f.disk, async () => { acknowledged = true; }, controller.signal)).rejects.toThrow();
    expect(acknowledged).toBe(false); expect(f.events).toHaveLength(1);
  }, 150);
});

test('unverified/default transport and invalid/symlink qcow artifacts fail before POST', async () => {
  await fixture(async f => {
    for (const client of [new IncusClient({ endpoint: f.client.endpoint, project: 'default' }),
      new IncusClient({ endpoint: f.client.endpoint, project: 'agentor', rejectUnauthorized: false }),
      new IncusClient({ endpoint: f.client.endpoint.replace('https:', 'http:'), project: 'agentor' })]) {
      await expect(client.importImage(f.metadata, f.disk)).rejects.toThrow('verified mTLS'); client.dispose();
    }
    await writeFile(f.disk, 'not qcow2'); await expect(f.client.importImage(f.metadata, f.disk)).rejects.toThrow('qcow2');
    const link = join(tlsDir, randomUUID()); await symlink(f.disk, link);
    try { await expect(f.client.importImage(f.metadata, link)).rejects.toThrow(); }
    finally { await rm(link); }
    expect(f.events).toEqual([]);
  });
});
