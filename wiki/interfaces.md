# Module Contracts, Interfaces & File Ownership

This document defines the exact file tree, agent ownership boundaries, TypeScript interfaces, and module signatures for **ogSnow** (`feat/v1-core-game`).

> [!CAUTION]
> **Strict Contract Rule:** Execution Sub-Agents MUST implement the exact exported names, method signatures, and property types specified in this document. Do NOT rename exported classes, methods, or `window.__OGSNOW_STATE__` fields.

---

## 1. Repository File Structure & Agent Ownership Boundaries

To enable conflict-free parallel execution, each file in the repository is assigned to a single Execution Sub-Agent role:

```text
real-life-steep/
├── .gitignore                              # Task 1 (Scaffolding & Terrain Agent)
├── package.json                            # Task 1 (Scaffolding & Terrain Agent)
├── tsconfig.json                           # Task 1 (Scaffolding & Terrain Agent)
├── vite.config.ts                          # Task 1 (Scaffolding & Terrain Agent)
├── index.html                              # Task 3 (Audio, UI & Game Loop Agent)
├── public/
│   └── assets/
│       └── whistler-peak.glb               # Task 1 (Generated via scripts/generate-glb.ts)
├── scripts/
│   └── generate-glb.ts                     # Task 1 (Build-time GLB terrain generator)
├── src/
│   ├── types.ts                            # Task 1 (Canonical shared interfaces)
│   ├── config.ts                           # Task 1 (Canonical game & mountain config)
│   ├── style.css                           # Task 3 (Retro PS1 UI & HUD styling)
│   ├── main.ts                             # Task 3 (GameApp coordinator & E2E hook)
│   ├── terrain/
│   │   ├── glbPipeline.ts                  # Task 1 (DEM heightmap + GLB export/import)
│   │   └── TerrainManager.ts               # Task 1 (Mesh, obstacles, height/normal queries)
│   ├── physics/
│   │   └── PhysicsEngine.ts                # Task 2 (cannon-es + slope/carve/collision solver)
│   ├── player/
│   │   ├── PlayerController.ts             # Task 2 (Keyboard/gamepad/programmatic input)
│   │   └── SnowboardCharacter.ts           # Task 2 (Low-poly 3D snowboarder & board mesh)
│   ├── camera/
│   │   └── FollowCamera.ts                 # Task 2 (Speed & pitch reactive 3rd-person camera)
│   ├── audio/
│   │   └── JungleAudioEngine.ts            # Task 3 (Web Audio 170 BPM PS1 Jungle & SFX)
│   └── ui/
│       └── HUDManager.ts                   # Task 3 (Main menu, drop-zone selector, HUD)
├── tests/
│   ├── unit/
│   │   ├── terrain.test.ts                 # Task 4 (Testing & E2E Agent)
│   │   ├── physics.test.ts                 # Task 4 (Testing & E2E Agent)
│   │   └── audio.test.ts                   # Task 4 (Testing & E2E Agent)
│   └── e2e/
│       └── gameplay.spec.ts                # Task 4 (Playwright E2E browser verification)
├── playwright.config.ts                    # Task 4 (Playwright configuration)
└── .github/
    └── workflows/
        └── ci.yml                          # Task 5 (GitHub Actions CI/CD Agent)
```

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
  width: number;          // World X span in meters (e.g. 400)
  length: number;         // World Z span in meters (e.g. 1200)
  segmentsX: number;      // Grid columns (e.g. 64)
  segmentsZ: number;      // Grid rows (e.g. 192)
  minElevation: number;   // Base elevation in meters
  maxElevation: number;   // Peak elevation in meters
  heights: Float32Array;  // Row-major (segmentsZ + 1) * (segmentsX + 1) elevation values
  obstacles: TerrainObstacle[];
  dropZones: DropZone[];
  glbLoaded: boolean;
  glbFormatVersion: string;
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
  headingRad: number;       // Yaw angle in radians (0 = -Z downhill)
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
}

export interface OGSnowGlobalState {
  mode: GameMode;
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
    };
  }
}
```

---

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
      name: 'Peak Express Summit (2,182m)',
      elevationMeters: 2182,
      description: 'Steep alpine bowl dropping directly from the Whistler summit ridge.',
      difficulty: 'Double Black',
      spawnPosition: { x: 0, y: 0, z: -520 },
      initialHeadingRad: 0,
    },
    {
      id: 'harmony-ridge',
      name: 'Harmony Ridge Drop (1,940m)',
      elevationMeters: 1940,
      description: 'Wide open powder cruisers with natural rollers and tree glades.',
      difficulty: 'Blue',
      spawnPosition: { x: -45, y: 0, z: -260 },
      initialHeadingRad: 0.08,
    },
    {
      id: 'glacier-bowl',
      name: 'Glacier Creek Chute (1,780m)',
      elevationMeters: 1780,
      description: 'High-speed technical lower mountain run through rock outcrops and pines.',
      difficulty: 'Black',
      spawnPosition: { x: 38, y: 0, z: -40 },
      initialHeadingRad: -0.06,
    },
  ],
};
```

---

## 4. Module Interface Contracts

### 4.1 Terrain & GLB Pipeline (`src/terrain/glbPipeline.ts` & `src/terrain/TerrainManager.ts`)

**`src/terrain/glbPipeline.ts`:**
- `generateWhistlerDEM(width?: number, length?: number, segmentsX?: number, segmentsZ?: number): TerrainData`
  - Deterministically synthesizes the Whistler Peak DEM elevation matrix (`Float32Array`), drop zones, and obstacle placements (trees, rocks, cliffs) with an average downhill slope from `-Z` (summit, higher Y) to `+Z` (base, lower Y), natural alpine bowls, ridges, and rollers. Ensures a clear navigable central corridor around each drop zone spawn point so players do not immediately collide on spawn.
- `buildTerrainMeshFromDEM(data: TerrainData): THREE.Mesh`
  - Constructs a low-poly `THREE.BufferGeometry` with flat-shaded vertex normals and vertex colors (snow whites, icy blues, steep rock grays) + `MeshLambertMaterial` or `MeshStandardMaterial` with `flatShading: true`.
- `exportTerrainToGLBBuffer(mesh: THREE.Object3D): Promise<ArrayBuffer>`
  - Uses Three.js `GLTFExporter` (`binary: true`) to serialize the 3D terrain mesh into a valid glTF 2.0 `.glb` binary `ArrayBuffer` ( verifying magic header `0x46546C67` / `"glTF"`).
- `parseTerrainFromGLBBuffer(buffer: ArrayBuffer): Promise<THREE.Group>`
  - Uses Three.js `GLTFLoader.parse` to hydrate a `.glb` binary buffer back into a renderable `THREE.Group`.

**`src/terrain/TerrainManager.ts`:**
```typescript
import * as THREE from 'three';
import { TerrainData, TerrainObstacle, Vector3Like } from '../types';

export class TerrainManager {
  public readonly terrainData: TerrainData;
  public readonly rootGroup: THREE.Group;
  public glbByteLength: number;

  constructor(customData?: TerrainData);
  public initialize(glbUrl?: string): Promise<void>;
  public getHeightAt(x: number, z: number): number;
  public getNormalAt(x: number, z: number): Vector3Like;
  public getSlopePitchAt(x: number, z: number, headingRad: number): number;
  public checkObstacleCollision(position: Vector3Like, radius?: number): TerrainObstacle | null;
}
```

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
**Key Physics Behavior Requirements:**
1. Uses `cannon-es` (`CANNON.World`, `CANNON.Body`, `CANNON.Sphere`) coupled with `TerrainManager.getHeightAt(x, z)` and `getNormalAt(x, z)` for rock-solid high-speed continuous terrain contact without tunneling.
2. Downhill acceleration is proportional to `config.gravity * sin(slopePitch)` along the downhill tangent vector.
3. Steering (`input.steer`) rotates `headingRad` and tilts `rollRad`.
4. Carving (`input.carve` or sharp steering angular delta) increases `carveAngleRad` and `carveIntensity`, applying lateral edge grip and speed deceleration (`carveDragCoefficient`).
5. Tucking (`input.tuck`) reduces aerodynamic drag and increases downhill acceleration.
6. Jumping (`input.jump` while `isGrounded === true`) imparts upward vertical velocity (`config.jumpImpulse`), transitioning `isGrounded` to `false` and accumulating `airtimeSeconds`.
7. Obstacle collision (`terrain.checkObstacleCollision`) triggers `isCrashed = true`, zeroes or sharply reduces forward momentum, sets `crashTimerSeconds = config.crashRecoverySeconds`, and auto-recovers when the timer expires.
8. Out-of-bounds clamping keeps `x` within `[-width/2 + 8, width/2 - 8]` and wraps or resets cleanly if reaching the bottom boundary (`z > length/2 - 10`).

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
- Maps `KeyA` / `ArrowLeft` (`steer = -1`), `KeyD` / `ArrowRight` (`steer = +1`), `KeyS` / `ArrowDown` (`carve = 1.0`), `KeyW` / `ArrowUp` (`tuck = true`), `Space` (`jump = true`), `KeyR` (`reset = true`).

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
