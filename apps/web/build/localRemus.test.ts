import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localRemusPackages } from './localRemus';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function pair(ioVersion = '2026.1.1', ioCommit = SHA) {
  const root = await mkdtemp(join(tmpdir(), 'remus-overlay-'));
  directories.push(root);
  const paths = [join(root, 'kernel'), join(root, 'io')];
  await Promise.all(
    paths.map(async (path, index) => {
      await mkdir(path);
      await writeFile(
        join(
          path,
          index === 0 ? 'remus_wasm_bg.wasm' : 'remus_wasm_io_bg.wasm'
        ),
        new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
      );
      await writeFile(
        join(path, 'package.json'),
        JSON.stringify({
          name: index === 0 ? 'remus-wasm' : 'remus-wasm-io',
          version: index === 0 ? '2026.1.1' : ioVersion,
          remusSourceCommit: index === 0 ? SHA : ioCommit
        })
      );
    })
  );
  return { REMUS_WASM_PKG: paths[0], REMUS_WASM_IO_PKG: paths[1] };
}
describe('paired local Remus browser packages', () => {
  it('leaves the immutable installed packages selected by default', async () => {
    expect(await localRemusPackages({})).toBeNull();
  });
  it('rejects a partial overlay', async () => {
    await expect(
      localRemusPackages({ REMUS_WASM_PKG: 'kernel' })
    ).rejects.toThrow('both');
  });
  it('labels a paired CI artifact as local with its real source stamp', async () => {
    const overlay = await localRemusPackages(await pair());
    expect(overlay?.build).toMatchObject({
      version: '2026.1.1+local',
      commit: SHA,
      local: true,
      dirty: false,
      sourceContext: 'ci-artifact'
    });
    expect(overlay?.build.wasmSha256).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/)
    ]);
    expect(Object.keys(overlay!.aliases)).toEqual([
      'remus-wasm',
      'remus-wasm-io'
    ]);
  });
  it('rejects different versions and source commits', async () => {
    await expect(localRemusPackages(await pair('2026.1.2'))).rejects.toThrow(
      'versions'
    );
    await expect(
      localRemusPackages(await pair('2026.1.1', 'a'.repeat(40)))
    ).rejects.toThrow('provenance');
  });
});
