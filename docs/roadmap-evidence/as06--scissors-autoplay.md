---
row: AS06
---

Opening the Scissors sample starts its pivot moving back and forth through
the saved limits, with the pivot controls expanded and Pause available. It
uses the existing transient assembly playback engine and selected sweep speed;
no pose, command, revision or checkpoint is written by playback. Pause and
manual angle edits remain stopped through ordinary renders, and leaving
Assemble stops motion. Reopening the sample starts its demonstration again;
other projects do not autoplay, and Reduce motion keeps the sample paused
until Play is requested. Regression coverage checks first open, edited-copy
reopen, reload, reset, pause and saved-angle preservation at desktop/mobile
widths, plus runtime lifecycle and ping-pong direction tests.
