#!/usr/bin/env node
// Cross-platform runner for the node:test suite.
// Splits fast CI checks from the long real-Git adversarial-review E2E test,
// applies Windows ConPTY-safe concurrency, and strips ELECTRON_RUN_AS_NODE.

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LONG_E2E_TESTS = new Set([
  'orchestration-adversarial-review.test.mjs',
]);

export function discoverTestFiles(testsDir) {
  return readdirSync(testsDir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort((a, b) => a.localeCompare(b));
}

export function selectTestFiles(allFiles, mode) {
  if (mode === 'fast') {
    return allFiles.filter((file) => !LONG_E2E_TESTS.has(file));
  }
  if (mode === 'e2e') {
    return allFiles.filter((file) => LONG_E2E_TESTS.has(file));
  }
  return [...allFiles];
}

export function parseRunnerArgs(argv) {
  let mode = 'all';
  let concurrency = null;
  const extraNodeArgs = [];
  const explicitFiles = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fast') {
      mode = 'fast';
    } else if (arg === '--e2e') {
      mode = 'e2e';
    } else if (arg === '--all') {
      mode = 'all';
    } else if (arg.startsWith('--concurrency=')) {
      concurrency = arg.slice('--concurrency='.length);
    } else if (arg === '--concurrency' && i + 1 < argv.length) {
      concurrency = argv[++i];
    } else if (arg.startsWith('-')) {
      extraNodeArgs.push(arg);
    } else {
      explicitFiles.push(arg);
    }
  }

  return { mode, concurrency, extraNodeArgs, explicitFiles };
}

export function resolveConcurrency({ explicitConcurrency, envConcurrency, platform, fileCount }) {
  if (fileCount <= 1) return null;
  const raw = explicitConcurrency ?? envConcurrency;
  if (raw != null && raw !== '') {
    const parsed = Number.parseInt(String(raw), 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`Invalid test concurrency: ${raw}`);
    }
    return parsed;
  }
  // More than 2 parallel test files fight over ConPTY handles on Windows.
  return platform === 'win32' ? 2 : null;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(here, '..');
  const testsDir = join(repoRoot, 'tests');

  const { mode, concurrency, extraNodeArgs, explicitFiles } = parseRunnerArgs(process.argv.slice(2));
  const files = explicitFiles.length > 0
    ? explicitFiles
    : selectTestFiles(discoverTestFiles(testsDir), mode).map((name) => join('tests', name));

  if (files.length === 0) {
    console.error(`[run-tests] No test files matched mode "${mode}".`);
    process.exit(1);
  }

  const resolvedConcurrency = resolveConcurrency({
    explicitConcurrency: concurrency,
    envConcurrency: process.env.AHA_TEST_CONCURRENCY,
    platform: process.platform,
    fileCount: files.length,
  });

  const nodeArgs = ['--import', './tests/register-electron-stub.mjs', '--test'];
  if (resolvedConcurrency != null) {
    nodeArgs.push(`--test-concurrency=${resolvedConcurrency}`);
  }
  nodeArgs.push(...extraNodeArgs, ...files);

  const env = { ...process.env };
  // Unset inherited ELECTRON_RUN_AS_NODE so Electron-based daemon tests launch normally.
  delete env.ELECTRON_RUN_AS_NODE;

  console.log(
    `[run-tests] mode=${explicitFiles.length > 0 ? 'explicit' : mode} files=${files.length}` +
      (resolvedConcurrency != null ? ` concurrency=${resolvedConcurrency}` : ''),
  );

  const child = spawn(process.execPath, nodeArgs, {
    cwd: repoRoot,
    env,
    stdio: 'inherit',
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      process.stderr.write(`[run-tests] terminated by signal ${signal}\n`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });

  child.on('error', (error) => {
    process.stderr.write(`[run-tests] failed to spawn node: ${error.message}\n`);
    process.exit(1);
  });
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  main();
}
