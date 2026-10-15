import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ParameterNode } from '@openzcad/shared';
import { describe, expect, it, vi } from 'vitest';
import { TweakPanel } from './TweakPanel';

const width = {
  id: 'node_width',
  parentId: null,
  revisionId: null,
  kind: 'parameter',
  parameterId: 'parameter_width',
  name: 'width',
  expression: '80',
  value: 80
} as ParameterNode;

function renderPanel(parameters: ParameterNode[]) {
  return render(
    <TweakPanel
      parameters={parameters}
      parameterValues={{ width: 80 }}
      canExport
      exportScope={null}
      onSetParameter={vi.fn()}
      onViewActivityLog={vi.fn()}
      onExportStep={vi.fn()}
      onOpenMeshExport={vi.fn()}
      share={null}
      panelOpen
      onTogglePanel={vi.fn()}
    />
  );
}

describe('TweakPanel', () => {
  /*
    A model with no parameters used to get the how-to intro ("Change a value
    and press Enter…") over an empty table and a two-sentence empty state:
    three sentences explaining nothing to do. One short line now.
  */
  it('says only that there is nothing to adjust when the model has no parameters', () => {
    renderPanel([]);
    const panel = screen.getByRole('complementary', { name: 'Parameters' });
    const lines = [...panel.querySelectorAll('p')].map(
      (line) => line.textContent
    );
    expect(lines).toEqual(['This model offers no parameters to adjust.']);
    expect(panel.querySelector('.param-list')).toBeNull();
  });

  it('keeps the how-to line over a table of values', () => {
    renderPanel([width]);
    const panel = screen.getByRole('complementary', { name: 'Parameters' });
    expect(panel).toHaveTextContent('Change a value and press Enter');
    expect(within(panel).queryByText(/offers no parameters/)).toBeNull();
    expect(panel.querySelector('.param-list')).not.toBeNull();
  });
});

describe('TweakPanel mesh export', () => {
  it('names every format the export dialog offers', () => {
    renderPanel([]);
    // It said "3MF or STL" after OBJ, glTF and PLY had shipped.
    expect(
      screen.getByRole('button', {
        name: 'Export mesh… — 3MF, STL, OBJ, glTF or PLY'
      })
    ).toBeInTheDocument();
  });
});

describe('TweakPanel refusals', () => {
  function parameter(name: string, expression: string): ParameterNode {
    return {
      ...width,
      id: `node_${name}`,
      parameterId: `parameter_${name}`,
      name,
      expression,
      value: Number(expression)
    } as ParameterNode;
  }

  /*
    Three refused base sizes kept their "No change applied" lines after a
    later fin_h edit went through, so the table read as three live errors
    beside a model that had moved on. A refusal answers the table it was
    measured against; the next successful change makes it stale.
  */
  it('clears stale refusals once another parameter change goes through', async () => {
    const user = userEvent.setup();
    const onSetParameter = vi.fn(async (name: string) =>
      name === 'fin_h' ? null : `Changing ${name} would break Fillet 1.`
    );
    const props = {
      parameterValues: { base_w: 60, base_t: 6, fin_h: 20 },
      canExport: true,
      exportScope: null,
      onSetParameter,
      onViewActivityLog: vi.fn(),
      onExportStep: vi.fn(),
      onOpenMeshExport: vi.fn(),
      share: null,
      panelOpen: true,
      onTogglePanel: vi.fn()
    };
    const before = [
      parameter('base_w', '60'),
      parameter('base_t', '6'),
      parameter('fin_h', '20')
    ];
    const { rerender } = render(<TweakPanel {...props} parameters={before} />);
    for (const [name, typed] of [
      ['base_w', '70'],
      ['base_t', '8']
    ] as const) {
      const field = screen.getByLabelText(`Expression for ${name}`);
      await user.clear(field);
      await user.type(field, `${typed}{Enter}`);
    }
    await waitFor(() => expect(screen.getAllByRole('alert')).toHaveLength(2));

    const finHeight = screen.getByLabelText('Expression for fin_h');
    await user.clear(finHeight);
    await user.type(finHeight, '24{Enter}');
    expect(onSetParameter).toHaveBeenLastCalledWith('fin_h', '24');
    // The accepted edit comes back as the new document's table.
    rerender(
      <TweakPanel
        {...props}
        parameterValues={{ base_w: 60, base_t: 6, fin_h: 24 }}
        parameters={[before[0]!, before[1]!, parameter('fin_h', '24')]}
      />
    );
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    expect(screen.getByLabelText('Expression for base_w')).not.toHaveAttribute(
      'aria-invalid'
    );
  });

  it('keeps a refusal while the table it was measured against stands', async () => {
    const user = userEvent.setup();
    const props = {
      parameterValues: { width: 80 },
      canExport: true,
      exportScope: null,
      onSetParameter: vi.fn(async () => 'width must be at most 90 mm.'),
      onViewActivityLog: vi.fn(),
      onExportStep: vi.fn(),
      onOpenMeshExport: vi.fn(),
      share: null,
      panelOpen: true,
      onTogglePanel: vi.fn()
    };
    const { rerender } = render(<TweakPanel {...props} parameters={[width]} />);
    const field = screen.getByLabelText('Expression for width');
    await user.clear(field);
    await user.type(field, '95{Enter}');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'width must be at most 90 mm. No change applied.'
      )
    );
    // A re-render with the same table, as any unrelated app update makes.
    rerender(<TweakPanel {...props} parameters={[{ ...width }]} />);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'width must be at most 90 mm.'
    );
  });
});
