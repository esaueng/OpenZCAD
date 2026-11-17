// Host conditions and browser switches shared by the ROADMAP Active 1
// performance probes (H02 first edit after reload, W01 interaction latency,
// large pattern previews) and `scripts/measure-active1-baselines.mjs`.
// Every baseline in docs/performance/2026-11-15-active1-baselines.md records
// a host snapshot beside its number: other agents' builds share the machine,
// and a sample taken while one runs is not comparable.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';

/** Processes whose presence makes a host too busy to measure on. */
export const BUSY_PROCESS = /\b(cargo|rustc|playwright)\b/;
/** Ancestors that are still part of the measuring command itself. */
const OWN_COMMAND = /\b(pnpm|playwright|vitest|measure-active1-baselines)\b/;

/** The quiet-host rule the Active 1 baselines were measured under. */
export const QUIET_HOST = Object.freeze({
  maxLoadAverage1m: 2.0,
  minAvailableMemoryBytes: 3 * 1024 ** 3
});

function availableMemory() {
  try {
    const match = /^MemAvailable:\s+(\d+) kB$/m.exec(
      readFileSync('/proc/meminfo', 'utf8')
    );
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
}

function processTable() {
  try {
    return execFileSync('ps', ['-eo', 'pid=,ppid=,args='], {
      encoding: 'utf8'
    })
      .split('\n')
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
      .filter((match) => match !== null)
      .map(([, pid, ppid, args]) => ({
        pid: Number(pid),
        ppid: Number(ppid),
        args
      }));
  } catch {
    return [];
  }
}

/**
 * cargo, rustc and Playwright (including its browsers) processes outside the
 * measuring run's own process tree. `ownRoot` names that tree's root; by
 * default it is the topmost ancestor still running pnpm, Playwright, Vitest
 * or the baseline runner, or `OZ_PERF_OWN_ROOT` when the runner set it.
 */
export function busyProcesses(ownRoot) {
  const rows = processTable();
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]));
  const args = new Map(rows.map((row) => [row.pid, row.args]));
  let root = ownRoot ?? (Number(process.env.OZ_PERF_OWN_ROOT) || undefined);
  if (root === undefined) {
    root = process.pid;
    for (let at = parent.get(process.pid), hops = 0; at && hops < 16; hops++) {
      if (!OWN_COMMAND.test(args.get(at) ?? '')) break;
      root = at;
      at = parent.get(at);
    }
  }
  const own = (pid) => {
    for (let at = pid, hops = 0; at && hops < 64; hops++) {
      if (at === root) return true;
      at = parent.get(at);
    }
    return false;
  };
  return rows
    .filter((row) => BUSY_PROCESS.test(row.args) && !own(row.pid))
    .map((row) => `${row.pid} ${row.args.slice(0, 120)}`);
}

export function hostSnapshot(ownRoot) {
  const [one, five] = loadavg();
  return {
    recordedAt: new Date().toISOString(),
    loadAverage1m: one,
    loadAverage5m: five,
    freeMemoryBytes: freemem(),
    availableMemoryBytes: availableMemory(),
    totalMemoryBytes: totalmem(),
    cpuModel: cpus()[0]?.model ?? null,
    cpuCount: cpus().length,
    busyProcesses: busyProcesses(ownRoot)
  };
}

/** Why a snapshot is not quiet, or an empty list when it is. */
export function noisyReasons(snapshot, rule = QUIET_HOST) {
  const reasons = [];
  if (snapshot.loadAverage1m >= rule.maxLoadAverage1m)
    reasons.push(`load ${snapshot.loadAverage1m.toFixed(2)}`);
  const available = snapshot.availableMemoryBytes ?? snapshot.freeMemoryBytes;
  if (available < rule.minAvailableMemoryBytes)
    reasons.push(`${(available / 1024 ** 3).toFixed(1)} GiB available`);
  if (snapshot.busyProcesses.length)
    reasons.push(`${snapshot.busyProcesses.length} busy processes`);
  return reasons;
}

/**
 * Chromium switches for `OZ_PERF_ANGLE`: unset keeps Playwright's headless
 * default (SwiftShader on Linux); `vulkan`, `gl` or another ANGLE backend
 * renders on the machine's GPU. Each probe records the renderer it got.
 */
export function perfBrowserArgs(angle = process.env.OZ_PERF_ANGLE) {
  if (!angle) return [];
  return [
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    `--use-angle=${angle}`,
    ...(angle === 'vulkan' ? ['--enable-features=Vulkan'] : [])
  ];
}
