// Analyze the app's actual display mesh for the filleted box: per-face groups,
// display deflection (scale*2e-4, angular 0.06), corner patch quality.
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// Resolve through the workspace symlink so this always loads the package the
// lockfile currently pins (a stale sibling can linger in node_modules/.pnpm).
const pkgDir = realpathSync(
  join(repoRoot, 'packages', 'kernel-adapter', 'node_modules', 'brepkit-wasm')
);
const require = createRequire(import.meta.url);
const { BrepKernel } = require(join(pkgDir, 'brepkit_wasm_node.cjs'));
console.log('brepkit-wasm at:', pkgDir);

const k = new BrepKernel();
const W = 30, H = 18, D = 24, R = 2;
const box = k.makeBox(W, H, D);
const edges = k.getSolidEdges(box);
const solid = k.fillet(box, edges, R);

const lin = 30 * 2e-4; // displayTessellationForExtents -> 0.006
const ang = 0.06;
const mesh = k.tessellateSolidGroupedBinary(solid, lin, ang);
const pos = mesh.positions, idx = mesh.indices, offs = Array.from(mesh.faceOffsets);
const faces = Array.from(k.getSolidFaces(solid));
console.log('faces:', faces.length, 'tris:', idx.length / 3, 'verts:', pos.length / 3);

// classify faces via surface info if available
for (let f = 0; f < offs.length - 1; f++) {
  const triCount = (offs[f + 1] - offs[f]) / 3;
  let info = '';
  try { info = k.faceSurfaceType ? k.faceSurfaceType(faces[f]) : ''; } catch {}
  if (!info) {
    try { info = JSON.parse(k.faceInfo(faces[f]))?.surfaceType ?? ''; } catch {}
  }
  // face bbox
  let mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  for (let t = offs[f]; t < offs[f + 1]; t++) {
    const v = idx[t];
    for (let c = 0; c < 3; c++) {
      mn[c] = Math.min(mn[c], pos[3 * v + c]);
      mx[c] = Math.max(mx[c], pos[3 * v + c]);
    }
  }
  const near0 = mx[0] < R + 1e-6 && mx[1] < R + 1e-6 && mx[2] < R + 1e-6;
  console.log(`face ${f} (${info || 'n/a'}): tris=${triCount} bbox=[${mn.map(v=>v.toFixed(2))}]..[${mx.map(v=>v.toFixed(2))}]${near0 ? '  <-- corner patch at origin' : ''}`);
}

// Corner patch at origin: analyze deviation + triangle quality + normals spread
const cornerFaceIdx = [];
for (let f = 0; f < offs.length - 1; f++) {
  let mx = [-1e9, -1e9, -1e9];
  for (let t = offs[f]; t < offs[f + 1]; t++) {
    const v = idx[t];
    for (let c = 0; c < 3; c++) mx[c] = Math.max(mx[c], pos[3 * v + c]);
  }
  if (mx[0] < R + 1e-6 && mx[1] < R + 1e-6 && mx[2] < R + 1e-6) cornerFaceIdx.push(f);
}
console.log('corner faces at origin:', cornerFaceIdx);

const C = [R, R, R];
for (const f of cornerFaceIdx) {
  let dmin = 1e9, dmax = -1e9;
  let degenerate = 0, tris = 0, flipped = 0;
  for (let t = offs[f]; t < offs[f + 1]; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const P = (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
    const pa = P(a), pb = P(b), pc = P(c);
    for (const p of [pa, pb, pc]) {
      const d = Math.hypot(p[0] - C[0], p[1] - C[1], p[2] - C[2]);
      dmin = Math.min(dmin, d); dmax = Math.max(dmax, d);
    }
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const nl = Math.hypot(...n);
    tris++;
    if (nl < 1e-12) { degenerate++; continue; }
    // outward = away from center for convex corner
    const mid = [(pa[0]+pb[0]+pc[0])/3 - C[0], (pa[1]+pb[1]+pc[1])/3 - C[1], (pa[2]+pb[2]+pc[2])/3 - C[2]];
    const dot = (n[0]*mid[0]+n[1]*mid[1]+n[2]*mid[2]) / nl;
    if (dot > 0) flipped++; // outward normal should point TOWARD -mid (outside is away from body, i.e. -radial... careful)
  }
  console.log(`corner face ${f}: tris=${tris} degenerateTris=${degenerate} radial dist min=${dmin.toFixed(4)} max=${dmax.toFixed(4)} (R=${R}), tris with normal pointing away-from-center=${flipped}/${tris}`);
}

// Boundary crease: compare corner-face normals vs adjacent cylinder-face normals at shared vertices
// Simplified: report the max angle between geometric normals of triangles sharing an edge across different faces near the origin corner.
const triFace = new Int32Array(idx.length / 3);
for (let f = 0; f < offs.length - 1; f++) for (let t = offs[f] / 3; t < offs[f + 1] / 3; t++) triFace[t] = f;
const edgeMap = new Map();
const triNormal = [];
for (let t = 0; t < idx.length / 3; t++) {
  const a = idx[3 * t], b = idx[3 * t + 1], c = idx[3 * t + 2];
  const P = (i) => [pos[3 * i], pos[3 * i + 1], pos[3 * i + 2]];
  const pa = P(a), pb = P(b), pc = P(c);
  const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
  let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const nl = Math.hypot(...n) || 1;
  triNormal.push(n.map((x) => x / nl));
  for (const [s, e] of [[a, b], [b, c], [c, a]]) {
    const key = s < e ? `${s}:${e}` : `${e}:${s}`;
    if (!edgeMap.has(key)) edgeMap.set(key, []);
    edgeMap.get(key).push(t);
  }
}
let worst = 0, worstPair = null;
for (const [key, ts] of edgeMap) {
  if (ts.length !== 2) continue;
  const [t1, t2] = ts;
  if (triFace[t1] === triFace[t2]) continue;
  // only near origin corner
  const vi = key.split(':').map(Number);
  const x = pos[3 * vi[0]], y = pos[3 * vi[0] + 1], z = pos[3 * vi[0] + 2];
  if (x > R + 0.75 || y > R + 0.75 || z > R + 0.75) continue;
  const n1 = triNormal[t1], n2 = triNormal[t2];
  const dot = Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]));
  const angDeg = (Math.acos(dot) * 180) / Math.PI;
  if (angDeg > worst) { worst = angDeg; worstPair = [triFace[t1], triFace[t2], x, y, z]; }
}
console.log('worst cross-face dihedral near origin corner:', worst.toFixed(2), 'deg between faces', worstPair);
mesh.free();
