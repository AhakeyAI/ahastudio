export type RuntimeState = 'not-installed' | 'not-enabled' | 'dependency-missing' | 'authentication-required'
  | 'permission-required' | 'host-unsupported' | 'configured' | 'verified' | 'unverified' | 'error';
export interface RuntimeFinding { name: string; state: RuntimeState; detail: string }
export interface CodexRuntimeReport {
  cwd: string; cli: string | null; configFile: string; separateProfile: boolean;
  findings: RuntimeFinding[]; checkedAt: number;
  configSources: { kind: string; path: string | null; active: boolean }[];
}
