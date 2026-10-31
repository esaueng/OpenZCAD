import prismFold from '../assets/prism-fold.json';
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties
} from 'react';

function subscribeOnline(changed: () => void) {
  window.addEventListener('online', changed);
  window.addEventListener('offline', changed);
  return () => {
    window.removeEventListener('online', changed);
    window.removeEventListener('offline', changed);
  };
}

/**
 * The real handoffs a part goes through before the workspace appears: App
 * owns the first (opening from the shelf, or restoring after a reload), and
 * WorkspaceLoading owns the model build and the lazy panels behind it.
 */
export type StartupStage =
  'creating' | 'opening' | 'restoring' | 'model' | 'panels';

const STEP: Record<StartupStage, number> = {
  creating: 0,
  opening: 0,
  restoring: 0,
  model: 1,
  panels: 2
};

const DETAIL: Record<StartupStage, string> = {
  creating: 'Creating your project',
  opening: 'Checking saved copies',
  restoring: 'Loading your last project',
  model: 'Building the model',
  panels: 'Loading tools and panels'
};

/** Must match the `.startup-mark` animation duration in start-screen.css. */
const BUILD_CYCLE_MS = 3200;

/** Long enough that an ordinary rebuild never shows it. */
const SLOW_MODEL_MS = 6000;

/**
 * The mark builds itself the way a part is made: the outline is sketched,
 * the front face fills, and the top and side faces extrude out of it.
 */
function BuildingMark() {
  // Phase-lock to the page clock: the opening and workspace screens are
  // separate trees, and a restart at the handoff reads as a stutter.
  const [phase] = useState(() => -(performance.now() % BUILD_CYCLE_MS));
  const colors: Record<string, string> = prismFold.colors;
  return (
    <svg
      className="startup-mark"
      viewBox={prismFold.viewBox}
      style={{ '--startup-phase': `${Math.round(phase)}ms` } as CSSProperties}
      aria-hidden="true"
      focusable="false"
    >
      <path className="startup-mark-ghost" d={prismFold.silhouette} />
      <path
        className="startup-mark-front"
        d={prismFold.frontFace}
        fill={colors.front}
      />
      {prismFold.faces.map((face) => (
        <path
          key={face.name}
          className={
            face.name === 'lower-front'
              ? 'startup-mark-front'
              : `startup-mark-face is-${face.tone}`
          }
          d={face.d}
          fill={colors[face.tone]}
        />
      ))}
      <path
        className="startup-mark-sketch"
        d={prismFold.silhouette}
        pathLength={1}
      />
    </svg>
  );
}

export function StartupScreen({
  onBack,
  loadingChunks = false,
  projectName,
  stage = projectName ? 'opening' : 'restoring',
  backLabel = 'Back to projects'
}: {
  onBack?(): void;
  loadingChunks?: boolean;
  projectName?: string;
  stage?: StartupStage;
  backLabel?: string;
}) {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine !== false
  );
  const [slowStage, setSlowStage] = useState<StartupStage | null>(null);
  useEffect(() => {
    if (stage !== 'model') return;
    const timer = window.setTimeout(() => setSlowStage(stage), SLOW_MODEL_MS);
    return () => window.clearTimeout(timer);
  }, [stage]);
  const slow = slowStage === stage;
  const offline = !online && loadingChunks;
  const detail = offline
    ? 'You’re offline. Connect to finish loading the workspace.'
    : DETAIL[stage];
  const step = STEP[stage];
  return (
    <div className="startup-screen">
      <div className="startup-card">
        <BuildingMark />
        <strong className="startup-wordmark">OpenZCAD</strong>
        <div
          className="startup-status"
          role="status"
          aria-live="polite"
          aria-label={
            stage === 'creating'
              ? 'Creating project'
              : stage === 'opening'
                ? 'Opening project'
                : 'Restoring workspace'
          }
        >
          <span className="startup-title" title={projectName}>
            {projectName ?? 'Restoring workspace'}
          </span>
          <span
            key={detail}
            className={`startup-detail${offline ? ' is-offline' : ''}`}
          >
            {detail}
          </span>
        </div>
        <ol className="startup-steps" aria-hidden="true">
          {[0, 1, 2].map((index) => (
            <li
              key={index}
              className={
                index < step ? 'is-done' : index === step ? 'is-active' : ''
              }
            />
          ))}
        </ol>
        {slow && !offline && (
          <p className="startup-hint">Complex models take longer to rebuild.</p>
        )}
        <button type="button" onClick={onBack} disabled={!onBack}>
          {backLabel}
        </button>
      </div>
    </div>
  );
}
