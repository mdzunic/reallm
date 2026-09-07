// The shared start helper (SPEC-002 §6.2, D-K). SPEC-002 puts a gate in front
// of the game — the gesture that unlocks audio, takes the wake lock and, on
// Android, goes fullscreen (E21) — so `page.goto('/')` no longer lands in a
// scene. Every suite passes through here instead, and no existing assertion had
// to be weakened for it.
import { expect, type Page } from '@playwright/test';

/** The dev-only bridge of SPEC-002 §3.11 (dev builds only). */
export interface DevBridge {
  go(id: string, params: unknown, opts?: { force?: boolean }): Promise<boolean>;
  scene(): string | null;
  memory(): { geometries: number; textures: number };
  stats(): StatsSnapshot;
  /** The live `Input.state` (SPEC-005 §3); the object is mutated in place. */
  input(): InputSnapshot;
  trace(): string[];
  loseContext(restoreAfterMs: number | null): void;
  stop(): void;
}

/** The part of `InputState` the suites assert on (SPEC-005 §3). */
export interface InputSnapshot {
  move: { x: number; y: number };
  aim: { dragging: boolean; dirX: number; dirY: number; hasPointer: boolean };
  buttons: Record<string, { down: boolean; justPressed: boolean; justReleased: boolean; heldFor: number }>;
  scheme: string;
  autoFire: boolean;
}

export interface StatsSnapshot {
  fps: number;
  frameMs: number;
  updates: number;
  droppedTime: number;
  frame: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  preset: string;
  dpr: number;
  deviceDpr: number;
  width: number;
  height: number;
  scene: string | null;
  sceneInfo: Record<string, number | string> | null;
  state: string;
}

declare global {
  interface Window {
    __reallm: DevBridge;
  }
}

/** Waits for the manifest to finish loading, which is when the gate appears. */
export async function awaitGate(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="boot-start"]')).toBeVisible();
}

/** Waits for the gate, then passes it with a click on TAP TO START. */
export async function passGate(page: Page): Promise<void> {
  await awaitGate(page);
  await page.locator('[data-testid="boot-start"]').click();
  await expect(page.locator('[data-testid="boot-overlay"]')).toBeHidden();
}

/**
 * Navigate, pass the gate, and wait until a scene is on screen and its
 * transition has settled — the fade still runs after the label appears
 * (SPEC-003 AC-14), and a `go()` issued during it would be refused (D-2).
 */
export async function start(page: Page, url = '/'): Promise<void> {
  await page.goto(url);
  await passGate(page);
  await expect(page.locator('[data-testid="scene-label"]')).toBeVisible();
  await expect(page.locator('[data-testid="transition-fade"]')).toHaveCSS('pointer-events', 'none');
}

/**
 * A synthetic `visibilitychange`; a real one needs a second tab. Shared because
 * both the lifecycle suite and the context-loss suite hide the page.
 */
export async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((value) => {
    Object.defineProperty(document, 'hidden', { value, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

/** Resolve after `count` animation frames have been rendered. */
export async function frames(page: Page, count = 2): Promise<void> {
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }, count);
}
