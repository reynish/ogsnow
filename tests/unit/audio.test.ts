import { describe, it, expect, beforeEach } from 'vitest';
import { JungleAudioEngine } from '../../src/audio/JungleAudioEngine';
import { DEFAULT_GAME_CONFIG } from '../../src/config';
import { PlayerState } from '../../src/types';

function createMockPlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    position: { x: 0, y: 2000, z: -500 },
    velocity: { x: 0, y: 0, z: 10 },
    speedMs: 5.0,
    speedKmh: 18.0,
    headingRad: 0.0,
    pitchRad: -0.15,
    rollRad: 0.0,
    carveAngleRad: 0.0,
    carveIntensity: 0.0,
    isGrounded: true,
    airtimeSeconds: 0.0,
    isCrashed: false,
    crashTimerSeconds: 0.0,
    altitudeMeters: 2000,
    distanceTraveledMeters: 50,
    activeDropZoneId: 'summit-express',
    ...overrides,
  };
}

describe('JungleAudioEngine', () => {
  let engine: JungleAudioEngine;

  beforeEach(() => {
    engine = new JungleAudioEngine(DEFAULT_GAME_CONFIG);
  });

  describe('Adaptive Stem Progression (ADR-0004)', () => {
    it('rule 1: at speedKmh = 0 (rest), activeStems is [pad], bassGain is 0, drumGain is 0', () => {
      const state = engine.update(createMockPlayerState({ speedKmh: 0, speedMs: 0 }), 0.016);

      expect(state.activeStems).toEqual(['pad']);
      expect(state.bassGain).toBe(0);
      expect(state.drumGain).toBe(0);
      expect(state.padGain).toBeGreaterThan(0.3);
      expect(state.padGain).toBeLessThanOrEqual(0.7);
    });

    it('below bassFadeInSpeedKmh (e.g. 10 km/h), remains [pad] only', () => {
      const state = engine.update(createMockPlayerState({ speedKmh: 10 }), 0.016);

      expect(state.activeStems).toEqual(['pad']);
      expect(state.bassGain).toBe(0);
      expect(state.drumGain).toBe(0);
    });

    it('rule 2: at speedKmh = 22, activeStems is [pad, bass], bassGain > 0, drumGain is 0', () => {
      const state = engine.update(createMockPlayerState({ speedKmh: 22 }), 0.016);

      expect(state.activeStems).toEqual(['pad', 'bass']);
      expect(state.bassGain).toBeGreaterThan(0);
      expect(state.drumGain).toBe(0);
      expect(state.padGain).toBeGreaterThan(0);
    });

    it('rule 3: at speedKmh >= 60, activeStems is [pad, bass, drums], padGain > 0, bassGain > 0.5, drumGain >= 0.8', () => {
      const state = engine.update(createMockPlayerState({ speedKmh: 65 }), 0.016);

      expect(state.activeStems).toEqual(['pad', 'bass', 'drums']);
      expect(state.padGain).toBeGreaterThan(0);
      expect(state.bassGain).toBeGreaterThan(0.5);
      expect(state.drumGain).toBeGreaterThanOrEqual(0.8);
    });

    it('at peak speed (100 km/h), drumGain reaches max (1.0)', () => {
      const state = engine.update(createMockPlayerState({ speedKmh: 100 }), 0.016);

      expect(state.activeStems).toEqual(['pad', 'bass', 'drums']);
      expect(state.drumGain).toBe(1.0);
      expect(state.bassGain).toBe(0.85);
    });
  });

  describe('Crash Ducking (ADR-0004 Rule 4)', () => {
    it('when isCrashed is true, ducks immediately to [pad] with bassGain=0 and drumGain=0 even at high speed', () => {
      // First get to high speed
      engine.update(createMockPlayerState({ speedKmh: 75, isCrashed: false }), 0.016);

      // Now crash
      const crashedState = engine.update(
        createMockPlayerState({ speedKmh: 75, isCrashed: true }),
        0.016
      );

      expect(crashedState.activeStems).toEqual(['pad']);
      expect(crashedState.bassGain).toBe(0);
      expect(crashedState.drumGain).toBe(0);
      expect(crashedState.padGain).toBeGreaterThan(0.5); // Pad swells on crash
      expect(crashedState.carveGain).toBe(0);
    });
  });

  describe('Wind SFX Scaling', () => {
    it('windGain scales from base at rest to higher gain at speed', () => {
      const restState = engine.update(createMockPlayerState({ speedKmh: 0 }), 0.016);
      const mediumState = engine.update(createMockPlayerState({ speedKmh: 45 }), 0.016);
      const fastState = engine.update(createMockPlayerState({ speedKmh: 115 }), 0.016);

      expect(restState.windGain).toBeCloseTo(0.02, 2);
      expect(mediumState.windGain).toBeGreaterThan(restState.windGain);
      expect(fastState.windGain).toBeGreaterThan(mediumState.windGain);
      expect(fastState.windGain).toBeCloseTo(0.65, 2);
    });

    it('windFrequencyHz scales from 220Hz at rest to 1400Hz at max speed', () => {
      const restState = engine.update(createMockPlayerState({ speedKmh: 0 }), 0.016);
      const fastState = engine.update(createMockPlayerState({ speedKmh: 115 }), 0.016);

      expect(restState.windFrequencyHz).toBeCloseTo(220, 1);
      expect(fastState.windFrequencyHz).toBeCloseTo(1400, 1);
    });
  });

  describe('Snow Carve SFX Scaling (ADR-0004 Rule 5)', () => {
    it('rule 5: when isGrounded is false (airborne), carveGain is exactly 0', () => {
      const airborne = engine.update(
        createMockPlayerState({
          speedKmh: 50,
          carveIntensity: 0.8,
          isGrounded: false,
          airtimeSeconds: 1.2,
        }),
        0.016
      );

      expect(airborne.carveGain).toBe(0);
    });

    it('when grounded, carveGain scales with carveIntensity and speed', () => {
      const lightCarve = engine.update(
        createMockPlayerState({
          speedKmh: 40,
          carveIntensity: 0.1,
          isGrounded: true,
        }),
        0.016
      );

      const hardCarve = engine.update(
        createMockPlayerState({
          speedKmh: 40,
          carveIntensity: 0.9,
          isGrounded: true,
        }),
        0.016
      );

      expect(hardCarve.carveGain).toBeGreaterThan(lightCarve.carveGain);
      expect(hardCarve.carveFrequencyHz).toBeGreaterThan(lightCarve.carveFrequencyHz);
    });

    it('when speed is under 3 km/h, carveGain is 0', () => {
      const creeping = engine.update(
        createMockPlayerState({
          speedKmh: 2.0,
          carveIntensity: 1.0,
          isGrounded: true,
        }),
        0.016
      );

      expect(creeping.carveGain).toBe(0);
    });
  });

  describe('Mute and State Management', () => {
    it('setMuted toggles isMuted flag', () => {
      expect(engine.getState().isMuted).toBe(false);

      engine.setMuted(true);
      expect(engine.getState().isMuted).toBe(true);

      engine.setMuted(false);
      expect(engine.getState().isMuted).toBe(false);
    });

    it('initialization marks isInitialized to true', async () => {
      await engine.init();
      expect(engine.getState().isInitialized).toBe(true);
    });

    it('dispose can be called safely without errors', () => {
      expect(() => engine.dispose()).not.toThrow();
    });
  });
});
