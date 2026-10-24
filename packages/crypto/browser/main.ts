/**
 * Browser run of the `@openzcad/crypto` scenarios on the page's own
 * WebCrypto and web streams. `run.mjs` reads `window.cryptoRun` once `done`.
 */
import type { StepResult } from './scenarios';

declare global {
  interface Window {
    cryptoRun?: {
      done: boolean;
      userAgent: string;
      secureContext: boolean;
      results: StepResult[];
      error?: string;
    };
  }
}

const out = document.getElementById('out')!;
const run: NonNullable<Window['cryptoRun']> = {
  done: false,
  userAgent: navigator.userAgent,
  secureContext: window.isSecureContext,
  results: []
};
window.cryptoRun = run;

try {
  const { runCryptoScenarios } = await import('./scenarios');
  await runCryptoScenarios((result) => {
    run.results.push(result);
    out.textContent = `${run.results.length} steps…`;
  });
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
