import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { packageMeshExport } from './meshExportPackage';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('packageMeshExport (I04)', () => {
  it('gives same-named bodies distinct stems, each OBJ naming its own MTL', async () => {
    const result = await packageMeshExport({
      formats: ['obj', 'stl-binary'],
      scopes: [
        { bodyIds: ['a'], stem: 'Part-Pin' },
        { bodyIds: ['b'], stem: 'Part-Pin' }
      ],
      objMaterials: true,
      write: async (format, ids, extra) => {
        if (format === 'obj') {
          const stem = extra.objMaterials!.stem;
          return {
            data: zipSync({
              [`${stem}.obj`]: new TextEncoder().encode(
                `mtllib ${stem}.mtl\no ${ids[0]}\n`
              ),
              [`${stem}.mtl`]: new TextEncoder().encode(`newmtl ${ids[0]}\n`)
            }),
            warnings: []
          };
        }
        return { data: new Uint8Array([1]), warnings: [] };
      }
    });
    const files = unzipSync(result.zip);
    expect(Object.keys(files).sort()).toEqual([
      'Part-Pin 2.mtl',
      'Part-Pin 2.obj',
      'Part-Pin 2.stl',
      'Part-Pin.mtl',
      'Part-Pin.obj',
      'Part-Pin.stl'
    ]);
    expect(text(files['Part-Pin 2.obj']!)).toContain('mtllib Part-Pin 2.mtl');
    expect(text(files['Part-Pin 2.mtl']!)).toContain('newmtl b');
    expect(text(files['Part-Pin.obj']!)).toContain('mtllib Part-Pin.mtl');
  });
});
