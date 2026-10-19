import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createHooks, installWindowShim, summarize } from './hooks.mjs';
import { installNodeWebCryptoShim } from './node-webcrypto-shim.mjs';

const PKG = new URL('../pkg/', import.meta.url);
const RESULTS = new URL('../results/', import.meta.url);
const PROJECT_ID = '0f7c6a52-3d1e-4b8a-9f3e-6c2d1b0a9e87';
const ROUNDS = Number(process.env.MLS_SPIKE_ROUNDS ?? 12);

const LIBRARIES = [
  { dir: 'mls-rs', name: 'openzcad_mls_spike_mls_rs' },
  { dir: 'mls-rs-rustcrypto', name: 'openzcad_mls_spike_mls_rs_rustcrypto' },
  { dir: 'openmls', name: 'openzcad_mls_spike_openmls' }
];

installWindowShim();
installNodeWebCryptoShim();

describe.each(LIBRARIES)('$dir', ({ dir, name }) => {
  it('runs the ADR-024 scenario on suite 0x0002', async () => {
    const mod = await import(new URL(`${dir}/${name}.js`, PKG).href);
    await mod.default({
      module_or_path: await readFile(new URL(`${dir}/${name}_bg.wasm`, PKG))
    });
    const { hooks, evidence } = createHooks();
    const report = JSON.parse(
      await mod.run_scenario(PROJECT_ID, hooks, ROUNDS)
    );
    const summary = {
      host: `node ${process.version}`,
      ...summarize(report),
      persistence: evidence
    };
    await mkdir(RESULTS, { recursive: true });
    await writeFile(
      new URL(`node-${dir}.json`, RESULTS),
      JSON.stringify({ summary, report }, null, 2) + '\n'
    );

    expect(report.cipher_suite).toBe(2);
    expect(summary.failedSteps).toEqual([]);
    expect(report.steps.map((s) => s.name)).toEqual([
      'create + add A2 via Welcome',
      'add B1 with editor role',
      'Update proposal by B1, committed by A1',
      'timed path-only commits',
      'timed Welcome joins',
      'policy: editor Add rejected',
      'policy: uncertified external commit rejected',
      'conflicting commits, loser rebases',
      'state persisted, reloaded, commits again',
      'external-commit rejoin of wiped A2',
      'remove A2',
      'B self-removal (SelfRemove)'
    ]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      keyExtractable: false,
      exportRefused: true,
      identical: true
    });
  });

  it('enforces the ADR-024 rejoin rules on external Commits', async () => {
    const mod = await import(new URL(`${dir}/${name}.js`, PKG).href);
    const { hooks } = createHooks();
    const report = JSON.parse(await mod.run_rejoin_scenario(PROJECT_ID, hooks));
    await writeFile(
      new URL(`node-${dir}-rejoin.json`, RESULTS),
      JSON.stringify(report, null, 2) + '\n'
    );
    expect(report.steps.filter((s) => !s.ok)).toEqual([]);
    expect(report.steps.map((s) => s.name)).toEqual([
      'rejoin: wiped sole member',
      'library: resumption PSK in an external Commit',
      'rejoin refused: revoked device with a fresh PSK',
      "rejoin refused: PSK older than the user's newest revocation",
      'rejoin accepted: unrevoked device, PSK inside the window',
      'rejoin refused: PSK outside the retention window',
      "rejoin refused: PSK from before the member's role change",
      'rejoin refused: removed member, PSK from before removal'
    ]);
  });
});
