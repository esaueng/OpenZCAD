import {
  createHooks,
  installWindowShim,
  summarize
} from '../harness/hooks.mjs';

installWindowShim();

const PROJECT_ID = '0f7c6a52-3d1e-4b8a-9f3e-6c2d1b0a9e87';

const loaders = {
  'mls-rs': () => import('../pkg/mls-rs/openzcad_mls_spike_mls_rs.js'),
  'mls-rs-rustcrypto': () =>
    import('../pkg/mls-rs-rustcrypto/openzcad_mls_spike_mls_rs_rustcrypto.js'),
  openmls: () => import('../pkg/openmls/openzcad_mls_spike_openmls.js')
};

self.onmessage = async ({ data: { lib, rounds, scenario } }) => {
  try {
    const t0 = performance.now();
    const mod = await loaders[lib]();
    await mod.default();
    const loadMs = performance.now() - t0;
    // Clear state left by earlier runs in this origin.
    await new Promise((resolve) => {
      const req = indexedDB.deleteDatabase('openzcad-mls-spike');
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
    const { hooks, evidence } = createHooks();
    if (scenario === 'rejoin') {
      const report = JSON.parse(
        await mod.run_rejoin_scenario(PROJECT_ID, hooks)
      );
      self.postMessage({ lib, report });
      return;
    }
    const report = JSON.parse(
      await mod.run_scenario(PROJECT_ID, hooks, rounds)
    );
    const summary = {
      host: navigator.userAgent,
      loadMs: +loadMs.toFixed(1),
      ...summarize(report),
      persistence: evidence
    };
    self.postMessage({ lib, summary, report });
  } catch (error) {
    self.postMessage({ lib, error: String(error?.stack ?? error) });
  }
};
