import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import {
  buildTerrainMeshFromDEM,
  exportTerrainToGLBBuffer,
  parseTerrainFromGLBBuffer,
} from '../../src/terrain/glbPipeline';
import { TerrainManager } from '../../src/terrain/TerrainManager';

describe('Terrain & GLB Pipeline', () => {
  let terrainManager: TerrainManager;

  beforeEach(() => {
    terrainManager = new TerrainManager();
  });

  describe('Whistler Peak DEM Generation', () => {
    it('generates deterministic DEM with correct grid dimensions and metadata', () => {
      const data = terrainManager.terrainData;
      expect(data.mountainId).toBe('whistler-peak');
      expect(data.width).toBe(400);
      expect(data.length).toBe(1200);
      expect(data.segmentsX).toBe(64);
      expect(data.segmentsZ).toBe(192);

      const expectedVertexCount = (data.segmentsX + 1) * (data.segmentsZ + 1);
      expect(data.heights.length).toBe(expectedVertexCount);
      expect(data.dropZones.length).toBe(3);
      expect(data.obstacles.length).toBeGreaterThan(50);
    });

    it('exhibits realistic downhill elevation profile from summit to base', () => {
      const summitHeight = terrainManager.getHeightAt(0, -520);
      const midHeight = terrainManager.getHeightAt(0, 0);
      const baseHeight = terrainManager.getHeightAt(0, 580);

      expect(summitHeight).toBeGreaterThan(midHeight);
      expect(midHeight).toBeGreaterThan(baseHeight);

      // Total vertical drop is substantial (> 500m)
      const verticalDrop = summitHeight - baseHeight;
      expect(verticalDrop).toBeGreaterThan(500);

      // Summit elevation corresponds to real-world Whistler Peak summit (~2,182m)
      expect(summitHeight).toBeCloseTo(2182, 0);
    });

    it('enforces strictly downhill gradient along center line between drop zones', () => {
      let prevHeight = terrainManager.getHeightAt(0, -520);
      // Sample center line down the mountain in 20m increments
      for (let z = -500; z <= 580; z += 20) {
        const currentHeight = terrainManager.getHeightAt(0, z);
        expect(currentHeight).toBeLessThan(prevHeight);
        prevHeight = currentHeight;
      }
    });
  });

  describe('Drop-Zone Spawn Safety & Clearance', () => {
    it('contains all 3 configured Whistler drop zones', () => {
      const dropZones = terrainManager.terrainData.dropZones;
      const ids = dropZones.map((d) => d.id);
      expect(ids).toContain('summit-express');
      expect(ids).toContain('harmony-ridge');
      expect(ids).toContain('glacier-bowl');
    });

    it('enforces minimum 25m clearance between obstacles and every drop zone spawn position', () => {
      const { dropZones, obstacles } = terrainManager.terrainData;

      for (const dz of dropZones) {
        for (const obs of obstacles) {
          const dist2D = Math.hypot(
            obs.position.x - dz.spawnPosition.x,
            obs.position.z - dz.spawnPosition.z
          );
          expect(dist2D).toBeGreaterThanOrEqual(25.0);
        }
      }
    });

    it('guarantees zero initial collision when player spawns at any drop zone', () => {
      const { dropZones } = terrainManager.terrainData;
      for (const dz of dropZones) {
        const collision = terrainManager.checkObstacleCollision(dz.spawnPosition, 1.0);
        expect(collision).toBeNull();
      }
    });
  });

  describe('Height and Normal Interpolation', () => {
    it('returns exact elevation at integer grid vertices', () => {
      const { width, length, segmentsX, segmentsZ, heights } = terrainManager.terrainData;
      const stride = segmentsX + 1;

      // Sample a few vertex indices
      const testVertices = [
        { c: 0, r: 0 },
        { c: 32, r: 96 },
        { c: 64, r: 192 },
      ];

      for (const { c, r } of testVertices) {
        const x = -width / 2 + (c / segmentsX) * width;
        const z = -length / 2 + (r / segmentsZ) * length;
        const expected = heights[r * stride + c];
        const actual = terrainManager.getHeightAt(x, z);
        expect(actual).toBeCloseTo(expected, 4);
      }
    });

    it('interpolates intermediate coordinates continuously', () => {
      const h1 = terrainManager.getHeightAt(0, 10);
      const h2 = terrainManager.getHeightAt(0, 11);
      const hMid = terrainManager.getHeightAt(0, 10.5);

      expect(hMid).toBeGreaterThanOrEqual(Math.min(h1, h2));
      expect(hMid).toBeLessThanOrEqual(Math.max(h1, h2));
    });

    it('computes unit-length surface normals pointing upward and slope-aligned', () => {
      const normal = terrainManager.getNormalAt(0, -200);
      const len = Math.hypot(normal.x, normal.y, normal.z);
      expect(len).toBeCloseTo(1.0, 4);
      expect(normal.y).toBeGreaterThan(0.5); // upward facing
      expect(normal.z).toBeGreaterThan(0.0); // downhill forward tilt along +Z
    });

    it('computes positive slope pitch when facing downhill', () => {
      const headingDownhill = 0; // heading 0 points +Z downhill
      const pitch = terrainManager.getSlopePitchAt(0, -200, headingDownhill);

      // Pitch angle should be positive and between 15° and 45° (0.26 to 0.78 rad)
      expect(pitch).toBeGreaterThan(0.2);
      expect(pitch).toBeLessThan(0.9);
    });
  });

  describe('Obstacle Collision Detection', () => {
    it('detects collision when player overlaps obstacle horizontal radius and vertical span', () => {
      const obs = terrainManager.terrainData.obstacles[0];
      expect(obs).toBeDefined();

      // Place player right at obstacle center
      const hit = terrainManager.checkObstacleCollision(
        { x: obs.position.x, y: obs.position.y, z: obs.position.z },
        0.8
      );
      expect(hit).not.toBeNull();
      expect(hit?.id).toBe(obs.id);
    });

    it('returns null when player is outside obstacle radius', () => {
      const obs = terrainManager.terrainData.obstacles[0];
      const miss = terrainManager.checkObstacleCollision(
        {
          x: obs.position.x + obs.radius + 5.0,
          y: obs.position.y,
          z: obs.position.z,
        },
        0.8
      );
      expect(miss).toBeNull();
    });

    it('returns null when player is far above obstacle in the air', () => {
      const obs = terrainManager.terrainData.obstacles[0];
      const airborne = terrainManager.checkObstacleCollision(
        {
          x: obs.position.x,
          y: obs.position.y + obs.height + 10.0,
          z: obs.position.z,
        },
        0.8
      );
      expect(airborne).toBeNull();
    });
  });

  describe('GLB Binary Export & Import Pipeline', () => {
    it('builds a low-poly THREE.Mesh with flat shading and vertex colors', () => {
      const mesh = buildTerrainMeshFromDEM(terrainManager.terrainData);
      expect(mesh).toBeInstanceOf(THREE.Mesh);

      const geom = mesh.geometry;
      expect(geom.getAttribute('position')).toBeDefined();
      expect(geom.getAttribute('color')).toBeDefined();
      expect(geom.getAttribute('normal')).toBeDefined();
      expect(geom.index).not.toBeNull();

      const mat = mesh.material as THREE.MeshStandardMaterial;
      expect(mat.flatShading).toBe(true);
      expect(mat.vertexColors).toBe(true);
    });

    it('exports terrain to valid glTF 2.0 binary buffer with magic 0x46546C67', async () => {
      const mesh = buildTerrainMeshFromDEM(terrainManager.terrainData);
      const glbBuffer = await exportTerrainToGLBBuffer(mesh);

      expect(glbBuffer).toBeInstanceOf(ArrayBuffer);
      expect(glbBuffer.byteLength).toBeGreaterThan(100000);

      // Verify magic header: 0x46546C67 ("glTF" in little-endian)
      const view = new DataView(glbBuffer);
      const magic = view.getUint32(0, true);
      expect(magic).toBe(0x46546c67);

      const version = view.getUint32(4, true);
      expect(version).toBe(2);
    });

    it('parses exported GLB buffer back into a renderable THREE.Group', async () => {
      const mesh = buildTerrainMeshFromDEM(terrainManager.terrainData);
      const glbBuffer = await exportTerrainToGLBBuffer(mesh);
      const group = await parseTerrainFromGLBBuffer(glbBuffer);

      expect(group).toBeInstanceOf(THREE.Group);
      expect(group.children.length).toBeGreaterThan(0);
    });

    it('initializes TerrainManager setting glbLoaded=true and populating rootGroup', async () => {
      await terrainManager.initialize();

      expect(terrainManager.terrainData.glbLoaded).toBe(true);
      expect(terrainManager.glbByteLength).toBeGreaterThan(100000);
      expect(terrainManager.rootGroup.children.length).toBeGreaterThan(0);

      // Check rootGroup has terrain mesh group and obstacle meshes
      const names = terrainManager.rootGroup.children.map((c) => c.name);
      expect(names).toContain('terrain_mesh_group');
      expect(names).toContain('terrain_obstacles');
    });
  });
});
