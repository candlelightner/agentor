import type { AuthContext } from "./auth-helpers";
import type { PluginDefinitionRecord } from "./plugin-definition-store";
import type { PluginInstallationRecord } from "./plugin-installation-store";

/** Pure authorization boundary shared by HTTP and every WS connection. No
 * client-supplied backend, display number, container name, or port is accepted. */
export function resolvePluginDesktop(
  auth: AuthContext | null,
  worker: { id: string; userId: string; status: string; containerId: string; containerName: string } | undefined,
  installation: PluginInstallationRecord | undefined,
  definition: PluginDefinitionRecord | undefined,
  target: { workerId: string; installationId: string; actionId: string; displayId: string },
) {
  if (!auth) throw Object.assign(new Error("Sign in to open this desktop."), { statusCode: 401 });
  const action = definition?.manifest.actions?.find(a => a.id === target.actionId);
  const mode = definition?.manifest.resources?.display?.mode;
  if (!worker || worker.id !== target.workerId || (auth.user.role !== "admin" && worker.userId !== auth.user.id) ||
      !installation || installation.id !== target.installationId || installation.workerId !== worker.id || installation.userId !== worker.userId ||
      !definition || definition.id !== installation.definitionId || definition.definitionHash !== installation.definitionHash ||
      action?.kind !== "desktop" || action.displayId !== target.displayId || target.displayId !== "primary" ||
      (mode !== "isolated" && mode !== "shared"))
    throw Object.assign(new Error("Plugin desktop not found."), { statusCode: 404 });
  const display = installation.allocations?.display;
  if (display !== undefined && (!Number.isInteger(display) || (mode === "shared" ? display !== 99 : display < 100 || display > 999)))
    throw Object.assign(new Error("Plugin display allocation is invalid."), { statusCode: 409 });
  const ready = worker.status === "running" && installation.desiredEnabled && installation.observed.ready &&
    installation.observed.runtimeGeneration === worker.containerId && display !== undefined &&
    (mode === "shared" || installation.observed.desktop?.viewerReady === true && installation.observed.desktop.display === display);
  return { worker, installation, definition, action, mode, display, ready };
}
