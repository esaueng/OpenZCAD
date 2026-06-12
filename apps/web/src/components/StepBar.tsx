import {
  Activity,
  Anchor,
  Box,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  Weight,
  type LucideIcon
} from 'lucide-react';
import type { StepState, WorkflowStepId } from '../lib/workflow';

interface StepBarProps {
  activeStep: WorkflowStepId;
  stepStates: Record<WorkflowStepId, StepState>;
  canNavigate(step: WorkflowStepId): boolean;
  units: string;
  solver: string;
  onSelect(step: WorkflowStepId): void;
}

const STEPS: ReadonlyArray<{ id: WorkflowStepId; label: string; Icon: LucideIcon }> = [
  { id: 'model', label: 'Model', Icon: Box },
  { id: 'preserve', label: 'Preserve', Icon: ShieldCheck },
  { id: 'constraints', label: 'Constraints', Icon: Anchor },
  { id: 'loads', label: 'Loads', Icon: Weight },
  { id: 'study', label: 'Study', Icon: SlidersHorizontal },
  { id: 'generate', label: 'Generate', Icon: Play },
  { id: 'results', label: 'Results', Icon: Activity }
];

export function StepBar({
  activeStep,
  stepStates,
  canNavigate,
  units,
  solver,
  onSelect
}: StepBarProps) {
  return (
    <nav className="stepbar" aria-label="Generative design workflow">
      <div className="stepbar-eyebrow">workflow</div>
      <div className="step-list">
        {STEPS.map(({ id, label, Icon }) => {
          const isActive = activeStep === id;
          const isDone = stepStates[id] === 'complete';
          return (
            <button
              key={id}
              type="button"
              className={`step ${isActive ? 'active' : ''}`}
              disabled={!canNavigate(id)}
              onClick={() => onSelect(id)}
              aria-current={isActive ? 'step' : undefined}
            >
              <span className={`step-icon ${isDone ? 'done' : ''}`} aria-hidden="true">
                <Icon size={17} strokeWidth={1.8} />
              </span>
              <span>{label}</span>
            </button>
          );
        })}
      </div>
      <div className="stepbar-footer">
        <div>
          <span>units</span>
          <strong>{units}</strong>
        </div>
        <div>
          <span>solver</span>
          <strong>{solver}</strong>
        </div>
      </div>
    </nav>
  );
}
