# ADR-0003: Slope Physics, Collision, and Snowboard Controls

- **Status:** Accepted
- **Date:** 2026-10-18
- **Iteration:** `feat/v1-core-game`

## Context

The PRD specifies gravity and momentum based on the actual slope angles of the 3D mountain, basic collision detection against terrain and natural obstacles, keyboard/controller inputs for steering (left/right) and speed control (carving to slow down), and a dynamic third-person follow camera that reacts to speed and slope pitch.

## Decision

1. **Hybrid `cannon-es` + Slope-Surface Physics Solver (`src/physics/PhysicsEngine.ts`):**
   - We instantiate a `cannon-es` `CANNON.World` and rigid body for velocity integration and impulse handling, coupled with continuous DEM height/normal projection (`TerrainManager.getHeightAt` / `getNormalAt`).
   - When `isGrounded` is `true`:
     - Gravity acceleration is projected onto the local slope tangent: $a_{\text{slope}} = g \cdot \sin(\theta_{\text{pitch}})$.
     - Steering input (`steer` in `[-1, 1]`) rotates the board's `headingRad` at `steerRateRadPerSec` and banks `rollRad`.
     - Carving occurs when the player holds the carve/brake key (`S` / `ArrowDown`, `input.carve > 0`) or turns sharply across the fall line. Carving increases `carveAngleRad` and `carveIntensity` (`0.0` to `1.0`), applying a quadratic deceleration drag force proportional to `carveDragCoefficient * carveIntensity * speedMs` and aligning velocity toward `headingRad`.
   - When jumping (`input.jump && isGrounded`) or launching off a steep crest:
     - Vertical velocity `velocity.y` receives `config.jumpImpulse`, `isGrounded` becomes `false`, and `airtimeSeconds` increments until `position.y <= terrainHeight`.
2. **Obstacle & Boundary Collisions:**
   - Each physics step checks `TerrainManager.checkObstacleCollision(position, 1.1)`.
   - If a collision occurs at `speedKmh >= config.crashSpeedThresholdKmh`, `isCrashed` becomes `true`, speed drops by 85%, and `crashTimerSeconds` counts down from `config.crashRecoverySeconds` (1.5s) before restoring normal riding control. Low-speed contacts gently deflect the player away from the obstacle center.
   - Lateral mountain boundaries (`|x| > width / 2 - 8`) clamp `x` and deflect lateral velocity back onto the run.
3. **Dynamic Follow Camera (`src/camera/FollowCamera.ts`):**
   - Smoothly interpolates behind the player's heading (`cameraBaseDistance`, `cameraBaseHeight`), pitching downward with `pitchRad` and widening FOV from `cameraBaseFov` (`62°`) up to `cameraMaxFov` (`84°`) as `speedKmh` increases.
   - Clamps camera elevation to at least `terrain.getHeightAt(camX, camZ) + 1.5` so the camera never clips underneath the mountain surface.

## Consequences

- **Positive:**
  - Deterministic, responsive arcade-simulation snowboarding feel reminiscent of *Cool Boarders* and *Steep*.
  - Zero high-speed mesh-tunneling artifacts.
- **Negative:**
  - Requires fixed-step sub-stepping (clamping `dtSeconds` to `<= 0.05s`) so frame drops do not destabilize velocity integration.

## Strict Compliance Rules

1. Leaving a player untouched on a downhill drop zone (`summit-express`) for 3 simulated seconds MUST accelerate `speedKmh` above `20 km/h` and move `position.z` downhill (`z` increasing).
2. Applying `input.carve = 1.0` MUST measurably reduce `speedKmh` compared to riding straight (`input.carve = 0.0`) over the same slope duration, and MUST set `carveIntensity > 0.3`.
3. Triggering a collision or `forceCrash()` MUST set `isCrashed = true` and recover to `isCrashed = false` after `crashRecoverySeconds` of simulation time.
