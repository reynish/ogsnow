import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { TerrainManager } from '../../src/terrain/TerrainManager';
import { PhysicsEngine } from '../../src/physics/PhysicsEngine';
import { PlayerController } from '../../src/player/PlayerController';
import { SnowboardCharacter } from '../../src/player/SnowboardCharacter';
import { FollowCamera } from '../../src/camera/FollowCamera';
import { DEFAULT_GAME_CONFIG } from '../../src/config';
import { PlayerInput } from '../../src/types';

describe('Physics, Character & Camera (Task 2)', () => {
  let terrain: TerrainManager;
  let physics: PhysicsEngine;

  const neutralInput: PlayerInput = {
    steer: 0,
    carve: 0,
    tuck: false,
    jump: false,
    reset: false,
  };

  beforeEach(() => {
    terrain = new TerrainManager();
    physics = new PhysicsEngine(terrain);
  });

  describe('Downhill Slope Gravity & Acceleration', () => {
    it('accelerates speedKmh above 20 km/h and moves position.z downhill (+Z) when untouched for 3s', () => {
      const dropZone = terrain.terrainData.dropZones.find((d) => d.id === 'summit-express')!;
      expect(dropZone).toBeDefined();

      const initial = physics.resetAtDropZone(dropZone);
      expect(initial.speedKmh).toBe(0);
      expect(initial.position.z).toBe(dropZone.spawnPosition.z);

      // Simulate 3 seconds at dt = 0.05s (60 steps)
      const dt = 0.05;
      for (let i = 0; i < 60; i++) {
        physics.step(dt, neutralInput);
      }

      const finalState = physics.getState();

      // ADR-0003 Rule 1: speedKmh > 20 km/h
      expect(finalState.speedKmh).toBeGreaterThan(20.0);

      // Downhill along Whistler DEM is +Z (z increasing from -520 towards 0)
      expect(finalState.position.z).toBeGreaterThan(initial.position.z);

      // Altitude decreases as player descends
      expect(finalState.altitudeMeters).toBeLessThan(initial.altitudeMeters);

      // Remained grounded on continuous terrain
      expect(finalState.isGrounded).toBe(true);
      expect(finalState.distanceTraveledMeters).toBeGreaterThan(10.0);
    });

    it('tucking provides aerodynamic boost and achieves higher speed than upright riding', () => {
      const dropZone = terrain.terrainData.dropZones[0];

      // Run 1: Normal upright riding for 2.0s
      physics.resetAtDropZone(dropZone);
      for (let i = 0; i < 40; i++) {
        physics.step(0.05, neutralInput);
      }
      const normalSpeed = physics.getState().speedKmh;

      // Run 2: Tucking for 2.0s
      physics.resetAtDropZone(dropZone);
      const tuckInput: PlayerInput = { ...neutralInput, tuck: true };
      for (let i = 0; i < 40; i++) {
        physics.step(0.05, tuckInput);
      }
      const tuckedSpeed = physics.getState().speedKmh;

      expect(tuckedSpeed).toBeGreaterThan(normalSpeed);
    });

    it('clamps speed to maxSpeedKmh configuration', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      // Run excessive downhill simulation
      for (let i = 0; i < 300; i++) {
        physics.step(0.05, { ...neutralInput, tuck: true });
      }

      const state = physics.getState();
      expect(state.speedKmh).toBeLessThanOrEqual(DEFAULT_GAME_CONFIG.maxSpeedKmh + 0.1);
    });
  });

  describe('Steering & Yaw / Roll Rotation', () => {
    it('turns heading to the right, moves towards world -X, banks roll right, and projects to camera NDC x > 0 when steer = +1.0 (B1)', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      const initial = physics.resetAtDropZone(dropZone);
      const camera = new FollowCamera(16 / 9, DEFAULT_GAME_CONFIG, terrain);
      camera.snap(initial);

      const steerRightInput: PlayerInput = { ...neutralInput, steer: 1.0 };
      for (let i = 0; i < 15; i++) {
        physics.step(0.05, steerRightInput);
      }

      const state = physics.getState();
      expect(state.headingRad).toBeLessThan(dropZone.initialHeadingRad);
      expect(state.velocity.x).toBeLessThan(0); // world -X = screen right
      expect(state.rollRad).toBeGreaterThan(0.1); // Banking into turn

      camera.camera.updateMatrixWorld();
      const pointAhead = new THREE.Vector3(
        state.position.x + state.velocity.x,
        state.position.y + state.velocity.y,
        state.position.z + state.velocity.z
      );
      pointAhead.project(camera.camera);
      expect(pointAhead.x).toBeGreaterThan(0); // Camera NDC x > 0 (screen right)
    });

    it('turns heading to the left, moves towards world +X, banks roll left, and projects to camera NDC x < 0 when steer = -1.0 (B1)', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      const initial = physics.resetAtDropZone(dropZone);
      const camera = new FollowCamera(16 / 9, DEFAULT_GAME_CONFIG, terrain);
      camera.snap(initial);

      const steerLeftInput: PlayerInput = { ...neutralInput, steer: -1.0 };
      for (let i = 0; i < 15; i++) {
        physics.step(0.05, steerLeftInput);
      }

      const state = physics.getState();
      expect(state.headingRad).toBeGreaterThan(dropZone.initialHeadingRad);
      expect(state.velocity.x).toBeGreaterThan(0); // world +X = screen left
      expect(state.rollRad).toBeLessThan(-0.1); // Banking into turn

      camera.camera.updateMatrixWorld();
      const pointAhead = new THREE.Vector3(
        state.position.x + state.velocity.x,
        state.position.y + state.velocity.y,
        state.position.z + state.velocity.z
      );
      pointAhead.project(camera.camera);
      expect(pointAhead.x).toBeLessThan(0); // Camera NDC x < 0 (screen left)
    });
  });

  describe('Carving Deceleration & Carve Intensity', () => {
    it('carving with input.carve = 1.0 measurably reduces speed compared to unbraked riding and sets carveIntensity > 0.3', () => {
      const dropZone = terrain.terrainData.dropZones[0];

      // 1. Build initial momentum for 1.5s (30 steps)
      physics.resetAtDropZone(dropZone);
      for (let i = 0; i < 30; i++) {
        physics.step(0.05, neutralInput);
      }
      const speedAfterRunup = physics.getState().speedKmh;
      expect(speedAfterRunup).toBeGreaterThan(10.0);

      // Continue without carving for 1.5s
      for (let i = 0; i < 30; i++) {
        physics.step(0.05, neutralInput);
      }
      const unbrakedSpeed = physics.getState().speedKmh;

      // 2. Repeat with identical runup, then carve hard for 1.5s
      physics.resetAtDropZone(dropZone);
      for (let i = 0; i < 30; i++) {
        physics.step(0.05, neutralInput);
      }

      const carveInput: PlayerInput = { ...neutralInput, carve: 1.0 };
      for (let i = 0; i < 30; i++) {
        physics.step(0.05, carveInput);
      }
      const carvedState = physics.getState();

      // ADR-0003 Rule 2: Carving speed is measurably lower than unbraked riding
      expect(carvedState.speedKmh).toBeLessThan(unbrakedSpeed);

      // ADR-0003 Rule 2: carveIntensity > 0.3
      expect(carvedState.carveIntensity).toBeGreaterThan(0.3);

      // Carve angle should be active
      expect(carvedState.carveAngleRad).toBeGreaterThan(0.1);
    });
  });

  describe('Jumping & Airtime Tracking', () => {
    it('imparts upward jump impulse, sets isGrounded to false, and tracks airtimeSeconds until landing', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      // Build slight speed
      for (let i = 0; i < 10; i++) {
        physics.step(0.05, neutralInput);
      }
      expect(physics.getState().isGrounded).toBe(true);

      // Trigger jump
      const jumpInput: PlayerInput = { ...neutralInput, jump: true };
      const afterJump = physics.step(0.05, jumpInput);

      expect(afterJump.isGrounded).toBe(false);
      expect(afterJump.airtimeSeconds).toBeGreaterThan(0);

      // Let rider remain in air for several steps
      let maxAirtime = 0;
      let landed = false;
      for (let i = 0; i < 40; i++) {
        const s = physics.step(0.05, neutralInput);
        if (!s.isGrounded) {
          maxAirtime = Math.max(maxAirtime, s.airtimeSeconds);
        } else {
          landed = true;
          expect(s.airtimeSeconds).toBe(0); // Reset on landing
          break;
        }
      }

      expect(maxAirtime).toBeGreaterThan(0.1);
      expect(landed).toBe(true);
    });
  });

  describe('Obstacle Collisions & Crash Recovery (B4)', () => {
    it('sets isCrashed = true and reduces speed when forceCrash() is called, and auto-recovers after crashRecoverySeconds', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      // Build speed
      for (let i = 0; i < 20; i++) {
        physics.step(0.05, neutralInput);
      }
      const speedBefore = physics.getState().speedKmh;
      expect(speedBefore).toBeGreaterThan(5.0);

      // Force crash
      physics.forceCrash();
      const crashed = physics.getState();
      expect(crashed.isCrashed).toBe(true);
      expect(crashed.crashTimerSeconds).toBe(DEFAULT_GAME_CONFIG.crashRecoverySeconds);
      expect(crashed.speedKmh).toBeLessThan(speedBefore);

      // Step for 1.0 second (not yet recovered)
      for (let i = 0; i < 20; i++) {
        physics.step(0.05, neutralInput);
      }
      expect(physics.getState().isCrashed).toBe(true);

      // Step remaining 0.6 seconds (> 1.5s total recovery time)
      for (let i = 0; i < 12; i++) {
        physics.step(0.05, neutralInput);
      }

      // ADR-0003 Rule 3: Auto-recovers to isCrashed = false
      const recovered = physics.getState();
      expect(recovered.isCrashed).toBe(false);
      expect(recovered.crashTimerSeconds).toBe(0);
    });

    it('low-speed collision (< 28 km/h) deflects velocity radially outward and pushes rider outside obstacle radius without setting isCrashed = true (B4)', () => {
      const obs = terrain.terrainData.obstacles[0];
      expect(obs).toBeDefined();

      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      // Low speed: only 1 step (~2 km/h < 28 km/h)
      physics.step(0.05, neutralInput);
      expect(physics.getState().speedKmh).toBeLessThan(DEFAULT_GAME_CONFIG.crashSpeedThresholdKmh);

      // Place rider within collision radius of obstacle
      (physics as any).state.position.x = obs.position.x + 0.1;
      (physics as any).state.position.y = obs.position.y;
      (physics as any).state.position.z = obs.position.z + 0.1;

      const postStep = physics.step(0.05, neutralInput);

      // Low-speed contact deflects without triggering crash
      expect(postStep.isCrashed).toBe(false);

      // Pushed radially outside obstacle radius
      const distFromObs = Math.hypot(
        postStep.position.x - obs.position.x,
        postStep.position.z - obs.position.z
      );
      expect(distFromObs).toBeGreaterThanOrEqual(obs.radius);

      // Velocity deflected radially outward
      const dotRadial =
        postStep.velocity.x * (postStep.position.x - obs.position.x) +
        postStep.velocity.z * (postStep.position.z - obs.position.z);
      expect(dotRadial).toBeGreaterThan(0);
    });

    it('high-speed collision (>= 28 km/h) sets isCrashed = true, pushes rider outside obstacle radius, and decelerates during recovery (B4)', () => {
      const obs = terrain.terrainData.obstacles[0];
      expect(obs).toBeDefined();

      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      // Build forward speed >= 28 km/h
      for (let i = 0; i < 20; i++) {
        physics.step(0.05, { ...neutralInput, tuck: true });
      }
      expect(physics.getState().speedKmh).toBeGreaterThanOrEqual(DEFAULT_GAME_CONFIG.crashSpeedThresholdKmh);

      // Overwrite body position to obstacle boundary
      (physics as any).state.position.x = obs.position.x + 0.1;
      (physics as any).state.position.y = obs.position.y;
      (physics as any).state.position.z = obs.position.z + 0.1;

      // Step simulation
      const postStep = physics.step(0.05, neutralInput);
      expect(postStep.isCrashed).toBe(true);
      expect(postStep.crashTimerSeconds).toBeGreaterThan(0);
      expect(postStep.crashTimerSeconds).toBeLessThanOrEqual(DEFAULT_GAME_CONFIG.crashRecoverySeconds);

      // Rider pushed outside obstacle radius
      const distFromObs = Math.hypot(
        postStep.position.x - obs.position.x,
        postStep.position.z - obs.position.z
      );
      expect(distFromObs).toBeGreaterThanOrEqual(obs.radius);

      // During crash recovery, speedKmh decelerates rather than accelerating downhill under slope gravity
      let prevSpeed = postStep.speedKmh;
      for (let i = 0; i < 10; i++) {
        const recoverStep = physics.step(0.05, neutralInput);
        expect(recoverStep.speedKmh).toBeLessThanOrEqual(prevSpeed);
        prevSpeed = recoverStep.speedKmh;
      }
    });
  });

  describe('Boundary Handling (Lateral Clamping & Bottom Reset M12)', () => {
    it('clamps position.x within mountain boundary width', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      const halfW = terrain.terrainData.width / 2;

      // Force lateral position past boundary
      (physics as any).state.position.x = halfW + 50;
      (physics as any).state.velocity.x = 20;

      const state = physics.step(0.05, neutralInput);
      expect(state.position.x).toBeLessThanOrEqual(halfW - 8);
    });

    it('cleanly resets rider back to the active drop zone upon reaching bottom boundary (z >= length / 2 - 15) (M12)', () => {
      const dropZone = terrain.terrainData.dropZones[1]; // harmony-ridge
      physics.resetAtDropZone(dropZone);

      const halfLength = terrain.terrainData.length / 2;
      // Position rider at/past bottom boundary
      (physics as any).state.position.z = halfLength - 14;

      const resetState = physics.step(0.05, neutralInput);
      expect(resetState.position.x).toBe(dropZone.spawnPosition.x);
      expect(resetState.position.z).toBe(dropZone.spawnPosition.z);
      expect(resetState.activeDropZoneId).toBe(dropZone.id);
      expect(resetState.speedKmh).toBe(0);
    });
  });

  describe('PlayerController', () => {
    it('returns default neutral input with no key pressed', () => {
      const controller = new PlayerController();
      const input = controller.getInput();
      expect(input.steer).toBe(0);
      expect(input.carve).toBe(0);
      expect(input.tuck).toBe(false);
      expect(input.jump).toBe(false);
      expect(input.reset).toBe(false);
      controller.dispose();
    });

    it('applies programmatic input override correctly', () => {
      const controller = new PlayerController();
      controller.setOverride({ steer: -0.75, carve: 0.8, jump: true });

      const input = controller.getInput();
      expect(input.steer).toBe(-0.75);
      expect(input.carve).toBe(0.8);
      expect(input.jump).toBe(true);
      expect(input.tuck).toBe(false);

      controller.setOverride(null);
      const restored = controller.getInput();
      expect(restored.steer).toBe(0);
      expect(restored.carve).toBe(0);
      controller.dispose();
    });

    it('clearResetFlag resets reset state', () => {
      const controller = new PlayerController();
      controller.setOverride({ reset: true });
      expect(controller.getInput().reset).toBe(true);

      controller.clearResetFlag();
      expect(controller.getInput().reset).toBe(false);
      controller.dispose();
    });

    it('keyboard Space jump is edge-triggered across multiple getInput() calls until keyup (M2)', () => {
      const controller = new PlayerController();

      // Trigger Space keydown
      (controller as any).handleKeyDown({ code: 'Space', preventDefault: () => {} });

      // First frame receives jump = true
      const frame1 = controller.getInput();
      expect(frame1.jump).toBe(true);

      // Subsequent frames while holding Space return jump = false
      const frame2 = controller.getInput();
      expect(frame2.jump).toBe(false);

      const frame3 = controller.getInput();
      expect(frame3.jump).toBe(false);

      // Release Space key
      (controller as any).handleKeyUp({ code: 'Space', preventDefault: () => {} });
      const frame4 = controller.getInput();
      expect(frame4.jump).toBe(false);

      // Press Space again -> new rising edge
      (controller as any).handleKeyDown({ code: 'Space', preventDefault: () => {} });
      const frame5 = controller.getInput();
      expect(frame5.jump).toBe(true);

      controller.dispose();
    });
  });

  describe('SnowboardCharacter', () => {
    it('constructs low-poly snowboarder with boardMesh, riderGroup, and spray particles', () => {
      const character = new SnowboardCharacter();
      expect(character.group).toBeDefined();
      expect(character.boardMesh).toBeDefined();
      expect(character.riderGroup).toBeDefined();

      const dropZone = terrain.terrainData.dropZones[0];
      const initial = physics.resetAtDropZone(dropZone);

      // Verify update runs cleanly without throwing
      expect(() => character.update(initial, 0.05)).not.toThrow();

      // Group position matches player position
      expect(character.group.position.x).toBe(initial.position.x);
      expect(character.group.position.y).toBe(initial.position.y);
      expect(character.group.position.z).toBe(initial.position.z);
    });

    it('applies wipeout rotation when player is crashed', () => {
      const character = new SnowboardCharacter();
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);
      physics.forceCrash();

      character.update(physics.getState(), 0.05);
      expect(character.riderGroup.rotation.z).toBeGreaterThan(0.5);
    });
  });

  describe('FollowCamera', () => {
    it('tracks behind player and responds to speed changes with dynamic FOV', () => {
      const camera = new FollowCamera(16 / 9, DEFAULT_GAME_CONFIG, terrain);
      expect(camera.camera).toBeDefined();
      expect(camera.camera.fov).toBe(DEFAULT_GAME_CONFIG.cameraBaseFov);

      const dropZone = terrain.terrainData.dropZones[0];
      const state0 = physics.resetAtDropZone(dropZone);

      const camState0 = camera.update(state0, 0.05);
      expect(camState0.position.z).toBeLessThan(state0.position.z); // Behind player along +Z
      expect(camState0.position.y).toBeGreaterThan(state0.position.y); // Above player
      expect(camState0.fov).toBeCloseTo(DEFAULT_GAME_CONFIG.cameraBaseFov, 0);

      // Simulate high speed
      (state0 as any).speedKmh = 100.0;
      const camStateHighSpeed = camera.update(state0, 0.5);
      expect(camStateHighSpeed.fov).toBeGreaterThan(DEFAULT_GAME_CONFIG.cameraBaseFov + 5);

      // Resize test
      camera.resize(4 / 3);
      expect(camera.camera.aspect).toBeCloseTo(4 / 3, 2);
    });

    it('enforces terrain clearance so camera does not clip through ground', () => {
      const camera = new FollowCamera(16 / 9, DEFAULT_GAME_CONFIG, terrain);
      const dropZone = terrain.terrainData.dropZones[0];
      const state = physics.resetAtDropZone(dropZone);

      const camState = camera.update(state, 0.05);
      const groundAtCam = terrain.getHeightAt(camState.position.x, camState.position.z);
      expect(camState.position.y).toBeGreaterThanOrEqual(groundAtCam + 1.49);
    });
  });
});
