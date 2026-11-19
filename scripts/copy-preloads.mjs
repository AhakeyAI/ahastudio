// Copy non-TS runtime files referenced at runtime in dist-electron/.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  ['electron/preload.cjs', 'dist-electron/preload.cjs'],
  ['electron/agent/agent-hook-relay.cjs', 'dist-electron/agent/agent-hook-relay.cjs'],
  ['electron/orchestration/aha-orchestration-cli.cjs', 'dist-electron/orchestration/aha-orchestration-cli.cjs'],
  ['electron/orchestration/aha-mcp-server.cjs', 'dist-electron/orchestration/aha-mcp-server.cjs'],
  ['electron/terminal-daemon/windows-pipe-acl.ps1', 'dist-electron/terminal-daemon/windows-pipe-acl.ps1'],
];

for (const [srcRel, destRel] of files) {
  const src = join(root, srcRel);
  const dest = join(root, destRel);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
}
