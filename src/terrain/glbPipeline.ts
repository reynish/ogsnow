import * as THREE from 'three';
import { TerrainData } from '../types';
import { deriveTerrain } from './terrainDerivation';

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

/**
 * Build a complete TerrainData from a committed manifest + raw Float32 heights.
 * Runs deterministic derivation (drop zones, obstacles) — never synthesizes elevations.
 * (ADR-0007: replaces the removed generateWhistlerDEM synthetic spline.)
 */
export function assembleTerrainData(
  manifest: import('../types').TerrainManifest,
  heights: Float32Array,
): TerrainData {
  return deriveTerrain(manifest, heights);
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
