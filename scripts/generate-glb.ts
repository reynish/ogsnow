import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildTerrainMeshFromDEM,
  exportTerrainToGLBBuffer,
} from '../src/terrain/glbPipeline';
import {
  TerrainManifest,
  TerrainDerivation,
} from '../src/types';
import { fnv1a32, deriveTerrain } from '../src/terrain/terrainDerivation';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ASSETS_TERRAIN = path.resolve(__dirname, '../public/assets/terrain');
const ASSETS_DIR = path.resolve(__dirname, '../public/assets');

async function main(): Promise<void> {
  const binPath = path.join(ASSETS_TERRAIN, 'whistler-dem.bin');
  const jsonPath = path.join(ASSETS_TERRAIN, 'whistler-terrain.json');

  // ── Read committed DEM binary ─────────────────────────────────────
  if (!fs.existsSync(binPath)) {
    console.error(`[generate-glb] FATAL: missing DEM binary ${binPath}`);
    console.error('[generate-glb] Run `npm run fetch-terrain -- --mountain whistler` first (network).');
    process.exit(1);
  }
  const binBuffer = fs.readFileSync(binPath);
  const floatCount = binBuffer.byteLength / 4;
  // Validate: should be (segmentsZ+1)*(segmentsX+1) = 257*129 = 33153 floats
  if (floatCount !== 33153) {
    console.error(`[generate-glb] FATAL: DEM binary has ${floatCount} floats, expected 33153.`);
    process.exit(1);
  }
  const heights = new Float32Array(floatCount);
  heights.set(new Float32Array(binBuffer.buffer, binBuffer.byteOffset, floatCount));

  // ── Read committed terrain manifest ───────────────────────────────
  if (!fs.existsSync(jsonPath)) {
    console.error(`[generate-glb] FATAL: missing terrain manifest ${jsonPath}`);
    process.exit(1);
  }
  const manifestRaw = fs.readFileSync(jsonPath, 'utf-8');
  const manifest: TerrainManifest = JSON.parse(manifestRaw);

  // Validate manifest fields
  if (manifest.format !== 'ogsnow-terrain') {
    console.error(`[generate-glb] FATAL: invalid manifest format "${manifest.format}".`);
    process.exit(1);
  }
  if (manifest.segmentsX !== 128 || manifest.segmentsZ !== 256) {
    console.error(
      `[generate-glb] FATAL: manifest grid ${manifest.segmentsX}×${manifest.segmentsZ} ` +
        `does not match expected 128×256.`,
    );
    process.exit(1);
  }
  if (manifest.minElevation > 1600) {
    console.error(`[generate-glb] FATAL: minElevation ${manifest.minElevation} > 1600 (synthetic?).`);
    process.exit(1);
  }
  if (manifest.maxElevation < 2100) {
    console.error(`[generate-glb] FATAL: maxElevation ${manifest.maxElevation} < 2100 (synthetic?).`);
    process.exit(1);
  }

  console.log(
    `[generate-glb] Loaded committed artifacts: ${binBuffer.byteLength} bytes, ` +
      `elevation ${manifest.minElevation}m–${manifest.maxElevation}m, ` +
      `${manifest.segmentsX}×${manifest.segmentsZ} grid.`,
  );

  // ── Run deterministic derivation ──────────────────────────────────
  const seed = fnv1a32(manifest.mountainId);
  console.log(`[generate-glb] Deriving drop zones and obstacles (seed=${seed})...`);

  const terrainData = deriveTerrain(manifest, heights);

  console.log(
    `[generate-glb] Derived: ${terrainData.dropZones.length} drop zones, ` +
      `${terrainData.obstacles.length} obstacles.`,
  );

  // Print drop-zone summary
  for (const dz of terrainData.dropZones) {
    console.log(
      `  Drop zone "${dz.id}": elev=${dz.elevationMeters}m, ` +
        `pos=(${dz.spawnPosition.x.toFixed(1)}, ${dz.spawnPosition.z.toFixed(1)}), ` +
        `difficulty=${dz.difficulty}`,
    );
  }

  // ── Build mesh and export GLB ─────────────────────────────────────
  console.log('[generate-glb] Building low-poly terrain mesh...');
  const mesh = buildTerrainMeshFromDEM(terrainData);

  console.log('[generate-glb] Exporting to binary glTF 2.0 (.glb)...');
  const glbBuffer = await exportTerrainToGLBBuffer(mesh);

  // Validate GLB magic header 0x46546C67 ("glTF")
  if (glbBuffer.byteLength < 12) {
    throw new Error(`Generated buffer too small: ${glbBuffer.byteLength} bytes`);
  }
  const view = new DataView(glbBuffer);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) {
    throw new Error(`Invalid GLB magic header: 0x${magic.toString(16)} (expected 0x46546c67)`);
  }

  // Write .glb
  if (!fs.existsSync(ASSETS_DIR)) {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
  }
  const glbPath = path.join(ASSETS_DIR, 'whistler-peak.glb');
  fs.writeFileSync(glbPath, Buffer.from(glbBuffer));
  const glbStats = fs.statSync(glbPath);
  console.log(
    `[generate-glb] Written ${glbPath} (${glbStats.size} bytes, magic 0x${magic.toString(16)})`,
  );

  // ── Enrich and rewrite terrain manifest ───────────────────────────
  // Stable serialization: sorted keys, deterministic ordering, no timestamps
  const derivation: TerrainDerivation = {
    algorithmVersion: 1,
    seed,
    treeLineElevationM: 1650,
    dropZoneCount: terrainData.dropZones.length,
    obstacleCount: terrainData.obstacles.length,
  };

  const enriched: Record<string, unknown> = {};
  // Ordered fields matching TerrainManifest structure
  enriched.format = manifest.format;
  enriched.demFormatVersion = manifest.demFormatVersion;
  enriched.mountainId = manifest.mountainId;
  enriched.mountainName = manifest.mountainName;
  enriched.region = manifest.region;
  enriched.origin = manifest.origin;
  enriched.width = manifest.width;
  enriched.length = manifest.length;
  enriched.segmentsX = manifest.segmentsX;
  enriched.segmentsZ = manifest.segmentsZ;
  enriched.gridResolutionMeters = manifest.gridResolutionMeters;
  enriched.minElevation = manifest.minElevation;
  enriched.maxElevation = manifest.maxElevation;
  enriched.source = manifest.source;
  enriched.license = manifest.license;
  enriched.attribution = manifest.attribution;
  enriched.sampledControlPoints = manifest.sampledControlPoints;
  enriched.dropZones = terrainData.dropZones;
  enriched.obstacles = terrainData.obstacles;
  enriched.derivation = derivation;

  const jsonContent = JSON.stringify(enriched, null, 2) + '\n';
  fs.writeFileSync(jsonPath, jsonContent, 'utf-8');

  const jsonStats = fs.statSync(jsonPath);
  console.log(
    `[generate-glb] Enriched ${jsonPath} (${jsonStats.size} bytes) ` +
      `with ${terrainData.dropZones.length} drop zones, ${terrainData.obstacles.length} obstacles.`,
  );

  console.log('[generate-glb] Done.');
}

main().catch((err) => {
  console.error('[generate-glb] Fatal error:', err);
  process.exit(1);
});