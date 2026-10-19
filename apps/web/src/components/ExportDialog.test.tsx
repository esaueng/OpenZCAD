import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MeshQualityReport } from '@openzcad/kernel-adapter/exact';
import { toBodyId } from '@openzcad/shared';
import { ExportDialog, type ExportDialogProps } from './ExportDialog';

function measured(triangleCount: number, maxDeviation: number) {
  return {
    triangleCount,
    maxDeviation,
    sampledTriangles: triangleCount,
    totalTriangles: triangleCount
  };
}

function renderDialog(overrides: Partial<ExportDialogProps> = {}) {
  const props: ExportDialogProps = {
    scopeLabel: 'all bodies (2)',
    bodies: [
      { bodyId: 'body_a', name: 'Base' },
      { bodyId: 'body_b', name: 'Boss' }
    ],
    revision: 7,
    onClose: vi.fn(),
    onExport: vi.fn(),
    onCheckQuality: vi.fn(async (): Promise<MeshQualityReport> => ({
      watertight: true,
      triangleCount: 1_248,
      maxDeviation: 0.0712,
      sampled: false,
      bodies: [
        {
          bodyId: toBodyId('body_a'),
          boundaryEdges: 0,
          nonManifoldEdges: 0,
          watertight: true,
          ...measured(1_000, 0.0712)
        },
        {
          bodyId: toBodyId('body_b'),
          boundaryEdges: 3,
          nonManifoldEdges: 1,
          watertight: false,
          ...measured(248, 0)
        }
      ]
    })),
    ...overrides
  };
  const { rerender } = render(<ExportDialog {...props} />);
  return {
    ...props,
    rerender: (next: Partial<ExportDialogProps>) =>
      rerender(<ExportDialog {...props} {...next} />)
  };
}

const watertight = (...bodyIds: string[]): MeshQualityReport => ({
  watertight: true,
  triangleCount: 12 * bodyIds.length,
  maxDeviation: 0,
  sampled: false,
  bodies: bodyIds.map((bodyId) => ({
    bodyId: toBodyId(bodyId),
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    watertight: true,
    ...measured(12, 0)
  }))
});

/** The options argument every printability check carries. */
function exportOptions() {
  return expect.anything() as unknown;
}

describe('ExportDialog', () => {
  it('offers hidden bodies as an explicit choice and refuses an empty export (ZC-199)', async () => {
    const user = userEvent.setup();
    const onIncludeHiddenChange = vi.fn();
    const dialog = renderDialog({
      scopeLabel: 'all bodies (2, 1 hidden)',
      hiddenBodies: 1,
      includeHidden: true,
      onIncludeHiddenChange
    });
    expect(
      screen.getByText(/Exports all bodies \(2, 1 hidden\)/)
    ).toBeVisible();
    const box = screen.getByRole('checkbox', { name: 'Include 1 hidden body' });
    expect(box).toBeChecked();
    await user.click(box);
    expect(onIncludeHiddenChange).toHaveBeenCalledWith(false);
    // Everything visible was hidden: the dialog stays to undo the choice,
    // but there is nothing to write.
    dialog.rerender({
      scopeLabel: 'visible bodies (0, 1 hidden left out)',
      bodies: [],
      includeHidden: false
    });
    expect(
      screen.getByRole('checkbox', { name: 'Include 1 hidden body' })
    ).not.toBeChecked();
    expect(screen.getByRole('button', { name: /^Export 3MF/ })).toBeDisabled();
    // Nothing to check either.
    expect(screen.getByRole('button', { name: /watertight/i })).toBeDisabled();
  });

  it('shows no hidden-body choice when nothing is hidden', () => {
    renderDialog();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('exports 3MF at the standard preset by default', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));

    await waitFor(() => expect(props.onExport).toHaveBeenCalledOnce());
    expect(props.onExport).toHaveBeenCalledWith('3mf', 0.08);
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('sends the chosen format and preset deflection', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('radio', { name: /STL \(binary\)/ }));
    await user.click(screen.getByRole('button', { name: /Fine/ }));
    await user.click(screen.getByRole('button', { name: /Export STL/ }));

    await waitFor(() =>
      expect(props.onExport).toHaveBeenCalledWith('stl-binary', 0.02)
    );
  });

  it('offers OBJ and glTF formats', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('radio', { name: /glTF \(GLB\)/ }));
    await user.click(screen.getByRole('button', { name: /Export glTF/ }));

    await waitFor(() =>
      expect(props.onExport).toHaveBeenCalledWith('glb', 0.08)
    );
    expect(screen.queryByRole('radio', { name: /OBJ/ })).not.toBeNull();
  });

  it('names glTF’s own unit rather than the slicers’ millimeters', async () => {
    const user = userEvent.setup();
    renderDialog();
    expect(screen.getByText(/in millimeters, ready for slicing/)).toBeVisible();

    await user.click(screen.getByLabelText(/glTF \(GLB\)/));

    expect(screen.getByText(/in meters, the unit glTF defines/)).toBeVisible();
  });

  /** The selected preset was shown by its colour alone. */
  it('exposes the selected quality preset as pressed', async () => {
    const user = userEvent.setup();
    renderDialog();
    const standard = screen.getByRole('button', { name: /Standard/ });
    const fine = screen.getByRole('button', { name: /Fine/ });
    const custom = screen.getByRole('button', { name: 'Custom' });
    expect(standard).toHaveAttribute('aria-pressed', 'true');
    expect(fine).toHaveAttribute('aria-pressed', 'false');
    expect(custom).toHaveAttribute('aria-pressed', 'false');

    await user.click(fine);
    expect(fine).toHaveAttribute('aria-pressed', 'true');
    expect(standard).toHaveAttribute('aria-pressed', 'false');
    await user.click(custom);
    expect(custom).toHaveAttribute('aria-pressed', 'true');
    expect(fine).toHaveAttribute('aria-pressed', 'false');
  });

  it('offers binary PLY at the standard preset', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('radio', { name: /PLY \(binary\)/ }));
    await user.click(screen.getByRole('button', { name: /Export PLY/ }));

    await waitFor(() =>
      expect(props.onExport).toHaveBeenCalledWith('ply', 0.08)
    );
  });

  it('blocks export while a custom deviation is out of range', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Custom' }));
    const input = screen.getByLabelText(/Max chord deviation/);
    await user.clear(input);
    await user.type(input, '7');

    expect(screen.getByRole('alert')).toHaveTextContent(/between 0.001 and 1/);
    expect(screen.getByRole('button', { name: /Export 3MF/ })).toBeDisabled();

    await user.clear(input);
    await user.type(input, '0.5');
    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));
    await waitFor(() =>
      expect(props.onExport).toHaveBeenCalledWith('3mf', 0.5)
    );
  });

  it('names each body in the printability report', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );

    await waitFor(() =>
      expect(props.onCheckQuality).toHaveBeenCalledWith(0.08, exportOptions())
    );
    expect(screen.getByText('Base')).toBeInTheDocument();
    expect(screen.getByText('Boss')).toBeInTheDocument();
    expect(
      screen.getByText('3 open edges, 1 non-manifold edge')
    ).toBeInTheDocument();
  });

  it('reports the measured deviation and triangle count of the checked mesh', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );

    expect(
      await screen.findByText(
        '1,248 triangles · measured deviation 0.071 mm of 0.08 mm allowed'
      )
    ).toBeInTheDocument();
  });

  it('sends a tighter facet angle to the check and the export, in radians', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Max facet angle' }),
      '5'
    );
    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    await waitFor(() =>
      expect(props.onCheckQuality).toHaveBeenCalledWith(
        0.08,
        expect.objectContaining({ angularTolerance: (5 * Math.PI) / 180 })
      )
    );
    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));
    expect(props.onExport).toHaveBeenCalledWith('3mf', 0.08, {
      angularTolerance: (5 * Math.PI) / 180
    });
  });

  it('keeps the default angle off the wire so default exports are unchanged', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    await waitFor(() => expect(props.onCheckQuality).toHaveBeenCalledOnce());
    const [deflection, options] = vi.mocked(props.onCheckQuality).mock
      .calls[0]!;
    expect(deflection).toBe(0.08);
    expect(options).not.toHaveProperty('angularTolerance');
  });

  it('checks in the unit the file will be meshed in, and goes stale when it changes', async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      exportUnits: 'inch',
      documentUnits: 'mm',
      onExportUnitsChange: vi.fn()
    });
    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    await waitFor(() =>
      expect(props.onCheckQuality).toHaveBeenCalledWith(
        0.08,
        expect.objectContaining({ units: 'inch' })
      )
    );
    await screen.findByText(/measured deviation/);
    // Another export unit is another float32 mesh: the verdict is stale.
    props.rerender({ exportUnits: 'cm' });
    expect(screen.queryByText(/measured deviation/)).toBeNull();
    expect(screen.getByText(/Quality changed/)).toBeVisible();
    // glTF meshes in millimetres whatever the preference says.
    await user.click(screen.getByRole('radio', { name: 'glTF (GLB)' }));
    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    await waitFor(() => expect(props.onCheckQuality).toHaveBeenCalledTimes(2));
    expect(
      vi.mocked(props.onCheckQuality).mock.calls[1]![1]
    ).not.toHaveProperty('units');
  });

  it('marks a report stale when the facet angle changes', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    await screen.findByText(/measured deviation/);
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Max facet angle' }),
      '10'
    );
    expect(screen.queryByText(/measured deviation/)).toBeNull();
    expect(screen.getByText(/Quality changed/)).toBeVisible();
  });

  it('writes in the export unit and offers the preference beside the format', async () => {
    const user = userEvent.setup();
    const onExportUnitsChange = vi.fn();
    const props = renderDialog({
      exportUnits: 'document',
      documentUnits: 'inch',
      onExportUnitsChange
    });

    expect(
      screen.getByText(/in inches, declared in the package\./)
    ).toBeInTheDocument();
    const units = screen.getByRole('combobox', { name: 'Units' });
    expect(units).toHaveValue('document');
    expect(
      screen.getByRole('option', { name: 'Project (inches)' })
    ).toBeInTheDocument();
    await user.selectOptions(units, 'mm');
    expect(onExportUnitsChange).toHaveBeenCalledWith('mm');

    props.rerender({ exportUnits: 'cm' });
    await user.click(screen.getByRole('radio', { name: 'OBJ' }));
    expect(
      screen.getByText(/in centimeters\. The file does not record its unit\./)
    ).toBeInTheDocument();
    // glTF is metres by definition: the unit choice stands aside.
    await user.click(screen.getByRole('radio', { name: 'glTF (GLB)' }));
    expect(screen.getByText(/in meters, the unit glTF defines/)).toBeVisible();
    expect(screen.getByRole('combobox', { name: 'Units' })).toBeDisabled();
  });

  it('marks a report stale when the quality changes', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    await waitFor(() => expect(props.onCheckQuality).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: /Draft/ }));
    expect(screen.getByText(/re-check to see the new verdict/)).toBeVisible();
  });

  it('marks a report stale when the exported bodies change', async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      scopeLabel: 'Base',
      bodies: [{ bodyId: 'body_a', name: 'Base' }],
      onCheckQuality: vi.fn(async () => watertight('body_a'))
    });

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    expect(await screen.findByText('watertight')).toBeVisible();

    props.rerender({
      scopeLabel: 'all bodies (2)',
      bodies: [
        { bodyId: 'body_a', name: 'Base' },
        { bodyId: 'body_b', name: 'Boss' }
      ]
    });
    expect(screen.queryByText('watertight')).toBeNull();
    expect(
      screen.getByText(/bodies being exported changed — re-check/)
    ).toBeVisible();
  });

  it('marks a report stale when the model changes under it', async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      onCheckQuality: vi.fn(async () => watertight('body_a', 'body_b'))
    });

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    expect(await screen.findAllByText('watertight')).toHaveLength(2);

    props.rerender({ revision: 8 });
    expect(screen.queryByText('watertight')).toBeNull();
  });

  it('reads a verdict that lands after the scope moved as stale', async () => {
    const user = userEvent.setup();
    let resolve: (report: MeshQualityReport) => void = () => {};
    const props = renderDialog({
      onCheckQuality: vi.fn(
        () =>
          new Promise<MeshQualityReport>((done) => {
            resolve = done;
          })
      )
    });

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    props.rerender({ revision: 8 });
    resolve(watertight('body_a', 'body_b'));

    expect(
      await screen.findByText(/bodies being exported changed — re-check/)
    ).toBeVisible();
    expect(screen.queryByText('watertight')).toBeNull();
  });

  /**
   * Disabling the focused check button dropped focus on the body, so Escape
   * reached the workspace behind the modal and cleared its selection.
   */
  it('keeps focus on the check button while the check runs', async () => {
    const user = userEvent.setup();
    let resolve: (report: MeshQualityReport) => void = () => {};
    renderDialog({
      onCheckQuality: vi.fn(
        () =>
          new Promise<MeshQualityReport>((done) => {
            resolve = done;
          })
      )
    });
    const check = screen.getByRole('button', {
      name: /Check watertightness/
    });

    await user.click(check);
    expect(check).toHaveAttribute('aria-disabled', 'true');
    expect(check).toHaveFocus();
    resolve(watertight('body_a', 'body_b'));

    expect(await screen.findByRole('button', { name: /Re-check/ })).toBe(check);
    expect(check).toHaveFocus();
    expect(check).not.toHaveAttribute('aria-disabled');
  });

  it('closes on Escape when focus has left the dialog', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    await user.keyboard('{Escape}');

    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it('closes once on Escape from a control inside it', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    screen.getByRole('button', { name: /Draft/ }).focus();
    await user.keyboard('{Escape}');

    expect(props.onClose).toHaveBeenCalledOnce();
  });

  /**
   * The export is the host's from the moment it starts: the dialog holds
   * choices, not progress, and a modal over the pill that reports the run
   * would hide the workspace the export leaves live.
   */
  it('hands the export to the host and closes at once', async () => {
    const user = userEvent.setup();
    const props = renderDialog();

    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));

    expect(props.onExport).toHaveBeenCalledWith('3mf', 0.08);
    expect(props.onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names each format radio and the printability check', async () => {
    const user = userEvent.setup();
    renderDialog();

    // Each radio is named by its format, described by its hint, and carries
    // a value of its own: every one used to report the default value "on".
    const stl = screen.getByRole('radio', { name: 'STL (binary)' });
    expect(stl).toHaveAttribute('value', 'stl-binary');
    expect(stl).toHaveAccessibleDescription('Single merged mesh, compact');
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).not.toHaveAttribute('value', 'on');
      expect(radio.getAttribute('aria-label')).toBeTruthy();
    }

    const check = screen.getByRole('button', { name: 'Check watertightness' });
    expect(check).toHaveAttribute('aria-label', 'Check watertightness');
    await user.click(check);
    expect(
      await screen.findByRole('button', { name: 'Re-check watertightness' })
    ).toBe(check);
    // The visible label fills the width it reserves; a bare "Re-check" sat
    // in a button sized for the longer label.
    expect(check).toHaveTextContent('Re-check watertightness');
  });
});
