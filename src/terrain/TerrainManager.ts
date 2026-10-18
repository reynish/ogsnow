import * as THREE from 'three';
import { TerrainData, TerrainObstacle, Vector3Like } from '../types';
import {
  generateWhistlerDEM,
  buildTerrainMeshFromDEM,
  exportTerrainToGLBBuffer,
  parseTerrainFromGLBBuffer,
} from './glbPipeline';

export class TerrainManager {
  public readonly terrainData: TerrainData;
  public readonly rootGroup: THREE.Group;
  public glbByteLength: number = 0;
  private initPromise: Promise<void> | null = null;

  constructor(customData?: TerrainData) {
    this.terrainData = customData ?? generateWhistlerDEM();
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'terrain_root';
  }

  // [PR-1 B2: Idempotent async initialization guard]
  // Caches in-flight initialization promise so concurrent or repeated calls to initialize()
  // never spawn duplicate fetches, duplicate GLB exports, or duplicate scene objects.
  // Clears any preexisting 'terrain_mesh_group' or 'terrain_obstacles' from rootGroup before adding.
  public async initialize(glbUrl: string = './assets/whistler-peak.glb'): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      // Remove any prior terrain meshes and obstacles before loading
      for (let i = this.rootGroup.children.length - 1; i >= 0; i--) {
        const child = this.rootGroup.children[i];
        if (child.name === 'terrain_mesh_group' || child.name === 'terrain_obstacles') {
          this.rootGroup.remove(child);
        }
      }

      let glbBuffer: ArrayBuffer | null = null;

      if (glbUrl && typeof fetch === 'function') {
        try {
          const response = await fetch(glbUrl);
          if (response.ok) {
            glbBuffer = await response.arrayBuffer();
          }
        } catch {
          // Fallback to in-memory generation if fetch fails (e.g. Node / Vitest)
        }
      }

      if (!glbBuffer) {
        const terrainMesh = buildTerrainMeshFromDEM(this.terrainData);
        glbBuffer = await exportTerrainToGLBBuffer(terrainMesh);
      }

      if (glbBuffer.byteLength < 12) {
        throw new Error(`GLB buffer too small: ${glbBuffer.byteLength} bytes`);
      }

      const view = new DataView(glbBuffer);
      const magic = view.getUint32(0, true);
      if (magic !== 0x46546c67) {
        throw new Error(`Invalid glTF binary magic header: 0x${magic.toString(16)} (expected 0x46546c67)`);
      }

      this.glbByteLength = glbBuffer.byteLength;
      const parsedScene = await parseTerrainFromGLBBuffer(glbBuffer);
      parsedScene.name = 'terrain_mesh_group';
      this.rootGroup.add(parsedScene);
      this.terrainData.glbLoaded = true;

      // Attach low-poly obstacle meshes to rootGroup
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
