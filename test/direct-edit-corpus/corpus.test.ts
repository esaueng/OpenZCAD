import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';

import {
  DIRECT_EDIT_FIXTURE_FORMAT,
  DIRECT_EDIT_FIXTURE_FORMAT_VERSION
} from '../../apps/web/src/lib/directEditFixture';
import type { DirectEditFixture } from '../../apps/web/src/lib/directEditFixture';
import { AUTHORED_REPLAY_CHECKS, AUTHORED_SCENARIOS } from './authored';
import { REFUSAL_PINS, SHAPE_PINS } from './pins';
import { replayFixture, type ReplayResult } from './replay';
import type { AuthoredScenario } from './authored';

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));

const capturedFiles = readdirSync(FIXTURES_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort();

let adapter: ExactKernelAdapter;

beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 30_000);

afterAll(() => {
  adapter.dispose();
});

function loadFixture(file: string): DirectEditFixture {
  return JSON.parse(
    readFileSync(join(FIXTURES_DIR, file), 'utf8')
  ) as DirectEditFixture;
}

function pinFor(name: string) {
  return REFUSAL_PINS.find((pin) => pin.fixture === name);
}

/**
 * Both directions. A pinned fixture must still refuse with the pinned
 * sentence; an unpinned one must commit, and an offset must move volume the
 * way its sign says.
 */
function assertOutcome(fixture: DirectEditFixture, result: ReplayResult): void {
  const pin = pinFor(fixture.name);
  if (pin) {
    expect(
      result.outcome,
      `${fixture.name} is pinned as refused (${pin.owner}); it now commits — retire the pin`
    ).toBe('refused');
    expect(result.message).toContain(pin.message);
    return;
  }
  expect(
    result.outcome,
    `${fixture.name} refused with: ${result.message ?? '(no message)'}`
  ).toBe('committed');
  if (fixture.edit.op === 'offset-face') {
    expect(result.volumeAfter).toBeDefined();
    if (fixture.edit.value > 0) {
      expect(result.volumeAfter).toBeGreaterThan(result.volumeBefore);
    } else if (fixture.edit.value < 0) {
      expect(result.volumeAfter).toBeLessThan(result.volumeBefore);
    }
  }
}

describe('captured direct-edit fixtures', () => {
  if (capturedFiles.length === 0) {
    it('has no captures yet', () => {
      expect(capturedFiles).toEqual([]);
    });
  }

  for (const file of capturedFiles) {
    const stem = basename(file, '.json');
    const fixture = loadFixture(file);
    const skipReason = fixture.document === null;
    const runner = skipReason ? it.skip : it;
    runner(
      skipReason
        ? `${stem} (skipped: document omitted — ${fixture.documentOmitted ?? 'unstated'})`
        : stem,
      async () => {
        expect(fixture.format).toBe(DIRECT_EDIT_FIXTURE_FORMAT);
        expect(fixture.formatVersion).toBe(DIRECT_EDIT_FIXTURE_FORMAT_VERSION);
        expect(fixture.name).toBe(stem);
        assertOutcome(fixture, await replayFixture(adapter, fixture));
      },
      60_000
    );
  }
});

/**
 * The oracle comparison. `committed` only says the kernel produced A solid;
 * this says whether it produced the RIGHT one, by rebuilding the same part
 * with its driving dimension moved and comparing volume deltas.
 */
async function assertShape(
  scenario: AuthoredScenario,
  result: ReplayResult
): Promise<void> {
  if (!scenario.expectedVolumeAfter || result.outcome !== 'committed') {
    return;
  }
  const expectedAfter = await scenario.expectedVolumeAfter(adapter);
  const expectedDelta = expectedAfter - result.volumeBefore;
  expect(result.volumeAfter).toBeDefined();
  const observedDelta =
    (result.volumeAfter ?? Number.NaN) - result.volumeBefore;
  const pin = SHAPE_PINS.find((entry) => entry.fixture === scenario.name);
  if (pin) {
    expect(
      observedDelta,
      `${scenario.name} is pinned at ${pin.observedVolumeDelta} (${pin.owner})`
    ).toBeCloseTo(pin.observedVolumeDelta, 3);
    expect(expectedDelta).toBeCloseTo(pin.expectedVolumeDelta, 3);
    expect(
      Math.abs(observedDelta - expectedDelta),
      `${scenario.name} now matches its oracle — retire the shape pin`
    ).toBeGreaterThan(1e-3);
    return;
  }
  expect(
    observedDelta,
    `${scenario.name}: the edit moved ${observedDelta} mm3, the rebuilt part ${expectedDelta}`
  ).toBeCloseTo(expectedDelta, 3);
}

describe('authored direct-edit scenarios', () => {
  for (const scenario of AUTHORED_SCENARIOS) {
    it(
      scenario.name,
      async () => {
        const fixture = await scenario.build(adapter);
        expect(fixture.name).toBe(scenario.name);
        const result = await replayFixture(adapter, fixture);
        // The recorded observation and the pin list are two statements about
        // the same run; a disagreement means one of them has gone stale.
        expect(fixture.observed.outcome).toBe(result.outcome);
        assertOutcome(fixture, result);
        await assertShape(scenario, result);
      },
      120_000
    );
  }
});

describe('authored replay checks', () => {
  for (const check of AUTHORED_REPLAY_CHECKS) {
    it(
      check.name,
      async () => {
        const result = await check.run(adapter);
        expect(
          result.rejection,
          `${check.name}: ${check.description}`
        ).toBeNull();
        expect(result.volume).toBeCloseTo(result.expectedVolume, 6);
      },
      120_000
    );
  }
});

describe('pin hygiene', () => {
  it('every pin names a fixture the corpus runs', () => {
    const known = new Set([
      ...capturedFiles.map((file) => basename(file, '.json')),
      ...AUTHORED_SCENARIOS.map((scenario) => scenario.name)
    ]);
    expect(REFUSAL_PINS.filter((pin) => !known.has(pin.fixture))).toEqual([]);
    expect(SHAPE_PINS.filter((pin) => !known.has(pin.fixture))).toEqual([]);
  });

  it('every shape pin names a fixture the oracle can judge', () => {
    // A shape pin on a fixture with no oracle would assert nothing.
    const withOracle = new Set(
      AUTHORED_SCENARIOS.filter(
        (scenario) => scenario.expectedVolumeAfter !== undefined
      ).map((scenario) => scenario.name)
    );
    expect(SHAPE_PINS.filter((pin) => !withOracle.has(pin.fixture))).toEqual(
      []
    );
  });
});
