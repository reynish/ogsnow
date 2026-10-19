// scripts/fetch-terrain.ts — Stage A network fetch (on-demand, developer machine only)
// Usage: npm run fetch-terrain -- --mountain whistler

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getMountainById, MountainRegistryEntry, MOUNTAIN_REGISTRY } from '../src/terrain/mountains';
import {
  terrariumTileUrl,
  lonLatToWebMercatorPixels,
  decodeTerrariumPng,
  resampleToGrid,
  sha256Hex,
  buildSourceMetadata,
  metersPerDegLat,
  metersPerDegLon,
  gameToEnu,
} from '../src/terrain/terrainSource';
import { TerrainTileRecord, TerrainManifest } from '../src/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

// ─── Helpers ──────────────────────────────────────────────────────────────

function usage(): never {
  console.error('Usage: npm run fetch-terrain -- --mountain <id>');
  console.error(`Available mountains: ${Object.keys(MOUNTAIN_REGISTRY).join(', ')}`);
  process.exit(1);
}

function parseArgs(): { mountainId: string } {
  const args = process.argv.slice(1);
  let mountainId = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mountain' && i + 1 < args.length) {
      mountainId = args[i + 1];
      i++;
    }
  }
  if (!mountainId) usage();
  return { mountainId };
}

// ─── Tile Cache ────────────────────────────────────────────────────────────

function cachePath(z: number, x: number, y: number): string {
  return path.resolve(REPO_ROOT, '.cache', 'terrain', String(z), String(x), `${y}.png`);
}

function ensureCacheDir(z: number, x: number): void {
  const dir = path.resolve(REPO_ROOT, '.cache', 'terrain', String(z), String(x));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function downloadTile(url: string, dest: string): Promise<Buffer> {
  console.log(`[fetch] Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const buf = Buffer.from(new Uint8Array(arrayBuffer));

  // Validate PNG magic
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50) {
    throw new Error(`Invalid PNG (bad magic) from ${url}`);
  }

  // Write cache
  fs.writeFileSync(dest, buf);
  return buf;
}

async function fetchTile(z: number, x: number, y: number): Promise<Buffer> {
  const url = terrariumTileUrl(z, x, y);
  const cached = cachePath(z, x, y);

  if (fs.existsSync(cached)) {
    console.log(`[fetch] Cache HIT ${url}`);
    return fs.readFileSync(cached);
  }

  ensureCacheDir(z, x);
  return await downloadTile(url, cached);
}

// ─── Covered-pixel check ──────────────────────────────────────────────────

function verifyCoverage(
  entry: MountainRegistryEntry,
  getElevation: (lonDeg: number, latDeg: number) => number,
  tileKeys: Set<string>,
): void {
  const { extentWidthM: W, extentLengthM: L, gridSegmentsX, gridSegmentsZ, origin, zoom } = entry;

  // Check all grid vertices plus a 1-pixel margin around the extent
  let uncovered = 0;

  for (let r = 0; r <= gridSegmentsZ; r++) {
    const zGame = -L / 2 + (r / gridSegmentsZ) * L;
    for (let c = 0; c <= gridSegmentsX; c++) {
      const xGame = -W / 2 + (c / gridSegmentsX) * W;

      const { eastM, northM } = gameToEnu(xGame, zGame, origin.downhillAzimuthDeg);
      const latDeg = origin.latitudeDeg + northM / metersPerDegLat();
      const lonDeg = origin.longitudeDeg + eastM / metersPerDegLon(origin.latitudeDeg);

      const { tx, ty } = lonLatToWebMercatorPixels(lonDeg, latDeg, zoom);
      const key = `${zoom}/${tx}/${ty}`;

      if (!tileKeys.has(key)) {
        if (uncovered < 10) {
          console.error(
            `[fetch] COVERAGE GAP at grid (${c},${r}) game (${xGame.toFixed(1)},${zGame.toFixed(1)}) ` +
            `lat/lon (${latDeg.toFixed(4)},${lonDeg.toFixed(4)}) -> tile ${key}`,
          );
        }
        uncovered++;
      }

      // Also verify getElevation works
      try {
        getElevation(lonDeg, latDeg);
      } catch (e) {
        if (uncovered < 10) {
          console.error(`[fetch] ELEVATION error at grid (${c},${r}): ${e}`);
        }
        uncovered++;
      }
    }
  }

  if (uncovered > 0) {
    console.error(`[fetch] FAIL: ${uncovered} pixels outside pinned tile set. Exiting.`);
    process.exit(1);
  }
  console.log(`[fetch] Coverage verified: all ${(gridSegmentsZ + 1) * (gridSegmentsX + 1)} grid pixels covered.`);
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { mountainId } = parseArgs();
  console.log(`[fetch] Starting fetch for mountain: ${mountainId}`);

  const entry = getMountainById(mountainId);
  console.log(`[fetch] ${entry.name} (${entry.region})`);
  console.log(`[fetch] Grid: ${entry.gridSegmentsX}x${entry.gridSegmentsZ}, extent ${entry.extentWidthM}x${entry.extentLengthM}m`);

  // 1. Fetch all pinned tiles, decode, record checksums
  const tileData: Map<string, Float32Array> = new Map();
  const tileRecords: TerrainTileRecord[] = [];
  const tileKeys = new Set<string>();

  for (const tile of entry.pinnedTiles) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    tileKeys.add(key);

    console.log(`[fetch] Processing tile ${key}...`);
    const rawPng = await fetchTile(tile.z, tile.x, tile.y);
    const sha256 = sha256Hex(rawPng);
    console.log(`[fetch]   SHA-256: ${sha256}`);

    const decoded = decodeTerrariumPng(rawPng);
    tileData.set(key, decoded);

    // Quick stats
    let tMin = Infinity;
    let tMax = -Infinity;
    for (let i = 0; i < decoded.length; i++) {
      if (decoded[i] < tMin) tMin = decoded[i];
      if (decoded[i] > tMax) tMax = decoded[i];
    }
    console.log(`[fetch]   Min: ${tMin.toFixed(1)} m, Max: ${tMax.toFixed(1)} m`);

    tileRecords.push({
      z: tile.z,
      x: tile.x,
      y: tile.y,
      url: terrariumTileUrl(tile.z, tile.x, tile.y),
      sha256,
    });
  }

  console.log(`[fetch] ${tileRecords.length} tiles fetched and decoded successfully.`);

  // 2. Build elevation query function
  function getElevation(lonDeg: number, latDeg: number): number {
    const { px, py, tx, ty } = lonLatToWebMercatorPixels(lonDeg, latDeg, entry.zoom);
    const key = `${entry.zoom}/${tx}/${ty}`;
    const data = tileData.get(key);
    if (!data) {
      throw new Error(`Tile ${key} not in pinned set for pixel (${px.toFixed(1)},${py.toFixed(1)})`);
    }

    // Fractional pixel within tile
    const tileSize = 256;
    const u = px - tx * tileSize;
    const v = py - ty * tileSize;

    if (u < -0.5 || u > 256.5 || v < -0.5 || v > 256.5) {
      throw new Error(`Pixel (${px.toFixed(1)},${py.toFixed(1)}) falls outside tile ${key}`);
    }

    // Bilinear interpolation (clamped to valid range)
    const stride = 256;
    const c0 = Math.min(255, Math.max(0, Math.floor(u)));
    const r0 = Math.min(255, Math.max(0, Math.floor(v)));
    const c1 = Math.min(255, c0 + 1);
    const r1 = Math.min(255, r0 + 1);
    const fx = u - c0;
    const fy = v - r0;

    const h00 = data[r0 * stride + c0];
    const h10 = data[r0 * stride + c1];
    const h01 = data[r1 * stride + c0];
    const h11 = data[r1 * stride + c1];

    const top = h00 * (1 - fx) + h10 * fx;
    const bot = h01 * (1 - fx) + h11 * fx;
    return top * (1 - fy) + bot * fy;
  }

  // 3. Verify coverage (before resampling — fail fast)
  verifyCoverage(entry, getElevation, tileKeys);

  // 4. Resample to game grid
  console.log(`[fetch] Resampling to ${entry.gridSegmentsX}x${entry.gridSegmentsZ} game grid...`);
  const { heights, minElevation, maxElevation, controlPoints } = resampleToGrid(entry, getElevation);
  console.log(`[fetch] DEM stats: min=${minElevation.toFixed(1)} m, max=${maxElevation.toFixed(1)} m`);

  if (minElevation < -500 || maxElevation > 10000 || maxElevation <= minElevation) {
    console.error(`[fetch] FAIL: implausible elevation range [${minElevation.toFixed(1)}, ${maxElevation.toFixed(1)}]`);
    process.exit(1);
  }

  // 5. Write whistler-dem.bin
  const assetsDir = path.resolve(REPO_ROOT, 'public', 'assets', 'terrain');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  const binPath = path.join(assetsDir, `${mountainId}-dem.bin`);
  const buf = new ArrayBuffer(heights.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < heights.length; i++) {
    view.setFloat32(i * 4, heights[i], true); // little-endian
  }
  fs.writeFileSync(binPath, Buffer.from(new Uint8Array(buf)));
  const binStats = fs.statSync(binPath);
  console.log(`[fetch] Wrote ${binPath} (${binStats.size} bytes, ${heights.length} floats)`);

  // Verify correct row-major dimensions
  const expectedFloats = (entry.gridSegmentsZ + 1) * (entry.gridSegmentsX + 1);
  if (heights.length !== expectedFloats) {
    console.error(`[fetch] FAIL: expected ${expectedFloats} floats, got ${heights.length}`);
    process.exit(1);
  }

  // 6. Build and write terrain JSON manifest
  const source = buildSourceMetadata(entry, tileRecords, minElevation, maxElevation);

  // Compute grid resolution
  const gridResolutionMeters = entry.extentWidthM / entry.gridSegmentsX;

  const manifest: TerrainManifest = {
    format: 'ogsnow-terrain',
    demFormatVersion: 1,
    mountainId: entry.id,
    mountainName: entry.name,
    region: entry.region,
    origin: {
      latitudeDeg: entry.origin.latitudeDeg,
      longitudeDeg: entry.origin.longitudeDeg,
      downhillAzimuthDeg: entry.origin.downhillAzimuthDeg,
    },
    width: entry.extentWidthM,
    length: entry.extentLengthM,
    segmentsX: entry.gridSegmentsX,
    segmentsZ: entry.gridSegmentsZ,
    gridResolutionMeters: Math.round(gridResolutionMeters * 100) / 100,
    minElevation: Math.round(minElevation * 100) / 100,
    maxElevation: Math.round(maxElevation * 100) / 100,
    source,
    license: entry.license,
    attribution: [...entry.attribution],
    sampledControlPoints: controlPoints,
  };

  const jsonPath = path.join(assetsDir, `${mountainId}-terrain.json`);
  // Stable JSON serialization: explicit field order, no timestamps
  const jsonContent = stableJsonStringify(manifest);
  fs.writeFileSync(jsonPath, jsonContent + '\n');
  const jsonStats = fs.statSync(jsonPath);
  console.log(`[fetch] Wrote ${jsonPath} (${jsonStats.size} bytes)`);

  // 7. Summary
  console.log('\n[fetch] === FETCH COMPLETE ===');
  console.log(`  Tiles: ${tileRecords.length} tiles at z${entry.zoom}`);
  for (const tr of tileRecords) {
    console.log(`    ${tr.z}/${tr.x}/${tr.y}  SHA-256:${tr.sha256}`);
  }
  console.log(`  Elevation range: ${minElevation.toFixed(1)} m - ${maxElevation.toFixed(1)} m`);
  console.log(`  Control points: ${controlPoints.length}`);
  console.log(`  BIN file: ${binStats.size} bytes (${heights.length} floats)`);
  console.log(`  JSON file: ${jsonStats.size} bytes`);
  console.log('[fetch] Done.');
}

// ─── Stable JSON Serializer ──────────────────────────────────────────────
// Produces deterministic JSON with canonical field ordering.

function stableJsonStringify(obj: any, indent: string = '  '): string {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj === 'string') return JSON.stringify(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);

  if (Array.isArray(obj)) {
    const items = obj.map((item) => stableJsonStringify(item, indent));
    return '[\n' + items.map((s) => indent + s).join(',\n') + '\n]';
  }

  if (typeof obj === 'object') {
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => {
      const val = stableJsonStringify(obj[k], indent);
      return `${indent}${JSON.stringify(k)}: ${val}`;
    });
    return '{\n' + pairs.join(',\n') + '\n}';
  }

  return String(obj);
}

main().catch((err) => {
  console.error('[fetch] FATAL:', err.message || err);
  process.exit(1);
});