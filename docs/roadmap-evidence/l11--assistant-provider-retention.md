---
row: L11
---

Assistant provider retention: an encrypted project's assistant request
through OpenRouter carries `provider.data_collection: 'deny'`, so only
providers that do not store or train on prompts receive it; the consent
dialog states what each route keeps, and ADR-024's assistant section now
lists the drawing sheet. Regression evidence: `test/assistant.test.ts`,
`test/e2ee-assistant-consent.test.ts`, `AssistantPanel.consent.test.tsx`.
