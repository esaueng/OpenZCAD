import { describe, expect, it } from 'vitest';
import {
  E2E_RENDER_PROFILE,
  FULL_RENDER_PROFILE,
  renderProfile
} from './renderProfile';

describe('renderProfile', () => {
  it('always renders in full outside e2e builds', () => {
    expect(renderProfile(false, undefined)).toBe(FULL_RENDER_PROFILE);
    expect(renderProfile(false, {})).toBe(FULL_RENDER_PROFILE);
    expect(renderProfile(false, { __ozFullRender: false })).toBe(
      FULL_RENDER_PROFILE
    );
  });

  it('drops antialiasing, shadows and the environment map in e2e builds', () => {
    expect(renderProfile(true, {})).toBe(E2E_RENDER_PROFILE);
    expect(renderProfile(true, undefined)).toBe(E2E_RENDER_PROFILE);
    expect(E2E_RENDER_PROFILE).toEqual({
      antialias: false,
      shadows: false,
      environment: false
    });
  });

  it('renders in full in an e2e build only on an explicit true opt-in', () => {
    expect(renderProfile(true, { __ozFullRender: true })).toBe(
      FULL_RENDER_PROFILE
    );
    expect(renderProfile(true, { __ozFullRender: 'true' })).toBe(
      E2E_RENDER_PROFILE
    );
    expect(renderProfile(true, { __ozFullRender: 1 })).toBe(E2E_RENDER_PROFILE);
  });
});
