# Feature history and repair

Selecting a history feature now exposes its immediate geometric inputs and all later geometric dependents. The graph follows stored sketch/body references, face-attached sketches, in-place edits, and both split results. Suppressed features remain in the graph, and deleted inputs are explicitly identified. These are geometry dependencies; named parameter expressions are still edited in the parameter panel.

Dependency links open the corresponding existing inspector. Selecting a consumed source also highlights its surviving result bodies, so history selection has visible model context. The details explain deletion/suppression impact before the user acts. Deletion remains undoable and now counts sketch dependents correctly.

Exact edit refusals retain their feature identity across the validation boundary. The History details panel identifies the failed feature, explains that the rejected edit did not alter the committed model, and opens that feature for repair. Opening it clears the previous form's error while retaining the failure context in History. Repair messages are scoped to their document version and are not published for stale validation results or features that were never committed.

Rollback shows how many later features are paused and offers Resume full history. That action removes rollback flags only, preserving manual suppression. Rollback and resume are each single undoable transactions.

Validation covers direct and transitive dependencies, in-place edits, suppressed features, split results, deleted inputs, and exact failure identity. Browser acceptance exercises downstream failure routing, invalid fillet radius rejection and correction, deletion recovery, rollback with manual suppression, and undo/redo. The existing exact geometry gates remain unchanged. History details and sketch edit UI/validation load on demand to stay within the existing initial bundle budget.

This milestone does not automatically re-select missing topology or rewrite feature references. The existing inspector remains the repair surface. It adds no kernel, document schema, unit, tolerance, or deployment changes.
