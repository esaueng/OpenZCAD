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
  reuseResolvedExtrudePreview
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
