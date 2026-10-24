# ADR-0008: Charge Jump, Crouch & Tricks (Hold-to-Wind / Risk-Reward Landing)

- **Status:** Accepted
- **Date:** 2026-10-20
- **Amended:** 2026-10-24 (PR-4 owner review comment, reynish) — while airborne the camera must stay fixed behind the rider's direction of travel. `headingRad` is therefore **frozen** at its takeoff value while airborne (`A`/`D` drives `spinRad` only, no air steering), and the `airSteerRateMultiplier` config field has been **removed**. See Context item 4 and §4.
- **Iteration:** `feat/charge-jump-tricks`
- **Supersedes:** ADR-0003 §"Decision.1" (jump impulse + edge-trigger semantics), §"Decision.1" (single-value `gravity` of `22 m/s²`), §"Decision.1" (grounded steering without crouch penalty), §"Decision.1" (airborne behavior without air control/tricks); and ADR-0006 §4 "Rising-Edge Jump Detection (M2)" (`input.jump` + `wasJumpPressed`), which is replaced by the `jumpHeld` charge/release contract below. ADR-0003's coordinate conventions, carve drag, crash threshold/recovery, and obstacle collision rules remain **in force**. (ADR-0006 line 81 retains the historical guardrail text for context; `PlayerInput.jump` is no longer an active field anywhere.)
- **Superseded-by:** — (active)

## Context

Iteration 1–2 shipped an instantaneous edge-triggered `jump` (fixed impulse `7.5 m/s`) with arcade-fast gravity (`22 m/s²`) producing brief ~`0.7 s` hops. README §8 (Iteration 3) specifies:

1. A **charge-and-release jump** (hold-to-wind, release-to-pop) where `Space` (gamepad `A`) held while grounded enters a visible **crouch/charge state** that accumulates `jumpCharge` (`0.0` to `1.0`) over `~0.5 s` and launches with an impulse interpolated **linearly** between a minimal tap (`jumpMinImpulse`) and a full charge (`jumpMaxImpulse`).
2. A **crouch steering penalty**: while winding up (`jumpCharge > 0`), effective steering and carve authority drop to `~0.4×` normal so the rider cannot carve aggressively while compressed.
3. **Realistic gravity retune** (lowering from `22 m/s²` toward `~14 m/s²`) with retuned impulses so a full-charge jump yields a floaty, semi-realistic air time of roughly **`1.8–2.2 s`** (evoking *SSX 3* / *Amped* float feel while preserving arcade responsiveness).
4. **Air control**: while airborne, the travel heading (`headingRad`) is **frozen** at its takeoff value (which equals the direction of travel), `A`/`D` drive trick spins (`spinRad`) only, and the camera stays fixed behind the direction of travel until touchdown; slope acceleration is disabled, and existing quadratic air drag is retained. Steering authority returns on landing.
5. **Spins and grabs**: while airborne, `A/D` (or `←/→`) spin the character yaw (`spinRad` accumulates independent of the physics travel heading), `W` (or `↑`) triggers **grab A** (indy/method), `S` (or `↓`) triggers **grab B** (melon/tail). Ground meanings of `A/D` (steer), `W` (tuck), `S` (carve) are preserved on the snow.
6. **Trick landing rule (risk/reward)**: on touchdown, if the rider is **mid-rotation** (not aligned to a `±60°` tolerance around a `180°`/`360°` multiple) **or is still holding a grab**, `isCrashed` is set and the existing crash-recovery flow applies (arrest friction + `crashRecoverySeconds` timer). Clean landings (aligned rotation, no active grab) continue riding normally.

Verified reconnaissance: existing `jumpImpulse: 7.5` under `gravity: 22` yields `t_air ≈ 2*7.5/22 ≈ 0.68 s`; target `1.8–2.2 s` at realistic `g ≈ 14` requires `jumpMaxImpulse ≈ 12.6–15.4 m/s` (mid-estimate `≈ 14 m/s`). A minimal tap `jumpMinImpulse ≈ 4.5 m/s` produces `~0.65 s` hang time (preserving quick hop feel). Charge curve ramps linearly over `jumpChargeMaxSeconds ≈ 0.5 s` (30 frames at 60 Hz).

## Decision

### 1. Charge-and-Release Jump Input Contract (replaces ADR-0003 §1 edge-trigger)

**`PlayerInput` final shape** (in `src/types.ts`) — the legacy `jump` field is **REMOVED**; `jumpHeld` is the single continuous hold signal:
```typescript
export interface PlayerInput {
  steer: number;         // -1.0 (left) to +1.0 (right)
  carve: number;         // 0.0 (none) to 1.0 (hard braking/carving)
  tuck: boolean;         // true when leaning forward for speed (W / ArrowUp); mid-air = grab A
  jumpHeld: boolean;     // single continuous hold signal: true while Space (or gamepad A) is held
  reset: boolean;        // true when reset to drop-zone requested (R)
}
```

`PhysicsEngine` MUST consume `jumpHeld` exclusively; there is no legacy rising-edge `jump` field.

- **Charge initiation:** When `input.jumpHeld === true` and the player is grounded (`isGrounded === true`, `!isCrashed`), `PhysicsEngine` increments `state.jumpCharge` at a rate `dt / config.jumpChargeMaxSeconds` (clamped `[0, 1]`).
- **Crouch pose:** `SnowboardCharacter.update()` interpolates a visible crouch compression (knees bend, hips drop, torso leans forward) from `state.jumpCharge`.
- **Crouch steering penalty:** While `state.jumpCharge > 0`, effective steering and carve rates scale by `config.crouchSteerRateMultiplier` (≈ `0.4`).
- **Release to pop:** When `input.jumpHeld` transitions from `true` to `false` (key releases) and `state.jumpCharge > 0`, the rider launches with vertical impulse:
  ```
  impulse = jumpMinImpulse + jumpCharge * (jumpMaxImpulse - jumpMinImpulse)
  ```
  `state.jumpCharge` is zeroed, `isGrounded` becomes `false`, and air time begins.
- **No re-trigger:** While airborne (`!isGrounded`), holding or re-pressing `jumpHeld` has no effect; each new jump requires a fresh key-down after landing.
- **Tap still works:** A very brief tap (release before significant charge accumulates, e.g., `jumpCharge < 0.05`) produces near-`jumpMinImpulse` and does not block the rider from hopping — input never feels dead.

### 2. Gravity Retune & Retuned Impulses

**`GameConfig` changes** (in `src/config.ts`):
- Old: `gravity: 22.0`, `jumpImpulse: 7.5`
- New:
  ```typescript
  gravity: 14.0,
  jumpChargeMaxSeconds: 0.5,
  jumpMinImpulse: 4.5,
  jumpMaxImpulse: 14.0,
  crouchSteerRateMultiplier: 0.4,
  ```

**Air-time calculation** (for reference):
- Minimal tap (`jumpMinImpulse = 4.5`): `t_air ≈ 2 * 4.5 / 14 ≈ 0.64 s`
- Full charge (`jumpMaxImpulse = 14.0`): `t_air ≈ 2 * 14 / 14 = 2.0 s` (target floaty range `1.8–2.2 s` met)

### 3. PlayerState Trick Fields

**`PlayerState` additions** (in `src/types.ts`):
```typescript
export interface PlayerState {
  // ... existing fields unchanged ...
  jumpCharge: number;          // 0.0 to 1.0 (accumulates while jumpHeld + grounded)
  spinRad: number;             // accumulated spin yaw angle in radians (independent of headingRad)
  activeGrab: 'none' | 'A' | 'B'; // 'A' = indy/method (W), 'B' = melon/tail (S)
}
```

- `jumpCharge`: reset to `0` on release/launch or crash; increments while `jumpHeld && isGrounded && !isCrashed`.
- `spinRad`: accumulates while airborne from `input.steer` (unchanged on ground); resets to `0` on touchdown.
- `activeGrab`: set to `'A'` when `input.tuck && !isGrounded`, `'B'` when `input.carve && !isGrounded`, `'none'` on touchdown or when the corresponding key is released mid-air.

### 4. Airborne Input Interpretation (tricks)

While `isGrounded === false`:
- `input.steer` (A/D or ←/→): **spin** frontside/backside (`spinRad += input.steer * config.spinRateRadPerSec * dt`; typical `spinRateRadPerSec ≈ 3.0` allows 1 full rotation in ~2 s).
- `input.tuck` (`W` / `↑`): **grab A** (`activeGrab = 'A'` while held, releases to `'none'` on key-up).
- `input.carve` (`S` / `↓`): **grab B** (`activeGrab = 'B'` while held, releases to `'none'` on key-up).
- **Physics steering**: the travel heading (`headingRad`) is **frozen** at its takeoff value while airborne — there is no airborne heading steering (`airSteerRateMultiplier` was removed in the 2026-10-24 amendment), so `A`/`D` affects `spinRad` only and the camera stays locked behind the direction of travel until touchdown. The visual spin (`spinRad`) is rendered on the character and is independent of the travel direction.

On ground (`isGrounded === true`):
- Existing meanings preserved: `input.steer` → steering, `input.tuck` → tuck/aerodynamic boost, `input.carve` → carving/braking. `spinRad` and `activeGrab` are reset/ignored.

### 5. Trick Landing Rule (Risk/Reward Crash)

On touchdown (`isGrounded` transition from `false` to `true`), `PhysicsEngine.step()` evaluates:
```typescript
const landAlignmentToleranceRad = Math.PI / 3; // 60 degrees
const nearestHalf = Math.round(spinRad / Math.PI) * Math.PI;
const alignmentError = Math.abs(spinRad - nearestHalf);

if (alignmentError > landAlignmentToleranceRad || activeGrab !== 'none') {
  // Bail / wipeout
  isCrashed = true;
  crashTimerSeconds = crashRecoverySeconds;
  velocity *= 0.15; // aggressive speed reduction
} else {
  // Clean landing
  // Continue riding normally; zero spinRad and activeGrab
}
```

- **Clean landing**: rider not spinning/grabbing, or rotation is aligned within `±60°` of a `180°`/`360°` multiple → no crash.
- **Wipeout**: mid-rotation outside tolerance **or** still holding a grab → `isCrashed = true`, existing crash-recovery applies.

### 6. Character Model Response (`SnowboardCharacter`)

**New pose states:**
- **Crouch/wind-up (`jumpCharge > 0`):** Interpolate rider group downward (`hips.position.y` drops, knees compress, torso leans forward); board may flex slightly (visual only).
- **Air spin (`spinRad`):** Apply `riderGroup.rotation.y = spinRad` so the character visually yaws independently of the board heading.
- **Grab poses:** When `activeGrab === 'A'`, extend forward arm toward the board nose (indy/method); when `activeGrab === 'B'`, reach back arm to tail (melon). Release returns to neutral air pose.
- **Landing squash:** On clean touchdown, briefly compress the character group (quick `scale.y` squash-and-stretch) for tactile feedback; existing wipeout tumble retained for crashes.

## Consequences

- **Positive:**
  - Charge-and-release jump gives intentional wind-up/pre-load feel reminiscent of *SSX 3*'s "preload" mechanic.
  - Floaty realistic air time (1.8–2.2 s at full charge) enables complex mid-air trick combos without feeling arcade-instant.
  - Risk/reward landing rule incentivizes skill: landing clean tricks feels rewarding; bailing mid-rotation punishes sloppy execution.
  - Existing coordinate conventions (downhill `+Z`, `steer=+1` → `-X` screen-right) and crash/obstacle/boundary contracts (ADR-0003/0006) are preserved; only jump/air/trick behavior changes.
- **Negative:**
  - Retuning `gravity` from `22` to `14` will change all ground physics slightly (less aggressive downhill acceleration on shallow slopes); the slope friction and carve drag coefficients may need minor rebalancing to preserve the existing 3-second downhill `>20 km/h` guarantee (acceptance criterion).
  - HUD and tests must track `jumpCharge`, `spinRad`, and `activeGrab` in telemetry.

## Strict Compliance Rules

1. **Charge-and-Release:** Holding `jumpHeld` while grounded MUST accumulate `jumpCharge` from `0.0` to `1.0` over `jumpChargeMaxSeconds` (≈ `0.5 s`); releasing MUST launch with interpolated impulse `jumpMinImpulse + jumpCharge * (jumpMaxImpulse - jumpMinImpulse)`. A tap (release before `jumpCharge` reaches ~`0.1`) MUST still produce a minimal hop.
2. **Crouch Penalty:** Effective steering rate while `jumpCharge > 0` MUST be measurably lower than standing rate (≈ `0.4×`), verified by measuring heading-change rate or lateral displacement over a fixed time window.
3. **Full-Charge Air Time:** A full-charge jump (`jumpCharge = 1.0`) from a moderately steep drop zone MUST produce air time in the range [`1.8 s`, `2.2 s`], measured via `airtimeSeconds` state field.
4. **Mid-Air Spin:** While airborne and pressing `input.steer = +/-1`, `spinRad` MUST accumulate at `spinRateRadPerSec` (≈ `3.0 rad/s`); the character visual rotation MUST reflect `spinRad` (not `headingRad`).
5. **Grab Hold/Release:** While airborne, pressing and holding `W` MUST set `activeGrab = 'A'`; releasing MUST return `activeGrab` to `'none'`. Similarly for `S` / `activeGrab = 'B'`.
6. **Landing Alignment:** Landing with `|spinRad - nearest_180°_multiple| > landAlignmentToleranceRad` (≈ `60°`) MUST set `isCrashed = true`; landing with `activeGrab !== 'none'` MUST also crash.
7. **Downhill Guarantee Preserved:** Despite the lowered `gravity` (`14 m/s²`), leaving a player untouched on `summit-express` for `3.0 s` MUST still accelerate `speedKmh` above `20 km/h` (may require minor adjustment of `baseSlopeFriction` or slope-acceleration coefficients to compensate for reduced g-force).
8. **No Scoring/Points:** This iteration does **not** add a trick **scoring/combo/points** system. Tricks are expressed purely through visual poses, crash/success mechanics, and telemetry (`window.__OGSNOW_STATE__.player.spinRad`, `activeGrab`) — no new HUD score display.
