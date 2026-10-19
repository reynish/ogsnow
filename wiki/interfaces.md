# Module Contracts, Interfaces & File Ownership

This document defines the exact file tree, agent ownership boundaries, TypeScript interfaces, and module signatures for **ogSnow** (`feat/v1-core-game`).

> [!CAUTION]
> **Strict Contract Rule:** Execution Sub-Agents MUST implement the exact exported names, method signatures, and property types specified in this document. Do NOT rename exported classes, methods, or `window.__OGSNOW_STATE__` fields.

---

## 1. Repository File Structure & Agent Ownership Boundaries

To enable conflict-free parallel execution, each file in the repository is assigned to a single Execution Sub-Agent role:

```text
real-life-steep/
├── .gitignore                              # Task T1 (adds .cache/terrain/)
├── package.json                            # Task T1 (adds fetch-terrain script)
├── tsconfig.json                           # (unchanged; scripts/ + src/ already included)
├── vite.config.ts                          # (unchanged; base './')
├── index.html                              # (unchanged)
├── public/
│   └── assets/
│       ├── whistler-peak.glb               # Task T2 (offline generate-glb output, committed)
│       └── terrain/
│           ├── whistler-dem.bin            # Task T1 (fetch-terrain output, committed, Float32 grid)
│           └── whistler-terrain.json       # Task T1 (fetch) → T2 (enriched w/ dropZones+obstacles), committed
├── scripts/
│   ├── generate-glb.ts                     # Task T2 (REWRITTEN: offline, reads .bin+.json, derives, exports)
│   └── fetch-terrain.ts                    # Task T1 (NEW: network one-shot fetch → committed artifacts)
├── src/
│   ├── types.ts                            # Task T1 (EXTENDED: optional provenance fields only)
│   ├── config.ts                           # Task T1 (drop zones re-derived; mountainName/region stay)
│   ├── style.css                           # Task T3 (attribution footer styling)
│   ├── main.ts                             # Task T3 (load .glb+.json+.bin; publish provenance)
│   ├── terrain/
│   │   ├── mountains.ts                    # Task T1 (NEW: mountain registry + types)
│   │   ├── terrainSource.ts                # Task T1 (NEW: Node-only tile fetch/geodesy/resample)
│   │   ├── terrainDerivation.ts            # Task T2 (NEW: seeded drop-zone + obstacle derivation)
│   │   ├── glbPipeline.ts                  # Task T2 (CHANGED: assembler; no synthetic generateWhistlerDEM)
│   │   └── TerrainManager.ts               # Task T3 (CHANGED: load committed .glb+.json+.bin)
│   ├── physics/
│   │   └── PhysicsEngine.ts                # (unchanged — preserves ADR-0006 contracts)
│   ├── player/
│   │   ├── PlayerController.ts             # (unchanged)
│   │   └── SnowboardCharacter.ts           # (unchanged)
│   ├── camera/
│   │   └── FollowCamera.ts                 # (unchanged)
│   ├── audio/
│   │   └── JungleAudioEngine.ts            # (unchanged)
│   └── ui/
│       └── HUDManager.ts                   # Task T3 (CHANGED: attribution element data-testid="terrain-attribution")
├── tests/
│   ├── unit/
│   │   ├── terrain.test.ts                 # Task T4 (REWRITTEN: provenance + real bounds + determinism)
│   │   ├── terrainSource.test.ts           # Task T4 (NEW: geodesy/reproject/decode, no network)
│   │   ├── terrainDerivation.test.ts       # Task T4 (NEW: seeded derivation determinism + clearance)
│   │   ├── physics.test.ts                 # Task T4 (UPDATED: real terrain fixtures, same invariants)
│   │   └── audio.test.ts                   # (unchanged)
│   └── e2e/
│       └── gameplay.spec.ts                # Task T4 (UPDATED: attribution + real altitude assertions)
├── playwright.config.ts                    # (unchanged)
└── .github/
    └── workflows/
        └── ci.yml                          # Task T5 (CHANGED: offline determinism gate over .glb+.json+.bin)
```

### Iteration 2 change matrix (which files are new vs. changed, and owner)

| File | New / Changed | Owner Sub-Agent |
| :--- | :--- | :--- |
| `src/terrain/mountains.ts` | New | T1 |
| `src/terrain/terrainSource.ts` | New | T1 |
| `scripts/fetch-terrain.ts` | New | T1 |
| `.gitignore`, `package.json`, `src/types.ts`, `src/config.ts` | Changed | T1 |
| `public/assets/terrain/whistler-dem.bin` | New (generated, committed) | T1 |
| `public/assets/terrain/whistler-terrain.json` | New (generated, committed) | T1 → T2 |
| `src/terrain/terrainDerivation.ts` | New | T2 |
| `src/terrain/glbPipeline.ts`, `scripts/generate-glb.ts` | Changed | T2 |
| `public/assets/whistler-peak.glb` | Regenerated (committed) | T2 |
| `src/terrain/TerrainManager.ts`, `src/main.ts`, `src/ui/HUDManager.ts`, `src/style.css` | Changed | T3 |
| `tests/unit/terrain.test.ts` | Rewritten | T4 |
| `tests/unit/terrainSource.test.ts`, `tests/unit/terrainDerivation.test.ts` | New | T4 |
| `tests/unit/physics.test.ts`, `tests/e2e/gameplay.spec.ts` | Updated | T4 |
| `.github/workflows/ci.yml` | Changed | T5 |

---

## 2. Canonical Shared Types (`src/types.ts`)

Task 1 MUST create `src/types.ts` with the exact definitions below:

```typescript
export type GameMode = 'menu' | 'riding' | 'paused';

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export interface DropZone {
  id: string;
  name: string;
  elevationMeters: number;
  description: string;
  difficulty: 'Green' | 'Blue' | 'Black' | 'Double Black';
  spawnPosition: Vector3Like;
  initialHeadingRad: number;
}

export interface TerrainObstacle {
  id: string;
  type: 'tree' | 'rock' | 'cliff';
  position: Vector3Like;
  radius: number;
  height: number;
}

export interface TerrainData {
  mountainId: string;
  mountainName: string;
  region: string;
  width: number;          // World X span in meters (1600 across-slope)
  length: number;         // World Z span in meters (3200 down-slope, downhill = +Z)
  segmentsX: number;      // Grid columns (128)
  segmentsZ: number;      // Grid rows (256)
  minElevation: number;   // Real-world base elevation in meters (e.g. < 1600)
  maxElevation: number;   // Real-world peak elevation in meters (e.g. > 2100)
  heights: Float32Array;  // Row-major (segmentsZ + 1) * (segmentsX + 1) elevation values
  obstacles: TerrainObstacle[];
  dropZones: DropZone[];
  glbLoaded: boolean;
  glbFormatVersion: string;
  // ---- Iteration 2 OPTIONAL provenance extensions (ADR-0007) — never required by existing consumers ----
  source?: TerrainSourceMetadata;
  origin?: GeoOrigin;
  realWorld?: boolean;
  attribution?: string[];
  sampledControlPoints?: SampledControlPoint[];
  gridResolutionMeters?: number;
}

export interface PlayerInput {
  steer: number;          // -1.0 (left) to +1.0 (right)
  carve: number;          // 0.0 (none) to 1.0 (hard braking/carving)
  tuck: boolean;          // true when leaning forward for speed (W / ArrowUp)
  jump: boolean;          // true when jump triggered (Space)
  reset: boolean;         // true when reset to drop-zone requested (R)
}

export interface PlayerState {
  position: Vector3Like;
  velocity: Vector3Like;
  speedMs: number;          // Speed in meters/second
  speedKmh: number;         // Speed in km/h (speedMs * 3.6)
  headingRad: number;       // Yaw angle in radians (0 = +Z downhill; steer = +1 decrements headingRad toward world -X / screen right)
  pitchRad: number;         // Slope pitch angle in radians
  rollRad: number;          // Board edge/lean roll angle in radians
  carveAngleRad: number;    // Angle between board heading and velocity vector
  carveIntensity: number;   // Normalized 0.0 to 1.0 carving force
  isGrounded: boolean;
  airtimeSeconds: number;
  isCrashed: boolean;
  crashTimerSeconds: number;
  altitudeMeters: number;   // Real-world equivalent altitude for HUD
  distanceTraveledMeters: number;
  activeDropZoneId: string;
}

export interface AudioState {
  isInitialized: boolean;
  isMuted: boolean;
  bpm: number;              // 170 BPM PS1 Jungle
  padGain: number;          // 0.0 - 1.0 (Atmospheric pads)
  bassGain: number;         // 0.0 - 1.0 (Sub / Reese bassline)
  drumGain: number;         // 0.0 - 1.0 (Amen breakbeat layer)
  windGain: number;         // 0.0 - 1.0 (Velocity wind resistance)
  windFrequencyHz: number;  // Bandpass center frequency for wind
  carveGain: number;        // 0.0 - 1.0 (Snow scrape/carve SFX)
  carveFrequencyHz: number; // Bandpass frequency for snow interaction
  activeStems: string[];    // e.g. ['pad', 'bass', 'drums']
}

export interface CameraState {
  position: Vector3Like;
  lookAt: Vector3Like;
  fov: number;
}

export interface GameConfig {
  mountainName: string;
  region: string;
  gravity: number;
  maxSpeedKmh: number;
  steerRateRadPerSec: number;
  carveDragCoefficient: number;
  airDragCoefficient: number;
  baseSlopeFriction: number;
  jumpImpulse: number;
  crashSpeedThresholdKmh: number;
  crashRecoverySeconds: number;
  audioBpm: number;
  bassFadeInSpeedKmh: number;
  drumsFadeInSpeedKmh: number;
  fullIntensitySpeedKmh: number;
  cameraBaseDistance: number;
  cameraBaseHeight: number;
  cameraBaseFov: number;
  cameraMaxFov: number;
  dropZones: DropZone[];
  attribution?: string[];  // Iteration 2: terrain data attribution (rendered in HUD footer)
}

export interface OGSnowGlobalState {
  mode: GameMode;
  ready?: boolean;
  webglActive?: boolean;
  mountainName: string;
  activeDropZoneId: string;
  frameCount: number;
  elapsedSeconds: number;
  player: PlayerState;
  audio: AudioState;
  camera: CameraState;
  terrain: {
    mountainId: string;
    width: number;
    length: number;
    obstacleCount: number;
    glbLoaded: boolean;
    glbByteLength: number;
    // ---- Iteration 2 OPTIONAL provenance fields (ADR-0007) ----
    realWorld?: boolean;
    source?: string;
    origin?: GeoOrigin;
    attribution?: string[];
    minElevation?: number;
    maxElevation?: number;
    demFormatVersion?: number;
  };
}

declare global {
  interface Window {
    __OGSNOW_STATE__: OGSnowGlobalState;
    __OGSNOW_APP__?: {
      dropIn: (dropZoneId: string) => void;
      returnToMenu: () => void;
      stepSimulation: (dtSeconds: number, overrideInput?: Partial<PlayerInput>) => void;
      setInputOverride: (overrideInput: Partial<PlayerInput> | null) => void;
      triggerCrashForTest: () => void;
      setPaused?: (paused: boolean) => void;
    };
  }
}
```

---

## 2.1 Iteration 2 New Types & Registry (ADR-0007)

These are **additive**; no existing consumer is broken. All are defined in `src/types.ts` except `MountainRegistryEntry` / `MOUNTAIN_REGISTRY` / `getMountainById`, which live in `src/terrain/mountains.ts`.

```typescript
// src/types.ts — Iteration 2 additions

export interface GeoOrigin {
  latitudeDeg: number;       // anchor lat (Whistler 50.0596)
  longitudeDeg: number;      // anchor lon (Whistler -122.9570)
  downhillAzimuthDeg: number;// compass bearing clockwise from North of the fall line (Whistler 180)
}

export interface PinnedTile {
  z: number;
  x: number;
  y: number;
}

export interface SampledControlPoint {
  id: string;                // stable id e.g. 'cp-00'
  row: number;               // grid row (0..segmentsZ)
  col: number;               // grid col (0..segmentsX)
  x: number;                 // game-space X (m)
  z: number;                 // game-space Z (m, downhill +Z)
  latDeg: number;
  lonDeg: number;
  tileZ: number;
  tileX: number;
  tileY: number;
  px: number;                // pixel x within tile
  py: number;                // pixel y within tile
  elevationM: number;        // decoded source elevation
}

export interface TerrainTileRecord {
  z: number;
  x: number;
  y: number;
  url: string;
  sha256: string;            // hex digest of raw PNG bytes
}

export interface TerrainSourceMetadata {
  provider: 'aws-terrarium' | 'copernicus-glo30';
  zoom: number;
  tiles: TerrainTileRecord[];
  minElevationM: number;
  maxElevationM: number;
  fetchedAtUtc?: never;      // FORBIDDEN: must NOT contain timestamps (determinism)
}

export interface TerrainDerivation {
  algorithmVersion: number;  // integer, bumped on behavior change
  seed: number;              // FNV-1a 32-bit hash of mountainId
  treeLineElevationM: number;
  dropZoneCount: number;
  obstacleCount: number;
}

// Shape of the committed public/assets/terrain/<id>-terrain.json manifest
export interface TerrainManifest {
  format: 'ogsnow-terrain';
  demFormatVersion: number;
  mountainId: string;
  mountainName: string;
  region: string;
  origin: GeoOrigin;
  width: number;
  length: number;
  segmentsX: number;
  segmentsZ: number;
  gridResolutionMeters: number;
  minElevation: number;
  maxElevation: number;
  source: TerrainSourceMetadata;
  license: string;
  attribution: string[];
  sampledControlPoints: SampledControlPoint[];
  dropZones?: DropZone[];            // added by generate-glb (Stage B)
  obstacles?: TerrainObstacle[];     // added by generate-glb (Stage B)
  derivation?: TerrainDerivation;    // added by generate-glb (Stage B)
}
```

```typescript
// src/terrain/mountains.ts (pure data; browser + Node safe; MUST NOT import terrainSource)

import { GeoOrigin, PinnedTile } from '../types';

export interface MountainRegistryEntry {
  id: string;                 // 'whistler'
  name: string;               // 'Whistler Mountain'
  region: string;             // 'British Columbia, Canada'
  origin: GeoOrigin;
  extentWidthM: number;       // across-slope → world X
  extentLengthM: number;      // down-slope → world Z
  zoom: number;               // DEM source zoom
  gridSegmentsX: number;      // 128
  gridSegmentsZ: number;      // 256
  treeLineElevationM: number; // 1650
  license: string;
  attribution: string[];
  pinnedTiles: PinnedTile[];
}

export const MOUNTAIN_REGISTRY: Record<string, MountainRegistryEntry>;
export function getMountainById(id: string): MountainRegistryEntry; // throws on unknown id
```

The canonical Whistler entry is documented verbatim in ADR-0007 §3 (origin `50.0596/-122.9570`, azimuth `180`, extent `1600×3200`, zoom `13`, grid `128×256`, tree line `1650`, pinned z13 tiles `(1297,2775)`, `(1298,2775)`, `(1297,2776)`, `(1298,2776)`).



## 3. Canonical Game Configuration (`src/config.ts`)

Task 1 MUST create `src/config.ts` exporting `DEFAULT_GAME_CONFIG: GameConfig`:

```typescript
import { GameConfig } from './types';

export const DEFAULT_GAME_CONFIG: GameConfig = {
  mountainName: 'Whistler Peak — Peak to Creek & Harmony Ridge',
  region: 'British Columbia, Canada',
  gravity: 22.0,
  maxSpeedKmh: 115.0,
  steerRateRadPerSec: 2.2,
  carveDragCoefficient: 0.85,
  airDragCoefficient: 0.012,
  baseSlopeFriction: 0.04,
  jumpImpulse: 7.5,
  crashSpeedThresholdKmh: 28.0,
  crashRecoverySeconds: 1.5,
  audioBpm: 170,
  bassFadeInSpeedKmh: 15.0,
  drumsFadeInSpeedKmh: 30.0,
  fullIntensitySpeedKmh: 60.0,
  cameraBaseDistance: 6.5,
  cameraBaseHeight: 2.6,
  cameraBaseFov: 62,
  cameraMaxFov: 84,
  dropZones: [
    {
      id: 'summit-express',
      name: 'Peak Express Summit (~2,152m)',
      elevationMeters: 2152,
      description: 'Steep alpine bowl dropping directly from the Whistler summit ridge.',
      difficulty: 'Double Black',
      spawnPosition: { x: 0, y: 0, z: -520 },
      initialHeadingRad: 0,
    },
    {
      id: 'harmony-ridge',
      name: 'Harmony Ridge Drop (~2,061m)',
      elevationMeters: 2061,
      description: 'Wide open powder cruisers with natural rollers and tree glades.',
      difficulty: 'Blue',
      spawnPosition: { x: -45, y: 0, z: -260 },
      initialHeadingRad: 0.08,
    },
    {
      id: 'glacier-bowl',
      name: 'Glacier Creek Chute (~1,837m)',
      elevationMeters: 1837,
      description: 'High-speed technical lower mountain run through rock outcrops and pines.',
      difficulty: 'Black',
      spawnPosition: { x: 38, y: 0, z: -40 },
      initialHeadingRad: -0.06,
    },
  ],
};
```

> **Iteration 2 note (ADR-0007):** the `dropZones` above are a **pre-initialize fallback placeholder only**. From `feat/real-terrain-import` onward, `GameApp.init()` replaces `config.dropZones` with manifest-derived `terrain.terrainData.dropZones` loaded from `public/assets/terrain/whistler-terrain.json` (ids `summit-express` / `harmony-ridge` / `glacier-bowl` with real elevations ≈2152 / 2061 / 1837 m), so `data-testid` selectors and E2E assertions remain valid. `GameConfig` gains an optional `attribution?: string[]` field for the terrain attribution footer. Physics/audio/camera constants are unchanged.

---

## 4. Module Interface Contracts

### 4.1 Terrain & GLB Pipeline (`src/terrain/glbPipeline.ts` & `src/terrain/TerrainManager.ts`)

> **Iteration 2 change (ADR-0007):** `generateWhistlerDEM()` (synthetic Hermite spline) is **removed**. `glbPipeline.ts` becomes a pure assembler/build/parse module; the DEM grid now comes from committed artifacts via `assembleTerrainData()`. `buildTerrainMeshFromDEM`, `exportTerrainToGLBBuffer`, and `parseTerrainFromGLBBuffer` retain their exact existing contracts (and all ADR-0002/0006 rules).

**`src/terrain/glbPipeline.ts`:**
- `assembleTerrainData(manifest: TerrainManifest, heights: Float32Array): TerrainData`
  - Builds a `TerrainData` from a committed manifest + raw `Float32` heights. Sets `realWorld = true`, `source`, `origin`, `attribution`, `sampledControlPoints`, `minElevation`/`maxElevation` from the manifest. **Never** synthesizes elevations.
- `buildTerrainMeshFromDEM(data: TerrainData): THREE.Mesh`
  - Constructs a low-poly `THREE.BufferGeometry` with flat-shaded vertex normals and vertex colors (snow whites, icy blues, steep rock grays) + `MeshStandardMaterial` with `flatShading: true`, and embeds `terrainMetadata` (`mountainId`, `mountainName`, `region`, `width`, `length`, `segmentsX`, `segmentsZ`, `minElevation`, `maxElevation`, `dropZones`, `obstacles`) in `mesh.userData.terrainMetadata`.
- `exportTerrainToGLBBuffer(mesh: THREE.Object3D): Promise<ArrayBuffer>`
  - Uses Three.js `GLTFExporter` (`binary: true`) to serialize the 3D terrain mesh into a valid glTF 2.0 `.glb` binary `ArrayBuffer` (verifying magic header `0x46546C67` / `"glTF"`). Deterministic for identical input (no timestamps).
- `parseTerrainFromGLBBuffer(buffer: ArrayBuffer): Promise<THREE.Group>`
  - Uses Three.js `GLTFLoader.parse` to hydrate a `.glb` binary buffer back into a renderable `THREE.Group`, enforcing `material.flatShading = true` and `material.needsUpdate = true` on every loaded `THREE.Mesh` child and preserving `userData.terrainMetadata`.

**`src/terrain/TerrainManager.ts`:**
```typescript
import * as THREE from 'three';
import { TerrainData, TerrainObstacle, Vector3Like } from '../types';

export interface TerrainArtifacts {
  glbUrl: string;      // default './assets/whistler-peak.glb'
  manifestUrl: string; // default './assets/terrain/whistler-terrain.json'
  demBinUrl: string;   // default './assets/terrain/whistler-dem.bin'
}

export class TerrainManager {
  public readonly terrainData: TerrainData;
  public readonly rootGroup: THREE.Group;
  public glbByteLength: number;

  constructor(customData?: TerrainData);
  public initialize(artifacts?: Partial<TerrainArtifacts>): Promise<void>;
  public getHeightAt(x: number, z: number): number;
  public getNormalAt(x: number, z: number): Vector3Like;
  public getSlopePitchAt(x: number, z: number, headingRad: number): number;
  public checkObstacleCollision(position: Vector3Like, radius?: number): TerrainObstacle | null;
}
```
- `initialize(artifacts?)` MUST be idempotent (caching its in-flight `Promise<void>`) so concurrent calls never duplicate `terrain_mesh_group` or `terrain_obstacles` inside `rootGroup`.
- `initialize()` MUST load three committed bundled assets via relative `fetch` (`.glb` for render mesh, `.json` manifest for dropZones/obstacles/provenance, `.bin` for the physics `Float32` heights grid), reconstruct `terrainData` via `assembleTerrainData`, and populate `rootGroup`. It MUST **never** perform a network request outside the bundled origin and MUST **never** synthesize a heightfield. If a committed asset is missing/invalid, it MUST throw (no silent synthetic fallback).

### 4.1.1 Mountain Registry (`src/terrain/mountains.ts`)

Pure-data module (browser + Node safe; MUST NOT import `terrainSource.ts`). Exports `MOUNTAIN_REGISTRY: Record<string, MountainRegistryEntry>` and `getMountainById(id: string): MountainRegistryEntry` (throws on unknown id). The Whistler entry is pinned in ADR-0007 §3.

### 4.1.2 Terrain Source (`src/terrain/terrainSource.ts` — Node-only)

> **Hard rule:** this module imports `node:` built-ins (`node:https`, `node:zlib`, `node:fs`, `node:crypto`) and MUST NOT be imported by any browser-bundled module. Only `scripts/fetch-terrain.ts` imports it.

```typescript
export function terrariumTileUrl(z: number, x: number, y: number): string;
export function lonLatToWebMercatorPixels(lonDeg: number, latDeg: number, zoom: number): { px: number; py: number; tx: number; ty: number };
export function webMercatorPixelsToLonLat(px: number, py: number, zoom: number): { lonDeg: number; latDeg: number };
export function decodeTerrariumPng(buf: Buffer): Float32Array; // R*256 + G + B/256 - 32768 per pixel, row-major 256*256
export function metersPerDegLat(): number;                       // 111320
  // metersPerDegLon(latDeg): 111320 * cos(latDeg*pi/180)
export function enuToGame(eastM: number, northM: number, azimuthDeg: number): { x: number; z: number };
export function gameToEnu(x: number, z: number, azimuthDeg: number): { eastM: number; northM: number };
export function resampleToGrid(
  entry: MountainRegistryEntry,
  getElevation: (lonDeg: number, latDeg: number) => number
): { heights: Float32Array; minElevation: number; maxElevation: number; controlPoints: SampledControlPoint[] };
export function sha256Hex(buf: Buffer): string;
export function buildSourceMetadata(entry: MountainRegistryEntry, tiles: TerrainTileRecord[], min: number, max: number): TerrainSourceMetadata;
```
- `enuToGame`/`gameToEnu` MUST implement the geodetic rotation with Three.js screen-space parity (M2: `x_game = -east·cosθ + north·sinθ`; `z_game = east·sinθ + north·cosθ` and inverse), so downhill azimuth `θ` maps to game `+Z` and real-world West maps to screen-right (`-X`).
- `resampleToGrid` MUST produce a `(gridSegmentsZ+1)×(gridSegmentsX+1)` `Float32` row-major grid over `x ∈ [−W/2,+W/2]`, `z ∈ [−L/2,+L/2]`, sampling the nearest/bilinear Terrarium pixel per grid node, and record ≥16 evenly spaced `SampledControlPoint`s.

### 4.1.3 Deterministic Derivation (`src/terrain/terrainDerivation.ts` — browser + Node safe)

```typescript
import { TerrainManifest, DropZone, TerrainObstacle, TerrainData } from '../types';

export type OsmRefineHook = (
  obstacles: TerrainObstacle[],
  manifest: TerrainManifest,
  heights: Float32Array,
) => TerrainObstacle[];

export function deriveDropZones(
  manifest: TerrainManifest,
  heights: Float32Array,
): DropZone[];

export function deriveObstacles(
  manifest: TerrainManifest,
  heights: Float32Array,
  dropZones: DropZone[],
  seed: number,
  osmRefine?: OsmRefineHook,
): TerrainObstacle[];

export function deriveTerrain(
  manifest: TerrainManifest,
  heights: Float32Array,
  osmRefine?: OsmRefineHook,
): TerrainData;
```
- `deriveDropZones` scans the grid for **sustained steep fall lines** (contiguous downhill cells above a min pitch for a min run length), picks `count` candidates with ≥`minSpacingM` lateral separation, and guarantees ≥`spawnClearanceM` (25 m) obstacle-free radial clearance + an 80 m downhill corridor below each spawn (ADR-0002 Rule 2).
- **Stable drop-zone id contract (retained from Iteration 1):** for Whistler, `deriveDropZones` MUST emit exactly 3 drop zones with the **unchanged** ids `summit-express` (highest elevation), `harmony-ridge` (middle), `glacier-bowl` (lowest), preserving the existing `[data-testid="drop-zone-btn-*"]` selectors and E2E assertions. Only their positions/elevations (and optional display names) are re-derived from the real DEM.
- `deriveObstacles` places `tree` obstacles below `treeLineElevationM` on low-slope/low-curvature cells, `rock`/`cliff` on steep/high-curvature cells, using the seeded PRNG; the optional `osmRefine` hook (unused by the committed Whistler artifact) may add/remove features when OSM data is available.
- All derivation MUST be deterministic: use a seeded PRNG (`seed` from FNV-1a of `mountainId`), fixed iteration order, stable ids (`<type>_<index>`), and no `Math.random()`/`Date.now()`.

### 4.1.4 Build scripts (`scripts/fetch-terrain.ts`, `scripts/generate-glb.ts`)

**`scripts/fetch-terrain.ts` (Node, network — `npm run fetch-terrain -- --mountain whistler`):**
1. Parse `--mountain <id>`; resolve `getMountainById(id)`.
2. For each `pinnedTiles` tile: download to `.cache/terrain/<z>/<x>/<y>.png` (cache hit skips download), verify HTTP 200 + PNG magic; record SHA-256. **Fail loudly** (exit 1) on any non-200/undecodable/missing-coverage tile — never synthesize.
3. Decode each tile (`decodeTerrariumPng`), build a `getElevation(lon,lat)` closure, run `resampleToGrid`.
4. Write `public/assets/terrain/<id>-dem.bin` (raw little-endian `Float32`, row-major) and `public/assets/terrain/<id>-terrain.json` (stable serializer; provenance manifest with `sampledControlPoints`, per-tile checksums, `source`, `origin`, `attribution`, real `minElevation`/`maxElevation`, `demFormatVersion`; NO timestamps).

**`scripts/generate-glb.ts` (Node, offline — `npm run generate-glb`):**
1. Read committed `public/assets/terrain/whistler-dem.bin` + `whistler-terrain.json`; validate schema, grid dims, and tile checksums. **Exit 1** if missing/invalid (never synthesize).
2. `assembleTerrainData(manifest, heights)` → run `deriveTerrain` (seeded) → update `dropZones`/`obstacles` → `buildTerrainMeshFromDEM` → `exportTerrainToGLBBuffer` → write `public/assets/whistler-peak.glb`.
3. Enrich and rewrite `whistler-terrain.json` with `dropZones`, `obstacles`, and `derivation` (stable ordering, no timestamps).
4. Exit 0. Two consecutive runs MUST produce byte-identical `.glb` + `.json`.

---

### 4.2 Physics Engine (`src/physics/PhysicsEngine.ts`)

```typescript
import { GameConfig, PlayerInput, PlayerState, DropZone } from '../types';
import { TerrainManager } from '../terrain/TerrainManager';

export class PhysicsEngine {
  public readonly config: GameConfig;
  public readonly terrain: TerrainManager;

  constructor(terrain: TerrainManager, config?: GameConfig);
  public resetAtDropZone(dropZone: DropZone): PlayerState;
  public step(dtSeconds: number, input: PlayerInput): PlayerState;
  public getState(): PlayerState;
  public forceCrash(): void;
}
```
**Key Physics Behavior Requirements (per ADR-0003 & ADR-0006):**
1. Uses `cannon-es` (`CANNON.World`, `CANNON.Body`, `CANNON.Sphere`) coupled with `TerrainManager.getHeightAt(x, z)` and `getNormalAt(x, z)` for rock-solid high-speed continuous terrain contact without tunneling, with fixed sub-stepping (`<= 1/60s`) and `Number.isFinite(dtSeconds)` guards.
2. Downhill acceleration is along `+Z` (from `-Z` summit to `+Z` base) proportional to `config.gravity * sin(slopePitch)` along the downhill tangent vector. `headingRad = 0` points straight downhill along `+Z` with forward vector `(sin(headingRad), cos(headingRad))`.
3. Steering (`input.steer`): Because `FollowCamera` sits behind the player looking toward `+Z` with world up `+Y`, camera right in Three.js right-handed coordinates is world `-X`. Therefore `steer = +1` (`ArrowRight`/`KeyD`) MUST decrement `headingRad` (`headingRad -= input.steer * config.steerRateRadPerSec * dt`) to turn toward world `-X` (screen right, `NDC x > 0`), and `rollRad` leans into the turn (`rollRad = -input.steer * 0.35`).
4. Carving (`input.carve` or sharp steering angular delta) increases `carveAngleRad` and `carveIntensity`, applying lateral edge grip and linear speed deceleration (`carveDragCoefficient * carveIntensity * speedMs`).
5. Tucking (`input.tuck`) reduces aerodynamic drag and increases downhill acceleration.
6. Jumping (`input.jump` while `isGrounded === true` and `!isCrashed`) is **edge-triggered** (rising edge only) and imparts upward vertical velocity (`config.jumpImpulse`), transitioning `isGrounded` to `false` and accumulating `airtimeSeconds`.
7. Obstacle collision (`terrain.checkObstacleCollision(position, 1.1)`):
   - Always pushes the rider radially outside `obs.radius + 1.1`.
   - Below `config.crashSpeedThresholdKmh` (`28 km/h`), deflects velocity along the contact normal without triggering a wipeout (`isCrashed` remains `false`).
   - At or above `config.crashSpeedThresholdKmh` (`28 km/h`), triggers `isCrashed = true`, reduces speed by 85%, sets `crashTimerSeconds = config.crashRecoverySeconds`, halts slope gravity acceleration during recovery, and applies crash friction until the timer expires.
8. Out-of-bounds clamping keeps `x` within `[-width/2 + 8, width/2 - 8]` (nudging `headingRad` inward to prevent wall grinding) and cleanly wraps/resets to the active drop zone when reaching the bottom boundary (`z >= length/2 - 15`).

---

### 4.3 Player Controller, Character & Follow Camera (`src/player/*`, `src/camera/*`)

**`src/player/PlayerController.ts`:**
```typescript
import { PlayerInput } from '../types';

export class PlayerController {
  constructor(targetElement?: Window | HTMLElement);
  public getInput(): PlayerInput;
  public setOverride(override: Partial<PlayerInput> | null): void;
  public clearResetFlag(): void;
  public dispose(): void;
}
```
- Maps `KeyA` / `ArrowLeft` (`steer = -1`), `KeyD` / `ArrowRight` (`steer = +1`), `KeyS` / `ArrowDown` (`carve = 1.0`), `KeyW` / `ArrowUp` (`tuck = true`), `Space` (`jump = true`), `KeyR` (`reset = true`), calling `e.preventDefault()` on game control keys so `Space` or arrow keys never scroll or activate focused DOM buttons.

**`src/player/SnowboardCharacter.ts`:**
```typescript
import * as THREE from 'three';
import { PlayerState } from '../types';

export class SnowboardCharacter {
  public readonly group: THREE.Group;
  public readonly boardMesh: THREE.Mesh;
  public readonly riderGroup: THREE.Group;

  constructor();
  public update(state: PlayerState, dtSeconds: number): void;
}
```
- Builds a nostalgic PS1-era low-poly snowboarder (board, boots, baggy snow pants, retro jacket, torso, head with goggles/beanie, arms) plus a dynamic snow-spray particle effect when carving on snow.

**`src/camera/FollowCamera.ts`:**
```typescript
import * as THREE from 'three';
import { CameraState, GameConfig, PlayerState } from '../types';
import { TerrainManager } from '../terrain/TerrainManager';

export class FollowCamera {
  public readonly camera: THREE.PerspectiveCamera;

  constructor(aspect: number, config?: GameConfig, terrain?: TerrainManager);
  public update(playerState: PlayerState, dtSeconds: number): CameraState;
  public snap(playerState: PlayerState): CameraState;
  public resize(aspect: number): void;
  public getState(): CameraState;
}
```

---

### 4.4 Adaptive PS1 Jungle Audio Engine (`src/audio/JungleAudioEngine.ts`)

```typescript
import { AudioState, GameConfig, PlayerState } from '../types';

export class JungleAudioEngine {
  constructor(config?: GameConfig, audioContextOverride?: BaseAudioContext);
  public init(): Promise<void>;
  public update(playerState: PlayerState, dtSeconds: number): AudioState;
  public setMuted(muted: boolean): void;
  public getState(): AudioState;
  public dispose(): void;
}
```
- **Deterministic State Calculation:** Even if browser autoplay blocks `AudioContext` or in headless unit tests without hardware audio output, `update(playerState, dtSeconds)` MUST deterministically compute and update `AudioState` (`padGain`, `bassGain`, `drumGain`, `windGain`, `windFrequencyHz`, `carveGain`, `carveFrequencyHz`, `activeStems`) so both unit tests and Playwright E2E tests can verify adaptive audio behavior at all speeds and crash states.
- **Web Audio Synthesis (when `AudioContext` is available):**
  - 170 BPM step sequencer triggering classic Amen-style breakbeat slices (kick, pitch-shifted snare, rapid chopped hi-hats/ghost snares), warm detuned minor-9th atmospheric pad chords, deep Reese/sub-bass, white-noise bandpass wind generator, and granular snow-carve filter.

---

### 4.5 UI & HUD Manager (`src/ui/HUDManager.ts`)

```typescript
import { AudioState, DropZone, GameConfig, GameMode, PlayerState } from '../types';

export interface HUDCallbacks {
  onSelectDropZone: (dropZoneId: string) => void;
  onReturnToMenu: () => void;
  onToggleMute: () => void;
}

export class HUDManager {
  constructor(container: HTMLElement, config: GameConfig, callbacks: HUDCallbacks);
  public setMode(mode: GameMode, activeDropZoneId?: string): void;
  public update(player: PlayerState, audio: AudioState): void;
}
```
- **Required DOM Selectors for E2E Verification:**
  - `#main-menu`: Visible when `mode === 'menu'`, hidden when `mode === 'riding'`.
  - `[data-testid="drop-zone-btn-summit-express"]`, `[data-testid="drop-zone-btn-harmony-ridge"]`, `[data-testid="drop-zone-btn-glacier-bowl"]`: Clickable drop zone buttons.
  - `#hud-overlay`: Visible when `mode === 'riding'`.
  - `[data-testid="hud-speed"]`: Displays integer speed in `km/h`.
  - `[data-testid="hud-altitude"]`: Displays current altitude in meters (`m`).
  - `[data-testid="hud-stems"]`: Displays active audio stems (`PAD`, `BASS`, `AMEN BREAKS`).
  - `[data-testid="btn-return-menu"]`: Button to return to the mountain/drop-zone menu.
  - `[data-testid="btn-mute-audio"]`: Button to mute/unmute audio.

### 4.6 Attribution Surface & Provenance Witness (ADR-0007)

- **Main-menu attribution element:** `HUDManager.render()` MUST create a visible element with `data-testid="terrain-attribution"` (in `#main-menu`, e.g. the menu footer) whose text content is the joined attribution strings from `config.attribution` (fallback: `"Elevation: AWS Open Data Terrain Tiles (Terrarium)"`). It MUST be populated via `textContent` (never `innerHTML`) using safe DOM creation.
- **Telemetry witness:** `window.__OGSNOW_STATE__.terrain` MUST include the optional provenance fields `realWorld` (`true`), `source` (`'aws-terrarium'`), `origin` (`GeoOrigin`), `attribution` (string[]), `minElevation`, `maxElevation`, and `demFormatVersion` (ADR-0007 Rule 7).
- **HUD altitude grounding:** `[data-testid="hud-altitude"]` MUST reflect the imported real-world elevation (`player.altitudeMeters`), which derives from the DEM grid (not a synthetic clamp).
