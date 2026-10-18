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

  // [PR-1 M1/Security] Cached HUD values to eliminate redundant DOM writes
  private cachedSpeedText: string = '';
  private cachedAltitudeText: string = '';
  private cachedStemsText: string = '';
  private cachedMuteBtnText: string = '';
  private cachedCarveWidth: string = '';
  private cachedActiveBanner: 'crash' | 'airtime' | 'carve' | 'none' = 'none';
  private cachedAirtimeText: string = '';

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
      this.cachedActiveBanner = 'none';

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

    // [PR-1 M1/Security] Update Speedometer & Altimeter with DOM write caching
    const speedKmh = Math.max(0, Math.round(player.speedKmh));
    const speedText = `${speedKmh} km/h`;
    if (this.cachedSpeedText !== speedText) {
      this.speedEl.textContent = speedText;
      this.cachedSpeedText = speedText;
    }

    const altitude = Math.round(player.altitudeMeters);
    const altitudeText = `${altitude} m`;
    if (this.cachedAltitudeText !== altitudeText) {
      this.altitudeEl.textContent = altitudeText;
      this.cachedAltitudeText = altitudeText;
    }

    // Update Stems Badge
    const stemLabels = audio.activeStems.map((stem) => {
      if (stem.toLowerCase() === 'drums') return 'AMEN BREAKS';
      return stem.toUpperCase();
    });
    const stemsText = stemLabels.join(' + ') || 'MUTED';
    if (this.cachedStemsText !== stemsText) {
      this.stemsEl.textContent = stemsText;
      this.cachedStemsText = stemsText;
    }

    // Update Mute Button text
    const muteText = audio.isMuted ? 'UNMUTE [M]' : 'MUTE [M]';
    if (this.cachedMuteBtnText !== muteText) {
      this.muteBtnEl.textContent = muteText;
      this.cachedMuteBtnText = muteText;
    }

    // Carve Meter
    if (this.carveMeterFillEl) {
      const carvePercent = Math.min(100, Math.round(player.carveIntensity * 100));
      const carveWidth = `${carvePercent}%`;
      if (this.cachedCarveWidth !== carveWidth) {
        this.carveMeterFillEl.style.width = carveWidth;
        this.cachedCarveWidth = carveWidth;
      }
    }

    // Status Banners
    let activeBanner: 'crash' | 'airtime' | 'carve' | 'none' = 'none';
    let airtimeText = '';

    if (player.isCrashed) {
      activeBanner = 'crash';
    } else if (!player.isGrounded && player.airtimeSeconds > 0.15) {
      activeBanner = 'airtime';
      airtimeText = `AIRTIME: ${player.airtimeSeconds.toFixed(1)}s`;
    } else if (player.isGrounded && player.carveIntensity > 0.35) {
      activeBanner = 'carve';
    }

    if (
      this.cachedActiveBanner !== activeBanner ||
      (activeBanner === 'airtime' && this.cachedAirtimeText !== airtimeText)
    ) {
      this.crashBannerEl.style.display = activeBanner === 'crash' ? 'block' : 'none';
      this.airtimeBannerEl.style.display = activeBanner === 'airtime' ? 'block' : 'none';
      if (activeBanner === 'airtime') {
        this.airtimeBannerEl.textContent = airtimeText;
        this.cachedAirtimeText = airtimeText;
      }
      this.carveBannerEl.style.display = activeBanner === 'carve' ? 'block' : 'none';
      this.cachedActiveBanner = activeBanner;
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

    const gameTitleEl = document.createElement('div');
    gameTitleEl.className = 'game-title';
    gameTitleEl.textContent = 'OG SNOW';

    const gameSubTitleEl = document.createElement('div');
    gameSubTitleEl.className = 'game-subtitle';
    gameSubTitleEl.textContent = 'Extreme Downhill PS1 Freeride';

    const mountainInfoEl = document.createElement('div');
    mountainInfoEl.className = 'mountain-info';

    const mountainBadgeEl = document.createElement('span');
    mountainBadgeEl.className = 'mountain-badge';
    mountainBadgeEl.textContent = 'FLAGSHIP RESORT';

    const mountainNameEl = document.createElement('span');
    mountainNameEl.className = 'mountain-name';
    mountainNameEl.textContent = this.config.mountainName;

    mountainInfoEl.appendChild(mountainBadgeEl);
    mountainInfoEl.appendChild(mountainNameEl);
    headerEl.appendChild(gameTitleEl);
    headerEl.appendChild(gameSubTitleEl);
    headerEl.appendChild(mountainInfoEl);
    this.mainMenuEl.appendChild(headerEl);

    // Drop Zone Selection
    const dropZoneSection = document.createElement('div');
    dropZoneSection.className = 'drop-zone-section';

    const sectionLabelEl = document.createElement('div');
    sectionLabelEl.className = 'section-label';
    sectionLabelEl.textContent = 'SELECT DROP ZONE TO DROP IN';
    dropZoneSection.appendChild(sectionLabelEl);

    const dropZoneGrid = document.createElement('div');
    dropZoneGrid.className = 'drop-zone-grid';

    // [PR-1 M1/Security] Construct drop-zone cards using safe DOM element creation and textContent
    for (const dz of this.config.dropZones) {
      const card = document.createElement('button');
      card.className = 'drop-zone-card retro-skew retro-shadow';
      card.setAttribute('data-testid', `drop-zone-btn-${dz.id}`);

      let diffClass = 'difficulty-blue';
      if (dz.difficulty === 'Double Black') diffClass = 'difficulty-double-black';
      else if (dz.difficulty === 'Black') diffClass = 'difficulty-black';
      else if (dz.difficulty === 'Green') diffClass = 'difficulty-green';

      const titleRow = document.createElement('div');
      titleRow.className = 'drop-zone-title-row';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'drop-zone-name';
      nameSpan.textContent = dz.name;

      const diffSpan = document.createElement('span');
      diffSpan.className = `difficulty-tag ${diffClass}`;
      diffSpan.textContent = dz.difficulty;

      titleRow.appendChild(nameSpan);
      titleRow.appendChild(diffSpan);

      const elevDiv = document.createElement('div');
      elevDiv.className = 'drop-zone-elevation';
      elevDiv.textContent = `${dz.elevationMeters}m Elevation`;

      const descDiv = document.createElement('div');
      descDiv.className = 'drop-zone-desc';
      descDiv.textContent = dz.description;

      card.appendChild(titleRow);
      card.appendChild(elevDiv);
      card.appendChild(descDiv);

      card.addEventListener('click', (e) => {
        (e.currentTarget as HTMLElement)?.blur();
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

    // [PR-1 M1/Security] Set tabindex="-1" and blur on click so space to jump never triggers button
    this.muteBtnEl = document.createElement('button');
    this.muteBtnEl.className = 'retro-btn retro-btn-secondary retro-skew retro-shadow';
    this.muteBtnEl.setAttribute('data-testid', 'btn-mute-audio');
    this.muteBtnEl.setAttribute('tabindex', '-1');
    this.muteBtnEl.textContent = 'MUTE [M]';
    this.muteBtnEl.addEventListener('click', (e) => {
      (e.currentTarget as HTMLElement)?.blur();
      this.callbacks.onToggleMute();
    });

    this.returnBtnEl = document.createElement('button');
    this.returnBtnEl.className = 'retro-btn retro-skew retro-shadow';
    this.returnBtnEl.setAttribute('data-testid', 'btn-return-menu');
    this.returnBtnEl.setAttribute('tabindex', '-1');
    this.returnBtnEl.textContent = 'MOUNTAIN MENU';
    this.returnBtnEl.addEventListener('click', (e) => {
      (e.currentTarget as HTMLElement)?.blur();
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
