(globalThis as Record<string, unknown>).DurableObject ??= class DurableObject {};
(globalThis as Record<string, unknown>).WorkflowEntrypoint ??= class WorkflowEntrypoint {};
