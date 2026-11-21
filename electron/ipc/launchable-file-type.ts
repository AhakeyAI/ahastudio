// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import { posix, win32 } from 'node:path';

/**
 * Extensions that Windows/macOS/Linux would execute, install, or follow if handed
 * directly to shell.openPath. Revealed in the file manager instead of executed.
 */
export const BLOCKED_LAUNCHABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe', 'com', 'scr', 'pif', 'bat', 'cmd', 'hta', 'cpl', 'msc', 'msi', 'msp', 'mst',
  'msix', 'msixbundle', 'appx', 'appxbundle', 'appref-ms', 'appinstaller', 'application', 'gadget', 'xbap',
  'jar', 'jnlp', 'js', 'jse', 'vb', 'vbe', 'vbs', 'vbscript', 'wsf', 'wsh', 'ws', 'wsc', 'sct',
  'shb', 'shs', 'ps1', 'ps1xml', 'ps2', 'ps2xml', 'psc1', 'psc2', 'psd1', 'psm1',
  'msh', 'msh1', 'msh2', 'mshxml', 'msh1xml', 'msh2xml', 'scf', 'lnk', 'url', 'website',
  'reg', 'inf', 'ins', 'isp', 'chm', 'hlp', 'dll', 'ocx', 'sys', 'drv', 'xll', 'xnk',
  'rdp', 'vsto', 'iqy', 'ade', 'adp', 'docm', 'xlsm', 'pptm', 'slk', 'ahk',
  'settingcontent-ms', 'library-ms', 'search-ms', 'searchconnector-ms', 'diagcab', 'mof',
  'py', 'pyc', 'pyo', 'pyw', 'iso', 'img', 'vhd', 'vhdx',
  'app', 'bundle', 'plugin', 'xpc', 'command', 'tool', 'terminal', 'action', 'workflow', 'scpt', 'scptd',
  'applescript', 'fileloc', 'webloc', 'inetloc', 'mobileconfig', 'pkg', 'mpkg', 'dmg',
  'kext', 'prefpane', 'osax',
  'html', 'htm', 'xhtml', 'svg',
  'sh', 'bash', 'csh', 'ksh', 'zsh', 'desktop', 'run', 'deb', 'rpm', 'appimage',
]);

/** Safe static raster image and document types allowed to pass directly to `shell.openPath`. */
export const SAFE_BINARY_OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'tif', 'tiff', 'heic', 'heif',
  'pdf',
]);

/** Safe plain-text formats allowed to open directly when their content is verified text. */
export const SAFE_TEXT_OPEN_EXTENSIONS: ReadonlySet<string> = new Set([
  'txt', 'text', 'log', 'md', 'markdown', 'mdx', 'json', 'jsonc', 'json5', 'jsonl', 'ndjson',
  'yaml', 'yml', 'toml', 'ini', 'conf', 'cfg', 'csv', 'tsv',
]);

export type LinkedFileAction = 'open' | 'view-as-text' | 'reveal';

export type LinkedFileFacts = {
  names: readonly string[];
  isFile: boolean;
  isDirectory: boolean;
  mode: number;
  head: Uint8Array;
};

const SCRIPT_SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  'mjs', 'cjs', 'ts', 'mts', 'cts', 'rb', 'pl', 'pm', 'fish', 'lua', 'php', 'tcl',
]);

const ARCHIVE_EXTENSIONS: ReadonlySet<string> = new Set([
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'zst', 'lz', 'lzma',
  'z', '7z', 'rar', 'cab', 'war', 'ear', 'apk', 'ipa', 'xpi', 'crx', 'vsix', 'nupkg',
]);

function fileExtension(name: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    const base = win32.basename(name).split(':')[0]!.replace(/[. ]+$/, '');
    return win32.extname(base).slice(1).toLowerCase();
  }
  return posix.extname(posix.basename(name)).slice(1).toLowerCase();
}

function isLaunchableExtension(
  extension: string,
  platform: NodeJS.Platform,
  windowsPathExt: string | undefined,
): boolean {
  if (!extension) return false;
  if (BLOCKED_LAUNCHABLE_EXTENSIONS.has(extension) || SCRIPT_SOURCE_EXTENSIONS.has(extension)) {
    return true;
  }
  return (
    platform === 'win32' &&
    (windowsPathExt ?? '')
      .toLowerCase()
      .split(';')
      .some((entry) => entry.trim() === `.${extension}`)
  );
}

function startsWith(head: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((byte, index) => head[index] === byte);
}

function hasShebang(head: Uint8Array): boolean {
  return startsWith(head, [0x23, 0x21]);
}

function isNativeExecutable(head: Uint8Array): boolean {
  return [
    [0x7f, 0x45, 0x4c, 0x46],
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
    [0x4d, 0x5a],
  ].some((magic) => startsWith(head, magic));
}

/** The PDF spec lets readers accept the `%PDF-` marker anywhere in the first 1024 bytes. */
function hasPdfHeader(head: Uint8Array): boolean {
  const limit = Math.min(head.length, 1024) - 5;
  for (let i = 0; i <= limit; i++) {
    if (startsWith(head.subarray(i), [0x25, 0x50, 0x44, 0x46, 0x2d])) return true;
  }
  return false;
}

function isArchiveContent(head: Uint8Array): boolean {
  const bzip2 = startsWith(head, [0x42, 0x5a, 0x68]) && (head[3] ?? 0) >= 0x31 && (head[3] ?? 0) <= 0x39;
  return (
    bzip2 ||
    [
      [0x50, 0x4b, 0x03, 0x04],
      [0x50, 0x4b, 0x05, 0x06],
      [0x50, 0x4b, 0x07, 0x08],
      [0x1f, 0x8b],
      [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
      [0x28, 0xb5, 0x2f, 0xfd],
      [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
      [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
    ].some((magic) => startsWith(head, magic))
  );
}

function isTextContent(head: Uint8Array): boolean {
  if (startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) return true;
  return !head.includes(0) && !isNativeExecutable(head) && !isArchiveContent(head);
}

export function classifyLinkedFile(
  { names, isFile, isDirectory, mode, head }: LinkedFileFacts,
  platform: NodeJS.Platform = process.platform,
  windowsPathExt: string | undefined = process.env.PATHEXT,
): LinkedFileAction {
  if (names.length === 0) return 'reveal';
  const extensions = names.map((name) => fileExtension(name, platform));
  const launchableByName = extensions.some((extension) =>
    isLaunchableExtension(extension, platform, windowsPathExt),
  );
  if (isDirectory) {
    const hasShellClsid = names.some((name) => /\{[0-9a-f]{8}-[0-9a-f-]{10,}\}/i.test(name));
    return launchableByName || hasShellClsid ? 'reveal' : 'open';
  }
  if (!isFile) return 'reveal';
  if (extensions.some((extension) => ARCHIVE_EXTENSIONS.has(extension))) return 'reveal';
  if (launchableByName) return isTextContent(head) ? 'view-as-text' : 'reveal';
  if (platform !== 'win32' && (mode & 0o111) !== 0) {
    if (hasShebang(head)) return 'view-as-text';
    if (extensions.some((extension) => extension === '')) {
      return isTextContent(head) ? 'view-as-text' : 'reveal';
    }
    return 'reveal';
  }

  // Strictly allowlist direct OS `shell.openPath`; unknown or risky file types only reveal in folder.
  if (extensions.every((extension) => extension !== '' && SAFE_BINARY_OPEN_EXTENSIONS.has(extension))) {
    if (isNativeExecutable(head) || isArchiveContent(head)) return 'reveal';
    if (extensions.includes('pdf') && !hasPdfHeader(head)) return 'reveal';
    return 'open';
  }
  if (extensions.every((extension) => extension !== '' && SAFE_TEXT_OPEN_EXTENSIONS.has(extension))) {
    return isTextContent(head) ? 'open' : 'reveal';
  }
  return 'reveal';
}
