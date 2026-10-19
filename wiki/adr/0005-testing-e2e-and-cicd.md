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
   - `GameApp` in `src/main.ts` continuously updates `window.__OGSNOW_STATE__` (including `ready: boolean` and `webglActive: boolean`) on every frame and exposes `window.__OGSNOW_APP__` helper methods (`dropIn`, `returnToMenu`, `stepSimulation`, `setInputOverride`, `triggerCrashForTest`, `setPaused`).
   - `stepSimulation(dtSeconds, overrideInput)` restores the prior input override after stepping so one-shot test steps do not permanently latch input overrides.
2. **Unit & Integration Suite (`tests/unit/*.test.ts` via Vitest):**
   - `tests/unit/terrain.test.ts`: Verifies real committed DEM artifact loading (`whistler-dem.bin` + `whistler-terrain.json` from disk) with real elevation bounds (`minElevation < 1600`, `maxElevation > 2100`, **never** `[1520,2182]`), provenance checks against `sampledControlPoints` (bilinear tolerance), `TerrainManager` idempotent `initialize()`, `.glb` binary magic (`0x46546C67`), post-parse `material.flatShading === true`, `userData.terrainMetadata` preservation, and drop-zone 25m radial + 80m downhill corridor clearance.
   - `tests/unit/terrainSource.test.ts`: Verifies geodesy reprojection (`lonLatToWebMercatorPixels`, `enuToGame`/`gameToEnu`) and `decodeTerrariumPng` against known synthetic PNG bytes — all offline with no network requests.
   - `tests/unit/terrainDerivation.test.ts`: Verifies seeded drop-zone and obstacle derivation determinism (byte-identical output for identical inputs), stable id assignment (`summit-express`/`harmony-ridge`/`glacier-bowl`), and spawn clearance invariants.
   - `tests/unit/physics.test.ts`: Verifies downhill gravity acceleration (`+Z`), steering screen-space projection through `FollowCamera` (`steer = +1` -> `NDC x > 0`), carving deceleration (`carve = 1` slows the player vs `carve = 0`), edge-triggered jumping/airtime, speed-gated obstacle collision (`< 28 km/h` deflection vs `>= 28 km/h` crash, radial push-out, and zero acceleration while crashed), and bottom boundary clean reset.
   - `tests/unit/audio.test.ts`: Verifies `JungleAudioEngine` stem transitions (`['pad']` -> `['pad', 'bass']` -> `['pad', 'bass', 'drums']`), crash/menu ducking, wind scaling with speed, and snow carve SFX scaling with `carveIntensity` and grounded state.
3. **Playwright E2E Browser Verification (`tests/e2e/gameplay.spec.ts`):**
   - Configured in `playwright.config.ts` to build and serve the production bundle (`npm run build && npm run preview -- --port 4173`), launch headless Chromium with WebGL flags (`--use-gl=angle`, `--use-angle=swiftshader`, `--enable-webgl`, `--ignore-gpu-blocklist`), capture `page.on('console', ...)` and `page.on('pageerror', ...)`, wait for `window.__OGSNOW_STATE__.ready === true`, and assert:
     1. Main menu renders flagship mountain (*Whistler Peak*), all 3 drop zones (`summit-express`, `harmony-ridge`, `glacier-bowl`), and active WebGL rendering (`webglActive === true`).
     2. Clicking a drop zone transitions `window.__OGSNOW_STATE__.mode` from `'menu'` to `'riding'`, loads `.glb` terrain (`terrain.glbLoaded === true`, `terrain.glbByteLength > 0`), and shows `#hud-overlay`.
     3. Deterministic simulation stepping (with `setPaused(true)` pausing background `requestAnimationFrame` ticks) increases `player.speedKmh`, moves player downhill (`player.position.z` increases), and activates adaptive audio stems (`bass`, `drums`) and wind SFX (`windGain > 0`).
     4. Real browser keyboard steering (`page.keyboard.down('ArrowRight')` / `'ArrowLeft'`) and carving update `headingRad`, screen-space movement, `carveIntensity`, and `audio.carveGain`, and clicking `MUTE` followed by `Space` jump does not re-toggle the focused button.
     5. Crash state and returning to menu duck `bassGain` and `drumGain` back to ambient pad (`['pad']`).
     6. Zero `pageerror` or `console.error` events occur throughout the entire E2E session.
4. **GitHub Actions CI/CD & Automated GitHub Pages Deployment (`.github/workflows/ci.yml`):**
   - Triggers on `push` (branches `main`, `master`, `feat/**`) and `pull_request`.
   - Sets top-level workflow permissions to `contents: read` only (least privilege) and omits top-level `concurrency` so PR builds run in parallel without canceling each other.
   - Job `build-and-test`:
     - Runs `npm ci`, verifies GLB determinism (`npm run generate-glb && git diff --exit-code public/assets/whistler-peak.glb`), runs `npm run build`, `npm test` (Vitest unit/integration), installs Playwright Chromium (`npx playwright install --with-deps chromium`), and runs `npm run test:e2e`.
     - When pushing to `main` or `master`, packages and uploads the Pages artifact using `actions/upload-pages-artifact@v3` (`path: ./dist`).
     - Uploads `dist/` and `playwright-report/` artifacts on completion.
   - Job `deploy-pages`:
     - Depends on `build-and-test` (`needs: build-and-test`).
     - Runs ONLY on push to `main` or `master` (`if: github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/master')`).
     - Scopes `permissions: { contents: read, pages: write, id-token: write }` and `concurrency: { group: 'pages', cancel-in-progress: false }` strictly to `deploy-pages`.
     - Deploys the Pages artifact using `actions/deploy-pages@v4` to the `github-pages` environment.
5. **Relative Base Path & Asset Resolution (`vite.config.ts`, `TerrainManager`, `main.ts`):**
   - `vite.config.ts` sets `base: './'` so compiled asset URLs resolve relatively under both root domains (`/`) and GitHub Pages project subpaths (e.g., `/ogsnow/`).
   - Default GLB fetch path in `src/terrain/TerrainManager.ts` and `src/main.ts` is configured as `'./assets/whistler-peak.glb'` (relative) instead of `'/assets/whistler-peak.glb'` (absolute), avoiding 404 errors when hosted under subpaths.

## Consequences

- **Positive:**
  - Full automated confidence from low-level math/physics/audio units up to real Chromium WebGL rendering and DOM keyboard interaction against the built production bundle.
  - Least-privilege CI workflow that protects the production GitHub Pages deployment from feature-branch overwrites.
- **Negative:**
  - E2E tests must call `setPaused(true)` before deterministic `stepSimulation(dt, input)` sequences so background `requestAnimationFrame` frames do not interleave.
  - All asset loading paths must strictly adhere to relative path conventions.

## Strict Compliance Rules

1. `npm run build`, `npm test`, and `npm run test:e2e` MUST all exit with code `0`, and `npm run generate-glb && git diff --exit-code public/assets/whistler-peak.glb` MUST produce zero diff.
2. Playwright E2E tests MUST attach `pageerror` and `console.error` listeners before `page.goto('/')`, await `window.__OGSNOW_STATE__.ready === true`, assert `webglActive === true`, test real `page.keyboard` steering inputs, and assert `errors.length === 0` at the end of every test.
3. All static asset fetch URLs (such as `.glb` terrain models) MUST use relative paths (e.g., `'./assets/whistler-peak.glb'`), and `vite.config.ts` MUST specify `base: './'` to ensure continuous compatibility with GitHub Pages repository subpaths.
