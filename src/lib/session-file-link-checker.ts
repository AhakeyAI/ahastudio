// Microtask-batched workspace file existence checker for inline clickable file links in Markdown.
// Adapted from Orca's native-chat-file-link-existence pattern (MIT, Copyright (c) 2026 Lovecast Inc.).

import {
  createNativeChatFileLinkChecker,
  type NativeChatFileLinkExistence,
} from './shared/native-chat/native-chat-file-link-existence';

const MAX_CHECK_PATHS_BATCH = 200;
const MAX_PATH_LENGTH = 1024;
const UNC_OR_DEVICE_RE = /^(?:[\\/]{2}|[\\/]\?\?(?:[\\/]|$))/;

export type CheckPathsFn = (opts: {
  cwd?: string;
  paths: string[];
}) => Promise<
  | { ok: true; existing: Record<string, { path: string; isDirectory: boolean }> }
  | { ok: false; error?: string }
>;

/**
 * Create one file-existence checker per session cwd. Multiple path lookups triggered within
 * the same render tick coalesce into a single IPC `shellPty.checkPaths` batch.
 */
export function createSessionFileLinkChecker(
  cwd: string | null,
  checkPaths?: CheckPathsFn,
): NativeChatFileLinkExistence | null {
  const api =
    checkPaths ??
    (typeof window !== 'undefined' ? window.vibeMeet?.shellPty?.checkPaths : undefined);
  if (!api || !cwd) return null;

  type PendingEntry = {
    resolvers: Array<(exists: boolean) => void>;
    rejecters: Array<(err: unknown) => void>;
  };

  let queued = new Map<string, PendingEntry>();
  let scheduled = false;

  const flush = (): void => {
    scheduled = false;
    const batch = queued;
    queued = new Map();
    const allPaths = [...batch.keys()];
    for (let offset = 0; offset < allPaths.length; offset += MAX_CHECK_PATHS_BATCH) {
      const chunk = allPaths.slice(offset, offset + MAX_CHECK_PATHS_BATCH);
      void api({ cwd, paths: chunk }).then(
        (res) => {
          if (!res.ok) {
            const err = new Error(res.error ?? 'checkPaths failed');
            for (const p of chunk) {
              for (const reject of batch.get(p)?.rejecters ?? []) reject(err);
            }
            return;
          }
          for (const p of chunk) {
            const exists = Boolean(res.existing[p]);
            for (const resolve of batch.get(p)?.resolvers ?? []) resolve(exists);
          }
        },
        (err) => {
          for (const p of chunk) {
            for (const reject of batch.get(p)?.rejecters ?? []) reject(err);
          }
        },
      );
    }
  };

  return createNativeChatFileLinkChecker<string>({
    lookup: (link) => {
      const pathText = link.pathText.trim();
      if (!pathText || pathText.length > MAX_PATH_LENGTH || UNC_OR_DEVICE_RE.test(pathText)) {
        return { kind: 'plain' };
      }
      return { kind: 'ask', key: `${cwd}::${pathText}`, target: pathText };
    },
    ask: (target) =>
      new Promise<boolean>((resolve, reject) => {
        const entry = queued.get(target) ?? { resolvers: [], rejecters: [] };
        entry.resolvers.push(resolve);
        entry.rejecters.push(reject);
        queued.set(target, entry);
        if (!scheduled) {
          scheduled = true;
          queueMicrotask(flush);
        }
      }),
  });
}
