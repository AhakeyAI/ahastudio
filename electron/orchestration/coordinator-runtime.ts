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
  cliCommand?: string;
  maxDepth?: number;
  listWorkerCandidates: (excludePaneIds: ReadonlySet<string>) => WorkerPaneCandidate[];
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
    submit?: boolean;
  }) => Promise<{
    ok: boolean;
    error?: string;
    startObservation?: OrchestrationStartObservation;
    observationReason?: string;
  }>;
  notifyStateChanged: (reason: string, runId?: string) => void;
}
