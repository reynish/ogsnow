# ADR-0003: Slope Physics, Collision, and Snowboard Controls

- **Status:** Accepted (partially superseded by [ADR-0008](./0008-charge-jump-and-tricks.md))
- **Date:** 2026-10-18
- **Iteration:** `feat/v1-core-game`

> [!WARNING]
> **Partially superseded by ADR-0008 (Iteration 3 `feat/charge-jump-tricks`):** The following clauses from §"Decision" are **superseded**:
> - §1 **Jump mechanics**: edge-triggered single-impulse jump (`jumpImpulse: 7.5`) is replaced by hold-to-charge/release-to-pop (`jumpCharge`, `jumpMinImpulse`, `jumpMaxImpulse`).
> - §1 **Gravity**: single-value `gravity: 22.0 m/s²` is replaced by `gravity: 14.0 m/s²` (realistic retune for floaty air time).
> - §1 **Grounded steering**: no crouch penalty is replaced by `crouchSteerRateMultiplier` (≈ `0.4×`) applied while `jumpCharge > 0`.
> - §1 **Airborne behavior**: no air control or tricks is replaced by a **frozen travel heading** while airborne (`A`/`D` drives spin `spinRad` only, per the ADR-0008 2026-10-24 amendment), and grab mechanics (`activeGrab`).
>
> **Historical context retained below:** All other rules remain in force: coordinate conventions (downhill `+Z`, `steer=+1` decrements `headingRad` → world `-X` / screen-right), carve drag, crash speed threshold (`28 km/h`), crash-recovery arrest friction, obstacle collision radial push-out, and boundary clamping.

## Context

The PRD specifies gravity and momentum based on the actual slope angles of the 3D mountain, basic collision detection against terrain and natural obstacles, keyboard/controller inputs for steering (left/right) and speed control (carving to slow down), and a dynamic third-person follow camera that reacts to speed and slope pitch.

## Decision

1. **Hybrid `cannon-es` + Slope-Surface Physics Solver (`src/physics/PhysicsEngine.ts`):**
   - We instantiate a `cannon-es` `CANNON.World` and rigid body for velocity integration and impulse handling, coupled with continuous DEM height/normal projection (`TerrainManager.getHeightAt` / `getNormalAt`), fixed sub-stepping (`<= 1/60s` up to clamped `0.05s`), and `Number.isFinite(dtSeconds)` guards.
   - **Coordinate System & Steering Convention (per ADR-0006):** Downhill is `+Z` (`headingRad = 0`, forward vector $(\sin h, \cos h)$). Because `FollowCamera` sits behind the player looking toward `+Z` with world up `+Y`, camera screen-right in Three.js right-handed coordinates is world `-X`. Therefore `steer = +1` (`ArrowRight` / `KeyD`) MUST decrement `headingRad` (`headingRad -= input.steer * config.steerRateRadPerSec * dt`) to steer the rider toward world `-X` (screen right, `NDC x > 0`), and `rollRad` banks into the turn (`rollRad = -input.steer * 0.35`).
   - When `isGrounded` is `true` and `isCrashed` is `false`:
     - Gravity acceleration is projected onto the local slope tangent: $a_{\text{slope}} = g \cdot \sin(\theta_{\text{pitch}})$.
     - Carving occurs when the player holds the carve/brake key (`S` / `ArrowDown`, `input.carve > 0`) or turns sharply across the fall line. Carving increases `carveAngleRad` and `carveIntensity` (`0.0` to `1.0`), applying a linear deceleration drag force proportional to `carveDragCoefficient * carveIntensity * speedMs` and aligning velocity toward `headingRad`.
   - When jumping (`input.jump && !wasJumpPressed && isGrounded && !isCrashed` — **rising-edge triggered**) or launching off a steep crest:
     - Vertical velocity `velocity.y` receives `config.jumpImpulse`, `isGrounded` becomes `false`, and `airtimeSeconds` increments until `position.y <= terrainHeight`.
2. **Obstacle & Boundary Collisions:**
   - Each physics step checks `TerrainManager.checkObstacleCollision(position, 1.1)`.
   - On contact with an obstacle, the rider is radially pushed outside `obs.radius + 1.1`.
   - If `speedKmh < config.crashSpeedThresholdKmh` (`28 km/h`), the contact gently deflects the player's velocity along the contact normal without triggering a crash (`isCrashed` remains `false`).
   - If `speedKmh >= config.crashSpeedThresholdKmh` (`28 km/h`), `isCrashed` becomes `true`, speed drops by 85%, and `crashTimerSeconds` counts down from `config.crashRecoverySeconds` (`1.5s`). While `isCrashed === true`, slope gravity acceleration and steering/carving are halted and strong crash friction decelerates the rider until recovery.
   - Lateral mountain boundaries (`|x| > width / 2 - 8`) clamp `x`, deflect lateral velocity back onto the run, and nudge `headingRad` inward. Reaching the bottom boundary (`z >= length / 2 - 15`) cleanly resets/wraps the rider back to the active drop zone.
3. **Dynamic Follow Camera (`src/camera/FollowCamera.ts`):**
   - Smoothly interpolates behind the player's heading (`cameraBaseDistance = 6.5`, `cameraBaseHeight = 2.6`), pitching downward with `pitchRad` and widening FOV from `cameraBaseFov` (`62°`) up to `cameraMaxFov` (`84°`) as `speedKmh` increases, and snaps immediately on drop-in/reset via `snap(playerState)`.
   - Clamps camera elevation to at least `terrain.getHeightAt(camX, camZ) + 1.5` so the camera never clips underneath the mountain surface.

## Consequences

- **Positive:**
  - Deterministic, responsive arcade-simulation snowboarding feel reminiscent of *Cool Boarders* and *Steep*.
  - Zero high-speed mesh-tunneling artifacts and accurate screen-space steering alignment.
- **Negative:**
  - Requires fixed-step sub-stepping (clamping `dtSeconds` to `<= 0.05s` and stepping in `<= 1/60s` increments) so frame drops do not destabilize velocity integration.

## Strict Compliance Rules

1. Leaving a player untouched on a downhill drop zone (`summit-express`) for 3 simulated seconds MUST accelerate `speedKmh` above `20 km/h` and move `position.z` downhill (`z` increasing).
2. Steering right (`steer = +1` / `ArrowRight`) MUST decrement `headingRad`, move `position.x` toward `-X`, and project to positive camera screen-space `NDC x > 0`.
3. Applying `input.carve = 1.0` MUST measurably reduce `speedKmh` compared to riding straight (`input.carve = 0.0`) over the same slope duration, and MUST set `carveIntensity > 0.3`.
4. Obstacle contact below `config.crashSpeedThresholdKmh` (`28 km/h`) MUST deflect without crashing; contact `>= 28 km/h` or `forceCrash()` MUST set `isCrashed = true`, push the rider outside the obstacle radius, halt slope acceleration during recovery, and recover to `isCrashed = false` after `crashRecoverySeconds` of simulation time.
