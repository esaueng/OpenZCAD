import { describe, expect, it, vi } from 'vitest';
import { repeatStepExport } from './repeat-step-export';
import type { StepExportMetadata } from './step-export-metadata';

const date = '2026-01-01T00:00:00Z';
const nextDate = '2026-01-02T00:00:00Z';
const metadata: StepExportMetadata = {
  fileName: `Owner's ${date}.step`,
  productName: date,
  timestamp: date,
  solids: [{ name: date, color: '#123abc' }]
};

const step = (stamp: string) => `HEADER;
FILE_NAME('Owner''s ${date}.step', '${stamp}', (''), (''), 'Remus', 'OpenZCAD', '');
ENDSEC;
DATA;
#1 = PRODUCT('${date}', '', '', ());
ENDSEC;`;

describe('repeat STEP exports', () => {
  it('uses owned bytes and changes only the time field on a hit', () => {
    const kernel = {};
    const solids = Uint8Array.of(1, 2);
    const write = vi.fn(() => step(date));
    repeatStepExport(kernel, 'p', 'mm', solids, metadata, write);
    solids[0] = 99;
    expect(
      repeatStepExport(
        kernel,
        'p',
        'mm',
        Uint8Array.of(1, 2),
        { ...metadata, timestamp: nextDate },
        write
      )
    ).toBe(step(nextDate));
    expect(write).toHaveBeenCalledTimes(1);
    repeatStepExport(kernel, 'p', 'mm', solids, metadata, write);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('rechecks project, units, ordered labels, assembly, PMI and protocol', () => {
    const kernel = {};
    const solids = Uint8Array.of(1);
    const write = vi.fn(() => step(date));
    const changes: Partial<StepExportMetadata>[] = [
      { productName: 'Renamed' },
      { fileName: 'new.step' },
      { solids: [{ name: date, color: '#ffff00' }] },
      { protocol: 'ap242' },
      { assembly: { folders: [{ name: 'Folder', parent: null }], bodies: [] } },
      {
        pmi: [
          {
            kind: 'datum',
            letter: 'A',
            face: { solid: 0, face: 0, surface: 'plane' }
          }
        ]
      }
    ];
    for (const change of changes) {
      repeatStepExport(kernel, 'p', 'mm', solids, metadata, write);
      write.mockClear();
      repeatStepExport(
        kernel,
        'p',
        'mm',
        solids,
        { ...metadata, ...change },
        write
      );
      expect(write).toHaveBeenCalledOnce();
    }
    repeatStepExport(kernel, 'p', 'mm', solids, metadata, write);
    write.mockClear();
    repeatStepExport(kernel, 'p', 'inch', solids, metadata, write);
    repeatStepExport(kernel, 'q', 'inch', solids, metadata, write);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['unrecognized header', step(date).replace('FILE_NAME(', 'FILE_NAME (')],
    ['oversized output', step(date) + ' '.repeat(2 * 1024 * 1024)]
  ])('keeps the writer path for %s', (_name, output) => {
    const kernel = {};
    const write = vi.fn(() => output);
    for (let i = 0; i < 2; i++)
      expect(
        repeatStepExport(kernel, 'p', 'mm', Uint8Array.of(1), metadata, write)
      ).toBe(output);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
