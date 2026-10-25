import * as THREE from 'three';
import { PlayerState } from '../types';

interface Particle {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
}

const BONE_ALIASES: Record<string, string[]> = {
  Hips: ['Hips', 'mixamorig:Hips', 'hips', 'hip'],
  Spine: ['Spine', 'mixamorig:Spine', 'spine', 'Spine1', 'mixamorig:Spine1'],
  Chest: ['Chest', 'mixamorig:Chest', 'chest', 'Spine2', 'mixamorig:Spine2'],
  Head: ['Head', 'mixamorig:Head', 'head'],
  RightLeg: ['RightUpLeg', 'mixamorig:RightUpLeg', 'rightUpLeg'],
  RightLowerLeg: ['RightLeg', 'mixamorig:RightLeg', 'rightLeg'],
  LeftLeg: ['LeftUpLeg', 'mixamorig:LeftUpLeg', 'leftUpLeg'],
  LeftLowerLeg: ['LeftLeg', 'mixamorig:LeftLeg', 'leftLeg'],
  RightArm: ['RightUpperArm', 'mixamorig:RightUpperArm', 'RightArm', 'mixamorig:RightArm', 'rightUpperArm', 'rightArm'],
  RightLowerArm: ['RightLowerArm', 'mixamorig:RightForeArm', 'rightLowerArm', 'rightForeArm'],
  LeftArm: ['LeftUpperArm', 'mixamorig:LeftUpperArm', 'LeftArm', 'mixamorig:LeftArm', 'leftUpperArm', 'leftArm'],
  LeftLowerArm: ['LeftLowerArm', 'mixamorig:LeftForeArm', 'leftLowerArm', 'leftForeArm'],
};

const MATERIAL_OVERRIDES = {
  pants: { color: 0x4a154b, roughness: 0.85, flatShading: true },
  jacket: { color: 0xff3366, roughness: 0.8, flatShading: true },
  beanie: { color: 0xffcc00, roughness: 0.9, flatShading: true },
  skin: { color: 0xf3b07c, roughness: 0.8, flatShading: true },
  goggles: { color: 0x00f0ff, roughness: 0.2, metalness: 0.8, flatShading: true },
  boots: { color: 0x1f2421, roughness: 0.9, flatShading: true },
} as const;

const MESH_MATERIAL_MAP: Record<string, string[]> = {
  pants: ['hips_mesh', 'left_up_leg_mesh', 'right_up_leg_mesh', 'left_knee_mesh', 'right_knee_mesh'],
  jacket: ['spine_mesh', 'chest_mesh', 'left_upper_arm_mesh', 'right_upper_arm_mesh', 'left_elbow_mesh', 'right_elbow_mesh'],
  beanie: ['beanie_mesh'],
  skin: ['head_mesh', 'left_lower_arm_mesh', 'right_lower_arm_mesh'],
  goggles: ['goggles_mesh'],
  boots: ['left_leg_mesh', 'right_leg_mesh', 'left_glove_mesh', 'right_glove_mesh'],
};

export class SnowboardCharacter {
  public readonly group: THREE.Group;
  public readonly boardGroup: THREE.Group;
  public readonly boardMesh: THREE.Mesh;
  public readonly frontBinding: THREE.Mesh;
  public readonly backBinding: THREE.Mesh;
  public readonly riderGroup: THREE.Group;

  // Animatable rider parts (meshes in fallback, bones in loaded GLB)
  private torso: THREE.Object3D | null = null;
  private hips: THREE.Object3D | null = null;
  private chest: THREE.Object3D | null = null;
  private head: THREE.Object3D | null = null;
  private frontLeg: THREE.Object3D | null = null;
  private frontLowerLeg: THREE.Object3D | null = null;
  private backLeg: THREE.Object3D | null = null;
  private backLowerLeg: THREE.Object3D | null = null;
  private frontArm: THREE.Object3D | null = null;
  private frontLowerArm: THREE.Object3D | null = null;
  private backArm: THREE.Object3D | null = null;
  private backLowerArm: THREE.Object3D | null = null;

  // GLB state
  private glbLoaded = false;
  private boneMap = new Map<string, THREE.Bone>();
  private originalBoneStates = new Map<string, { quaternion: THREE.Quaternion; position: THREE.Vector3 }>();

  // Base pose values (rest pose for bones, hard-coded for fallback meshes)
  private baseHipsY = 0.58;
  private baseTorsoY = 0.88;
  private baseTorsoRotX = 0;
  private baseChestRotX = 0;
  private baseHeadRotX = 0;
  private baseFrontLegRotX = 0.2;
  private baseBackLegRotX = -0.2;
  private baseFrontLowerLegRotX = 0;
  private baseBackLowerLegRotX = 0;
  private baseFrontArmRotX = 0.4;
  private baseFrontArmRotZ = -0.5;
  private baseFrontLowerArmRotX = 0;
  private baseFrontLowerArmRotZ = 0;
  private baseBackArmRotX = -0.4;
  private baseBackArmRotZ = 0.5;
  private baseBackLowerArmRotX = 0;
  private baseBackLowerArmRotZ = 0;

  // Landing squash state
  private wasAirborne = false;
  private landingSquashTimer = 0;
  private readonly landingSquashDuration = 0.15;

  private sprayParticles: Particle[] = [];
  private sprayGeometry: THREE.BufferGeometry;
  private sprayPoints: THREE.Points;
  private maxParticles = 100;
  private particlePositions: Float32Array;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'snowboard_character';

    // 1. Construct Board Group & Snowboard Mesh + Bindings
    this.boardGroup = new THREE.Group();
    this.boardGroup.name = 'board_group';
    this.group.add(this.boardGroup);

    const boardGeo = new THREE.BoxGeometry(0.32, 0.04, 1.6);
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0x00e5ff,
      roughness: 0.4,
      metalness: 0.1,
      flatShading: true,
    });
    this.boardMesh = new THREE.Mesh(boardGeo, boardMat);
    this.boardMesh.name = 'snowboard_mesh';
    this.boardMesh.position.y = 0.02;
    this.boardGroup.add(this.boardMesh);

    // Bindings
    const bindingGeo = new THREE.BoxGeometry(0.22, 0.04, 0.18);
    const bindingMat = new THREE.MeshStandardMaterial({
      color: 0x222222,
      roughness: 0.8,
      flatShading: true,
    });
    this.frontBinding = new THREE.Mesh(bindingGeo, bindingMat);
    this.frontBinding.name = 'front_binding';
    this.frontBinding.position.set(0, 0.04, 0.35);
    this.frontBinding.rotation.y = 0.35;
    this.boardGroup.add(this.frontBinding);

    this.backBinding = new THREE.Mesh(bindingGeo, bindingMat);
    this.backBinding.name = 'back_binding';
    this.backBinding.position.set(0, 0.04, -0.35);
    this.backBinding.rotation.y = 0.15;
    this.boardGroup.add(this.backBinding);

    // 2. Construct Low-Poly PS1 Snowboarder Rider Group (procedural fallback)
    this.riderGroup = this.buildProceduralRider();
    this.group.add(this.riderGroup);

    // 3. Snow Spray Particle System
    this.particlePositions = new Float32Array(this.maxParticles * 3);
    for (let i = 0; i < this.maxParticles; i++) {
      this.sprayParticles.push({
        x: 0,
        y: -1000,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        life: 0,
        maxLife: 1.0,
      });
      this.particlePositions[i * 3 + 1] = -1000;
    }

    this.sprayGeometry = new THREE.BufferGeometry();
    this.sprayGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(this.particlePositions, 3)
    );

    const sprayMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.18,
      transparent: true,
      opacity: 0.75,
    });
    this.sprayPoints = new THREE.Points(this.sprayGeometry, sprayMat);
    this.sprayPoints.frustumCulled = false;
    this.group.add(this.sprayPoints);

    // 4. Async load rigged GLB (swaps in when ready; fallback stays active otherwise)
    this.loadGlbAsync();
  }

  private buildProceduralRider(): THREE.Group {
    const riderGroup = new THREE.Group();
    riderGroup.name = 'rider_group';

    // Materials
    const bootMat = new THREE.MeshStandardMaterial({
      color: 0x1f2421,
      flatShading: true,
      roughness: 0.9,
    });
    const pantsMat = new THREE.MeshStandardMaterial({
      color: 0x4a154b,
      flatShading: true,
      roughness: 0.85,
    });
    const jacketMat = new THREE.MeshStandardMaterial({
      color: 0xff3366,
      flatShading: true,
      roughness: 0.8,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xf3b07c,
      flatShading: true,
      roughness: 0.8,
    });
    const beanieMat = new THREE.MeshStandardMaterial({
      color: 0xffcc00,
      flatShading: true,
      roughness: 0.9,
    });
    const goggleMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff,
      roughness: 0.2,
      metalness: 0.8,
    });

    // Boots planted firmly at bindings
    const bootGeo = new THREE.BoxGeometry(0.18, 0.14, 0.26);
    const frontBoot = new THREE.Mesh(bootGeo, bootMat);
    frontBoot.position.set(0, 0.09, 0.35);
    frontBoot.rotation.y = 0.35;
    riderGroup.add(frontBoot);

    const backBoot = new THREE.Mesh(bootGeo, bootMat);
    backBoot.position.set(0, 0.09, -0.35);
    backBoot.rotation.y = 0.15;
    riderGroup.add(backBoot);

    // Legs: Bent knees with upper thighs and lower shins
    const thighGeo = new THREE.BoxGeometry(0.16, 0.28, 0.18);
    const shinGeo = new THREE.BoxGeometry(0.15, 0.26, 0.17);
    const kneeGeo = new THREE.SphereGeometry(0.08, 6, 5);

    // Front Leg (Right upper thigh)
    this.frontLeg = new THREE.Mesh(thighGeo, pantsMat);
    this.frontLeg.position.set(0.06, 0.44, 0.28);
    this.frontLeg.rotation.set(0.2, 0.4, -0.2);
    riderGroup.add(this.frontLeg);

    const frontKnee = new THREE.Mesh(kneeGeo, pantsMat);
    frontKnee.position.set(0.12, 0.31, 0.32);
    riderGroup.add(frontKnee);

    const frontShin = new THREE.Mesh(shinGeo, pantsMat);
    frontShin.position.set(0.06, 0.20, 0.34);
    frontShin.rotation.set(-0.3, 0.1, 0.15);
    riderGroup.add(frontShin);
    this.frontLowerLeg = frontShin;

    // Back Leg (Left upper thigh)
    this.backLeg = new THREE.Mesh(thighGeo, pantsMat);
    this.backLeg.position.set(0.06, 0.44, -0.28);
    this.backLeg.rotation.set(-0.2, 0.2, -0.2);
    riderGroup.add(this.backLeg);

    const backKnee = new THREE.Mesh(kneeGeo, pantsMat);
    backKnee.position.set(0.12, 0.31, -0.31);
    riderGroup.add(backKnee);

    const backShin = new THREE.Mesh(shinGeo, pantsMat);
    backShin.position.set(0.06, 0.20, -0.34);
    backShin.rotation.set(0.3, 0.1, 0.15);
    riderGroup.add(backShin);
    this.backLowerLeg = backShin;

    // Hips: lowered athletic stance rotated sideways
    const hipsGeo = new THREE.BoxGeometry(0.36, 0.22, 0.48);
    this.hips = new THREE.Mesh(hipsGeo, pantsMat);
    this.hips.position.set(0, 0.58, 0.0);
    this.hips.rotation.y = 1.35;
    riderGroup.add(this.hips);

    // Torso: sideways posture (rotation.y ≈ 1.35)
    const torsoGeo = new THREE.BoxGeometry(0.38, 0.48, 0.44);
    this.torso = new THREE.Mesh(torsoGeo, jacketMat);
    this.torso.position.set(0, 0.88, 0.0);
    this.torso.rotation.set(0, 1.35, 0);
    riderGroup.add(this.torso);

    // Arms: flexed elbows with forearms attached
    const armGeo = new THREE.BoxGeometry(0.12, 0.22, 0.12);
    const forearmGeo = new THREE.BoxGeometry(0.10, 0.20, 0.10);

    this.frontArm = new THREE.Mesh(armGeo, jacketMat);
    this.frontArm.position.set(0.18, 0.88, 0.28);
    this.frontArm.rotation.set(0.4, 0, -0.5);
    riderGroup.add(this.frontArm);

    const frontForearm = new THREE.Mesh(forearmGeo, skinMat);
    frontForearm.position.set(0, -0.16, 0.06);
    frontForearm.rotation.set(-0.75, 0, 0);
    this.frontArm.add(frontForearm);

    this.backArm = new THREE.Mesh(armGeo, jacketMat);
    this.backArm.position.set(-0.18, 0.88, -0.28);
    this.backArm.rotation.set(-0.4, 0, 0.5);
    riderGroup.add(this.backArm);

    const backForearm = new THREE.Mesh(forearmGeo, skinMat);
    backForearm.position.set(0, -0.16, 0.06);
    backForearm.rotation.set(-0.75, 0, 0);
    this.backArm.add(backForearm);

    // Head: counter-turned downhill (+Z direction)
    const headGeo = new THREE.BoxGeometry(0.22, 0.24, 0.22);
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.set(0, 1.22, 0.0);
    head.rotation.y = 0.0;
    riderGroup.add(head);

    // Beanie
    const beanieGeo = new THREE.BoxGeometry(0.24, 0.16, 0.24);
    const beanie = new THREE.Mesh(beanieGeo, beanieMat);
    beanie.position.set(0, 1.34, 0.0);
    beanie.rotation.y = 0.0;
    riderGroup.add(beanie);

    // Goggles: wrap-around visor facing downhill (+Z)
    const goggleGeo = new THREE.BoxGeometry(0.20, 0.08, 0.12);
    const goggles = new THREE.Mesh(goggleGeo, goggleMat);
    goggles.position.set(0.0, 1.22, 0.11);
    goggles.rotation.y = 0.0;
    riderGroup.add(goggles);

    return riderGroup;
  }

  private async loadGlbAsync(): Promise<void> {
    try {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync('assets/character/rider.glb');

      const scene = gltf.scene;

      // Apply material overrides
      scene.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          const matName = (mesh.material as THREE.Material)?.name;
          let spec: (typeof MATERIAL_OVERRIDES)[keyof typeof MATERIAL_OVERRIDES] | undefined;

          if (matName && matName in MATERIAL_OVERRIDES) {
            spec = MATERIAL_OVERRIDES[matName as keyof typeof MATERIAL_OVERRIDES];
          } else {
            for (const [key, meshNames] of Object.entries(MESH_MATERIAL_MAP)) {
              if (meshNames.includes(mesh.name)) {
                spec = MATERIAL_OVERRIDES[key as keyof typeof MATERIAL_OVERRIDES];
                break;
              }
            }
          }

          if (spec) {
            mesh.material = new THREE.MeshStandardMaterial(spec);
          } else {
            const oldMat = mesh.material as THREE.MeshStandardMaterial | undefined;
            if (oldMat) {
              mesh.material = new THREE.MeshStandardMaterial({
                color: oldMat.color,
                roughness: oldMat.roughness ?? 0.8,
                metalness: (oldMat as any).metalness ?? 0,
                flatShading: true,
              });
            }
          }
        }
      });

      // Build bone name → Bone map with aliases
      const aliasMap = new Map<string, string>();
      for (const [canonical, aliases] of Object.entries(BONE_ALIASES)) {
        for (const alias of aliases) {
          aliasMap.set(alias.toLowerCase(), canonical);
        }
      }

      scene.traverse((obj) => {
        if ((obj as THREE.Bone).isBone) {
          const bone = obj as THREE.Bone;
          const canonical = aliasMap.get(bone.name.toLowerCase());
          if (canonical) {
            this.boneMap.set(canonical, bone);
          }
        }
      });

      // Verify critical bones exist
      const required = ['Hips', 'Spine', 'RightArm', 'LeftArm'];
      const missing = required.filter((b) => !this.boneMap.has(b));
      if (missing.length > 0) {
        console.warn('Loaded rider.glb but missing required bones:', missing.join(', '));
        return;
      }

      // Save original bone transforms keyed by canonical bone name so reset() can restore them
      for (const [canonical, bone] of this.boneMap.entries()) {
        this.originalBoneStates.set(canonical, {
          quaternion: bone.quaternion.clone(),
          position: bone.position.clone(),
        });
      }

      // Replace procedural riderGroup contents with loaded model
      this.riderGroup.clear();
      this.riderGroup.add(scene);

      // Map all 12 canonical bones (update() and tests read these)
      this.hips = this.boneMap.get('Hips') ?? null;
      this.torso = this.boneMap.get('Spine') ?? null;
      this.chest = this.boneMap.get('Chest') ?? null;
      this.head = this.boneMap.get('Head') ?? null;
      this.frontLeg = this.boneMap.get('RightLeg') ?? null;
      this.frontLowerLeg = this.boneMap.get('RightLowerLeg') ?? null;
      this.backLeg = this.boneMap.get('LeftLeg') ?? null;
      this.backLowerLeg = this.boneMap.get('LeftLowerLeg') ?? null;
      this.frontArm = this.boneMap.get('RightArm') ?? null;
      this.frontLowerArm = this.boneMap.get('RightLowerArm') ?? null;
      this.backArm = this.boneMap.get('LeftArm') ?? null;
      this.backLowerArm = this.boneMap.get('LeftLowerArm') ?? null;

      // Capture base transforms from the model's bind pose so poses are relative
      if (this.hips) this.baseHipsY = this.hips.position.y;
      if (this.torso) this.baseTorsoY = this.torso.position.y;
      if (this.torso) this.baseTorsoRotX = this.torso.rotation.x;
      if (this.chest) this.baseChestRotX = this.chest.rotation.x;
      if (this.head) {
        this.baseHeadRotX = this.head.rotation.x;
      }
      if (this.frontLeg) this.baseFrontLegRotX = this.frontLeg.rotation.x;
      if (this.backLeg) this.baseBackLegRotX = this.backLeg.rotation.x;
      if (this.frontLowerLeg) this.baseFrontLowerLegRotX = this.frontLowerLeg.rotation.x;
      if (this.backLowerLeg) this.baseBackLowerLegRotX = this.backLowerLeg.rotation.x;
      if (this.frontArm) {
        this.baseFrontArmRotX = this.frontArm.rotation.x;
        this.baseFrontArmRotZ = this.frontArm.rotation.z;
      }
      if (this.frontLowerArm) {
        this.baseFrontLowerArmRotX = this.frontLowerArm.rotation.x;
        this.baseFrontLowerArmRotZ = this.frontLowerArm.rotation.z;
      }
      if (this.backArm) {
        this.baseBackArmRotX = this.backArm.rotation.x;
        this.baseBackArmRotZ = this.backArm.rotation.z;
      }
      if (this.backLowerArm) {
        this.baseBackLowerArmRotX = this.backLowerArm.rotation.x;
        this.baseBackLowerArmRotZ = this.backLowerArm.rotation.z;
      }

      this.glbLoaded = true;
    } catch (err) {
      console.warn('Failed to load rider.glb, using procedural fallback:', err);
    }
  }

  public update(state: PlayerState, dtSeconds: number): void {
    const dt = Math.min(Math.max(0, dtSeconds), 0.1);
    const k = Math.min(1, dt * 12);

    // 1. World Position
    this.group.position.set(state.position.x, state.position.y, state.position.z);

    // 2. Orient Group with Heading, Pitch, and Roll
    this.group.rotation.order = 'YXZ';
    this.group.rotation.y = state.headingRad;
    this.group.rotation.x = state.pitchRad;
    this.group.rotation.z = -state.rollRad;

    // 3. Rider Dynamics (Carve crouch, jump charge crouch, spin, grab, wipeout tumble)
    if (!this.hips || !this.torso || !this.frontLeg || !this.backLeg || !this.frontArm || !this.backArm) {
      return;
    }

    if (state.isCrashed) {
      // PS1-style wipeout tumble (crash takes precedence)
      this.landingSquashTimer = 0;
      this.riderGroup.scale.y = 1.0;
      this.riderGroup.position.set(0, 0.2, 0);
      this.riderGroup.rotation.z = Math.PI * 0.45;
      this.riderGroup.rotation.x = 0.3;
      this.boardGroup.position.set(0, 0, 0);
      this.boardGroup.rotation.set(0, 0, 0);
    } else {
      // Normal riding stance: y = 0 is board surface, keep boots anchored
      this.riderGroup.position.set(0, 0, 0);

      const carveLean = state.rollRad * 0.4 + state.carveIntensity * 0.15;
      this.riderGroup.rotation.z = carveLean;
      this.riderGroup.rotation.x = 0;

      // Air spin: visually yaw the rider (persistent stance offset + in-air spin)
      // independently of the board heading. When grounded, ease toward the
      // persistent stance yaw (switch stance) along the SHORTEST path — a naive
      // ease would visibly unwind a full reverse rotation after a landed 360.
      if (state.isGrounded) {
        const target =
          state.stanceRad +
          2 * Math.PI * Math.round((this.riderGroup.rotation.y - state.stanceRad) / (2 * Math.PI));
        this.riderGroup.rotation.y += (target - this.riderGroup.rotation.y) * k;
      } else {
        this.riderGroup.rotation.y = state.stanceRad + state.spinRad;
      }

      // Synchronize boardGroup in lockstep with riderGroup
      this.boardGroup.rotation.copy(this.riderGroup.rotation);
      if (!state.isGrounded && state.activeGrab !== 'none') {
        this.boardGroup.rotation.x = state.activeGrab === 'A' ? -0.12 : 0.12;
      }
      const airTuckLift = state.isGrounded ? 0 : (state.activeGrab !== 'none' ? 0.12 : 0.04);
      this.boardGroup.position.y += (airTuckLift - this.boardGroup.position.y) * k;

      // Crouch / wind-up pose from jumpCharge (0..1) + carve crouch + airborne grab hip tuck
      const jumpCharge = Math.min(1, Math.max(0, state.jumpCharge));
      const carveCrouch = state.carveIntensity * 0.08;
      const grabHipTuck = (!state.isGrounded && state.activeGrab !== 'none') ? 0.08 : (!state.isGrounded ? 0.03 : 0);
      const hipsTargetY = this.baseHipsY - jumpCharge * 0.15 - carveCrouch - grabHipTuck;
      this.hips.position.y += (hipsTargetY - this.hips.position.y) * k;

      if (!this.glbLoaded) {
        const torsoTargetY = this.baseTorsoY - jumpCharge * 0.2 - carveCrouch - grabHipTuck;
        this.torso.position.y += (torsoTargetY - this.torso.position.y) * k;
      }

      const grabTorsoLeanX = (!state.isGrounded && state.activeGrab === 'A')
        ? 0.20
        : (!state.isGrounded && state.activeGrab === 'B')
          ? -0.15
          : 0;
      const torsoTargetRotX = this.baseTorsoRotX + jumpCharge * 0.30 + grabTorsoLeanX;
      this.torso.rotation.x += (torsoTargetRotX - this.torso.rotation.x) * k;

      if (this.chest) {
        const chestGrabLean = state.isGrounded ? 0 : (state.activeGrab !== 'none' ? 0.28 : 0.08);
        const chestTargetRotX = this.baseChestRotX + jumpCharge * 0.20 + state.carveIntensity * 0.12 + chestGrabLean;
        this.chest.rotation.x += (chestTargetRotX - this.chest.rotation.x) * k;
      }

      if (this.head) {
        const headTargetRotX = this.baseHeadRotX - (jumpCharge * 0.25 + state.carveIntensity * 0.08);
        this.head.rotation.x += (headTargetRotX - this.head.rotation.x) * k;
      }

      const boardTargetScaleY = 1.0 + jumpCharge * 0.1;
      this.boardMesh.scale.y += (boardTargetScaleY - this.boardMesh.scale.y) * k;

      // Foot-anchored 2-bone leg IK (when GLB loaded) or procedural fallback rotation
      if (this.glbLoaded && this.backLowerLeg && this.frontLowerLeg) {
        this.solveLegIK();
      } else {
        const frontLegTargetX = this.baseFrontLegRotX + jumpCharge * 0.25;
        const backLegTargetX = this.baseBackLegRotX - jumpCharge * 0.2;
        this.frontLeg.rotation.x += (frontLegTargetX - this.frontLeg.rotation.x) * k;
        this.backLeg.rotation.x += (backLegTargetX - this.backLeg.rotation.x) * k;
        if (this.frontLowerLeg) {
          const frontLowerLegTargetX = this.baseFrontLowerLegRotX - jumpCharge * 0.2;
          this.frontLowerLeg.rotation.x += (frontLowerLegTargetX - this.frontLowerLeg.rotation.x) * k;
        }
        if (this.backLowerLeg) {
          const backLowerLegTargetX = this.baseBackLowerLegRotX + jumpCharge * 0.2;
          this.backLowerLeg.rotation.x += (backLowerLegTargetX - this.backLowerLeg.rotation.x) * k;
        }
      }

      // Grab poses while airborne; neutral outstretched pose on the ground.
      let frontArmTargetX = this.baseFrontArmRotX;
      let frontArmTargetZ = this.baseFrontArmRotZ;
      let backArmTargetX = this.baseBackArmRotX;
      let backArmTargetZ = this.baseBackArmRotZ;

      if (!state.isGrounded) {
        if (state.activeGrab === 'A') {
          // indy/method: reach front arm toward the board nose
          frontArmTargetX = this.baseFrontArmRotX + 0.4;
          frontArmTargetZ = this.baseFrontArmRotZ - 0.1;
        } else if (state.activeGrab === 'B') {
          // melon/tail: reach back arm toward the board tail
          backArmTargetX = this.baseBackArmRotX - 0.5;
          backArmTargetZ = this.baseBackArmRotZ + 0.2;
        }
      }

      this.frontArm.rotation.x += (frontArmTargetX - this.frontArm.rotation.x) * k;
      this.frontArm.rotation.z += (frontArmTargetZ - this.frontArm.rotation.z) * k;
      this.backArm.rotation.x += (backArmTargetX - this.backArm.rotation.x) * k;
      this.backArm.rotation.z += (backArmTargetZ - this.backArm.rotation.z) * k;

      // Elbow forearm dynamic articulation during crouch and grabs
      if (this.frontLowerArm) {
        let frontLowerArmTargetX = this.baseFrontLowerArmRotX - jumpCharge * 0.15;
        let frontLowerArmTargetZ = this.baseFrontLowerArmRotZ;
        if (!state.isGrounded && state.activeGrab === 'A') {
          frontLowerArmTargetX = this.baseFrontLowerArmRotX + 0.55;
          frontLowerArmTargetZ = this.baseFrontLowerArmRotZ + 0.35;
        }
        this.frontLowerArm.rotation.x += (frontLowerArmTargetX - this.frontLowerArm.rotation.x) * k;
        this.frontLowerArm.rotation.z += (frontLowerArmTargetZ - this.frontLowerArm.rotation.z) * k;
      }

      if (this.backLowerArm) {
        let backLowerArmTargetX = this.baseBackLowerArmRotX - jumpCharge * 0.15;
        let backLowerArmTargetZ = this.baseBackLowerArmRotZ;
        if (!state.isGrounded && state.activeGrab === 'B') {
          backLowerArmTargetX = this.baseBackLowerArmRotX + 0.55;
          backLowerArmTargetZ = this.baseBackLowerArmRotZ - 0.35;
        }
        this.backLowerArm.rotation.x += (backLowerArmTargetX - this.backLowerArm.rotation.x) * k;
        this.backLowerArm.rotation.z += (backLowerArmTargetZ - this.backLowerArm.rotation.z) * k;
      }
    }

    // 5. Landing squash on a clean touchdown
    const airborneNow = !state.isGrounded;
    if (state.isGrounded && this.wasAirborne && !state.isCrashed) {
      this.landingSquashTimer = this.landingSquashDuration;
    }
    this.wasAirborne = airborneNow;

    if (!state.isCrashed) {
      if (this.landingSquashTimer > 0) {
        const progress = 1.0 - this.landingSquashTimer / this.landingSquashDuration;
        const squashY = 1.0 - 0.3 * Math.sin(progress * Math.PI); // peak squash at midpoint, min ~0.7
        this.riderGroup.scale.y = squashY;
        this.landingSquashTimer -= dt;
        if (this.landingSquashTimer <= 0) {
          this.landingSquashTimer = 0;
          this.riderGroup.scale.y = 1.0;
        }
      } else {
        this.riderGroup.scale.y = 1.0;
      }
    }

    // 6. Update Snow Spray Particles
    this.updateParticles(state, dt);
  }

  private solveLegIK(): void {
    if (!this.hips || !this.backLeg || !this.backLowerLeg || !this.frontLeg || !this.frontLowerLeg) {
      return;
    }

    const boardY = this.boardGroup.position.y;
    const hipsQuat = this.hips.quaternion;

    // --- Back Leg (LeftUpLeg -> LeftLeg) ---
    const HL = this.backLeg.position.clone().applyQuaternion(hipsQuat).add(this.hips.position);
    const AL = new THREE.Vector3(0, 0.06 + boardY, -0.35);
    const L1_L = Math.abs(this.backLowerLeg.position.y) || 0.3069;
    const L2_L = 0.2802;

    const dVecL = AL.clone().sub(HL);
    const dL = Math.min(L1_L + L2_L - 0.005, Math.max(0.05, dVecL.length()));
    const dirL = dVecL.clone().normalize();
    const cosAlphaL = (L1_L * L1_L + dL * dL - L2_L * L2_L) / (2 * L1_L * dL);
    const alphaL = Math.acos(Math.max(-1, Math.min(1, cosAlphaL)));

    const bendHintL = new THREE.Vector3(0.86, 0.20, -0.46).normalize();
    const bendOrthL = bendHintL.clone().addScaledVector(dirL, -bendHintL.dot(dirL)).normalize();
    const KL = HL.clone()
      .addScaledVector(dirL, Math.cos(alphaL) * L1_L)
      .addScaledVector(bendOrthL, Math.sin(alphaL) * L1_L);

    const dirThighHipsL = KL.clone().sub(HL).normalize().applyQuaternion(hipsQuat.clone().invert());
    const qUpLegL = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirThighHipsL);
    this.backLeg.quaternion.copy(qUpLegL);
    this.backLeg.rotation.setFromQuaternion(qUpLegL, 'YXZ');

    const qUpLegInRiderL = hipsQuat.clone().multiply(qUpLegL);
    const dirShinUpLegL = AL.clone().sub(KL).normalize().applyQuaternion(qUpLegInRiderL.clone().invert());
    const qLegL = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirShinUpLegL);
    this.backLowerLeg.quaternion.copy(qLegL);
    this.backLowerLeg.rotation.setFromQuaternion(qLegL, 'YXZ');

    // --- Front Leg (RightUpLeg -> RightLeg) ---
    const HR = this.frontLeg.position.clone().applyQuaternion(hipsQuat).add(this.hips.position);
    const AR = new THREE.Vector3(0, 0.06 + boardY, 0.35);
    const L1_R = Math.abs(this.frontLowerLeg.position.y) || 0.3069;
    const L2_R = 0.2802;

    const dVecR = AR.clone().sub(HR);
    const dR = Math.min(L1_R + L2_R - 0.005, Math.max(0.05, dVecR.length()));
    const dirR = dVecR.clone().normalize();
    const cosAlphaR = (L1_R * L1_R + dR * dR - L2_R * L2_R) / (2 * L1_R * dR);
    const alphaR = Math.acos(Math.max(-1, Math.min(1, cosAlphaR)));

    const bendHintR = new THREE.Vector3(0.86, 0.20, 0.46).normalize();
    const bendOrthR = bendHintR.clone().addScaledVector(dirR, -bendHintR.dot(dirR)).normalize();
    const KR = HR.clone()
      .addScaledVector(dirR, Math.cos(alphaR) * L1_R)
      .addScaledVector(bendOrthR, Math.sin(alphaR) * L1_R);

    const dirThighHipsR = KR.clone().sub(HR).normalize().applyQuaternion(hipsQuat.clone().invert());
    const qUpLegR = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirThighHipsR);
    this.frontLeg.quaternion.copy(qUpLegR);
    this.frontLeg.rotation.setFromQuaternion(qUpLegR, 'YXZ');

    const qUpLegInRiderR = hipsQuat.clone().multiply(qUpLegR);
    const dirShinUpLegR = AR.clone().sub(KR).normalize().applyQuaternion(qUpLegInRiderR.clone().invert());
    const qLegR = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirShinUpLegR);
    this.frontLowerLeg.quaternion.copy(qLegR);
    this.frontLowerLeg.rotation.setFromQuaternion(qLegR, 'YXZ');
  }

  public reset(): void {
    this.landingSquashTimer = 0;
    this.wasAirborne = false;
    this.riderGroup.scale.set(1, 1, 1);
    this.riderGroup.position.set(0, 0, 0);
    this.riderGroup.rotation.set(0, 0, 0);
    this.boardMesh.scale.set(1, 1, 1);
    this.boardGroup.position.set(0, 0, 0);
    this.boardGroup.rotation.set(0, 0, 0);

    for (let i = 0; i < this.maxParticles; i++) {
      this.sprayParticles[i].life = 0;
      this.particlePositions[i * 3 + 1] = -1000;
    }
    this.sprayGeometry.attributes.position.needsUpdate = true;

    // Restore original bone poses if GLB is loaded
    if (this.glbLoaded) {
      for (const [name, state] of this.originalBoneStates) {
        const bone = this.boneMap.get(name);
        if (bone) {
          bone.quaternion.copy(state.quaternion);
          bone.position.copy(state.position);
        }
      }
    } else {
      if (this.hips) this.hips.position.y = this.baseHipsY;
      if (this.torso) {
        this.torso.position.y = this.baseTorsoY;
        this.torso.rotation.x = this.baseTorsoRotX;
      }
      if (this.frontLeg) this.frontLeg.rotation.x = this.baseFrontLegRotX;
      if (this.frontLowerLeg) this.frontLowerLeg.rotation.x = this.baseFrontLowerLegRotX;
      if (this.backLeg) this.backLeg.rotation.x = this.baseBackLegRotX;
      if (this.backLowerLeg) this.backLowerLeg.rotation.x = this.baseBackLowerLegRotX;
      if (this.frontArm) {
        this.frontArm.rotation.x = this.baseFrontArmRotX;
        this.frontArm.rotation.z = this.baseFrontArmRotZ;
      }
      if (this.backArm) {
        this.backArm.rotation.x = this.baseBackArmRotX;
        this.backArm.rotation.z = this.baseBackArmRotZ;
      }
    }
  }

  private updateParticles(state: PlayerState, dt: number): void {
    // Emit new spray when on snow and moving
    const canSpray = state.isGrounded && !state.isCrashed && state.speedKmh > 6.0;
    const sprayRate = canSpray ? Math.floor(1 + state.carveIntensity * 5 + state.speedKmh * 0.05) : 0;

    let emitted = 0;
    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.sprayParticles[i];
      if (p.life <= 0 && emitted < sprayRate) {
        emitted++;
        // Emit from rear edge of board in local space
        const sideSign = state.rollRad >= 0 ? 1 : -1;
        p.x = sideSign * (0.12 + Math.random() * 0.1);
        p.y = 0.02;
        p.z = -0.65 - Math.random() * 0.3;

        // Velocity directed backwards and outward
        const speedScale = (state.speedKmh / 30.0) * (0.5 + state.carveIntensity * 1.5);
        p.vx = sideSign * (1.2 + Math.random() * 2.0) * speedScale;
        p.vy = (0.8 + Math.random() * 1.8) * speedScale;
        p.vz = (-1.5 - Math.random() * 2.5) * speedScale;

        p.life = 0.25 + Math.random() * 0.35;
        p.maxLife = p.life;
      }

      if (p.life > 0) {
        p.life -= dt;
        p.vy -= 9.8 * dt; // gravity on particles
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.z += p.vz * dt;

        if (p.life <= 0 || p.y < -0.2) {
          p.life = 0;
          this.particlePositions[i * 3 + 1] = -1000;
        } else {
          this.particlePositions[i * 3] = p.x;
          this.particlePositions[i * 3 + 1] = p.y;
          this.particlePositions[i * 3 + 2] = p.z;
        }
      } else {
        this.particlePositions[i * 3 + 1] = -1000;
      }
    }

    this.sprayGeometry.attributes.position.needsUpdate = true;
  }
}
