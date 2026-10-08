import { render, screen, within } from '@testing-library/react';
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
        name: 'Export Mesh… — 3MF, STL, OBJ, glTF or PLY'
      })
    ).toBeInTheDocument();
  });
});
