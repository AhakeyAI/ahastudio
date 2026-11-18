import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { deliverPromptToPty, type PtyWriteFn } from '../agent/agent-prompt-delivery.js';
import type { AgentStatusStore } from '../agent/agent-status-store.js';
import {
  addGitWorktree,
  inspectGitRepo,
  listGitWorktrees,
  removeGitWorktree,
} from '../git/git-service.js';
import type { TerminalRuntimeTracker } from '../terminal-runtime-tracker.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import { formatAgentFieldsText } from './orchestration-messaging.js';
import type { OrchestrationService } from './orchestration-service.js';
import {
  getBundledSkillContent,
  listBundledSkills,
  syncBundledOrchestrationSkills,
} from './orchestration-skill-sync.js';
import { redactDispatchCapability } from './worker-dispatch-preamble.js';
import { resolveWorkerLaunchConfig } from './worker-launch-catalog.js';
import { inferSiblingMainRepoPath } from './worker-worktree-placement.js';

export interface CompanionCliDependencies {
  terminalTracker: TerminalRuntimeTracker;
  agentStatusStore: AgentStatusStore;
  writePty: PtyWriteFn;
  createPty?: (payload: {
    cwd?: string;
    cliId?: string;
    extraArgs?: string[];
    waitForReady?: { quietMs?: number; maxMs?: number };
  }) => Promise<{ ptyId: string; cwd?: string }>;
  closePty?: (ptyId: string) => Promise<{ ok: boolean }>;
  getDefaultCwd?: () => string | undefined;
  orchestrationService?: () => OrchestrationService | undefined;
  onWorktreeTerminalSpawned?: (event: {
    ptyId: string;
    cwd: string;
    branch: string | null;
    cliId: string;
  }) => void;
}

const terminalListSchema = z.object({
  includeExited: z.boolean().optional(),
});

const terminalShowSchema = z.object({
  id: z.string().trim().min(1),
});

const terminalReadSchema = z.object({
  id: z.string().trim().min(1),
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(256_000).optional(),
  screen: z.boolean().optional(),
});

const terminalSendSchema = z.object({
  id: z.string().trim().min(1),
  text: z.string().min(1).max(8_192),
  submit: z.boolean().optional(),
  from: z.string().trim().min(1).optional(),
});

const terminalWaitSchema = z.object({
  id: z.string().trim().min(1),
  for: z.enum(['exit', 'tui-idle']).optional(),
  timeoutMs: z.number().int().min(0).max(600_000).optional(),
  idleMs: z.number().int().min(100).max(60_000).optional(),
});

const worktreeListSchema = z.object({
  cwd: z.string().trim().min(1).optional(),
});

const worktreeCreateSchema = z.object({
  cwd: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  agent: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).max(64_000).optional(),
  detach: z.boolean().optional(),
});

const worktreeRemoveSchema = z.object({
  cwd: z.string().trim().min(1).optional(),
  path: z.string().trim().min(1),
  force: z.boolean().optional(),
});

const skillsGetSchema = z.object({
  name: z.string().trim().min(1).optional(),
  reference: z.string().trim().min(1).optional(),
  full: z.boolean().optional(),
});

const skillsSyncSchema = z.object({
  homeDir: z.string().trim().min(1).optional(),
});

function slugifyWorktreeName(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || `wt-${Date.now().toString(36)}`
  );
}

export async function dispatchCompanionHttpAction(
  deps: CompanionCliDependencies,
  namespace: 'terminal' | 'worktree' | 'skills',
  action: string,
  rawPayload: unknown,
  context: { signal: AbortSignal; callerPaneId?: string | null }
): Promise<{ status: number; body: Record<string, unknown> }> {
  const payload =
    typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const formatReceipt = payload.receiptText === true;

  try {
    if (namespace === 'terminal') {
      let result: Record<string, unknown>;
      let receiptText: string | undefined;

      switch (action) {
        case 'list': {
          const parsed = terminalListSchema.parse(payload);
          const terminals = deps.terminalTracker
            .listTerminals({ includeExited: parsed.includeExited })
            .map((t) => ({
              ...t,
              agentStatus: deps.agentStatusStore.get(t.ptyId),
            }));
          result = { terminals, count: terminals.length };
          if (formatReceipt) {
            const lines = terminals.map(
              (t) =>
                `${t.ptyId}  ${t.alive ? 'alive' : 'exited'}  agent=${t.agentStatus?.agentId ?? t.cliId ?? 'shell'}  state=${t.agentStatus?.state ?? 'idle'}  cwd=${t.cwd}`
            );
            receiptText = lines.length > 0 ? lines.join('\n') : 'No active terminals.';
          }
          break;
        }
        case 'show': {
          const parsed = terminalShowSchema.parse(payload);
          const terminal = deps.terminalTracker.getTerminal(parsed.id);
          const agentStatus = deps.agentStatusStore.get(parsed.id);
          if (!terminal && !agentStatus) {
            return {
              status: 404,
              body: { ok: false, code: 'not_found', error: `Terminal not found: ${parsed.id}` },
            };
          }
          const activeDispatch =
            deps.orchestrationService?.()?.store.getActiveDispatchForIdentity(parsed.id, parsed.id) ??
            null;
          result = { terminal, agentStatus, activeDispatch };
          if (formatReceipt) {
            receiptText = formatAgentFieldsText([
              ['Terminal', parsed.id],
              ['Alive', terminal ? (terminal.alive ? 'true' : 'false') : 'true'],
              ['Agent', agentStatus?.agentId ?? terminal?.cliId ?? 'shell'],
              ['State', agentStatus?.state ?? 'idle'],
              ['CWD', terminal?.cwd ?? null],
              ['ActiveDispatch', activeDispatch?.id ?? null],
            ]);
          }
          break;
        }
        case 'read': {
          const parsed = terminalReadSchema.parse(payload);
          const read = deps.terminalTracker.readOutput(parsed.id, {
            cursor: parsed.cursor,
            limit: parsed.limit,
            screen: parsed.screen,
          });
          if (!read) {
            return {
              status: 404,
              body: { ok: false, code: 'not_found', error: `Terminal not found: ${parsed.id}` },
            };
          }
          const orch = deps.orchestrationService?.();
          let safeText = read.text;
          if (orch) {
            for (const d of orch.store.listDispatches()) {
              if (d.assigneePaneId === parsed.id || d.assigneeHandle === parsed.id) {
                safeText = redactDispatchCapability(
                  safeText,
                  orch.store.getDispatchCapability(d.id)
                );
              }
            }
          }
          result = { ...read, text: safeText };
          if (formatReceipt) {
            const header = formatAgentFieldsText([
              ['Terminal', read.ptyId],
              ['Mode', read.screen ? 'screen' : 'cursor'],
              ['Cursor', String(read.cursor)],
              ['NextCursor', String(read.nextCursor)],
              ['HasMore', read.hasMore ? 'true' : 'false'],
            ]);
            receiptText = safeText ? `${header}\n\n${safeText}` : `${header}\n\n(empty)`;
          }
          break;
        }
        case 'send': {
          const parsed = terminalSendSchema.parse(payload);
          if ((context.callerPaneId ?? parsed.from) === parsed.id) {
            return {
              status: 400,
              body: {
                ok: false,
                code: 'invalid_argument',
                error: `Cannot send terminal input to caller's own terminal (${parsed.id}).`,
              },
            };
          }
          if (deps.orchestrationService?.()?.isCoordinatorTerminal(parsed.id)) {
            return {
              status: 403,
              body: { ok: false, code: 'operation_rejected', error: 'Coordinator terminals accept orchestration mail instead of direct terminal input.' },
            };
          }
          const term = deps.terminalTracker.getTerminal(parsed.id);
          const status = deps.agentStatusStore.get(parsed.id);
          if ((!term || !term.alive) && !status) {
            return {
              status: 404,
              body: {
                ok: false,
                code: 'terminal_unavailable',
                error: `Terminal ${parsed.id} is not alive.`,
              },
            };
          }
          const delivery = await deliverPromptToPty(
            {
              ptyId: parsed.id,
              prompt: parsed.text,
              submit: parsed.submit ?? true,
              agentId:
                deps.agentStatusStore.get(parsed.id)?.agentId ??
                deps.terminalTracker.getTerminal(parsed.id)?.cliId ??
                null,
              isPaneAlive: () => deps.terminalTracker.isAlive(parsed.id),
              readScreen: () => deps.terminalTracker.captureTail(parsed.id, 4_000),
              getLastOutputAtMs: () => deps.terminalTracker.getLastOutputAtMs(parsed.id),
            },
            deps.writePty
          );
          if (!delivery.ok) {
            return {
              status: 503,
              body: {
                ok: false,
                code: 'prompt_delivery_failed',
                error: delivery.error ?? `Failed to send input to ${parsed.id}`,
              },
            };
          }
          result = { ptyId: parsed.id, sent: true, submitted: parsed.submit ?? true };
          if (formatReceipt) {
            receiptText = formatAgentFieldsText(
              [
                ['Terminal', parsed.id],
                ['Submitted', (parsed.submit ?? true) ? 'true' : 'false'],
              ],
              'Input delivered.'
            );
          }
          break;
        }
        case 'wait': {
          const parsed = terminalWaitSchema.parse(payload);
          const waitRes = await deps.terminalTracker.waitForTerminal(parsed.id, {
            for: parsed.for ?? 'tui-idle',
            timeoutMs: parsed.timeoutMs,
            idleMs: parsed.idleMs,
            agentStatusStore: deps.agentStatusStore,
            signal: context.signal,
          });
          result = { ...waitRes };
          if (formatReceipt) {
            receiptText = formatAgentFieldsText([
              ['Terminal', waitRes.ptyId],
              ['For', waitRes.for],
              ['Satisfied', waitRes.satisfied ? 'true' : 'false'],
              ['TimedOut', waitRes.timedOut ? 'true' : undefined],
              ['Alive', waitRes.alive ? 'true' : 'false'],
              ['State', waitRes.state ?? null],
            ]);
          }
          break;
        }
        default:
          return {
            status: 404,
            body: { ok: false, code: 'not_found', error: `Unknown terminal action: ${action}` },
          };
      }

      return {
        status: 200,
        body: { ok: true, result, ...(receiptText !== undefined ? { receiptText } : {}) },
      };
    }

    if (namespace === 'worktree') {
      let result: Record<string, unknown>;
      let receiptText: string | undefined;

      switch (action) {
        case 'list': {
          const parsed = worktreeListSchema.parse(payload);
          const cwd = parsed.cwd ?? deps.getDefaultCwd?.() ?? process.cwd();
          const listed = await listGitWorktrees(cwd);
          if (!listed.ok) {
            return { status: 400, body: { ok: false, code: 'worktree_failed', error: listed.error } };
          }
          const dispatches = deps.orchestrationService?.()?.store.listDispatches() ?? [];
          const enriched = listed.worktrees.map((wt) => {
            const owners = dispatches.filter(
              (d) =>
                d.worktreePath &&
                resolve(d.worktreePath).toLowerCase() === resolve(wt.path).toLowerCase() &&
                !d.releasedAt
            );
            return {
              ...wt,
              workerDispatches: owners.map((d) => ({
                dispatchId: d.id,
                taskId: d.taskId,
                status: d.status,
                ownsWorktree: Boolean(d.ownsWorktree),
              })),
            };
          });
          result = { isGitRepo: listed.isGitRepo, worktrees: enriched, count: enriched.length };
          if (formatReceipt) {
            receiptText =
              enriched.length > 0
                ? enriched
                    .map(
                      (wt) =>
                        `${wt.path}  branch=${wt.branch ?? '(detached)'}${wt.isMainWorktree ? ' [main]' : ''}`
                    )
                    .join('\n')
                : 'No Git worktrees found.';
          }
          break;
        }
        case 'create': {
          const parsed = worktreeCreateSchema.parse(payload);
          if (parsed.prompt && !parsed.agent) {
            return {
              status: 400,
              body: {
                ok: false,
                code: 'invalid_argument',
                error: '--prompt requires --agent <cli> to launch a terminal in the created worktree.',
              },
            };
          }
          const cwd = parsed.cwd ?? deps.getDefaultCwd?.() ?? process.cwd();
          const inspected = await inspectGitRepo(cwd);
          if (!inspected.ok || !inspected.isGitRepo || !inspected.rootPath) {
            return {
              status: 400,
              body: {
                ok: false,
                code: 'worktree_failed',
                error: !inspected.ok ? inspected.error : 'Target directory is not a Git repository.',
              },
            };
          }
          if (!inspected.head) {
            return {
              status: 400,
              body: {
                ok: false,
                code: 'worktree_failed',
                error: `Git repository at ${inspected.rootPath} has no commits yet (unborn HEAD). Create an initial commit first.`,
              },
            };
          }

          const listed = await listGitWorktrees(inspected.rootPath);
          const mainWorktreeRoot =
            (listed.ok && listed.isGitRepo
              ? listed.worktrees.find((wt) => wt.isMainWorktree)?.path
              : null) ?? inspected.rootPath;

          const launch = parsed.agent
            ? resolveWorkerLaunchConfig({
                cliId: parsed.agent,
                model: parsed.model,
                effort: parsed.effort,
              })
            : null;

          const slug = slugifyWorktreeName(
            parsed.name || parsed.branch || `wt-${Date.now().toString(36).slice(-5)}`
          );
          const targetPath = parsed.path
            ? isAbsolute(parsed.path)
              ? resolve(parsed.path)
              : resolve(mainWorktreeRoot, parsed.path)
            : join(
                dirname(mainWorktreeRoot),
                `${basename(mainWorktreeRoot)}.aha-worktrees`,
                slug
              );
          const desiredBranch = parsed.detach ? undefined : parsed.branch || `worktree/${slug}`;

          let added = await addGitWorktree({
            cwd: mainWorktreeRoot,
            worktreePath: targetPath,
            ...(parsed.detach
              ? { detach: true, startPoint: parsed.baseBranch }
              : { newBranch: desiredBranch, startPoint: parsed.baseBranch }),
          });
          if (!added.ok && parsed.branch && /already exists/i.test(added.error)) {
            added = await addGitWorktree({
              cwd: mainWorktreeRoot,
              worktreePath: targetPath,
              branch: parsed.branch,
            });
          }
          if (!added.ok) {
            return { status: 400, body: { ok: false, code: 'worktree_failed', error: added.error } };
          }

          let ptyId: string | null = null;
          let promptDelivered: boolean | undefined;
          if (launch && deps.createPty) {
            const spawned = await deps.createPty({
              cwd: added.path,
              cliId: launch.cliId,
              extraArgs: launch.extraArgs,
              ...(parsed.prompt ? { waitForReady: { quietMs: 1_500, maxMs: 20_000 } } : {}),
            });
            ptyId = spawned.ptyId;
            deps.onWorktreeTerminalSpawned?.({
              ptyId,
              cwd: added.path,
              branch: desiredBranch ?? null,
              cliId: launch.cliId,
            });
            if (parsed.prompt) {
              const delivered = await deliverPromptToPty(
                {
                  ptyId,
                  prompt: parsed.prompt,
                  submit: true,
                  agentId: launch.cliId,
                  isPaneAlive: () => deps.terminalTracker.isAlive(ptyId!),
                  readScreen: () => deps.terminalTracker.captureTail(ptyId!, 4_000),
                  getLastOutputAtMs: () => deps.terminalTracker.getLastOutputAtMs(ptyId!),
                },
                deps.writePty
              );
              if (!delivered.ok) {
                return {
                  status: 503,
                  body: {
                    ok: false,
                    code: 'prompt_delivery_failed',
                    error: delivered.error,
                    data: { path: added.path, branch: desiredBranch ?? null, ptyId },
                  },
                };
              }
              promptDelivered = true;
            }
          }

          result = {
            path: added.path,
            branch: desiredBranch ?? null,
            ptyId,
            agent: launch?.cliId ?? null,
            ...(promptDelivered !== undefined ? { promptDelivered } : {}),
          };
          if (formatReceipt) {
            receiptText = formatAgentFieldsText(
              [
                ['Worktree', added.path],
                ['Branch', desiredBranch ?? '(detached)'],
                ['Terminal', ptyId],
                ['Agent', launch?.cliId ?? null],
                ...(promptDelivered !== undefined
                  ? [['PromptDelivered', promptDelivered ? 'true' : 'false'] as [string, string]]
                  : []),
              ],
              'Worktree created.'
            );
          }
          break;
        }
        case 'remove': {
          const parsed = worktreeRemoveSchema.parse(payload);
          const targetWorktreePath = resolve(parsed.path);
          const orch = deps.orchestrationService?.();
          if (orch && !parsed.force) {
            const activeOwner = orch.store
              .listDispatches()
              .find(
                (d) =>
                  ACTIVE_DISPATCH_STATUSES.has(d.status) &&
                  d.worktreePath &&
                  resolve(d.worktreePath).toLowerCase() === targetWorktreePath.toLowerCase()
              );
            if (activeOwner) {
              return {
                status: 409,
                body: {
                  ok: false,
                  code: 'operation_rejected',
                  error: `Worktree ${parsed.path} has active worker dispatch ${activeOwner.id}; stop the worker first or pass --force.`,
                },
              };
            }
          }

          let listed = await listGitWorktrees(targetWorktreePath);
          if (!listed.ok || !listed.isGitRepo) {
            const fallbackRepo =
              inferSiblingMainRepoPath(targetWorktreePath) ??
              parsed.cwd ??
              deps.getDefaultCwd?.();
            if (fallbackRepo) {
              listed = await listGitWorktrees(fallbackRepo);
            }
          }
          const mainRepoCwd =
            (listed.ok && listed.isGitRepo
              ? listed.worktrees.find((wt) => wt.isMainWorktree)?.path
              : null) ??
            inferSiblingMainRepoPath(targetWorktreePath) ??
            parsed.cwd ??
            deps.getDefaultCwd?.() ??
            dirname(targetWorktreePath);

          const removed = await removeGitWorktree({
            cwd: mainRepoCwd,
            worktreePath: targetWorktreePath,
            force: parsed.force,
          });
          if (!removed.ok) {
            return {
              status: 400,
              body: { ok: false, code: 'worktree_failed', error: removed.error },
            };
          }
          result = { path: removed.path, removed: true };
          if (formatReceipt) {
            receiptText = formatAgentFieldsText([['RemovedWorktree', removed.path]], 'Worktree removed.');
          }
          break;
        }
        default:
          return {
            status: 404,
            body: { ok: false, code: 'not_found', error: `Unknown worktree action: ${action}` },
          };
      }

      return {
        status: 200,
        body: { ok: true, result, ...(receiptText !== undefined ? { receiptText } : {}) },
      };
    }

    // namespace === 'skills'
    switch (action) {
      case 'list': {
        const result = listBundledSkills();
        const receiptText = formatReceipt
          ? result.skills
              .map((s) => `${s.name}: ${s.description} (refs: ${s.references.join(', ')})`)
              .join('\n')
          : undefined;
        return {
          status: 200,
          body: { ok: true, result, ...(receiptText ? { receiptText } : {}) },
        };
      }
      case 'get': {
        const parsed = skillsGetSchema.parse(payload);
        const result = getBundledSkillContent(parsed);
        return {
          status: 200,
          body: {
            ok: true,
            result,
            ...(formatReceipt ? { receiptText: result.content } : {}),
          },
        };
      }
      case 'sync': {
        const parsed = skillsSyncSchema.parse(payload);
        const result = syncBundledOrchestrationSkills({
          ...(parsed.homeDir ? { homeDir: parsed.homeDir } : {}),
        });
        const receiptText = formatReceipt
          ? formatAgentFieldsText(
              [
                ['Skill', result.skillName],
                ['Targets', String(result.targets.length)],
                ['UpdatedFiles', String(result.updatedFiles.length)],
                ['SkippedFiles', String(result.skippedFiles.length)],
              ],
              'Bundled orchestration skills synced.'
            )
          : undefined;
        return {
          status: 200,
          body: { ok: true, result, ...(receiptText ? { receiptText } : {}) },
        };
      }
      default:
        return {
          status: 404,
          body: { ok: false, code: 'not_found', error: `Unknown skills action: ${action}` },
        };
    }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return {
        status: 400,
        body: {
          ok: false,
          code: 'invalid_argument',
          error: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
        },
      };
    }
    return {
      status: 400,
      body: {
        ok: false,
        code: 'operation_rejected',
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
