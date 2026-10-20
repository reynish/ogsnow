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
  if (manifest.dropZones && manifest.dropZones.length > 0 && manifest.obstacles && manifest.obstacles.length > 0) {
    return {
      mountainId: manifest.mountainId,
      mountainName: manifest.mountainName,
      region: manifest.region,
      width: manifest.width,
      length: manifest.length,
      segmentsX: manifest.segmentsX,
      segmentsZ: manifest.segmentsZ,
      minElevation: manifest.minElevation,
      maxElevation: manifest.maxElevation,
      heights,
      obstacles: manifest.obstacles,
      dropZones: manifest.dropZones,
      glbLoaded: false,
      glbFormatVersion: '2.0',
      source: manifest.source,
      origin: manifest.origin,
      realWorld: true,
      attribution: manifest.attribution,
      sampledControlPoints: manifest.sampledControlPoints,
      gridResolutionMeters: manifest.gridResolutionMeters,
    };
  }
  return deriveTerrain(manifest, heights);
}

export function buildTerrainMeshFromDEM(data: TerrainData): THREE.Mesh {
  const { width, length, segmentsX, segmentsZ, heights } = data;
  const geometry = new THREE.BufferGeometry();
  const stride = segmentsX + 1;

  const numTriangles = segmentsZ * segmentsX * 2;
  const numVertices = numTriangles * 3;

  const positions = new Float32Array(numVertices * 3);
  const colors = new Float32Array(numVertices * 3);

  // Sunlight direction normalized: sun position (120, 280, 140)
  const sunDirX = 0.362;
  const sunDirY = 0.845;
  const sunDirZ = 0.422;

  let vIdx = 0;
  let triIdx = 0;

  for (let r = 0; r < segmentsZ; r++) {
    const z0 = -length / 2 + (r / segmentsZ) * length;
    const z1 = -length / 2 + ((r + 1) / segmentsZ) * length;

    for (let c = 0; c < segmentsX; c++) {
      const x0 = -width / 2 + (c / segmentsX) * width;
      const x1 = -width / 2 + ((c + 1) / segmentsX) * width;

      const y00 = heights[r * stride + c];
      const y10 = heights[r * stride + c + 1];
      const y01 = heights[(r + 1) * stride + c];
      const y11 = heights[(r + 1) * stride + c + 1];

      // Local 3x3 window average height for curvature/bump deviation
      let sumH = 0;
      let countH = 0;
      for (let dr = -1; dr <= 2; dr++) {
        for (let dc = -1; dc <= 2; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr <= segmentsZ && cc >= 0 && cc <= segmentsX) {
            sumH += heights[rr * stride + cc];
            countH++;
          }
        }
      }
      const avgLocalH = countH > 0 ? sumH / countH : (y00 + y10 + y01 + y11) / 4;

      const tris = [
        // Triangle 1: (v00, v01, v10)
        [x0, y00, z0,  x0, y01, z1,  x1, y10, z0],
        // Triangle 2: (v01, v11, v10)
        [x0, y01, z1,  x1, y11, z1,  x1, y10, z0],
      ];

      for (const t of tris) {
        const [p0x, p0y, p0z, p1x, p1y, p1z, p2x, p2y, p2z] = t;

        // Compute face normal vector
        const ax = p1x - p0x, ay = p1y - p0y, az = p1z - p0z;
        const bx = p2x - p0x, by = p2y - p0y, bz = p2z - p0z;

        let nx = ay * bz - az * by;
        let ny = az * bx - ax * bz;
        let nz = ax * by - ay * bx;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;

        const yCent = (p0y + p1y + p2y) / 3;
        const heightDev = yCent - avgLocalH;
        const sunDot = nx * sunDirX + ny * sunDirY + nz * sunDirZ;

        // Subtle deterministic facet hash variation to accentuate polygon definition
        const hash = ((triIdx * 9301 + 49297) % 233280) / 233280;
        const facetVar = (hash - 0.5) * 0.05;

        let cr: number, cg: number, cb: number;

        if (ny < 0.62) {
          // Dark alpine rock / granite cliff
          cr = 0.30 + facetVar;
          cg = 0.32 + facetVar;
          cb = 0.36 + facetVar;
        } else if (ny < 0.76) {
          // Steep transition / windswept ice
          const k = (ny - 0.62) / 0.14;
          cr = 0.50 + 0.30 * k + facetVar;
          cg = 0.58 + 0.28 * k + facetVar;
          cb = 0.70 + 0.22 * k + facetVar;
        } else {
          // Snowfield facet
          let baseR = 0.80;
          let baseG = 0.84;
          let baseB = 0.90;

          if (yCent < 1650) {
            baseR = 0.76; baseG = 0.80; baseB = 0.85;
          } else if (yCent > 1950) {
            baseR = 0.83; baseG = 0.88; baseB = 0.95;
          }

          const aspectShade = (sunDot - 0.7) * 0.32;
          const devShade = Math.max(-0.20, Math.min(0.18, heightDev * 0.12));

          cr = baseR + aspectShade + devShade + facetVar;
          cg = baseG + aspectShade + devShade + facetVar;
          cb = baseB + aspectShade + (devShade < 0 ? devShade * 0.3 : devShade) + facetVar;

          // Clamp RGB
          cr = Math.max(0.55, Math.min(0.98, cr));
          cg = Math.max(0.60, Math.min(0.98, cg));
          cb = Math.max(0.68, Math.min(1.00, cb));
        }

        positions[vIdx * 3]     = p0x; positions[vIdx * 3 + 1] = p0y; positions[vIdx * 3 + 2] = p0z;
        positions[(vIdx+1) * 3] = p1x; positions[(vIdx+1) * 3 + 1] = p1y; positions[(vIdx+1) * 3 + 2] = p1z;
        positions[(vIdx+2) * 3] = p2x; positions[(vIdx+2) * 3 + 1] = p2y; positions[(vIdx+2) * 3 + 2] = p2z;

        colors[vIdx * 3]     = cr; colors[vIdx * 3 + 1] = cg; colors[vIdx * 3 + 2] = cb;
        colors[(vIdx+1) * 3] = cr; colors[(vIdx+1) * 3 + 1] = cg; colors[(vIdx+1) * 3 + 2] = cb;
        colors[(vIdx+2) * 3] = cr; colors[(vIdx+2) * 3 + 1] = cg; colors[(vIdx+2) * 3 + 2] = cb;

        vIdx += 3;
        triIdx++;
      }
    }
  }

  const indices = new Uint32Array(numVertices);
  for (let i = 0; i < numVertices; i++) {
    indices[i] = i;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();

  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 0.85,
    metalness: 0.05,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'whistler_terrain_mesh';
  // Attach terrain metadata so glTF extras carries mountain metadata [Fix M10 / M4]
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
    source: data.source,
    origin: data.origin,
    attribution: data.attribution,
    demFormatVersion: (data as any).demFormatVersion ?? 1,
    gridResolutionMeters: data.gridResolutionMeters ?? (data.width / data.segmentsX),
    sampledControlPoints: data.sampledControlPoints,
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
        let meshUserData: Record<string, any> | null = null;
        gltf.scene.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const m = child as THREE.Mesh;
            if (!meshUserData && m.userData && Object.keys(m.userData).length > 0) {
              meshUserData = m.userData;
            }
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
        if (meshUserData) {
          const uData = meshUserData as Record<string, any>;
          gltf.scene.userData = { ...uData, ...gltf.scene.userData };
          gltf.scene.userData.terrainMetadata = uData;
        }
        resolve(gltf.scene);
      },
      (error) => {
        reject(error);
      }
    );
  });
}
