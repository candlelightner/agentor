import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

const orchestrator = resolve(__dirname, '../../../orchestrator');

export default defineNuxtConfig({
  ssr: false,
  devtools: { enabled: false },
  modulesDir: [resolve(orchestrator, 'node_modules')],
  modules: [resolve(orchestrator, 'node_modules/@nuxt/ui/dist/module.mjs')],
  css: [resolve(__dirname, 'fixture.css')],
  colorMode: { preference: 'dark' },
  components: [
    { path: resolve(orchestrator, 'app/components'), pathPrefix: false, pattern: [
      'AppSidebar.vue', 'ThemeToggle.vue', 'ContainerCard.vue', 'WorkerRuntimeIcon.vue', 'WorkerEmergencyStopButton.vue', 'VcpuEditor.vue', 'AdminWorkspaceModal.vue',
      'WorkerGroupSidebarNode.vue', 'ArchivedWorkerGroupSidebarNode.vue', 'ArchivedWorkerCard.vue',
    ] },
    { path: resolve(__dirname, 'components'), pathPrefix: false },
  ],
  vite: { server: { fs: { allow: [orchestrator, __dirname, realpathSync(resolve(orchestrator, 'node_modules'))] } } },
  compatibilityDate: '2025-01-01',
});
