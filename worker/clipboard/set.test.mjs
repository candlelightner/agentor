import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const bin = await mkdtemp(join(tmpdir(), "agentor-clipboard-test-"));
await writeFile(
  join(bin, "ps"),
  `#!/bin/sh
printf '%s\n' 'x11vnc -display :99 -rfbport 5900' 'Xvfb :20 -screen 0 1920x1080x24'
`,
);
await writeFile(
  join(bin, "xclip"),
  `#!/bin/sh
[ "\${DISPLAY:-}" = ':20' ] || exit 1
exit 0
`,
);
await chmod(join(bin, "ps"), 0o755);
await chmod(join(bin, "xclip"), 0o755);

const result = spawnSync("bash", [new URL("./set.sh", import.meta.url).pathname, "text/plain"], {
  input: "clipboard-test",
  env: { ...process.env, DISPLAY: ":99", PATH: `${bin}:${process.env.PATH}` },
  encoding: "utf8",
});
assert.equal(result.status, 0, result.stderr);
console.log("clipboard display fallback: ok");
