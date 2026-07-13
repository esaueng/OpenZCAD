import { describe, expect, it } from 'vitest';
import { CommandManager, commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { createKernelAdapter } from '@openzcad/kernel-adapter';
import { toUserId, type ProjectDocument, type SketchId } from '@openzcad/shared';
import {
  buildSessionCommand,
  createSession,
  nextFeatureName,
  sessionFields,
  sessionInstruction,
  sessionManipulator,
  sessionPreview,
  setSessionValue,
  sketchOverlays,
  toggleBooleanTarget,
  validateSession,
  type ToolSession
} from '../apps/web/src/lib/session';

const kernel = createKernelAdapter();

function makeDoc(): ProjectDocument {
  return createProjectDocument('Session Test', toUserId('user_test'), 'mm');
}

function withDerived(doc: ProjectDocument): ProjectDocument {
  return { ...doc, derived: kernel.syncDocument(doc) };
}

function startCtx(doc: ProjectDocument) {
  return { doc, selectedBodyIds: [], selectedSketchId: null };
}

describe('tool sessions', () => {
  it('creates a primitive session with valid defaults that commit to a command', () => {
    const doc = makeDoc();
    const session = createSession('primitive', startCtx(doc), { primitiveKind: 'box' });
    expect(validateSession(session, {}).ok).toBe(true);

    const command = buildSessionCommand(session, doc)!;
    expect(command.kind).toBe('primitive.add');
    const manager = new CommandManager(doc);
    const next = manager.execute(command);
    expect(next.featureOrder.length).toBe(1);
    expect(manager.canUndo).toBe(true);
    // A cancelled command never touches the document; undo restores exactly.
    expect(manager.undo()).toEqual(doc);
  });

  it('flags invalid and non-positive dimensions with inline field errors', () => {
    const doc = makeDoc();
    let session = createSession('primitive', startCtx(doc), { primitiveKind: 'box' });
    session = setSessionValue(session, 'width', '-5');
    let validation = validateSession(session, {});
    expect(validation.ok).toBe(false);
    expect(validation.fieldErrors.width).toMatch(/positive/i);

    session = setSessionValue(session, 'width', 'nope +');
    validation = validateSession(session, {});
    expect(validation.fieldErrors.width).toBeTruthy();
  });

  it('evaluates parameter expressions in session values', () => {
    const doc = makeDoc();
    let session = createSession('primitive', startCtx(doc), { primitiveKind: 'box' });
    session = setSessionValue(session, 'width', 'w * 2');
    expect(validateSession(session, { w: 15 }).ok).toBe(true);
    expect(validateSession(session, {}).ok).toBe(false);
  });

  it('rejects a torus whose tube is larger than its ring', () => {
    const doc = makeDoc();
    let session = createSession('primitive', startCtx(doc), { primitiveKind: 'torus' });
    session = setSessionValue(session, 'minorRadius', '40');
    const validation = validateSession(session, {});
    expect(validation.fieldErrors.minorRadius).toMatch(/smaller/i);
  });

  it('seeds extrude sessions from the selected sketch and previews real plane geometry', () => {
    let doc = makeDoc();
    const manager = new CommandManager(doc);
    doc = manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XZ',
        offset: 0,
        object: { objectKind: 'rectangle', width: 20, height: 10, centerX: 0, centerY: 0 }
      })
    );
    const sketchId = doc.sketchOrder[0]!;

    const session = createSession('extrude', {
      doc,
      selectedBodyIds: [],
      selectedSketchId: sketchId
    }) as Extract<ToolSession, { kind: 'extrude' }>;
    expect(session.sketchId).toBe(sketchId);
    expect(validateSession(session, {}).ok).toBe(true);

    const preview = sessionPreview(session, doc, {});
    expect(preview?.kind).toBe('extrude');
    if (preview?.kind === 'extrude') {
      expect(preview.points.length).toBe(4);
      // XZ plane normal is +Y.
      expect(preview.normal).toEqual({ x: 0, y: 1, z: 0 });
      expect(preview.distance).toBe(24);
    }

    const manipulator = sessionManipulator(session, doc, {}, {});
    expect(manipulator?.kind).toBe('linear-arrow');

    const command = buildSessionCommand(session, doc)!;
    const next = manager.execute(command);
    const derived = kernel.syncDocument(next);
    const body = Object.values(derived.bodyRepresentations)[0]!;
    expect(body.volume).toBeCloseTo(20 * 10 * 24, 5);
  });

  it('requires a sketch before an extrude session can commit', () => {
    const doc = makeDoc();
    const session = createSession('extrude', startCtx(doc));
    const validation = validateSession(session, {});
    expect(validation.ok).toBe(false);
    expect(validation.message).toMatch(/sketch/i);
    expect(buildSessionCommand(session, doc)).toBeNull();
  });

  it('collects boolean targets in pick order and toggles them', () => {
    let doc = makeDoc();
    const manager = new CommandManager(doc);
    doc = manager.execute(
      commandFactories.addPrimitive({
        name: 'A',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      })
    );
    doc = manager.execute(
      commandFactories.addPrimitive({
        name: 'B',
        primitiveKind: 'box',
        dimensions: { width: 10, height: 10, depth: 10 }
      })
    );
    doc = withDerived(doc);
    const [first, second] = doc.bodyOrder;

    let session = createSession('boolean', startCtx(doc), {
      operation: 'subtract'
    }) as Extract<ToolSession, { kind: 'boolean' }>;
    expect(validateSession(session, {}).ok).toBe(false);
    expect(sessionInstruction(session)).toMatch(/keep/i);

    session = toggleBooleanTarget(session, first!) as typeof session;
    session = toggleBooleanTarget(session, second!) as typeof session;
    expect(session.targetBodyIds).toEqual([first, second]);
    expect(validateSession(session, {}).ok).toBe(true);

    // Toggling again removes.
    session = toggleBooleanTarget(session, second!) as typeof session;
    expect(session.targetBodyIds).toEqual([first]);
  });

  it('seeds move sessions from the last live body and previews the transform', () => {
    let doc = makeDoc();
    const manager = new CommandManager(doc);
    doc = manager.execute(
      commandFactories.addPrimitive({
        name: 'A',
        primitiveKind: 'box',
        dimensions: { width: 30, height: 18, depth: 24 }
      })
    );
    doc = withDerived(doc);

    let session = createSession('move', startCtx(doc)) as Extract<ToolSession, { kind: 'move' }>;
    expect(session.targetBodyId).toBe(doc.bodyOrder[0]);

    session = setSessionValue(session, 'tx', '12') as typeof session;
    const preview = sessionPreview(session, doc, {});
    expect(preview?.kind).toBe('move');
    if (preview?.kind === 'move') {
      expect(preview.translation.x).toBe(12);
    }
    const manipulator = sessionManipulator(session, doc, {}, doc.derived.bodyRepresentations);
    expect(manipulator?.kind).toBe('triad');

    const command = buildSessionCommand(session, doc)!;
    expect(command.kind).toBe('feature.transform');
  });

  it('numbers default feature names per kind', () => {
    let doc = makeDoc();
    const manager = new CommandManager(doc);
    expect(nextFeatureName(doc, 'Box')).toBe('Box');
    doc = manager.execute(
      commandFactories.addPrimitive({
        name: 'Box',
        primitiveKind: 'box',
        dimensions: { width: 1, height: 1, depth: 1 }
      })
    );
    expect(nextFeatureName(doc, 'Box')).toBe('Box 2');
  });

  it('exposes HUD fields for every session kind without duplicates', () => {
    const doc = makeDoc();
    const kinds: ToolSession['kind'][] = [
      'primitive',
      'sketch',
      'extrude',
      'revolve',
      'boolean',
      'move'
    ];
    for (const kind of kinds) {
      const fields = sessionFields(createSession(kind, startCtx(doc)));
      const keys = fields.map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('produces pickable world-space sketch overlays', () => {
    let doc = makeDoc();
    const manager = new CommandManager(doc);
    doc = manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XY',
        offset: 5,
        object: { objectKind: 'circle', radius: 10, centerX: 0, centerY: 0 }
      })
    );
    const overlays = sketchOverlays(doc, {});
    expect(overlays.length).toBe(1);
    // XY plane offset runs along +Z.
    expect(overlays[0]!.points.every((point) => Math.abs(point.z - 5) < 1e-9)).toBe(true);
  });

  it('sketch sessions preview a profile on the chosen plane', () => {
    const doc = makeDoc();
    let session = createSession('sketch', startCtx(doc)) as Extract<
      ToolSession,
      { kind: 'sketch' }
    >;
    session = { ...session, plane: 'YZ', shape: 'circle' };
    session = setSessionValue(session, 'offset', '3') as typeof session;
    const preview = sessionPreview(session, doc, {});
    expect(preview?.kind).toBe('profile');
    if (preview?.kind === 'profile') {
      // YZ plane normal is +X, so every preview point sits at x = offset.
      expect(preview.points.every((point) => Math.abs(point.x - 3) < 1e-9)).toBe(true);
    }
    const command = buildSessionCommand(session, doc)!;
    expect(command.kind).toBe('sketch.add');
  });

  it('extrude distance of zero is rejected before commit', () => {
    let doc = makeDoc();
    const manager = new CommandManager(doc);
    doc = manager.execute(
      commandFactories.addSketch({
        name: 'Profile',
        plane: 'XZ',
        offset: 0,
        object: { objectKind: 'rectangle', width: 20, height: 10, centerX: 0, centerY: 0 }
      })
    );
    let session = createSession('extrude', {
      doc,
      selectedBodyIds: [],
      selectedSketchId: doc.sketchOrder[0] as SketchId
    });
    session = setSessionValue(session, 'distance', '0');
    const validation = validateSession(session, {});
    expect(validation.ok).toBe(false);
    expect(validation.fieldErrors.distance).toMatch(/non-zero/i);
  });
});
