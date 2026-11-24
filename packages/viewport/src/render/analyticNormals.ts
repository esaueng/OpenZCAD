import type {
  BodyTopology,
  FaceGeometry,
  MeshGeometry
} from '@openzcad/shared';

/**
 * Writes the oriented unit surface normal at a mesh vertex into `out` and
 * answers true, or answers false where the face's exact surface does not
 * describe that point (off the surface, on its axis, at a cone apex).
 */
export type VertexSurfaceNormal = (
  x: number,
  y: number,
  z: number,
  out: Float64Array
) => boolean;

type FaceWithGeometry = Pick<
  BodyTopology['faces'][number],
  'triangleStart' | 'triangleCount'
> & { geometry?: FaceGeometry };

/** Unoriented surface normal; see {@link VertexSurfaceNormal}. */
type SurfaceNormal = VertexSurfaceNormal;

/**
 * How far a vertex may sit from the exact surface and still take its normal:
 * a ten-thousandth of the surface's own radius, widened to cover float32
 * rounding of coordinates far from the origin. A face whose geometry no
 * longer matches its mesh (a stale measurement during an edit) misses this
 * by orders of magnitude and keeps its facet normals.
 */
function onSurfaceTolerance(radius: number, x: number, y: number, z: number) {
  return Math.max(
    1e-4 * radius,
    4e-7 * Math.max(Math.abs(x), Math.abs(y), Math.abs(z))
  );
}

function finiteVector(
  value: { x: number; y: number; z: number } | undefined
): value is { x: number; y: number; z: number } {
  return (
    value !== undefined &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}

function unitAxis(
  x: number,
  y: number,
  z: number
): readonly [number, number, number] | null {
  const length = Math.sqrt(x * x + y * y + z * z);
  return length > 0 && Number.isFinite(length)
    ? [x / length, y / length, z / length]
    : null;
}

function surfaceNormalOf(geometry: FaceGeometry): SurfaceNormal | null {
  switch (geometry.surfaceType) {
    case 'cylinder': {
      const { axisStart: start, axisEnd: end, radius } = geometry;
      if (!finiteVector(start) || !finiteVector(end)) return null;
      if (radius === undefined || !(radius > 0) || !Number.isFinite(radius))
        return null;
      const axis = unitAxis(end.x - start.x, end.y - start.y, end.z - start.z);
      if (!axis) return null;
      const [ax, ay, az] = axis;
      return (x, y, z, out) => {
        const qx = x - start.x;
        const qy = y - start.y;
        const qz = z - start.z;
        const h = qx * ax + qy * ay + qz * az;
        const rx = qx - h * ax;
        const ry = qy - h * ay;
        const rz = qz - h * az;
        const rho = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (!(rho > 0)) return false;
        if (Math.abs(rho - radius) > onSurfaceTolerance(radius, x, y, z))
          return false;
        out[0] = rx / rho;
        out[1] = ry / rho;
        out[2] = rz / rho;
        return true;
      };
    }
    case 'cone': {
      const { apex, axis: rawAxis, halfAngle } = geometry;
      if (!finiteVector(apex) || !finiteVector(rawAxis)) return null;
      if (
        halfAngle === undefined ||
        !(halfAngle > 0) ||
        !(halfAngle < Math.PI / 2)
      )
        return null;
      const axis = unitAxis(rawAxis.x, rawAxis.y, rawAxis.z);
      if (!axis) return null;
      const [ax, ay, az] = axis;
      const cos = Math.cos(halfAngle);
      const sin = Math.sin(halfAngle);
      return (x, y, z, out) => {
        const qx = x - apex.x;
        const qy = y - apex.y;
        const qz = z - apex.z;
        const h = qx * ax + qy * ay + qz * az;
        const rx = qx - h * ax;
        const ry = qy - h * ay;
        const rz = qz - h * az;
        const rho = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (!(rho > 0) || h === 0) return false;
        // Distance from the point to the nappe on its side of the apex.
        const distance = Math.abs(rho * cos - Math.abs(h) * sin);
        if (distance > onSurfaceTolerance(rho, x, y, z)) return false;
        const side = h > 0 ? 1 : -1;
        out[0] = (rx / rho) * cos - side * ax * sin;
        out[1] = (ry / rho) * cos - side * ay * sin;
        out[2] = (rz / rho) * cos - side * az * sin;
        return true;
      };
    }
    case 'torus': {
      const {
        torusCenter: center,
        axis: rawAxis,
        majorRadius,
        minorRadius
      } = geometry;
      if (!finiteVector(center) || !finiteVector(rawAxis)) return null;
      if (
        majorRadius === undefined ||
        minorRadius === undefined ||
        !(majorRadius > 0) ||
        !(minorRadius > 0) ||
        !Number.isFinite(majorRadius) ||
        !Number.isFinite(minorRadius)
      )
        return null;
      const axis = unitAxis(rawAxis.x, rawAxis.y, rawAxis.z);
      if (!axis) return null;
      const [ax, ay, az] = axis;
      return (x, y, z, out) => {
        const qx = x - center.x;
        const qy = y - center.y;
        const qz = z - center.z;
        const h = qx * ax + qy * ay + qz * az;
        const rx = qx - h * ax;
        const ry = qy - h * ay;
        const rz = qz - h * az;
        const rho = Math.sqrt(rx * rx + ry * ry + rz * rz);
        if (!(rho > 0)) return false;
        // From the nearest point of the spine circle to the vertex.
        const scale = majorRadius / rho;
        const wx = qx - rx * scale;
        const wy = qy - ry * scale;
        const wz = qz - rz * scale;
        const tube = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (!(tube > 0)) return false;
        if (
          Math.abs(tube - minorRadius) >
          onSurfaceTolerance(minorRadius, x, y, z)
        )
          return false;
        out[0] = wx / tube;
        out[1] = wy / tube;
        out[2] = wz / tube;
        return true;
      };
    }
    default:
      return null;
  }
}

/**
 * Exact shading normals for the faces whose analytic surface fully defines
 * them — cylinders, cones and tori — by face index; null for every other face.
 *
 * A facet-averaged normal is only as good as the triangles around the vertex.
 * The kernel's mesher can leave a strip of slivers along a face boundary (a
 * second row of vertices a few hundredths of a millimetre from a cylinder's
 * rim): each sliver spans a chord of the curve, so its plane tilts by up to
 * 45°, and a sliver's near-180° corner dominates any angle-weighted average.
 * Those tilted normals then interpolate along the face's long triangles as
 * streaks. The exact normal does not depend on the triangles at all.
 *
 * The surface's sign is taken from the facets: a face whose triangles do not
 * clearly agree on one orientation (or whose geometry no longer matches its
 * mesh) keeps facet normals.
 */
export function analyticFaceNormals(
  mesh: Pick<MeshGeometry, 'vertices' | 'indices'>,
  faces: ReadonlyArray<FaceWithGeometry>
): Array<VertexSurfaceNormal | null> {
  const positions = mesh.vertices;
  const indices = mesh.indices;
  const triangleCount = Math.floor(indices.length / 3);
  const vertexCount = Math.floor(positions.length / 3);
  const scratch = new Float64Array(3);
  return faces.map((face) => {
    const geometry = face.geometry;
    if (!geometry) return null;
    const normalAt = surfaceNormalOf(geometry);
    if (!normalAt) return null;
    const start = Math.max(0, Math.floor(face.triangleStart));
    const end = Math.min(
      triangleCount,
      Math.ceil(face.triangleStart + face.triangleCount)
    );
    let agree = 0;
    let disagree = 0;
    for (let triangle = start; triangle < end; triangle += 1) {
      const i0 = indices[triangle * 3]!;
      const i1 = indices[triangle * 3 + 1]!;
      const i2 = indices[triangle * 3 + 2]!;
      if (i0 >= vertexCount || i1 >= vertexCount || i2 >= vertexCount) continue;
      const p0 = i0 * 3;
      const p1 = i1 * 3;
      const p2 = i2 * 3;
      const x = positions[p0]!;
      const y = positions[p0 + 1]!;
      const z = positions[p0 + 2]!;
      if (!normalAt(x, y, z, scratch)) continue;
      const ax = positions[p1]! - x;
      const ay = positions[p1 + 1]! - y;
      const az = positions[p1 + 2]! - z;
      const bx = positions[p2]! - x;
      const by = positions[p2 + 1]! - y;
      const bz = positions[p2 + 2]! - z;
      // Area-weighted, so slivers cannot sway the verdict.
      const dot =
        (ay * bz - az * by) * scratch[0]! +
        (az * bx - ax * bz) * scratch[1]! +
        (ax * by - ay * bx) * scratch[2]!;
      if (dot > 0) agree += dot;
      else disagree -= dot;
    }
    const total = agree + disagree;
    if (!(total > 0)) return null;
    // Facets of one face on its exact surface all face the same way; a
    // split verdict means the geometry does not describe this mesh.
    if (Math.min(agree, disagree) > 0.01 * total) return null;
    if (agree > disagree) return normalAt;
    return (x, y, z, out) => {
      if (!normalAt(x, y, z, out)) return false;
      out[0] = -out[0]!;
      out[1] = -out[1]!;
      out[2] = -out[2]!;
      return true;
    };
  });
}
