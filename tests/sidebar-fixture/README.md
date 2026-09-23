# Sidebar visual QA fixture

This local Nuxt app renders the production `AppSidebar`, `ThemeToggle`, worker cards, and nested group components with real Nuxt UI buttons, icons, Tailwind classes, and the production stylesheet. Its composables and API data are local fixtures; it does not start the Agentor orchestrator or contact other workers. Only modal and unrelated tab-content components are empty placeholders.

From `tests/`, run:

```bash
./node_modules/.bin/playwright test --config sidebar-fixture/playwright.config.ts
```

Playwright starts the fixture on `127.0.0.1:4180`, uses bundled Chromium when available (falling back to `/usr/bin/chromium`), and writes attached screenshots under `tests/test-results/`. The config creates a relative `nuxt/node_modules` symlink to the installed orchestrator dependencies if needed. The symlink and generated `.nuxt` files are ignored by Git.

The tests cover light/dark mode, admin/ordinary states, active gold/red worker cards, nested live and archived groups, real icons, the loaded Inter font, the 200 px minimum and 420 px width, theme switching, action emits, and narrow control overflow. The fixture explicitly includes the production app in Tailwind's source scan, and a computed grid-span assertion guards against incomplete utility generation.
