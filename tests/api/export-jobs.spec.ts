import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { ApiClient } from '../helpers/api-client';
import { createWorker, cleanupWorker, waitForWorkerRunning } from '../helpers/worker-lifecycle';
import { createTestUser, deleteTestUser } from '../helpers/test-users';
import { TerminalWsClient } from '../helpers/terminal-ws';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

async function waitForTerminal(api: ApiClient, jobId: string, timeout = 90_000) {
  const started = Date.now();
  let last: any;
  while (Date.now() - started < timeout) {
    const result = await api.getExportJob(jobId);
    expect(result.status).toBe(200);
    last = result.body;
    if (['succeeded', 'failed', 'cancelled'].includes(result.body.status)) return result.body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Export job ${jobId} did not finish (phase=${last?.phase || 'unknown'}, bytes=${last?.bytesProcessed ?? 'unknown'})`,
  );
}

async function execInWorker(workerId: string, command: string, expected: RegExp): Promise<void> {
  const terminal = new TerminalWsClient(workerId);
  try {
    await terminal.connect();
    await terminal.waitForOutput(/[\$#>]\s*$/, 30_000);
    terminal.clearBuffer();
    terminal.sendLine(command);
    await terminal.waitForOutput(expected, 30_000);
  } finally {
    terminal.close();
  }
}

async function streamExportIntoImport(
  request: APIRequestContext,
  jobId: string,
  displayName: string,
) {
  const state = await request.storageState();
  const cookie = state.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const headers = { Cookie: cookie, Origin: BASE_URL };
  const downloadUrl = new URL(
    `/api/export-jobs/${jobId}/download`,
    BASE_URL,
  );
  const importUrl = new URL(
    `/api/containers/import?displayName=${encodeURIComponent(displayName)}`,
    BASE_URL,
  );
  const makeRequest = downloadUrl.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const downloadRequest = makeRequest(downloadUrl, { headers }, (download) => {
      if (download.statusCode !== 200) {
        download.resume();
        reject(new Error(`Export download failed with ${download.statusCode}`));
        return;
      }
      const upload = makeRequest(
        importUrl,
        {
          method: 'POST',
          headers: {
            ...headers,
            'Content-Type': 'application/x-tar',
            ...(download.headers['content-length']
              ? { 'Content-Length': download.headers['content-length'] }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let body: any = {};
            try { body = JSON.parse(text); } catch {}
            resolve({ status: response.statusCode || 0, body });
          });
        },
      );
      upload.on('error', reject);
      download.on('error', reject);
      download.pipe(upload);
    });
    downloadRequest.on('error', reject);
    downloadRequest.end();
  });
}

test.describe.serial('Asynchronous worker exports', () => {
  // Retrying this serial group would repeat the multi-gigabyte rootfs proof.
  test.describe.configure({ retries: 0 });
  let workerId = '';

  test.beforeAll(async ({ request }) => {
    workerId = (await createWorker(request, { displayName: `Export-jobs-${Date.now()}` })).id;
  });

  test.afterAll(async ({ request }) => {
    if (workerId) await cleanupWorker(request, workerId);
  });

  test('creation returns 202 and defaults to workspace-only', async ({ request }) => {
    const api = new ApiClient(request);
    const created = await api.createExportJob(workerId);
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({
      workerId,
      includeRootfs: false,
      status: expect.stringMatching(/^(queued|running)$/),
      progress: expect.any(Number),
      bytesProcessed: expect.any(Number),
      downloadReady: false,
    });
    expect(created.body.id).toBeTruthy();
    await waitForTerminal(api, created.body.id);
  });

  test('job progresses to success and downloads a streamed tar artifact', async ({ request }) => {
    const api = new ApiClient(request);
    const created = await api.createExportJob(workerId, false);
    expect(created.status).toBe(202);
    const finished = await waitForTerminal(api, created.body.id);
    expect(finished).toMatchObject({ status: 'succeeded', phase: 'complete', progress: 100, downloadReady: true });
    expect(finished.completedAt).toBeTruthy();
    expect(finished.expiresAt).toBeTruthy();

    const download = await api.downloadExportJob(created.body.id);
    expect(download.status).toBe(200);
    expect(download.headers['content-type']).toContain('application/x-tar');
    expect(download.headers['content-disposition']).toContain('attachment');
    expect(download.headers['cache-control']).toContain('no-store');
    expect(download.body.length).toBeGreaterThan(0);
  });

  test('a duplicate active export is rejected', async ({ request }) => {
    const api = new ApiClient(request);
    const first = await api.createExportJob(workerId, true);
    expect(first.status).toBe(202);
    expect(first.body.includeRootfs).toBe(true);
    const duplicate = await api.createExportJob(workerId, false);
    expect(duplicate.status).toBe(409);
    await api.cancelExportJob(first.body.id);
    await waitForTerminal(api, first.body.id);
  });

  test('an active export can be cancelled and cannot be downloaded', async ({ request }) => {
    const api = new ApiClient(request);
    const created = await api.createExportJob(workerId, true);
    expect(created.status).toBe(202);
    const cancelled = await api.cancelExportJob(created.body.id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    const status = await waitForTerminal(api, created.body.id);
    expect(status.status).toBe('cancelled');
    expect((await api.downloadExportJob(created.body.id)).status).toBe(409);
  });

  test('explicit rootfs capture survives an export/import round trip', async ({ request }) => {
    // The standard worker image is intentionally feature-rich and a complete
    // docker export + validated docker import can take more than 30 minutes on
    // the nested-Docker CI host. This is the explicit advanced path: export is
    // asynchronous and both directions stream, so the duration is not a UI or
    // in-memory buffering timeout. Run the costly proof once, with headroom,
    // instead of retrying the entire multi-gigabyte round trip.
    test.info().annotations.push({ type: 'slow-path', description: 'Full rootfs Docker export/import round trip' });
    test.setTimeout(2_700_000);
    const api = new ApiClient(request);
    const marker = `ROOTFS_EXPORT_${Date.now()}`;
    let importedId = '';
    await execInWorker(workerId, `printf '%s' '${marker}' > /home/agent/export-rootfs-marker && echo ROOTFS_READY`, /ROOTFS_READY/);
    try {
      const created = await api.createExportJob(workerId, true);
      expect(created.status).toBe(202);
      const finished = await waitForTerminal(api, created.body.id, 900_000);
      expect(finished.status).toBe('succeeded');
      const imported = await streamExportIntoImport(
        request,
        created.body.id,
        `rootfs-import-${Date.now()}`,
      );
      expect(imported.status).toBe(201);
      importedId = imported.body.id;
      await waitForWorkerRunning(request, importedId, 90_000);
      await execInWorker(importedId, 'cat /home/agent/export-rootfs-marker', new RegExp(marker));
    } finally {
      await execInWorker(workerId, 'rm -f /home/agent/export-rootfs-marker && echo ROOTFS_CLEAN', /ROOTFS_CLEAN/).catch(() => {});
      if (importedId) await cleanupWorker(request, importedId);
    }
  });

  test('job status, cancellation, and download require authentication', async () => {
    const anonymous = await playwrightRequest.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { Origin: BASE_URL },
      storageState: { cookies: [], origins: [] },
    });
    try {
      const api = new ApiClient(anonymous);
      expect((await api.getExportJob('00000000-0000-4000-8000-000000000000')).status).toBe(401);
      expect((await api.cancelExportJob('00000000-0000-4000-8000-000000000000')).status).toBe(401);
      expect((await api.downloadExportJob('00000000-0000-4000-8000-000000000000')).status).toBe(401);
      expect((await api.createExportJob(workerId)).status).toBe(401);
    } finally {
      await anonymous.dispose();
    }
  });

  test('another user cannot inspect, cancel, or download an export job', async ({ request }) => {
    const ownerApi = new ApiClient(request);
    const created = await ownerApi.createExportJob(workerId, false);
    expect(created.status).toBe(202);

    const user = await createTestUser('Export Isolation');
    let other: APIRequestContext | undefined;
    try {
      other = await playwrightRequest.newContext({ baseURL: BASE_URL, extraHTTPHeaders: { Origin: BASE_URL } });
      const otherApi = new ApiClient(other);
      expect((await otherApi.signInEmail(user.email, user.password)).status).toBe(200);
      expect((await otherApi.getExportJob(created.body.id)).status).toBe(403);
      expect((await otherApi.cancelExportJob(created.body.id)).status).toBe(403);
      expect((await otherApi.downloadExportJob(created.body.id)).status).toBe(403);
      expect((await otherApi.createExportJob(workerId)).status).toBe(403);
    } finally {
      await other?.dispose();
      await deleteTestUser(user.id);
      await waitForTerminal(ownerApi, created.body.id);
    }
  });
});
