import { describe, expect, it } from 'vitest';
import {
  describeFailure,
  describeProjectImportFailure,
  describeShaprImportFailure,
  describeShareOpenFailure,
  unsupportedImportMessage,
  OFFLINE_FAILURE_MESSAGE,
  SERVER_FAILURE_MESSAGE,
  UNREACHABLE_FAILURE_MESSAGE,
  UNREADABLE_REPLY_MESSAGE
} from './plainFailure';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const fallback = 'Could not do that.';

describe('describeFailure', () => {
  it('says offline or unreachable for a fetch that got no answer', () => {
    const fetchFailed = new TypeError('Failed to fetch');
    expect(describeFailure(fetchFailed, { fallback, online: false })).toEqual({
      kind: 'offline',
      message: OFFLINE_FAILURE_MESSAGE,
      detail: 'Failed to fetch'
    });
    expect(
      describeFailure(new TypeError('Load failed'), { fallback, online: true })
    ).toMatchObject({
      kind: 'unreachable',
      message: UNREACHABLE_FAILURE_MESSAGE
    });
  });

  it('never blames the connection for a server failure', () => {
    const plain = describeFailure(new HttpError(500, 'Internal error'), {
      fallback
    });
    expect(plain).toEqual({
      kind: 'server',
      message: SERVER_FAILURE_MESSAGE,
      detail: '500: Internal error'
    });
    expect(plain.message).not.toMatch(/connection/i);
  });

  it('keeps parser text out of the message', () => {
    const parse = new SyntaxError(
      `Unexpected token '<', "<!doctype "... is not valid JSON`
    );
    const plain = describeFailure(parse, { fallback });
    expect(plain.kind).toBe('unreadable');
    expect(plain.message).toBe(UNREADABLE_REPLY_MESSAGE);
    expect(plain.detail).toContain('is not valid JSON');
    expect(
      describeFailure(new HttpError(404, '<!doctype html><title>x</title>'), {
        fallback
      }).message
    ).toBe(UNREADABLE_REPLY_MESSAGE);
  });

  it('passes a server refusal written for users through as it is', () => {
    expect(
      describeFailure(new HttpError(403, 'This link was revoked.'), {
        fallback
      })
    ).toEqual({ kind: 'refused', message: 'This link was revoked.' });
  });

  it('leads with the fallback for technical text, keeping it as detail', () => {
    expect(
      describeFailure(new Error('circular trim ray-event'), {
        fallback,
        technical: true
      })
    ).toEqual({
      kind: 'other',
      message: fallback,
      detail: 'circular trim ray-event'
    });
    expect(describeFailure({}, { fallback })).toEqual({
      kind: 'other',
      message: fallback
    });
  });

  it('shortens a long raw reply', () => {
    const plain = describeFailure(
      new HttpError(502, `<html>${'x'.repeat(2000)}</html>`),
      { fallback }
    );
    expect(plain.detail!.length).toBeLessThan(320);
  });
});

describe('describeProjectImportFailure', () => {
  const jsonError = (token: string) =>
    new SyntaxError(`Unexpected token '${token}', "…" is not valid JSON`);

  it('names a STEP file and points to Import CAD files', async () => {
    const file = new File(['ISO-10303-21;\nHEADER;'], 'bracket.txt');
    const plain = await describeProjectImportFailure(jsonError('I'), file);
    expect(plain.message).toBe(
      'This is a STEP file, not an OpenZCAD project backup. Open a project and use Import CAD files to bring it in.'
    );
    expect(plain.detail).toContain('is not valid JSON');
  });

  it('names an STL mesh by its content or its name', async () => {
    for (const file of [
      new File(['solid x\nendsolid x\n'], 'part'),
      new File([new Uint8Array(84)], 'part.STL')
    ]) {
      expect(
        (await describeProjectImportFailure(jsonError('s'), file)).message
      ).toMatch(/^This is an STL mesh, not an OpenZCAD project backup\./);
    }
  });

  it('calls a damaged backup damaged, not a parser error', async () => {
    const file = new File(['{"format":"openz'], 'Bracket.openzcad');
    const plain = await describeProjectImportFailure(jsonError('h'), file);
    expect(plain.message).toBe(
      'Bracket.openzcad is not a readable OpenZCAD project backup. It may be damaged or incomplete.'
    );
  });
});

describe('describeShaprImportFailure', () => {
  it('says a broken archive is damaged, keeping the reader text as detail', () => {
    const plain = describeShaprImportFailure(
      new Error('SHAPR archive has no valid ZIP central directory.')
    );
    expect(plain.message).toMatch(/^This \.shapr file could not be read\./);
    expect(plain.detail).toBe(
      'SHAPR archive has no valid ZIP central directory.'
    );
  });

  it('says an oversized archive is too large', () => {
    expect(
      describeShaprImportFailure(
        new Error('SHAPR archive exceeds the 256 MB import limit.')
      ).message
    ).toMatch(/larger than OpenZCAD can import/);
  });
});

describe('describeShareOpenFailure', () => {
  it('does not send the visitor after the connection for a 500', () => {
    const failure = describeShareOpenFailure(
      new HttpError(500, 'Internal error'),
      null,
      true
    );
    expect(failure.message).toBe(SERVER_FAILURE_MESSAGE);
    expect(failure.guidance).toMatch(/not a problem with your connection/);
    expect(failure.detail).toBe('500: Internal error');
  });

  it('says offline instead of "Failed to fetch"', () => {
    const failure = describeShareOpenFailure(
      new TypeError('Failed to fetch'),
      null,
      false
    );
    expect(failure.message).toBe(OFFLINE_FAILURE_MESSAGE);
    expect(failure.detail).toBe('Failed to fetch');
  });

  it('uses the loader wording for a refusal', () => {
    const failure = describeShareOpenFailure(
      new Error('signature mismatch'),
      () => 'This link’s files could not be verified.',
      true
    );
    expect(failure.message).toBe('This link’s files could not be verified.');
  });
});

describe('unsupportedImportMessage', () => {
  it('lists what imports and gives FreeCAD its way out', () => {
    expect(unsupportedImportMessage('model.FCStd')).toBe(
      'OpenZCAD can’t import .FCStd files. It imports STEP, STL, 3MF, OBJ, GLB, PLY, DXF, or a .shapr + STEP pair. In FreeCAD, use File › Export to save it as STEP first.'
    );
    expect(unsupportedImportMessage('notes.txt')).toMatch(
      /^OpenZCAD can’t import \.txt files\. It imports STEP,.*pair\.$/
    );
  });
});
