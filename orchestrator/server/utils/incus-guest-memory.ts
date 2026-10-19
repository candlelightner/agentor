import type { Readable } from 'node:stream';
import type { IncusClient } from './incus-client';

export interface IncusGuestMemory { usedBytes: number; totalBytes: number }
export const INCUS_GUEST_MEMORY_TIMEOUT_MS = 5000;

// Only fixed guest kernel counters; no worker setup, environment or host ZFS data.
export const INCUS_GUEST_MEMORY_PROBE = String.raw`
import json,sys
# Wait for stdin EOF after all exec channels have attached.
sys.stdin.buffer.read(1)
def read(path):
    with open(path, 'r', encoding='ascii') as source:
        value = source.read(16385)
    if len(value) > 16384:
        raise ValueError('Guest memory counter file exceeds limit')
    return value
sample = {'meminfo': read('/proc/meminfo')}
try:
    sample['arcstats'] = read('/proc/spl/kstat/zfs/arcstats')
except FileNotFoundError:
    pass
print(json.dumps(sample))
`;

export function parseGuestMemory(output: string): IncusGuestMemory {
  if (Buffer.byteLength(output) > 65536) throw new Error('Guest memory output exceeds limit');
  let sample;
  try { sample = JSON.parse(output); }
  catch { throw new Error('Guest memory sample is invalid'); }
  if (!sample || typeof sample !== 'object' || Array.isArray(sample) ||
      typeof sample.meminfo !== 'string' || Buffer.byteLength(sample.meminfo) > 16384 ||
      Object.keys(sample).some(key => !['meminfo', 'arcstats'].includes(key)))
    throw new Error('Guest memory sample is invalid');
  const number = (text: string) => {
    const value = Number(text);
    if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(value) || value < 0)
      throw new Error('Guest memory counter is invalid');
    return BigInt(value);
  };
  const required = ['MemTotal', 'MemFree', 'Buffers', 'Cached', 'SReclaimable', 'Shmem'];
  const values = new Map<string, bigint>();
  for (const line of sample.meminfo.split('\n')) {
    const name = line.split(':', 1)[0];
    if (!required.includes(name)) continue;
    const match = /^([A-Za-z]+):[ \t]+([0-9]+)[ \t]+kB[ \t]*$/.exec(line);
    if (!match || values.has(name)) throw new Error('Guest memory counters are missing or malformed');
    values.set(name, number(match[2]!));
  }
  if (values.size !== required.length) throw new Error('Guest memory counters are missing or malformed');
  const [total, free, buffers, cached, reclaimable, shared] = required.map(key => values.get(key)!);
  if (total! <= 0n || [...values.values()].some(value => value > total!) || total! * 1024n > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('Guest memory totals are invalid');
  const available = free! + buffers! + cached! + reclaimable!;
  // htop's numeric meter excludes reclaimable cache, includes shared memory,
  // and falls back to total-free when concurrently sampled counters overshoot.
  let used = (total! >= available ? total! - available : total! - free!) + shared!;
  if (sample.arcstats !== undefined) {
    if (typeof sample.arcstats !== 'string' || Buffer.byteLength(sample.arcstats) > 16384)
      throw new Error('Guest ZFS ARC counters are invalid');
    const arc = new Map<string, bigint>();
    for (const line of sample.arcstats.split('\n')) {
      const name = line.trim().split(/\s+/, 1)[0];
      if (name !== 'size' && name !== 'c_min') continue;
      const match = /^(size|c_min)[ \t]+[0-9]+[ \t]+([0-9]+)[ \t]*$/.exec(line);
      if (!match || arc.has(name)) throw new Error('Guest ZFS ARC counters are invalid');
      arc.set(name, number(match[2]!) / 1024n);
    }
    if (arc.size !== 2) throw new Error('Guest ZFS ARC counters are invalid');
    const reclaimableArc = arc.get('size')! - arc.get('c_min')!;
    if (reclaimableArc > 0n) used -= reclaimableArc;
  }
  if (used < 0n || used > total!)
    throw new Error('Guest memory totals are invalid');
  return { usedBytes: Number(used * 1024n), totalBytes: Number(total! * 1024n) };
}

async function boundedOutput(stream: Readable, maximum: number): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > maximum) throw new Error('Guest memory output exceeds limit');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readIncusGuestMemory(client: IncusClient, name: string, signal: AbortSignal): Promise<IncusGuestMemory> {
  signal.throwIfAborted();
  const session = await client.execStream(name, ['/usr/bin/python3', '-c', INCUS_GUEST_MEMORY_PROBE], {
    command: [], user: 0, group: 0, recordOutput: false, signal, timeoutMs: INCUS_GUEST_MEMORY_TIMEOUT_MS,
  });
  const close = () => session.close();
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    session.stdin.end();
    const [stdout, , exitCode] = await Promise.all([
      boundedOutput(session.stdout, 65536), boundedOutput(session.stderr, 1024), session.result,
    ]);
    signal.throwIfAborted();
    if (exitCode !== 0) throw new Error('Guest memory probe failed');
    return parseGuestMemory(stdout);
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
}
