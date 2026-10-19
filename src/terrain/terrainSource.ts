// Node-only terrain source module. MUST NOT be imported by any browser-bundled module.
// Uses node:builtins: zlib (no new dependency), crypto, etc.

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { MountainRegistryEntry } from './mountains';
import {
  SampledControlPoint,
  TerrainTileRecord,
  TerrainSourceMetadata,
} from '../types';

// ─── Web Mercator (EPSG:3857) Tile URL ───────────────────────────────────

export function terrariumTileUrl(z: number, x: number, y: number): string {
  return `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
}

// ─── Web Mercator Pixel Math ─────────────────────────────────────────────

export function lonLatToWebMercatorPixels(
  lonDeg: number,
  latDeg: number,
  zoom: number,
): { px: number; py: number; tx: number; ty: number } {
  const n = Math.pow(2, zoom);
  const tileSize = 256;
  const latRad = latDeg * Math.PI / 180;

  const px = (lonDeg + 180) / 360 * n * tileSize;
  const py =
    (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 *
    n *
    tileSize;

  return {
    px,
    py,
    tx: Math.floor(px / tileSize),
    ty: Math.floor(py / tileSize),
  };
}

export function webMercatorPixelsToLonLat(
  px: number,
  py: number,
  zoom: number,
): { lonDeg: number; latDeg: number } {
  const n = Math.pow(2, zoom);
  const tileSize = 256;
  const lonDeg = (px * 360) / (n * tileSize) - 180;
  const latRad = Math.atan(
    Math.sinh(Math.PI * (1 - (2 * py) / (n * tileSize))),
  );
  const latDeg = latRad * 180 / Math.PI;
  return { lonDeg, latDeg };
}

// ─── Geodesy Constants ──────────────────────────────────────────────────

export function metersPerDegLat(): number {
  return 111320.0;
}

export function metersPerDegLon(latDeg: number): number {
  return 111320.0 * Math.cos(latDeg * Math.PI / 180);
}

// ─── ENU ↔ Game-space rotation (ADR-0007 §5) ────────────────────────────

export function enuToGame(
  eastM: number,
  northM: number,
  azimuthDeg: number,
): { x: number; z: number } {
  const thetaRad = azimuthDeg * Math.PI / 180;
  const sinT = Math.sin(thetaRad);
  const cosT = Math.cos(thetaRad);
  // x_game = east·cosT − north·sinT
  // z_game = east·sinT + north·cosT
  return {
    x: eastM * cosT - northM * sinT,
    z: eastM * sinT + northM * cosT,
  };
}

export function gameToEnu(
  x: number,
  z: number,
  azimuthDeg: number,
): { eastM: number; northM: number } {
  const thetaRad = azimuthDeg * Math.PI / 180;
  const sinT = Math.sin(thetaRad);
  const cosT = Math.cos(thetaRad);
  // east  = x·cosT + z·sinT
  // north = −x·sinT + z·cosT
  return {
    eastM: x * cosT + z * sinT,
    northM: -x * sinT + z * cosT,
  };
}

// ─── Compact PNG Decoder (node:zlib only) ──────────────────────────────

const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readU32(buf: Buffer, offset: number): number {
  return (
    (buf[offset] << 24) |
    (buf[offset + 1] << 16) |
    (buf[offset + 2] << 8) |
    buf[offset + 3]
  );
}

interface PngInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  channels: number;
}

function parsePngHeader(buf: Buffer): { info: PngInfo; idatOffsets: number[] } {
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIG[i]) {
      throw new Error(`Invalid PNG signature byte ${i}: ${buf[i]} !== ${PNG_SIG[i]}`);
    }
  }

  let offset = 8;
  let info: PngInfo | null = null;
  const idatOffsets: number[] = [];

  while (offset + 8 <= buf.length) {
    const length = readU32(buf, offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (type === 'IHDR') {
      if (dataEnd > buf.length) {
        throw new Error('Truncated IHDR chunk');
      }
      const width = readU32(buf, dataStart);
      const height = readU32(buf, dataStart + 4);
      const bitDepth = buf[dataStart + 8];
      const colorType = buf[dataStart + 9];
      const compression = buf[dataStart + 10];
      const filterMethod = buf[dataStart + 11];
      const interlace = buf[dataStart + 12];

      if (compression !== 0) {
        throw new Error(`Unsupported PNG compression method: ${compression}`);
      }
      if (filterMethod !== 0) {
        throw new Error(`Unsupported PNG filter method: ${filterMethod}`);
      }
      if (interlace !== 0) {
        throw new Error('Interlaced PNG not supported');
      }

      let channels: number;
      switch (colorType) {
        case 0: channels = 1; break;
        case 2: channels = 3; break;
        case 3: channels = 1; break;
        case 4: channels = 2; break;
        case 6: channels = 4; break;
        default: throw new Error(`Unsupported PNG color type: ${colorType}`);
      }

      if (bitDepth !== 8) {
        throw new Error(`Unsupported PNG bit depth: ${bitDepth} (only 8-bit supported)`);
      }

      info = { width, height, bitDepth, colorType, channels };
    } else if (type === 'IDAT') {
      idatOffsets.push(dataStart);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4; // skip CRC
  }

  if (!info) {
    throw new Error('PNG missing IHDR chunk');
  }
  if (idatOffsets.length === 0) {
    throw new Error('PNG missing IDAT chunk(s)');
  }

  return { info, idatOffsets };
}

/** Concatenate all IDAT chunk data into one compressed buffer. */
function _concatIdat(buf: Buffer, offsets: number[]): Buffer {
  let total = 0;
  for (const off of offsets) {
    total += readU32(buf, off - 8);
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const off of offsets) {
    const len = readU32(buf, off - 8);
    for (let i = 0; i < len; i++) {
      out[pos + i] = buf[off + i];
    }
    pos += len;
  }
  return Buffer.from(out.buffer);
}

/**
 * Decode a PNG image buffer to raw 8-bit pixel data (row-major, byte-per-channel).
 */
function decodePngRaw(buf: Buffer): { pixels: Buffer; info: PngInfo } {
  const { info, idatOffsets } = parsePngHeader(buf);

  // Decompress IDAT via zlib
  const compressed = _concatIdat(buf, idatOffsets);
  const rawBuf: Buffer = zlib.inflateSync(compressed) as unknown as Buffer;

  // Unfilter rows
  const { width, height, channels } = info;
  const rowBytes = width * channels;
  const pixels = new Uint8Array(height * rowBytes);

  let srcOff = 0;
  const prevRow = new Uint8Array(rowBytes);
  const curRow = new Uint8Array(rowBytes);

  for (let r = 0; r < height; r++) {
    const filterType = rawBuf[srcOff++];
    const rowStart = srcOff;
    srcOff += rowBytes;

    // Read raw (filtered) bytes into curRow
    for (let i = 0; i < rowBytes; i++) {
      curRow[i] = rawBuf[rowStart + i];
    }

    // Apply inverse filter
    switch (filterType) {
      case 0: // None
        break;
      case 1: { // Sub
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= channels ? curRow[i - channels] : 0;
          curRow[i] = (curRow[i] + left) & 0xff;
        }
        break;
      }
      case 2: { // Up
        for (let i = 0; i < rowBytes; i++) {
          curRow[i] = (curRow[i] + prevRow[i]) & 0xff;
        }
        break;
      }
      case 3: { // Average
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= channels ? curRow[i - channels] : 0;
          const up = prevRow[i];
          curRow[i] = (curRow[i] + ((left + up) >> 1)) & 0xff;
        }
        break;
      }
      case 4: { // Paeth
        for (let i = 0; i < rowBytes; i++) {
          const left = i >= channels ? curRow[i - channels] : 0;
          const up = prevRow[i];
          const upperLeft = i >= channels ? prevRow[i - channels] : 0;
          const p = left + up - upperLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upperLeft);
          const pr = (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : upperLeft);
          curRow[i] = (curRow[i] + pr) & 0xff;
        }
        break;
      }
      default:
        throw new Error(`Unsupported PNG filter type: ${filterType}`);
    }

    pixels.set(curRow, r * rowBytes);

    // Copy curRow to prevRow for next iteration
    for (let i = 0; i < rowBytes; i++) {
      prevRow[i] = curRow[i];
    }
  }

  // Convert pixel data to Buffer for API compat
  const pixelBuf = Buffer.from(pixels.buffer as ArrayBuffer);
  return { pixels: pixelBuf, info };
}

/**
 * Decode a Terrarium PNG buffer (8-bit RGB, 256x256) to Float32Array
 * of elevation values (row-major 256x256).
 *
 * Elevation formula: R*256 + G + B/256 - 32768
 */
export function decodeTerrariumPng(buf: Buffer): Float32Array {
  const { pixels, info } = decodePngRaw(buf);
  const { width, height, colorType } = info;

  if (width !== 256 || height !== 256) {
    throw new Error(
      `Expected 256x256 Terrarium tile, got ${width}x${height}`,
    );
  }

  const elevations = new Float32Array(256 * 256);

  if (colorType === 2) {
    // RGB: each pixel is 3 bytes
    for (let r = 0; r < 256; r++) {
      const rowOff = r * 256 * 3;
      for (let c = 0; c < 256; c++) {
        const off = rowOff + c * 3;
        const R = pixels[off];
        const G = pixels[off + 1];
        const B = pixels[off + 2];
        elevations[r * 256 + c] = (R * 256 + G + B / 256.0) - 32768.0;
      }
    }
  } else if (colorType === 0) {
    // Grayscale: each pixel is 1 byte (unlikely for Terrarium but handle it)
    for (let r = 0; r < 256; r++) {
      const rowOff = r * 256;
      for (let c = 0; c < 256; c++) {
        elevations[r * 256 + c] = pixels[rowOff + c];
      }
    }
  } else {
    throw new Error(
      `Unsupported Terrarium color type: ${colorType} (expected 2=RGB or 0=Grayscale)`,
    );
  }

  return elevations;
}

// ─── SHA-256 ───────────────────────────────────────────────────────────

export function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ─── Build Source Metadata ─────────────────────────────────────────────

export function buildSourceMetadata(
  entry: MountainRegistryEntry,
  tiles: TerrainTileRecord[],
  minElevationM: number,
  maxElevationM: number,
): TerrainSourceMetadata {
  return {
    provider: 'aws-terrarium',
    zoom: entry.zoom,
    tiles,
    minElevationM,
    maxElevationM,
  };
}

// ─── Grid Resampling ───────────────────────────────────────────────────

export function resampleToGrid(
  entry: MountainRegistryEntry,
  getElevation: (lonDeg: number, latDeg: number) => number,
): {
  heights: Float32Array;
  minElevation: number;
  maxElevation: number;
  controlPoints: SampledControlPoint[];
} {
  const { extentWidthM: W, extentLengthM: L, gridSegmentsX, gridSegmentsZ, origin, zoom } = entry;
  const stride = gridSegmentsX + 1;
  const total = (gridSegmentsZ + 1) * stride;
  const heights = new Float32Array(total);

  let minElevation = Infinity;
  let maxElevation = -Infinity;

  // Prepare control points: 5x5 grid = 25 points (>=16)
  const cpRows: number[] = [];
  const cpCols: number[] = [];
  for (let ri = 0; ri < 5; ri++) {
    cpRows.push(Math.round((ri / 4) * gridSegmentsZ));
  }
  for (let ci = 0; ci < 5; ci++) {
    cpCols.push(Math.round((ci / 4) * gridSegmentsX));
  }
  const controlPoints: SampledControlPoint[] = [];
  let cpIdx = 0;

  for (let r = 0; r <= gridSegmentsZ; r++) {
    const zGame = -L / 2 + (r / gridSegmentsZ) * L;
    for (let c = 0; c <= gridSegmentsX; c++) {
      const xGame = -W / 2 + (c / gridSegmentsX) * W;

      // Game -> ENU
      const { eastM, northM } = gameToEnu(xGame, zGame, origin.downhillAzimuthDeg);

      // ENU -> lat/lon (small-angle approximation)
      const latDeg = origin.latitudeDeg + northM / metersPerDegLat();
      const lonDeg = origin.longitudeDeg + eastM / metersPerDegLon(origin.latitudeDeg);

      const elev = getElevation(lonDeg, latDeg);
      heights[r * stride + c] = elev;

      if (elev < minElevation) minElevation = elev;
      if (elev > maxElevation) maxElevation = elev;

      // Record control points at regular intervals
      if (cpRows.includes(r) && cpCols.includes(c)) {
        const { px, py, tx, ty } = lonLatToWebMercatorPixels(lonDeg, latDeg, zoom);
        controlPoints.push({
          id: `cp-${cpIdx.toString().padStart(2, '0')}`,
          row: r,
          col: c,
          x: xGame,
          z: zGame,
          latDeg: Math.round(latDeg * 1e6) / 1e6,
          lonDeg: Math.round(lonDeg * 1e6) / 1e6,
          tileZ: zoom,
          tileX: tx,
          tileY: ty,
          px: Math.round(px * 100) / 100,
          py: Math.round(py * 100) / 100,
          elevationM: Math.round(elev * 100) / 100,
        });
        cpIdx++;
      }
    }
  }

  return { heights, minElevation, maxElevation, controlPoints };
}