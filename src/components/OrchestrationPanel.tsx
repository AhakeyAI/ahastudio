import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  Play,
  Plus,
  Send,
  Square,
  StepForward,
  Terminal,
  TriangleAlert,
  Workflow,
  X,
} from 'lucide-react';
import { orchestrationClient } from '../lib/orchestration-client';
import {
  COORDINATOR_STATUS_LABELS,
  DISPATCH_STATUS_LABELS,
  MESSAGE_TYPE_LABELS,
  PRIORITY_LABELS,
  RUN_STATUS_LABELS,
  TASK_STATUS_LABELS,
  UI_HANDLE,
  attentionItems,
  buildTaskRows,
  countTasks,
  dispatchStartDiagnostic,
  formatRelativeTime,
  leafIdForSpawnedPty,
  messagesForRun,
  pickRunId,
  shortId,
  sortRuns,
  taskStatusTone,
  taskTitle,
  tasksForRun,
  type StatusTone,
  type TaskRow,
} from '../lib/orchestration-view';
import type {
  AgentPaneStatus,
  LocalCliInfo,
  OrchestrationDispatchRecord,
  OrchestrationGateRecord,
  OrchestrationMessagePriority,
  OrchestrationMessageRecord,
  OrchestrationQuestionRecord,
  OrchestrationResult,
  OrchestrationSnapshot,
  OrchestrationTaskStatus,
} from '../types';
import { agentStatusLabel } from '../lib/agent-status-view';
import './orchestration-panel.css';

export interface OrchestrationPaneTarget {
  ptyId: string;
  label: string;
  isAgent: boolean;
  status?: AgentPaneStatus | null;
}

export interface OrchestrationHostActions {
  /** Focuses the terminal showing `ptyId`; returns false when no open pane shows it. */
  focusPane: (ptyId: string) => boolean;
  /** Opens a terminal tab attached to a PTY the orchestrator created. */
  openWorkerPane: (target: { ptyId: string; cliId?: string; cwd?: string; title: string }) => void;
}

const RUN_KEY = 'aha.orchestration.run';
const ACTIVE_DISPATCH = new Set(['pending', 'dispatched']);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useOrchestrationSnapshot(): OrchestrationSnapshot {
  return useSyncExternalStore(orchestrationClient.subscribe, orchestrationClient.getSnapshot, orchestrationClient.getSnapshot);
}

function Tone({ tone, children, title }: { tone: StatusTone; children: ReactNode; title?: string }) {
  return (
    <span className={`orch-tone is-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function OrchestrationPanel({
  cwd,
  onNotify,
  panes,
  actions,
}: {
  cwd: string | undefined;
  onNotify: (message: string) => void;
  /** Every open terminal pane, used to label handles and as dispatch targets. */
  panes: OrchestrationPaneTarget[];
  actions: OrchestrationHostActions;
}) {
  const snapshot = useOrchestrationSnapshot();
  const loadError = orchestrationClient.getError();
  const loaded = orchestrationClient.isLoaded();
  const api = window.vibeMeet.orchestration;
  const [preferredRun, setPreferredRun] = useState<string | null>(() => localStorage.getItem(RUN_KEY));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creatingRun, setCreatingRun] = useState(false);

  const runId = pickRunId(snapshot, preferredRun);
  const runs = useMemo(() => sortRuns(snapshot.runs), [snapshot.runs]);
  const run = snapshot.runs.find((item) => item.id === runId) ?? null;
  const tasks = useMemo(() => tasksForRun(snapshot, runId), [snapshot, runId]);
  const rows = useMemo(
    () => buildTaskRows(tasks, snapshot.gates.filter((gate) => gate.runId === runId)),
    [tasks, snapshot.gates, runId],
  );
  const counts = useMemo(() => countTasks(tasks), [tasks]);
  const attention = useMemo(() => attentionItems(snapshot, runId), [snapshot, runId]);
  const coordinator = snapshot.activeCoordinatorRun;
  const lastCoordinatorRun = useMemo(
    () =>
      snapshot.coordinatorRuns
        .filter((item) => item.runId === runId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0] ?? null,
    [snapshot.coordinatorRuns, runId],
  );

  const selectRun = (id: string) => {
    setPreferredRun(id);
    localStorage.setItem(RUN_KEY, id);
  };

  const paneLabel = (ptyId: string | null | undefined) => {
    if (!ptyId) return null;
    return panes.find((pane) => pane.ptyId === ptyId)?.label ?? null;
  };

  const dispatchById = useMemo(
    () => new Map(snapshot.dispatches.map((dispatch) => [dispatch.id, dispatch])),
    [snapshot.dispatches],
  );
  const taskById = useMemo(() => new Map(snapshot.tasks.map((task) => [task.id, task])), [snapshot.tasks]);

  const handleLabel = (handle: string): string => {
    if (handle === UI_HANDLE) return '协调者';
    if (handle === '@workers') return '全部 Worker';
    if (handle === '@all') return '全部终端';
    if (handle.startsWith('run:')) return '协调者邮箱';
    if (handle.startsWith('dispatch:')) {
      const dispatch = dispatchById.get(handle.slice('dispatch:'.length));
      const task = dispatch ? taskById.get(dispatch.taskId) : undefined;
      return task ? `Worker · ${taskTitle(task)}` : `Worker ${shortId(handle)}`;
    }
    return paneLabel(handle) ?? handle;
  };

  async function call<T extends Record<string, unknown>>(
    key: string,
    fn: () => Promise<OrchestrationResult<T>>,
    success?: string,
  ): Promise<({ ok: true } & T) | null> {
    if (!api) {
      setError('编排接口不可用');
      return null;
    }
    setBusy(key);
    setError(null);
    try {
      const res = await fn();
      if (!res.ok) {
        setError(res.error || res.code);
        return null;
      }
      if (success) onNotify(success);
      return res;
    } catch (err) {
      setError(errorText(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  const openAssignee = (dispatch: OrchestrationDispatchRecord, title: string, cwd?: string) => {
    const ptyId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    if (actions.focusPane(ptyId)) return;
    if (leafIdForSpawnedPty(ptyId)?.startsWith('orch-')) {
      actions.openWorkerPane({ ptyId, title: `Worker · ${title}`, ...(cwd ? { cwd } : {}) });
      return;
    }
    onNotify('该 Worker 的终端已关闭或不在当前窗口');
  };

  if (!api) {
    return (
      <div className="wrp-empty">
        <Workflow size={22} />
        <p>编排接口不可用</p>
      </div>
    );
  }

  return (
    <div className="orch">
      <div className="orch-runbar">
        <select
          aria-label="选择编排运行"
          value={runId ?? ''}
          onChange={(event) => selectRun(event.target.value)}
          disabled={runs.length === 0}
        >
          {runs.length === 0 && <option value="">暂无运行</option>}
          {runs.map((item) => (
            <option key={item.id} value={item.id}>
              {RUN_STATUS_LABELS[item.status]} · {item.objective.slice(0, 40) || item.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={`wrp-icon-btn ${creatingRun ? 'is-active' : ''}`}
          title="新建运行"
          aria-label="新建运行"
          onClick={() => setCreatingRun((value) => !value)}
        >
          <Plus size={14} />
        </button>
      </div>

      {error && (
        <div className="wrp-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="关闭错误" onClick={() => setError(null)}>
            <X size={12} />
          </button>
        </div>
      )}
      {loadError && !loaded && <div className="wrp-inline-error">{loadError}</div>}

      <div className="orch-scroll">
        {creatingRun && (
          <NewRunForm
            busy={busy === 'run-create'}
            onCancel={() => setCreatingRun(false)}
            onSubmit={async (objective) => {
              const res = await call('run-create', () => api.runCreate({ objective }), '已创建编排运行');
              if (res) {
                selectRun(res.run.id);
                setCreatingRun(false);
              }
            }}
          />
        )}

        {!run && !creatingRun && (
          <div className="wrp-empty orch-empty">
            <Workflow size={22} />
            <p>{loaded ? '还没有编排运行' : '正在读取编排状态…'}</p>
            <small>新建一个运行，拆分任务后交给多个 Agent 并行处理。终端里的 Agent 也可以通过 aha 命令创建任务。</small>
            {loaded && (
              <button type="button" className="wrp-btn is-primary" onClick={() => setCreatingRun(true)}>
                <Plus size={13} />
                新建运行
              </button>
            )}
          </div>
        )}

        {run && (
          <>
            <section className="orch-card orch-run">
              <div className="orch-run-head">
                <Tone tone={run.status === 'active' ? 'accent' : run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'error' : 'neutral'}>
                  {RUN_STATUS_LABELS[run.status]}
                </Tone>
                <strong title={run.objective}>{run.objective || run.id}</strong>
              </div>
              <div className="orch-run-meta">
                <span title={run.id}>{shortId(run.id)}</span>
                <span>{formatRelativeTime(run.createdAt)}</span>
                <span>
                  {counts.completed}/{counts.total} 完成
                </span>
                {counts.failed > 0 && <span className="is-error">{counts.failed} 失败</span>}
              </div>
              {counts.total > 0 && (
                <div className="orch-progress" aria-hidden>
                  {(['completed', 'dispatched', 'ready', 'pending', 'blocked', 'failed'] as const).map((status) =>
                    counts[status] ? (
                      <span
                        key={status}
                        className={`is-${taskStatusTone(status)} is-${status}`}
                        style={{ flexGrow: counts[status] }}
                      />
                    ) : null,
                  )}
                </div>
              )}
              <CoordinatorControls
                runId={run.id}
                cwd={cwd}
                agentPanes={panes.filter((pane) => pane.isAgent)}
                active={coordinator}
                last={lastCoordinatorRun}
                busy={busy}
                onStart={(opts) =>
                  void call(
                    'coord-start',
                    () => api.coordinatorStart({ runId: run.id, ...opts }),
                    '协调器已启动',
                  )
                }
                onStop={() => void call('coord-stop', () => api.coordinatorStop(), '协调器已停止')}
                onTick={async (workerPaneIds) => {
                  const res = await call('coord-tick', () => api.coordinatorTick({ runId: run.id, workerPaneIds }));
                  if (res) onNotify(res.converged ? '所有任务已结束' : '已推进一步');
                }}
              />
            </section>

            {(attention.gates.length > 0 || attention.questions.length > 0) && (
              <section className="orch-section">
                <h3 className="orch-section-title is-warn">
                  <TriangleAlert size={12} />
                  需要你处理 <span className="wrp-count">{attention.gates.length + attention.questions.length}</span>
                </h3>
                {attention.gates.map((gate) => (
                  <GateCard
                    key={gate.id}
                    gate={gate}
                    taskLabel={taskById.get(gate.taskId) ? taskTitle(taskById.get(gate.taskId)!) : gate.taskId}
                    busy={busy === `gate-${gate.id}`}
                    onResolve={(resolution) =>
                      void call(`gate-${gate.id}`, () => api.gateResolve({ id: gate.id, resolution }), '已提交决策')
                    }
                  />
                ))}
                {attention.questions.map((question) => (
                  <QuestionCard
                    key={question.messageId}
                    question={question}
                    fromLabel={handleLabel(question.fromHandle)}
                    busy={busy === `q-${question.messageId}`}
                    onReply={(body) =>
                      void call(`q-${question.messageId}`, () => api.reply({ id: question.messageId, body }), '已回复 Worker')
                    }
                  />
                ))}
              </section>
            )}

            <TaskSection
              rows={rows}
              cwd={cwd}
              busy={busy}
              panes={panes}
              paneLabel={paneLabel}
              onCreate={async (input) => {
                const res = await call('task-create', () => api.taskCreate({ runId: run.id, ...input }), '已添加任务');
                return Boolean(res);
              }}
              onDispatch={(taskId, to) =>
                void call(`task-${taskId}`, () => api.dispatch({ taskId, to, inject: true }), '已派发任务')
              }
              onUpdate={(taskId, status) =>
                void call(`task-${taskId}`, () => api.taskUpdate({ id: taskId, status }), '已更新任务状态')
              }
              onOpenAssignee={openAssignee}
            />

            <MessageSection
              messages={messagesForRun(snapshot, run.id, { limit: 80 })}
              handleLabel={handleLabel}
              recipients={[
                { value: `run:${run.id}`, label: '协调者邮箱' },
                { value: '@workers', label: '全部 Worker' },
                ...snapshot.dispatches
                  .filter((dispatch) => dispatch.runId === run.id && ACTIVE_DISPATCH.has(dispatch.status))
                  .map((dispatch) => ({ value: `dispatch:${dispatch.id}`, label: handleLabel(`dispatch:${dispatch.id}`) })),
              ]}
              busy={busy === 'send'}
              onSend={async (input) => {
                const res = await call(
                  'send',
                  () => api.send({ runId: run.id, type: 'status', priority: 'normal', ...input }),
                  '消息已发送',
                );
                return Boolean(res);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}

function NewRunForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (objective: string) => void;
}) {
  const [objective, setObjective] = useState('');
  return (
    <form
      className="orch-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (objective.trim()) onSubmit(objective.trim());
      }}
    >
      <label className="wrp-field">
        <span>运行目标</span>
        <textarea
          autoFocus
          rows={3}
          value={objective}
          placeholder="例如：为设置页增加导入/导出，并补齐测试"
          onChange={(event) => setObjective(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && objective.trim()) {
              event.preventDefault();
              onSubmit(objective.trim());
            }
          }}
        />
      </label>
      <div className="wrp-form-actions">
        <button type="button" className="wrp-btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="wrp-btn is-primary" disabled={busy || !objective.trim()}>
          {busy ? <LoaderCircle size={13} className="wrp-spin" /> : <Plus size={13} />}
          创建
        </button>
      </div>
    </form>
  );
}

function CoordinatorControls({
  runId,
  cwd,
  agentPanes,
  active,
  last,
  busy,
  onStart,
  onStop,
  onTick,
}: {
  runId: string;
  cwd: string | undefined;
  agentPanes: OrchestrationPaneTarget[];
  active: OrchestrationSnapshot['activeCoordinatorRun'];
  last: OrchestrationSnapshot['activeCoordinatorRun'];
  busy: string | null;
  onStart: (opts: {
    maxConcurrent: number;
    autoSpawnWorkers: boolean;
    workerCliId?: string;
    cwd?: string;
    workerPaneIds: string[];
  }) => void;
  onStop: () => void;
  onTick: (workerPaneIds: string[]) => void;
}) {
  // Only panes the user picks receive tasks; other agent chats are never typed into.
  const [pool, setPool] = useState<string[]>([]);
  const poolIds = pool.filter((id) => agentPanes.some((pane) => pane.ptyId === id));
  const [maxConcurrent, setMaxConcurrent] = useState(() => Number(localStorage.getItem('aha.orchestration.max')) || 3);
  const [autoSpawn, setAutoSpawn] = useState(() => localStorage.getItem('aha.orchestration.autoSpawn') === '1');
  const [workerCli, setWorkerCli] = useState(() => localStorage.getItem('aha.orchestration.workerCli') ?? 'claude');
  const [clis, setClis] = useState<LocalCliInfo[]>([]);

  useEffect(() => {
    let cancelled = false;
    void window.vibeMeet.shellPty
      .listClis()
      .then((res) => {
        if (!cancelled && res.ok) setClis(res.clis);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const runningHere = active && active.runId === runId;
  const runningElsewhere = active && active.runId !== runId;

  if (runningHere) {
    return (
      <div className="orch-coord is-running">
        <span className="orch-coord-status">
          <span className="orch-pulse" aria-hidden />
          协调器运行中 · 最多 {active.maxConcurrent} 个并行
        </span>
        <button type="button" className="wrp-btn" disabled={busy === 'coord-stop'} onClick={onStop}>
          <Square size={12} />
          停止
        </button>
      </div>
    );
  }

  return (
    <div className="orch-coord">
      {runningElsewhere ? (
        <p className="orch-note">另一个运行的协调器正在工作，同一时间只能运行一个。</p>
      ) : (
        <>
          <div className="orch-coord-options">
            <label className="orch-inline-field" title="同时派发的任务上限">
              并行
              <select
                value={maxConcurrent}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setMaxConcurrent(value);
                  localStorage.setItem('aha.orchestration.max', String(value));
                }}
              >
                {[1, 2, 3, 4, 5, 6, 8].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label className="wrp-check" title="没有空闲 Agent 时，在当前项目目录启动新的 Agent 终端">
              <input
                type="checkbox"
                checked={autoSpawn}
                onChange={(event) => {
                  setAutoSpawn(event.target.checked);
                  localStorage.setItem('aha.orchestration.autoSpawn', event.target.checked ? '1' : '0');
                }}
              />
              自动启动 Worker
            </label>
            {autoSpawn && (
              <select
                aria-label="Worker 使用的 CLI"
                value={workerCli}
                onChange={(event) => {
                  setWorkerCli(event.target.value);
                  localStorage.setItem('aha.orchestration.workerCli', event.target.value);
                }}
              >
                {clis.length === 0 && <option value={workerCli}>{workerCli}</option>}
                {clis.map((cli) => (
                  <option key={cli.id} value={cli.id}>
                    {cli.label}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="wrp-field">
            <span>可派发的 Agent 终端</span>
            {agentPanes.length === 0 ? (
              <p className="orch-note">当前没有打开的 Agent 终端。</p>
            ) : (
              <div className="orch-dep-list">
                {agentPanes.map((pane) => (
                  <label key={pane.ptyId} className="wrp-check">
                    <input
                      type="checkbox"
                      checked={poolIds.includes(pane.ptyId)}
                      onChange={(event) =>
                        setPool((value) =>
                          event.target.checked ? [...value, pane.ptyId] : value.filter((id) => id !== pane.ptyId),
                        )
                      }
                    />
                    <span>
                      {pane.label}
                      {pane.status ? ` · ${agentStatusLabel(pane.status)}` : ''}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>
          {!autoSpawn && poolIds.length === 0 && (
            <p className="orch-note is-warn">没有可用的 Worker：勾选上面的 Agent 终端，或开启“自动启动 Worker”。</p>
          )}
          {autoSpawn && !cwd && <p className="orch-note is-warn">未选择项目目录，Worker 会在默认目录启动。</p>}
        </>
      )}
      <div className="orch-coord-actions">
        {last && !active && (
          <span className="orch-coord-last" title={last.error ?? undefined}>
            上次：{COORDINATOR_STATUS_LABELS[last.status]}
            {last.error ? ` · ${last.error}` : ''}
          </span>
        )}
        <button
          type="button"
          className="wrp-btn"
          title="手动执行一次调度：推进依赖，把就绪任务派发给勾选的 Agent 终端（不会自动启动 Worker）"
          disabled={Boolean(busy) || Boolean(active)}
          onClick={() => onTick(poolIds)}
        >
          {busy === 'coord-tick' ? <LoaderCircle size={12} className="wrp-spin" /> : <StepForward size={12} />}
          推进一步
        </button>
        <button
          type="button"
          className="wrp-btn is-primary"
          disabled={Boolean(busy) || Boolean(active)}
          onClick={() =>
            onStart({
              maxConcurrent,
              autoSpawnWorkers: autoSpawn,
              ...(autoSpawn ? { workerCliId: workerCli } : {}),
              ...(cwd ? { cwd } : {}),
              workerPaneIds: poolIds,
            })
          }
        >
          {busy === 'coord-start' ? <LoaderCircle size={12} className="wrp-spin" /> : <Play size={12} />}
          启动协调器
        </button>
      </div>
    </div>
  );
}

function ChoiceReply({
  options,
  busy,
  placeholder,
  submitLabel,
  onSubmit,
}: {
  options: string[];
  busy: boolean;
  placeholder: string;
  submitLabel: string;
  onSubmit: (value: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <>
      {options.length > 0 && (
        <div className="orch-options">
          {options.map((option) => (
            <button key={option} type="button" className="wrp-btn" disabled={busy} onClick={() => onSubmit(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
      <form
        className="orch-reply"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) onSubmit(text.trim());
        }}
      >
        <input value={text} placeholder={placeholder} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="wrp-btn is-primary" disabled={busy || !text.trim()}>
          {busy ? <LoaderCircle size={12} className="wrp-spin" /> : <Send size={12} />}
          {submitLabel}
        </button>
      </form>
    </>
  );
}

function GateCard({
  gate,
  taskLabel,
  busy,
  onResolve,
}: {
  gate: OrchestrationGateRecord;
  taskLabel: string;
  busy: boolean;
  onResolve: (resolution: string) => void;
}) {
  return (
    <div className="orch-card orch-attention is-gate">
      <div className="orch-attention-head">
        <Tone tone="warn">决策</Tone>
        <span title={taskLabel}>{taskLabel}</span>
        <small>{formatRelativeTime(gate.createdAt)}</small>
      </div>
      <p className="orch-attention-body">{gate.question}</p>
      <ChoiceReply
        options={gate.options}
        busy={busy}
        placeholder={gate.options.length ? '或输入其他决定' : '输入你的决定'}
        submitLabel="提交"
        onSubmit={onResolve}
      />
    </div>
  );
}

function QuestionCard({
  question,
  fromLabel,
  busy,
  onReply,
}: {
  question: OrchestrationQuestionRecord;
  fromLabel: string;
  busy: boolean;
  onReply: (body: string) => void;
}) {
  return (
    <div className="orch-card orch-attention is-question">
      <div className="orch-attention-head">
        <Tone tone="accent">
          <CircleHelp size={10} />
          提问
        </Tone>
        <span title={fromLabel}>{fromLabel}</span>
        <small>{formatRelativeTime(question.createdAt)}</small>
      </div>
      <p className="orch-attention-body">{question.question}</p>
      <ChoiceReply options={question.options} busy={busy} placeholder="回复 Worker" submitLabel="回复" onSubmit={onReply} />
    </div>
  );
}

type TaskCreateInput = {
  spec: string;
  taskTitle?: string;
  deps?: string[];
  priority?: OrchestrationMessagePriority;
  worktreePath?: string;
};

function TaskSection({
  rows,
  cwd,
  busy,
  panes,
  paneLabel,
  onCreate,
  onDispatch,
  onUpdate,
  onOpenAssignee,
}: {
  rows: TaskRow[];
  cwd: string | undefined;
  busy: string | null;
  panes: OrchestrationPaneTarget[];
  paneLabel: (ptyId: string | null | undefined) => string | null;
  onCreate: (input: TaskCreateInput) => Promise<boolean>;
  onDispatch: (taskId: string, to: string) => void;
  onUpdate: (taskId: string, status: OrchestrationTaskStatus) => void;
  onOpenAssignee: (dispatch: OrchestrationDispatchRecord, title: string, cwd?: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className="orch-section">
      <h3 className="orch-section-title">
        <ListChecks size={12} />
        任务 <span className="wrp-count">{rows.length}</span>
        <button
          type="button"
          className={`wrp-icon-btn ${adding ? 'is-active' : ''}`}
          title="添加任务"
          aria-label="添加任务"
          onClick={() => setAdding((value) => !value)}
        >
          <Plus size={13} />
        </button>
      </h3>
      {adding && (
        <TaskForm
          rows={rows}
          cwd={cwd}
          busy={busy === 'task-create'}
          onCancel={() => setAdding(false)}
          onSubmit={async (input) => {
            if (await onCreate(input)) setAdding(false);
          }}
        />
      )}
      {rows.length === 0 && !adding && <p className="orch-note">还没有任务。添加任务，或让协调者 Agent 用 aha task-create 拆分。</p>}
      <div className="orch-tasks">
        {rows.map((row) => (
          <TaskItem
            key={row.task.id}
            row={row}
            rows={rows}
            open={expanded === row.task.id}
            busy={busy === `task-${row.task.id}`}
            panes={panes}
            paneLabel={paneLabel}
            onToggle={() => setExpanded((value) => (value === row.task.id ? null : row.task.id))}
            onDispatch={(to) => onDispatch(row.task.id, to)}
            onUpdate={(status) => onUpdate(row.task.id, status)}
            onOpenAssignee={onOpenAssignee}
          />
        ))}
      </div>
    </section>
  );
}

function TaskForm({
  rows,
  cwd,
  busy,
  onCancel,
  onSubmit,
}: {
  rows: TaskRow[];
  cwd: string | undefined;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: TaskCreateInput) => void;
}) {
  const [title, setTitle] = useState('');
  const [spec, setSpec] = useState('');
  const [deps, setDeps] = useState<string[]>([]);
  const [priority, setPriority] = useState<OrchestrationMessagePriority>('normal');
  const [worktree, setWorktree] = useState('');
  const submit = () => {
    if (!spec.trim()) return;
    onSubmit({
      spec: spec.trim(),
      ...(title.trim() ? { taskTitle: title.trim() } : {}),
      ...(deps.length ? { deps } : {}),
      priority,
      ...(worktree.trim() ? { worktreePath: worktree.trim() } : {}),
    });
  };
  return (
    <form
      className="orch-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <label className="wrp-field">
        <span>标题</span>
        <input autoFocus value={title} placeholder="可选，默认取说明第一行" onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="wrp-field">
        <span>任务说明（会发送给 Worker）</span>
        <textarea
          rows={4}
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </label>
      {rows.length > 0 && (
        <div className="wrp-field">
          <span>依赖（这些任务完成后才会就绪）</span>
          <div className="orch-dep-list">
            {rows.map(({ task }) => (
              <label key={task.id} className="wrp-check">
                <input
                  type="checkbox"
                  checked={deps.includes(task.id)}
                  onChange={(event) =>
                    setDeps((value) => (event.target.checked ? [...value, task.id] : value.filter((id) => id !== task.id)))
                  }
                />
                <span>{taskTitle(task)}</span>
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="orch-form-row">
        <label className="wrp-field">
          <span>优先级</span>
          <select value={priority} onChange={(event) => setPriority(event.target.value as OrchestrationMessagePriority)}>
            {(Object.keys(PRIORITY_LABELS) as OrchestrationMessagePriority[]).map((value) => (
              <option key={value} value={value}>
                {PRIORITY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="wrp-field is-grow">
          <span>工作目录</span>
          <div className="wrp-field-row">
            <input value={worktree} placeholder="可选，Worker 在此目录启动" onChange={(event) => setWorktree(event.target.value)} />
            {cwd && (
              <button type="button" className="wrp-link" onClick={() => setWorktree(cwd)}>
                当前目录
              </button>
            )}
          </div>
        </label>
      </div>
      <div className="wrp-form-actions">
        <button type="button" className="wrp-btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="wrp-btn is-primary" disabled={busy || !spec.trim()}>
          {busy ? <LoaderCircle size={13} className="wrp-spin" /> : <Plus size={13} />}
          添加
        </button>
      </div>
    </form>
  );
}

function TaskItem({
  row,
  rows,
  open,
  busy,
  panes,
  paneLabel,
  onToggle,
  onDispatch,
  onUpdate,
  onOpenAssignee,
}: {
  row: TaskRow;
  rows: TaskRow[];
  open: boolean;
  busy: boolean;
  panes: OrchestrationPaneTarget[];
  paneLabel: (ptyId: string | null | undefined) => string | null;
  onToggle: () => void;
  onDispatch: (to: string) => void;
  onUpdate: (status: OrchestrationTaskStatus) => void;
  onOpenAssignee: (dispatch: OrchestrationDispatchRecord, title: string, cwd?: string) => void;
}) {
  const { task } = row;
  const dispatch = task.latestDispatch;
  const title = taskTitle(task);
  const dispatchActive = Boolean(dispatch && ACTIVE_DISPATCH.has(dispatch.status));
  const startDiagnostic = dispatchStartDiagnostic(dispatch);
  const assignee = dispatch ? (paneLabel(dispatch.assigneePaneId ?? dispatch.assigneeHandle) ?? 'Worker 终端') : null;
  const titleOf = (id: string) => {
    const dep = rows.find((item) => item.task.id === id)?.task;
    return dep ? taskTitle(dep) : id;
  };
  const agentPanes = panes.filter((pane) => pane.isAgent);
  const [target, setTarget] = useState('');
  const selectedTarget = agentPanes.some((pane) => pane.ptyId === target) ? target : (agentPanes[0]?.ptyId ?? '');

  return (
    <div className={`orch-task ${open ? 'is-open' : ''}`} style={{ marginLeft: Math.min(row.level, 4) * 12 }}>
      <button type="button" className="orch-task-head" onClick={onToggle} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Tone tone={taskStatusTone(task.status)}>{TASK_STATUS_LABELS[task.status]}</Tone>
        <span className="orch-task-title" title={title}>
          {title}
        </span>
        {task.priority !== 'normal' && (
          <span className={`wrp-chip ${task.priority === 'urgent' || task.priority === 'high' ? 'is-warn' : ''}`}>
            {PRIORITY_LABELS[task.priority]}
          </span>
        )}
        {row.pendingGates > 0 && <span className="wrp-chip is-warn">待决策</span>}
      </button>
      {(row.waitingOn.length > 0 || (dispatch && !open)) && (
        <div className="orch-task-sub">
          {row.waitingOn.length > 0 && <span>等待：{row.waitingOn.map(titleOf).join('、')}</span>}
          {dispatch && !open && (
            <>
              <span>
                {DISPATCH_STATUS_LABELS[dispatch.status]} · {assignee}
              </span>
              {startDiagnostic && (
                <Tone tone={startDiagnostic.tone} title={startDiagnostic.reason ?? startDiagnostic.label}>
                  {startDiagnostic.label}
                </Tone>
              )}
            </>
          )}
        </div>
      )}
      {open && (
        <div className="orch-task-body">
          <pre className="orch-spec">{task.spec}</pre>
          {row.missingDeps.length > 0 && <p className="orch-note is-warn">缺失的依赖：{row.missingDeps.join('、')}</p>}
          {task.worktreePath && (
            <p className="orch-note" title={task.worktreePath}>
              目录：{task.worktreePath}
            </p>
          )}
          {dispatch && (
            <div className="orch-dispatch">
              <span>
                {DISPATCH_STATUS_LABELS[dispatch.status]}
                {dispatch.failureCount > 0 ? ` · 失败 ${dispatch.failureCount} 次` : ''}
                {dispatch.lastHeartbeatAt ? ` · 心跳 ${formatRelativeTime(dispatch.lastHeartbeatAt)}` : ''}
              </span>
              {startDiagnostic && (
                <Tone tone={startDiagnostic.tone} title={startDiagnostic.reason ?? startDiagnostic.label}>
                  {startDiagnostic.label}
                </Tone>
              )}
              <button type="button" className="wrp-link" onClick={() => onOpenAssignee(dispatch, title, task.worktreePath ?? undefined)}>
                <Terminal size={11} /> {assignee}
              </button>
              {startDiagnostic?.reason && (
                <p className={`orch-note ${startDiagnostic.tone === 'warn' ? 'is-warn' : ''}`}>{startDiagnostic.reason}</p>
              )}
              {(dispatch.failureSummary || dispatch.lastFailureReason) && (
                <p className="wrp-error-text">{dispatch.failureSummary ?? dispatch.lastFailureReason}</p>
              )}
            </div>
          )}
          <div className="orch-task-actions">
            {!dispatchActive && task.status !== 'completed' && (
              <div className="orch-dispatch-to">
                <select
                  aria-label="派发目标"
                  value={selectedTarget}
                  onChange={(event) => setTarget(event.target.value)}
                  disabled={agentPanes.length === 0}
                >
                  {agentPanes.length === 0 && <option value="">没有打开的 Agent 终端</option>}
                  {agentPanes.map((pane) => (
                    <option key={pane.ptyId} value={pane.ptyId}>
                      {pane.label}
                      {pane.status ? ` · ${agentStatusLabel(pane.status)}` : ''}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="wrp-btn is-primary"
                  disabled={busy || !selectedTarget || task.status === 'pending'}
                  title={task.status === 'pending' ? '依赖未完成' : '把任务说明发送到所选终端'}
                  onClick={() => onDispatch(selectedTarget)}
                >
                  <Send size={12} />
                  派发
                </button>
              </div>
            )}
            <select
              aria-label="修改任务状态"
              value=""
              disabled={busy}
              onChange={(event) => {
                if (event.target.value) onUpdate(event.target.value as OrchestrationTaskStatus);
              }}
            >
              <option value="">标记为…</option>
              {(['ready', 'completed', 'failed', 'blocked'] as const)
                .filter((status) => status !== task.status)
                .map((status) => (
                  <option key={status} value={status}>
                    {TASK_STATUS_LABELS[status]}
                  </option>
                ))}
            </select>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageSection({
  messages,
  handleLabel,
  recipients,
  busy,
  onSend,
}: {
  messages: OrchestrationMessageRecord[];
  handleLabel: (handle: string) => string;
  recipients: Array<{ value: string; label: string }>;
  busy: boolean;
  onSend: (input: { to: string; subject: string; body?: string }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [composing, setComposing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [to, setTo] = useState(recipients[0]?.value ?? '');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const recipient = recipients.some((item) => item.value === to) ? to : (recipients[0]?.value ?? '');

  return (
    <section className="orch-section">
      <h3 className="orch-section-title">
        <button type="button" className="orch-section-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          <MessageSquare size={12} />
          消息 <span className="wrp-count">{messages.length}</span>
        </button>
        <button
          type="button"
          className={`wrp-icon-btn ${composing ? 'is-active' : ''}`}
          title="发送消息"
          aria-label="发送消息"
          onClick={() => {
            setComposing((value) => !value);
            setOpen(true);
          }}
        >
          <Send size={12} />
        </button>
      </h3>
      {open && composing && (
        <form
          className="orch-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!subject.trim() || !recipient) return;
            const ok = await onSend({ to: recipient, subject: subject.trim(), ...(body.trim() ? { body: body.trim() } : {}) });
            if (ok) {
              setSubject('');
              setBody('');
              setComposing(false);
            }
          }}
        >
          <label className="wrp-field">
            <span>发给</span>
            <select value={recipient} onChange={(event) => setTo(event.target.value)}>
              {recipients.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label className="wrp-field">
            <span>主题</span>
            <input value={subject} onChange={(event) => setSubject(event.target.value)} />
          </label>
          <label className="wrp-field">
            <span>内容</span>
            <textarea rows={3} value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
          <div className="wrp-form-actions">
            <button type="button" className="wrp-btn" onClick={() => setComposing(false)}>
              取消
            </button>
            <button type="submit" className="wrp-btn is-primary" disabled={busy || !subject.trim() || !recipient}>
              {busy ? <LoaderCircle size={12} className="wrp-spin" /> : <Send size={12} />}
              发送
            </button>
          </div>
        </form>
      )}
      {open && (
        <div className="orch-messages">
          {messages.length === 0 && <p className="orch-note">暂无消息</p>}
          {messages.map((message) => (
            <button
              type="button"
              key={message.id}
              className={`orch-message ${expanded === message.id ? 'is-open' : ''} ${message.type === 'escalation' || message.priority === 'urgent' ? 'is-urgent' : ''}`}
              onClick={() => setExpanded((value) => (value === message.id ? null : message.id))}
            >
              <span className="orch-message-head">
                <span className="wrp-chip">{MESSAGE_TYPE_LABELS[message.type] ?? message.type}</span>
                <span className="orch-message-route">
                  {handleLabel(message.fromHandle)} → {handleLabel(message.toHandle)}
                </span>
                <small>{formatRelativeTime(message.createdAt)}</small>
              </span>
              <span className="orch-message-subject">{message.subject}</span>
              {expanded === message.id && message.body && <pre className="orch-spec">{message.body}</pre>}
              {expanded === message.id && message.lifecycleRejectedReason && (
                <span className="wrp-error-text">{message.lifecycleRejectedReason}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
