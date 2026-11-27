import { OrchestrationService } from '../../dist-electron/orchestration/orchestration-service.js';
import { TerminalRuntimeTracker } from '../../dist-electron/terminal-runtime-tracker.js';

// These service fixtures run in one known directory without a real PTY host registering panes.
export function atNextDelivery(service, action) {
  const deliver = service.deliverAndObserveDispatchTurn.bind(service);
  service.deliverAndObserveDispatchTurn = (...args) => {
    service.deliverAndObserveDispatchTurn = deliver;
    // Inject the activity while the transport owns observation of this delivery.
    service.inFlightObservationDispatches.add(args[0]);
    action();
    return deliver(...args);
  };
}

export function createTrackedTestService(deps) {
  const tracker = new TerminalRuntimeTracker();
  const getTerminal = tracker.getTerminal.bind(tracker);
  tracker.getTerminal = id => {
    const existing = getTerminal(id);
    if (existing) return existing;
    const pane = deps.agentStatusStore.get(id);
    if (!pane) return null;
    return tracker.registerPty({ ptyId: id, cwd: deps.getDefaultCwd?.() ?? process.cwd(), cliId: pane.agentId });
  };
  return new OrchestrationService({ terminalTracker: tracker, ...deps });
}
