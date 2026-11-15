import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FeatureId } from '@openzcad/shared';
import type { SheetMetalFlatPattern } from '@openzcad/kernel-adapter/sheet-metal-flat-pattern';
import {
  FlatPatternDialog,
  type FlatPatternDialogProps
} from './FlatPatternDialog';

const SHEET = 'feature_sheet' as FeatureId;
const OTHER = 'feature_other' as FeatureId;

/** The spec's L bracket as the adapter returns it (nominal 90° bend). */
function bracket(
  changedBy: SheetMetalFlatPattern['changedBy'] = []
): SheetMetalFlatPattern {
  const corners: [number, number][] = [
    [0, 0],
    [96.5239, 0],
    [96.5239, 40],
    [0, 40]
  ];
  return {
    featureId: SHEET,
    thickness: 2,
    frame: {
      origin: [0, 0, 0],
      u: [1, 0, 0],
      v: [0, 1, 0],
      normal: [0, 0, 1]
    },
    loops: [
      {
        outer: true,
        entities: corners.map((start, index) => ({
          kind: 'line' as const,
          start,
          end: corners[(index + 1) % 4]!
        }))
      }
    ],
    bends: [
      {
        bendId: 'b1',
        piece: 0,
        segment: [
          [48.262, 0],
          [48.262, 40]
        ],
        direction: 'up',
        angleDeg: 90,
        insideRadius: 2,
        kFactor: 0.44,
        bendAllowance: 4.5239,
        bendDeduction: 3.4761,
        lineLength: 40
      },
      {
        bendId: 'b2',
        piece: 0,
        segment: [
          [80, 0],
          [80, 40]
        ],
        direction: 'down',
        angleDeg: 180,
        insideRadius: 1.5,
        kFactor: 0.44,
        bendAllowance: 7.476,
        bendDeduction: null,
        lineLength: 40
      }
    ],
    changedBy
  };
}

function renderDialog(
  overrides: Partial<
    Pick<FlatPatternDialogProps, 'features' | 'loadPattern'>
  > = {}
) {
  const onSave = vi.fn<FlatPatternDialogProps['onSave']>(async () => true);
  const onCopy = vi.fn<FlatPatternDialogProps['onCopy']>(async () => {});
  const onClose = vi.fn<FlatPatternDialogProps['onClose']>();
  const loadPattern =
    overrides.loadPattern ??
    vi.fn<FlatPatternDialogProps['loadPattern']>(async () => bracket());
  render(
    <FlatPatternDialog
      features={overrides.features ?? [{ featureId: SHEET, name: 'Bracket' }]}
      initialFeatureId={SHEET}
      units="mm"
      projectName="Shelf"
      loadPattern={loadPattern}
      onSave={onSave}
      onCopy={onCopy}
      onClose={onClose}
    />
  );
  return { onSave, onCopy, onClose, loadPattern };
}

describe('FlatPatternDialog', () => {
  it('shows the drawing, the flat size and the bend table', async () => {
    const props = renderDialog();
    expect(
      screen.getByRole('dialog', { name: 'Flat pattern — Bracket' })
    ).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Bend table' });
    expect(props.loadPattern).toHaveBeenCalledWith(SHEET);
    const rows = [...table.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => cell.textContent)
    );
    expect(rows).toEqual([
      ['1', 'Up', '90', '2', '0.44', '4.524', '3.476', '40'],
      ['2', 'Down', '180', '1.5', '0.44', '7.476', '—', '40']
    ]);
    expect(table.querySelector('thead')).toHaveTextContent(
      'Inside radius (mm)'
    );
    expect(screen.getByText('96.524 × 40 mm')).toBeInTheDocument();
    const preview = screen.getByRole('img', {
      name: /Flat pattern of Bracket/
    });
    expect(preview.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(preview.getAttribute('src')!)).toContain(
      'data-layer="BEND_DOWN"'
    );
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('warns plainly when later features changed the body', async () => {
    renderDialog({
      loadPattern: vi.fn(async () =>
        bracket([
          { featureId: 'feature_hole' as FeatureId, name: 'Hole 1' },
          { featureId: 'feature_cut' as FeatureId, name: 'Cut 1' }
        ])
      )
    });
    expect(await screen.findByRole('note')).toHaveTextContent(
      '2 later features change this body; the flat pattern shows the sheet before them.'
    );
  });

  it('exports the layered DXF and the SVG, and copies the bend table', async () => {
    const props = renderDialog();
    await screen.findByRole('table', { name: 'Bend table' });

    fireEvent.click(screen.getByRole('button', { name: 'Export DXF' }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    const dxf = props.onSave.mock.calls[0]![0] as {
      fileName: string;
      format: string;
      text: string;
    };
    expect(dxf.fileName).toBe('Shelf-Bracket-flat.dxf');
    expect(dxf.format).toBe('dxf');
    expect(dxf.text).toContain('BEND_UP');
    expect(dxf.text).toContain('BEND_DOWN');
    expect(dxf.text).toContain('UP 90\\U+00B0 R2');
    expect(
      await screen.findByText('Saved Shelf-Bracket-flat.dxf.')
    ).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Export SVG' }));
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(2));
    const svg = props.onSave.mock.calls[1]![0] as {
      fileName: string;
      format: string;
      text: string;
    };
    expect(svg.fileName).toBe('Shelf-Bracket-flat.svg');
    expect(svg.format).toBe('svg');
    expect(svg.text).toContain('<title>Bracket flat pattern</title>');

    fireEvent.click(screen.getByRole('button', { name: 'Copy bend table' }));
    await waitFor(() => expect(props.onCopy).toHaveBeenCalledTimes(1));
    const csv = props.onCopy.mock.calls[0]![0];
    expect(csv.split('\r\n').slice(0, 3)).toEqual([
      'No.,Direction,Angle (°),Inside radius (mm),K-factor,Bend allowance (mm),Bend deduction (mm),Line length (mm)',
      '1,Up,90,2,0.44,4.524,3.476,40',
      '2,Down,180,1.5,0.44,7.476,—,40'
    ]);
    expect(await screen.findByText('Bend table copied as CSV.')).toBeVisible();
  });

  it('reports a pattern that does not build and keeps the actions off', async () => {
    renderDialog({
      loadPattern: vi.fn(async () => {
        throw new Error('sheet-metal:bend-zone-not-clear');
      })
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'sheet-metal:bend-zone-not-clear'
    );
    expect(screen.getByRole('button', { name: 'Export DXF' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export SVG' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: 'Copy bend table' })
    ).toBeDisabled();
  });

  it('switches between sheet-metal features and closes on Escape', async () => {
    const loadPattern = vi.fn(async (featureId: FeatureId) => ({
      ...bracket(),
      featureId
    }));
    const props = renderDialog({
      features: [
        { featureId: SHEET, name: 'Bracket' },
        { featureId: OTHER, name: 'Cover' }
      ],
      loadPattern
    });
    await screen.findByRole('table', { name: 'Bend table' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Sheet metal' }), {
      target: { value: OTHER }
    });
    await waitFor(() => expect(loadPattern).toHaveBeenLastCalledWith(OTHER));
    expect(
      screen.getByRole('dialog', { name: 'Flat pattern — Cover' })
    ).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
