import * as THREE from 'three';
import { CameraState, GameConfig, PlayerState } from '../types';
import { DEFAULT_GAME_CONFIG } from '../config';
import { TerrainManager } from '../terrain/TerrainManager';

/**
 * [ADR-0006 / PR-1 B1: Right-Handed Screen-Space Steering Convention]
 *
 * Camera perspective and coordinate conventions:
 * - Downhill travel along the Whistler DEM corresponds to the +Z world axis.
 * - FollowCamera is positioned behind the rider (-Z relative to rider) looking toward +Z with up = +Y.
 * - In Three.js right-handed coordinates, looking forward (+Z) with up (+Y) yields camera-right = world -X:
 *     Camera Right = Forward x Up = (0, 0, 1) x (0, 1, 0) = (-1, 0, 0) [world -X].
 * - When the rider steers right (steer = +1), headingRad is decremented, directing the forward vector
 *   (sin(h), cos(h)) toward world -X, which projects to screen-right.
 */
export class FollowCamera {
  public readonly camera: THREE.PerspectiveCamera;
  public readonly config: GameConfig;
  public readonly terrain?: TerrainManager;

  private currentPosition: THREE.Vector3 = new THREE.Vector3();
  private currentLookAt: THREE.Vector3 = new THREE.Vector3();
  private targetPosition: THREE.Vector3 = new THREE.Vector3();
  private targetLookAt: THREE.Vector3 = new THREE.Vector3();
  private isInitialized: boolean = false;

  constructor(aspect: number, config: GameConfig = DEFAULT_GAME_CONFIG, terrain?: TerrainManager) {
    this.config = config;
    this.terrain = terrain;

    this.camera = new THREE.PerspectiveCamera(
      this.config.cameraBaseFov,
      aspect,
      0.1,
      2500
    );
    this.camera.name = 'follow_camera';
  }

  public snap(playerState: PlayerState): CameraState {
    const targetFov = this.computeTargets(playerState);
    this.currentPosition.copy(this.targetPosition);
    this.currentLookAt.copy(this.targetLookAt);
    this.camera.fov = targetFov;
    this.camera.position.copy(this.currentPosition);
    this.camera.lookAt(this.currentLookAt);
    this.camera.updateProjectionMatrix();
    this.isInitialized = true;
    return this.getState();
  }

  public update(playerState: PlayerState, dtSeconds: number): CameraState {
    const dt = Math.min(Math.max(0, dtSeconds), 0.1);
    const targetFov = this.computeTargets(playerState);

    const distSq = this.currentPosition.distanceToSquared(this.targetPosition);

    // Auto-snap if not initialized or if distance squared exceeds 2500 (50m)
    if (!this.isInitialized || distSq > 2500) {
      this.currentPosition.copy(this.targetPosition);
      this.currentLookAt.copy(this.targetLookAt);
      this.camera.fov = targetFov;
      this.isInitialized = true;
    } else {
      // Smooth tracking interpolation
      const lerpFactor = Math.min(1.0, (dt > 0 ? dt : 0.016) * 7.0);
      this.currentPosition.lerp(this.targetPosition, lerpFactor);
      this.currentLookAt.lerp(this.targetLookAt, lerpFactor);

      // Verify ground clearance after interpolation
      if (this.terrain) {
        const currentGroundH = this.terrain.getHeightAt(
          this.currentPosition.x,
          this.currentPosition.z
        );
        this.currentPosition.y = Math.max(this.currentPosition.y, currentGroundH + 1.5);
      }

      this.camera.fov += (targetFov - this.camera.fov) * lerpFactor;
    }

    this.camera.position.copy(this.currentPosition);
    this.camera.lookAt(this.currentLookAt);
    this.camera.updateProjectionMatrix();

    return this.getState();
  }

  public resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  public getState(): CameraState {
    return {
      position: {
        x: this.camera.position.x,
        y: this.camera.position.y,
        z: this.camera.position.z,
      },
      lookAt: {
        x: this.currentLookAt.x,
        y: this.currentLookAt.y,
        z: this.currentLookAt.z,
      },
      fov: this.camera.fov,
    };
  }

  private computeTargets(playerState: PlayerState): number {
    const speedRatio = Math.min(1.0, Math.max(0.0, playerState.speedKmh / this.config.maxSpeedKmh));
    const dist = this.config.cameraBaseDistance + speedRatio * 1.2;
    const height = this.config.cameraBaseHeight;

    const heading = playerState.headingRad;
    const targetCamX = playerState.position.x - Math.sin(heading) * dist;
    const targetCamZ = playerState.position.z - Math.cos(heading) * dist;

    // Pitch tilt downward on steep slopes
    const pitchOffset = Math.sin(playerState.pitchRad) * 0.7;
    let targetCamY = playerState.position.y + height + pitchOffset;

    // Terrain clearance clamping
    if (this.terrain) {
      const groundH = this.terrain.getHeightAt(targetCamX, targetCamZ);
      targetCamY = Math.max(targetCamY, groundH + 1.5);
    }

    // Look-at point slightly ahead of rider
    const targetLookAtX = playerState.position.x + Math.sin(heading) * 2.0;
    const targetLookAtY = playerState.position.y + 1.1;
    const targetLookAtZ = playerState.position.z + Math.cos(heading) * 2.0;

    const targetFov =
      this.config.cameraBaseFov + (this.config.cameraMaxFov - this.config.cameraBaseFov) * speedRatio;

    this.targetPosition.set(targetCamX, targetCamY, targetCamZ);
    this.targetLookAt.set(targetLookAtX, targetLookAtY, targetLookAtZ);

    return targetFov;
  }
}
