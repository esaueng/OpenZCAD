import type { PanelId } from '../../lib/panelLayout';
import { DiagnosticsPanel, diagnosticCount } from './DiagnosticsPanel';
import {
  HistoryFindToggle,
  HistoryPanel,
  historyCount,
  useHistoryFind
} from './HistoryPanel';
import type { ModelPanelSource } from './modelPanelProps';
import {
  modelBodies,
  ObjectsPanel,
  objectCount,
  useObjectsView
} from './ObjectsPanel';
import { PanelFrame, type PanelControls } from './PanelFrame';
import { ParametersPanel, parameterCount } from './ParametersPanel';
import {
  RevisionsPanel,
  revisionCount,
  useRevisionCheckpoints
} from './RevisionsPanel';

export interface ModelPanelProps extends ModelPanelSource {
  id: PanelId;
  controls: PanelControls;
}

/**
 * One model panel in its frame. Each panel owns its own view state — the
 * Objects filter and search, the History step search, the Revisions device
 * save states — so two panels open side by side never share it. Loaded
 * lazily with the panel bodies, off the entry chunk.
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
  const view = useObjectsView();
  return (
    <PanelFrame
      id="bodies"
      count={objectCount(props)}
      controls={props.controls}
    >
      <ObjectsPanel {...props} view={view} />
    </PanelFrame>
  );
}

function HistoryFrame(props: ModelPanelProps) {
  const find = useHistoryFind();
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
