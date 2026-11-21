// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { classifyLinkedFile, type LinkedFileAction } from './launchable-file-type.js';

const HEAD_BYTES = 4096;
const MAX_SYMLINK_HOPS = 32;
const UNSAFE_SYMLINK_TARGET_RE = /^(?:[\\/]{2}|[\\/]\?\?(?:[\\/]|$))/;

async function symlinkChain(pathValue: string): Promise<string[]> {
  const names = [pathValue];
  let current = pathValue;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    if (UNSAFE_SYMLINK_TARGET_RE.test(current)) {
      throw new Error('Unsafe symlink target rejected');
    }
    if (!(await lstat(current)).isSymbolicLink()) break;
    current = resolve(dirname(current), await readlink(current));
    if (UNSAFE_SYMLINK_TARGET_RE.test(current)) {
      throw new Error('Unsafe symlink target rejected');
    }
    names.push(current);
  }
  return names;
}

async function readHead(pathValue: string): Promise<Uint8Array> {
  const handle = await open(pathValue, 'r');
  try {
    const buffer = new Uint8Array(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Classifies a local file link while following symlinks; fails closed to reveal. */
export async function inspectLinkedFile(pathValue: string): Promise<LinkedFileAction> {
  try {
    const names = await symlinkChain(pathValue);
    const resolved = await realpath(pathValue).catch(() => names.at(-1) ?? pathValue);
    names.push(resolved);
    const stats = await stat(resolved);
    return classifyLinkedFile({
      names,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      mode: stats.mode,
      head: stats.isFile() ? await readHead(resolved) : new Uint8Array(),
    });
  } catch {
    return 'reveal';
  }
}
