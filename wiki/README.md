# ogSnow Architecture Wiki

Welcome to the living architecture documentation for **ogSnow** (`feat/real-terrain-import`), a browser-based 3D snowboarding game utilizing **real-world open-map elevation data** (AWS Open Data Terrarium DEM → committed `.bin`/`.json` → `.glb`), slope-driven physics, low-poly PS1 aesthetics, and a speed-reactive PS1 Jungle/Breakbeat Web Audio engine.

> [!IMPORTANT]
> **Mandatory Agent Compliance:** Every Execution, Testing, Fixer, and CI/CD Sub-Agent MUST read this `wiki/`, all active ADRs in `wiki/adr/` (`ADR-0001` through `ADR-0007`), and the [PR #1 Review Verification Checklist](./reviews/pr-0001-opus-review.md#4-mandatory-verification-checklist-for-future-sub-agents) prior to writing or modifying any file. Any implementation that deviates from the contracts in [interfaces.md](file:///Users/reynish/Projects/real-life-steep/wiki/interfaces.md) or violates an ADR in `wiki/adr/` will be rejected during verification.

---

## Navigation & Knowledge Base Index

1. **[System Architecture (C4 Model & Diagrams)](./architecture.md)**
   - C1: System Context Diagram
   - C2: Container Diagram
   - C3: Component Diagram
   - C4: Code & Runtime Sequence Diagrams
   - Data-Flow & State Synchronization
2. **[Module Contracts, Interfaces & File Ownership](./interfaces.md)**
   - Repository Directory Structure & Agent Ownership Boundaries
   - Shared TypeScript Data Contracts (`src/types.ts`)
   - Game Configuration Constants (`src/config.ts`)
   - Exact Class & Function Signatures per Module
   - E2E Inspection Hook (`window.__OGSNOW_STATE__`)
3. **[Iteration 2 Task Decomposition (`feat/real-terrain-import`)](./tasks.md)**
   - Task T1: Mountain Registry, Node-Only Terrain Source & Network Fetch Script
   - Task T2: Deterministic Derivation, Offline GLB & Committed Artifacts
   - Task T3: Runtime Wiring, Attribution UI & Telemetry
   - Task T4: Unit + E2E Test Suite (Vitest + Playwright)
   - Task T5: CI Workflow Update (Offline Determinism Gate)
4. **[Anything Decision Records (ADRs)](./adr/)**
   - [ADR-0001: Build and Runtime Stack](./adr/0001-build-and-runtime-stack.md)
   - [ADR-0002: 3D Rendering and Standardized GLB Terrain Pipeline](./adr/0002-3d-rendering-and-terrain-pipeline.md)
   - [ADR-0003: Slope Physics, Collision, and Snowboard Controls](./adr/0003-physics-and-controls.md)
   - [ADR-0004: Adaptive PS1 Jungle Procedural WebAudio Engine](./adr/0004-adaptive-jungle-audio-engine.md)
   - [ADR-0005: Automated Testing, E2E Browser Verification, and CI/CD](./adr/0005-testing-e2e-and-cicd.md)
   - [ADR-0006: Code Review Guardrails and Coordinate Conventions](./adr/0006-code-review-guardrails-and-coordinate-conventions.md)
   - [ADR-0007: Real-World Open-Map Terrain Import (Two-Stage Build Pipeline)](./adr/0007-open-map-terrain-import.md)
5. **[Architecture & Code Reviews (`wiki/reviews/`)](./reviews/)**
   - [PR #1 Opus 5.5 Principal Code Review, Root-Cause Analysis & Verification Checklist](./reviews/pr-0001-opus-review.md)

---

## Architectural Principles

1. **Zero-Friction Browser Delivery:** Instant loading in modern desktop web browsers with zero external binary dependencies required at runtime beyond bundled assets.
2. **Real-World Topographical Fidelity:** Flagship mountain (*Whistler Mountain, BC*) imported from **open map data** (AWS Open Data Terrarium terrain tiles) via a two-stage pipeline (network fetch → committed `whistler-dem.bin`/`whistler-terrain.json` → offline deterministic `.glb`), with a real elevation range (`minElevation < 1600 m`, `maxElevation > 2100 m`), provenance checksums, and user-visible attribution — never a synthetic heightfield (ADR-0007).
3. **Momentum-Coupled Audio-Visual Feedback:** Speed, slope pitch, carving angle, and airtime directly drive camera FOV/offset (`62°` to `84°`) and real-time Web Audio stem mixing (ambient pad, 170 BPM Amen breakbeat, sub-bass, wind noise, snow carve filter).
4. **Deterministic Testability:** Every core subsystem (Terrain, Physics, Audio, Camera, UI) can run deterministically in both headless unit tests (Vitest) and headless Chromium WebGL E2E tests (Playwright) via `window.__OGSNOW_STATE__` and `window.__OGSNOW_APP__`.
