# ADR-0002: 3D Rendering and Standardized GLB Terrain Pipeline

- **Status:** Accepted
- **Date:** 2026-10-18
- **Iteration:** `feat/v1-core-game`

## Context

The PRD requires a single flagship real-world mountain (*Whistler Peak, BC — Peak Express / Harmony Ridge*) imported using a repeatable standard: generating 3D meshes from DEM/Heightmap elevation data and exporting/loading them as `.glTF` / `.glb` files. It also requires PS1-era nostalgic low-poly aesthetics, natural obstacles (trees, rocks, cliffs), and multiple drop zones.

## Decision

1. **Standardized DEM-to-GLB Pipeline (`src/terrain/glbPipeline.ts`):**
   - `generateWhistlerDEM()` produces a deterministic `TerrainData` heightfield representing Whistler Peak's alpine bowl, ridge line, and lower chutes (`width = 400m`, `length = 1200m`, `segmentsX = 64`, `segmentsZ = 192`, elevation range `1,520m` to `2,182m`).
   - `buildTerrainMeshFromDEM(terrainData)` creates an indexed low-poly `THREE.BufferGeometry` with flat-shaded normals and elevation/slope-based vertex colors (alpine snow, blue glacier ice on steep pitches, dark granite rock on cliffs).
   - `exportTerrainToGLBBuffer(mesh)` uses Three.js `GLTFExporter` (`binary: true`) to produce a standard binary `.glb` (`glTF 2.0`) buffer, and `parseTerrainFromGLBBuffer(buffer)` / `GLTFLoader` loads `.glb` binaries into the scene.
   - A static asset `public/assets/whistler-peak.glb` is generated and bundled so the browser loads a genuine `.glb` file via `GLTFLoader` at startup (with deterministic in-memory `.glb` export/parse fallback when running inside Node/Vitest).
2. **PS1 Low-Poly Visual Aesthetic:**
   - Flat shading (`flatShading: true`) on terrain, obstacles, and snowboard character meshes.
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

1. `TerrainManager.initialize()` MUST load or hydrate a valid glTF 2.0 binary (`.glb`) with magic header `0x46546C67` (`"glTF"`), setting `terrainData.glbLoaded = true` and recording `glbByteLength > 0` in `window.__OGSNOW_STATE__.terrain`.
2. Drop zone spawn coordinates MUST have a minimum 25-meter obstacle-free radius so spawning never causes an immediate collision.
3. All 3D meshes MUST use low-poly geometry with `flatShading: true`.
