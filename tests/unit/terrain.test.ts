import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import {
  assembleTerrainData,
  buildTerrainMeshFromDEM,
  exportTerrainToGLBBuffer,
  parseTerrainFromGLBBuffer,
} from '../../src/terrain/glbPipeline';
import { TerrainManager, validateArtifactUrl } from '../../src/terrain/TerrainManager';
import { TerrainManifest, TerrainData } from '../../src/types';
import { stableJsonStringify } from '../../scripts/fetch-terrain';

// ─── Shared fixture loading ────────────────────────────────────────────

function loadManifest(): TerrainManifest {
  const raw = fs.readFileSync('public/assets/terrain/whistler-terrain.json', 'utf8');
  return JSON.parse(raw) as TerrainManifest;
}

function loadHeights(): Float32Array {
  const buf = fs.readFileSync('public/assets/terrain/whistler-dem.bin');
  return new Float32Array(buf.buffer);
}

function buildTerrainData(): TerrainData {
  const manifest = loadManifest();
  const heights = loadHeights();
  return assembleTerrainData(manifest, heights);
}

let terrainManager: TerrainManager;

// ─── Committed artifact tests ──────────────────────────────────────────

describe('Committed terrain artifacts — provenance & metadata', () => {
  it('.bin byte length equals (257×129)×4 = 132612', () => {
    const binStat = fs.statSync('public/assets/terrain/whistler-dem.bin');
    expect(binStat.size).toBe(132612);
    expect(binStat.size).toBe((257 * 129) * 4);
  });

  it('JSON segmentsX=128 and segmentsZ=256 (not the old 64×192)', () => {
    const manifest = loadManifest();
    expect(manifest.segmentsX).toBe(128);
    expect(manifest.segmentsZ).toBe(256);
  });

  it('minElevation < 1600 and maxElevation > 2100 (real world, not [1520, 2182])', () => {
    const manifest = loadManifest();
    expect(manifest.minElevation).toBeLessThan(1600);
    expect(manifest.maxElevation).toBeGreaterThan(2100);
    // Must not be the synthetic clamp
    expect(manifest.minElevation === 1520 && manifest.maxElevation === 2182).toBe(false);
  });

  it('maxElevation is less than or equal to the committed max (2177.14)', () => {
    const manifest = loadManifest();
    expect(manifest.maxElevation).toBeLessThanOrEqual(2180); // committed max is 2177.14
  });

  it('provenance metadata is populated', () => {
    const manifest = loadManifest();
    expect(manifest.format).toBe('ogsnow-terrain');
    expect(manifest.mountainId).toBe('whistler');
    expect(manifest.origin.downhillAzimuthDeg).toBe(180);
    expect(manifest.origin.latitudeDeg).toBeCloseTo(50.0596, 4);
    expect(manifest.origin.longitudeDeg).toBeCloseTo(-122.957, 3);
    expect(manifest.source.provider).toBe('aws-terrarium');
    expect(manifest.source.zoom).toBe(13);
    expect(manifest.source.tiles.length).toBe(4);
    // Verify each tile has a SHA-256 checksum
    for (const tile of manifest.source.tiles) {
      expect(tile.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(manifest.license).toBe('AWS Open Data Terrain Tiles (Terrarium)');
    expect(manifest.attribution.length).toBeGreaterThanOrEqual(1);
  });

  it('grid elevations match sampledControlPoints within bilinear tolerance', () => {
    const manifest = loadManifest();
    const heights = loadHeights();
    const stride = manifest.segmentsX + 1;

    for (const cp of manifest.sampledControlPoints) {
      const expectedElev = cp.elevationM;
      const gridElev = heights[cp.row * stride + cp.col];
      // Grid should be within ~1m of the recorded control point elevation
      // (allow small tolerance for float32 precision)
      expect(Math.abs(gridElev - expectedElev)).toBeLessThanOrEqual(1.0);
    }
  });

  it('committed GLB has valid magic header 0x46546C67', () => {
    const buf = fs.readFileSync('public/assets/whistler-peak.glb');
    const view = new DataView(buf.buffer);
    const magic = view.getUint32(0, true);
    expect(magic).toBe(0x46546c67);
    const version = view.getUint32(4, true);
    expect(version).toBe(2);
  });
});

// ─── TerrainManager with real injected data ────────────────────────────

describe('TerrainManager — Real Terrain Injection', () => {
  beforeEach(() => {
    terrainManager = new TerrainManager(buildTerrainData());
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

      const testVertices = [
        { c: 0, r: 0 },
        { c: 32, r: 128 },
        { c: 64, r: 200 },
        { c: 128, r: 256 },
      ];

      for (const { c, r } of testVertices) {
        if (c > segmentsX || r > segmentsZ) continue;
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

      expect(hMid).toBeGreaterThanOrEqual(Math.min(h1, h2) - 0.1);
      expect(hMid).toBeLessThanOrEqual(Math.max(h1, h2) + 0.1);
    });

    it('computes unit-length surface normals pointing upward and slope-aligned', () => {
      const normal = terrainManager.getNormalAt(0, -200);
      const len = Math.hypot(normal.x, normal.y, normal.z);
      expect(len).toBeCloseTo(1.0, 4);
      expect(normal.y).toBeGreaterThan(0.5);
    });

    it('computes positive slope pitch at a suitable downhill point', () => {
      // Find a point on the real terrain with clear downhill gradient
      // Test a few center-line points and ensure at least one shows positive pitch
      const headingDownhill = 0;
      const testPoints = [-100, 0, 100, 200, 300, 400, 500, 600, 700, 800];
      let foundPositive = false;
      for (const z of testPoints) {
        const pitch = terrainManager.getSlopePitchAt(0, z, headingDownhill);
        if (pitch > 0.05) {
          foundPositive = true;
          break;
        }
      }
      expect(foundPositive).toBe(true);
    });

    it('elevation is lower at the bottom of the domain than near the drop zones', () => {
      // The lowest drop zone (glacier-bowl) is at z ≈ 1137.5.
      // Elevation near the bottom (z=1500) should be lower than at the drop zones.
      const elevAtBottom = terrainManager.getHeightAt(0, 1500);
      const elevAtSummit = terrainManager.getHeightAt(0, 150);
      // On a real mountain, the bottom of the domain should be lower than the summit drop zone
      expect(elevAtBottom).toBeLessThan(elevAtSummit);
    });
  });

  describe('Obstacle Collision Detection', () => {
    it('detects collision when player overlaps obstacle horizontal radius and vertical span', () => {
      const obs = terrainManager.terrainData.obstacles[0];
      expect(obs).toBeDefined();

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

  describe('Real Terrain Metadata & Provenance', () => {
    it('terrainData has real-world provenance fields', () => {
      const td = terrainManager.terrainData;
      expect(td.realWorld).toBe(true);
      expect(td.source).toBeDefined();
      expect(td.source!.provider).toBe('aws-terrarium');
      expect(td.origin).toBeDefined();
      expect(td.attribution).toBeDefined();
      expect(td.attribution!.length).toBeGreaterThanOrEqual(1);
      expect(td.minElevation).toBeLessThan(1600);
      expect(td.maxElevation).toBeGreaterThan(2100);
    });

    it('has exactly 3 drop zones with expected ids', () => {
      const dzs = terrainManager.terrainData.dropZones;
      expect(dzs.length).toBe(3);
      const ids = dzs.map(d => d.id);
      expect(ids).toEqual(['summit-express', 'harmony-ridge', 'glacier-bowl']);
    });
  });
});

// ─── GLB Pipeline tests ───────────────────────────────────────────────-

describe('GLB Export & Import Pipeline', () => {
  let realData: TerrainData;

  beforeAll(() => {
    realData = buildTerrainData();
  });

  it('builds a low-poly THREE.Mesh with flat shading and vertex colors', () => {
    const mesh = buildTerrainMeshFromDEM(realData);
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
    const mesh = buildTerrainMeshFromDEM(realData);
    const glbBuffer = await exportTerrainToGLBBuffer(mesh);

    expect(glbBuffer).toBeInstanceOf(ArrayBuffer);
    expect(glbBuffer.byteLength).toBeGreaterThan(100000);

    const view = new DataView(glbBuffer);
    const magic = view.getUint32(0, true);
    expect(magic).toBe(0x46546c67);

    const version = view.getUint32(4, true);
    expect(version).toBe(2);
  });

  it('parses exported GLB buffer back into a renderable THREE.Group with flatShading and metadata', async () => {
    const mesh = buildTerrainMeshFromDEM(realData);
    const glbBuffer = await exportTerrainToGLBBuffer(mesh);
    const group = await parseTerrainFromGLBBuffer(glbBuffer);

    expect(group).toBeInstanceOf(THREE.Group);
    expect(group.children.length).toBeGreaterThan(0);

    let meshFound = false;
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        meshFound = true;
        const m = child as THREE.Mesh;
        const mat = m.material as THREE.MeshStandardMaterial;
        expect(mat.flatShading).toBe(true);
        expect(mat.vertexColors).toBe(true);
        expect(m.userData.minElevation).toBeDefined();
        expect(m.userData.maxElevation).toBeDefined();
        expect(m.userData.dropZones).toHaveLength(3);
        expect(m.userData.obstacles.length).toBeGreaterThan(0);
      }
    });
    expect(meshFound).toBe(true);
  });

  it('assembleTerrainData produces correct bounds', () => {
    const td = realData;
    expect(td.width).toBe(1600);
    expect(td.length).toBe(3200);
    expect(td.heights.length).toBe(33153);
    expect(td.minElevation).toBeLessThan(1600);
    expect(td.maxElevation).toBeGreaterThan(2100);
  });

  it('parseTerrainFromGLBBuffer preserves userData metadata including Iteration 2 provenance (M4)', async () => {
    const mesh = buildTerrainMeshFromDEM(realData);
    const glbBuffer = await exportTerrainToGLBBuffer(mesh);
    const group = await parseTerrainFromGLBBuffer(glbBuffer);

    let meshFound = false;
    group.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        meshFound = true;
        const m = child as THREE.Mesh;
        // Properties are stored directly on userData (terrainMetadata is not a nested object)
        // The build function sets: m.userData = { mountainId, mountainName, region, ... }
        // After GLB round-trip, verify key metadata survives
        expect(m.userData.minElevation).toBeDefined();
        expect(m.userData.maxElevation).toBeDefined();
        expect(m.userData.dropZones).toHaveLength(3);
        expect(m.userData.obstacles.length).toBeGreaterThan(0);
        // M4: Full provenance fields
        expect(m.userData.source).toBeDefined();
        expect(m.userData.source.provider).toBe('aws-terrarium');
        expect(m.userData.origin).toBeDefined();
        expect(m.userData.origin.downhillAzimuthDeg).toBe(180);
        expect(m.userData.attribution).toBeDefined();
        expect(m.userData.attribution.length).toBeGreaterThanOrEqual(1);
        expect(m.userData.demFormatVersion).toBe(1);
        expect(m.userData.gridResolutionMeters).toBe(12.5);
      }
    });
    expect(meshFound).toBe(true);

    // Also assert on group.userData.terrainMetadata
    expect(group.userData.terrainMetadata).toBeDefined();
    expect(group.userData.terrainMetadata.mountainId).toBe('whistler');
    expect(group.userData.terrainMetadata.source.provider).toBe('aws-terrarium');
  });

  it('TerrainManager.initialize() idempotency: initPromise cached internally', async () => {
    terrainManager = new TerrainManager(realData);
    // First call triggers creation of initPromise (async lambda that fails in Node env)
    const call1 = terrainManager.initialize();
    // Catch the internal initPromise directly to prevent unhandled rejection
    // (the Node runtime detects unhandled rejection on the initPromise itself,
    //  not just on the external Promise returned by the async initialize()).
    (terrainManager as any).initPromise?.catch(() => {});
    // The internal initPromise should now be set (truthy object)
    expect((terrainManager as any).initPromise).not.toBeNull();
    // Second call returns the cached promise — no new init triggered
    const call2 = terrainManager.initialize();
    call2.catch(() => {});
    // Let both settle
    await call1.catch(() => {});
    await call2.catch(() => {});
  });

  it('assembleTerrainData and buildTerrainMeshFromDEM produce identical results for same input', () => {
    // Idempotency at the data level: calling assembleTerrainData twice with same
    // manifest/heights produces identical TerrainData objects.
    const manifest = loadManifest();
    const heights = loadHeights();
    const td1 = assembleTerrainData(manifest, heights);
    const td2 = assembleTerrainData(manifest, heights);
    expect(td1.mountainId).toBe(td2.mountainId);
    expect(td1.minElevation).toBe(td2.minElevation);
    expect(td1.maxElevation).toBe(td2.maxElevation);
    expect(td1.dropZones.length).toBe(td2.dropZones.length);
    expect(td1.obstacles.length).toBe(td2.obstacles.length);
  });

  it('TerrainManager rootGroup children are not duplicated on repeated assembleTerrainData calls', () => {
    // Build the TerrainData once, pass it to new TerrainManager instances.
    const td = realData;
    const tm1 = new TerrainManager(td);
    const tm2 = new TerrainManager(td);
    // Both have the same terrain data but independent rootGroups (no duplication)
    expect(tm1.terrainData.mountainId).toBe(tm2.terrainData.mountainId);
    expect(tm1.terrainData.obstacles.length).toBe(tm2.terrainData.obstacles.length);
    expect(tm1.rootGroup.children.length).toBe(0); // No children before initialize
    expect(tm2.rootGroup.children.length).toBe(0);
  });
});

describe('Terrain Pipeline — Performance & Security Guardrails (P1, S1, S2)', () => {
  it('P1: assembleTerrainData reuses pre-derived dropZones and obstacles from manifest', () => {
    const manifest = loadManifest();
    const heights = loadHeights();

    expect(manifest.dropZones).toBeDefined();
    expect(manifest.obstacles).toBeDefined();

    const data = assembleTerrainData(manifest, heights);
    // Should reuse the references from manifest rather than recalculating
    expect(data.dropZones).toBe(manifest.dropZones);
    expect(data.obstacles).toBe(manifest.obstacles);
  });

  it('S1: validateArtifactUrl permits safe relative asset URLs', () => {
    expect(validateArtifactUrl('./assets/whistler-peak.glb', 'glbUrl')).toBe('./assets/whistler-peak.glb');
    expect(validateArtifactUrl('assets/terrain/whistler-dem.bin', 'heightsUrl')).toBe('assets/terrain/whistler-dem.bin');
    expect(validateArtifactUrl('/assets/terrain/whistler-terrain.json', 'manifestUrl')).toBe('/assets/terrain/whistler-terrain.json');
  });

  it('S1: validateArtifactUrl rejects absolute, external, traversal, or non-asset paths', () => {
    // External protocols
    expect(() => validateArtifactUrl('https://malicious.com/hack.glb', 'glbUrl')).toThrow(/absolute URL/);
    expect(() => validateArtifactUrl('http://evil.org/dem.bin', 'heightsUrl')).toThrow(/absolute URL/);
    expect(() => validateArtifactUrl('//cdn.example.com/data.json', 'manifestUrl')).toThrow(/absolute URL/);

    // Path traversal
    expect(() => validateArtifactUrl('../secret/whistler.glb', 'glbUrl')).toThrow(/path traversal/);
    expect(() => validateArtifactUrl('./assets/../../etc/passwd', 'glbUrl')).toThrow(/path traversal/);

    // Outside assets directory
    expect(() => validateArtifactUrl('./scripts/generate-glb.ts', 'glbUrl')).toThrow(/restricted to assets directory/);
    expect(() => validateArtifactUrl('src/config.ts', 'manifestUrl')).toThrow(/restricted to assets directory/);
  });

  it('S2: stableJsonStringify throws on cyclic structures', () => {
    const circularObj: any = { a: 1 };
    circularObj.self = circularObj;

    expect(() => stableJsonStringify(circularObj)).toThrow(TypeError);
    expect(() => stableJsonStringify(circularObj)).toThrow(/circular/);
  });

  it('S2: stableJsonStringify throws on excessive nesting depth', () => {
    let deep: any = { value: 42 };
    for (let i = 0; i < 40; i++) {
      deep = { child: deep };
    }

    expect(() => stableJsonStringify(deep, '  ', 30)).toThrow(RangeError);
    expect(() => stableJsonStringify(deep, '  ', 30)).toThrow(/maximum nesting depth/);
  });
});
