import type { OrchestrationSnapshot } from '../types';

export function RunAttention({ snapshot, runId }: { snapshot: OrchestrationSnapshot; runId?: string }) {
  if (!runId) return null;
  const human = (snapshot.openApprovals ?? []).filter(a => a.runId === runId).length
    + (snapshot.pendingProposals ?? []).filter(p => p.runId === runId).length;
  const questions = snapshot.questions.filter(q => q.runId === runId && q.status === 'pending').length;
  const review = snapshot.dispatches.filter(d => d.runId === runId && (d.stage === 'needs_reconciliation' || d.stage === 'awaiting_review')).length;
  const queued = snapshot.tasks.filter(t => t.runId === runId && t.queuedLaunch).length;
  const summary = [human && `等你授权 ${human}`, questions && `待回答 ${questions}`, review && `待核对 ${review}`, queued && `排队 ${queued}`].filter(Boolean).join(' · ');
  if (!summary) return null;
  return <button type="button" title="打开本轮协作处理待办" onClick={() =>
    window.dispatchEvent(new CustomEvent('aha:open-orchestration-board', { detail: { runId } }))
  }>{summary}</button>;
}
