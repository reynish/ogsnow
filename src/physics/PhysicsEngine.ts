import * as CANNON from 'cannon-es';
import { GameConfig, PlayerInput, PlayerState, DropZone, Vector3Like } from '../types';
import { DEFAULT_GAME_CONFIG } from '../config';
import { TerrainManager } from '../terrain/TerrainManager';

/**
 * [ADR-0006 / PR-1 B1: Right-Handed Screen-Space Steering Convention]
 *
 * Coordinate system and camera perspective:
 * - Downhill travel along the Whistler DEM is in the +Z direction (headingRad = 0 => forward = (sin(h), cos(h)) = (0, 1)).
 * - FollowCamera sits behind the rider (-Z) looking toward +Z with up = +Y.
 * - In Three.js right-handed coordinates, camera-right is world -X:
 *     Camera Right = Forward x Up = (0, 0, 1) x (0, 1, 0) = (-1, 0, 0) [world -X].
 * - Therefore steer = +1 (ArrowRight / KeyD) MUST turn toward world -X by DECREMENTING headingRad:
 *     this.state.headingRad -= effectiveSteer * this.config.steerRateRadPerSec * dtSeconds;
 * - Conversely, steer = -1 (ArrowLeft / KeyA) steers toward world +X (screen-left) by INCREMENTING headingRad.
 * - Roll angle rolls into the turn: steer = +1 banks right (rollRad > 0), steer = -1 banks left (rollRad < 0).
 * - Carve intensity and angle evaluate drift magnitude symmetrically for both left and right turns.
 */
export class PhysicsEngine {
  public readonly config: GameConfig;
  public readonly terrain: TerrainManager;
  public readonly world: CANNON.World;
  public readonly body: CANNON.Body;

  private state: PlayerState;
  // Tracks the previous substep's continuous jump-hold signal so "release" is detected
  // exactly once across the multi-substep integration loop (ADR-0008 §1).
  private lastJumpHeld = false;
  // ADR-0008 §1 fresh-key-down latch: set when the rider touches down while
  // jumpHeld is still held, cleared only when a release is observed while
  // grounded. While set, holding Space must NOT start a new charge — each new
  // jump requires a fresh key-down after landing.
  private requireFreshJumpPress = false;

  constructor(terrain: TerrainManager, config: GameConfig = DEFAULT_GAME_CONFIG) {
    this.terrain = terrain;
    this.config = config;

    this.world = new CANNON.World();
    this.world.gravity.set(0, -this.config.gravity, 0);

    const shape = new CANNON.Sphere(0.5);
    this.body = new CANNON.Body({ mass: 75, shape });
    this.world.addBody(this.body);

    const defaultDz = this.config.dropZones[0] ?? this.terrain.terrainData.dropZones[0];
    this.state = this.buildInitialState(defaultDz);
  }

  public resetAtDropZone(dropZone: DropZone): PlayerState {
    this.state = this.buildInitialState(dropZone);
    this.lastJumpHeld = false;
    this.requireFreshJumpPress = false;
    this.body.position.set(this.state.position.x, this.state.position.y, this.state.position.z);
    this.body.velocity.set(0, 0, 0);
    return this.getState();
  }

  public step(dtSeconds: number, input: PlayerInput): PlayerState {
    if (!Number.isFinite(dtSeconds) || dtSeconds <= 0) {
      return this.getState();
    }

    const dt = Math.min(dtSeconds, 0.1);
    const maxSubStep = 0.02;
    const subSteps = dt > 0.025 ? Math.ceil(dt / maxSubStep) : 1;
    const subDt = dt / subSteps;

    for (let s = 0; s < subSteps; s++) {
      const resetState = this.stepSubStep(subDt, input);
      if (resetState) {
        return resetState;
      }
    }

    return this.getState();
  }

  private stepSubStep(dt: number, input: PlayerInput): PlayerState | null {
    // Handle crash recovery timer
    if (this.state.isCrashed) {
      this.state.crashTimerSeconds -= dt;
      if (this.state.crashTimerSeconds <= 0) {
        this.state.isCrashed = false;
        this.state.crashTimerSeconds = 0;
      }
    }

    // Restrict controls while crashed (ADR-0008: no legacy `jump` field)
    const effectiveInput: PlayerInput = this.state.isCrashed
      ? { steer: 0, carve: 0, tuck: false, jumpHeld: false, reset: false }
      : input;

    // 0. Charge-jump accumulation & release-to-launch (ADR-0008 §1)
    const jumpHeld = effectiveInput.jumpHeld;
    if (this.state.isGrounded && !this.state.isCrashed) {
      if (!jumpHeld) {
        // A release observed while grounded re-arms the latch so the NEXT press
        // counts as a fresh key-down (ADR-0008 §1 "no re-trigger").
        this.requireFreshJumpPress = false;
        if (this.lastJumpHeld && this.state.jumpCharge > 0) {
          const impulse =
            this.config.jumpMinImpulse +
            this.state.jumpCharge * (this.config.jumpMaxImpulse - this.config.jumpMinImpulse);
          this.state.velocity.y = impulse;
          this.state.isGrounded = false;
          this.state.jumpCharge = 0;
          this.state.airtimeSeconds = 0;
        }
      } else if (!this.requireFreshJumpPress) {
        this.state.jumpCharge = Math.min(
          1.0,
          this.state.jumpCharge + dt / this.config.jumpChargeMaxSeconds
        );
      }
    }

    // 1. Steering & Heading Yaw (B1: steer = +1 decrements headingRad towards -X / screen-right)
    if (this.state.isGrounded && !this.state.isCrashed) {
      // Crouch steering penalty while winding up a charge (ADR-0008 §1)
      const crouchMultiplier =
        this.state.jumpCharge > 0 ? this.config.crouchSteerRateMultiplier : 1.0;
      this.state.headingRad -=
        effectiveInput.steer * this.config.steerRateRadPerSec * crouchMultiplier * dt;
      while (this.state.headingRad > Math.PI) this.state.headingRad -= 2 * Math.PI;
      while (this.state.headingRad < -Math.PI) this.state.headingRad += 2 * Math.PI;
    } else if (!this.state.isGrounded && !this.state.isCrashed) {
      // Airborne: A/D drives trick spin ONLY. headingRad stays frozen at its
      // takeoff value, which equals the direction of travel (grounded velocity
      // alignment) and is never modified while airborne — so FollowCamera stays
      // locked behind the travel direction (owner PR-4 comment / README §8.3).
      // Spin sign matches the ADR-0006 ground steering convention: steer = +1 (D)
      // DECREMENTS the angle -> nose toward world -X -> screen-right (clockwise
      // from the chase camera), exactly like a ground D-turn.
      this.state.spinRad -= effectiveInput.steer * this.config.spinRateRadPerSec * dt;
    }

    // 2. Slope pitch at current coordinates along heading
    const pitch = this.terrain.getSlopePitchAt(
      this.state.position.x,
      this.state.position.z,
      this.state.headingRad
    );
    this.state.pitchRad = pitch;

    // 3. Roll angle (board bank leaning into the turn) — grounded only. While
    // airborne, A/D is a trick-spin input and must not bank the rider, so the
    // roll target decays toward 0 in the air (ADR-0008 §4 / owner PR-4 comment).
    const targetRoll = this.state.isGrounded
      ? effectiveInput.steer * 0.35 +
        (effectiveInput.carve > 0 && effectiveInput.steer !== 0
          ? Math.sign(effectiveInput.steer) * 0.2
          : 0)
      : 0;
    this.state.rollRad += (targetRoll - this.state.rollRad) * Math.min(1.0, dt * 10);

    // 4. Trick grab state — reflects CURRENTLY held keys only, never latched (ADR-0008 §4/§5)
    if (!this.state.isGrounded && !this.state.isCrashed) {
      this.state.activeGrab = effectiveInput.tuck
        ? 'A'
        : effectiveInput.carve > 0
          ? 'B'
          : 'none';
    } else {
      this.state.activeGrab = 'none';
    }

    // 5. Carve Intensity & Angle
    const fwdX = Math.sin(this.state.headingRad);
    const fwdZ = Math.cos(this.state.headingRad);

    let vx = this.state.velocity.x;
    let vz = this.state.velocity.z;
    let currentSpeed = Math.hypot(vx, vz);

    if (this.state.isCrashed) {
      this.state.carveIntensity = 0;
      this.state.carveAngleRad = 0;
    } else if (currentSpeed > 0.05) {
      const dot = Math.max(-1, Math.min(1, (vx * fwdX + vz * fwdZ) / currentSpeed));
      const driftAngle = Math.acos(dot);
      const steerDeltaCarve = Math.abs(effectiveInput.steer) * 0.35;
      const rawIntensity = Math.max(
        effectiveInput.carve,
        steerDeltaCarve,
        Math.min(1.0, driftAngle / 0.7)
      );
      this.state.carveIntensity = Math.min(1.0, Math.max(0.0, rawIntensity));
      this.state.carveAngleRad = Math.max(driftAngle, effectiveInput.carve * 0.45);
    } else {
      this.state.carveIntensity = effectiveInput.carve;
      this.state.carveAngleRad = effectiveInput.carve * 0.45;
    }

    // 6. Acceleration and Drag Dynamics
    // [ADR-0003 / PR-1 B4: Crash speed threshold gating, radial obstacle push-out, and crash arrest friction]
    if (this.state.isGrounded) {
      if (this.state.isCrashed) {
        // While wiped out, do not apply downhill slope acceleration (downhillAccel = 0)
        // and do not align velocity to heading. Instead apply strong snow arrest friction.
        const arrestDamping = Math.max(0, 1.0 - 5.0 * dt);
        vx *= arrestDamping;
        vz *= arrestDamping;
        currentSpeed = Math.hypot(vx, vz);
      } else {
        // Downhill slope gravitational acceleration
        const slopeAccel = this.config.gravity * Math.sin(pitch);
        const tuckBoost = effectiveInput.tuck ? 1.25 : 1.0;
        const forwardDrive = slopeAccel * tuckBoost;

        // Friction and drag forces
        const baseFriction =
          this.config.baseSlopeFriction * this.config.gravity * Math.max(0.1, Math.cos(pitch));
        const airDrag =
          (effectiveInput.tuck ? 0.5 : 1.0) *
          this.config.airDragCoefficient *
          currentSpeed *
          currentSpeed;
        const carveDrag =
          this.config.carveDragCoefficient * this.state.carveIntensity * currentSpeed * 1.5;

        const totalResistance = baseFriction + airDrag + carveDrag;
        currentSpeed = Math.max(0, currentSpeed + (forwardDrive - totalResistance) * dt);

        // Clamp max speed
        const maxSpeedMs = this.config.maxSpeedKmh / 3.6;
        currentSpeed = Math.min(maxSpeedMs, currentSpeed);

        // Align horizontal velocity towards board heading
        const alignmentRate = (4.5 + this.state.carveIntensity * 6.0) * dt;
        const targetVx = fwdX * currentSpeed;
        const targetVz = fwdZ * currentSpeed;

        vx += (targetVx - vx) * Math.min(1.0, alignmentRate);
        vz += (targetVz - vz) * Math.min(1.0, alignmentRate);

        const postAlignSpeed = Math.hypot(vx, vz);
        if (postAlignSpeed > 1e-4) {
          vx = (vx / postAlignSpeed) * currentSpeed;
          vz = (vz / postAlignSpeed) * currentSpeed;
        }
      }
    } else {
      // Airborne kinematics
      this.state.airtimeSeconds += dt;
      this.state.velocity.y -= this.config.gravity * dt;

      if (this.state.isCrashed) {
        const arrestDamping = Math.max(0, 1.0 - 5.0 * dt);
        vx *= arrestDamping;
        vz *= arrestDamping;
        currentSpeed = Math.hypot(vx, vz);
      } else {
        // Mild air drag while airborne
        const airborneDrag = this.config.airDragCoefficient * currentSpeed * currentSpeed * dt;
        currentSpeed = Math.max(0, currentSpeed - airborneDrag);
        if (currentSpeed > 1e-4) {
          const hSpeed = Math.hypot(vx, vz);
          if (hSpeed > 1e-4) {
            vx = (vx / hSpeed) * currentSpeed;
            vz = (vz / hSpeed) * currentSpeed;
          }
        }
      }
    }

    // 7. Position Integration
    const prevX = this.state.position.x;
    const prevZ = this.state.position.z;

    let newX = prevX + vx * dt;
    let newZ = prevZ + vz * dt;
    let newY = this.state.position.y + this.state.velocity.y * dt;

    const terrainY = this.terrain.getHeightAt(newX, newZ);

    if (this.state.isGrounded) {
      newY = terrainY;
      this.state.velocity.y = 0;
    } else {
      if (newY <= terrainY) {
        // Touchdown landing — evaluate trick alignment/grab (ADR-0008 §5)
        newY = terrainY;
        this.state.isGrounded = true;
        this.state.airtimeSeconds = 0;
        this.state.velocity.y = 0;

        // ADR-0008 §1: holding jumpHeld through a touchdown must NOT start a new
        // charge — arm the fresh-press latch (cleared by a release while grounded).
        if (jumpHeld) {
          this.requireFreshJumpPress = true;
        }

        const nearestHalf = Math.round(this.state.spinRad / Math.PI) * Math.PI;
        const alignmentError = Math.abs(this.state.spinRad - nearestHalf);
        if (
          alignmentError > this.config.landAlignmentToleranceRad ||
          this.state.activeGrab !== 'none'
        ) {
          // Wipeout: mid-rotation or still holding a grab on touchdown.
          // Crash resets stance to normal (owner PR-4 round-2 feedback).
          this.state.isCrashed = true;
          this.state.crashTimerSeconds = this.config.crashRecoverySeconds;
          vx *= 0.15;
          vz *= 0.15;
          currentSpeed *= 0.15;
          this.state.jumpCharge = 0;
          this.state.spinRad = 0;
          this.state.stanceRad = 0;
          this.state.activeGrab = 'none';
        } else {
          // Clean landing: absorb the nearest-180° multiple into the persistent
          // stance offset (switch stance: 180/540 -> switch, 360/720 -> normal),
          // then zero trick state and keep riding.
          this.state.stanceRad =
            (((this.state.stanceRad + nearestHalf) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          this.state.spinRad = 0;
          this.state.activeGrab = 'none';
        }
      }
    }

    // 8. Lateral & Runout Boundary Clamping
    // [PR-1 M12: Deflect heading inward on lateral boundaries, cleanly wrap/reset at bottom boundary]
    const halfWidth = this.terrain.terrainData.width / 2;
    const halfLength = this.terrain.terrainData.length / 2;

    if (newX < -halfWidth + 8) {
      newX = -halfWidth + 8;
      vx = Math.abs(vx) * 0.4;
      this.state.headingRad *= 0.5;
    } else if (newX > halfWidth - 8) {
      newX = halfWidth - 8;
      vx = -Math.abs(vx) * 0.4;
      this.state.headingRad *= 0.5;
    }

    // 8. Lateral & Bottom Boundary Enforcement (ADR-0006 M12, PR-2 m4)
    if (newZ >= halfLength - 15 || (!this.state.isCrashed && newZ >= halfLength - 40 && currentSpeed < 0.05)) {
      const dz =
        this.config.dropZones.find((d) => d.id === this.state.activeDropZoneId) ||
        this.config.dropZones[0];
      return this.resetAtDropZone(dz);
    }

    // 9. Obstacle Collision Detection
    // [ADR-0003 / PR-1 B4: Crash speed threshold gating, radial obstacle push-out, and crash arrest friction]
    const collisionPos: Vector3Like = { x: newX, y: newY, z: newZ };
    const obstacleHit = this.terrain.checkObstacleCollision(collisionPos, 1.1);

    if (obstacleHit) {
      // Always push the rider radially outside the obstacle (to distance = obs.radius + 1.15 from obs.position)
      const dx = newX - obstacleHit.position.x;
      const dz = newZ - obstacleHit.position.z;
      const dist2D = Math.hypot(dx, dz);
      const targetDist = obstacleHit.radius + 1.15;
      let normX = 0;
      let normZ = 1;
      if (dist2D > 1e-4) {
        normX = dx / dist2D;
        normZ = dz / dist2D;
      } else {
        normX = -Math.sin(this.state.headingRad);
        normZ = -Math.cos(this.state.headingRad);
        if (Math.hypot(normX, normZ) < 1e-4) {
          normX = 0;
          normZ = 1;
        }
      }
      newX = obstacleHit.position.x + normX * targetDist;
      newZ = obstacleHit.position.z + normZ * targetDist;
      newY = this.terrain.getHeightAt(newX, newZ);

      if (!this.state.isCrashed) {
        const speedKmh = Math.max(this.state.speedKmh, currentSpeed * 3.6);
        if (speedKmh >= this.config.crashSpeedThresholdKmh) {
          this.forceCrash();
          vx = this.state.velocity.x;
          vz = this.state.velocity.z;
          currentSpeed = this.state.speedMs;
        } else {
          // Sub-threshold contact: deflect velocity outward along radial contact normal with 0.65 speed retention
          const retainedSpeed = currentSpeed * 0.65;
          vx = normX * retainedSpeed;
          vz = normZ * retainedSpeed;
          currentSpeed = retainedSpeed;
        }
      }
    }

    // 10. Update internal PlayerState
    this.state.position.x = newX;
    this.state.position.y = newY;
    this.state.position.z = newZ;
    this.state.velocity.x = vx;
    this.state.velocity.z = vz;
    this.state.speedMs = currentSpeed;
    this.state.speedKmh = currentSpeed * 3.6;
    this.state.altitudeMeters = Math.round(newY);
    this.state.distanceTraveledMeters += Math.hypot(newX - prevX, newZ - prevZ);

    // Synchronize cannon-es body & world step
    this.body.position.set(newX, newY, newZ);
    this.body.velocity.set(vx, this.state.velocity.y, vz);
    this.world.step(dt);

    this.lastJumpHeld = jumpHeld;
    return null;
  }

  public getState(): PlayerState {
    return {
      ...this.state,
      position: { ...this.state.position },
      velocity: { ...this.state.velocity },
    };
  }

  public forceCrash(): void {
    this.state.isCrashed = true;
    this.state.crashTimerSeconds = this.config.crashRecoverySeconds;
    this.state.jumpCharge = 0;
    this.state.spinRad = 0;
    this.state.stanceRad = 0;
    this.state.activeGrab = 'none';
    this.state.velocity.x *= 0.15;
    this.state.velocity.z *= 0.15;
    this.state.speedMs *= 0.15;
    this.state.speedKmh *= 0.15;
    this.body.velocity.x *= 0.15;
    this.body.velocity.z *= 0.15;
  }

  private buildInitialState(dropZone: DropZone): PlayerState {
    const spawnY = this.terrain.getHeightAt(dropZone.spawnPosition.x, dropZone.spawnPosition.z);
    const heading = dropZone.initialHeadingRad ?? 0;
    const pitch = this.terrain.getSlopePitchAt(dropZone.spawnPosition.x, dropZone.spawnPosition.z, heading);

    return {
      position: {
        x: dropZone.spawnPosition.x,
        y: spawnY,
        z: dropZone.spawnPosition.z,
      },
      velocity: { x: 0, y: 0, z: 0 },
      speedMs: 0,
      speedKmh: 0,
      headingRad: heading,
      pitchRad: pitch,
      rollRad: 0,
      carveAngleRad: 0,
      carveIntensity: 0,
      isGrounded: true,
      airtimeSeconds: 0,
      isCrashed: false,
      crashTimerSeconds: 0,
      altitudeMeters: Math.round(spawnY),
      distanceTraveledMeters: 0,
      activeDropZoneId: dropZone.id,
      jumpCharge: 0,
      spinRad: 0,
      stanceRad: 0,
      activeGrab: 'none',
    };
  }
}
