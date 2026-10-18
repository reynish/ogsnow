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
4. **GitHub Actions CI/CD & Automated GitHub Pages Deployment (`.github/workflows/ci.yml`):**
   - Triggers on `push` (branches `main`, `master`, `feat/**`) and `pull_request`.
   - Configures top-level permissions: `contents: read`, `pages: write`, `id-token: write`.
   - Defines a `concurrency` group (`group: 'pages'`, `cancel-in-progress: false`) for serialized Pages deployments.
   - Job `build-and-test`:
     - Runs `npm ci`, `npm run build`, `npm test` (Vitest unit/integration), installs Playwright Chromium (`npx playwright install --with-deps chromium`), and runs `npm run test:e2e`.
     - After build, unit tests, and Playwright E2E verification pass, packages and uploads the Pages artifact using `actions/upload-pages-artifact@v3` (`path: ./dist`).
     - Uploads `dist/` and `playwright-report/` artifacts on every completion.
   - Job `deploy-pages`:
     - Depends on `build-and-test` (`needs: build-and-test`).
     - Runs on push to `main`, `master`, or `feat/**` (`if: github.event_name == 'push'`).
     - Deploys the Pages artifact using `actions/deploy-pages@v4` to the `github-pages` environment with URL output `${{ steps.deployment.outputs.page_url }}` for instant live browser testing.
5. **Relative Base Path & Asset Resolution (`vite.config.ts`, `TerrainManager`, `main.ts`):**
   - `vite.config.ts` sets `base: './'` so compiled asset URLs resolve relatively under both root domains (`/`) and GitHub Pages project subpaths (e.g., `/ogsnow/`).
   - Default GLB fetch path in `src/terrain/TerrainManager.ts` and `src/main.ts` is configured as `'./assets/whistler-peak.glb'` (relative) instead of `'/assets/whistler-peak.glb'` (absolute), avoiding 404 errors when hosted under subpaths.

## Consequences

- **Positive:**
  - Full automated confidence from low-level math/physics/audio units up to real Chromium WebGL rendering and DOM interaction.
  - Automated continuous deployment to GitHub Pages for both `feat/**` feature branches and mainline branches, enabling instant browser verification on physical devices without manual deployment steps.
- **Negative:**
  - E2E tests must avoid flaky wall-clock sleeps by using `window.__OGSNOW_APP__.stepSimulation(dt, input)` or deterministic polling (`expect.poll`).
  - All asset loading paths must strictly adhere to relative path conventions.

## Strict Compliance Rules

1. `npm run build`, `npm test`, and `npm run test:e2e` MUST all exit with code `0`.
2. Playwright E2E tests MUST attach `pageerror` and `console.error` listeners before `page.goto('/')` and assert `errors.length === 0` at the end of every test.
3. All static asset fetch URLs (such as `.glb` terrain models) MUST use relative paths (e.g., `'./assets/whistler-peak.glb'`), and `vite.config.ts` MUST specify `base: './'` to ensure continuous compatibility with GitHub Pages repository subpaths.
