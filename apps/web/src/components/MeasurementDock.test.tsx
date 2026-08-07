import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  formatMeasurement,
  type Measurement
} from '../lib/measurements';
import { MeasurementDock } from './MeasurementDock';

function measurement(): Measurement {
  return {
    id: 'edge:b1/e1',
    kind: 'edge-length',
    label: 'Bracket · Edge 1',
    targets: [
      {
        bodyId: 'b1' as Measurement['targets'][number]['bodyId'],
        bodyName: 'Bracket',
        kind: 'edge',
        topologyId: 'edge:1',
        label: 'Bracket · Edge 1',
        semantic: 'edge-midpoint',
        quality: 'exact-analytic'
      }
    ],
    result: { value: 84, dimension: 'length' },
    quality: 'kernel-integrated',
    status: 'current',
    sourceRevision: 3,
    sourceUnit: 'mm',
    visible: true
  };
}

function renderDock(overrides: Partial<Parameters<typeof MeasurementDock>[0]> = {}) {
  const props: Parameters<typeof MeasurementDock>[0] = {
    measurements: [measurement()],
    formattedMeasurements: {
      'edge:b1/e1': formatMeasurement(measurement(), {
        unit: 'mm',
        precision: 2,
        radialDisplay: 'diameter'
      })
    },
    enabled: true,
    activeMeasurementId: null,
    mode: 'smart',
    draftTargetLabel: null,
    display: { unit: 'mm', precision: 2, radialDisplay: 'diameter' },
    onMode: vi.fn(),
    onUnit: vi.fn(),
    onPrecision: vi.fn(),
    onRadialDisplay: vi.fn(),
    onSelect: vi.fn(),
    onToggleVisibility: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onClear: vi.fn(),
    onCopy: vi.fn(),
    onExport: vi.fn(),
    ...overrides
  };
  return { ...render(<MeasurementDock {...props} />), props };
}

describe('MeasurementDock', () => {
  it('exposes explicit Smart, Distance, and Angle workflows', () => {
    const { props } = renderDock();
    fireEvent.click(screen.getByRole('button', { name: 'Distance' }));
    expect(props.onMode).toHaveBeenCalledWith('distance');
    expect(screen.getByLabelText('Measurement units')).toHaveValue('mm');
    expect(screen.getByLabelText('Measurement decimal places')).toHaveValue('2');
  });

  it('renders value provenance and row actions', () => {
    const { props } = renderDock();
    expect(screen.getByText('84.00 mm')).toBeInTheDocument();
    expect(screen.getByText('Kernel')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Hide Bracket · Edge 1'));
    fireEvent.click(screen.getByLabelText('Copy Bracket · Edge 1'));
    fireEvent.click(screen.getByLabelText('Delete Bracket · Edge 1'));
    expect(props.onToggleVisibility).toHaveBeenCalledWith('edge:b1/e1');
    expect(props.onCopy).toHaveBeenCalledWith(props.measurements[0]);
    expect(props.onDelete).toHaveBeenCalledWith('edge:b1/e1');
  });

  it('renames a row and records an inspection note', () => {
    const { props } = renderDock();
    fireEvent.click(screen.getByLabelText('Edit Bracket · Edge 1'));
    fireEvent.change(screen.getByLabelText('Name'), {
      target: { value: 'Overall length' }
    });
    fireEvent.change(screen.getByLabelText('Note'), {
      target: { value: 'Within tolerance' }
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(props.onRename).toHaveBeenCalledWith(
      'edge:b1/e1',
      'Overall length',
      'Within tolerance'
    );
  });

  it('announces the two-pick progress state', () => {
    renderDock({
      mode: 'distance',
      draftTargetLabel: 'Bracket · Hole center'
    });
    expect(
      screen.getByText(
        'Bracket · Hole center selected. Pick the second target.'
      )
    ).toHaveAttribute('aria-live', 'polite');
  });
});
