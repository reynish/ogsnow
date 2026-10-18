import { AudioState, GameConfig, GameMode, PlayerState } from '../types';

export interface HUDCallbacks {
  onSelectDropZone: (dropZoneId: string) => void;
  onReturnToMenu: () => void;
  onToggleMute: () => void;
}

export class HUDManager {
  private container: HTMLElement;
  private config: GameConfig;
  private callbacks: HUDCallbacks;

  // DOM Elements
  private mainMenuEl!: HTMLElement;
  private hudOverlayEl!: HTMLElement;
  private speedEl!: HTMLElement;
  private altitudeEl!: HTMLElement;
  private stemsEl!: HTMLElement;
  private muteBtnEl!: HTMLElement;
  private returnBtnEl!: HTMLElement;
  private activeDropZoneNameEl!: HTMLElement;
  private crashBannerEl!: HTMLElement;
  private airtimeBannerEl!: HTMLElement;
  private carveBannerEl!: HTMLElement;
  private carveMeterFillEl!: HTMLElement;

  private currentMode: GameMode = 'menu';

  constructor(container: HTMLElement, config: GameConfig, callbacks: HUDCallbacks) {
    this.container = container;
    this.config = config;
    this.callbacks = callbacks;

    this.render();
  }

  public setMode(mode: GameMode, activeDropZoneId?: string): void {
    this.currentMode = mode;

    if (mode === 'menu') {
      this.mainMenuEl.classList.remove('hidden');
      this.hudOverlayEl.classList.add('hidden');
    } else {
      this.mainMenuEl.classList.add('hidden');
      this.hudOverlayEl.classList.remove('hidden');

      if (activeDropZoneId) {
        const dropZone = this.config.dropZones.find((dz) => dz.id === activeDropZoneId);
        if (dropZone && this.activeDropZoneNameEl) {
          this.activeDropZoneNameEl.textContent = dropZone.name;
        }
      }
    }
  }

  public update(player: PlayerState, audio: AudioState): void {
    if (this.currentMode !== 'riding') {
      return;
    }

    // Update Speedometer & Altimeter
    const speedKmh = Math.max(0, Math.round(player.speedKmh));
    this.speedEl.textContent = `${speedKmh} km/h`;

    const altitude = Math.round(player.altitudeMeters);
    this.altitudeEl.textContent = `${altitude} m`;

    // Update Stems Badge
    const stemLabels = audio.activeStems.map((stem) => {
      if (stem.toLowerCase() === 'drums') return 'AMEN BREAKS';
      return stem.toUpperCase();
    });
    this.stemsEl.textContent = stemLabels.join(' + ') || 'MUTED';

    // Update Mute Button text
    this.muteBtnEl.textContent = audio.isMuted ? 'UNMUTE [M]' : 'MUTE [M]';

    // Carve Meter
    if (this.carveMeterFillEl) {
      const carvePercent = Math.min(100, Math.round(player.carveIntensity * 100));
      this.carveMeterFillEl.style.width = `${carvePercent}%`;
    }

    // Status Banners
    if (player.isCrashed) {
      this.crashBannerEl.style.display = 'block';
      this.airtimeBannerEl.style.display = 'none';
      this.carveBannerEl.style.display = 'none';
    } else if (!player.isGrounded && player.airtimeSeconds > 0.15) {
      this.crashBannerEl.style.display = 'none';
      this.airtimeBannerEl.style.display = 'block';
      this.airtimeBannerEl.textContent = `AIRTIME: ${player.airtimeSeconds.toFixed(1)}s`;
      this.carveBannerEl.style.display = 'none';
    } else if (player.isGrounded && player.carveIntensity > 0.35) {
      this.crashBannerEl.style.display = 'none';
      this.airtimeBannerEl.style.display = 'none';
      this.carveBannerEl.style.display = 'block';
    } else {
      this.crashBannerEl.style.display = 'none';
      this.airtimeBannerEl.style.display = 'none';
      this.carveBannerEl.style.display = 'none';
    }
  }

  private render(): void {
    this.container.innerHTML = '';

    // ==========================================
    // 1. MAIN MENU (#main-menu)
    // ==========================================
    this.mainMenuEl = document.createElement('div');
    this.mainMenuEl.id = 'main-menu';

    // Header
    const headerEl = document.createElement('div');
    headerEl.className = 'menu-header';
    headerEl.innerHTML = `
      <div class="game-title">OG SNOW</div>
      <div class="game-subtitle">Extreme Downhill PS1 Freeride</div>
      <div class="mountain-info">
        <span class="mountain-badge">FLAGSHIP RESORT</span>
        <span class="mountain-name">${this.config.mountainName}</span>
      </div>
    `;
    this.mainMenuEl.appendChild(headerEl);

    // Drop Zone Selection
    const dropZoneSection = document.createElement('div');
    dropZoneSection.className = 'drop-zone-section';
    dropZoneSection.innerHTML = `<div class="section-label">SELECT DROP ZONE TO DROP IN</div>`;

    const dropZoneGrid = document.createElement('div');
    dropZoneGrid.className = 'drop-zone-grid';

    for (const dz of this.config.dropZones) {
      const card = document.createElement('button');
      card.className = 'drop-zone-card retro-skew retro-shadow';
      card.setAttribute('data-testid', `drop-zone-btn-${dz.id}`);

      let diffClass = 'difficulty-blue';
      if (dz.difficulty === 'Double Black') diffClass = 'difficulty-double-black';
      else if (dz.difficulty === 'Black') diffClass = 'difficulty-black';
      else if (dz.difficulty === 'Green') diffClass = 'difficulty-green';

      card.innerHTML = `
        <div class="drop-zone-title-row">
          <span class="drop-zone-name">${dz.name}</span>
          <span class="difficulty-tag ${diffClass}">${dz.difficulty}</span>
        </div>
        <div class="drop-zone-elevation">${dz.elevationMeters}m Elevation</div>
        <div class="drop-zone-desc">${dz.description}</div>
      `;

      card.addEventListener('click', () => {
        this.callbacks.onSelectDropZone(dz.id);
      });

      dropZoneGrid.appendChild(card);
    }

    dropZoneSection.appendChild(dropZoneGrid);
    this.mainMenuEl.appendChild(dropZoneSection);

    // Footer
    const footerEl = document.createElement('div');
    footerEl.className = 'menu-footer';
    footerEl.innerHTML = `
      <div class="controls-hint">
        CONTROLS: [A/D] STEER • [S] CARVE / BRAKE • [W] TUCK ACCEL • [SPACE] JUMP • [R] RESET
      </div>
      <div class="soundtrack-info">170 BPM AMEN JUNGLE SOUNDTRACK</div>
    `;
    this.mainMenuEl.appendChild(footerEl);

    // ==========================================
    // 2. IN-GAME HUD (#hud-overlay)
    // ==========================================
    this.hudOverlayEl = document.createElement('div');
    this.hudOverlayEl.id = 'hud-overlay';
    this.hudOverlayEl.className = 'hidden';

    // Top Bar
    const topBar = document.createElement('div');
    topBar.className = 'hud-top-bar';

    const locationGroup = document.createElement('div');
    locationGroup.className = 'hud-location-group';
    this.activeDropZoneNameEl = document.createElement('div');
    this.activeDropZoneNameEl.className = 'hud-active-drop-zone retro-skew retro-text-shadow';
    this.activeDropZoneNameEl.textContent = this.config.dropZones[0]?.name ?? 'Whistler Peak';
    locationGroup.appendChild(this.activeDropZoneNameEl);

    // Stems Badge
    const stemsContainer = document.createElement('div');
    stemsContainer.className = 'hud-audio-stems-container retro-skew retro-shadow';
    stemsContainer.innerHTML = `<span class="hud-stems-label">AUDIO STEMS:</span>`;
    this.stemsEl = document.createElement('span');
    this.stemsEl.className = 'hud-stems-badge';
    this.stemsEl.setAttribute('data-testid', 'hud-stems');
    this.stemsEl.textContent = 'PAD';
    stemsContainer.appendChild(this.stemsEl);

    // Action Buttons
    const actionButtons = document.createElement('div');
    actionButtons.className = 'hud-action-buttons';

    this.muteBtnEl = document.createElement('button');
    this.muteBtnEl.className = 'retro-btn retro-btn-secondary retro-skew retro-shadow';
    this.muteBtnEl.setAttribute('data-testid', 'btn-mute-audio');
    this.muteBtnEl.textContent = 'MUTE [M]';
    this.muteBtnEl.addEventListener('click', () => {
      this.callbacks.onToggleMute();
    });

    this.returnBtnEl = document.createElement('button');
    this.returnBtnEl.className = 'retro-btn retro-skew retro-shadow';
    this.returnBtnEl.setAttribute('data-testid', 'btn-return-menu');
    this.returnBtnEl.textContent = 'MOUNTAIN MENU';
    this.returnBtnEl.addEventListener('click', () => {
      this.callbacks.onReturnToMenu();
    });

    actionButtons.appendChild(this.muteBtnEl);
    actionButtons.appendChild(this.returnBtnEl);

    topBar.appendChild(locationGroup);
    topBar.appendChild(stemsContainer);
    topBar.appendChild(actionButtons);
    this.hudOverlayEl.appendChild(topBar);

    // Center Banners
    const centerBannerArea = document.createElement('div');
    centerBannerArea.className = 'hud-center-banner-area';

    this.crashBannerEl = document.createElement('div');
    this.crashBannerEl.className = 'banner-crash retro-skew retro-shadow';
    this.crashBannerEl.textContent = 'WIPEOUT! RECOVERING...';
    this.crashBannerEl.style.display = 'none';

    this.airtimeBannerEl = document.createElement('div');
    this.airtimeBannerEl.className = 'banner-airtime retro-skew retro-shadow';
    this.airtimeBannerEl.textContent = 'BIG AIR!';
    this.airtimeBannerEl.style.display = 'none';

    this.carveBannerEl = document.createElement('div');
    this.carveBannerEl.className = 'banner-carving retro-skew retro-shadow';
    this.carveBannerEl.textContent = 'CARVING EDGE';
    this.carveBannerEl.style.display = 'none';

    centerBannerArea.appendChild(this.crashBannerEl);
    centerBannerArea.appendChild(this.airtimeBannerEl);
    centerBannerArea.appendChild(this.carveBannerEl);
    this.hudOverlayEl.appendChild(centerBannerArea);

    // Bottom Telemetry
    const bottomBar = document.createElement('div');
    bottomBar.className = 'hud-bottom-bar';

    // Speedometer
    const telemetryLeft = document.createElement('div');
    telemetryLeft.className = 'hud-telemetry-left retro-skew retro-shadow';

    this.speedEl = document.createElement('span');
    this.speedEl.className = 'hud-speed-val retro-text-shadow';
    this.speedEl.setAttribute('data-testid', 'hud-speed');
    this.speedEl.textContent = '0 km/h';

    telemetryLeft.appendChild(this.speedEl);

    // Altimeter
    const telemetryRight = document.createElement('div');
    telemetryRight.className = 'hud-telemetry-right retro-skew retro-shadow';

    const altLabel = document.createElement('span');
    altLabel.className = 'hud-altitude-label';
    altLabel.textContent = 'PEAK ELEVATION';

    this.altitudeEl = document.createElement('span');
    this.altitudeEl.className = 'hud-altitude-val retro-text-shadow';
    this.altitudeEl.setAttribute('data-testid', 'hud-altitude');
    this.altitudeEl.textContent = `${this.config.dropZones[0]?.elevationMeters ?? 2182} m`;

    const carveMeter = document.createElement('div');
    carveMeter.className = 'hud-carve-meter';
    this.carveMeterFillEl = document.createElement('div');
    this.carveMeterFillEl.className = 'hud-carve-meter-fill';
    carveMeter.appendChild(this.carveMeterFillEl);

    telemetryRight.appendChild(altLabel);
    telemetryRight.appendChild(this.altitudeEl);
    telemetryRight.appendChild(carveMeter);

    bottomBar.appendChild(telemetryLeft);
    bottomBar.appendChild(telemetryRight);
    this.hudOverlayEl.appendChild(bottomBar);

    // Mount to container
    this.container.appendChild(this.mainMenuEl);
    this.container.appendChild(this.hudOverlayEl);
  }
}
