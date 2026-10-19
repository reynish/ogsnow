# Principal Code Review & Root-Cause Post-Mortem — PR #2 (`feat/real-terrain-import-2`)

- **Reviewer:** Opus 5.5 Principal Code Review Sub-Agent
- **Target Branch:** `feat/real-terrain-import-2` (or `feat/real-terrain-import`) → `main`
- **Verdict:** 🟠 **REQUEST CHANGES** (2 Blockers, 5 Major, 5 Minor, 2 Performance, 2 Security, 4 Nits)
- **Associated ADRs:** [ADR-0002](../../wiki/adr/0002-3d-rendering-and-terrain-pipeline.md), [ADR-0006](../../wiki/adr/0006-code-review-guardrails-and-coordinate-conventions.md), [ADR-0007](../../wiki/adr/0007-open-map-terrain-import.md)

---

## 1. Executive Summary & Verification Matrix

Iteration 2 delivers a major architectural transition: replacing synthetic procedural splines with a two-stage open-map terrain pipeline sourcing real elevation tiles from AWS Open Data Terrarium at Whistler Mountain, British Columbia. The offline derivation and build scripts (`fetch-terrain.ts`, `generate-glb.ts`) execute cleanly, unit tests pass (94/94), and Playwright E2E browser tests pass (7/7).

However, rigorous probe analysis and deep static verification uncovered **2 Blockers** and **5 Major defects**:
1. **B1:** A user clicking a drop zone while `init()` is in flight causes a race condition where the player is reset to stale/placeholder coordinates (`z = -520m`), stranding the rider on an uphill reverse-slope where speed remains trapped at `0.0 km/h`.
2. **B2:** `GameApp.init()` catches and swallows any failure to load terrain artifacts (`whistler-dem.bin` / `whistler-peak.glb`), logging a console warning but marking `isReady = true`. This leaves `TerrainManager` with an empty heightfield; subsequent queries return `NaN`, collapsing physics and rendering into a zombie state in direct violation of ADR-0007 Rules 1 & 8.
3. **M1:** A math bug in `createSeededRandom` (`terrainDerivation.ts`) truncates the Mulberry32 output range strictly to `[0.0, 0.5000]`. As a direct consequence, **every derived obstacle (107/107) is placed exclusively in the top-left quadrant (`z <= 0`, `x <= 0`)**, leaving the entire lower playable mountain (`z > 0`, from `z = 150` down to `z = 1600`) with zero trees, rocks, or cliffs.
4. **M2:** In `enuToGame` / `gameToEnu`, the coordinate transformation with downhill azimuth $180^\circ$ (South) reflects the East/West axis, causing real-world geographic features to render mirrored horizontally.
5. **M3:** Topographical analysis of the committed DEM reveals that Whistler Peak summit (`2,177m`) is located at `z = +50m` (the center of the grid), meaning the northern half (`z ∈ [-1600m, 0m]`) is a steep uphill approach (91.6% uphill grade along `+Z`), rather than a continuous downhill summit-to-base fall line as specified in ADR-0007 §5.

### Verification Summary

| Check | Result | Notes |
| :--- | :--- | :--- |
| `npm run build` (`tsc --noEmit && vite build`) | ✅ Pass | 521 kB three.js chunk, 82 kB cannon-es chunk |
| `npm test` (Vitest) | ✅ Pass (94/94 passed) | Duration: 843ms across 5 test suites |
| `npm run test:e2e` (Playwright) | ✅ Pass (7/7 passed) | Chromium headless, 14.5s |
| Deterministic GLB Generation (`scripts/generate-glb.ts`) | ✅ Pass | `git diff --exit-code` produces zero diff |
| Bundle Leak Audit (`dist/assets/*.js`) | ✅ Pass | No Node builtins or GIS fetch URLs in browser bundle |
| Pre-ready UI Interaction Probe | ❌ **FAIL (B1)** | Un-gated buttons reset player to stale `z = -520` |
| Missing Asset Fault-Tolerance Probe | ❌ **FAIL (B2)** | Swallows 404, sets `ready = true`, produces `NaN` player state |
| PRNG Range & Obstacle Spatial Probe | ❌ **FAIL (M1)** | PRNG range `[0, 0.5)`; zero obstacles below `z = 0` |
| Geodetic Frame Parity Probe | ❌ **FAIL (M2)** | Real-world East/West mirrored relative to screen space |

---

## 2. Full Review Findings

### 🔴 Blockers (Must Fix Before Merge)

#### B1. Pre-Ready Drop-Zone Click Causes State Desynchronization and Stranding (Partial Regression of PR-1 B2)
- **Location:** `src/main.ts:133-150`, `src/ui/HUDManager.ts:248-251`
- **Finding:**
  - In `GameApp.constructor()`, `this.hud = new HUDManager(...)` is instantiated immediately and renders the main menu using `DEFAULT_GAME_CONFIG.dropZones`, which has placeholder coordinates (`z = -520m`, `elevation = 2130m`).
  - The drop-zone cards in `HUDManager.ts` are never disabled or gated by `isReady`.
  - If a user clicks a drop-zone button while `init()` is in flight (e.g. while network fetches for `whistler-terrain.json`, `whistler-dem.bin`, and `whistler-peak.glb` are active):
    1. `dropIn(dropZoneId)` is invoked with the placeholder drop zone (`z = -520m`).
    2. `this.physics.resetAtDropZone(dropZone)` places the player at `z = -520m` with `y = 0` (or `NaN` if `heights` is not yet populated).
    3. When `init()` finishes later, it calls `hud.updateDropZones(realDropZones)` and updates `this.config.dropZones`, but **does not reposition the active player**.
  - On the real Whistler DEM, `z = -520m` is on the northern reverse-slope, where the grade ascends towards the summit at `z = 50m`. The rider is stranded in flat/uphill terrain with speed stuck at `0.0 km/h`, unable to move downhill.
- **Fix:**
  1. In `HUDManager.ts`, render drop-zone cards in a disabled state (`pointer-events: none; opacity: 0.5`) until `updateDropZones()` is called.
  2. In `GameApp.dropIn()`, await `this.init()` before looking up the drop zone and resetting physics.

#### B2. Silent Error Swallowing on Missing/Corrupt Assets Yields Zombie `NaN` Engine State (ADR-0007 Rule 1 & Rule 8 Violation)
- **Location:** `src/main.ts:139-140, 186-187`, `src/terrain/TerrainManager.ts:35-51, 165-191`
- **Finding:**
  - `GameApp.init()` wraps `await this.terrain.initialize()` in a `try ... catch` block:
    ```typescript
    try {
      await this.terrain.initialize();
      this.config.dropZones = [...this.terrain.terrainData.dropZones];
    } catch (err) {
      console.warn('Failed to load terrain artifacts during init:', err);
    }
    ```
  - When `terrain.initialize()` throws (e.g. if `whistler-dem.bin` returns HTTP 404 or fails checksum/size validation), `init()` catches the error, logs a console warning, and proceeds to execute:
    ```typescript
    this.isReady = true;
    this.syncGlobalState();
    this.startLoop();
    ```
  - Because `TerrainManager` failed to initialize, `this.terrain.terrainData.heights` remains an empty `Float32Array(0)`.
  - In `PhysicsEngine.ts:222` and `getHeightAt(x, z)`, accessing `heights[r * stride + c]` yields `undefined`, converting all position/altitude calculations to `NaN`.
  - The game enters a broken zombie state with `ready = true` and `player.position.y = NaN`.
  - This violates ADR-0007 Rule 1 ("No synthetic terrain anywhere in the runtime or CI path") and Rule 8 ("Fail-loud fetch / no silent synthetic fallback").
- **Fix:**
  - Do not swallow errors in `main.ts:139-140`. If `terrain.initialize()` fails:
    1. Set `this.isReady = false`.
    2. Transition `mode` to `'error'`.
    3. Render an error banner in `HUDManager` instructing the user/developer that required terrain artifacts failed to load.
    4. Do not start the physics simulation loop.

---

### 🟠 Major Findings (M1–M5)

#### M1. PRNG Bitwise Overflow in `createSeededRandom` Halves Range to `[0, 0.5)` — 100% of Obstacles Confined to North-West Quadrant
- **Location:** `src/terrain/terrainDerivation.ts:25-34, 307-313`
- **Finding:**
  - In `createSeededRandom(seed)`:
    ```typescript
    s += 0x6d2b79f5;
    let t = s;
    t = (t ^ (t >> 15)) * (1 | t);
    t = (t ^ (t >> 7)) * (61 | t);
    return (t ^ (t >> 14)) / 4294967296;
    ```
  - In JavaScript, bitwise operators operate on signed 32-bit integers. Without `>>> 0` on the final XOR and without `Math.imul` for 32-bit integer multiplication, `(t ^ (t >> 14))` evaluates as a signed integer whose top bit is 0, yielding values strictly in `[0, 2147483647]`.
  - Empirical probe results across 100,000 iterations:
    - Minimum generated value: `0.000000`
    - Maximum generated value: `0.499999`
    - Decile histogram: `[20000, 20000, 20000, 20000, 20000, 0, 0, 0, 0, 0]`
  - In `deriveObstacles()`:
    ```typescript
    const r = Math.floor(rand() * (segZ + 1));
    const c = Math.floor(rand() * (segX + 1));
    ```
    Since `rand() < 0.5`, `r` is bounded in `[0, 128]` (out of 256) and `c` is bounded in `[0, 64]` (out of 128).
  - Consequently:
    - `z` is strictly in `[-1600m, 0m]` (the top half of the map).
    - `x` is strictly in `[-800m, 0m]` (the left half of the map).
  - In the committed `whistler-terrain.json`, **all 107 obstacles have $z \le 0$ and $x \le 0$**.
  - The entire playable downhill course ($z \in [150, 1600]$), where all 3 drop zones descend, has **zero obstacles**. A player never encounters a single tree, rock, or cliff during downhill riding.
- **Fix:**
  - Correct `createSeededRandom` to standard 32-bit unsigned Mulberry32:
    ```typescript
    export function createSeededRandom(seed: number): () => number {
      let s = seed >>> 0;
      return function () {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    ```
  - Re-run `npm run generate-glb` to populate obstacles across the full mountain extent.

#### M2. Geodetic Axis Reflection (Handedness Inversion vs Screen-Space Camera)
- **Location:** `src/terrain/terrainSource.ts:71-101`
- **Finding:**
  - `enuToGame` computes:
    $$x_{\text{game}} = \text{east} \cdot \cos\theta - \text{north} \cdot \sin\theta$$
    $$z_{\text{game}} = \text{east} \cdot \sin\theta + \text{north} \cdot \cos\theta$$
  - For Whistler with downhill azimuth $\theta = 180^\circ$ (due South):
    $$x_{\text{game}} = -\text{east}, \quad z_{\text{game}} = -\text{north}$$
  - In Three.js, camera looks down $+Z$ (South) with $+Y$ Up. Screen-right is world $-X$ (ADR-0006).
  - Therefore, world $+X$ is screen-left.
  - Since $x_{\text{game}} = -\text{east}$, $+X$ represents **West**. Thus West is rendered on screen-left.
  - But for an observer looking South, West is to the **right** hand!
  - 3D camera projection probe confirms: a real-world point to the West of Whistler Peak projects to negative NDC $x$ (left half of screen). The imported terrain is horizontally mirrored relative to real geography.
- **Fix:**
  - Update `enuToGame` and `gameToEnu` to account for Three.js camera coordinate parity:
    $$x_{\text{game}} = \text{east} \cdot \cos\theta + \text{north} \cdot \sin\theta$$
    (or reflect the lateral axis so real-world West maps to screen-right).

#### M3. Topographical Saddle / Fall Line Inversion on Whistler Summit
- **Location:** `public/assets/terrain/whistler-terrain.json`, `src/terrain/mountains.ts:27-31`
- **Finding:**
  - ADR-0007 §5 and README §6.1 specify that $-Z$ corresponds to summit/uphill and $+Z$ corresponds to base/downhill.
  - However, in the committed DEM grid, Whistler Peak (`2,177.14m`) is located at grid vertex $(c=64, r=132)$, corresponding to $(x=0, z=+50m)$—the exact geometric center of the terrain extent.
  - For all $z \in [-1600m, 0m]$, the elevation *increases* along $+Z$ (rising from $1,606m$ up to $2,177m$). 91.6% of grid cells in the northern half slope uphill along $+Z$.
  - While `summit-express` was placed at $z = 150m$ to catch the downhill slope, placing the summit at $z = +50m$ truncates the effective downhill run to $1,550m$ instead of the planned $3,200m$, and leaves the northern $1,600m$ as an unplayable reverse slope.
- **Fix:**
  - In `src/terrain/mountains.ts`, adjust the `origin.latitudeDeg` and `origin.longitudeDeg` (or shift the sampling window anchor) so the summit is positioned near $z = -1400m$, allowing the full $3,200m$ extent to serve as a downhill run.

#### M4. GLB Metadata Omits Iteration 2 Provenance Fields
- **Location:** `src/terrain/glbPipeline.ts:134-146`, `scripts/generate-glb.ts:98`
- **Finding:**
  - `buildTerrainMeshFromDEM()` attaches metadata to `mesh.userData`, which is serialized into glTF `extras`:
    ```typescript
    mesh.userData = {
      mountainId: data.mountainId,
      mountainName: data.mountainName,
      region: data.region,
      width: data.width,
      length: data.length,
      segmentsX: data.segmentsX,
      segmentsZ: data.segmentsZ,
      minElevation: data.minElevation,
      maxElevation: data.maxElevation,
      dropZones: data.dropZones,
      obstacles: data.obstacles,
    };
    ```
  - Noticeably missing are the Iteration 2 provenance fields: `source` (provider, zoom, tiles), `origin` (lat/lon, azimuth), `attribution`, `demFormatVersion`, and `sampledControlPoints`.
  - When inspecting the generated `whistler-peak.glb` using glTF inspection tools, provenance telemetry cannot be recovered from the GLB alone.
- **Fix:**
  - Include `source`, `origin`, `attribution`, `demFormatVersion`, and `gridResolutionMeters` in `mesh.userData` inside `buildTerrainMeshFromDEM`.

#### M5. FNV-1a Hash 32-Bit Signed Integer Inconsistency
- **Location:** `src/terrain/terrainDerivation.ts:14-21`
- **Finding:**
  - In `fnv1a32(str)`:
    ```typescript
    hash = (hash * 0x01000193) & 0xffffffff;
    ```
  - In JavaScript, `& 0xffffffff` returns a 32-bit signed integer.
  - Standard FNV-1a requires unsigned 32-bit arithmetic (`>>> 0`).
  - For strings that hash with the MSB set, `fnv1a32` returns a negative number, which can cause erratic seed initialization in downstream generators.
- **Fix:**
  - Use `Math.imul(hash, 0x01000193) >>> 0`.

---

### 🟡 Minor, ⚡ Performance, 🔐 Security & 🧹 Nits

#### Minor Issues
- **m1. Outdated Default Drop Zones in `src/config.ts`:** `DEFAULT_GAME_CONFIG.dropZones` still contains Iteration 1 synthetic coordinates (`z = -520`, `z = -260`, `z = -40`). When `GameApp` starts before `init()` updates the HUD, these outdated coordinates are briefly visible.
- **m2. Tautological Control-Point Assertion in `terrain.test.ts:79-91`:** `sampledControlPoints` are generated during `fetch-terrain.ts` by sampling the already-resampled grid. Testing `heights[r * stride + c] === cp.elevationM` tests object identity rather than verifying elevations against raw DEM source data.
- **m3. Missing `OsmRefineHook` in `terrainDerivation.ts`:** `wiki/interfaces.md` specifies an optional `osmRefine` parameter for `deriveObstacles`, but the parameter is absent in the implementation signature.
- **m4. Elevation Discontinuity near Runout Boundary:** Near $z = 1550m$, the slope flattens abruptly to $1,395m$, causing high-speed riders to stall immediately before the reset boundary ($z = 1585m$).
- **m5. Missing Network Spy in E2E Tests:** `tests/e2e/gameplay.spec.ts` verifies local telemetry but does not assert that `page.route` intercepted zero external outbound requests.

#### Performance Issues
- **P1. Redundant Derivation Execution in Browser Runtime:** `whistler-terrain.json` already contains pre-derived `dropZones` and `obstacles`. When `TerrainManager.initialize()` runs in the browser, it calls `assembleTerrainData()`, re-running the full derivation algorithm over 33,153 vertices instead of reading the pre-derived objects from the manifest.
- **P2. GLB Buffer Memory Allocation:** `whistler-peak.glb` is 1.6 MB uncompressed. Serving with gzip/brotli compression on static hosts reduces transfer to ~400 kB.

#### Security Issues
- **S1. Unrestricted Artifact URL Parameter in `TerrainManager.initialize`:** `initialize(artifacts)` takes arbitrary URL strings without validating that the path is relative or restricted to `./assets/`.
- **S2. Recursive Object Serialization in `stableJsonStringify`:** `stableJsonStringify` in `scripts/fetch-terrain.ts` does not guard against cyclic structures or depth limits.

#### Nits
- **N1. Type Signature Mismatch in `interfaces.md`:** `deriveTerrain` is documented in `interfaces.md` as `(data: TerrainData, opts?: Partial<DeriveOptions>)`, but in code it takes `(manifest: TerrainManifest, heights: Float32Array)`.
- **N2. Tree Line Threshold Constant:** `treeLineElevationM` is hardcoded as `1650` in `terrainDerivation.ts:342` instead of referencing `manifest.treeLineElevationM`.
- **N3. Verbose Console Output:** `scripts/fetch-terrain.ts` logs multiple redundant lines during tile extraction.
- **N4. Attribution CSS Selector Fallback:** `.terrain-attribution` in `style.css` does not define fallback font families.

---

## 3. Root-Cause Analysis

| Defect Category | Sub-Agent Action | Root Cause | Architectural Guardrail |
| :--- | :--- | :--- | :--- |
| **B1: Pre-Ready Drop-In Race** | Gated `resetAtDropZone` inside `init()` if `mode !== 'menu'`. | **Un-gated DOM Buttons:** Did not disable interactive drop-zone buttons in the DOM while asynchronous initialization was unresolved. | **ADR-0006 §2 / UI State Guard:** All interactive controls dependent on asynchronous assets must be disabled in the DOM until `isReady === true`. |
| **B2: Silent Error Swallowing** | Added `try ... catch` around `terrain.initialize()` in `main.ts`. | **Defensive Catch Antipattern:** Swallowed fatal asset loading errors to prevent unhandled promise rejections, masking complete engine failure. | **ADR-0007 Rule 8 / Fail-Loud Policy:** Core assets must throw and transition to a visible error state rather than continuing in an invalid state. |
| **M1: PRNG Range Truncation** | Implemented Mulberry32 PRNG without unsigned bit-shift. | **JavaScript Operator Type Blindness:** Assumed bitwise XOR returns unsigned numbers, neglecting JavaScript's signed 32-bit integer coercion. | **PRNG Uniformity Testing Rule:** All PRNG implementations must have unit tests asserting uniformity across all deciles $[0.0, 1.0]$. |
| **M2: Geodetic Handedness Inversion** | Derived 2D rotation formulas for azimuth $180^\circ$. | **Coordinate Space Parity Error:** Converted from ENU (right-handed, Z up) to Three.js (right-handed, Y up) without checking screen-space camera parity. | **ADR-0006 §1 / Screen-Space Parity:** Geodetic mappings must verify that real-world compass directions project to expected screen-space axes. |

---

## 4. Actionable Fix Specifications

### Fix B1: Disable Drop-Zone Buttons Until Ready & Await `init()` in `dropIn`
- **Target File:** `src/ui/HUDManager.ts:248-251` & `src/main.ts:176-189`
- **Changes:**
  1. In `HUDManager.ts`, add a disabled class or `pointer-events: none` to drop-zone cards during initial render, and enable them in `updateDropZones()`.
  2. In `GameApp.dropIn()`, await `this.initPromise` before selecting the drop zone.

### Fix B2: Fail Loudly on Missing Assets
- **Target File:** `src/main.ts:133-145`
- **Changes:**
  - Remove `try ... catch` in `main.ts:133-145`. Allow the promise to reject, set `this.isReady = false`, and display a prominent error banner in `#ui-container`.

### Fix M1: Correct Mulberry32 PRNG & Regenerate Artifacts
- **Target File:** `src/terrain/terrainDerivation.ts:25-34`
- **Changes:**
  - Replace `createSeededRandom` with proper unsigned `Math.imul` implementation.
  - Run `npm run generate-glb` to regenerate `whistler-peak.glb` and `whistler-terrain.json` with obstacles properly distributed across the entire mountain.

### Fix M2: Align Geodetic East/West with Camera NDC
- **Target File:** `src/terrain/terrainSource.ts:71-101`
- **Changes:**
  - Update `enuToGame` and `gameToEnu` to ensure real-world West projects to camera screen-right (`NDC.x > 0`).

### Fix M4: Serialize Full Provenance into GLB Extras
- **Target File:** `src/terrain/glbPipeline.ts:134-146`
- **Changes:**
  - Embed `source`, `origin`, `attribution`, `demFormatVersion`, and `gridResolutionMeters` into `mesh.userData`.

---

## 5. Verification Checklist for Subsequent Sub-Agents

- [ ] **B1 Verification:** Pre-ready drop-zone button clicks do not strand the rider at $z = -520m$ or corrupt active drop-zone state.
- [ ] **B2 Verification:** 404 on `whistler-dem.bin` transitions to an explicit error state and does not produce `NaN` in telemetry.
- [ ] **M1 Verification:** Obstacles in `whistler-terrain.json` span both $z < 0$ and $z > 0$, with at least 40% of obstacles located in the active riding runout ($z > 0$).
- [ ] **M2 Verification:** Geodetic coordinate transforms place real-world West on the right half of the screen when riding South.
- [ ] **M4 Verification:** `whistler-peak.glb` contains full provenance metadata in glTF `extras`.
- [ ] **Determinism Gate:** `npm run generate-glb && git diff --exit-code` passes with zero diff.
