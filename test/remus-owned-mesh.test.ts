import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('keeps consumed mesh arrays alive after freeing the result and growing WASM memory', () => {
  const require = createRequire(
    new URL('../packages/kernel-adapter/package.json', import.meta.url)
  );
  const packagePath = process.env.REMUS_WASM_PKG
    ? resolve(process.env.REMUS_WASM_PKG)
    : require.resolve('remus-wasm');
  // Load in a clean process so we can observe the actual exported memory
  // before the package instantiates. No borrowed memory is exposed by the API.
  const result = execFileSync(
    process.execPath,
    [
      '-e',
      `
const assert = require('node:assert/strict');
const memories = [];
const Instance = WebAssembly.Instance;
WebAssembly.Instance = class extends Instance {
  constructor(module, imports) {
    super(module, imports);
    for (const value of Object.values(this.exports))
      if (value instanceof WebAssembly.Memory) memories.push(value);
  }
};
const { BrepKernel } = require(process.argv[1]);
const kernel = new BrepKernel();
const solid = kernel.makeBox(2, 3, 4);
const mesh = kernel.tessellateSolidGroupedBinary(solid, 0.06);
const positions = mesh.takePositions();
const indices = mesh.takeIndices();
const offsets = mesh.takeFaceOffsets();
const expected = [positions.slice(), indices.slice(), offsets.slice()];
assert.equal(mesh.takePositions().length, 0);
assert.equal(mesh.takeIndices().length, 0);
assert.equal(mesh.takeFaceOffsets().length, 0);
mesh.free();
assert.equal(memories.length, 1);
const memory = memories[0];
const previous = memory.buffer;
memory.grow(1);
assert.notEqual(memory.buffer, previous);
kernel.free();
for (const [index, array] of [positions, indices, offsets].entries()) {
  assert.ok(array.byteLength > 0);
  assert.deepEqual(array, expected[index]);
}
process.stdout.write(JSON.stringify({ vertices: positions.length / 3, triangles: indices.length / 3 }));
`,
      packagePath
    ],
    { encoding: 'utf8' }
  );
  expect(JSON.parse(result)).toEqual({ vertices: 8, triangles: 12 });
});
