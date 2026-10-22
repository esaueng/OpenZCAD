import { describe, expect, it } from 'vitest';
import { toProjectId, toUserId, type SketchObjectData } from '@openzcad/shared';
import { addSketchFeature, createProjectDocument, findSketch } from './index';
import { resolvedSketchDocument } from './sketch-geometry';

function fixture() {
  const added = addSketchFeature(
    createProjectDocument('Solved sketch view', toUserId('user_geometry_view')),
    {
      name: 'Outline',
      plane: 'XY',
      objects: [
        { objectKind: 'line', x1: 0, y1: 0, x2: '20', y2: 0 },
        { objectKind: 'circle', centerX: 5, centerY: 5, radius: 2 }
      ]
    }
  );
  const [lineId, circleId] = findSketch(
    added.document,
    added.sketchId
  )!.objectIds;
  const solved: SketchObjectData = {
    objectKind: 'line',
    x1: 0,
    y1: 0,
    x2: 32,
    y2: 0
  };
  const document = {
    ...added.document,
    derived: {
      ...added.document.derived,
      sketchGeometry: {
        projectId: added.document.projectId,
        documentVersion: added.document.version,
        objects: { [lineId!]: solved }
      }
    }
  };
  return { document, lineId: lineId!, circleId: circleId!, solved };
}

describe('resolved sketch read view', () => {
  it('shows solved coordinates without changing authored expressions or history', () => {
    const f = fixture();
    const before = structuredClone(f.document);
    const view = resolvedSketchDocument(f.document);
    expect(view).not.toBe(f.document);
    expect(view.nodes[f.lineId]).toMatchObject({ data: { x2: 32 } });
    expect(f.document.nodes[f.lineId]).toMatchObject({ data: { x2: '20' } });
    expect(view.nodes[f.circleId]).toBe(f.document.nodes[f.circleId]);
    expect(view.commandLog).toBe(f.document.commandLog);
    expect(view.editHistory).toBe(f.document.editHistory);
    expect(f.document).toEqual(before);
    expect(resolvedSketchDocument(f.document)).toBe(view);
    expect(resolvedSketchDocument(view)).toBe(view);
    const line = view.nodes[f.lineId];
    if (line?.kind !== 'sketch-object' || line.data.objectKind !== 'line')
      throw new Error('Expected a solved line.');
    line.data.x2 = 40;
    expect(f.solved).toMatchObject({ x2: 32 });
    expect(f.document.nodes[f.lineId]).toMatchObject({ data: { x2: '20' } });
  });

  it.each(['project', 'version', 'absent'] as const)(
    'ignores an %s-mismatched result',
    (mismatch) => {
      const { document } = fixture();
      if (mismatch === 'project')
        document.derived.sketchGeometry.projectId = toProjectId('proj_other');
      else if (mismatch === 'version') document.version += 1;
      else
        delete (document.derived as Partial<typeof document.derived>)
          .sketchGeometry;
      expect(resolvedSketchDocument(document)).toBe(document);
    }
  );

  it('keeps a history-only document without derived state readable', () => {
    const { document } = fixture();
    delete (document as Partial<typeof document>).derived;
    expect(resolvedSketchDocument(document)).toBe(document);
  });

  it('ignores unknown ids, non-sketch nodes and changed entity kinds', () => {
    const f = fixture();
    f.document.derived.sketchGeometry.objects = {
      missing: f.solved,
      [f.document.rootNodeId]: f.solved,
      [f.circleId]: f.solved
    };
    expect(resolvedSketchDocument(f.document)).toBe(f.document);
  });

  it('replaces a cached view when the same document receives a new geometry channel', () => {
    const f = fixture();
    const before = resolvedSketchDocument(f.document);
    f.document.derived = {
      ...f.document.derived,
      sketchGeometry: {
        ...f.document.derived.sketchGeometry,
        objects: {
          [f.lineId]: { objectKind: 'line', x1: 0, y1: 0, x2: 36, y2: 0 }
        }
      }
    };
    const after = resolvedSketchDocument(f.document);
    expect(after).not.toBe(before);
    expect(before.nodes[f.lineId]).toMatchObject({ data: { x2: 32 } });
    expect(after.nodes[f.lineId]).toMatchObject({ data: { x2: 36 } });
    expect(f.document.nodes[f.lineId]).toMatchObject({ data: { x2: '20' } });
  });
});
