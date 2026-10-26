import { CLOUD_API_ORIGIN, isDesktopApp } from './desktopBridge';

/**
 * The privacy policy page (ADR-024, Delivery phases row 0): a static file,
 * `apps/web/public/privacy.html`, which Cloudflare's asset HTML handling
 * serves at this path. It needs no script and no sign-in.
 */
export const PRIVACY_POLICY_PATH = '/privacy';

/**
 * Where a link to the policy points. In a browser the page sits beside the
 * app on the same origin. The desktop app has no web origin of its own, and
 * the policy that covers it is the hosted service's, so it links there.
 */
export function privacyPolicyHref(): string {
  return isDesktopApp()
    ? `${CLOUD_API_ORIGIN}${PRIVACY_POLICY_PATH}`
    : PRIVACY_POLICY_PATH;
}
