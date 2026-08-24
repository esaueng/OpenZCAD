import { zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { resolveShaprImportLimits } from './limits';
import { extractShaprArchive, inspectShaprArchive } from './zip';

const limits = resolveShaprImportLimits();

describe('SHAPR ZIP inspection', () => {
  it('extracts only the bounded workspace entry', () => {
    const workspace = new TextEncoder().encode('workspace-bytes');
    const archive = zipSync({
      workspace,
      'preview/thumbnail.png': new Uint8Array([1, 2, 3])
    });

    const extracted = extractShaprArchive(archive, limits);

    expect(extracted.workspace).toEqual(workspace);
    expect(extracted.inspection.entries.map((entry) => entry.name)).toEqual([
      'workspace',
      'preview/thumbnail.png'
    ]);
  });

  it('rejects traversal paths before decompression', () => {
    const archive = zipSync({
      '../workspace': new Uint8Array([1])
    });

    expect(() => inspectShaprArchive(archive, limits)).toThrow(
      'unsafe entry path'
    );
  });

  it('rejects excessive compression ratios before decompression', () => {
    const archive = zipSync({
      workspace: new Uint8Array(2 * 1024 * 1024)
    });

    expect(() => inspectShaprArchive(archive, limits)).toThrow(
      'compression-ratio limit'
    );
  });

  it('rejects archives whose workspace exceeds the configured limit', () => {
    const archive = zipSync(
      {
        workspace: new Uint8Array([1, 2, 3, 4])
      },
      { level: 0 }
    );

    expect(() =>
      inspectShaprArchive(
        archive,
        resolveShaprImportLimits({ maxWorkspaceBytes: 3 })
      )
    ).toThrow('exceeds its size limit');
  });

  it('rejects a local filename that disagrees with the central directory', () => {
    const archive = zipSync({ workspace: new Uint8Array([1]) }, { level: 0 });
    const corrupted = archive.slice();
    corrupted[30] = 'x'.charCodeAt(0);

    expect(() => inspectShaprArchive(corrupted, limits)).toThrow(
      'does not match its central directory'
    );
  });
});
