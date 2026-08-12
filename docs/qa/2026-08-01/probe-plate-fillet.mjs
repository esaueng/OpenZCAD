// Repro for the "Fillet could not be created … radius 2" failure on the
// screenshot plate (80 x 60 x 6, four dia-4.5 holes): drives the pinned
// brepkit-wasm kernel directly, no app needed. Builds plate = box - cylinder,
// then attempts every fillet class the user can request and prints whether
// the kernel returned a new solid or its silent no-op fallback (the input
// handle), which the adapter then reports as the radius error.
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const pkgDir = realpathSync(
  join(repoRoot, 'packages', 'kernel-adapter', 'node_modules', 'brepkit-wasm')
);
const require = createRequire(import.meta.url);
const { BrepKernel } = require(join(pkgDir, 'brepkit_wasm_node.cjs'));
console.log('brepkit-wasm at:', pkgDir);

const k = new BrepKernel();

const translation = (x, y, z) =>
  new Float64Array([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]);

function buildPlate(withHole) {
  const plate = k.makeBox(80, 60, 6);
  if (!withHole) return plate;
  const tool = k.copyAndTransformSolid(k.makeCylinder(2.25, 6), translation(10, 10, 0));
  return k.cut(plate, tool);
}

function edgeData(solid) {
  return Array.from(k.getSolidEdges(solid)).map((edge) => {
    const vertices = Array.from(k.getEdgeVertices(edge));
    return {
      edge,
      type: k.getEdgeCurveType(edge),
      length: k.edgeLength(edge),
      start: vertices.slice(0, 3),
      end: vertices.slice(3, 6)
    };
  });
}

const onTop = (e) => Math.abs(e.start[2] - 6) < 1e-9 && Math.abs(e.end[2] - 6) < 1e-9;
const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
const touches = (a, b) =>
  near(a.start, b.start) || near(a.start, b.end) || near(a.end, b.start) || near(a.end, b.end);

function attempt(label, solid, edges, radius) {
  let out;
  try {
    out = k.fillet(solid, Uint32Array.from(edges), radius);
  } catch (error) {
    console.log(`  ${label} r=${radius}: THREW ${error.message ?? error}`);
    return;
  }
  console.log(
    `  ${label} r=${radius}: ${out === solid ? 'NO-OP (all engines failed, input returned)' : `OK -> new solid ${out}`}`
  );
}

for (const withHole of [false, true]) {
  const solid = buildPlate(withHole);
  const edges = edgeData(solid);
  const top80 = edges.find((e) => e.type === 'LINE' && onTop(e) && Math.abs(e.length - 80) < 1e-6);
  const top60 = edges.find(
    (e) => e.type === 'LINE' && onTop(e) && Math.abs(e.length - 60) < 1e-6 && touches(e, top80)
  );
  const rim = edges.find((e) => e.type === 'CIRCLE' && onTop(e));
  console.log(`\n=== plate ${withHole ? 'WITH one hole' : 'without holes'} (${edges.length} edges) ===`);
  attempt('single 80mm top edge   ', solid, [top80.edge], 2);
  attempt('corner 80mm+60mm pair  ', solid, [top80.edge, top60.edge], 2);
  attempt('corner 80mm+60mm pair  ', solid, [top80.edge, top60.edge], 0.5);
  if (rim) {
    attempt('hole rim (circle)      ', solid, [rim.edge], 2);
    attempt('hole rim (circle)      ', solid, [rim.edge], 1);
    attempt('hole rim (circle)      ', solid, [rim.edge], 0.5);
  }
  const perimeter = edges.filter(
    (e) => e.type === 'LINE' && onTop(e) && (Math.abs(e.length - 80) < 1e-6 || Math.abs(e.length - 60) < 1e-6)
  );
  attempt(`top perimeter (${perimeter.length} edges)`, solid, perimeter.map((e) => e.edge), 2);
}

// Sequential fillets: first fillet succeeds, then a second feature on the
// filleted body (what the user actually did in the screenshot).
const solid = buildPlate(true);
const edges = edgeData(solid);
const top80 = edges.find((e) => e.type === 'LINE' && onTop(e) && Math.abs(e.length - 80) < 1e-6);
const first = k.fillet(solid, Uint32Array.from([top80.edge]), 2);
console.log(`\n=== second fillet on the already-filleted plate (first fillet ${first === solid ? 'NO-OP' : 'OK'}) ===`);
const afterEdges = edgeData(first);
let ok = 0;
let failed = 0;
for (const e of afterEdges) {
  const out = k.fillet(first, Uint32Array.from([e.edge]), 2);
  if (out === first) failed += 1;
  else ok += 1;
}
console.log(`  single-edge R2 attempts on all ${afterEdges.length} edges: ${ok} OK, ${failed} NO-OP`);
