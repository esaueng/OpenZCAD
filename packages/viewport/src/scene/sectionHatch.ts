import type * as THREE from 'three';

/**
 * The hatch every section cut is drawn with, approximate cap and exact fill
 * alike: thin diagonal strokes over the cut's own (shaded-down) body colour.
 *
 * A cut face used to be filled in the body's colour and lit like its
 * outside, so cut fins read as shorter fins and a cut boss as a lower one.
 * Hatching is the drafting convention for "material was cut here"; it reads
 * at any angle and in any body colour, and it needs no UVs, which neither
 * cap has. The strokes are laid in screen space, a fixed CSS-pixel pitch
 * whatever the zoom, so they never alias into a moiré at a distance.
 */
export const SECTION_HATCH_PITCH_PX = 8;

/**
 * How far a cut surface sits below its body's colour in lightness. The cut
 * takes the colour of the body it cuts — a pale slate blue used to fill every
 * cut, a colour nothing else on the stage used — and is shaded down from it,
 * so it reads as the inside of that body and never as more of its outside.
 */
export const CUT_LIGHTNESS_SHIFT = -0.14;

/** Stroke width, in CSS pixels. */
export const SECTION_HATCH_STROKE_PX = 1.25;

/** How far a stroke darkens the fill under it. */
export const SECTION_HATCH_DARKEN = 0.5;

const ANCHOR = '#include <color_fragment>';

const PARS = `uniform float sectionHatchPitch;
uniform float sectionHatchStroke;
void main() {`;

const APPLY = `${ANCHOR}
{
  float sectionHatchPhase = mod(gl_FragCoord.x + gl_FragCoord.y, sectionHatchPitch);
  diffuseColor.rgb *= mix(1.0, ${SECTION_HATCH_DARKEN.toFixed(3)}, step(sectionHatchPhase, sectionHatchStroke));
}`;

/** Marks a material as drawn with the hatch; tests and passes read it. */
export const SECTION_HATCH = 'sectionHatch';

/**
 * Draws `material` hatched. Composes with any compile hook it already has,
 * keys its own program, and follows the renderer's pixel ratio so the
 * pitch stays in CSS pixels on a high-density screen.
 */
export function withSectionHatch<T extends THREE.Material>(material: T): T {
  const uniforms = {
    sectionHatchPitch: { value: SECTION_HATCH_PITCH_PX },
    sectionHatchStroke: { value: SECTION_HATCH_STROKE_PX }
  };
  const compile = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    compile(shader, renderer);
    if (
      !shader.fragmentShader.includes(ANCHOR) ||
      !shader.fragmentShader.includes('void main() {')
    ) {
      throw new Error('Section shader changed: hatch anchor missing.');
    }
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', PARS)
      .replace(ANCHOR, APPLY);
  };
  const cacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${cacheKey()}|section-hatch`;
  const render = material.onBeforeRender.bind(material);
  material.onBeforeRender = (
    renderer,
    scene,
    camera,
    geometry,
    object,
    group
  ) => {
    render(renderer, scene, camera, geometry, object, group);
    const ratio = renderer.getPixelRatio?.() ?? 1;
    uniforms.sectionHatchPitch.value = SECTION_HATCH_PITCH_PX * ratio;
    uniforms.sectionHatchStroke.value = SECTION_HATCH_STROKE_PX * ratio;
  };
  material.userData[SECTION_HATCH] = true;
  return material;
}
