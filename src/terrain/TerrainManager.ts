import * as THREE from 'three';
import { TerrainData, TerrainManifest, TerrainObstacle, Vector3Like } from '../types';
import { assembleTerrainData, parseTerrainFromGLBBuffer } from './glbPipeline';

export interface TerrainArtifacts {
  glbUrl?: string;
  manifestUrl?: string;
  heightsUrl?: string;
}

const DEFAULT_ARTIFACTS: TerrainArtifacts = {
  glbUrl: './assets/whistler-peak.glb',
  manifestUrl: './assets/terrain/whistler-terrain.json',
  heightsUrl: './assets/terrain/whistler-dem.bin',
};

export class TerrainManager {
  public readonly terrainData: TerrainData;
  public readonly rootGroup: THREE.Group;
  public glbByteLength: number = 0;
  public demFormatVersion: number = 1;
  private initPromise: Promise<void> | null = null;
  private dataInjected: boolean;

  /**
   * @param customData Optional pre-built TerrainData for testing (offline, no fetch).
   *   When omitted, all data is loaded by initialize() from committed artifact URLs.
   */
  constructor(customData?: TerrainData) {
    if (customData) {
      this.terrainData = customData;
      this.dataInjected = true;
    } else {
      // Placeholder — real values loaded by initialize() (never used before that)
      this.terrainData = {
        mountainId: '',
        mountainName: '',
        region: '',
        width: 1600,
        length: 3200,
        segmentsX: 128,
        segmentsZ: 256,
        minElevation: 0,
        maxElevation: 0,
        heights: new Float32Array(0),
        obstacles: [],
        dropZones: [],
        glbLoaded: false,
        glbFormatVersion: '2.0',
      };
      this.dataInjected = false;
    }

    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'terrain_root';
  }

  /**
   * Idempotent async initializer. Loads the committed GLB mesh, terrain manifest,
   * and DEM heightfield via relative bundled fetches (zero external network).
   *
   * @param artifacts  Optional override URLs for each artifact (defaults to committed paths).
   *   When the constructor received customData, only glbUrl is used (manifest/heights skipped).
   *   Throws on missing/invalid artifacts — NEVER synthesizes (ADR-0007 Rule 1).
   */
  public async initialize(artifacts?: TerrainArtifacts): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const {
        glbUrl = DEFAULT_ARTIFACTS.glbUrl,
        manifestUrl = DEFAULT_ARTIFACTS.manifestUrl,
        heightsUrl = DEFAULT_ARTIFACTS.heightsUrl,
      } = artifacts ?? {};

      // 1. Clear any prior terrain meshes and obstacles from rootGroup
      for (let i = this.rootGroup.children.length - 1; i >= 0; i--) {
        const child = this.rootGroup.children[i];
        if (child.name === 'terrain_mesh_group' || child.name === 'terrain_obstacles') {
          this.rootGroup.remove(child);
        }
      }

      // 2. Load manifest + DEM heights (skipped if customData was injected)
      if (!this.dataInjected) {
        if (!manifestUrl || !heightsUrl) {
          throw new Error(
            'TerrainManager: manifestUrl and heightsUrl are required when no customData is provided.',
          );
        }

        const manifestResp = await fetch(manifestUrl);
        if (!manifestResp.ok) {
          throw new Error(
            `TerrainManager: failed to fetch terrain manifest (${manifestUrl}): ${manifestResp.status} ${manifestResp.statusText}`,
          );
        }
        const manifest: TerrainManifest = await manifestResp.json();

        const heightsResp = await fetch(heightsUrl);
        if (!heightsResp.ok) {
          throw new Error(
            `TerrainManager: failed to fetch DEM heights (${heightsUrl}): ${heightsResp.status} ${heightsResp.statusText}`,
          );
        }
        const heightsBuf = await heightsResp.arrayBuffer();

        const expectedFloats = (manifest.segmentsZ + 1) * (manifest.segmentsX + 1);
        const expectedBytes = expectedFloats * 4;
        if (heightsBuf.byteLength !== expectedBytes) {
          throw new Error(
            `TerrainManager: DEM height buffer size mismatch: got ${heightsBuf.byteLength} bytes, ` +
            `expected ${expectedBytes} (${expectedFloats} Float32 values for ${manifest.segmentsX}×${manifest.segmentsZ} grid)`,
          );
        }

        const heights = new Float32Array(heightsBuf);
        const assembled = assembleTerrainData(manifest, heights);

        // Mutate the readonly placeholder with assembled data (no reassign needed)
        Object.assign(this.terrainData, assembled);
        this.demFormatVersion = manifest.demFormatVersion;
      }

      // 3. Load GLB mesh
      if (!glbUrl) {
        throw new Error('TerrainManager: glbUrl is required.');
      }

      const glbResponse = await fetch(glbUrl);
      if (!glbResponse.ok) {
        throw new Error(
          `TerrainManager: failed to fetch GLB mesh (${glbUrl}): ${glbResponse.status} ${glbResponse.statusText}`,
        );
      }
      const glbBuffer = await glbResponse.arrayBuffer();

      if (glbBuffer.byteLength < 12) {
        throw new Error(`TerrainManager: GLB buffer too small: ${glbBuffer.byteLength} bytes`);
      }

      const view = new DataView(glbBuffer);
      const magic = view.getUint32(0, true);
      if (magic !== 0x46546c67) {
        throw new Error(
          `TerrainManager: invalid glTF binary magic header: 0x${magic.toString(16)} (expected 0x46546c67)`,
        );
      }

      this.glbByteLength = glbBuffer.byteLength;
      const parsedScene = await parseTerrainFromGLBBuffer(glbBuffer);
      parsedScene.name = 'terrain_mesh_group';
      this.rootGroup.add(parsedScene);
      this.terrainData.glbLoaded = true;

      // 4. Attach low-poly obstacle meshes
      this.buildObstacleMeshes();
    })();

    return this.initPromise;
  }

  public getHeightAt(x: number, z: number): number {
    const { width, length, segmentsX, segmentsZ, heights } = this.terrainData;
    const clampedX = Math.max(-width / 2, Math.min(width / 2, x));
    const clampedZ = Math.max(-length / 2, Math.min(length / 2, z));

    const u = ((clampedX + width / 2) / width) * segmentsX;
    const v = ((clampedZ + length / 2) / length) * segmentsZ;

    const c0 = Math.min(Math.floor(u), segmentsX - 1);
    const r0 = Math.min(Math.floor(v), segmentsZ - 1);
    const c1 = c0 + 1;
    const r1 = r0 + 1;

    const fx = u - c0;
    const fz = v - r0;

    const stride = segmentsX + 1;
    const h00 = heights[r0 * stride + c0];
    const h10 = heights[r0 * stride + c1];
    const h01 = heights[r1 * stride + c0];
    const h11 = heights[r1 * stride + c1];

    const h0 = h00 * (1 - fx) + h10 * fx;
    const h1 = h01 * (1 - fx) + h11 * fx;

    return h0 * (1 - fz) + h1 * fz;
  }

  public getNormalAt(x: number, z: number): Vector3Like {
    const eps = 0.5;
    const hL = this.getHeightAt(x - eps, z);
    const hR = this.getHeightAt(x + eps, z);
    const hD = this.getHeightAt(x, z - eps);
    const hU = this.getHeightAt(x, z + eps);

    const dhdx = (hR - hL) / (2 * eps);
    const dhdz = (hU - hD) / (2 * eps);

    const len = Math.hypot(-dhdx, 1, -dhdz);
    return {
      x: -dhdx / len,
      y: 1 / len,
      z: -dhdz / len,
    };
  }

  public getSlopePitchAt(x: number, z: number, headingRad: number): number {
    const normal = this.getNormalAt(x, z);
    const dirX = Math.sin(headingRad);
    const dirZ = Math.cos(headingRad);
    const dh = -(normal.x * dirX + normal.z * dirZ) / (normal.y || 1e-6);
    return Math.atan(-dh);
  }

  public checkObstacleCollision(position: Vector3Like, radius: number = 0.8): TerrainObstacle | null {
    const obstacles = this.terrainData.obstacles;
    for (let i = 0; i < obstacles.length; i++) {
      const obs = obstacles[i];
      const dx = position.x - obs.position.x;
      const dz = position.z - obs.position.z;
      const dist2D = Math.hypot(dx, dz);
      if (dist2D <= obs.radius + radius) {
        const playerBottom = position.y;
        const playerTop = position.y + 1.8;
        const obsBottom = obs.position.y - 0.5;
        const obsTop = obs.position.y + obs.height + 0.5;
        if (playerTop >= obsBottom && playerBottom <= obsTop) {
          return obs;
        }
      }
    }
    return null;
  }

  private buildObstacleMeshes(): void {
    // Clear any prior obstacle group
    for (let i = this.rootGroup.children.length - 1; i >= 0; i--) {
      if (this.rootGroup.children[i].name === 'terrain_obstacles') {
        this.rootGroup.remove(this.rootGroup.children[i]);
      }
    }

    const obstacleGroup = new THREE.Group();
    obstacleGroup.name = 'terrain_obstacles';

    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.4, 2.0, 5);
    const trunkMat = new THREE.MeshStandardMaterial({
      color: 0x4a3520,
      flatShading: true,
      roughness: 0.9,
    });

    const foliageGeo = new THREE.ConeGeometry(1.6, 3.2, 5);
    const foliageMat = new THREE.MeshStandardMaterial({
      color: 0x1d4324,
      flatShading: true,
      roughness: 0.85,
    });

    const rockMat = new THREE.MeshStandardMaterial({
      color: 0x5e636b,
      flatShading: true,
      roughness: 0.95,
    });

    const cliffMat = new THREE.MeshStandardMaterial({
      color: 0x3d4047,
      flatShading: true,
      roughness: 0.95,
    });

    const dummy = new THREE.Object3D();

    const trees = this.terrainData.obstacles.filter((o) => o.type === 'tree');
    const rocks = this.terrainData.obstacles.filter((o) => o.type === 'rock');
    const cliffs = this.terrainData.obstacles.filter((o) => o.type === 'cliff');

    if (trees.length > 0) {
      const trunkMesh = new THREE.InstancedMesh(trunkGeo, trunkMat, trees.length);
      const foliage1Mesh = new THREE.InstancedMesh(foliageGeo, foliageMat, trees.length);
      const foliage2Mesh = new THREE.InstancedMesh(foliageGeo, foliageMat, trees.length);

      trees.forEach((tree, i) => {
        // Trunk
        dummy.position.set(tree.position.x, tree.position.y + 1.0, tree.position.z);
        dummy.scale.set(1, 1, 1);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        trunkMesh.setMatrixAt(i, dummy.matrix);

        // Foliage tier 1
        dummy.position.set(tree.position.x, tree.position.y + 2.8, tree.position.z);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        foliage1Mesh.setMatrixAt(i, dummy.matrix);

        // Foliage tier 2
        dummy.position.set(tree.position.x, tree.position.y + 4.4, tree.position.z);
        dummy.scale.set(0.75, 0.75, 0.75);
        dummy.updateMatrix();
        foliage2Mesh.setMatrixAt(i, dummy.matrix);
      });

      trunkMesh.instanceMatrix.needsUpdate = true;
      foliage1Mesh.instanceMatrix.needsUpdate = true;
      foliage2Mesh.instanceMatrix.needsUpdate = true;

      obstacleGroup.add(trunkMesh, foliage1Mesh, foliage2Mesh);
    }

    if (rocks.length > 0) {
      const rockGeo = new THREE.DodecahedronGeometry(1.0, 0);
      const rockMesh = new THREE.InstancedMesh(rockGeo, rockMat, rocks.length);

      rocks.forEach((rock, i) => {
        dummy.position.set(rock.position.x, rock.position.y + rock.radius * 0.7, rock.position.z);
        dummy.scale.set(rock.radius * 1.1, rock.radius * 0.8, rock.radius * 1.0);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        rockMesh.setMatrixAt(i, dummy.matrix);
      });

      rockMesh.instanceMatrix.needsUpdate = true;
      obstacleGroup.add(rockMesh);
    }

    if (cliffs.length > 0) {
      const cliffGeo = new THREE.CylinderGeometry(0.85, 1.1, 1.0, 6);
      const cliffMesh = new THREE.InstancedMesh(cliffGeo, cliffMat, cliffs.length);

      cliffs.forEach((cliff, i) => {
        dummy.position.set(cliff.position.x, cliff.position.y + cliff.height / 2, cliff.position.z);
        dummy.scale.set(cliff.radius, cliff.height, cliff.radius);
        dummy.rotation.set(0, 0, 0);
        dummy.updateMatrix();
        cliffMesh.setMatrixAt(i, dummy.matrix);
      });

      cliffMesh.instanceMatrix.needsUpdate = true;
      obstacleGroup.add(cliffMesh);
    }

    this.rootGroup.add(obstacleGroup);
  }
}