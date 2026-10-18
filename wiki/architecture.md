# System Architecture (C4 Model)

This document defines the system architecture of **ogSnow** using the **C4 Model** (System Context, Containers, Components, and Code/Sequence Flows).

---

## 1. System Context (C1)

At the highest level, **ogSnow** is a self-contained browser-based 3D snowboarding simulation accessed by players and automated verification suites, built and deployed via GitHub Actions.

```mermaid
flowchart TD
    Player["Player (Desktop Browser User)"]
    E2ERunner["Playwright E2E Runner (Headless Chromium)"]
    OGSnow["ogSnow Web Application (3D Snowboarding Game)"]
    GISData["Real-World DEM / GLB Mountain Data (Whistler Peak)"]
    CICD["GitHub Actions CI/CD Pipeline"]

    Player -->|"Keyboard / Controller Inputs (Steer, Carve, Tuck, Jump, Drop-In)"| OGSnow
    OGSnow -->|"3D Low-Poly WebGL Visuals & Adaptive PS1 Jungle Audio"| Player
    GISData -->|"Standardized Heightfield & .glb Terrain Mesh"| OGSnow
    E2ERunner -->|"Simulates Inputs & Inspects window.__OGSNOW_STATE__"| OGSnow
    CICD -->|"Builds, Unit Tests (Vitest), & Runs E2E Suite"| OGSnow
```

---

## 2. Container Architecture (C2)

Inside the browser runtime, **ogSnow** executes within a single-page TypeScript/Vite application divided into five primary runtime containers plus a build-time/runtime `.glb` terrain asset pipeline.

```mermaid
flowchart LR
    subgraph Browser["Web Browser Runtime (Desktop)"]
        UIContainer["UI & HUD Layer (DOM / CSS Overlay)"]
        GameCore["Game Coordinator & State Store (main.ts)"]
        RenderEngine["3D WebGL Renderer (Three.js Scene, Camera, GLTF)"]
        PhysicsWorld["Physics & Slope Solver (cannon-es + DEM Heightfield)"]
        AudioEngine["Adaptive Audio Engine (Web Audio API / Procedural Jungle)"]
        E2EHook["Telemetry Bridge (window.__OGSNOW_STATE__)"]
    end

    subgraph Assets["Static Assets & DEM Pipeline"]
        GLBAsset["Flagship Mountain Asset (whistler-peak.glb + DEM Grid)"]
    end

    UIContainer -->|"Selects Mountain & DropZone / Reads Telemetry"| GameCore
    GameCore -->|"Steps Simulation (dt) & Reads PlayerInput"| PhysicsWorld
    GLBAsset -->|"Loads .glb Mesh & Elevation Matrix"| RenderEngine
    GLBAsset -->|"Provides Height / Normal Queries"| PhysicsWorld
    PhysicsWorld -->|"Updates PlayerState (Position, Velocity, Pitch, Grounded)"| GameCore
    GameCore -->|"Syncs Character, Obstacles & FollowCamera"| RenderEngine
    GameCore -->|"Modulates Stems & SFX by Speed / Carve / Crash"| AudioEngine
    GameCore -->|"Publishes Live Snapshot"| E2EHook
```

---

## 3. Component Architecture (C3)

Each container is decomposed into strictly typed ES modules with single responsibilities and zero circular dependencies.

```mermaid
flowchart TD
    subgraph Entry["Entry & Orchestration"]
        Main["GameApp (src/main.ts)"]
        Config["GameConfig (src/config.ts)"]
        Types["Data Contracts (src/types.ts)"]
    end

    subgraph TerrainPkg["Terrain & GLB Pipeline (src/terrain/)"]
        DEMGen["WhistlerDEM & GLBPipeline (src/terrain/glbPipeline.ts)"]
        TerrainMgr["TerrainManager (src/terrain/TerrainManager.ts)"]
    end

    subgraph PhysicsPlayerPkg["Physics, Character & Camera (src/physics/, src/player/, src/camera/)"]
        PhysEng["PhysicsEngine (src/physics/PhysicsEngine.ts)"]
        InputCtrl["InputController (src/player/PlayerController.ts)"]
        CharMesh["SnowboardCharacter (src/player/SnowboardCharacter.ts)"]
        CamCtrl["FollowCamera (src/camera/FollowCamera.ts)"]
    end

    subgraph AudioUIPkg["Adaptive Audio & UI (src/audio/, src/ui/)"]
        JungleAudio["JungleAudioEngine (src/audio/JungleAudioEngine.ts)"]
        HUDMgr["HUDManager (src/ui/HUDManager.ts)"]
    end

    Main --> Config
    Main --> Types
    Main --> TerrainMgr
    Main --> PhysEng
    Main --> InputCtrl
    Main --> CharMesh
    Main --> CamCtrl
    Main --> JungleAudio
    Main --> HUDMgr

    TerrainMgr --> DEMGen
    PhysEng --> TerrainMgr
    CamCtrl --> TerrainMgr
```

### Component Responsibilities

| Component | File Path | Responsibility |
| :--- | :--- | :--- |
| `Types` | `src/types.ts` | Canonical TypeScript interfaces (`PlayerState`, `TerrainData`, `DropZone`, `AudioState`, `GameConfig`, `OGSnowGlobalState`). |
| `Config` | `src/config.ts` | Default physics constants, Whistler Peak metadata, 3 drop zones, audio BPM/thresholds, camera parameters. |
| `GLBPipeline` | `src/terrain/glbPipeline.ts` | Generates deterministic Whistler Peak DEM heightmap data, builds low-poly vertex-colored Three.js geometry, exports/loads `.glb` binary buffers (`GLTFExporter` / `GLTFLoader`). |
| `TerrainManager` | `src/terrain/TerrainManager.ts` | Manages the 3D mountain mesh, natural obstacles (trees, rocks, cliffs), bilinear height/normal queries `getHeightAt(x, z)` and `getNormalAt(x, z)`. |
| `PhysicsEngine` | `src/physics/PhysicsEngine.ts` | `cannon-es` world + slope-aligned snowboard dynamics: gravity projection along slope normal, carving deceleration, edge grip, obstacle/boundary collisions, crash recovery, and airtime detection. |
| `InputController` | `src/player/PlayerController.ts` | Captures keyboard (`WASD` / Arrow keys / `Space` / `R`) and Gamepad inputs, plus programmatic input injection for E2E testing. |
| `SnowboardCharacter` | `src/player/SnowboardCharacter.ts` | Low-poly PS1-style 3D snowboarder + board mesh hierarchy with procedural lean, carve tilt, pitch alignment, and snow spray particles. |
| `FollowCamera` | `src/camera/FollowCamera.ts` | Third-person dynamic chase camera that interpolates position, look-at target, pitch tilt, and FOV (`62°` to `84°`) based on speed and slope pitch, with instant snap on drop-in/reset. |
| `JungleAudioEngine` | `src/audio/JungleAudioEngine.ts` | Web Audio API procedural 170 BPM PS1 Jungle/Amen breakbeat synthesizer & mixer: atmospheric pad stem, bassline stem (`> 15 km/h`), breakbeat drum stem (`> 30 km/h`, full `>= 60 km/h`), wind noise generator, and snow-carve bandpass filter. |
| `HUDManager` | `src/ui/HUDManager.ts` | Main menu mountain/drop-zone selector, HUD speedometer (`km/h`), altitude/vertical drop meter, audio stem activity indicators, and crash/airtime notifications. |
| `GameApp` | `src/main.ts` | Top-level lifecycle orchestrator, `requestAnimationFrame` loop, deterministic `step(dt)` hook, and `window.__OGSNOW_STATE__` publisher. |

---

## 4. Code & Runtime Sequence Diagrams (C4)

### 4.1 Initialization & Drop-In Flow

```mermaid
sequenceDiagram
    participant User as Player / E2E Test
    participant UI as HUDManager
    participant App as GameApp (main.ts)
    participant Terrain as TerrainManager
    participant Phys as PhysicsEngine
    participant Audio as JungleAudioEngine

    App->>Terrain: initialize() (Idempotent load/hydrate Whistler Peak .glb & DEM)
    Terrain-->>App: TerrainData & Three.js Group ready
    App->>UI: renderMainMenu(mountain, dropZones) & enable drop-in buttons
    App->>App: Publish window.__OGSNOW_STATE__ (mode = "menu", ready = true)
    User->>UI: Click Drop Zone (e.g. "Peak Express Summit - 2,182m")
    UI->>App: onDropIn(dropZoneId)
    App->>Phys: resetAtDropZone(dropZone)
    App->>Audio: init() & resume AudioContext
    App->>UI: setMode("riding")
    App->>App: Publish window.__OGSNOW_STATE__ (mode = "riding", ready = true)
```

### 4.2 Per-Frame Game Loop (`tick(dt)`)

```mermaid
sequenceDiagram
    participant App as GameApp
    participant Input as InputController
    participant Phys as PhysicsEngine
    participant Terrain as TerrainManager
    participant Char as SnowboardCharacter
    participant Cam as FollowCamera
    participant Audio as JungleAudioEngine
    participant UI as HUDManager

    App->>Input: getInput()
    Input-->>App: PlayerInput (steer, carve, tuck, jump, reset)
    App->>Phys: step(dt, input)
    Phys->>Terrain: getHeightAt(x, z) & getNormalAt(x, z)
    Terrain-->>Phys: elevation, slopeNormal, slopePitch
    Phys->>Terrain: checkObstacleCollision(position, radius)
    Terrain-->>Phys: collisionResult
    Phys-->>App: Updated PlayerState (pos, vel, speedKmh, carveAngle, isGrounded, isCrashed)
    App->>Char: update(playerState, dt)
    App->>Cam: update(playerState, dt)
    App->>Audio: update(playerState, dt)
    App->>UI: update(playerState, audioState)
    App->>App: Sync window.__OGSNOW_STATE__
```

---

## 5. Adaptive Audio State Machine & Stem Mixing Flow

```mermaid
flowchart LR
    State["PlayerState (speedKmh, carveIntensity, isGrounded, isCrashed)"]
    
    subgraph Mixer["JungleAudioEngine (170 BPM Procedural Web Audio)"]
        Pad["Atmospheric Pad Stem (Always Active: Gain 0.35 - 0.70)"]
        Bass["Reese / Sub-Bass Stem (Fades in > 15 km/h, Full at 45 km/h)"]
        Drums["170 BPM Amen Breakbeat Stem (Fades in > 30 km/h, Full >= 60 km/h)"]
        Wind["Procedural Wind Filter (Pitch 220-1400Hz & Gain scale 0 - 115 km/h)"]
        Carve["Snow Carve Noise (Scales with carveIntensity * speed & grounded)"]
    end

    CrashLogic{"isCrashed == true or mode == 'menu' or speedKmh < 15?"}

    State --> CrashLogic
    CrashLogic -->|"Yes"| Duck["Duck Drums & Bass to 0.0, Keep Ambient Pad (activeStems = ['pad'])"]
    CrashLogic -->|"No"| SpeedMap["Map speedKmh & carveIntensity to Stem Gains"]
    SpeedMap --> Pad
    SpeedMap --> Bass
    SpeedMap --> Drums
    SpeedMap --> Wind
    SpeedMap --> Carve
```
