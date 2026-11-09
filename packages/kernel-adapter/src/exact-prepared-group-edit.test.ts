import { describe, it, expect, vi } from 'vitest';
import type { RemusKernel } from './remus-runtime';
import {
  preparedGroupEdit,
  releasePreparedGroupEdit,
  hasPreparedGroupEdit,
  preparedCommitNeedsEvolution
} from './exact-prepared-group-edit';
function fake() {
  const api = {
    prepareResizeBlend: vi.fn(() => 7),
    prepareResizeCylindricalFace: vi.fn(() => 8),
    previewPreparedGroupEdit: vi.fn(() => 20),
    commitPreparedGroupEditJournaled: vi.fn(() => '{"solid":21}'),
    releasePreparedGroupEdit: vi.fn(() => true)
  };
  return { api, kernel: api as unknown as RemusKernel };
}
describe('prepared group lifecycle', () => {
  it('retains construction roles and never promotes inferred journal history', () => {
    const kernel = {
      journalSummary: () =>
        JSON.stringify([
          { op: 1, detail: { origin: 'geometry' } },
          { op: 2, detail: { origin: 'construction' } }
        ])
    } as unknown as RemusKernel;
    expect(preparedCommitNeedsEvolution(kernel, 1)).toBe(false);
    expect(preparedCommitNeedsEvolution(kernel, 2)).toBe(true);
    expect(preparedCommitNeedsEvolution(kernel, 3)).toBe(true);
  });
  it('keeps old kernels on existing paths', () =>
    expect(
      preparedGroupEdit({} as RemusKernel, 1, 2, 'blend', 4, true)
    ).toBeNull());
  it('prepares once, streams radii, commits canonically and releases once', () => {
    const { api, kernel } = fake();
    preparedGroupEdit(kernel, 1, 2, 'blend', 4, true)!.preview(1.5);
    preparedGroupEdit(kernel, 1, 2, 'blend', 4, true)!.preview(1.9);
    preparedGroupEdit(kernel, 1, 2, 'blend', 4, false)!.commit(1.9);
    expect(api.prepareResizeBlend).toHaveBeenCalledTimes(1);
    expect(api.previewPreparedGroupEdit.mock.calls).toEqual([
      [7, 1.5],
      [7, 1.9]
    ]);
    expect(api.commitPreparedGroupEditJournaled).toHaveBeenCalledWith(7, 1.9);
    releasePreparedGroupEdit(kernel);
    releasePreparedGroupEdit(kernel);
    expect(api.releasePreparedGroupEdit).toHaveBeenCalledTimes(1);
    expect(hasPreparedGroupEdit(kernel)).toBe(false);
  });
  it('releases on target change and passes a radius to boss preparation', () => {
    const { api, kernel } = fake();
    preparedGroupEdit(kernel, 1, 2, 'blend', 4, true);
    preparedGroupEdit(kernel, 1, 3, 'cylinder', 6, true)!.preview(7.3);
    expect(api.releasePreparedGroupEdit).toHaveBeenCalledWith(7);
    expect(api.previewPreparedGroupEdit).toHaveBeenCalledWith(8, 7.3);
  });
  it('remembers refusal for this source and allows the unprepared route', () => {
    const { api, kernel } = fake();
    api.prepareResizeBlend.mockImplementation(() => {
      throw new Error('blend-cluster-not-prepared');
    });
    expect(preparedGroupEdit(kernel, 1, 2, 'blend', 4, true)).toBeNull();
    expect(preparedGroupEdit(kernel, 1, 2, 'blend', 4, true)).toBeNull();
    expect(api.prepareResizeBlend).toHaveBeenCalledTimes(1);
    expect(hasPreparedGroupEdit(kernel)).toBe(false);
  });
});
