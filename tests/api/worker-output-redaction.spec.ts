import { expect, test } from "@playwright/test";
import { redactManagedBufferSlice, redactManagedOutput, workerOutputRedactionValues } from "../../orchestrator/server/utils/worker-output-redaction";

test("selects only managed sensitive values for the target worker", async () => {
  const calls: string[] = [];
  const values = await workerOutputRedactionValues(
    { id: "worker-a", userId: "owner-a", environmentId: "environment-a" },
    {
      localValues: async (userId, workerId) => {
        calls.push(`local:${userId}:${workerId}`);
        return [
          { kind: "secret", key: "LOGIN", value: "local-secret" },
          { kind: "secretFile", key: "CONFIG", value: "secret-file-content" },
          { kind: "variable", key: "CUSTOM_API_KEY", value: "local-api-key" },
          { kind: "variable", key: "COLOR", value: "ordinary-local" },
          { kind: "secret", key: "PIN", value: "123" },
          { kind: "secret", key: "DUPLICATE", value: "global-token" },
        ];
      },
      userValues: (userId) => {
        calls.push(`user:${userId}`);
        return [{ key: "GITHUB_TOKEN", value: "global-token" }, { key: "THEME", value: "ordinary-global" }];
      },
      environmentText: (environmentId) => {
        calls.push(`environment:${environmentId}`);
        return "ROUTER_PASSWORD=environment-password\nDISPLAY_COLOR=ordinary-environment";
      },
    },
  );
  expect(calls).toEqual(["local:owner-a:worker-a", "user:owner-a", "environment:environment-a"]);
  expect(values).toEqual(["environment-password", "secret-file-content", "local-api-key", "local-secret", "global-token"]);
  expect(redactManagedOutput(
    "local-secret secret-file-content local-api-key ordinary-local global-token ordinary-global environment-password ordinary-environment 123",
    values,
  )).toEqual({
    output: "[REDACTED] [REDACTED] [REDACTED] ordinary-local [REDACTED] ordinary-global [REDACTED] ordinary-environment 123",
    redacted: 5,
  });
});

test("malformed environment configuration is ignored gracefully", async () => {
  await expect(workerOutputRedactionValues(
    { id: "worker-a", userId: "owner-a", environmentId: "environment-a" },
    {
      localValues: async () => [{ kind: "secret", key: "LOGIN", value: "local-secret" }],
      userValues: () => [],
      environmentText: () => "not dotenv",
    },
  )).resolves.toEqual(["local-secret"]);
});

test("redacts exact literals longest first without regex interpretation", () => {
  expect(redactManagedOutput("token-long token a.b* a.b*", ["token", "token-long", "a.b*", "a.b*", "abc"])).toEqual({
    output: "[REDACTED] [REDACTED] [REDACTED] [REDACTED]", redacted: 4,
  });
});

test("console slices withhold split secrets until they can be redacted", () => {
  const first = redactManagedBufferSlice(Buffer.from("visible:secret-"), 0, ["secret-value"]);
  expect(first).toMatchObject({ output: "visible:", start: 0, safeEnd: 8 });
  expect(redactManagedBufferSlice(Buffer.from("visible:secret-value:done"), first.safeEnd, ["secret-value"]))
    .toMatchObject({ output: "[REDACTED]:done", start: 8, safeEnd: 25, redacted: 1 });
});

test("console slices cannot start inside a complete secret", () => {
  const result = redactManagedBufferSlice(Buffer.from("before:secret-value:after"), 10, ["secret-value"]);
  expect(result).toMatchObject({ output: "[REDACTED]:after", start: 7, safeEnd: 25, redacted: 1 });
  expect(result.output).not.toContain("ret-value");
});

test("console ring-buffer trimming redacts a retained secret suffix", () => {
  const result = redactManagedBufferSlice(
    Buffer.from("ret-value:after"), 0, ["secret-value"], true,
  );
  expect(result.output).toBe("[REDACTED]:after");
  expect(result.output).not.toContain("ret-value");
});
