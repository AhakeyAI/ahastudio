import type { WorkerTimelineEvent } from '../orchestration/worker-timeline.js';

/** Replaces every credential the driver was launched with; tokens are long hex, so plain matching is exact. */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  for (const secret of secrets) if (secret) text = text.replaceAll(secret, '<redacted>');
  return text;
}

/** Redacts every string inside a timeline event before it leaves the driver. */
export function redactTimelineEvent(event: WorkerTimelineEvent, secrets: readonly string[]): WorkerTimelineEvent {
  if (secrets.length === 0) return event;
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redactSecrets(value, secrets);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
    }
    return value;
  };
  return walk(event) as WorkerTimelineEvent;
}

/** The Aha MCP credentials in a launch environment, which no transcript, diff, or error may show. */
export function ahaMcpSecrets(env: Readonly<Record<string, string>> | undefined): string[] {
  if (!env) return [];
  return [env.AHA_WORKER_TOKEN, env.AHA_SESSION_TOKEN, env.AHA_AGENT_HOOK_TOKEN]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}
