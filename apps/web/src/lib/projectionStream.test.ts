import { describe, expect, it } from 'vitest';
import {
  toBodyId,
  type BodyRepresentation,
  type DerivedState,
  type GeometryReadyState
} from '@openzcad/shared';
import {
  ProjectionReceiver,
  ProjectionSender,
  projectionTransferables
} from './projectionStream';
import { sameBodyRenderGeometry } from '@openzcad/viewport';

const id = toBodyId('body_stream');
function body(): BodyRepresentation {
  return {
    bodyId: id,
    name: 'Part',
    source: 'primitive',
    color: '#888888',
    consumed: false,
    exportableStep: true,
    faceCount: 1,
    volume: 0.5,
    bbox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
    mesh: {
      kind: 'mesh',
      vertices: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
      indices: Uint32Array.of(0, 1, 2)
    }
  };
}
function state(part = body()): DerivedState {
  return {
    bodyRepresentations: { [id]: part },
    exportableBodyIds: [id],
    warnings: [],
    updatedAt: '2026-10-07T00:00:00Z'
  };
}

describe('owned body projection stream', () => {
  it('retains object identity for unchanged bodies and sends no mesh for quantities', () => {
    const sender = new ProjectionSender('worker'),
      receiver = new ProjectionReceiver();
    const original = state();
    const first = receiver.apply(sender.encode('project', original))!;
    const second = receiver.apply(
      sender.encode('project', structuredClone(original))
    )!;
    expect(second.bodyRepresentations[id]).toBe(first.bodyRepresentations[id]);
    const measured = { ...original.bodyRepresentations[id]!, volume: 0.75 };
    const packet = sender.encode('project', state(measured));
    expect(packet.changes[id]!.mesh).toBeUndefined();
    expect(projectionTransferables(packet)).toEqual([]);
    const third = receiver.apply(packet)!;
    expect(
      sameBodyRenderGeometry(
        second.bodyRepresentations[id]!,
        third.bodyRepresentations[id]!
      )
    ).toBe(true);
    expect((third as DerivedState).bodyRepresentations[id]!.volume).toBe(0.75);
  });

  it('shares geometry between early and complete frames without inventing a volume', () => {
    const sender = new ProjectionSender('worker'),
      receiver = new ProjectionReceiver();
    const complete = state();
    const { volume: _volume, ...geometryBody } =
      complete.bodyRepresentations[id]!;
    const early: GeometryReadyState = {
      bodyRepresentations: { [id]: geometryBody },
      warnings: [],
      updatedAt: complete.updatedAt,
      analysis: 'pending'
    };
    const geometry = receiver.apply(sender.encode('project', early))!;
    expect('volume' in geometry.bodyRepresentations[id]!).toBe(false);
    const packet = sender.encode('project', complete);
    expect(projectionTransferables(packet)).toHaveLength(0);
    const result = receiver.apply(packet)!;
    expect(result.bodyRepresentations[id]!.mesh).toBe(
      geometry.bodyRepresentations[id]!.mesh
    );
    expect((result as DerivedState).bodyRepresentations[id]!.volume).toBe(0.5);
  });

  it('rejects a dropped base atomically, then accepts a full recovery and body removal', () => {
    const sender = new ProjectionSender('worker'),
      receiver = new ProjectionReceiver();
    receiver.apply(sender.encode('project', state()));
    sender.encode('project', state({ ...body(), volume: 0.6 }));
    expect(
      receiver.apply(
        sender.encode('project', state({ ...body(), volume: 0.7 }))
      )
    ).toBeNull();
    const full = sender.encode(
      'project',
      state({ ...body(), volume: 0.8 }),
      true
    );
    expect(
      (receiver.apply(full) as DerivedState).bodyRepresentations[id]!.volume
    ).toBe(0.8);
    const empty = {
      ...state(),
      bodyRepresentations: {},
      exportableBodyIds: []
    };
    expect(sender.encode('project', empty).removed).toEqual([id]);
  });

  it('transfers outgoing copies without detaching retained or input buffers', () => {
    const sender = new ProjectionSender('worker'),
      receiver = new ProjectionReceiver();
    const input = state();
    const packet = sender.encode('project', input);
    const received = structuredClone(packet, {
      transfer: projectionTransferables(packet)
    });
    expect(receiver.apply(received)).not.toBeNull();
    expect(input.bodyRepresentations[id]!.mesh.vertices.byteLength).toBe(36);
    expect(sender.encode('project', input).changes).toEqual({});
  });
});
