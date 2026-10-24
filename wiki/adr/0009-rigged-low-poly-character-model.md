# ADR-0009: Rigged Low-Poly Character Model

- **Status:** Accepted
- **Date:** 2026-10-24
- **Iteration:** `feat/better-character-model`
- **Supersedes:** — (active)
- **Superseded-by:** — (active)

## Context

The current rider in `src/player/SnowboardCharacter.ts` is built entirely from `THREE.BoxGeometry` primitives (torso, hips, legs, arms, head, beanie, goggles). While this works, GitHub issue #5 ("Better character model") calls for a more realistic humanoid shape that still preserves the PS1-era low-poly aesthetic. The existing procedural pose system (crouch/charge, spins, grabs A/B, landing squash, stance offset from ADR-0008 §5) must be retained, but re-implemented on top of a skeleton-rigged imported model rather than hard-coded mesh transforms.

Key constraints:
- The game targets Three.js in the browser; assets are `.glb`.
- The model must be **free and openly licensed** (CC0 or CC-BY with attribution).
- Poly budget: **under 2,000 triangles** to stay true to the low-poly PS1 look.
- The skeleton must be compatible with Mixamo-style or generic humanoid bone naming so the existing pose code can drive named bones (hips, spine, legs, arms, head).
- The procedural snowboard mesh may remain separate, or the model may include a snowboard group that we reparent/replace.
- The existing 90s color palette (purple pants, magenta jacket, yellow beanie, cyan goggles) should be preserved, either via vertex colors in the model or via material overrides at runtime.

## Decision

### 1. Asset Sourcing

An agent will search free model repositories (poly.pizza CC0, Sketchfab CC0, Mixamo, Kenney.nl, etc.) and select a low-poly humanoid base mesh with a standard skeleton. The downloaded `.glb` is committed under `public/assets/character/`.

- **Selection criteria:**
  - Low-poly humanoid (not an animal/robot unless explicitly stylized).
  - Skeleton with named bones: `Hips`, `Spine`, `Chest`, `Head`, `LeftLeg`, `RightLeg`, `LeftArm`, `RightArm` (or Mixamo equivalents).
  - License: CC0 strongly preferred; CC-BY accepted with attribution recorded in `public/assets/character/ATTRIBUTION.md`.
  - Poly count ≤ 2,000 tris.
  - Single `.glb` file, no external texture dependencies (or textures are also CC0/CC-BY).

### 2. Runtime Loading & Skeleton Mapping

`SnowboardCharacter` will load the `.glb` via `GLTFLoader` at `GameApp.init()` time (or lazily on first construction) and:
- Extract the `THREE.SkinnedMesh` and `THREE.Skeleton` from the loaded scene.
- Build a bone name → `THREE.Bone` lookup map.
- Retain the existing public API (`group`, `boardMesh`, `update(state, dt)`) so `PhysicsEngine`, `FollowCamera`, and `GameApp` require **zero changes**.

### 3. Pose Re-implementation (Bone-Driven, Procedural)

All poses from ADR-0008 §8.5 are re-implemented as **bone quaternion/position interpolations** driven by the same `PlayerState` fields:

- **Crouch/charge (`jumpCharge`):**
  - Lower `Hips` Y position, bend `Spine` forward, rotate upper-leg bones inward.
  - Board flex is handled by rotating the separate `boardMesh` group as today.
- **Grab A (indy/method, `activeGrab === 'A'`):**
  - Reach `RightArm` bone toward the front (toe-side) board edge.
- **Grab B (melon/tail, `activeGrab === 'B'`):**
  - Reach `LeftArm` bone toward the back (heel-side) board edge.
- **Spin / stance (`spinRad + stanceRad`):**
  - The entire character `group` is yaw-rotated around world Y, exactly as today. No per-bone spin; the root group rotation preserves the simple visual spin contract.
- **Landing squash:**
  - Brief `Spine` compression and `Hips` dip on clean touchdown (`0.15 s` window, same as today).
- **Board remain separate:**
  - The procedural `boardMesh` (neon cyan, bindings) is kept as a child of `group`, positioned relative to the character's feet. If the imported model includes its own board geometry, it is hidden or removed.

No pre-baked animation clips are used. Poses remain fully procedural and responsive to frame-by-frame state, preserving the charge-jump responsiveness from ADR-0008.

### 4. Materials & Aesthetic

- The model's materials are overridden at load time to enforce **flat shading** and the 90s palette:
  - Pants: `#4a154b` (purple)
  - Jacket: `#ff3366` (magenta)
  - Beanie: `#ffcc00` (yellow)
  - Skin: `#f3b07c`
  - Goggles lens: `#00f0ff` (cyan, low roughness, high metalness)
  - Boots: `#1f2421`
- If the model uses vertex colors, the runtime material overrides still apply via `MeshStandardMaterial` with `flatShading: true`.

### 5. Backward-Compatibility Contract

`SnowboardCharacter.ts` keeps its public interface unchanged:
```typescript
export class SnowboardCharacter {
  public readonly group: THREE.Group;
  public readonly boardMesh: THREE.Mesh;
  public readonly riderGroup: THREE.Group; // may now be the loaded GLB scene group
  update(state: PlayerState, dt: number): void;
  reset(): void;
}
```
Internal fields (meshes like `torso`, `hips`, `frontLeg`, etc.) become private bone references or are removed. No other module imports these internals.

### 6. Fallback

If the `.glb` fails to load (network/build error, missing file), `SnowboardCharacter` falls back to the existing procedural box-built rider so the game never crashes. This is a **developer-only** safeguard; the committed `.glb` must always be present in production builds.

## Consequences

- **Positive:** A more realistic humanoid silhouette while keeping the low-poly aesthetic. The skeleton enables future expansion (pre-baked idle/run animations, blended clips) if desired.
- **Positive:** The public API is unchanged; integration risk into `GameApp`, `PhysicsEngine`, `FollowCamera`, and `JungleAudioEngine` is minimal.
- **Positive:** Procedural poses are preserved, so charge-jump and trick mechanics from ADR-0008 work identically.
- **Risk:** Bone naming mismatches between model sources. The bone lookup map must be tolerant of common aliases (`mixamorig:Hips` vs `Hips` vs `hip`).
- **Risk:** `.glb` file size. The committed asset must be under ~200 KB to preserve fast browser load.
- **Compliance:** If CC-BY, attribution must be added to the main-menu credits (existing `attribution?: string[]` field in `GameConfig` / `OGSnowGlobalState` is sufficient).

## Compliance Rules

1. The committed `public/assets/character/` directory must contain the `.glb` and an `ATTRIBUTION.md` if the license requires attribution.
2. `SnowboardCharacter` must expose the same public API; no changes to `GameApp.ts`, `PhysicsEngine.ts`, `FollowCamera.ts`, or `HUDManager.ts`.
3. All existing unit tests (`character.test.ts`, `physics.test.ts`) and E2E tests (`gameplay.spec.ts`) must pass without modification, or be updated only to account for visual differences (e.g., bounding-box size).
4. The model must be loaded and the skeleton mapped before any `update()` is called; if loading fails, the procedural fallback must activate silently.
5. `npm run build` must succeed and the new asset must be included in the `dist/` output.
