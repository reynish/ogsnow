# Product Description: ogSnow (Working Title)

## 1. Executive Summary

ogSnow is a browser-based 3D snowboarding game that bridges the gap between digital gaming and real-world exploration. By utilizing real topographical data and 3D maps of actual ski resorts, players can drop in and snowboard down their favorite real-world mountains directly from their web browser—no downloads or heavy installations required. 

The game combines the accessibility of web gaming with the thrill of extreme sports, delivering an authentic, real-mountain snowboarding experience directly in the browser.

> **Core fidelity principle:** the playable terrain MUST be a genuine import of a real-world location from **open map data** (open DEM elevation tiles / open geospatial data). Procedurally invented or "inspired-by" heightfields are explicitly out of scope. See **Section 6 — Real-World Terrain Import (Open Map Data Pipeline)** for the exact sources, pipeline, and acceptance criteria.

---

## 2. Target Audience

\*   **Winter Sports Enthusiasts:** Snowboarders and skiers who want to explore real resorts before visiting, or re-live past trips off-season.

\*   **Casual Gamers:** Players looking for an accessible, low-barrier-to-entry sports game they can play instantly in their browser.

\*   **Geography/Map Nerds:** Users fascinated by 3D topological data and real-world map explorations (similar to the appeal of Google Earth VR or Microsoft Flight Simulator).

\*   **Retro Gaming Fans:** Players drawn to nostalgic, PS1-era low-poly aesthetics and high-energy electronic soundtracks.

---

## 3. Core Gameplay &amp; User Experience (UX)

\*   **The Drop-In:** The user selects a mountain from the main menu, chooses a drop zone, and spawns into the 3D world.

\*   **The Ride:** The core loop involves carving down the mountain, managing speed, navigating natural terrain obstacles (trees, rocks, cliffs), and finding the best lines.

\*   **The Vibe:** Relaxing but exhilarating. Breathtaking real-world vistas paired with a highly responsive, pulse-pounding audio experience.

---

## 4. Audio &amp; Adaptive Sound Design

*A defining feature of the game will be its highly reactive, nostalgia-driven soundscape that ties directly into the player's momentum.*

\*   **Adaptive Music System:** The game will feature a real-time, procedurally mixed soundtrack that adapts to the player's current state. As the player's speed increases, the music dynamically adds layers (e.g., bringing in heavy basslines or faster drum loops). If the player crashes or slows down, the music fades back into atmospheric, ambient pads.

\*   **Musical Style (PS1 Jungle/Breakbeat):** The soundtrack will heavily draw from the 90s PS1 era of extreme sports games (reminiscent of *Cool Boarders* or *SSX*). It will feature high-BPM jungle beats, classic amen breaks, and atmospheric drum and bass to perfectly match the low-poly visual aesthetic and the adrenaline of carving down a mountain.

\*   **Dynamic SFX:** 

    \*   **Wind Resistance:** Procedural wind audio that scales in pitch and volume based on the character's velocity.

    \*   **Snow Interaction:** The sound of the snowboard carving will change dynamically based on speed and the angle of the turn, giving physical feedback to the player's inputs.

---

## 5. Core Features

*This target iteration delivers the core snowboarding mechanics, real-world map import pipeline, and adaptive audio systems.*

\*   **Single Flagship Mountain (real-world import):** One highly polished, accurate 3D map of a well-known real-world ski run — **Whistler Mountain, British Columbia, Canada** — built from actual open DEM elevation tiles of that location, not a synthetic approximation. See Section 6.

\*   **Standardized Map Formatting:** The terrain is imported using an easily repeatable, config-driven standard: real-world DEM/heightmap tiles from open map providers are decoded, re-projected into game space, and exported as `.glTF`/`.glb` with a sidecar metadata file recording provenance. This ensures future real-world mountains can be added quickly (Section 6.6).

\*   **Basic 3D Character:** A simple, low-poly 3D character model strapped to a snowboard.

\*   **Core Physics &amp; Controls:** 

    \*   Gravity and momentum based on the actual slope angles of the 3D map.

    \*   Basic collision detection (terrain and boundaries).

    \*   Simple keyboard/controller inputs for steering (left/right) and speed control (carving to slow down).

\*   **Dynamic Camera:** A third-person follow camera that adjusts based on speed and slope pitch.

\*   **Adaptive Audio:** Speed-linked drum and bass music system paired with dynamic wind and snow-carving sound effects.

---

## 6. Real-World Terrain Import (Open Map Data Pipeline)

This iteration replaces the previous synthetic heightfield with a **genuine import of a real-world location from open map data**. Every terrain vertex elevation must trace back to a recorded, openly licensed DEM source tile. No playable elevation may be procedural.

### 6.1 Flagship Location & Framing

\*   **Location:** Whistler Mountain summit area, British Columbia, Canada (origin approx. `50.0596° N, 122.9570° W`).

\*   **Playable extent:** approx. `1,600 m` across-slope x `3,200 m` down-slope, sampled from open DEM tiles at zoom `13–14` (`6.1–12.3 m/px` at this latitude). The committed Whistler build uses zoom `13` at a `12.5 m` grid spacing (z13 is already finer than the grid); the chosen zoom, tile set, and checksums are recorded in the artifact metadata (`whistler-terrain.json`).

\*   **Orientation:** the real fall line is rotated so downhill runs along world **`+Z`** and lateral spread along `X`, preserving the existing coordinate convention (ADR-0006) so physics/camera/audio contracts are unchanged.

### 6.2 Open Data Sources (free, no API key)

\*   **Primary elevation — AWS Open Data "Terrarium" Terrain Tiles:** 8-bit RGB-encoded PNG elevation tiles (`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`), derived from open SRTM/NED/etc. globally, public and keyless. Decode: `elevation = R*256 + G + B/256 - 32768`.

\*   **Cross-check / fallback elevation — Copernicus DEM GLO-30** (AWS Open Data, keyless, 30 m) to validate the macro elevation profile and to fall back to if Terrarium is unavailable.

\*   **Optional feature overlay — OpenStreetMap** (`piste:type=downhill` runs, `landuse=forest`/`natural=tree`, lifts) via Overpass API or Geofabrik extracts, © OpenStreetMap contributors (ODbL), used to place ski runs, tree glades, and obstacles when reachable.

### 6.3 Build-Time Fetch Pipeline (network, run on demand)

`scripts/fetch-terrain.ts` (new, `npm run fetch-terrain`):

1. Resolve the pinned Terrarium tile set for the configured mountainous region and zoom; cache raw tiles under `.cache/terrain/` (gitignored).
2. Decode RGB PNG pixels into real elevations.
3. Re-project EPSG:3857 (Web Mercator) pixels into a local metric ENU frame anchored at the configured origin, rotated so the fall line is `+Z`.
4. Resample onto the DEM grid and write the **committed source-of-truth artifacts**:
   \*   `public/assets/terrain/whistler-dem.bin` — raw `Float32` elevation grid (row-major, `(segmentsZ+1) x (segmentsX+1)`).
   \*   `public/assets/terrain/whistler-terrain.json` — origin lat/lon, EPSG:3857 tile URLs + `z/x/y`, zoom, per-tile checksums, grid dimensions, real `min/maxElevation`, and license/attribution strings.

### 6.4 Offline Deterministic Derivation (CI-safe)

`scripts/generate-glb.ts` (no network) reads the committed `.bin` + metadata JSON, then:

1. Derives **drop zones** from the real terrain (steepest sustained fall lines with sane spacing and safe spawn clearance).
2. Derives **obstacles** (trees / rocks / cliffs) from real elevation, slope, curvature, and tree-line height (optionally refined by OSM features).
3. Builds the low-poly, flat-shaded, vertex-colored mesh and exports `public/assets/whistler-peak.glb`.

Running the derivation twice MUST produce a byte-identical `.glb` (enables the existing CI `git diff --exit-code` determinism gate).

### 6.5 Runtime Guarantees

\*   The browser loads **only** the committed `.glb` + metadata; **zero network requests at runtime**.

\*   Real-world `altitudeMeters` come from the imported DEM so the HUD shows true elevations (Whistler summit ≈ `2,182 m`).

\*   **Attribution is user-visible** in the main menu (e.g., *"Elevation: AWS Open Data Terrain Tiles · Map data © OpenStreetMap contributors"*) and in a terrain provenance/info panel.

### 6.6 Repeatability (Adding a New Mountain)

A mountain registry entry (`id`, `name`, `region`, origin lat/lon, bounding box, zoom, license) is the only input required. Running `npm run fetch-terrain -- --mountain <id>` followed by `npm run generate-glb` yields a new `.glb` + metadata with **no code changes**.

### 6.7 Acceptance Criteria (Definition of Done)

1. Terrain grid elevations match independently decoded DEM tile elevations at N sample points within tolerance.
2. `min/maxElevation` reflect the real imported tile range (committed Whistler build: `1,395.36 m`–`2,177.14 m`) rather than synthetic clamps, and `altitudeMeters` in `window.__OGSNOW_STATE__` is real-world.
3. `npm run build`, `npm test`, and `npm run test:e2e` perform **zero network requests** and still pass with existing coverage (physics, audio, camera, UI, E2E).
4. `npm run generate-glb` is byte-deterministic (clean `git diff`).
5. Data-source attribution is visible in the main menu.
6. Coordinate conventions (downhill `+Z`, ADR-0006) and all data contracts in `wiki/interfaces.md` remain unchanged, or are updated in `wiki/` + ADRs alongside the change.

---

## 7. Technical Specifications &amp; Architecture

\*   **Platform:** Web Browser (Desktop optimized).

\*   **Engine:** Three.js, Babylon.js, or Unity WebGL. (Three.js or Babylon.js are highly recommended for optimal browser performance and fast load times).

\*   **Audio Engine:** Web Audio API, utilizing libraries like Tone.js or Howler.js to manage the dynamic mixing, stem fading, and real-time generation of the breakbeat tracks based on game variables (speed, airtime).

\*   **Map Data Sourcing:** open-source GIS data only (no proprietary/paid APIs, no API keys), per Section 6: real DEM elevation tiles from AWS Open Data (Terrarium / Copernicus GLO-30) and optional OpenStreetMap feature overlays, converted into playable `.glb` mesh data.

\*   **Physics Engine:** Cannon.js or Ammo.js to handle the complex physics of a board sliding on uneven, sloped terrain.

\*   **Asset Format:** `.glTF` / `.glb` for all 3D models (terrain, character, snowboard) to ensure rapid loading over standard internet connections.

---

## 8. Iteration 3 — Charge Jump, Crouch & Tricks (`feat/charge-jump-tricks`)

This iteration replaces the single-button instantaneous jump with a **charge-and-release (wind-up) jump**, gives the rider distinct **crouch and aerial poses**, and adds **spins and grabs** with a risk/reward crash-on-bad-landing mechanic. It builds on Section 5 (Core Physics & Controls) and supersedes the jump/steering behaviour described in ADR-0003 where they conflict.

### 8.1 Charge-and-Release Jump (hold `Space`)

*   **Wind-up:** Holding `Space` (or gamepad `A`) while grounded enters a **crouch/charge state**. The rider visibly compresses (knees bend, hips drop, torso leans forward, board flexes).
*   **Charge curve:** `jumpCharge` ramps from `0.0` to `1.0` over a configurable `jumpChargeMaxSeconds` (≈ `0.5 s`). Holding beyond full charge caps at `1.0` and does not consume anything further.
*   **Release to pop:** Releasing `Space` launches the rider with a vertical impulse interpolated **linearly** between `jumpMinImpulse` (quick tap) and `jumpMaxImpulse` (full charge). A tap before any charge still produces a minimal hop — input is never dead.
*   **No re-trigger:** Jumping is only possible while grounded; holding `Space` in the air never re-triggers a jump. Each charge requires a fresh key-down.
*   **Crouch steering penalty:** While crouched/winding up, the effective steering rate and carve authority are reduced (≈ `0.4×` of the normal standing rate) so the rider cannot carve as hard while compressed. Steering authority is restored on release/stand.

### 8.2 Realistic Air Time & Air Control

*   **Gravity retune:** World gravity is lowered (from the arcade `22 m/s²` toward ≈ `14 m/s²`) with impulses retuned so a full-charge jump produces a floaty, semi-realistic air time of roughly **1.8–2.2 s**.
*   **Air control:** While airborne there is **no heading steering** — the travel heading is frozen at its takeoff value (which equals the direction of travel), and `A`/`D` perform trick spins only. The camera stays fixed behind the direction of travel until touchdown; steering authority returns on landing. Slope acceleration is disabled, and the existing quadratic air drag is retained.
*   **Landing:** Touchdown is detected against the terrain surface (as today) and additionally evaluated against the rider's rotational alignment (Section 8.4).

### 8.3 Trick Controls (airborne)

*   `A` / `D` (or `←` / `→`) — **spin** (frontside/backside yaw). Spin rate scales with speed.
*   `W` (or `↑`) — **grab A** (indy / method).
*   `S` (or `↓`) — **grab B** (melon / tail).
*   Ground meanings are preserved: on the snow, `A`/`D` steer, `W` tucks, `S` carves; the airborne meanings above apply only while `isGrounded === false`.
*   The physics **travel heading** remains the direction of motion and is frozen at its takeoff value while airborne — spin input (`A`/`D`) rotates neither the board's travel heading nor the camera; the **visual spin** is rendered on the character independently of heading.

### 8.4 Trick Landing Rule (risk/reward)

*   On touchdown the accumulated `spinRad` is compared to the nearest multiple of `π` (`180°`) within a tolerance (≈ `±60°`).
*   **Clean landing:** Rotation is aligned (or the rider is not spinning/grabbing) → rider continues riding normally.
*   **Wipeout:** If the rider touches down **mid-rotation** (not near a `180°`/`360°` multiple) **or is still holding a grab**, the rider **crashes** (`isCrashed`, using the existing crash-recovery flow and arrest friction). Landing out of a trick is therefore a genuine risk.

### 8.5 Character Model Response

*   **Crouch/charge pose:** interpolated from `jumpCharge` — compressed legs, dropped hips, forward-leaning torso, board flex.
*   **Air/trick poses:** the character group visually rotates with `spinRad`, and the corresponding arm reaches to the board edge while a grab is held.
*   **Landing squash:** a brief compression on clean touchdown; the existing wipeout tumble is retained for crashes.

### 8.6 Out of Scope (this iteration)

*   No trick **scoring / combo / points** system and no new HUD score display. Tricks are expressed visually and through the crash-on-bad-landing mechanic only.
*   No new mountains or terrain-pipeline changes.

### 8.7 Acceptance Criteria (Definition of Done)

1. Holding `Space` while grounded enters a crouch/charge state with `jumpCharge` ramping to `1.0` over `jumpChargeMaxSeconds`; releasing launches with an impulse monotonic in charge.
2. A tap (`Space` down then up immediately) produces a minimal hop and never a full-power jump; a full charge produces the configured maximum impulse and the longest air time.
3. Effective steer rate while `jumpCharge > 0` is measurably lower than while standing (≈ `0.4×`), per ADR-0008.
4. Full-charge air time falls within the configured realistic band (≈ `1.8–2.2 s`) under the retuned gravity.
5. Spins (A/D) accumulate `spinRad` while airborne and rotate the character visually; grabs (W/S) set an active grab pose.
6. Landing mid-rotation or while grabbing sets `isCrashed = true` and recovers via the existing `crashRecoverySeconds`; landing aligned (or not tricking) does not crash.
7. `npm run build`, `npm test`, and `npm run test:e2e` pass with zero runtime/console errors; existing camera/audio/terrain contracts remain intact.
8. `wiki/interfaces.md`, `wiki/architecture.md`, and a new ADR-0008 document the new input/state fields and control rules; ADR-0003 is superseded where it conflicts.