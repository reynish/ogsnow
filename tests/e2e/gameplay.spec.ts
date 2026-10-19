import { test, expect } from '@playwright/test';

test.describe('ogSnow Downhill Freeride — E2E Browser Verification (ADR-0005)', () => {
  let consoleErrors: string[] = [];
  let pageErrors: string[] = [];
  let externalRequests: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    pageErrors = [];
    externalRequests = [];

    // Capture all console.error and pageerror events before navigation
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    // m5: Spy on all network requests and assert zero external outbound requests
    await page.route('**/*', (route) => {
      const url = route.request().url();
      try {
        const parsed = new URL(url);
        const isLocal =
          parsed.hostname === 'localhost' ||
          parsed.hostname === '127.0.0.1' ||
          parsed.hostname === '::1' ||
          parsed.protocol === 'data:' ||
          parsed.protocol === 'blob:';

        if (!isLocal) {
          externalRequests.push(url);
          route.abort('blockedbyclient');
        } else {
          route.continue();
        }
      } catch {
        route.continue();
      }
    });

    await page.goto('/');

    // Wait until GameApp initializes window.__OGSNOW_STATE__ and window.__OGSNOW_APP__, and finishes async setup (B2)
    await page.waitForFunction(() => {
      return (
        typeof window.__OGSNOW_STATE__ !== 'undefined' &&
        typeof window.__OGSNOW_APP__ !== 'undefined' &&
        window.__OGSNOW_STATE__?.ready === true
      );
    });
  });

  test.afterEach(async () => {
    // Assert zero console.error and zero pageerror events occurred
    expect(
      consoleErrors,
      `Detected console.error messages during test: ${consoleErrors.join(' | ')}`
    ).toHaveLength(0);

    expect(
      pageErrors,
      `Detected pageerror exceptions during test: ${pageErrors.join(' | ')}`
    ).toHaveLength(0);

    // m5: Assert zero external outbound requests occurred during test
    expect(
      externalRequests,
      `Detected external outbound network requests during test: ${externalRequests.join(' | ')}`
    ).toHaveLength(0);
  });

  test('1. Main menu renders flagship mountain and all 3 drop zones', async ({ page }) => {
    // Verify WebGL canvas presence (M7)
    const canvas = page.locator('canvas');
    await expect(canvas).toBeVisible();

    // Verify Main Menu container is visible
    const mainMenu = page.locator('#main-menu');
    await expect(mainMenu).toBeVisible();

    // Verify flagship mountain info
    const mountainName = page.locator('.mountain-name');
    await expect(mountainName).toBeVisible();
    await expect(mountainName).toContainText('Whistler Peak');

    // Verify all 3 drop zone buttons
    const summitBtn = page.locator('[data-testid="drop-zone-btn-summit-express"]');
    const harmonyBtn = page.locator('[data-testid="drop-zone-btn-harmony-ridge"]');
    const glacierBtn = page.locator('[data-testid="drop-zone-btn-glacier-bowl"]');

    await expect(summitBtn).toBeVisible();
    await expect(summitBtn).toContainText('Peak Express Summit');
    await expect(harmonyBtn).toBeVisible();
    await expect(harmonyBtn).toContainText('Harmony Ridge');
    await expect(glacierBtn).toBeVisible();
    await expect(glacierBtn).toContainText('Glacier Creek');

    // Verify initial state is 'menu' and WebGL is active
    const state = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(state.mode).toBe('menu');
    expect(state.ready).toBe(true);
    expect(state.webglActive).toBe(true);

    // ADR-0007: Verify real terrain provenance in telemetry
    expect(state.terrain.realWorld).toBe(true);
    expect(state.terrain.maxElevation).toBeGreaterThan(2100);
    expect(state.terrain.minElevation).toBeLessThan(1600);
    expect(state.terrain.attribution).toBeDefined();
    expect(state.terrain.attribution!.length).toBeGreaterThanOrEqual(1);
    expect(state.terrain.source).toContain('aws-terrarium');

    // ADR-0007: Attribution element visible in main menu
    const attributionEl = page.locator('[data-testid="terrain-attribution"]');
    await expect(attributionEl).toBeVisible();
    await expect(attributionEl).toContainText('AWS Open Data');
  });

  test('2. Drop zone selection transitions mode to riding, loads GLB terrain, and shows HUD', async ({
    page,
  }) => {
    // Click on Peak Express Summit drop zone
    const summitBtn = page.locator('[data-testid="drop-zone-btn-summit-express"]');
    await summitBtn.click();

    // Verify state transition in window.__OGSNOW_STATE__
    await page.waitForFunction(() => window.__OGSNOW_STATE__.mode === 'riding');

    const state = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(state.mode).toBe('riding');
    expect(state.activeDropZoneId).toBe('summit-express');

    // Verify GLB terrain is loaded
    expect(state.terrain.glbLoaded).toBe(true);
    expect(state.terrain.glbByteLength).toBeGreaterThan(0);

    // Verify HUD elements are visible and displaying telemetry
    const hudOverlay = page.locator('#hud-overlay');
    await expect(hudOverlay).toBeVisible();

    const speedEl = page.locator('[data-testid="hud-speed"]');
    const altitudeEl = page.locator('[data-testid="hud-altitude"]');
    const stemsEl = page.locator('[data-testid="hud-stems"]');

    await expect(speedEl).toBeVisible();
    await expect(altitudeEl).toBeVisible();
    await expect(stemsEl).toBeVisible();

    // ADR-0007: HUD altitude reflects imported real elevation (NOT 2182)
    const altitudeText = await altitudeEl.textContent();
    const altitudeVal = parseInt(altitudeText ?? '0', 10);
    // Summit spawn is ~2152 m; altitude should be around that, not 2182
    expect(altitudeVal).toBeGreaterThan(1900);
    expect(altitudeVal).toBeLessThan(2300);
    // It must NOT be exactly 2182 (the old synthetic clamp)
    expect(altitudeVal).not.toBe(2182);

    // ADR-0007: Terrain artifacts loaded from bundled relative URLs
    // (verified by successful GLB load + manifest data present)
    expect(state.terrain.demFormatVersion).toBeDefined();
    expect(state.terrain.demFormatVersion).toBeGreaterThanOrEqual(1);
    expect(state.terrain.source).toContain('aws-terrarium');
    expect(state.terrain.attribution).toBeDefined();
    expect(state.terrain.attribution!.length).toBeGreaterThanOrEqual(1);
  });

  test('3. Downhill riding increases speed, moves downhill (+Z), transitions audio stems, and scales wind', async ({
    page,
  }) => {
    // Drop in at summit
    await page.locator('[data-testid="drop-zone-btn-summit-express"]').click();
    await page.waitForFunction(() => window.__OGSNOW_STATE__.mode === 'riding');

    // Pause rAF loop so spawn position is stable before reading
    await page.evaluate(() => {
      window.__OGSNOW_APP__?.setPaused?.(true);
    });

    const initialState = await page.evaluate(() => window.__OGSNOW_STATE__);
    // Real terrain summit-express spawn is at z ≈ 150 (not -520 from synthetic)
    expect(Math.abs(initialState.player.position.z - 150)).toBeLessThan(2);
    // altitudeMeters reflects real imported elevation (~2152 m at summit, not 2182)
    expect(initialState.player.altitudeMeters).toBeGreaterThan(1900);
    expect(initialState.player.altitudeMeters).toBeLessThan(2300);
    expect(initialState.player.altitudeMeters).not.toBe(2182);

    // Progress simulation downhill
    await page.evaluate(() => {
      // Pause live rAF loop during deterministic stepping (M4)
      window.__OGSNOW_APP__?.setPaused?.(true);
      // Step simulation for 2.0s with tucking to build momentum rapidly
      for (let i = 0; i < 40; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, { tuck: true });
      }
    });

    // Check intermediate state: speed > 20 km/h, stems include 'bass'
    const midState = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(midState.player.speedKmh).toBeGreaterThan(20);
    expect(midState.player.position.z).toBeGreaterThan(initialState.player.position.z);
    expect(midState.audio.activeStems).toContain('bass');
    expect(midState.audio.windGain).toBeGreaterThan(initialState.audio.windGain);

    // Continue downhill until high speed (>= 60 km/h) to engage Amen breakbeat drum layer
    await page.evaluate(() => {
      window.__OGSNOW_APP__?.setPaused?.(true);
      for (let i = 0; i < 80; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, { tuck: true });
      }
    });

    const fastState = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(fastState.player.speedKmh).toBeGreaterThanOrEqual(60);
    expect(fastState.audio.activeStems).toEqual(['pad', 'bass', 'drums']);
    expect(fastState.audio.drumGain).toBeGreaterThan(0.7);
    expect(fastState.audio.windGain).toBeGreaterThan(0.3);

    // Verify live HUD update reflects high speed and stems
    const speedEl = page.locator('[data-testid="hud-speed"]');
    const stemsEl = page.locator('[data-testid="hud-stems"]');
    await expect(speedEl).toContainText('km/h');
    await expect(stemsEl).toContainText('AMEN BREAKS');
  });

  test('4. Steering updates heading and carving decelerates speed while increasing carveGain', async ({
    page,
  }) => {
    // Drop in
    await page.locator('[data-testid="drop-zone-btn-summit-express"]').click();
    await page.waitForFunction(() => window.__OGSNOW_STATE__.mode === 'riding');

    // Pause rAF loop for deterministic simulation steps (M4)
    await page.evaluate(() => {
      window.__OGSNOW_APP__?.setPaused?.(true);
    });

    // Build initial speed
    await page.evaluate(() => {
      for (let i = 0; i < 30; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, {});
      }
    });

    const preSteer = await page.evaluate(() => window.__OGSNOW_STATE__);
    const initialHeading = preSteer.player.headingRad;

    // Test Right Steering: steer = +1.0 decrements headingRad (turning toward world -X / screen-right) (B1)
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, { steer: 1.0 });
      }
    });

    const postSteerRight = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(postSteerRight.player.headingRad).toBeLessThan(initialHeading);
    expect(postSteerRight.player.rollRad).toBeGreaterThan(0);

    // Test Left Steering: steer = -1.0 increments headingRad (turning toward world +X / screen-left) (B1)
    await page.evaluate(() => {
      for (let i = 0; i < 40; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, { steer: -1.0 });
      }
    });

    const postSteerLeft = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(postSteerLeft.player.headingRad).toBeGreaterThan(postSteerRight.player.headingRad);

    // Test Carving Deceleration: compare unbraked vs carved speed
    // 1. Unbraked run
    await page.evaluate(() => {
      window.__OGSNOW_APP__?.stepSimulation(0.05, { reset: true });
      for (let i = 0; i < 40; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, {});
      }
    });
    const unbrakedSpeed = (await page.evaluate(() => window.__OGSNOW_STATE__)).player.speedKmh;

    // 2. Carved run with carve = 1.0
    await page.evaluate(() => {
      window.__OGSNOW_APP__?.stepSimulation(0.05, { reset: true });
      for (let i = 0; i < 40; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, { carve: 1.0 });
      }
    });
    const carvedState = await page.evaluate(() => window.__OGSNOW_STATE__);

    expect(carvedState.player.speedKmh).toBeLessThan(unbrakedSpeed);
    expect(carvedState.player.carveIntensity).toBeGreaterThan(0.3);
    expect(carvedState.audio.carveGain).toBeGreaterThan(0);
  });

  test('5. Crash state ducks bass and drums to pad only, and recovers after crash recovery time', async ({
    page,
  }) => {
    // Drop in and accelerate to full speed
    await page.locator('[data-testid="drop-zone-btn-summit-express"]').click();
    await page.waitForFunction(() => window.__OGSNOW_STATE__.mode === 'riding');

    await page.evaluate(() => {
      window.__OGSNOW_APP__?.setPaused?.(true);
      for (let i = 0; i < 80; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, { tuck: true });
      }
    });

    const fastState = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(fastState.audio.activeStems).toEqual(['pad', 'bass', 'drums']);

    // Trigger Crash
    await page.evaluate(() => {
      window.__OGSNOW_APP__?.triggerCrashForTest();
    });

    const crashedState = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(crashedState.player.isCrashed).toBe(true);
    expect(crashedState.audio.activeStems).toEqual(['pad']);
    expect(Math.abs(crashedState.audio.bassGain)).toBeLessThan(0.01);
    expect(Math.abs(crashedState.audio.drumGain)).toBeLessThan(0.01);
    expect(Math.abs(crashedState.audio.carveGain)).toBeLessThan(0.01);

    // Verify Crash Banner is displayed in HUD
    const crashBanner = page.locator('.banner-crash');
    await expect(crashBanner).toBeVisible();

    // Advance simulation past crash recovery time (1.5 seconds = 30 steps @ 0.05s)
    await page.evaluate(() => {
      window.__OGSNOW_APP__?.setPaused?.(true);
      for (let i = 0; i < 35; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, {});
      }
    });

    const recoveredState = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(recoveredState.player.isCrashed).toBe(false);
    expect(Math.abs(recoveredState.player.crashTimerSeconds)).toBeLessThan(0.01);
    await expect(crashBanner).toBeHidden();
  });

  test('6. Return to menu button returns game mode to menu, hides HUD, and ducks audio to pad only (M3)', async ({
    page,
  }) => {
    // Drop in first
    await page.locator('[data-testid="drop-zone-btn-harmony-ridge"]').click();
    await page.waitForFunction(() => window.__OGSNOW_STATE__.mode === 'riding');

    const hudOverlay = page.locator('#hud-overlay');
    await expect(hudOverlay).toBeVisible();

    // Build speed so stems become active
    await page.evaluate(() => {
      window.__OGSNOW_APP__?.setPaused?.(true);
      for (let i = 0; i < 50; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, { tuck: true });
      }
    });

    const ridingState = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(ridingState.audio.activeStems.length).toBeGreaterThan(1);

    // Click Return to Menu
    const returnBtn = page.locator('[data-testid="btn-return-menu"]');
    await returnBtn.click();

    // Verify mode is menu
    await page.waitForFunction(() => window.__OGSNOW_STATE__.mode === 'menu');
    const state = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(state.mode).toBe('menu');

    // M3: Verify audio ducked to ['pad'] only with bassGain = 0 and drumGain = 0
    expect(state.audio.activeStems).toEqual(['pad']);
    expect(Math.abs(state.audio.bassGain)).toBeLessThan(0.01);
    expect(Math.abs(state.audio.drumGain)).toBeLessThan(0.01);

    // Main menu visible, HUD hidden
    await expect(page.locator('#main-menu')).toBeVisible();
    await expect(hudOverlay).toBeHidden();
  });

  test('7. Real keyboard input steers rider and spacebar is safe after clicking mute button (M1, M5)', async ({
    page,
  }) => {
    // Drop in at summit
    await page.locator('[data-testid="drop-zone-btn-summit-express"]').click();
    await expect(page.locator('#main-menu')).toBeHidden();
    await expect(page.locator('#hud-overlay')).toBeVisible();

    // Ensure live simulation is unpaused so real DOM keyboard events are integrated by rAF loop (M5)
    await page.evaluate(() => {
      window.__OGSNOW_APP__?.setPaused?.(false);
    });

    // Let rider roll for a brief moment to get non-zero forward speed
    await page.waitForTimeout(200);

    const initialHeading = (await page.evaluate(() => window.__OGSNOW_STATE__)).player.headingRad;

    // Test real keyboard input for steering right (M5)
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(300);
    await page.keyboard.up('ArrowRight');

    const rightState = await page.evaluate(() => window.__OGSNOW_STATE__);
    // steer = +1 decrements headingRad towards world -X
    expect(rightState.player.headingRad).toBeLessThan(initialHeading);
    expect(rightState.player.velocity.x).toBeLessThan(0);

    // Test real keyboard input for steering left (M5)
    await page.keyboard.down('ArrowLeft');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowLeft');

    const leftState = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(leftState.player.headingRad).toBeGreaterThan(rightState.player.headingRad);

    // Test Button Focus / Spacebar safety after clicking mute button (M1)
    const muteBtn = page.locator('[data-testid="btn-mute-audio"]');
    await muteBtn.click();

    let state = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(state.audio.isMuted).toBe(true);

    // Verify mute button is blurred after click
    const isMuteFocused = await muteBtn.evaluate((el) => document.activeElement === el);
    expect(isMuteFocused).toBe(false);

    // Press Space key (jump) — should NOT toggle mute button
    await page.keyboard.press('Space');
    state = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(state.audio.isMuted).toBe(true);

    // Click mute button again to unmute
    await muteBtn.click();
    state = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(state.audio.isMuted).toBe(false);
  });
});
