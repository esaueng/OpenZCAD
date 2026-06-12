import { useEffect, useState } from 'react';
import type { StudySettings } from '../../lib/workflow';

interface StudyPanelProps {
  settings: StudySettings;
  onApply(settings: StudySettings): void;
}

export function StudyPanel({ settings, onApply }: StudyPanelProps) {
  const [fractionPercent, setFractionPercent] = useState(String(Math.round(settings.volumeFraction * 100)));
  const [resolution, setResolution] = useState<StudySettings['resolution']>(settings.resolution);
  const [objective, setObjective] = useState<StudySettings['objective']>(settings.objective);

  useEffect(() => {
    setFractionPercent(String(Math.round(settings.volumeFraction * 100)));
    setResolution(settings.resolution);
    setObjective(settings.objective);
  }, [settings.volumeFraction, settings.resolution, settings.objective]);

  const parsedFraction = Math.min(90, Math.max(5, Number(fractionPercent) || 0)) / 100;

  return (
    <>
      <div className="field">
        <span>Target volume fraction</span>
        <div className="field-row">
          <input
            type="number"
            min={5}
            max={90}
            step={5}
            value={fractionPercent}
            aria-label="Target volume fraction in percent"
            onChange={(event) => setFractionPercent(event.target.value)}
            style={{ width: 90 }}
          />
          <span className="mono">% of design space</span>
        </div>
        <small>How much of the unmarked design-space volume the optimizer may keep.</small>
      </div>

      <div className="field">
        <span>Objective</span>
        <select
          value={objective}
          aria-label="Optimization objective"
          onChange={(event) => setObjective(event.target.value as StudySettings['objective'])}
        >
          <option value="stiffness">Maximize stiffness</option>
          <option value="mass">Minimize mass</option>
        </select>
        <small>Weights the outcome scoring between displacement and mass.</small>
      </div>

      <div className="field">
        <span>Resolution</span>
        <select
          value={resolution}
          aria-label="Study resolution"
          onChange={(event) => setResolution(event.target.value as StudySettings['resolution'])}
        >
          <option value="coarse">Coarse · 3 outcomes</option>
          <option value="standard">Standard · 4 outcomes</option>
          <option value="fine">Fine · 6 outcomes</option>
        </select>
        <small>Controls how many candidate outcomes the study explores.</small>
      </div>

      <button
        type="button"
        className="primary wide"
        onClick={() =>
          onApply({
            volumeFraction: parsedFraction,
            resolution,
            objective,
            confirmed: true
          })
        }
      >
        Apply study settings
      </button>

      {settings.confirmed ? (
        <div className="callout">
          Settings are saved with the project document — they replay, undo, and persist like
          any other edit.
        </div>
      ) : (
        <div className="callout warning">
          Apply the settings once to confirm the study setup. Defaults are shown above.
        </div>
      )}
    </>
  );
}
