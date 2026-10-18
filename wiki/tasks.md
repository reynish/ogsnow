# Iteration 1 Task Decomposition (`feat/v1-core-game`)

This document decomposes Iteration 1 (`feat/v1-core-game`) into five self-contained tasks for Execution, Testing, and CI/CD Sub-Agents. Every Sub-Agent MUST read `wiki/interfaces.md`, `wiki/adr/0001-*.md` through `0006-*.md`, and `wiki/reviews/pr-0001-opus-review.md` before writing code.

---

## Execution Order & Parallelism Graph

```mermaid
flowchart TD
    T1["Task 1: Scaffolding, Types/Config & Terrain DEM/GLB Pipeline"]
    T2["Task 2: Physics Engine, Low-Poly Snowboarder & Follow Camera"]
    T3["Task 3: Adaptive PS1 Jungle WebAudio Engine, UI/HUD & Game Loop"]
    T4["Task 4: Vitest Unit/Integration Suite & Playwright E2E Browser Tests"]
    T5["Task 5: GitHub Actions CI/CD Workflow (.github/workflows/ci.yml)"]

    T1 --> T2
    T1 --> T3
    T1 --> T5
    T2 --> T4
    T3 --> T4
```

- **Wave 1 (Foundation):** Task 1 sets up `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`, `src/types.ts`, `src/config.ts`, and `src/terrain/*` (plus `public/assets/whistler-peak.glb`), and installs dependencies (`npm install`).
- **Wave 2 (Parallel Core Implementation):** Task 2 (`src/physics/*`, `src/player/*`, `src/camera/*`), Task 3 (`src/audio/*`, `src/ui/*`, `src/main.ts`, `index.html`, `src/style.css`), and Task 5 (`.github/workflows/ci.yml`) can execute in parallel with zero file overlap.
- **Wave 3 (Verification & E2E):** Task 4 writes and executes the unit/integration tests (`tests/unit/*`) and Playwright E2E browser tests (`tests/e2e/*`, `playwright.config.ts`) against the integrated application.

---

## Task 1: Scaffolding, Shared Contracts & Flagship Mountain DEM/GLB Pipeline

- **Assigned Role:** Execution Sub-Agent 1 (Scaffolding & Terrain/GLB Pipeline)
- **Owned Files:**
  - `.gitignore`
  - `package.json`
  - `tsconfig.json`
  - `vite.config.ts`
  - `src/types.ts`
  - `src/config.ts`
  - `src/terrain/glbPipeline.ts`
  - `src/terrain/TerrainManager.ts`
  - `scripts/generate-glb.ts`
  - `public/assets/whistler-peak.glb`
- **Detailed Requirements:**
  1. Create `.gitignore` ignoring `node_modules/`, `dist/`, `.logs/`, `playwright-report/`, and `test-results/`.
  2. Create `package.json` with dependencies `three` (`^0.169.0`), `cannon-es` (`^0.20.0`), and devDependencies `typescript` (`^5.6.0`), `vite` (`^5.4.0`), `@types/three` (`^0.169.0`), `vitest` (`^2.1.0`), `jsdom` (`^25.0.0`), `@playwright/test` (`^1.48.0`), `tsx` (`^4.19.0`). Run `npm install`.
  3. Create `tsconfig.json` and `vite.config.ts` (`base: './'`).
  4. Implement `src/types.ts` and `src/config.ts` matching `wiki/interfaces.md` verbatim.
  5. Implement `src/terrain/glbPipeline.ts`:
     - `generateWhistlerDEM(width = 400, length = 1200, segmentsX = 64, segmentsZ = 192): TerrainData` generating a deterministic downhill ski mountain heightfield (Whistler Peak Express `2,182m` to base `1,520m`, clamping elevations strictly within `[1520, 2182]`) with alpine bowls, ridges, rollers, 3 drop zones (`DEFAULT_GAME_CONFIG.dropZones`), and natural obstacles (`tree`, `rock`, `cliff`) keeping both a `25m` clear radius AND an `80m` clear downhill corridor (`|x - spawnX| < 18m`, `z` in `[spawnZ, spawnZ + 80m]`) below each drop zone spawn point.
     - `buildTerrainMeshFromDEM(data: TerrainData): THREE.Mesh` with low-poly flat-shaded vertex colors (`flatShading: true`) and `mesh.userData.terrainMetadata` containing `mountainId`, dimensions, elevation bounds, `dropZones`, and `obstacles`.
     - `exportTerrainToGLBBuffer(mesh: THREE.Object3D): Promise<ArrayBuffer>` and `parseTerrainFromGLBBuffer(buffer: ArrayBuffer): Promise<THREE.Group>` creating/parsing valid binary glTF 2.0 (`.glb`, magic header `0x46546C67`). `parseTerrainFromGLBBuffer` MUST enforce `material.flatShading = true; material.needsUpdate = true` on all loaded `THREE.Mesh` children and preserve `userData.terrainMetadata`.
  6. Generate `public/assets/whistler-peak.glb` via `scripts/generate-glb.ts` so the static `.glb` file exists on disk.
  7. Implement `src/terrain/TerrainManager.ts` with idempotent `initialize(glbUrl?)` (caching its in-flight `Promise<void>`), `getHeightAt(x, z)`, `getNormalAt(x, z)`, `getSlopePitchAt(x, z, headingRad)`, `checkObstacleCollision(position, radius)`, and low-poly 3D obstacle meshes (pine trees, jagged rocks, cliff faces) attached to `rootGroup`.

---

## Task 2: Physics Engine, Low-Poly Snowboard Character, Controls & Dynamic Camera

- **Assigned Role:** Execution Sub-Agent 2 (Physics, Character & Camera)
- **Owned Files:**
  - `src/physics/PhysicsEngine.ts`
  - `src/player/PlayerController.ts`
  - `src/player/SnowboardCharacter.ts`
  - `src/camera/FollowCamera.ts`
- **Detailed Requirements:**
  1. Implement `src/physics/PhysicsEngine.ts` adhering strictly to `wiki/interfaces.md`, `ADR-0003`, and `ADR-0006`:
     - Uses `cannon-es` (`CANNON.World`, `CANNON.Body`) coupled with `TerrainManager.getHeightAt(x, z)` and `getNormalAt(x, z)`, fixed sub-stepping (`<= 1/60s`), and `Number.isFinite(dtSeconds)` guards.
     - Downhill is `+Z` (`headingRad = 0`). Because `FollowCamera` looks along `+Z` with `+Y` up, camera screen-right is world `-X`. Therefore `steer = +1` (`ArrowRight`/`KeyD`) MUST decrement `headingRad` (`headingRad -= steer * steerRate * dt`) to steer toward world `-X` (screen right, `NDC x > 0`), and `rollRad` banks into the turn (`-steer * 0.35`).
     - Implements carving deceleration (`carveIntensity`, `carveAngleRad`, `carveDragCoefficient`), aerodynamic tuck boost (`input.tuck`), **edge-triggered** jump impulse (`input.jump` rising edge only) & `airtimeSeconds` tracking, speed-gated obstacle collision (`< 28 km/h` pushes out and deflects without crashing; `>= 28 km/h` sets `isCrashed = true`, pushes outside `obs.radius + 1.1`, cuts speed by 85%, and freezes slope gravity drive during `crashTimerSeconds` recovery), and lateral/bottom boundary handling (wrapping/resetting to active drop zone when `z >= length / 2 - 15`).
  2. Implement `src/player/PlayerController.ts` supporting keyboard (`WASD`, Arrow keys, `Space`, `R` with `e.preventDefault()` on game keys), Gamepad API polling, and programmatic test overrides (`setOverride`).
  3. Implement `src/player/SnowboardCharacter.ts` building a nostalgic PS1 low-poly snowboarder mesh (board, bindings, rider legs, torso, jacket, arms, head with goggles/beanie) and snow spray particles that scale with `carveIntensity` and speed.
  4. Implement `src/camera/FollowCamera.ts` with smooth third-person chase tracking, instant `snap(playerState)` on reset/drop-in, slope pitch tilt, terrain-clearance clamping, and speed-reactive FOV (`cameraBaseFov = 62°` to `cameraMaxFov = 84°`).

---

## Task 3: Adaptive PS1 Jungle WebAudio Engine, UI/HUD & Game Loop Coordinator

- **Assigned Role:** Execution Sub-Agent 3 (Audio, UI/HUD & Main Coordinator)
- **Owned Files:**
  - `src/audio/JungleAudioEngine.ts`
  - `src/ui/HUDManager.ts`
  - `src/main.ts`
  - `src/style.css`
  - `index.html`
- **Detailed Requirements:**
  1. Implement `src/audio/JungleAudioEngine.ts` adhering strictly to `wiki/interfaces.md`, `ADR-0004`, and `ADR-0006`:
     - Lazy `AudioContext` creation inside `init()` (on user gesture) rather than at page load.
     - Deterministic `update(playerState, dtSeconds): AudioState` calculating `padGain`, `bassGain` (`> 15 km/h`), `drumGain` (`> 30 km/h`, full `>= 60 km/h`), `windGain`, `windFrequencyHz`, `carveGain`, `carveFrequencyHz`, and `activeStems` based on `speedKmh`, `carveIntensity`, `isGrounded`, and `isCrashed`.
     - Procedural Web Audio API 170 BPM PS1 Jungle synthesizer (detuned atmospheric C-minor-9th pad oscillators, C1/C2 Reese/sub-bass oscillator at `32.7 Hz`/`65.4 Hz`, 16-step Amen breakbeat drum pattern with kick/snare/chopped hats, bandpass-filtered wind noise, and bandpass-filtered snow carve noise).
  2. Implement `src/ui/HUDManager.ts` and `src/style.css` with retro PS1 extreme-sports styling:
     - Main menu (`#main-menu`) displaying mountain overview and clickable drop-zone buttons (`[data-testid="drop-zone-btn-summit-express"]`, `[data-testid="drop-zone-btn-harmony-ridge"]`, `[data-testid="drop-zone-btn-glacier-bowl"]`).
     - In-game HUD (`#hud-overlay`) displaying live speed (`[data-testid="hud-speed"]`), altitude (`[data-testid="hud-altitude"]`), active audio stems badge (`[data-testid="hud-stems"]`), carve/airtime/crash status banners, mute toggle (`[data-testid="btn-mute-audio"]`), and return-to-menu button (`[data-testid="btn-return-menu"]`). All buttons call `blur()` on click so `Space` jump never activates a focused button.
  3. Implement `src/main.ts` (`GameApp`) and `index.html`:
     - Wires `TerrainManager`, `PhysicsEngine`, `PlayerController`, `SnowboardCharacter`, `FollowCamera`, `JungleAudioEngine`, and `HUDManager` into a Three.js scene with alpine sky lighting and fog.
     - Gates drop-in until `init()` finishes (`ready: true`), ducks audio to `['pad']` on `returnToMenu()`, and snaps camera on drop-in/reset.
     - Publishes `window.__OGSNOW_STATE__` (including `ready` and `webglActive`) and `window.__OGSNOW_APP__` (`dropIn`, `returnToMenu`, `stepSimulation`, `setInputOverride`, `triggerCrashForTest`, `setPaused`) on every frame and state transition.

---

## Task 4: Automated Unit/Integration Tests (Vitest) & E2E Browser Verification (Playwright)

- **Assigned Role:** Testing & Playwright E2E Sub-Agent
- **Owned Files:**
  - `tests/unit/terrain.test.ts`
  - `tests/unit/physics.test.ts`
  - `tests/unit/audio.test.ts`
  - `tests/e2e/gameplay.spec.ts`
  - `playwright.config.ts`
- **Detailed Requirements:**
  1. Write unit/integration tests in `tests/unit/` covering:
     - `terrain.test.ts`: Whistler DEM elevation profile (`[1520, 2182]` bounds, summit higher than base), bilinear height/normal accuracy, obstacle collision checks, drop-zone 25m radial + 80m downhill corridor clearance, `.glb` binary export (`0x46546C67` header), post-parse `material.flatShading === true` verification, `userData.terrainMetadata` preservation, and idempotent `initialize()`.
     - `physics.test.ts`: Gravity acceleration down slope (`+Z`), left/right steering screen-space projection through `FollowCamera` (`steer = +1` -> `NDC x > 0`), carving deceleration & `carveIntensity`, edge-triggered jump & airtime tracking, speed-gated obstacle collision (`< 28 km/h` deflection vs `>= 28 km/h` crash, radial push-out, and zero acceleration while crashed), and bottom boundary clean reset.
     - `audio.test.ts`: Adaptive stem progression (`['pad']` at 0 km/h -> `['pad', 'bass']` at 22 km/h -> `['pad', 'bass', 'drums']` at 65 km/h), crash ducking back to `['pad']`, wind pitch/gain scaling with speed, snow carve SFX scaling with carve intensity and zeroing when airborne.
  2. Configure `playwright.config.ts` (running against built production bundle `npm run build && npm run preview -- --port 4173`) and write `tests/e2e/gameplay.spec.ts`:
     - Launch the game in headless Chromium with WebGL flags (`--use-gl=angle`, `--use-angle=swiftshader`, `--enable-webgl`, `--ignore-gpu-blocklist`).
     - Assert zero `console.error` and zero `pageerror` events.
     - Wait for `window.__OGSNOW_STATE__.ready === true`, assert `webglActive === true`, and use `window.__OGSNOW_APP__.setPaused(true)` during deterministic `stepSimulation` sequences.
     - Verify main menu rendering, drop-zone selection (`summit-express`, `harmony-ridge`), `.glb` terrain loading state (`terrain.glbLoaded === true`), downhill momentum buildup, real keyboard steering (`page.keyboard.down('ArrowRight')` / `'ArrowLeft'`), MUTE button click + `Space` jump focus isolation, adaptive audio stem state transitions in `window.__OGSNOW_STATE__.audio`, menu audio ducking, and crash ducking recovery.
  3. Run `npm run build`, `npm test`, and `npm run test:e2e` and verify 100% pass rate.

---

## Task 5: GitHub Actions CI/CD & Automated GitHub Pages Deployment Pipeline

- **Assigned Role:** CI/CD & GitHub Pages Sub-Agent
- **Owned Files:**
  - `.github/workflows/ci.yml`
  - `vite.config.ts` (base path configuration)
- **Detailed Requirements:**
  1. Create and maintain `.github/workflows/ci.yml` triggered on `push` (`main`, `master`, `feat/**`) and `pull_request`.
  2. Set top-level workflow permissions to `contents: read` (least privilege). Do NOT set workflow-wide `concurrency: pages` so PR checks never cancel each other.
  3. Configure Node.js 20 with `npm` caching, install dependencies (`npm ci`), verify GLB asset determinism (`npm run generate-glb && git diff --exit-code public/assets/whistler-peak.glb`), install Playwright Chromium (`npx playwright install --with-deps chromium`), run `npm run build`, `npm test`, and `npm run test:e2e`.
  4. Upload Pages artifact using `actions/upload-pages-artifact@v3` (`path: ./dist`) in `build-and-test` when pushing to `main` or `master`.
  5. Add `deploy-pages` job (`needs: build-and-test`, runs ONLY on push to `main` or `master`) with job-scoped `permissions: { contents: read, pages: write, id-token: write }` and `concurrency: { group: 'pages', cancel-in-progress: false }`, deploying via `actions/deploy-pages@v4` to `github-pages` environment.
  6. Ensure `vite.config.ts` sets `base: './'` and all static assets in code reference relative paths (`'./assets/whistler-peak.glb'`) for seamless operation on GitHub Pages project subpaths (`/ogsnow/`).
