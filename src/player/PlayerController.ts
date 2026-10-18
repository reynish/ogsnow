import { PlayerInput } from '../types';

export class PlayerController {
  private target: Window | HTMLElement | null = null;
  private keyStates: Map<string, boolean> = new Map();
  private override: Partial<PlayerInput> | null = null;
  private onKeyDownBound: (e: KeyboardEvent) => void;
  private onKeyUpBound: (e: KeyboardEvent) => void;
  private onBlurBound: () => void;

  constructor(targetElement?: Window | HTMLElement) {
    if (targetElement) {
      this.target = targetElement;
    } else if (typeof window !== 'undefined') {
      this.target = window;
    }

    this.onKeyDownBound = this.handleKeyDown.bind(this);
    this.onKeyUpBound = this.handleKeyUp.bind(this);
    this.onBlurBound = this.handleBlur.bind(this);

    if (this.target && typeof this.target.addEventListener === 'function') {
      this.target.addEventListener('keydown', this.onKeyDownBound as EventListener);
      this.target.addEventListener('keyup', this.onKeyUpBound as EventListener);
      this.target.addEventListener('blur', this.onBlurBound as EventListener);
    }
  }

  public getInput(): PlayerInput {
    // 1. Gather raw keyboard input
    const leftPressed = this.isPressed('KeyA') || this.isPressed('ArrowLeft');
    const rightPressed = this.isPressed('KeyD') || this.isPressed('ArrowRight');
    let steer = 0;
    if (leftPressed && !rightPressed) {
      steer = -1.0;
    } else if (rightPressed && !leftPressed) {
      steer = 1.0;
    }

    const carvePressed = this.isPressed('KeyS') || this.isPressed('ArrowDown');
    const carve = carvePressed ? 1.0 : 0.0;

    const tuck = this.isPressed('KeyW') || this.isPressed('ArrowUp');
    const jump = this.isPressed('Space');
    const reset = this.isPressed('KeyR');

    let input: PlayerInput = { steer, carve, tuck, jump, reset };

    // 2. Poll Gamepad API if available
    const gamepadInput = this.pollGamepad();
    if (gamepadInput) {
      if (gamepadInput.steer !== undefined && Math.abs(gamepadInput.steer) > 0.01) {
        input.steer = gamepadInput.steer;
      }
      if (gamepadInput.carve !== undefined && gamepadInput.carve > 0) {
        input.carve = Math.max(input.carve, gamepadInput.carve);
      }
      if (gamepadInput.tuck) {
        input.tuck = true;
      }
      if (gamepadInput.jump) {
        input.jump = true;
      }
      if (gamepadInput.reset) {
        input.reset = true;
      }
    }

    // 3. Apply programmatic overrides (e.g. for Vitest, Playwright, automated tests)
    if (this.override) {
      input = {
        steer: this.override.steer !== undefined ? this.override.steer : input.steer,
        carve: this.override.carve !== undefined ? this.override.carve : input.carve,
        tuck: this.override.tuck !== undefined ? this.override.tuck : input.tuck,
        jump: this.override.jump !== undefined ? this.override.jump : input.jump,
        reset: this.override.reset !== undefined ? this.override.reset : input.reset,
      };
    }

    return input;
  }

  public setOverride(override: Partial<PlayerInput> | null): void {
    this.override = override ? { ...override } : null;
  }

  public clearResetFlag(): void {
    this.keyStates.set('KeyR', false);
    if (this.override && this.override.reset !== undefined) {
      this.override.reset = false;
    }
  }

  public dispose(): void {
    if (this.target && typeof this.target.removeEventListener === 'function') {
      this.target.removeEventListener('keydown', this.onKeyDownBound as EventListener);
      this.target.removeEventListener('keyup', this.onKeyUpBound as EventListener);
      this.target.removeEventListener('blur', this.onBlurBound as EventListener);
    }
    this.keyStates.clear();
    this.override = null;
    this.target = null;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    this.keyStates.set(e.code, true);
  }

  private handleKeyUp(e: KeyboardEvent): void {
    this.keyStates.set(e.code, false);
  }

  private handleBlur(): void {
    this.keyStates.clear();
  }

  private isPressed(code: string): boolean {
    return this.keyStates.get(code) === true;
  }

  private pollGamepad(): Partial<PlayerInput> | null {
    if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
      return null;
    }

    const gamepads = navigator.getGamepads();
    if (!gamepads) return null;

    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp || !gp.connected) continue;

      let steer = 0;
      // Analog Stick X
      if (gp.axes && gp.axes.length > 0) {
        const rawAxis = gp.axes[0];
        if (Math.abs(rawAxis) > 0.15) {
          steer = rawAxis;
        }
      }

      // D-pad Left / Right (standard gamepad mapping buttons 14 and 15)
      if (gp.buttons && gp.buttons.length > 15) {
        if (gp.buttons[14]?.pressed) steer = -1.0;
        if (gp.buttons[15]?.pressed) steer = 1.0;
      }

      // Carve: Trigger LT / L2 (button 6) or B button (button 1)
      let carve = 0;
      if (gp.buttons && gp.buttons.length > 6) {
        const trigger = gp.buttons[6];
        if (trigger) {
          carve = typeof trigger.value === 'number' ? trigger.value : trigger.pressed ? 1.0 : 0.0;
        }
      }
      if (gp.buttons && gp.buttons[1]?.pressed) {
        carve = 1.0;
      }

      // Tuck: RT / R2 (button 7) or Up on stick/D-pad (button 12)
      let tuck = false;
      if (gp.buttons && gp.buttons[7]?.pressed) tuck = true;
      if (gp.buttons && gp.buttons[12]?.pressed) tuck = true;
      if (gp.axes && gp.axes.length > 1 && gp.axes[1] < -0.5) tuck = true;

      // Jump: Button A (button 0)
      const jump = gp.buttons && gp.buttons[0]?.pressed === true;

      // Reset: Button Y (button 3) or Select / Back (button 8)
      const reset =
        gp.buttons && (gp.buttons[3]?.pressed === true || gp.buttons[8]?.pressed === true);

      return { steer, carve, tuck, jump, reset };
    }

    return null;
  }
}
