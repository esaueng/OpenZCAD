import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PROJECT_FORMAT_UNSUPPORTED_CODE,
  PROJECT_FORMAT_UNSUPPORTED_MESSAGE
} from '@openzcad/shared';
import {
  api,
  isProjectDocumentUnavailableError,
  isProjectFormatUnsupportedError
} from './api';
import { desktopFetch } from './desktopBridge';

vi.mock('./desktopBridge', () => ({ desktopFetch: vi.fn() }));
afterEach(() => vi.clearAllMocks());

/**
 * ADR-024 Phase 4: the Worker refuses an end-to-end encrypted project with
 * 409 PROJECT_FORMAT_UNSUPPORTED. The browser reports it in its own words,
 * and not as an unreadable account copy that would invite repair.
 */
describe('loads of a project in an unsupported storage format', () => {
  it.each(['project', 'revision'] as const)(
    'report a %s refusal with an update message',
    async (kind) => {
      vi.mocked(desktopFetch).mockResolvedValue(
        new Response(
          JSON.stringify({
            error: 'Some older wording.',
            code: PROJECT_FORMAT_UNSUPPORTED_CODE
          }),
          { status: 409, headers: { 'content-type': 'application/json' } }
        )
      );
      const load =
        kind === 'project'
          ? api.loadProject('proj_encrypted')
          : api.loadRevision('proj_encrypted', 'rev_1');
      const error = await load.then(
        () => null,
        (caught: unknown) => caught
      );
      expect(isProjectFormatUnsupportedError(error)).toBe(true);
      expect(isProjectDocumentUnavailableError(error)).toBe(false);
      expect((error as Error).message).toBe(PROJECT_FORMAT_UNSUPPORTED_MESSAGE);
      expect(PROJECT_FORMAT_UNSUPPORTED_MESSAGE).toBe(
        'This project is end-to-end encrypted. Update OpenZCAD to open it.'
      );
    }
  );

  it('leaves other refusals as they were', async () => {
    vi.mocked(desktopFetch).mockResolvedValue(
      new Response(JSON.stringify({ error: 'Conflict', code: 'OTHER' }), {
        status: 409
      })
    );
    const error = await api.loadProject('proj_x').then(
      () => null,
      (caught: unknown) => caught
    );
    expect(isProjectFormatUnsupportedError(error)).toBe(false);
    expect((error as Error).message).toBe('Conflict');
  });
});
