import { formatAgentFieldsText, formatMessageBanner } from './orchestration-messaging.js';
import type {
  OrchestrationAgentRosterEntry,
  OrchestrationCoordinatorStatusResult,
  OrchestrationDispatchRecord,
  OrchestrationExposedMessage,
  OrchestrationTaskRecord,
  WorkerApprovalPayload,
} from './orchestration-types.js';

/** Human-readable CLI receipt for an orchestration action result; falls back to pretty JSON. */
export function formatActionReceiptText(
  action: string,
  data: unknown,
  options: { full?: boolean; cliCommand: string },
): string {
  const { cliCommand } = options;
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<
    string,
    unknown
  >;

  if (action === 'check') {
    const formatted = typeof record.formatted === 'string' ? record.formatted : '';
    const count = typeof record.count === 'number' ? record.count : 0;
    const deliveryId = typeof record.deliveryId === 'string' ? record.deliveryId : null;
    const mailbox = typeof record.mailbox === 'string' ? record.mailbox : '';
    const header = formatAgentFieldsText(
      [
        ['Mailbox', mailbox],
        ['Messages', String(count)],
        ['Delivery', deliveryId],
        ['Acknowledged', typeof record.acknowledged === 'string' ? record.acknowledged : null],
        ['Replayed', record.replayed ? 'true' : undefined],
        ['TimedOut', record.timedOut ? 'true' : undefined],
        ['Cancelled', record.cancelled ? 'true' : undefined],
      ],
      count > 0
        ? deliveryId
          ? `Review the messages above; acknowledgment ${deliveryId} recorded.`
          : 'Messages checked.'
        : 'No unread messages.'
    );
    if (count === 0) return header;
    if (options.full && formatted) {
      return `${header}\n\n${formatted}`;
    }
    return formatted ? `${header}\n\n${formatted}` : header;
  }

  if (action === 'inbox') {
    const messages = Array.isArray(record.messages)
      ? (record.messages as OrchestrationExposedMessage[])
      : [];
    const count = typeof record.count === 'number' ? record.count : messages.length;
    const mailbox = typeof record.mailbox === 'string' ? record.mailbox : '';
    const header = formatAgentFieldsText(
      [
        ['Mailbox', mailbox],
        ['Messages', String(count)],
      ],
      count > 0 ? 'Inbox history (read-only).' : 'Inbox is empty.'
    );
    if (messages.length === 0) return header;
    const banners = messages
      .map((m) =>
        formatMessageBanner(
          {
            ...m,
            seq: 0,
            read: true,
          },
          { cliCommand: cliCommand, followUp: m.followUp }
        )
      )
      .join('\n\n');
    return `${header}\n\n${banners}`;
  }

  if (action === 'send') {
    const msg = record.message as OrchestrationExposedMessage | undefined;
    const followUp = record.followUp as
      | {
          previousDispatchId?: string;
          dispatch?: OrchestrationDispatchRecord;
          task?: OrchestrationTaskRecord;
          reusedPane?: boolean;
        }
      | undefined;
    return formatAgentFieldsText(
      [
        ['Message', msg?.id],
        ['From', msg?.fromHandle],
        ['To', msg?.toHandle],
        ['Type', msg?.type],
        ['Run', msg?.runId],
        ['ReactivatedDispatch', followUp?.dispatch?.id],
        ['ReactivatedTask', followUp?.task?.id],
        ['ReusedPane', followUp ? (followUp.reusedPane ? 'true' : 'false') : undefined],
      ],
      followUp
        ? `Settled worker ${followUp.previousDispatchId} reactivated as ${followUp.dispatch?.id}.`
        : 'Message sent.'
    );
  }

  if (action === 'worker-done' || action === 'task-done' || action === 'task-fail') {
    const task = record.task as OrchestrationTaskRecord | undefined;
    const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
    return formatAgentFieldsText(
      [
        ['Task', task?.id],
        ['TaskStatus', task?.status],
        ['Dispatch', dispatch?.id],
        ['DispatchStatus', dispatch?.status],
      ],
      'Worker completion report settled.'
    );
  }

  if (action === 'worker-start') {
    const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
    const task = record.task as OrchestrationTaskRecord | undefined;
    return formatAgentFieldsText(
      [
        ['Dispatch', dispatch?.id],
        ['Worker', typeof record.ptyId === 'string' ? record.ptyId : dispatch?.assigneePaneId],
        ['Task', task?.id],
        ['Run', dispatch?.runId],
        ['Agent', typeof record.cliId === 'string' ? record.cliId : dispatch?.cliId],
        ['Model', typeof record.model === 'string' ? record.model : dispatch?.model],
        ['Effort', typeof record.effort === 'string' ? record.effort : dispatch?.effort],
        ['Worktree', typeof record.worktreePath === 'string' ? record.worktreePath : null],
        ['Branch', typeof record.branch === 'string' ? record.branch : null],
        ['OwnsWorktree', record.ownsWorktree ? 'true' : 'false'],
      ],
      `${dispatch?.startObservation === 'observed' ? 'Worker started' : 'Dispatch observation: ' + (dispatch?.startObservation ?? 'pending')}. Wait for updates with: ${cliCommand} orchestration check --wait`
    );
  }

  if (action === 'worker-show') {
    const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
    const task = record.task as OrchestrationTaskRecord | null | undefined;
    return formatAgentFieldsText(
      [
        ['Dispatch', dispatch?.id],
        ['Worker', dispatch?.assigneePaneId ?? dispatch?.assigneeHandle],
        ['Stage', typeof record.stage === 'string' ? record.stage : dispatch?.stage],
        ['Status', dispatch?.status],
        ['PaneAlive', record.paneAlive ? 'true' : 'false'],
        ['Task', task?.id],
        ['Agent', dispatch?.cliId],
        ['Model', dispatch?.model],
        ['Effort', dispatch?.effort],
        ['Generation', String(dispatch?.processGeneration ?? 1)],
        ['Worktree', dispatch?.worktreePath],
        ['Branch', dispatch?.branch],
        ['FollowUpChild', typeof record.followUpChildDispatchId === 'string' ? record.followUpChildDispatchId : null],
      ],
      dispatch ? `Worker ${dispatch.id} (${String(record.stage ?? dispatch.status)}).` : 'Worker details.'
    );
  }

  if (action === 'worker-read') {
    const text = typeof record.text === 'string' ? record.text : '';
    const header = formatAgentFieldsText([
      ['Dispatch', typeof record.dispatchId === 'string' ? record.dispatchId : undefined],
      ['Terminal', typeof record.ptyId === 'string' ? record.ptyId : undefined],
      ['Mode', record.screen ? 'screen' : 'cursor'],
      ['Cursor', typeof record.cursor === 'number' ? String(record.cursor) : undefined],
      ['NextCursor', typeof record.nextCursor === 'number' ? String(record.nextCursor) : undefined],
      ['HasMore', record.hasMore ? 'true' : 'false'],
      ['Archived', record.archived ? 'true' : undefined],
    ]);
    return text ? `${header}\n\n${text}` : `${header}\n\n(empty)`;
  }

  if (action === 'worker-release' || action === 'worker-stop') {
    const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
    return formatAgentFieldsText(
      [
        ['Dispatch', dispatch?.id],
        ['Stage', dispatch?.stage],
        ['ClosedPane', record.closedPane ? 'true' : 'false'],
        ['RemovedWorktree', record.removedWorktree ? 'true' : 'false'],
      ],
      action === 'worker-release' ? 'Worker released.' : 'Worker stopped.'
    );
  }

  if (action === 'worker-abandon') {
    const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
    return formatAgentFieldsText(
      [
        ['Dispatch', dispatch?.id],
        ['Status', dispatch?.status],
        ['Warning', typeof record.warning === 'string' ? record.warning : undefined],
      ],
      'Worker dispatch abandoned.'
    );
  }

  if (action === 'reset') {
    const removed = (record.removed ?? {}) as Record<string, unknown>;
    return formatAgentFieldsText(
      [
        ['Scope', typeof record.reset === 'string' ? record.reset : undefined],
        ['RemovedRuns', removed.runs !== undefined ? String(removed.runs) : undefined],
        ['RemovedTasks', removed.tasks !== undefined ? String(removed.tasks) : undefined],
        ['RemovedDispatches', removed.dispatches !== undefined ? String(removed.dispatches) : undefined],
        ['RemovedMessages', removed.messages !== undefined ? String(removed.messages) : undefined],
      ],
      'Orchestration state reset.'
    );
  }

  if (action === 'approve' || action === 'deny') {
    const approval = record.approval as WorkerApprovalPayload | undefined;
    return formatAgentFieldsText(
      [
        ['Approval', approval?.approvalId],
        ['Status', approval?.status],
        ['Dispatch', approval?.dispatchId],
        ['Tool', approval?.toolName],
        ['Reason', approval?.reason ?? null],
      ],
      action === 'approve' ? 'Permission approved.' : 'Permission denied.'
    );
  }

  if (action === 'ask') {
    const pending = record.pending === true;
    return formatAgentFieldsText(
      [
        ['Question', String(record.messageId ?? '')],
        ['Pending', pending ? 'true' : 'false'],
        ['Answer', typeof record.answer === 'string' ? record.answer : null],
        ['TimedOut', record.timedOut ? 'true' : undefined],
      ],
      pending
        ? `Question pending; resume with: ${cliCommand} orchestration ask --resume ${String(record.messageId ?? '')} --wait`
        : 'Question answered.'
    );
  }

  if (action === 'reply') {
    const msg = record.message as OrchestrationExposedMessage | undefined;
    return formatAgentFieldsText(
      [
        ['Reply', msg?.id],
        ['To', msg?.toHandle],
        ['Thread', msg?.threadId],
        ['Duplicate', record.duplicate ? 'true' : undefined],
      ],
      'Reply delivered.'
    );
  }

  if (action === 'task-show') {
    const task = record.task as OrchestrationTaskRecord | undefined;
    const latestDispatch = record.latestDispatch as OrchestrationDispatchRecord | null | undefined;
    const gates = Array.isArray(record.gates) ? record.gates : [];
    return formatAgentFieldsText(
      [
        ['Task', task?.id],
        ['Title', task?.taskTitle],
        ['Status', task?.status],
        ['Run', task?.runId],
        ['Deps', task?.deps?.length ? task.deps.join(', ') : null],
        ['LatestDispatch', latestDispatch?.id ?? null],
        ['DispatchStatus', latestDispatch?.status ?? null],
        ['Gates', String(gates.length)],
      ],
      task ? `Task ${task.id} (${task.status}).` : 'Task details.'
    );
  }

  if (action === 'coordinator-status') {
    const counts = (record.taskCounts ?? {}) as Partial<
      OrchestrationCoordinatorStatusResult['taskCounts']
    >;
    return formatAgentFieldsText(
      [
        ['Running', record.running ? 'true' : 'false'],
        ['Run', typeof record.runId === 'string' ? record.runId : null],
        ['Tasks', counts.total !== undefined ? String(counts.total) : undefined],
        ['Ready', counts.ready !== undefined ? String(counts.ready) : undefined],
        ['Dispatched', counts.dispatched !== undefined ? String(counts.dispatched) : undefined],
        ['Completed', counts.completed !== undefined ? String(counts.completed) : undefined],
        [
          'ActiveDispatches',
          typeof record.activeDispatches === 'number' ? String(record.activeDispatches) : undefined,
        ],
        [
          'PendingGates',
          typeof record.pendingGates === 'number' ? String(record.pendingGates) : undefined,
        ],
      ],
      record.running ? 'Coordinator is running.' : 'Coordinator is idle.'
    );
  }

  if (action === 'agents') {
    const agents = Array.isArray(record.agents)
      ? (record.agents as OrchestrationAgentRosterEntry[])
      : [];
    if (agents.length === 0) {
      return 'No coding agents discovered.';
    }
    return agents
      .map((a) => {
        const state = a.available
          ? 'available'
          : !a.installed
            ? 'not-installed'
            : 'disabled';
        const idle = a.idlePanes.length > 0 ? `, ${a.idlePanes.length} idle pane(s)` : '';
        const model = a.defaultModel ? `, model=${a.defaultModel}` : '';
        const mcp = a.mcpReady ? `mcp=${a.mcpMode}` : 'mcp=fallback';
        return `- ${a.cliId} (${a.label}) [${state}; ${mcp}${model}${idle}]: ${a.specialty}`;
      })
      .join('\n');
  }

  if (action === 'delegate-task') {
    if (record.status === 'confirmation_required' || record.status === 'rejected') {
      return typeof record.message === 'string' ? record.message : JSON.stringify(data, null, 2);
    }
    const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
    return formatAgentFieldsText(
      [
        ['Role', typeof record.role === 'string' && record.role ? `@${record.role}` : null],
        ['Agent', typeof record.agent === 'string' ? record.agent : dispatch?.cliId],
        ['Dispatch', dispatch?.id],
        ['Worker', typeof record.ptyId === 'string' ? record.ptyId : dispatch?.assigneePaneId],
        ['FallbackFrom', typeof record.fallbackFrom === 'string' ? record.fallbackFrom : null],
        ['Worktree', typeof record.worktreePath === 'string' ? record.worktreePath : null],
        ['Branch', typeof record.branch === 'string' ? record.branch : null],
      ],
      'Task delegated.'
    );
  }

  return JSON.stringify(data, null, 2);
}
