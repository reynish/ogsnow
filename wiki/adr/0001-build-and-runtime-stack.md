# ADR-0001: Build and Runtime Stack

- **Status:** Accepted
- **Date:** 2026-10-18
- **Iteration:** `feat/v1-core-game`

## Context

`ogSnow` requires a zero-install, fast-loading desktop web browser runtime capable of 3D low-poly graphics, deterministic physics, real-time procedural Web Audio synthesis, and automated unit + E2E verification. Parallel Execution Sub-Agents need strict compile-time verification of module boundaries so independently authored subsystems integrate cleanly.

## Decision

We adopt the following core build and runtime stack:
1. **Language:** TypeScript (`^5.6.0`) in strict ES module mode (`"type": "module"`).
2. **Bundler & Dev Server:** Vite (`^5.4.0` or `^6.0.0`) producing static production assets in `dist/`.
3. **3D Engine:** Three.js (`three` `^0.169.0` + `@types/three` `^0.169.0`).
4. **Physics Engine:** `cannon-es` (`^0.20.0`) paired with deterministic DEM terrain surface projection.
5. **Audio Engine:** Native browser **Web Audio API** (`AudioContext`, `OscillatorNode`, `GainNode`, `BiquadFilterNode`, `AudioBufferSourceNode`) with zero external binary audio files required.
6. **Test Runners:**
   - Unit & Integration Tests: `vitest` (`^2.1.0`) + `jsdom`.
   - End-to-End Browser Verification: `@playwright/test` (`^1.48.0`) on headless Chromium with WebGL enabled.

## Consequences

- **Positive:**
  - Rapid startup and sub-second HMR/build times via Vite.
  - Full TypeScript type-checking (`tsc --noEmit`) catches contract mismatches across sub-agents immediately.
  - Zero external audio asset failures or CORS bottlenecks in CI/CD.
- **Negative:**
  - Headless browser testing of WebGL requires explicit Chromium flags (`--use-gl=angle`, `--enable-webgl`) or graceful software fallback if a GPU context is unavailable in stripped-down containers.

## Strict Compliance Rules

1. `package.json` MUST define scripts:
   - `"dev": "vite --port 5173"`
   - `"build": "tsc --noEmit && vite build"`
   - `"preview": "vite preview --port 4173"`
   - `"test": "vitest run"`
   - `"test:e2e": "playwright test"`
   - `"generate-glb": "tsx scripts/generate-glb.ts"`
2. `.gitignore` MUST ignore `node_modules/`, `dist/`, `.logs/`, `playwright-report/`, and `test-results/`.
3. All source files MUST reside in `src/` and compile with zero TypeScript errors.
4. `GameApp` in `src/main.ts` MUST support both hardware WebGL rendering (`THREE.WebGLRenderer`) and a resilient fallback mock/canvas context if a headless container lacks GPU drivers, reporting `webglActive: boolean` and `ready: boolean` in `window.__OGSNOW_STATE__` and ensuring zero unhandled runtime exceptions.
