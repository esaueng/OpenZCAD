import {
  addPrimitiveFeature,
  createProjectDocument,
  filletEdges,
  gearBody,
  importStepBody,
  patternBody
} from '@openzcad/document-core';
import { toUserId, type ProjectDocument } from '@openzcad/shared';
import type { LookdevScene } from './lookdev-scenes';
import { roundedBlockDocument } from './chamfer-rounded-block';
import { rotationalSleeveStep } from '../support/rotational-sleeve';

/**
 * Heavy curved scenes for the viewport frame-timing probe
 * (test/e2e/perf-frame-timing.spec.ts). The U10 look added per-frame work
 * that scales with curved tessellation — the silhouette candidates of every
 * curved face are drawn each frame — so each scene stresses that from a
 * different side: many small curved faces (the gear), many blend faces
 * meeting at spherical corners (the filleted block), finely tessellated
 * torus fillets on an imported part (the rotational sleeve), and dense doubly curved
 * surfaces up to the candidate cap (the torus and the sphere row). The light
 * rounded block is the everyday baseline.
 */
const owner = toUserId('user_frame_timing');

/** A box with every one of its twelve edges rounded. */
async function filletedBlock(
  adapter: Parameters<LookdevScene['build']>[0]
): Promise<ProjectDocument> {
  const document = addPrimitiveFeature(
    createProjectDocument('Frame timing filleted block', owner),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 60, height: 40, depth: 24 }
    }
  );
  const bodyId = document.bodyOrder.at(-1)!;
  const derived = await adapter.syncDocument(document);
  const edges = derived.bodyRepresentations[bodyId]!.topology!.edges;
  if (edges.length !== 12) throw new Error('Expected a box with 12 edges.');
  return filletEdges(document, {
    name: 'Round every edge',
    targetBodyId: bodyId,
    size: 6,
    edgeHashes: edges.map((edge) => edge.hash),
    edgeReferences: edges.map((edge) => edge.reference!)
  }).document;
}

/** `count` copies of one primitive in a row, as one patterned body. */
function row(
  name: string,
  primitive: Parameters<typeof addPrimitiveFeature>[1],
  count: number,
  spacing: number
): ProjectDocument {
  const document = addPrimitiveFeature(
    createProjectDocument(name, owner),
    primitive
  );
  return patternBody(document, {
    name: 'Row',
    targetBodyId: document.bodyOrder.at(-1)!,
    patternKind: 'linear',
    count,
    axis: 'x',
    spacing
  }).document;
}

export const FRAME_TIMING_SCENES: readonly LookdevScene[] = [
  {
    id: 'rounded-block',
    title: 'Block with a large round and three small rounds (baseline)',
    build: async (adapter) => (await roundedBlockDocument(adapter)).document
  },
  {
    id: 'gear-60t',
    title: 'Spur gear, 60 involute teeth',
    build: async () =>
      gearBody(createProjectDocument('Frame timing gear', owner), {
        name: 'Gear',
        gearType: 'external',
        sizing: 'module',
        pitch: 1.5,
        teeth: 60,
        faceWidth: 20,
        origin: { x: 0, y: 0, z: 0 },
        axis: { x: 0, y: 0, z: 1 }
      }).document
  },
  {
    id: 'filleted-block',
    title: 'Block with all twelve edges filleted',
    build: filletedBlock
  },
  {
    id: 'torus',
    title: 'Torus (about 89k triangles, all curved)',
    build: async () =>
      addPrimitiveFeature(createProjectDocument('Frame timing torus', owner), {
        name: 'Torus',
        primitiveKind: 'torus',
        dimensions: { majorRadius: 20, minorRadius: 7 }
      })
  },
  {
    // Just under MAX_SILHOUETTE_CANDIDATES (150k): the most outline work
    // one body can carry before outlines are skipped.
    id: 'sphere-row',
    title: 'Row of five spheres, one body (about 125k triangles)',
    build: async () =>
      row(
        'Frame timing sphere row',
        { name: 'Sphere', primitiveKind: 'sphere', dimensions: { radius: 9 } },
        5,
        22
      )
  },
  {
    // The e2e rotational-direct-edits part: five torus fillets tessellate
    // into about 59k outline candidates.
    id: 'rotational-sleeve',
    title: 'Imported rotational sleeve with five torus fillets',
    build: async () =>
      importStepBody(createProjectDocument('Frame timing sleeve', owner), {
        name: 'Sleeve',
        sourceName: 'rotational-sleeve.step',
        artifactId: 'sleeve',
        stepText: new TextDecoder().decode(await rotationalSleeveStep())
      }).document
  }
];
