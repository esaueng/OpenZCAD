import {
  Camera,
  Check,
  Grid3x3,
  Layers2,
  Layers3,
  Maximize2,
  Minus,
  Orbit,
  Plus,
  Rows3,
  Ruler,
  ScanEye,
  Spline,
  SquareSplitVertical,
  Triangle
} from 'lucide-react';
import {
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type ReactNode
} from 'react';
import {
  VIEW_LABELS,
  type DisplayMode,
  type ProjectionMode,
  type SectionPlaneId,
  type SectionViewSettings,
  type StandardView,
  type ViewerSettings
} from '@openzcad/viewport';
import type { SurfaceAnalysisKind } from '@openzcad/shared';
import {
  ANALYSIS_LABELS,
  analysisRuntime,
  useAnalysisRuntime
} from '../../lib/analysis/analysisRuntime';
import { DISPLAY_MODE_LABELS, DISPLAY_MODE_ORDER } from '../../lib/displayMode';
import type { SectionOutlineState } from '../../lib/sectionOutline';
import {
  SavedViewsSection,
  type SavedViewsSectionProps
} from '../SavedViewsSection';
import {
  SectionToolbox,
  sectionSliderStep,
  snapSectionOffset
} from '../SectionToolbox';
import { AxisTriadIcon, DisplayModeIcon } from '../ViewerRailIcons';
import { PartsList, PartsListModeProvider } from '../ViewModeRail';
import { CompactAnalysisSlotContext, useCompactTray } from './compactSlots';
import {
  TrayPage,
  TrayRow,
  useTrayPagesLeaveWithTray,
  type TrayItem
} from './CompactTray';

/** Measure, shared by both trays: the workbench while Measure is on. */
export interface CompactMeasure {
  on: boolean;
  toggle(next: boolean): void;
  /** The measurement workbench, present while Measure is on. */
  dock: ReactNode;
}

export interface CompactViewTrayProps {
  measure: CompactMeasure;
  section: {
    /** The cut on screen, or null with the section off. */
    current: SectionViewSettings | null;
    /** The model's extent across a plane, or null with nothing to cut. */
    rangeFor(plane: SectionPlaneId): { min: number; max: number } | null;
    outline: SectionOutlineState;
    units: string;
    onToggle(): void;
    onPlane(plane: SectionPlaneId): void;
    onOffset(offset: number): void;
    onCommit(offset?: number): void;
    onFlip(): void;
    onExport(): void;
  };
  display: {
    settings: ViewerSettings;
    projection: ProjectionMode;
    onDisplayMode(mode: DisplayMode): void;
    onToggleXray(): void;
    onToggleProjection(): void;
    onToggleOrbitMode(): void;
    onToggleGrid(): void;
    onFit(): void;
  };
  views: {
    onView(view: StandardView): void;
    saved?: SavedViewsSectionProps;
  };
  parts: ComponentProps<typeof PartsList>;
  /** A page rose over the stage's foot: keep the model in view above it. */
  onStageCovered?(): void;
}

/** The order the regular View bar keeps its views in. */
const VIEWS: readonly StandardView[] = [
  'front',
  'back',
  'left',
  'right',
  'top',
  'bottom',
  'iso'
];

/** The M09 analyses, in the Display menu's order, with its icons. */
const ANALYSES: readonly {
  kind: SurfaceAnalysisKind;
  icon: typeof Triangle;
}[] = [
  { kind: 'draft', icon: Triangle },
  { kind: 'curvature', icon: Spline },
  { kind: 'zebra', icon: Rows3 },
  { kind: 'thickness', icon: Layers2 }
];

type ViewPage = 'measure' | 'section' | 'display' | 'views' | 'parts';

const PAGE_TITLES: Record<ViewPage, string> = {
  measure: 'Measure',
  section: 'Section',
  display: 'Display',
  views: 'Views',
  parts: 'Parts'
};

/**
 * Measure's page follows Measure: switched on (the tray, M, the command
 * bar) its page opens with the workbench; switched off, the page goes; and
 * leaving the page (Back, another page) switches Measure off, as closing
 * the workbench does on the regular stage. Pinned results stay either way.
 */
export function useMeasurePage(measure: CompactMeasure) {
  const tray = useCompactTray();
  const page = tray?.page ?? null;
  const onRef = useRef(measure.on);
  onRef.current = measure.on;
  const toggleRef = useRef(measure.toggle);
  toggleRef.current = measure.toggle;
  const trayRef = useRef(tray);
  trayRef.current = tray;
  const lastOn = useRef(false);
  useEffect(() => {
    const was = lastOn.current;
    lastOn.current = measure.on;
    const current = trayRef.current;
    if (!current) return;
    if (measure.on && !was && current.page !== 'measure') {
      current.openPage('measure', PAGE_TITLES.measure);
    } else if (!measure.on && was && current.page === 'measure') {
      current.closePage();
    }
  }, [measure.on]);
  const lastPage = useRef(page);
  useEffect(() => {
    const was = lastPage.current;
    lastPage.current = page;
    if (was === 'measure' && page !== 'measure' && onRef.current) {
      toggleRef.current(false);
    }
  }, [page]);
}

function SectionPage({ section }: Pick<CompactViewTrayProps, 'section'>) {
  const { current } = section;
  // Off, the controls stay on the last cut, so its plane or the switch
  // brings it straight back (as on Build's rail).
  const lastCut = useRef<SectionViewSettings | null>(current);
  if (current) lastCut.current = current;
  const plane = (current ?? lastCut.current)?.plane ?? 'XZ';
  const range = section.rangeFor(plane);
  if (!range) {
    return (
      <p className="compact-page-note">
        Nothing to cut yet. Add or show a body first.
      </p>
    );
  }
  const shown = current ??
    lastCut.current ?? { plane, offset: (range.min + range.max) / 2 };
  // Five per cent of the model a tap: the slider's own step is two hundred
  // to the model, too fine for a thumb.
  const nudgeStep = sectionSliderStep(range) * 10;
  const nudge = (direction: 1 | -1) => {
    if (!current) return;
    const next = snapSectionOffset(
      current.offset + direction * nudgeStep,
      range
    );
    if (next === current.offset) return;
    section.onOffset(next);
    section.onCommit(next);
  };
  return (
    <>
      <SectionToolbox
        inline
        key={shown.plane}
        section={shown}
        range={range}
        active={current !== null}
        outline={section.outline}
        units={section.units}
        onSwitch={section.onToggle}
        onPlane={section.onPlane}
        onOffset={section.onOffset}
        onCommit={section.onCommit}
        onFlip={section.onFlip}
        onExport={section.onExport}
      />
      <div
        className="compact-stepper-row"
        role="group"
        aria-label="Move the cut"
      >
        <button
          type="button"
          className="compact-round-button"
          aria-label="Move the cut back"
          disabled={!current || current.offset <= range.min}
          onClick={() => nudge(-1)}
        >
          <Minus size={20} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="compact-round-button"
          aria-label="Move the cut forward"
          disabled={!current || current.offset >= range.max}
          onClick={() => nudge(1)}
        >
          <Plus size={20} aria-hidden="true" />
        </button>
      </div>
    </>
  );
}

/** A row that switches something on or off, or runs it once. */
function OptionRow({
  label,
  icon,
  pressed,
  onPress
}: {
  label: string;
  icon: ReactNode;
  pressed?: boolean;
  onPress(): void;
}) {
  return (
    <li>
      <button
        type="button"
        className="compact-menu-row"
        aria-label={label}
        {...(pressed === undefined ? {} : { 'aria-pressed': pressed })}
        onClick={onPress}
      >
        <span className="compact-menu-icon" aria-hidden="true">
          {icon}
        </span>
        <span className="compact-menu-label" aria-hidden="true">
          {label}
        </span>
        {pressed ? (
          <Check className="compact-menu-check" size={18} aria-hidden="true" />
        ) : null}
      </button>
    </li>
  );
}

function DisplayPage({ display }: Pick<CompactViewTrayProps, 'display'>) {
  const analysisKind = useAnalysisRuntime((s) => s.request?.kind ?? null);
  const analysisSlot = useContext(CompactAnalysisSlotContext);
  const { settings } = display;
  return (
    <>
      <div
        className="compact-choice-grid"
        role="group"
        aria-label="Display mode"
      >
        {DISPLAY_MODE_ORDER.map((mode) => (
          <button
            key={mode}
            type="button"
            className="compact-choice"
            aria-pressed={settings.displayMode === mode}
            onClick={() => display.onDisplayMode(mode)}
          >
            <DisplayModeIcon mode={mode} size={20} />
            <span>{DISPLAY_MODE_LABELS[mode]}</span>
          </button>
        ))}
      </div>
      <ul className="compact-menu" aria-label="View options">
        <OptionRow
          label="X-ray"
          icon={<ScanEye size={18} />}
          pressed={settings.xray === true}
          onPress={display.onToggleXray}
        />
        <OptionRow
          label="Grid"
          icon={<Grid3x3 size={18} />}
          pressed={settings.showGrid}
          onPress={display.onToggleGrid}
        />
        <OptionRow
          label="Orthographic"
          icon={<Camera size={18} />}
          pressed={display.projection === 'orthographic'}
          onPress={display.onToggleProjection}
        />
        <OptionRow
          label="Turntable orbit"
          icon={<Orbit size={18} />}
          pressed={(settings.orbitMode ?? 'free') === 'turntable'}
          onPress={display.onToggleOrbitMode}
        />
        <OptionRow
          label="Fit view"
          icon={<Maximize2 size={18} />}
          onPress={display.onFit}
        />
      </ul>
      <ul className="compact-menu" aria-label="Analysis">
        {ANALYSES.map(({ kind, icon: Icon }) => (
          <OptionRow
            key={kind}
            label={`${ANALYSIS_LABELS[kind]} analysis`}
            icon={<Icon size={18} />}
            pressed={analysisKind === kind}
            onPress={() => analysisRuntime.toggle(kind)}
          />
        ))}
      </ul>
      {/* The analysis switched on draws its panel here (ViewerShell). */}
      <div ref={analysisSlot?.setHost} className="compact-analysis-host" />
    </>
  );
}

function ViewsPage({
  views,
  onChosen
}: Pick<CompactViewTrayProps, 'views'> & { onChosen(): void }) {
  return (
    <>
      <div
        className="compact-choice-grid"
        role="group"
        aria-label="Standard views"
      >
        {VIEWS.map((view) => (
          <button
            key={view}
            type="button"
            className={`compact-choice${view === 'iso' ? ' is-wide' : ''}`}
            aria-label={`${VIEW_LABELS[view]} view`}
            onClick={() => {
              views.onView(view);
              onChosen();
            }}
          >
            <span aria-hidden="true">{VIEW_LABELS[view]}</span>
          </button>
        ))}
      </div>
      {views.saved ? (
        <div className="compact-saved-views">
          <SavedViewsSection
            {...views.saved}
            onApply={(view) => {
              views.saved!.onApply(view);
              onChosen();
            }}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * View in the compact workspace (U12 slice 7): Measure, Section, Display,
 * Views and Parts in the tray, each page in the sheet. Every control runs
 * the handler View's bar and rail run on the regular stage.
 */
export function CompactViewTray(props: CompactViewTrayProps) {
  const { measure, section, display, views, parts, onStageCovered } = props;
  const tray = useCompactTray();
  const page = tray?.page ?? null;
  useMeasurePage(measure);
  useTrayPagesLeaveWithTray();
  const open = (key: ViewPage) => {
    if (page === key) tray?.closePage();
    else tray?.openPage(key, PAGE_TITLES[key]);
  };
  const items: TrayItem[] = [
    {
      key: 'measure',
      label: 'Measure',
      icon: <Ruler size={22} aria-hidden="true" />,
      pressed: measure.on,
      onPress: () =>
        measure.on && page !== 'measure'
          ? tray?.openPage('measure', PAGE_TITLES.measure)
          : measure.toggle(!measure.on)
    },
    {
      key: 'section',
      label: 'Section view',
      icon: <SquareSplitVertical size={22} aria-hidden="true" />,
      on: section.current !== null,
      onPress: () => open('section')
    },
    {
      key: 'display',
      label: 'Display mode',
      icon: <DisplayModeIcon mode={display.settings.displayMode} size={22} />,
      onPress: () => open('display')
    },
    {
      key: 'views',
      label: 'Standard views',
      icon: <AxisTriadIcon size={22} />,
      onPress: () => open('views')
    },
    {
      key: 'parts',
      label: 'Parts',
      icon: <Layers3 size={22} aria-hidden="true" />,
      on: parts.hiddenBodyIds.size > 0,
      onPress: () => open('parts')
    }
  ];
  return (
    <>
      <TrayRow label="View tools" items={items} page={page} />
      <TrayPage page="measure" onStageCovered={onStageCovered}>
        {measure.dock}
      </TrayPage>
      <TrayPage page="section" onStageCovered={onStageCovered}>
        <SectionPage section={section} />
      </TrayPage>
      <TrayPage page="display" onStageCovered={onStageCovered}>
        <DisplayPage display={display} />
      </TrayPage>
      <TrayPage page="views">
        <ViewsPage views={views} onChosen={() => tray?.closePage()} />
      </TrayPage>
      <TrayPage page="parts" onStageCovered={onStageCovered}>
        <PartsListModeProvider mode="view">
          <PartsList {...parts} />
        </PartsListModeProvider>
      </TrayPage>
    </>
  );
}
