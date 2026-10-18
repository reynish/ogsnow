import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateWhistlerDEM,
  buildTerrainMeshFromDEM,
  exportTerrainToGLBBuffer,
} from '../src/terrain/glbPipeline';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log('[generate-glb] Synthesizing Whistler Peak DEM...');
  const terrainData = generateWhistlerDEM();
  console.log(
    `[generate-glb] DEM generated: ${terrainData.segmentsX}x${terrainData.segmentsZ} grid, ` +
      `elevation ${terrainData.minElevation}m - ${terrainData.maxElevation}m, ` +
      `${terrainData.obstacles.length} obstacles, ${terrainData.dropZones.length} drop zones.`
  );

  console.log('[generate-glb] Building low-poly terrain mesh...');
  const mesh = buildTerrainMeshFromDEM(terrainData);

  console.log('[generate-glb] Exporting to binary glTF 2.0 (.glb)...');
  const glbBuffer = await exportTerrainToGLBBuffer(mesh);

  // Validate GLB binary magic header 0x46546C67 ("glTF")
  if (glbBuffer.byteLength < 12) {
    throw new Error(`Generated buffer is too small: ${glbBuffer.byteLength} bytes`);
  }
  const view = new DataView(glbBuffer);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) {
    throw new Error(`Invalid GLB magic header: 0x${magic.toString(16)} (expected 0x46546c67)`);
  }

  const outputDir = path.resolve(__dirname, '../public/assets');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const outputPath = path.join(outputDir, 'whistler-peak.glb');
  fs.writeFileSync(outputPath, Buffer.from(glbBuffer));

  const stats = fs.statSync(outputPath);
  console.log(
    `[generate-glb] Successfully generated ${outputPath} (${stats.size} bytes, magic 0x${magic.toString(16)})`
  );
}

main().catch((err) => {
  console.error('[generate-glb] Error generating GLB asset:', err);
  process.exit(1);
});
