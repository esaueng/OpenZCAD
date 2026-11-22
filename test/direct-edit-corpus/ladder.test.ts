import {
  CommandManager,
  replayCommands,
  type AnyCommand
} from '@openzcad/command-system';
import {
  listFeaturesInOrder,
  withoutDerivedProjection
} from '@openzcad/document-core';
import {
  createExactKernelAdapter,
  type ExactKernelAdapter
} from '@openzcad/kernel-adapter/exact';
import type {
  BodyRepresentation,
  DerivedState,
  ProjectDocument
} from '@openzcad/shared';
import { expect, it } from 'vitest';

import { validatedFeatureRejection } from '../../apps/web/src/lib/featureValidation';
import { GENERIC_REFUSAL } from '../../apps/web/src/lib/refusalLanguage';
import { withCarriedSelections } from '../../apps/web/src/lib/topologyReferenceRepairs';
import {
  inspectTriangleMeshClosure,
  isClosedConsistentlyOrientedMesh
} from '../../packages/kernel-adapter/src/boolean-result-validation';
import {
  DISPLAY_DEFLECTION_HOLD_RATIO,
  displayTessellationForExtents
} from '../../packages/kernel-adapter/src/display-tessellation';
import { refusal, sync } from '../support/combination-matrix';
import {
  LADDER_BOUNDARY_SUCCESSES,
  LADDER_MONOTONIC_FINDINGS,
  LADDER_REFUSAL_PINS
} from './pins';
import {
  PARTS,
  referencePart,
  targets,
  type ReferencePart,
  type Target
} from './reference-parts';

const BUDGET_MS = 30_000;
const INITIAL_CENSUS = {
  A: 'cone,cylinder:12,plane:7,sphere:8,torus:2',
  B: 'cylinder:12,plane:6,sphere:8',
  C: 'cylinder,plane:7,torus',
  D: 'cone:2,cylinder,plane:2'
};

function faceCensus(body: BodyRepresentation): string {
  const counts = new Map<string, number>();
  for (const face of body.topology!.faces) {
    const type = face.geometry!.surfaceType;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => (count === 1 ? type : `${type}:${count}`))
    .join(',');
}

function snapshot(body: BodyRepresentation) {
  return {
    volume: body.volume,
    faces: faceCensus(body),
    edges: body.topology!.edges.length
  };
}

function magnitudes(limit: number | null, span: number): [string, number][] {
  return limit === null
    ? [
        ['0.1', 0.1],
        ['1', 1],
        ['span/4', span / 4],
        ['span/2', span / 2],
        ['span', span],
        ['2span', 2 * span]
      ]
    : [
        ['0.1', 0.1],
        ['1', 1],
        ['L/4', limit / 4],
        ['L/2', limit / 2],
        ['L-0.1', limit - 0.1],
        ['L', limit],
        ['L+0.1', limit + 0.1],
        ['2L', 2 * limit]
      ];
}

function diagnostic(derived: DerivedState, cell: string) {
  const warning = derived.featureWarnings?.find(
    (entry) => entry.kind === 'build-failed' || entry.kind === 'refusal'
  );
  expect(warning, `${cell}: ${refusal(derived, cell)?.evidence}`).toBeDefined();
  const rejected = validatedFeatureRejection({
    featureId: warning!.featureId,
    featureName: warning!.featureName,
    bodyPresent: true,
    documentMoved: false,
    warnings: derived.warnings,
    featureWarnings: derived.featureWarnings!
  });
  expect(warning!.kernelRefusal, cell).toBeDefined();
  expect(rejected?.message, cell).toBeTruthy();
  expect(rejected?.message, cell).not.toBe(GENERIC_REFUSAL);
  const { family, category, code } = warning!.kernelRefusal!;
  return {
    family,
    category,
    code,
    message: rejected!.message,
    detail: rejected!.detail
  };
}

function meshVolume({ vertices, indices }: BodyRepresentation['mesh']): number {
  let sixTimesVolume = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [
      indices[i]! * 3,
      indices[i + 1]! * 3,
      indices[i + 2]! * 3
    ];
    const [ax, ay, az] = [vertices[a]!, vertices[a + 1]!, vertices[a + 2]!];
    const [bx, by, bz] = [vertices[b]!, vertices[b + 1]!, vertices[b + 2]!];
    const [cx, cy, cz] = [vertices[c]!, vertices[c + 1]!, vertices[c + 2]!];
    sixTimesVolume +=
      ax * (by * cz - bz * cy) +
      ay * (bz * cx - bx * cz) +
      az * (bx * cy - by * cx);
  }
  return sixTimesVolume / 6;
}

function volumeTolerance(volume: number) {
  return Math.max(0.05, 1e-6 * Math.abs(volume));
}

function assertExact(body: BodyRepresentation, cell: string) {
  expect(body?.exportableStep, cell).toBe(true);
  const closure = inspectTriangleMeshClosure(
    body.mesh.vertices,
    body.mesh.indices
  );
  expect(
    isClosedConsistentlyOrientedMesh(closure),
    `${cell}: ${JSON.stringify(closure)}`
  ).toBe(true);
  const { min, max } = body.bbox;
  const deflection = displayTessellationForExtents(
    max.x - min.x,
    max.y - min.y,
    max.z - min.z
  ).linearDeflection;
  // The mesh oracle integrates the closed triangle shell. Allow the volume
  // of the display chordal band on curved faces, including the adapter's
  // documented held-deflection range. Planar faces add no chordal error.
  const curvedArea = body.topology!.faces.reduce(
    (sum, { geometry: g }) =>
      sum + (g && g.surfaceType !== 'plane' ? g.area : 0),
    0
  );
  expect(
    Math.abs(meshVolume(body.mesh) - body.volume),
    `${cell}: exact vs mesh volume`
  ).toBeLessThanOrEqual(
    volumeTolerance(body.volume) +
      curvedArea * deflection * DISPLAY_DEFLECTION_HOLD_RATIO
  );
}

function near(
  actual: number,
  expected: number,
  tolerance: number,
  label: string
) {
  expect(Math.abs(actual - expected), label).toBeLessThanOrEqual(tolerance);
}

function assertMovedPlanes(
  base: ReferencePart,
  body: BodyRepresentation,
  target: Target,
  delta: number,
  cell: string
) {
  for (const { geometry: picked } of target.movedPlanes ?? []) {
    const g = picked!;
    const at = g.planeOffset! + delta;
    const moved = body.topology!.faces.find(
      ({ geometry: f }) =>
        f?.normal &&
        g.normal &&
        Math.hypot(
          f.normal.x - g.normal.x,
          f.normal.y - g.normal.y,
          f.normal.z - g.normal.z
        ) < 1e-6 &&
        Math.abs(f.planeOffset! - at) < 1e-6
    );
    expect(moved, `${cell}: missing moved plane at ${at}`).toBeDefined();
    if (target.section !== undefined) {
      near(
        moved!.geometry!.area,
        g.area,
        volumeTolerance(g.area),
        `${cell}: cap area`
      );
      expect(faceCensus(body), cell).toBe(faceCensus(base.body));
    }
  }
  if (target.section !== undefined) {
    // For the chamfered rod, the end is the plane and its incident cone.
    // Match both cones on their exact carriers to establish translation of
    // the chosen end group and confirm that the opposite end stays put.
    const cones = base.body.topology!.faces.filter(
      (face) => face.geometry?.surfaceType === 'cone'
    );
    if (cones.length === 2) {
      const pick = target.movedPlanes![0]!;
      const normal = pick.geometry!.normal!;
      const adjacent = new Set(
        base.body
          .topology!.edges.filter((edge) =>
            edge.adjacentFaceHashes?.includes(pick.hash)
          )
          .flatMap((edge) => edge.adjacentFaceHashes!)
      );
      expect(
        cones.filter((cone) => adjacent.has(cone.hash)),
        cell
      ).toHaveLength(1);
      for (const cone of cones) {
        const shift = adjacent.has(cone.hash) ? delta * normal.z : 0;
        const g = cone.geometry!;
        const translated = body.topology!.faces.find(
          ({ geometry: f }) =>
            f?.surfaceType === 'cone' &&
            Math.hypot(
              f.apex!.x - g.apex!.x,
              f.apex!.y - g.apex!.y,
              f.apex!.z - g.apex!.z - shift
            ) < 1e-6 &&
            Math.abs(f.halfAngle! - g.halfAngle!) < 1e-6
        );
        expect(translated, `${cell}: chamfer carrier`).toBeDefined();
        near(
          translated!.geometry!.area,
          g.area,
          volumeTolerance(g.area),
          `${cell}: chamfer area`
        );
      }
    }
    const expected = base.body.volume + target.section * delta;
    near(
      body.volume,
      expected,
      volumeTolerance(expected),
      `${cell}: constant-section volume`
    );
  }
}

async function checkCell(
  adapter: ExactKernelAdapter,
  replayAdapter: ExactKernelAdapter,
  base: ReferencePart,
  target: Target,
  cell: string,
  delta: number,
  deadline: number
) {
  const session = { adapter, deadline };
  const manager = new CommandManager(base.document);
  const original = structuredClone(withoutDerivedProjection(manager.document));
  const before = snapshot(base.body);
  const preview = async (commands: AnyCommand[]) => {
    const disposable = new CommandManager(base.document);
    for (const command of commands) disposable.execute(command);
    return sync(session, disposable.document, base.bodyId, {
      proposeCarry: true
    });
  };

  const command = target.command(delta);
  const candidate = await preview([command]);
  if (refusal(candidate, cell)) {
    const observed = diagnostic(candidate, cell);
    if (command.kind === 'feature.direct-edit') {
      expect(
        snapshot(candidate.bodyRepresentations[base.bodyId]!),
        cell
      ).toEqual(before);
    }
    expect(withoutDerivedProjection(manager.document), cell).toEqual(original);
    expect(manager.canUndo, cell).toBe(false);
    const kept = await sync(session, manager.document, base.bodyId);
    expect(snapshot(kept.bodyRepresentations[base.bodyId]!), cell).toEqual(
      before
    );
    return { observed };
  }

  const carried = withCarriedSelections(base.document, [command], candidate);
  expect(carried, cell).not.toHaveProperty('refusal');
  if ('refusal' in carried) throw new Error(carried.refusal);
  manager.runTransaction(command.label, carried.commands);
  const body = candidate.bodyRepresentations[base.bodyId]!;
  assertExact(body, cell);
  assertMovedPlanes(base, body, target, delta, cell);
  target.assertShape?.(body, delta);

  const store = (document: ProjectDocument) =>
    JSON.parse(
      JSON.stringify(withoutDerivedProjection(document))
    ) as ProjectDocument;
  const replayed = replayCommands(
    store(base.document),
    store(manager.document).commandLog
  );
  const fresh = await sync(
    { adapter: replayAdapter, deadline },
    replayed,
    base.bodyId
  );
  expect(refusal(fresh, cell), cell).toBeNull();
  expect(snapshot(fresh.bodyRepresentations[base.bodyId]!), cell).toEqual(
    snapshot(body)
  );

  expect(manager.canUndo, cell).toBe(true);
  const undone = await sync(session, manager.undo(), base.bodyId);
  expect(refusal(undone, cell), cell).toBeNull();
  expect(snapshot(undone.bodyRepresentations[base.bodyId]!), cell).toEqual(
    before
  );
  expect(listFeaturesInOrder(manager.document), cell).toHaveLength(
    listFeaturesInOrder(base.document).length
  );
  expect(manager.canRedo, cell).toBe(true);
  const redone = await sync(session, manager.redo(), base.bodyId);
  expect(refusal(redone, cell), cell).toBeNull();
  expect(snapshot(redone.bodyRepresentations[base.bodyId]!), cell).toEqual(
    snapshot(body)
  );

  if (target.rebuildSource) {
    const independent = await target.rebuildSource(replayAdapter, delta);
    near(
      body.volume,
      independent.body.volume,
      volumeTolerance(independent.body.volume),
      `${cell}: independent source volume`
    );
    expect(faceCensus(body), cell).toBe(faceCensus(independent.body));
  }
  if (target.sourceCommand) {
    const sourceCommand = target.sourceCommand(delta);
    const source = await preview([sourceCommand]);
    expect(refusal(source, `${cell}: source-dimension preflight`)).toBeNull();
    const sourceCommit = withCarriedSelections(
      base.document,
      [sourceCommand],
      source
    );
    if ('refusal' in sourceCommit) throw new Error(sourceCommit.refusal);
    const sourceManager = new CommandManager(base.document);
    sourceManager.runTransaction(sourceCommand.label, sourceCommit.commands);
    const sourceRebuilt = await sync(
      { adapter: replayAdapter, deadline },
      sourceManager.document,
      base.bodyId
    );
    expect(
      refusal(sourceRebuilt, `${cell}: source-dimension replay`)
    ).toBeNull();
    const viaSource = sourceRebuilt.bodyRepresentations[base.bodyId]!;
    near(
      body.volume,
      viaSource.volume,
      volumeTolerance(viaSource.volume),
      `${cell}: source resize volume`
    );
    expect(faceCensus(body), cell).toBe(faceCensus(viaSource));
  }
  return {};
}

it.each(PARTS)(
  'qualifies the distance ladder for part %s',
  async (part) => {
    const adapter = await createExactKernelAdapter();
    const replayAdapter = await createExactKernelAdapter();
    try {
      const deadline = Date.now() + BUDGET_MS;
      const base = await referencePart(adapter, part);
      assertExact(base.body, part);
      expect(faceCensus(base.body)).toBe(INITIAL_CENSUS[part]);
      const seenRefusals: string[] = [];
      const boundarySuccesses: string[] = [];
      const violations: { refused: string; built: string }[] = [];
      for (const target of targets(part, base)) {
        for (const sign of [-1, 1]) {
          const limit = sign < 0 ? target.inward : target.outward;
          const refusals: { magnitude: number; cell: string }[] = [];
          for (const [rung, magnitude] of magnitudes(limit, base.span).sort(
            (a, b) => a[1] - b[1]
          )) {
            const delta = sign * magnitude;
            const cell = `${part}/${target.name}/${sign < 0 ? '-' : '+'}${rung}`;
            const label = `${cell} (${delta} mm, L=${limit ?? 'unbounded'})`;
            const { observed } = await checkCell(
              adapter,
              replayAdapter,
              base,
              target,
              label,
              delta,
              deadline
            );
            const pin = LADDER_REFUSAL_PINS.find(
              (entry) => entry.cell === cell
            );
            if (observed) {
              expect(
                pin,
                `${label}: unpinned refusal ${JSON.stringify(observed)}`
              ).toBeDefined();
              expect(observed, label).toMatchObject(pin!.diagnostic);
              refusals.push({ magnitude, cell });
              seenRefusals.push(cell);
            } else {
              expect(
                pin,
                `${label}: a pinned refusal now builds`
              ).toBeUndefined();
              if (limit !== null && magnitude >= limit)
                boundarySuccesses.push(cell);
              for (const earlier of refusals) {
                if (earlier.magnitude < magnitude)
                  violations.push({ refused: earlier.cell, built: cell });
              }
            }
          }
        }
      }
      const belongsToPart = (cell: string) => cell.startsWith(`${part}/`);
      expect(seenRefusals.sort(), 'unused or duplicate refusal pins').toEqual(
        LADDER_REFUSAL_PINS.map((pin) => pin.cell)
          .filter(belongsToPart)
          .sort()
      );
      expect(
        boundarySuccesses.sort(),
        'successes at or beyond the geometric limit'
      ).toEqual(
        LADDER_BOUNDARY_SUCCESSES.map((pin) => pin.cell)
          .filter(belongsToPart)
          .sort()
      );
      expect(
        violations,
        'monotonic limit: a greater magnitude built after a refusal on the same face'
      ).toEqual(
        LADDER_MONOTONIC_FINDINGS.filter((pin) => belongsToPart(pin.built)).map(
          ({ refused, built }) => ({ refused, built })
        )
      );
    } finally {
      replayAdapter.dispose();
      adapter.dispose();
    }
  },
  BUDGET_MS + 5000
);
