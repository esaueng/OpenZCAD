import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  FileDown,
  Files,
  LayoutGrid,
  PencilLine,
  PencilRuler,
  Plus,
  Scissors,
  SlidersHorizontal,
  SquareArrowOutUpRight,
  Trash2,
  X,
  ZoomIn
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import {
  MAX_DRAWING_TEXT_LENGTH,
  type DrawingSheet,
  type DrawingSheetId
} from '@openzcad/shared';
import {
  ANNOTATION_TOOL_LABELS,
  type AnnotationToolKind
} from '../../lib/drawing/annotationPicking';
import {
  COMPACT_ANNOTATION_GROUPS,
  COMPACT_ANNOTATION_WORDS
} from '../../lib/drawing/compactDraw';
import { ANNOTATION_TOOL_ICONS } from '../drawingToolIcons';
import { useCompactTray } from './compactSlots';
import { TrayPage, TrayRow, type TrayItem } from './CompactTray';

/** A view tool (section, detail, auxiliary), as the drawing toolbar has it. */
export interface CompactDrawToolControl {
  active: boolean;
  usable: boolean;
  disabledReason: string;
  onToggle(): void;
}

/** The tool running now: its row stands in for the tray. */
export interface CompactDrawRun {
  /** The tool's name ("Horizontal", "Section view"). */
  label: string;
  icon: ReactNode;
  /** What it asks for next, a word or two ("Point 2"). */
  step: string;
  /** The same, as the sentence the regular workspace shows. */
  hint: string;
  onCancel(): void;
  onDone(): void;
}

/** The sheets, and what the regular workspace's sheet tabs do with them. */
export interface CompactDrawSheets {
  sheets: readonly DrawingSheet[];
  activeId: DrawingSheetId | null;
  onSelect(sheetId: DrawingSheetId): void;
  onCreate(): void;
  onRename(sheetId: DrawingSheetId, name: string): void;
  onDuplicate(sheetId: DrawingSheetId): void;
  onMove(sheetId: DrawingSheetId, index: number): void;
  onDelete(sheetId: DrawingSheetId): void;
  /** Why sheet edits are refused, or null. */
  editDisabledReason: string | null;
  /** Why a new sheet is refused now, or null. */
  createDisabledReason: string | null;
}

export type CompactDrawExportFormat = 'pdf' | 'svg' | 'dxf';

/** What the open sheet offers; absent before the first sheet. */
export interface CompactDrawSheet {
  annotate: {
    active: AnnotationToolKind | null;
    canUse(kind: AnnotationToolKind): boolean;
    disabledReason(kind: AnnotationToolKind): string;
    onTool(kind: AnnotationToolKind): void;
    /** The dimension check, with Auto-dimension and its preview. */
    check: ReactNode;
    /** The sheet's annotations, to pick one for its properties. */
    list: ReactNode;
  };
  viewTools: Record<'section' | 'detail' | 'auxiliary', CompactDrawToolControl>;
  /** The sheet's views: the list, New view, Fit and Auto scale. */
  views: ReactNode;
  /** The selected view's configuration and Delete view, or null. */
  selectedView: ReactNode | null;
  /** The selected annotation's properties, or the sheet's. */
  properties: ReactNode;
  /** A view or an annotation is selected. */
  hasSelection: boolean;
  exports: {
    /** Why export is refused now, or null. */
    reason: string | null;
    onExport(format: CompactDrawExportFormat): void;
    /** Annotations that lost what they measure. */
    broken: number;
    canDeleteBroken: boolean;
    onDeleteBroken(): void;
  };
  /** The workspace asks for the properties (a note just placed). */
  propertiesRequested: boolean;
  onPropertiesShown(): void;
}

export interface CompactDrawTrayProps {
  sheets: CompactDrawSheets;
  sheet: CompactDrawSheet | null;
  run: CompactDrawRun | null;
}

type DrawPage = 'annotate' | 'views' | 'sheets' | 'properties' | 'export';

const PAGE_TITLES: Record<DrawPage, string> = {
  annotate: 'Annotate',
  views: 'Views',
  sheets: 'Sheets',
  properties: 'Properties',
  export: 'Export'
};

const NO_SHEET = 'Add a sheet first.';

/** A tile in a page's grid: an icon with one word, its name for AT. */
function ToolTile({
  label,
  word,
  icon,
  active,
  disabledReason,
  onPress,
  onRefused
}: {
  label: string;
  word: string;
  icon: ReactNode;
  active: boolean;
  disabledReason: string | null;
  onPress(): void;
  onRefused(reason: string): void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`compact-tool-tile${active ? ' active' : ''}`}
        aria-label={label}
        aria-pressed={active}
        aria-disabled={disabledReason !== null}
        title={disabledReason ?? label}
        onClick={() =>
          disabledReason === null
            ? onPress()
            : onRefused(`${label}: ${disabledReason}`)
        }
      >
        <span className="compact-tool-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="compact-tool-label" aria-hidden="true">
          {word}
        </span>
      </button>
    </li>
  );
}

/** A refused tile's reason, under the page's top until another tap. */
function useReason() {
  const [reason, setReason] = useState<string | null>(null);
  const line = reason ? (
    <p className="compact-tray-reason" role="status">
      {reason}
    </p>
  ) : null;
  return [line, setReason] as const;
}

function AnnotatePage({
  sheet,
  onStart
}: {
  sheet: CompactDrawSheet;
  onStart(start: () => void): void;
}) {
  const { annotate } = sheet;
  const [reasonLine, showReason] = useReason();
  const headingId = useId();
  return (
    <div className="compact-draw-page">
      {reasonLine}
      {COMPACT_ANNOTATION_GROUPS.map((group) => (
        <section
          key={group.id}
          className="compact-tool-group"
          aria-labelledby={`${headingId}-${group.id}`}
        >
          <h3
            id={`${headingId}-${group.id}`}
            className="compact-tool-group-title"
          >
            {group.label}
          </h3>
          <ul className="compact-tool-grid">
            {group.tools.map((kind) => {
              const Icon = ANNOTATION_TOOL_ICONS[kind];
              return (
                <ToolTile
                  key={kind}
                  label={ANNOTATION_TOOL_LABELS[kind]}
                  word={COMPACT_ANNOTATION_WORDS[kind]}
                  icon={<Icon size={22} />}
                  active={annotate.active === kind}
                  disabledReason={
                    annotate.canUse(kind) ? null : annotate.disabledReason(kind)
                  }
                  onPress={() => onStart(() => annotate.onTool(kind))}
                  onRefused={showReason}
                />
              );
            })}
          </ul>
        </section>
      ))}
      <div className="compact-draw-section">{annotate.check}</div>
      <div className="compact-draw-section">{annotate.list}</div>
    </div>
  );
}

const VIEW_TOOLS = [
  {
    key: 'section',
    label: 'Section view',
    word: 'Section',
    icon: <Scissors size={22} />
  },
  {
    key: 'detail',
    label: 'Detail view',
    word: 'Detail',
    icon: <ZoomIn size={22} />
  },
  {
    key: 'auxiliary',
    label: 'Auxiliary view',
    word: 'Auxiliary',
    icon: <SquareArrowOutUpRight size={22} />
  }
] as const;

function ViewsPage({
  sheet,
  onStart
}: {
  sheet: CompactDrawSheet;
  onStart(start: () => void): void;
}) {
  const [reasonLine, showReason] = useReason();
  return (
    <div className="compact-draw-page">
      {reasonLine}
      <ul className="compact-tool-grid" aria-label="View tools">
        {VIEW_TOOLS.map((tool) => {
          const control = sheet.viewTools[tool.key];
          return (
            <ToolTile
              key={tool.key}
              label={tool.label}
              word={tool.word}
              icon={tool.icon}
              active={control.active}
              disabledReason={control.usable ? null : control.disabledReason}
              onPress={() => onStart(control.onToggle)}
              onRefused={showReason}
            />
          );
        })}
      </ul>
      {sheet.selectedView ? (
        <div className="compact-draw-section">{sheet.selectedView}</div>
      ) : null}
      <div className="compact-draw-section">{sheet.views}</div>
    </div>
  );
}

function SheetRow({
  sheet,
  index,
  count,
  active,
  control
}: {
  sheet: DrawingSheet;
  index: number;
  count: number;
  active: boolean;
  control: CompactDrawSheets;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const renaming = draft !== null;
  useEffect(() => {
    if (renaming) input.current?.focus();
  }, [renaming]);
  const editable = control.editDisabledReason === null;
  const why = control.editDisabledReason ?? undefined;
  const { name, sheetId } = sheet;
  return (
    <li className={`compact-draw-sheet${active ? ' is-active' : ''}`}>
      {draft === null ? (
        <button
          type="button"
          className="compact-menu-row"
          aria-pressed={active}
          onClick={() => control.onSelect(sheetId)}
        >
          <span className="compact-menu-icon" aria-hidden="true">
            <Files size={18} />
          </span>
          <span className="compact-menu-label">{name}</span>
          {active ? (
            <Check
              className="compact-menu-check"
              size={18}
              aria-hidden="true"
            />
          ) : null}
        </button>
      ) : (
        <form
          className="compact-draw-rename"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() && draft.trim() !== name) {
              control.onRename(sheetId, draft);
            }
            setDraft(null);
          }}
        >
          <input
            ref={input}
            className="compact-draw-rename-input"
            aria-label="Sheet name"
            value={draft}
            maxLength={MAX_DRAWING_TEXT_LENGTH}
            enterKeyHint="done"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                setDraft(null);
              }
            }}
          />
          <button
            type="submit"
            className="compact-round-button"
            aria-label="Save name"
            disabled={!draft.trim()}
          >
            <Check size={20} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="compact-round-button"
            aria-label="Cancel rename"
            onClick={() => setDraft(null)}
          >
            <X size={20} aria-hidden="true" />
          </button>
        </form>
      )}
      <div
        className="compact-draw-sheet-actions"
        role="group"
        aria-label={`${name} actions`}
      >
        <button
          type="button"
          className="compact-round-button"
          aria-label={`Rename ${name}`}
          disabled={!editable || draft !== null}
          title={why}
          onClick={() => setDraft(name)}
        >
          <PencilLine size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="compact-round-button"
          aria-label={`Duplicate ${name}`}
          disabled={!editable}
          title={why}
          onClick={() => control.onDuplicate(sheetId)}
        >
          <Copy size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="compact-round-button"
          aria-label={`Move ${name} up`}
          disabled={!editable || index === 0}
          title={why}
          onClick={() => control.onMove(sheetId, index - 1)}
        >
          <ChevronUp size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="compact-round-button"
          aria-label={`Move ${name} down`}
          disabled={!editable || index === count - 1}
          title={why}
          onClick={() => control.onMove(sheetId, index + 1)}
        >
          <ChevronDown size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="compact-round-button is-danger"
          aria-label={`Delete ${name}`}
          disabled={!editable}
          title={why}
          onClick={() => control.onDelete(sheetId)}
        >
          <Trash2 size={20} aria-hidden="true" />
        </button>
      </div>
    </li>
  );
}

function SheetsPage({ control }: { control: CompactDrawSheets }) {
  const { sheets } = control;
  return (
    <div className="compact-draw-page">
      <button
        type="button"
        className="compact-menu-row"
        aria-label="New drawing sheet"
        disabled={control.createDisabledReason !== null}
        title={control.createDisabledReason ?? undefined}
        onClick={control.onCreate}
      >
        <span className="compact-menu-icon" aria-hidden="true">
          <Plus size={18} />
        </span>
        <span className="compact-menu-label" aria-hidden="true">
          New sheet
        </span>
      </button>
      {sheets.length > 0 ? (
        <ul className="compact-draw-sheets" aria-label="Sheets">
          {sheets.map((sheet, index) => (
            <SheetRow
              key={sheet.sheetId}
              sheet={sheet}
              index={index}
              count={sheets.length}
              active={sheet.sheetId === control.activeId}
              control={control}
            />
          ))}
        </ul>
      ) : null}
      {control.createDisabledReason ? (
        <p className="compact-page-note">{control.createDisabledReason}</p>
      ) : null}
    </div>
  );
}

const EXPORTS: readonly {
  format: CompactDrawExportFormat;
  word: string;
}[] = [
  { format: 'pdf', word: 'PDF' },
  { format: 'svg', word: 'SVG' },
  { format: 'dxf', word: 'DXF' }
];

function ExportPage({ sheet }: { sheet: CompactDrawSheet }) {
  const { exports } = sheet;
  return (
    <div className="compact-draw-page">
      <ul className="compact-menu" aria-label="Export">
        {EXPORTS.map(({ format, word }) => (
          <li key={format}>
            <button
              type="button"
              className="compact-menu-row"
              aria-label={`Export ${word}`}
              disabled={exports.reason !== null}
              onClick={() => exports.onExport(format)}
            >
              <span className="compact-menu-icon" aria-hidden="true">
                <FileDown size={18} />
              </span>
              <span className="compact-menu-label" aria-hidden="true">
                {word}
              </span>
            </button>
          </li>
        ))}
        {exports.broken > 0 ? (
          <li>
            <button
              type="button"
              className="compact-menu-row"
              aria-label="Delete all broken"
              disabled={!exports.canDeleteBroken}
              onClick={exports.onDeleteBroken}
            >
              <span className="compact-menu-icon" aria-hidden="true">
                <Trash2 size={18} />
              </span>
              <span className="compact-menu-label" aria-hidden="true">
                Delete broken
              </span>
            </button>
          </li>
        ) : null}
      </ul>
      {exports.reason ? (
        <p className="compact-page-note">{exports.reason}</p>
      ) : null}
    </div>
  );
}

/** The running tool's row: its icon, its step, Cancel and Done. */
function RunRow({ run }: { run: CompactDrawRun }) {
  return (
    <div
      className="compact-tray-row compact-draw-run"
      role="group"
      aria-label={`${run.label} placement`}
    >
      <span className="compact-tray-tool" aria-hidden="true">
        {run.icon}
      </span>
      <span className="compact-step-chip" title={run.hint} aria-hidden="true">
        {run.step}
      </span>
      <span className="visually-hidden" role="status">
        {run.hint}
      </span>
      <button
        type="button"
        className="compact-draw-run-button"
        aria-label="Cancel"
        onClick={run.onCancel}
      >
        <X size={22} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="compact-draw-run-button is-done"
        aria-label="Done"
        onClick={run.onDone}
      >
        <Check size={22} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Draw in the compact workspace (U12 slice 9): Annotate, Views, Sheets,
 * Properties and Export in the tray, each page in the sheet; a running
 * tool's step, Cancel and Done stand in for the tray while it runs. The
 * drawing workspace draws this into the sheet's tray slot; every control
 * runs the handler its regular toolbar, tabs and panel run.
 */
export default function CompactDrawTray({
  sheets,
  sheet,
  run
}: CompactDrawTrayProps) {
  const tray = useCompactTray();
  const page = (tray?.page ?? null) as DrawPage | null;
  const open = (key: DrawPage) => {
    if (page === key) tray?.closePage();
    else tray?.openPage(key, PAGE_TITLES[key]);
  };
  // A tool takes the tray: the page goes, so the sheet is in view to pick
  // on (whatever started it: a tile, a re-pick, a key).
  const running = run !== null;
  useEffect(() => {
    if (running && page) tray?.closePage();
  }, [page, running, tray]);
  // A note or a frame just placed asks for its properties.
  const requested = sheet?.propertiesRequested ?? false;
  const shown = sheet?.onPropertiesShown;
  useEffect(() => {
    if (!requested) return;
    shown?.();
    if (page !== 'properties') tray?.openPage('properties', 'Properties');
  }, [page, requested, shown, tray]);
  const start = (begin: () => void) => {
    tray?.closePage();
    begin();
  };
  if (run) return <RunRow run={run} />;
  const missing = sheet ? null : NO_SHEET;
  const items: TrayItem[] = [
    {
      key: 'annotate',
      label: 'Annotate',
      icon: <PencilRuler size={22} aria-hidden="true" />,
      disabledReason: missing,
      onPress: () => open('annotate')
    },
    {
      key: 'views',
      label: 'Views',
      icon: <LayoutGrid size={22} aria-hidden="true" />,
      disabledReason: missing,
      onPress: () => open('views')
    },
    {
      key: 'sheets',
      label: 'Sheets',
      icon: <Files size={22} aria-hidden="true" />,
      onPress: () => open('sheets')
    },
    {
      key: 'properties',
      label: 'Properties',
      icon: <SlidersHorizontal size={22} aria-hidden="true" />,
      on: sheet?.hasSelection ?? false,
      disabledReason: missing,
      onPress: () => open('properties')
    },
    {
      key: 'export',
      label: 'Export',
      icon: <FileDown size={22} aria-hidden="true" />,
      disabledReason: missing,
      onPress: () => open('export')
    }
  ];
  return (
    <>
      <TrayRow label="Draw tools" items={items} page={page} />
      {sheet ? (
        <>
          <TrayPage page="annotate">
            <AnnotatePage sheet={sheet} onStart={start} />
          </TrayPage>
          <TrayPage page="views">
            <ViewsPage sheet={sheet} onStart={start} />
          </TrayPage>
          <TrayPage page="properties">
            <div className="compact-draw-page">
              <div className="compact-draw-section">{sheet.properties}</div>
            </div>
          </TrayPage>
          <TrayPage page="export">
            <ExportPage sheet={sheet} />
          </TrayPage>
        </>
      ) : null}
      <TrayPage page="sheets">
        <SheetsPage control={sheets} />
      </TrayPage>
    </>
  );
}
