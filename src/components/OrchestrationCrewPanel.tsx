import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AtSign,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  GitBranch,
  Pin,
  ShieldAlert,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import { ptyIdForLeaf } from '../lib/agent-status-view';
import { agentStatusClient } from '../lib/agent-status-client';
import { orchestrationClient } from '../lib/orchestration-client';
import {
  buildCrewViewForPane,
  type AgentStatusLookup,
  type CrewMemberEntry,
} from '../lib/orchestration-crew-model';
import { dispatchFocusOrchestrationTarget } from '../lib/terminal-links/orchestration-terminal-links';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import './orchestration-crew-panel.css';

export interface OrchestrationCrewPanelProps {
  leafId: string;
  agentStatuses: AgentStatusLookup;
  searchOpen?: boolean;
  onNotify?: (message: string) => void;
}

export function OrchestrationCrewPanel({
  leafId,
  agentStatuses,
  searchOpen = false,
  onNotify,
}: OrchestrationCrewPanelProps) {
  const snapshot = useSyncExternalStore(
    orchestrationClient.subscribe,
    orchestrationClient.getSnapshot,
  );
  const agentStatusRevision = useSyncExternalStore(
    agentStatusClient.subscribe,
    agentStatusClient.getSnapshot,
  );
  const ptyId = ptyIdForLeaf(leafId);
  const crew = useMemo(
    () => buildCrewViewForPane(snapshot, ptyId, agentStatuses),
    [snapshot, ptyId, agentStatuses, agentStatusRevision],
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [denyReasonByApproval, setDenyReasonByApproval] = useState<Record<string, string>>({});
  const [previewByDispatch, setPreviewByDispatch] = useState<Record<string, string>>({});
  const [confirmForceReleaseByDispatch, setConfirmForceReleaseByDispatch] = useState<
    Record<string, string>
  >({});

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setExpanded(false);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [expanded]);

  const insertTextIntoCurrentTerminal = useCallback(
    async (text: string) => {
      if (!text) return;
      const res = await window.vibeMeet.shellPty.input(ptyId, text);
      if (!res.ok) {
        onNotify?.(res.error ?? '无法写入当前终端');
      }
    },
    [ptyId, onNotify],
  );

  const focusMemberPane = useCallback(
    (entry: { ptyId: string | null; label: string; dispatchId?: string | null; taskId?: string | null; cwd?: string | null; cliId?: string | null }) => {
      if (!entry.ptyId) {
        onNotify?.(`${entry.label} 没有关联的活跃终端`);
        return;
      }
      dispatchFocusOrchestrationTarget({
        kind: 'dispatch',
        label: entry.label,
        ptyId: entry.ptyId,
        dispatchId: entry.dispatchId ?? null,
        taskId: entry.taskId ?? null,
        cwd: entry.cwd ?? null,
        cliId: entry.cliId ?? null,
      });
    },
    [onNotify],
  );

  const handleApprove = async (approvalId: string) => {
    const api = window.vibeMeet.orchestration?.approve;
    if (!api) return;
    setBusyId(approvalId);
    try {
      const res = await api({ id: approvalId, from: ptyId });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已允许工具执行');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeny = async (approvalId: string) => {
    const api = window.vibeMeet.orchestration?.deny;
    if (!api) return;
    setBusyId(approvalId);
    try {
      const reason = denyReasonByApproval[approvalId]?.trim() || 'Denied from Crew panel';
      const res = await api({ id: approvalId, from: ptyId, reason });
      if (!res.ok) onNotify?.(res.error);
      else {
        setDenyReasonByApproval((prev) => {
          const next = { ...prev };
          delete next[approvalId];
          return next;
        });
        onNotify?.('已拒绝工具执行');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleReplyQuestion = async (messageId: string, body: string) => {
    const trimmed = body.trim();
    const api = window.vibeMeet.orchestration?.reply;
    if (!trimmed || !api) return;
    setBusyId(messageId);
    try {
      const res = await api({
        id: messageId,
        body: trimmed,
        from: ptyId,
      });
      if (!res.ok) onNotify?.(res.error);
      else {
        setQuestionDrafts((prev) => {
          const next = { ...prev };
          delete next[messageId];
          return next;
        });
        onNotify?.('已回复 Worker 提问');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleResolveGate = async (gateId: string, resolution: string) => {
    const trimmed = resolution.trim();
    const api = window.vibeMeet.orchestration?.gateResolve;
    if (!trimmed || !api) return;
    setBusyId(gateId);
    try {
      const res = await api({
        id: gateId,
        resolution: trimmed,
      });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已通过决策门禁');
    } finally {
      setBusyId(null);
    }
  };

  const handleTogglePreview = async (entry: CrewMemberEntry) => {
    if (!entry.dispatch) return;
    const dId = entry.dispatch.id;
    if (previewByDispatch[dId] !== undefined) {
      setPreviewByDispatch((prev) => {
        const next = { ...prev };
        delete next[dId];
        return next;
      });
      return;
    }
    const api = window.vibeMeet.orchestration?.workerRead;
    if (!api) return;
    setBusyId(`read:${dId}`);
    try {
      const res = await api({ dispatchId: dId, screen: true });
      if (!res.ok) {
        onNotify?.(res.error);
      } else {
        setPreviewByDispatch((prev) => ({
          ...prev,
          [dId]: res.text.trim() || '(终端屏幕当前为空)',
        }));
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleKeepOpen = async (entry: CrewMemberEntry) => {
    const api = window.vibeMeet.orchestration?.workerKeepOpen;
    if (!entry.dispatch || !api) return;
    const dId = entry.dispatch.id;
    setBusyId(`keep:${dId}`);
    try {
      const res = await api({
        dispatchId: dId,
        keepOpen: !entry.retained,
      });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.(res.retained ? '已保留 Worker 终端' : '已取消保留 Worker 终端');
    } finally {
      setBusyId(null);
    }
  };

  const handleRelease = async (entry: CrewMemberEntry, force = false) => {
    const api = window.vibeMeet.orchestration?.workerRelease;
    if (!entry.dispatch || !api) return;
    const dId = entry.dispatch.id;
    setBusyId(`rel:${dId}`);
    try {
      const res = await api({
        dispatchId: dId,
        ...(force ? { force: true } : {}),
      });
      if (!res.ok) {
        if (!force && res.code === 'operation_rejected') {
          setConfirmForceReleaseByDispatch((prev) => ({
            ...prev,
            [dId]: res.error,
          }));
        }
        onNotify?.(res.error);
      } else {
        setConfirmForceReleaseByDispatch((prev) => {
          if (!(dId in prev)) return prev;
          const next = { ...prev };
          delete next[dId];
          return next;
        });
        onNotify?.(res.closedPane ? '已释放 Worker 资源' : '已释放工作树（保留终端）');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (entry: CrewMemberEntry) => {
    const api = window.vibeMeet.orchestration?.workerStop;
    if (!entry.dispatch || !api) return;
    const dId = entry.dispatch.id;
    setBusyId(`stop:${dId}`);
    try {
      const res = await api({
        dispatchId: dId,
        reason: 'Stopped from Crew panel',
      });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已终止 Worker');
    } finally {
      setBusyId(null);
    }
  };

  if (!crew.isVisible) {
    return null;
  }

  return (
    <div
      ref={rootRef}
      className={`aha-crew-overlay ${searchOpen ? 'is-below-search' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={`aha-crew-pill tone-${crew.pillTone} ${expanded ? 'is-open' : ''}`}
        aria-expanded={expanded}
        aria-label="Orchestration Crew"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className={`aha-crew-dot tone-${crew.pillTone}`} aria-hidden="true" />
        <Users size={12} />
        <span className="aha-crew-pill-label">{crew.pillLabel}</span>
        {crew.attentionCount > 0 && (
          <span className="aha-crew-pill-badge">{crew.attentionCount}</span>
        )}
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>

      {expanded && (
        <div className="aha-crew-drawer" role="region" aria-label="Orchestration Crew 详情">
          {crew.openApprovals.length > 0 && (
            <section className="aha-crew-section is-alert">
              <header className="aha-crew-section-header">
                <span>
                  <ShieldAlert size={12} /> 权限请求 ({crew.openApprovals.length})
                </span>
              </header>
              {crew.openApprovals.map((app) => (
                <div key={app.approvalId} className="aha-crew-alert-card">
                  <div className="aha-crew-alert-title">
                    <strong>{app.toolName}</strong>
                    <small>{app.approvalId}</small>
                  </div>
                  {app.toolInput && <code className="aha-crew-code">{app.toolInput}</code>}
                  <div className="aha-crew-inline-actions">
                    <input
                      type="text"
                      placeholder="拒绝原因（可选）"
                      value={denyReasonByApproval[app.approvalId] ?? ''}
                      onChange={(e) =>
                        setDenyReasonByApproval((prev) => ({
                          ...prev,
                          [app.approvalId]: e.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="is-ok"
                      disabled={busyId === app.approvalId}
                      onClick={() => void handleApprove(app.approvalId)}
                    >
                      <Check size={11} /> Allow
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      disabled={busyId === app.approvalId}
                      onClick={() => void handleDeny(app.approvalId)}
                    >
                      <X size={11} /> Deny
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {crew.openQuestions.length > 0 && (
            <section className="aha-crew-section is-alert">
              <header className="aha-crew-section-header">
                <span>Worker 提问 ({crew.openQuestions.length})</span>
              </header>
              {crew.openQuestions.map((q) => (
                <div key={q.messageId} className="aha-crew-alert-card">
                  <p className="aha-crew-question-text">{q.question}</p>
                  {q.options.length > 0 && (
                    <div className="aha-crew-chips">
                      {q.options.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          disabled={busyId === q.messageId}
                          onClick={() => void handleReplyQuestion(q.messageId, opt)}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="aha-crew-inline-actions">
                    <input
                      type="text"
                      placeholder="输入回复…"
                      value={questionDrafts[q.messageId] ?? ''}
                      onChange={(e) =>
                        setQuestionDrafts((prev) => ({ ...prev, [q.messageId]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleReplyQuestion(q.messageId, questionDrafts[q.messageId] ?? '');
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="is-accent"
                      disabled={busyId === q.messageId}
                      onClick={() =>
                        void handleReplyQuestion(q.messageId, questionDrafts[q.messageId] ?? '')
                      }
                    >
                      回复
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {crew.openGates.length > 0 && (
            <section className="aha-crew-section is-alert">
              <header className="aha-crew-section-header">
                <span>决策门禁 ({crew.openGates.length})</span>
              </header>
              {crew.openGates.map((g) => (
                <div key={g.id} className="aha-crew-alert-card">
                  <p className="aha-crew-question-text">{g.question}</p>
                  <div className="aha-crew-chips">
                    {(g.options.length > 0 ? g.options : ['approve', 'reject']).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        disabled={busyId === g.id}
                        onClick={() => void handleResolveGate(g.id, opt)}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}

          {crew.managedBy && (
            <section className="aha-crew-section">
              <header className="aha-crew-section-header">
                <span>Managed by</span>
              </header>
              <div className="aha-crew-row">
                <button
                  type="button"
                  className="aha-crew-row-main"
                  title="点击切换到上级终端"
                  onClick={() =>
                    focusMemberPane({
                      ptyId: crew.managedBy!.ptyId,
                      label: crew.managedBy!.label,
                      dispatchId: crew.managedBy!.dispatch?.id,
                      taskId: crew.managedBy!.task?.id,
                      cwd: crew.managedBy!.worktreePath,
                      cliId: crew.managedBy!.cliId,
                    })
                  }
                >
                  <TerminalProfileIcon id={crew.managedBy.cliId ?? undefined} size={13} />
                  <span className="aha-crew-row-text">
                    <strong>{crew.managedBy.label}</strong>
                    <small>{crew.managedBy.subtitle}</small>
                  </span>
                  <span className={`aha-crew-stage tone-${crew.managedBy.tone}`}>
                    {crew.managedBy.stageLabel}
                  </span>
                </button>
                <div className="aha-crew-row-actions">
                  <button
                    type="button"
                    title={`在终端插入 ${crew.managedBy.mentionToken}`}
                    onClick={() => void insertTextIntoCurrentTerminal(`${crew.managedBy!.mentionToken} `)}
                  >
                    <AtSign size={12} />
                  </button>
                </div>
              </div>
            </section>
          )}

          {crew.managing.length > 0 && (
            <section className="aha-crew-section">
              <header className="aha-crew-section-header">
                <span>Managing ({crew.managing.length})</span>
                <button
                  type="button"
                  className="aha-crew-mention-all"
                  title="在当前终端插入全部下属 Worker 提及"
                  onClick={() => void insertTextIntoCurrentTerminal(crew.mentionAllText)}
                >
                  <AtSign size={11} /> Mention all
                </button>
              </header>
              {crew.managing.map((entry) => {
                const dId = entry.dispatch?.id ?? entry.key;
                const preview = previewByDispatch[dId];
                const forceReleaseReason = confirmForceReleaseByDispatch[dId];
                return (
                  <div key={entry.key} className="aha-crew-item">
                    <div className="aha-crew-row">
                      <button
                        type="button"
                        className="aha-crew-row-main"
                        title="定位到该 Worker 终端"
                        onClick={() =>
                          focusMemberPane({
                            ptyId: entry.ptyId,
                            label: entry.label,
                            dispatchId: entry.dispatch?.id,
                            taskId: entry.task?.id,
                            cwd: entry.worktreePath,
                            cliId: entry.cliId,
                          })
                        }
                      >
                        <TerminalProfileIcon id={entry.cliId ?? undefined} size={13} />
                        <span className="aha-crew-row-text">
                          <strong>{entry.label}</strong>
                          <small>
                            {entry.subtitle}
                            {entry.model ? ` · ${entry.model}${entry.effort ? ` (${entry.effort})` : ''}` : ''}
                            {entry.branch ? (
                              <>
                                {' · '}
                                <GitBranch size={10} style={{ verticalAlign: '-1px' }} /> {entry.branch}
                              </>
                            ) : null}
                          </small>
                        </span>
                        <span className={`aha-crew-stage tone-${entry.tone}`}>
                          {entry.stageLabel}
                        </span>
                      </button>
                      <div className="aha-crew-row-actions">
                        <button
                          type="button"
                          title={`在终端插入 ${entry.mentionToken}`}
                          onClick={() => void insertTextIntoCurrentTerminal(`${entry.mentionToken} `)}
                        >
                          <AtSign size={12} />
                        </button>
                        <button
                          type="button"
                          className={preview !== undefined ? 'is-active' : ''}
                          title="读取 Worker 当前屏幕快照"
                          onClick={() => void handleTogglePreview(entry)}
                        >
                          <Eye size={12} />
                        </button>
                        <button
                          type="button"
                          className={entry.retained ? 'is-active' : ''}
                          title={entry.retained ? '已保留终端（点击取消）' : '保留 Worker 终端'}
                          onClick={() => void handleKeepOpen(entry)}
                        >
                          <Pin size={12} />
                        </button>
                        {entry.isSettled ? (
                          <button
                            type="button"
                            title="释放已完成的 Worker 与工作树"
                            disabled={busyId === `rel:${dId}`}
                            onClick={() => void handleRelease(entry)}
                          >
                            <Trash2 size={12} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="is-danger"
                            title="终止该运行中的 Worker"
                            disabled={busyId === `stop:${dId}`}
                            onClick={() => void handleStop(entry)}
                          >
                            <Square size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                    {forceReleaseReason && (
                      <div className="aha-crew-force-confirm" role="alert">
                        <span>{forceReleaseReason}</span>
                        <div className="aha-crew-inline-actions">
                          <button
                            type="button"
                            className="is-danger"
                            disabled={busyId === `rel:${dId}`}
                            onClick={() => void handleRelease(entry, true)}
                          >
                            强制释放
                          </button>
                          <button
                            type="button"
                            disabled={busyId === `rel:${dId}`}
                            onClick={() =>
                              setConfirmForceReleaseByDispatch((prev) => {
                                const next = { ...prev };
                                delete next[dId];
                                return next;
                              })
                            }
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                    {preview !== undefined && (
                      <pre className="aha-crew-preview">{preview}</pre>
                    )}
                  </div>
                );
              })}
            </section>
          )}

          {crew.talkingWith.length > 0 && (
            <section className="aha-crew-section">
              <header className="aha-crew-section-header">
                <span>Talking with ({crew.talkingWith.length})</span>
              </header>
              {crew.talkingWith.map((peer) => (
                <div key={peer.key} className="aha-crew-row">
                  <button
                    type="button"
                    className="aha-crew-row-main"
                    onClick={() =>
                      focusMemberPane({
                        ptyId: peer.ptyId,
                        label: peer.label,
                        cliId: peer.cliId,
                      })
                    }
                  >
                    <TerminalProfileIcon id={peer.cliId ?? undefined} size={13} />
                    <span className="aha-crew-row-text">
                      <strong>{peer.label}</strong>
                      <small>{peer.lastSubject}</small>
                    </span>
                    {peer.unreadCount > 0 && (
                      <span className="aha-crew-pill-badge">{peer.unreadCount}</span>
                    )}
                    {peer.ptyId && <ExternalLink size={11} className="aha-crew-ext" />}
                  </button>
                  <div className="aha-crew-row-actions">
                    <button
                      type="button"
                      title={`在终端插入 ${peer.mentionToken}`}
                      onClick={() => void insertTextIntoCurrentTerminal(`${peer.mentionToken} `)}
                    >
                      <AtSign size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}
        </div>
      )}
    </div>
  );
}
