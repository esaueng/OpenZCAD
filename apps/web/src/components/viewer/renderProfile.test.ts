import { describe, expect, it } from 'vitest';
import {
  E2E_RENDER_PROFILE,
  FULL_RENDER_PROFILE,
  ambientOcclusionEnabled,
  renderProfile
} from './renderProfile';

const PRODUCTION = { e2e: false, fullRender: false };
const E2E = { e2e: true, fullRender: false };
const E2E_FULL = { e2e: true, fullRender: true };

describe('renderProfile', () => {
  it('always renders in full outside e2e builds', () => {
    expect(renderProfile(PRODUCTION, undefined)).toBe(FULL_RENDER_PROFILE);
    expect(renderProfile(PRODUCTION, {})).toBe(FULL_RENDER_PROFILE);
    expect(renderProfile(PRODUCTION, { __ozFullRender: false })).toBe(
      FULL_RENDER_PROFILE
    );
  });

  it('drops antialiasing, shadows and the environment map in e2e builds', () => {
    expect(renderProfile(E2E, {})).toBe(E2E_RENDER_PROFILE);
    expect(renderProfile(E2E, undefined)).toBe(E2E_RENDER_PROFILE);
    expect(E2E_RENDER_PROFILE).toEqual({
      antialias: false,
      shadows: false,
      environment: false,
      ambientOcclusion: false
    });
  });

  it('renders in full in an e2e build only on an explicit true opt-in', () => {
    expect(renderProfile(E2E, { __ozFullRender: true })).toBe(
      FULL_RENDER_PROFILE
    );
    expect(renderProfile(E2E, { __ozFullRender: 'true' })).toBe(
      E2E_RENDER_PROFILE
    );
    expect(renderProfile(E2E, { __ozFullRender: 1 })).toBe(E2E_RENDER_PROFILE);
  });

  it('renders in full for perf and capture builds without a page opt-in', () => {
    expect(renderProfile(E2E_FULL, undefined)).toBe(FULL_RENDER_PROFILE);
    expect(renderProfile(E2E_FULL, {})).toBe(FULL_RENDER_PROFILE);
  });

  it('computes ambient occlusion only in full renders, when switched on and not opted out', () => {
    expect(ambientOcclusionEnabled(FULL_RENDER_PROFILE, true, undefined)).toBe(
      true
    );
    expect(ambientOcclusionEnabled(FULL_RENDER_PROFILE, true, {})).toBe(true);
    expect(
      ambientOcclusionEnabled(FULL_RENDER_PROFILE, true, {
        __ozAmbientOcclusion: false
      })
    ).toBe(false);
    expect(ambientOcclusionEnabled(FULL_RENDER_PROFILE, false, {})).toBe(false);
    expect(ambientOcclusionEnabled(E2E_RENDER_PROFILE, true, {})).toBe(false);
  });
});
