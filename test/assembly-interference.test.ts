import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import {
  assemblyInterferenceOperands,
  attachDerivedState,
  createProjectDocument,
  sortInterferencePairs,
  summarizeInterference
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import {
  axisAngleQuaternion,
  IDENTITY_PLACEMENT,
  PROJECT_DOCUMENT_SCHEMA_VERSION,
  toUserId,
  type AssemblyInterferencePair,
  type BodyClashVerdict,
  type BodyId,
  type ProjectDocument
} from '@openzcad/shared';

/**
 * AS04: exact pairwise interference between assembly components, posed at
 * their solved pose (never the exploded view), through the same M09 clash
 * query (`exact-body-clash.ts`) every other body clash uses. No schema change:
 * the check is a read-only query and stores nothing.
 */
const owner = toUserId('user_interference');
const allLive = () => true;

let adapter: ExactKernelAdapter;
beforeAll(async () => {
  adapter = await createExactKernelAdapter();
}, 120_000);
afterAll(() => adapter.dispose());

/** Three 10 mm cubes made in place, then placed as components. */
function rig(offsets: { x: number; y: number; z: number }[]) {
  const manager = new CommandManager(createProjectDocument('Rig', owner));
  for (let index = 0; index < offsets.length; index += 1)
    manager.execute(
      commandFactories.addPrimitive({
        name: `Cube ${index + 1}`,
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
  const ids = [...manager.document.bodyOrder] as BodyId[];
  manager.execute(
    commandFactories.addAssemblyComponents({
      components: ids.map((bodyId, index) => ({
        componentId: `comp_${index + 1}`,
        name: `Cube ${index + 1}`,
        bodyId,
        grounded: index === 0,
        placement: { ...IDENTITY_PLACEMENT, translation: offsets[index]! }
      }))
    })
  );
  return manager;
}

async function synced(document: ProjectDocument) {
  return attachDerivedState(document, await adapter.syncDocument(document));
}

async function interference(document: ProjectDocument) {
  const { operands, missing } = assemblyInterferenceOperands(document, allLive);
  const report = await adapter.assemblyInterference(document, operands);
  return { ...report, missing: [...missing, ...report.missing] };
}

function verdictOf(
  pairs: AssemblyInterferencePair[],
  a: string,
  b: string
): BodyClashVerdict {
  const pair = pairs.find((p) => p.a === a && p.b === b);
  if (!pair) throw new Error(`no pair ${a}·${b}`);
  return pair.verdict;
}

describe('AS04 assembly interference', () => {
  it('stores nothing: the document schema is unchanged by the check', () => {
    const document = rig([{ x: 0, y: 0, z: 0 }]).document;
    expect(document.schemaVersion).toBe(PROJECT_DOCUMENT_SCHEMA_VERSION);
    expect(document.assembly?.components).toHaveLength(1);
    expect(Object.keys(document.assembly ?? {})).not.toContain('interference');
  });

  it('measures every pair exactly at the assembled pose, with witnesses', async () => {
    const manager = rig([
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 },
      { x: 30, y: 0, z: 0 }
    ]);
    const document = await synced(manager.document);
    const report = await interference(document);
    expect(report.missing).toEqual([]);
    expect(report.pairs.map((p) => `${p.a}·${p.b}`)).toEqual([
      'comp_1·comp_2',
      'comp_1·comp_3',
      'comp_2·comp_3'
    ]);

    const overlap = verdictOf(report.pairs, 'comp_1', 'comp_2');
    expect(overlap.kind).toBe('interference');
    if (overlap.kind !== 'interference') return;
    expect(overlap.proof).toBe('intersect');
    expect(overlap.volume).toBeCloseTo(500, 6);
    expect(overlap.complete).toBe(true);
    // The shared region is the 5 mm slab both cubes cover, in world space.
    const box = overlap.bounds!;
    expect(box.max.x - box.min.x).toBeCloseTo(5, 9);
    expect(box.max.y - box.min.y).toBeCloseTo(10, 9);
    expect(box.max.z - box.min.z).toBeCloseTo(10, 9);
    const p = overlap.point!;
    expect(p.x).toBeGreaterThan(box.min.x);
    expect(p.x).toBeLessThan(box.max.x);

    expect(verdictOf(report.pairs, 'comp_1', 'comp_3')).toMatchObject({
      kind: 'clear',
      touching: false,
      distance: 20
    });
    expect(verdictOf(report.pairs, 'comp_2', 'comp_3')).toMatchObject({
      kind: 'clear',
      distance: 15
    });
    expect(summarizeInterference(report)).toEqual({
      interfering: 1,
      unknown: 0,
      touching: 0,
      clear: 2,
      missing: 0
    });
  }, 120_000);

  it('ignores the exploded view and reports face contact as touching', async () => {
    const manager = rig([
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 }
    ]);
    // Pull the second cube far out: presentation only, never interference.
    manager.execute(
      commandFactories.setAssemblyExplode(
        { offsets: { comp_2: { x: 0, y: 0, z: 100 } } },
        'Explode'
      )
    );
    const document = await synced(manager.document);
    const { operands } = assemblyInterferenceOperands(document, allLive);
    // The pose matrix carries the placement only.
    expect(operands[1]!.matrix.slice(12, 15)).toEqual([10, 0, 0]);
    const report = await interference(document);
    expect(verdictOf(report.pairs, 'comp_1', 'comp_2')).toMatchObject({
      kind: 'clear',
      touching: true,
      distance: 0
    });
  }, 120_000);

  it('poses a rotated component before checking it', async () => {
    // The box primitive spans [0, 10]³. Placed at x = 15 it clears the first
    // cube by 5; turned a quarter about Z first, (x, y) → (−y, x), it spans
    // x ∈ [5, 15] and shares a 5 × 10 × 10 slab with it.
    const unturned = await interference(
      await synced(
        rig([
          { x: 0, y: 0, z: 0 },
          { x: 15, y: 0, z: 0 }
        ]).document
      )
    );
    expect(verdictOf(unturned.pairs, 'comp_1', 'comp_2')).toMatchObject({
      kind: 'clear',
      distance: 5
    });

    const manager = rig([
      { x: 0, y: 0, z: 0 },
      { x: 15, y: 0, z: 0 }
    ]);
    manager.execute(
      commandFactories.updateAssemblyComponent({
        componentId: 'comp_2',
        placement: {
          translation: { x: 15, y: 0, z: 0 },
          rotation: axisAngleQuaternion({ x: 0, y: 0, z: 1 }, Math.PI / 2)
        }
      })
    );
    const turned = await interference(await synced(manager.document));
    const verdict = verdictOf(turned.pairs, 'comp_1', 'comp_2');
    expect(verdict.kind).toBe('interference');
    if (verdict.kind !== 'interference') return;
    expect(verdict.volume).toBeCloseTo(500, 6);
    expect(verdict.bounds!.min.x).toBeCloseTo(5, 9);
    expect(verdict.bounds!.max.x).toBeCloseTo(10, 9);
  }, 120_000);

  it('reports a component whose body is gone as missing, never as clear', async () => {
    const manager = rig([
      { x: 0, y: 0, z: 0 },
      { x: 5, y: 0, z: 0 }
    ]);
    const document = await synced(manager.document);
    const gone = structuredClone(document);
    gone.assembly!.components[1]!.bodyId = 'body_gone' as BodyId;
    const report = await interference(gone);
    expect(report.missing).toEqual(['comp_2']);
    expect(report.pairs).toEqual([]);
    expect(summarizeInterference(report).missing).toBe(1);
  }, 120_000);
});

describe('interference ordering', () => {
  const pair = (a: string, verdict: BodyClashVerdict) => ({
    a,
    b: 'z',
    verdict
  });
  const clear: BodyClashVerdict = {
    kind: 'clear',
    touching: false,
    distance: 1,
    closest: null,
    atLeast: 1
  };
  const touching: BodyClashVerdict = { ...clear, touching: true, distance: 0 };
  const unknown: BodyClashVerdict = {
    kind: 'unknown',
    reason: 'exact_only_unattainable',
    message: 'declined'
  };
  const overlap = (volume: number | null): BodyClashVerdict => ({
    kind: 'interference',
    volume,
    proof: volume === null ? 'point' : 'intersect',
    point: null,
    bounds: null,
    complete: volume !== null
  });

  it('leads with the largest overlap, then unknowns, contact and clear', () => {
    const sorted = sortInterferencePairs([
      pair('clear', clear),
      pair('touch', touching),
      pair('small', overlap(1)),
      pair('unknown', unknown),
      pair('unmeasured', overlap(null)),
      pair('large', overlap(9))
    ]);
    expect(sorted.map((p) => p.a)).toEqual([
      'large',
      'small',
      'unmeasured',
      'unknown',
      'touch',
      'clear'
    ]);
  });

  it('returns nothing to check without an assembly', () => {
    const document = createProjectDocument('Empty', owner);
    expect(assemblyInterferenceOperands(document, allLive)).toEqual({
      operands: [],
      missing: []
    });
  });
});
