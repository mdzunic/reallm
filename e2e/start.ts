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
  /** SPEC-007's slot store, for the M1 acceptance suite (§7). */
  save(): SaveBridge;
  trace(): string[];
  loseContext(restoreAfterMs: number | null): void;
  stop(): void;
}

/**
 * The part of `SaveStore` the suites drive (SPEC-007 §3). `SaveV1` itself stays
 * loose here: `e2e/` may not import `src/`, and the suites only ever read the
 * two or three fields they assert on.
 */
export interface SaveBridge {
  readonly available: boolean;
  /** 07-f: false where the browser has no `CompressionStream` (SPEC-007 §4.6). */
  readonly codesSupported: boolean;
  /** 07-a: true once another tab has written this slot (SPEC-007 §4.5). */
  readonly refusingAutosaves: boolean;
  list(): Array<{
    slot: number;
    empty: boolean;
    name?: string;
    classId?: string;
    level?: number;
    planet?: string | null;
    playtimeSec?: number;
    updatedAt?: number;
    corrupt?: boolean;
  }>;
  load(slot: number): { ok: boolean; source?: string; reason?: string; foundVersion?: number; data?: SaveSnapshot };
  create(slot: number, creation: unknown, seed?: number): SaveSnapshot;
  /** §4.5: a debounced autosave; `manual` and `pagehide` skip the debounce. */
  request(reason: string): void;
  addPlaytime(seconds: number): void;
  flush(): boolean;
  delete(slot: number): void;
  exportCode(slot: number): Promise<string>;
  importCode(
    code: string,
    slot: number,
  ): Promise<{ ok: boolean; reason?: string; foundVersion?: number; data?: SaveSnapshot }>;
}

export interface SaveSnapshot {
  version: number;
  meta: { slot: number; seed: number; playtimeSec: number; updatedAt: number; iteration: number; difficulty: string };
  player: {
    name: string;
    classId: string;
    level: number;
    xp: number;
    tokens: number;
    hp: number;
    attributes: Record<string, number>;
  };
  resources: Record<string, number>;
  inventory: Array<{ itemId: string; qty: number }>;
  equipped: { weapon: string; armor: string };
  ship: Record<string, number>;
  companions: Array<{ id: string; level: number; enabled: boolean }>;
  progress: {
    missionsDone: string[];
    missionsActive: Array<{ id: string; stage: number; counters: Record<string, number> }>;
    flags: string[];
    currentPlanet: string | null;
    location: string;
    poisDiscovered: string[];
    visits: Record<string, number>;
    endingSeen: boolean;
  };
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
  /** SPEC-007 §4.7: `null` until `navigator.storage.persist()` has answered. */
  persistGranted: boolean | null;
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
