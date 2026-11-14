// ── Binary resolution from PATH ────────────────────────────────────────────────
// Tries to find a binary by name: system PATH first, then known locations.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter } from 'node:path';

/** Standard binary directories per platform. The Electron main process
 *  launched from a .app bundle often has a minimal or empty PATH — we always
 *  augment the which/where call and the filesystem candidate list with these
 *  locations so freshly-installed CLIs are discoverable without a relaunch. */
function getStandardBinDirs(): string[] {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  if (process.platform === 'win32') {
    const dirs: string[] = [];
    // npm global installs
    if (process.env.APPDATA) dirs.push(`${process.env.APPDATA}\\npm`);
    // Antigravity CLI (agy) user-local install
    if (process.env.LOCALAPPDATA) dirs.push(`${process.env.LOCALAPPDATA}\\agy\\bin`);
    // Grok Build user-local install
    if (process.env.GROK_HOME) dirs.push(`${process.env.GROK_HOME}\\bin`);
    if (home) dirs.push(`${home}\\.grok\\bin`);
    // Scoop
    if (home) dirs.push(`${home}\\scoop\\shims`);
    // Chocolatey
    dirs.push('C:\\ProgramData\\chocolatey\\bin');
    return dirs;
  }
  const dirs = ['/usr/local/bin', '/opt/homebrew/bin'];
  if (process.env.GROK_HOME) dirs.push(`${process.env.GROK_HOME}/bin`);
  if (home) {
    dirs.push(
      `${home}/.local/bin`,
      `${home}/.bin`,
      `${home}/bin`,
      `${home}/.grok/bin`,
      // Canonical location used by the current Kimi Code installer. Finder-
      // launched .app processes do not source ~/.zshrc, so this must be an
      // explicit candidate rather than relying on the user's interactive PATH.
      `${home}/.kimi-code/bin`,
    );
    // npm global bin when the user has a custom prefix (~/.npm-global is the
    // most common convention; also covers npmrc `prefix` set to ~/.npm-global).
    dirs.push(`${home}/.npm-global/bin`);
  }
  // Dynamically resolve npm global prefix via config (fast — reads ~/.npmrc
  // and built-in defaults without starting the full npm process). Cached
  // after first call so repeated resolutions don't re-spawn.
  const npmBin = resolveNpmGlobalBin();
  if (npmBin && !dirs.includes(npmBin)) dirs.push(npmBin);
  return dirs;
}

/** Resolve the npm global `bin` directory by running `npm config get prefix`.
 *  Returns null if npm isn't available or the command fails. Cached after
 *  first call — the global prefix doesn't change at runtime. */
let npmGlobalBinCache: string | null | undefined;
function resolveNpmGlobalBin(): string | null {
  if (npmGlobalBinCache !== undefined) return npmGlobalBinCache;
  try {
    const lookupCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const result = execFileSync(lookupCmd, ['config', 'get', 'prefix'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PATH: process.env.PATH },
    });
    const prefix = result.trim();
    if (prefix && existsSync(prefix)) {
      const binDir = process.platform === 'win32' ? prefix : `${prefix}/bin`;
      npmGlobalBinCache = existsSync(binDir) ? binDir : null;
      return npmGlobalBinCache;
    }
  } catch { /* npm not available */ }
  npmGlobalBinCache = null;
  return null;
}

/** Build a PATH string that includes the inherited PATH plus standard dirs. */
export function augmentedPath(): string {
  const parts = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const dir of getStandardBinDirs()) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(delimiter);
}

export function resolveBinaryFromPath(binaryName: string): string | null {
  // Validate binaryName: only alphanumeric, hyphens, underscores, dots allowed
  if (!/^[a-zA-Z0-9._-]+$/.test(binaryName)) {
    return null;
  }

  // 1. Check system PATH via execFileSync (no shell — prevents command injection)
  //    Windows uses `where`, Unix uses `which`.
  try {
    const lookupCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(lookupCmd, [binaryName], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, PATH: augmentedPath() },
    });
    // npm installs a Unix Shell script beside its Windows .cmd launcher;
    // `where` can list that extensionless script first. It is not a Win32
    // executable (ConPTY fails asynchronously with error 193). Keep PATH
    // order, but only select launchers supported on the current platform.
    const found = result.split(/\r?\n/).map((line) => line.trim()).find((candidate) =>
      (process.platform !== 'win32' || /\.(exe|com|cmd|bat)$/i.test(candidate))
      && existsSync(candidate));
    if (found) return found;
  } catch { /* not found in PATH */ }

  // 2. Known install locations (platform-specific)
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

  if (process.platform === 'win32') {
    const winCandidates = [
      // Standard Program Files installs
      `C:\\Program Files\\${binaryName}\\${binaryName}.exe`,
      `C:\\Program Files (x86)\\${binaryName}\\${binaryName}.exe`,
      // User-local installs
      process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\${binaryName}\\${binaryName}.exe` : '',
      process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\${binaryName}\\bin\\${binaryName}.exe` : '',
      process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\${binaryName}\\${binaryName}.exe` : '',
      process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Programs\\${binaryName}\\bin\\${binaryName}.exe` : '',
      // npm global installs (multiple extensions)
      `${process.env.APPDATA}\\npm\\${binaryName}.cmd`,
      `${process.env.APPDATA}\\npm\\${binaryName}.exe`,
      // Scoop shims
      `${home}\\scoop\\shims\\${binaryName}.exe`,
      `${home}\\scoop\\apps\\${binaryName}\\current\\${binaryName}.exe`,
      // Kimi installer canonical native Windows executable.
      `${home}\\.kimi-code\\bin\\${binaryName}.exe`,
      // Grok Build canonical native Windows executable.
      process.env.GROK_HOME ? `${process.env.GROK_HOME}\\bin\\${binaryName}.exe` : '',
      home ? `${home}\\.grok\\bin\\${binaryName}.exe` : '',
      // Chocolatey
      `C:\\ProgramData\\chocolatey\\bin\\${binaryName}.exe`,
    ];
    for (const candidate of winCandidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
  } else {
    // macOS / Linux candidates
    const candidates = [
      `/usr/local/bin/${binaryName}`,
      `/opt/homebrew/bin/${binaryName}`,
      `${home}/.local/bin/${binaryName}`,
      `${home}/.bin/${binaryName}`,
      `${home}/bin/${binaryName}`,
      process.env.GROK_HOME ? `${process.env.GROK_HOME}/bin/${binaryName}` : '',
      home ? `${home}/.grok/bin/${binaryName}` : '',
      `${home}/.kimi-code/bin/${binaryName}`,
      // npm global bin when user has custom prefix (~/.npm-global)
      `${home}/.npm-global/bin/${binaryName}`,
      // Homebrew npm global installs on Apple Silicon
      `/opt/homebrew/lib/node_modules/${binaryName}/bin/${binaryName}`,
      // npm global prefix on macOS (Intel) / Linux
      `/usr/local/lib/node_modules/${binaryName}/bin/${binaryName}`,
      `/usr/lib/node_modules/${binaryName}/bin/${binaryName}`,
      // npm global installs under custom prefix
      `${home}/.npm-global/lib/node_modules/${binaryName}/bin/${binaryName}`,
      // Linux-specific
      `/snap/bin/${binaryName}`,
    ];
    for (const candidate of candidates) {
      if (candidate && existsSync(candidate)) return candidate;
    }
  }

  return null;
}
