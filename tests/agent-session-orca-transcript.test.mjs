import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';
import { resolveTerminalLinkPath } from '../dist-electron/ipc/shell-pty.js';

const dir = mkdtempSync(join(tmpdir(), 'aha-orca-transcript-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

async function bundleEntry(name, contents) {
  const outfile = join(dir, `${name}.cjs`);
  await build({
    stdin: {
      contents,
      resolveDir: repoRoot,
      loader: 'tsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return mod.default ?? mod;
}

const helpers = await bundleEntry(
  'helpers',
  `
    export * from './src/lib/shared/native-chat/native-chat-text-reveal.ts';
    export * from './src/lib/shared/native-chat/native-chat-reply-reveals.ts';
    export * from './src/lib/session-turn-model.ts';
    export * from './src/lib/session-work-log-model.ts';
    export * from './src/lib/session-file-link-checker.ts';
    export { parseUnifiedDiff } from './src/lib/git-panel-model.ts';
    export { resolveSessionLinkTarget } from './src/components/agent-session/SessionMarkdown.tsx';
  `,
);

const ui = await bundleEntry(
  'ui',
  `
    import { createElement } from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { SessionMarkdown } from './src/components/agent-session/SessionMarkdown.tsx';
    import { SessionEmptyState } from './src/components/agent-session/SessionEmptyState.tsx';
    import { WorkGroup, WorkItemRow, WorkLogRow, SessionNoticeRow } from './src/components/agent-session/SessionWorkLog.tsx';
    import { TurnView } from './src/components/agent-session/SessionTurnView.tsx';
    import { AgentSessionContext } from './src/components/agent-session/session-context.ts';
    import { SessionDisclosureContext } from './src/components/agent-session/session-disclosure-store.tsx';

    export const renderMarkdown = (props) => renderToStaticMarkup(createElement(SessionMarkdown, props));
    export const renderEmptyState = (props) => renderToStaticMarkup(createElement(SessionEmptyState, props));
    export const renderWorkGroup = (props) => renderToStaticMarkup(createElement(WorkGroup, props));
    export const renderWorkItem = (props) => renderToStaticMarkup(createElement(WorkItemRow, props));
    export const renderWorkLogRow = (props) => renderToStaticMarkup(createElement(WorkLogRow, props));
    export const renderNotice = (props) => renderToStaticMarkup(createElement(SessionNoticeRow, props));
    export const renderTurn = (props, options = {}) => {
      const openKeys = new Set(options.openKeys ?? []);
      const store = { read: (k) => (openKeys.has(k) ? true : undefined), write: () => {} };
      return renderToStaticMarkup(
        createElement(
          AgentSessionContext.Provider,
          { value: { cwd: options.cwd ?? 'C:/repo', appearance: 'light' } },
          createElement(
            SessionDisclosureContext.Provider,
            { value: store },
            createElement(TurnView, props),
          ),
        ),
      );
    };
  `,
);

test('paced text reveal respects CJK char & English word boundaries, reduced motion, and hidden-window deadline fallback', async () => {
  assert.equal(helpers.isSpacelessScriptChar('中'), true);
  assert.equal(helpers.isSpacelessScriptChar('a'), false);

  // English partial word is held until boundary when more text is pending; CJK advances per character.
  assert.equal(helpers.pacedTextEnd('hello world', 3, true), 5);
  assert.equal(helpers.pacedTextEnd('streaming', 4, true), 0, 'incomplete trailing English word held back');
  assert.equal(helpers.pacedTextEnd('你好世界', 2, true), 2, 'CJK advances cleanly by character');

  // Arrival pacing and reduced-motion immediate completion.
  let state = helpers.startNativeChatTextReveal('你好世界', true, undefined, true, 0, 200);
  assert.equal(state.shown, 0);
  state = helpers.advanceNativeChatText(state, 100, 200);
  assert.equal(state.shown, 2);
  state = helpers.advanceNativeChatText(state, 200, 200);
  assert.equal(state.shown, 4);

  const reduced = helpers.receiveNativeChatText(
    { source: 'abc', shown: 0, arrivals: [{ from: 0, to: 3, at: 0 }] },
    'abcdef',
    true,
    true,
    10,
    200,
  );
  assert.equal(reduced.shown, 6, 'prefers-reduced-motion shows full text immediately');

  // Non-prefix text replacement snaps immediately instead of getting stuck.
  const replaced = helpers.arriveNativeChatText({ source: 'hello', shown: 2, arrivals: [] }, 'other', 50);
  assert.equal(replaced.shown, 5);

  // Hidden-window fallback: rAF never fires, yet the deadline timer still finishes the reveal.
  let now = 0;
  let current = helpers.startNativeChatTextReveal('测试回退', true, undefined, true, now, 30);
  const steps = [];
  const cancel = helpers.playNativeChatTextReveal(
    () => current,
    (next) => {
      current = next;
      steps.push(next.shown);
    },
    {
      now: () => now,
      request: () => 1, // Simulates background/hidden window where rAF never calls back.
      cancel: () => {},
    },
    30,
  );
  now = 40;
  await new Promise((resolve) => setTimeout(resolve, 60));
  cancel();
  assert.equal(current.shown, 4, 'deadline timer catches up when rAF stops');
  assert.ok(steps.at(-1) === 4);

  // Word-fade tokenizer matches CJK chars, whitespace, and English words.
  assert.deepEqual(
    helpers.markdownWordTokens('修复 auth bug').map((t) => t.value),
    ['修', '复', ' ', 'auth', ' ', 'bug'],
  );
});

test('reply reveal tracker skips loaded history, remembers progress across remount, and paces fresh sessions', () => {
  // Opening a session with pre-existing history does not animate existing rows.
  const historyTracker = helpers.createNativeChatReplyRevealTracker();
  const initialReveals = helpers.trackNativeChatReplyRows(
    historyTracker,
    ['t1:m1', 't2:m2'],
    new Set(['t1:m1', 't2:m2']),
    true,
  );
  assert.equal(initialReveals.begun.size, 0);
  const loadedStart = helpers.startNativeChatTextReveal('historical text', false, undefined, false, 0);
  assert.equal(loadedStart.shown, 'historical text'.length);

  // A new reply arriving after load IS marked begun.
  helpers.trackNativeChatReplyRows(
    historyTracker,
    ['t1:m1', 't2:m2', 't3:m3'],
    new Set(['t1:m1', 't2:m2', 't3:m3']),
    true,
  );
  assert.equal(initialReveals.begun.has('t3:m3'), true);

  // Remounting with remembered progress resumes without replaying from 0.
  const remembered = { source: 'hello world', shown: 6, arrivals: [{ from: 0, to: 11, at: 0 }] };
  const resumed = helpers.startNativeChatTextReveal('hello world', true, remembered, true, 100, 350);
  assert.ok(resumed.shown >= 6);

  // A brand-new empty session primed at load paces its very first streaming reply.
  const freshTracker = helpers.createNativeChatReplyRevealTracker();
  helpers.trackNativeChatReplyRows(freshTracker, [], new Set(), true);
  const freshReveals = helpers.trackNativeChatReplyRows(freshTracker, ['t1:m1'], new Set(['t1:m1']), true);
  assert.equal(freshReveals.begun.has('t1:m1'), true);
});

test('turn status, live activity, reasoning disclosure keys, and turn folding protect pending approvals and unexplained failures', () => {
  assert.equal(
    helpers.describeTurnStatus({ status: 'running', startedAt: 0, completedAt: null }, 65).label,
    '正在工作 1m 05s',
  );
  assert.equal(
    helpers.describeTurnStatus({ status: 'running', startedAt: 0, completedAt: null, commandKind: 'compact' }, 4).label,
    '正在压缩上下文 4s',
  );
  assert.equal(
    helpers.describeTurnStatus({ status: 'completed', startedAt: 1_000, completedAt: 15_400 }, 0).label,
    '已工作 14s',
  );
  assert.equal(
    helpers.describeTurnStatus({ status: 'interrupted', startedAt: 1_000, completedAt: 6_000 }, 0).label,
    '已中断 · 用时 5s',
  );
  assert.equal(
    helpers.describeTurnStatus({ status: 'failed', startedAt: 1_000, completedAt: 9_000 }, 0).label,
    '已失败 · 用时 8s',
  );

  // Reasoning headlines & turn-scoped disclosure keys.
  assert.equal(
    helpers.describeReasoningHeadline({ status: 'running', startedAt: 1000, completedAt: null }, { turnRunning: true }),
    '思考中',
  );
  assert.equal(
    helpers.describeReasoningHeadline({ status: 'completed', startedAt: 1000, completedAt: 4200 }, { turnRunning: false }),
    '思考了 3s',
  );
  assert.equal(
    helpers.describeReasoningHeadline({ status: 'completed', startedAt: null, completedAt: null }, { turnRunning: false }),
    '已思考',
  );
  assert.notEqual(
    helpers.reasoningDisclosureKey('d1#1', 'r1'),
    helpers.reasoningDisclosureKey('d1#2', 'r1'),
    'disclosure keys stay scoped per turn when later turns reuse item ids',
  );

  // Live reasoning at tail (ignoring trailing info notice) vs pending approval suppression.
  const runningReasoningTurn = {
    status: 'running',
    items: [
      { id: 'c1', kind: 'command', status: 'completed', command: 'ls', cwd: null, output: '', outputTruncated: false, exitCode: 0, durationMs: 10, startedAt: 1, completedAt: 2 },
      { id: 'r1', kind: 'reasoning', status: 'running', summary: '先检查依赖', text: '', startedAt: 3, completedAt: null },
      { id: 'n1', kind: 'notice', level: 'info', text: '心跳正常', startedAt: 4, completedAt: 4 },
    ],
  };
  const liveActivity = helpers.describeTurnActivity(runningReasoningTurn);
  assert.equal(liveActivity.label, '思考中');
  assert.equal(liveActivity.reasoning.item.id, 'r1');
  assert.equal(liveActivity.reasoning.markdown, '先检查依赖');
  assert.equal(helpers.describeTurnActivity(runningReasoningTurn, { stopping: true }).label, '正在停止…');
  assert.equal(helpers.describeTurnActivity(runningReasoningTurn, { stopping: true }).reasoning, null);

  const pendingApprovalTurn = {
    status: 'running',
    items: [
      { id: 'a1', kind: 'approval', approvalId: 'ap1', method: 'exec', tool: 'shell', input: 'rm -rf', reason: null, status: 'pending', resolution: null, startedAt: 1, completedAt: null },
    ],
  };
  assert.equal(helpers.describeTurnActivity(pendingApprovalTurn), null, 'pending approval suppresses working spinner');

  // Settled turn folding: keeps final answer, plans, settlements, warnings/errors, pending approvals; folds intermediate steps.
  const settledTurn = {
    status: 'completed',
    items: [
      { id: 'r1', kind: 'reasoning', status: 'completed', summary: 'plan', text: '', startedAt: 1, completedAt: 2 },
      { id: 'c1', kind: 'command', status: 'completed', command: 'rg foo src', cwd: null, output: '', outputTruncated: false, exitCode: 0, durationMs: 50, startedAt: 2, completedAt: 3 },
      { id: 'm_pre', kind: 'message', status: 'completed', role: 'assistant', text: '我先查一下。', startedAt: 3, completedAt: 4 },
      { id: 'c2', kind: 'command', status: 'completed', command: 'npm test', cwd: null, output: 'ok', outputTruncated: false, exitCode: 0, durationMs: 200, startedAt: 4, completedAt: 5 },
      { id: 'f1', kind: 'file_change', status: 'completed', files: [{ path: 'src/a.ts', change: 'update', movePath: null, diff: '@@ -1 +1 @@\n-a\n+b', added: 1, removed: 1, truncated: false }], startedAt: 5, completedAt: 6 },
      { id: 'w1', kind: 'notice', level: 'warning', text: '上下文接近上限', startedAt: 6, completedAt: 6 },
      { id: 'p1', kind: 'plan', status: 'completed', explanation: null, steps: [{ step: '修复', status: 'completed' }], text: '', startedAt: 6, completedAt: 6 },
      { id: 'm_final', kind: 'message', status: 'completed', role: 'assistant', text: '已完成修改并通过测试。', startedAt: 7, completedAt: 8 },
      { id: 's1', kind: 'settlement', settlement: 'report_done', stopReason: null, outcome: 'completed', verdict: 'approve', findings: [], summary: 'ok', diff: null, diffSource: null, startedAt: 8, completedAt: 8 },
    ],
  };
  const fold = helpers.planTurnFold(settledTurn, { hasChangesCard: true });
  assert.equal(fold.foldable, true);
  assert.equal(fold.foldedItemIds.has('r1'), true);
  assert.equal(fold.foldedItemIds.has('c1'), true);
  assert.equal(fold.foldedItemIds.has('m_pre'), true);
  assert.equal(fold.foldedItemIds.has('c2'), true);
  assert.equal(fold.foldedItemIds.has('f1'), true, 'covered by TurnChangesCard');
  assert.equal(fold.foldedItemIds.has('w1'), false, 'warning stays visible');
  assert.equal(fold.foldedItemIds.has('p1'), false, 'plan stays visible');
  assert.equal(fold.foldedItemIds.has('m_final'), false, 'final answer stays visible');
  assert.equal(fold.foldedItemIds.has('s1'), false, 'Worker settlement stays visible');

  // Unexplained failure MUST NOT be folded when there is no final prose or settlement.
  const unexplainedFailureTurn = {
    status: 'failed',
    items: [
      { id: 'c_ok', kind: 'command', status: 'completed', command: 'git status', cwd: null, output: '', outputTruncated: false, exitCode: 0, durationMs: 10, startedAt: 1, completedAt: 2 },
      { id: 'c_fail', kind: 'command', status: 'failed', command: 'npm test', cwd: null, output: 'FAIL', outputTruncated: false, exitCode: 1, durationMs: 50, startedAt: 2, completedAt: 3 },
      { id: 'a_pending', kind: 'approval', approvalId: 'ap2', method: 'exec', tool: 'shell', input: 'x', reason: null, status: 'pending', resolution: null, startedAt: 3, completedAt: null },
    ],
  };
  const failFold = helpers.planTurnFold(unexplainedFailureTurn, { hasChangesCard: false });
  assert.equal(failFold.foldedItemIds.has('c_ok'), true);
  assert.equal(failFold.foldedItemIds.has('c_fail'), false, 'unexplained failed command is never hidden');
  assert.equal(failFold.foldedItemIds.has('a_pending'), false, 'pending approval is never hidden');
});

test('semantic Chinese work-log sentences, file target extraction, outcome badges, and lazy detail mounting', () => {
  const items = [
    { id: 'r1', kind: 'reasoning', status: 'completed', summary: 'x', text: '', startedAt: 1, completedAt: 2 },
    { id: 'c1', kind: 'command', status: 'completed', command: 'bash -lc "cat src/auth/refresh.ts"', cwd: null, output: '', outputTruncated: false, exitCode: 0, durationMs: 20, startedAt: 2, completedAt: 3 },
    { id: 'c2', kind: 'command', status: 'completed', command: 'bash -lc "rg -n token src"', cwd: null, output: '', outputTruncated: false, exitCode: 0, durationMs: 20, startedAt: 3, completedAt: 4 },
    { id: 'c3', kind: 'command', status: 'failed', command: 'npm test', cwd: null, output: 'fail', outputTruncated: false, exitCode: 1, durationMs: 100, startedAt: 4, completedAt: 5 },
    { id: 't1', kind: 'tool_call', status: 'declined', toolType: 'mcp', server: 'aha', tool: 'read_board', args: '{}', progress: null, output: '', error: null, durationMs: 10, startedAt: 5, completedAt: 6 },
  ];

  assert.equal(helpers.extractReadCommandFilePath('cat src/auth/refresh.ts'), 'src/auth/refresh.ts');
  assert.equal(helpers.extractReadCommandFilePath('cat src/auth/refresh.ts | grep token'), null, 'piped commands are not misclassified as simple reads');
  assert.deepEqual(helpers.extractWorkItemFileTarget(items[1]), {
    path: 'src/auth/refresh.ts',
    label: 'src/auth/refresh.ts',
    openable: true,
  });

  const summary = helpers.summarizeWorkRun(items, { live: false });
  assert.equal(summary.sentence, '思考了 1 次、读取了 1 个文件、搜索了 1 次、运行了 1 条命令、调用了 1 次集成');
  assert.equal(summary.failedCount, 1);
  assert.equal(summary.declinedCount, 1);
  assert.equal(summary.succeeded, false);
  assert.equal(summary.icon, 'wrench');

  const liveSummary = helpers.summarizeWorkRun(items.slice(1, 3), { live: true });
  assert.equal(liveSummary.sentence, '正在读取 1 个文件、正在搜索');
  assert.equal(liveSummary.latestPreview, 'rg -n token src');

  // Lone settled shell command shows its unwrapped command directly.
  assert.equal(helpers.formatWorkRunSentence([items[3]], { live: false }), 'npm test');

  // Code fence language labels.
  assert.equal(helpers.codeFenceLanguageLabel('ts'), 'TypeScript');
  assert.equal(helpers.codeFenceLanguageLabel('pwsh'), 'PowerShell');
  assert.equal(helpers.codeFenceLanguageLabel('text'), '纯文本');
  assert.equal(helpers.codeFenceLanguageLabel(''), '代码');

  // Inline diff detection + lazy args formatting.
  assert.ok(helpers.extractInlineDiffFromText('@@ -1,2 +1,2 @@\n-old\n+new'));
  assert.match(helpers.formatLazyToolArgs('{"a":1,"b":2}'), /\n  "a": 1,/);

  // Verify WorkGroup renders Chinese sentence and outcome badges, and collapsed WorkLogRow is strictly lazy.
  const groupHtml = ui.renderWorkGroup({
    block: { type: 'group', id: 'group:r1', items, running: false, durationMs: 1_500 },
    turnKey: 'd1#1',
  });
  assert.match(groupHtml, /思考了 1 次、读取了 1 个文件、搜索了 1 次、运行了 1 条命令、调用了 1 次集成/);
  assert.match(groupHtml, /· 1 项失败/);
  assert.match(groupHtml, /· 1 项已拒绝/);
  assert.doesNotMatch(groupHtml, /asv-group-body/, 'collapsed WorkGroup mounts no member DOM');

  let detailEvaluations = 0;
  const lazyHtml = ui.renderWorkLogRow({
    icon: null,
    label: '行标题',
    hasDetail: true,
    renderDetail: () => {
      detailEvaluations += 1;
      return '详细内容';
    },
  });
  assert.equal(detailEvaluations, 0, 'collapsed WorkLogRow must not evaluate lazy detail');
  assert.doesNotMatch(lazyHtml, /详细内容/);

  // Clickable file pill for reads and non-openable static pill for deleted files.
  const readCmdHtml = ui.renderWorkItem({ item: items[1], turnKey: 'd1#1' });
  assert.match(readCmdHtml, /class="asv-file-pill"/);
  assert.match(readCmdHtml, /src\/auth\/refresh\.ts/);
  const deletedHtml = ui.renderWorkItem({
    item: {
      id: 'fc-del', kind: 'file_change', status: 'completed',
      files: [{ path: 'old.ts', change: 'delete', movePath: null, diff: '-x', added: 0, removed: 1, truncated: false }],
      startedAt: 1, completedAt: 2,
    },
  });
  assert.match(deletedHtml, /class="asv-file-pill is-static"/);
});

test('Markdown supports double-tilde strikethrough, inline clickable workspace file paths, word fade, code wrap, and batched path checking', async () => {
  const existingFiles = new Set(['src/auth/refresh.ts', 'package.json']);
  const html = ui.renderMarkdown({
    text: [
      '耗时约 1~2 秒，~~旧逻辑~~ 已移除。',
      '',
      '查看 src/auth/refresh.ts:18，以及 `package.json` 和不存在的 src/missing/file.ts。',
      '',
      '[本地文件](file:///C:/repo/src/auth/refresh.ts#L12)',
      '',
      '```ts',
      'export const x = 1;',
      '```',
    ].join('\n'),
    linkifyFilePaths: true,
    fileLinkExists: (link) => existingFiles.has(link.pathText),
    fadeWords: true,
    rowKey: 'd1#1:m1',
  });

  assert.doesNotMatch(html, /<del>[^<]*2/, 'single tilde numeric ranges stay plain text');
  assert.match(html, /<del>[\s\S]*旧[\s\S]*逻[\s\S]*辑[\s\S]*<\/del>/, 'double tilde strikethrough still works');
  assert.doesNotMatch(html, /<span data-word-group="">\s*<\/span>/, 'whitespace-only text nodes are not wrapped in word-fade spans');
  assert.match(html, /<a class="asv-md-link" data-file-link="true"[^>]*title="src\/auth\/refresh\.ts:18"[^>]*>src\/auth\/refresh\.ts:18<\/a>/);
  assert.match(html, /<a class="asv-md-link" data-file-link="true"[^>]*title="package\.json"[^>]*><code>package\.json<\/code><\/a>/);
  assert.doesNotMatch(html, /title="src\/missing\/file\.ts"/, 'non-existent workspace paths stay plain text');
  assert.match(html, /<a class="asv-md-link" data-file-link="true"[^>]*title="C:\/repo\/src\/auth\/refresh\.ts:12"[^>]*>本地文件<\/a>/);
  assert.doesNotMatch(html, /\shref=/, 'no rendered anchor emits href');
  assert.match(html, /data-word-group=""/);
  assert.match(html, /data-word=""/);
  assert.match(html, /<span class="asv-code-lang" title="ts">TypeScript<\/span>/);
  assert.match(html, /aria-label="自动换行"/);

  // Without fadeWords, no word-fade span wrappers are added and double-tilde renders cleanly.
  const staticHtml = ui.renderMarkdown({ text: '普通文本 1~2 ~~删除~~ hello', fadeWords: false });
  assert.doesNotMatch(staticHtml, /data-word/);
  assert.match(staticHtml, /1~2 <del>删除<\/del>/);

  // Word fade inside tables and lists never wraps inter-element whitespace newlines in <span>.
  const tableFadeHtml = ui.renderMarkdown({
    text: '| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- item one\n- item two',
    fadeWords: true,
  });
  assert.doesNotMatch(tableFadeHtml, /<(table|thead|tbody|tr|ul|ol)>\s*<span data-word-group="">/);

  // Microtask-batched workspace file checker coalesces multiple paths into one checkPaths IPC call.
  const batches = [];
  const checker = helpers.createSessionFileLinkChecker('C:/repo', async ({ cwd, paths }) => {
    batches.push({ cwd, paths: [...paths] });
    return {
      ok: true,
      existing: Object.fromEntries(
        paths.filter((p) => existingFiles.has(p)).map((p) => [p, { path: `${cwd}/${p}`, isDirectory: false }]),
      ),
    };
  });
  const watcher = checker.watch();
  let notifications = 0;
  const unsub = watcher.subscribe(() => { notifications += 1; });
  assert.equal(watcher.getSnapshot().check({ pathText: 'src/auth/refresh.ts', line: 18, column: null, startIndex: 0, endIndex: 22, displayText: 'src/auth/refresh.ts:18' }), false);
  assert.equal(watcher.getSnapshot().check({ pathText: 'src/missing.ts', line: null, column: null, startIndex: 0, endIndex: 14, displayText: 'src/missing.ts' }), false);
  assert.equal(watcher.getSnapshot().check({ pathText: '\\\\server\\share\\x.ts', line: null, column: null, startIndex: 0, endIndex: 19, displayText: '\\\\server\\share\\x.ts' }), false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(batches.length, 1, 'same-tick checks coalesce into a single IPC batch');
  assert.deepEqual(batches[0].paths.sort(), ['src/auth/refresh.ts', 'src/missing.ts']);
  assert.equal(notifications, 1);
  assert.equal(watcher.getSnapshot().check({ pathText: 'src/auth/refresh.ts', line: 18, column: null, startIndex: 0, endIndex: 22, displayText: 'src/auth/refresh.ts:18' }), true);
  unsub();
});

test('SessionEmptyState has no hardcoded Codex copy and TurnView renders live reasoning, collapsed turns, and unexplained failures', () => {
  for (const policy of ['read-only', 'workspace-write', 'full-auto']) {
    const html = ui.renderEmptyState({ folder: 'repo', policy, onPick: () => {} });
    assert.doesNotMatch(html, /Codex/i, `policy ${policy} stays protocol-agnostic`);
  }

  // Running turn with live tail reasoning + streaming assistant text: hides duplicate reasoning row and hides assistant action bar.
  const runningHtml = ui.renderTurn({
    turn: {
      key: 'd1#1', dispatchId: 'd1', turnId: 't1', generation: 1, prompt: '帮我分析问题',
      startedAt: Date.now() - 5_000, completedAt: null, status: 'running', stopReason: null, usage: null, error: null,
      items: [
        { id: 'm1', kind: 'message', status: 'running', role: 'assistant', text: '正在分析…', startedAt: 1, completedAt: null },
        { id: 'r1', kind: 'reasoning', status: 'running', summary: '排查登录流程', text: '', startedAt: 2, completedAt: null },
      ],
    },
  });
  assert.match(runningHtml, /data-asv-turn-status="active"/);
  assert.match(runningHtml, /正在工作/);
  assert.match(runningHtml, /data-asv-turn-activity="true"/);
  assert.match(runningHtml, /思考中/);
  assert.doesNotMatch(runningHtml, /排查登录流程/, 'closed reasoning body is lazily omitted');
  assert.doesNotMatch(runningHtml, /asv-assistant-foot/, 'assistant actions stay hidden while streaming/running');

  // Opening the live reasoning disclosure mounts the bounded faint reasoning body.
  const runningOpenReasoningHtml = ui.renderTurn(
    {
      turn: {
        key: 'd1#1', dispatchId: 'd1', turnId: 't1', generation: 1, prompt: '帮我分析问题',
        startedAt: Date.now() - 5_000, completedAt: null, status: 'running', stopReason: null, usage: null, error: null,
        items: [
          { id: 'r1', kind: 'reasoning', status: 'running', summary: '排查登录流程', text: '', startedAt: 2, completedAt: null },
        ],
      },
    },
    { openKeys: ['reasoning:d1#1:r1'] },
  );
  assert.match(runningOpenReasoningHtml, /class="asv-reasoning-body" data-asv-tone="faint"/);
  assert.match(runningOpenReasoningHtml, /排查登录流程/);

  // Settled turn folds intermediate work behind status bar while keeping final answer + restrained controls + settlement.
  const settledHtml = ui.renderTurn({
    turn: {
      key: 'd1#2', dispatchId: 'd1', turnId: 't2', generation: 2, prompt: '修复并发刷新',
      startedAt: 1_000, completedAt: 19_000, status: 'completed', stopReason: null, usage: null, error: null,
      items: [
        { id: 'r2', kind: 'reasoning', status: 'completed', summary: '隐藏的内部推理', text: '', startedAt: 1_500, completedAt: 4_500 },
        { id: 'c2', kind: 'command', status: 'completed', command: 'npm test', cwd: null, output: 'pass', outputTruncated: false, exitCode: 0, durationMs: 3_000, startedAt: 5_000, completedAt: 8_000 },
        { id: 'm2', kind: 'message', status: 'completed', role: 'assistant', text: '修复已完成。', startedAt: 9_000, completedAt: 18_500 },
        { id: 's2', kind: 'settlement', settlement: 'report_done', stopReason: null, outcome: 'completed', verdict: 'approve', findings: [], summary: '已通过', diff: null, diffSource: null, startedAt: 19_000, completedAt: 19_000 },
      ],
    },
    latestResponseKey: 'd1#2:m2',
  });
  assert.match(settledHtml, /data-asv-turn-status="settled" aria-expanded="false"/);
  assert.match(settledHtml, /已工作 18s/);
  assert.match(settledHtml, /思考了 1 次、运行了 1 条命令/);
  assert.doesNotMatch(settledHtml, /隐藏的内部推理/, 'folded intermediate reasoning is hidden while collapsed');
  assert.match(settledHtml, /修复已完成。/);
  assert.match(settledHtml, /asv-msg-actions is-visible/);
  assert.match(settledHtml, /aria-label="滚动到此回复顶部"/);
  assert.match(settledHtml, /已提交结果/);

  // Failed turn with turn.error & unexplained command failure renders both outside the fold.
  const failedHtml = ui.renderTurn({
    turn: {
      key: 'd1#3', dispatchId: 'd1', turnId: 't3', generation: 3, prompt: '跑测试',
      startedAt: 1_000, completedAt: 5_000, status: 'failed', stopReason: null, usage: null, error: '进程意外退出',
      items: [
        { id: 'cf', kind: 'command', status: 'failed', command: 'npm test', cwd: null, output: 'ERR', outputTruncated: false, exitCode: 1, durationMs: 2_000, startedAt: 2_000, completedAt: 4_000 },
      ],
    },
  });
  assert.match(failedHtml, /已失败 · 用时 4s/);
  assert.match(failedHtml, /npm test/);
  assert.match(failedHtml, /role="alert"/);
  assert.match(failedHtml, /进程意外退出/);
});

test('regression checks: file link IPC target stripping, history zero timestamps, read flags, inline diffs, folding, and non-nested row triggers', () => {
  // 1. File links strip `:line[:col]` for shell-pty:open-link while keeping `:line` in the tooltip.
  const relLink = helpers.resolveSessionLinkTarget('src/auth/refresh.ts:18');
  assert.deepEqual(relLink, {
    title: 'src/auth/refresh.ts:18',
    openTarget: 'src/auth/refresh.ts',
    isFile: true,
  });
  const baseCwd = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  assert.ok(
    resolveTerminalLinkPath(relLink.openTarget, baseCwd),
    'stripped openTarget passes real electron resolveTerminalLinkPath',
  );
  const fileUriLink = helpers.resolveSessionLinkTarget('file:///C:/repo/src/auth/refresh.ts#L12');
  assert.deepEqual(fileUriLink, {
    title: 'C:/repo/src/auth/refresh.ts:12',
    openTarget: 'C:/repo/src/auth/refresh.ts',
    isFile: true,
  });
  const encodedLoc = helpers.resolveSessionLinkTarget('#aha-native-chat-file=src%2Fauth%2Frefresh.ts%3A18%3A5');
  assert.deepEqual(encodedLoc, {
    title: 'src/auth/refresh.ts:18:5',
    openTarget: 'src/auth/refresh.ts',
    isFile: true,
  });
  assert.deepEqual(helpers.resolveSessionLinkTarget('https://example.com/docs'), {
    title: 'https://example.com/docs',
    openTarget: 'https://example.com/docs',
    isFile: false,
  });

  // 2. Reopened history turns with 0 or equal timestamps never show bogus `0s`, `1s`, or `1970-01-01` clock times.
  assert.equal(
    helpers.describeTurnStatus({ status: 'completed', startedAt: 0, completedAt: 0 }, 0).label,
    '已完成',
  );
  assert.equal(
    helpers.describeTurnStatus({ status: 'failed', startedAt: 0, completedAt: 0 }, 0).label,
    '已失败',
  );
  assert.equal(
    helpers.describeReasoningHeadline({ status: 'completed', startedAt: 0, completedAt: 0 }, { turnRunning: false }),
    '已思考',
  );
  assert.equal(
    helpers.describeReasoningHeadline({ status: 'completed', startedAt: 5_000, completedAt: 5_000 }, { turnRunning: false }),
    '已思考',
  );
  const historyTurnHtml = ui.renderTurn({
    turn: {
      key: 'h1#1', dispatchId: 'h1', turnId: 't1', generation: 1, prompt: '历史问题',
      startedAt: 0, completedAt: 0, status: 'completed', stopReason: null, usage: null, error: null,
      items: [
        { id: 'm1', kind: 'message', status: 'completed', role: 'assistant', text: '历史回复', startedAt: 0, completedAt: 0 },
      ],
    },
    latestResponseKey: 'h1#1:m1',
  });
  assert.match(historyTurnHtml, /已完成/);
  assert.doesNotMatch(historyTurnHtml, /已工作 0s/);
  assert.doesNotMatch(historyTurnHtml, /<time\b/, 'epoch-0 historical items omit bogus 1970 clock timestamps');

  // 3. Read command detection handles `cat -n`, PowerShell `-Encoding utf8 -Path`, and read-only `sed -n`, rejecting `sed -i`.
  assert.equal(helpers.extractReadCommandFilePath('cat -n src/auth/refresh.ts'), 'src/auth/refresh.ts');
  assert.equal(helpers.extractReadCommandFilePath('head -n 50 src/auth/refresh.ts'), 'src/auth/refresh.ts');
  assert.equal(helpers.extractReadCommandFilePath('Get-Content -Encoding utf8 -Path src/auth/refresh.ts'), 'src/auth/refresh.ts');
  assert.equal(helpers.extractReadCommandFilePath("sed -n '1,120p' src/auth/refresh.ts"), 'src/auth/refresh.ts');
  assert.equal(helpers.extractReadCommandFilePath("sed -i 's/a/b/' src/auth/refresh.ts"), null);

  // 4. Inline diff extraction ignores `@@` buried inside test failure logs, while normalizing apply_patch and old_string/new_string.
  const testLog = 'FAIL tests/foo.test.mjs\n  × expected match\n@@ -1,2 +1,2 @@\n-old\n+new';
  assert.equal(helpers.extractInlineDiffFromText(testLog), null, 'command test logs are not truncated by DiffBlock');

  const applyPatchArgs = JSON.stringify({
    patch: '*** Begin Patch\n*** Update File: src/a.ts\n@@\n const a = 1;\n-const b = 2;\n+const b = 3;\n*** End Patch',
  });
  const normalizedPatch = helpers.extractInlineDiffFromText(applyPatchArgs);
  assert.ok(normalizedPatch, 'Codex apply_patch args normalize to unified diff');
  const patchRows = helpers.parseUnifiedDiff(normalizedPatch);
  assert.ok(patchRows.some((r) => r.kind === 'hunk'));
  assert.ok(patchRows.some((r) => r.kind === 'del' && r.text === 'const b = 2;'));
  assert.ok(patchRows.some((r) => r.kind === 'add' && r.text === 'const b = 3;'));

  const editArgs = JSON.stringify({ file_path: 'src/a.ts', old_string: 'oldVal()', new_string: 'newVal()' });
  const editDiff = helpers.extractInlineDiffFromText(editArgs);
  assert.ok(editDiff, 'old_string/new_string tool args synthesize a unified diff');
  const editRows = helpers.parseUnifiedDiff(editDiff);
  assert.ok(editRows.some((r) => r.kind === 'del' && r.text === 'oldVal()'));
  assert.ok(editRows.some((r) => r.kind === 'add' && r.text === 'newVal()'));

  // 5. Back-to-back pre-tool narration folds cleanly together; back-to-back final replies stay visible; unexplained declined steps never hide.
  const preToolFold = helpers.planTurnFold(
    {
      status: 'completed',
      items: [
        { id: 'm1', kind: 'message', status: 'completed', role: 'assistant', text: '第一步检查。', startedAt: 1, completedAt: 2 },
        { id: 'm2', kind: 'message', status: 'completed', role: 'assistant', text: '马上执行命令。', startedAt: 2, completedAt: 3 },
        { id: 'c1', kind: 'command', status: 'completed', command: 'npm test', cwd: null, output: 'ok', outputTruncated: false, exitCode: 0, durationMs: 10, startedAt: 3, completedAt: 4 },
        { id: 'm3', kind: 'message', status: 'completed', role: 'assistant', text: '全部通过。', startedAt: 4, completedAt: 5 },
      ],
    },
    { hasChangesCard: false },
  );
  assert.equal(preToolFold.foldedItemIds.has('m1'), true, 'earlier pre-tool narration folds');
  assert.equal(preToolFold.foldedItemIds.has('m2'), true, 'later pre-tool narration folds');
  assert.equal(preToolFold.foldedItemIds.has('m3'), false, 'final reply stays visible');

  const multiFinalAnswers = helpers.selectTurnAnswerItemIds([
    { id: 'm1', kind: 'message', status: 'completed', role: 'assistant', text: '第一段总结。', startedAt: 1, completedAt: 2 },
    { id: 'm2', kind: 'message', status: 'completed', role: 'assistant', text: '第二段补充。', startedAt: 2, completedAt: 3 },
  ]);
  assert.deepEqual([...multiFinalAnswers].sort(), ['m1', 'm2']);

  const declinedFold = helpers.planTurnFold(
    {
      status: 'interrupted',
      items: [
        { id: 'c_declined', kind: 'command', status: 'declined', command: 'rm -rf dist', cwd: null, output: '', outputTruncated: false, exitCode: null, durationMs: null, startedAt: 1, completedAt: 2 },
      ],
    },
    { hasChangesCard: false },
  );
  assert.equal(declinedFold.foldedItemIds.has('c_declined'), false, 'unexplained declined step stays visible');

  // 6. Expandable WorkLogRow renders sibling `.asv-row-trigger` and `button.asv-file-pill` (never nested `<button>` inside `<button>`), and WorkGroup omits `aria-live` from the toggle button.
  const readRowHtml = ui.renderWorkItem({
    item: {
      id: 'c_cat', kind: 'command', status: 'completed', command: 'bash -lc "cat -n src/auth/refresh.ts"',
      cwd: 'C:/repo', output: '1 export {}', outputTruncated: false, exitCode: 0, durationMs: 20, startedAt: 1, completedAt: 2,
    },
    turnKey: 'd1#1',
  });
  assert.match(readRowHtml, /<div class="asv-row-line is-expandable"><button type="button" class="asv-row-trigger" aria-expanded="false"[^>]*><\/button>/, 'expand trigger is an empty sibling button with no nested interactive controls');
  assert.match(readRowHtml, /<button type="button" class="asv-file-pill"/);

  const groupHtml = ui.renderWorkGroup({
    block: {
      type: 'group', id: 'group:c1', running: true, durationMs: null,
      items: [
        { id: 'c1', kind: 'command', status: 'completed', command: 'ls', cwd: null, output: '', outputTruncated: false, exitCode: 0, durationMs: 10, startedAt: 1, completedAt: 2 },
        { id: 'c2', kind: 'command', status: 'running', command: 'npm test', cwd: null, output: '', outputTruncated: false, exitCode: null, durationMs: null, startedAt: 2, completedAt: null },
      ],
    },
    turnKey: 'd1#1',
  });
  assert.doesNotMatch(groupHtml, /<button[^>]*aria-live=/, 'WorkGroup toggle omits aria-live so LiveTimer ticks do not spam announcements');

  // 7. Settled foldable turn exposes disclosure scope attributes so useTimelineScroll reveals expanded rows.
  const scopeTurnHtml = ui.renderTurn({
    turn: {
      key: 'd1#9', dispatchId: 'd1', turnId: 't9', generation: 9, prompt: 'test',
      startedAt: 1_000, completedAt: 5_000, status: 'completed', stopReason: null, usage: null, error: null,
      items: [
        { id: 'c1', kind: 'command', status: 'completed', command: 'ls', cwd: null, output: '', outputTruncated: false, exitCode: 0, durationMs: 10, startedAt: 1_100, completedAt: 1_200 },
        { id: 'm1', kind: 'message', status: 'completed', role: 'assistant', text: 'done', startedAt: 2_000, completedAt: 4_500 },
      ],
    },
  });
  assert.match(scopeTurnHtml, /class="asv-turn-body" data-asv-disclosure-scope=""/);
  assert.match(scopeTurnHtml, /data-asv-disclosure-scope-trigger="true"/);
});
