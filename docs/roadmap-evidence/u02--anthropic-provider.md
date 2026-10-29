---
row: U02
---
AI provider settings include Anthropic with a Claude Sonnet 5.5 default and the official
Messages endpoint. Native authentication, images, reasoning options and SSE translation
retain the existing structured-reply and preview contracts. Regression evidence:
`test/assistant.test.ts`, `test/assistant-anthropic.test.ts`, `test/app-settings.test.ts`,
`SettingsPage.test.tsx`, and `test/e2e/settings.spec.ts`. Live paid-provider verification
remains unrecorded.
