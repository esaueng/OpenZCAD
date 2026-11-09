/**
 * The per-frame rendering the viewer pays for beyond the geometry itself.
 *
 * CI runs the e2e suite on machines without a GPU, where Chromium draws
 * WebGL through SwiftShader on the CPU. There antialiasing, the shadow map
 * and the studio environment map cost about 43% of the suite's test time
 * (measured on 2026-10-23 across all specs), and almost no spec asserts on
 * any of them. `VITE_E2E=1` builds therefore render without all three
 * unless the page sets `window.__ozFullRender = true` before it loads,
 * which is what `enableFullRender` in the e2e fixtures does for the specs
 * whose contract is the rendering itself. Performance probes and
 * documentation captures build with `VITE_E2E_FULL_RENDER=1`
 * (playwright.config.ts), so they measure and publish the production
 * renderer. Production always renders in full.
 *
 * Settled-frame ambient occlusion (`@openzcad/viewport` ambientOcclusion.ts)
 * follows the same split: it is a render-quality pass no colour-sampling
 * spec should have to account for, and it costs a SwiftShader runner real
 * time at every settle.
 */
export interface RenderProfile {
  readonly antialias: boolean;
  readonly shadows: boolean;
  readonly environment: boolean;
  readonly ambientOcclusion: boolean;
}

export const FULL_RENDER_PROFILE: RenderProfile = Object.freeze({
  antialias: true,
  shadows: true,
  environment: true,
  ambientOcclusion: true
});

export const E2E_RENDER_PROFILE: RenderProfile = Object.freeze({
  antialias: false,
  shadows: false,
  environment: false,
  ambientOcclusion: false
});

/** The page-side opt-in an e2e init script sets. */
export interface FullRenderScope {
  __ozFullRender?: unknown;
  /**
   * `false` turns the settled ambient occlusion off in any build, so a frame
   * timing or capture can compare the same build with and without it.
   */
  __ozAmbientOcclusion?: unknown;
}

/** Which build the bundle is: production, a full-render e2e build, or e2e. */
export interface RenderBuild {
  e2e: boolean;
  fullRender: boolean;
}

export function renderProfile(
  build: RenderBuild,
  scope: FullRenderScope | undefined
): RenderProfile {
  return build.e2e && !build.fullRender && scope?.__ozFullRender !== true
    ? E2E_RENDER_PROFILE
    : FULL_RENDER_PROFILE;
}

/** Read when a renderer is created, so an opt-in must precede navigation. */
export function currentRenderProfile(): RenderProfile {
  return renderProfile(
    {
      e2e: import.meta.env.VITE_E2E === '1',
      // OZ_PERF is baked into the bundle (vite.config.ts), so a perf build
      // served by hand keeps the production renderer too.
      fullRender:
        import.meta.env.VITE_E2E_FULL_RENDER === '1' ||
        Boolean(import.meta.env.OZ_PERF)
    },
    typeof window === 'undefined' ? undefined : (window as FullRenderScope)
  );
}

/**
 * Whether the viewer computes settled-frame ambient occlusion: the profile
 * allows it, the viewport's own switch is on, and the page has not opted out.
 */
export function ambientOcclusionEnabled(
  profile: RenderProfile,
  switchedOn: boolean,
  scope: FullRenderScope | undefined
): boolean {
  return (
    profile.ambientOcclusion &&
    switchedOn &&
    scope?.__ozAmbientOcclusion !== false
  );
}
