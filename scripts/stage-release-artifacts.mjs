#!/usr/bin/env node
// Copies distributable installers (and optional blockmaps) from release/ into
// release-artifacts/ so GitHub Actions uploads only end-user packages.

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PRIMARY_INSTALLER_RE = /\.(exe|dmg|AppImage)$/i;
const DISTRIBUTABLE_ASSET_RE = /\.(exe|dmg|AppImage|blockmap)$/i;

export function stageReleaseArtifacts({ releaseDir, outputDir }) {
  if (!existsSync(releaseDir)) {
    throw new Error(`Release output directory not found: ${releaseDir}`);
  }

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const entries = readdirSync(releaseDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && DISTRIBUTABLE_ASSET_RE.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const primaryInstallers = entries.filter((entry) => PRIMARY_INSTALLER_RE.test(entry.name));
  if (primaryInstallers.length === 0) {
    const seen = readdirSync(releaseDir).sort().join(', ') || '(empty)';
    throw new Error(
      `No distributable installer (.exe, .dmg, .AppImage) found in ${releaseDir}. Found: ${seen}`,
    );
  }

  const staged = [];
  for (const entry of entries) {
    const src = join(releaseDir, entry.name);
    const dest = join(outputDir, entry.name);
    copyFileSync(src, dest);
    staged.push({ name: entry.name, size: statSync(dest).size });
  }

  return staged;
}

function formatMiB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..');
  const releaseDir = resolve(process.argv[2] ?? join(repoRoot, 'release'));
  const outputDir = resolve(process.argv[3] ?? join(repoRoot, 'release-artifacts'));

  const staged = stageReleaseArtifacts({ releaseDir, outputDir });
  console.log(`[stage-release] staged ${staged.length} file(s) into ${outputDir}:`);
  for (const file of staged) {
    console.log(`  - ${file.name} (${formatMiB(file.size)})`);
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`[stage-release] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
