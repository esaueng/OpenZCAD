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
  addSplitFeature,
  assertNoNewHistoryFork,
  bodyPiecesAfter,
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
  moveFeature,
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

    /** Stock, a tool, the tool's in-place Move, then stock − tool (#2334). */
    function placedCut() {
      const stock = block('Stock');
      const tool = block('Tool', stock.document);
      const place = createFeatureOnlyIds();
      const placed = transformBody(tool.document, {
        name: 'Place tool',
        targetBodyId: tool.bodyId,
        translation: { x: 5, y: 0, z: 0 },
        ids: place
      }).document;
      const cut = createBodyFeatureIds();
      const document = booleanBodies(placed, {
        name: 'Subtract 1',
        operation: 'subtract',
        targetBodyIds: [stock.bodyId, tool.bodyId],
        ids: cut
      }).document;
      return { document, stock, tool, place, cut };
    }

    const position = (document: ProjectDocument, featureId: FeatureId) =>
      listFeaturesInOrder(document).findIndex(
        (feature) => feature.featureId === featureId
      );

    it('names an in-place edit a reorder puts after the consumer of its body', () => {
      const { document, tool, place, cut } = placedCut();
      expect(historyForks(document)).toEqual([]);
      const fork = {
        featureId: place.featureId,
        bodyId: tool.bodyId,
        consumerFeatureId: cut.featureId
      };
      // The placement moved down, and the consumer moved up: one arrangement.
      for (const moved of [
        moveFeature(document, {
          featureId: place.featureId,
          toIndex: position(document, cut.featureId)
        }),
        moveFeature(document, {
          featureId: cut.featureId,
          toIndex: position(document, place.featureId)
        })
      ]) {
        expect(newHistoryForks(document, moved)).toEqual([fork]);
        expect(() => assertNoNewHistoryFork(document, moved)).toThrow(
          'Cannot reorder: “Place tool” would run after “Subtract 1” already replaced “Tool”, which branches the history. Keep “Place tool” before “Subtract 1”.'
        );
      }
    });

    it('leaves a reorder of steps that share no body alone', () => {
      const { document, tool, place } = placedCut();
      // The tool and its placement ahead of the stock: still before the cut.
      const toolFirst = moveFeature(document, {
        featureId: tool.featureId,
        toIndex: 0
      });
      const moved = moveFeature(toolFirst, {
        featureId: place.featureId,
        toIndex: 1
      });
      expect(listFeaturesInOrder(moved).map((feature) => feature.name)).toEqual(
        ['Tool', 'Place tool', 'Stock', 'Subtract 1']
      );
      expect(newHistoryForks(document, moved)).toEqual([]);
      expect(() => assertNoNewHistoryFork(document, moved)).not.toThrow();
    });

    it('lets a stored fork be reordered, and moved back out of the fork', () => {
      const { document, place, cut } = placedCut();
      const forked = moveFeature(document, {
        featureId: place.featureId,
        toIndex: position(document, cut.featureId)
      });
      expect(historyForks(forked)).toHaveLength(1);
      // An unrelated step moved around the fork does not add one.
      const later = block('Later', forked);
      const around = moveFeature(later.document, {
        featureId: later.featureId,
        toIndex: 0
      });
      expect(historyForks(around)).toHaveLength(1);
      expect(newHistoryForks(later.document, around)).toEqual([]);
      // The placement back ahead of its consumer removes the fork.
      const repaired = moveFeature(forked, {
        featureId: place.featureId,
        toIndex: position(forked, cut.featureId)
      });
      expect(historyForks(repaired)).toEqual([]);
      expect(newHistoryForks(forked, repaired)).toEqual([]);
    });

    it('lets the two branches of a stored fork swap places', () => {
      // Both fillets already replace the block. Swapping them changes which
      // one is reported as the later branch, not what is built.
      const box = block('Block');
      const first = fillet(box.document, 'Fillet 1', box.bodyId);
      const stale = fillet(first.document, 'Fillet 2', box.bodyId);
      const swapped = moveFeature(stale.document, {
        featureId: stale.featureId,
        toIndex: position(stale.document, first.featureId)
      });
      expect(historyForks(swapped)).toEqual([
        {
          featureId: first.featureId,
          bodyId: box.bodyId,
          consumerFeatureId: stale.featureId
        }
      ]);
      expect(newHistoryForks(stale.document, swapped)).toEqual([]);
    });

    /**
     * A stored history that already forks: two stocks cut by one tool, with
     * the tool's placement between the cuts. "Cut A" consumed the tool first,
     * so the placement and "Cut B" each already fork against it.
     */
    function sharedTool() {
      const stockA = block('Stock A');
      const stockB = block('Stock B', stockA.document);
      const tool = block('Tool', stockB.document);
      const cutA = createBodyFeatureIds();
      const place = createFeatureOnlyIds();
      const cutB = createBodyFeatureIds();
      let document = booleanBodies(tool.document, {
        name: 'Cut A',
        operation: 'subtract',
        targetBodyIds: [stockA.bodyId, tool.bodyId],
        ids: cutA
      }).document;
      document = transformBody(document, {
        name: 'Place tool',
        targetBodyId: tool.bodyId,
        translation: { x: 5, y: 0, z: 0 },
        ids: place
      }).document;
      document = booleanBodies(document, {
        name: 'Cut B',
        operation: 'subtract',
        targetBodyIds: [stockB.bodyId, tool.bodyId],
        ids: cutB
      }).document;
      return { document, tool, cutA, place, cutB };
    }

    it('refuses a new step-and-consumer pair in a history that already forks', () => {
      const { document, tool, cutA, place, cutB } = sharedTool();
      // Reported against the tool's first consumer only.
      expect(historyForks(document)).toEqual([
        {
          featureId: place.featureId,
          bodyId: tool.bodyId,
          consumerFeatureId: cutA.featureId
        },
        {
          featureId: cutB.featureId,
          bodyId: tool.bodyId,
          consumerFeatureId: cutA.featureId
        }
      ]);
      // The placement already forks against Cut A. That does not let it land
      // after Cut B, which it ran ahead of: Cut B would cut unplaced.
      const fork = {
        featureId: place.featureId,
        bodyId: tool.bodyId,
        consumerFeatureId: cutB.featureId
      };
      for (const moved of [
        // Cut B above Cut A: Cut B, Cut A, Place tool.
        moveFeature(document, {
          featureId: cutB.featureId,
          toIndex: position(document, cutA.featureId)
        }),
        // Cut B above the placement: Cut A, Cut B, Place tool.
        moveFeature(document, {
          featureId: cutB.featureId,
          toIndex: position(document, place.featureId)
        }),
        // The placement below Cut B: the same order, and the same forks the
        // document reports, since both are still listed against Cut A.
        moveFeature(document, {
          featureId: place.featureId,
          toIndex: position(document, cutB.featureId)
        })
      ]) {
        expect(newHistoryForks(document, moved)).toEqual([fork]);
        expect(() => assertNoNewHistoryFork(document, moved)).toThrow(
          'Cannot reorder: “Place tool” would run after “Cut B” already replaced “Tool”, which branches the history. Keep “Place tool” before “Cut B”.'
        );
      }
    });

    it('still lets the pairs a stored fork holds be moved, and taken apart', () => {
      const { document, cutA, place, cutB } = sharedTool();
      // An unrelated step moved through the fork.
      const later = block('Later', document);
      const around = moveFeature(later.document, {
        featureId: later.featureId,
        toIndex: position(later.document, place.featureId)
      });
      expect(newHistoryForks(later.document, around)).toEqual([]);
      // Cut A below Cut B: Place tool, Cut B, Cut A. The placement no longer
      // forks, and the two cuts are the pair they were, the other way round.
      const cutALast = moveFeature(document, {
        featureId: cutA.featureId,
        toIndex: position(document, cutB.featureId)
      });
      expect(historyForks(cutALast)).toHaveLength(1);
      expect(newHistoryForks(document, cutALast)).toEqual([]);
      // The placement ahead of both cuts: only the two cuts still fork.
      const placedFirst = moveFeature(document, {
        featureId: place.featureId,
        toIndex: position(document, cutA.featureId)
      });
      expect(historyForks(placedFirst)).toHaveLength(1);
      expect(newHistoryForks(document, placedFirst)).toEqual([]);
    });

    /**
     * {@link sharedTool} with a suppressed cut OF the tool last: "Trim tool"
     * would replace the tool, by a spare block made ahead of everything. Cut
     * A already consumed the tool, so the suppressed step has nothing left to
     * pass through (ADR-017 fails closed): it builds and consumes nothing.
     */
    function suppressedTrim() {
      const shared = sharedTool();
      const spare = block('Spare', shared.document);
      const trim = createBodyFeatureIds();
      const document = metadata(
        booleanBodies(
          moveFeature(spare.document, {
            featureId: spare.featureId,
            toIndex: 0
          }),
          {
            name: 'Trim tool',
            operation: 'subtract',
            targetBodyIds: [shared.tool.bodyId, spare.bodyId],
            ids: trim
          }
        ).document,
        trim.featureId,
        FEATURE_SUPPRESSED_METADATA_KEY
      );
      return { ...shared, document, trim };
    }

    const names = (document: ProjectDocument) =>
      listFeaturesInOrder(document).map((feature) => feature.name);

    it('does not count a suppressed step that has nothing left to pass through', () => {
      const { document, tool, cutA, place, cutB, trim } = suppressedTrim();
      expect(names(document).slice(-4)).toEqual([
        'Cut A',
        'Place tool',
        'Cut B',
        'Trim tool'
      ]);
      const reported = historyForks(document);
      // The suppressed cut above Cut B, and above the placement: the build
      // skips it at either place exactly as it did last.
      const aboveCutB = moveFeature(document, {
        featureId: trim.featureId,
        toIndex: position(document, cutB.featureId)
      });
      expect(names(aboveCutB).slice(-3)).toEqual([
        'Place tool',
        'Trim tool',
        'Cut B'
      ]);
      const abovePlacement = moveFeature(document, {
        featureId: trim.featureId,
        toIndex: position(document, place.featureId)
      });
      for (const moved of [aboveCutB, abovePlacement]) {
        expect(historyForks(moved)).toEqual(reported);
        expect(newHistoryForks(document, moved)).toEqual([]);
        expect(() => assertNoNewHistoryFork(document, moved)).not.toThrow();
      }
      // And back down again.
      expect(newHistoryForks(aboveCutB, document)).toEqual([]);

      // Above Cut A it is the tool's first consumer: its pass-through now
      // takes the tool, and shows it under its own id beside both cuts.
      const first = moveFeature(document, {
        featureId: trim.featureId,
        toIndex: position(document, cutA.featureId)
      });
      expect(newHistoryForks(document, first)).toContainEqual({
        featureId: cutA.featureId,
        bodyId: tool.bodyId,
        consumerFeatureId: trim.featureId
      });
      expect(() => assertNoNewHistoryFork(document, first)).toThrow(
        'Cannot reorder: “Cut A” would run after “Trim tool” already replaced “Tool”, which branches the history. Keep “Cut A” before “Trim tool”.'
      );
    });

    it('reports the suppressed step once it is resumed, wherever it was moved', () => {
      const { document, tool, cutA, place, cutB, trim } = suppressedTrim();
      const moved = moveFeature(document, {
        featureId: trim.featureId,
        toIndex: position(document, cutB.featureId)
      });
      const resume = (suppressed: ProjectDocument) =>
        setNodeMetadata(suppressed, {
          nodeId: listFeaturesInOrder(suppressed).find(
            (feature) => feature.featureId === trim.featureId
          )!.id,
          metadata: { [FEATURE_SUPPRESSED_METADATA_KEY]: null }
        });
      // Resuming is reported, never refused, in the moved order as in the
      // stored one: the cut of the tool forks against Cut A in both.
      for (const suppressed of [document, moved]) {
        const resumed = resume(suppressed);
        expect(newHistoryForks(suppressed, resumed)).toEqual([]);
        expect(historyForks(resumed)).toContainEqual({
          featureId: trim.featureId,
          bodyId: tool.bodyId,
          consumerFeatureId: cutA.featureId
        });
      }
      // Once it runs it is a consumer like any other: the placement may not
      // be moved after it.
      const resumed = resume(document);
      const placementLast = moveFeature(resumed, {
        featureId: place.featureId,
        toIndex: position(resumed, trim.featureId)
      });
      expect(() => assertNoNewHistoryFork(resumed, placementLast)).toThrow(
        'Cannot reorder: “Place tool” would run after “Cut B” already replaced “Tool”, which branches the history. Keep “Place tool” before “Cut B”.'
      );
      const trimBeforePlacement = moveFeature(resumed, {
        featureId: trim.featureId,
        toIndex: position(resumed, place.featureId)
      });
      expect(() =>
        assertNoNewHistoryFork(resumed, trimBeforePlacement)
      ).toThrow(
        'Cannot reorder: “Place tool” would run after “Trim tool” already replaced “Tool”, which branches the history. Keep “Place tool” before “Trim tool”.'
      );
    });

    it('does not refuse a resume that uncovers a fork a reorder never made', () => {
      // An edit of the tool added while its consumer is paused. Resuming
      // changes neither targets nor order.
      const { document, tool, cut } = placedCut();
      const paused = metadata(
        document,
        cut.featureId,
        FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY
      );
      const extra = offset(paused, 'Offset 1', tool.bodyId);
      expect(newHistoryForks(paused, extra.document)).toEqual([]);
      const resumed = setNodeMetadata(extra.document, {
        nodeId: listFeaturesInOrder(extra.document).find(
          (feature) => feature.featureId === cut.featureId
        )!.id,
        metadata: { [FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY]: null }
      });
      expect(historyForks(resumed)).toHaveLength(1);
      expect(newHistoryForks(extra.document, resumed)).toEqual([]);
    });
  });
});

/**
 * PR #2415 review: where a body's material is by the end of the history, by
 * the ids the build assigns. The flat pattern reads its Scale from this.
 */
describe('bodyPiecesAfter', () => {
  const built = { failed: () => false, inactive: () => false };

  function block(name: string, document?: ProjectDocument) {
    const ids = createBodyFeatureIds();
    return {
      document: addPrimitiveFeature(
        document ??
          createProjectDocument('Pieces', toUserId('user_body_pieces'), 'mm'),
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

  const scale = (document: ProjectDocument, name: string, target: BodyId) =>
    transformBody(document, {
      name,
      targetBodyId: target,
      translation: { x: 0, y: 0, z: 0 },
      scale: 2
    }).document;

  const flagged = (
    document: ProjectDocument,
    featureId: FeatureId,
    key: string
  ) =>
    setNodeMetadata(document, {
      nodeId: listFeaturesInOrder(document).find(
        (feature) => feature.featureId === featureId
      )!.id,
      metadata: { [key]: true }
    });

  /** Each piece as `[bodyId, live, transform names]`. */
  const pieces = (
    document: ProjectDocument,
    originId: FeatureId,
    outcomes: Parameters<typeof bodyPiecesAfter>[2] = built
  ) =>
    bodyPiecesAfter(
      document,
      listFeaturesInOrder(document).find(
        (feature) => feature.featureId === originId
      )!,
      outcomes
    ).map((piece) => [
      piece.bodyId,
      piece.live,
      piece.transforms.map((feature) => feature.name)
    ]);

  const plane = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 } };

  it('follows a replacement to its result, suppressed or failed included, and records in-place transforms', () => {
    const box = block('Block');
    const first = fillet(box.document, 'Fillet 1', box.bodyId);
    const document = scale(first.document, 'Scale 1', first.bodyId);
    expect(pieces(document, box.featureId)).toEqual([
      [first.bodyId, true, ['Scale 1']]
    ]);
    // Manually suppressed: the build passes the block through under the
    // fillet's id, so the Scale still lands on it.
    expect(
      pieces(
        flagged(document, first.featureId, FEATURE_SUPPRESSED_METADATA_KEY),
        box.featureId
      )
    ).toEqual([[first.bodyId, true, ['Scale 1']]]);
    // Failed: the same pass-through.
    expect(
      pieces(document, box.featureId, {
        ...built,
        failed: (feature) => feature.featureId === first.featureId
      })
    ).toEqual([[first.bodyId, true, ['Scale 1']]]);
    // Paused by a rollback: nothing is passed, the block stays itself.
    expect(
      pieces(
        flagged(
          document,
          first.featureId,
          FEATURE_ROLLBACK_SUPPRESSED_METADATA_KEY
        ),
        box.featureId
      )
    ).toEqual([[box.bodyId, true, []]]);
    // A Scale the build refused, or a suppressed one, is not recorded.
    const refused = listFeaturesInOrder(document).at(-1)!;
    expect(
      pieces(document, box.featureId, {
        ...built,
        failed: (feature) => feature.featureId === refused.featureId
      })
    ).toEqual([[first.bodyId, true, []]]);
    expect(
      pieces(
        flagged(document, refused.featureId, FEATURE_SUPPRESSED_METADATA_KEY),
        box.featureId
      )
    ).toEqual([[first.bodyId, true, []]]);
  });

  it('stays on a kept original and does not follow a copy, a mirror or a stale branch', () => {
    const box = block('Block');
    const split = addSplitFeature(box.document, {
      name: 'Split 1',
      targetBodyId: box.bodyId,
      plane,
      keepOriginal: true
    });
    const half = scale(split.document, 'Scale half', split.bodyId);
    const both = scale(half, 'Scale original', box.bodyId);
    expect(pieces(both, box.featureId)).toEqual([
      [box.bodyId, true, ['Scale original']]
    ]);
    const copy = transformBody(box.document, {
      name: 'Copy 1',
      targetBodyId: box.bodyId,
      translation: { x: 20, y: 0, z: 0 },
      scale: 3,
      copy: true
    });
    const mirrored = mirrorBody(copy.document, {
      name: 'Mirror 1',
      targetBodyId: box.bodyId,
      plane
    });
    expect(
      pieces(scale(mirrored.document, 'Scale copy', copy.bodyId), box.featureId)
    ).toEqual([[box.bodyId, true, []]]);
    // A fork: the second fillet builds on the block the first replaced.
    const first = fillet(box.document, 'Fillet 1', box.bodyId);
    const stale = fillet(first.document, 'Fillet 2', box.bodyId);
    expect(
      pieces(scale(stale.document, 'Scale stale', stale.bodyId), box.featureId)
    ).toEqual([[first.bodyId, true, []]]);
  });

  it('gives a consuming Split two pieces, and a union one body holding both', () => {
    const box = block('Block');
    const split = addSplitFeature(box.document, {
      name: 'Split 1',
      targetBodyId: box.bodyId,
      plane
    });
    const half = scale(split.document, 'Scale half', split.secondBodyId);
    expect(pieces(half, box.featureId)).toEqual([
      [split.bodyId, true, []],
      [split.secondBodyId, true, ['Scale half']]
    ]);
    const joined = booleanBodies(half, {
      name: 'Union 1',
      operation: 'union',
      targetBodyIds: [split.bodyId, split.secondBodyId]
    });
    expect(
      pieces(scale(joined.document, 'Scale all', joined.bodyId), box.featureId)
    ).toEqual([
      [joined.bodyId, true, ['Scale all']],
      [joined.bodyId, true, ['Scale half', 'Scale all']]
    ]);
  });

  it('follows a boolean by what each operand becomes', () => {
    const box = block('Block');
    const other = block('Other', box.document);
    const boolean = (
      operation: 'union' | 'subtract' | 'intersect',
      targetBodyIds: BodyId[],
      keepOriginals?: 'all' | 'target' | 'tools'
    ) =>
      booleanBodies(other.document, {
        name: 'Boolean 1',
        operation,
        targetBodyIds,
        ...(keepOriginals ? { keepOriginals } : {})
      });
    // The first operand is replaced by the result.
    const base = boolean('subtract', [box.bodyId, other.bodyId]);
    expect(pieces(base.document, box.featureId)).toEqual([
      [base.bodyId, true, []]
    ]);
    // A subtract's consumed tool is out of the model.
    const tool = boolean('subtract', [other.bodyId, box.bodyId]);
    expect(pieces(tool.document, box.featureId)).toEqual([
      [box.bodyId, false, []]
    ]);
    // Kept, as a tool or as the target, it stays itself.
    for (const kept of [
      boolean('subtract', [other.bodyId, box.bodyId], 'tools'),
      boolean('subtract', [box.bodyId, other.bodyId], 'target'),
      boolean('union', [other.bodyId, box.bodyId], 'all')
    ]) {
      expect(
        pieces(scale(kept.document, 'Scale 1', kept.bodyId), box.featureId)
      ).toEqual([[box.bodyId, true, []]]);
    }
    // A union or an intersect carries its other operands into the result,
    // unless it is switched off: then only the first operand is in it.
    for (const operation of ['union', 'intersect'] as const) {
      const merged = boolean(operation, [other.bodyId, box.bodyId]);
      expect(pieces(merged.document, box.featureId)).toEqual([
        [merged.bodyId, true, []]
      ]);
      expect(
        pieces(merged.document, box.featureId, {
          ...built,
          inactive: () => true
        })
      ).toEqual([[box.bodyId, false, []]]);
      // Failed, it passes only its first operand through.
      expect(
        pieces(merged.document, box.featureId, {
          ...built,
          failed: (feature) => feature.name === 'Boolean 1'
        })
      ).toEqual([[box.bodyId, true, []]]);
    }
  });
});
