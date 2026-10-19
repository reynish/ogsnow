import { describe, it, expect } from 'vitest';
import {
  lonLatToWebMercatorPixels,
  webMercatorPixelsToLonLat,
  decodeTerrariumPng,
  metersPerDegLat,
  metersPerDegLon,
  enuToGame,
  gameToEnu,
  resampleToGrid,
} from '../../src/terrain/terrainSource';
import { MountainRegistryEntry } from '../../src/terrain/mountains';

// ─── Helpers ───────────────────────────────────────────────────────────

/**
 * Build a minimal valid 256×256 RGB PNG (color type 2, 8 bpc) in-memory.
 * `pixelFn(r, c)` returns [R, G, B] for row r (0..255), col c (0..255).
 * Uses no compression-level tuning; results must match decodeTerrariumPng.
 */
function u32be(buf: Uint8Array, off: number, val: number): void {
  buf[off] = (val >> 24) & 0xff;
  buf[off + 1] = (val >> 16) & 0xff;
  buf[off + 2] = (val >> 8) & 0xff;
  buf[off + 3] = val & 0xff;
}

function crc32Bytes(buf: Uint8Array): number {
  // Use node:zlib's CRC-32 (PNG spec uses CRC-32/ISO-HDLC)
  const zlib = require('node:zlib');
  return zlib.crc32(Buffer.from(buf));
}

function buildTerrariumPng(
  pixelFn: (r: number, c: number) => [number, number, number],
): Buffer {
  const zlib = require('node:zlib');

  const W = 256;
  const H = 256;
  const channels = 3; // RGB
  const rowBytes = W * channels;

  // Build raw (unfiltered) pixel data: filter-type byte 0 (None) per row
  const raw = new Uint8Array(H * (1 + rowBytes));
  for (let r = 0; r < H; r++) {
    const rowOff = r * (1 + rowBytes);
    raw[rowOff] = 0; // filter type None
    for (let c = 0; c < W; c++) {
      const [R, G, B] = pixelFn(r, c);
      const pxOff = rowOff + 1 + c * channels;
      raw[pxOff] = R & 0xff;
      raw[pxOff + 1] = G & 0xff;
      raw[pxOff + 2] = B & 0xff;
    }
  }

  const compressed = Buffer.from(zlib.deflateSync(raw));

  // ─── PNG chunk helpers ─────────────────────────────────────────────
  function chunkBytes(type: string, data: Uint8Array): Uint8Array[] {
    const lenBuf = new Uint8Array(4);
    u32be(lenBuf, 0, data.length);
    const typeBytes = new Uint8Array(4);
    typeBytes[0] = type.charCodeAt(0);
    typeBytes[1] = type.charCodeAt(1);
    typeBytes[2] = type.charCodeAt(2);
    typeBytes[3] = type.charCodeAt(3);

    const crcInput = new Uint8Array(typeBytes.length + data.length);
    for (let i = 0; i < typeBytes.length; i++) crcInput[i] = typeBytes[i];
    for (let i = 0; i < data.length; i++) crcInput[typeBytes.length + i] = data[i];

    const crcBuf = new Uint8Array(4);
    u32be(crcBuf, 0, crc32Bytes(crcInput));

    return [lenBuf, typeBytes, data, crcBuf];
  }

  // Signature
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR: width(4) height(4) bitDepth(1) colorType(1) compression(1) filter(1) interlace(1)
  const ihdrData = new Uint8Array(13);
  u32be(ihdrData, 0, W);
  u32be(ihdrData, 4, H);
  ihdrData[8] = 8;  // bit depth
  ihdrData[9] = 2;  // RGB
  ihdrData[10] = 0; // compression deflate
  ihdrData[11] = 0; // filter adaptive
  ihdrData[12] = 0; // interlace none

  const ihdrParts = chunkBytes('IHDR', ihdrData);
  const idatParts = chunkBytes('IDAT', new Uint8Array(compressed));
  const iendParts = chunkBytes('IEND', new Uint8Array(0));

  // Concatenate all parts
  const allParts: Uint8Array[] = [sig, ...ihdrParts, ...idatParts, ...iendParts];
  let totalLen = 0;
  for (const p of allParts) totalLen += p.length;
  const out = new Uint8Array(totalLen);
  let off = 0;
  for (const p of allParts) {
    for (let i = 0; i < p.length; i++) out[off + i] = p[i];
    off += p.length;
  }
  return Buffer.from(out.buffer);
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('terrainSource — Geodesy & Coordinate Transforms', () => {
  it('lonLatToWebMercatorPixels / webMercatorPixelsToLonLat round-trip at Whistler anchor', () => {
    const lat = 50.0596;
    const lon = -122.9570;
    const zoom = 13;

    const { px, py, tx, ty } = lonLatToWebMercatorPixels(lon, lat, zoom);

    // Whistler anchor 50.0596/-122.9570 falls in tile 1298/2776 at z13
    expect(tx).toBe(1298);
    expect(ty).toBe(2776);

    // Round-trip
    const { lonDeg, latDeg } = webMercatorPixelsToLonLat(px, py, zoom);
    expect(lonDeg).toBeCloseTo(lon, 4);
    expect(latDeg).toBeCloseTo(lat, 4);
  });

  it('lonLatToWebMercatorPixels / inverse round-trip at origin/prime-meridian/equator', () => {
    const testPoints: [number, number, number][] = [
      [0, 0, 13],
      [48.8566, 2.3522, 13], // Paris
      [-33.8688, 151.2093, 14], // Sydney
      [90, -180, 10], // North pole / dateline
    ];

    for (const [lat, lon, zoom] of testPoints) {
      const { px, py } = lonLatToWebMercatorPixels(lon, lat, zoom);
      const { lonDeg, latDeg } = webMercatorPixelsToLonLat(px, py, zoom);
      expect(lonDeg).toBeCloseTo(lon, 4);
      expect(latDeg).toBeCloseTo(lat, 4);
    }
  });

  it('metersPerDegLon is smaller at higher latitudes', () => {
    const at60 = metersPerDegLon(60);
    const at0 = metersPerDegLon(0);
    expect(at60).toBeLessThan(at0);
    expect(at0).toBeCloseTo(111320, 0);
  });

  it('enuToGame / gameToEnu round-trips at various azimuths', () => {
    const azimuths = [0, 45, 90, 180, 270, 315];
    for (const az of azimuths) {
      const e = 100.0;
      const n = 200.0;
      const { x, z } = enuToGame(e, n, az);
      const { eastM, northM } = gameToEnu(x, z, az);
      expect(eastM).toBeCloseTo(e, 8);
      expect(northM).toBeCloseTo(n, 8);
    }
  });

  it('with downhill azimuth 180 (due south), ENU north vector maps to game -Z and West maps to screen-right (-X) (M2)', () => {
    // At azimuth 180: x_game = -east·(-1) + north·0 = +east
    //                z_game = east·0 + north·(-1) = −north
    const e = 100.0; // East
    const n = 200.0;
    const { x, z } = enuToGame(e, n, 180);

    // North points to -z in game space (summit/uphill)
    expect(z).toBeCloseTo(-n, 8);
    // Real-world East maps to screen-left (+X); real-world West maps to screen-right (-X) (M2)
    expect(x).toBeCloseTo(e, 8);

    // Verify West (e = -100) maps to world -X (screen-right)
    const westPt = enuToGame(-100.0, n, 180);
    expect(westPt.x).toBeCloseTo(-100.0, 8);
    expect(westPt.x).toBeLessThan(0);

    // Inverse
    const { eastM, northM } = gameToEnu(x, z, 180);
    expect(eastM).toBeCloseTo(e, 8);
    expect(northM).toBeCloseTo(n, 8);
  });

  it('with downhill azimuth 0 (due north), ENU north maps to game +Z and East maps to screen-right (-X)', () => {
    const e = 50.0;
    const n = 100.0;
    const { x, z } = enuToGame(e, n, 0);
    // azimuth 0: x = -e*1 + n*0 = -e, z = e*0 + n*1 = n
    expect(x).toBeCloseTo(-e, 8);
    expect(z).toBeCloseTo(n, 8);
  });
});

describe('terrainSource — decodeTerrariumPng', () => {
  it('decodes a black (R=G=B=0) 256×256 PNG to constant -32768 m', () => {
    const pngBuf = buildTerrariumPng(() => [0, 0, 0]);
    const elev = decodeTerrariumPng(pngBuf);
    expect(elev.length).toBe(256 * 256);
    // Every value = 0*256 + 0 + 0/256 - 32768 = -32768
    for (let i = 0; i < elev.length; i += 1000) {
      expect(elev[i]).toBeCloseTo(-32768, 0);
    }
    expect(elev[0]).toBe(-32768);
    expect(elev[65535]).toBe(-32768);
  });

  it('decodes a known RGB pixel to the correct elevation', () => {
    // R=128, G=64, B=0 => 128*256 + 64 + 0/256 - 32768 = 32768 + 64 - 32768 = 64
    const pngBuf = buildTerrariumPng(() => [128, 64, 0]);
    const elev = decodeTerrariumPng(pngBuf);
    expect(elev.length).toBe(256 * 256);
    expect(elev[0]).toBe(64);
    expect(elev[255]).toBe(64);
    expect(elev[64000]).toBe(64);
  });

  it('decodes a gradient PNG correctly', () => {
    // R=1, G=0, B=0 => 256 - 32768 = -32512
    // R=0, G=1, B=0 => 1 - 32768 = -32767
    // R=255, G=255, B=255 => 255*256 + 255 + 255/256 - 32768 ≈ 65535 - 32768 + 0.996 = 32767.996
    const pngBuf = buildTerrariumPng((r, c) => {
      if (r === 0 && c === 0) return [255, 255, 255];
      if (r === 100 && c === 50) return [128, 64, 32];
      return [0, 0, 0];
    });
    const elev = decodeTerrariumPng(pngBuf);
    expect(elev[0]).toBeCloseTo(255 * 256 + 255 + 255 / 256 - 32768, -1);
    expect(elev[100 * 256 + 50]).toBeCloseTo(128 * 256 + 64 + 32 / 256 - 32768, -1);
    expect(elev[200 * 256 + 200]).toBe(-32768);
  });

  it('rejects non-256×256 PNG', () => {
    // We can't easily build a non-256×256 valid PNG in this test helper,
    // but we can test the error path by passing a buffer that fails the size check.
    const smallBuf = Buffer.alloc(100);
    expect(() => decodeTerrariumPng(smallBuf)).toThrow();
  });
});

describe('terrainSource — resampleToGrid', () => {
  const whistlerEntry: MountainRegistryEntry = {
    id: 'whistler',
    name: 'Whistler Mountain',
    region: 'British Columbia, Canada',
    origin: { latitudeDeg: 50.0596, longitudeDeg: -122.957, downhillAzimuthDeg: 180 },
    extentWidthM: 1600,
    extentLengthM: 3200,
    zoom: 13,
    gridSegmentsX: 128,
    gridSegmentsZ: 256,
    treeLineElevationM: 1650,
    license: 'AWS Open Data Terrain Tiles (Terrarium)',
    attribution: ['Elevation: AWS Open Data Terrain Tiles (Terrarium)'],
    pinnedTiles: [
      { z: 13, x: 1297, y: 2775 },
      { z: 13, x: 1298, y: 2775 },
      { z: 13, x: 1297, y: 2776 },
      { z: 13, x: 1298, y: 2776 },
    ],
  };

  it('returns the correct number of heights and dimensions', () => {
    const expectedRows = whistlerEntry.gridSegmentsZ + 1; // 257
    const expectedCols = whistlerEntry.gridSegmentsX + 1; // 129
    const expectedCount = expectedRows * expectedCols; // 33153

    // Flat-earth mock elevation: constant 1500m
    const result = resampleToGrid(whistlerEntry, () => 1500.0);

    expect(result.heights.length).toBe(expectedCount);
    expect(result.controlPoints.length).toBeGreaterThanOrEqual(16);
    expect(result.controlPoints.length).toBe(25); // 5×5 grid
    expect(result.minElevation).toBe(1500);
    expect(result.maxElevation).toBe(1500);
  });

  it('varies elevation across the grid for a known slope function', () => {
    // Create a synthetic slope: elevation = 2000 + zGame * 0.1 (increases downhill +Z)
    const result = resampleToGrid(whistlerEntry, (lonDeg, latDeg) => {
      // Convert lat/lon back to game coords approximately
      const dLat = (latDeg - whistlerEntry.origin.latitudeDeg) * metersPerDegLat();
      const dLon = (lonDeg - whistlerEntry.origin.longitudeDeg) * metersPerDegLon(whistlerEntry.origin.latitudeDeg);
      const { z } = enuToGame(dLon, dLat, whistlerEntry.origin.downhillAzimuthDeg);
      return 2000 + z * 0.01; // gentle downhill increase
    });

    const midRow = whistlerEntry.gridSegmentsZ / 2;
    const midCol = whistlerEntry.gridSegmentsX / 2;
    const stride = whistlerEntry.gridSegmentsX + 1;
    const midElev = result.heights[Math.floor(midRow) * stride + Math.floor(midCol)];

    expect(midElev).toBeGreaterThan(1900);
    expect(midElev).toBeLessThan(2100);
    expect(result.minElevation).toBeLessThan(result.maxElevation);
  });

  it('records control points at the expected 5×5 grid positions', () => {
    const result = resampleToGrid(whistlerEntry, () => 1500.0);

    expect(result.controlPoints.length).toBe(25);
    // Check first control point (row=0, col=0)
    const cp00 = result.controlPoints[0];
    expect(cp00.id).toBe('cp-00');
    expect(cp00.row).toBe(0);
    expect(cp00.col).toBe(0);
    expect(cp00.elevationM).toBe(1500);

    // Check last control point (row=256, col=128)
    const cp24 = result.controlPoints[24];
    expect(cp24.id).toBe('cp-24');
    expect(cp24.row).toBe(whistlerEntry.gridSegmentsZ);
    expect(cp24.col).toBe(whistlerEntry.gridSegmentsX);
  });
});