import { test, expect } from '@playwright/test';
import { createWsRelayHandlers, isAllowedRelayOrigin } from '../../orchestrator/server/utils/ws-utils';

const upgrade = (origin?: string, host = 'agentor.test:8443') => ({
  url: 'http://internal-orchestrator:3000/plugin-ui/worker/plugin/open/',
  headers: new Headers({ host, ...(origin === undefined ? {} : { origin }) }),
});

test('relay accepts same-host browser origins behind TLS termination and existing non-browser clients', () => {
  expect(isAllowedRelayOrigin(upgrade('https://agentor.test:8443'))).toBe(true);
  expect(isAllowedRelayOrigin(upgrade('http://agentor.test:8443'))).toBe(true);
  expect(isAllowedRelayOrigin(upgrade())).toBe(true);
  expect(isAllowedRelayOrigin({ url: 'http://agentor.test/desktop/worker/',
    headers: new Headers({ origin: 'https://agentor.test' }) })).toBe(true);
});

test('relay rejects foreign, opaque, malformed, credential-bearing and mismatched-port origins', () => {
  for (const origin of ['https://unrelated.invalid', 'https://agentor.test', 'https://agentor.test:8444',
    'https://agentor.test.attacker.invalid:8443', 'null', '', 'not a URL',
    'ws://agentor.test:8443', 'https://user@agentor.test:8443', 'https://agentor.test:8443/path']) {
    expect(isAllowedRelayOrigin(upgrade(origin)), origin).toBe(false);
  }
});

test('foreign browser upgrade closes before worker lookup, authorization or backend resolution', async () => {
  let closed = 0, authorized = 0, targeted = 0;
  const relay = createWsRelayHandlers(/\/plugin-ui\/([^/?]+)/,
    () => { targeted++; throw new Error('must not resolve backend'); },
    () => { authorized++; return true; });
  const peer = { id: 'foreign-origin-test', request: upgrade('https://unrelated.invalid'), close() { closed++; } } as any;
  await relay.open(peer);
  relay.message(peer, 'must not buffer'); relay.close(peer);
  expect({ closed, authorized, targeted }).toEqual({ closed: 1, authorized: 0, targeted: 0 });
});
