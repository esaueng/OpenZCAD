import { describe, expect, it } from 'vitest';
import { remappedRustFlags } from '../scripts/run-tauri-build.mjs';

describe('desktop release path privacy', () => {
  it('remaps repository, home, and temporary build paths', () => {
    const flags = remappedRustFlags({
      root: '/Users/test-user/OpenZCAD',
      home: '/Users/test-user',
      temporaryDirectory: '/private/tmp',
      existing: '-Ctarget-cpu=apple-m1'
    }).split('\x1f');

    expect(flags).toEqual([
      '-Ctarget-cpu=apple-m1',
      '--remap-path-prefix=/Users/test-user/OpenZCAD=/source/OpenZCAD',
      '--remap-path-prefix=/Users/test-user=/home/build',
      '--remap-path-prefix=/private/tmp=/tmp/build'
    ]);
  });
});
