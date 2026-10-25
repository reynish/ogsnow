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
  // Base unit cylinder of height 1, radius 1, then scale X/Z per height row
  const geo = new THREE.CylinderGeometry(1, 1, opts.height, radialSegs, heightSegs, false);
  const pos = geo.attributes.position;
  const halfH = opts.height / 2;

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // t = 0 at bottom (-halfH), t = 1 at top (+halfH)
    const t = Math.max(0, Math.min(1, (y + halfH) / opts.height));
    const rx = opts.bottomRadiusX + (opts.topRadiusX - opts.bottomRadiusX) * t;
    const rz = opts.bottomRadiusZ + (opts.topRadiusZ - opts.bottomRadiusZ) * t;
    pos.setXYZ(i, x * rx, y, z * rz);
  }
  geo.computeVertexNormals();
  return geo;
}

function createBeanieGeometry(): THREE.BufferGeometry {
  // Low-poly hemisphere / flattened dome with folded cuff and pom-pom on top
  const geo = new THREE.SphereGeometry(0.125, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.62);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Slightly elongate front-to-back and flatten height for stylized beanie silhouette
    const cuffBoost = y < 0.03 ? 1.08 : 1.0;
    pos.setXYZ(i, x * 0.96 * cuffBoost, y * 0.88, z * 1.05 * cuffBoost);
  }
  geo.computeVertexNormals();
  return geo;
}

function createGogglesGeometry(): THREE.BufferGeometry {
  // Stylized wrap-around ski goggles (8-sided curved visor prism)
  const geo = createTaperedPrism({
    topRadiusX: 0.045,
    topRadiusZ: 0.095,
    bottomRadiusX: 0.042,
    bottomRadiusZ: 0.09,
    height: 0.055,
    radialSegments: 6,
  });
  return geo;
}

function createBootGeometry(yawRad: number): THREE.BufferGeometry {
  // Stylized chunky snowboard boot + lower shin cuff tapered prism
  const geo = createTaperedPrism({
    topRadiusX: 0.068,
    topRadiusZ: 0.072,
    bottomRadiusX: 0.082,
    bottomRadiusZ: 0.115,
    height: 0.34,
    radialSegments: 8,
    heightSegments: 2,
  });
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Shift lower vertices forward (+X in local foot space before yaw) to form boot toe box
    const toeOffset = y < -0.06 ? 0.035 : 0;
    pos.setXYZ(i, x + toeOffset, y, z);
  }
  geo.rotateY(yawRad);
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
  // because mesh.bind(skeleton) sets boneInverse = inverse(bone.matrixWorld)
  geo.applyMatrix4(bone.matrixWorld);
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
  // Sideways snowboard stance (regular stance: left/back foot at z=-0.35, right/front foot at z=+0.35)
  // Hips and chest rotated ~0.25-0.30 rad on Y axis; head/goggles turned toward +Z (downhill)
  const boneDefs: Array<{
    name: string;
    parent: number;
    pos: THREE.Vector3;
    rot?: THREE.Euler;
  }> = [
    // 0: Hips — centered above board, angled sideways (0.26 rad on Y)
    {
      name: 'Hips',
      parent: -1,
      pos: new THREE.Vector3(0, 0.72, 0),
      rot: new THREE.Euler(0, 0.26, 0, 'YXZ'),
    },
    // 1: Spine — rises from hips
    {
      name: 'Spine',
      parent: 0,
      pos: new THREE.Vector3(0, 0.14, 0),
      rot: new THREE.Euler(0.04, 0.02, 0, 'YXZ'),
    },
    // 2: Chest — upper torso rotated slightly further toward downhill (+Z)
    {
      name: 'Chest',
      parent: 1,
      pos: new THREE.Vector3(0, 0.18, 0),
      rot: new THREE.Euler(0.02, 0.04, 0, 'YXZ'),
    },
    // 3: Head — atop chest, turned toward +Z (downhill)
    {
      name: 'Head',
      parent: 2,
      pos: new THREE.Vector3(0, 0.26, 0.02),
      rot: new THREE.Euler(0, 0.35, 0, 'YXZ'),
    },
    // 4: LeftUpperArm (Back arm — raised toward tail -Z)
    {
      name: 'LeftUpperArm',
      parent: 2,
      pos: new THREE.Vector3(-0.04, 0.12, -0.22),
      rot: new THREE.Euler(0.75, 0, -0.25, 'YXZ'),
    },
    // 5: LeftLowerArm (Back forearm — extends toward tail -Z)
    {
      name: 'LeftLowerArm',
      parent: 4,
      pos: new THREE.Vector3(0, -0.24, -0.04),
      rot: new THREE.Euler(0.35, 0, -0.15, 'YXZ'),
    },
    // 6: RightUpperArm (Front arm — raised toward nose +Z)
    {
      name: 'RightUpperArm',
      parent: 2,
      pos: new THREE.Vector3(0.04, 0.12, 0.22),
      rot: new THREE.Euler(-0.75, 0, 0.25, 'YXZ'),
    },
    // 7: RightLowerArm (Front forearm — extends toward nose +Z)
    {
      name: 'RightLowerArm',
      parent: 6,
      pos: new THREE.Vector3(0, -0.24, 0.04),
      rot: new THREE.Euler(-0.35, 0, 0.15, 'YXZ'),
    },
    // 8: LeftUpLeg (Back upper leg — world hip socket above back binding, world Z ≈ -0.18, angled toward z = -0.35)
    {
      name: 'LeftUpLeg',
      parent: 0,
      pos: new THREE.Vector3(0.046, -0.04, -0.174),
      rot: new THREE.Euler(0.2, -0.26, 0, 'YXZ'),
    },
    // 9: LeftLeg (Back lower leg/boot — world ankle at (0, 0.09, -0.35) over back binding)
    {
      name: 'LeftLeg',
      parent: 8,
      pos: new THREE.Vector3(0, -0.59, -0.052),
      rot: new THREE.Euler(-0.2, 0, 0, 'YXZ'),
    },
    // 10: RightUpLeg (Front upper leg — world hip socket above front binding, world Z ≈ +0.18, angled toward z = +0.35)
    {
      name: 'RightUpLeg',
      parent: 0,
      pos: new THREE.Vector3(-0.046, -0.04, 0.174),
      rot: new THREE.Euler(-0.2, -0.26, 0, 'YXZ'),
    },
    // 11: RightLeg (Front lower leg/boot — world ankle at (0, 0.09, +0.35) over front binding)
    {
      name: 'RightLeg',
      parent: 10,
      pos: new THREE.Vector3(0, -0.59, 0.052),
      rot: new THREE.Euler(0.2, 0, 0, 'YXZ'),
    },
  ];

  const bones: THREE.Bone[] = [];
  for (const def of boneDefs) {
    const bone = new THREE.Bone();
    bone.name = def.name;
    bone.position.copy(def.pos);
    if (def.rot) {
      bone.rotation.copy(def.rot);
    }
    bones.push(bone);
    if (def.parent >= 0) {
      bones[def.parent].add(bone);
    }
  }

  bones[0].updateMatrixWorld(true);
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

  // Build stylized PS1 low-poly humanoid parts using tapered 6- to 8-sided primitives and low-poly spheres
  const parts: Array<{
    name: string;
    bone: number;
    mat: number;
    geo: THREE.BufferGeometry;
    offset: THREE.Vector3;
    rot?: THREE.Euler;
  }> = [
    // Pelvis / Hips: tapered 8-sided prism, wider at hips, narrower at waist
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
    // Mid-torso / Waist (Spine): tapered 8-sided prism expanding from waist to lower ribs
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
    // Upper torso / Chest: broader shoulders (along Z in sideways stance) tapering down to ribs
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
    // Head: low-poly 8x6 stylized sphere (slightly taller than wide)
    {
      name: 'head_mesh',
      bone: 3,
      mat: M.skin,
      geo: (() => {
        const g = new THREE.SphereGeometry(0.115, 8, 6);
        g.scale(0.95, 1.12, 0.98);
        return g;
      })(),
      offset: new THREE.Vector3(0, 0.08, 0),
    },
    // Beanie: low-poly hemisphere dome crowning the head up to y >= 1.54
    {
      name: 'beanie_mesh',
      bone: 3,
      mat: M.beanie,
      geo: createBeanieGeometry(),
      offset: new THREE.Vector3(0, 0.13, -0.005),
      rot: new THREE.Euler(-0.08, 0, 0),
    },
    // Goggles: wrap-around visor facing downhill (+Z)
    {
      name: 'goggles_mesh',
      bone: 3,
      mat: M.goggles,
      geo: createGogglesGeometry(),
      offset: new THREE.Vector3(0.085, 0.085, 0.075),
      rot: new THREE.Euler(0, 0.72, 0),
    },
    // Left Upper Arm (back arm): tapered 7-sided sleeve wider at shoulder, narrower at elbow
    {
      name: 'left_upper_arm_mesh',
      bone: 4,
      mat: M.jacket,
      geo: createTaperedPrism({
        topRadiusX: 0.068,
        topRadiusZ: 0.068,
        bottomRadiusX: 0.052,
        bottomRadiusZ: 0.052,
        height: 0.26,
        radialSegments: 7,
      }),
      offset: new THREE.Vector3(0, -0.11, -0.02),
    },
    // Left Lower Arm + Glove (back forearm): tapered 7-sided cylinder
    {
      name: 'left_lower_arm_mesh',
      bone: 5,
      mat: M.skin,
      geo: createTaperedPrism({
        topRadiusX: 0.05,
        topRadiusZ: 0.05,
        bottomRadiusX: 0.038,
        bottomRadiusZ: 0.044,
        height: 0.24,
        radialSegments: 7,
      }),
      offset: new THREE.Vector3(0, -0.10, 0),
    },
    // Right Upper Arm (front arm): tapered 7-sided sleeve wider at shoulder, narrower at elbow
    {
      name: 'right_upper_arm_mesh',
      bone: 6,
      mat: M.jacket,
      geo: createTaperedPrism({
        topRadiusX: 0.068,
        topRadiusZ: 0.068,
        bottomRadiusX: 0.052,
        bottomRadiusZ: 0.052,
        height: 0.26,
        radialSegments: 7,
      }),
      offset: new THREE.Vector3(0, -0.11, 0.02),
    },
    // Right Lower Arm + Glove (front forearm): tapered 7-sided cylinder
    {
      name: 'right_lower_arm_mesh',
      bone: 7,
      mat: M.skin,
      geo: createTaperedPrism({
        topRadiusX: 0.05,
        topRadiusZ: 0.05,
        bottomRadiusX: 0.038,
        bottomRadiusZ: 0.044,
        height: 0.24,
        radialSegments: 7,
      }),
      offset: new THREE.Vector3(0, -0.10, 0),
    },
    // Left Upper Leg (back thigh): baggy snow pants tapered prism (wider at thigh, narrower at knee)
    {
      name: 'left_up_leg_mesh',
      bone: 8,
      mat: M.pants,
      geo: createTaperedPrism({
        topRadiusX: 0.095,
        topRadiusZ: 0.10,
        bottomRadiusX: 0.074,
        bottomRadiusZ: 0.078,
        height: 0.36,
        radialSegments: 8,
      }),
      offset: new THREE.Vector3(0, -0.16, -0.02),
    },
    // Left Lower Leg & Boot (back leg over z = -0.35 binding): tapered shin + boot reaching y ≈ 0.02
    {
      name: 'left_leg_mesh',
      bone: 9,
      mat: M.boots,
      geo: createBootGeometry(0.15),
      offset: new THREE.Vector3(0, 0.10, 0),
    },
    // Right Upper Leg (front thigh): baggy snow pants tapered prism (wider at thigh, narrower at knee)
    {
      name: 'right_up_leg_mesh',
      bone: 10,
      mat: M.pants,
      geo: createTaperedPrism({
        topRadiusX: 0.095,
        topRadiusZ: 0.10,
        bottomRadiusX: 0.074,
        bottomRadiusZ: 0.078,
        height: 0.36,
        radialSegments: 8,
      }),
      offset: new THREE.Vector3(0, -0.16, 0.02),
    },
    // Right Lower Leg & Boot (front leg over z = +0.35 binding): tapered shin + boot reaching y ≈ 0.02
    {
      name: 'right_leg_mesh',
      bone: 11,
      mat: M.boots,
      geo: createBootGeometry(0.35),
      offset: new THREE.Vector3(0, 0.10, 0),
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
  gltf.scene.traverse((child: any) => {
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

  console.log(`Exported ${outPath}`);
  console.log(`  Size:        ${stats.size} bytes`);
  console.log(`  SkinnedMesh: ${skinnedMeshCount}`);
  console.log(`  Bones:       ${boneCount}`);
  console.log(`  Triangles:   ${loadedTriangles}`);
  console.log(`  BindBBox Y:  [${loadedBindBox.min.y.toFixed(3)}, ${loadedBindBox.max.y.toFixed(3)}]`);
  console.log(`  BindBBox Z:  [${loadedBindBox.min.z.toFixed(3)}, ${loadedBindBox.max.z.toFixed(3)}]`);
  console.log(`  Magic:       0x${magic.toString(16)}`);

  if (loadedTriangles >= 2000) {
    throw new Error(`Triangle budget exceeded: ${loadedTriangles} >= 2000`);
  }
  if (loadedBindBox.min.y < 0.0 || loadedBindBox.max.y < 1.5) {
    throw new Error(
      `Invalid bind pose Y bounds: minY=${loadedBindBox.min.y.toFixed(3)} (expected >= 0.0), maxY=${loadedBindBox.max.y.toFixed(3)} (expected >= 1.5)`
    );
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
