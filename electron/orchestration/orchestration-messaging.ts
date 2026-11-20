import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import type { OrchestrationStore } from './orchestration-store.js';
import type {
  OrchestrationExposedMessage,
  OrchestrationMessageRecord,
  OrchestrationReportFollowUp,
} from './orchestration-types.js';

const BANNER_WIDTH = 60;
const SEPARATOR = '─'.repeat(BANNER_WIDTH);

export function completionReportDispatchId(
  store: OrchestrationStore,
  message: OrchestrationMessageRecord
): string | undefined {
  if (message.fromHandle.startsWith('dispatch:')) {
    return message.fromHandle.slice('dispatch:'.length);
  }
  if (message.type !== 'worker_done' || !message.payload) {
    return undefined;
  }
  try {
    const payload = JSON.parse(message.payload) as Record<string, unknown>;
    if (
      typeof payload === 'object' &&
      payload !== null &&
      !message.lifecycleRejectedReason &&
      typeof payload.dispatchId === 'string' &&
      typeof payload.taskId === 'string'
    ) {
      const dispatch = store.getDispatchContext(payload.dispatchId);
      if (dispatch && dispatch.taskId === payload.taskId) {
        return dispatch.id;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export function reportFollowUpAction(
  store: OrchestrationStore,
  dispatchId: string
): OrchestrationReportFollowUp | undefined {
  const dispatch = store.getDispatchContext(dispatchId);
  if (!dispatch || ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
    return undefined;
  }
  return { kind: 'worker_start', dispatchId, active: false };
}

export function exposeMessage(
  msg: OrchestrationMessageRecord,
  followUp?: OrchestrationReportFollowUp
): OrchestrationExposedMessage {
  return {
    id: msg.id,
    runId: msg.runId,
    ...(msg.boardSeq !== undefined ? { boardSeq: msg.boardSeq } : {}),
    type: msg.type,
    priority: msg.priority,
    fromHandle: msg.fromHandle,
    toHandle: msg.toHandle,
    ...(msg.fromRole ? { fromRole: msg.fromRole } : {}),
    ...(msg.mentions && msg.mentions.length > 0 ? { mentions: [...msg.mentions] } : {}),
    ...(msg.refs && msg.refs.length > 0 ? { refs: [...msg.refs] } : {}),
    ...(msg.kind ? { kind: msg.kind } : {}),
    ...(msg.artifacts !== undefined ? { artifacts: msg.artifacts } : {}),
    subject: msg.subject,
    body: msg.body,
    payload: msg.payload,
    threadId: msg.threadId,
    deliveredAt: msg.deliveredAt,
    createdAt: msg.createdAt,
    lifecycleRejectedReason: msg.lifecycleRejectedReason,
    ...(followUp ? { followUp } : {}),
  };
}

export function exposeMessages(
  store: OrchestrationStore,
  messages: readonly OrchestrationMessageRecord[]
): OrchestrationExposedMessage[] {
  return messages.map((msg) => {
    let followUp: OrchestrationReportFollowUp | undefined;
    if (msg.type === 'worker_done') {
      const dispatchId = completionReportDispatchId(store, msg);
      if (dispatchId) {
        followUp = reportFollowUpAction(store, dispatchId);
      }
    }
    return exposeMessage(msg, followUp);
  });
}

export function formatMessageBanner(
  msg: OrchestrationMessageRecord,
  options: {
    cliCommand?: string;
    followUp?: OrchestrationReportFollowUp;
    mcpMode?: boolean;
    roleLabel?: string;
  } = {}
): string {
  const cli = options.cliCommand ?? 'aha';
  const priorityTag =
    msg.priority === 'urgent' ? ' [URGENT]' : msg.priority === 'high' ? ' [HIGH]' : '';
  const rejectedTag = msg.lifecycleRejectedReason
    ? ` [REJECTED: ${msg.lifecycleRejectedReason}]`
    : '';

  if (options.mcpMode) {
    const cleanRole =
      options.roleLabel?.trim().replace(/^@+/, '') ||
      msg.fromRole?.trim().replace(/^@+/, '') ||
      msg.fromHandle;
    const senderTag = cleanRole.startsWith('@') ? cleanRole : `@${cleanRole}`;
    const mentionsTag =
      msg.mentions && msg.mentions.length > 0
        ? ` → ${msg.mentions.map((m) => `@${m}`).join(' ')}`
        : '';
    const seqNum = msg.boardSeq ?? msg.seq;
    const kindLabel = msg.kind ?? msg.type;
    const lines: string[] = [
      `[#${seqNum} · ${senderTag}${mentionsTag} · ${kindLabel}]${priorityTag}${rejectedTag}`,
    ];
    if (msg.body) {
      lines.push(msg.body);
    } else if (msg.subject) {
      lines.push(msg.subject);
    }
    if (msg.artifacts) {
      const parts: string[] = [];
      if (msg.artifacts.branch) parts.push(`branch=${msg.artifacts.branch}`);
      if (msg.artifacts.headCommit) parts.push(`commit=${msg.artifacts.headCommit}`);
      if (typeof msg.artifacts.changedFileCount === 'number') {
        const filesList = msg.artifacts.changedFiles?.length
          ? `: ${msg.artifacts.changedFiles.slice(0, 6).join(', ')}${msg.artifacts.changedFileCount > 6 ? '…' : ''}`
          : '';
        parts.push(`${msg.artifacts.changedFileCount} changed file(s)${filesList}`);
      }
      if (parts.length > 0) {
        lines.push(`Artifacts: ${parts.join(' | ')}`);
      }
    }
    if (msg.kind === 'approval') {
      lines.push(
        `[Action: manage_worker(role="${cleanRole}", action="approve" | "deny")]`
      );
    } else if (options.followUp) {
      lines.push(
        `[Worker ${senderTag} settled; mention ${senderTag} via post_message to reactivate or manage_worker(role="${cleanRole}", action="release").]`
      );
    } else if (msg.type !== 'heartbeat') {
      lines.push(`[Reply: post_message(text="${senderTag} ...")]`);
    }
    return lines.join('\n');
  }

  const senderName = msg.fromHandle.toUpperCase();
  const header = `──── From: ${senderName} (${msg.fromHandle})${priorityTag}${rejectedTag} (${msg.type}) ────`;

  const lines: string[] = [header, `Subject: ${msg.subject}`];
  if (msg.body) {
    lines.push(msg.body);
  }
  if (msg.payload) {
    lines.push(`[Payload: ${msg.payload}]`);
  }

  if (options.followUp) {
    lines.push(
      `[Report settled (${options.followUp.dispatchId ?? 'dispatch'} finished); do not reply to worker report.]`
    );
  } else if (msg.type !== 'heartbeat') {
    const explicitFrom =
      msg.toHandle.startsWith('run:') || msg.toHandle.startsWith('dispatch:')
        ? ''
        : ` --from ${msg.toHandle}`;
    lines.push(`[Reply: ${cli} orchestration reply --id ${msg.id}${explicitFrom} --body "..."]`);
  }

  lines.push(SEPARATOR);
  return lines.join('\n');
}

export function formatMessagesForInjection(
  messages: readonly OrchestrationMessageRecord[],
  cliCommand = 'aha'
): string {
  if (messages.length === 0) {
    return '';
  }
  const banners = messages.map((m) => formatMessageBanner(m, { cliCommand })).join('\n\n');
  return `\n--- Orchestration Messages (${messages.length}) ---\n${banners}\n---\n`;
}

export function formatMessagePointer(
  count: number,
  mailboxHandle?: string,
  cliCommand = 'aha',
  heldDeliveryId?: string
): string {
  const noun = count === 1 ? 'message' : 'messages';
  const runFlag = mailboxHandle?.startsWith('run:')
    ? ` --run ${mailboxHandle.slice('run:'.length)}`
    : '';
  if (heldDeliveryId) {
    return `You have ${count} new orchestration ${noun} after delivery ${heldDeliveryId}, which you have not acknowledged. Run \`${cliCommand} orchestration check${runFlag} --ack ${heldDeliveryId}\`, then \`${cliCommand} orchestration check${runFlag}\` for the new mail.`;
  }
  return `You have ${count} orchestration ${noun}. Run \`${cliCommand} orchestration check${runFlag}\`.`;
}

export type AgentViewField = [label: string, value: string | null | undefined];

export function formatAgentFieldsText(
  fields: readonly AgentViewField[],
  next?: string | readonly string[]
): string {
  const lines: string[] = [];
  for (const [label, value] of fields) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    lines.push(`${label}: ${value}`);
  }
  if (next) {
    const nextList = Array.isArray(next) ? next : [next];
    for (const item of nextList) {
      if (item) {
        lines.push(`Next: ${item}`);
      }
    }
  }
  return lines.join('\n');
}
