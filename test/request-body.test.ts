import { describe, expect, it } from 'vitest';
import {
  readBoundedRequestBytes,
  readBoundedRequestText
} from '../apps/web/worker/requestBody';

const tooLarge = () => {
  throw new Error('route-specific 413');
};

function streamed(bytes: Uint8Array, chunkSize = 2, rejectCancel = false) {
  const state = { offset: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (state.offset === bytes.length) controller.close();
        else {
          const end = Math.min(bytes.length, state.offset + chunkSize);
          controller.enqueue(bytes.slice(state.offset, end));
          state.offset = end;
        }
      },
      cancel() {
        state.cancelled = true;
        if (rejectCancel) throw new Error('transport cleanup failed');
      }
    },
    { highWaterMark: 0 }
  );
  const request = new Request('https://example.com/body', {
    method: 'POST',
    body,
    duplex: 'half'
  } as RequestInit);
  return { request, body, state };
}

describe('bounded request transport', () => {
  it('preserves Request.text UTF-8, BOM and split-codepoint behavior at the character ceiling', async () => {
    const bytes = new TextEncoder().encode('\ufeff雪😀');
    const { request, body } = streamed(bytes, 1);
    expect(await readBoundedRequestText(request, 3, tooLarge)).toBe('雪😀');
    expect(body.locked).toBe(false);
  });

  it('counts replacement characters from a final incomplete UTF-8 sequence', async () => {
    const bytes = Uint8Array.of(97, 0xe2, 0x82);
    const expected = await new Request('https://example.com', {
      method: 'POST',
      body: bytes
    }).text();
    const fits = streamed(bytes, 1);
    expect(await readBoundedRequestText(fits.request, 2, tooLarge)).toBe(
      expected
    );
    const overflow = streamed(bytes, 1);
    await expect(
      readBoundedRequestText(overflow.request, 1, tooLarge)
    ).rejects.toThrow('route-specific 413');
    expect(overflow.body.locked).toBe(false);
  });

  it('accepts Unicode whose transport bytes exceed the character ceiling', async () => {
    const text = JSON.stringify({ padding: '漢'.repeat(40_000) });
    const bytes = new TextEncoder().encode(text);
    expect(bytes.length).toBeGreaterThan(100_000);
    const { request } = streamed(bytes, 127);
    expect(await readBoundedRequestText(request, 100_000, tooLarge)).toBe(text);
  });

  it.each([false, true])(
    'refuses text overflow before an unread tail, despite cleanup rejection %s',
    async (rejectCancel) => {
      const { request, body, state } = streamed(
        new Uint8Array(100).fill(97),
        2,
        rejectCancel
      );
      await expect(
        readBoundedRequestText(request, 4, tooLarge)
      ).rejects.toThrow('route-specific 413');
      expect(state.offset).toBe(6);
      expect(state.cancelled).toBe(true);
      expect(body.locked).toBe(false);
    }
  );

  it('retains exact bytes at the frame ceiling, including arbitrary binary data', async () => {
    const bytes = Uint8Array.of(0, 255, 128, 0);
    const { request, body } = streamed(bytes, 1);
    expect(await readBoundedRequestBytes(request, 4, tooLarge)).toEqual(bytes);
    expect(body.locked).toBe(false);
  });

  it.each([false, true])(
    'refuses frame byte overflow before an unread tail, despite cleanup rejection %s',
    async (rejectCancel) => {
      const { request, body, state } = streamed(
        new Uint8Array(100),
        1,
        rejectCancel
      );
      await expect(
        readBoundedRequestBytes(request, 4, tooLarge)
      ).rejects.toThrow('route-specific 413');
      expect(state.offset).toBe(5);
      expect(state.cancelled).toBe(true);
      expect(body.locked).toBe(false);
    }
  );

  it('retains empty-body semantics for route-specific JSON and frame parsers', async () => {
    expect(
      await readBoundedRequestText(
        new Request('https://example.com'),
        4,
        tooLarge
      )
    ).toBe('');
    expect(
      await readBoundedRequestBytes(
        new Request('https://example.com'),
        4,
        tooLarge
      )
    ).toEqual(new Uint8Array());
  });

  it.each(['text', 'bytes'])(
    'retains transport failures and releases the %s reader',
    async (kind) => {
      const error = new Error('original transport failure');
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.error(error);
          }
        },
        { highWaterMark: 0 }
      );
      const request = new Request('https://example.com', {
        method: 'POST',
        body,
        duplex: 'half'
      } as RequestInit);
      const read =
        kind === 'text' ? readBoundedRequestText : readBoundedRequestBytes;
      await expect(read(request, 4, tooLarge)).rejects.toBe(error);
      expect(body.locked).toBe(false);
    }
  );
});
