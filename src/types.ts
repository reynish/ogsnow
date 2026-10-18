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
