import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTextFontProvider, findFontFace } from '@openzcad/geometry';
import {
  MAX_SKETCH_TEXT_OBJECTS,
  type SketchObjectData
} from '@openzcad/shared';
import { parseFontFace } from '../../../../packages/geometry/src/text/loader';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  displayObjectsWithTextBudget,
  objectPolylines
} from './objectPolyline';
import { buildSketchModeRig } from '../components/viewer/sketchModeController';

const label = (id: string, text = 'HI') => ({
  id,
  data: {
    objectKind: 'text' as const,
    text,
    fontFamily: 'open-sans',
    fontStyle: 'regular' as const,
    size: 10,
    x: 0,
    y: 0
  }
});
const circle = {
  id: 'circle',
  data: {
    objectKind: 'circle',
    radius: 4,
    centerX: 0,
    centerY: 0
  } as SketchObjectData
};
const resolve = (value: unknown) => Number(value);

afterEach(() => {
  vi.restoreAllMocks();
  setTextFontProvider(null);
});

describe('bounded viewport text collections', () => {
  it.each([null, 'Project text exceeds the outline limit.'])(
    'refuses all excessive text before glyph work and preserves other polylines (%s)',
    (documentError) => {
      const provider = vi.fn(() => undefined);
      setTextFontProvider(provider);
      const objects = [
        ...Array.from({ length: MAX_SKETCH_TEXT_OBJECTS + 1 }, (_, index) =>
          label(`label-${index}`)
        ),
        circle
      ];
      const drawable = displayObjectsWithTextBudget(objects, documentError);
      expect(drawable).toEqual([circle]);
      expect(
        drawable.flatMap((object) => objectPolylines(object.data, resolve))
      ).toEqual(objectPolylines(circle.data, resolve));
      expect(provider).not.toHaveBeenCalled();
    }
  );

  it('preflights the active sketch rig before constructing outline geometry', () => {
    const provider = vi.fn(() => undefined);
    setTextFontProvider(provider);
    const rig = buildSketchModeRig(
      {
        origin: { x: 0, y: 0, z: 0 },
        normal: { x: 0, y: 0, z: 1 },
        u: { x: 1, y: 0, z: 0 },
        v: { x: 0, y: 1, z: 0 }
      },
      () => ({ width: 800, height: 600 })
    );
    try {
      rig.setObjects(
        [
          ...Array.from({ length: MAX_SKETCH_TEXT_OBJECTS + 1 }, (_, index) =>
            label(`label-${index}`)
          ),
          circle
        ],
        null,
        resolve
      );
      expect(provider).not.toHaveBeenCalled();
      expect(
        rig.group.getObjectByName('sketch-committed')?.children.length
      ).toBeGreaterThan(0);
      rig.setObjects(
        [label('safe'), circle],
        null,
        resolve,
        [],
        [],
        'Project text exceeds the outline limit.'
      );
      expect(provider).not.toHaveBeenCalled();
    } finally {
      rig.dispose();
    }
  });

  it('continues drawing complete normal text using real exact font outlines', async () => {
    const file = findFontFace('open-sans', 'regular')!.face.file;
    const bytes = await readFile(
      path.resolve(process.cwd(), '../../packages/geometry/assets/fonts', file)
    );
    const font = parseFontFace(
      'open-sans',
      'regular',
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    );
    setTextFontProvider(() => font);
    const objects = [label('label'), circle];
    expect(displayObjectsWithTextBudget(objects)).toBe(objects);
    expect(objectPolylines(objects[0]!.data, resolve)).toHaveLength(2);
  });
});
