import {
  CommandManager,
  commandFactories,
  type AnyCommand
} from '@openzcad/command-system';
import {
  attachDerivedState,
  createBodyFeatureIds,
  createCheckpoint,
  createParameterIds,
  createProjectDocument,
  createSketchFeatureIds,
  type BodyFeatureIds,
  type SketchFeatureIds
} from '@openzcad/document-core';
import {
  toUserId,
  type DerivedState,
  type EdgeTopology,
  type EdgeTopologyReferenceV5,
  type ProjectDocument,
  type UserId
} from '@openzcad/shared';
import {
  DEMO_DEFINITIONS,
  VISUAL_SELECTION_ACCEPTANCE_DEMO,
  type DemoDefinition
} from './demoDefinitions';

export {
  DEMO_DEFINITIONS,
  VISUAL_SELECTION_ACCEPTANCE_DEMO,
  type DemoDefinition
};

/**
 * Design revision demos: three seeded projects that each tell a three-stage
 * design story (Rev A → Rev B → Rev C) through real parametric feature
 * history. Demos are built with ordinary commands, so every feature remains
 * editable, replayable, and undoable — and the finishing stages (fillet /
 * chamfer) reference exact edge hashes resolved through a live kernel sync,
 * exactly like an interactive edge pick.
 */

export type ExactSyncFn = (document: ProjectDocument) => Promise<DerivedState>;

/**
 * A seeded demo: the finished document plus the document as it stood at each
 * of its checkpoints, so every revision the launcher promises can be stored
 * as a save state and restored (ZCAD-002). Only the final document carries
 * derived state.
 */
export interface DemoSeed {
  document: ProjectDocument;
  saveStates: ProjectDocument[];
}

class DemoBuilder {
  private readonly manager: CommandManager;
  private readonly saveStates: ProjectDocument[] = [];

  constructor(name: string, ownerUserId: UserId) {
    this.manager = new CommandManager(
      createProjectDocument(name, ownerUserId, 'mm')
    );
    // A new document is born with its "Initial document" checkpoint.
    this.saveStates.push(this.manager.document);
  }

  get document(): ProjectDocument {
    return this.manager.document;
  }

  /** One durable revision per design stage. */
  stage(label: string, checkpoint: string, commands: AnyCommand[]) {
    this.manager.runTransaction(label, commands);
    this.manager.document = createCheckpoint(this.manager.document, checkpoint);
    this.saveStates.push(this.manager.document);
  }

  finish(derived: DerivedState): DemoSeed {
    return {
      document: attachDerivedState(this.manager.document, derived),
      saveStates: [...this.saveStates]
    };
  }
}

function params(values: Record<string, number>): AnyCommand[] {
  return Object.entries(values).map(([name, value]) =>
    commandFactories.setParameter({
      name,
      expression: String(value),
      ids: createParameterIds()
    })
  );
}

interface P3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Exact edge hashes whose sampled points all satisfy the spatial predicate.
 * Straight edges sample only their endpoints, so `edgeSpan` additionally
 * constrains the edge's bounding box — the only reliable way to keep long
 * perimeter edges out of a corner pick.
 */
function pickEdgeHashes(
  derived: DerivedState,
  bodyId: BodyFeatureIds['bodyId'],
  predicate: (p: P3) => boolean,
  edgeSpan?: (span: P3) => boolean
): number[] {
  return pickEdges(derived, bodyId, predicate, edgeSpan).map(
    (edge) => edge.hash
  );
}

/** The exact edges themselves, for a pick that also needs their lineage. */
function pickEdges(
  derived: DerivedState,
  bodyId: BodyFeatureIds['bodyId'],
  predicate: (p: P3) => boolean,
  edgeSpan?: (span: P3) => boolean
): EdgeTopology[] {
  const representation = derived.bodyRepresentations[bodyId];
  const picked: EdgeTopology[] = [];
  for (const edge of representation?.topology?.edges ?? []) {
    let all = true;
    const min: P3 = { x: Infinity, y: Infinity, z: Infinity };
    const max: P3 = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (let index = 0; index < edge.points.length; index += 3) {
      const x = edge.points[index]!;
      const y = edge.points[index + 1]!;
      const z = edge.points[index + 2]!;
      min.x = Math.min(min.x, x);
      min.y = Math.min(min.y, y);
      min.z = Math.min(min.z, z);
      max.x = Math.max(max.x, x);
      max.y = Math.max(max.y, y);
      max.z = Math.max(max.z, z);
      if (!predicate({ x, y, z })) {
        all = false;
        break;
      }
    }
    if (
      all &&
      edgeSpan &&
      !edgeSpan({
        x: max.x - min.x,
        y: max.y - min.y,
        z: max.z - min.z
      })
    ) {
      all = false;
    }
    if (all) {
      picked.push(edge);
    }
  }
  return picked;
}

/**
 * A pick every edge of which carries a lineage reference, so the feature it
 * seeds survives a parameter tweak. Throws otherwise: a demo that silently
 * fell back to hashes would break again the way ZCAD-001 did.
 */
function requireReferencedEdges(
  edges: EdgeTopology[],
  what: string,
  expected?: { count?: number; min?: number }
): { hashes: number[]; references: EdgeTopologyReferenceV5[] } {
  requireHashes(
    edges.map((edge) => edge.hash),
    what,
    expected
  );
  const references: EdgeTopologyReferenceV5[] = [];
  for (const edge of edges) {
    if (!edge.reference) {
      throw new Error(
        `Demo seeding picked an edge without a lineage reference for ${what}.`
      );
    }
    references.push(edge.reference);
  }
  return { hashes: edges.map((edge) => edge.hash), references };
}

function requireHashes(
  hashes: number[],
  what: string,
  expected?: { count?: number; min?: number }
): number[] {
  if (hashes.length === 0) {
    throw new Error(`Demo seeding found no exact edges for ${what}.`);
  }
  if (expected?.count !== undefined && hashes.length !== expected.count) {
    throw new Error(
      `Demo seeding expected ${expected.count} exact edges for ${what}, found ${hashes.length}.`
    );
  }
  if (expected?.min !== undefined && hashes.length < expected.min) {
    throw new Error(
      `Demo seeding expected at least ${expected.min} exact edges for ${what}, found ${hashes.length}.`
    );
  }
  return hashes;
}

const near = (value: number, target: number, tolerance = 0.75) =>
  Math.abs(value - target) <= tolerance;

// ---------------------------------------------------------------------------
// Demo 1 — Mounting Bracket (the workspace concept part)
// ---------------------------------------------------------------------------

async function buildBracket(
  definition: DemoDefinition,
  ownerUserId: UserId,
  syncExact: ExactSyncFn
): Promise<DemoSeed> {
  const builder = new DemoBuilder(definition.name, ownerUserId);

  builder.stage('Define parameters', 'Parameters', [
    ...params({
      width: 80,
      depth: 40,
      plate_t: 8,
      wall_h: 32,
      boss_r: 10,
      hole_r: 4,
      mount_r: 3,
      mount_inset: 16,
      fillet_r: 3
    })
  ]);

  const base = createBodyFeatureIds();
  const wall = createBodyFeatureIds();
  const unionL = createBodyFeatureIds();
  builder.stage('Rev A — L-bracket blank', 'Rev A — L-bracket blank', [
    commandFactories.addPrimitive({
      name: 'Base plate',
      primitiveKind: 'box',
      dimensions: { width: 'width', height: 'depth', depth: 'plate_t' },
      ids: base
    }),
    commandFactories.addPrimitive({
      name: 'Wall plate',
      primitiveKind: 'box',
      dimensions: { width: 'width', height: 'plate_t', depth: 'wall_h' },
      ids: wall
    }),
    commandFactories.transformBody({
      name: 'Seat wall on base',
      targetBodyId: wall.bodyId,
      translation: { x: 0, y: 'depth - plate_t', z: 'plate_t - 0.5' }
    }),
    commandFactories.booleanBodies({
      name: 'Union L bracket',
      operation: 'union',
      targetBodyIds: [base.bodyId, wall.bodyId],
      ids: unionL
    })
  ]);

  const boss = createBodyFeatureIds();
  const unionBoss = createBodyFeatureIds();
  const bore = createBodyFeatureIds();
  const cutBore = createBodyFeatureIds();
  const mountA = createBodyFeatureIds();
  const mountB = createBodyFeatureIds();
  const cutMountA = createBodyFeatureIds();
  const cutMounts = createBodyFeatureIds();
  builder.stage('Rev B — Boss + mounting holes', 'Rev B — Boss + holes', [
    commandFactories.addPrimitive({
      name: 'Boss',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'boss_r', height: 'plate_t + 4' },
      ids: boss
    }),
    commandFactories.transformBody({
      name: 'Place boss on wall',
      targetBodyId: boss.bodyId,
      rotationDeg: { x: 90, y: 0, z: 0 },
      translation: {
        x: 'width / 2',
        y: 'depth - plate_t + 2',
        z: 'plate_t + wall_h / 2'
      }
    }),
    commandFactories.booleanBodies({
      name: 'Union boss',
      operation: 'union',
      targetBodyIds: [unionL.bodyId, boss.bodyId],
      ids: unionBoss
    }),
    commandFactories.addPrimitive({
      name: 'Boss bore tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'hole_r', height: 'wall_h + 16' },
      ids: bore
    }),
    commandFactories.transformBody({
      name: 'Aim bore through boss',
      targetBodyId: bore.bodyId,
      rotationDeg: { x: 90, y: 0, z: 0 },
      translation: {
        x: 'width / 2',
        y: 'depth + 8',
        z: 'plate_t + wall_h / 2'
      }
    }),
    commandFactories.booleanBodies({
      name: 'Boss bore',
      operation: 'subtract',
      targetBodyIds: [unionBoss.bodyId, bore.bodyId],
      ids: cutBore
    }),
    commandFactories.addPrimitive({
      name: 'Mount hole L',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'mount_r', height: 'plate_t + 4' },
      ids: mountA
    }),
    commandFactories.transformBody({
      name: 'Place mount hole L',
      targetBodyId: mountA.bodyId,
      translation: { x: 'mount_inset', y: 'depth / 2', z: -2 }
    }),
    commandFactories.addPrimitive({
      name: 'Mount hole R',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'mount_r', height: 'plate_t + 4' },
      ids: mountB
    }),
    commandFactories.transformBody({
      name: 'Place mount hole R',
      targetBodyId: mountB.bodyId,
      translation: { x: 'width - mount_inset', y: 'depth / 2', z: -2 }
    }),
    // One tool per subtract: a multi-tool boolean publishes no lineage for
    // its result, and Rev C's fillet needs edges it can find again after a
    // parameter tweak.
    commandFactories.booleanBodies({
      name: 'Mount hole L cut',
      operation: 'subtract',
      targetBodyIds: [cutBore.bodyId, mountA.bodyId],
      ids: cutMountA
    }),
    commandFactories.booleanBodies({
      name: 'Mounting holes',
      operation: 'subtract',
      targetBodyIds: [cutMountA.bodyId, mountB.bodyId],
      ids: cutMounts
    })
  ]);

  // Rev C breaks the wall's two long top edges. They are picked by lineage
  // reference, not by hash alone: a hash encodes the edge's position, so a
  // hash-only pick stopped resolving the moment `width` or `depth` moved
  // (ZCAD-001), while a reference follows the edge through the rebuild. The
  // base corners cannot be picked this way yet — the unions publish no
  // lineage for them — so the edge break moved to edges that carry one.
  const revBDerived = await syncExact(builder.document);
  const wallTop = requireReferencedEdges(
    pickEdges(
      revBDerived,
      cutMounts.bodyId,
      (p) => (near(p.y, 32) || near(p.y, 40)) && near(p.z, 39.5),
      (span) => span.x >= 70 && span.y <= 0.1 && span.z <= 0.1
    ),
    'wall top edges',
    { count: 2 }
  );

  const fillet = createBodyFeatureIds();
  builder.stage('Rev C — Edge break fillet', 'Rev C — Edge break fillet', [
    commandFactories.filletEdges({
      name: 'Wall top edge break',
      targetBodyId: cutMounts.bodyId,
      edgeHashes: wallTop.hashes,
      edgeReferences: wallTop.references,
      size: 'fillet_r',
      ids: fillet
    }),
    commandFactories.renameNode({
      nodeId: fillet.bodyNodeId,
      name: 'Mounting Bracket'
    }),
    commandFactories.setNodeMetadata(
      {
        nodeId: fillet.bodyNodeId,
        metadata: { color: '#e1a948' }
      },
      'Bracket gold finish'
    )
  ]);

  return builder.finish(await syncExact(builder.document));
}

// ---------------------------------------------------------------------------
// E2E reference — boss + through-bore + one finished and one sharp rim
// ---------------------------------------------------------------------------

async function buildVisualSelectionAcceptance(
  definition: DemoDefinition,
  ownerUserId: UserId,
  syncExact: ExactSyncFn
): Promise<DemoSeed> {
  const builder = new DemoBuilder(definition.name, ownerUserId);

  builder.stage('Define parameters', 'Parameters', [
    ...params({ boss_r: 15, bore_r: 10, boss_h: 10, fillet_r: 2 })
  ]);

  const boss = createBodyFeatureIds();
  builder.stage('Rev A — Boss blank', 'Rev A — Boss blank', [
    commandFactories.addPrimitive({
      name: 'Boss',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'boss_r', height: 'boss_h' },
      ids: boss
    })
  ]);

  const bore = createBodyFeatureIds();
  const boredBoss = createBodyFeatureIds();
  builder.stage('Rev B — Through-bore', 'Rev B — Through-bore', [
    commandFactories.addPrimitive({
      name: 'Bore tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'bore_r', height: 'boss_h + 4' },
      ids: bore
    }),
    commandFactories.transformBody({
      name: 'Pass bore through boss',
      targetBodyId: bore.bodyId,
      translation: { x: 0, y: 0, z: -2 }
    }),
    commandFactories.booleanBodies({
      name: 'Bored boss',
      operation: 'subtract',
      targetBodyIds: [boss.bodyId, bore.bodyId],
      ids: boredBoss
    })
  ]);

  const revBDerived = await syncExact(builder.document);
  const outerRims = (
    revBDerived.bodyRepresentations[boredBoss.bodyId]?.topology?.edges ?? []
  )
    .filter(
      (edge) =>
        edge.displayRole !== 'seam' &&
        edge.curve?.type === 'CIRCLE' &&
        near(edge.curve.circle?.radius ?? 0, 15, 1e-6)
    )
    .sort(
      (left, right) =>
        (left.curve?.circle?.center.z ?? 0) -
        (right.curve?.circle?.center.z ?? 0)
    );
  const lowerOuterRim = requireHashes(
    outerRims.slice(0, 1).map((edge) => edge.hash),
    'lower outer boss rim',
    { count: 1 }
  );

  const fillet = createBodyFeatureIds();
  builder.stage('Rev C — Lower rim fillet', 'Rev C — Lower rim fillet', [
    commandFactories.filletEdges({
      name: 'Lower rim fillet',
      targetBodyId: boredBoss.bodyId,
      edgeHashes: lowerOuterRim,
      ...(outerRims[0]?.reference
        ? { edgeReferences: [outerRims[0].reference] }
        : {}),
      size: 'fillet_r',
      ids: fillet
    }),
    commandFactories.renameNode({
      nodeId: fillet.bodyNodeId,
      name: 'Visual Selection Reference'
    }),
    commandFactories.setNodeMetadata(
      {
        nodeId: fillet.bodyNodeId,
        metadata: { color: '#e1a948' }
      },
      'Reference part gold finish'
    )
  ]);

  return builder.finish(await syncExact(builder.document));
}

// ---------------------------------------------------------------------------
// Demo 2 — Pipe Flange (revolve + circular pattern)
// ---------------------------------------------------------------------------

async function buildFlange(
  definition: DemoDefinition,
  ownerUserId: UserId,
  syncExact: ExactSyncFn
): Promise<DemoSeed> {
  const builder = new DemoBuilder(definition.name, ownerUserId);

  builder.stage('Define parameters', 'Parameters', [
    ...params({
      rim_r: 45,
      hub_r: 24,
      bore_r: 12,
      rim_t: 10,
      hub_h: 26,
      bolt_r: 3,
      bolt_circle: 34,
      bolt_count: 6,
      chamfer_d: 1.5
    })
  ]);

  const rimSketch: SketchFeatureIds = createSketchFeatureIds();
  const rim = createBodyFeatureIds();
  const hubSketch: SketchFeatureIds = createSketchFeatureIds();
  const hub = createBodyFeatureIds();
  const blank = createBodyFeatureIds();
  builder.stage('Rev A — Revolved blank', 'Rev A — Revolved blank', [
    commandFactories.addSketch({
      name: 'Rim profile',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 'rim_r - hub_r',
        height: 'rim_t',
        centerX: '(rim_r + hub_r) / 2',
        centerY: 'rim_t / -2'
      },
      ids: rimSketch
    }),
    commandFactories.revolveSketch({
      name: 'Revolve rim',
      sketchId: rimSketch.sketchId,
      axis: 'vertical',
      ids: rim
    }),
    commandFactories.addSketch({
      name: 'Hub profile',
      plane: 'XZ',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 'hub_r - bore_r',
        height: 'hub_h',
        centerX: '(hub_r + bore_r) / 2',
        centerY: 'hub_h / -2'
      },
      ids: hubSketch
    }),
    commandFactories.revolveSketch({
      name: 'Revolve hub',
      sketchId: hubSketch.sketchId,
      axis: 'vertical',
      ids: hub
    }),
    commandFactories.booleanBodies({
      name: 'Union flange blank',
      operation: 'union',
      targetBodyIds: [rim.bodyId, hub.bodyId],
      ids: blank
    })
  ]);

  const bolt = createBodyFeatureIds();
  const boltCircle = createBodyFeatureIds();
  const drilled = createBodyFeatureIds();
  builder.stage('Rev B — Bolt circle', 'Rev B — Bolt circle', [
    commandFactories.addPrimitive({
      name: 'Bolt hole tool',
      primitiveKind: 'cylinder',
      dimensions: { radius: 'bolt_r', height: 'rim_t + 6' },
      ids: bolt
    }),
    commandFactories.transformBody({
      name: 'Place bolt hole',
      targetBodyId: bolt.bodyId,
      translation: { x: 'bolt_circle', y: 0, z: -3 }
    }),
    commandFactories.patternBody({
      name: 'Bolt circle',
      targetBodyId: bolt.bodyId,
      patternKind: 'circular',
      count: 'bolt_count',
      axis: 'z',
      angleDeg: 360,
      ids: boltCircle
    }),
    commandFactories.booleanBodies({
      name: 'Drill bolt circle',
      operation: 'subtract',
      targetBodyIds: [blank.bodyId, boltCircle.bodyId],
      ids: drilled
    })
  ]);

  const revBDerived = await syncExact(builder.document);
  // The three edges wanted here are all circles lying flat in a Z plane: the
  // rim's top and bottom rims (r=45) and the hub lip (r=24, z=26). The radial
  // predicate alone also matches the r=45 cylinder's vertical SEAM, which runs
  // z=0→10 at the same radius and is not a design edge at all. Pinning the Z
  // span to zero is what separates them — and it only started mattering once
  // the kernel returned an analytic blank, because a tessellated rim has no
  // seam edge to pick up.
  const rimHashes = requireHashes(
    pickEdgeHashes(
      revBDerived,
      drilled.bodyId,
      (p) => {
        const radial = Math.hypot(p.x, p.y);
        return near(radial, 45) || (near(radial, 24) && p.z >= 25.5);
      },
      (span) => span.z <= 0.5
    ),
    'rim + hub lip',
    { count: 3 }
  );

  const chamfer = createBodyFeatureIds();
  builder.stage('Rev C — Rim chamfer', 'Rev C — Rim chamfer', [
    commandFactories.chamferEdges({
      name: 'Rim chamfer',
      targetBodyId: drilled.bodyId,
      edgeHashes: rimHashes,
      size: 'chamfer_d',
      ids: chamfer
    }),
    commandFactories.renameNode({
      nodeId: chamfer.bodyNodeId,
      name: 'Pipe Flange'
    }),
    commandFactories.setNodeMetadata(
      {
        nodeId: chamfer.bodyNodeId,
        metadata: { color: '#e1a948' }
      },
      'Flange gold finish'
    )
  ]);

  return builder.finish(await syncExact(builder.document));
}

// ---------------------------------------------------------------------------
// Demo 3 — Heat Sink (sketch extrude + linear pattern)
// ---------------------------------------------------------------------------

async function buildHeatSink(
  definition: DemoDefinition,
  ownerUserId: UserId,
  syncExact: ExactSyncFn
): Promise<DemoSeed> {
  const builder = new DemoBuilder(definition.name, ownerUserId);

  builder.stage('Define parameters', 'Parameters', [
    ...params({
      base_w: 90,
      base_d: 60,
      base_t: 6,
      fin_t: 3,
      fin_h: 22,
      fin_count: 8,
      fin_spacing: 11,
      fillet_r: 2.5
    })
  ]);

  const baseSketch: SketchFeatureIds = createSketchFeatureIds();
  const base = createBodyFeatureIds();
  builder.stage('Rev A — Base extrusion', 'Rev A — Base extrusion', [
    commandFactories.addSketch({
      name: 'Base profile',
      plane: 'XY',
      offset: 0,
      object: {
        objectKind: 'rectangle',
        width: 'base_w',
        height: 'base_d',
        centerX: 'base_w / 2',
        centerY: 'base_d / 2'
      },
      ids: baseSketch
    }),
    commandFactories.extrudeSketch({
      name: 'Extrude base',
      sketchId: baseSketch.sketchId,
      distance: 'base_t',
      ids: base
    })
  ]);

  const fin = createBodyFeatureIds();
  const finField = createBodyFeatureIds();
  const sink = createBodyFeatureIds();
  builder.stage('Rev B — Fin field', 'Rev B — Fin field', [
    commandFactories.addPrimitive({
      name: 'Fin',
      primitiveKind: 'box',
      dimensions: { width: 'fin_t', height: 'base_d', depth: 'fin_h' },
      ids: fin
    }),
    commandFactories.transformBody({
      name: 'Seat first fin',
      targetBodyId: fin.bodyId,
      translation: { x: 4, y: 0, z: 'base_t - 0.5' }
    }),
    commandFactories.patternBody({
      name: 'Fin field',
      targetBodyId: fin.bodyId,
      patternKind: 'linear',
      count: 'fin_count',
      axis: 'x',
      spacing: 'fin_spacing',
      ids: finField
    }),
    commandFactories.booleanBodies({
      name: 'Union fin field',
      operation: 'union',
      targetBodyIds: [base.bodyId, finField.bodyId],
      ids: sink
    })
  ]);

  const revBDerived = await syncExact(builder.document);
  // The four vertical base corners: the span filter keeps tangent rim and
  // fin-seat edges out of the pick (a fillet across those fails the kernel).
  const cornerHashes = requireHashes(
    pickEdgeHashes(
      revBDerived,
      sink.bodyId,
      (p) =>
        (near(p.x, 0) || near(p.x, 90)) &&
        (near(p.y, 0) || near(p.y, 60)) &&
        p.z >= -0.1 &&
        p.z <= 6.1,
      (span) => span.x < 0.01 && span.y < 0.01 && span.z > 4
    ),
    'base corners'
  );

  const fillet = createBodyFeatureIds();
  builder.stage('Rev C — Corner fillets', 'Rev C — Corner fillets', [
    commandFactories.filletEdges({
      name: 'Base corner fillets',
      targetBodyId: sink.bodyId,
      edgeHashes: cornerHashes,
      size: 'fillet_r',
      ids: fillet
    }),
    commandFactories.renameNode({
      nodeId: fillet.bodyNodeId,
      name: 'Heat Sink'
    }),
    commandFactories.setNodeMetadata(
      {
        nodeId: fillet.bodyNodeId,
        metadata: { color: '#e1a948' }
      },
      'Heat sink gold finish'
    )
  ]);

  return builder.finish(await syncExact(builder.document));
}

const DEMO_BUILDERS: Record<
  string,
  (
    definition: DemoDefinition,
    ownerUserId: UserId,
    syncExact: ExactSyncFn
  ) => Promise<DemoSeed>
> = {
  bracket: buildBracket,
  flange: buildFlange,
  heatsink: buildHeatSink,
  'visual-selection-acceptance': buildVisualSelectionAcceptance
};

/**
 * Builds (or rebuilds) a demo document. The demo's project id is
 * deterministic, so re-seeding after local data was cleared just rebuilds it.
 */
export async function buildDemoDocument(
  definition: DemoDefinition,
  ownerUserId: UserId | undefined,
  syncExact: ExactSyncFn
): Promise<ProjectDocument> {
  return (await buildDemoSeed(definition, ownerUserId, syncExact)).document;
}

export async function buildDemoSeed(
  definition: DemoDefinition,
  ownerUserId: UserId | undefined,
  syncExact: ExactSyncFn
): Promise<DemoSeed> {
  const builder = DEMO_BUILDERS[definition.key];
  if (!builder) {
    throw new Error(`Unknown demo "${definition.key}".`);
  }
  const seed = await builder(
    definition,
    ownerUserId ?? toUserId('user_local_browser'),
    syncExact
  );
  return {
    document: withDemoIdentity(seed.document, definition),
    saveStates: seed.saveStates.map((saveState) =>
      withDemoIdentity(saveState, definition)
    )
  };
}

/**
 * Deterministic identity keeps seeding idempotent and lets the demos live
 * alongside user projects without ever colliding with them. Applied to every
 * save state as well as the final document, so the stored revisions belong to
 * the project they are listed under.
 */
function withDemoIdentity(
  document: ProjectDocument,
  definition: DemoDefinition
): ProjectDocument {
  const rootNode = document.nodes[document.rootNodeId];
  return {
    ...document,
    editHistory: undefined,
    projectId: definition.projectId,
    nodes:
      rootNode?.kind === 'project'
        ? {
            ...document.nodes,
            [document.rootNodeId]: {
              ...rootNode,
              projectId: definition.projectId
            }
          }
        : document.nodes
  };
}
