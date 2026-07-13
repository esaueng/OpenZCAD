/**
 * Constructive solid geometry on convex polygon soups using BSP trees.
 *
 * This is an implementation of the classic algorithm popularized by Evan
 * Wallace's csg.js: solids are converted to lists of convex polygons, a BSP
 * tree built from one operand clips the polygons of the other, and the
 * surviving polygon sets are recombined. All inputs and outputs are convex,
 * planar polygons, which plane-splitting preserves.
 */

export interface CsgVec {
  x: number;
  y: number;
  z: number;
}

const EPSILON = 1e-5;

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

function sub(a: CsgVec, b: CsgVec): CsgVec {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function cross(a: CsgVec, b: CsgVec): CsgVec {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function dot(a: CsgVec, b: CsgVec): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function lerp(a: CsgVec, b: CsgVec, t: number): CsgVec {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
  };
}

function normalize(v: CsgVec): CsgVec {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

class CsgPlane {
  constructor(
    public normal: CsgVec,
    public w: number
  ) {}

  static fromPoints(a: CsgVec, b: CsgVec, c: CsgVec): CsgPlane | null {
    const normal = normalize(cross(sub(b, a), sub(c, a)));
    if (normal.x === 0 && normal.y === 0 && normal.z === 0) {
      return null;
    }
    return new CsgPlane(normal, dot(normal, a));
  }

  clone(): CsgPlane {
    return new CsgPlane({ ...this.normal }, this.w);
  }

  flip(): void {
    this.normal = { x: -this.normal.x, y: -this.normal.y, z: -this.normal.z };
    this.w = -this.w;
  }

  splitPolygon(
    polygon: CsgPolygon,
    coplanarFront: CsgPolygon[],
    coplanarBack: CsgPolygon[],
    front: CsgPolygon[],
    back: CsgPolygon[]
  ): void {
    let polygonType = 0;
    const types: number[] = [];

    for (const vertex of polygon.vertices) {
      const t = dot(this.normal, vertex) - this.w;
      const type = t < -EPSILON ? BACK : t > EPSILON ? FRONT : COPLANAR;
      polygonType |= type;
      types.push(type);
    }

    switch (polygonType) {
      case COPLANAR:
        (dot(this.normal, polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(
          polygon
        );
        break;
      case FRONT:
        front.push(polygon);
        break;
      case BACK:
        back.push(polygon);
        break;
      case SPANNING: {
        const f: CsgVec[] = [];
        const b: CsgVec[] = [];
        for (let i = 0; i < polygon.vertices.length; i++) {
          const j = (i + 1) % polygon.vertices.length;
          const ti = types[i]!;
          const tj = types[j]!;
          const vi = polygon.vertices[i]!;
          const vj = polygon.vertices[j]!;
          if (ti !== BACK) {
            f.push(vi);
          }
          if (ti !== FRONT) {
            b.push(vi);
          }
          if ((ti | tj) === SPANNING) {
            const t =
              (this.w - dot(this.normal, vi)) / dot(this.normal, sub(vj, vi));
            const v = lerp(vi, vj, t);
            f.push(v);
            b.push({ ...v });
          }
        }
        if (f.length >= 3) {
          front.push(new CsgPolygon(f, polygon.plane.clone()));
        }
        if (b.length >= 3) {
          back.push(new CsgPolygon(b, polygon.plane.clone()));
        }
        break;
      }
    }
  }
}

export class CsgPolygon {
  plane: CsgPlane;

  constructor(
    public vertices: CsgVec[],
    plane?: CsgPlane
  ) {
    const computed =
      plane ?? CsgPlane.fromPoints(vertices[0]!, vertices[1]!, vertices[2]!);
    if (!computed) {
      throw new Error('Degenerate polygon passed to CSG.');
    }
    this.plane = computed;
  }

  clone(): CsgPolygon {
    return new CsgPolygon(
      this.vertices.map((vertex) => ({ ...vertex })),
      this.plane.clone()
    );
  }

  flip(): void {
    this.vertices.reverse();
    this.plane.flip();
  }
}

class BspNode {
  plane: CsgPlane | null = null;
  front: BspNode | null = null;
  back: BspNode | null = null;
  polygons: CsgPolygon[] = [];

  constructor(polygons?: CsgPolygon[]) {
    if (polygons && polygons.length > 0) {
      this.build(polygons);
    }
  }

  invert(): void {
    for (const polygon of this.polygons) {
      polygon.flip();
    }
    this.plane?.flip();
    this.front?.invert();
    this.back?.invert();
    const temp = this.front;
    this.front = this.back;
    this.back = temp;
  }

  clipPolygons(polygons: CsgPolygon[]): CsgPolygon[] {
    if (!this.plane) {
      return polygons.slice();
    }
    let front: CsgPolygon[] = [];
    let back: CsgPolygon[] = [];
    for (const polygon of polygons) {
      this.plane.splitPolygon(polygon, front, back, front, back);
    }
    if (this.front) {
      front = this.front.clipPolygons(front);
    }
    back = this.back ? this.back.clipPolygons(back) : [];
    return front.concat(back);
  }

  clipTo(bsp: BspNode): void {
    this.polygons = bsp.clipPolygons(this.polygons);
    this.front?.clipTo(bsp);
    this.back?.clipTo(bsp);
  }

  allPolygons(): CsgPolygon[] {
    let polygons = this.polygons.slice();
    if (this.front) {
      polygons = polygons.concat(this.front.allPolygons());
    }
    if (this.back) {
      polygons = polygons.concat(this.back.allPolygons());
    }
    return polygons;
  }

  build(polygons: CsgPolygon[]): void {
    if (polygons.length === 0) {
      return;
    }
    if (!this.plane) {
      this.plane = polygons[0]!.plane.clone();
    }
    const front: CsgPolygon[] = [];
    const back: CsgPolygon[] = [];
    for (const polygon of polygons) {
      this.plane.splitPolygon(polygon, this.polygons, this.polygons, front, back);
    }
    if (front.length > 0) {
      this.front ??= new BspNode();
      this.front.build(front);
    }
    if (back.length > 0) {
      this.back ??= new BspNode();
      this.back.build(back);
    }
  }
}

function clonePolygons(polygons: CsgPolygon[]): CsgPolygon[] {
  return polygons.map((polygon) => polygon.clone());
}

export function csgUnion(a: CsgPolygon[], b: CsgPolygon[]): CsgPolygon[] {
  const nodeA = new BspNode(clonePolygons(a));
  const nodeB = new BspNode(clonePolygons(b));
  nodeA.clipTo(nodeB);
  nodeB.clipTo(nodeA);
  nodeB.invert();
  nodeB.clipTo(nodeA);
  nodeB.invert();
  nodeA.build(nodeB.allPolygons());
  return nodeA.allPolygons();
}

export function csgSubtract(a: CsgPolygon[], b: CsgPolygon[]): CsgPolygon[] {
  const nodeA = new BspNode(clonePolygons(a));
  const nodeB = new BspNode(clonePolygons(b));
  nodeA.invert();
  nodeA.clipTo(nodeB);
  nodeB.clipTo(nodeA);
  nodeB.invert();
  nodeB.clipTo(nodeA);
  nodeB.invert();
  nodeA.build(nodeB.allPolygons());
  nodeA.invert();
  return nodeA.allPolygons();
}

export function csgIntersect(a: CsgPolygon[], b: CsgPolygon[]): CsgPolygon[] {
  const nodeA = new BspNode(clonePolygons(a));
  const nodeB = new BspNode(clonePolygons(b));
  nodeA.invert();
  nodeB.clipTo(nodeA);
  nodeB.invert();
  nodeA.clipTo(nodeB);
  nodeB.clipTo(nodeA);
  nodeA.build(nodeB.allPolygons());
  nodeA.invert();
  return nodeA.allPolygons();
}
