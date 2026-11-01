import { describe, expect, it } from 'vitest';
import {
  addPrimitiveFeature,
  createProjectDocument,
  listFeaturesInOrder
} from '@openzcad/document-core';
import { toUserId } from '@openzcad/shared';
import {
  localHistoryAppend,
  retainLocalHistoryAppend
} from './localHistoryAppend';

const box = (doc: ReturnType<typeof createProjectDocument>, name: string) =>
  addPrimitiveFeature(doc, {
    name,
    primitiveKind: 'box',
    dimensions: { width: 10, height: 10, depth: 10 }
  });
describe('local history append', () => {
  it('names the actual newest created operation rather than an older publisher', () => {
    const before = box(
      createProjectDocument('History', toUserId('user_history')),
      'Original'
    );
    const after = box(box(before, 'Second'), 'Third');
    expect(localHistoryAppend(before, after)).toEqual({
      projectId: after.projectId,
      nodeId: listFeaturesInOrder(after).at(-1)!.id,
      version: after.version
    });
  });
  it('does not announce a rename, unchanged document, removal or another project', () => {
    const before = box(
      createProjectDocument('History', toUserId('user_history')),
      'Original'
    );
    expect(localHistoryAppend(before, before)).toBeNull();
    expect(
      localHistoryAppend(before, {
        ...before,
        featureOrder: [...before.featureOrder]
      })
    ).toBeNull();
    expect(
      localHistoryAppend(before, {
        ...before,
        name: 'Renamed',
        version: before.version + 1
      })
    ).toBeNull();
    expect(
      localHistoryAppend(before, { ...before, featureOrder: [] })
    ).toBeNull();
    expect(
      localHistoryAppend(
        before,
        box(
          createProjectDocument('Other', toUserId('user_history')),
          'Other box'
        )
      )
    ).toBeNull();
  });
  it('retains the actual local target across peer appends and clears another project or an undone target', () => {
    const before = box(
      createProjectDocument('History', toUserId('user_history')),
      'Original'
    );
    const after = box(before, 'Local');
    const signal = localHistoryAppend(before, after)!;
    const peer = box(after, 'Remote');
    expect(retainLocalHistoryAppend(signal, peer)).toBe(signal);
    expect(retainLocalHistoryAppend(signal, before)).toBeNull();
    expect(
      retainLocalHistoryAppend(signal, {
        ...after,
        projectId: createProjectDocument('Fork', toUserId('user_history'))
          .projectId
      })
    ).toBeNull();
  });
});
