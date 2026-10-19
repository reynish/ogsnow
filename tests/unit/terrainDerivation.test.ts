import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { deriveDropZones, deriveObstacles, deriveTerrain, fnv1a32, createSeededRandom } from '../../src/terrain/terrainDerivation';
import { TerrainManifest, TerrainData } from '../../src/types';

// ─── Shared fixture ────────────────────────────────────────────────────

function loadManifest(): TerrainManifest {
  const raw = fs.readFileSync('public/assets/terrain/whistler-terrain.json', 'utf8');
  return JSON.parse(raw) as TerrainManifest;
}

function loadHeights(): Float32Array {
  const buf = fs.readFileSync('public/assets/terrain/whistler-dem.bin');
  return new Float32Array(buf.buffer);
}

function loadTerrainData(): TerrainData {
  const manifest = loadManifest();
  const heights = loadHeights();
  return deriveTerrain(manifest, heights);
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('terrainDerivation — Seeded Determinism', () => {
  it('same seed/mountain produces byte-identical drop zones and obstacles', () => {
    const manifest = loadManifest();
    const heights = loadHeights();

    const result1 = deriveTerrain(manifest, heights);
    const result2 = deriveTerrain(manifest, heights);

    // Deep compare drop zones (all fields including floating point)
    expect(result1.dropZones.length).toBe(result2.dropZones.length);
    for (let i = 0; i < result1.dropZones.length; i++) {
      const a = result1.dropZones[i];
      const b = result2.dropZones[i];
      expect(a.id).toBe(b.id);
      expect(a.name).toBe(b.name);
      expect(a.elevationMeters).toBe(b.elevationMeters);
      expect(a.spawnPosition.x).toBe(b.spawnPosition.x);
      expect(a.spawnPosition.y).toBe(b.spawnPosition.y);
      expect(a.spawnPosition.z).toBe(b.spawnPosition.z);
      expect(a.initialHeadingRad).toBe(b.initialHeadingRad);
    }

    // Deep compare obstacles (all fields)
    expect(result1.obstacles.length).toBe(result2.obstacles.length);
    for (let i = 0; i < result1.obstacles.length; i++) {
      const a = result1.obstacles[i];
      const b = result2.obstacles[i];
      expect(a.id).toBe(b.id);
      expect(a.type).toBe(b.type);
      expect(a.position.x).toBe(b.position.x);
      expect(a.position.y).toBe(b.position.y);
      expect(a.position.z).toBe(b.position.z);
      expect(a.radius).toBe(b.radius);
      expect(a.height).toBe(b.height);
    }

    // Derivation metadata identical
    expect(result1.source!.tiles[0].sha256).toBe(result2.source!.tiles[0].sha256);
  });

  it('two different mountain ids produce different (but valid) output', () => {
    const manifest = loadManifest();
    const heights = loadHeights();

    // Simulate a different mountain by changing the id (FNV-1a changes)
    const manifestA = { ...manifest, mountainId: 'whistler' };
    const manifestB = { ...manifest, mountainId: 'snowdon' };

    const resultA = deriveTerrain(manifestA, heights);
    const resultB = deriveTerrain(manifestB, heights);

    // Both should produce valid output
    expect(resultA.dropZones.length).toBe(3);
    expect(resultB.dropZones.length).toBe(3);
    expect(resultA.obstacles.length).toBeGreaterThan(0);
    expect(resultB.obstacles.length).toBeGreaterThan(0);

    // But different (different seed → different placement)
    // At least the obstacle count or positions should differ (high probability)
    // We check that the first obstacle positions are not all identical
    const obsPosA = resultA.obstacles.slice(0, 5).map(o => `${o.position.x},${o.position.z}`);
    const obsPosB = resultB.obstacles.slice(0, 5).map(o => `${o.position.x},${o.position.z}`);
    const identical = obsPosA.every((v, i) => v === obsPosB[i]);
    // It's overwhelmingly likely they differ
    expect(identical).toBe(false);
  });

  it('deriveDropZones called twice with same inputs returns deeply equal results', () => {
    const manifest = loadManifest();
    const heights = loadHeights();

    const zones1 = deriveDropZones(manifest, heights);
    const zones2 = deriveDropZones(manifest, heights);

    expect(zones1.length).toBe(zones2.length);
    for (let i = 0; i < zones1.length; i++) {
      expect(zones1[i].id).toBe(zones2[i].id);
      expect(zones1[i].elevationMeters).toBe(zones2[i].elevationMeters);
      expect(zones1[i].spawnPosition.x).toBe(zones2[i].spawnPosition.x);
      expect(zones1[i].spawnPosition.z).toBe(zones2[i].spawnPosition.z);
    }
  });

  it('deriveObstacles called twice with same inputs returns deeply equal results', () => {
    const manifest = loadManifest();
    const heights = loadHeights();
    const seed = fnv1a32('whistler');
    const dropZones = deriveDropZones(manifest, heights);

    const obs1 = deriveObstacles(manifest, heights, dropZones, seed);
    const obs2 = deriveObstacles(manifest, heights, dropZones, seed);

    expect(obs1.length).toBe(obs2.length);
    for (let i = 0; i < obs1.length; i++) {
      expect(obs1[i].id).toBe(obs2[i].id);
      expect(obs1[i].position.x).toBe(obs2[i].position.x);
      expect(obs1[i].position.z).toBe(obs2[i].position.z);
      expect(obs1[i].radius).toBe(obs2[i].radius);
    }
  });

  it('createSeededRandom produces identical sequences for the same seed', () => {
    const rng1 = createSeededRandom(42);
    const rng2 = createSeededRandom(42);
    for (let i = 0; i < 100; i++) {
      expect(rng1()).toBe(rng2());
    }
  });

  it('createSeededRandom produces different sequences for different seeds', () => {
    const rng1 = createSeededRandom(42);
    const rng2 = createSeededRandom(999);
    // First value should differ
    expect(rng1()).not.toBe(rng2());
  });
});

describe('terrainDerivation — Drop Zone Constraints', () => {
  it('produces exactly 3 drop zones with correct ids', () => {
    const data = loadTerrainData();
    const zones = data.dropZones;

    expect(zones.length).toBe(3);
    const ids = zones.map(z => z.id);
    expect(ids).toContain('summit-express');
    expect(ids).toContain('harmony-ridge');
    expect(ids).toContain('glacier-bowl');
  });

  it('drop zones are ordered highest → lowest elevation', () => {
    const data = loadTerrainData();
    const zones = data.dropZones;

    for (let i = 1; i < zones.length; i++) {
      expect(zones[i - 1].elevationMeters).toBeGreaterThan(zones[i].elevationMeters);
    }
  });

  it('every drop zone has ≥25 m obstacle-free radial clearance', () => {
    const data = loadTerrainData();
    const { dropZones, obstacles } = data;

    for (const dz of dropZones) {
      for (const obs of obstacles) {
        const dist = Math.hypot(
          obs.position.x - dz.spawnPosition.x,
          obs.position.z - dz.spawnPosition.z,
        );
        expect(dist).toBeGreaterThanOrEqual(25.0);
      }
    }
  });

  it('every drop zone has 80 m downhill corridor clearance', () => {
    const data = loadTerrainData();
    const { dropZones, obstacles } = data;

    for (const dz of dropZones) {
      const corridorObstacles = obstacles.filter(
        (obs) =>
          Math.abs(obs.position.x - dz.spawnPosition.x) < 18 &&
          obs.position.z >= dz.spawnPosition.z &&
          obs.position.z <= dz.spawnPosition.z + 80,
      );
      expect(corridorObstacles).toHaveLength(0);
    }
  });

  it('drop zone spawn positions have zero initial obstacle collision', () => {
    const data = loadTerrainData();
    const { dropZones, obstacles } = data;

    for (const dz of dropZones) {
      // Check no obstacle within 25m of spawn
      for (const obs of obstacles) {
        const dist = Math.hypot(
          obs.position.x - dz.spawnPosition.x,
          obs.position.z - dz.spawnPosition.z,
        );
        if (dist < 25) {
          // Should not happen, but let's fail gracefully
          expect(dist).toBeGreaterThanOrEqual(25);
        }
      }
    }
  });

  it('all drop zone spawn positions are within terrain bounds', () => {
    const data = loadTerrainData();
    const { dropZones, width, length } = data;
    const halfW = width / 2;
    const halfL = length / 2;

    for (const dz of dropZones) {
      expect(dz.spawnPosition.x).toBeGreaterThanOrEqual(-halfW);
      expect(dz.spawnPosition.x).toBeLessThanOrEqual(halfW);
      expect(dz.spawnPosition.z).toBeGreaterThanOrEqual(-halfL);
      expect(dz.spawnPosition.z).toBeLessThanOrEqual(halfL);
    }
  });
});

describe('terrainDerivation — Obstacle Constraints', () => {
  it('obstacle count is within budget (<=110)', () => {
    const data = loadTerrainData();
    expect(data.obstacles.length).toBeLessThanOrEqual(110);
    expect(data.obstacles.length).toBeGreaterThan(0);
  });

  it('all obstacles have valid types', () => {
    const data = loadTerrainData();
    const validTypes = new Set(['tree', 'rock', 'cliff']);
    for (const obs of data.obstacles) {
      expect(validTypes).toContain(obs.type);
    }
  });

  it('all obstacles have stable string ids', () => {
    const data = loadTerrainData();
    for (const obs of data.obstacles) {
      expect(obs.id).toMatch(/^(tree|rock|cliff)_\d+$/);
    }
  });

  it('all obstacle positions are within terrain bounds', () => {
    const data = loadTerrainData();
    const { obstacles, width, length } = data;
    const halfW = width / 2;
    const halfL = length / 2;

    for (const obs of obstacles) {
      expect(obs.position.x).toBeGreaterThanOrEqual(-halfW);
      expect(obs.position.x).toBeLessThanOrEqual(halfW);
      expect(obs.position.z).toBeGreaterThanOrEqual(-halfL);
      expect(obs.position.z).toBeLessThanOrEqual(halfL);
    }
  });

  it('no two obstacles overlap (minimum 15m spacing)', () => {
    const data = loadTerrainData();
    const { obstacles } = data;
    for (let i = 0; i < obstacles.length; i++) {
      for (let j = i + 1; j < obstacles.length; j++) {
        const dist = Math.hypot(
          obstacles[i].position.x - obstacles[j].position.x,
          obstacles[i].position.z - obstacles[j].position.z,
        );
        expect(dist).toBeGreaterThanOrEqual(14.9); // slight tolerance for rounding
      }
    }
  });

  it('tree obstacles are below treeLineElevationM', () => {
    const data = loadTerrainData();
    const treeLine = 1650;
    const trees = data.obstacles.filter(o => o.type === 'tree');
    for (const tree of trees) {
      expect(tree.position.y).toBeLessThanOrEqual(treeLine + 10); // small tolerance
    }
  });
});

describe('terrainDerivation — Derivation Metadata', () => {
  it('deriveTerrain returns proper TerrainData metadata', () => {
    const data = loadTerrainData();

    expect(data.mountainId).toBe('whistler');
    expect(data.mountainName).toBe('Whistler Mountain');
    expect(data.width).toBe(1600);
    expect(data.length).toBe(3200);
    expect(data.segmentsX).toBe(128);
    expect(data.segmentsZ).toBe(256);
    expect(data.glbLoaded).toBe(false);
    expect(data.glbFormatVersion).toBe('2.0');
    expect(data.realWorld).toBe(true);
    expect(data.attribution).toBeDefined();
    expect(data.attribution!.length).toBeGreaterThanOrEqual(1);
    expect(data.origin).toBeDefined();
    expect(data.origin!.downhillAzimuthDeg).toBe(180);
    expect(data.source).toBeDefined();
    expect(data.source!.provider).toBe('aws-terrarium');
  });
});

describe('terrainDerivation — PRNG Uniformity & Obstacle Spatial Distribution (M1)', () => {
  it('createSeededRandom spans full [0.0, 1.0) range across all 10 deciles (M1)', () => {
    const rand = createSeededRandom(12345);
    const N = 100000;
    const deciles = new Array(10).fill(0);
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let i = 0; i < N; i++) {
      const val = rand();
      expect(val).toBeGreaterThanOrEqual(0.0);
      expect(val).toBeLessThan(1.0);
      if (val < minVal) minVal = val;
      if (val > maxVal) maxVal = val;
      const decileIndex = Math.floor(val * 10);
      deciles[Math.min(decileIndex, 9)]++;
    }

    // Min value should be very close to 0, max value should exceed 0.99
    expect(minVal).toBeLessThan(0.005);
    expect(maxVal).toBeGreaterThan(0.995);

    // Each decile expected to hold ~10% (10,000) of samples, tolerance +/- 1,500
    for (let d = 0; d < 10; d++) {
      expect(deciles[d]).toBeGreaterThan(8500);
      expect(deciles[d]).toBeLessThan(11500);
    }
  });

  it('derived obstacles span both z < 0 and z > 0 with >= 40% in downhill runout (M1)', () => {
    const data = loadTerrainData();
    const negZ = data.obstacles.filter((o) => o.position.z < 0).length;
    const posZ = data.obstacles.filter((o) => o.position.z > 0).length;
    const posPercent = (posZ / data.obstacles.length) * 100;

    expect(negZ).toBeGreaterThan(0);
    expect(posZ).toBeGreaterThan(0);
    expect(posPercent).toBeGreaterThanOrEqual(40);
  });
});

describe('terrainDerivation — FNV-1a 32-Bit Unsigned Hash (M5)', () => {
  it('fnv1a32 always returns an unsigned 32-bit integer (>= 0 and <= 0xffffffff)', () => {
    const testStrings = [
      'whistler',
      'snowdon',
      'mont-blanc',
      'matterhorn',
      'a-very-long-test-string-to-induce-top-bit-sets',
      'special-chars-!@#$%^&*()',
      '',
    ];

    for (const str of testStrings) {
      const hash = fnv1a32(str);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash >>> 0).toBe(hash);
    }
  });
});

describe('terrainDerivation — OsmRefine Hook (m3)', () => {
  it('passes derived obstacles through optional osmRefine hook when provided', () => {
    const manifest = loadManifest();
    const heights = loadHeights();

    let hookCalled = false;
    const customHook = (obs: any[]) => {
      hookCalled = true;
      return obs.filter((_, idx) => idx % 2 === 0);
    };

    const result = deriveTerrain(manifest, heights, customHook);
    expect(hookCalled).toBe(true);
    expect(result.obstacles.length).toBe(55); // 110 / 2
  });
});