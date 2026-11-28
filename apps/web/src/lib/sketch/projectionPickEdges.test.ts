import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  addSketchFeature,
  createProjectDocument,
  findSketch,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { frameForPlaneRef } from '@openzcad/geometry';
import {
  edgeTopologyWitnessHash,
  toBodyId,
  toUserId,
  type BodyRepresentation,
  type EdgeTopology,
  type EdgeTopologyReferenceV5,
  type FeatureId,
  type ProjectDocument,
  type SketchNode,
  type TopologySelection
} from '@openzcad/shared';
import { projectionFromPick } from './projection';
import {
  projectionPickEdges,
  projectionPickProjects,
  projectionRepickAccepts
} from './projectionPickEdges';

/**
 * I01: the Project hover and the Project commit read a pick through one
 * rule, so the hover accepts exactly the picks the click would. Synthetic
 * block topology; the commit is `projectionFromPick`.
 */

const plane = { type: 'canonical', plane: 'XY', offset: 0 } as const;
const basis = frameForPlaneRef(plane, (value) => Number(value));
const bodyId = toBodyId('body_block');

function reference(name: string): EdgeTopologyReferenceV5 {
  const result: EdgeTopologyReferenceV5 = {
    kind: 'edge',
    producingFeatureId: 'feat_block' as FeatureId,
    lineageName: name,
    currentHash: 0,
    witnessVersion: 1,
    witness: {
      curveType: 'LINE',
      length: 1,
      closed: false,
      endpoints: [
        [0, 0, 0],
        [1, 0, 0]
      ],
      midpoint: [0, 0, 0]
    }
  };
  result.currentHash = edgeTopologyWitnessHash(result.witness);
  return result;
}

const line = (
  id: string,
  hash: number,
  from: [number, number, number],
  to: [number, number, number],
  faces: number[],
  extra: Partial<EdgeTopology> = {}
): EdgeTopology => ({
  topologyId: id,
  hash,
  reference: reference(`edge.${id}`),
  curve: { type: 'LINE' },
  adjacentFaceHashes: faces,
  points: [...from, ...to],
  ...extra
});

const TOP = 50;
/** A 4 × 3 top face (hash 50), an edge off it, a riser and a seam. */
const EDGES: EdgeTopology[] = [
  line('a', 1, [0, 0, 5], [4, 0, 5], [TOP, 60]),
  line('b', 2, [4, 0, 5], [4, 3, 5], [TOP, 61]),
  line('c', 3, [4, 3, 5], [0, 3, 5], [TOP, 62]),
  line('d', 4, [0, 3, 5], [0, 0, 5], [TOP, 63]),
  // Off the top face: a bottom edge.
  line('f', 6, [0, 0, 0], [4, 0, 0], [60, 70]),
  // Seen end-on from the XY plane: projects to a point.
  line('riser', 5, [0, 0, 0], [0, 0, 5], [60, 63]),
  line('seam', 7, [2, 0, 5], [2, 3, 5], [TOP], { displayRole: 'seam' })
];

function modelDocument(edges: EdgeTopology[] = EDGES): ProjectDocument {
  const base = addPrimitiveFeature(
    createProjectDocument('Hover', toUserId('user_hover')),
    {
      name: 'Block',
      primitiveKind: 'box',
      dimensions: { width: 4, height: 3, depth: 5 }
    }
  );
  const producer = listFeaturesInOrder(base).at(-1)!.featureId;
  return {
    ...base,
    derived: {
      ...base.derived,
      bodyRepresentations: {
        [bodyId]: {
          bodyId,
          name: 'Block',
          topology: {
            faces: [],
            edges: edges.map((edge) =>
              edge.reference
                ? {
                    ...edge,
                    reference: {
                      ...edge.reference,
                      producingFeatureId: producer
                    }
                  }
                : edge
            )
          }
        } as unknown as BodyRepresentation
      }
    }
  };
}

const edge = (topologyId: string): TopologySelection => {
  const found = EDGES.find((entry) => entry.topologyId === topologyId)!;
  return { bodyId, kind: 'edge', topologyId, hash: found.hash };
};
const topFace: TopologySelection = {
  bodyId,
  kind: 'face',
  topologyId: 'top',
  hash: TOP
};

/** A sketch holding a linked projection of each named edge, in order. */
function sketchFollowing(document: ProjectDocument, ids: string[]) {
  const objects = ids.flatMap(
    (id) =>
      projectionFromPick({
        document,
        sketch: null,
        selection: edge(id),
        basis,
        mode: 'linked',
        construction: false
      }).objects
  );
  const sketched = addSketchFeature(document, {
    name: 'S',
    planeRef: plane,
    objects
  });
  const sketch = findSketch(sketched.document, sketched.sketchId)!;
  return {
    document: sketched.document,
    sketch,
    objectFor: (id: string) => sketch.objectIds[ids.indexOf(id)]!
  };
}

/** What the re-pick commit decides: one object of the object's kind. */
function repickCommits(input: {
  document: ProjectDocument;
  sketch: SketchNode;
  selection: TopologySelection;
  repairing: string;
}): boolean {
  try {
    const { objects } = projectionFromPick({
      ...input,
      basis,
      mode: 'linked',
      construction: false
    });
    return objects.length === 1 && objects[0]!.objectKind === 'line';
  } catch {
    return false;
  }
}

describe('projectionPickEdges', () => {
  it('names one edge, or a face boundary without its seams', () => {
    const ids = (selection: TopologySelection) =>
      projectionPickEdges(EDGES, selection).map((entry) => entry.topologyId);
    expect(ids(edge('b'))).toEqual(['b']);
    expect(ids(topFace)).toEqual(['a', 'b', 'c', 'd']);
    expect(ids({ bodyId, kind: 'edge', topologyId: 'gone' })).toEqual([]);
    expect(ids({ bodyId, kind: 'body' })).toEqual([]);
  });
});

describe('projectionPickProjects', () => {
  const document = modelDocument();
  const projects = (
    selection: TopologySelection,
    mode: 'linked' | 'unlinked' = 'linked',
    sketch: SketchNode | null = null,
    on: ProjectDocument = document
  ) =>
    projectionPickProjects({
      document: on,
      sketch,
      selection,
      basis,
      mode
    });

  it('takes an edge or face that shows on the plane', () => {
    expect(projects(edge('a'))).toBe(true);
    expect(projects(topFace)).toBe(true);
  });

  it('refuses an edge seen end-on, which projects to a point', () => {
    expect(projects(edge('riser'))).toBe(false);
    expect(projects(edge('riser'), 'unlinked')).toBe(false);
  });

  it('refuses a linked pick the sketch already follows, as the click does', () => {
    const { document: on, sketch } = sketchFollowing(document, ['a']);
    expect(projects(edge('a'), 'linked', sketch, on)).toBe(false);
    expect(() =>
      projectionFromPick({
        document: on,
        sketch,
        selection: edge('a'),
        basis,
        mode: 'linked',
        construction: false
      })
    ).toThrow(/already projected linked/);
    // A copy is not a link: unlinked still takes it, and the face still
    // has three edges to add.
    expect(projects(edge('a'), 'unlinked', sketch, on)).toBe(true);
    expect(projects(topFace, 'linked', sketch, on)).toBe(true);
  });

  it('counts an edge whose identity the click would first acquire', () => {
    const unverified = modelDocument(
      EDGES.map((entry) =>
        entry.topologyId === 'a' ? { ...entry, reference: undefined } : entry
      )
    );
    const input = {
      document: unverified,
      sketch: null,
      selection: edge('a'),
      basis,
      mode: 'linked' as const
    };
    // The commit skips it until lineage is published; the click rebuilds
    // with lineage first, which the hover assumes.
    expect(projectionPickProjects(input)).toBe(false);
    expect(projectionPickProjects({ ...input, lineagePending: true })).toBe(
      true
    );
  });
});

describe('projectionRepickAccepts', () => {
  const document = modelDocument();

  it('takes a face whose other boundary edges the sketch already follows', () => {
    // a, b and d are projected linked; the object being repaired follows
    // f, off the face. The face's commit adds only c, so it is accepted.
    const {
      document: on,
      sketch,
      objectFor
    } = sketchFollowing(document, ['a', 'b', 'd', 'f']);
    const input = {
      document: on,
      sketch,
      selection: topFace,
      repairing: objectFor('f')
    };
    expect(repickCommits(input)).toBe(true);
    expect(
      projectionRepickAccepts({ ...input, basis, objectKind: 'line' })
    ).toBe(true);
  });

  it('refuses a face with several edges still to add', () => {
    const {
      document: on,
      sketch,
      objectFor
    } = sketchFollowing(document, ['f']);
    const input = {
      document: on,
      sketch,
      selection: topFace,
      repairing: objectFor('f')
    };
    expect(repickCommits(input)).toBe(false);
    expect(
      projectionRepickAccepts({ ...input, basis, objectKind: 'line' })
    ).toBe(false);
  });

  it('refuses an edge another object already follows', () => {
    const {
      document: on,
      sketch,
      objectFor
    } = sketchFollowing(document, ['a', 'b']);
    const accepts = (selection: TopologySelection, repairing: string) =>
      projectionRepickAccepts({
        document: on,
        sketch,
        selection,
        basis,
        repairing,
        objectKind: 'line'
      });
    // B onto A's edge would leave two lines following one edge.
    expect(accepts(edge('a'), objectFor('b'))).toBe(false);
    // A onto its own edge, or B onto a fresh one, is the repair itself.
    expect(accepts(edge('a'), objectFor('a'))).toBe(true);
    expect(accepts(edge('d'), objectFor('b'))).toBe(true);
  });

  it('refuses a curve of another kind or an edge seen end-on', () => {
    const {
      document: on,
      sketch,
      objectFor
    } = sketchFollowing(document, ['a']);
    const accepts = (
      selection: TopologySelection,
      objectKind: 'line' | 'circle'
    ) =>
      projectionRepickAccepts({
        document: on,
        sketch,
        selection,
        basis,
        repairing: objectFor('a'),
        objectKind
      });
    expect(accepts(edge('d'), 'circle')).toBe(false);
    expect(accepts(edge('riser'), 'line')).toBe(false);
  });

  it('agrees with the re-pick commit on every pick', () => {
    const {
      document: on,
      sketch,
      objectFor
    } = sketchFollowing(document, ['a', 'b', 'f']);
    const picks = [topFace, ...EDGES.map((entry) => edge(entry.topologyId))];
    for (const repaired of ['a', 'b', 'f']) {
      for (const selection of picks) {
        const input = {
          document: on,
          sketch,
          selection,
          repairing: objectFor(repaired)
        };
        expect(
          projectionRepickAccepts({ ...input, basis, objectKind: 'line' }),
          `${repaired} → ${selection.topologyId}`
        ).toBe(repickCommits(input));
      }
    }
  });
});
