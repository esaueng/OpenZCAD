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
 * whose contract is the rendering itself. Production always renders in full.
 */
export interface RenderProfile {
  readonly antialias: boolean;
  readonly shadows: boolean;
  readonly environment: boolean;
}

export const FULL_RENDER_PROFILE: RenderProfile = Object.freeze({
  antialias: true,
  shadows: true,
  environment: true
});

export const E2E_RENDER_PROFILE: RenderProfile = Object.freeze({
  antialias: false,
  shadows: false,
  environment: false
});

/** The page-side opt-in an e2e init script sets. */
export interface FullRenderScope {
  __ozFullRender?: unknown;
}

export function renderProfile(
  e2eBuild: boolean,
  scope: FullRenderScope | undefined
): RenderProfile {
  return e2eBuild && scope?.__ozFullRender !== true
    ? E2E_RENDER_PROFILE
    : FULL_RENDER_PROFILE;
}

/** Read when a renderer is created, so an opt-in must precede navigation. */
export function currentRenderProfile(): RenderProfile {
  return renderProfile(
    import.meta.env.VITE_E2E === '1',
    typeof window === 'undefined' ? undefined : (window as FullRenderScope)
  );
}
