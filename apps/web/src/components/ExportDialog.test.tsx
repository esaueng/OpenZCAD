import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MeshQualityReport } from '@openzcad/kernel-adapter/exact';
import { toBodyId } from '@openzcad/shared';
import { ExportDialog, type ExportDialogProps } from './ExportDialog';

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
      bodies: [
        {
          bodyId: toBodyId('body_a'),
          boundaryEdges: 0,
          nonManifoldEdges: 0,
          watertight: true
        },
        {
          bodyId: toBodyId('body_b'),
          boundaryEdges: 3,
          nonManifoldEdges: 1,
          watertight: false
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
  bodies: bodyIds.map((bodyId) => ({
    bodyId: toBodyId(bodyId),
    boundaryEdges: 0,
    nonManifoldEdges: 0,
    watertight: true
  }))
});

/** The options argument every printability check carries. */
function exportOptions() {
  return expect.anything() as unknown;
}

describe('ExportDialog', () => {
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
    expect(screen.getByText(/3 open, 1 non-manifold edge/)).toBeInTheDocument();
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
});
