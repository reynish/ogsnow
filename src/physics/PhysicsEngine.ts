import * as CANNON from 'cannon-es';
import { GameConfig, PlayerInput, PlayerState, DropZone, Vector3Like } from '../types';
import { DEFAULT_GAME_CONFIG } from '../config';
import { TerrainManager } from '../terrain/TerrainManager';

export class PhysicsEngine {
  public readonly config: GameConfig;
  public readonly terrain: TerrainManager;
  public readonly world: CANNON.World;
  public readonly body: CANNON.Body;

  private state: PlayerState;

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
    this.body.position.set(this.state.position.x, this.state.position.y, this.state.position.z);
    this.body.velocity.set(0, 0, 0);
    return this.getState();
  }

  public step(dtSeconds: number, input: PlayerInput): PlayerState {
    const dt = Math.min(Math.max(0, dtSeconds), 0.05);
    if (dt <= 0) {
      return this.getState();
    }

    // Handle crash recovery timer
    if (this.state.isCrashed) {
      this.state.crashTimerSeconds -= dt;
      if (this.state.crashTimerSeconds <= 0) {
        this.state.isCrashed = false;
        this.state.crashTimerSeconds = 0;
      }
    }

    // Restrict controls while crashed
    const effectiveInput: PlayerInput = this.state.isCrashed
      ? { steer: 0, carve: 0, tuck: false, jump: false, reset: false }
      : input;

    // 1. Steering & Heading Yaw
    if (this.state.isGrounded && !this.state.isCrashed) {
      this.state.headingRad += effectiveInput.steer * this.config.steerRateRadPerSec * dt;
      while (this.state.headingRad > Math.PI) this.state.headingRad -= 2 * Math.PI;
      while (this.state.headingRad < -Math.PI) this.state.headingRad += 2 * Math.PI;
    }

    // 2. Slope pitch at current coordinates along heading
    const pitch = this.terrain.getSlopePitchAt(
      this.state.position.x,
      this.state.position.z,
      this.state.headingRad
    );
    this.state.pitchRad = pitch;

    // 3. Roll angle (board bank)
    const targetRoll =
      effectiveInput.steer * 0.35 +
      (effectiveInput.carve > 0 && effectiveInput.steer !== 0
        ? Math.sign(effectiveInput.steer) * 0.2
        : 0);
    this.state.rollRad += (targetRoll - this.state.rollRad) * Math.min(1.0, dt * 10);

    // 4. Jump trigger
    if (effectiveInput.jump && this.state.isGrounded && !this.state.isCrashed) {
      this.state.isGrounded = false;
      this.state.velocity.y = this.config.jumpImpulse;
      this.state.airtimeSeconds = 0;
    }

    // 5. Carve Intensity & Angle
    const fwdX = Math.sin(this.state.headingRad);
    const fwdZ = Math.cos(this.state.headingRad);

    let vx = this.state.velocity.x;
    let vz = this.state.velocity.z;
    let currentSpeed = Math.hypot(vx, vz);

    if (currentSpeed > 0.05) {
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
    if (this.state.isGrounded) {
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
    } else {
      // Airborne kinematics
      this.state.airtimeSeconds += dt;
      this.state.velocity.y -= this.config.gravity * dt;

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
        // Touchdown landing
        newY = terrainY;
        this.state.isGrounded = true;
        this.state.airtimeSeconds = 0;
        this.state.velocity.y = 0;
      }
    }

    // 8. Lateral & Runout Boundary Clamping
    const halfWidth = this.terrain.terrainData.width / 2;
    const halfLength = this.terrain.terrainData.length / 2;

    if (newX < -halfWidth + 8) {
      newX = -halfWidth + 8;
      vx = Math.abs(vx) * 0.4;
    } else if (newX > halfWidth - 8) {
      newX = halfWidth - 8;
      vx = -Math.abs(vx) * 0.4;
    }

    if (newZ > halfLength - 10) {
      newZ = halfLength - 10;
      vz *= 0.5;
    }

    // 9. Obstacle Collision Detection
    const collisionPos: Vector3Like = { x: newX, y: newY, z: newZ };
    const obstacleHit = this.terrain.checkObstacleCollision(collisionPos, 1.1);

    if (obstacleHit && !this.state.isCrashed) {
      this.forceCrash();
      vx = this.state.velocity.x;
      vz = this.state.velocity.z;
      currentSpeed = Math.hypot(vx, vz);
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

    return this.getState();
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
    this.state.velocity.x *= 0.15;
    this.state.velocity.z *= 0.15;
    this.state.speedMs *= 0.15;
    this.state.speedKmh *= 0.15;
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
    };
  }
}
