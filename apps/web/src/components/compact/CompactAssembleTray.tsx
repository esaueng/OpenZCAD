import { Boxes, Expand, Link2, MoveVertical, Play, X } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  assemblyRuntime,
  getAssemblyRuntime,
  useAssemblyRuntime
} from '../../lib/assembly/assemblyRuntime';
import {
  AssemblyPanel,
  type AssemblyPanelProps,
  type AssemblyPanelSection
} from '../assembly/AssemblyPanel';
import { AssemblyPlayer, playerStudies } from '../assembly/AssemblyPlayer';
import { MotionStudyTimelineSlot } from '../assembly/MotionStudyTimelineSlot';
import { useCompactTray } from './compactSlots';
import {
  TrayPage,
  TrayRow,
  useTrayPagesLeaveWithTray,
  type TrayItem
} from './CompactTray';
import { useMeasurePage, type CompactMeasure } from './CompactViewTray';

export interface CompactAssembleTrayProps {
  /** Measure has no verb in Assemble's tray; a workbench opened by M shows. */
  measure: CompactMeasure;
  /** What Assemble's sidebar is given: every page draws part of it. */
  panel: Omit<AssemblyPanelProps, 'sections' | 'touch' | 'studies'>;
  onStageCovered?(): void;
}

export type AssemblePage = 'joints' | 'motion' | 'explode' | 'parts' | 'play';

const PAGE_TITLES: Record<AssemblePage, string> = {
  joints: 'Joints',
  motion: 'Motion',
  explode: 'Exploded view',
  parts: 'Parts',
  play: 'Player'
};

/** The sidebar's sections each page shows, in the sidebar's order. */
export const ASSEMBLE_PAGE_SECTIONS: Record<
  Exclude<AssemblePage, 'play'>,
  readonly AssemblyPanelSection[]
> = {
  joints: ['joints'],
  motion: ['motion', 'positions', 'studies'],
  explode: ['explode'],
  parts: ['parts', 'interference', 'bom']
};

/** The page an open card (the joint tool, Set up motion, Place gears) is on. */
function cardPage(state: ReturnType<typeof getAssemblyRuntime>) {
  return state.jointTool
    ? 'joints'
    : state.motionSetup || state.gearMesh
      ? 'motion'
      : null;
}

/**
 * Assemble in the compact workspace (U12 slice 8): Joints, Motion, Explode,
 * Parts and the player in the tray, each page in the sheet. The pages are
 * Assemble's own sidebar, a few sections at a time, so every control runs
 * the handler the sidebar runs; the motion study timeline sits under the
 * Motion page's animations with buttons for what its keys do.
 */
export function CompactAssembleTray(props: CompactAssembleTrayProps) {
  const { measure, panel, onStageCovered } = props;
  const tray = useCompactTray();
  const page = (tray?.page ?? null) as AssemblePage | 'measure' | null;
  useMeasurePage(measure);
  useTrayPagesLeaveWithTray();
  const card = useAssemblyRuntime(cardPage);
  const exploded = useAssemblyRuntime((s) => s.exploded);
  const playing = useAssemblyRuntime((s) => s.playback !== null);

  // A card opened from anywhere (the first run's Join, a key) brings its
  // page up: the sheet is where the card is drawn.
  const trayRef = useRef(tray);
  trayRef.current = tray;
  useEffect(() => {
    const current = trayRef.current;
    if (card && current && current.page !== card)
      current.openPage(card, PAGE_TITLES[card]);
  }, [card]);

  // Leaving a page leaves what only it shows: the card it holds, the
  // animation open on its timeline (a part moved elsewhere would key into
  // an animation no longer on screen), or the player's pose.
  const lastPage = useRef(page);
  useEffect(() => {
    const was = lastPage.current;
    lastPage.current = page;
    if (was === page) return;
    const runtime = getAssemblyRuntime();
    if (was === 'joints' && runtime.jointTool) assemblyRuntime.closeJointTool();
    if (was === 'motion') {
      if (runtime.motionSetup) assemblyRuntime.closeMotionSetup();
      if (runtime.gearMesh) assemblyRuntime.closeGearMesh();
      if (runtime.selectedStudyId) {
        assemblyRuntime.stop();
        assemblyRuntime.selectStudy(null);
      }
    }
    if (was === 'play' && !runtime.playback) assemblyRuntime.clearOverrides();
    // The player runs its own clock: a joint already playing stops first.
    if (page === 'play' && runtime.playback) assemblyRuntime.stop();
  }, [page]);

  const open = (key: AssemblePage) => {
    if (page === key) tray?.closePage();
    else tray?.openPage(key, PAGE_TITLES[key]);
  };
  const items: TrayItem[] = [
    {
      key: 'joints',
      label: 'Joints',
      icon: <Link2 size={22} aria-hidden="true" />,
      onPress: () => open('joints')
    },
    {
      key: 'motion',
      label: 'Motion',
      icon: <MoveVertical size={22} aria-hidden="true" />,
      onPress: () => open('motion')
    },
    {
      key: 'explode',
      label: 'Exploded view',
      icon: <Expand size={22} aria-hidden="true" />,
      on: exploded,
      onPress: () => open('explode')
    },
    {
      key: 'parts',
      label: 'Parts',
      icon: <Boxes size={22} aria-hidden="true" />,
      onPress: () => open('parts')
    },
    {
      key: 'play',
      label: 'Player',
      icon: <Play size={22} aria-hidden="true" />,
      on: playing,
      onPress: () => open('play')
    }
  ];
  const assembly = panel.document.assembly;
  // The player draws nothing then (only rigid joints, say): the note does.
  const nothingToPlay = useMemo(
    () => playerStudies(assembly).length === 0,
    [assembly]
  );
  // Exploded stays on away from its page, where a drag pulls a part out
  // rather than turning its joint: a chip on the stage says so wherever
  // else the sheet stands, and puts the parts back together.
  const explodedChip =
    exploded && page !== 'explode' && tray?.stageHost
      ? createPortal(
          <button
            type="button"
            className="compact-analysis-chip"
            aria-label="Turn off exploded view"
            title="Exploded view: a drag pulls a part out. Tap to assemble."
            onClick={() => assemblyRuntime.setExploded(false)}
          >
            <span className="compact-selection-dot" aria-hidden="true" />
            <span className="compact-selection-text" aria-hidden="true">
              Exploded
            </span>
            <X size={18} aria-hidden="true" />
          </button>,
          tray.stageHost
        )
      : null;
  const pagePanel = (key: Exclude<AssemblePage, 'play'>) => (
    <TrayPage page={key} onStageCovered={onStageCovered}>
      <div className="compact-assemble-page">
        <AssemblyPanel
          {...panel}
          sections={ASSEMBLE_PAGE_SECTIONS[key]}
          touch
        />
        {key === 'motion' && !card ? (
          <MotionStudyTimelineSlot
            resetKey={panel.document.projectId}
            assembly={assembly}
            execute={panel.execute}
            lengthUnit={panel.document.units}
            touch
          />
        ) : null}
      </div>
    </TrayPage>
  );
  return (
    <>
      {explodedChip}
      <TrayRow label="Assemble tools" items={items} page={page} />
      <TrayPage page="measure" onStageCovered={onStageCovered}>
        {measure.dock}
      </TrayPage>
      {pagePanel('joints')}
      {pagePanel('motion')}
      {pagePanel('explode')}
      {pagePanel('parts')}
      <TrayPage page="play" onStageCovered={onStageCovered}>
        <div className="compact-assemble-page">
          <AssemblyPlayer assembly={assembly} />
          {nothingToPlay ? (
            <p className="compact-page-note">Nothing to play yet.</p>
          ) : null}
        </div>
      </TrayPage>
    </>
  );
}

/**
 * The compact workspace's tray for Assemble (U12 slice 8), loaded only
 * where the compact workspace is in force: off the entry chunk.
 */
export default CompactAssembleTray;
