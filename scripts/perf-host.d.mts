export interface HostSnapshot {
  recordedAt: string;
  loadAverage1m: number;
  loadAverage5m: number;
  freeMemoryBytes: number;
  /** Linux `MemAvailable`; null elsewhere. */
  availableMemoryBytes: number | null;
  totalMemoryBytes: number;
  cpuModel: string | null;
  cpuCount: number;
  busyProcesses: string[];
}

export interface QuietHostRule {
  maxLoadAverage1m: number;
  minAvailableMemoryBytes: number;
}

export const BUSY_PROCESS: RegExp;
export const QUIET_HOST: Readonly<QuietHostRule>;
export function busyRows<T extends { pid: number; ppid: number; args: string }>(
  rows: readonly T[],
  root: number
): T[];
export function busyProcesses(ownRoot?: number): string[];
export function hostSnapshot(ownRoot?: number): HostSnapshot;
export function noisyReasons(
  snapshot: HostSnapshot,
  rule?: QuietHostRule
): string[];
export function perfBrowserArgs(angle?: string): string[];
