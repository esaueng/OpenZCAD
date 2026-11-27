import { describe, expect, it } from 'vitest';
import {
  ANNOTATION_TOOL_LABELS,
  isGeometryTool,
  isToleranceTool
} from './annotationPicking';
import {
  ANNOTATION_TOOL_NAMES,
  DRAWING_TOOL_ACTIONS,
  drawingToolAction,
  drawingToolActionForKey
} from './toolActions';
import {
  ANNOTATION_TOOL_KEYS,
  ANNOTATION_TOOLS,
  AUXILIARY_TOOL_KEY,
  DETAIL_TOOL_KEY,
  SECTION_TOOL_KEY
} from './toolKeys';
import { TOOL_META } from '../tools';

describe('Draw’s tool actions', () => {
  it('lists the 22 annotation tools in toolbar order, then the 3 view tools', () => {
    expect(DRAWING_TOOL_ACTIONS.map((action) => action.id)).toEqual([
      ...ANNOTATION_TOOLS.map((kind) => `drawing-${kind}`),
      'drawing-section-view',
      'drawing-detail-view',
      'drawing-auxiliary-view'
    ]);
    for (const kind of ANNOTATION_TOOLS) {
      expect(drawingToolAction(`drawing-${kind}`)?.key).toBe(
        ANNOTATION_TOOL_KEYS[kind]
      );
    }
    expect(drawingToolAction('drawing-section-view')?.key).toBe(
      SECTION_TOOL_KEY
    );
    expect(drawingToolAction('drawing-detail-view')?.key).toBe(DETAIL_TOOL_KEY);
    expect(drawingToolAction('drawing-auxiliary-view')?.key).toBe(
      AUXILIARY_TOOL_KEY
    );
  });

  it('answers each key, either case, with one tool', () => {
    const keys = DRAWING_TOOL_ACTIONS.map((action) => action.key.toLowerCase());
    expect(new Set(keys).size).toBe(keys.length);
    for (const action of DRAWING_TOOL_ACTIONS) {
      expect(drawingToolActionForKey(action.key)).toBe(action);
      expect(drawingToolActionForKey(action.key.toLowerCase())).toBe(action);
    }
    expect(drawingToolActionForKey('Z')).toBeUndefined();
    expect(drawingToolActionForKey('Escape')).toBeUndefined();
  });

  it('names a dimension as one, as the toolbar’s tooltip always did', () => {
    for (const kind of ANNOTATION_TOOLS) {
      const plain =
        kind === 'note' ||
        kind === 'balloon' ||
        kind === 'parts-list' ||
        kind === 'hole-table' ||
        kind === 'image' ||
        kind === 'general-tolerance' ||
        isToleranceTool(kind) ||
        isGeometryTool(kind);
      expect(ANNOTATION_TOOL_NAMES[kind], kind).toBe(
        plain
          ? ANNOTATION_TOOL_LABELS[kind]
          : `${ANNOTATION_TOOL_LABELS[kind]} dimension`
      );
    }
  });

  it('gives each command-bar row a name no modeling tool has', () => {
    const toolNames = new Set(
      Object.values(TOOL_META).map((meta) => meta.label)
    );
    const names = DRAWING_TOOL_ACTIONS.map((action) => action.searchName);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(toolNames.has(name), name).toBe(false);
    expect(drawingToolAction('drawing-image')?.searchName).toBe('Sheet image');
    expect(drawingToolAction('drawing-note')?.searchName).toBe('Note');
  });
});
