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
});

describe('exportMesh (I04)', () => {
  const STL = {
    extension: 'stl',
    contentType: 'model/stl',
    label: 'STL',
    kind: 'stl-export' as const,
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
      version: 4,
      documentUnits: 'mm',
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
      label: 'STL',
      kind: 'stl-export',
      contentType: 'model/stl',
      metadata: {
        bodyIds: 'body_a',
        documentVersion: 4,
        units: 'mm',
        format: 'stl-binary',
        deflectionMm: 0.05
      }
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
      label: 'STL of Wide',
      metadata: { configuration: 'Wide' }
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
      label: 'Mesh package',
      kind: 'stl-export',
      contentType: 'application/zip',
      metadata: { format: 'stl-binary,obj', perBody: 'no' }
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
