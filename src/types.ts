export type GameMode = 'menu' | 'riding' | 'paused' | 'error';

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

export interface GeoOrigin {
  latitudeDeg: number;
  longitudeDeg: number;
  downhillAzimuthDeg: number;
}

export interface PinnedTile {
  z: number;
  x: number;
  y: number;
}

export interface SampledControlPoint {
  id: string;
  row: number;
  col: number;
  x: number;
  z: number;
  latDeg: number;
  lonDeg: number;
  tileZ: number;
  tileX: number;
  tileY: number;
  px: number;
  py: number;
  elevationM: number;
}

export interface TerrainTileRecord {
  z: number;
  x: number;
  y: number;
  url: string;
  sha256: string;
}

export interface TerrainSourceMetadata {
  provider: 'aws-terrarium' | 'copernicus-glo30';
  zoom: number;
  tiles: TerrainTileRecord[];
  minElevationM: number;
  maxElevationM: number;
}

export interface TerrainDerivation {
  algorithmVersion: number;
  seed: number;
  treeLineElevationM: number;
  dropZoneCount: number;
  obstacleCount: number;
}

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
  treeLineElevationM?: number;
  dropZones?: DropZone[];
  obstacles?: TerrainObstacle[];
  derivation?: TerrainDerivation;
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
  // ---- Iteration 2 OPTIONAL provenance extensions (ADR-0007) ----
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
  tuck: boolean;          // true when leaning forward for speed (W / ArrowUp); mid-air = grab A
  jumpHeld: boolean;      // true while Space (or gamepad A) is held down (continuous hold, not edge-triggered) — ADR-0008
  reset: boolean;         // true when reset to drop-zone requested (R)
}

export interface PlayerState {
  position: Vector3Like;
  velocity: Vector3Like;
  speedMs: number;          // Speed in meters/second
  speedKmh: number;         // Speed in km/h (speedMs * 3.6)
  headingRad: number;       // Yaw angle in radians (0 = +Z downhill; negative heading = world -X = screen right)
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
  // ---- Iteration 3 charge-jump & trick fields (ADR-0008) ----
  jumpCharge: number;       // 0.0 to 1.0 charge accumulated while jumpHeld + grounded; reset on release/launch/crash
  spinRad: number;          // Accumulated mid-air spin yaw in radians (independent of headingRad); reset on touchdown
  activeGrab: 'none' | 'A' | 'B'; // Mid-air grab pose: 'A' = indy/method (W), 'B' = melon/tail (S), 'none' = not grabbing
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
  jumpImpulse: number;                  // DEPRECATED (Iteration 3): replaced by jumpMinImpulse/jumpMaxImpulse
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
  attribution?: string[];
  // ---- Iteration 3 NEW charge-jump & trick config fields (ADR-0008) ----
  jumpChargeMaxSeconds: number;         // duration to charge from 0.0 to 1.0 (e.g. 0.5 s)
  jumpMinImpulse: number;               // vertical impulse for minimal tap (e.g. 4.5 m/s)
  jumpMaxImpulse: number;               // vertical impulse for full charge (e.g. 14.0 m/s)
  crouchSteerRateMultiplier: number;    // effective steering rate while jumpCharge > 0 (e.g. 0.4 = 40% of normal)
  spinRateRadPerSec: number;            // spin accumulation rate while airborne (e.g. 3.0 rad/s)
  landAlignmentToleranceRad: number;    // tolerance for clean trick landing vs crash (e.g. π/3 = 60°)
}

export interface OGSnowGlobalState {
  ready?: boolean;
  webglActive?: boolean;
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
