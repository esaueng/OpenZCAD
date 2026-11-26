import { describe, expect, it, vi } from 'vitest';
import {
  listedStoredFiles,
  projectCommentsOffered,
  projectSharingEntry,
  projectSharingOffered
} from './projectMenuGates';

describe('project menu gates', () => {
  const entry = (
    overrides: Partial<Parameters<typeof projectSharingEntry>[0]> = {}
  ) =>
    projectSharingEntry({
      sharingAvailable: true,
      shareSession: null,
      signedIn: true,
      onOpenSharing: vi.fn(),
      onSignIn: vi.fn(),
      ...overrides
    });

  it('offers sharing to the project’s own session', () => {
    expect(entry()?.label).toBe('Share');
    expect(entry({ signedIn: false })?.label).toBe('Sign in to share');
  });

  it('never offers sharing on a share link, signed in or out', () => {
    for (const shareSession of [
      { mode: 'view' },
      { mode: 'tweak' },
      { mode: 'view', comments: true }
    ]) {
      expect(
        projectSharingOffered({ sharingAvailable: true, shareSession })
      ).toBe(false);
      expect(entry({ shareSession })).toBeNull();
      expect(entry({ shareSession, signedIn: false })).toBeNull();
    }
  });

  it('withholds sharing where cloud features or the preference are off', () => {
    expect(entry({ sharingAvailable: false })).toBeNull();
    expect(entry({ sharingAvailable: false, signedIn: false })).toBeNull();
  });

  it('offers comments except on a link that does not take them', () => {
    expect(projectCommentsOffered(null)).toBe(true);
    expect(projectCommentsOffered({ comments: true })).toBe(true);
    expect(projectCommentsOffered({})).toBe(false);
    expect(projectCommentsOffered({ comments: false })).toBe(false);
  });

  it('lists the files someone picked or exported, not internal payloads', () => {
    expect(
      listedStoredFiles([
        { kind: 'step-import' },
        { kind: 'mesh-payload' },
        { kind: 'reference-image' },
        { kind: 'export' }
      ]).map((file) => file.kind)
    ).toEqual(['step-import', 'export']);
  });
});
