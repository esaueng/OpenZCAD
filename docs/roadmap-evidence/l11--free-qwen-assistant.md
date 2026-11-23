---
row: L11
---

Encrypted projects can use an optional built-in Qwen route backed by the
Workers AI Free allowance. The Worker verifies an empty subscription list
before sending project data, requires consent naming the actual inference
endpoint, and stops on quota exhaustion. Personal credentials and the
unencrypted built-in route retain their existing selection rules
(`test/e2ee-assistant-consent.test.ts`,
`apps/web/src/components/assistant/AssistantPanel.consent.test.tsx`).
