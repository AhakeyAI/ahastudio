import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface OrchestrationBinShim {
  binDir: string;
  cliScriptPath: string;
  applyToEnv: (env: Record<string, string>) => Record<string, string>;
}

export function resolveDefaultOrchestrationCliPath(moduleUrlOrPath: string = import.meta.url): string {
  const filePath = moduleUrlOrPath.startsWith('file://') ? fileURLToPath(moduleUrlOrPath) : moduleUrlOrPath;
  const here = dirname(filePath);
  return join(here, 'aha-orchestration-cli.cjs').replace(/\.asar([\\/])/, '.asar.unpacked$1');
}

export function resolveDefaultOrchestrationMcpServerPath(
  moduleUrlOrPath: string = import.meta.url
): string {
  const filePath = moduleUrlOrPath.startsWith('file://') ? fileURLToPath(moduleUrlOrPath) : moduleUrlOrPath;
  const here = dirname(filePath);
  return join(here, 'aha-mcp-server.cjs').replace(/\.asar([\\/])/, '.asar.unpacked$1');
}

export function findPathEnvKey(env: Record<string, string | undefined>): string {
  return Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
}

export function createOrchestrationBinShim(options: {
  binDir: string;
  nodeExecPath?: string;
  cliScriptPath?: string;
}): OrchestrationBinShim {
  const binDir = options.binDir;
  const nodeExec = options.nodeExecPath ?? process.execPath;
  const cliScriptPath = options.cliScriptPath ?? resolveDefaultOrchestrationCliPath();

  mkdirSync(binDir, { recursive: true });

  const cmdShimPath = join(binDir, 'aha.cmd');
  const cmdContent = [
    '@echo off',
    'setlocal',
    'set ELECTRON_RUN_AS_NODE=1',
    `"${nodeExec}" "${cliScriptPath}" %*`,
    '',
  ].join('\r\n');
  writeFileSync(cmdShimPath, cmdContent, 'utf8');

  const shShimPath = join(binDir, 'aha');
  const escapedNode = nodeExec.replace(/'/g, "'\\''");
  const escapedScript = cliScriptPath.replace(/'/g, "'\\''");
  const shContent = [
    '#!/bin/sh',
    `exec env ELECTRON_RUN_AS_NODE=1 '${escapedNode}' '${escapedScript}' "$@"`,
    '',
  ].join('\n');
  writeFileSync(shShimPath, shContent, 'utf8');
  if (process.platform !== 'win32') {
    chmodSync(shShimPath, 0o755);
  }

  return {
    binDir,
    cliScriptPath,
    applyToEnv: (env) => {
      const hasEnvPathKey = Object.keys(env).some((key) => key.toUpperCase() === 'PATH');
      const pathKey = hasEnvPathKey ? findPathEnvKey(env) : findPathEnvKey(process.env);
      const existingPath = env[pathKey] ?? process.env[pathKey] ?? '';
      const segments = existingPath.split(delimiter).filter(Boolean);
      const nextPath = segments.includes(binDir)
        ? existingPath
        : existingPath
          ? `${binDir}${delimiter}${existingPath}`
          : binDir;
      const cleanedEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(env)) {
        if (k.toUpperCase() !== 'PATH') {
          cleanedEnv[k] = v;
        }
      }
      return {
        ...cleanedEnv,
        AHA_ORCHESTRATION_CLI: 'aha',
        AHA_ORCHESTRATION_CLI_SCRIPT: cliScriptPath,
        [pathKey]: nextPath,
      };
    },
  };
}
