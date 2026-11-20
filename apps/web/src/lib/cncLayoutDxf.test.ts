import { describe, expect, it, vi } from 'vitest';
import type { BodyId, ProjectDocument } from '@openzcad/shared';

import { writeCncLayoutDxf } from './cncLayoutDxf';

const document = { name: 'Parts' } as unknown as ProjectDocument;
const plate = 'body_plate' as BodyId;

function run(
  exportModel: ReturnType<typeof vi.fn>,
  save = vi.fn(async () => true),
  allShownBodies = false
) {
  const announce = vi.fn();
  return {
    announce,
    save,
    done: writeCncLayoutDxf({
      geometry: { exportModel } as never,
      target: { document, bodyIds: [plate], allShownBodies },
      units: 'inch',
      stem: 'Parts',
      save,
      announce
    })
  };
}

describe('writeCncLayoutDxf', () => {
  it('asks for the layout of the export bodies and names what was left out', async () => {
    const exportModel = vi.fn(async () => ({
      text: 'DXF',
      warnings: ['Ball has no flat face to lay it on']
    }));
    const { announce, save, done } = run(exportModel);
    await done;
    expect(exportModel).toHaveBeenCalledWith('dxf', document, [plate], {
      units: 'inch',
      cncLayout: {}
    });
    expect(save).toHaveBeenCalledWith('Parts-cnc.dxf', 'dxf', 'DXF');
    expect(announce).toHaveBeenLastCalledWith(
      'Exported the CNC cut layout to Parts-cnc.dxf, one layer per face height. Left out: Ball has no flat face to lay it on.'
    );
  });

  it('passes a configuration export through as every shown body', async () => {
    const exportModel = vi.fn(async () => ({ text: 'DXF', warnings: [] }));
    const { announce, done } = run(
      exportModel,
      vi.fn(async () => true),
      true
    );
    await done;
    expect(exportModel).toHaveBeenCalledWith('dxf', document, [plate], {
      units: 'inch',
      cncLayout: {},
      allShownBodies: true
    });
    expect(announce).toHaveBeenLastCalledWith(
      'Exported the CNC cut layout to Parts-cnc.dxf, one layer per face height.'
    );
  });

  it('reports a cancelled save and the adapter refusal', async () => {
    const cancelled = run(
      vi.fn(async () => ({ text: 'DXF', warnings: [] })),
      vi.fn(async () => false)
    );
    await cancelled.done;
    expect(cancelled.announce).toHaveBeenLastCalledWith(
      'CNC layout export cancelled.'
    );
    const refused = run(
      vi.fn(async () => {
        throw new Error(
          'Nothing to lay out: Ball has no flat face to lay it on.'
        );
      })
    );
    await refused.done;
    expect(refused.save).not.toHaveBeenCalled();
    expect(refused.announce).toHaveBeenLastCalledWith(
      'Nothing to lay out: Ball has no flat face to lay it on.'
    );
  });
});
