import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  E2EE_VERSION_LOG_RETAINED_HEADS,
  MAX_PROJECT_REVISIONS,
  PROJECT_SHARE_LINK_TTL_SECONDS,
  TRASH_RETENTION_DAYS
} from '@openzcad/shared';
import { SESSION_COOKIE_NAME } from '../../worker/sessionCredentials';
import { ASSISTANT_CONSENT_ITEMS } from './assistant/consentCopy';
import { INTERACTION_DIAGNOSTICS_MAX_ENTRIES } from './interactionDiagnostics';
import { PRIVACY_POLICY_PATH } from './privacyPolicy';

/**
 * The privacy policy page (ADR-024, Delivery phases row 0) is a static file
 * in `public/`, served beside the app without the Worker and without
 * signing in. These tests render it as a browser would and tie the figures
 * it states to the code that sets them, so a change to either shows up here.
 */
const WEB_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(WEB_ROOT, '../..');
const html = readFileSync(resolve(WEB_ROOT, 'public/privacy.html'), 'utf8');

function renderPolicy(): Document {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  document.title = parsed.title;
  document.body.innerHTML = parsed.body.innerHTML;
  return parsed;
}

/** The page's visible text, whitespace folded, as one line. */
function pageText(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ');
}

function sectionText(id: string): string {
  const heading = document.getElementById(id);
  if (!heading) throw new Error(`No section #${id}`);
  const parts: string[] = [];
  for (
    let node = heading.nextElementSibling;
    node && node.tagName !== 'H2';
    node = node.nextElementSibling
  ) {
    parts.push(node.textContent ?? '');
  }
  return parts.join(' ').replace(/\s+/g, ' ');
}

interface WranglerConfig {
  assets: {
    html_handling?: string;
    not_found_handling?: string;
    run_worker_first?: string[];
  };
  vars: Record<string, string>;
}

/** `wrangler.jsonc` without its comments, parsed. */
function wranglerConfig(path: string): WranglerConfig {
  const text = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/^\s*\/\/.*$/, ''))
    .join('\n');
  return JSON.parse(text) as WranglerConfig;
}

/**
 * A numeric constant's value read from source, for modules a happy-dom test
 * cannot import (Worker and Durable Object code). Only literal products such
 * as `7 * 24 * 60 * 60` are accepted.
 */
function sourceConstant(file: string, name: string): number {
  const source = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  const match = new RegExp(`\\b${name} = ([0-9_ *]+);`).exec(source);
  if (!match) throw new Error(`No literal ${name} in ${file}`);
  return match[1]!
    .split('*')
    .map((factor) => Number(factor.trim().replaceAll('_', '')))
    .reduce((product, factor) => product * factor, 1);
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('privacy policy page', () => {
  it('renders signed out as a self-contained page', () => {
    const parsed = renderPolicy();
    expect(parsed.title).toBe('Privacy policy · OpenZCAD');
    expect(document.querySelector('h1')?.textContent?.trim()).toBe(
      'Privacy policy'
    );
    expect(pageText()).toContain('Effective October 28, 2026');
    // No script means no sign-in, no app boot and nothing for the entry
    // budget; nothing is fetched from another origin either.
    expect(parsed.querySelectorAll('script')).toHaveLength(0);
    for (const element of parsed.querySelectorAll('[src], link[href]')) {
      const url = element.getAttribute('src') ?? element.getAttribute('href');
      expect(url, element.outerHTML).toMatch(/^\/(?!\/)/);
    }
    expect(document.querySelector('a[href="/"]')?.textContent).toContain(
      'Back to OpenZCAD'
    );
  });

  it('covers every topic the encryption claim depends on', () => {
    renderPolicy();
    const sections = [
      'who-we-are',
      'without-an-account',
      'account',
      'projects',
      'encrypted-projects',
      'keys',
      'sharing',
      'collaboration',
      'assistant',
      'analytics',
      'cookies',
      'email',
      'processors',
      'retention',
      'deletion',
      'desktop',
      'security',
      'self-hosted',
      'transfers',
      'children',
      'changes',
      'contact'
    ];
    for (const id of sections) {
      expect(document.getElementById(id), id).not.toBeNull();
      expect(
        document.querySelector(`nav a[href="#${id}"]`),
        `contents link to #${id}`
      ).not.toBeNull();
    }
    // Every in-page link lands on something.
    for (const link of document.querySelectorAll('a[href^="#"]')) {
      const target = link.getAttribute('href')!.slice(1);
      expect(document.getElementById(target), target).not.toBeNull();
    }
  });

  it('never claims more encryption than the beta delivers', () => {
    renderPolicy();
    const text = pageText();
    expect(text).toContain('opt-in per account');
    expect(text).toContain('available to every signed-in account');
    expect(text).not.toMatch(
      /may not yet be available|made available gradually/
    );
    expect(text).toContain(
      'Cloud projects are stored in readable form unless they are end-to-end encrypted.'
    );
    expect(text).toContain('There is no server-held recovery key.');
    // ADR-024 "Plaintext metadata": what the server still sees is listed.
    const metadata = sectionText('encrypted-projects');
    for (const item of [
      'email addresses and display names',
      'members of a project, their roles',
      'the size of each stored item, timestamps, version numbers',
      'which account and which device signed each saved version',
      'presence (active or idle)',
      'device labels, their public keys'
    ]) {
      expect(metadata).toContain(item);
    }
    expect(text).not.toMatch(
      /all (your )?(cloud )?projects are (end-to-end )?encrypted/i
    );
    expect(text).not.toMatch(/zero[- ]knowledge|military[- ]grade/i);
  });

  it('states the figures the code sets', () => {
    renderPolicy();
    expect(pageText()).toContain(SESSION_COOKIE_NAME);
    const loginCodeSeconds = sourceConstant(
      'apps/web/worker/auth.ts',
      'LOGIN_CODE_TTL_SECONDS'
    );
    expect(sectionText('account')).toContain(
      `expires after ${loginCodeSeconds / 60} minutes`
    );
    const roomHistory = sourceConstant(
      'packages/cloudflare-adapters/src/index.ts',
      'MAX_ROOM_HISTORY'
    );
    expect(sectionText('collaboration')).toContain(
      `up to ${roomHistory} earlier snapshots`
    );
    const invitationSeconds = sourceConstant(
      'apps/web/worker/sharing.ts',
      'PROJECT_INVITATION_TTL_SECONDS'
    );
    expect(sectionText('without-an-account')).toContain(
      `newest ${INTERACTION_DIAGNOSTICS_MAX_ENTRIES} entries`
    );
    const sharing = sectionText('sharing');
    expect(sharing).toContain(
      `expire after ${invitationSeconds / 86_400} days`
    );
    expect(sharing).toContain(
      `for ${PROJECT_SHARE_LINK_TTL_SECONDS / 86_400} days after the link is created`
    );
    const retention = sectionText('retention');
    expect(retention).toContain(`after ${TRASH_RETENTION_DAYS} days`);
    expect(retention).toContain(
      `The newest ${MAX_PROJECT_REVISIONS} per project`
    );
    expect(retention).toContain(
      `latest ${E2EE_VERSION_LOG_RETAINED_HEADS.toLocaleString('en-US')} versions`
    );
    // The assistant's own consent copy and the policy agree on the history.
    const history = ASSISTANT_CONSENT_ITEMS.find((item) =>
      item.fields.includes('history')
    );
    expect(history?.detail).toContain('Up to 12 earlier turns');
    expect(sectionText('assistant')).toContain('up to 12 earlier turns');
  });

  it('matches the official deployment configuration', () => {
    renderPolicy();
    const official = wranglerConfig(resolve(REPO_ROOT, 'wrangler.jsonc'));
    expect(official.vars.E2EE_KEYS_ENABLED).toBe('true');
    expect(official.vars.E2EE_DEFAULT_ON).toBe('false');
    expect(sectionText('encrypted-projects')).toContain(
      'available to every signed-in account in Settings → Encryption'
    );
    expect(official.vars.AUTH_SESSION_DAYS).toBe('30');
    expect(sectionText('account')).toContain('A session lasts 30 days');
    // The provider is named as today's, because the deployment can change it.
    expect(official.vars.AI_PROVIDER).toBe('openrouter');
    expect(sectionText('assistant')).toContain('Today that is OpenRouter');
    expect(official.vars.GLIMPSE_BASIC_ENABLED).toBe('true');
    expect(sectionText('analytics')).toContain(
      'always on for the hosted service'
    );
  });

  it.each(['wrangler.jsonc', 'apps/web/wrangler.jsonc'])(
    'is served at %s’s /privacy as a static asset',
    (config) => {
      const { assets } = wranglerConfig(resolve(REPO_ROOT, config));
      expect(PRIVACY_POLICY_PATH).toBe('/privacy');
      // Cloudflare maps /privacy to privacy.html only with the default
      // auto-trailing-slash HTML handling, and only when the request does
      // not go to the Worker first.
      expect(assets.html_handling ?? 'auto-trailing-slash').toBe(
        'auto-trailing-slash'
      );
      for (const pattern of assets.run_worker_first ?? []) {
        expect(pattern === '/*' || pattern.startsWith('/privacy')).toBe(false);
      }
    }
  );
});
