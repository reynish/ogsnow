import * as THREE from 'three';
import { GameConfig, GameMode, OGSnowGlobalState, PlayerInput, PlayerState } from './types';
import { DEFAULT_GAME_CONFIG } from './config';
import { TerrainManager } from './terrain/TerrainManager';
import { PhysicsEngine } from './physics/PhysicsEngine';
import { PlayerController } from './player/PlayerController';
import { SnowboardCharacter } from './player/SnowboardCharacter';
import { FollowCamera } from './camera/FollowCamera';
import { JungleAudioEngine } from './audio/JungleAudioEngine';
import { HUDManager } from './ui/HUDManager';

export class GameApp {
  public readonly config: GameConfig;
  public readonly scene: THREE.Scene;
  public renderer: THREE.WebGLRenderer | null = null;
  public canvas: HTMLCanvasElement | null = null;
  public uiContainer: HTMLElement | null = null;

  public terrain: TerrainManager;
  public physics: PhysicsEngine;
  public controller: PlayerController;
  public character: SnowboardCharacter;
  public camera: FollowCamera;
  public audio: JungleAudioEngine;
  public hud: HUDManager | null = null;

  public mode: GameMode = 'menu';
  public activeDropZoneId: string;
  public frameCount: number = 0;
  public elapsedSeconds: number = 0;

  // [ADR-0006 / PR-1 B2, M4] Initialization readiness and simulation pause state
  private isReady: boolean = false;
  private initPromise: Promise<void> | null = null;
  private isSimulationPaused: boolean = false;

  private animationFrameId: number | null = null;
  private onKeyDownBound: (e: KeyboardEvent) => void;
  private onResizeBound: () => void;

  constructor(customConfig?: GameConfig, customCanvas?: HTMLCanvasElement, customUI?: HTMLElement) {
    this.config = customConfig ?? DEFAULT_GAME_CONFIG;
    this.activeDropZoneId = this.config.dropZones[0]?.id ?? 'summit-express';

    // 1. Setup Three.js Scene with PS1 Alpine Sky and Fog
    this.scene = new THREE.Scene();
    this.scene.name = 'og_snow_scene';
    this.scene.background = new THREE.Color(0x8cb8de);
    this.scene.fog = new THREE.FogExp2(0x8cb8de, 0.0022);

    // Directional Sunlight & Sky/Ground Ambient Lighting
    const ambientLight = new THREE.HemisphereLight(0xffffff, 0x446688, 0.85);
    ambientLight.name = 'alpine_ambient_light';
    this.scene.add(ambientLight);

    const sunLight = new THREE.DirectionalLight(0xfffaed, 1.25);
    sunLight.name = 'alpine_sun_light';
    sunLight.position.set(120, 280, 140);
    this.scene.add(sunLight);

    // 2. Initialize Subsystems
    this.terrain = new TerrainManager();
    this.scene.add(this.terrain.rootGroup);

    this.physics = new PhysicsEngine(this.terrain, this.config);
    this.controller = new PlayerController();

    this.character = new SnowboardCharacter();
    this.scene.add(this.character.group);

    const aspect = typeof window !== 'undefined' ? window.innerWidth / window.innerHeight : 16 / 9;
    this.camera = new FollowCamera(aspect, this.config, this.terrain);

    this.audio = new JungleAudioEngine(this.config);

    // 3. Resolve Canvas & UI Container
    if (typeof document !== 'undefined') {
      this.canvas = customCanvas ?? (document.getElementById('game-canvas') as HTMLCanvasElement);
      this.uiContainer = customUI ?? document.getElementById('ui-container');
    }

    // 4. Initialize WebGL Renderer with Resilient Headless Fallback
    if (this.canvas) {
      try {
        this.renderer = new THREE.WebGLRenderer({
          canvas: this.canvas,
          antialias: true,
          powerPreference: 'high-performance',
        });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      } catch (err) {
        console.warn('WebGLRenderer unavailable, running with headless fallback context:', err);
        this.renderer = null;
      }
    }

    // 5. Initialize HUD Manager
    if (this.uiContainer) {
      this.hud = new HUDManager(this.uiContainer, this.config, {
        onSelectDropZone: (dropZoneId: string) => {
          this.dropIn(dropZoneId);
        },
        onReturnToMenu: () => {
          this.returnToMenu();
        },
        onToggleMute: () => {
          this.toggleMute();
        },
      });
    }

    // 6. Bind Event Listeners
    this.onKeyDownBound = this.handleKeyDown.bind(this);
    this.onResizeBound = this.handleResize.bind(this);

    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', this.onKeyDownBound);
      window.addEventListener('resize', this.onResizeBound);
    }

    // Expose window API bridge immediately
    this.registerGlobalBridge();
  }

  // [ADR-0006 / PR-1 B2] Idempotent init flow avoiding drop-in overwrite
  public async init(): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const defaultDz =
        this.config.dropZones.find((dz) => dz.id === this.activeDropZoneId) ??
        this.config.dropZones[0];

      // Load .glb terrain model
      try {
        await this.terrain.initialize('./assets/whistler-peak.glb');
      } catch (err) {
        console.warn('Failed to load terrain GLB during init:', err);
      }

      // [ADR-0006 / PR-1 B2] Only reset player to defaultDz and HUD to menu if mode is still menu
      // (if dropIn was already called while GLB was loading, do not overwrite mode back to 'menu')
      if (this.mode === 'menu') {
        this.physics.resetAtDropZone(defaultDz);
        const playerState = this.physics.getState();

        this.character.update(playerState, 0);
        this.camera.update(playerState, 0);
        const audioState = this.audio.update(playerState, 0);

        if (this.hud) {
          this.hud.setMode('menu', defaultDz.id);
          this.hud.update(playerState, audioState);
        }
      }

      this.isReady = true;
      this.syncGlobalState();
      this.startLoop();
    })();

    return this.initPromise;
  }

  // [ADR-0006 / PR-1 B2] Idempotent drop-in flow with camera snap and state readiness
  public async dropIn(dropZoneId: string): Promise<void> {
    const dropZone =
      this.config.dropZones.find((dz) => dz.id === dropZoneId) ?? this.config.dropZones[0];

    this.activeDropZoneId = dropZone.id;
    this.mode = 'riding';

    try {
      await this.terrain.initialize('./assets/whistler-peak.glb');
    } catch (err) {
      console.warn('Failed to load terrain GLB during dropIn:', err);
    }

    this.physics.resetAtDropZone(dropZone);
    const playerState = this.physics.getState();

    this.character.update(playerState, 0);
    // [ADR-0006 / PR-1 B2] Snap camera immediately on drop-in with snap dt = 1.0
    this.camera.update(playerState, 1.0);

    try {
      await this.audio.init();
    } catch {
      // Browser autoplay policy gating
    }

    const audioState = this.audio.update(playerState, 0);

    if (this.hud) {
      this.hud.setMode('riding', dropZone.id);
      this.hud.update(playerState, audioState);
    }

    this.isReady = true;
    this.syncGlobalState();
  }

  // [ADR-0006 / PR-1 M3] Menu audio ducking immediately on returnToMenu
  public returnToMenu(): void {
    this.mode = 'menu';
    const menuPlayerState: PlayerState = {
      ...this.physics.getState(),
      speedMs: 0,
      speedKmh: 0,
      carveIntensity: 0,
      isGrounded: true,
      isCrashed: false,
    };
    const audioState = this.audio.update(menuPlayerState, 0);
    if (this.hud) {
      this.hud.setMode('menu', this.activeDropZoneId);
      this.hud.update(menuPlayerState, audioState);
    }
    this.syncGlobalState();
  }

  public toggleMute(): void {
    const currentMuted = this.audio.getState().isMuted;
    this.audio.setMuted(!currentMuted);
    const playerState = this.physics.getState();
    const audioState = this.audio.getState();
    if (this.hud) {
      this.hud.update(playerState, audioState);
    }
    this.syncGlobalState();
  }

  public triggerCrashForTest(): void {
    this.physics.forceCrash();
    const playerState = this.physics.getState();
    this.character.update(playerState, 0.016);
    const audioState = this.audio.update(playerState, 0.016);
    if (this.hud) {
      this.hud.update(playerState, audioState);
    }
    this.syncGlobalState();
  }

  // [ADR-0006 / PR-1 M4] Deterministic stepping with single-step override restore
  public stepSimulation(dtSeconds: number, overrideInput?: Partial<PlayerInput>): void {
    const prevOverride =
      overrideInput !== undefined
        ? (this.controller as unknown as { override: Partial<PlayerInput> | null }).override
          ? { ...(this.controller as unknown as { override: Partial<PlayerInput> | null }).override }
          : null
        : null;

    if (overrideInput !== undefined) {
      this.controller.setOverride(overrideInput);
    }

    try {
      const input = this.controller.getInput();

      if (input.reset) {
        const currentDz =
          this.config.dropZones.find((dz) => dz.id === this.activeDropZoneId) ??
          this.config.dropZones[0];
        this.physics.resetAtDropZone(currentDz);
        this.controller.clearResetFlag();
      } else {
        this.physics.step(dtSeconds, input);
      }

      const playerState = this.physics.getState();
      this.character.update(playerState, dtSeconds);
      this.camera.update(playerState, dtSeconds);
      const audioState = this.audio.update(playerState, dtSeconds);

      if (this.hud) {
        this.hud.update(playerState, audioState);
      }

      if (this.renderer) {
        this.renderer.render(this.scene, this.camera.camera);
      }

      this.frameCount++;
      this.elapsedSeconds += dtSeconds;
      this.syncGlobalState();
    } finally {
      if (overrideInput !== undefined) {
        this.controller.setOverride(prevOverride);
      }
    }
  }

  // [ADR-0006 / PR-1 B2] Global state synchronizer
  public syncGlobalState(): void {
    this.publishState();
  }

  // [ADR-0006 / PR-1 M7] Include ready and webglActive in global state telemetry
  public publishState(): void {
    if (typeof window === 'undefined') return;

    const playerState = this.physics.getState();
    const audioState = this.audio.getState();
    const cameraState = this.camera.getState();

    const state = {
      mode: this.mode,
      mountainName: this.config.mountainName,
      activeDropZoneId: this.activeDropZoneId,
      frameCount: this.frameCount,
      elapsedSeconds: this.elapsedSeconds,
      ready: this.isReady,
      webglActive: this.renderer !== null,
      player: playerState,
      audio: audioState,
      camera: cameraState,
      terrain: {
        mountainId: this.terrain.terrainData.mountainId,
        width: this.terrain.terrainData.width,
        length: this.terrain.terrainData.length,
        obstacleCount: this.terrain.terrainData.obstacles.length,
        glbLoaded: this.terrain.terrainData.glbLoaded,
        glbByteLength: this.terrain.glbByteLength,
      },
    };

    window.__OGSNOW_STATE__ = state as unknown as OGSnowGlobalState;
  }

  public dispose(): void {
    if (this.animationFrameId !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    if (typeof window !== 'undefined') {
      window.removeEventListener('keydown', this.onKeyDownBound);
      window.removeEventListener('resize', this.onResizeBound);
    }

    this.controller.dispose();
    this.audio.dispose();

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
  }

  private registerGlobalBridge(): void {
    if (typeof window === 'undefined') return;

    // [ADR-0006 / PR-1 M4] Expose setPaused on window.__OGSNOW_APP__ for deterministic E2E test stepping
    (window as unknown as { __OGSNOW_APP__: Record<string, unknown> }).__OGSNOW_APP__ = {
      dropIn: (dropZoneId: string) => {
        this.dropIn(dropZoneId);
      },
      returnToMenu: () => {
        this.returnToMenu();
      },
      stepSimulation: (dtSeconds: number, overrideInput?: Partial<PlayerInput>) => {
        this.stepSimulation(dtSeconds, overrideInput);
      },
      setInputOverride: (overrideInput: Partial<PlayerInput> | null) => {
        this.controller.setOverride(overrideInput);
      },
      triggerCrashForTest: () => {
        this.triggerCrashForTest();
      },
      setPaused: (paused: boolean) => {
        this.isSimulationPaused = paused;
      },
    };

    this.syncGlobalState();
  }

  // [ADR-0006 / PR-1 M3, M4] Discrete simulation tick called by rAF loop
  public tick(dtSeconds: number): void {
    if (this.mode === 'riding' && !this.isSimulationPaused) {
      this.stepSimulation(dtSeconds);
    } else {
      this.frameCount++;
      this.elapsedSeconds += dtSeconds;

      if (this.mode === 'menu') {
        // [ADR-0006 / PR-1 M3] Keep audio ducked in menu tick so drums and bass smoothly duck back to ['pad']
        const menuPlayerState: PlayerState = {
          ...this.physics.getState(),
          speedMs: 0,
          speedKmh: 0,
          carveIntensity: 0,
          isGrounded: true,
          isCrashed: false,
        };
        const audioState = this.audio.update(menuPlayerState, dtSeconds);
        if (this.hud) {
          this.hud.update(menuPlayerState, audioState);
        }
      }

      if (this.renderer) {
        this.renderer.render(this.scene, this.camera.camera);
      }
      this.syncGlobalState();
    }
  }

  private startLoop(): void {
    if (typeof requestAnimationFrame === 'undefined') {
      return;
    }

    let lastTimestamp = performance.now();

    const frame = (timestamp: number) => {
      this.animationFrameId = requestAnimationFrame(frame);
      const dt = Math.min((timestamp - lastTimestamp) / 1000, 0.05);
      lastTimestamp = timestamp;

      this.tick(dt);
    };

    this.animationFrameId = requestAnimationFrame(frame);
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (e.code === 'KeyM') {
      this.toggleMute();
    } else if (e.code === 'Escape') {
      this.returnToMenu();
    }
  }

  private handleResize(): void {
    if (typeof window === 'undefined') return;
    const width = window.innerWidth;
    const height = window.innerHeight;

    if (this.renderer) {
      this.renderer.setSize(width, height);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    }

    this.camera.resize(width / height);
  }
}

// Bootstrap application on page load
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    const app = new GameApp();
    app.init().catch((err) => {
      console.error('Failed to initialize ogSnow GameApp:', err);
    });
  });
}
