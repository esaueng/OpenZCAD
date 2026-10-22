/**
 * Browser run of the MLS scenarios through the real lazily started module
 * Worker. The entry chunk holds only this file: the package, the scenarios
 * and the WASM are loaded on demand.
 */
interface StepResult {
  suite: string;
  step: string;
  ok: boolean;
  detail: string;
  ms: number;
}

declare global {
  interface Window {
    mlsRun?: {
      done: boolean;
      userAgent: string;
      build?: unknown;
      results: StepResult[];
      error?: string;
    };
  }
}

const out = document.getElementById('out')!;
const run: NonNullable<Window['mlsRun']> = {
  done: false,
  userAgent: navigator.userAgent,
  results: []
};
window.mlsRun = run;

try {
  const [{ loadMls }, { runScenarios }] = await Promise.all([
    import('../src/index'),
    import('../src/scenarios')
  ]);
  const mls = loadMls();
  run.build = await mls.buildInfo();
  await runScenarios(mls, (result) => {
    run.results.push(result);
    out.textContent = `${run.results.length} steps…`;
  });
  mls.close();
} catch (error) {
  run.error =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
}
run.done = true;
const failed = run.results.filter((r) => !r.ok);
out.textContent = run.error
  ? `error: ${run.error}`
  : `${run.results.length - failed.length}/${run.results.length} steps passed\n` +
    failed.map((r) => `FAIL ${r.suite} › ${r.step}: ${r.detail}`).join('\n');

export {};
