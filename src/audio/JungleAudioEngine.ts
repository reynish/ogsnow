import { AudioState, GameConfig, PlayerState } from '../types';
import { DEFAULT_GAME_CONFIG } from '../config';

export class JungleAudioEngine {
  public readonly config: GameConfig;
  private state: AudioState;
  private ctx: AudioContext | null = null;
  private isGraphRunning: boolean = false;

  // Web Audio Nodes
  private masterGainNode: GainNode | null = null;
  private padGainNode: GainNode | null = null;
  private bassGainNode: GainNode | null = null;
  private drumGainNode: GainNode | null = null;
  private windGainNode: GainNode | null = null;
  private windFilterNode: BiquadFilterNode | null = null;
  private carveGainNode: GainNode | null = null;
  private carveFilterNode: BiquadFilterNode | null = null;

  // Active oscillators/sources for disposal
  private activeSources: (AudioBufferSourceNode | OscillatorNode)[] = [];

  constructor(config?: GameConfig, audioContextOverride?: BaseAudioContext) {
    this.config = config ?? DEFAULT_GAME_CONFIG;

    this.state = {
      isInitialized: false,
      isMuted: false,
      bpm: this.config.audioBpm || 170,
      padGain: 0.6,
      bassGain: 0.0,
      drumGain: 0.0,
      windGain: 0.02,
      windFrequencyHz: 220,
      carveGain: 0.0,
      carveFrequencyHz: 400,
      activeStems: ['pad'],
    };

    // [PR-1 Audio: C-minor harmonic alignment & lazy AudioContext]
    // Only assign ctx in constructor if audioContextOverride is passed.
    // Lazy AudioContext creation inside init() avoids browser autoplay console warnings on initial page load.
    if (audioContextOverride) {
      this.ctx = audioContextOverride as AudioContext;
    }
  }

  public async init(): Promise<void> {
    if (!this.ctx && typeof window !== 'undefined') {
      const AudioCtxClass =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioCtxClass) {
        try {
          this.ctx = new AudioCtxClass();
        } catch {
          this.ctx = null;
        }
      }
    }

    if (this.ctx) {
      if (this.ctx.state === 'suspended') {
        try {
          await this.ctx.resume();
        } catch {
          // Browser gesture gating
        }
      }

      if (!this.isGraphRunning) {
        this.setupAudioGraph();
      }
    }

    this.state.isInitialized = true;
  }

  public update(playerState: PlayerState, _dtSeconds: number): AudioState {
    const speed = Math.max(0, playerState.speedKmh);
    const maxSpeed = this.config.maxSpeedKmh || 115.0;
    const bassFadeStart = this.config.bassFadeInSpeedKmh; // 15.0
    const drumsFadeStart = this.config.drumsFadeInSpeedKmh; // 30.0
    const fullIntensitySpeed = this.config.fullIntensitySpeedKmh; // 60.0

    // 1. Calculate dynamic SFX values
    const speedRatio = Math.min(1.0, speed / maxSpeed);
    const windGain = 0.02 + speedRatio * (0.65 - 0.02);
    const windFrequencyHz = 220.0 + speedRatio * (1400.0 - 220.0);

    let carveGain = 0.0;
    let carveFrequencyHz = 400.0;

    if (playerState.isGrounded && speed > 3.0 && !playerState.isCrashed) {
      const intensity = Math.max(0.0, Math.min(1.0, playerState.carveIntensity || 0));
      carveGain = Math.min(1.0, (speed / 50.0) * (0.15 + 0.85 * intensity));
      carveFrequencyHz = 400.0 + intensity * (1800.0 - 400.0);
    } else {
      carveGain = 0.0;
      carveFrequencyHz = 400.0;
    }

    // 2. Calculate musical stem gains & activeStems
    let activeStems: string[];
    let padGain: number;
    let bassGain: number;
    let drumGain: number;

    if (playerState.isCrashed) {
      // Crash ducking: rapid duck to pad only
      activeStems = ['pad'];
      padGain = 0.65;
      bassGain = 0.0;
      drumGain = 0.0;
    } else if (speed < bassFadeStart) {
      // Rest / low speed
      activeStems = ['pad'];
      padGain = 0.55;
      bassGain = 0.0;
      drumGain = 0.0;
    } else if (speed < drumsFadeStart) {
      // Medium cruising speed
      activeStems = ['pad', 'bass'];
      padGain = 0.5;
      const bassRatio = Math.min(1.0, (speed - bassFadeStart) / (45.0 - bassFadeStart));
      bassGain = Math.min(0.85, bassRatio * 0.85);
      drumGain = 0.0;
    } else {
      // High speed: full PS1 Amen breakbeat layer
      activeStems = ['pad', 'bass', 'drums'];
      padGain = 0.4;
      const bassRatio = Math.min(1.0, (speed - bassFadeStart) / (45.0 - bassFadeStart));
      bassGain = Math.min(0.85, bassRatio * 0.85);

      const drumRatio = Math.min(
        1.0,
        (speed - drumsFadeStart) / Math.max(1.0, fullIntensitySpeed - drumsFadeStart)
      );
      drumGain = Math.min(1.0, drumRatio * 1.0);
    }

    // Update state object deterministically
    this.state.padGain = padGain;
    this.state.bassGain = bassGain;
    this.state.drumGain = drumGain;
    this.state.windGain = windGain;
    this.state.windFrequencyHz = windFrequencyHz;
    this.state.carveGain = carveGain;
    this.state.carveFrequencyHz = carveFrequencyHz;
    this.state.activeStems = activeStems;

    // 3. Update Web Audio graph if active
    if (this.ctx && this.isGraphRunning && this.ctx.state === 'running') {
      const now = this.ctx.currentTime;
      const timeConstant = 0.04;

      const muteMultiplier = this.state.isMuted ? 0 : 1;

      if (this.padGainNode) {
        this.padGainNode.gain.setTargetAtTime(padGain * 0.45 * muteMultiplier, now, timeConstant);
      }
      if (this.bassGainNode) {
        this.bassGainNode.gain.setTargetAtTime(bassGain * 0.55 * muteMultiplier, now, timeConstant);
      }
      if (this.drumGainNode) {
        this.drumGainNode.gain.setTargetAtTime(drumGain * 0.5 * muteMultiplier, now, timeConstant);
      }
      if (this.windGainNode) {
        this.windGainNode.gain.setTargetAtTime(windGain * 0.35 * muteMultiplier, now, timeConstant);
      }
      if (this.windFilterNode) {
        this.windFilterNode.frequency.setTargetAtTime(windFrequencyHz, now, timeConstant);
      }
      if (this.carveGainNode) {
        this.carveGainNode.gain.setTargetAtTime(carveGain * 0.4 * muteMultiplier, now, timeConstant);
      }
      if (this.carveFilterNode) {
        this.carveFilterNode.frequency.setTargetAtTime(carveFrequencyHz, now, timeConstant);
      }
    }

    return this.getState();
  }

  public setMuted(muted: boolean): void {
    this.state.isMuted = muted;
    if (this.masterGainNode && this.ctx) {
      this.masterGainNode.gain.setTargetAtTime(muted ? 0.0 : 1.0, this.ctx.currentTime, 0.02);
    }
  }

  public getState(): AudioState {
    return {
      ...this.state,
      activeStems: [...this.state.activeStems],
    };
  }

  public dispose(): void {
    for (const source of this.activeSources) {
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Source might not have started or already stopped
      }
    }
    this.activeSources = [];

    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        this.ctx.close();
      } catch {
        // Ignored
      }
    }

    this.ctx = null;
    this.isGraphRunning = false;
    this.state.isInitialized = false;
  }

  private setupAudioGraph(): void {
    if (!this.ctx) return;

    try {
      // 1. Master Output
      this.masterGainNode = this.ctx.createGain();
      this.masterGainNode.gain.setValueAtTime(this.state.isMuted ? 0 : 1.0, this.ctx.currentTime);
      this.masterGainNode.connect(this.ctx.destination);

      // 2. Pad Stem (Atmospheric minor-9th chords)
      this.padGainNode = this.ctx.createGain();
      this.padGainNode.gain.setValueAtTime(this.state.padGain * 0.45, this.ctx.currentTime);

      const padFilter = this.ctx.createBiquadFilter();
      padFilter.type = 'lowpass';
      padFilter.frequency.setValueAtTime(750, this.ctx.currentTime);
      padFilter.Q.setValueAtTime(1.2, this.ctx.currentTime);
      this.padGainNode.connect(padFilter);
      padFilter.connect(this.masterGainNode);

      // Minor 9th chord notes: C3 (130.81), Eb3 (155.56), G3 (196.00), Bb3 (233.08), D4 (293.66)
      const chordFrequencies = [130.81, 155.56, 196.0, 233.08, 293.66];
      for (const freq of chordFrequencies) {
        const osc = this.ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        // Slight detune for lush analog warmth
        osc.detune.setValueAtTime((Math.random() - 0.5) * 14, this.ctx.currentTime);

        const oscGain = this.ctx.createGain();
        oscGain.gain.setValueAtTime(0.18, this.ctx.currentTime);

        osc.connect(oscGain);
        oscGain.connect(this.padGainNode);
        osc.start();
        this.activeSources.push(osc);
      }

      // 3. Reese / Sub-Bass Stem
      this.bassGainNode = this.ctx.createGain();
      this.bassGainNode.gain.setValueAtTime(this.state.bassGain * 0.55, this.ctx.currentTime);

      const bassFilter = this.ctx.createBiquadFilter();
      bassFilter.type = 'lowpass';
      bassFilter.frequency.setValueAtTime(220, this.ctx.currentTime);
      bassFilter.Q.setValueAtTime(2.0, this.ctx.currentTime);
      this.bassGainNode.connect(bassFilter);
      bassFilter.connect(this.masterGainNode);

      // [PR-1 Audio: C-minor harmonic alignment & lazy AudioContext]
      // Detuned twin saw oscillators for Reese phasing (65.41 Hz / C2) + sub sine (32.70 Hz / C1)
      // Harmonically aligned with the C-minor-9th atmospheric pad (C3 130.81, Eb3 155.56, G3 196.00, Bb3 233.08, D4 293.66)
      const reeseBassFreq = 65.41; // C2
      const subBassFreq = 32.70; // C1

      const saw1 = this.ctx.createOscillator();
      saw1.type = 'sawtooth';
      saw1.frequency.setValueAtTime(reeseBassFreq, this.ctx.currentTime);
      saw1.detune.setValueAtTime(-4, this.ctx.currentTime);

      const saw2 = this.ctx.createOscillator();
      saw2.type = 'sawtooth';
      saw2.frequency.setValueAtTime(reeseBassFreq, this.ctx.currentTime);
      saw2.detune.setValueAtTime(4, this.ctx.currentTime);

      const subSine = this.ctx.createOscillator();
      subSine.type = 'sine';
      subSine.frequency.setValueAtTime(subBassFreq, this.ctx.currentTime);

      saw1.connect(this.bassGainNode);
      saw2.connect(this.bassGainNode);
      subSine.connect(this.bassGainNode);

      saw1.start();
      saw2.start();
      subSine.start();
      this.activeSources.push(saw1, saw2, subSine);

      // 4. 170 BPM Amen Breakbeat Drum Loop
      this.drumGainNode = this.ctx.createGain();
      this.drumGainNode.gain.setValueAtTime(this.state.drumGain * 0.5, this.ctx.currentTime);
      this.drumGainNode.connect(this.masterGainNode);

      const amenBuffer = this.createAmenBreakBuffer(this.ctx, this.state.bpm);
      const drumSource = this.ctx.createBufferSource();
      drumSource.buffer = amenBuffer;
      drumSource.loop = true;
      drumSource.connect(this.drumGainNode);
      drumSource.start();
      this.activeSources.push(drumSource);

      // 5. Procedural Wind SFX
      this.windGainNode = this.ctx.createGain();
      this.windGainNode.gain.setValueAtTime(this.state.windGain * 0.35, this.ctx.currentTime);

      this.windFilterNode = this.ctx.createBiquadFilter();
      this.windFilterNode.type = 'bandpass';
      this.windFilterNode.frequency.setValueAtTime(this.state.windFrequencyHz, this.ctx.currentTime);
      this.windFilterNode.Q.setValueAtTime(1.2, this.ctx.currentTime);

      const windNoiseBuffer = this.createNoiseBuffer(this.ctx, 2.0);
      const windSource = this.ctx.createBufferSource();
      windSource.buffer = windNoiseBuffer;
      windSource.loop = true;
      windSource.connect(this.windFilterNode);
      this.windFilterNode.connect(this.windGainNode);
      this.windGainNode.connect(this.masterGainNode);
      windSource.start();
      this.activeSources.push(windSource);

      // 6. Procedural Snow Carve SFX
      this.carveGainNode = this.ctx.createGain();
      this.carveGainNode.gain.setValueAtTime(this.state.carveGain * 0.4, this.ctx.currentTime);

      this.carveFilterNode = this.ctx.createBiquadFilter();
      this.carveFilterNode.type = 'bandpass';
      this.carveFilterNode.frequency.setValueAtTime(this.state.carveFrequencyHz, this.ctx.currentTime);
      this.carveFilterNode.Q.setValueAtTime(2.2, this.ctx.currentTime);

      const carveNoiseBuffer = this.createNoiseBuffer(this.ctx, 1.5);
      const carveSource = this.ctx.createBufferSource();
      carveSource.buffer = carveNoiseBuffer;
      carveSource.loop = true;
      carveSource.connect(this.carveFilterNode);
      this.carveFilterNode.connect(this.carveGainNode);
      this.carveGainNode.connect(this.masterGainNode);
      carveSource.start();
      this.activeSources.push(carveSource);

      this.isGraphRunning = true;
    } catch {
      // Graceful fallback in environments with restricted WebAudio
      this.isGraphRunning = false;
    }
  }

  private createAmenBreakBuffer(ctx: AudioContext, bpm: number): AudioBuffer {
    const secondsPerBeat = 60.0 / bpm;
    const barDuration = secondsPerBeat * 4.0; // 1 bar = 4 beats = 16 sixteenths
    const sampleRate = ctx.sampleRate;
    const totalSamples = Math.floor(barDuration * sampleRate);
    const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
    const data = buffer.getChannelData(0);

    const stepSamples = totalSamples / 16.0;

    // Helper functions to synthesize punchy 90s breakbeat drums into raw buffer
    const addKick = (startSample: number) => {
      const durationSamples = Math.min(Math.floor(sampleRate * 0.16), totalSamples - startSample);
      for (let i = 0; i < durationSamples; i++) {
        const t = i / sampleRate;
        const freq = 140.0 * Math.exp(-t * 22.0) + 45.0;
        const amp = Math.exp(-t * 16.0);
        data[startSample + i] += Math.sin(2 * Math.PI * freq * t) * amp * 0.8;
      }
    };

    const addSnare = (startSample: number, volume: number = 0.65) => {
      const durationSamples = Math.min(Math.floor(sampleRate * 0.15), totalSamples - startSample);
      for (let i = 0; i < durationSamples; i++) {
        const t = i / sampleRate;
        const toneFreq = 210.0 * Math.exp(-t * 10.0);
        const tone = Math.sin(2 * Math.PI * toneFreq * t) * 0.4;
        const noise = (Math.random() * 2 - 1) * 0.6;
        const amp = Math.exp(-t * 20.0);
        data[startSample + i] += (tone + noise) * amp * volume;
      }
    };

    const addHiHat = (startSample: number, volume: number = 0.28) => {
      const durationSamples = Math.min(Math.floor(sampleRate * 0.05), totalSamples - startSample);
      for (let i = 0; i < durationSamples; i++) {
        const t = i / sampleRate;
        const noise = Math.random() * 2 - 1;
        const amp = Math.exp(-t * 50.0);
        data[startSample + i] += noise * amp * volume;
      }
    };

    // 16-step classic syncopated Amen rhythm pattern:
    // Step 0: Kick + Hat
    // Step 2: Hat
    // Step 4: Snare + Hat
    // Step 6: Hat
    // Step 7: Ghost Snare
    // Step 8: Hat
    // Step 10: Kick
    // Step 11: Kick
    // Step 12: Snare + Hat
    // Step 14: Hat
    // Step 15: Ghost Snare
    const steps = [
      { kick: true, snare: false, hat: true, ghost: false }, // 0
      { kick: false, snare: false, hat: false, ghost: false }, // 1
      { kick: false, snare: false, hat: true, ghost: false }, // 2
      { kick: false, snare: false, hat: false, ghost: false }, // 3
      { kick: false, snare: true, hat: true, ghost: false }, // 4
      { kick: false, snare: false, hat: false, ghost: false }, // 5
      { kick: false, snare: false, hat: true, ghost: false }, // 6
      { kick: false, snare: false, hat: false, ghost: true }, // 7
      { kick: false, snare: false, hat: true, ghost: false }, // 8
      { kick: false, snare: false, hat: false, ghost: false }, // 9
      { kick: true, snare: false, hat: true, ghost: false }, // 10
      { kick: true, snare: false, hat: false, ghost: false }, // 11
      { kick: false, snare: true, hat: true, ghost: false }, // 12
      { kick: false, snare: false, hat: false, ghost: false }, // 13
      { kick: false, snare: false, hat: true, ghost: false }, // 14
      { kick: false, snare: false, hat: false, ghost: true }, // 15
    ];

    for (let step = 0; step < 16; step++) {
      const start = Math.floor(step * stepSamples);
      const conf = steps[step];
      if (conf.kick) addKick(start);
      if (conf.snare) addSnare(start, 0.7);
      if (conf.ghost) addSnare(start, 0.28);
      if (conf.hat) addHiHat(start, 0.25);
    }

    // Soft clip to prevent harsh distortion
    for (let i = 0; i < totalSamples; i++) {
      data[i] = Math.tanh(data[i]);
    }

    return buffer;
  }

  private createNoiseBuffer(ctx: AudioContext, durationSeconds: number): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const totalSamples = Math.floor(durationSeconds * sampleRate);
    const buffer = ctx.createBuffer(1, totalSamples, sampleRate);
    const data = buffer.getChannelData(0);

    let lastOut = 0.0;
    for (let i = 0; i < totalSamples; i++) {
      const white = Math.random() * 2 - 1;
      // Gentle 1-pole lowpass to soften raw digital white noise
      lastOut = lastOut * 0.6 + white * 0.4;
      data[i] = lastOut;
    }

    return buffer;
  }
}
