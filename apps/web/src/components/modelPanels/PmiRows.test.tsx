import {
  act,
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnyCommand } from '@openzcad/command-system';
import type {
  GeometryBodyRepresentation,
  ModelPmiAnnotation,
  ModelPmiId,
  ProjectDocument
} from '@openzcad/shared';
import { setPmiFace, setSelectedPmiId } from '../../lib/pmi/pmiSelection';
import { PmiRows } from './PmiRows';

/**
 * The model PMI editor in Objects: a frame never moves to a face its
 * characteristic cannot control (#2321), a datum's new letter carries its
 * frames (#2375), and a broken frame's repair names its cause (#2260).
 */

const BODY = 'body_pin';
const BARREL = 101;
const CAP = 202;
/** An imported B-spline side shown to lie on a cylinder, and a free-form one. */
const SPLINE_SIDE = 303;
const FREEFORM = 404;

const face = (hash: number, surfaceType: string, supportSurface?: string) => ({
  topologyId: `face_${hash}`,
  hash,
  triangleStart: 0,
  triangleCount: 0,
  geometry: {
    surfaceType,
    ...(supportSurface ? { supportSurface } : {}),
    area: 1,
    center: { x: 0, y: 0, z: hash === CAP ? 16 : 8 }
  }
});

const representations = {
  [BODY]: {
    topology: {
      faces: [
        face(BARREL, 'cylinder'),
        face(CAP, 'plane'),
        face(SPLINE_SIDE, 'bspline', 'cylinder'),
        face(FREEFORM, 'bspline')
      ],
      edges: []
    }
  }
} as unknown as Record<string, GeometryBodyRepresentation>;

const id = (name: string) => `pmi_${name}` as ModelPmiId;

function documentWith(annotations: ModelPmiAnnotation[]): ProjectDocument {
  return {
    units: 'mm',
    pmi: { annotations },
    derived: { bodyRepresentations: representations }
  } as unknown as ProjectDocument;
}

const cylindricity: ModelPmiAnnotation = {
  pmiId: id('cyl'),
  kind: 'feature-control-frame',
  face: { bodyId: BODY, hash: BARREL } as ModelPmiAnnotation['face'],
  anchor: { x: 0, y: 0, z: 8 },
  characteristic: 'cylindricity',
  amount: 0.004
};

function renderRows(annotations: ModelPmiAnnotation[]) {
  const onCommand = vi.fn((_command: AnyCommand) => true);
  render(
    <PmiRows
      document={documentWith(annotations)}
      representations={representations}
      bodyNames={new Map([[BODY, 'Pin']])}
      editable
      onCommand={onCommand}
    />
  );
  return onCommand;
}

afterEach(() => {
  act(() => {
    setPmiFace(null);
    setSelectedPmiId(null);
  });
});

describe('PmiRows', () => {
  it('refuses to move a cylindricity frame to a flat cap, and offers no form tolerance the bore cannot take', () => {
    act(() => {
      setSelectedPmiId(id('cyl'));
      setPmiFace({ bodyId: BODY, hash: CAP });
    });
    const onCommand = renderRows([cylindricity]);
    const characteristic = screen.getByRole('combobox', {
      name: 'Characteristic'
    });
    const option = (value: string) =>
      characteristic.querySelector<HTMLOptionElement>(
        `option[value="${value}"]`
      )!;
    expect(option('cylindricity').disabled).toBe(false);
    expect(option('flatness').disabled).toBe(true);
    expect(option('circularity').disabled).toBe(false);
    fireEvent.click(
      screen.getByRole('button', { name: /Move to selected face/ })
    );
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Cylindricity applies to a cylindrical face, and this face is planar. Pick a face it applies to, or change the characteristic first.'
    );
  });

  it('shows a stored cylindricity frame on a flat cap broken, with its own repair', () => {
    act(() => setSelectedPmiId(id('cyl')));
    renderRows([
      {
        ...cylindricity,
        face: { bodyId: BODY, hash: CAP } as ModelPmiAnnotation['face']
      }
    ]);
    expect(
      screen.getByRole('button', { name: 'Cylindricity | 0.004 (broken)' })
    ).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Broken: Cylindricity applies to a cylindrical face, and this face is planar. Select a face it applies to and move it there, choose another characteristic, or delete it.'
    );
  });

  it('renames a datum with its frames following, in one command', () => {
    act(() => setSelectedPmiId(id('a')));
    const onCommand = renderRows([
      {
        pmiId: id('a'),
        kind: 'datum-feature',
        face: { bodyId: BODY, hash: CAP } as ModelPmiAnnotation['face'],
        anchor: { x: 0, y: 0, z: 16 },
        letter: 'A'
      }
    ]);
    fireEvent.change(screen.getByRole('combobox', { name: 'Letter' }), {
      target: { value: 'F' }
    });
    expect(onCommand).toHaveBeenCalledTimes(1);
    const command = onCommand.mock.calls[0]![0];
    expect(command.kind).toBe('pmi.update');
    expect(command.payload).toMatchObject({
      annotation: { pmiId: id('a'), letter: 'F' },
      followReferences: true
    });
  });

  it('directs an undeclared datum to its slot rather than to the face', () => {
    act(() => setSelectedPmiId(id('pos')));
    renderRows([
      {
        pmiId: id('a'),
        kind: 'datum-feature',
        face: { bodyId: BODY, hash: CAP } as ModelPmiAnnotation['face'],
        anchor: { x: 0, y: 0, z: 16 },
        letter: 'A'
      },
      {
        pmiId: id('pos'),
        kind: 'feature-control-frame',
        face: { bodyId: BODY, hash: BARREL } as ModelPmiAnnotation['face'],
        anchor: { x: 0, y: 0, z: 8 },
        characteristic: 'position',
        amount: 0.1,
        datums: [{ letter: 'A' }, { letter: 'C' }]
      }
    ]);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(
      "Broken: This frame's secondary datum C is not declared on the model. Add a datum feature C to a face, or choose a declared datum in that slot. Or delete the frame."
    );
    expect(alert).not.toHaveTextContent(/re-pick/);
  });

  it('judges a B-spline face by the surface it lies on, and refuses form tolerances on one with none', () => {
    const flatness: ModelPmiAnnotation = {
      ...cylindricity,
      face: { bodyId: BODY, hash: CAP } as ModelPmiAnnotation['face'],
      characteristic: 'flatness',
      amount: 0.1
    };
    act(() => {
      setSelectedPmiId(id('cyl'));
      setPmiFace({ bodyId: BODY, hash: SPLINE_SIDE });
    });
    const onCommand = renderRows([flatness]);
    fireEvent.click(
      screen.getByRole('button', { name: /Move to selected face/ })
    );
    expect(onCommand).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Flatness applies to a planar face, and this face is cylindrical.'
    );
    const options = () => {
      const menu = screen.getByRole('combobox', { name: 'Characteristic' });
      return (value: string) =>
        menu.querySelector<HTMLOptionElement>(`option[value="${value}"]`)!
          .disabled;
    };
    cleanup();
    act(() => setPmiFace(null));
    renderRows([
      {
        ...cylindricity,
        face: { bodyId: BODY, hash: SPLINE_SIDE } as ModelPmiAnnotation['face']
      }
    ]);
    let disabled = options();
    expect(disabled('flatness')).toBe(true);
    expect(disabled('circularity')).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
    renderRows([
      {
        ...cylindricity,
        face: { bodyId: BODY, hash: FREEFORM } as ModelPmiAnnotation['face']
      }
    ]);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Cylindricity applies to a cylindrical face, and this B-spline face could not be shown to be one.'
    );
    disabled = options();
    expect(disabled('flatness')).toBe(true);
    expect(disabled('circularity')).toBe(true);
    expect(disabled('straightness')).toBe(true);
    expect(disabled('profile-surface')).toBe(false);
  });

  it('keeps judging a frame by its face while a datum it names is undeclared', () => {
    act(() => setSelectedPmiId(id('pos')));
    // Position on the flat cap, its datum A deleted.
    renderRows([
      {
        pmiId: id('pos'),
        kind: 'feature-control-frame',
        face: { bodyId: BODY, hash: CAP } as ModelPmiAnnotation['face'],
        anchor: { x: 0, y: 0, z: 16 },
        characteristic: 'position',
        amount: 0.1,
        datums: [{ letter: 'A' }]
      }
    ]);
    expect(screen.getByRole('alert')).toHaveTextContent(
      "This frame's primary datum A is not declared on the model."
    );
    const characteristic = screen.getByRole('combobox', {
      name: 'Characteristic'
    });
    const option = (value: string) =>
      characteristic.querySelector<HTMLOptionElement>(
        `option[value="${value}"]`
      )!;
    expect(option('cylindricity').disabled).toBe(true);
    expect(option('circularity').disabled).toBe(true);
    expect(option('flatness').disabled).toBe(false);
  });
});
