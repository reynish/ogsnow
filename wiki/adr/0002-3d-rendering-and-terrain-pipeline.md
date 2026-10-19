# ADR-0002: 3D Rendering and Standardized GLB Terrain Pipeline

- **Status:** Accepted (partially superseded by [ADR-0007](./0007-open-map-terrain-import.md))
- **Date:** 2026-10-18
- **Iteration:** `feat/v1-core-game`

> [!WARNING]
> **Superseded clause (Iteration 2):** ADR-0007 supersedes the *synthetic* `generateWhistlerDEM()` heightfield generator in §"Decision.1" and the "external GIS ingestion deferred" note in ADR-0006 §"Decision.3". From `feat/real-terrain-import` onward, the DEM grid comes from committed real-world open-data artifacts (`whistler-dem.bin` + `whistler-terrain.json`) via the two-stage pipeline, and `generateWhistlerDEM()` is removed or reduced to a pure `TerrainData` assembler. **All other rules below remain in force**: the `TerrainData`/GLB serialization contract, `flatShading: true`, `terrainMetadata` embedding in glTF `extras`, bilinear height/normal queries, and drop-zone clearance requirements are retained verbatim and re-stated in ADR-0007.

## Context

The PRD requires a single flagship real-world mountain (*Whistler Peak, BC — Peak Express / Harmony Ridge*) imported using a repeatable standard: generating 3D meshes from DEM/Heightmap elevation data and exporting/loading them as `.glTF` / `.glb` files. It also requires PS1-era nostalgic low-poly aesthetics, natural obstacles (trees, rocks, cliffs), and multiple drop zones.

## Decision

1. **Standardized DEM-to-GLB Pipeline (`src/terrain/glbPipeline.ts`):**
   - `generateWhistlerDEM()` produces a deterministic `TerrainData` heightfield representing Whistler Peak's alpine bowl, ridge line, and lower chutes (`width = 400m`, `length = 1200m`, `segmentsX = 64`, `segmentsZ = 192`, elevation range strictly clamped/normalized to `1,520m` to `2,182m`).
   - `buildTerrainMeshFromDEM(terrainData)` creates an indexed low-poly `THREE.BufferGeometry` with flat-shaded normals, elevation/slope-based vertex colors (alpine snow, blue glacier ice on steep pitches, dark granite rock on cliffs), and embeds `terrainMetadata` (`mountainId`, dimensions, elevation bounds, `dropZones`, `obstacles`) in `mesh.userData.terrainMetadata` (serialized into glTF `extras`).
   - `exportTerrainToGLBBuffer(mesh)` uses Three.js `GLTFExporter` (`binary: true`) to produce a standard binary `.glb` (`glTF 2.0`) buffer, and `parseTerrainFromGLBBuffer(buffer)` / `GLTFLoader` loads `.glb` binaries into the scene while enforcing `material.flatShading = true; material.needsUpdate = true` on all loaded `THREE.Mesh` children and restoring `userData.terrainMetadata`.
   - A static asset `public/assets/whistler-peak.glb` is generated and bundled so the browser loads a genuine `.glb` file via `GLTFLoader` at startup (with deterministic in-memory `.glb` export/parse fallback when running inside Node/Vitest).
2. **PS1 Low-Poly Visual Aesthetic:**
   - Flat shading (`flatShading: true`) on terrain, obstacles, and snowboard character meshes, verified on the **post-parse** `.glb` output.
   - Exponential distance fog (`THREE.FogExp2`) and crisp alpine directional sunlight + hemisphere sky lighting.
3. **Bilinear Height & Surface Normal Queries:**
   - `TerrainManager.getHeightAt(x, z)` and `TerrainManager.getNormalAt(x, z)` interpolate the DEM elevation grid in $O(1)$ time for fast physics and camera queries.

## Consequences

- **Positive:**
  - Any future mountain DEM grid can be converted into a `.glb` asset and loaded via the exact same `TerrainData` + `GLTFLoader` pipeline.
  - $O(1)$ heightfield queries avoid expensive per-frame 3D raycasting against thousands of triangles.
- **Negative:**
  - `TerrainData.heights` and the `.glb` mesh vertex positions must share the exact same coordinate mapping (`x` in `[-width/2, +width/2]`, `z` in `[-length/2, +length/2]`).

## Strict Compliance Rules

1. `TerrainManager.initialize()` MUST be idempotent (caching its in-flight `Promise<void>`) and MUST load or hydrate a valid glTF 2.0 binary (`.glb`) with magic header `0x46546C67` (`"glTF"`), setting `terrainData.glbLoaded = true` and recording `glbByteLength > 0` in `window.__OGSNOW_STATE__.terrain`.
2. Drop zone spawn coordinates MUST have both a minimum 25-meter obstacle-free radial clearance AND a clear downhill fall-line corridor (`|x - spawnX| < 18m` for `z` in `[spawnZ, spawnZ + 80m]`) so spawning and initial unsteered descent never cause an immediate collision.
3. All 3D meshes—specifically including the hydrated `THREE.Mesh` children returned by `parseTerrainFromGLBBuffer()`—MUST use low-poly geometry with `material.flatShading === true`, and DEM elevations MUST strictly remain within `[1520, 2182]` meters.
