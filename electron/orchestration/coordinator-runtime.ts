import type { BuildDispatchPreambleInput } from './worker-dispatch-preamble.js';
import type {
  OrchestrationStartObservation,
  OrchestrationTaskRecord,
} from './orchestration-types.js';

export interface WorkerPaneCandidate {
  ptyId: string;
  agentId?: string | null;
  cwd?: string;
}

export interface CoordinatorRuntime {
  buildDispatchBrief?: (input: BuildDispatchPreambleInput) => string;
  cliCommand?: string;
  maxDepth?: number;
  listWorkerCandidates: (excludePaneIds: ReadonlySet<string>, cwd?: string, cliId?: string) => WorkerPaneCandidate[];
  launchDependent?: (task: OrchestrationTaskRecord, cliId: string) => Promise<void>;
  verifyCodeInputs?: (task: OrchestrationTaskRecord, cwd?: string) => Promise<void>;
  spawnWorker?: (input: {
    runId: string;
    task: OrchestrationTaskRecord;
    cliId?: string;
    cwd?: string;
  }) => Promise<WorkerPaneCandidate | null>;
  isPaneAlive: (ptyId: string) => boolean;
  hasPaneExited: (ptyId: string) => boolean;
  sendTurn: (input: {
    ptyId: string;
    body: string;
    freshlySpawned?: boolean;
    submit?: boolean;
  }) => Promise<{
    ok: boolean;
    error?: string;
    startObservation?: OrchestrationStartObservation;
    observationReason?: string;
    promptDeferred?: boolean;
  }>;
  notifyStateChanged: (reason: string, runId?: string) => void;
}
