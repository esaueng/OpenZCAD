import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  OFFICIAL,
  OFFICIAL_STABLE
} from '../scripts/validate-deployment-config.mjs';
import {
  HOSTED_REALMS,
  realmForPage,
  type DeploymentRealm
} from '../apps/web/src/lib/deploymentRealm';

interface Route {
  pattern: string;
  custom_domain?: boolean;
  previews_enabled?: boolean;
  enabled?: boolean;
}

function routes(path: string): Route[] {
  const config = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
    .config as { routes?: (Route | string)[] };
  return (config.routes ?? []).map((route) =>
    typeof route === 'string' ? { pattern: route } : route
  );
}

/** The hostnames a config serves the app at: Previews-only domains excluded. */
function served(path: string): string[] {
  return routes(path)
    .filter((route) => route.enabled !== false)
    .map((route) => route.pattern.replace(/\/.*$/, ''));
}

const page = (hostname: string) => realmForPage({ hostname, desktop: false });

describe('deployment realms follow the Workers’ routes', () => {
  const channels: [string, DeploymentRealm][] = [
    ['wrangler.jsonc', 'beta'],
    ['wrangler.stable.jsonc', 'stable']
  ];

  it.each(channels)(
    'gives every address %s serves its realm',
    (path, realm) => {
      const hostnames = served(path);
      expect(hostnames.length).toBeGreaterThan(0);
      for (const hostname of hostnames)
        expect(page(hostname), hostname).toBe(realm);
    }
  );

  it('names no hostname that neither channel serves', () => {
    const all = new Set(channels.flatMap(([path]) => served(path)));
    expect(Object.keys(HOSTED_REALMS).sort()).toEqual([...all].sort());
  });

  it('agrees with the origins the deployment validator pins', () => {
    expect(page(new URL(OFFICIAL.publicOrigin).hostname)).toBe('beta');
    for (const origin of OFFICIAL_STABLE.servedOrigins)
      expect(page(new URL(origin).hostname), origin).toBe('stable');
  });

  it('leaves Previews outside every realm', () => {
    const previews = routes('wrangler.jsonc').filter(
      (route) => route.previews_enabled
    );
    expect(previews.length).toBeGreaterThan(0);
    for (const route of previews) {
      expect(page(route.pattern)).toBeNull();
      expect(page(`feature-x.${route.pattern}`)).toBeNull();
    }
  });
});
