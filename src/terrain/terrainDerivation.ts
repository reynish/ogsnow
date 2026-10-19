// Deterministic terrain derivation (browser + Node safe; NO node: imports)
// Exports deriveDropZones, deriveObstacles, deriveTerrain
// Seeded PRNG via FNV-1a of mountainId; never Math.random()/Date.now()

import {
  TerrainManifest,
  DropZone,
  TerrainObstacle,
  TerrainData,
} from '../types';

// ─── FNV-1a 32-bit hash for seeding ───────────────────────────────────

export function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  return hash;
}

// ─── Mulberry32 seeded PRNG ──────────────────────────────────────────

export function createSeededRandom(seed: number): () => number {
  let s = seed & 0xffffffff;
  return function () {
    s += 0x6d2b79f5;
    let t = s;
    t = (t ^ (t >> 15)) * (1 | t);
    t = (t ^ (t >> 7)) * (61 | t);
    return (t ^ (t >> 14)) / 4294967296;
  };
}

// ─── Grid helpers ─────────────────────────────────────────────────────

function gridX(c: number, W: number, segX: number): number {
  return -W / 2 + (c / segX) * W;
}

function gridZ(r: number, L: number, segZ: number): number {
  return -L / 2 + (r / segZ) * L;
}



/** Compute average downhill pitch (radians) over a window of `n` rows. */
function avgDownhillPitch(
  r: number,
  c: number,
  n: number,
  heights: Float32Array,
  segX: number,
  segZ: number,
  spacing: number,
): number {
  const stride = segX + 1;
  if (r + n > segZ) return 0;
  let totalDrop = 0;
  for (let i = 0; i < n; i++) {
    totalDrop += heights[(r + i) * stride + c] - heights[(r + i + 1) * stride + c];
  }
  const avgDrop = totalDrop / n;
  return Math.atan2(avgDrop, spacing);
}

/** Check if a cell (r, c) plus a downhill corridor of `corridorM` meters is clear of
 *  any previously placed drop zones. Returns true if safe. */
function corridorClearFromDropZones(
  r: number,
  c: number,
  dropZones: DropZone[],
  W: number,
  L: number,
  segX: number,
  segZ: number,
): boolean {
  const x0 = gridX(c, W, segX);
  const z0 = gridZ(r, L, segZ);
  for (const dz of dropZones) {
    // 25m radial clearance
    if (Math.hypot(x0 - dz.spawnPosition.x, z0 - dz.spawnPosition.z) < 25) {
      return false;
    }
    // 80m downhill corridor: |x - spawnX| < 18 for z in [spawnZ, spawnZ+80]
    if (
      Math.abs(x0 - dz.spawnPosition.x) < 18 &&
      z0 >= dz.spawnPosition.z &&
      z0 <= dz.spawnPosition.z + 80
    ) {
      return false;
    }
  }
  return true;
}

/** Compute slope magnitude at a grid cell (r, c) using central differences. */
function slopeMagnitude(
  r: number,
  c: number,
  heights: Float32Array,
  segX: number,
  segZ: number,
  spacing: number,
): number {
  const stride = segX + 1;
  if (r <= 0 || r >= segZ || c <= 0 || c >= segX) {
    return 0;
  }
  const dz = (heights[(r + 1) * stride + c] - heights[(r - 1) * stride + c]) / (2 * spacing);
  const dx = (heights[r * stride + c + 1] - heights[r * stride + c - 1]) / (2 * spacing);
  return Math.sqrt(dx * dx + dz * dz);
}

/** Compute curvature (Laplacian approximation) at a grid cell. Positive = convex (ridge). */
function curvature(
  r: number,
  c: number,
  heights: Float32Array,
  segX: number,
  segZ: number,
  spacing: number,
): number {
  const stride = segX + 1;
  if (r <= 0 || r >= segZ || c <= 0 || c >= segX) return 0;
  const center = heights[r * stride + c];
  const left = heights[r * stride + c - 1];
  const right = heights[r * stride + c + 1];
  const up = heights[(r - 1) * stride + c];
  const down = heights[(r + 1) * stride + c];
  return (left + right + up + down - 4 * center) / (spacing * spacing);
}

// ─── Drop Zone Derivation ─────────────────────────────────────────────

/**
 * Derive 3 drop zones with fixed ids summit-express, harmony-ridge, glacier-bowl.
 * Uses fully deterministic scanning of the height grid — no PRNG.
 * Positions are chosen for sustained steep downhill fall lines at
 * distinct elevations (highest→lowest).
 */
export function deriveDropZones(
  manifest: TerrainManifest,
  heights: Float32Array,
): DropZone[] {
  const { width: W, length: L, segmentsX: segX, segmentsZ: segZ } = manifest;
  const spacing = manifest.gridResolutionMeters || 12.5;
  const stride = segX + 1;
  const segCount = (segZ + 1) * stride;

  if (heights.length < segCount) {
    throw new Error(
      `heights length ${heights.length} < required ${segCount} (${segZ + 1}×${segX + 1})`,
    );
  }

  const dropZones: DropZone[] = [];

  // Define 3 elevation-correlated z-bands for deterministically picking positions.
  // Band boundaries in z-space (game coordinates).
  // Based on terrain analysis: summit near z=50, sustained steeps z=75→525,
  // flatter z=530→750, steep again z=750→1575.
  const bands: {
    id: string;
    name: string;
    description: string;
    difficulty: 'Green' | 'Blue' | 'Black' | 'Double Black';
    zMin: number;
    zMax: number;
    preferX: number; // preferred lateral position
  }[] = [
    {
      id: 'summit-express',
      name: 'Peak Express Summit',
      description: 'Steep alpine bowl dropping directly from the Whistler summit ridge.',
      difficulty: 'Double Black',
      zMin: -100,
      zMax: 150,
      preferX: 0,
    },
    {
      id: 'harmony-ridge',
      name: 'Harmony Ridge Drop',
      description: 'Wide open powder cruisers with natural rollers and tree glades.',
      difficulty: 'Blue',
      zMin: 450,
      zMax: 700,
      preferX: -45,
    },
    {
      id: 'glacier-bowl',
      name: 'Glacier Creek Chute',
      description: 'High-speed technical lower mountain run through rock outcrops and pines.',
      difficulty: 'Black',
      zMin: 800,
      zMax: 1150,
      preferX: 38,
    },
  ];

  for (const band of bands) {
    let bestScore = -Infinity;
    let bestR = -1;
    let bestC = -1;
    let bestH = 0;

    // Scan in row-major order (fully deterministic)
    for (let r = 0; r <= segZ; r++) {
      const z = gridZ(r, L, segZ);
      if (z < band.zMin || z > band.zMax) continue;

      for (let c = 0; c <= segX; c++) {
        const x = gridX(c, W, segX);

        // Skip if this candidate conflicts with an already-placed drop zone
        if (!corridorClearFromDropZones(r, c, dropZones, W, L, segX, segZ)) {
          continue;
        }

        const h = heights[r * stride + c];

        // Compute sustained pitch score: average pitch over ~6 cells (75m)
        const pitch = avgDownhillPitch(r, c, 6, heights, segX, segZ, spacing);

        // Bonus for being near the preferred lateral offset
        const lateralBonus = -Math.abs(x - band.preferX) * 0.001;

        // Bonus for higher elevation (within band)
        const elevNorm = (h - manifest.minElevation) / (manifest.maxElevation - manifest.minElevation);

        // Score: pitch dominates, with minor lateral and elevation bonuses
        const score = pitch + lateralBonus + elevNorm * 0.02;

        if (score > bestScore) {
          bestScore = score;
          bestR = r;
          bestC = c;
          bestH = h;
        }
      }
    }

    if (bestR < 0 || bestC < 0) {
      throw new Error(
        `Could not place drop zone "${band.id}" in z=[${band.zMin}, ${band.zMax}]`,
      );
    }

    const sx = gridX(bestC, W, segX);
    const sz = gridZ(bestR, L, segZ);
    const sy = bestH;

    // Determine a heading: for now, straight downhill (0 rad = +Z)
    // Slight variation for harmony and glacier to add character
    let headingRad = 0.0;
    if (band.id === 'harmony-ridge') headingRad = 0.08;
    else if (band.id === 'glacier-bowl') headingRad = -0.06;

    dropZones.push({
      id: band.id,
      name: band.name,
      elevationMeters: Math.round(sy * 100) / 100,
      description: band.description,
      difficulty: band.difficulty,
      spawnPosition: { x: Math.round(sx * 100) / 100, y: sy, z: Math.round(sz * 100) / 100 },
      initialHeadingRad: headingRad,
    });
  }

  // Sort highest → lowest by elevation
  dropZones.sort((a, b) => b.elevationMeters - a.elevationMeters);

  return dropZones;
}

// ─── Obstacle Derivation ──────────────────────────────────────────────

/**
 * Derive obstacles (trees, rocks, cliffs) deterministically from the height grid.
 * Uses a seeded PRNG for pseudo-random but reproducible placement.
 * Respects drop-zone clearance (25m radial + 80m corridor).
 */
export function deriveObstacles(
  manifest: TerrainManifest,
  heights: Float32Array,
  dropZones: DropZone[],
  seed: number,
): TerrainObstacle[] {
  const { width: W, length: L, segmentsX: segX, segmentsZ: segZ } = manifest;
  const spacing = manifest.gridResolutionMeters || 12.5;
  const stride = segX + 1;

  // Ensure the terrain extends from z = -L/2 to z = +L/2
  const zMin = -L / 2 + spacing * 2; // stay away from absolute edges
  const zMax = L / 2 - spacing * 2;

  const rand = createSeededRandom(seed);
  const obstacles: TerrainObstacle[] = [];
  const maxObstacles = 110;
  const maxAttempts = 3000;

  let attempts = 0;
  while (obstacles.length < maxObstacles && attempts < maxAttempts) {
    attempts++;

    // Pick a random grid cell (using seeded PRNG)
    const r = Math.floor(rand() * (segZ + 1));
    const c = Math.floor(rand() * (segX + 1));

    const z = gridZ(r, L, segZ);
    const x = gridX(c, W, segX);

    // Skip edge cells
    if (z < zMin || z > zMax) continue;

    const h = heights[r * stride + c];

    // ---- Clearance from drop zones ----
    let safe = true;
    for (const dz of dropZones) {
      // 25m radial clearance
      if (Math.hypot(x - dz.spawnPosition.x, z - dz.spawnPosition.z) < 25) {
        safe = false;
        break;
      }
      // 80m downhill corridor: |x - spawnX| < 18 for z in [spawnZ, spawnZ+80]
      if (
        Math.abs(x - dz.spawnPosition.x) < 18 &&
        z >= dz.spawnPosition.z &&
        z <= dz.spawnPosition.z + 80
      ) {
        safe = false;
        break;
      }
    }
    if (!safe) continue;

    // ---- Terrain analysis for obstacle type classification ----
    const slope = slopeMagnitude(r, c, heights, segX, segZ, spacing);
    const curv = curvature(r, c, heights, segX, segZ, spacing);
    const treeLine = manifest.source?.minElevationM !== undefined
      ? Math.min(manifest.maxElevation, 1650)
      : 1650;

    // Probability weights based on terrain
    const belowTreeLine = h <= treeLine;
    const isSteep = slope > 0.4; // ~22° slope magnitude
    const isVerySteep = slope > 0.7; // ~35°
    const isConvexRidge = curv > 0.005;
    let obstacleType: 'tree' | 'rock' | 'cliff' | null = null;

    // Cliffs on very steep or highly convex ridges
    if (isVerySteep || (isSteep && isConvexRidge)) {
      // ~30% chance of cliff on steep terrain
      if (rand() < 0.30) obstacleType = 'cliff';
    }

    // Rocks on moderately steep terrain or concave features
    if (obstacleType === null && isSteep) {
      if (rand() < 0.35) obstacleType = 'rock';
    }

    // Trees below tree line on gentle-moderate terrain (not too steep)
    if (obstacleType === null && belowTreeLine && slope < 0.5) {
      // ~40% chance for tree coverage in forested areas
      const treeProb = 0.40 * (1 - slope / 0.5); // denser on flatter terrain
      if (rand() < treeProb) obstacleType = 'tree';
    }

    // If no type selected, skip this cell
    if (obstacleType === null) continue;

    // Ensure minimum spacing between obstacles (~15m)
    let tooClose = false;
    for (const obs of obstacles) {
      if (Math.hypot(x - obs.position.x, z - obs.position.z) < 15) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;

    // Determine obstacle dimensions
    let radius: number;
    let height: number;

    switch (obstacleType) {
      case 'tree':
        radius = 0.8 + rand() * 1.0; // 0.8–1.8m
        height = 4.0 + rand() * 6.0; // 4–10m
        break;
      case 'rock':
        radius = 1.0 + rand() * 1.5; // 1.0–2.5m
        height = 1.0 + rand() * 2.5; // 1–3.5m
        break;
      case 'cliff':
        radius = 2.0 + rand() * 3.0; // 2–5m
        height = 3.0 + rand() * 5.0; // 3–8m
        break;
    }

    obstacles.push({
      id: `${obstacleType}_${obstacles.length}`,
      type: obstacleType,
      position: {
        x: Math.round(x * 100) / 100,
        y: heights[r * stride + c],
        z: Math.round(z * 100) / 100,
      },
      radius: Math.round(radius * 100) / 100,
      height: Math.round(height * 100) / 100,
    });
  }

  return obstacles;
}

// ─── Derive Terrain (full TerrainData) ────────────────────────────────

/**
 * Build a complete TerrainData from the committed manifest and height grid.
 * Runs deterministic derivation: drop zones, obstacles, metadata.
 */
export function deriveTerrain(
  manifest: TerrainManifest,
  heights: Float32Array,
): TerrainData {
  const seed = fnv1a32(manifest.mountainId);

  const dropZones = deriveDropZones(manifest, heights);
  const obstacles = deriveObstacles(manifest, heights, dropZones, seed);

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
    obstacles,
    dropZones,
    glbLoaded: false,
    glbFormatVersion: '2.0',
    // Provenance (Iteration 2, ADR-0007)
    source: manifest.source,
    origin: manifest.origin,
    realWorld: true,
    attribution: manifest.attribution,
    sampledControlPoints: manifest.sampledControlPoints,
    gridResolutionMeters: manifest.gridResolutionMeters,
  };
}