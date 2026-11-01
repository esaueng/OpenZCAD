---
row: L01
---
Collaboration refusals preserve local validation/encryption failure reasons and
expose them with Retry connection in the sharing dialog. An explicit retry
retires the old socket, invalidates late replies, reconciles the room head and
acquires a fresh lease before publishing current unsent work. Unresolved
conflicts retain their existing resolution path. Encrypted-hook regression
coverage checks one publication on the new lease, ignored old-socket acks and
no reconnect while already live; dialog coverage checks visible refusal and
retry. These are local/browser-fixture checks, not authenticated production or
cross-device acceptance.
