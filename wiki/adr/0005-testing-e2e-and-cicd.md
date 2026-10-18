# ADR-0005: Automated Testing, E2E Browser Verification, and CI/CD

- **Status:** Accepted
- **Date:** 2026-10-18
- **Iteration:** `feat/v1-core-game`

## Context

`AGENTS.md` mandates:
1. Unit and integration tests for all new features and modules.
2. Automated end-to-end (E2E) browser verification using Playwright that launches the game in a real browser, simulates gameplay interactions, verifies rendering/state transitions, and asserts zero console or runtime errors.
3. GitHub Actions workflows (`.github/workflows/`) to automatically build, test, and run E2E browser verification on push and pull requests.

## Decision

1. **Global Telemetry & Control Bridge (`window.__OGSNOW_STATE__` & `window.__OGSNOW_APP__`):**
   - `GameApp` in `src/main.ts` continuously updates `window.__OGSNOW_STATE__` on every frame and exposes `window.__OGSNOW_APP__` helper methods (`dropIn`, `returnToMenu`, `stepSimulation`, `setInputOverride`, `triggerCrashForTest`).
2. **Unit & Integration Suite (`tests/unit/*.test.ts` via Vitest):**
   - `tests/unit/terrain.test.ts`: Verifies DEM generation, bilinear height/normal interpolation, drop-zone clearance, `.glb` binary export (`0x46546C67` magic bytes), and `.glb` import hydration.
   - `tests/unit/physics.test.ts`: Verifies downhill gravity acceleration on Whistler Peak slopes, steering heading changes, carving deceleration (`carve = 1` slows the player vs `carve = 0`), jumping/airtime, and obstacle collision / crash recovery.
   - `tests/unit/audio.test.ts`: Verifies `JungleAudioEngine` stem transitions (`['pad']` -> `['pad', 'bass']` -> `['pad', 'bass', 'drums']`), crash ducking, wind scaling with speed, and snow carve SFX scaling with `carveIntensity` and grounded state.
3. **Playwright E2E Browser Verification (`tests/e2e/gameplay.spec.ts`):**
   - Configured in `playwright.config.ts` to start the Vite dev/preview server automatically (`webServer`), launch headless Chromium with WebGL flags (`--use-gl=angle`, `--use-angle=swiftshader`, `--enable-webgl`, `--ignore-gpu-blocklist`), capture `page.on('console', ...)` and `page.on('pageerror', ...)`, and assert:
     1. Main menu renders flagship mountain (*Whistler Peak*) and all 3 drop zones (`summit-express`, `harmony-ridge`, `glacier-bowl`).
     2. Clicking a drop zone transitions `window.__OGSNOW_STATE__.mode` from `'menu'` to `'riding'`, loads `.glb` terrain (`terrain.glbLoaded === true`, `terrain.glbByteLength > 0`), and shows `#hud-overlay`.
     3. Downhill riding increases `player.speedKmh`, moves player downhill (`player.position.z` increases), and activates adaptive audio stems (`bass`, `drums`) and wind SFX (`windGain > 0`).
     4. Steering (`ArrowLeft`/`ArrowRight`) and carving (`ArrowDown`) update `headingRad`, `carveIntensity`, and `audio.carveGain`, and reduce speed compared to unbraked riding.
     5. Crash state ducks `bassGain` and `drumGain` back to ambient pad (`['pad']`).
     6. Zero `pageerror` or `console.error` events occur throughout the entire E2E session.
4. **GitHub Actions CI/CD (`.github/workflows/ci.yml`):**
   - Triggers on `push` (branches `main`, `master`, `feat/**`) and `pull_request`.
   - Runs `npm ci`, `npm run build`, `npm test` (Vitest unit/integration), installs Playwright Chromium (`npx playwright install --with-deps chromium`), and runs `npm run test:e2e`.

## Consequences

- **Positive:**
  - Full automated confidence from low-level math/physics/audio units up to real Chromium WebGL rendering and DOM interaction.
- **Negative:**
  - E2E tests must avoid flaky wall-clock sleeps by using `window.__OGSNOW_APP__.stepSimulation(dt, input)` or deterministic polling (`expect.poll`).

## Strict Compliance Rules

1. `npm run build`, `npm test`, and `npm run test:e2e` MUST all exit with code `0`.
2. Playwright E2E tests MUST attach `pageerror` and `console.error` listeners before `page.goto('/')` and assert `errors.length === 0` at the end of every test.
