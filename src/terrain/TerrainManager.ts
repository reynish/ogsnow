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

  constructor(customData?: TerrainData) {
    this.terrainData = customData ?? generateWhistlerDEM();
    this.rootGroup = new THREE.Group();
    this.rootGroup.name = 'terrain_root';
  }

  public async initialize(glbUrl?: string): Promise<void> {
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
    const eps = 0.5;
    const hL = this.getHeightAt(x - eps, z);
    const hR = this.getHeightAt(x + eps, z);
    const hD = this.getHeightAt(x, z - eps);
    const hU = this.getHeightAt(x, z + eps);

    const dhdx = (hR - hL) / (2 * eps);
    const dhdz = (hU - hD) / (2 * eps);

    const dirX = Math.sin(headingRad);
    const dirZ = Math.cos(headingRad);

    const dh = dhdx * dirX + dhdz * dirZ;
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

    for (const obs of this.terrainData.obstacles) {
      if (obs.type === 'tree') {
        const treeGroup = new THREE.Group();
        treeGroup.position.set(obs.position.x, obs.position.y, obs.position.z);

        const trunk = new THREE.Mesh(trunkGeo, trunkMat);
        trunk.position.y = 1.0;
        treeGroup.add(trunk);

        const foliage1 = new THREE.Mesh(foliageGeo, foliageMat);
        foliage1.position.y = 2.8;
        treeGroup.add(foliage1);

        const foliage2 = new THREE.Mesh(foliageGeo, foliageMat);
        foliage2.position.y = 4.4;
        foliage2.scale.set(0.75, 0.75, 0.75);
        treeGroup.add(foliage2);

        obstacleGroup.add(treeGroup);
      } else if (obs.type === 'rock') {
        const rockGeo = new THREE.DodecahedronGeometry(obs.radius, 0);
        const rock = new THREE.Mesh(rockGeo, rockMat);
        rock.position.set(obs.position.x, obs.position.y + obs.radius * 0.7, obs.position.z);
        rock.scale.set(1.1, 0.8, 1.0);
        obstacleGroup.add(rock);
      } else if (obs.type === 'cliff') {
        const cliffGeo = new THREE.CylinderGeometry(obs.radius * 0.85, obs.radius * 1.1, obs.height, 6);
        const cliff = new THREE.Mesh(cliffGeo, cliffMat);
        cliff.position.set(obs.position.x, obs.position.y + obs.height / 2, obs.position.z);
        obstacleGroup.add(cliff);
      }
    }

    this.rootGroup.add(obstacleGroup);
  }
}
