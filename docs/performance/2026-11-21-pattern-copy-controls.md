# Retaining pattern copy buttons during edits

Skipping one copy used to replace the viewport's pattern buttons. In a Chromium CPU profile, removing controls accounted for 34.1 ms across 12 click-to-worker intervals on a 12-hole plate and 42.8 ms across 12 intervals on a 32-hole plate. A focused button also disappeared when the user pressed Enter to skip or Space to restore a copy.

The button now keeps its identity when only its skipped state changes. The viewport updates its pressed state and skipped style on the existing element. Picking another point still gives the copy a new identity when its label changes.

## Measured effect

The direct parent was `6a4690dfb`, and the candidate was `ed397ef95`. Both release builds used the same Remus binaries. In hardware Chromium on an RTX 3090, each session skipped three distinct copies in reverse pick order. Six pairs of fresh sessions per plate size alternated which build ran first.

| Holes | Click to worker, parent → candidate | Click to matching exact frame, parent → candidate | Pairs with faster dispatch | Pairs with faster frame |
| ---: | ---: | ---: | ---: | ---: |
| 12 | 7.35 → 4.30 ms | 52.45 → 50.35 ms | 6/6 | 5/6 |
| 32 | 8.60 → 4.90 ms | 135.95 → 130.80 ms | 6/6 | 4/6 |

Each time is the median of 18 clicks per build and size. The pair counts compare the three-click session medians. Dispatch improved by 42–43%. The complete edit reached its frame about 4% sooner. All 72 click results matched the reference in mesh vertices and indices, full topology, volume and warnings. The measurements isolate this change from the separate work on geometry computation.

## Reproduction

Open the 12- or 32-hole plate's point pattern in History, then click the last three copy buttons in reverse pick order. Time from each click to posting its geometry request, then to the first frame drawn with the matching checked triangle count. [Fixture coordinates and frame instrumentation](2026-11-20-point-pattern-bore-checks.md)

For keyboard verification, focus a copy button, press Enter to skip it, then press Space to restore it. Check focus, the accessible name and the pressed state after each toggle. The CI smoke case also clicks the copy again, saves the pattern and checks the resulting model.
