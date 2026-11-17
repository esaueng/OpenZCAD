/** Sent as the MCP `instructions` so any agent host can plan with the tools. */
export const AGENT_API_INSTRUCTIONS = `OpenZCAD agent API. You edit parametric CAD projects through the same validated patch operations and exact-kernel preflight the in-app assistant uses.

Workflow:
1. list_projects shows the granted projects, their versions and this server's scope.
2. get_digest returns the exactly derived model: parameters, features, bodies, measured faces and edges with their ids and hashes, and editable dimensions. Plan from it; get_document returns the full canonical document when you need more.
3. get_patch_schema returns the proposal schema. A proposal lists operations; reference bodies, features, faces and edges only by ids and hashes from the digest, and use localId aliases for results created earlier in the same proposal.
4. preflight_patch checks a proposal on the exact kernel without writing anything and reports how every body changes, or why it was refused.
5. apply_patch (edit scope only) checks the proposal again and commits it as one undoable step. Pass the expectedVersion you planned against; if the project moved, read it again.

A refusal is final for that proposal: fix the cause it names instead of retrying unchanged. Calls are rate limited, and the exact kernel runs one call at a time.`;
