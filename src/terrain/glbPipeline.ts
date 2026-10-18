import * as THREE from 'three';
import { TerrainData, TerrainObstacle, DropZone } from '../types';
import { DEFAULT_GAME_CONFIG } from '../config';

// [PR-1 Security/B3]: Guard FileReader polyfill so it only installs in Node.js / Vitest environments
// where window is undefined and FileReader is absent. It must never run or mutate globalThis
// in browser runtime environments to prevent prototype pollution or unintended side effects.
function ensureFileReaderPolyfill(): void {
  if (typeof window === 'undefined' && typeof globalThis.FileReader === 'undefined') {
    class PolyfillFileReader {
      public result: any = null;
      public onloadend: (() => void) | null = null;
      public onerror: ((err: any) => void) | null = null;

      public readAsArrayBuffer(blob: Blob): void {
        blob
          .arrayBuffer()
          .then((buf) => {
            this.result = buf;
            if (this.onloadend) this.onloadend();
          })
          .catch((err) => {
            if (this.onerror) this.onerror(err);
          });
      }
    }
    (globalThis as any).FileReader = PolyfillFileReader;
  }
}
ensureFileReaderPolyfill();

// Deterministic PRNG for obstacle generation
function createSeededRandom(seed: number = 42) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return function () {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

// Monotonic Hermite cubic spline interpolation for downhill elevation
function hermite(t: number, p0: number, p1: number, m0: number, m1: number, dz: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * m0 * dz + h01 * p1 + h11 * m1 * dz;
}

export function generateWhistlerDEM(
  width: number = 400,
  length: number = 1200,
  segmentsX: number = 64,
  segmentsZ: number = 192
): TerrainData {
  const stride = segmentsX + 1;
  const totalVertices = (segmentsZ + 1) * stride;
  const heights = new Float32Array(totalVertices);

  // Real Whistler Peak profile control points (M11):
  // Summit ridge (z = -600, 2182m) -> Peak Express Summit (z = -520, ~2130m) -> Harmony Ridge (z = -260, 1940m) ->
  // Glacier Creek Chute (z = -40, 1780m) -> Lower Mountain (z = 250, 1640m) -> Base (z = 600, 1520m)
  // Max elevation never exceeds 2182m (Whistler Peak summit).
  const pts = [
    { z: -600, h: 2182 },
    { z: -520, h: 2130 },
    { z: -260, h: 1940 },
    { z: -40, h: 1780 },
    { z: 250, h: 1640 },
    { z: 600, h: 1520 },
  ];

  const tangents: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) {
      tangents.push((pts[1].h - pts[0].h) / (pts[1].z - pts[0].z));
    } else if (i === pts.length - 1) {
      tangents.push((pts[i].h - pts[i - 1].h) / (pts[i].z - pts[i - 1].z));
    } else {
      tangents.push((pts[i + 1].h - pts[i - 1].h) / (pts[i + 1].z - pts[i - 1].z));
    }
  }

  function getBaseHeight(z: number): number {
    if (z <= pts[0].z) return pts[0].h;
    if (z >= pts[pts.length - 1].z) return pts[pts.length - 1].h;
    for (let i = 0; i < pts.length - 1; i++) {
      if (z >= pts[i].z && z <= pts[i + 1].z) {
        const dz = pts[i + 1].z - pts[i].z;
        const t = (z - pts[i].z) / dz;
        return hermite(t, pts[i].h, pts[i + 1].h, tangents[i], tangents[i + 1], dz);
      }
    }
    return 1520;
  }

  const dropZoneConfigs = DEFAULT_GAME_CONFIG.dropZones;

  // Generate heightfield with bowl contour and natural rollers
  let minElevation = Infinity;
  let maxElevation = -Infinity;

  for (let r = 0; r <= segmentsZ; r++) {
    const z = -length / 2 + (r / segmentsZ) * length;
    const baseH = getBaseHeight(z);

    // Taper bowl & rollers near summit ridge so maxElevation never exceeds 2182m summit
    const summitTaper = Math.max(0, Math.min(1, (z - (-length / 2)) / 120));

    for (let c = 0; c <= segmentsX; c++) {
      const x = -width / 2 + (c / segmentsX) * width;
      const xNorm = x / (width / 2);

      // Natural bowl: higher ridges on lateral boundaries, tapering at summit ridge
      const bowl = 18.0 * (xNorm * xNorm) * summitTaper;

      // Natural terrain rollers, damped around drop zone spawn points
      let rollerWeight = 1.0;
      for (const dz of dropZoneConfigs) {
        const d = Math.hypot(x - dz.spawnPosition.x, z - dz.spawnPosition.z);
        if (d < 25.0) {
          rollerWeight = Math.min(rollerWeight, d / 25.0);
        }
      }

      const rolls =
        (2.0 * Math.sin((2 * Math.PI * z) / 160) * Math.cos((2 * Math.PI * x) / 110) +
          1.0 * Math.sin((2 * Math.PI * z) / 60) * Math.cos((2 * Math.PI * x) / 50)) *
        rollerWeight *
        summitTaper;

      const h = Math.min(2182.0, baseH + bowl + rolls);
      heights[r * stride + c] = h;

      if (h < minElevation) minElevation = h;
      if (h > maxElevation) maxElevation = h;
    }
  }

  // Helper to query elevation during obstacle placement
  function queryHeight(qx: number, qz: number): number {
    const clampedX = Math.max(-width / 2, Math.min(width / 2, qx));
    const clampedZ = Math.max(-length / 2, Math.min(length / 2, qz));
    const u = ((clampedX + width / 2) / width) * segmentsX;
    const v = ((clampedZ + length / 2) / length) * segmentsZ;
    const c0 = Math.min(Math.floor(u), segmentsX - 1);
    const r0 = Math.min(Math.floor(v), segmentsZ - 1);
    const c1 = c0 + 1;
    const r1 = r0 + 1;
    const fx = u - c0;
    const fz = v - r0;
    const h00 = heights[r0 * stride + c0];
    const h10 = heights[r0 * stride + c1];
    const h01 = heights[r1 * stride + c0];
    const h11 = heights[r1 * stride + c1];
    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;
    return h0 * (1 - fz) + h1 * fz;
  }

  // Populate drop zones with exact terrain elevations
  const dropZones: DropZone[] = dropZoneConfigs.map((dz) => ({
    ...dz,
    spawnPosition: {
      x: dz.spawnPosition.x,
      y: queryHeight(dz.spawnPosition.x, dz.spawnPosition.z),
      z: dz.spawnPosition.z,
    },
  }));

  // Generate deterministic obstacles respecting 28m clearance and downhill fall-line corridor
  const rand = createSeededRandom(42);
  const obstacles: TerrainObstacle[] = [];
  let attempts = 0;

  while (obstacles.length < 110 && attempts < 2000) {
    attempts++;
    const ox = (rand() - 0.5) * (width * 0.88);
    const oz = -length / 2 + 30 + rand() * (length - 60);

    // Keep minimum 28m clearance around all drop zones AND clear downhill fall-line corridor
    let safe = true;
    for (const dz of dropZones) {
      if (Math.hypot(ox - dz.spawnPosition.x, oz - dz.spawnPosition.z) < 28.0) {
        safe = false;
        break;
      }
      if (
        Math.abs(ox - dz.spawnPosition.x) < 18 &&
        oz >= dz.spawnPosition.z - 10 &&
        oz <= dz.spawnPosition.z + 100
      ) {
        safe = false;
        break;
      }
    }

    // Keep central high-speed ski line less obstructed
    if (Math.abs(ox) < 10 && rand() > 0.15) {
      continue;
    }

    if (!safe) continue;

    const r = rand();
    let type: 'tree' | 'rock' | 'cliff';
    let radius: number;
    let height: number;

    // Below tree line (oz > -280), trees can spawn (65% chance)
    if (oz > -280 && r < 0.65) {
      type = 'tree';
      radius = 1.2;
      height = 6.0 + rand() * 4.0;
    } else if (r < 0.86) {
      type = 'rock';
      radius = 1.5 + rand() * 0.8;
      height = 2.0 + rand() * 1.5;
    } else {
      type = 'cliff';
      radius = 3.0 + rand() * 1.5;
      height = 5.0 + rand() * 3.5;
    }

    const oy = queryHeight(ox, oz);
    obstacles.push({
      id: `${type}_${obstacles.length}`,
      type,
      position: { x: ox, y: oy, z: oz },
      radius,
      height,
    });
  }

  return {
    mountainId: 'whistler-peak',
    mountainName: DEFAULT_GAME_CONFIG.mountainName,
    region: DEFAULT_GAME_CONFIG.region,
    width,
    length,
    segmentsX,
    segmentsZ,
    minElevation: Math.round(minElevation),
    maxElevation: Math.round(maxElevation),
    heights,
    obstacles,
    dropZones,
    glbLoaded: false,
    glbFormatVersion: '2.0',
  };
}

export function buildTerrainMeshFromDEM(data: TerrainData): THREE.Mesh {
  const { width, length, segmentsX, segmentsZ, heights } = data;
  const geometry = new THREE.BufferGeometry();
  const stride = segmentsX + 1;
  const numVertices = (segmentsZ + 1) * stride;

  const positions = new Float32Array(numVertices * 3);
  const colors = new Float32Array(numVertices * 3);

  let pIdx = 0;
  for (let r = 0; r <= segmentsZ; r++) {
    const z = -length / 2 + (r / segmentsZ) * length;
    for (let c = 0; c <= segmentsX; c++) {
      const x = -width / 2 + (c / segmentsX) * width;
      const y = heights[r * stride + c];
      positions[pIdx] = x;
      positions[pIdx + 1] = y;
      positions[pIdx + 2] = z;
      pIdx += 3;
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < segmentsZ; r++) {
    for (let c = 0; c < segmentsX; c++) {
      const i00 = r * stride + c;
      const i10 = r * stride + c + 1;
      const i01 = (r + 1) * stride + c;
      const i11 = (r + 1) * stride + c + 1;

      // Triangle 1
      indices.push(i00, i01, i10);
      // Triangle 2
      indices.push(i01, i11, i10);
    }
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  // Low-poly vertex coloring: snow whites, icy blues, steep rock grays
  const normals = geometry.attributes.normal.array;
  for (let i = 0; i < numVertices; i++) {
    const y = positions[i * 3 + 1];
    const ny = normals[i * 3 + 1];

    let cr = 0.96;
    let cg = 0.98;
    let cb = 1.0;

    if (ny < 0.65) {
      // Steep granite cliff
      cr = 0.35;
      cg = 0.36;
      cb = 0.40;
    } else if (ny < 0.78) {
      // Windswept alpine ice / blue glacier snow
      cr = 0.75;
      cg = 0.86;
      cb = 0.95;
    } else if (y < 1650) {
      // Lower runout cruiser snow
      cr = 0.89;
      cg = 0.92;
      cb = 0.94;
    } else if (y < 1920) {
      // Mid-mountain packed snow
      cr = 0.93;
      cg = 0.95;
      cb = 0.98;
    }

    colors[i * 3] = cr;
    colors[i * 3 + 1] = cg;
    colors[i * 3 + 2] = cb;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.9,
    metalness: 0.05,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'whistler_terrain_mesh';
  // Attach terrain metadata so glTF extras carries mountain metadata [Fix M10]
  mesh.userData = {
    mountainId: data.mountainId,
    mountainName: data.mountainName,
    region: data.region,
    width: data.width,
    length: data.length,
    segmentsX: data.segmentsX,
    segmentsZ: data.segmentsZ,
    minElevation: data.minElevation,
    maxElevation: data.maxElevation,
    dropZones: data.dropZones,
    obstacles: data.obstacles,
  };
  return mesh;
}

export async function exportTerrainToGLBBuffer(mesh: THREE.Object3D): Promise<ArrayBuffer> {
  ensureFileReaderPolyfill();
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const exporter = new GLTFExporter();
    exporter.parse(
      mesh,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else if (ArrayBuffer.isView(result)) {
          const u8 = result as Uint8Array;
          const copy = new Uint8Array(u8.byteLength);
          copy.set(u8);
          resolve(copy.buffer);
        } else {
          reject(new Error('GLTFExporter did not return an ArrayBuffer'));
        }
      },
      (error) => {
        reject(error);
      },
      { binary: true }
    );
  });
}

export async function parseTerrainFromGLBBuffer(buffer: ArrayBuffer): Promise<THREE.Group> {
  if (buffer.byteLength < 12) {
    throw new Error(`Buffer too small for GLB binary: ${buffer.byteLength} bytes`);
  }
  const view = new DataView(buffer);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) {
    throw new Error(`Invalid glTF binary magic header: 0x${magic.toString(16)} (expected 0x46546c67)`);
  }

  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  return new Promise<THREE.Group>((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.parse(
      buffer,
      '',
      (gltf) => {
        // [PR-1 B3: GLTF 2.0 spec does not serialize Three.js material.flatShading flag]
        // Standard glTF 2.0 material specifications do not include a property for Three.js
        // flatShading. When importing from GLB, GLTFLoader constructs MeshStandardMaterial
        // with flatShading: false by default. To strictly enforce ADR-0002 Rule 3, traverse
        // all child meshes in the loaded scene, set material.flatShading = true,
        // material.vertexColors = true, and material.needsUpdate = true, while ensuring
        // geometry vertex normals are properly computed for low-poly faceted rendering.
        gltf.scene.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const m = child as THREE.Mesh;
            if (m.geometry) {
              m.geometry.computeVertexNormals();
            }
            if (m.material) {
              const materials = Array.isArray(m.material) ? m.material : [m.material];
              for (const mat of materials) {
                if (mat instanceof THREE.MeshStandardMaterial || 'flatShading' in mat) {
                  (mat as any).flatShading = true;
                  (mat as any).vertexColors = true;
                  mat.needsUpdate = true;
                }
              }
            }
          }
        });
        resolve(gltf.scene);
      },
      (error) => {
        reject(error);
      }
    );
  });
}
