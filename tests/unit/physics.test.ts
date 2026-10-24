import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { TerrainManager } from '../../src/terrain/TerrainManager';
import { assembleTerrainData } from '../../src/terrain/glbPipeline';
import { PhysicsEngine } from '../../src/physics/PhysicsEngine';
import { PlayerController } from '../../src/player/PlayerController';
import { SnowboardCharacter } from '../../src/player/SnowboardCharacter';
import { FollowCamera } from '../../src/camera/FollowCamera';
import { DEFAULT_GAME_CONFIG } from '../../src/config';
import { PlayerInput, TerrainData, TerrainManifest } from '../../src/types';

// ─── Load real terrain fixtures from committed artifacts ──────────────

function loadRealTerrainData(): TerrainData {
  const raw = fs.readFileSync('public/assets/terrain/whistler-terrain.json', 'utf8');
  const manifest: TerrainManifest = JSON.parse(raw);
  const buf = fs.readFileSync('public/assets/terrain/whistler-dem.bin');
  const heights = new Float32Array(buf.buffer);
  return assembleTerrainData(manifest, heights);
}

describe('Physics, Character & Camera (Task 2)', () => {
  let terrain: TerrainManager;
  let physics: PhysicsEngine;

  const neutralInput: PlayerInput = {
    steer: 0,
    carve: 0,
    tuck: false,
    jumpHeld: false,
    reset: false,
  };

  let realDropZones: import('../../src/types').DropZone[];

  beforeEach(() => {
    terrain = new TerrainManager(loadRealTerrainData());
    // Sync config drop zones with terrain data so bottom-boundary reset
    // uses the real drop-zone spawn positions (PhysicsEngine uses config.dropZones for reset)
    realDropZones = terrain.terrainData.dropZones;
    physics = new PhysicsEngine(terrain, {
      ...DEFAULT_GAME_CONFIG,
      dropZones: realDropZones,
    });
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

  describe('Charge-and-Release Jump (ADR-0008)', () => {
    it('accumulates jumpCharge 0.0 -> 1.0 over jumpChargeMaxSeconds while jumpHeld + grounded, staying grounded while holding', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      const dt = 0.05;
      const steps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / dt);
      expect(steps).toBeGreaterThan(1);

      for (let i = 0; i < steps; i++) {
        physics.step(dt, { ...neutralInput, jumpHeld: true });
        // Holding a charge must NOT launch the rider; release is required (ADR-0008 rule 1).
        expect(physics.getState().isGrounded).toBe(true);
      }

      const state = physics.getState();
      expect(state.jumpCharge).toBeCloseTo(1.0, 1);
      expect(state.isGrounded).toBe(true);
    });

    it('launches on release with jumpMinImpulse on a brief tap (one hold step then release)', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      // Hold for a single short frame, then release.
      physics.step(0.016, { ...neutralInput, jumpHeld: true });
      expect(physics.getState().jumpCharge).toBeLessThan(0.1);
      expect(physics.getState().isGrounded).toBe(true);

      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      const launch = physics.getState();

      expect(launch.isGrounded).toBe(false);
      expect(launch.jumpCharge).toBe(0);
      // Absolute tolerance of 0.5 m/s (toBeCloseTo's 2nd arg is decimal digits, not tolerance).
      expect(Math.abs(launch.velocity.y - DEFAULT_GAME_CONFIG.jumpMinImpulse)).toBeLessThan(0.5);
    });

    it('launches on release with jumpMaxImpulse on a full charge and achieves 1.8-2.2s airtime (flat-spot launch)', () => {
      // Flat-spot launch: constant terrain height + zero pitch make the flight
      // purely ballistic (t = 2*vy/g = 2.0s), matching the documented
      // ADR-0008 strict rule 3 band of 1.8-2.2s exactly (no slope margin).
      const flatTerrain = new TerrainManager(loadRealTerrainData());
      const dropZone = flatTerrain.terrainData.dropZones[0];
      const flatY = flatTerrain.getHeightAt(dropZone.spawnPosition.x, dropZone.spawnPosition.z);
      (flatTerrain as any).getHeightAt = () => flatY;
      (flatTerrain as any).getSlopePitchAt = () => 0;
      (flatTerrain as any).checkObstacleCollision = () => null;

      const flatPhysics = new PhysicsEngine(flatTerrain, {
        ...DEFAULT_GAME_CONFIG,
        dropZones: [dropZone],
      });
      flatPhysics.resetAtDropZone(dropZone);

      const dt = 0.05;
      const steps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / dt);
      for (let i = 0; i < steps; i++) {
        flatPhysics.step(dt, { ...neutralInput, jumpHeld: true });
      }
      expect(flatPhysics.getState().jumpCharge).toBeCloseTo(1.0, 1);
      expect(flatPhysics.getState().isGrounded).toBe(true);

      // Release with a short step so gravity has minimal time to reduce vy before sampling.
      flatPhysics.step(0.016, { ...neutralInput, jumpHeld: false });
      const launch = flatPhysics.getState();
      expect(launch.isGrounded).toBe(false);
      // Absolute tolerance of 0.5 m/s (toBeCloseTo's 2nd arg is decimal digits, not tolerance).
      expect(Math.abs(launch.velocity.y - DEFAULT_GAME_CONFIG.jumpMaxImpulse)).toBeLessThan(0.5);

      let airtime = 0;
      while (!flatPhysics.getState().isGrounded && airtime < 5.0) {
        flatPhysics.step(dt, neutralInput);
        airtime += dt;
      }

      // ADR-0008 strict rule 3 / README §8.2/§8.7.4: full-charge air time 1.8-2.2s.
      expect(airtime).toBeGreaterThanOrEqual(1.8);
      expect(airtime).toBeLessThanOrEqual(2.2);
    });

    it('yields a longer airtime for a full charge than for a tap', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      const dt = 0.05;

      // Tap airtime
      physics.resetAtDropZone(dropZone);
      physics.step(0.016, { ...neutralInput, jumpHeld: true });
      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      let tapAirtime = 0;
      while (!physics.getState().isGrounded && tapAirtime < 5.0) {
        physics.step(dt, neutralInput);
        tapAirtime += dt;
      }

      // Full-charge airtime
      physics.resetAtDropZone(dropZone);
      const steps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / dt);
      for (let i = 0; i < steps; i++) {
        physics.step(dt, { ...neutralInput, jumpHeld: true });
      }
      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      let fullAirtime = 0;
      while (!physics.getState().isGrounded && fullAirtime < 5.0) {
        physics.step(dt, neutralInput);
        fullAirtime += dt;
      }

      expect(fullAirtime).toBeGreaterThan(tapAirtime);
    });

    it('applies a crouch steering penalty while jumpCharge > 0 (crouch heading change < 0.6x standing)', () => {
      const dropZone = terrain.terrainData.dropZones[0];

      // Standing steering over a fixed 0.1s window
      physics.resetAtDropZone(dropZone);
      const standingStart = physics.getState().headingRad;
      for (let i = 0; i < 2; i++) {
        physics.step(0.05, { ...neutralInput, steer: 1.0 });
      }
      const standingChange = Math.abs(physics.getState().headingRad - standingStart);
      expect(standingChange).toBeGreaterThan(0.1);

      // Crouched/charging steering over the identical 0.1s window
      physics.resetAtDropZone(dropZone);
      const crouchStart = physics.getState().headingRad;
      for (let i = 0; i < 2; i++) {
        physics.step(0.05, { ...neutralInput, steer: 1.0, jumpHeld: true });
      }
      const crouchChange = Math.abs(physics.getState().headingRad - crouchStart);

      // ADR-0008 rule 2: crouch authority ~0.4x; assert clearly below 0.6x.
      expect(crouchChange).toBeLessThan(standingChange * 0.6);
      expect(crouchChange).toBeGreaterThan(0);
    });

    it('requires a fresh Space press after landing — holding Space through touchdown never starts a new charge (ADR-0008 §1)', () => {
      // Flat-spot terrain keeps the full flight + post-landing ride deterministic
      // (no obstacles, no boundary resets).
      const flatTerrain = new TerrainManager(loadRealTerrainData());
      const dropZone = flatTerrain.terrainData.dropZones[0];
      const flatY = flatTerrain.getHeightAt(dropZone.spawnPosition.x, dropZone.spawnPosition.z);
      (flatTerrain as any).getHeightAt = () => flatY;
      (flatTerrain as any).getSlopePitchAt = () => 0;
      (flatTerrain as any).checkObstacleCollision = () => null;
      const flatPhysics = new PhysicsEngine(flatTerrain, {
        ...DEFAULT_GAME_CONFIG,
        dropZones: [dropZone],
      });
      flatPhysics.resetAtDropZone(dropZone);

      // Charge fully and launch.
      const chargeSteps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / 0.05);
      for (let i = 0; i < chargeSteps; i++) {
        flatPhysics.step(0.05, { ...neutralInput, jumpHeld: true });
      }
      flatPhysics.step(0.016, { ...neutralInput, jumpHeld: false });
      expect(flatPhysics.getState().isGrounded).toBe(false);

      // Re-press and HOLD Space mid-air; keep holding through touchdown and beyond.
      const holdInput: PlayerInput = { ...neutralInput, jumpHeld: true };
      let guard = 0;
      while (!flatPhysics.getState().isGrounded && guard++ < 200) {
        flatPhysics.step(0.05, holdInput);
      }
      expect(flatPhysics.getState().isGrounded).toBe(true);
      expect(flatPhysics.getState().isCrashed).toBe(false); // neutral landing = clean

      // Still held: no new charge may accumulate for a full second on the snow.
      for (let i = 0; i < 20; i++) {
        flatPhysics.step(0.05, holdInput);
        expect(flatPhysics.getState().jumpCharge).toBe(0);
        expect(flatPhysics.getState().isGrounded).toBe(true);
      }

      // Release then re-press: the fresh press charges normally.
      flatPhysics.step(0.05, { ...neutralInput, jumpHeld: false });
      flatPhysics.step(0.05, holdInput);
      expect(flatPhysics.getState().jumpCharge).toBeGreaterThan(0);
    });
  });

  describe('Air Control & Spin (ADR-0008)', () => {
    it('accumulates spinRad while airborne and steering at ~spinRateRadPerSec', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      // Full charge so the rider stays airborne for the whole 1.0s spin window.
      const steps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / 0.05);
      for (let i = 0; i < steps; i++) {
        physics.step(0.05, { ...neutralInput, jumpHeld: true });
      }
      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      expect(physics.getState().isGrounded).toBe(false);

      const spinInput: PlayerInput = { ...neutralInput, steer: 1.0 };
      for (let i = 0; i < 20; i++) {
        physics.step(0.05, spinInput);
      }

      const state = physics.getState();
      expect(state.isGrounded).toBe(false);
      // ~3.0 rad/s * ~1.0s. Allow a small integration margin.
      expect(state.spinRad).toBeGreaterThan(2.5);
      expect(state.spinRad).toBeLessThan(3.5);
    });

    it('freezes headingRad while airborne; A/D accumulates only spinRad at spinRateRadPerSec', () => {
      const dropZone = terrain.terrainData.dropZones[0];

      // Launch at full charge so the rider stays airborne for the whole steer window.
      physics.resetAtDropZone(dropZone);
      const chargeSteps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / 0.05);
      for (let i = 0; i < chargeSteps; i++) {
        physics.step(0.05, { ...neutralInput, jumpHeld: true });
      }
      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      expect(physics.getState().isGrounded).toBe(false);

      const frozenHeading = physics.getState().headingRad;
      const spinInput: PlayerInput = { ...neutralInput, steer: 1.0 };
      for (let i = 0; i < 20; i++) {
        physics.step(0.05, spinInput);
      }

      const state = physics.getState();
      expect(state.isGrounded).toBe(false);
      // ADR-0008 §4 / owner PR-4 comment / README §8.3: heading is FROZEN at its
      // takeoff value while airborne (exact equality — the frozen branch performs
      // no mutation); A/D drives spinRad only.
      expect(state.headingRad).toBe(frozenHeading);
      // ~spinRateRadPerSec (3.0 rad/s) over ~1.0s. Allow a small integration margin.
      expect(state.spinRad).toBeGreaterThan(2.5);
      expect(state.spinRad).toBeLessThan(3.5);
    });

    it('does not bank rollRad from A/D while airborne (roll target decays toward 0 in the air)', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      const chargeSteps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / 0.05);
      for (let i = 0; i < chargeSteps; i++) {
        physics.step(0.05, { ...neutralInput, jumpHeld: true });
      }
      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      expect(physics.getState().isGrounded).toBe(false);

      for (let i = 0; i < 10; i++) {
        physics.step(0.05, { ...neutralInput, steer: 1.0 });
      }

      // A/D in the air is a trick-spin input only; it must not bank the rider.
      expect(Math.abs(physics.getState().rollRad)).toBeLessThan(0.02);
      // Spin still accumulated normally during the same window.
      expect(physics.getState().spinRad).toBeGreaterThan(1.0);
    });

    it('keeps the follow camera locked behind the travel direction while spinning in the air (owner PR-4 comment)', () => {
      const dropZone = terrain.terrainData.dropZones[0]; // summit-express, initialHeadingRad = 0
      physics.resetAtDropZone(dropZone);

      const camera = new FollowCamera(16 / 9, DEFAULT_GAME_CONFIG, terrain);

      const chargeSteps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / 0.05);
      for (let i = 0; i < chargeSteps; i++) {
        physics.step(0.05, { ...neutralInput, jumpHeld: true });
      }
      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      expect(physics.getState().isGrounded).toBe(false);
      expect(physics.getState().headingRad).toBe(0);

      camera.snap(physics.getState());

      const spinInput: PlayerInput = { ...neutralInput, steer: 1.0 };
      for (let i = 0; i < 20 && !physics.getState().isGrounded; i++) {
        physics.step(0.05, spinInput);
        const player = physics.getState();
        const cam = camera.update(player, 0.05);
        // Heading frozen at 0 => straight +Z travel; no lateral camera swing.
        expect(player.headingRad).toBe(0);
        expect(Math.abs(cam.position.x - player.position.x)).toBeLessThan(0.25);
        // Look-at stays ahead of the rider along +Z, not swung sideways.
        expect(cam.lookAt.z).toBeGreaterThan(player.position.z);
        expect(Math.abs(cam.lookAt.x - player.position.x)).toBeLessThan(0.25);
      }

      // The rider actually spun during the window (trick input was live).
      expect(physics.getState().spinRad).toBeGreaterThan(1.0);
    });

    it('sets activeGrab = A on tuck while airborne and releases to none (no latching)', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      const chargeSteps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / 0.05);
      for (let i = 0; i < chargeSteps; i++) {
        physics.step(0.05, { ...neutralInput, jumpHeld: true });
      }
      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      expect(physics.getState().isGrounded).toBe(false);

      physics.step(0.05, { ...neutralInput, tuck: true });
      expect(physics.getState().activeGrab).toBe('A');

      physics.step(0.05, neutralInput);
      expect(physics.getState().activeGrab).toBe('none');
    });

    it('sets activeGrab = B on carve while airborne and releases to none (no latching)', () => {
      const dropZone = terrain.terrainData.dropZones[0];
      physics.resetAtDropZone(dropZone);

      const chargeSteps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / 0.05);
      for (let i = 0; i < chargeSteps; i++) {
        physics.step(0.05, { ...neutralInput, jumpHeld: true });
      }
      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      expect(physics.getState().isGrounded).toBe(false);

      physics.step(0.05, { ...neutralInput, carve: 1.0 });
      expect(physics.getState().activeGrab).toBe('B');

      physics.step(0.05, neutralInput);
      expect(physics.getState().activeGrab).toBe('none');
    });
  });

  describe('Trick Landing Evaluation (ADR-0008)', () => {
    /** Full-charge launch, returning once the rider is airborne with trick state initialised. */
    function launchFullCharge(): void {
      physics.resetAtDropZone(terrain.terrainData.dropZones[0]);
      const chargeSteps = Math.ceil(DEFAULT_GAME_CONFIG.jumpChargeMaxSeconds / 0.05);
      for (let i = 0; i < chargeSteps; i++) {
        physics.step(0.05, { ...neutralInput, jumpHeld: true });
      }
      physics.step(0.016, { ...neutralInput, jumpHeld: false });
      expect(physics.getState().isGrounded).toBe(false);
    }

    it('crashes when landing mid-rotation (spinRad = pi/2, outside tolerance)', () => {
      launchFullCharge();

      // Deterministically place the rider at 90 degrees of rotation mid-air.
      (physics as any).state.spinRad = Math.PI / 2;

      let guard = 0;
      while (!physics.getState().isGrounded && guard++ < 200) {
        physics.step(0.05, neutralInput);
      }

      const landState = physics.getState();
      expect(landState.isGrounded).toBe(true);
      expect(landState.isCrashed).toBe(true);
      expect(landState.spinRad).toBe(0);
    });

    it('does not crash and resets spinRad when landing aligned (spinRad = pi)', () => {
      launchFullCharge();

      // A 180-degree (pi) rotation is a valid milestone landing.
      (physics as any).state.spinRad = Math.PI;

      let guard = 0;
      while (!physics.getState().isGrounded && guard++ < 200) {
        physics.step(0.05, neutralInput);
      }

      const landState = physics.getState();
      expect(landState.isGrounded).toBe(true);
      expect(landState.isCrashed).toBe(false);
      expect(landState.spinRad).toBe(0);
      expect(landState.activeGrab).toBe('none');
    });

    it('crashes when landing while still holding a grab, even if rotation is aligned', () => {
      launchFullCharge();

      // Hold grab A all the way through touchdown.
      const grabInput: PlayerInput = { ...neutralInput, tuck: true };
      let sawGrab = false;
      let guard = 0;
      while (!physics.getState().isGrounded && guard++ < 200) {
        physics.step(0.05, grabInput);
        if (physics.getState().activeGrab === 'A') {
          sawGrab = true;
        }
      }

      expect(sawGrab).toBe(true);
      const landState = physics.getState();
      expect(landState.isGrounded).toBe(true);
      expect(landState.isCrashed).toBe(true);
    });

    it('does not crash when landing neutral (no spin, no grab)', () => {
      launchFullCharge();

      let guard = 0;
      while (!physics.getState().isGrounded && guard++ < 200) {
        physics.step(0.05, neutralInput);
      }

      const landState = physics.getState();
      expect(landState.isGrounded).toBe(true);
      expect(landState.isCrashed).toBe(false);
      expect(landState.spinRad).toBe(0);
      expect(landState.activeGrab).toBe('none');
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

      // Build a small forward velocity (a step or two from drop zone)
      for (let i = 0; i < 3; i++) {
        physics.step(0.05, neutralInput);
      }
      expect(physics.getState().speedKmh).toBeLessThan(DEFAULT_GAME_CONFIG.crashSpeedThresholdKmh);

      // Place rider just inside the obstacle and inject a small forward velocity
      (physics as any).state.position.x = obs.position.x + 0.1;
      (physics as any).state.position.y = obs.position.y;
      (physics as any).state.position.z = obs.position.z + 0.1;
      (physics as any).state.velocity = { x: 0, y: 0, z: 1.0 };
      (physics as any).state.speedMs = 1.0;
      (physics as any).state.speedKmh = 3.6;

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

      // Build forward speed >= 28 km/h with sufficient run-up for real terrain
      for (let i = 0; i < 40; i++) {
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
      expect(input.jumpHeld).toBe(false);
      expect(input.reset).toBe(false);
      controller.dispose();
    });

    it('applies programmatic input override correctly', () => {
      const controller = new PlayerController();
      controller.setOverride({ steer: -0.75, carve: 0.8, jumpHeld: true });

      const input = controller.getInput();
      expect(input.steer).toBe(-0.75);
      expect(input.carve).toBe(0.8);
      expect(input.jumpHeld).toBe(true);
      expect(input.tuck).toBe(false);

      controller.setOverride(null);
      const restored = controller.getInput();
      expect(restored.steer).toBe(0);
      expect(restored.carve).toBe(0);
      expect(restored.jumpHeld).toBe(false);
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

    it('keyboard Space is a continuous jumpHeld signal across multiple getInput() calls until keyup (ADR-0008)', () => {
      const controller = new PlayerController();

      // Trigger Space keydown
      (controller as any).handleKeyDown({ code: 'Space', preventDefault: () => {} });

      // Every frame while Space is held reports jumpHeld = true (no edge-trigger)
      const frame1 = controller.getInput();
      expect(frame1.jumpHeld).toBe(true);

      const frame2 = controller.getInput();
      expect(frame2.jumpHeld).toBe(true);

      const frame3 = controller.getInput();
      expect(frame3.jumpHeld).toBe(true);

      // Release Space key -> continuous signal drops
      (controller as any).handleKeyUp({ code: 'Space', preventDefault: () => {} });
      const frame4 = controller.getInput();
      expect(frame4.jumpHeld).toBe(false);

      // Press Space again -> held signal returns
      (controller as any).handleKeyDown({ code: 'Space', preventDefault: () => {} });
      const frame5 = controller.getInput();
      expect(frame5.jumpHeld).toBe(true);

      controller.dispose();
    });

    it('latches a sub-frame Space tap so it still yields one frame of jumpHeld (README §8.1 — input is never dead)', () => {
      const controller = new PlayerController();

      // keydown + keyup BOTH occur between two getInput() samples (a fast tap).
      (controller as any).handleKeyDown({ code: 'Space', preventDefault: () => {} });
      (controller as any).handleKeyUp({ code: 'Space' });

      // The tap must surface as exactly one frame of jumpHeld = true (minimal hop).
      expect(controller.getInput().jumpHeld).toBe(true);
      expect(controller.getInput().jumpHeld).toBe(false);

      controller.dispose();
    });

    it('polls the gamepad once per getInput() and folds button A into jumpHeld', () => {
      const controller = new PlayerController();
      let pollCount = 0;
      const fakePad = {
        connected: true,
        axes: [0, 0],
        buttons: Array.from({ length: 17 }, (_, i) => ({
          pressed: i === 0,
          value: i === 0 ? 1 : 0,
        })),
      };
      vi.stubGlobal('navigator', {
        getGamepads: () => {
          pollCount++;
          return [fakePad];
        },
      });
      try {
        const input = controller.getInput();
        expect(input.jumpHeld).toBe(true); // gamepad A (button 0) folded in
        expect(pollCount).toBe(1); // single merged poll per getInput()
      } finally {
        vi.unstubAllGlobals();
      }
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
