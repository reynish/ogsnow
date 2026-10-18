import { test, expect } from '@playwright/test';

test.describe('ogSnow Downhill Freeride — E2E Browser Verification (ADR-0005)', () => {
  let consoleErrors: string[] = [];
  let pageErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    consoleErrors = [];
    pageErrors = [];

    // Capture all console.error and pageerror events before navigation
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.goto('/');

    // Wait until GameApp initializes window.__OGSNOW_STATE__ and window.__OGSNOW_APP__
    await page.waitForFunction(() => {
      return (
        typeof window.__OGSNOW_STATE__ !== 'undefined' &&
        typeof window.__OGSNOW_APP__ !== 'undefined'
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
  });

  test('1. Main menu renders flagship mountain and all 3 drop zones', async ({ page }) => {
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

    // Verify initial state is 'menu'
    const state = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(state.mode).toBe('menu');
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
  });

  test('3. Downhill riding increases speed, moves downhill (+Z), transitions audio stems, and scales wind', async ({
    page,
  }) => {
    // Drop in at summit
    await page.locator('[data-testid="drop-zone-btn-summit-express"]').click();
    await page.waitForFunction(() => window.__OGSNOW_STATE__.mode === 'riding');

    const initialState = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(initialState.player.position.z).toBeCloseTo(-520, 0);

    // Progress simulation downhill
    await page.evaluate(() => {
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

    // Build initial speed
    await page.evaluate(() => {
      for (let i = 0; i < 30; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, {});
      }
    });

    const preSteer = await page.evaluate(() => window.__OGSNOW_STATE__);
    const initialHeading = preSteer.player.headingRad;

    // Test Right Steering
    await page.evaluate(() => {
      for (let i = 0; i < 20; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, { steer: 1.0 });
      }
    });

    const postSteerRight = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(postSteerRight.player.headingRad).toBeGreaterThan(initialHeading);
    expect(postSteerRight.player.rollRad).toBeGreaterThan(0);

    // Test Left Steering
    await page.evaluate(() => {
      for (let i = 0; i < 40; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, { steer: -1.0 });
      }
    });

    const postSteerLeft = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(postSteerLeft.player.headingRad).toBeLessThan(postSteerRight.player.headingRad);

    // Test Carving Deceleration: compare unbraked vs carved speed
    // 1. Unbraked run
    await page.evaluate(() => {
      const dz = window.__OGSNOW_STATE__.activeDropZoneId;
      window.__OGSNOW_APP__?.dropIn(dz);
      for (let i = 0; i < 40; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, {});
      }
    });
    const unbrakedSpeed = (await page.evaluate(() => window.__OGSNOW_STATE__)).player.speedKmh;

    // 2. Carved run with carve = 1.0
    await page.evaluate(() => {
      const dz = window.__OGSNOW_STATE__.activeDropZoneId;
      window.__OGSNOW_APP__?.dropIn(dz);
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
    expect(crashedState.audio.bassGain).toBe(0);
    expect(crashedState.audio.drumGain).toBe(0);
    expect(crashedState.audio.carveGain).toBe(0);

    // Verify Crash Banner is displayed in HUD
    const crashBanner = page.locator('.banner-crash');
    await expect(crashBanner).toBeVisible();

    // Advance simulation past crash recovery time (1.5 seconds = 30 steps @ 0.05s)
    await page.evaluate(() => {
      for (let i = 0; i < 35; i++) {
        window.__OGSNOW_APP__?.stepSimulation(0.05, {});
      }
    });

    const recoveredState = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(recoveredState.player.isCrashed).toBe(false);
    expect(recoveredState.player.crashTimerSeconds).toBe(0);
    await expect(crashBanner).toBeHidden();
  });

  test('6. Return to menu button returns game mode to menu and hides HUD', async ({
    page,
  }) => {
    // Drop in first
    await page.locator('[data-testid="drop-zone-btn-harmony-ridge"]').click();
    await page.waitForFunction(() => window.__OGSNOW_STATE__.mode === 'riding');

    const hudOverlay = page.locator('#hud-overlay');
    await expect(hudOverlay).toBeVisible();

    // Click Return to Menu
    const returnBtn = page.locator('[data-testid="btn-return-menu"]');
    await returnBtn.click();

    // Verify mode is menu
    await page.waitForFunction(() => window.__OGSNOW_STATE__.mode === 'menu');
    const state = await page.evaluate(() => window.__OGSNOW_STATE__);
    expect(state.mode).toBe('menu');

    // Main menu visible, HUD hidden
    await expect(page.locator('#main-menu')).toBeVisible();
    await expect(hudOverlay).toBeHidden();
  });
});
