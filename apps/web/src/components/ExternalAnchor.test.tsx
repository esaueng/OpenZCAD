import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { ExternalAnchor } from './ExternalAnchor';
import { privacyPolicyHref } from '../lib/privacyPolicy';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

type TauriWindow = Window & { __TAURI_INTERNALS__?: unknown };

const HREF = 'https://zcad.app/privacy';

afterEach(() => {
  delete (window as TauriWindow).__TAURI_INTERNALS__;
  vi.mocked(invoke).mockReset();
  vi.restoreAllMocks();
});

describe('ExternalAnchor', () => {
  it('stays a plain new-tab anchor in a browser', () => {
    render(<ExternalAnchor href={HREF}>Policy</ExternalAnchor>);
    const link = screen.getByRole('link', { name: 'Policy' });
    expect(link).toHaveAttribute('href', HREF);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
    let defaultPrevented: boolean | undefined;
    link.addEventListener('click', (event) => {
      defaultPrevented = event.defaultPrevented;
      // jsdom cannot follow the link; stop it after React has seen the click.
      event.preventDefault();
    });
    fireEvent.click(link);
    expect(defaultPrevented).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('opens the page in the system browser from the desktop app', async () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockResolvedValue(undefined);
    render(<ExternalAnchor href={HREF}>Policy</ExternalAnchor>);
    const link = screen.getByRole('link', { name: 'Policy' });
    // WKWebView would silently drop the new-window request.
    expect(fireEvent.click(link)).toBe(false);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('open_external_url', { url: HREF })
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('reports a refused or failed native open instead of throwing', async () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {};
    vi.mocked(invoke).mockRejectedValue(
      'That link is not an approved OpenZCAD link.'
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ExternalAnchor href={HREF}>Policy</ExternalAnchor>);
    fireEvent.click(screen.getByRole('link', { name: 'Policy' }));
    await waitFor(() => expect(error).toHaveBeenCalledTimes(1));
  });
});

describe('desktop external link allowlist', () => {
  // The Rust shell opens only exact URLs from this list; a link the web app
  // routes through it but the list omits would silently do nothing.
  const rust = readFileSync(
    resolve(__dirname, '../../../desktop/src-tauri/src/external_links.rs'),
    'utf8'
  );
  const list = rust.slice(
    rust.indexOf('APPROVED_EXTERNAL_URLS'),
    rust.indexOf('];', rust.indexOf('APPROVED_EXTERNAL_URLS'))
  );
  const approved = [...list.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1] ?? ''
  );

  it('covers every external link the desktop app opens', () => {
    (window as TauriWindow).__TAURI_INTERNALS__ = {};
    const settings = readFileSync(
      resolve(__dirname, 'SettingsPage.tsx'),
      'utf8'
    );
    const providerLinks = [
      ...settings.matchAll(/href: '(https:\/\/[^']+)'/g)
    ].map((match) => match[1]);
    expect(providerLinks.length).toBeGreaterThan(0);
    for (const url of [privacyPolicyHref(), ...providerLinks]) {
      expect(approved).toContain(url);
    }
  });

  it('lists only https URLs without queries or fragments', () => {
    expect(approved.length).toBeGreaterThan(0);
    for (const url of approved) {
      const parsed = new URL(url);
      expect(parsed.protocol).toBe('https:');
      expect(parsed.search).toBe('');
      expect(parsed.hash).toBe('');
      expect(parsed.href).toBe(url);
    }
  });
});
