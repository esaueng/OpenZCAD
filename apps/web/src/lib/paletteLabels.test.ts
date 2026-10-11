import { describe, expect, it } from 'vitest';
import { featurePaletteLabel, withDistinctLabels } from './paletteLabels';
import { TOOL_GROUPS, TOOL_META } from './tools';

/** The tool rows as App lists them first in the palette. */
const toolRows = TOOL_GROUPS.flatMap((group) =>
  group.tools.map((toolId) => ({
    id: `tool-${toolId}`,
    label: TOOL_META[toolId].label,
    group: group.label
  }))
);

function duplicateLabels(rows: { label: string }[]): string[] {
  const seen = new Set<string>();
  return rows
    .map((row) => row.label)
    .filter((label) => seen.has(label) || !seen.add(label));
}

describe('palette labels', () => {
  it('lists every tool once', () => {
    expect(duplicateLabels(toolRows)).toEqual([]);
  });

  it('never names a feature row after the tool that made it', () => {
    // A fillet named "Fillet" listed as "Fillet · Feature" beside
    // "Fillet · Edges & faces", and the two did different things.
    const featureRows = toolRows.map((tool) => ({
      id: `feature-${tool.id}`,
      label: featurePaletteLabel(tool.label),
      group: 'Feature'
    }));
    const palette = withDistinctLabels([...toolRows, ...featureRows]);

    expect(duplicateLabels(palette)).toEqual([]);
    expect(palette.find((row) => row.id === 'tool-fillet')?.label).toBe(
      'Fillet'
    );
    expect(palette.find((row) => row.id === 'feature-tool-fillet')?.label).toBe(
      'Go to Fillet'
    );
  });

  it('numbers repeated names in list order, and keeps the first', () => {
    const rows = [
      { id: 'a', label: 'Go to Hole' },
      { id: 'b', label: 'Go to Hole' },
      // A feature already called what the numbering would produce.
      { id: 'c', label: 'Go to Hole (2)' },
      { id: 'd', label: 'Go to Hole' }
    ];
    const palette = withDistinctLabels(rows);

    expect(palette.map((row) => row.label)).toEqual([
      'Go to Hole',
      'Go to Hole (2)',
      'Go to Hole (2) (2)',
      'Go to Hole (3)'
    ]);
    expect(duplicateLabels(palette)).toEqual([]);
    // Rows that were already unique are passed through, not copied.
    expect(palette[0]).toBe(rows[0]);
  });
});
