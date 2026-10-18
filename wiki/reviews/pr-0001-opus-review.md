# Principal Code Review & Root-Cause Post-Mortem — PR #1 (`feat/v1-core-game`)

- **Reviewer:** Opus 5.5 Principal Code Review Sub-Agent
- **Target Branch:** `feat/v1-core-game` → `main`
- **Verdict:** 🟠 **REQUEST CHANGES** (4 Blockers, 13 Major, 12 Minor, 4 Performance, 3 Security, 5 Nits)
- **Associated ADR:** [ADR-0006: Code Review Guardrails and Coordinate Conventions](../adr/0006-code-review-guardrails-and-coordinate-conventions.md)

---

## 1. Executive Summary & Verification Matrix

Module layout is clean, `src/types.ts` matches `wiki/interfaces.md` byte-for-byte, relative asset paths are configured, and CI passes. However, deep probe verification uncovered **4 blockers**:
1. **B1:** Steering is mirrored on screen (`ArrowRight` turns the rider to the screen LEFT).
2. **B2:** An async race between `init()` and `dropIn()` duplicates terrain meshes/obstacles and corrupts game state.
3. **B3:** Exported/parsed GLB terrain renders smooth-shaded (`flatShading: false`), violating ADR-0002 Rule 3.
4. **B4:** Crash physics ignores `crashSpeedThresholdKmh`, fails to stop slope acceleration during wipeout recovery, and allows riders to pass straight through obstacle volumes.

### Verification Summary

| Check | Result |
| :--- | :--- |
| `npm run build` (`tsc --noEmit && vite build`) | ✅ Pass (⚠️ 652 kB main chunk warning) |
| `npm test` (Vitest) | ✅ 48/48 pass |
| `npx playwright test` (local) | ✅ 6/6 pass (15.3 s) |
| `gh pr checks 1` | ✅ Build/Test/E2E pass, Pages deploy pass |
| Committed `whistler-peak.glb` vs regenerated | ✅ Identical sha256 (`e9ffaff7bf56`) — deterministic pipeline |
| Ad-hoc probe scripts (`tsx`) for physics, camera & GLB | ❌ Uncovered Blockers B1–B4 & Major issues M1–M13 |

---

## 2. Full Review Findings

### 🔴 Blockers (Must Fix Before Merge)

#### B1. Steering is mirrored on screen: `ArrowRight` turns the rider to the LEFT
- **Location:** `src/physics/PhysicsEngine.ts:58,87-88` and `src/camera/FollowCamera.ts:37-38`
- **Finding:**
  - `steer = +1` increments `headingRad`, which moves the rider toward world `+X` (`fwd = (sin h, cos h)`).
  - The camera sits behind the rider (`-Z` offset) looking along `+Z` (downhill) with world up `+Y`. In Three.js right-handed coordinates, camera screen-right is world **`-X`** ($\text{forward} \times \text{up} = (0,0,1) \times (0,1,0) = (-1,0,0)$).
  - Probe result: after `steer = +1` for `0.5s`, the travel direction projects to Normalized Device Coordinates (NDC) `x = -0.512` (the left half of the screen).
  - Unit tests (`physics.test.ts:94-120`) and E2E Test 4 only checked the raw sign of `headingRad`, locking in the inverted behavior without checking screen-space projection.
- **Fix:** Use `headingRad -= steer * rate * dt` (with `fwd = (sin h, cos h)`), align `rollRad` sign so the rider leans into the turn, update `initialHeadingRad` values if needed, and add a unit/integration test projecting travel direction through `FollowCamera` asserting `NDC x > 0` for `steer = +1`.

#### B2. Race between `init()` and `dropIn()` corrupts state and duplicates terrain
- **Location:** `src/main.ts:117-118,121-148,150-163` and `src/terrain/TerrainManager.ts:21-58`
- **Finding:**
  - `window.__OGSNOW_APP__` and HUD drop-zone buttons are active in the `GameApp` constructor before `init()` resolves.
  - Clicking a drop zone while the ~600 kB GLB fetch is still in flight triggers two bugs:
    1. `dropIn()` sees `glbLoaded === false` and invokes `terrain.initialize()` a **second time concurrently**. `rootGroup` ends up containing duplicated `terrain_mesh_group` and `terrain_obstacles`.
    2. When the original `init()` resolves, it calls `physics.resetAtDropZone(defaultDz)` and `hud.setMode('menu')` while `mode === 'riding'`, teleporting the active rider back to the summit and covering the running game with the main menu overlay.
  - E2E `beforeEach` only waited for `window.__OGSNOW_STATE__` to exist rather than waiting for async initialization to complete.
- **Fix:** Make `TerrainManager.initialize()` idempotent by caching its in-flight `Promise`. Gate drop-in actions and disable drop-zone buttons until `init()` finishes. Expose `ready: boolean` on `window.__OGSNOW_STATE__` and await `ready === true` in E2E tests.

#### B3. Rendered terrain is smooth-shaded: ADR-0002 Rule 3 (`flatShading: true`) is violated
- **Location:** `src/terrain/glbPipeline.ts:280` and `src/terrain/TerrainManager.ts:51-53`
- **Finding:**
  - Core glTF 2.0 specification has no material boolean for `flatShading`. When `GLTFExporter` serializes an indexed mesh with smooth vertex normals, `GLTFLoader` reconstructs a `MeshStandardMaterial` with `flatShading = false`.
  - Unit test `terrain.test.ts:181` asserted `flatShading === true` on the *pre-export* `THREE.Mesh`, never inspecting the parsed GLB output that actually renders in the scene.
- **Fix:** Enforce `child.material.flatShading = true; child.material.needsUpdate = true` on all mesh materials inside `parseTerrainFromGLBBuffer()` (and/or convert to non-indexed faceted normals before export), and assert `flatShading === true` on the **parsed** GLB meshes in unit tests.

#### B4. Crash physics: crashes at any speed, rider keeps accelerating while crashed, and passes through obstacles
- **Location:** `src/physics/PhysicsEngine.ts:111-147,205-214,243-250`
- **Finding:**
  - ADR-0003 specifies that a crash occurs only when `speedKmh >= config.crashSpeedThresholdKmh` (`28 km/h`), while lower-speed contacts gently deflect the player. In code, `crashSpeedThresholdKmh` was never read—any contact even at `2 km/h` triggered `isCrashed = true`.
  - During `isCrashed === true`, only steering/carve inputs were zeroed while slope gravity acceleration and heading alignment continued running. Probe on `harmony-ridge`: rider crashed at `14.4 km/h` and accelerated while "crashed" to **`73.8 km/h`** by the end of the `1.5s` recovery timer, sliding straight through `tree_27`.
  - No radial position push-out was performed on collision, leaving the player inside the obstacle's collision cylinder.
- **Fix:** Check `speedKmh >= config.crashSpeedThresholdKmh` on obstacle contact; for low-speed contacts, push the rider out to `obs.radius + playerRadius` and deflect velocity along the contact normal without crashing. For high-speed contacts (`>= 28 km/h`), trigger `isCrashed = true`, push out of obstacle radius, cut speed by 85%, and halt slope gravity drive while applying heavy crash deceleration during recovery.

---

### 🟠 Major Findings (M1–M13)

| ID | Area | Finding & Remediation | Location |
| :--- | :--- | :--- | :--- |
| **M1** | Input / UX | **Focused HUD button captures `Space`:** Clicking `MUTE` leaves focus on the `<button>`. Pressing `Space` to jump activates the focused button and toggles mute. **Fix:** Call `button.blur()` on HUD button clicks and call `e.preventDefault()` on game keys in `PlayerController`. | `HUDManager.ts:208-222`, `PlayerController.ts:105-107` |
| **M2** | Input | **Holding jump auto-repeats:** `jump` is level-triggered, causing 8 consecutive jumps in 5 seconds when holding `Space` (including mid-crash jumps). **Fix:** Edge-trigger jump (rising edge detection) and block jumping while `isCrashed`. | `PlayerController.ts:44`, `PhysicsEngine.ts:80` |
| **M3** | Audio | **Music stems stay at full gain in menu:** `returnToMenu()` / `Escape` never updates `JungleAudioEngine`, and the render loop skips audio updates when `mode === 'menu'`. **Fix:** Reset/duck audio to ambient `['pad']` on menu entry. | `main.ts:187-193,337-347` |
| **M4** | Tests | **E2E stepping is non-deterministic:** The `requestAnimationFrame` loop runs concurrently with `page.evaluate(() => stepSimulation(...))`, and `stepSimulation(dt, override)` permanently latches `overrideInput`. **Fix:** Add `setPaused(paused: boolean)` on `window.__OGSNOW_APP__` and restore previous input override after `stepSimulation`. | `main.ts:217-220,325-351`, `gameplay.spec.ts:189-206` |
| **M5** | Tests / ADR-0005 | **E2E never tests real browser keyboard events:** Every E2E test used `stepSimulation` overrides, leaving `PlayerController` DOM `keydown`/`keyup` untested in Chromium. **Fix:** Drive real `page.keyboard.down('ArrowRight')` / `'ArrowLeft'` in Playwright E2E and verify screen-space/heading movement. | `gameplay.spec.ts` |
| **M6** | Tests / Deploy | **E2E runs against Vite dev server instead of built `dist/`:** `playwright.config.ts` ran `npm run dev`, never testing production bundle asset paths (`base: './'`). **Fix:** Run `npm run build && npm run preview` in `playwright.config.ts`. | `playwright.config.ts:35-40` |
| **M7** | Tests | **No WebGL rendering assertion:** E2E never verified that a WebGL context or canvas was actually active. **Fix:** Expose `webglActive: boolean` in `window.__OGSNOW_STATE__` and assert canvas/WebGL rendering in Playwright. | `gameplay.spec.ts` |
| **M8** | CI/CD | **Workflow-wide concurrency and write permissions:** Top-level `concurrency: pages` serialized all PR checks, and `pages: write` / `id-token: write` were granted to `build-and-test`. **Fix:** Scope `pages: write`, `id-token: write`, and `concurrency: pages` strictly to the `deploy-pages` job; keep `build-and-test` at `contents: read`. | `.github/workflows/ci.yml:11-18` |
| **M9** | CI/CD | **Feature branch pushes overwrite production GitHub Pages & no GLB drift check:** `deploy-pages` ran on `feat/**` pushes, overwriting production. **Fix:** Restrict `deploy-pages` to `refs/heads/main` and `refs/heads/master`, and add a CI step `npm run generate-glb && git diff --exit-code public/assets/whistler-peak.glb`. | `.github/workflows/ci.yml:4-8,74` |
| **M10** | Architecture | **GLB stores mesh only, omitting `TerrainData` metadata:** `TerrainManager` regenerated DEM heights/obstacles in code rather than hydrating metadata from the GLB. **Fix:** Embed `terrainMetadata` (`mountainId`, dimensions, elevation bounds, `dropZones`, `obstacles`) in `mesh.userData.terrainMetadata` (glTF `extras`) so `parseTerrainFromGLBBuffer` recovers it. | `TerrainManager.ts:15-16`, `glbPipeline.ts:51` |
| **M11** | PRD / DEM | **Synthetic DEM overshoot (`2,259m` > `2,182m` summit):** Procedural ridge cosine wave pushed `maxElevation` to `2,259m`, exceeding Whistler Peak's real `2,182m` summit and causing doc drift. **Fix:** Clamp/normalize DEM elevations strictly within `[1520, 2182]` meters and document procedural DEM vs external GIS ingestion in ADR-0006. | `glbPipeline.ts:64-71` |
| **M12** | Gameplay | **Bottom boundary (`z = 590`) is a dead end & lateral wall grind:** Reaching the bottom of the mountain trapped the rider at ~2 km/h instead of wrapping or resetting as required by `interfaces.md` §4.2.8. **Fix:** Wrap/reset cleanly to the active drop zone when `z >= length / 2 - 15`, and adjust `headingRad` inward on lateral boundary contact. | `PhysicsEngine.ts:192-203` |
| **M13** | Wiki / ADR Drift | **Documentation out of sync with code:** Mismatches in camera FOV (`60–85°` vs `62–84°`), audio thresholds (`18/32/55` vs `15/30/60 km/h`), heading convention (`0 = -Z` vs `0 = +Z`), elevation ceiling (`2,182m` vs `2,259m`), carve drag formula wording, and ducking threshold (`< 10` vs `< 15 km/h`). **Fix:** Synchronize all `wiki/` and `wiki/adr/` files with canonical config and code. | `wiki/*` |

---

### 🟡 Minor, ⚡ Performance, 🔐 Security & 🧹 Nits

#### Minor Issues
- **Spawn Fall-Line Corridor:** `harmony-ridge` met the 25m radial spawn clearance rule, but `tree_27` sat directly on the fall line 2.9 seconds below spawn. **Fix:** Enforce both a 25m radial clearance around `(spawnX, spawnZ)` AND a clear downhill corridor (`|x - spawnX| < 18m` for `z` in `[spawnZ, spawnZ + 80m]`).
- **Physics Sub-Stepping & `NaN` Guards:** Guard `step(dt)` with `Number.isFinite(dt)` and sub-step physics integration in fixed increments (`<= 1/60s`) up to clamped `0.05s`.
- **Musical Key Alignment:** Tune bass drone fundamental to C1/C2 (`32.7 Hz` / `65.4 Hz`) to match the C-minor-9th atmospheric pad without a tritone clash.
- **Lazy AudioContext Creation:** Instantiate `AudioContext` inside `init()` (on user gesture) rather than inside the constructor at page load.
- **Camera Snap on Reset:** Snap `FollowCamera` immediately to the player's spawn pose on `resetAtDropZone` / `dropIn` instead of lerping across the mountain.

#### Performance, Security & Nits
- **DOM Security (`HUDManager`):** Prefer safe DOM construction or sanitized text content when rendering dynamic strings.
- **Global Side Effects (`glbPipeline.ts`):** Only apply the Node `FileReader` polyfill when `typeof FileReader === 'undefined'`.
- **CI Least Privilege (`.github/workflows/ci.yml`):** Separate build/test permissions (`contents: read`) from deployment permissions (`pages: write`, `id-token: write`).

---

## 3. Root-Cause Analysis: Why Initial Sub-Agents Missed These Defects

| Defect Category | What the Sub-Agent Did | Root Cause of the Miss | Architectural Guardrail Introduced |
| :--- | :--- | :--- | :--- |
| **B1: Mirrored Screen-Space Steering** | Tested `expect(stateRight.headingRad).toBeGreaterThan(0)` in unit/E2E tests. | **Coordinate-Frame Blindness:** Tested an internal scalar (`headingRad`) in isolation without projecting the resulting 3D world movement vector through `FollowCamera`'s view-projection matrix into screen-space Normalized Device Coordinates (NDC). Because the camera looks toward `+Z` with `+Y` up, world `+X` points to the **left** of the screen (`NDC x < 0`). | **End-to-End Coordinate Projection Rule (ADR-0006 §1):** Directional controls (`ArrowRight` / `steer = +1`) must be verified by projecting the resulting player position into camera NDC space (`ndc.x > 0`), never by asserting an arbitrary internal angle sign in isolation. |
| **B2: Async Init / Drop-In Race** | Tested `terrain.initialize()` in unit tests and synchronous `dropIn()` in E2E after fast local load. | **Missing Idempotency & Lifecycle Gating:** `TerrainManager.initialize()` created a new network/parse pipeline on every call instead of caching an in-flight `Promise<void>`, and `GameApp` exposed interactive UI buttons before async initialization resolved. | **Idempotent Async Init & Ready State Gate (ADR-0006 §2):** All async `initialize()` methods must cache their in-flight `Promise`. `window.__OGSNOW_STATE__.ready` must gate user/test drop-in actions. |
| **B3: Lost `flatShading` After GLB Roundtrip** | Asserted `expect(mesh.material.flatShading).toBe(true)` on the *input* mesh from `buildTerrainMeshFromDEM()`. | **Pre-Serialization Testing Fallacy:** Assumed `GLTFExporter` + `GLTFLoader` preserves all Three.js material flags. Core glTF 2.0 does not serialize `flatShading`, so `GLTFLoader` always defaults to `flatShading: false` unless post-processed on parse or exported with non-indexed faceted normals. | **Post-Deserialization Assertion Rule (ADR-0006 §3):** Any requirement on serialized assets (`.glb` materials, normals, metadata) must be asserted on the **hydrated output** of `parseTerrainFromGLBBuffer()`, never solely on the pre-export object. |
| **B4: Unconditional Crash & Slope Acceleration While Crashed** | Tested `forceCrash()` and high-speed collision flag toggling (`isCrashed === true` -> `false` after `1.5s`). | **State-Flag vs. Physical-Invariant Testing:** Verified boolean state transitions (`isCrashed`) without asserting physical invariants during the state (e.g., rider must decelerate during a crash, must not pass through the obstacle volume, and low-speed `< 28 km/h` contacts must deflect without crashing). | **Physical Invariant Assertions (ADR-0006 §4):** Physics tests must verify both threshold boundaries (`< crashSpeedThresholdKmh` vs `>= crashSpeedThresholdKmh`) and velocity/position invariants throughout the entire crash recovery window. |
| **M1, M2, M4, M5: Input & E2E Determinism** | Used `stepSimulation(dt, { steer: 1 })` while `requestAnimationFrame` was still running in the background. | **Bypassing Real DOM Input & Unpaused Loop:** By relying exclusively on programmatic input overrides while the browser rAF loop ticked concurrently, tests missed DOM button focus capture (`Space` toggling `MUTE`), level-triggered jump repeat, and non-deterministic extra frames. | **Paused Simulation Stepping & Real Keyboard E2E (ADR-0006 §5):** E2E suites must pause the rAF loop (`setPaused(true)`) during deterministic `stepSimulation` assertions AND include dedicated tests using real `page.keyboard` events. |

---

## 4. Mandatory Verification Checklist for Future Sub-Agents

Every Execution, Testing, Fixer, and Review Sub-Agent MUST verify all items in this checklist before marking a task complete:

### A. Coordinate System & Camera Projection Checklist
- [ ] **Downhill Axis:** `-Z` is the mountain summit (`z = -600m`); `+Z` is the mountain base (`z = +600m`). Riding downhill increases `position.z`, and `headingRad = 0` corresponds to riding straight downhill along `+Z`.
- [ ] **Screen-Space Steering:** Pressing `ArrowRight` / `KeyD` (`steer = +1`) turns the rider toward world `-X` (decrementing `headingRad`) so that projecting `player.position` through `FollowCamera.camera` yields `NDC.x > 0` (right half of screen).
- [ ] **Board Roll Convention:** Turning right (`steer = +1`) banks `rollRad` consistently into the turn, and `FollowCamera.snap()` is invoked on drop-in/reset so the camera never sweeps across the terrain.

### B. GLB Asset & Terrain Pipeline Checklist
- [ ] **Post-Parse Material Verification:** Unit tests inspect the `THREE.Group` returned by `parseTerrainFromGLBBuffer()` and assert `material.flatShading === true` on every mesh child.
- [ ] **Embedded Metadata (`userData.terrainMetadata`):** `exportTerrainToGLBBuffer` and `parseTerrainFromGLBBuffer` preserve mountain metadata (`mountainId`, dimensions, elevation bounds, `dropZones`, `obstacles`) inside glTF `extras` / `userData`.
- [ ] **Elevation Ceiling & Fall-Line Corridor:** `generateWhistlerDEM()` elevations strictly respect `[1520m, 2182m]`, and every drop zone has both a `25m` radial obstacle clearance AND an `80m` downhill fall-line corridor (`|x - spawnX| < 18m`, `z` in `[spawnZ, spawnZ + 80m]`) so an unsteered rider never hits an obstacle within the first 5 seconds.
- [ ] **Binary Asset Drift Guard:** Running `npm run generate-glb && git diff --exit-code public/assets/whistler-peak.glb` exits with `0`.

### C. Physics & Audio Invariant Checklist
- [ ] **Crash Speed Threshold (`28 km/h`):** Obstacle contact at `speedKmh < config.crashSpeedThresholdKmh` pushes the rider outside `obs.radius + 1.1` and deflects velocity without setting `isCrashed = true`.
- [ ] **Crash Freeze & Push-Out:** Obstacle contact at `speedKmh >= config.crashSpeedThresholdKmh` sets `isCrashed = true`, pushes the rider outside `obs.radius + 1.1`, reduces speed by 85%, halts downhill gravity acceleration during `crashTimerSeconds > 0`, and applies crash friction so speed decreases monotonically until recovery.
- [ ] **Edge-Triggered Jump:** Holding `jump: true` across multiple consecutive frames triggers only a single jump on the rising edge (`false -> true`) while grounded and not crashed.
- [ ] **Boundary Wrap/Reset:** Reaching the bottom boundary (`z >= length / 2 - 15`) cleanly resets/wraps the rider back to the active drop zone.
- [ ] **Menu Audio Ducking:** Returning to the main menu (`returnToMenu()`) immediately ducks `bassGain` and `drumGain` to `0` (`activeStems = ['pad']`).

### D. E2E & CI/CD Hygiene Checklist
- [ ] **Async Ready Gate:** `TerrainManager.initialize()` caches its in-flight `Promise`. Playwright tests await `window.__OGSNOW_STATE__.ready === true` before interacting with the page.
- [ ] **Deterministic E2E Stepping:** Playwright tests call `window.__OGSNOW_APP__.setPaused(true)` before running deterministic `stepSimulation()` sequences so background `requestAnimationFrame` ticks do not pollute frame counts or physics state.
- [ ] **Real DOM Keyboard & Focus Hygiene:** HUD buttons call `blur()` on click so `Space` never re-triggers a focused button. Playwright E2E tests exercise real `page.keyboard.down('ArrowRight')` / `'ArrowLeft'` inputs and verify `window.__OGSNOW_STATE__.webglActive === true`.
- [ ] **Production Preview Server & Least-Privilege CI:** Playwright runs against the built production bundle (`npm run build && npm run preview`), and `.github/workflows/ci.yml` restricts `pages: write`, `id-token: write`, and `concurrency: pages` strictly to the `deploy-pages` job on `main`/`master`.
