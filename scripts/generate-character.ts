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

function createRiggedBox(
  w: number,
  h: number,
  d: number,
  ox: number,
  oy: number,
  oz: number,
  boneIndex: number,
  matIndex: number,
): THREE.BoxGeometry {
  const geo = new THREE.BoxGeometry(w, h, d);
  geo.translate(ox, oy, oz);

  const count = geo.attributes.position.count;
  const skinIndex = new Float32Array(count * 4);
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
  geo.addGroup(0, indexCount, matIndex);

  return geo;
}

async function main(): Promise<void> {
  const boneDefs = [
    { name: 'Hips', parent: -1, pos: new THREE.Vector3(0, 0.92, 0) },
    { name: 'Spine', parent: 0, pos: new THREE.Vector3(0, 0.10, 0) },
    { name: 'Chest', parent: 1, pos: new THREE.Vector3(0, 0.18, 0) },
    { name: 'Head', parent: 2, pos: new THREE.Vector3(0, 0.38, 0.02) },
    { name: 'LeftUpperArm', parent: 2, pos: new THREE.Vector3(0.22, 0.10, 0) },
    { name: 'LeftLowerArm', parent: 4, pos: new THREE.Vector3(0, -0.30, 0) },
    { name: 'RightUpperArm', parent: 2, pos: new THREE.Vector3(-0.22, 0.10, 0) },
    { name: 'RightLowerArm', parent: 6, pos: new THREE.Vector3(0, -0.30, 0) },
    { name: 'LeftUpLeg', parent: 0, pos: new THREE.Vector3(0.10, -0.10, 0) },
    { name: 'LeftLeg', parent: 8, pos: new THREE.Vector3(0, -0.44, 0) },
    { name: 'RightUpLeg', parent: 0, pos: new THREE.Vector3(-0.10, -0.10, 0) },
    { name: 'RightLeg', parent: 10, pos: new THREE.Vector3(0, -0.44, 0) },
  ];

  const bones: THREE.Bone[] = [];
  for (const def of boneDefs) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    bone.position.copy(def.pos);
    bones.push(bone);
    if (def.parent >= 0) {
      bones[def.parent].add(bone);
    }
  }

  bones[0].updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  const materials = [
    new THREE.MeshStandardMaterial({ color: 0xffccaa, name: 'skin', flatShading: true, roughness: 0.7, metalness: 0.0 }),
    new THREE.MeshStandardMaterial({ color: 0xff00aa, name: 'jacket', flatShading: true, roughness: 0.8, metalness: 0.1 }),
    new THREE.MeshStandardMaterial({ color: 0x8800ff, name: 'pants', flatShading: true, roughness: 0.8, metalness: 0.1 }),
    new THREE.MeshStandardMaterial({ color: 0x333333, name: 'boots', flatShading: true, roughness: 0.9, metalness: 0.0 }),
    new THREE.MeshStandardMaterial({ color: 0xffdd00, name: 'beanie', flatShading: true, roughness: 0.9, metalness: 0.0 }),
    new THREE.MeshStandardMaterial({ color: 0x00ffff, name: 'goggles', flatShading: true, roughness: 0.2, metalness: 0.3 }),
  ];

  const M = { skin: 0, jacket: 1, pants: 2, boots: 3, beanie: 4, goggles: 5 };

  // Build each body part as its own SkinnedMesh sharing one skeleton
  const parts = [
    { w: 0.28, h: 0.18, d: 0.22, ox: 0, oy: 0, oz: 0, bone: 0, mat: M.pants, name: 'hips_mesh' },
    { w: 0.26, h: 0.14, d: 0.20, ox: 0, oy: 0, oz: 0, bone: 1, mat: M.jacket, name: 'spine_mesh' },
    { w: 0.30, h: 0.22, d: 0.22, ox: 0, oy: 0, oz: 0, bone: 2, mat: M.jacket, name: 'chest_mesh' },
    { w: 0.16, h: 0.20, d: 0.18, ox: 0, oy: 0.02, oz: 0.02, bone: 3, mat: M.skin, name: 'head_mesh' },
    { w: 0.17, h: 0.06, d: 0.19, ox: 0, oy: 0.15, oz: 0.02, bone: 3, mat: M.beanie, name: 'beanie_mesh' },
    { w: 0.14, h: 0.05, d: 0.04, ox: 0, oy: 0.04, oz: 0.11, bone: 3, mat: M.goggles, name: 'goggles_mesh' },
    { w: 0.10, h: 0.28, d: 0.10, ox: 0, oy: -0.10, oz: 0, bone: 4, mat: M.jacket, name: 'left_upper_arm_mesh' },
    { w: 0.09, h: 0.26, d: 0.09, ox: 0, oy: -0.12, oz: 0, bone: 5, mat: M.skin, name: 'left_lower_arm_mesh' },
    { w: 0.10, h: 0.28, d: 0.10, ox: 0, oy: -0.10, oz: 0, bone: 6, mat: M.jacket, name: 'right_upper_arm_mesh' },
    { w: 0.09, h: 0.26, d: 0.09, ox: 0, oy: -0.12, oz: 0, bone: 7, mat: M.skin, name: 'right_lower_arm_mesh' },
    { w: 0.13, h: 0.42, d: 0.14, ox: 0, oy: -0.22, oz: 0, bone: 8, mat: M.pants, name: 'left_up_leg_mesh' },
    { w: 0.11, h: 0.40, d: 0.12, ox: 0, oy: -0.20, oz: 0.02, bone: 9, mat: M.boots, name: 'left_leg_mesh' },
    { w: 0.13, h: 0.42, d: 0.14, ox: 0, oy: -0.22, oz: 0, bone: 10, mat: M.pants, name: 'right_up_leg_mesh' },
    { w: 0.11, h: 0.40, d: 0.12, ox: 0, oy: -0.20, oz: 0.02, bone: 11, mat: M.boots, name: 'right_leg_mesh' },
  ];

  const riderGroup = new THREE.Group();
  riderGroup.name = 'rider';
  riderGroup.add(bones[0]);

  let totalTriangles = 0;

  for (const p of parts) {
    const geo = createRiggedBox(p.w, p.h, p.d, p.ox, p.oy, p.oz, p.bone, 0);
    const mesh = new THREE.SkinnedMesh(geo, materials[p.mat]);
    mesh.name = p.name;
    mesh.bind(skeleton);
    riderGroup.add(mesh);
    if (geo.index) {
      totalTriangles += geo.index.count / 3;
    }
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
  gltf.scene.traverse((child: any) => {
    if (child.isSkinnedMesh) {
      skinnedMeshCount++;
      if (child.skeleton) {
        boneCount = child.skeleton.bones.length;
      }
      if (child.geometry && child.geometry.index) {
        totalTriangles += child.geometry.index.count / 3;
      }
    }
  });

  console.log(`Exported ${outPath}`);
  console.log(`  Size:        ${stats.size} bytes`);
  console.log(`  SkinnedMesh: ${skinnedMeshCount}`);
  console.log(`  Bones:       ${boneCount}`);
  console.log(`  Triangles:   ${totalTriangles}`);
  console.log(`  Magic:       0x${magic.toString(16)}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
