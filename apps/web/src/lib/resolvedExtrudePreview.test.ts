import { describe, expect, it } from 'vitest';
import { commandFactories } from '@openzcad/command-system';
import { createProjectDocument } from '@openzcad/document-core';
import { toBodyId, toSketchId, toUserId } from '@openzcad/shared';
import type {
  ResolveExtrudeOptions,
  ResolvedExtrude
} from './extrudeInference';
import {
  resolvedExtrudePreviewKey,
  reuseResolvedExtrudePreview,
  reuseRunningExtrudePreview
} from './resolvedExtrudePreview';

const base = createProjectDocument('Extrude', toUserId('user_preview'));
const options: Omit<ResolveExtrudeOptions, 'derive'> = {
  base,
  input: {
    name: 'Boss',
    sketchId: toSketchId('sketch_1'),
    distance: 5,
    symmetric: false,
    backDistance: 0
  },
  choice: { operation: 'new-body' }
};
const command = commandFactories.extrudeSketch(options.input);
const resolved: ResolvedExtrude = {
  command,
  document: base,
  derived: base.derived,
  inference: { operation: 'new-body', reason: 'explicit', tolerance: 1e-7 },
  baseVersion: base.version
};
const preview = {
  baseProjectId: base.projectId,
  baseVersion: base.version,
  key: resolvedExtrudePreviewKey({ ...options, input: command.payload }),
  resolved
};

describe('resolved extrusion preview reuse', () => {
  it('keeps the exact preview command and its reserved IDs on a matching commit', () => {
    const reused = reuseResolvedExtrudePreview(preview, options);
    expect(reused).toBe(resolved);
    expect(reused?.command).toBe(command);
    expect(reused?.command.payload.ids).toBe(command.payload.ids);
    expect(command.payload.ids?.bodyId).toBeTruthy();
  });

  it('rejects changed geometry, expression intent, or boolean target', () => {
    for (const input of [
      { ...options.input, distance: 6 },
      { ...options.input, distance: '2 + 3' },
      { ...options.input, symmetric: true },
      { ...options.input, backDistance: 1 },
      { ...options.input, sketchId: toSketchId('sketch_2') }
    ]) {
      expect(
        reuseResolvedExtrudePreview(preview, { ...options, input })
      ).toBeNull();
    }
    expect(
      reuseResolvedExtrudePreview(preview, {
        ...options,
        choice: { operation: 'cut', targetBodyId: toBodyId('body_1') }
      })
    ).toBeNull();
    expect(
      reuseResolvedExtrudePreview(preview, {
        ...options,
        faceAttachment: { bodyId: toBodyId('body_1'), direction: 'into' }
      })
    ).toBeNull();
  });

  it('rejects stale documents and absent previews', () => {
    expect(reuseResolvedExtrudePreview(null, options)).toBeNull();
    expect(
      reuseResolvedExtrudePreview(preview, {
        ...options,
        base: { ...base, version: base.version + 1 }
      })
    ).toBeNull();
    expect(
      reuseResolvedExtrudePreview(preview, {
        ...options,
        base: createProjectDocument('Other', toUserId('user_preview'))
      })
    ).toBeNull();
  });
});

describe('running extrusion preview reuse', () => {
  const running = (
    result: Promise<{ resolved: ResolvedExtrude; rejection: unknown }>,
    input = command.payload
  ) => ({
    document: {
      ...options,
      input,
      baseProjectId: base.projectId,
      baseVersion: base.version
    },
    result
  });

  it('awaits the frame still rebuilding this exact extrusion', async () => {
    let finish!: (value: {
      resolved: ResolvedExtrude;
      rejection: null;
    }) => void;
    const frame = running(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const reused = reuseRunningExtrudePreview(frame, options);
    finish({ resolved, rejection: null });
    await expect(reused).resolves.toBe(resolved);
  });

  it('does not wait for a frame rebuilding another extrusion', async () => {
    // Never settles: answering null must not depend on it.
    const frame = running(new Promise(() => undefined), {
      ...command.payload,
      distance: 6
    });
    await expect(reuseRunningExtrudePreview(frame, options)).resolves.toBe(
      null
    );
    await expect(
      reuseRunningExtrudePreview(running(new Promise(() => undefined)), {
        ...options,
        base: { ...base, version: base.version + 1 }
      })
    ).resolves.toBeNull();
    await expect(reuseRunningExtrudePreview(null, options)).resolves.toBeNull();
  });

  it('leaves a refused or failed frame to the commit to resolve itself', async () => {
    await expect(
      reuseRunningExtrudePreview(
        running(
          Promise.resolve({ resolved, rejection: { message: 'refused' } })
        ),
        options
      )
    ).resolves.toBeNull();
    await expect(
      reuseRunningExtrudePreview(
        running(Promise.reject(new Error('worker failed'))),
        options
      )
    ).resolves.toBeNull();
  });
});
