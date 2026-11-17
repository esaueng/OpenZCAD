import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type {
  BodyRepresentation,
  ConfigurationSet,
  FeatureNode,
  ParameterNode
} from '@openzcad/shared';
import {
  ConfigurationTable,
  type ConfigurationActions
} from './ConfigurationTable';

const width = {
  id: 'node_width',
  kind: 'parameter',
  parameterId: 'parameter_width',
  name: 'width',
  expression: '20',
  value: 20
} as unknown as ParameterNode;

const lug = {
  id: 'node_lug',
  kind: 'feature',
  featureId: 'feature_lug',
  name: 'Lug'
} as unknown as FeatureNode;

const lugBody = {
  bodyId: 'body_lug',
  name: 'Lug body'
} as unknown as BodyRepresentation;

const set: ConfigurationSet = {
  columns: [
    { kind: 'parameter', parameterId: width.parameterId },
    { kind: 'suppression', featureId: lug.featureId },
    { kind: 'body', bodyId: lugBody.bodyId },
    { kind: 'material' }
  ],
  rows: [
    {
      id: 'small',
      name: 'Small',
      parameters: { [width.parameterId]: '20' },
      suppressed: { [lug.featureId]: false },
      bodies: { [lugBody.bodyId]: true },
      material: { kind: 'unit' }
    },
    {
      id: 'large',
      name: 'Large',
      parameters: { [width.parameterId]: '45' },
      suppressed: { [lug.featureId]: true },
      bodies: { [lugBody.bodyId]: false },
      material: { kind: 'preset', presetId: 'steel' }
    }
  ],
  activeRowId: 'small'
};

function actions(): ConfigurationActions {
  return {
    create: vi.fn().mockReturnValue(null),
    remove: vi.fn().mockReturnValue(null),
    addRow: vi.fn().mockReturnValue(null),
    renameRow: vi.fn().mockReturnValue(null),
    deleteRow: vi.fn().mockReturnValue(null),
    addColumn: vi.fn().mockReturnValue(null),
    deleteColumn: vi.fn().mockReturnValue(null),
    setCell: vi.fn().mockReturnValue(null),
    activate: vi.fn().mockReturnValue(null)
  };
}

function renderTable(
  configurations: ConfigurationSet | undefined,
  run: ConfigurationActions | null = actions()
) {
  render(
    <ConfigurationTable
      configurations={configurations}
      parameters={[width]}
      features={[lug]}
      bodies={[lugBody]}
      {...(run ? { actions: run } : {})}
    />
  );
  return run;
}

describe('ConfigurationTable', () => {
  it('offers to start a table on a model without one', async () => {
    const run = renderTable(undefined)!;
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Add configurations/ })
      );
    });
    expect(run.create).toHaveBeenCalledWith('Default');
  });

  it('shows each row against each column, with the active row checked', () => {
    renderTable(set);
    expect(screen.getByRole('radio', { name: 'Use Small' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Use Large' })).not.toBeChecked();
    expect(screen.getByLabelText('width, Large')).toHaveValue('45');
    expect(screen.getByLabelText('Lug built, Small')).toBeChecked();
    expect(screen.getByLabelText('Lug built, Large')).not.toBeChecked();
    expect(screen.getByLabelText('Lug body shown, Large')).not.toBeChecked();
    expect(screen.getByLabelText('Material, Large')).toHaveValue(
      'preset:steel'
    );
    // The active row cannot be deleted; another can.
    expect(screen.queryByRole('button', { name: 'Delete Small' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Delete Large' })).toBeEnabled();
  });

  it('activates, edits cells and adds rows and columns through its actions', async () => {
    const run = renderTable(set)!;
    await act(async () => {
      fireEvent.click(screen.getByRole('radio', { name: 'Use Large' }));
    });
    expect(run.activate).toHaveBeenCalledWith('large');
    const cell = screen.getByLabelText('width, Large');
    await act(async () => {
      fireEvent.change(cell, { target: { value: '50' } });
      fireEvent.keyDown(cell, { key: 'Enter' });
    });
    expect(run.setCell).toHaveBeenCalledWith('large', set.columns[0], '50');
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Lug built, Small'));
    });
    expect(run.setCell).toHaveBeenCalledWith('small', set.columns[1], true);
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Material, Small'), {
        target: { value: 'preset:brass' }
      });
    });
    expect(run.setCell).toHaveBeenCalledWith('small', set.columns[3], {
      kind: 'preset',
      presetId: 'brass'
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: /Add configuration$/ })
      );
    });
    expect(run.addRow).toHaveBeenCalledWith('Configuration 3');
    // Every column is already used, so the picker offers none.
    expect(
      screen
        .getByRole('combobox', { name: 'Add column' })
        .querySelectorAll('option')
    ).toHaveLength(1);
  });

  it('reverts a refused cell and says why', async () => {
    const run = actions();
    run.setCell = vi.fn().mockReturnValue('Configuration "Large": bad value');
    renderTable(set, run);
    const cell = screen.getByLabelText('width, Large');
    await act(async () => {
      fireEvent.change(cell, { target: { value: 'oops' } });
      fireEvent.blur(cell);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('bad value');
    expect(cell).toHaveValue('45');
  });

  it('is read-only without actions', () => {
    renderTable(set, null);
    expect(screen.getByRole('radio', { name: 'Use Large' })).toBeDisabled();
    expect(screen.getByLabelText('width, Large')).toHaveAttribute('readonly');
    expect(
      screen.queryByRole('button', { name: /Add configuration/ })
    ).toBeNull();
  });

  it('exports any row, even read-only (F06 slice 2)', async () => {
    const onExportRow = vi.fn();
    render(
      <ConfigurationTable
        configurations={set}
        parameters={[width]}
        features={[lug]}
        bodies={[lugBody]}
        onExportRow={onExportRow}
      />
    );
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Export Large'), {
        target: { value: 'step' }
      });
    });
    expect(onExportRow).toHaveBeenCalledWith('large', 'step');
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Export Small'), {
        target: { value: 'mesh' }
      });
    });
    expect(onExportRow).toHaveBeenCalledWith('small', 'mesh');
    // The picker resets, ready for the next export.
    expect(screen.getByLabelText('Export Large')).toHaveValue('');
  });
});
