import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

  it('loads rider.glb with valid bind-space silhouette (minY >= 0.0, maxY >= 1.5, < 2000 tris), non-colliding bone aliases, and non-compounding crouch', async () => {
    const glbPath = path.resolve(process.cwd(), 'public/assets/character/rider.glb');
    expect(fs.existsSync(glbPath)).toBe(true);
    const buf = fs.readFileSync(glbPath);
    const arrayBuffer = new Uint8Array(buf).buffer;

    const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
    const loader = new GLTFLoader();
    const gltf = await new Promise<any>((resolve, reject) => {
      loader.parse(arrayBuffer, '', resolve, reject);
    });

    // Verify skinned bounding box at bind pose spans minY >= 0.0 and maxY >= 1.5 and < 2000 triangles
    gltf.scene.updateMatrixWorld(true);
    const bindBox = new THREE.Box3();
    const v = new THREE.Vector3();
    let totalTris = 0;

    gltf.scene.traverse((obj: any) => {
      if (obj.isSkinnedMesh) {
        const sm = obj as THREE.SkinnedMesh;
        sm.skeleton.update();
        const pos = sm.geometry.attributes.position;
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i);
          sm.applyBoneTransform(i, v);
          v.applyMatrix4(sm.matrixWorld);
          bindBox.expandByPoint(v);
        }
        totalTris += sm.geometry.index ? sm.geometry.index.count / 3 : pos.count / 3;
      }
    });

    expect(totalTris).toBeGreaterThan(200);
    expect(totalTris).toBeLessThan(2000);
    expect(bindBox.min.y).toBeGreaterThanOrEqual(0.0);
    expect(bindBox.max.y).toBeGreaterThanOrEqual(1.5);
    // Sideways snowboard stance spans front (+0.35) and back (-0.35) bindings along Z
    expect(bindBox.min.z).toBeLessThan(-0.35);
    expect(bindBox.max.z).toBeGreaterThan(0.35);

    // Inject parsed gltf into SnowboardCharacter via mocked GLTFLoader.prototype.loadAsync
    const origLoadAsync = GLTFLoader.prototype.loadAsync;
    GLTFLoader.prototype.loadAsync = async () => gltf;
    try {
      const glbChar = new SnowboardCharacter();
      await new Promise((r) => setTimeout(r, 20));

      const internal = glbChar as any;
      expect(internal.glbLoaded).toBe(true);

      // Verify bone aliases did not overwrite parents with children
      expect(internal.boneMap.get('Spine')?.name).toBe('Spine');
      expect(internal.boneMap.get('Chest')?.name).toBe('Chest');
      expect(internal.boneMap.get('RightLeg')?.name).toBe('RightUpLeg');
      expect(internal.boneMap.get('LeftLeg')?.name).toBe('LeftUpLeg');
      expect(internal.boneMap.get('RightArm')?.name).toBe('RightUpperArm');
      expect(internal.boneMap.get('LeftArm')?.name).toBe('LeftUpperArm');

      // Verify hierarchical crouch dips Hips.position.y and leans Spine.rotation.x without translating Spine.position.y
      const spineBaseY = internal.torso.position.y;
      const hipsBaseY = internal.hips.position.y;
      const spineBaseRotX = internal.torso.rotation.x;

      glbChar.update(createMockPlayerState({ jumpCharge: 1 }), 0.1);
      expect(internal.hips.position.y).toBeCloseTo(hipsBaseY - 0.15, 3);
      expect(internal.torso.position.y).toBeCloseTo(spineBaseY, 5);
      expect(internal.torso.rotation.x).toBeCloseTo(spineBaseRotX + 0.3, 3);

      // Verify reset() restores original bone states using canonical bone names
      glbChar.reset();
      expect(internal.hips.position.y).toBeCloseTo(hipsBaseY, 5);
      expect(internal.torso.rotation.x).toBeCloseTo(spineBaseRotX, 5);
    } finally {
      GLTFLoader.prototype.loadAsync = origLoadAsync;
    }
  });

  describe('Board & Bindings Lockstep Yaw Coupling (ADR-0009 §7.1, Compliance Rule 6)', () => {
    it('rotates boardGroup in lockstep with riderGroup across airborne spins and grounded switch stance', () => {
      // 1. Airborne 90° spin
      character.update(createMockPlayerState({ isGrounded: false, spinRad: Math.PI / 2, stanceRad: 0 }), 0.05);
      expect(character.riderGroup.rotation.y).toBeCloseTo(Math.PI / 2, 3);
      expect(character.boardGroup.rotation.y).toBeCloseTo(character.riderGroup.rotation.y, 4);

      // 2. Airborne 180° spin
      character.update(createMockPlayerState({ isGrounded: false, spinRad: Math.PI, stanceRad: 0 }), 0.05);
      expect(character.riderGroup.rotation.y).toBeCloseTo(Math.PI, 3);
      expect(character.boardGroup.rotation.y).toBeCloseTo(character.riderGroup.rotation.y, 4);

      // 3. Grounded switch stance (stanceRad = Math.PI, spinRad = 0)
      for (let i = 0; i < 20; i++) {
        character.update(createMockPlayerState({ isGrounded: true, stanceRad: Math.PI, spinRad: 0 }), 0.05);
      }
      expect(character.riderGroup.rotation.y).toBeCloseTo(Math.PI, 2);
      expect(character.boardGroup.rotation.y).toBeCloseTo(character.riderGroup.rotation.y, 4);
    });

    it('transforms front and back bindings in lockstep with rider stance yaw instead of staying fixed at yaw 0', () => {
      // At yaw = 0 (neutral)
      character.update(createMockPlayerState({ isGrounded: false, spinRad: 0, stanceRad: 0 }), 0.1);
      character.boardGroup.updateMatrix();
      const frontPos0 = new THREE.Vector3(0, 0.04, 0.35).applyMatrix4(character.boardGroup.matrix);
      const backPos0 = new THREE.Vector3(0, 0.04, -0.35).applyMatrix4(character.boardGroup.matrix);
      expect(frontPos0.x).toBeCloseTo(0, 3);
      expect(frontPos0.z).toBeCloseTo(0.35, 3);
      expect(backPos0.x).toBeCloseTo(0, 3);
      expect(backPos0.z).toBeCloseTo(-0.35, 3);

      // At yaw = Math.PI / 2 (airborne 90° spin): x' = 0.35 * sin(PI/2) = 0.35, z' = 0.35 * cos(PI/2) = 0
      character.update(createMockPlayerState({ isGrounded: false, spinRad: Math.PI / 2, stanceRad: 0 }), 0.1);
      character.boardGroup.updateMatrix();
      const frontPos90 = new THREE.Vector3(0, 0.04, 0.35).applyMatrix4(character.boardGroup.matrix);
      const backPos90 = new THREE.Vector3(0, 0.04, -0.35).applyMatrix4(character.boardGroup.matrix);
      expect(frontPos90.x).toBeCloseTo(0.35, 2);
      expect(frontPos90.z).toBeCloseTo(0, 2);
      expect(backPos90.x).toBeCloseTo(-0.35, 2);
      expect(backPos90.z).toBeCloseTo(0, 2);
      // Front binding has rotated significantly away from yaw 0 (x was 0, now 0.35; z was 0.35, now 0)
      expect(Math.abs(frontPos90.x - frontPos0.x)).toBeGreaterThan(0.3);

      // At yaw = Math.PI (switch stance / 180° spin): front binding rotates to z ≈ -0.35
      character.update(createMockPlayerState({ isGrounded: false, spinRad: Math.PI, stanceRad: 0 }), 0.1);
      character.boardGroup.updateMatrix();
      const frontPos180 = new THREE.Vector3(0, 0.04, 0.35).applyMatrix4(character.boardGroup.matrix);
      const backPos180 = new THREE.Vector3(0, 0.04, -0.35).applyMatrix4(character.boardGroup.matrix);
      expect(frontPos180.x).toBeCloseTo(0, 2);
      expect(frontPos180.z).toBeCloseTo(-0.35, 2);
      expect(backPos180.x).toBeCloseTo(0, 2);
      expect(backPos180.z).toBeCloseTo(0.35, 2);
    });
  });

  describe('Authentic 3D Sideways Bind Pose & Joint Flex in rider.glb (ADR-0009 §7.2, Compliance Rule 8)', () => {
    it('verifies rider.glb bind pose geometry, hips height/yaw, 3D knee flex, torso hinge, and downhill head', async () => {
      const glbPath = path.resolve(process.cwd(), 'public/assets/character/rider.glb');
      expect(fs.existsSync(glbPath)).toBe(true);
      const buf = fs.readFileSync(glbPath);
      const arrayBuffer = new Uint8Array(buf).buffer;

      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const gltf = await new Promise<any>((resolve, reject) => {
        loader.parse(arrayBuffer, '', resolve, reject);
      });

      gltf.scene.updateMatrixWorld(true);

      const loadedBones: Record<string, THREE.Bone> = {};
      const bindBox = new THREE.Box3();
      const v = new THREE.Vector3();
      let totalTris = 0;

      gltf.scene.traverse((obj: any) => {
        if (obj.isBone) {
          loadedBones[obj.name] = obj;
        }
        if (obj.isSkinnedMesh) {
          const sm = obj as THREE.SkinnedMesh;
          sm.skeleton.update();
          const pos = sm.geometry.attributes.position;
          for (let i = 0; i < pos.count; i++) {
            v.fromBufferAttribute(pos, i);
            sm.applyBoneTransform(i, v);
            v.applyMatrix4(sm.matrixWorld);
            bindBox.expandByPoint(v);
          }
          totalTris += sm.geometry.index ? sm.geometry.index.count / 3 : pos.count / 3;
        }
      });

      // 1. Poly count & bind box
      expect(totalTris).toBeLessThan(2000);
      expect(bindBox.min.y).toBeGreaterThanOrEqual(0.0);
      expect(bindBox.max.y).toBeGreaterThanOrEqual(1.42);

      // 2. Hips position and sideways rotation
      const hips = loadedBones['Hips'];
      expect(hips).toBeDefined();
      const hipsWorldPos = hips.getWorldPosition(new THREE.Vector3());
      const hipsWorldQuat = hips.getWorldQuaternion(new THREE.Quaternion());
      const hipsWorldEuler = new THREE.Euler().setFromQuaternion(hipsWorldQuat, 'YXZ');

      expect(hipsWorldPos.y).toBeGreaterThanOrEqual(0.50);
      expect(hipsWorldPos.y).toBeLessThanOrEqual(0.62);
      expect(hipsWorldEuler.y).toBeGreaterThanOrEqual(1.20);

      // 3. Genuine 3D knee flex: x >= 0.08, y in [0.26, 0.36], offset >= 0.08, bend >= 0.50 rad
      const leftUpLeg = loadedBones['LeftUpLeg'];
      const leftLeg = loadedBones['LeftLeg'];
      const rightUpLeg = loadedBones['RightUpLeg'];
      const rightLeg = loadedBones['RightLeg'];

      expect(leftUpLeg).toBeDefined();
      expect(leftLeg).toBeDefined();
      expect(rightUpLeg).toBeDefined();
      expect(rightLeg).toBeDefined();

      const leftHip = leftUpLeg.getWorldPosition(new THREE.Vector3());
      const leftKnee = leftLeg.getWorldPosition(new THREE.Vector3());
      const leftAnkle = new THREE.Vector3(0, -0.2802, 0).applyMatrix4(leftLeg.matrixWorld);

      const rightHip = rightUpLeg.getWorldPosition(new THREE.Vector3());
      const rightKnee = rightLeg.getWorldPosition(new THREE.Vector3());
      const rightAnkle = new THREE.Vector3(0, -0.2802, 0).applyMatrix4(rightLeg.matrixWorld);

      // Left Knee checks
      expect(leftKnee.x).toBeGreaterThanOrEqual(0.08);
      expect(leftKnee.y).toBeGreaterThanOrEqual(0.26);
      expect(leftKnee.y).toBeLessThanOrEqual(0.36);

      const haL = leftAnkle.clone().sub(leftHip);
      const hkL = leftKnee.clone().sub(leftHip);
      const projL = hkL.dot(haL.clone().normalize());
      const perpOffsetL = hkL.clone().sub(haL.clone().normalize().multiplyScalar(projL)).length();
      expect(perpOffsetL).toBeGreaterThanOrEqual(0.08);

      const thighVecL = leftKnee.clone().sub(leftHip).normalize();
      const shinVecL = leftAnkle.clone().sub(leftKnee).normalize();
      const kneeBendL = thighVecL.angleTo(shinVecL);
      expect(kneeBendL).toBeGreaterThanOrEqual(0.50);

      // Right Knee checks
      expect(rightKnee.x).toBeGreaterThanOrEqual(0.08);
      expect(rightKnee.y).toBeGreaterThanOrEqual(0.26);
      expect(rightKnee.y).toBeLessThanOrEqual(0.36);

      const haR = rightAnkle.clone().sub(rightHip);
      const hkR = rightKnee.clone().sub(rightHip);
      const projR = hkR.dot(haR.clone().normalize());
      const perpOffsetR = hkR.clone().sub(haR.clone().normalize().multiplyScalar(projR)).length();
      expect(perpOffsetR).toBeGreaterThanOrEqual(0.08);

      const thighVecR = rightKnee.clone().sub(rightHip).normalize();
      const shinVecR = rightAnkle.clone().sub(rightKnee).normalize();
      const kneeBendR = thighVecR.angleTo(shinVecR);
      expect(kneeBendR).toBeGreaterThanOrEqual(0.50);

      // 4. Spine and Chest forward athletic bend
      const spine = loadedBones['Spine'];
      const chest = loadedBones['Chest'];
      expect(spine).toBeDefined();
      expect(chest).toBeDefined();
      expect(spine.rotation.x).toBeGreaterThan(0.10);
      expect(chest.rotation.x).toBeGreaterThan(0.10);

      // 5. Head counter-rotates toward downhill (+Z)
      const head = loadedBones['Head'];
      expect(head).toBeDefined();
      const headQuat = head.getWorldQuaternion(new THREE.Quaternion());
      const headForward = new THREE.Vector3(0, 0, 1).applyQuaternion(headQuat);
      const hipsForward = new THREE.Vector3(0, 0, 1).applyQuaternion(hipsWorldQuat);
      expect(headForward.z).toBeGreaterThan(0.70);
      expect(headForward.z).toBeGreaterThan(hipsForward.z);

      // 6. Both elbows exhibit 3D elbow bend angle >= 0.50 rad
      const leftUpperArm = loadedBones['LeftUpperArm'];
      const leftLowerArm = loadedBones['LeftLowerArm'];
      const rightUpperArm = loadedBones['RightUpperArm'];
      const rightLowerArm = loadedBones['RightLowerArm'];

      expect(leftUpperArm).toBeDefined();
      expect(leftLowerArm).toBeDefined();
      expect(rightUpperArm).toBeDefined();
      expect(rightLowerArm).toBeDefined();

      const leftShoulder = leftUpperArm.getWorldPosition(new THREE.Vector3());
      const leftElbow = leftLowerArm.getWorldPosition(new THREE.Vector3());
      const leftHand = new THREE.Vector3(0, -0.24, 0).applyMatrix4(leftLowerArm.matrixWorld);
      const leftArmVec = leftElbow.clone().sub(leftShoulder).normalize();
      const leftForearmVec = leftHand.clone().sub(leftElbow).normalize();
      const leftElbowBend = leftArmVec.angleTo(leftForearmVec);
      expect(leftElbowBend).toBeGreaterThanOrEqual(0.50);

      const rightShoulder = rightUpperArm.getWorldPosition(new THREE.Vector3());
      const rightElbow = rightLowerArm.getWorldPosition(new THREE.Vector3());
      const rightHand = new THREE.Vector3(0, -0.24, 0).applyMatrix4(rightLowerArm.matrixWorld);
      const rightArmVec = rightElbow.clone().sub(rightShoulder).normalize();
      const rightForearmVec = rightHand.clone().sub(rightElbow).normalize();
      const rightElbowBend = rightArmVec.angleTo(rightForearmVec);
      expect(rightElbowBend).toBeGreaterThanOrEqual(0.50);
    });
  });

  describe('Foot-Anchored 2-Bone Leg IK & 12-Bone Articulation (ADR-0009 §7.3, Compliance Rule 7 & 9)', () => {
    it('articulates all 12 bones and keeps ankles anchored to bindings without sinking below y = 0 across all riding and air trick poses', async () => {
      const glbPath = path.resolve(process.cwd(), 'public/assets/character/rider.glb');
      const buf = fs.readFileSync(glbPath);
      const arrayBuffer = new Uint8Array(buf).buffer;

      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const gltf = await new Promise<any>((resolve, reject) => {
        loader.parse(arrayBuffer, '', resolve, reject);
      });

      const origLoadAsync = GLTFLoader.prototype.loadAsync;
      GLTFLoader.prototype.loadAsync = async () => gltf;

      try {
        const glbChar = new SnowboardCharacter();
        await new Promise((r) => setTimeout(r, 20));

        const internal = glbChar as any;
        expect(internal.glbLoaded).toBe(true);

        const canonicalBones = [
          'Hips', 'Spine', 'Chest', 'Head',
          'RightLeg', 'RightLowerLeg', 'LeftLeg', 'LeftLowerLeg',
          'RightArm', 'RightLowerArm', 'LeftArm', 'LeftLowerArm'
        ];

        // 1. All 12 canonical bones are mapped and non-null
        for (const boneName of canonicalBones) {
          const bone = internal.boneMap.get(boneName);
          expect(bone, `Expected canonical bone ${boneName} to be mapped`).toBeDefined();
          expect(bone).not.toBeNull();
        }

        const testStates: Array<{ name: string; state: Partial<PlayerState> }> = [
          { name: 'Neutral riding', state: { jumpCharge: 0, isGrounded: true } },
          { name: 'Full crouch', state: { jumpCharge: 1.0, isGrounded: true } },
          { name: 'Heavy carve', state: { carveIntensity: 1.0, rollRad: 0.4, isGrounded: true } },
          { name: 'Airborne Grab A', state: { isGrounded: false, activeGrab: 'A', spinRad: Math.PI / 2 } },
          { name: 'Airborne Grab B', state: { isGrounded: false, activeGrab: 'B', spinRad: -Math.PI / 2 } },
        ];

        let kneeAngleNeutral = 0;
        let kneeAngleCrouch = 0;
        let chestNeutralRotX = 0;
        let chestCrouchRotX = 0;
        let headNeutralRotX = 0;
        let headCrouchRotX = 0;

        for (const { name, state: partialState } of testStates) {
          glbChar.update(createMockPlayerState(partialState), 0.1);

          glbChar.group.updateMatrixWorld(true);
          glbChar.riderGroup.updateMatrixWorld(true);
          glbChar.boardGroup.updateMatrixWorld(true);

          const leftShin = internal.boneMap.get('LeftLowerLeg') as THREE.Bone;
          const rightShin = internal.boneMap.get('RightLowerLeg') as THREE.Bone;
          const leftThigh = internal.boneMap.get('LeftLeg') as THREE.Bone;

          const invRider = glbChar.riderGroup.matrixWorld.clone().invert();
          const leftAnkleInRider = new THREE.Vector3(0, -0.2802, 0)
            .applyMatrix4(leftShin.matrixWorld)
            .applyMatrix4(invRider);
          const rightAnkleInRider = new THREE.Vector3(0, -0.2802, 0)
            .applyMatrix4(rightShin.matrixWorld)
            .applyMatrix4(invRider);

          const expectedY = 0.06 + glbChar.boardGroup.position.y;

          // 2. Ankles stay anchored to bindings and never sink below y = 0
          expect(
            Math.abs(leftAnkleInRider.y - expectedY),
            `${name}: Left ankle Y (${leftAnkleInRider.y.toFixed(3)}) within ±0.05m of expected (${expectedY.toFixed(3)})`
          ).toBeLessThanOrEqual(0.05);
          expect(
            leftAnkleInRider.y,
            `${name}: Left ankle Y must never sink below 0`
          ).toBeGreaterThanOrEqual(0.0);
          expect(
            Math.abs(leftAnkleInRider.z - (-0.35)),
            `${name}: Left ankle Z (${leftAnkleInRider.z.toFixed(3)}) within ±0.05m of back binding (-0.35)`
          ).toBeLessThanOrEqual(0.05);

          expect(
            Math.abs(rightAnkleInRider.y - expectedY),
            `${name}: Right ankle Y (${rightAnkleInRider.y.toFixed(3)}) within ±0.05m of expected (${expectedY.toFixed(3)})`
          ).toBeLessThanOrEqual(0.05);
          expect(
            rightAnkleInRider.y,
            `${name}: Right ankle Y must never sink below 0`
          ).toBeGreaterThanOrEqual(0.0);
          expect(
            Math.abs(rightAnkleInRider.z - 0.35),
            `${name}: Right ankle Z (${rightAnkleInRider.z.toFixed(3)}) within ±0.05m of front binding (+0.35)`
          ).toBeLessThanOrEqual(0.05);

          // Capture kinematics for crouch vs neutral comparison
          if (name === 'Neutral riding') {
            const thighVec = leftShin.getWorldPosition(new THREE.Vector3()).sub(leftThigh.getWorldPosition(new THREE.Vector3())).normalize();
            const shinVec = new THREE.Vector3(0, -0.2802, 0).applyMatrix4(leftShin.matrixWorld).sub(leftShin.getWorldPosition(new THREE.Vector3())).normalize();
            kneeAngleNeutral = thighVec.angleTo(shinVec);
            chestNeutralRotX = (internal.boneMap.get('Chest') as THREE.Bone).rotation.x;
            headNeutralRotX = (internal.boneMap.get('Head') as THREE.Bone).rotation.x;
          } else if (name === 'Full crouch') {
            const thighVec = leftShin.getWorldPosition(new THREE.Vector3()).sub(leftThigh.getWorldPosition(new THREE.Vector3())).normalize();
            const shinVec = new THREE.Vector3(0, -0.2802, 0).applyMatrix4(leftShin.matrixWorld).sub(leftShin.getWorldPosition(new THREE.Vector3())).normalize();
            kneeAngleCrouch = thighVec.angleTo(shinVec);
            chestCrouchRotX = (internal.boneMap.get('Chest') as THREE.Bone).rotation.x;
            headCrouchRotX = (internal.boneMap.get('Head') as THREE.Bone).rotation.x;
          }

          // 4. During airborne spins + grabs: boots remain directly on top of bindings in group space
          if (name.startsWith('Airborne')) {
            const invGroup = glbChar.group.matrixWorld.clone().invert();
            const leftAnkleInGroup = new THREE.Vector3(0, -0.2802, 0)
              .applyMatrix4(leftShin.matrixWorld)
              .applyMatrix4(invGroup);
            const rightAnkleInGroup = new THREE.Vector3(0, -0.2802, 0)
              .applyMatrix4(rightShin.matrixWorld)
              .applyMatrix4(invGroup);

            const backBindingInGroup = glbChar.backBinding.getWorldPosition(new THREE.Vector3()).applyMatrix4(invGroup);
            const frontBindingInGroup = glbChar.frontBinding.getWorldPosition(new THREE.Vector3()).applyMatrix4(invGroup);

            const backHozDist = Math.hypot(leftAnkleInGroup.x - backBindingInGroup.x, leftAnkleInGroup.z - backBindingInGroup.z);
            const frontHozDist = Math.hypot(rightAnkleInGroup.x - frontBindingInGroup.x, rightAnkleInGroup.z - frontBindingInGroup.z);
            expect(backHozDist, `${name}: Left ankle horizontal distance to back binding < 0.06m`).toBeLessThan(0.06);
            expect(frontHozDist, `${name}: Right ankle horizontal distance to front binding < 0.06m`).toBeLessThan(0.06);

            const backVertDist = Math.abs(leftAnkleInGroup.y - backBindingInGroup.y);
            const frontVertDist = Math.abs(rightAnkleInGroup.y - frontBindingInGroup.y);
            expect(backVertDist, `${name}: Left ankle vertical distance to back binding < 0.05m`).toBeLessThan(0.05);
            expect(frontVertDist, `${name}: Right ankle vertical distance to front binding < 0.05m`).toBeLessThan(0.05);
          }
        }

        // 3. At full crouch: knee bend increases, Chest.rotation.x increases, Head.rotation.x counter-tilts
        expect(kneeAngleCrouch, 'Knee bend angle must increase in full crouch').toBeGreaterThan(kneeAngleNeutral);
        expect(chestCrouchRotX, 'Chest forward rotation.x must increase in full crouch').toBeGreaterThan(chestNeutralRotX);
        expect(headCrouchRotX, 'Head rotation.x must counter-tilt (tilt up toward downhill)').toBeLessThan(headNeutralRotX);
      } finally {
        GLTFLoader.prototype.loadAsync = origLoadAsync;
      }
    });
  });
});
