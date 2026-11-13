import { describe, expect, it } from 'vitest';
import {
  FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY,
  FEATURE_SUPPRESSED_METADATA_KEY,
  toUserId,
  type BodyId,
  type FeatureId,
  type ProjectDocument
} from '@openzcad/shared';
import {
  addPrimitiveFeature,
  booleanBodies,
  chamferEdges,
  createBodyFeatureIds,
  createFeatureOnlyIds,
  createProjectDocument,
  directEditBody,
  filletEdges,
  historyForkMessage,
  historyForks,
  listFeaturesInOrder,
  mirrorBody,
  newHistoryForks,
  setNodeMetadata,
  transformBody
} from './index';

/**
 * ADR-025: two features that both replace the same body fork the history —
 * both build, so two overlapping lineages of one part are on screen. The
 * detector reads the document alone and names the later feature.
 */
describe('history fork detection', () => {
  function block(name: string, document?: ProjectDocument) {
    const ids = createBodyFeatureIds();
    return {
      document: addPrimitiveFeature(
        document ??
          createProjectDocument('Forks', toUserId('user_history_fork'), 'mm'),
        {
          name,
          bodyName: name,
          primitiveKind: 'box',
          dimensions: { width: 10, height: 10, depth: 10 },
          ids
        }
      ),
      bodyId: ids.bodyId,
      featureId: ids.featureId
    };
  }

  function fillet(document: ProjectDocument, name: string, target: BodyId) {
    const ids = createBodyFeatureIds();
    return {
      document: filletEdges(document, {
        name,
        targetBodyId: target,
        edgeHashes: [101],
        size: 1,
        ids
      }).document,
      ...ids
    };
  }

  function offset(document: ProjectDocument, name: string, target: BodyId) {
    const ids = createFeatureOnlyIds();
    return {
      document: directEditBody(document, {
        name,
        targetBodyId: target,
        operation: {
          kind: 'offset-face',
          faceHash: 7,
          sourceSurfaceType: 'plane',
          sourceArea: 100,
          sourceCenter: { x: 0, y: 0, z: 10 },
          sourceNormal: { x: 0, y: 0, z: 1 },
          offset: 1
        },
        ids
      }).document,
      ...ids
    };
  }

  function metadata(
    document: ProjectDocument,
    featureId: FeatureId,
    key: string
  ) {
    const node = listFeaturesInOrder(document).find(
      (feature) => feature.featureId === featureId
    )!;
    return setNodeMetadata(document, {
      nodeId: node.id,
      metadata: { [key]: true }
    });
  }

  it('reports a second replacement of the same body on the later feature', () => {
    const box = block('Block');
    const first = fillet(box.document, 'Fillet 1', box.bodyId);
    const ids = createBodyFeatureIds();
    const document = chamferEdges(first.document, {
      name: 'Chamfer 1',
      targetBodyId: box.bodyId,
      edgeHashes: [202],
      size: 1,
      ids
    }).document;
    const forks = historyForks(document);
    expect(forks).toEqual([
      {
        featureId: ids.featureId,
        bodyId: box.bodyId,
        consumerFeatureId: first.featureId
      }
    ]);
    expect(historyForkMessage(document, forks[0]!)).toBe(
      'Builds on an earlier state of “Block” that “Fillet 1” already replaced; this branches the history.'
    );
  });

  it('reports a chain that continues on the replaced body, not on the chain tip', () => {
    const box = block('Block');
    const first = fillet(box.document, 'Fillet 1', box.bodyId);
    const onTip = fillet(first.document, 'Fillet 2', first.bodyId);
    expect(historyForks(onTip.document)).toEqual([]);
    const stale = fillet(onTip.document, 'Fillet 3', box.bodyId);
    // The branch's own continuation builds on the branch: one report only.
    const continued = fillet(stale.document, 'Fillet 4', stale.bodyId);
    expect(historyForks(continued.document)).toEqual([
      {
        featureId: stale.featureId,
        bodyId: box.bodyId,
        consumerFeatureId: first.featureId
      }
    ]);
  });

  it('reports a boolean operand an earlier feature already replaced', () => {
    const a = block('A');
    const b = block('B', a.document);
    const union = createBodyFeatureIds();
    const merged = booleanBodies(b.document, {
      name: 'Union 1',
      operation: 'union',
      targetBodyIds: [a.bodyId, b.bodyId],
      ids: union
    }).document;
    // A fillet on the tool operand after the union consumed it.
    const toolBranch = fillet(merged, 'Fillet 1', b.bodyId);
    expect(historyForks(toolBranch.document)).toEqual([
      {
        featureId: toolBranch.featureId,
        bodyId: b.bodyId,
        consumerFeatureId: union.featureId
      }
    ]);
    // A second boolean reusing the union's first operand.
    const c = block('C', merged);
    const second = createBodyFeatureIds();
    const subtracted = booleanBodies(c.document, {
      name: 'Subtract 1',
      operation: 'subtract',
      targetBodyIds: [a.bodyId, c.bodyId],
      ids: second
    }).document;
    expect(historyForks(subtracted)).toEqual([
      {
        featureId: second.featureId,
        bodyId: a.bodyId,
        consumerFeatureId: union.featureId
      }
    ]);
  });

  it('does not report two consumers whose results are combined again', () => {
    // The imported-opening recipe: outside = A − M and inside = A ∩ M, then
    // reassembled into one body. Both read A and M, one body is on screen.
    const a = block('A');
    const m = block('M', a.document);
    const outside = createBodyFeatureIds();
    const inside = createBodyFeatureIds();
    let document = booleanBodies(m.document, {
      name: 'Outside',
      operation: 'subtract',
      targetBodyIds: [a.bodyId, m.bodyId],
      ids: outside
    }).document;
    document = booleanBodies(document, {
      name: 'Inside',
      operation: 'intersect',
      targetBodyIds: [a.bodyId, m.bodyId],
      ids: inside
    }).document;
    expect(historyForks(document)).toHaveLength(2);
    const reassembled = booleanBodies(document, {
      name: 'Reassembly',
      operation: 'union',
      targetBodyIds: [outside.bodyId, inside.bodyId]
    }).document;
    expect(historyForks(reassembled)).toEqual([]);
  });

  it('does not report a boolean operand it keeps (M11)', () => {
    const a = block('A');
    const b = block('B', a.document);
    const merged = booleanBodies(b.document, {
      name: 'Union 1',
      operation: 'union',
      targetBodyIds: [a.bodyId, b.bodyId],
      keepOriginals: 'all'
    }).document;
    expect(historyForks(fillet(merged, 'Fillet 1', b.bodyId).document)).toEqual(
      []
    );
  });

  it('reports an in-place edit of a body an earlier feature already replaced', () => {
    const box = block('Block');
    // Editing in place before the fillet is the ordinary chain.
    const before = offset(box.document, 'Offset 1', box.bodyId);
    const first = fillet(before.document, 'Fillet 1', box.bodyId);
    expect(historyForks(first.document)).toEqual([]);
    const after = offset(first.document, 'Offset 2', box.bodyId);
    const moveIds = createFeatureOnlyIds();
    const moved = transformBody(after.document, {
      name: 'Move 1',
      targetBodyId: box.bodyId,
      translation: { x: 5, y: 0, z: 0 },
      ids: moveIds
    }).document;
    expect(historyForks(moved)).toEqual([
      {
        featureId: after.featureId,
        bodyId: box.bodyId,
        consumerFeatureId: first.featureId
      },
      {
        featureId: moveIds.featureId,
        bodyId: box.bodyId,
        consumerFeatureId: first.featureId
      }
    ]);
  });

  it('does not report a mirror or copy that only reads the replaced body', () => {
    const box = block('Block');
    const first = fillet(box.document, 'Fillet 1', box.bodyId);
    const mirrored = mirrorBody(first.document, {
      name: 'Mirror 1',
      targetBodyId: box.bodyId,
      plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } }
    }).document;
    expect(historyForks(mirrored)).toEqual([]);
  });

  it('does not report a suppressed or rolled-back later feature', () => {
    const box = block('Block');
    const first = fillet(box.document, 'Fillet 1', box.bodyId);
    const stale = fillet(first.document, 'Fillet 2', box.bodyId);
    expect(historyForks(stale.document)).toHaveLength(1);
    for (const key of [
      FEATURE_SUPPRESSED_METADATA_KEY,
      FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY
    ]) {
      expect(
        historyForks(metadata(stale.document, stale.featureId, key))
      ).toEqual([]);
    }
  });

  it('does not count a rolled-back earlier consumer, which passes nothing through', () => {
    const box = block('Block');
    const first = fillet(box.document, 'Fillet 1', box.bodyId);
    const stale = fillet(first.document, 'Fillet 2', box.bodyId);
    expect(
      historyForks(
        metadata(
          stale.document,
          first.featureId,
          FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY
        )
      )
    ).toEqual([]);
  });

  it('still counts a manually suppressed earlier consumer, whose pass-through replaces the body', () => {
    // ADR-017: a suppressed fillet shows its input under its own result id,
    // so a second branch on that input is still on screen beside it.
    const box = block('Block');
    const first = fillet(box.document, 'Fillet 1', box.bodyId);
    const stale = fillet(first.document, 'Fillet 2', box.bodyId);
    expect(
      historyForks(
        metadata(
          stale.document,
          first.featureId,
          FEATURE_SUPPRESSED_METADATA_KEY
        )
      )
    ).toEqual([
      {
        featureId: stale.featureId,
        bodyId: box.bodyId,
        consumerFeatureId: first.featureId
      }
    ]);
  });

  it('does not report a chain through a failed step: its result id is the tip', () => {
    // A failed fillet passes its input through under its result id
    // (ADR-017), so a feature on that result id continues the one chain.
    // The detector reads the document only and never asks whether it built.
    const box = block('Block');
    const failed = fillet(box.document, 'Fillet 1', box.bodyId);
    const next = fillet(failed.document, 'Fillet 2', failed.bodyId);
    expect(historyForks(next.document)).toEqual([]);
  });

  describe('new forks an edit introduces', () => {
    it('names a feature added on a replaced body', () => {
      const box = block('Block');
      const first = fillet(box.document, 'Fillet 1', box.bodyId);
      const stale = fillet(first.document, 'Fillet 2', box.bodyId);
      expect(newHistoryForks(first.document, stale.document)).toEqual([
        {
          featureId: stale.featureId,
          bodyId: box.bodyId,
          consumerFeatureId: first.featureId
        }
      ]);
    });

    it('leaves an existing fork alone through unrelated edits and resumes', () => {
      const box = block('Block');
      const first = fillet(box.document, 'Fillet 1', box.bodyId);
      const stale = fillet(first.document, 'Fillet 2', box.bodyId);
      const paused = metadata(
        stale.document,
        stale.featureId,
        FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY
      );
      const resumed = setNodeMetadata(paused, {
        nodeId: listFeaturesInOrder(paused).at(-1)!.id,
        metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: null }
      });
      expect(historyForks(resumed)).toHaveLength(1);
      expect(newHistoryForks(paused, resumed)).toEqual([]);
      const later = block('Later', stale.document);
      expect(newHistoryForks(stale.document, later.document)).toEqual([]);
    });
  });
});
