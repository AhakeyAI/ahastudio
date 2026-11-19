#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const SERVER_INFO = {
  name: 'aha-orchestration',
  version: '1.0.0',
};
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const TASK_KIND_ENUM = [
  'architecture',
  'implementation',
  'debug',
  'tests',
  'review',
  'research',
  'docs',
];

function readEndpointFile() {
  const file = process.env.AHA_AGENT_HOOK_ENDPOINT_FILE;
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(data && data.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (typeof data.token !== 'string' || !/^[a-f0-9]{16,128}$/i.test(data.token)) return null;
    return { baseUrl: `http://127.0.0.1:${port}/orchestration`, token: data.token };
  } catch {
    return null;
  }
}

function resolveOrchestrationEndpoint() {
  const fromFile = readEndpointFile();
  if (fromFile) return fromFile;
  const token = process.env.AHA_AGENT_HOOK_TOKEN || '';
  if (process.env.AHA_ORCHESTRATION_URL) {
    return { baseUrl: process.env.AHA_ORCHESTRATION_URL.replace(/\/+$/, ''), token };
  }
  if (process.env.AHA_AGENT_HOOK_URL) {
    return {
      baseUrl: process.env.AHA_AGENT_HOOK_URL.replace(/\/hook\/?$/, '') + '/orchestration',
      token,
    };
  }
  if (process.env.AHA_AGENT_HOOK_PORT) {
    return {
      baseUrl: `http://127.0.0.1:${process.env.AHA_AGENT_HOOK_PORT}/orchestration`,
      token,
    };
  }
  return null;
}

function postOrchestrationAction(action, payload, activeRequests) {
  const endpoint = resolveOrchestrationEndpoint();
  if (!endpoint) {
    return Promise.reject(
      new Error('Missing AhaStation orchestration endpoint environment variables.')
    );
  }
  const urlStr = `${endpoint.baseUrl}/${action}`;
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const bodyText = JSON.stringify(payload || {});
    const client = parsed.protocol === 'https:' ? https : http;

    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyText),
    };
    if (endpoint.token) {
      headers['x-aha-agent-hook-token'] = endpoint.token;
    }
    if (process.env.AHA_TERMINAL_ID) {
      headers['x-aha-pty-id'] = process.env.AHA_TERMINAL_ID;
    }
    if (process.env.AHA_ORCHESTRATION_PANE_TOKEN) {
      headers['x-aha-pane-token'] = process.env.AHA_ORCHESTRATION_PANE_TOKEN;
    }

    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          if (activeRequests) activeRequests.delete(req);
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const json = JSON.parse(text);
            resolve({ status: res.statusCode || 500, body: json });
          } catch {
            reject(new Error(`Invalid JSON response (${res.statusCode}): ${text}`));
          }
        });
      }
    );

    if (activeRequests) activeRequests.add(req);
    req.on('error', (err) => {
      if (activeRequests) activeRequests.delete(req);
      reject(err);
    });

    req.write(bodyText);
    req.end();
  });
}

function buildDelegateTaskTool(ctx) {
  const roster = Array.isArray(ctx && ctx.roster) ? ctx.roster : [];
  const available = roster.filter((entry) => entry && entry.available);
  const availableCliIds = [];
  for (const entry of available) {
    if (typeof entry.cliId === 'string' && !availableCliIds.includes(entry.cliId)) {
      availableCliIds.push(entry.cliId);
    }
  }
  const agentEnum = ['auto', ...availableCliIds];

  const descParts = [
    'Delegate a task to a Coding Agent worker in AhaStation (spawns or reuses a worker terminal with optional isolated Git worktree).',
  ];

  if (available.length > 0) {
    const cliSummaries = available.map((a) => {
      const idleCount = Array.isArray(a.idlePanes) ? a.idlePanes.length : 0;
      const idlePart = idleCount > 0 ? `, ${idleCount} idle pane${idleCount > 1 ? 's' : ''}` : '';
      const specPart = a.specialty ? `: ${a.specialty}` : '';
      return `${a.cliId}${specPart}${idlePart}`;
    });
    descParts.push(`Available agents: ${cliSummaries.join('; ')}.`);
  }

  const confirmMode = (ctx && ctx.confirmMode) || 'chat-and-guard';
  if (confirmMode === 'chat-and-guard') {
    descParts.push(
      'Confirmation rule (2-step): before spawning workers on a new user request, first call delegate_task with confirmed=false to register the dispatch plan without spawning (returns resolved agent & worktree), then briefly ask the user in one natural sentence to confirm the role, Coding Agent, task, and worktree isolation; after the user replies to confirm, call delegate_task with confirmed=true (parallel batch calls in the confirmed turn all pass without re-confirming).'
    );
  } else if (confirmMode === 'always-ui') {
    descParts.push(
      'This call waits for the user to approve (or adjust agent/worktree) in the AhaStation UI.'
    );
  }

  return {
    name: 'delegate_task',
    description: descParts.join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: 'Short semantic worker role name without @ (e.g. reviewer, tester, backend).',
        },
        task: {
          type: 'string',
          description: 'Clear, self-contained task specification for the worker.',
        },
        agent: {
          type: 'string',
          enum: agentEnum,
          description: 'Target Coding Agent CLI or "auto" to pick the best fit by taskKind.',
        },
        taskKind: {
          type: 'string',
          enum: TASK_KIND_ENUM,
          description: 'Task category used when agent is "auto" (prefers heterogeneous review).',
        },
        worktree: {
          type: 'boolean',
          description: 'Whether to isolate the worker in a dedicated Git worktree.',
        },
        model: {
          type: 'string',
          description: 'Optional model override for the spawned Coding Agent.',
        },
        effort: {
          type: 'string',
          description: 'Optional reasoning effort override (requires model).',
        },
        terminal: {
          type: 'string',
          description: 'Optional existing idle pane ptyId to reuse.',
        },
        confirmed: {
          type: 'boolean',
          description: 'Set to true only after the user has explicitly confirmed dispatch in chat.',
        },
        planSummary: {
          type: 'string',
          description: 'One-sentence human-readable summary of what this worker will do.',
        },
      },
      required: ['task'],
    },
  };
}

function buildTeamWaitTool() {
  return {
    name: 'team_wait',
    description:
      'Wait reactively for worker completions, questions, permission approval requests, or turn-stop escalations (never poll in a loop).',
    inputSchema: {
      type: 'object',
      properties: {
        timeoutMs: {
          type: 'number',
          description: 'Maximum wait duration in milliseconds (default 120000).',
        },
        peek: {
          type: 'boolean',
          description: 'If true, read unread updates immediately without waiting or acknowledging.',
        },
      },
    },
  };
}

function buildToolsForContext(ctx) {
  if (ctx && ctx.role === 'worker') {
    const tools = [
      {
        name: 'report_done',
        description: 'Report task completion, failure, or blocker back to your coordinator.',
        inputSchema: {
          type: 'object',
          properties: {
            outcome: {
              type: 'string',
              enum: ['completed', 'failed', 'blocked', 'escalated', 'abandoned'],
              description: 'Final outcome (default: completed).',
            },
            summary: {
              type: 'string',
              description: 'Concise summary of what changed, verification results, or root cause.',
            },
          },
          required: ['summary'],
        },
      },
      {
        name: 'ask_coordinator',
        description:
          'Ask your coordinator a clarifying or blocking question instead of guessing (waits for reply by default).',
        inputSchema: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: 'The question to ask the coordinator.',
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional discrete choices.',
            },
            wait: {
              type: 'boolean',
              description: 'Wait for the coordinator answer before returning (default: true).',
            },
            timeoutMs: {
              type: 'number',
              description: 'Wait timeout in milliseconds.',
            },
          },
          required: ['question'],
        },
      },
    ];
    if (ctx.canDelegate) {
      tools.push(buildDelegateTaskTool(ctx), buildTeamWaitTool());
    }
    return tools;
  }

  return [
    {
      name: 'list_coding_agents',
      description:
        'List Coding Agent CLIs available in AhaStation along with their specialties, default models, MCP readiness, and idle panes.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    buildDelegateTaskTool(ctx),
    {
      name: 'team_status',
      description:
        'View active and settled workers managed by this pane (roles, CLIs, stages, open questions/approvals) and pending dispatch proposals.',
      inputSchema: {
        type: 'object',
        properties: {
          includeSettled: {
            type: 'boolean',
            description: 'Include completed/failed/released workers (default: true).',
          },
        },
      },
    },
    buildTeamWaitTool(),
    {
      name: 'message_worker',
      description:
        'Reply to a worker pending question, steer an active worker, or reactivate a settled worker by @role (or dispatch id).',
      inputSchema: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            description: 'Target worker @role name or dispatch id.',
          },
          message: {
            type: 'string',
            description: 'Reply or follow-up instructions for the worker.',
          },
          subject: {
            type: 'string',
            description: 'Optional short subject line when steering or reactivating.',
          },
        },
        required: ['role', 'message'],
      },
    },
    {
      name: 'manage_worker',
      description:
        'Inspect terminal output, approve/deny a pending permission request, release resources, or stop a worker by @role (or dispatch id).',
      inputSchema: {
        type: 'object',
        properties: {
          role: {
            type: 'string',
            description: 'Target worker @role name or dispatch id.',
          },
          action: {
            type: 'string',
            enum: ['read', 'approve', 'deny', 'release', 'stop'],
            description: 'Management action to perform on the target worker.',
          },
          reason: {
            type: 'string',
            description: 'Optional reason when denying an approval or stopping a worker.',
          },
          force: {
            type: 'boolean',
            description: 'Force release/stop even with unread mail or dirty worktree.',
          },
          screen: {
            type: 'boolean',
            description: 'For action="read", read visible terminal screen (default: true).',
          },
        },
        required: ['role', 'action'],
      },
    },
  ];
}

function formatAgentsText(agents) {
  if (!Array.isArray(agents) || agents.length === 0) {
    return 'No coding agents discovered.';
  }
  return agents
    .map((a) => {
      const status = a.available ? 'available' : !a.installed ? 'not-installed' : 'disabled';
      const idle =
        Array.isArray(a.idlePanes) && a.idlePanes.length > 0
          ? `, idlePanes=[${a.idlePanes.map((p) => p.ptyId).join(', ')}]`
          : '';
      const model = a.defaultModel ? `, model=${a.defaultModel}` : '';
      const mcp = a.mcpReady ? `mcp=${a.mcpMode}` : 'mcp=fallback';
      return `- ${a.cliId} (${a.label}) [${status}; ${mcp}${model}${idle}]: ${a.specialty}`;
    })
    .join('\n');
}

function formatTeamStatusText(ctx, includeSettled) {
  const workers = Array.isArray(ctx && ctx.workers) ? ctx.workers : [];
  const filtered =
    includeSettled === false
      ? workers.filter((w) => w.status === 'pending' || w.status === 'dispatched')
      : workers;
  const lines = [];
  if (filtered.length === 0) {
    lines.push('No managed workers.');
  } else {
    lines.push(`Managed workers (${filtered.length}):`);
    for (const w of filtered) {
      const roleLabel = w.role ? `@${w.role}` : w.dispatchId;
      const extras = [];
      if (w.cliId) extras.push(w.cliId);
      extras.push(w.stage || w.status);
      if (w.branch) extras.push(`branch=${w.branch}`);
      if (w.openQuestionCount > 0) extras.push(`${w.openQuestionCount} pending question(s)`);
      if (w.openApprovalCount > 0) extras.push(`${w.openApprovalCount} pending approval(s)`);
      lines.push(`- ${roleLabel} (${w.dispatchId}): ${extras.join(', ')}`);
    }
  }
  const pendingProposals = Array.isArray(ctx && ctx.pendingProposals) ? ctx.pendingProposals : [];
  if (pendingProposals.length > 0) {
    lines.push('', `Pending dispatch proposals (${pendingProposals.length}):`);
    for (const p of pendingProposals) {
      lines.push(
        `- ${p.id}: ${p.role ? `@${p.role}` : '(unnamed)'} -> ${p.resolvedAgent} (worktree=${p.worktree})`
      );
    }
  }
  return lines.join('\n');
}

function formatDelegateResultText(res) {
  if (!res || typeof res !== 'object') return 'Unexpected empty response.';
  if (res.status === 'confirmation_required') {
    const p = res.proposal || {};
    const lines = [
      res.message || 'Dispatch requires user confirmation before starting.',
      `Proposal: ${p.id || ''}`,
      ...(p.role ? [`Role: @${p.role}`] : []),
      `Agent: ${p.resolvedAgent || p.requestedAgent || 'auto'}`,
      `Worktree: ${p.worktree ? 'yes' : 'no'}`,
      ...(p.planSummary ? [`Plan: ${p.planSummary}`] : []),
    ];
    return lines.join('\n');
  }
  if (res.status === 'rejected') {
    return `Dispatch cancelled: ${res.message || 'Rejected by user.'}`;
  }
  const lines = [
    `Worker started${res.role ? ` (@${res.role})` : ''}.`,
    `Agent: ${res.agent}${res.fallbackFrom ? ` (fallback from ${res.fallbackFrom})` : ''}`,
    ...(res.selectionReason ? [`Selection: ${res.selectionReason}`] : []),
    ...(res.dispatch && res.dispatch.id ? [`Dispatch: ${res.dispatch.id}`] : []),
    ...(res.ptyId ? [`Pane: ${res.ptyId}`] : []),
    ...(res.worktreePath ? [`Worktree: ${res.worktreePath}`] : []),
    ...(res.branch ? [`Branch: ${res.branch}`] : []),
    'Use team_wait to wait reactively for completion, questions, or approvals.',
  ];
  return lines.join('\n');
}

function formatMessageWorkerText(res) {
  if (!res || typeof res !== 'object') return 'Message delivered.';
  if (res.mode === 'replied') {
    return `Answered pending question for worker (${res.dispatch ? res.dispatch.id : ''}).`;
  }
  if (res.mode === 'reactivated') {
    const nextId = res.followUp && res.followUp.dispatch ? res.followUp.dispatch.id : '';
    return `Reactivated settled worker as ${nextId}. Use team_wait for its reply.`;
  }
  return `Message delivered to worker (${res.dispatch ? res.dispatch.id : ''}).`;
}

function formatManageWorkerText(res) {
  if (!res || typeof res !== 'object') return 'Action completed.';
  switch (res.action) {
    case 'read': {
      const out = res.output || {};
      const body = typeof out.text === 'string' && out.text.length > 0 ? out.text : '(empty)';
      return `[${out.dispatchId || ''} | ${out.screen ? 'screen' : 'log'} | ${out.alive ? 'alive' : 'exited'}]\n${body}`;
    }
    case 'approve':
      return `Approved permission ${res.approval ? res.approval.approvalId : ''} (${res.approval ? res.approval.toolName : ''}).`;
    case 'deny':
      return `Denied permission ${res.approval ? res.approval.approvalId : ''} (${res.approval ? res.approval.reason || '' : ''}).`;
    case 'release':
      return `Released worker ${res.dispatch ? res.dispatch.id : ''} (closedPane=${Boolean(res.closedPane)}, removedWorktree=${Boolean(res.removedWorktree)}).`;
    case 'stop':
      return `Stopped worker ${res.dispatch ? res.dispatch.id : ''} (closedPane=${Boolean(res.closedPane)}, removedWorktree=${Boolean(res.removedWorktree)}).`;
    default:
      return JSON.stringify(res, null, 2);
  }
}

function toolText(text, isError = false) {
  return {
    content: [{ type: 'text', text: String(text) }],
    ...(isError ? { isError: true } : {}),
  };
}

function nonEmptyStr(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNonNegativeInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

async function handleToolCall(name, rawArgs, activeRequests) {
  if (!process.env.AHA_TERMINAL_ID) {
    return toolText(
      'AhaStation orchestration tools are only available inside an AhaStation terminal.',
      true
    );
  }
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};

  const callAction = async (action, payload) => {
    const res = await postOrchestrationAction(action, payload, activeRequests);
    if (!res.body || res.body.ok !== true) {
      const code = res.body && res.body.code ? `[${res.body.code}] ` : '';
      const errMsg = (res.body && res.body.error) || `HTTP ${res.status}`;
      return { ok: false, errorText: `${code}${errMsg}` };
    }
    return { ok: true, result: res.body.result };
  };

  switch (name) {
    case 'list_coding_agents': {
      const res = await callAction('agents', {});
      if (!res.ok) return toolText(res.errorText, true);
      return toolText(formatAgentsText(res.result && res.result.agents));
    }
    case 'delegate_task': {
      const role = nonEmptyStr(args.role);
      const agent = nonEmptyStr(args.agent);
      const taskKind = nonEmptyStr(args.taskKind ?? args.task_kind);
      const model = nonEmptyStr(args.model);
      const effort = nonEmptyStr(args.effort);
      const terminal = nonEmptyStr(args.terminal);
      const planSummary = nonEmptyStr(args.planSummary ?? args.plan_summary);
      const payload = {
        ...(role ? { role } : {}),
        task: typeof args.task === 'string' ? args.task : '',
        ...(agent ? { agent } : {}),
        ...(taskKind ? { taskKind } : {}),
        ...(typeof args.worktree === 'boolean' ? { worktree: args.worktree } : {}),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(terminal ? { terminal } : {}),
        ...(typeof args.confirmed === 'boolean' ? { confirmed: args.confirmed } : {}),
        ...(planSummary ? { planSummary } : {}),
        callerCwd: process.cwd(),
      };
      const res = await callAction('delegate-task', payload);
      if (!res.ok) return toolText(res.errorText, true);
      return toolText(formatDelegateResultText(res.result));
    }
    case 'team_status': {
      const res = await callAction('mcp-context', {});
      if (!res.ok) return toolText(res.errorText, true);
      const includeSettled =
        typeof args.includeSettled === 'boolean'
          ? args.includeSettled
          : typeof args.include_settled === 'boolean'
            ? args.include_settled
            : undefined;
      return toolText(formatTeamStatusText(res.result, includeSettled));
    }
    case 'team_wait': {
      const peek = args.peek === true;
      const timeoutMs = finiteNonNegativeInt(args.timeoutMs ?? args.timeout_ms);
      const payload = {
        from: process.env.AHA_TERMINAL_ID,
        wait: !peek,
        peek,
        format: true,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      const res = await callAction('check', payload);
      if (!res.ok) return toolText(res.errorText, true);
      const r = res.result || {};
      if (r.count > 0 && typeof r.formatted === 'string' && r.formatted.trim()) {
        return toolText(r.formatted);
      }
      if (r.timedOut) return toolText('No new worker updates (wait timed out).');
      if (r.cancelled) return toolText('Wait cancelled.');
      return toolText('No unread worker updates.');
    }
    case 'message_worker': {
      const subject = nonEmptyStr(args.subject);
      const res = await callAction('role-message', {
        role: typeof args.role === 'string' ? args.role : '',
        message: typeof args.message === 'string' ? args.message : '',
        ...(subject ? { subject } : {}),
      });
      if (!res.ok) return toolText(res.errorText, true);
      return toolText(formatMessageWorkerText(res.result));
    }
    case 'manage_worker': {
      const reason = nonEmptyStr(args.reason);
      const res = await callAction('role-manage', {
        role: typeof args.role === 'string' ? args.role : '',
        action: typeof args.action === 'string' ? args.action : '',
        ...(reason ? { reason } : {}),
        ...(typeof args.force === 'boolean' ? { force: args.force } : {}),
        ...(typeof args.screen === 'boolean' ? { screen: args.screen } : {}),
      });
      if (!res.ok) return toolText(res.errorText, true);
      return toolText(formatManageWorkerText(res.result));
    }
    case 'report_done': {
      const outcome = nonEmptyStr(args.outcome);
      const res = await callAction('worker-done-self', {
        ...(outcome ? { outcome } : {}),
        summary: typeof args.summary === 'string' ? args.summary : '',
      });
      if (!res.ok) return toolText(res.errorText, true);
      const d = res.result && res.result.dispatch;
      return toolText(
        `Completion report recorded (${d ? `${d.id}: ${d.status}` : 'settled'}).`
      );
    }
    case 'ask_coordinator': {
      const timeoutMs = finiteNonNegativeInt(args.timeoutMs ?? args.timeout_ms);
      const options = Array.isArray(args.options)
        ? args.options.map(nonEmptyStr).filter(Boolean)
        : [];
      const payload = {
        question: typeof args.question === 'string' ? args.question : '',
        ...(options.length > 0 ? { options } : {}),
        wait: args.wait !== false,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      };
      const res = await callAction('ask-self', payload);
      if (!res.ok) return toolText(res.errorText, true);
      const r = res.result || {};
      if (typeof r.answer === 'string') {
        return toolText(`Coordinator reply: ${r.answer}`);
      }
      if (r.timedOut) {
        return toolText(`Question ${r.messageId || ''} sent, but timed out waiting for reply.`);
      }
      return toolText(`Question ${r.messageId || ''} sent to coordinator (pending reply).`);
    }
    default:
      return toolText(`Unknown tool: ${name}`, true);
  }
}

function encodeFrame(messageObj, framing) {
  const json = JSON.stringify(messageObj);
  if (framing === 'content-length') {
    const bytes = Buffer.byteLength(json, 'utf8');
    return `Content-Length: ${bytes}\r\n\r\n${json}`;
  }
  return `${json}\n`;
}

function extractFramesFromBuffer(buffer) {
  const frames = [];
  let offset = 0;

  while (offset < buffer.length) {
    // Skip leading CR/LF whitespace between newline-delimited frames.
    while (offset < buffer.length && (buffer[offset] === 0x0d || buffer[offset] === 0x0a)) {
      offset += 1;
    }
    if (offset >= buffer.length) break;

    // Check if the frame begins with an LSP-style Content-Length / Content-Type header.
    const peekLen = Math.min(32, buffer.length - offset);
    const peekStr = buffer.subarray(offset, offset + peekLen).toString('ascii');
    if (
      buffer.length - offset < 16 &&
      buffer.indexOf(0x0a, offset) === -1 &&
      /^content-/i.test(peekStr)
    ) {
      break;
    }
    if (/^(?:content-length|content-type)\s*:/i.test(peekStr)) {
      const crlfIdx = buffer.indexOf('\r\n\r\n', offset);
      const lfIdx = buffer.indexOf('\n\n', offset);
      let headerEnd = -1;
      let sepLen = 0;
      if (crlfIdx !== -1 && (lfIdx === -1 || crlfIdx < lfIdx)) {
        headerEnd = crlfIdx;
        sepLen = 4;
      } else if (lfIdx !== -1) {
        headerEnd = lfIdx;
        sepLen = 2;
      }
      if (headerEnd === -1) break;

      const headerBlock = buffer.subarray(offset, headerEnd).toString('ascii');
      const match = /content-length\s*:\s*(\d+)/i.exec(headerBlock);
      if (!match) {
        offset = headerEnd + sepLen;
        continue;
      }
      const contentLength = Number(match[1]);
      const bodyStart = headerEnd + sepLen;
      if (buffer.length < bodyStart + contentLength) break;

      const bodyStr = buffer.subarray(bodyStart, bodyStart + contentLength).toString('utf8');
      frames.push({ framing: 'content-length', raw: bodyStr });
      offset = bodyStart + contentLength;
      continue;
    }

    // Standard MCP stdio transport: newline-delimited JSON-RPC.
    const nlIdx = buffer.indexOf(0x0a, offset);
    if (nlIdx === -1) break;
    const line = buffer.subarray(offset, nlIdx).toString('utf8').replace(/\r$/, '').trim();
    offset = nlIdx + 1;
    if (line.length > 0) {
      frames.push({ framing: 'newline', raw: line });
    }
  }

  return {
    frames,
    remainder: offset > 0 ? buffer.subarray(offset) : buffer,
  };
}

function runMcpServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const activeRequests = new Set();
  let buffer = Buffer.alloc(0);
  let inFlight = 0;
  let stdinEnded = false;
  let resolveDone;
  const donePromise = new Promise((resolve) => {
    resolveDone = resolve;
  });

  const maybeFinish = () => {
    if (stdinEnded && inFlight === 0) {
      resolveDone();
    }
  };

  const writeResponse = (msg, framing) => {
    try {
      output.write(encodeFrame(msg, framing));
    } catch {
      // Ignore broken pipe when host disconnects.
    }
  };

  const dispatchMessage = async (msg, framing) => {
    if (!msg || typeof msg !== 'object') return;
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
    const id = msg.id;
    const method = typeof msg.method === 'string' ? msg.method : '';
    const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

    // Notifications (no id) require no response.
    if (!hasId) {
      return;
    }

    try {
      if (method === 'initialize') {
        const protocolVersion =
          typeof params.protocolVersion === 'string' && params.protocolVersion.trim()
            ? params.protocolVersion.trim()
            : DEFAULT_PROTOCOL_VERSION;
        writeResponse(
          {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: SERVER_INFO,
            },
          },
          framing
        );
        return;
      }

      if (method === 'ping') {
        writeResponse({ jsonrpc: '2.0', id, result: {} }, framing);
        return;
      }

      if (method === 'tools/list') {
        if (!process.env.AHA_TERMINAL_ID) {
          writeResponse({ jsonrpc: '2.0', id, result: { tools: [] } }, framing);
          return;
        }
        let ctx = null;
        try {
          const res = await postOrchestrationAction('mcp-context', {}, activeRequests);
          if (res.body && res.body.ok === true && res.body.result) {
            ctx = res.body.result;
          }
        } catch {
          writeResponse({ jsonrpc: '2.0', id, result: { tools: [] } }, framing);
          return;
        }
        if (!ctx) {
          writeResponse({ jsonrpc: '2.0', id, result: { tools: [] } }, framing);
          return;
        }
        writeResponse(
          { jsonrpc: '2.0', id, result: { tools: buildToolsForContext(ctx) } },
          framing
        );
        return;
      }

      if (method === 'tools/call') {
        const toolName = typeof params.name === 'string' ? params.name : '';
        const result = await handleToolCall(toolName, params.arguments, activeRequests);
        writeResponse({ jsonrpc: '2.0', id, result }, framing);
        return;
      }

      writeResponse(
        {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        },
        framing
      );
    } catch (err) {
      writeResponse(
        {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        },
        framing
      );
    }
  };

  const processFrame = (frame) => {
    let parsed;
    try {
      parsed = JSON.parse(frame.raw);
    } catch {
      writeResponse(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        },
        frame.framing
      );
      return;
    }
    inFlight += 1;
    Promise.resolve(dispatchMessage(parsed, frame.framing)).finally(() => {
      inFlight -= 1;
      maybeFinish();
    });
  };

  input.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    buffer = buffer.length === 0 ? buf : Buffer.concat([buffer, buf]);
    const extracted = extractFramesFromBuffer(buffer);
    buffer = extracted.remainder;
    for (const frame of extracted.frames) {
      processFrame(frame);
    }
  });

  input.on('end', () => {
    const trailing = buffer.toString('utf8').trim();
    buffer = Buffer.alloc(0);
    if (trailing.startsWith('{')) {
      processFrame({ framing: 'newline', raw: trailing });
    }
    stdinEnded = true;
    maybeFinish();
  });

  const abortActive = () => {
    for (const req of activeRequests) {
      try {
        req.destroy();
      } catch {
        // ignore
      }
    }
    activeRequests.clear();
  };

  input.on('close', () => {
    stdinEnded = true;
    maybeFinish();
  });
  process.once('SIGINT', () => {
    abortActive();
    stdinEnded = true;
    resolveDone();
  });
  process.once('SIGTERM', () => {
    abortActive();
    stdinEnded = true;
    resolveDone();
  });

  if (typeof input.resume === 'function') {
    input.resume();
  }

  return donePromise;
}

if (require.main === module) {
  runMcpServer().catch(() => {
    process.exitCode = 1;
  });
}

module.exports = {
  runMcpServer,
  extractFramesFromBuffer,
  encodeFrame,
  buildToolsForContext,
  resolveOrchestrationEndpoint,
};
