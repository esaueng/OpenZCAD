/**
 * Whether this Playwright run builds the production renderer. E2E builds
 * otherwise drop antialiasing, shadows and the environment map
 * (apps/web/src/components/viewer/renderProfile.ts); performance probes and
 * documentation captures measure or publish what users see, so they keep it.
 */
export function fullRenderBuild(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(
    env.OZ_PERF || env.OZ_CAPTURE || env.H02_SESSION_PROBE === '1'
  );
}
