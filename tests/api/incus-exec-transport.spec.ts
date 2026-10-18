import { test, expect } from "@playwright/test";
import http from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { IncusClient } from "../../orchestrator/server/utils/incus-client";

const { WebSocketServer } = createRequire(join(process.cwd(), "../orchestrator/package.json"))("ws");

async function fixture(mode: "normal" | "reject" | "stall" | "early-close" | "stream" | "stream-hang" | "stream-fast", run: (client: IncusClient, controls: unknown[], projects: string[], channels: Set<any>) => Promise<void>) {
  const controls: unknown[] = [], projects: string[] = [];
  const raw = new Set<Socket>();
  const channels = new Set<any>();
  const streamMode = mode.startsWith("stream");
  const streams: Record<string, any> = {};
  const input: Buffer[] = [];
  const server = http.createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.method === "GET") {
      response.end(JSON.stringify({ type: "sync", metadata: { status: "Success", status_code: 200, metadata: { return: 23 } } }));
      return;
    }
    response.end(JSON.stringify({ type: "async", operation: "/1.0/operations/test-exec",
      metadata: { id: "test-exec", metadata: { fds: { "0": "data", ...(streamMode ? { "1": "stdout", "2": "stderr" } : {}), control: "control" } } } }));
  });
  const ws = new WebSocketServer({ noServer: true });
  server.on("connection", (socket) => { raw.add(socket); socket.once("close", () => raw.delete(socket)); });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url!, "http://localhost");
    projects.push(url.searchParams.get("project")!);
    const control = url.searchParams.get("secret") === "control";
    if (control && mode === "reject") { socket.destroy(); return; }
    if (control && mode === "stall") return;
    const upgrade = () => {
      if (socket.destroyed) return;
      ws.handleUpgrade(request, socket, head, (channel: any) => {
        channels.add(channel);
        streams[url.searchParams.get("secret")!] = channel;
        channel.on("error", () => {});
        channel.once("close", () => channels.delete(channel));
        channel.on("message", (bytes: Buffer, binary: boolean) => {
          if (control) controls.push(JSON.parse(bytes.toString()));
          else if (!streamMode) channel.send(bytes, { binary });
          else if (url.searchParams.get("secret") === "data") {
            controls.push({ binary, bytes: Buffer.from(bytes) });
            if (binary) input.push(Buffer.from(bytes));
            else if (mode === "stream") {
              streams.stdout.send(Buffer.concat(input), { binary: true });
              streams.stderr.send(Buffer.from([255, 0, 13, 10]), { binary: true });
              streams.stdout.send("", { binary: false });
              streams.stderr.send("", { binary: false });
            }
          }
        });
        if (!control && mode === "early-close") channel.close();
        if (mode === "stream-fast" && Object.keys(streams).length === 4) {
          streams.stdout.send(Buffer.from([0,255]), { binary: true });
          streams.stdout.send("", { binary: false });
          streams.stderr.send("", { binary: false });
          streams.control.close();
        }
      });
    };
    if (control && mode === "early-close") setTimeout(upgrade, 50);
    else upgrade();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const client = new IncusClient({ endpoint: `http://127.0.0.1:${(server.address() as any).port}`, project: "scoped-project", timeoutMs: 250 });
  try { await run(client, controls, projects, channels); }
  finally {
    client.dispose();
    for (const channel of channels) channel.terminate();
    for (const socket of raw) socket.destroy();
    await new Promise<void>((resolve) => ws.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("PTY controls match Incus wire types and binary data retains its bytes", async () => {
  await fixture("normal", async (client, controls, projects, channels) => {
    const session = await client.execInteractive("fixture", ["true"]);
    try {
      const payload = Buffer.from([0, 255, 10, 13, 127]);
      const received = new Promise<Buffer>((resolve) => session.dataWs.once("message", resolve));
      session.dataWs.send(payload, { binary: true });
      expect(await received).toEqual(payload);
      session.resize(120, 40);
      session.sendSignal(15);
      await expect.poll(() => controls).toEqual([
        { command: "window-resize", args: { width: "120", height: "40" } },
        { command: "signal", signal: 15 },
      ]);
      expect(projects).toEqual(["scoped-project", "scoped-project"]);
    } finally { session.close(); }
    await expect.poll(() => channels.size).toBe(0);
  });
});

test("fast non-PTY output is captured even when the command ends during setup", async () => {
  await fixture("stream-fast", async (client, _controls, _projects, channels) => {
    const session = await client.execStream("fixture", ["true"]);
    session.stderr.resume();
    const chunks: Buffer[] = [];
    for await (const chunk of session.stdout) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0,255]));
    expect(await session.result).toBe(23);
    await expect.poll(() => channels.size).toBe(0);
  });
});

test("non-PTY exec preserves separate binary outputs and sends explicit stdin EOF", async () => {
  await fixture("stream", async (client, controls, projects, channels) => {
    const session = await client.execStream("fixture", ["cat"]);
    const collect = async (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    };
    const outputs = Promise.all([collect(session.stdout), collect(session.stderr)]);
    const payload = Buffer.from([0, 255, 13, 10, 128]);
    session.stdin.end(payload);
    expect(await outputs).toEqual([payload, Buffer.from([255, 0, 13, 10])]);
    expect(await session.result).toBe(23);
    expect(controls).toEqual([{ binary: true, bytes: payload }, { binary: false, bytes: Buffer.alloc(0) }]);
    expect(projects).toEqual(Array(4).fill("scoped-project"));
    await expect.poll(() => channels.size).toBe(0);
  });
});

for (const reason of ["abort", "timeout"] as const) {
  test(`non-PTY ${reason} closes all four channels and rejects the result`, async () => {
    await fixture("stream-hang", async (client, _controls, _projects, channels) => {
      const controller = new AbortController();
      const session = await client.execStream("fixture", ["cat"], { command: [], signal: controller.signal, timeoutMs: reason === "timeout" ? 50 : 1000 });
      session.stdout.resume(); session.stderr.resume();
      if (reason === "abort") controller.abort();
      await expect(session.result).rejects.toThrow(reason === "abort" ? /cancelled/ : /timed out/);
      await expect.poll(() => channels.size).toBe(0);
    });
  });
}

for (const mode of ["reject", "stall", "early-close"] as const) {
  test(`PTY ${mode} during control handshake cleans the already connected data channel`, async () => {
    await fixture(mode, async (client, _controls, _projects, channels) => {
      await expect(client.execInteractive("fixture", ["true"])).rejects.toThrow(/handshake|setup/);
      await expect.poll(() => channels.size).toBe(0);
    });
  });
}

test("PTY output EOF closes its data channel without requiring operation completion", async () => {
  await fixture("normal", async (client, _controls, _projects, channels) => {
    const session = await client.execInteractive("fixture", ["true"]);
    try {
      const closed = new Promise<void>((resolve) => session.dataWs.once("close", () => resolve()));
      session.dataWs.send("", { binary: false });
      await closed;
      expect(session.dataWs.readyState).toBe(3);
    } finally { session.close(); }
    await expect.poll(() => channels.size).toBe(0);
  });
});

test("real guest PTY accepts input, applies resize and delivers control signal", async () => {
  test.skip(process.env.INCUS_EXEC_TEST !== "true", "Explicit disposable Incus PTY acceptance");
  test.setTimeout(600_000);
  const client = new IncusClient({ endpoint: "https://127.0.0.1:18443", project: "agentor",
    clientCertPath: "/workspace/agentor-incus-tls/client.crt", clientKeyPath: "/workspace/agentor-incus-tls/client.key",
    serverCertPath: "/workspace/agentor-incus-tls/server.crt" });
  const nonce = randomUUID(), name = `agentor-pty-${nonce}`;
  let session: Awaited<ReturnType<IncusClient["execInteractive"]>> | undefined;
  let submitted = false, primaryFailure = false;
  try {
    const image = await client.getImageAlias(process.env.INCUS_EXEC_IMAGE || "agentor-worker-phase6-candidate");
    submitted = true;
    await client.createInstance({ name, type: "virtual-machine", profiles: [], source: { type: "image", fingerprint: image.target },
      config: { "user.agentor.test": nonce, "security.secureboot": "false", "limits.memory": "2GiB", "limits.cpu": "2" },
      devices: { root: { type: "disk", path: "/", pool: "default" },
        eth0: { type: "nic", name: "eth0", network: "incusbr0", "security.ipv4_filtering": "true", "security.ipv6_filtering": "true", "security.mac_filtering": "true" } } });
    await client.startInstance(name);
    await expect.poll(async () => {
      try { return (await client.exec(name, ["true"])).returnCode; } catch { return -1; }
    }, { timeout: 120_000 }).toBe(0);
    const script = `import os,signal,sys
def size(*args):
 s=os.get_terminal_size(); print('SIZE:%dx%d'%(s.columns,s.lines),flush=True)
def stop(*args):
 print('TERM',flush=True); sys.exit(42)
signal.signal(signal.SIGWINCH,size)
signal.signal(signal.SIGTERM,stop)
for line in sys.stdin:
 print('INPUT:'+line.strip(),flush=True)
`;
    session = await client.execInteractive(name, ["python3", "-u", "-c", script], { command: [], user: 1000, group: 1000, cwd: "/home/agent" });
    let output = "";
    session.dataWs.on("message", (bytes) => { output += bytes.toString(); });
    await expect.poll(() => { session!.dataWs.send(Buffer.from("inspect\n"), { binary: true }); return output; }, { timeout: 15_000 }).toContain("INPUT:inspect");
    session.resize(120, 40);
    await expect.poll(() => output, { timeout: 10_000 }).toContain("SIZE:120x40");
    session.sendSignal(15);
    await expect.poll(() => output, { timeout: 10_000 }).toContain("TERM");
    const result = await client.waitForOperation(session.operationId);
    expect(result.metadata?.return).toBe(42);
    const binary = await client.execStream(name, ["python3", "-c", "import sys; data=sys.stdin.buffer.read(); sys.stdout.buffer.write(data); sys.stderr.buffer.write(bytes([255,0,13,10])); sys.exit(23)"], { command: [], user: 1000, group: 1000 });
    const collect = async (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(Buffer.from(chunk));
      return Buffer.concat(chunks);
    };
    const outputs = Promise.all([collect(binary.stdout), collect(binary.stderr)]);
    const payload = Buffer.from([0,255,10,13,128,0]);
    try {
      binary.stdin.end(payload);
      expect(await outputs).toEqual([payload, Buffer.from([255,0,13,10])]);
      expect(await binary.result).toBe(23);
    } finally { binary.close(); }
    for (let i = 0; i < 5; i++) {
      const fast = await client.execStream(name, ["printf", "fast-output"], { command: [], user: 1000, group: 1000 });
      try {
        fast.stderr.resume();
        const chunks: Buffer[] = [];
        for await (const chunk of fast.stdout) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString()).toBe("fast-output");
        expect(await fast.result).toBe(0);
      } finally { fast.close(); }
    }
  } catch (error) { primaryFailure = true; throw error; }
  finally {
    session?.close();
    try {
      if (submitted) {
        const instance = await client.getInstance(name).catch((error) => { if (error.statusCode === 404) return undefined; throw error; });
        if (instance) {
          if (instance.config["user.agentor.test"] !== nonce) throw new Error("Refusing foreign PTY fixture cleanup");
          await client.stopInstance(name, { force: true });
          await client.deleteInstance(name);
        }
      }
    } catch (error) {
      if (!primaryFailure) throw error;
      console.error("PTY fixture cleanup failed; original failure retained", name);
    } finally { client.dispose(); }
  }
});
