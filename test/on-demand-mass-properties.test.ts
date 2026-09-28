import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addPrimitiveFeature,
  configureParameterToggle,
  createProjectDocument,
  listFeaturesInOrder,
  setParameter,
  updateFeature
} from '@openzcad/document-core';
import { createExactKernelAdapter } from '@openzcad/kernel-adapter/exact';
import { toUserId } from '@openzcad/shared';
import { RemusKernel } from '../packages/kernel-adapter/src/remus-runtime';

afterEach(() => vi.restoreAllMocks());

function boxDocument(name = 'Lazy mass') {
  return addPrimitiveFeature(
    createProjectDocument(name, toUserId('mass-test')),
    {
      name: 'Box',
      primitiveKind: 'box',
      dimensions: { width: 10, height: 12, depth: 14 }
    }
  );
}

describe('on-demand exact mass properties', () => {
  it('keeps parameter-hidden bodies unavailable in direct sync and history-only recovery', async () => {
    const adapter = await createExactKernelAdapter();
    const visible = boxDocument('Toggle mass');
    const bodyId = visible.bodyOrder[0]!;
    const toggled = configureParameterToggle(visible, {
      name: 'show_box',
      bodyIds: [bodyId]
    });
    const hidden = setParameter(toggled, {
      name: 'show_box',
      expression: '0'
    });
    try {
      const derived = await adapter.syncDocument(hidden);
      expect(derived.bodyRepresentations[bodyId]).toBeDefined();
      expect(derived.exportableBodyIds).not.toContain(bodyId);
      const direct = adapter.readCurrentMassProperties({
        projectId: hidden.projectId,
        version: hidden.version,
        bodyId,
        epoch: adapter.currentMassPropertiesEpoch()!
      });
      expect(direct).toMatchObject({ status: 'unavailable', code: 'unsupported' });

      const recoveredEpoch = await adapter.prepareMassPropertiesForDocument(hidden);
      const recovered = adapter.readCurrentMassProperties({
        projectId: hidden.projectId,
        version: hidden.version,
        bodyId,
        epoch: recoveredEpoch
      });
      expect(recovered).toMatchObject({ status: 'unavailable', code: 'unsupported' });

      const revealed = setParameter(hidden, {
        name: 'show_box',
        expression: '1'
      });
      await adapter.syncDocument(revealed);
      expect(adapter.readCurrentMassProperties({
        projectId: revealed.projectId,
        version: revealed.version,
        bodyId,
        epoch: adapter.currentMassPropertiesEpoch()!
      }).status).toBe('ready');
    } finally {
      adapter.dispose();
    }
  });
  it('does not integrate moments during sync and caches one query per live body', async () => {
    const mass = vi.spyOn(RemusKernel.prototype, 'massProperties');
    const adapter = await createExactKernelAdapter();
    const document = boxDocument();
    const bodyId = document.bodyOrder[0]!;
    try {
      const derived = await adapter.syncDocument(document);
      expect(derived.bodyRepresentations[bodyId]!.volume).toBe(1680);
      expect(derived.bodyRepresentations[bodyId]!.massProperties).toBeUndefined();
      expect(mass).not.toHaveBeenCalled();

      const epoch = adapter.currentMassPropertiesEpoch()!;
      const input = { projectId: document.projectId, version: document.version, bodyId, epoch };
      const first = adapter.readCurrentMassProperties(input);
      expect(first.status).toBe('ready');
      expect(adapter.readCurrentMassProperties(input)).toEqual(first);
      expect(mass).toHaveBeenCalledTimes(1);

      const feature = listFeaturesInOrder(document)[0]!;
      const edited = updateFeature(document, {
        featureId: feature.featureId,
        data: { dimensions: { width: 11, height: 12, depth: 14 } }
      });
      await adapter.syncDocument(edited);
      expect(adapter.readCurrentMassProperties(input).status).toBe('unavailable');
      const changed = adapter.readCurrentMassProperties({
        projectId: edited.projectId,
        version: edited.version,
        bodyId,
        epoch: adapter.currentMassPropertiesEpoch()!
      });
      expect(changed.status).toBe('ready');
      if (first.status === 'ready' && changed.status === 'ready') {
        expect(changed.properties).not.toEqual(first.properties);
      }
      expect(mass).toHaveBeenCalledTimes(2);
    } finally {
      adapter.dispose();
    }
  });

  it('recovers an older document or post-export query by rebuilding only exact history', async () => {
    const mass = vi.spyOn(RemusKernel.prototype, 'massProperties');
    const adapter = await createExactKernelAdapter();
    const original = boxDocument();
    const bodyId = original.bodyOrder[0]!;
    try {
      await adapter.syncDocument(original);
      const originalEpoch = adapter.currentMassPropertiesEpoch()!;
      const feature = listFeaturesInOrder(original)[0]!;
      const edited = updateFeature(original, {
        featureId: feature.featureId,
        data: { dimensions: { width: 20, height: 12, depth: 14 } }
      });
      await adapter.syncDocument(edited);
      const restoredEpoch = await adapter.prepareMassPropertiesForDocument(original);
      expect(restoredEpoch).not.toBe(originalEpoch);
      const restored = adapter.readCurrentMassProperties({
        projectId: original.projectId,
        version: original.version,
        bodyId,
        epoch: restoredEpoch
      });
      expect(restored.status).toBe('ready');
      expect(mass).toHaveBeenCalledTimes(1);

      await adapter.exportStep(original, [bodyId]);
      expect(adapter.currentMassPropertiesEpoch()).toBeNull();
      expect(adapter.readCurrentMassProperties({
        projectId: original.projectId,
        version: original.version,
        bodyId,
        epoch: restoredEpoch
      }).status).toBe('unavailable');
      const afterExportEpoch = await adapter.prepareMassPropertiesForDocument(original);
      expect(adapter.readCurrentMassProperties({
        projectId: original.projectId,
        version: original.version,
        bodyId,
        epoch: afterExportEpoch
      }).status).toBe('ready');
      expect(mass).toHaveBeenCalledTimes(2);
    } finally {
      adapter.dispose();
    }
  });

  it('rejects retired epochs and project identities', async () => {
    const adapter = await createExactKernelAdapter();
    const first = boxDocument('First project');
    const second = boxDocument('Second project');
    const bodyId = first.bodyOrder[0]!;
    await adapter.syncDocument(first);
    const staleEpoch = adapter.currentMassPropertiesEpoch()!;
    await adapter.syncDocument(second);
    expect(adapter.readCurrentMassProperties({
      projectId: first.projectId,
      version: first.version,
      bodyId,
      epoch: staleEpoch
    }).status).toBe('unavailable');
    adapter.dispose();
    expect(adapter.readCurrentMassProperties({
      projectId: second.projectId,
      version: second.version,
      bodyId: second.bodyOrder[0]!,
      epoch: staleEpoch
    }).status).toBe('unavailable');
  });
});
