import type { FeatureNode } from '@openzcad/shared';
import type { PanelId } from '../../lib/panelLayout';
import { DiagnosticsPanel } from '../modelPanels/DiagnosticsPanel';
import type { ModelPanelSource } from '../modelPanels/modelPanelProps';
import { modelBodies, ObjectsPanel } from '../modelPanels/ObjectsPanel';
import type { ModelPanelViews } from '../modelPanels/panelViews';
import { ParametersPanel } from '../modelPanels/ParametersPanel';
import {
  RevisionsPanel,
  useRevisionCheckpoints
} from '../modelPanels/RevisionsPanel';
import { CompactHistoryList } from './CompactHistoryList';

export interface CompactPanelBodyProps extends ModelPanelSource {
  id: PanelId;
  views: ModelPanelViews;
  /**
   * Leaves the panel sheet for the workspace's own content: a History tap
   * opens the step's edit form or its sketch, which the sheet shows next.
   */
  onLeave(): void;
}

/**
 * One model panel's body in the compact panel sheet (U12 slice 5), loaded
 * lazily with the compact workspace. History is a touch list of its own;
 * Objects, Parameters (with its configuration table), Revisions and
 * Diagnostics are the regular panels' bodies, without the dock's frame,
 * restyled as touch rows by `compact-shell.css`.
 */
export default function CompactPanelBody(props: CompactPanelBodyProps) {
  switch (props.id) {
    case 'history':
      return <CompactHistory {...props} />;
    case 'bodies':
      return (
        <div className="compact-panel-list is-objects">
          <ObjectsPanel {...props} view={props.views.objects} />
        </div>
      );
    case 'parameters':
      return (
        <div className="compact-panel-list is-parameters">
          <ParametersPanel
            {...props}
            bodies={modelBodies(props).filter((body) => !body.consumed)}
          />
        </div>
      );
    case 'revisions':
      return <CompactRevisions {...props} />;
    case 'diagnostics':
      return (
        <div className="compact-panel-list is-diagnostics">
          <DiagnosticsPanel {...props} />
        </div>
      );
  }
}

function CompactHistory(props: CompactPanelBodyProps) {
  const { onSelectFeature, onEditSketch, onLeave, selectedFeatureNodeId } =
    props;
  const text = props.views.historyText;
  const editStep = (feature: FeatureNode) => {
    if (feature.data.featureKind === 'sketch' && onEditSketch) {
      onEditSketch(feature);
    } else if (feature.id !== selectedFeatureNodeId) {
      // Selecting the selected step would clear it: a tap only opens.
      onSelectFeature(feature.id);
    }
    onLeave();
  };
  return (
    <CompactHistoryList
      {...props}
      onEditStep={editStep}
      historyText={props.document ? text : null}
    />
  );
}

function CompactRevisions(props: CompactPanelBodyProps) {
  const revisions = useRevisionCheckpoints(props);
  return (
    <div className="compact-panel-list is-revisions">
      <RevisionsPanel {...props} revisions={revisions} />
    </div>
  );
}
