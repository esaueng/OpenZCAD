import * as THREE from 'three';
import { VIEW_LABELS } from '@openzcad/viewport';
import type { CubePalette } from '../../lib/stagePalette';
import {
  AXIS_KEYS,
  CUBE_SIZE,
  FACES,
  type AxisKey,
  type CubeAffine,
  type CubeFacet,
  type CubeHighlight,
  type CubePoint,
  type CubeProjection
} from './orientationCube';

/**
 * The view cube, painted into the viewer's own WebGL canvas.
 *
 * The cube used to be an SVG that rewrote some forty attributes on every
 * camera frame. Chrome rasterises that cheaply; Firefox rebuilds and repaints
 * the page for any DOM change in a frame, and on a busy machine that repaint
 * is what cost an orbit its frame rate (60 → ~46 fps measured). Drawn here,
 * an orbit changes nothing but the canvas the viewer is already presenting.
 *
 * It draws exactly what the SVG drew, in the SVG's painter's order, from the
 * same projection (orientationCube.ts): triad arms behind the cube, the facets
 * with their seams, the face labels, then the arms in front. The SVG stays in
 * the page, unpainted, as the cube's click, focus and accessibility surface.
 */

/** Room around the cube's box for what overhangs it: the triad's tips. */
const MARGIN = 24;
const FACE_SEAM = 2.5;
const CORNER_SEAM = 1.8;
const FOCUS_SEAM = 1.5;
const ARM_WIDTH = 2.2;
/** Atlas texels per CSS pixel: labels only ever shrink, and DPR is ≤ 2. */
const TEXT_SCALE = 4;
/** The facets' `transition: fill var(--dur-fast)`. */
const HOVER_MS = 100;
const ROUND_SEGMENTS = 10;

type Rgb = readonly [number, number, number];
type Rgba = readonly [number, number, number, number];

/** A hex colour's sRGB components, for mixing the way `color-mix` does. */
function srgb(hex: string): Rgb {
  const color = new THREE.Color(hex);
  const out = { r: 0, g: 0, b: 0 };
  color.getRGB(out, THREE.SRGBColorSpace);
  return [out.r, out.g, out.b];
}

function mixRgb(from: Rgb, to: Rgb, t: number): Rgb {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t
  ];
}

/** sRGB → the renderer's linear working space, which it converts back out. */
function linear(rgb: Rgb, alpha = 1): Rgba {
  const color = new THREE.Color().setRGB(
    rgb[0],
    rgb[1],
    rgb[2],
    THREE.SRGBColorSpace
  );
  return [color.r, color.g, color.b, alpha];
}

/** CSS `ease`, near enough for a 100 ms fill fade. */
function ease(t: number): number {
  return t * t * (3 - 2 * t);
}

function facetKey(facet: CubeFacet): string {
  return `${facet.kind}:${facet.index}`;
}

function sameFacet(
  a: CubeFacet | null,
  kind: CubeFacet['kind'],
  index: number
) {
  return a?.kind === kind && a.index === index;
}

/** Triangles built on the CPU each frame, drawn in one call. */
class Batch {
  readonly geometry = new THREE.BufferGeometry();
  readonly mesh: THREE.Mesh;
  private position = new Float32Array(0);
  private color = new Float32Array(0);
  private uv: Float32Array | null;
  private count = 0;

  constructor(
    material: THREE.Material,
    renderOrder: number,
    textured: boolean
  ) {
    this.uv = textured ? new Float32Array(0) : null;
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.renderOrder = renderOrder;
    this.mesh.frustumCulled = false;
    this.grow(1024);
  }

  private grow(capacity: number) {
    const position = new Float32Array(capacity * 3);
    position.set(this.position.subarray(0, this.count * 3));
    const color = new Float32Array(capacity * 4);
    color.set(this.color.subarray(0, this.count * 4));
    this.position = position;
    this.color = color;
    // A replaced attribute keeps its old GL buffer until the geometry is
    // disposed, and the next draw uploads the new ones.
    this.geometry.dispose();
    this.geometry.setAttribute(
      'position',
      new THREE.BufferAttribute(position, 3).setUsage(THREE.DynamicDrawUsage)
    );
    this.geometry.setAttribute(
      'color',
      new THREE.BufferAttribute(color, 4).setUsage(THREE.DynamicDrawUsage)
    );
    if (this.uv) {
      const uv = new Float32Array(capacity * 2);
      uv.set(this.uv.subarray(0, this.count * 2));
      this.uv = uv;
      this.geometry.setAttribute(
        'uv',
        new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage)
      );
    }
  }

  begin() {
    this.count = 0;
  }

  vertex(x: number, y: number, color: Rgba, u = 0, v = 0) {
    if (this.count * 3 >= this.position.length) {
      this.grow(this.count * 2);
    }
    const index = this.count;
    this.position[index * 3] = x;
    this.position[index * 3 + 1] = y;
    this.position[index * 3 + 2] = 0;
    this.color.set(color, index * 4);
    if (this.uv) {
      this.uv[index * 2] = u;
      this.uv[index * 2 + 1] = v;
    }
    this.count += 1;
  }

  triangle(a: CubePoint, b: CubePoint, c: CubePoint, color: Rgba) {
    this.vertex(a.x, a.y, color);
    this.vertex(b.x, b.y, color);
    this.vertex(c.x, c.y, color);
  }

  /** A convex polygon as a fan; every facet the cube shows is convex. */
  fill(points: readonly CubePoint[], color: Rgba) {
    const first = points[0];
    if (!first) return;
    for (let index = 1; index + 1 < points.length; index += 1) {
      this.triangle(first, points[index]!, points[index + 1]!, color);
    }
  }

  private quad(a: CubePoint, b: CubePoint, half: number, color: Rgba) {
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 1e-9) return;
    const nx = (-(b.y - a.y) / length) * half;
    const ny = ((b.x - a.x) / length) * half;
    const a0 = { x: a.x + nx, y: a.y + ny };
    const a1 = { x: a.x - nx, y: a.y - ny };
    const b0 = { x: b.x + nx, y: b.y + ny };
    const b1 = { x: b.x - nx, y: b.y - ny };
    this.triangle(a0, b0, b1, color);
    this.triangle(a0, b1, a1, color);
  }

  /** A fan of `ROUND_SEGMENTS` per half turn, from `start` radians. */
  private arc(
    center: CubePoint,
    radius: number,
    start: number,
    turns: number,
    color: Rgba
  ) {
    const steps = Math.ceil(ROUND_SEGMENTS * turns * 2);
    const span = turns * Math.PI * 2;
    for (let step = 0; step < steps; step += 1) {
      const a0 = start + (span * step) / steps;
      const a1 = start + (span * (step + 1)) / steps;
      this.triangle(
        center,
        {
          x: center.x + Math.cos(a0) * radius,
          y: center.y + Math.sin(a0) * radius
        },
        {
          x: center.x + Math.cos(a1) * radius,
          y: center.y + Math.sin(a1) * radius
        },
        color
      );
    }
  }

  /** A closed outline with round joins, centred on the edges like SVG. */
  stroke(points: readonly CubePoint[], width: number, color: Rgba) {
    const half = width / 2;
    points.forEach((point, index) => {
      this.quad(point, points[(index + 1) % points.length]!, half, color);
      this.arc(point, half, 0, 1, color);
    });
  }

  /**
   * One segment with round caps. The caps are only the outer half-discs, so
   * a translucent line never blends twice over itself.
   */
  segment(a: CubePoint, b: CubePoint, width: number, color: Rgba) {
    const half = width / 2;
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    this.quad(a, b, half, color);
    this.arc(a, half, angle + Math.PI / 2, 0.5, color);
    this.arc(b, half, angle - Math.PI / 2, 0.5, color);
  }

  /** A textured rectangle in local units, mapped through `affine`. */
  glyph(affine: CubeAffine, cell: AtlasCell, color: Rgba) {
    const [a, b, c, d, e, f] = affine;
    const map = (x: number, y: number) => ({
      x: a * x + c * y + e,
      y: b * x + d * y + f
    });
    const tl = map(cell.left, cell.top);
    const tr = map(cell.right, cell.top);
    const br = map(cell.right, cell.bottom);
    const bl = map(cell.left, cell.bottom);
    this.vertex(tl.x, tl.y, color, cell.u0, cell.v0);
    this.vertex(tr.x, tr.y, color, cell.u1, cell.v0);
    this.vertex(br.x, br.y, color, cell.u1, cell.v1);
    this.vertex(tl.x, tl.y, color, cell.u0, cell.v0);
    this.vertex(br.x, br.y, color, cell.u1, cell.v1);
    this.vertex(bl.x, bl.y, color, cell.u0, cell.v1);
  }

  end() {
    for (const name of ['position', 'color', 'uv']) {
      const attribute = this.geometry.getAttribute(name);
      if (attribute) attribute.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, this.count);
  }

  dispose() {
    this.geometry.dispose();
  }
}

/** One label's rectangle around its anchor, in CSS px, and its texels. */
interface AtlasCell {
  left: number;
  right: number;
  top: number;
  bottom: number;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface CubeFonts {
  /** `.cube-face-label`: centred on its anchor both ways. */
  face: { family: string; weight: string; size: number; spacing: number };
  /** `.orientation-axis-label`: centred on x, alphabetic baseline on y. */
  axis: { family: string; weight: string; size: number };
}

/** The labels' faces as the cube's stylesheet resolves them. */
export function readCubeFonts(svg: Element): CubeFonts {
  const read = (selector: string, size: number) => {
    const element = svg.querySelector(selector);
    const style = element ? window.getComputedStyle(element) : null;
    const spacing = Number.parseFloat(style?.letterSpacing ?? '');
    return {
      family: style?.fontFamily || 'sans-serif',
      weight: style?.fontWeight || '500',
      size: Number.parseFloat(style?.fontSize ?? '') || size,
      spacing: Number.isFinite(spacing) ? spacing : 0
    };
  };
  const axis = read('.orientation-axis-label', 10);
  return {
    face: read('.cube-face-label', 9),
    axis: { family: axis.family, weight: axis.weight, size: axis.size }
  };
}

/**
 * The labels rasterised once, white on black, read as coverage through the
 * material's alpha map: the colour comes from the vertices, so a theme change
 * costs no redraw, and the black background keeps filtered edges from
 * picking up the fringe an unpremultiplied transparent texel brings.
 */
class LabelAtlas {
  readonly texture: THREE.CanvasTexture;
  readonly faces: AtlasCell[] = [];
  readonly axes = {} as Record<AxisKey, AtlasCell>;

  constructor(fonts: CubeFonts) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const pad = 2 * TEXT_SCALE;
    type Entry = {
      text: string;
      font: string;
      size: number;
      spacing: number;
      centred: boolean;
      width: number;
      height: number;
      top: number;
    };
    const faceFont = `${fonts.face.weight} ${fonts.face.size * TEXT_SCALE}px ${fonts.face.family}`;
    const axisFont = `${fonts.axis.weight} ${fonts.axis.size * TEXT_SCALE}px ${fonts.axis.family}`;
    const entries: Entry[] = [
      ...FACES.map((face) => ({
        text: VIEW_LABELS[face.view],
        font: faceFont,
        size: fonts.face.size * TEXT_SCALE,
        spacing: fonts.face.spacing * TEXT_SCALE,
        centred: true
      })),
      ...AXIS_KEYS.map((key) => ({
        text: key.toUpperCase(),
        font: axisFont,
        size: fonts.axis.size * TEXT_SCALE,
        spacing: 0,
        centred: false
      }))
    ].map((entry) => {
      let width = entry.size * entry.text.length;
      if (context) {
        context.font = entry.font;
        setLetterSpacing(context, entry.spacing);
        width = context.measureText(entry.text).width;
      }
      return {
        ...entry,
        width: Math.ceil(width + pad * 2),
        height: Math.ceil(entry.size * 1.6 + pad * 2),
        top: 0
      };
    });
    let y = 0;
    for (const entry of entries) {
      entry.top = y;
      y += entry.height;
    }
    canvas.width = Math.max(...entries.map((entry) => entry.width));
    canvas.height = Math.max(y, 1);
    if (context) {
      context.fillStyle = '#000';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = '#fff';
      context.textAlign = 'center';
    }
    const cells = entries.map((entry) => {
      const centreX = entry.width / 2;
      // Face labels hang on the em box's centre (SVG `central`), axis
      // letters on the alphabetic baseline.
      const anchorY = entry.centred
        ? entry.top + entry.height / 2
        : entry.top + pad + entry.size * 1.15;
      if (context) {
        context.font = entry.font;
        setLetterSpacing(context, entry.spacing);
        context.textBaseline = entry.centred ? 'middle' : 'alphabetic';
        context.fillText(entry.text, centreX, anchorY);
      }
      const cell: AtlasCell = {
        left: -centreX / TEXT_SCALE,
        right: (entry.width - centreX) / TEXT_SCALE,
        top: (entry.top - anchorY) / TEXT_SCALE,
        bottom: (entry.top + entry.height - anchorY) / TEXT_SCALE,
        u0: 0,
        u1: entry.width / canvas.width,
        // CanvasTexture flips rows on upload, so the canvas's top is v = 1.
        v0: 1 - entry.top / canvas.height,
        v1: 1 - (entry.top + entry.height) / canvas.height
      };
      return cell;
    });
    this.faces.push(...cells.slice(0, FACES.length));
    AXIS_KEYS.forEach((key, index) => {
      this.axes[key] = cells[FACES.length + index]!;
    });
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
  }

  dispose() {
    this.texture.dispose();
  }
}

function setLetterSpacing(context: CanvasRenderingContext2D, px: number) {
  // Chrome 99+ and Firefox 115+; older engines draw without the 0.02em.
  if ('letterSpacing' in context) {
    (context as { letterSpacing: string }).letterSpacing = `${px}px`;
  }
}

/** Where the cube's SVG box sits on the canvas, in CSS pixels. */
export interface CubeBox {
  left: number;
  top: number;
  width: number;
}

export class OrientationCubeOverlay {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);
  private readonly shapeMaterial: THREE.MeshBasicMaterial;
  private readonly textMaterial: THREE.MeshBasicMaterial;
  private readonly under: Batch;
  private readonly underText: Batch;
  private readonly facets: Batch;
  private readonly faceText: Batch;
  private readonly over: Batch;
  private readonly overText: Batch;
  private atlas: LabelAtlas | null = null;
  private palette: {
    glancing: Rgb;
    frontal: Rgb;
    hover: Rgb;
    seam: Rgba;
    label: Rgba;
    focus: Rgba;
    axis: Record<AxisKey, Rgb>;
  };
  /** Each highlighted facet's eased progress toward the hover fill. */
  private readonly hoverMix = new Map<string, number>();
  private highlight: CubeHighlight = { hovered: null, focusVisible: null };
  private readonly savedViewport = new THREE.Vector4();
  private readonly drawingBuffer = new THREE.Vector2();

  constructor(palette: CubePalette) {
    const common = {
      vertexColors: true,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      side: THREE.DoubleSide
    } as const;
    this.shapeMaterial = new THREE.MeshBasicMaterial(common);
    this.textMaterial = new THREE.MeshBasicMaterial(common);
    this.under = new Batch(this.shapeMaterial, 0, false);
    this.underText = new Batch(this.textMaterial, 1, true);
    this.facets = new Batch(this.shapeMaterial, 2, false);
    this.faceText = new Batch(this.textMaterial, 3, true);
    this.over = new Batch(this.shapeMaterial, 4, false);
    this.overText = new Batch(this.textMaterial, 5, true);
    for (const batch of [
      this.under,
      this.underText,
      this.facets,
      this.faceText,
      this.over,
      this.overText
    ]) {
      this.scene.add(batch.mesh);
    }
    this.palette = this.resolve(palette);
  }

  private resolve(palette: CubePalette) {
    return {
      glancing: srgb(palette.glancing),
      frontal: srgb(palette.frontal),
      hover: srgb(palette.hover),
      seam: linear(srgb(palette.seam)),
      label: linear(srgb(palette.label)),
      focus: linear(srgb(palette.focus)),
      axis: {
        x: srgb(palette.axisX),
        y: srgb(palette.axisY),
        z: srgb(palette.axisZ)
      }
    };
  }

  setPalette(palette: CubePalette) {
    this.palette = this.resolve(palette);
  }

  /** Rasterises the labels again, e.g. once the web font has loaded. */
  setFonts(fonts: CubeFonts) {
    this.atlas?.dispose();
    this.atlas = new LabelAtlas(fonts);
    this.textMaterial.alphaMap = this.atlas.texture;
    this.textMaterial.needsUpdate = true;
  }

  setHighlight(highlight: CubeHighlight) {
    this.highlight = highlight;
  }

  /** Eases hover fills; true while one is still moving. */
  step(dtMs: number, reducedMotion: boolean): boolean {
    const targets = new Set<string>();
    for (const facet of [this.highlight.hovered, this.highlight.focusVisible]) {
      if (facet) targets.add(facetKey(facet));
    }
    for (const key of targets) {
      if (!this.hoverMix.has(key)) this.hoverMix.set(key, 0);
    }
    let moving = false;
    const delta = reducedMotion ? 1 : dtMs / HOVER_MS;
    for (const [key, value] of this.hoverMix) {
      const target = targets.has(key) ? 1 : 0;
      const next =
        target > value
          ? Math.min(value + delta, 1)
          : Math.max(value - delta, 0);
      if (next === 0 && target === 0) {
        this.hoverMix.delete(key);
        continue;
      }
      this.hoverMix.set(key, next);
      if (next !== target) moving = true;
    }
    return moving;
  }

  private fillFor(kind: CubeFacet['kind'], index: number, facing: number) {
    const base = mixRgb(this.palette.glancing, this.palette.frontal, facing);
    const hover = this.hoverMix.get(`${kind}:${index}`) ?? 0;
    return linear(mixRgb(base, this.palette.hover, ease(hover)));
  }

  private build(projection: CubeProjection) {
    const atlas = this.atlas;
    for (const batch of [
      this.under,
      this.underText,
      this.facets,
      this.faceText,
      this.over,
      this.overText
    ]) {
      batch.begin();
    }
    for (const key of AXIS_KEYS) {
      const arm = projection.arms[key];
      if (arm.opacity <= 0) continue;
      const color = linear(this.palette.axis[key], arm.opacity);
      const shapes = arm.onSurface ? this.over : this.under;
      shapes.segment(arm.from, arm.to, ARM_WIDTH, color);
      if (atlas) {
        (arm.onSurface ? this.overText : this.underText).glyph(
          [1, 0, 0, 1, arm.letter.x, arm.letter.y],
          atlas.axes[key],
          color
        );
      }
    }
    projection.faces.forEach((face, index) => {
      if (!face) return;
      const focused = sameFacet(this.highlight.focusVisible, 'face', index);
      this.facets.fill(face.outline, this.fillFor('face', index, face.facing));
      this.facets.stroke(
        face.outline,
        focused ? FOCUS_SEAM : FACE_SEAM,
        focused ? this.palette.focus : this.palette.seam
      );
      if (atlas) {
        this.faceText.glyph(
          face.label,
          atlas.faces[index]!,
          this.palette.label
        );
      }
    });
    projection.corners.forEach((corner, index) => {
      if (!corner) return;
      const focused = sameFacet(this.highlight.focusVisible, 'corner', index);
      this.facets.fill(
        corner.outline,
        this.fillFor('corner', index, corner.facing)
      );
      this.facets.stroke(
        corner.outline,
        focused ? FOCUS_SEAM : CORNER_SEAM,
        focused ? this.palette.focus : this.palette.seam
      );
    });
    for (const batch of [
      this.under,
      this.underText,
      this.facets,
      this.faceText,
      this.over,
      this.overText
    ]) {
      batch.end();
    }
  }

  /**
   * Draws over whatever the renderer just drew, without clearing it.
   * `box` is the cube's SVG box relative to the canvas, in CSS pixels; the
   * viewport snaps to whole device pixels and the camera takes up the
   * remainder, so the cube lands where the SVG's would to the subpixel.
   */
  render(
    renderer: THREE.WebGLRenderer,
    projection: CubeProjection,
    box: CubeBox
  ) {
    if (!(box.width > 0)) return;
    this.build(projection);
    const ratio = renderer.getPixelRatio();
    const scale = box.width / CUBE_SIZE;
    const extent = (CUBE_SIZE + MARGIN * 2) * scale;
    const left = box.left - MARGIN * scale;
    const top = box.top - MARGIN * scale;
    const x0 = Math.floor(left * ratio);
    const x1 = Math.ceil((left + extent) * ratio);
    const y0 = Math.floor(top * ratio);
    const y1 = Math.ceil((top + extent) * ratio);
    const bufferHeight = renderer.getDrawingBufferSize(this.drawingBuffer).y;
    this.camera.left = (x0 / ratio - box.left) / scale;
    this.camera.right = (x1 / ratio - box.left) / scale;
    // SVG y grows downward, so the camera's top is the smaller number.
    this.camera.top = (y0 / ratio - box.top) / scale;
    this.camera.bottom = (y1 / ratio - box.top) / scale;
    this.camera.updateProjectionMatrix();

    if (this.textMaterial.alphaMap) {
      this.textMaterial.alphaMap.anisotropy =
        renderer.capabilities.getMaxAnisotropy();
    }
    renderer.getViewport(this.savedViewport);
    const autoClear = renderer.autoClear;
    // The scene has no shadow casters, but a pending refresh must survive
    // this pass for the frame that follows.
    const shadowUpdate = renderer.shadowMap.needsUpdate;
    renderer.autoClear = false;
    renderer.setViewport(
      x0 / ratio,
      (bufferHeight - y1) / ratio,
      (x1 - x0) / ratio,
      (y1 - y0) / ratio
    );
    try {
      renderer.render(this.scene, this.camera);
    } finally {
      renderer.setViewport(this.savedViewport);
      renderer.autoClear = autoClear;
      renderer.shadowMap.needsUpdate = shadowUpdate;
    }
  }

  dispose() {
    for (const batch of [
      this.under,
      this.underText,
      this.facets,
      this.faceText,
      this.over,
      this.overText
    ]) {
      batch.dispose();
    }
    this.atlas?.dispose();
    this.shapeMaterial.dispose();
    this.textMaterial.dispose();
  }
}
