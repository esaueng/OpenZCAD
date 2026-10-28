import { describe, expect, it, vi } from 'vitest';
import { verifyShelfEntries } from './progressiveShelf';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('progressive encrypted shelf verification', () => {
  it('publishes verified cards while a sibling is held and bounds a 150-project library', async () => {
    const gates = Array.from({ length: 150 }, () => deferred<string>());
    const verify = vi.fn((index: number) => gates[index]!.promise);
    const publish = vi.fn();
    const work = verifyShelfEntries(
      gates.map((_, i) => i),
      verify,
      publish,
      () => true
    );
    expect(verify).toHaveBeenCalledTimes(4);
    gates[1]!.resolve('Verified part 1');
    await vi.waitFor(() =>
      expect(publish).toHaveBeenCalledWith(1, 'Verified part 1')
    );
    expect(publish).not.toHaveBeenCalledWith(0, expect.anything());
    expect(verify).toHaveBeenCalledTimes(5);
    gates.forEach((gate, i) => gate.resolve(`Verified part ${i}`));
    await work;
    expect(publish).toHaveBeenCalledTimes(150);
  });

  it('never publishes a rejected envelope and continues with the remaining cards', async () => {
    const publish = vi.fn();
    await verifyShelfEntries(
      [0, 1, 2],
      async (index) => {
        if (index === 1) throw new Error('Signature or rollback check failed');
        return `Verified ${index}`;
      },
      publish,
      () => true
    );
    expect(publish.mock.calls).toEqual([
      [0, 'Verified 0'],
      [2, 'Verified 2']
    ]);
  });

  it('drops in-flight results and stops scheduling when the account/key session ends', async () => {
    let current = true;
    const gate = deferred<string>();
    const verify = vi.fn(() => gate.promise);
    const publish = vi.fn();
    const work = verifyShelfEntries(
      Array.from({ length: 150 }, (_, i) => i),
      verify,
      publish,
      () => current
    );
    current = false;
    gate.resolve('Former account name');
    await work;
    expect(verify).toHaveBeenCalledTimes(4);
    expect(publish).not.toHaveBeenCalled();
  });
});
