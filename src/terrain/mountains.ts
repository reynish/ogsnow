// Pure-data mountain registry (browser + Node safe)
// MUST NOT import terrainSource.ts

import { GeoOrigin, PinnedTile } from '../types';

export interface MountainRegistryEntry {
  id: string;
  name: string;
  region: string;
  origin: GeoOrigin;
  extentWidthM: number;
  extentLengthM: number;
  zoom: number;
  gridSegmentsX: number;
  gridSegmentsZ: number;
  treeLineElevationM: number;
  license: string;
  attribution: string[];
  pinnedTiles: PinnedTile[];
}

export const MOUNTAIN_REGISTRY: Record<string, MountainRegistryEntry> = {
  whistler: {
    id: 'whistler',
    name: 'Whistler Mountain',
    region: 'British Columbia, Canada',
    origin: {
      latitudeDeg: 50.0596,
      longitudeDeg: -122.9570,
      downhillAzimuthDeg: 180,
    },
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
  },
};

export function getMountainById(id: string): MountainRegistryEntry {
  const entry = MOUNTAIN_REGISTRY[id];
  if (!entry) {
    throw new Error(`Unknown mountain id: "${id}". Available: ${Object.keys(MOUNTAIN_REGISTRY).join(', ')}`);
  }
  return entry;
}