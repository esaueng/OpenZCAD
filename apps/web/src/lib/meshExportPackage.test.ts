import { unzipSync, zipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import type { BodyId, ProjectDocument } from '@openzcad/shared';
import { saveCadBinaryFile } from './desktopBridge';
import {
  exportMesh,
  packageMeshExport,
  type MeshExportRequest
} from './meshExportPackage';

vi.mock('./desktopBridge', () => ({
  saveCadBinaryFile: vi.fn(() => Promise.resolve(true)),
  saveCadTextFile: vi.fn(() => Promise.resolve(true))
}));

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

  /**
   * #2369: STL, OBJ and PLY record no unit, so a package that mixes them with
   * a 3MF or a glTF names every file's unit in a manifest of its own.
   */
  it('names each file’s unit in a units manifest', async () => {
    const result = await packageMeshExport({
      formats: ['3mf', 'stl-binary', 'glb', 'obj'],
      scopes: [{ bodyIds: ['a'], stem: 'Part' }],
      objMaterials: true,
      units: 'inch',
      write: async (format, _ids, extra) =>
        format === 'obj'
          ? {
              data: zipSync({
                [`${extra.objMaterials!.stem}.obj`]: new Uint8Array([1]),
                [`${extra.objMaterials!.stem}.mtl`]: new Uint8Array([2])
              }),
              warnings: []
            }
          : { data: new Uint8Array([1]), warnings: [] }
    });
    const files = unzipSync(result.zip);
    expect(result.names).toContain('units.txt');
    expect(text(files['units.txt']!)).toBe(
      [
        'Length units of the files in this package.',
        '',
        'Part.3mf: inches (declared in the file)',
        'Part.stl: inches (not recorded in the file)',
        'Part.glb: meters (the unit glTF defines)',
        'Part.obj: inches (not recorded in the file)',
        ''
      ].join('\n')
    );
  });
});

describe('exportMesh (I04)', () => {
  const STL = {
    extension: 'stl',
    label: 'STL',
    binaryFormat: 'stl' as const
  };

  function request(
    overrides: Partial<MeshExportRequest> = {},
    rowName: string | null = null
  ) {
    const jobs: Parameters<MeshExportRequest['runExportJob']>[0][] = [];
    const statuses: string[] = [];
    const exportModel = vi.fn(() =>
      Promise.resolve({
        data: new Uint8Array([7]),
        warnings: []
      })
    );
    const input: MeshExportRequest = {
      format: 'stl-binary',
      deflection: 0.05,
      options: { angularTolerance: 0.3 },
      target: {
        document: { nodes: {} } as unknown as ProjectDocument,
        bodyIds: ['body_a' as BodyId],
        allShownBodies: false,
        rowName
      },
      info: STL,
      units: 'inch',
      stemOf: (name) => (name ? `Part ${name}` : 'Part'),
      setStatus: (message) => statuses.push(message),
      runExportJob: (job) => {
        jobs.push(job);
        return Promise.resolve();
      },
      exportModel: exportModel as unknown as MeshExportRequest['exportModel'],
      ...overrides
    };
    return { input, jobs, statuses, exportModel };
  }

  it('writes one file of one format as before the packages', async () => {
    const { input, jobs, exportModel } = request();
    exportMesh(input);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job).toMatchObject({
      fileName: 'Part.stl',
      label: 'STL'
    });
    expect(job.completed).toBeUndefined();
    const signal = new AbortController().signal;
    const produced = await job.produce({ signal, onState: () => {} });
    expect(exportModel).toHaveBeenCalledWith(
      'stl-binary',
      input.target.document,
      ['body_a'],
      expect.objectContaining({
        deflection: 0.05,
        angularTolerance: 0.3,
        units: 'inch',
        signal
      })
    );
    const options = (exportModel.mock.calls[0] as unknown[])[3] as object;
    expect(options).not.toHaveProperty('objMaterials');
    expect(options).not.toHaveProperty('allShownBodies');
    await produced.save();
    expect(saveCadBinaryFile).toHaveBeenCalledWith(
      'Part.stl',
      'stl',
      new Uint8Array([7])
    );
  });

  it('names a configuration in the label and the completion status', () => {
    const { input, jobs } = request({}, 'Wide');
    exportMesh(input);
    expect(jobs[0]).toMatchObject({
      fileName: 'Part Wide.stl',
      label: 'STL of Wide'
    });
    expect(jobs[0]!.completed!('')).toBe(
      'Exported configuration Wide to Part Wide.stl.'
    );
  });

  it('packages more formats as one ZIP', () => {
    const { input, jobs } = request({
      options: { extraFormats: ['obj'] }
    });
    exportMesh(input);
    expect(jobs[0]).toMatchObject({
      fileName: 'Part.zip',
      label: 'Mesh package'
    });
  });

  it('refuses one file per body of a configuration not on screen', () => {
    const base = request();
    const { input, jobs, statuses } = request({
      options: { perBody: true },
      target: { ...base.input.target, allShownBodies: true }
    });
    exportMesh(input);
    expect(jobs).toEqual([]);
    expect(statuses).toEqual([
      'Show this configuration to export one file per body.'
    ]);
  });
});
