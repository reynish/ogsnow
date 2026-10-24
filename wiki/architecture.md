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
    GISData["Committed Real-World DEM / GLB Artifacts (whistler-dem.bin + terrain.json + .glb)"]
    OpenData["Open Map Data Providers (AWS Open Data Terrarium, Copernicus GLO-30, OSM)"]
    FetchPipeline["Build-Time Fetch Pipeline (scripts/fetch-terrain.ts — network, on-demand)"]
    CICD["GitHub Actions CI/CD Pipeline"]

    Player -->|"Keyboard / Controller Inputs (Steer, Carve, Tuck, Jump, Drop-In)"| OGSnow
    OGSnow -->|"3D Low-Poly WebGL Visuals, Adaptive PS1 Jungle Audio & Attribution"| Player
    GISData -->|"Standardized Heightfield, .glb Terrain Mesh & Provenance Manifest"| OGSnow
    OpenData -->|"Terrarium PNG Elevation Tiles / Copernicus COGs / OSM Extracts (keyless)"| FetchPipeline
    FetchPipeline -->|"Writes Committed Source-of-Truth DEM Artifacts"| GISData
    E2ERunner -->|"Simulates Inputs & Inspects window.__OGSNOW_STATE__"| OGSnow
    CICD -->|"Builds, Unit Tests (Vitest), Offline Derivation Diff & Runs E2E Suite"| OGSnow
```

---

## 2. Container Architecture (C2)

Inside the browser runtime, **ogSnow** executes within a single-page TypeScript/Vite application divided into five primary runtime containers plus a build-time/runtime `.glb` terrain asset pipeline.

```mermaid
flowchart LR
    subgraph Browser["Web Browser Runtime (Desktop) — zero network"]
        UIContainer["UI & HUD Layer (DOM / CSS Overlay, Attribution)"]
        GameCore["Game Coordinator & State Store (main.ts)"]
        RenderEngine["3D WebGL Renderer (Three.js Scene, Camera, GLTF)"]
        PhysicsWorld["Physics & Slope Solver (cannon-es + DEM Heightfield)"]
        AudioEngine["Adaptive Audio Engine (Web Audio API / Procedural Jungle)"]
        E2EHook["Telemetry Bridge (window.__OGSNOW_STATE__)"]
    end

    subgraph Assets["Committed Static Assets (bundled, relative paths)"]
        GLBAsset["whistler-peak.glb (Render Mesh + Metadata Extras)"]
        DEMAsset["whistler-dem.bin (Float32 Heightfield)"]
        ManifestAsset["whistler-terrain.json (Provenance, DropZones, Obstacles, Attribution)"]
    end

    subgraph BuildTime["Build-Time Pipeline (Node, not shipped to browser)"]
        FetchScript["scripts/fetch-terrain.ts (Network One-Shot)"]
        GenScript["scripts/generate-glb.ts (Offline Deterministic Derivation)"]
    end

    UIContainer -->|"Selects Mountain & DropZone / Reads Telemetry & Attribution"| GameCore
    GameCore -->|"Steps Simulation (dt) & Reads PlayerInput"| PhysicsWorld
    GLBAsset -->|"Loads .glb Mesh"| RenderEngine
    DEMAsset -->|"Provides Height / Normal Queries"| PhysicsWorld
    ManifestAsset -->|"Provides DropZones, Obstacles, Provenance & Attribution"| GameCore
    PhysicsWorld -->|"Updates PlayerState (Position, Velocity, Pitch, Grounded)"| GameCore
    GameCore -->|"Syncs Character, Obstacles & FollowCamera"| RenderEngine
    GameCore -->|"Modulates Stems & SFX by Speed / Carve / Crash"| AudioEngine
    GameCore -->|"Publishes Live Snapshot"| E2EHook
    FetchScript -->|"Decodes + Reprojects + Resamples"| DEMAsset
    FetchScript -->|"Writes Provenance Manifest"| ManifestAsset
    GenScript -->|"Reads committed .bin + .json, derives, exports"| GLBAsset
    GenScript -->|"Enriches Manifest with DropZones + Obstacles"| ManifestAsset
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

    subgraph TerrainPkg["Terrain Pipeline (src/terrain/, scripts/)"]
        Registry["Mountain Registry (src/terrain/mountains.ts)"]
        Source["Node-Only Terrain Source (src/terrain/terrainSource.ts)"]
        Derivation["Deterministic Derivation (src/terrain/terrainDerivation.ts)"]
        Pipeline["GLB Build/Parse (src/terrain/glbPipeline.ts)"]
        TerrainMgr["TerrainManager (src/terrain/TerrainManager.ts)"]
        Fetch["scripts/fetch-terrain.ts (Node/Network)"]
        Gen["scripts/generate-glb.ts (Node/Offline)"]
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

    TerrainMgr --> Pipeline
    PhysEng --> TerrainMgr
    CamCtrl --> TerrainMgr

    Fetch --> Registry
    Fetch --> Source
    Gen --> Registry
    Gen --> Source
    Gen --> Derivation
    Gen --> Pipeline
```

### Component Responsibilities

| Component | File Path | Responsibility |
| :--- | :--- | :--- |
| `Types` | `src/types.ts` | Canonical TypeScript interfaces (`PlayerState`, `TerrainData`, `DropZone`, `AudioState`, `GameConfig`, `OGSnowGlobalState`) plus optional provenance fields (`GeoOrigin`, `TerrainSourceMetadata`, `SampledControlPoint`). |
| `Config` | `src/config.ts` | Default physics constants, Whistler Peak metadata, drop zones, audio BPM/thresholds, camera parameters. |
| `Registry` | `src/terrain/mountains.ts` | Pure-data mountain registry (`MOUNTAIN_REGISTRY`, `getMountainById`): origin, extent, zoom, grid segments, tree line, license/attribution, pinned tiles. |
| `Source` | `src/terrain/terrainSource.ts` | **Node-only.** Terrarium tile URL builder, PNG RGB decode, EPSG:3857 ↔ lat/lon, rotated-rectangle ENU sampling, `Float32` resample, provenance builder. Never imported by browser code. |
| `Derivation` | `src/terrain/terrainDerivation.ts` | Deterministic, seeded drop-zone selection (sustained steep fall lines, spacing, spawn clearance) and obstacle derivation (tree line, slope, curvature; optional OSM refinement hook). Browser-safe (no `node:` imports) for unit testing. |
| `GLBPipeline` | `src/terrain/glbPipeline.ts` | Assembles `TerrainData`, builds low-poly vertex-colored Three.js geometry, exports/loads `.glb` (`GLTFExporter` / `GLTFLoader`). No synthetic heightfield. |
| `TerrainManager` | `src/terrain/TerrainManager.ts` | Loads committed `.glb` + `.json` + `.bin`, reconstructs `TerrainData`, manages mesh + obstacles, bilinear `getHeightAt(x,z)`/`getNormalAt(x,z)`. |
| `Fetch` | `scripts/fetch-terrain.ts` | Node CLI (`npm run fetch-terrain -- --mountain <id>`): downloads pinned tiles → `.cache/terrain/`, decodes/reprojects/resamples, writes `<id>-dem.bin` + `<id>-terrain.json`. |
| `Gen` | `scripts/generate-glb.ts` | Node CLI (offline): reads committed `.bin` + `.json`, runs derivation, exports deterministic `.glb`, enriches manifest. |
| `PhysicsEngine` | `src/physics/PhysicsEngine.ts` | `cannon-es` world + slope-aligned snowboard dynamics: gravity projection along slope normal, carving deceleration, edge grip, obstacle/boundary collisions, crash recovery, airtime detection, **charge-jump mechanics** (Iteration 3: `jumpCharge` accumulation + release-to-launch), **frozen air heading** (`headingRad` locked at takeoff; `A`/`D` spins only), **spin accumulation** (`spinRad`, ADR-0006 sign convention), **switch-stance persistence** (`stanceRad` absorbs nearest-180° multiple on clean landing; reset on crash/reset), and **trick landing evaluation** (alignment tolerance + grab-on-touchdown crash rule). |
| `InputController` | `src/player/PlayerController.ts` | Captures keyboard (`WASD` / Arrow keys / `Space` / `R`) and Gamepad inputs, plus programmatic input injection for E2E testing. |
| `SnowboardCharacter` | `src/player/SnowboardCharacter.ts` | Low-poly PS1-style 3D snowboarder + board mesh hierarchy with procedural lean, carve tilt, pitch alignment, snow spray particles, **crouch/wind-up pose** (Iteration 3: interpolated from `jumpCharge`), **spin visual rotation** (`spinRad` + persistent `stanceRad` yaw; grounded shortest-path ease to stance), **grab A/B arm poses** (`activeGrab`), and **landing squash** (brief compression on touchdown). |
| `FollowCamera` | `src/camera/FollowCamera.ts` | Third-person dynamic chase camera that interpolates position, look-at target, pitch tilt, and FOV (`62°` to `84°`) based on speed and slope pitch, with instant snap on drop-in/reset. |
| `JungleAudioEngine` | `src/audio/JungleAudioEngine.ts` | Web Audio API procedural 170 BPM PS1 Jungle/Amen breakbeat synthesizer & mixer. |
| `HUDManager` | `src/ui/HUDManager.ts` | Main menu mountain/drop-zone selector, attribution footer (`data-testid="terrain-attribution"`), HUD speedometer, altitude, audio stems, crash/airtime notifications, **controls legend overlay** (Iteration 3: charge-jump instructions and trick controls; no score display). |
| `GameApp` | `src/main.ts` | Top-level lifecycle orchestrator, `requestAnimationFrame` loop, deterministic `step(dt)` hook, and `window.__OGSNOW_STATE__` publisher (incl. terrain provenance). |

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

    App->>Terrain: initialize(artifacts) (idempotent: .glb + .json + .bin)
    Terrain-->>App: TerrainData (real DEM heights, dropZones, obstacles, provenance) & Three.js Group ready
    App->>UI: renderMainMenu(mountain, dropZones, attribution) & enable drop-in buttons
    App->>App: Publish window.__OGSNOW_STATE__ (mode = "menu", ready = true, terrain.realWorld = true)
    User->>UI: Click Drop Zone
    UI->>App: onDropIn(dropZoneId)
    App->>Phys: resetAtDropZone(dropZone)
    App->>Audio: init() & resume AudioContext
    App->>UI: setMode("riding")
    App->>App: Publish window.__OGSNOW_STATE__ (mode = "riding", ready = true)
```

### 4.3 Build-Time Terrain Import Data Flow (ADR-0007)

```mermaid
flowchart LR
    subgraph Network["Stage A — Network Fetch (on-demand, developer machine only)"]
        Tiles["Terrarium PNG Tiles (z13 pinned)"]
        Cache[".cache/terrain/ (gitignored)"]
        Fetch["scripts/fetch-terrain.ts"]
    end

    subgraph Committed["Committed Source-of-Truth Artifacts (repo)"]
        Bin["whistler-dem.bin (Float32 grid)"]
        Man["whistler-terrain.json (provenance + control points)"]
    end

    subgraph Offline["Stage B — Offline Deterministic Derivation (CI-safe)"]
        Gen["scripts/generate-glb.ts"]
        Deriv["terrainDerivation.ts (drop zones + obstacles)"]
    end

    subgraph RuntimeArtifacts["Committed Runtime Artifacts"]
        GLB["whistler-peak.glb"]
        Man2["whistler-terrain.json (enriched: dropZones, obstacles, attribution)"]
    end

    Tiles -->|"download + cache"| Cache
    Cache --> Fetch
    Fetch -->|"decode, reproject, resample, checksum"| Bin
    Fetch -->|"write provenance manifest"| Man
    Bin --> Gen
    Man --> Gen
    Gen --> Deriv
    Deriv -->|"seeded drop zones + obstacles"| Gen
    Gen -->|"build mesh + export deterministic .glb"| GLB
    Gen -->|"enrich manifest"| Man2
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

---

## 6. Iteration 3 — Charge-Jump & Trick Flow (ADR-0008)

### 6.1 Charge-and-Release Jump State Machine

```mermaid
stateDiagram-v2
    [*] --> Grounded_Standing
    Grounded_Standing --> Grounded_Crouching: jumpHeld = true & isGrounded
    Grounded_Crouching --> Grounded_Standing: jumpHeld = false (tap, jumpCharge < 0.05)
    Grounded_Crouching --> Airborne: jumpHeld = false (release, jumpCharge > 0) / launch(impulse)
    Grounded_Standing --> Airborne: manual jump trigger
    Airborne --> Trick_Spin: input.steer ≠ 0 / spinRad accumulates
    Airborne --> Trick_Grab_A: input.tuck = true / activeGrab = 'A'
    Airborne --> Trick_Grab_B: input.carve > 0 / activeGrab = 'B'
    Trick_Spin --> Airborne: input.steer = 0 or land
    Trick_Grab_A --> Airborne: input.tuck = false or land
    Trick_Grab_B --> Airborne: input.carve = 0 or land
    Airborne --> Grounded_Standing: touchdown & aligned & no grab / stanceRad absorbs nearestHalf (switch for 180°/540°)
    Airborne --> Crashed: touchdown & (misaligned OR activeGrab ≠ 'none')
    Crashed --> Grounded_Standing: crashTimerSeconds ≤ 0
```

### 6.2 Per-Frame Charge-Jump & Trick Evaluation Sequence

```mermaid
sequenceDiagram
    participant Input as PlayerController
    participant Phys as PhysicsEngine
    participant Terrain as TerrainManager
    participant Char as SnowboardCharacter
    participant HUD as HUDManager

    Input->>Phys: PlayerInput (jumpHeld, steer, tuck, carve)
    
    alt isGrounded && jumpHeld && !isCrashed
        Phys->>Phys: jumpCharge += dt / jumpChargeMaxSeconds (clamp [0,1])
        Phys->>Phys: effectiveSteerRate *= crouchSteerRateMultiplier (0.4)
        Phys->>Char: state.jumpCharge (for crouch pose interpolation)
    else isGrounded && !jumpHeld && jumpCharge > 0
        Phys->>Phys: impulse = jumpMinImpulse + jumpCharge*(jumpMaxImpulse - jumpMinImpulse)
        Phys->>Phys: velocity.y = impulse; isGrounded = false; jumpCharge = 0
    end

    alt !isGrounded (Airborne)
        Phys->>Phys: headingRad FROZEN at takeoff value (no air steering; camera stays locked behind direction of travel)
        Phys->>Phys: spinRad -= input.steer * spinRateRadPerSec * dt (steer=+1/D decrements: clockwise/screen-right, ADR-0006 sign)
        
        alt input.tuck && !wasActiveGrab
            Phys->>Phys: activeGrab = 'A' (indy/method)
        else input.carve > 0 && !wasActiveGrab
            Phys->>Phys: activeGrab = 'B' (melon/tail)
        else !input.tuck && !input.carve
            Phys->>Phys: activeGrab = 'none'
        end

        Phys->>Char: state.stanceRad + state.spinRad, state.activeGrab (for visual yaw & grab poses)
    end

    Phys->>Terrain: getHeightAt(x, z) (check touchdown)
    
    alt touchdown (isGrounded transition)
        Phys->>Phys: nearestHalf = round(spinRad / π) * π
        Phys->>Phys: alignmentError = |spinRad - nearestHalf|
        
        alt alignmentError > landAlignmentToleranceRad (π/3) OR activeGrab ≠ 'none'
            Phys->>Phys: isCrashed = true; velocity *= 0.15; crashTimerSeconds = crashRecoverySeconds; stanceRad = 0
            Phys->>Char: crash tumble animation
        else
            Phys->>Phys: stanceRad = (stanceRad + nearestHalf) mod 2π (180°/540° → switch, 360° → normal); spinRad = 0; activeGrab = 'none'
            Phys->>Char: landing squash animation
        end
    end

    Phys-->>HUD: PlayerState (jumpCharge, spinRad, stanceRad, activeGrab, isCrashed)
```

### 6.3 Input Interpretation (Ground vs. Air)

| Input Key | Grounded Meaning | Airborne Meaning (ADR-0008) |
| :--- | :--- | :--- |
| `A` / `←` | Steer left (+X) | Spin frontside (spinRad increments — counterclockwise/screen-left) |
| `D` / `→` | Steer right (-X) | Spin backside (spinRad decrements — clockwise/screen-right) |
| `W` / `↑` | Tuck (aerodynamic boost) | Grab A (indy/method) |
| `S` / `↓` | Carve/brake (slow down) | Grab B (melon/tail) |
| `Space` | Hold to charge jump; release to launch | No effect (already airborne) |
| `R` | Reset to drop zone | Reset to drop zone |
| Gamepad `A` | Charge/release jump | No effect (already airborne) |
| Gamepad analog stick | Steer left/right | Spin left/right |
| Gamepad `LT`/`B` | Carve/brake | Grab B |
| Gamepad `RT` | Tuck | Grab A (alternative mapping) |

**Airborne heading policy (ADR-0008, amended 2026-10-24):** while airborne the travel heading `headingRad` is **frozen** at its takeoff value — none of the airborne inputs above rotate the heading or the follow camera; `A`/`D` (or the stick) only spin the character (`spinRad`, sharing `headingRad`'s sign convention: `D` decrements → clockwise/screen-right). Steering authority returns on touchdown.

**Switch-stance persistence (ADR-0008, round-2 amendment 2026-10-24):** a clean landing absorbs the nearest `180°` multiple of `spinRad` into `stanceRad` (`180°`/`540°` → switch/goofy, `360°`/`720°` → normal; crash/reset → normal). While grounded the character eases its visual yaw to `stanceRad` (shortest path); while airborne the visual yaw is `stanceRad + spinRad`. `stanceRad` is visual-only and never affects heading, velocity, or obstacles.
