import type { PanelId } from '../../lib/panelLayout';
import { DiagnosticsPanel, diagnosticCount } from './DiagnosticsPanel';
import { HistoryFindToggle, HistoryPanel, historyCount } from './HistoryPanel';
import type { ModelPanelSource } from './modelPanelProps';
import { modelBodies, ObjectsPanel, objectCount } from './ObjectsPanel';
import { PanelFrame, type PanelControls } from './PanelFrame';
import type { ModelPanelViews } from './panelViews';
import { ParametersPanel, parameterCount } from './ParametersPanel';
import {
  RevisionsPanel,
  revisionCount,
  useRevisionCheckpoints
} from './RevisionsPanel';

export interface ModelPanelProps extends ModelPanelSource {
  id: PanelId;
  controls: PanelControls;
  views: ModelPanelViews;
}

/**
 * One model panel in its frame. Each panel has its own view state — the
 * Objects filter and search, the History step search, the Revisions device
 * save states — so two panels open side by side never share it; the first
 * two come from `views`, held above the panel so a move that remounts it
 * keeps them. Loaded lazily with the panel bodies, off the entry chunk.
 */
export function ModelPanel(props: ModelPanelProps) {
  switch (props.id) {
    case 'parameters':
      return <ParametersFrame {...props} />;
    case 'bodies':
      return <ObjectsFrame {...props} />;
    case 'history':
      return <HistoryFrame {...props} />;
    case 'revisions':
      return <RevisionsFrame {...props} />;
    case 'diagnostics':
      return (
        <PanelFrame
          id="diagnostics"
          count={diagnosticCount(props.warnings)}
          controls={props.controls}
        >
          <DiagnosticsPanel {...props} />
        </PanelFrame>
      );
  }
}

function ParametersFrame(props: ModelPanelProps) {
  // A toggle parameter's body picker lists every live body; the Objects
  // name search never narrows it.
  const liveBodies = modelBodies(props).filter((body) => !body.consumed);
  return (
    <PanelFrame
      id="parameters"
      count={parameterCount(props.parameters)}
      controls={props.controls}
    >
      <ParametersPanel {...props} bodies={liveBodies} />
    </PanelFrame>
  );
}

function ObjectsFrame(props: ModelPanelProps) {
  return (
    <PanelFrame
      id="bodies"
      count={objectCount(props)}
      controls={props.controls}
    >
      <ObjectsPanel {...props} view={props.views.objects} />
    </PanelFrame>
  );
}

function HistoryFrame(props: ModelPanelProps) {
  const find = props.views.historyFind;
  return (
    <PanelFrame
      id="history"
      count={historyCount(props.features)}
      controls={props.controls}
      actions={
        props.features.length > 0 ? (
          <HistoryFindToggle find={find} />
        ) : undefined
      }
    >
      <HistoryPanel {...props} find={find} />
    </PanelFrame>
  );
}

function RevisionsFrame(props: ModelPanelProps) {
  const revisions = useRevisionCheckpoints(props);
  return (
    <PanelFrame
      id="revisions"
      count={revisionCount(revisions)}
      controls={props.controls}
    >
      <RevisionsPanel {...props} revisions={revisions} />
    </PanelFrame>
  );
}
