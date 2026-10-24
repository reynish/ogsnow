import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { SnowboardCharacter } from '../../src/player/SnowboardCharacter';
import { PlayerState } from '../../src/types';

function createMockPlayerState(overrides: Partial<PlayerState> = {}): PlayerState {
  return {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    speedMs: 0,
    speedKmh: 0,
    headingRad: 0,
    pitchRad: 0,
    rollRad: 0,
    carveAngleRad: 0,
    carveIntensity: 0,
    isGrounded: true,
    airtimeSeconds: 0,
    isCrashed: false,
    crashTimerSeconds: 0,
    altitudeMeters: 2000,
    distanceTraveledMeters: 0,
    activeDropZoneId: 'test',
    jumpCharge: 0,
    spinRad: 0,
    stanceRad: 0,
    activeGrab: 'none',
    ...overrides,
  };
}

describe('SnowboardCharacter Pose Interpolation (ADR-0008)', () => {
  let character: SnowboardCharacter;
  let mockState: PlayerState;

  // Private animatable meshes are promoted in the class but not exposed publicly;
  // tests read them via a narrow `any` cast, consistent with other unit tests.
  const meshes = (c: SnowboardCharacter) =>
    c as unknown as {
      torso: THREE.Mesh;
      hips: THREE.Mesh;
      frontArm: THREE.Mesh;
      backArm: THREE.Mesh;
    };

  beforeEach(() => {
    character = new SnowboardCharacter();
    mockState = createMockPlayerState();
  });

  it('exposes the public API (group, boardMesh, riderGroup, update)', () => {
    expect(character.group).toBeInstanceOf(THREE.Group);
    expect(character.boardMesh).toBeInstanceOf(THREE.Mesh);
    expect(character.riderGroup).toBeInstanceOf(THREE.Group);
    expect(typeof character.update).toBe('function');
  });

  it('updates without throwing on every pose state', () => {
    const states: Array<Partial<PlayerState>> = [
      {},
      { jumpCharge: 1 },
      { isGrounded: false, spinRad: Math.PI / 2 },
      { isGrounded: false, activeGrab: 'A' },
      { isGrounded: false, activeGrab: 'B' },
      { isCrashed: true, crashTimerSeconds: 1 },
    ];

    for (const override of states) {
      expect(() => character.update(createMockPlayerState(override), 0.05)).not.toThrow();
    }
  });

  it('lowers torso and hips as jumpCharge rises from 0.0 to 1.0 (crouch/wind-up)', () => {
    // dt = 0.1 makes the pose smoothing factor snap to target (k = min(1, dt * 12) = 1).
    character.update(createMockPlayerState({ jumpCharge: 0 }), 0.1);
    const torsoYNeutral = meshes(character).torso.position.y;
    const hipsYNeutral = meshes(character).hips.position.y;

    character.update(createMockPlayerState({ jumpCharge: 1 }), 0.1);
    const torsoYCharged = meshes(character).torso.position.y;
    const hipsYCharged = meshes(character).hips.position.y;

    expect(torsoYCharged).toBeLessThan(torsoYNeutral);
    expect(hipsYCharged).toBeLessThan(hipsYNeutral);
    // Targets drop torso by 0.2 and hips by 0.15 at full charge.
    expect(torsoYNeutral - torsoYCharged).toBeCloseTo(0.2, 2);
    expect(hipsYNeutral - hipsYCharged).toBeCloseTo(0.15, 2);
  });

  it('applies the airborne spin yaw (riderGroup.rotation.y tracks spinRad)', () => {
    character.update(mockState, 0.05);
    expect(character.riderGroup.rotation.y).toBeCloseTo(0, 2);

    character.update(createMockPlayerState({ isGrounded: false, spinRad: Math.PI }), 0.05);
    expect(character.riderGroup.rotation.y).toBeCloseTo(Math.PI, 3);

    character.update(createMockPlayerState({ isGrounded: false, spinRad: Math.PI / 2 }), 0.05);
    expect(character.riderGroup.rotation.y).toBeCloseTo(Math.PI / 2, 3);
  });

  it('eases the spin yaw back to the persistent stance yaw once grounded (stanceRad = 0 -> neutral)', () => {
    character.update(createMockPlayerState({ isGrounded: false, spinRad: Math.PI }), 0.05);
    expect(character.riderGroup.rotation.y).toBeCloseTo(Math.PI, 3);

    // Grounded update clears spinRad in state and eases rotation toward stanceRad (0 here).
    for (let i = 0; i < 20; i++) {
      character.update(createMockPlayerState({ isGrounded: true, spinRad: 0, stanceRad: 0 }), 0.05);
    }
    // Shortest-path ease converges on stance 0 modulo 2*pi (the representative may be 2*pi).
    const wrapped =
      ((character.riderGroup.rotation.y % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    expect(Math.min(wrapped, 2 * Math.PI - wrapped)).toBeLessThan(0.01);
  });

  it('persists switch stance while grounded: eases toward stanceRad = pi instead of unwinding to 0', () => {
    // Land a 180: last airborne frame renders stanceRad(0) + spinRad(pi), then the
    // grounded ease must converge on the NEW stance target (pi), not 0.
    character.update(createMockPlayerState({ isGrounded: false, stanceRad: 0, spinRad: Math.PI }), 0.05);
    expect(character.riderGroup.rotation.y).toBeCloseTo(Math.PI, 3);

    for (let i = 0; i < 20; i++) {
      character.update(createMockPlayerState({ isGrounded: true, stanceRad: Math.PI, spinRad: 0 }), 0.05);
    }
    expect(character.riderGroup.rotation.y).toBeCloseTo(Math.PI, 2);
  });

  it('applies airborne yaw as stanceRad + spinRad (spin starts from the persistent stance)', () => {
    character.update(
      createMockPlayerState({ isGrounded: false, stanceRad: Math.PI, spinRad: Math.PI / 2 }),
      0.05
    );
    expect(character.riderGroup.rotation.y).toBeCloseTo((3 * Math.PI) / 2, 3);
  });

  it('uses the shortest path when easing to the stance yaw (no full unwind after a landed 360)', () => {
    // Simulate the last airborne frame of a clean 360: visual yaw ~2*pi while the
    // persisted stance target is 0 (mod 2*pi). The shortest-path ease must decay
    // the residual near 2*pi -> 0, NOT rotate backwards through pi.
    character.update(
      createMockPlayerState({ isGrounded: false, stanceRad: 0, spinRad: 2 * Math.PI }),
      0.05
    );
    expect(character.riderGroup.rotation.y).toBeCloseTo(2 * Math.PI, 3);

    for (let i = 0; i < 40; i++) {
      character.update(createMockPlayerState({ isGrounded: true, stanceRad: 0, spinRad: 0 }), 0.05);
    }
    // Converged to the 2*pi representative of stance 0 (equivalent to 0 mod 2*pi).
    expect(character.riderGroup.rotation.y).toBeCloseTo(2 * Math.PI, 1);
  });

  it('poses grab A on the front arm, grab B on the back arm, and neutral arms when none', () => {
    // Neutral air pose
    character.update(createMockPlayerState({ isGrounded: false, activeGrab: 'none' }), 0.1);
    expect(meshes(character).frontArm.rotation.x).toBeCloseTo(0.4, 2);
    expect(meshes(character).backArm.rotation.x).toBeCloseTo(-0.4, 2);

    // Grab A: front arm reaches toward the board nose
    character.update(createMockPlayerState({ isGrounded: false, activeGrab: 'A' }), 0.1);
    expect(meshes(character).frontArm.rotation.x).toBeCloseTo(0.8, 2);
    expect(meshes(character).frontArm.rotation.z).toBeCloseTo(-0.6, 2);

    // Grab B: back arm reaches toward the board tail
    character.update(createMockPlayerState({ isGrounded: false, activeGrab: 'B' }), 0.1);
    expect(meshes(character).backArm.rotation.x).toBeCloseTo(-0.9, 2);
    expect(meshes(character).backArm.rotation.z).toBeCloseTo(0.7, 2);

    // Releasing the grab returns arms to neutral
    character.update(createMockPlayerState({ isGrounded: false, activeGrab: 'none' }), 0.1);
    expect(meshes(character).frontArm.rotation.x).toBeCloseTo(0.4, 2);
    expect(meshes(character).backArm.rotation.x).toBeCloseTo(-0.4, 2);
  });

  it('performs a clean landing squash and restores riderGroup.scale.y to 1.0', () => {
    // Airborne, then a clean touchdown.
    character.update(createMockPlayerState({ isGrounded: false }), 0.05);
    character.update(createMockPlayerState({ isGrounded: true, isCrashed: false }), 0.05);

    // Squash should visibly compress below 1.0 at some point during the animation.
    let minScale = 1;
    for (let i = 0; i < 6; i++) {
      character.update(createMockPlayerState({ isGrounded: true, isCrashed: false }), 0.05);
      minScale = Math.min(minScale, character.riderGroup.scale.y);
    }

    expect(minScale).toBeLessThan(1.0);
    // After the squash window elapses, the rider returns to normal scale.
    expect(character.riderGroup.scale.y).toBeCloseTo(1.0, 2);
  });
});
