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
    onClose: vi.fn(),
    onExport: vi.fn(async () => undefined),
    onCheckQuality: vi.fn(
      async (): Promise<MeshQualityReport> => ({
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
      })
    ),
    ...overrides
  };
  render(<ExportDialog {...props} />);
  return props;
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

    await waitFor(() => expect(props.onExport).toHaveBeenCalledWith('glb', 0.08));
    expect(screen.queryByRole('radio', { name: /OBJ/ })).not.toBeNull();
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
      expect(props.onCheckQuality).toHaveBeenCalledWith(0.08)
    );
    expect(screen.getByText('Base')).toBeInTheDocument();
    expect(screen.getByText('Boss')).toBeInTheDocument();
    expect(
      screen.getByText(/3 open, 1 non-manifold edge/)
    ).toBeInTheDocument();
  });

  it('marks a report stale when the quality changes and shows export errors', async () => {
    const user = userEvent.setup();
    const props = renderDialog({
      onExport: vi.fn(async () => {
        throw new Error('The export failed downstream.');
      })
    });

    await user.click(
      screen.getByRole('button', { name: /Check watertightness/ })
    );
    await waitFor(() => expect(props.onCheckQuality).toHaveBeenCalledOnce());
    await user.click(screen.getByRole('button', { name: /Draft/ }));
    expect(screen.getByText(/re-check to see the new verdict/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Export 3MF/ }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The export failed downstream.'
      )
    );
    expect(props.onClose).not.toHaveBeenCalled();
  });
});
