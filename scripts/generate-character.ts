import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

// Polyfill FileReader for Node.js so GLTFExporter works
if (typeof globalThis.FileReader === 'undefined') {
  class PolyfillFileReader {
    public result: any = null;
    public onloadend: (() => void) | null = null;
    public onerror: ((err: any) => void) | null = null;
    readAsArrayBuffer(blob: Blob) {
      blob.arrayBuffer().then((buf) => {
        this.result = buf;
        if (this.onloadend) this.onloadend();
      }).catch((err) => {
        if (this.onerror) this.onerror(err);
      });
    }
  }
  (globalThis as any).FileReader = PolyfillFileReader;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUT_DIR = path.resolve(__dirname, '../public/assets/character');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

interface TaperedPrismOptions {
  topRadiusX: number;
  topRadiusZ: number;
  bottomRadiusX: number;
  bottomRadiusZ: number;
  height: number;
  radialSegments?: number;
  heightSegments?: number;
}

function createTaperedPrism(opts: TaperedPrismOptions): THREE.BufferGeometry {
  const radialSegs = opts.radialSegments ?? 8;
  const heightSegs = opts.heightSegments ?? 1;
  const geo = new THREE.CylinderGeometry(1, 1, opts.height, radialSegs, heightSegs, false);
  const pos = geo.attributes.position;
  const halfH = opts.height / 2;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const t = Math.max(0, Math.min(1, (y + halfH) / opts.height));
    const rx = opts.bottomRadiusX + (opts.topRadiusX - opts.bottomRadiusX) * t;
    const rz = opts.bottomRadiusZ + (opts.topRadiusZ - opts.bottomRadiusZ) * t;
    pos.setXYZ(i, x * rx, y, z * rz);
  }
  geo.computeVertexNormals();
  return geo;
}

function createBeanieGeometry(): THREE.BufferGeometry {
  // Low-poly hemisphere dome with folded cuff and top dome height
  const geo = new THREE.SphereGeometry(0.14, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.65);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const cuffBoost = y < 0.03 ? 1.08 : 1.0;
    pos.setXYZ(i, x * 0.98 * cuffBoost, y * 1.45, z * 1.05 * cuffBoost);
  }
  geo.computeVertexNormals();
  return geo;
}

function createGogglesGeometry(): THREE.BufferGeometry {
  // Stylized wrap-around ski goggles (wide across X, thin along Z, height along Y)
  const geo = createTaperedPrism({
    topRadiusX: 0.095,
    topRadiusZ: 0.045,
    bottomRadiusX: 0.090,
    bottomRadiusZ: 0.042,
    height: 0.055,
    radialSegments: 8,
  });
  return geo;
}

function createBootGeometry(yawRad: number): THREE.BufferGeometry {
  // Stylized chunky snowboard boot + lower shin tapered prism
  const geo = createTaperedPrism({
    topRadiusX: 0.068,
    topRadiusZ: 0.072,
    bottomRadiusX: 0.082,
    bottomRadiusZ: 0.115,
    height: 0.32,
    radialSegments: 8,
    heightSegments: 2,
  });
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Shift lower vertices along local +Z (which points toward world +X toe edge)
    const toeOffset = y < -0.06 ? 0.035 : 0;
    pos.setXYZ(i, x, y, z + toeOffset);
  }
  if (yawRad !== 0) {
    geo.rotateY(yawRad);
  }
  geo.computeVertexNormals();
  return geo;
}

function rigGeometryInBindSpace(
  geo: THREE.BufferGeometry,
  bone: THREE.Bone,
  boneIndex: number,
  localOffset: THREE.Vector3,
  localEuler?: THREE.Euler,
): THREE.BufferGeometry {
  if (localEuler) {
    const q = new THREE.Quaternion().setFromEuler(localEuler);
    geo.applyQuaternion(q);
  }
  geo.translate(localOffset.x, localOffset.y, localOffset.z);

  // Transform vertices from bone-local space into world bind space
  geo.applyMatrix4(bone.matrixWorld);
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) {
    if (p.getY(i) < 0.02) p.setY(i, 0.02);
  }
  geo.computeVertexNormals();

  const count = geo.attributes.position.count;
  const skinIndex = new Uint16Array(count * 4);
  const skinWeight = new Float32Array(count * 4);

  for (let i = 0; i < count; i++) {
    skinIndex[i * 4] = boneIndex;
    skinIndex[i * 4 + 1] = 0;
    skinIndex[i * 4 + 2] = 0;
    skinIndex[i * 4 + 3] = 0;
    skinWeight[i * 4] = 1;
    skinWeight[i * 4 + 1] = 0;
    skinWeight[i * 4 + 2] = 0;
    skinWeight[i * 4 + 3] = 0;
  }

  geo.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));

  const indexCount = geo.index ? geo.index.count : count;
  geo.clearGroups();
  geo.addGroup(0, indexCount, 0);

  return geo;
}

async function main(): Promise<void> {
  // Coordinate frame (ADR-0009 §7.2):
  // Board lies along Z (+Z = nose/downhill, -Z = tail/uphill)
  // +X = toe edge, -X = heel edge, +Y = up
  // Front binding at (0, 0.04, +0.35), back binding at (0, 0.04, -0.35)

  // 0: Hips (Pelvis) — athletic crouched stance (pos: 0, 0.56, 0), rotated sideways (~77.3° yaw)
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  hips.position.set(0, 0.56, 0);
  hips.rotation.set(0, 1.35, 0, 'YXZ');

  // 1: Spine (Waist / Mid-torso, parent: 0: Hips) — forward hinge +0.16 rad over toe edge in local +Z
  const spine = new THREE.Bone();
  spine.name = 'Spine';
  spine.position.set(0, 0.12, 0);
  spine.rotation.set(0.16, -0.08, 0.05, 'YXZ');
  hips.add(spine);

  // 2: Chest (Upper torso / Shoulders, parent: 1: Spine) — cumulative forward torso hinge +0.30 rad
  const chest = new THREE.Bone();
  chest.name = 'Chest';
  chest.position.set(0, 0.17, 0);
  chest.rotation.set(0.14, -0.12, 0.05, 'YXZ');
  spine.add(chest);

  // 3: Head (Head + Beanie + Goggles, parent: 2: Chest) — counter-tilts upright, turns downhill toward +Z
  const head = new THREE.Bone();
  head.name = 'Head';
  head.position.set(0, 0.24, 0.02);
  head.rotation.set(-0.22, -0.95, -0.06, 'YXZ');
  chest.add(head);

  // 4: LeftUpperArm (Back upper arm, parent: 2: Chest) — extends toward board tail (-Z)
  const leftUpperArm = new THREE.Bone();
  leftUpperArm.name = 'LeftUpperArm';
  leftUpperArm.position.set(0.20, 0.14, 0.0);
  leftUpperArm.rotation.set(0.25, 0.15, 0.85, 'YXZ');
  chest.add(leftUpperArm);

  // 5: LeftLowerArm (Back forearm, parent: 4: LeftUpperArm) — flexed elbow
  const leftLowerArm = new THREE.Bone();
  leftLowerArm.name = 'LeftLowerArm';
  leftLowerArm.position.set(0, -0.24, 0);
  leftLowerArm.rotation.set(-0.75, 0.2, 0.25, 'YXZ');
  leftUpperArm.add(leftLowerArm);

  // 6: RightUpperArm (Front upper arm, parent: 2: Chest) — extends toward board nose (+Z)
  const rightUpperArm = new THREE.Bone();
  rightUpperArm.name = 'RightUpperArm';
  rightUpperArm.position.set(-0.20, 0.14, 0.0);
  rightUpperArm.rotation.set(0.30, -0.15, -0.80, 'YXZ');
  chest.add(rightUpperArm);

  // 7: RightLowerArm (Front forearm, parent: 6: RightUpperArm) — flexed elbow
  const rightLowerArm = new THREE.Bone();
  rightLowerArm.name = 'RightLowerArm';
  rightLowerArm.position.set(0, -0.24, 0);
  rightLowerArm.rotation.set(-0.75, -0.2, -0.20, 'YXZ');
  rightUpperArm.add(rightLowerArm);

  // Calculate 3D leg bone kinematics
  hips.updateMatrixWorld(true);
  const hipsQuat = hips.quaternion.clone();

  // Left Leg: hip socket -> knee (0.12, 0.31, -0.31) -> ankle (0.0, 0.06, -0.35)
  const leftHipLocal = new THREE.Vector3(0.135, -0.03, -0.04);
  const leftHipWorld = leftHipLocal.clone().applyMatrix4(hips.matrixWorld);
  const leftKneeTarget = new THREE.Vector3(0.12, 0.31, -0.31);
  const leftAnkleTarget = new THREE.Vector3(0.0, 0.06, -0.35);

  const thighL = leftKneeTarget.clone().sub(leftHipWorld);
  const thighLenL = thighL.length();
  const dirThighHipsL = thighL.clone().normalize().applyQuaternion(hipsQuat.clone().invert());
  const qUpLegL = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirThighHipsL);

  const leftUpLeg = new THREE.Bone();
  leftUpLeg.name = 'LeftUpLeg';
  leftUpLeg.position.copy(leftHipLocal);
  leftUpLeg.quaternion.copy(qUpLegL);
  leftUpLeg.rotation.setFromQuaternion(qUpLegL, 'YXZ');
  hips.add(leftUpLeg);
  hips.updateMatrixWorld(true);

  const leftLeg = new THREE.Bone();
  leftLeg.name = 'LeftLeg';
  leftLeg.position.set(0, -thighLenL, 0);

  const upLegWorldQuatL = leftUpLeg.getWorldQuaternion(new THREE.Quaternion());
  const shinL = leftAnkleTarget.clone().sub(leftKneeTarget);
  const shinLenL = shinL.length();
  const dirShinUpLegL = shinL.clone().normalize().applyQuaternion(upLegWorldQuatL.clone().invert());
  const qLegL = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirShinUpLegL);
  leftLeg.quaternion.copy(qLegL);
  leftLeg.rotation.setFromQuaternion(qLegL, 'YXZ');
  leftUpLeg.add(leftLeg);

  // Right Leg: hip socket -> knee (0.13, 0.31, 0.32) -> ankle (0.0, 0.06, 0.35)
  const rightHipLocal = new THREE.Vector3(-0.135, -0.03, 0.04);
  const rightHipWorld = rightHipLocal.clone().applyMatrix4(hips.matrixWorld);
  const rightKneeTarget = new THREE.Vector3(0.13, 0.31, 0.32);
  const rightAnkleTarget = new THREE.Vector3(0.0, 0.06, 0.35);

  const thighR = rightKneeTarget.clone().sub(rightHipWorld);
  const thighLenR = thighR.length();
  const dirThighHipsR = thighR.clone().normalize().applyQuaternion(hipsQuat.clone().invert());
  const qUpLegR = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirThighHipsR);

  const rightUpLeg = new THREE.Bone();
  rightUpLeg.name = 'RightUpLeg';
  rightUpLeg.position.copy(rightHipLocal);
  rightUpLeg.quaternion.copy(qUpLegR);
  rightUpLeg.rotation.setFromQuaternion(qUpLegR, 'YXZ');
  hips.add(rightUpLeg);
  hips.updateMatrixWorld(true);

  const rightLeg = new THREE.Bone();
  rightLeg.name = 'RightLeg';
  rightLeg.position.set(0, -thighLenR, 0);

  const upLegWorldQuatR = rightUpLeg.getWorldQuaternion(new THREE.Quaternion());
  const shinR = rightAnkleTarget.clone().sub(rightKneeTarget);
  const shinLenR = shinR.length();
  const dirShinUpLegR = shinR.clone().normalize().applyQuaternion(upLegWorldQuatR.clone().invert());
  const qLegR = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, -1, 0), dirShinUpLegR);
  rightLeg.quaternion.copy(qLegR);
  rightLeg.rotation.setFromQuaternion(qLegR, 'YXZ');
  rightUpLeg.add(rightLeg);

  hips.updateMatrixWorld(true);

  const bones: THREE.Bone[] = [
    hips, spine, chest, head,
    leftUpperArm, leftLowerArm, rightUpperArm, rightLowerArm,
    leftUpLeg, leftLeg, rightUpLeg, rightLeg
  ];
  const skeleton = new THREE.Skeleton(bones);

  const materials = [
    new THREE.MeshStandardMaterial({ color: 0xf3b07c, name: 'skin', flatShading: true, roughness: 0.8, metalness: 0.0 }),
    new THREE.MeshStandardMaterial({ color: 0xff3366, name: 'jacket', flatShading: true, roughness: 0.8, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: 0x4a154b, name: 'pants', flatShading: true, roughness: 0.85, metalness: 0.05 }),
    new THREE.MeshStandardMaterial({ color: 0x1f2421, name: 'boots', flatShading: true, roughness: 0.9, metalness: 0.0 }),
    new THREE.MeshStandardMaterial({ color: 0xffcc00, name: 'beanie', flatShading: true, roughness: 0.9, metalness: 0.0 }),
    new THREE.MeshStandardMaterial({ color: 0x00f0ff, name: 'goggles', flatShading: true, roughness: 0.2, metalness: 0.8 }),
  ];

  const M = { skin: 0, jacket: 1, pants: 2, boots: 3, beanie: 4, goggles: 5 };

  // Build stylized PS1 low-poly humanoid parts
  const parts: Array<{
    name: string;
    bone: number;
    mat: number;
    geo: THREE.BufferGeometry;
    offset: THREE.Vector3;
    rot?: THREE.Euler;
  }> = [
    // 0: Pelvis / Hips: tapered 8-sided prism
    {
      name: 'hips_mesh',
      bone: 0,
      mat: M.pants,
      geo: createTaperedPrism({
        topRadiusX: 0.13,
        topRadiusZ: 0.17,
        bottomRadiusX: 0.145,
        bottomRadiusZ: 0.195,
        height: 0.20,
        radialSegments: 8,
      }),
      offset: new THREE.Vector3(0, 0.01, 0),
    },
    // 1: Mid-torso / Waist (Spine)
    {
      name: 'spine_mesh',
      bone: 1,
      mat: M.jacket,
      geo: createTaperedPrism({
        topRadiusX: 0.155,
        topRadiusZ: 0.205,
        bottomRadiusX: 0.128,
        bottomRadiusZ: 0.168,
        height: 0.22,
        radialSegments: 8,
      }),
      offset: new THREE.Vector3(0, 0.06, 0),
    },
    // 2: Upper torso / Chest: broader shoulders
    {
      name: 'chest_mesh',
      bone: 2,
      mat: M.jacket,
      geo: createTaperedPrism({
        topRadiusX: 0.17,
        topRadiusZ: 0.24,
        bottomRadiusX: 0.148,
        bottomRadiusZ: 0.195,
        height: 0.28,
        radialSegments: 8,
        heightSegments: 2,
      }),
      offset: new THREE.Vector3(0, 0.08, 0),
    },
    // 3: Head: stylized low-poly sphere
    {
      name: 'head_mesh',
      bone: 3,
      mat: M.skin,
      geo: (() => {
        const g = new THREE.SphereGeometry(0.12, 8, 6);
        g.scale(0.95, 1.25, 0.98);
        return g;
      })(),
      offset: new THREE.Vector3(0, 0.16, 0),
    },
    // 3: Beanie: low-poly hemisphere dome crowning the head
    {
      name: 'beanie_mesh',
      bone: 3,
      mat: M.beanie,
      geo: createBeanieGeometry(),
      offset: new THREE.Vector3(0, 0.25, -0.005),
      rot: new THREE.Euler(-0.08, 0, 0),
    },
    // 3: Goggles: wrap-around visor facing downhill (+Z)
    {
      name: 'goggles_mesh',
      bone: 3,
      mat: M.goggles,
      geo: createGogglesGeometry(),
      offset: new THREE.Vector3(0, 0.17, 0.105),
    },
    // 4: Left Upper Arm (back arm sleeve)
    {
      name: 'left_upper_arm_mesh',
      bone: 4,
      mat: M.jacket,
      geo: createTaperedPrism({
        topRadiusX: 0.065,
        topRadiusZ: 0.065,
        bottomRadiusX: 0.050,
        bottomRadiusZ: 0.050,
        height: 0.24,
        radialSegments: 7,
      }),
      offset: new THREE.Vector3(0, -0.12, 0),
    },
    // 4: Left Elbow Sphere Cap (gapless elbow joint)
    {
      name: 'left_elbow_mesh',
      bone: 4,
      mat: M.jacket,
      geo: new THREE.SphereGeometry(0.048, 6, 5),
      offset: new THREE.Vector3(0, -0.24, 0),
    },
    // 5: Left Lower Arm (back forearm)
    {
      name: 'left_lower_arm_mesh',
      bone: 5,
      mat: M.skin,
      geo: createTaperedPrism({
        topRadiusX: 0.05,
        topRadiusZ: 0.05,
        bottomRadiusX: 0.038,
        bottomRadiusZ: 0.044,
        height: 0.19,
        radialSegments: 7,
      }),
      offset: new THREE.Vector3(0, -0.095, 0),
    },
    // 5: Left Glove (dark boots-colored glove at hand end)
    {
      name: 'left_glove_mesh',
      bone: 5,
      mat: M.boots,
      geo: (() => {
        const g = new THREE.SphereGeometry(0.045, 6, 4);
        g.scale(0.9, 1.3, 1.1);
        return g;
      })(),
      offset: new THREE.Vector3(0, -0.22, 0),
    },
    // 6: Right Upper Arm (front arm sleeve)
    {
      name: 'right_upper_arm_mesh',
      bone: 6,
      mat: M.jacket,
      geo: createTaperedPrism({
        topRadiusX: 0.065,
        topRadiusZ: 0.065,
        bottomRadiusX: 0.050,
        bottomRadiusZ: 0.050,
        height: 0.24,
        radialSegments: 7,
      }),
      offset: new THREE.Vector3(0, -0.12, 0),
    },
    // 6: Right Elbow Sphere Cap (gapless elbow joint)
    {
      name: 'right_elbow_mesh',
      bone: 6,
      mat: M.jacket,
      geo: new THREE.SphereGeometry(0.048, 6, 5),
      offset: new THREE.Vector3(0, -0.24, 0),
    },
    // 7: Right Lower Arm (front forearm)
    {
      name: 'right_lower_arm_mesh',
      bone: 7,
      mat: M.skin,
      geo: createTaperedPrism({
        topRadiusX: 0.05,
        topRadiusZ: 0.05,
        bottomRadiusX: 0.038,
        bottomRadiusZ: 0.044,
        height: 0.19,
        radialSegments: 7,
      }),
      offset: new THREE.Vector3(0, -0.095, 0),
    },
    // 7: Right Glove (dark boots-colored glove at hand end)
    {
      name: 'right_glove_mesh',
      bone: 7,
      mat: M.boots,
      geo: (() => {
        const g = new THREE.SphereGeometry(0.045, 6, 4);
        g.scale(0.9, 1.3, 1.1);
        return g;
      })(),
      offset: new THREE.Vector3(0, -0.22, 0),
    },
    // 8: Left Upper Leg (back thigh)
    {
      name: 'left_up_leg_mesh',
      bone: 8,
      mat: M.pants,
      geo: createTaperedPrism({
        topRadiusX: 0.095,
        topRadiusZ: 0.10,
        bottomRadiusX: 0.075,
        bottomRadiusZ: 0.080,
        height: thighLenL,
        radialSegments: 8,
      }),
      offset: new THREE.Vector3(0, -thighLenL / 2, 0),
    },
    // 8: Left Knee Sphere Cap (gapless knee overlap)
    {
      name: 'left_knee_mesh',
      bone: 8,
      mat: M.pants,
      geo: new THREE.SphereGeometry(0.074, 6, 5),
      offset: new THREE.Vector3(0, -thighLenL, 0),
    },
    // 9: Left Shin & Boot (back lower leg over z = -0.35 binding)
    {
      name: 'left_leg_mesh',
      bone: 9,
      mat: M.boots,
      geo: createBootGeometry(0),
      offset: new THREE.Vector3(0, -0.16, 0),
    },
    // 10: Right Upper Leg (front thigh)
    {
      name: 'right_up_leg_mesh',
      bone: 10,
      mat: M.pants,
      geo: createTaperedPrism({
        topRadiusX: 0.095,
        topRadiusZ: 0.10,
        bottomRadiusX: 0.075,
        bottomRadiusZ: 0.080,
        height: thighLenR,
        radialSegments: 8,
      }),
      offset: new THREE.Vector3(0, -thighLenR / 2, 0),
    },
    // 10: Right Knee Sphere Cap (gapless knee overlap)
    {
      name: 'right_knee_mesh',
      bone: 10,
      mat: M.pants,
      geo: new THREE.SphereGeometry(0.074, 6, 5),
      offset: new THREE.Vector3(0, -thighLenR, 0),
    },
    // 11: Right Shin & Boot (front lower leg over z = +0.35 binding)
    {
      name: 'right_leg_mesh',
      bone: 11,
      mat: M.boots,
      geo: createBootGeometry(0),
      offset: new THREE.Vector3(0, -0.16, 0),
    },
  ];

  const riderGroup = new THREE.Group();
  riderGroup.name = 'rider';
  riderGroup.add(bones[0]);

  const bindBox = new THREE.Box3();

  for (const p of parts) {
    const geo = rigGeometryInBindSpace(p.geo, bones[p.bone], p.bone, p.offset, p.rot);
    geo.computeBoundingBox();
    if (geo.boundingBox) {
      bindBox.union(geo.boundingBox);
    }
    const mesh = new THREE.SkinnedMesh(geo, materials[p.mat]);
    mesh.name = p.name;
    mesh.bind(skeleton);
    riderGroup.add(mesh);
  }

  const scene = new THREE.Scene();
  scene.name = 'rider_scene';
  scene.add(riderGroup);

  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();

  const glbBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          reject(new Error('GLTFExporter returned JSON instead of ArrayBuffer'));
        }
      },
      (err: any) => {
        reject(err);
      },
      { binary: true, onlyVisible: true },
    );
  });

  if (glbBuffer.byteLength < 12) {
    throw new Error(`Generated buffer too small: ${glbBuffer.byteLength} bytes`);
  }
  const view = new DataView(glbBuffer);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) {
    throw new Error(`Invalid GLB magic header: 0x${magic.toString(16)} (expected 0x46546c67)`);
  }

  ensureDir(OUT_DIR);
  const outPath = path.join(OUT_DIR, 'rider.glb');
  fs.writeFileSync(outPath, Buffer.from(glbBuffer));
  const stats = fs.statSync(outPath);

  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const gltf = await new Promise<any>((resolve, reject) => {
    loader.parse(
      glbBuffer,
      '',
      (gltf: any) => resolve(gltf),
      (err: any) => reject(err),
    );
  });

  let skinnedMeshCount = 0;
  let boneCount = 0;
  let loadedTriangles = 0;
  const loadedBindBox = new THREE.Box3();
  const v = new THREE.Vector3();

  gltf.scene.updateMatrixWorld(true);
  const loadedBones: Record<string, THREE.Bone> = {};
  gltf.scene.traverse((child: any) => {
    if (child.isBone) {
      loadedBones[child.name] = child;
    }
    if (child.isSkinnedMesh) {
      skinnedMeshCount++;
      const sm = child as THREE.SkinnedMesh;
      if (sm.skeleton) {
        boneCount = sm.skeleton.bones.length;
        sm.skeleton.update();
      }
      const pos = sm.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        sm.applyBoneTransform(i, v);
        v.applyMatrix4(sm.matrixWorld);
        loadedBindBox.expandByPoint(v);
      }
      if (sm.geometry && sm.geometry.index) {
        loadedTriangles += sm.geometry.index.count / 3;
      } else if (pos) {
        loadedTriangles += pos.count / 3;
      }
    }
  });

  // Extract bone transforms for kinematic assertions
  const hipsBone = loadedBones['Hips'];
  const leftLegBone = loadedBones['LeftLeg'];
  const rightLegBone = loadedBones['RightLeg'];
  const leftUpLegBone = loadedBones['LeftUpLeg'];
  const rightUpLegBone = loadedBones['RightUpLeg'];
  const leftUpperArmBone = loadedBones['LeftUpperArm'];
  const leftLowerArmBone = loadedBones['LeftLowerArm'];
  const rightUpperArmBone = loadedBones['RightUpperArm'];
  const rightLowerArmBone = loadedBones['RightLowerArm'];

  if (!hipsBone || !leftLegBone || !rightLegBone || !leftUpLegBone || !rightUpLegBone ||
      !leftUpperArmBone || !leftLowerArmBone || !rightUpperArmBone || !rightLowerArmBone) {
    throw new Error('Missing one or more required bones in exported GLB');
  }

  const hipsWorldPos = hipsBone.getWorldPosition(new THREE.Vector3());
  const hipsWorldEuler = new THREE.Euler().setFromQuaternion(hipsBone.getWorldQuaternion(new THREE.Quaternion()), 'YXZ');

  const leftKneePos = leftLegBone.getWorldPosition(new THREE.Vector3());
  const rightKneePos = rightLegBone.getWorldPosition(new THREE.Vector3());
  const leftHipPos = leftUpLegBone.getWorldPosition(new THREE.Vector3());
  const rightHipPos = rightUpLegBone.getWorldPosition(new THREE.Vector3());

  const leftAnklePos = new THREE.Vector3(0, -shinLenL, 0).applyMatrix4(leftLegBone.matrixWorld);
  const rightAnklePos = new THREE.Vector3(0, -shinLenR, 0).applyMatrix4(rightLegBone.matrixWorld);

  const thighVecL = leftKneePos.clone().sub(leftHipPos).normalize();
  const shinVecL = leftAnklePos.clone().sub(leftKneePos).normalize();
  const kneeBendL = thighVecL.angleTo(shinVecL);

  const thighVecR = rightKneePos.clone().sub(rightHipPos).normalize();
  const shinVecR = rightAnklePos.clone().sub(rightKneePos).normalize();
  const kneeBendR = thighVecR.angleTo(shinVecR);

  const leftShoulderPos = leftUpperArmBone.getWorldPosition(new THREE.Vector3());
  const leftElbowPos = leftLowerArmBone.getWorldPosition(new THREE.Vector3());
  const leftHandPos = new THREE.Vector3(0, -0.24, 0).applyMatrix4(leftLowerArmBone.matrixWorld);
  const leftUpperArmVec = leftElbowPos.clone().sub(leftShoulderPos).normalize();
  const leftLowerArmVec = leftHandPos.clone().sub(leftElbowPos).normalize();
  const leftElbowAngle = leftUpperArmVec.angleTo(leftLowerArmVec);

  const rightShoulderPos = rightUpperArmBone.getWorldPosition(new THREE.Vector3());
  const rightElbowPos = rightLowerArmBone.getWorldPosition(new THREE.Vector3());
  const rightHandPos = new THREE.Vector3(0, -0.24, 0).applyMatrix4(rightLowerArmBone.matrixWorld);
  const rightUpperArmVec = rightElbowPos.clone().sub(rightShoulderPos).normalize();
  const rightLowerArmVec = rightHandPos.clone().sub(rightElbowPos).normalize();
  const rightElbowAngle = rightUpperArmVec.angleTo(rightLowerArmVec);

  console.log(`Exported ${outPath}`);
  console.log(`  Size:              ${stats.size} bytes`);
  console.log(`  SkinnedMesh:       ${skinnedMeshCount}`);
  console.log(`  Bones:             ${boneCount}`);
  console.log(`  Triangles:         ${loadedTriangles}`);
  console.log(`  BindBBox Y:        [${loadedBindBox.min.y.toFixed(3)}, ${loadedBindBox.max.y.toFixed(3)}]`);
  console.log(`  BindBBox Z:        [${loadedBindBox.min.z.toFixed(3)}, ${loadedBindBox.max.z.toFixed(3)}]`);
  console.log(`  BindBBox X:        [${loadedBindBox.min.x.toFixed(3)}, ${loadedBindBox.max.x.toFixed(3)}]`);
  console.log(`  Hips World Y:      ${hipsWorldPos.y.toFixed(3)} (rotY: ${hipsWorldEuler.y.toFixed(3)} rad)`);
  console.log(`  Left Knee Joint:   (${leftKneePos.x.toFixed(3)}, ${leftKneePos.y.toFixed(3)}, ${leftKneePos.z.toFixed(3)}) flex: ${kneeBendL.toFixed(3)} rad (${(kneeBendL * 180 / Math.PI).toFixed(1)}°)`);
  console.log(`  Right Knee Joint:  (${rightKneePos.x.toFixed(3)}, ${rightKneePos.y.toFixed(3)}, ${rightKneePos.z.toFixed(3)}) flex: ${kneeBendR.toFixed(3)} rad (${(kneeBendR * 180 / Math.PI).toFixed(1)}°)`);
  console.log(`  Left Elbow Bend:   ${leftElbowAngle.toFixed(3)} rad (${(leftElbowAngle * 180 / Math.PI).toFixed(1)}°)`);
  console.log(`  Right Elbow Bend:  ${rightElbowAngle.toFixed(3)} rad (${(rightElbowAngle * 180 / Math.PI).toFixed(1)}°)`);
  console.log(`  Magic:             0x${magic.toString(16)}`);

  // Self-verification assertions
  if (loadedTriangles >= 2000) {
    throw new Error(`Triangle budget exceeded: ${loadedTriangles} >= 2000`);
  }
  if (stats.size >= 200_000) {
    throw new Error(`File size budget exceeded: ${stats.size} >= 200000 bytes`);
  }
  if (loadedBindBox.min.y < 0.0 || loadedBindBox.max.y < 1.42) {
    throw new Error(
      `Invalid bind pose Y bounds: minY=${loadedBindBox.min.y.toFixed(3)} (expected >= 0.0), maxY=${loadedBindBox.max.y.toFixed(3)} (expected >= 1.42)`
    );
  }
  if (loadedBindBox.min.z >= -0.35 || loadedBindBox.max.z <= 0.35) {
    throw new Error(
      `Invalid bind pose Z bounds: minZ=${loadedBindBox.min.z.toFixed(3)} (expected < -0.35), maxZ=${loadedBindBox.max.z.toFixed(3)} (expected > 0.35)`
    );
  }
  if (hipsWorldPos.y < 0.50 || hipsWorldPos.y > 0.62) {
    throw new Error(`Hips world Y=${hipsWorldPos.y.toFixed(3)} out of expected range [0.50, 0.62]`);
  }
  if (hipsWorldEuler.y < 1.20) {
    throw new Error(`Hips Y-rotation=${hipsWorldEuler.y.toFixed(3)} rad below expected >= 1.20 rad`);
  }
  if (leftKneePos.x < 0.08 || leftKneePos.y < 0.26 || leftKneePos.y > 0.36 || kneeBendL < 0.50) {
    throw new Error(
      `Left knee kinematic check failed: x=${leftKneePos.x.toFixed(3)} (expected >= 0.08), y=${leftKneePos.y.toFixed(3)} (expected [0.26, 0.36]), flex=${kneeBendL.toFixed(3)} (expected >= 0.50)`
    );
  }
  if (rightKneePos.x < 0.08 || rightKneePos.y < 0.26 || rightKneePos.y > 0.36 || kneeBendR < 0.50) {
    throw new Error(
      `Right knee kinematic check failed: x=${rightKneePos.x.toFixed(3)} (expected >= 0.08), y=${rightKneePos.y.toFixed(3)} (expected [0.26, 0.36]), flex=${kneeBendR.toFixed(3)} (expected >= 0.50)`
    );
  }
  if (leftElbowAngle < 0.50 || rightElbowAngle < 0.50) {
    throw new Error(
      `Elbow flexion check failed: left=${leftElbowAngle.toFixed(3)}, right=${rightElbowAngle.toFixed(3)} (expected >= 0.50)`
    );
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
