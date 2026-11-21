import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { enabledCodexPilot, launchCodexPilot } from '../dist-electron/orchestration/codex-app-server-pilot.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';

const enabled = enabledCodexPilot(process.platform, false, process.env.AHA_CODEX_APP_SERVER_PILOT);
assert.ok(enabled, 'Run on Windows with AHA_CODEX_APP_SERVER_PILOT=1 and an authenticated Codex CLI.');
const cwd = process.cwd();
const agentStatusStore = new AgentStatusStore();
const store = new OrchestrationStore();
const hook = new AgentHookServer(agentStatusStore);
const coordinator = 'pilot-acceptance-coordinator';
const mcpServerPath = resolve('dist-electron/orchestration/aha-mcp-server.cjs');
let ptyAttempts = 0;
let sessions = 0;
const evidence = (step, data) => console.log(JSON.stringify({ step, ...data }));

const service = new OrchestrationService({
  store, agentStatusStore, getDefaultCwd: () => cwd,
  writePty: async () => { throw new Error('Unexpected PTY input'); },
  spawnWorkerPty: async () => {
    ptyAttempts++;
    throw new Error('Trial did not reach the Codex app-server path');
  },
  codexPilot: {
    enabled: () => enabled,
    launch: (id, workdir, events) => {
      sessions++;
      return launchCodexPilot({
        cwd: workdir, mcpServerPath, mcpEnv: hook.envForWorker(id),
        events: {
          ...events,
          onExit(reason, code) {
            evidence('child-exit', { reason, code });
            events.onExit(reason, code);
          },
        },
      });
    },
  },
});

async function waitFor(label, read, timeoutMs = 160_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(130);
  }
  const state = service.workerList().workers.map(({ dispatch }) => ({
    id: dispatch.id, stage: dispatch.stage, status: dispatch.status,
    reason: dispatch.lastFailureReason, turn: dispatch.codexTurn?.stopReason,
    output: dispatch.codexTurn?.finalText.slice(0, 600),
  }));
  throw new Error(label + ' timed out: ' + JSON.stringify(state));
}

function approveReportRequest(dispatchId) {
  const request = service.workerShow({ dispatchId }).openApprovals.find((item) =>
    item.eventName === 'mcpServer/elicitation/request');
  if (!request) return;
  const details = JSON.parse(request.toolInput);
  evidence('mcp-confirmation-request', {
    server: details.server, message: request.message, metadata: details.metadata, schema: details.schema,
  });
  assert.equal(details.server, 'aha');
  assert.match(JSON.stringify(details) + request.message, /report_done/i);
  service.approve({ id: request.approvalId, reason: 'Acceptance test: allow the Aha completion report' }, coordinator);
}

function findReport(dispatchId) {
  return store.listMessages({ type: 'worker_done' }).find((message) => {
    if (!message.payload) return false;
    return JSON.parse(message.payload).dispatchId === dispatchId;
  });
}

hook.setOrchestrationHandler(async (action, payload, context) => {
  const result = await dispatchOrchestrationHttpAction(service, action, payload, context);
  if (action === 'worker-done-self') {
    evidence('report-http', { status: result.status, code: result.body.code, error: result.body.error });
  }
  return result;
});
await hook.start();
try {
  const { run } = service.runCreate({
    from: coordinator, paneId: coordinator, objective: 'Windows Codex read-only pilot acceptance',
  });
  const marker = '竹海-终章-0729';
  const paragraphs = Array.from({ length: 90 }, (_, index) =>
    '只读测试段落 ' + (index + 1) + '。' + '这段文字只用于确认长中文输入完整传输，不需要复述。'.repeat(6));
  const spec = [
    '这是 AhaStation 的只读验收。不要读写文件，也不要运行命令。',
    '请找到最后一段的终章标记。必须直接调用 Aha MCP 的 report_done，summary 只填写该标记，然后结束。',
    ...paragraphs, '终章标记为 ' + marker,
  ].join('\n\n');
  const start = await service.workerStart({
    from: coordinator, runId: run.id, cliId: 'codex',
    ...(process.env.AHA_PILOT_MODEL ? { model: process.env.AHA_PILOT_MODEL } : {}),
    effort: 'low', readOnly: true, noWorktree: true, cwd, spec,
  });
  const first = start.dispatch;
  assert.equal(first.assigneePaneId, null);
  assert.equal(first.ownsPane, false);
  assert.ok(first.providerSessionId);
  evidence('long-prompt-accepted', {
    dispatchId: first.id, threadId: first.providerSessionId, inputBytes: Buffer.byteLength(spec),
    startObservation: first.startObservation,
  });

  const report = await waitFor('first MCP report_done', () => {
    approveReportRequest(first.id);
    const received = findReport(first.id);
    const turn = store.getDispatchContext(first.id).codexTurn;
    if (!received && turn) {
      const output = service.workerRead({ dispatchId: first.id, screen: true }).text;
      throw new Error('First turn ended without report_done: ' + output.slice(-1_500));
    }
    return received;
  });
  assert.match(JSON.parse(report.payload).summary, new RegExp(marker));
  assert.equal(store.getDispatchContext(first.id).status, 'completed');
  await waitFor('first turn completion', () => store.getDispatchContext(first.id).codexTurn);
  evidence('mcp-report-accepted', { dispatchId: first.id, summary: JSON.parse(report.payload).summary });

  const followUp = await service.send({
    runId: run.id, from: coordinator, to: 'dispatch:' + first.id, type: 'status',
    subject: '只读续轮和审批验收', body: [
      '这是审批机制的只读验收。请只发起一次命令审批，不要修改任何文件。',
      '调用本地命令工具执行 Get-Location，必须明确传 sandbox_permissions=require_escalated，并用一句话说明这是测试审批。',
      'Coordinator 会拒绝。收到拒绝后立即调用 Aha MCP 的 report_done。summary 请包含上一轮终章标记和字符串 APPROVAL_DECLINED。',
    ].join('\n'),
  });
  const second = followUp.followUp.dispatch;
  assert.equal(second.providerSessionId, first.providerSessionId);
  assert.equal(second.assigneeHandle, first.assigneeHandle);
  evidence('follow-up-accepted', { dispatchId: second.id, threadId: second.providerSessionId, sessions });
  const request = await waitFor('approval request', () => service.workerShow({ dispatchId: second.id }).openApprovals[0], 75_000);
  const { approval } = service.deny({ id: request.approvalId, reason: 'Acceptance test: deny the read-only command' }, coordinator);
  assert.equal(approval.status, 'denied');
  evidence('approval-denied', { approvalId: approval.approvalId, tool: approval.toolName, input: approval.toolInput });
  const afterDenial = await waitFor('report after denial', () => {
    approveReportRequest(second.id);
    return findReport(second.id);
  });
  const summary = JSON.parse(afterDenial.payload).summary;
  assert.match(summary, /APPROVAL_DECLINED/);
  assert.match(summary, new RegExp(marker));
  await waitFor('second turn completion', () => store.getDispatchContext(second.id).codexTurn);
  evidence('worker-returned-after-denial', { summary });

  const cancelFollowUp = await service.send({
    runId: run.id, from: coordinator, to: 'dispatch:' + second.id, type: 'status',
    subject: '取消验收', body: '请开始输出一段不少于 3000 字的中文自然景物描写，不要运行命令或提前汇报。Coordinator 将取消本次回合。',
  });
  const third = cancelFollowUp.followUp.dispatch;
  assert.equal(third.providerSessionId, first.providerSessionId);
  await waitFor('streamed output before cancel', () => {
    const read = service.workerRead({ dispatchId: third.id, screen: true });
    return read.alive && read.text.length ? read : null;
  }, 30_000);
  const stopped = await service.workerStop({ dispatchId: third.id, reason: 'Windows pilot cancellation acceptance' });
  const archived = service.workerRead({ dispatchId: third.id, screen: true });
  assert.equal(stopped.dispatch.status, 'failed');
  assert.equal(service.isPaneAlive(third.assigneeHandle), false);
  assert.equal(archived.archived, true);
  assert.ok(archived.text.length);
  assert.equal(service.workerShow({ dispatchId: third.id }).openApprovals.length, 0);
  assert.equal(ptyAttempts, 0);
  assert.equal(sessions, 1);
  evidence('cancelled-and-archived', {
    status: stopped.dispatch.status, turnStatus: stopped.dispatch.codexTurn?.stopReason,
    alive: archived.alive, archivedChars: archived.text.length, ptyAttempts, sessions,
  });
} finally {
  await service.stopCodexWorkers();
  service.dispose();
  await hook.stop();
}
