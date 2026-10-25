# ADR-0009: Rigged Low-Poly Character Model & Authentic Sideways Snowboarder Kinematics

- **Status:** Accepted
- **Date:** 2026-10-24
- **Amended:** 2026-10-25 (PR #7 owner playtest review, reynish) — three critical playtest fixes for authentic snowboarding biomechanics and board-rider coupling:
  1. **Board & Bindings Coupled to Rider Spin/Stance + Foot Anchor (`SnowboardCharacter.ts`):** `boardMesh`, `frontBinding`, and `backBinding` MUST rotate in lockstep with `riderGroup.rotation.y` (`stanceRad + spinRad`) and rise/tilt with the rider's feet during air grabs and jump crouch so boots never detach from bindings or clip through the board.
  2. **Authentic Sideways Athletic Snowboarder Bind Pose (`scripts/generate-character.ts` & `public/assets/character/rider.glb`):** Redesign the 12-bone skeleton and mesh geometry so the rider stands **sideways** across the board (`Hips` at `y ≈ 0.56`, `yaw ≈ 1.30–1.40 rad` facing toe edge `+X`), with genuinely flexed 3D knees (`knee flexion angle ≈ 0.55–0.70 rad`, knee joints offset forward toward `+X` at `y ≈ 0.30–0.33`), boots planted at `(x ≈ 0, y ≈ 0.04–0.09, z = ±0.35)`, forward-hinged spine/chest (`~0.22–0.30 rad`), bent elbows (`~0.65–0.85 rad`), and head/goggles counter-rotated on Y to face downhill (`+Z`, `maxY >= 1.42`).
  3. **Full 12-Bone Procedural Animation & Foot-Anchored Kinematics (`src/player/SnowboardCharacter.ts`):** Drive all 12 bones (`Hips`, `Spine`, `Chest`, `Head`, `RightLeg`/`RightUpLeg`, `RightLowerLeg`/`RightLeg`, `LeftLeg`/`LeftUpLeg`, `LeftLowerLeg`/`LeftLeg`, `RightArm`/`RightUpperArm`, `RightLowerArm`, `LeftArm`/`LeftUpperArm`, `LeftLowerArm`) with counter-flexing lower legs during crouch so boots stay locked to the bindings, plus full torso/arm/board articulation for Grab A (Indy/Method) and Grab B (Melon/Tail). See §7 and Compliance Rules 6–10.
- **Iteration:** `feat/better-character-model` (`feat/rigged-low-poly-character-model-integration-2`)
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
  - `this.group.rotation.y` tracks travel `headingRad`, while `riderGroup.rotation.y` AND the snowboard + bindings (`boardGroup` / `boardMesh`, `frontBinding`, `backBinding`) rotate together in lockstep by `stanceRad + spinRad` (amended in §7.1 so the board never stays fixed at yaw 0 when the rider spins or rides switch).
- **Landing squash:**
  - Brief vertical squash-and-stretch (`riderGroup.scale.y`) on clean touchdown (`0.15 s` window, same as today).
- **Board & bindings coupled to rider feet:**
  - The procedural `boardMesh` (neon cyan) and bindings (`frontBinding`, `backBinding`) are coupled to the rider's yaw (`stanceRad + spinRad`), roll, and airborne foot tuck height (see §7.1) while keeping `this.boardMesh` publicly accessible on `SnowboardCharacter`.

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

If the `.glb` fails to load (network/build error, missing file), `SnowboardCharacter` falls back to the procedural low-poly rider (`buildProceduralRider()`) so the game never crashes. This is a **developer-only** safeguard (also active synchronously in unit tests prior to async GLB resolution); the committed `.glb` must always be present in production builds.

### 7. Amendment (PR #7 Owner Playtest Review, 2026-10-25): Board Coupling, Sideways Athletic Bind Pose & 12-Bone Foot-Anchored Kinematics

Owner playtesting of the initial PR #7 build identified three critical biomechanics and hierarchy defects that must be corrected:

#### 7.1 Board & Bindings Coupled to Rider Spin/Stance + Foot Anchor (`src/player/SnowboardCharacter.ts`)

1. **No Uncoupled Board Yaw:** `boardMesh`, `frontBinding`, and `backBinding` MUST NOT remain fixed at yaw `0` directly on `this.group` while `riderGroup` rotates by `stanceRad + spinRad`.
2. **Coupled Hierarchy / Lockstep Transform:** Parent `boardMesh`, `frontBinding`, and `backBinding` under a dedicated `boardGroup` (or inside `riderGroup`, or synchronize `boardMesh` + bindings yaw/roll/position in lockstep with `riderGroup`) so that:
   - Whenever `riderGroup.rotation.y` rotates by `stanceRad + spinRad` (both during airborne spin tricks and during grounded switch-stance shortest-path ease), the snowboard (`boardMesh`) and both bindings (`frontBinding`, `backBinding`) rotate identically in lockstep with the rider's feet.
   - Public properties `this.group` (`public readonly group: THREE.Group`), `this.boardMesh` (`public readonly boardMesh: THREE.Mesh`), and `this.riderGroup` (`public readonly riderGroup: THREE.Group`) MUST remain publicly accessible with 100% backward compatibility.
3. **Airborne Tuck & Grab Board Elevation/Tilt:** During airborne grabs (`activeGrab === 'A' | 'B'`) or jump crouch/tuck, the board (`boardGroup` / `boardMesh` + bindings) rises and tilts with the tucked feet so the rider's boots never detach from the bindings or clip through the underside of the board.

#### 7.2 Authentic Sideways Athletic Snowboarder Bind Pose (`scripts/generate-character.ts` & `public/assets/character/rider.glb`)

A real snowboarder stands **sideways** across the board (regular stance: left foot at back binding `z = -0.35`, right foot at front binding `z = +0.35`, toes pointing toward `+X` toe edge, heels toward `-X` heel edge) with bent knees, lowered hips, athletic forward torso hinge, bent elbows, and head turned toward downhill (`+Z`).

The 12-bone skeleton and mesh geometry in `scripts/generate-character.ts` MUST be constructed so that in the bind pose (`public/assets/character/rider.glb`):

1. **Pelvis / Hips (`Hips`):**
   - Positioned at `y ≈ 0.56` (athletic lowered center of gravity, NOT `0.72` straight-legged).
   - Rotated sideways across the board (`yaw ≈ 1.30–1.40 rad` / `~75°–80°` around Y so the rider's front faces toward the toe edge `+X` and slightly downhill `+Z`).
2. **Knees & Legs (`LeftUpLeg`, `LeftLeg`, `RightUpLeg`, `RightLeg`):**
   - Upper legs (`LeftUpLeg` back thigh, `RightUpLeg` front thigh) originate at the hip sockets and angle outward along the board toward `z ≈ ±0.32` AND forward toward the toe edge (`+X`, `x ≈ +0.10 to +0.14`) down to bent knee joints at `y ≈ 0.30–0.33`.
   - Lower legs (`LeftLeg` back shin/boot, `RightLeg` front shin/boot) bend back from the flexed knees (`knee flexion angle ≈ 0.55–0.70 rad` / `~32°–40°` visible 3D bend) down to boots planted firmly on the bindings at `(x ≈ 0, y ≈ 0.04–0.09, z = -0.35)` and `(x ≈ 0, y ≈ 0.04–0.09, z = +0.35)`.
   - Include knee/joint overlap spheres or clean tapered alignment so knees and elbows look seamless when bent.
3. **Back / Torso (`Spine`, `Chest`):**
   - Visibly flexed athletic posture: forward hinge over the toe edge (`+X`) of `~0.22–0.30 rad` (`~13°–17°`) plus slight downhill shoulder tilt, NOT a vertical pole.
4. **Head & Goggles (`Head`, `beanie_mesh`, `goggles_mesh`):**
   - `Head` counter-rotated on Y relative to `Chest` so the rider looks downhill toward `+Z` (over the front right shoulder), with `goggles_mesh` wrapping the front of the face (`+Z` direction) and `beanie_mesh` crowning the head (`maxY >= 1.42`).
5. **Arms & Elbows (`LeftUpperArm`, `LeftLowerArm`, `RightUpperArm`, `RightLowerArm`):**
   - `LeftUpperArm` (back arm) extends out over the tail (`-Z`, slightly `-X`/`+Y`), and `LeftLowerArm` bends at the elbow (`~0.65–0.85 rad` / `~37°–48°` elbow flex) forward/up for active balance.
   - `RightUpperArm` (front arm) extends out over the nose (`+Z`, slightly `+X`/`+Y`), and `RightLowerArm` bends at the elbow (`~0.65–0.85 rad` flex) inward/up with gloved hands (`boots` or contrasting glove material at the hand tip).

#### 7.3 Full 12-Bone Procedural Animation & Foot-Anchored Kinematics (`src/player/SnowboardCharacter.ts`)

1. **Complete 12-Bone Mapping:**
   - Map and drive all 12 canonical bones: `Hips`, `Spine`, `Chest`, `Head`, `RightLeg` (`RightUpLeg`), `RightLowerLeg` (`RightLeg`), `LeftLeg` (`LeftUpLeg`), `LeftLowerLeg` (`LeftLeg`), `RightArm` (`RightUpperArm`), `RightLowerArm`, `LeftArm` (`LeftUpperArm`), `LeftLowerArm`.
2. **Procedural Fallback Parity (`buildProceduralRider()`):**
   - Update `buildProceduralRider()` so its fallback meshes (`torso`, `hips`, `frontLeg`, `backLeg`, `frontArm`, `backArm`, plus knee/shin/elbow geometry) match the sideways bent-knee snowboarder silhouette, keep boots anchored at `z = ±0.35` above the bindings, and satisfy all unit test contracts.
3. **Crouch (`jumpCharge` 0→1) & Carve (`carveIntensity`, `rollRad`):**
   - Lower `Hips.position.y` by `jumpCharge * 0.15` (plus carve crouch).
   - Simultaneously flex upper legs (`RightLeg`/`LeftLeg` → `RightUpLeg`/`LeftUpLeg`) AND counter-flex lower legs (`RightLowerLeg`/`LeftLowerLeg` → `RightLeg`/`LeftLeg` knee joints) so the ankles/boots remain planted on the board bindings (`y` within `±0.05` of binding height) instead of sinking through the board.
   - Bend `Spine` (`+0.30 * jumpCharge`) and `Chest` (`+0.20 * jumpCharge`) into a deep athletic coil while counter-tilting `Head` so the rider keeps looking downhill.
4. **Airborne & Grab A / Grab B Poses (`activeGrab === 'A' | 'B'`):**
   - In mid-air, tuck legs and pull the board (`boardGroup` / `boardMesh` + bindings) up toward the rider's crouched hips so boots stay locked in the bindings.
   - **Grab A (Indy / Method, `activeGrab === 'A'`):** Bend `Spine`/`Chest` down toward the board, rotate `RightArm` (`RightUpperArm`) + `RightLowerArm` downward and inward toward the front/toe edge of the board, and tweak board/leg tilt for a stylish Indy/Method tweak.
   - **Grab B (Melon / Tail, `activeGrab === 'B'`):** Bend `Spine`/`Chest` toward the tail, rotate `LeftArm` (`LeftUpperArm`) + `LeftLowerArm` downward and backward to grab the heel/tail edge of the board.

## Consequences

- **Positive:** Authentic sideways snowboarder silhouette with real 3D knee flex, forward torso hinge, elbow bend, and downhill head orientation in both the rigged `.glb` and procedural fallback.
- **Positive:** Board and bindings stay locked to the rider's feet during spins, switch-stance transitions, crouch wind-ups, and airborne grabs — eliminating uncoupled foot-off-board artifacts and boot-through-board clipping.
- **Positive:** The public API (`group`, `boardMesh`, `riderGroup`, `update()`, `reset()`) is unchanged; integration into `GameApp`, `PhysicsEngine`, `FollowCamera`, and `JungleAudioEngine` remains zero-touch.
- **Risk:** Bone naming mismatches between model sources. The bone lookup map must be tolerant of common aliases (`mixamorig:Hips` vs `Hips` vs `hip`) without colliding parent and child bones (`RightUpLeg` vs `RightLeg`).
- **Risk:** `.glb` file size. The committed asset must be under ~200 KB to preserve fast browser load.
- **Compliance:** If CC-BY, attribution must be added to the main-menu credits (existing `attribution?: string[]` field in `GameConfig` / `OGSnowGlobalState` is sufficient).

## Compliance Rules

1. The committed `public/assets/character/` directory must contain `rider.glb` (< 2,000 triangles, < 200 KB) and an `ATTRIBUTION.md` if the license requires attribution.
2. `SnowboardCharacter` must expose the same public API (`group`, `boardMesh`, `riderGroup`, `update(state, dt)`, `reset()`); no changes to `GameApp.ts`, `PhysicsEngine.ts`, `FollowCamera.ts`, or `HUDManager.ts`.
3. All unit tests (`character.test.ts`, `physics.test.ts`) and E2E tests (`gameplay.spec.ts`) must pass with zero console or page errors.
4. The model must be loaded and all 12 bones mapped without alias collisions; prior to async completion or if loading fails, the procedural fallback must remain active seamlessly.
5. `npm run build` must succeed and the new asset must be included in the `dist/` output.
6. **Lockstep Board-Rider Yaw & Stance Coupling (PR #7 Amendment):** `boardMesh`, `frontBinding`, and `backBinding` MUST rotate in lockstep with `riderGroup.rotation.y` across all airborne spins (`stanceRad + spinRad`) and grounded switch-stance transitions (`stanceRad`).
7. **Foot-Anchored Kinematics (PR #7 Amendment):** World/group-space boot/ankle positions MUST remain anchored at the board bindings (`z ≈ ±0.35`, `y` within `±0.05` of binding top surface) across neutral riding, full crouch (`jumpCharge = 1.0`), and airborne grabs (`activeGrab = 'A' | 'B'`) — boots MUST NOT sink through the board or detach from bindings.
8. **Sideways Bent-Knee Athletic Bind Pose (PR #7 Amendment):** `rider.glb` (generated deterministically by `scripts/generate-character.ts`) MUST position `Hips` at `y ≈ 0.56` rotated sideways (`yaw ≈ 1.30–1.40 rad`), with 3D knee flex (`knee bend angle >= 0.45 rad`, knee joint offset `>= 0.08 m` toward `+X` from the hip-to-ankle line at `y ≈ 0.30–0.33`), forward torso hinge (`~0.22–0.30 rad`), bent elbows (`~0.65–0.85 rad`), downhill-facing `Head`/goggles (`+Z`), and overall height `minY >= 0.0`, `maxY >= 1.42`.
9. **Full 12-Bone Articulation (PR #7 Amendment):** `SnowboardCharacter.update()` MUST articulate all 12 bones (`Hips`, `Spine`, `Chest`, `Head`, `RightLeg`, `RightLowerLeg`, `LeftLeg`, `LeftLowerLeg`, `RightArm`, `RightLowerArm`, `LeftArm`, `LeftLowerArm`) during crouch, carve, air tuck, Grab A, and Grab B.
10. **Procedural Fallback Silhouette Parity (PR #7 Amendment):** `buildProceduralRider()` MUST mirror the sideways bent-knee snowboarder posture and preserve all unit-test contracts on `torso`, `hips`, `frontLeg`, `backLeg`, `frontArm`, and `backArm`.
