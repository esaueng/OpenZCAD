import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { benchmarkStepInput } from './support/benchmarkStepInput';

it('retains the imported STEP identity when the source file changes during a run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'h02-step-input-'));
  try {
    const path = join(directory, 'public-fixture.step');
    const firstBytes = Buffer.from('ISO-10303-21; public fixture A');
    const secondBytes = Buffer.from('ISO-10303-21; public fixture B');
    await writeFile(path, firstBytes);
    const firstInput = await benchmarkStepInput(path);
    // Simulate an edit while the disabled arm is still running, before the
    // enabled arm imports the same pathname.
    await writeFile(path, secondBytes);
    const secondInput = await benchmarkStepInput(path);
    expect(firstInput.buffer).toEqual(firstBytes);
    expect(secondInput.buffer).toEqual(secondBytes);
    expect(firstInput.sha256).toBe(
      createHash('sha256').update(firstInput.buffer).digest('hex')
    );
    expect(secondInput.sha256).toBe(
      createHash('sha256').update(secondInput.buffer).digest('hex')
    );
    expect(firstInput.sha256).not.toBe(secondInput.sha256);
    expect(firstInput.name).toBe('public-fixture.step');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('hashes generated STEP bytes without rereading a file', async () => {
  const buffer = Buffer.from('ISO-10303-21; generated public fixture');
  const input = await benchmarkStepInput({ name: 'generated.step', buffer });
  expect(input.buffer).toBe(buffer);
  expect(input.sha256).toBe(createHash('sha256').update(buffer).digest('hex'));
});
