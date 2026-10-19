# ADR-0007: Real-World Open-Map Terrain Import (Two-Stage Build Pipeline)

- **Status:** Accepted
- **Date:** 2026-10-19
- **Iteration:** `feat/real-terrain-import`
- **Supersedes:** ADR-0002 §"Decision.1" (`generateWhistlerDEM()` synthetic heightfield clause) and ADR-0006 §"Decision.3" (the deferral of external GIS ingestion). All other ADR-0002 rules (GLB serialization, flat-shading, metadata embedding, `TerrainData` contract, drop-zone clearance) remain **in force** and are re-stated below for the real-data pipeline.
- **Superseded-by:** — (active)

## Context

Iteration 1 shipped a **synthetic** Whistler heightfield (`generateWhistlerDEM()`), a monotonic Hermite spline clamped to `[1520, 2182]` m. The PRD (README §6) and its Core Fidelity Principle require the playable terrain to be a **genuine import of a real-world location from open map data** — not a procedural "inspired-by" heightfield. Verified reconnaissance established:

- AWS Open Data "Terrarium" terrain tiles are reachable and **keyless**: `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` (8-bit RGB PNG; decode `elevation = R*256 + G + B/256 - 32768`).
- Whistler anchor ≈ `50.0596° N, -122.9570° W`. The correct z13 tile is `x=1298, y=2776`. A real z13 tile decoded to **min 1145 m / max 2172 m / center 1853 m** — i.e. the real terrain range is **not** `[1520, 2182]`.
- z14 ≈ `6.13 m/px`; z13 ≈ `12.27 m/px` at this latitude.
- Copernicus DEM GLO-30 COGs are reachable keyless on AWS Open Data (cross-check/fallback only).
- OSM tiles / Nominatim / Geofabrik are reachable, but the Overpass API returns HTTP 406 from the build environment. OSM feature overlays are therefore **optional/best-effort**, and obstacle & drop-zone derivation **must work from the DEM alone** with zero hard network dependency.
- CI runs on GitHub Actions; runtime and all tests must make **zero network requests**.

## Decision

### 1. Sources (open, licensed, keyless)

| Role | Source | License / Attribution |
| :--- | :--- | :--- |
| Primary elevation | AWS Open Data **Terrarium** terrain tiles (Mapzen-derived, SRTM/NED/etc.) | `"Elevation: AWS Open Data Terrain Tiles (Terrarium)"` |
| Cross-check / fallback | **Copernicus DEM GLO-30** COGs (AWS Open Data) | `"Copernicus DEM GLO-30 © European Union, contains modified Copernicus Sentinel data"` |
| Optional feature overlay | **OpenStreetMap** (`piste:type=downhill`, `landuse=forest`/`natural=tree`, lifts) via Geofabrik extracts (not Overpass) | `"Map data © OpenStreetMap contributors"` |

The **committed** Whistler artifacts use Terrarium elevation and DEM-only derivation (no OSM overlay), so their attribution is the Terrarium string only. The OSM string is emitted only when OSM features actually contribute to a derived artifact.

### 2. Two-stage build pipeline (network ⇄ offline split)

- **Stage A — network one-shot fetch (`scripts/fetch-terrain.ts`, `npm run fetch-terrain -- --mountain <id>`):** resolves the registry entry's pinned tile set, downloads raw tiles to a gitignored on-disk cache (`.cache/terrain/`), decodes RGB PNG elevations, re-projects EPSG:3857 → lat/lon → local ENU, resamples onto the rotated game grid, and writes the **committed source-of-truth artifacts**:
  - `public/assets/terrain/<id>-dem.bin` — raw `Float32` little-endian, row-major `(gridSegmentsZ+1) × (gridSegmentsX+1)` elevations.
  - `public/assets/terrain/<id>-terrain.json` — provenance manifest (origin, grid dims, real `min/maxElevation`, zoom, pinned tile URLs + `z/x/y` + SHA-256 checksums, `sampledControlPoints`, license/attribution, `demFormatVersion`). It does **not** yet contain derived drop zones/obstacles.
- **Stage B — offline deterministic derivation (`scripts/generate-glb.ts`, `npm run generate-glb`):** reads the committed `.bin` + `.json` (never the network), derives drop zones and obstacles via `src/terrain/terrainDerivation.ts`, assembles `TerrainData`, builds the low-poly flat-shaded vertex-colored mesh, and writes:
  - `public/assets/whistler-peak.glb` — the render mesh with `terrainMetadata` embedded in glTF `extras` (per ADR-0002/0006).
  - an enriched `public/assets/terrain/<id>-terrain.json` — the same manifest **plus** the derived `dropZones`, `obstacles`, and a `derivation` block (algorithm version + seed). Deterministic field ordering; no timestamps/UUIDs/random.

CI runs **Stage B only** and diffs. Runtime loads **only** committed bundled assets (zero network). See §Consequences for the determinism gate.

### 3. Mountain registry (`src/terrain/mountains.ts`)

A single registry entry is the **only** input required to add a mountain (README §6.6). The Whistler entry:

```typescript
{
  id: 'whistler',
  name: 'Whistler Mountain',
  region: 'British Columbia, Canada',
  origin: { latitudeDeg: 50.0596, longitudeDeg: -122.9570, downhillAzimuthDeg: 180 },
  extentWidthM: 1600,    // across-slope → world X
  extentLengthM: 3200,   // down-slope   → world Z
  zoom: 13,              // source zoom (12.27 m/px @ 50.06N)
  gridSegmentsX: 128,    // 12.5 m spacing
  gridSegmentsZ: 256,    // 12.5 m spacing
  treeLineElevationM: 1650,
  license: 'AWS Open Data Terrain Tiles (Terrarium)',
  attribution: ['Elevation: AWS Open Data Terrain Tiles (Terrarium)'],
  pinnedTiles: [
    { z: 13, x: 1297, y: 2775 }, { z: 13, x: 1298, y: 2775 },
    { z: 13, x: 1297, y: 2776 }, { z: 13, x: 1298, y: 2776 },
  ],
}
```

**Pinned-tile derivation (verified):** the origin `50.0596/-122.9570` falls at fractional pixel `(11.6, 41.7)` inside z13 tile `1298/2776`. The rotated `1600×3200 m` extent at `12.268 m/px` needs `±65 px` laterally and `±130 px` down-slope, i.e. global pixel ranges `x 332234–332365` and `y 710567–710828`, which span tiles `x ∈ {1297, 1298}` and `y ∈ {2775, 2776}`. (An earlier draft listing `1299/2777` did **not** cover the extent.) `fetch-terrain` MUST still derive/verify coverage from the formulas and fail loudly if any required pixel is outside the pinned set.

**Zoom justification:** the game grid spacing is `12.5 m`; z13 (`12.27 m/px`) is already finer than the grid (satisfying the "sample no coarser than ~20 m" budget) and avoids the ~4× fetch volume of z14 (`6.13 m/px`), which would be downsampled away. README §6.1's "zoom 14" is treated as the maximum permissible source resolution; z13 is the chosen committed resolution.

### 4. Grid budget (PS1 low-poly aesthetic)

- `128 × 256` segments ⇒ **65,536 triangles**, `129 × 257 = 33,153` vertices, `12.5 m` grid spacing.
- 65k terrain triangles ≈ 44% of the `< 150k` budget, leaving headroom for ~110 instanced low-poly obstacles (trees/rocks/cliffs) without exceeding the budget.
- `heights` = `33,153 × 4 B ≈ 133 KB` on disk/runtime; acceptable to bundle.

### 5. Coordinate convention & fall-line orientation (preserves ADR-0006)

Downhill remains **world `+Z`**; `steer=+1 → headingRad` decrement → world `-X` (screen right) is **unchanged**. The rotated sampling rectangle is computed as follows (implemented in `terrainSource.ts`, unit-tested offline):

- Local metric ENU anchored at `origin`:
  - `east  = (lon - lon0) · metersPerDegLon`, `metersPerDegLon = 111320 · cos(lat0·π/180)`
  - `north = (lat - lat0) · metersPerDegLat`, `metersPerDegLat = 111320`
- With downhill azimuth `θ` (compass bearing clockwise from North; Whistler `θ = 180°`, due south), `sinθ = sin(θ·π/180)`, `cosθ = cos(θ·π/180)`:
  - Downhill direction (→ game `+Z`): `d = (sinθ, cosθ)` in `(east, north)`
  - Lateral direction (→ game `+X`): `l = (cosθ, −sinθ)` in `(east, north)`
- Forward (ENU → game): `x_game = east·cosθ − north·sinθ`, `z_game = east·sinθ + north·cosθ`.
- Inverse (game → ENU, for grid sampling): `east = x_game·cosθ + z_game·sinθ`, `north = −x_game·sinθ + z_game·cosθ`, then `lat = lat0 + north/metersPerDegLat`, `lon = lon0 + east/metersPerDegLon`.
- Game grid: `x_game ∈ [−W/2, +W/2]`, `z_game ∈ [−L/2, +L/2]`; summit/uphill at `−Z`, base/downhill at `+Z` (identical to Iteration 1). `getNormalAt`, `getSlopePitchAt`, physics gravity projection, and camera contracts are therefore untouched.

### 6. Determinism (byte-identical offline output)

- Single seeded PRNG (`mulberry32` or the existing `createSeededRandom` LCG) with a **constant seed derived from `mountainId`** (FNV-1a 32-bit hash of the id) — never `Math.random()`/`Date.now()`/`crypto`/UUID.
- Derivation iterates the grid in fixed row-major order and sorts derived drop zones by `id` (stable) and obstacles by deterministic `id` (`<type>_<index>`).
- `generate-glb` and `fetch-terrain` write JSON via a stable serializer (explicit field order / sorted keys) and MUST NOT embed build timestamps, machine names, or environment state.
- `GLTFExporter` output is deterministic for identical `TerrainData` (its `asset.generator`/`asset.version` are fixed constants; no timestamps).
- Gate: running `npm run generate-glb` twice yields byte-identical `public/assets/whistler-peak.glb`, `public/assets/terrain/whistler-terrain.json`, and (unchanged) `whistler-dem.bin`.

### 7. Provenance & no-network fidelity verification

- `fetch-terrain` records `sampledControlPoints` (≥ 16 grid-space samples with geodetic coords, source tile `z/x/y`, pixel coords, and decoded elevation) plus per-tile SHA-256 checksums in `<id>-terrain.json`.
- Tests compare the committed grid against the recorded control points (bilinear tolerance) and assert real-world bounds for Whistler: **`maxElevation > 2100` and `minElevation < 1600`**, and **never** the synthetic `[1520, 2182]` clamp. All provenance assertions read committed artifacts only — no network.

### 8. Failure handling (no silent synthetic fallback)

- `fetch-terrain` exits non-zero if any pinned tile returns non-200, fails to decode, or leaves the extent uncovered; it MUST NOT substitute synthetic elevations.
- `generate-glb` exits non-zero if the committed `.bin`/`.json` are missing or fail schema/checksum validation; it MUST NOT regenerate the heightfield synthetically.
- Committed artifacts are authoritative; the browser never invokes either Node script.

## Consequences

- **Positive:**
  - The playable mountain becomes a genuine, verifiable open-data import; every elevation traces to a recorded, checksummed Terrarium tile.
  - Clean network/offline split makes CI and tests hermetic (zero network) and reproducible.
  - Registry-driven repeatability: adding a mountain is data-only (README §6.6).
  - ADR-0006 coordinate/steering contracts and ADR-0002 GLB/flat-shading/metadata contracts are preserved; physics/camera/audio tests remain valid.
- **Negative:**
  - Runtime must now load the committed `.glb` **plus** `whistler-terrain.json` + `whistler-dem.bin` (three bundled relative fetches) to reconstruct the physics heightfield + provenance.
  - Iteration-1 `generateWhistlerDEM()` and its synthetic-elevation unit tests are removed; `TerrainManager` can no longer synthesize its `TerrainData` in the constructor.
  - The exact real elevation range (`≈1145–2172 m`) will change HUD altitude and drop-zone elevations vs Iteration 1.

## Strict Compliance Rules

1. **No synthetic terrain anywhere in the runtime or CI path.** `generateWhistlerDEM()` (synthetic Hermite spline) MUST be deleted or reduced to a pure `TerrainData` assembler; no playable elevation may be procedurally invented. Every committed elevation MUST trace to a recorded, checksummed open DEM tile.
2. **Network isolation:** `src/terrain/terrainSource.ts` and `scripts/fetch-terrain.ts` are Node-only and MUST NOT be imported by any browser-bundled module (`src/main.ts`, `src/terrain/TerrainManager.ts`, etc.). `tsc --noEmit`, `npm run build`, `npm test`, and `npm run test:e2e` MUST make zero network requests.
3. **Determinism gate:** `npm run generate-glb && git diff --exit-code public/assets/whistler-peak.glb public/assets/terrain/whistler-terrain.json public/assets/terrain/whistler-dem.bin` MUST produce zero diff, and two consecutive offline runs MUST be byte-identical.
4. **Real elevation bounds (Whistler):** committed `whistler-terrain.json` MUST record `minElevation < 1600` and `maxElevation > 2100`, and MUST NOT be `[1520, 2182]`. `altitudeMeters` in `window.__OGSNOW_STATE__` MUST be the imported real-world elevation.
5. **Coordinate convention (ADR-0006):** downhill MUST remain `+Z`; `steer=+1` MUST decrement `headingRad` toward world `-X`. The rotated sampling rectangle MUST follow §5 formulas exactly.
6. **ADR-0002 retained rules:** `TerrainManager.initialize()` idempotent; `.glb` magic `0x46546C67`; post-parse `material.flatShading === true`; `terrainMetadata` embedded in glTF `extras` and restored to `userData`; 25 m obstacle-free radial + 80 m downhill corridor clearance at every drop-zone spawn. Drop-zone **ids** remain `summit-express` / `harmony-ridge` / `glacier-bowl` (highest→lowest) so existing `data-testid` selectors and E2E assertions are preserved.
7. **Attribution visibility:** the exact attribution strings in §1 MUST appear (a) in a stable `data-testid="terrain-attribution"` DOM element in the main menu, (b) in `window.__OGSNOW_STATE__.terrain.attribution`, and (c) in `<id>-terrain.json`.
8. **Fail-loud fetch:** `fetch-terrain` MUST exit non-zero (never silently synthesize) if any pinned tile is unreachable/undecodable/uncovered.
