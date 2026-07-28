import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker } from '../helpers/worker-lifecycle';
import { createTestUser, deleteTestUser, type CreatedUser } from '../helpers/test-users';
import {
  buildPng,
  pngWithBadSignature,
  pngWithBadIhdr,
  pngWithZeroWidth,
  invalidUtf8,
  readWorkerClipboard,
  waitForClipboardReady,
} from '../helpers/clipboard';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const UNAUTH_OPTS = {
  baseURL: BASE_URL,
  extraHTTPHeaders: { Origin: BASE_URL },
  storageState: { cookies: [], origins: [] },
};

test.describe.serial('Clipboard API — POST /api/containers/:id/clipboard', () => {
  let containerId: string;

  test.beforeAll(async ({ request }) => {
    const container = await createWorker(request);
    containerId = container.id;
    await waitForClipboardReady(request, containerId);
  });

  test.afterAll(async ({ request }) => {
    await cleanupWorker(request, containerId);
  });

  test('valid tiny PNG returns metadata and serves image/png on the X clipboard', async ({ request }) => {
    const api = new ApiClient(request);
    const png = buildPng(4, 3);
    const { status, body } = await api.setClipboard(containerId, 'image/png', png);
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.type).toBe('image/png');
    expect(body.width).toBe(4);
    expect(body.height).toBe(3);

    // Read the selection back from the worker's X clipboard and verify the
    // exact bytes match (signature + full payload). This proves the helper
    // actually took ownership and is serving image/png.
    const readBack = await readWorkerClipboard(request, containerId, 'image/png');
    expect(readBack).not.toBeNull();
    expect(readBack!.equals(png)).toBe(true);
  });

  test('valid UTF-8 text is accepted', async ({ request }) => {
    const api = new ApiClient(request);
    const text = 'héllo wörld — € •';
    const { status, body } = await api.setClipboard(containerId, 'text/plain', Buffer.from(text, 'utf-8'));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.type).toBe('text/plain');
    // Text responses carry no width/height.
    expect(body.width).toBeUndefined();
    expect(body.height).toBeUndefined();
  });

  test('empty body returns 400', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.setClipboard(containerId, 'image/png', Buffer.alloc(0));
    expect(status).toBe(400);
  });

  test('unsupported MIME type returns 415', async ({ request }) => {
    const res = await request.post(`${BASE_URL}/api/containers/${containerId}/clipboard`, {
      headers: { 'Content-Type': 'application/octet-stream' },
      data: Buffer.from([0x01, 0x02, 0x03]),
    });
    expect(res.status()).toBe(415);
  });

  test('invalid PNG signature returns 415', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.setClipboard(containerId, 'image/png', pngWithBadSignature());
    expect(status).toBe(415);
  });

  test('corrupted IHDR chunk tag returns 415', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.setClipboard(containerId, 'image/png', pngWithBadIhdr());
    expect(status).toBe(415);
  });

  test('zero PNG width returns 415', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.setClipboard(containerId, 'image/png', pngWithZeroWidth());
    expect(status).toBe(415);
  });

  test('invalid UTF-8 in text/plain returns 415', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.setClipboard(containerId, 'text/plain', invalidUtf8());
    expect(status).toBe(415);
  });

  test('image payload exceeding the 16 MiB cap returns 413', async ({ request }) => {
    const api = new ApiClient(request);
    // Build a valid PNG header + a body just over the 16 MiB cap. The route
    // enforces the cap byte-by-byte on the stream, so it rejects before the
    // helper runs. We don't need a structurally perfect huge PNG — a valid
    // signature + IHDR followed by >16 MiB of zeros triggers the 413 path
    // after the signature/IHDR pre-checks pass.
    const over = 16 * 1024 * 1024 + 16;
    const head = buildPng(1, 1).subarray(0, 24); // signature + IHDR chunk (24 bytes)
    const body = Buffer.concat([head, Buffer.alloc(over - head.length, 0)]);
    const { status } = await api.setClipboard(containerId, 'image/png', body);
    expect(status).toBe(413);
  });

  test('text payload exceeding the 1 MiB cap returns 413', async ({ request }) => {
    const api = new ApiClient(request);
    const over = 1 * 1024 * 1024 + 16;
    const { status } = await api.setClipboard(containerId, 'text/plain', Buffer.alloc(over, 0x41));
    expect(status).toBe(413);
  });

  test('stopped worker returns 409', async ({ request }) => {
    const api = new ApiClient(request);
    // Create a second worker, stop it, then POST a clipboard payload.
    const stopped = await createWorker(request);
    try {
      const stopRes = await api.stopContainer(stopped.id);
      expect(stopRes.status).toBe(200);
      // Give the orchestrator a moment to flip the stored status to 'stopped'.
      await new Promise((r) => setTimeout(r, 1500));
      const png = buildPng(2, 2);
      const { status } = await api.setClipboard(stopped.id, 'image/png', png);
      expect(status).toBe(409);
    } finally {
      await cleanupWorker(request, stopped.id);
    }
  });

  test('missing worker returns 404', async ({ request }) => {
    const api = new ApiClient(request);
    const { status } = await api.setClipboard('nonexistent-worker-id', 'image/png', buildPng(2, 2));
    expect(status).toBe(404);
  });

  test('unauthenticated request returns 401', async () => {
    const ctx = await playwrightRequest.newContext(UNAUTH_OPTS);
    try {
      const api = new ApiClient(ctx);
      const { status } = await api.setClipboard(containerId, 'image/png', buildPng(2, 2));
      expect(status).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test('cross-user request returns 403', async ({ request }) => {
    const api = new ApiClient(request);
    // Bob (regular user) must not paste into the admin-owned worker.
    let bob: CreatedUser | undefined;
    let bobCtx: APIRequestContext | undefined;
    try {
      bob = await createTestUser('Bob Clip');
      bobCtx = await playwrightRequest.newContext(UNAUTH_OPTS);
      const bobApi = new ApiClient(bobCtx);
      const signIn = await bobApi.signInEmail(bob.email, bob.password);
      expect(signIn.status).toBe(200);
      const { status } = await bobApi.setClipboard(containerId, 'image/png', buildPng(2, 2));
      expect(status).toBe(403);
    } finally {
      await bobCtx?.dispose();
      if (bob) await deleteTestUser(bob.id);
    }
  });
});
