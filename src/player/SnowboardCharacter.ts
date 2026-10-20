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

export class SnowboardCharacter {
  public readonly group: THREE.Group;
  public readonly boardMesh: THREE.Mesh;
  public readonly riderGroup: THREE.Group;

  // Animatable rider meshes (promoted from constructor locals for update())
  private torso: THREE.Mesh;
  private hips: THREE.Mesh;
  private frontLeg: THREE.Mesh;
  private backLeg: THREE.Mesh;
  private frontArm: THREE.Mesh;
  private backArm: THREE.Mesh;

  // Landing squash state
  private wasAirborne: boolean = false;
  private landingSquashTimer: number = 0;
  private readonly landingSquashDuration: number = 0.15;

  private sprayParticles: Particle[] = [];
  private sprayGeometry: THREE.BufferGeometry;
  private sprayPoints: THREE.Points;
  private maxParticles: number = 100;
  private particlePositions: Float32Array;

  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'snowboard_character';

    // 1. Construct Snowboard Mesh
    const boardGeo = new THREE.BoxGeometry(0.32, 0.04, 1.6);
    const boardMat = new THREE.MeshStandardMaterial({
      color: 0x00e5ff, // Vibrant neon cyan
      roughness: 0.4,
      metalness: 0.1,
      flatShading: true,
    });
    this.boardMesh = new THREE.Mesh(boardGeo, boardMat);
    this.boardMesh.name = 'snowboard_mesh';
    this.boardMesh.position.y = 0.02;
    this.group.add(this.boardMesh);

    // Bindings
    const bindingGeo = new THREE.BoxGeometry(0.22, 0.04, 0.18);
    const bindingMat = new THREE.MeshStandardMaterial({
      color: 0x222222,
      roughness: 0.8,
      flatShading: true,
    });
    const frontBinding = new THREE.Mesh(bindingGeo, bindingMat);
    frontBinding.position.set(0, 0.04, 0.35);
    frontBinding.rotation.y = 0.35; // Snowboarder angled stance
    this.group.add(frontBinding);

    const backBinding = new THREE.Mesh(bindingGeo, bindingMat);
    backBinding.position.set(0, 0.04, -0.35);
    backBinding.rotation.y = 0.15;
    this.group.add(backBinding);

    // 2. Construct Low-Poly PS1 Snowboarder Rider Group
    this.riderGroup = new THREE.Group();
    this.riderGroup.name = 'rider_group';

    // Materials
    const bootMat = new THREE.MeshStandardMaterial({
      color: 0x1f2421,
      flatShading: true,
      roughness: 0.9,
    });
    const pantsMat = new THREE.MeshStandardMaterial({
      color: 0x4a154b, // 90s baggy purple pants
      flatShading: true,
      roughness: 0.85,
    });
    const jacketMat = new THREE.MeshStandardMaterial({
      color: 0xff3366, // Retro neon magenta jacket
      flatShading: true,
      roughness: 0.8,
    });
    const skinMat = new THREE.MeshStandardMaterial({
      color: 0xf3b07c,
      flatShading: true,
      roughness: 0.8,
    });
    const beanieMat = new THREE.MeshStandardMaterial({
      color: 0xffcc00, // Vibrant yellow beanie
      flatShading: true,
      roughness: 0.9,
    });
    const goggleMat = new THREE.MeshStandardMaterial({
      color: 0x00f0ff, // Mirrored cyan goggle lens
      roughness: 0.2,
      metalness: 0.8,
    });

    // Boots
    const bootGeo = new THREE.BoxGeometry(0.18, 0.14, 0.26);
    const frontBoot = new THREE.Mesh(bootGeo, bootMat);
    frontBoot.position.set(0, 0.09, 0.35);
    frontBoot.rotation.y = 0.35;
    this.riderGroup.add(frontBoot);

    const backBoot = new THREE.Mesh(bootGeo, bootMat);
    backBoot.position.set(0, 0.09, -0.35);
    backBoot.rotation.y = 0.15;
    this.riderGroup.add(backBoot);

    // Legs / Snow pants (bent knees stance)
    const legGeo = new THREE.BoxGeometry(0.18, 0.45, 0.2);
    this.frontLeg = new THREE.Mesh(legGeo, pantsMat);
    this.frontLeg.position.set(0, 0.35, 0.3);
    this.frontLeg.rotation.set(0.2, 0.35, -0.15);
    this.riderGroup.add(this.frontLeg);

    this.backLeg = new THREE.Mesh(legGeo, pantsMat);
    this.backLeg.position.set(0, 0.35, -0.3);
    this.backLeg.rotation.set(-0.2, 0.15, -0.15);
    this.riderGroup.add(this.backLeg);

    // Pelvis / Hips
    const hipsGeo = new THREE.BoxGeometry(0.36, 0.22, 0.48);
    this.hips = new THREE.Mesh(hipsGeo, pantsMat);
    this.hips.position.set(0, 0.58, 0.0);
    this.hips.rotation.y = 0.25;
    this.riderGroup.add(this.hips);

    // Torso / Jacket
    const torsoGeo = new THREE.BoxGeometry(0.38, 0.48, 0.44);
    this.torso = new THREE.Mesh(torsoGeo, jacketMat);
    this.torso.position.set(0, 0.88, 0.0);
    this.torso.rotation.y = 0.3;
    this.riderGroup.add(this.torso);

    // Arms & Mittens (outstretched for snowboard balance)
    const armGeo = new THREE.BoxGeometry(0.12, 0.38, 0.12);
    this.frontArm = new THREE.Mesh(armGeo, jacketMat);
    this.frontArm.position.set(0.18, 0.88, 0.32);
    this.frontArm.rotation.set(0.4, 0, -0.5);
    this.riderGroup.add(this.frontArm);

    this.backArm = new THREE.Mesh(armGeo, jacketMat);
    this.backArm.position.set(-0.18, 0.88, -0.32);
    this.backArm.rotation.set(-0.4, 0, 0.5);
    this.riderGroup.add(this.backArm);

    // Head
    const headGeo = new THREE.BoxGeometry(0.22, 0.24, 0.22);
    const head = new THREE.Mesh(headGeo, skinMat);
    head.position.set(0, 1.22, 0.0);
    head.rotation.y = 0.2;
    this.riderGroup.add(head);

    // Beanie
    const beanieGeo = new THREE.BoxGeometry(0.24, 0.16, 0.24);
    const beanie = new THREE.Mesh(beanieGeo, beanieMat);
    beanie.position.set(0, 1.34, 0.0);
    beanie.rotation.y = 0.2;
    this.riderGroup.add(beanie);

    // Goggles
    const goggleGeo = new THREE.BoxGeometry(0.12, 0.08, 0.2);
    const goggles = new THREE.Mesh(goggleGeo, goggleMat);
    goggles.position.set(0.11, 1.22, 0.0);
    goggles.rotation.y = 0.2;
    this.riderGroup.add(goggles);

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
  }

  public update(state: PlayerState, dtSeconds: number): void {
    const dt = Math.min(Math.max(0, dtSeconds), 0.1);
    // Smoothing factor for pose interpolation (frame-rate independent-ish)
    const k = Math.min(1, dt * 12);

    // 1. World Position
    this.group.position.set(state.position.x, state.position.y, state.position.z);

    // 2. Orient Group with Heading, Pitch, and Roll
    this.group.rotation.order = 'YXZ';
    this.group.rotation.y = state.headingRad;
    this.group.rotation.x = state.pitchRad;
    this.group.rotation.z = -state.rollRad;

    // 3. Rider Dynamics (Carve crouch, jump charge crouch, spin, grab, wipeout tumble)
    if (state.isCrashed) {
      // PS1-style wipeout tumble (crash takes precedence)
      this.landingSquashTimer = 0;
      this.riderGroup.scale.y = 1.0;
      this.riderGroup.position.set(0, 0.2, 0);
      this.riderGroup.rotation.z = Math.PI * 0.45;
      this.riderGroup.rotation.x = 0.3;
    } else {
      // Normal riding stance with dynamic carving lean & knee flex
      const crouch = state.carveIntensity * 0.12 + (state.isGrounded ? 0 : 0.08);
      this.riderGroup.position.set(0, -crouch, 0);

      const carveLean = state.rollRad * 0.4 + state.carveIntensity * 0.15;
      this.riderGroup.rotation.z = carveLean;
      this.riderGroup.rotation.x = 0;

      // Air spin: visually yaw the rider independently of the board heading.
      // When grounded, ease the spin back to the neutral (0) yaw.
      if (state.isGrounded) {
        this.riderGroup.rotation.y += (0 - this.riderGroup.rotation.y) * k;
      } else {
        this.riderGroup.rotation.y = state.spinRad;
      }

      // Crouch / wind-up pose from jumpCharge (0..1). Targets match the
      // neutral stance exactly when jumpCharge === 0.
      const jumpCharge = Math.min(1, Math.max(0, state.jumpCharge));
      const hipsTargetY = 0.58 - jumpCharge * 0.15;
      const torsoTargetY = 0.88 - jumpCharge * 0.2;
      const torsoTargetRotX = jumpCharge * 0.3;
      const frontLegTargetX = 0.2 + jumpCharge * 0.25;
      const backLegTargetX = -0.2 - jumpCharge * 0.2;
      const boardTargetScaleY = 1.0 + jumpCharge * 0.1;

      this.hips.position.y += (hipsTargetY - this.hips.position.y) * k;
      this.torso.position.y += (torsoTargetY - this.torso.position.y) * k;
      this.torso.rotation.x += (torsoTargetRotX - this.torso.rotation.x) * k;
      this.frontLeg.rotation.x += (frontLegTargetX - this.frontLeg.rotation.x) * k;
      this.backLeg.rotation.x += (backLegTargetX - this.backLeg.rotation.x) * k;
      this.boardMesh.scale.y += (boardTargetScaleY - this.boardMesh.scale.y) * k;

      // Grab poses while airborne; neutral outstretched pose on the ground.
      let frontArmTargetX = 0.4;
      let frontArmTargetZ = -0.5;
      let backArmTargetX = -0.4;
      let backArmTargetZ = 0.5;

      if (!state.isGrounded) {
        if (state.activeGrab === 'A') {
          // indy/method: reach front arm toward the board nose
          frontArmTargetX = 0.8;
          frontArmTargetZ = -0.6;
        } else if (state.activeGrab === 'B') {
          // melon/tail: reach back arm toward the board tail
          backArmTargetX = -0.9;
          backArmTargetZ = 0.7;
        }
      }

      this.frontArm.rotation.x += (frontArmTargetX - this.frontArm.rotation.x) * k;
      this.frontArm.rotation.z += (frontArmTargetZ - this.frontArm.rotation.z) * k;
      this.backArm.rotation.x += (backArmTargetX - this.backArm.rotation.x) * k;
      this.backArm.rotation.z += (backArmTargetZ - this.backArm.rotation.z) * k;
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
