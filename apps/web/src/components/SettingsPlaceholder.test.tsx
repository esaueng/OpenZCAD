import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SettingsPlaceholder } from './SettingsPlaceholder';

describe('SettingsPlaceholder', () => {
  it('draws the Settings frame on the page’s own layout classes', () => {
    const { container } = render(<SettingsPlaceholder />);
    const page = container.firstElementChild as HTMLElement;
    expect(page.classList.contains('settings-page')).toBe(true);
    expect(page.querySelector('.settings-layout > .settings-nav')).not.toBe(
      null
    );
    expect(
      page.querySelector('.settings-layout > .settings-head')?.textContent
    ).toBe('Settings');
  });

  it('offers nothing to assistive technology or the keyboard', () => {
    const { container } = render(<SettingsPlaceholder />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe(
      'true'
    );
    // The busy dialog around it carries the name; the frame adds no second
    // "Settings" heading for a test or a screen reader to find early.
    expect(screen.queryByRole('heading')).toBe(null);
    expect(container.querySelector('button, a, input, [tabindex]')).toBe(null);
  });
});
