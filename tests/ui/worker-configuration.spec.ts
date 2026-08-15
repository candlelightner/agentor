import { test, expect, type Page, type Request } from "@playwright/test";
import { goToDashboard } from "../helpers/ui-helpers";

const workerId = "11111111-1111-4111-8111-111111111111";
const worker = {
  id: workerId,
  userId: "owner-config-ui",
  containerId: "a".repeat(64),
  containerName: `agentor-worker-${workerId}`,
  displayName: "Configuration UI Worker",
  imageName: "agentor-worker:latest",
  imageId: `sha256:${"b".repeat(64)}`,
  status: "running",
  environmentId: "default-env-ui",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  pendingRebuild: false,
  excludedGlobalEnvVarKeys: ["CUSTOM_DISABLED"],
  excludedGroupEnvVarKeys: ["GROUP_DISABLED"],
};

const forbiddenSecret = "NEVER_RETURN_THIS_SECRET_VALUE";
const forbiddenFileContent = "NEVER_RETURN_THIS_FILE_CONTENT";

const configurationResponse = {
  local: {
    variables: [{ key: "LOCAL_VISIBLE", value: "visible-local-value" }],
    secrets: [{ key: "WORKER_TOKEN", configured: true }],
    secretFiles: [
      { name: "service-key", path: "service/key.pem", configured: true },
    ],
  },
  effective: [
    {
      key: "ORCHESTRATOR_URL",
      source: "orchestrator",
      type: "secret",
      masked: true,
    },
    {
      key: "USER_VISIBLE",
      value: "user-visible-value",
      source: "user",
      type: "variable",
    },
    {
      key: "ENVIRONMENT_TOKEN",
      source: "environment",
      type: "secret",
      masked: true,
    },
    {
      key: "LOCAL_VISIBLE",
      value: "visible-local-value",
      source: "worker",
      type: "variable",
      overriddenScopes: [
        { source: "environment", type: "variable", masked: false },
        { source: "user", type: "variable", masked: false },
      ],
    },
    { key: "WORKER_TOKEN", source: "worker", type: "secret", masked: true },
  ],
  pendingRebuild: false,
};

async function mockDashboard(page: Page) {
  // Match both create-time discovery and worker-scoped discovery with a query
  // string. Playwright's exact glob does not include `?workerId=...`.
  await page.route(/\/api\/account\/env-var-keys(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { keys: ["OPENAI_API_KEY", "CUSTOM_ENABLED", "CUSTOM_DISABLED"], predefinedKeys: ["OPENAI_API_KEY"], customKeys: ["CUSTOM_ENABLED", "CUSTOM_DISABLED"], groupKeys: route.request().url().includes("workerId=") ? ["GROUP_ENABLED", "GROUP_DISABLED"] : [] } }),
  );
  await page.route("**/api/containers", async (route) => {
    if (route.request().method() === "POST") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([worker]),
    });
  });
  await page.route("**/api/environments", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([
        {
          id: "default-env-ui",
          name: "Default",
          builtIn: true,
          cpuLimit: 0,
          memoryLimit: "",
          networkMode: "full",
          allowedDomains: [],
          includePackageManagerDomains: false,
          dockerEnabled: true,
          envVars: "",
          setupScript: "",
          exposeApis: { portMappings: true, domainMappings: true, usage: true },
          enabledCapabilityIds: null,
          enabledInstructionIds: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ]),
    }),
  );
  await page.route("**/api/containers/generate-name", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ displayName: "suggested-worker" }),
    }),
  );
  await page.route(
    `**/api/containers/${workerId}/configuration`,
    async (route) => {
      if (route.request().method() === "PUT") return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(configurationResponse),
      });
    },
  );
  await page.route("**/api/port-mappings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/api/domain-mappings", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route(`**/api/containers/${workerId}/apps`, (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
}

async function openCreateConfiguration(page: Page) {
  await goToDashboard(page);
  await page.getByRole("button", { name: /New Worker/i }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByText("Worker-local variables and secrets", { exact: true })
    .click();
  const editor = dialog.locator('[data-testid="worker-configuration-editor"]');
  await expect(editor).toBeVisible();
  return { dialog, editor };
}

async function openSettingsConfiguration(page: Page) {
  await goToDashboard(page);
  await page.getByText("Configuration UI Worker", { exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Worker-local variables and secrets");
  const editor = dialog.locator('[data-testid="worker-configuration-editor"]');
  await expect(editor).toBeVisible();
  return { dialog, editor };
}

test.beforeEach(async ({ page }) => {
  await mockDashboard(page);
});

test("create selects account variables by default and submits only excluded key names", async ({ page }) => {
  let createBody: any;
  await page.route("**/api/containers", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createBody = route.request().postDataJSON();
    return route.fulfill({ status: 201, json: worker });
  });
  await goToDashboard(page);
  await page.getByRole("button", { name: /New Worker/i }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Predefined", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Custom", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel("Inherit OPENAI_API_KEY")).toBeChecked();
  await expect(dialog.getByLabel("Inherit CUSTOM_ENABLED")).toBeChecked();
  await dialog.getByLabel("Inherit CUSTOM_ENABLED").uncheck();
  await dialog.getByRole("button", { name: "Create", exact: true }).click();
  expect(createBody.excludedGlobalEnvVarKeys).toEqual(["CUSTOM_ENABLED"]);
  expect(JSON.stringify(createBody)).not.toContain("NEVER_RETURN_THIS_SECRET_VALUE");
});

test("settings reflects saved exclusions and submits changed key names", async ({ page }) => {
  let patchBody: any;
  await page.route(`**/api/containers/${workerId}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    patchBody = route.request().postDataJSON();
    return route.fulfill({ json: { ...worker, ...patchBody, pendingRebuild: true } });
  });
  const { dialog } = await openSettingsConfiguration(page);
  await expect(dialog.getByLabel("Inherit CUSTOM_DISABLED")).not.toBeChecked();
  await expect(dialog.getByLabel("Inherit OPENAI_API_KEY")).toBeChecked();
  await expect(dialog.getByLabel("Inherit group GROUP_DISABLED")).not.toBeChecked();
  await expect(dialog.getByLabel("Inherit group GROUP_ENABLED")).toBeChecked();
  await dialog.getByLabel("Inherit OPENAI_API_KEY").uncheck();
  await dialog.getByLabel("Inherit group GROUP_ENABLED").uncheck();
  await expect(dialog.getByRole("button", { name: "Save & Rebuild" })).toBeVisible();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  expect(patchBody.excludedGlobalEnvVarKeys).toEqual(["CUSTOM_DISABLED", "OPENAI_API_KEY"]);
  expect(patchBody.excludedGroupEnvVarKeys).toEqual(["GROUP_DISABLED", "GROUP_ENABLED"]);
});

test("create modal exposes bulk variables, masked secrets, secret files, and the safe root explanation", async ({
  page,
}) => {
  const { editor } = await openCreateConfiguration(page);
  await expect(editor).toContainText(
    "Precedence: orchestrator → user → environment → worker",
  );
  await expect(editor).toContainText("/run/agentor-secrets");
  await expect(editor).toContainText("never stored in the workspace");
  await expect(editor.getByPlaceholder("# comments allowed")).toBeVisible();

  await editor.getByRole("button", { name: "Add masked secret" }).click();
  const secretValue = editor.getByPlaceholder("write-only value");
  await expect(secretValue).toHaveAttribute("type", "password");
  await editor.getByRole("button", { name: "Add secret file" }).click();
  await expect(editor.getByPlaceholder("write-only content")).toHaveAttribute(
    "type",
    "password",
  );
});

test("create request carries bulk/local configuration while secret inputs remain masked", async ({
  page,
}) => {
  let createRequest: Request | undefined;
  await page.route("**/api/containers", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createRequest = route.request();
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(worker),
    });
  });
  const { dialog, editor } = await openCreateConfiguration(page);
  await dialog.getByLabel("Display name").fill("Configured worker");
  await editor
    .getByPlaceholder("# comments allowed")
    .fill('BULK_ONE=bulk-value\nBULK_TWO="two words"');
  await editor.getByRole("button", { name: "Add variable" }).click();
  await editor.getByPlaceholder("VARIABLE_NAME").fill("LOCAL_ONE");
  await editor.getByPlaceholder("value").fill("local-value");
  await editor.getByRole("button", { name: "Add masked secret" }).click();
  await editor.getByPlaceholder("SECRET_NAME").fill("WORKER_TOKEN");
  await editor.getByPlaceholder("write-only value").fill(forbiddenSecret);
  await editor.getByRole("button", { name: "Add secret file" }).click();
  await editor.getByPlaceholder("logical name").fill("service-key");
  await editor.getByPlaceholder("relative/path").fill("service/key.pem");
  await editor
    .getByPlaceholder("write-only content")
    .fill(forbiddenFileContent);
  await expect(editor.getByPlaceholder("write-only value")).toHaveAttribute(
    "type",
    "password",
  );
  await expect(editor.getByPlaceholder("write-only content")).toHaveAttribute(
    "type",
    "password",
  );
  await dialog.getByRole("button", { name: "Create", exact: true }).click();

  expect(createRequest).toBeTruthy();
  const body = createRequest!.postDataJSON();
  expect(body.workerConfiguration).toMatchObject({
    envFile: 'BULK_ONE=bulk-value\nBULK_TWO="two words"',
    variables: [{ key: "LOCAL_ONE", value: "local-value" }],
    secrets: [{ key: "WORKER_TOKEN", value: forbiddenSecret }],
    secretFiles: [
      {
        name: "service-key",
        path: "service/key.pem",
        content: forbiddenFileContent,
      },
    ],
  });
});

test("settings loads inherited sources and configured secret names without returning values", async ({
  page,
}) => {
  const { dialog, editor } = await openSettingsConfiguration(page);
  await expect(editor).toContainText(
    "Configured secrets: WORKER_TOKEN (values cannot be read back)",
  );
  await expect(editor).toContainText(
    "Configured secret files: service-key → service/key.pem",
  );
  await editor.getByText("Effective environment preview").click();
  await expect(editor).toContainText("orchestrator");
  await expect(editor).toContainText("user");
  await expect(editor).toContainText("environment");
  await expect(editor).toContainText("worker");
  await expect(editor).toContainText("overrides environment, user");
  await expect(editor).toContainText("USER_VISIBLE");
  await expect(editor).toContainText("user-visible-value");
  await expect(editor).toContainText("••••••••");

  const rendered = await dialog.textContent();
  expect(rendered).not.toContain(forbiddenSecret);
  expect(rendered).not.toContain(forbiddenFileContent);
  expect(await page.content()).not.toContain(forbiddenSecret);
  expect(await page.content()).not.toContain(forbiddenFileContent);
});

test("saving new values sends only write-only replacements and reports pending rebuild", async ({
  page,
}) => {
  let savedBody: any;
  await page.route(
    `**/api/containers/${workerId}/configuration`,
    async (route) => {
      if (route.request().method() !== "PUT") return route.fallback();
      savedBody = route.request().postDataJSON();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...configurationResponse,
          pendingRebuild: true,
        }),
      });
    },
  );
  const { editor } = await openSettingsConfiguration(page);
  await editor
    .getByPlaceholder("# comments allowed")
    .fill("SETTINGS_BULK=from-settings");
  await editor.getByRole("button", { name: "Add masked secret" }).click();
  await editor.getByPlaceholder("SECRET_NAME").fill("REPLACEMENT_TOKEN");
  await editor.getByPlaceholder("write-only value").fill(forbiddenSecret);
  await editor
    .getByRole("button", { name: "Save worker configuration" })
    .click();

  await expect(editor).toContainText(
    "Saved. Rebuild the worker to apply these changes.",
  );
  expect(savedBody).toMatchObject({
    envFile: "SETTINGS_BULK=from-settings",
    variables: [{ key: "LOCAL_VISIBLE", value: "visible-local-value" }],
    secrets: [{ key: "REPLACEMENT_TOKEN", value: forbiddenSecret }],
  });
  expect(JSON.stringify(savedBody)).not.toContain("service/key.pem");
  expect(JSON.stringify(savedBody)).not.toContain(forbiddenFileContent);
  await expect(editor).toContainText("Configured secrets: WORKER_TOKEN");
  expect(await editor.textContent()).not.toContain(forbiddenSecret);
});
