import { describe, expect, it } from 'vitest';
import { toEntityId, type SketchObjectData } from './index';
import {
  isSketchPromotion,
  resolveSketchPromotionBoundaryTokens,
  type SketchPromotion
} from './sketch-promotions';

function fixture(): {
  promotion: SketchPromotion;
  objects: Map<string, SketchObjectData>;
} {
  const edgeIds = Array.from({ length: 4 }, (_, i) =>
    toEntityId(`ent_promoted_${i}`)
  );
  const centerSpokeId = toEntityId('ent_center_spoke');
  const helperId = toEntityId('ent_diagonal');
  const promotion: SketchPromotion = {
    promotionId: 'promotion_fixture',
    version: 1,
    sourceObjectId: toEntityId('ent_source'),
    sourceData: {
      objectKind: 'rectangle',
      width: 'width',
      height: 12,
      centerX: 0,
      centerY: 0
    },
    sourceName: 'Original rectangle',
    topology: { kind: 'rectangle', version: 1, count: 4 },
    edgeIds,
    centerSpokeId,
    helperIds: [helperId],
    structureConstraintIds: [],
    aliases: {
      version: 1,
      vertices: edgeIds.map((objectId) => ({ objectId, point: 'start' })),
      edges: [...edgeIds],
      center: { objectId: centerSpokeId, point: 'start' }
    }
  };
  const line: SketchObjectData = {
    objectKind: 'line',
    x1: 0,
    y1: 0,
    x2: 1,
    y2: 1
  };
  const objects = new Map<string, SketchObjectData>(
    edgeIds.map((id) => [id, { ...line }])
  );
  objects.set(centerSpokeId, { ...line, construction: true });
  objects.set(helperId, { ...line, construction: true });
  return { promotion, objects };
}

describe('S04 complete promotion aliases', () => {
  it('retains the inert source expressions and canonical endpoint/line/center aliases', () => {
    const { promotion, objects } = fixture();
    const before = structuredClone(promotion);
    expect(isSketchPromotion(promotion)).toBe(true);
    expect([
      ...resolveSketchPromotionBoundaryTokens([promotion], objects)
    ]).toEqual(
      promotion.edgeIds.map((id, i) => [
        id,
        `b1/ent_source/rectangle/1/4/e/${i}`
      ])
    );
    expect(promotion).toEqual(before);
    expect(promotion.sourceData).toMatchObject({ width: 'width' });
  });

  it('qualifies polygon aliases without inventing rectangle helpers or evaluating source expressions', () => {
    const { promotion, objects } = fixture();
    promotion.sourceData = {
      objectKind: 'polygon',
      sides: 'side_count',
      radius: 'radius',
      centerX: 0,
      centerY: 0
    };
    promotion.topology = { kind: 'regular-polygon', version: 1, count: 4 };
    promotion.helperIds = [];
    expect(isSketchPromotion(promotion)).toBe(true);
    expect([
      ...resolveSketchPromotionBoundaryTokens([promotion], objects).values()
    ]).toEqual(
      [0, 1, 2, 3].map((i) => `b1/ent_source/regular-polygon/1/4/e/${i}`)
    );
  });

  it.each([
    (p: SketchPromotion) => {
      p.version = 2 as 1;
    },
    (p: SketchPromotion) => {
      p.edgeIds.reverse();
    },
    (p: SketchPromotion) => {
      p.edgeIds[1] = p.edgeIds[0]!;
    },
    (p: SketchPromotion) => {
      p.centerSpokeId = p.edgeIds[0]!;
    },
    (p: SketchPromotion) => {
      p.helperIds = [];
    },
    (p: SketchPromotion) => {
      p.helperIds = [p.edgeIds[0]!];
    },
    (p: SketchPromotion) => {
      p.aliases.vertices[0]!.point = 'end';
    },
    (p: SketchPromotion) => {
      p.aliases.vertices.pop();
    },
    (p: SketchPromotion) => {
      p.aliases.edges.reverse();
    },
    (p: SketchPromotion) => {
      p.aliases.version = 2 as 1;
    },
    (p: SketchPromotion) => {
      p.topology.count = 5;
    },
    (p: SketchPromotion) => {
      p.topology.kind = 'regular-polygon';
    },
    (p: SketchPromotion) => {
      p.sourceObjectId = p.edgeIds[0]!;
    },
    (p: SketchPromotion) => {
      p.edgeIds = Array<ReturnType<typeof toEntityId>>(4);
    },
    (p: SketchPromotion) => {
      p.aliases.vertices = Array(4) as typeof p.aliases.vertices;
    }
  ])(
    'rejects changed, partial, duplicated and noncanonical alias maps',
    (mutate) => {
      const { promotion } = fixture();
      mutate(promotion);
      expect(isSketchPromotion(promotion)).toBe(false);
    }
  );

  it('rejects unknown fields and malformed saved source data without evaluating expressions', () => {
    const { promotion } = fixture();
    expect(isSketchPromotion({ ...promotion, unknown: true })).toBe(false);
    expect(
      isSketchPromotion({
        ...promotion,
        aliases: { ...promotion.aliases, unknown: true }
      })
    ).toBe(false);
    expect(
      isSketchPromotion({
        ...promotion,
        sourceData: { ...promotion.sourceData, extra: true }
      })
    ).toBe(false);
    expect(
      isSketchPromotion({
        ...promotion,
        sourceData: { ...promotion.sourceData, width: NaN }
      })
    ).toBe(false);
    expect(
      isSketchPromotion({
        ...promotion,
        sourceData: { ...promotion.sourceData, width: 'unknown_parameter' }
      })
    ).toBe(true);
  });

  it.each(['side', 'spoke', 'construction', 'source', 'kind'] as const)(
    'refuses an incomplete current owner (%s), never returning a partial map',
    (change) => {
      const { promotion, objects } = fixture();
      if (change === 'side') objects.delete(promotion.edgeIds[2]!);
      if (change === 'spoke') objects.delete(promotion.centerSpokeId);
      if (change === 'construction')
        objects.set(promotion.centerSpokeId, {
          objectKind: 'line',
          x1: 0,
          y1: 0,
          x2: 1,
          y2: 1
        });
      if (change === 'source')
        objects.set(promotion.sourceObjectId, promotion.sourceData);
      if (change === 'kind')
        objects.set(promotion.edgeIds[0]!, {
          objectKind: 'circle',
          radius: 1,
          centerX: 0,
          centerY: 0
        });
      expect(() =>
        resolveSketchPromotionBoundaryTokens([promotion], objects)
      ).toThrow(/Sketch promotion/);
    }
  );

  it('refuses repeated sources, repeated identities and shared member ownership', () => {
    const { promotion, objects } = fixture();
    expect(() =>
      resolveSketchPromotionBoundaryTokens(
        [promotion, structuredClone(promotion)],
        objects
      )
    ).toThrow(/more than one owner/);
    const other = structuredClone(promotion);
    other.promotionId = 'promotion_other';
    other.sourceObjectId = toEntityId('ent_other');
    expect(() =>
      resolveSketchPromotionBoundaryTokens([promotion, other], objects)
    ).toThrow(/more than one promotion owner/);
  });
});
