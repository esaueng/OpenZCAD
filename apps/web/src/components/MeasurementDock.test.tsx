import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { formatMeasurement, type Measurement } from '../lib/measurements';
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
    quality: 'exact-kernel',
    status: 'current',
    sourceRevision: 3,
    sourceUnit: 'mm',
    visible: true
  };
}

function renderDock(
  overrides: Partial<Parameters<typeof MeasurementDock>[0]> = {}
) {
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
    // Named with its visible label, so "click Precision" reaches it.
    expect(screen.getByLabelText('Measurement precision')).toHaveValue('2');
    expect(screen.getByRole('button', { name: 'Diameter' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: 'Radius' })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('offers every precision a stored record can carry', () => {
    renderDock({
      display: { unit: 'mm', precision: 6, radialDisplay: 'diameter' }
    });
    const select = screen.getByLabelText<HTMLSelectElement>(
      'Measurement precision'
    );
    expect([...select.options].map((option) => option.value)).toEqual([
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6'
    ]);
    expect(select).toHaveValue('6');
  });

  it('cancels a row edit on Escape without ending Measure', () => {
    // The workspace's Escape ladder listens on window and closes Measure.
    const workspaceEscape = vi.fn();
    window.addEventListener('keydown', workspaceEscape);
    try {
      const { props, container } = renderDock();
      fireEvent.click(screen.getByLabelText('Edit Bracket · Edge 1'));
      const name = screen.getByLabelText('Name');
      fireEvent.change(name, { target: { value: 'Overall length' } });
      fireEvent.keyDown(name, { key: 'Escape' });

      expect(workspaceEscape).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Name')).toBeNull();
      expect(props.onRename).not.toHaveBeenCalled();
      expect(container.querySelector('.measurement-dock')).not.toBeNull();
      // Focus goes back to the row it was editing, not to the body.
      expect(document.activeElement).toBe(
        screen.getByLabelText('Edit Bracket · Edge 1')
      );
    } finally {
      window.removeEventListener('keydown', workspaceEscape);
    }
  });

  it('hands focus back to the Measure toggle when it closes', () => {
    const toggle = document.createElement('button');
    toggle.setAttribute('aria-label', 'Measure');
    toggle.setAttribute('aria-pressed', 'true');
    document.body.append(toggle);
    try {
      const { unmount } = renderDock();
      screen.getByRole('button', { name: 'Distance' }).focus();
      unmount();
      expect(document.activeElement).toBe(toggle);
    } finally {
      toggle.remove();
    }
  });

  it('leaves focus alone when it closes without holding it', () => {
    const toggle = document.createElement('button');
    toggle.setAttribute('aria-label', 'Measure');
    toggle.setAttribute('aria-pressed', 'true');
    const elsewhere = document.createElement('input');
    document.body.append(toggle, elsewhere);
    try {
      const { unmount } = renderDock();
      elsewhere.focus();
      unmount();
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      toggle.remove();
      elsewhere.remove();
    }
  });

  it('renders value provenance and row actions', () => {
    const { props } = renderDock();
    expect(screen.getByText('84.00 mm')).toBeInTheDocument();
    // An edge length carries no deflection parameter, so it reads Exact. It
    // used to read Kernel, sharing a tier with face areas that are not.
    expect(screen.getByText('Exact')).toBeInTheDocument();
    expect(screen.queryByText('Kernel')).not.toBeInTheDocument();
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

  it('cancels a rename on Escape without the key reaching the workspace', () => {
    // The workspace's Escape (a window listener) turned Measure off, which
    // unmounted the dock and the half-typed name with it.
    const workspace = vi.fn();
    window.addEventListener('keydown', workspace);
    try {
      const { props } = renderDock();
      fireEvent.click(screen.getByLabelText('Edit Bracket · Edge 1'));
      fireEvent.change(screen.getByLabelText('Name'), {
        target: { value: 'Overall' }
      });
      fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Escape' });

      expect(workspace).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Name')).toBeNull();
      expect(props.onRename).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', workspace);
    }
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
