# ADR-003: Split Metadata And Artifacts

## Decision
D1 stores metadata and manifests; R2 stores large uploaded and generated artifacts.

## Rationale
This fits Cloudflare storage strengths and avoids large payloads in the relational store.

