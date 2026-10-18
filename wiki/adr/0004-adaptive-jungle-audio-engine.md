# ADR-0004: Adaptive PS1 Jungle Procedural WebAudio Engine

- **Status:** Accepted
- **Date:** 2026-10-18
- **Iteration:** `feat/v1-core-game`

## Context

Section 4 of `README.md` specifies a defining feature of `ogSnow`:
- **Adaptive Music System:** Real-time, procedurally mixed soundtrack that adapts to player speed and state. As speed increases, the music dynamically adds layers (heavy basslines, faster drum loops). When crashing or slowing down, the music fades back into atmospheric ambient pads.
- **Musical Style (PS1 Jungle/Breakbeat):** 90s PS1 extreme sports aesthetic (*Cool Boarders* / *SSX*) featuring high-BPM (170 BPM) jungle beats, classic Amen-style breakbeat patterns, and atmospheric drum & bass pads.
- **Dynamic SFX:**
  - **Wind Resistance:** Procedural wind audio scaling in pitch (bandpass cutoff frequency) and volume (`windGain`) with player velocity.
  - **Snow Interaction:** Snowboard carving audio (`carveGain`, `carveFrequencyHz`) changing dynamically based on speed and carve angle when grounded.

## Decision

We implement `JungleAudioEngine` (`src/audio/JungleAudioEngine.ts`) using the native **Web Audio API** with procedural synthesis and real-time stem gain modulation:

1. **Three Musical Stems (170 BPM Synchronized):**
   - **Atmospheric Pad Stem (`padGain`):** Lush, detuned C-minor-9th / suspended synthesizer pad oscillators routed through a warm lowpass filter. Always active while riding (`padGain` in `[0.35, 0.70]`), swelling when stopped or crashed.
   - **Reese / Sub-Bass Stem (`bassGain`):** Deep C1/C2 (`32.7 Hz` / `65.4 Hz`) saw/sub-sine bassline (harmonically locked to the C-minor-9th pad) that fades in linearly as `speedKmh` rises above `config.bassFadeInSpeedKmh` (`15 km/h`), reaching full gain (`0.85`) around `45 km/h`.
   - **170 BPM Amen Breakbeat Stem (`drumGain`):** 16-step procedural Jungle/Amen breakbeat synthesizer (punchy 90s kick, pitched snare, syncopated ghost snares, and rapid metallic chopped hi-hat/ride breaks) that fades in as `speedKmh` exceeds `config.drumsFadeInSpeedKmh` (`30 km/h`) and reaches peak intensity (`1.0`) at `config.fullIntensitySpeedKmh` (`60 km/h`).
   - **Crash / Slowdown / Menu Ducking:** When `playerState.isCrashed === true`, `speedKmh < config.bassFadeInSpeedKmh` (`15 km/h`), or the player returns to the main menu (`mode === 'menu'`), `bassGain` and `drumGain` duck to `0.0`, leaving only the atmospheric pad stem (`activeStems = ['pad']`).
2. **Two Dynamic SFX Generators:**
   - **Wind Resistance (`windGain`, `windFrequencyHz`):** Continuous pink/white noise buffer routed through a `BiquadFilterNode` (`type = 'bandpass'`). `windGain` scales from `0.02` at rest to `0.65` at max speed; `windFrequencyHz` scales from `220 Hz` to `1,400 Hz` based on `speedKmh`.
   - **Snow Interaction (`carveGain`, `carveFrequencyHz`):** Filtered granular noise active only when `isGrounded === true` and `speedKmh > 3`. `carveGain` scales with `Math.min(1.0, (speedKmh / 50) * (0.15 + 0.85 * carveIntensity))`, and `carveFrequencyHz` shifts from `400 Hz` (gliding) up to `1,800 Hz` (hard edge carve).
3. **Headless & Autoplay Resilience:**
   - `AudioContext` is instantiated lazily inside `init()` (on user drop-in gesture) rather than at page load to respect browser autoplay policies without console warnings.
   - `JungleAudioEngine.update(playerState, dtSeconds)` computes all target gains, frequencies, and `activeStems` deterministically on every tick, even before `AudioContext` is unlocked or in headless test environments without audio hardware.

## Consequences

- **Positive:**
  - Zero external MP3/WAV asset download overhead; instant startup and 100% deterministic telemetry in Vitest and Playwright.
  - Authentic 170 BPM 90s Jungle/Drum & Bass vibe tightly locked to player momentum.
- **Negative:**
  - Browser autoplay policies require creating/resuming `AudioContext` on the user's Drop-In button click (`audioEngine.init()`).

## Strict Compliance Rules

1. At `speedKmh = 0` (at rest) or upon returning to the main menu (`returnToMenu()`), `activeStems` MUST equal `['pad']`, `bassGain === 0`, and `drumGain === 0`.
2. At `speedKmh = 22` (medium cruise, `>= 15 km/h` and `< 30 km/h`), `activeStems` MUST equal `['pad', 'bass']` with `bassGain > 0` and `drumGain === 0`.
3. At `speedKmh >= 60` (high speed), `activeStems` MUST equal `['pad', 'bass', 'drums']` with `padGain > 0`, `bassGain > 0.5`, and `drumGain >= 0.8`.
4. When `isCrashed === true`, `bassGain` and `drumGain` MUST drop to `0` and `activeStems` MUST equal `['pad']`.
5. When `isGrounded === false` (airborne), `carveGain` MUST equal `0`.
