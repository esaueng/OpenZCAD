import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectDocument } from '@openzcad/shared';
import { qualifyFreecadStep } from './freecadExactQualification';
const adapter = vi.hoisted(() => ({
  inspectStep: vi.fn(),
  syncDocument: vi.fn(),
  exportStep: vi.fn(),
  dispose: vi.fn()
}));
vi.mock('@openzcad/kernel-adapter/exact', () => ({
  createExactKernelAdapter: async () => adapter
}));
afterEach(() => vi.resetAllMocks());

it('refuses reader incompatibility and disposes without attempting a rebuild', async () => {
  adapter.inspectStep.mockResolvedValue({
    valid: false,
    solidIndices: [],
    reason: 'surface curve cannot be certified'
  });
  await expect(qualifyFreecadStep('STEP', 1, 'mm')).rejects.toThrow(
    /surface curve cannot be certified/
  );
  expect(adapter.syncDocument).not.toHaveBeenCalled();
  expect(adapter.dispose).toHaveBeenCalledOnce();
});
it('refuses missing roots, rebuild warnings, export errors and roundtrip failures', async () => {
  adapter.inspectStep.mockResolvedValue({ valid: true, solidIndices: [0] });
  await expect(qualifyFreecadStep('STEP', 2, 'mm')).rejects.toThrow(
    /solid validation/
  );
  adapter.syncDocument.mockResolvedValue({
    warnings: ['invalid geometry'],
    bodyRepresentations: {}
  });
  await expect(qualifyFreecadStep('STEP', 1, 'mm')).rejects.toThrow(
    /invalid geometry/
  );
  adapter.syncDocument.mockResolvedValue({
    warnings: [],
    bodyRepresentations: { body: {} }
  });
  adapter.exportStep.mockRejectedValueOnce(
    new Error('pcurve endpoint misses vertex')
  );
  await expect(qualifyFreecadStep('STEP', 1, 'inch')).rejects.toThrow(
    /pcurve endpoint/
  );
  adapter.exportStep.mockResolvedValue('exported STEP');
  adapter.inspectStep
    .mockResolvedValueOnce({ valid: true, solidIndices: [0] })
    .mockResolvedValueOnce({ valid: false, solidIndices: [] });
  await expect(qualifyFreecadStep('STEP', 1, 'mm')).rejects.toThrow(
    /round-trip/
  );
  expect(adapter.dispose).toHaveBeenCalledTimes(4);
});
it('qualifies in the target document units and preserves the source', async () => {
  adapter.inspectStep.mockResolvedValue({ valid: true, solidIndices: [0, 1] });
  adapter.syncDocument.mockResolvedValue({
    warnings: [],
    bodyRepresentations: { body: {} }
  });
  adapter.exportStep.mockResolvedValue('exported STEP');
  await expect(
    qualifyFreecadStep('original STEP', 2, 'inch')
  ).resolves.toBeUndefined();
  const document = adapter.syncDocument.mock.calls[0]![0] as ProjectDocument;
  expect(document.units).toBe('inch');
  const feature = Object.values(document.nodes).find(
    (node) => node.kind === 'feature'
  );
  expect(feature?.data).toMatchObject({ stepText: 'original STEP' });
  expect(adapter.inspectStep).toHaveBeenLastCalledWith('exported STEP');
  expect(adapter.dispose).toHaveBeenCalledOnce();
});
