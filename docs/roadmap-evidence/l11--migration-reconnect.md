---
row: L11
---
Automatic migration retries config discovery on browser reconnect, removes its
listener and aborts pending discovery on account disposal, and checks all four
server gates before importing the optional key and migration code (#945).
Enabled-gate chunk failures retain a reload instruction through profile saves;
closed gates and older servers leave Settings closed. Verified by controller
cancellation regressions and the ten Encryption settings browser journeys.
Production activation remains off pending outside review; macOS qualification
remains deferred.
