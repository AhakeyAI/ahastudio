// Dismissible inline banners above the direct-session composer for `/clear`, `/usage-limits`,
// `/goal`, and `/feedback`.
// Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.):
// - apps/web/src/components/chat/ComposerFreshSession.tsx
// - apps/web/src/components/chat/ComposerUsageLimits.tsx
// - packages/client-runtime/src/state/threadFeedback.ts

import { memo } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Eraser,
  Gauge,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Target,
  X,
} from 'lucide-react';
import type { UsageSummary } from '../../lib/usage-limits';
import type { AgentGoalStatus, AgentSessionGoal } from '../../types';
import { CopyButton } from './SessionCode';

export type FeedbackBannerState =
  | { status: 'uploading' }
  | { status: 'sent'; feedbackId: string }
  | { status: 'failed'; error: string };

const GOAL_STATUS_LABELS: Record<AgentGoalStatus, string> = {
  active: '进行中',
  paused: '已暂停',
  blocked: '已阻塞',
  usageLimited: '额度受限',
  budgetLimited: '预算受限',
  complete: '已完成',
};

/** Shown while `/clear` is armed; dismissing keeps the current provider conversation. */
export const FreshSessionBanner = memo(function FreshSessionBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="asv-slash-banner is-info" role="status" aria-label="新上下文已就绪">
      <div className="asv-slash-banner-row">
        <Eraser size={14} className="asv-slash-banner-icon" aria-hidden="true" />
        <div className="asv-slash-banner-main">
          <div className="asv-slash-banner-title">下一条消息将开启全新上下文</div>
          <div className="asv-slash-banner-desc">模型不会看到当前会话此前的消息，上方历史记录仍会保留。</div>
        </div>
        <button type="button" className="asv-btn is-ghost" onClick={onDismiss}>
          保留当前上下文
        </button>
      </div>
    </div>
  );
});

/** Shown when `/usage-limits` is invoked; displays each Codex quota window with refresh & close. */
export const UsageLimitsBanner = memo(function UsageLimitsBanner({
  summary,
  refreshing,
  onRefresh,
  onClose,
}: {
  summary: UsageSummary | null;
  refreshing: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  return (
    <div className="asv-slash-banner is-info" role="region" aria-label="Codex 额度详情">
      <div className="asv-slash-banner-head">
        <Gauge size={14} className="asv-slash-banner-icon" aria-hidden="true" />
        <span className="asv-slash-banner-title">
          Codex 额度{summary?.planType ? ` · ${summary.planType}` : ''}
        </span>
        <span className="asv-strip-spacer" />
        <button
          type="button"
          className="asv-icon-btn"
          disabled={refreshing}
          aria-label="刷新额度"
          title="重新查询额度"
          onClick={onRefresh}
        >
          <RefreshCw size={12} className={refreshing ? 'asv-spin' : undefined} />
        </button>
        <button type="button" className="asv-icon-btn" aria-label="关闭额度面板" title="关闭" onClick={onClose}>
          <X size={13} />
        </button>
      </div>
      {summary && summary.windows.length > 0 ? (
        <div className="asv-slash-usage-grid">
          {summary.windows.map((window, index) => (
            <div key={index} className="asv-usage-row">
              <div className="asv-usage-line">
                <span className="asv-usage-label">{window.label}</span>
                <span className="asv-usage-used">{window.used}</span>
              </div>
              <span className={`asv-usage-bar is-${window.level}`}>
                <i style={{ width: `${window.percent}%` }} />
              </span>
              {window.reset && <span className="asv-usage-reset">{window.reset}</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="asv-slash-banner-desc">当前账号没有可用的 Codex 额度信息。</div>
      )}
    </div>
  );
});

/** Shown whenever the session has a Codex thread goal (`/goal`), with pause/resume/clear controls. */
export const GoalBanner = memo(function GoalBanner({
  goal,
  running,
  busy,
  onPause,
  onResume,
  onClear,
}: {
  goal: AgentSessionGoal;
  running: boolean;
  busy: boolean;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}) {
  const tone = goal.status === 'complete' ? 'is-ok' : goal.status === 'blocked' || goal.status === 'usageLimited' || goal.status === 'budgetLimited' ? 'is-warn' : 'is-info';
  return (
    <div className={`asv-slash-banner ${tone}`} role="region" aria-label="会话目标">
      <div className="asv-slash-banner-row">
        <Target size={14} className="asv-slash-banner-icon" aria-hidden="true" />
        <div className="asv-slash-banner-main">
          <div className="asv-slash-banner-title-line">
            <span className="asv-slash-banner-title">会话目标</span>
            <span className={`asv-pop-badge${goal.status === 'active' || goal.status === 'complete' ? ' is-ok' : ''}`}>
              {GOAL_STATUS_LABELS[goal.status]}
            </span>
          </div>
          <div className="asv-slash-banner-desc is-clamp" title={goal.objective}>{goal.objective}</div>
        </div>
        <div className="asv-slash-banner-actions">
          {goal.status === 'active' && (
            <button type="button" className="asv-btn is-ghost" disabled={busy} onClick={onPause}>
              <Pause size={12} /> 暂停
            </button>
          )}
          {(goal.status === 'paused' || goal.status === 'blocked') && (
            <button type="button" className="asv-btn is-ghost" disabled={busy || running} onClick={onResume}>
              <Play size={12} /> 继续
            </button>
          )}
          <button type="button" className="asv-icon-btn" disabled={busy} aria-label="清除目标" title="清除目标" onClick={onClear}>
            <X size={13} />
          </button>
        </div>
      </div>
    </div>
  );
});

/** Shown while `/feedback` uploads thread logs to OpenAI and once it settles. */
export const FeedbackBanner = memo(function FeedbackBanner({
  state,
  onDismiss,
}: {
  state: FeedbackBannerState;
  onDismiss: () => void;
}) {
  const tone = state.status === 'sent' ? 'is-ok' : state.status === 'failed' ? 'is-bad' : 'is-info';
  return (
    <div className={`asv-slash-banner ${tone}`} role="status" aria-label="反馈状态">
      <div className="asv-slash-banner-row">
        {state.status === 'uploading' ? (
          <Loader2 size={14} className="asv-slash-banner-icon asv-spin" aria-hidden="true" />
        ) : state.status === 'sent' ? (
          <CheckCircle2 size={14} className="asv-slash-banner-icon" aria-hidden="true" />
        ) : (
          <CircleAlert size={14} className="asv-slash-banner-icon" aria-hidden="true" />
        )}
        <div className="asv-slash-banner-main">
          {state.status === 'uploading' ? (
            <div className="asv-slash-banner-title">正在向 OpenAI 发送当前会话与 Codex 日志…</div>
          ) : state.status === 'sent' ? (
            <>
              <div className="asv-slash-banner-title">反馈已发送至 OpenAI</div>
              <div className="asv-slash-banner-desc">
                Thread ID: <code>{state.feedbackId}</code>
              </div>
            </>
          ) : (
            <>
              <div className="asv-slash-banner-title">反馈发送失败</div>
              <div className="asv-slash-banner-desc">{state.error}</div>
            </>
          )}
        </div>
        <div className="asv-slash-banner-actions">
          {state.status === 'sent' && <CopyButton text={state.feedbackId} label="复制 Thread ID" className="asv-act" />}
          {state.status !== 'uploading' && (
            <button type="button" className="asv-icon-btn" aria-label="关闭反馈提示" title="关闭" onClick={onDismiss}>
              <X size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
