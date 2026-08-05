export type AdminWorkspaceStatus = "running" | "stopped";

export interface AdminWorkspace {
  id: string;
  kind: "administrative";
  trusted: true;
  status: AdminWorkspaceStatus;
  createdAt: string;
  updatedAt: string;
  image: {
    name: string;
    digest: string;
    promoted: boolean;
  };
  presentation: {
    terminalTheme: string;
    banner: string;
    promptMarker: string;
    browserTitle: string;
    environmentMarker: string;
    warningBeforePrivilegedActions: boolean;
  };
  services: Array<"terminal" | "editor" | "desktop" | string>;
}

function adminError(error: any, fallback: string) {
  return (
    error?.data?.statusMessage ||
    error?.data?.message ||
    error?.message ||
    fallback
  );
}

export function useAdminWorkspace() {
  const workspace = ref<AdminWorkspace | null>(null);
  const loading = ref(false);
  const action = ref<"ensure" | "start" | "stop" | "rebuild" | "">("");
  const error = ref("");

  async function request(
    operation: Exclude<typeof action.value, "">,
    path: string,
    method: "GET" | "POST",
  ) {
    action.value = operation;
    error.value = "";
    try {
      workspace.value = await $fetch<AdminWorkspace>(path, { method });
      return workspace.value;
    } catch (cause) {
      error.value = adminError(
        cause,
        "Administrative workspace operation failed.",
      );
      throw cause;
    } finally {
      action.value = "";
    }
  }

  async function refresh() {
    loading.value = true;
    error.value = "";
    try {
      workspace.value = await $fetch<AdminWorkspace>("/api/admin/workspace");
      return workspace.value;
    } catch (cause) {
      error.value = adminError(
        cause,
        "Could not load the administrative workspace.",
      );
      throw cause;
    } finally {
      loading.value = false;
    }
  }

  const ensure = () => request("ensure", "/api/admin/workspace", "POST");
  const start = () => request("start", "/api/admin/workspace/start", "POST");
  const stop = () => request("stop", "/api/admin/workspace/stop", "POST");
  const rebuild = () =>
    request("rebuild", "/api/admin/workspace/rebuild", "POST");

  return {
    workspace,
    loading,
    action,
    error,
    refresh,
    ensure,
    start,
    stop,
    rebuild,
  };
}
