import { z } from 'zod';
import {
  addGitWorktree,
  checkoutGitBranch,
  commitGitChanges,
  discardGitPaths,
  getGitDiff,
  getGitStatus,
  inspectGitRepo,
  listGitBranches,
  listGitWorktrees,
  removeGitWorktree,
  stageGitPaths,
  unstageGitPaths,
} from '../git/git-service.js';
import type { IpcContext } from './context.js';
import { handleSecure, mainWindowSenderPolicy } from './validators.js';

const cwdField = z.string().min(1).max(1024);
const repoPathField = z.string().min(1).max(1024);
const gitRefField = z.string().min(1).max(256);

export const gitCwdSchema = z.object({ cwd: cwdField }).strict();

export const gitDiffSchema = z
  .object({
    cwd: cwdField,
    path: repoPathField.optional(),
    staged: z.boolean().optional(),
    contextLines: z.number().int().min(0).max(50).optional(),
  })
  .strict();

export const gitStageSchema = z
  .object({
    cwd: cwdField,
    paths: z.array(repoPathField).max(500).optional(),
    all: z.boolean().optional(),
  })
  .strict();

export const gitDiscardSchema = z
  .object({
    cwd: cwdField,
    paths: z.array(repoPathField).min(1).max(500),
  })
  .strict();

export const gitCommitSchema = z
  .object({
    cwd: cwdField,
    message: z.string().min(1).max(65_536),
    amend: z.boolean().optional(),
  })
  .strict();

export const gitCheckoutSchema = z
  .object({
    cwd: cwdField,
    branch: gitRefField,
    create: z.boolean().optional(),
    startPoint: gitRefField.optional(),
  })
  .strict();

export const gitWorktreeAddSchema = z
  .object({
    cwd: cwdField,
    worktreePath: cwdField,
    branch: gitRefField.optional(),
    newBranch: gitRefField.optional(),
    startPoint: gitRefField.optional(),
    detach: z.boolean().optional(),
  })
  .strict();

export const gitWorktreeRemoveSchema = z
  .object({
    cwd: cwdField,
    worktreePath: cwdField,
    force: z.boolean().optional(),
  })
  .strict();

export function registerGitIpc(ctx: IpcContext): void {
  const authorize = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  const authorizeError = 'Sender is not the main window';

  handleSecure('git:inspect', {
    schema: gitCwdSchema,
    authorize,
    authorizeError,
    handler: ({ cwd }) => inspectGitRepo(cwd),
  });

  handleSecure('git:status', {
    schema: gitCwdSchema,
    authorize,
    authorizeError,
    handler: ({ cwd }) => getGitStatus(cwd),
  });

  handleSecure('git:diff', {
    schema: gitDiffSchema,
    authorize,
    authorizeError,
    handler: (payload) => getGitDiff(payload),
  });

  handleSecure('git:stage', {
    schema: gitStageSchema,
    authorize,
    authorizeError,
    handler: (payload) => stageGitPaths(payload),
  });

  handleSecure('git:unstage', {
    schema: gitStageSchema,
    authorize,
    authorizeError,
    handler: (payload) => unstageGitPaths(payload),
  });

  handleSecure('git:discard', {
    schema: gitDiscardSchema,
    authorize,
    authorizeError,
    handler: (payload) => discardGitPaths(payload),
  });

  handleSecure('git:commit', {
    schema: gitCommitSchema,
    authorize,
    authorizeError,
    handler: (payload) => commitGitChanges(payload),
  });

  handleSecure('git:branches', {
    schema: gitCwdSchema,
    authorize,
    authorizeError,
    handler: ({ cwd }) => listGitBranches(cwd),
  });

  handleSecure('git:checkout', {
    schema: gitCheckoutSchema,
    authorize,
    authorizeError,
    handler: (payload) => checkoutGitBranch(payload),
  });

  handleSecure('git:worktree-list', {
    schema: gitCwdSchema,
    authorize,
    authorizeError,
    handler: ({ cwd }) => listGitWorktrees(cwd),
  });

  handleSecure('git:worktree-add', {
    schema: gitWorktreeAddSchema,
    authorize,
    authorizeError,
    handler: (payload) => addGitWorktree(payload),
  });

  handleSecure('git:worktree-remove', {
    schema: gitWorktreeRemoveSchema,
    authorize,
    authorizeError,
    handler: (payload) => removeGitWorktree(payload),
  });
}
