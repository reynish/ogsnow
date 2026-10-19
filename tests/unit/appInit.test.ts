import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { HUDManager } from '../../src/ui/HUDManager';
import { DEFAULT_GAME_CONFIG } from '../../src/config';
import { GameApp } from '../../src/main';

describe('B1: Drop-Zone Card Gating & Pre-Ready Interaction Protection', () => {
  let container: HTMLElement;
  let onSelectDropZone: ReturnType<typeof vi.fn>;
  let onReturnToMenu: ReturnType<typeof vi.fn>;
  let onToggleMute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    onSelectDropZone = vi.fn();
    onReturnToMenu = vi.fn();
    onToggleMute = vi.fn();
  });

  afterEach(() => {
    container.remove();
  });

  it('drop-zone cards are disabled upon initial render until updateDropZones() is called', () => {
    const hud = new HUDManager(container, DEFAULT_GAME_CONFIG, {
      onSelectDropZone,
      onReturnToMenu,
      onToggleMute,
    });

    const cards = container.querySelectorAll<HTMLButtonElement>('.drop-zone-card');
    expect(cards.length).toBe(3);

    for (const card of cards) {
      expect(card.disabled).toBe(true);
      expect(card.classList.contains('disabled')).toBe(true);
      expect(card.style.pointerEvents).toBe('none');
      expect(card.style.opacity).toBe('0.5');

      // Click event must NOT trigger callback while disabled
      card.click();
      expect(onSelectDropZone).not.toHaveBeenCalled();
    }

    // Call updateDropZones to enable them
    hud.updateDropZones(DEFAULT_GAME_CONFIG.dropZones);

    const updatedCards = container.querySelectorAll<HTMLButtonElement>('.drop-zone-card');
    expect(updatedCards.length).toBe(3);
    for (const card of updatedCards) {
      expect(card.disabled).toBe(false);
      expect(card.classList.contains('disabled')).toBe(false);
    }

    // Clicking enabled card must trigger callback
    updatedCards[0].click();
    expect(onSelectDropZone).toHaveBeenCalledWith(DEFAULT_GAME_CONFIG.dropZones[0].id);
  });

  it('DEFAULT_GAME_CONFIG.dropZones contains real Whistler drop zones with z >= 150 (m1)', () => {
    expect(DEFAULT_GAME_CONFIG.dropZones).toHaveLength(3);
    for (const dz of DEFAULT_GAME_CONFIG.dropZones) {
      expect(dz.spawnPosition.z).toBeGreaterThanOrEqual(150);
      expect(dz.elevationMeters).toBeGreaterThan(1800);
    }
    const summit = DEFAULT_GAME_CONFIG.dropZones.find((d) => d.id === 'summit-express');
    expect(summit?.spawnPosition.z).toBe(150);
  });
});

describe('B2: Fail-Loud on Asset Loading Error (ADR-0007 Rule 1 & Rule 8)', () => {
  let app: GameApp;
  let canvas: HTMLCanvasElement;
  let uiContainer: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = '';
    canvas = document.createElement('canvas');
    canvas.id = 'game-canvas';
    document.body.appendChild(canvas);

    uiContainer = document.createElement('div');
    uiContainer.id = 'ui-container';
    document.body.appendChild(uiContainer);
  });

  afterEach(() => {
    app?.dispose();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('does not swallow terrain.initialize() error: marks isReady=false, mode=error, renders error banner', async () => {
    app = new GameApp();

    // Mock terrain.initialize to reject (e.g. simulated 404 or corrupted asset)
    const loadError = new Error('HTTP 404: Asset whistler-dem.bin not found');
    vi.spyOn((app as any).terrain, 'initialize').mockRejectedValueOnce(loadError);

    // init() MUST rethrow / reject rather than swallowing
    await expect(app.init()).rejects.toThrow('HTTP 404: Asset whistler-dem.bin not found');

    // Engine must NOT enter a zombie ready state
    expect(app.isReady).toBe(false);
    expect(app.mode).toBe('error');

    // Telemetry must report ready=false and mode=error
    expect(window.__OGSNOW_STATE__.ready).toBe(false);
    expect(window.__OGSNOW_STATE__.mode).toBe('error');

    // Prominent error banner must be rendered in DOM
    const errorBanner = document.querySelector('[data-testid="terrain-error-banner"]');
    expect(errorBanner).not.toBeNull();
    expect(errorBanner?.textContent).toContain('TERRAIN LOAD ERROR');
    expect(errorBanner?.textContent).toContain('HTTP 404');

    // Attempting dropIn while in error mode must abort early
    await app.dropIn('summit-express');
    expect(app.mode).toBe('error');
    expect(app.isReady).toBe(false);
  });
});
