import { describe, expect, it, vi } from 'vitest';

import {
  createProjectDocument,
  addSketchFeature
} from '@openzcad/document-core';
import { toSketchId, toUserId } from '@openzcad/shared';
import { writeSketchDxf } from './sketchDxf';

/** The sketch-DXF helper next to `writeSectionDxf`: same call shape, no bodies. */
describe('writeSketchDxf', () => {
  it('exports the named sketch with no bodies and announces the file', async () => {
    const root = createProjectDocument('Sketch DXF', toUserId('user'));
    const { document, sketchId } = addSketchFeature(root, {
      name: 'Sketch',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    });
    const exportModel = vi.fn(async () => ({ text: '0\r\nEOF\r\n' }));
    const save = vi.fn(async () => true);
    const announced: string[] = [];

    await writeSketchDxf(
      { exportModel } as never,
      document,
      sketchId,
      save,
      'part',
      (message: string) => announced.push(message)
    );

    expect(exportModel).toHaveBeenCalledWith('dxf', document, [], {
      sketchId
    });
    expect(save).toHaveBeenCalledWith('part-sketch.dxf', 'dxf', '0\r\nEOF\r\n');
    expect(announced.at(-1)).toBe('Exported the sketch to part-sketch.dxf.');
  });

  it('announces a cancelled save instead of claiming an export', async () => {
    const root = createProjectDocument('Sketch DXF', toUserId('user'));
    const { document, sketchId } = addSketchFeature(root, {
      name: 'Sketch',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    });
    const exportModel = vi.fn(async () => ({ text: '0\r\nEOF\r\n' }));
    const save = vi.fn(async () => false);
    const announced: string[] = [];

    await writeSketchDxf(
      { exportModel } as never,
      document,
      sketchId,
      save,
      'part',
      (message: string) => announced.push(message)
    );

    expect(announced.at(-1)).toBe('DXF export cancelled.');
  });

  it('surfaces the named refusal instead of writing a file', async () => {
    const root = createProjectDocument('Sketch DXF', toUserId('user'));
    const { document } = addSketchFeature(root, {
      name: 'Sketch',
      plane: 'XY',
      offset: 0,
      object: { objectKind: 'line', x1: 0, y1: 0, x2: 10, y2: 0 }
    });
    const exportModel = async () => {
      throw new Error('unsupported-object: Sketch object ent_1 is text.');
    };
    const save = vi.fn(async () => true);
    const announced: string[] = [];

    await writeSketchDxf(
      { exportModel },
      document,
      toSketchId('sketch_missing'),
      save,
      'part',
      (message: string) => announced.push(message)
    );

    expect(save).not.toHaveBeenCalled();
    expect(announced.at(-1)).toMatch(/unsupported-object/);
  });
});
