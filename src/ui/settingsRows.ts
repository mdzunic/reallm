// The settings panel's row table (SPEC-045 §4.2). Pure — no DOM — so the
// node suite can hold the panel to two promises: every stored setting has a
// control or is named bookkeeping (two options once went without a control
// because nothing checked), and every row's testid follows one rule.
//
// The rule: a toggle or a slider is `settings-<kebab(key)>`, and a choice row
// is the group `settings-<kebab(key)>` holding `settings-<kebab(key)>-<suffix>`
// — a string value is its own suffix, a scale's is its percentage, a frame
// rate's its number. Kept as they were: `settings-mouse-steer`, `settings-service`
// and SPEC-040's `settings-framerate-<n>`. Buttons keep their own names.
//
// Six sections, in the order players look (§2); the rows follow the scheme —
// a desktop has no joystick and a phone no mouse (§2).
import type { Scheme } from '@/core/Input';
import type { Settings } from '@/core/Settings';

export type SettingsSection = 'audio' | 'display' | 'controls' | 'accessibility' | 'gameplay' | 'data';

export const SETTINGS_SECTIONS: readonly { readonly id: SettingsSection; readonly title: string }[] = [
  { id: 'audio', title: 'Audio' },
  { id: 'display', title: 'Display' },
  { id: 'controls', title: 'Controls' },
  { id: 'accessibility', title: 'Accessibility' },
  { id: 'gameplay', title: 'Gameplay' },
  { id: 'data', title: 'Data' },
];

/**
 * When a row is shown: `keyboard` covers the gamepad too; `touch-vibrate` is
 * the touch scheme where `navigator.vibrate` exists (SPEC-042); `fullscreen`
 * where `document.fullscreenEnabled`; `save` while a save is bound;
 * `service` while the service override is on (SPEC-032).
 */
export type RowShown = 'always' | 'keyboard' | 'touch' | 'touch-vibrate' | 'fullscreen' | 'save' | 'service';

export interface SettingsChoice {
  readonly value: string | number;
  readonly label: string;
  readonly suffix: string;
}

export interface SettingsRowDef {
  /** The testid — the group's, for a choice row. */
  readonly id: string;
  /** `null` for buttons and status lines. */
  readonly key: keyof Settings | 'difficulty' | null;
  readonly section: SettingsSection;
  readonly label: string;
  readonly control: 'slider' | 'toggle' | 'choice' | 'button' | 'status' | 'block';
  readonly choices?: readonly SettingsChoice[];
  /** Default `'always'`. */
  readonly shown?: RowShown;
  /** A `p.settings-note` under the row. */
  readonly note?: string;
  /** The note on the touch scheme, where its words differ (the touch scheme has no Enter). */
  readonly touchNote?: string;
}

/** What `visibleRows` decides on; the panel reads it on every render. */
export interface RowEnv {
  scheme: Scheme;
  vibrate: boolean;
  fullscreen: boolean;
  saveBound: boolean;
  serviceMode: boolean;
}

/** `'invertFlightY'` → `'invert-flight-y'`: the testid form of a settings key. */
export function kebab(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** A choice per value, suffixed by the value itself. */
function named(...pairs: readonly (readonly [string, string])[]): SettingsChoice[] {
  return pairs.map(([value, label]) => ({ value, label, suffix: value }));
}

/** A choice per scale, suffixed and labelled by its percentage (`1.15` → `115`, `115 %`). */
function scales(...values: readonly number[]): SettingsChoice[] {
  return values.map((value) => {
    const percent = String(Math.round(value * 100));
    return { value, label: `${percent} %`, suffix: percent };
  });
}

/** SPEC-005 / SPEC-029: the three modes `autoFire` and `weaponAutoSwap` share. */
const ON_OFF_TOUCH = named(['on', 'On'], ['off', 'Off'], ['touch', 'Touch only']);

/** §4.2's table, in order. "New" in a comment marks a control this spec adds. */
export const SETTINGS_ROWS: readonly SettingsRowDef[] = [
  // ------------------------------------------------------------------ Audio
  { id: 'settings-master', key: 'master', section: 'audio', label: 'Master', control: 'slider' },
  { id: 'settings-music', key: 'music', section: 'audio', label: 'Music', control: 'slider' },
  { id: 'settings-sfx', key: 'sfx', section: 'audio', label: 'Effects', control: 'slider' },
  // New: the `ui_*` sounds' own bus (§4.9).
  { id: 'settings-volume-interface', key: 'volumeInterface', section: 'audio', label: 'Interface', control: 'slider' },
  // New (§4.9).
  { id: 'settings-mono', key: 'mono', section: 'audio', label: 'Mono audio', control: 'toggle' },
  // SPEC-042 §4.10: only where haptics can fire.
  { id: 'settings-haptics', key: 'haptics', section: 'audio', label: 'Vibration', control: 'toggle', shown: 'touch-vibrate' },

  // ---------------------------------------------------------------- Display
  // With `settings-redetect` and `settings-benchmark` (SPEC-015 §4.7).
  {
    id: 'settings-quality',
    key: 'quality',
    section: 'display',
    label: 'Quality',
    control: 'choice',
    choices: named(['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']),
  },
  // SPEC-040 §4.3, with its testids.
  {
    id: 'settings-framerate',
    key: 'frameRate',
    section: 'display',
    label: 'Frame rate',
    control: 'choice',
    choices: [
      { value: 60, label: '60', suffix: '60' },
      { value: 30, label: '30', suffix: '30' },
    ],
  },
  { id: 'settings-adaptive-quality', key: 'adaptiveQuality', section: 'display', label: 'Adaptive quality', control: 'toggle' },
  // SPEC-046 §4.7.
  {
    id: 'settings-sharp-render',
    key: 'sharpRender',
    section: 'display',
    label: 'Sharp rendering',
    control: 'toggle',
    note: 'Medium quality at up to 2× resolution. Uses more battery.',
  },
  // New: −30 … +30 %, in steps of 5 (§4.9).
  { id: 'settings-brightness', key: 'brightness', section: 'display', label: 'Brightness', control: 'slider' },
  { id: 'settings-fullscreen', key: 'fullscreen', section: 'display', label: 'Fullscreen', control: 'toggle', shown: 'fullscreen' },
  { id: 'settings-show-fps', key: 'showFps', section: 'display', label: 'Show FPS', control: 'toggle' },

  // --------------------------------------------------------------- Controls
  // SPEC-044 §4.5: the controls sheet opens the section.
  { id: 'settings-controls', key: null, section: 'controls', label: 'Controls', control: 'button' },
  { id: 'settings-auto-fire', key: 'autoFire', section: 'controls', label: 'Auto-fire', control: 'choice', choices: ON_OFF_TOUCH },
  // New: SPEC-029's sidearm fallback, stored but without a control until now.
  {
    id: 'settings-weapon-auto-swap',
    key: 'weaponAutoSwap',
    section: 'controls',
    label: 'Weapon fallback',
    control: 'choice',
    choices: ON_OFF_TOUCH,
  },
  {
    id: 'settings-mouse-steer',
    key: 'flightMouseSteer',
    section: 'controls',
    label: 'Mouse steer (flight)',
    control: 'toggle',
    shown: 'keyboard',
  },
  // New (§4.9).
  { id: 'settings-invert-flight-y', key: 'invertFlightY', section: 'controls', label: 'Invert flight up / down', control: 'toggle' },
  // SPEC-036 §4.5.
  {
    id: 'settings-pause-on-blur',
    key: 'pauseOnBlur',
    section: 'controls',
    label: 'Pause when the game loses focus',
    control: 'toggle',
  },
  // SPEC-050 §4.5: a Shift press toggles the run instead of holding it…
  { id: 'settings-sprint-toggle', key: 'sprintToggle', section: 'controls', label: 'Run toggle', control: 'toggle', shown: 'keyboard' },
  // …and the stick pushed past its ring runs.
  { id: 'settings-stick-sprint', key: 'stickSprint', section: 'controls', label: 'Run with the stick', control: 'toggle', shown: 'touch' },
  {
    id: 'settings-joystick-side',
    key: 'joystickSide',
    section: 'controls',
    label: 'Joystick side',
    control: 'choice',
    choices: named(['left', 'Left'], ['right', 'Right']),
    shown: 'touch',
  },
  // New: SPEC-005's `buttonScale`, stored but without a control until now.
  {
    id: 'settings-button-scale',
    key: 'buttonScale',
    section: 'controls',
    label: 'Button size',
    control: 'choice',
    choices: scales(1, 1.25, 1.5),
    shown: 'touch',
  },

  // ---------------------------------------------------------- Accessibility
  // New (§4.4).
  {
    id: 'settings-text-scale',
    key: 'textScale',
    section: 'accessibility',
    label: 'Text size',
    control: 'choice',
    choices: scales(1, 1.2, 1.4),
  },
  // New (§4.4): the phone layout is sized to its screen.
  {
    id: 'settings-ui-scale',
    key: 'uiScale',
    section: 'accessibility',
    label: 'UI scale',
    control: 'choice',
    choices: scales(1, 1.15, 1.3, 1.5),
    shown: 'keyboard',
  },
  {
    id: 'settings-reduce-motion',
    key: 'reduceMotion',
    section: 'accessibility',
    label: 'Reduce motion',
    control: 'toggle',
    note: 'Also sets camera shake, damage flash, films and typewriter text.',
  },
  // SPEC-037 §4.6.
  {
    id: 'settings-damage-flash',
    key: 'damageFlash',
    section: 'accessibility',
    label: 'Damage flash',
    control: 'choice',
    choices: named(['full', 'Full'], ['subtle', 'Subtle'], ['off', 'Off']),
  },
  // New (§4.3).
  {
    id: 'settings-camera-shake',
    key: 'cameraShake',
    section: 'accessibility',
    label: 'Camera shake',
    control: 'choice',
    choices: [
      { value: 0, label: 'Off', suffix: '0' },
      { value: 0.5, label: 'Half', suffix: '50' },
      { value: 1, label: 'Full', suffix: '100' },
    ],
  },
  // New (§4.3).
  {
    id: 'settings-film-mode',
    key: 'filmMode',
    section: 'accessibility',
    label: 'Films',
    control: 'choice',
    choices: named(['video', 'Video'], ['stills', 'Stills']),
  },
  // New (§4.3).
  { id: 'settings-typewriter', key: 'typewriter', section: 'accessibility', label: 'Typewriter text', control: 'toggle' },
  // New (§4.1).
  {
    id: 'settings-dialogue-speed',
    key: 'dialogueSpeed',
    section: 'accessibility',
    label: 'Dialogue speed',
    control: 'choice',
    choices: named(['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast'], ['manual', 'Manual']),
    note: 'Manual: story lines wait for Enter or ›.',
    touchNote: 'Manual: story lines wait for ›.',
  },
  // New (§4.5).
  { id: 'settings-plain-text', key: 'plainText', section: 'accessibility', label: 'Plain text', control: 'toggle' },
  // New (§4.5).
  {
    id: 'settings-colour-preset',
    key: 'colourPreset',
    section: 'accessibility',
    label: 'Colours',
    control: 'choice',
    choices: named(['standard', 'Standard'], ['colour-blind', 'Colour-blind']),
    note: 'Good is blue, danger is orange, and hostiles glow magenta.',
  },

  // --------------------------------------------------------------- Gameplay
  // SPEC-038 §4.6 and SPEC-043 §4.4, in the creation screen's order, with
  // `DIFFICULTY_LINES` under it. It writes the save, not the settings.
  // SPEC-059 §4.2.3: `Story` is the first segment, and the rest run easiest
  // to hardest, in `DIFFICULTIES` order (review 2026-10 P-09).
  {
    id: 'settings-difficulty',
    key: 'difficulty',
    section: 'gameplay',
    label: 'Difficulty',
    control: 'choice',
    choices: named(['story', 'Story'], ['casual', 'Casual'], ['normal', 'Normal'], ['hard', 'Hard']),
    shown: 'save',
  },
  // SPEC-027 §4.9.
  {
    id: 'settings-guidance',
    key: 'guidance',
    section: 'gameplay',
    label: 'Guidance',
    control: 'choice',
    choices: named(['full', 'Full'], ['minimal', 'Minimal'], ['off', 'Off']),
  },
  { id: 'settings-reset-tips', key: null, section: 'gameplay', label: 'First-time tips', control: 'button' },

  // ------------------------------------------------------------------- Data
  // SPEC-040 §4.7's status line.
  { id: 'settings-offline', key: null, section: 'data', label: 'Offline data', control: 'status' },
  { id: 'settings-backup', key: null, section: 'data', label: 'Backup', control: 'block' },
  { id: 'settings-reset', key: null, section: 'data', label: 'Reset', control: 'block' },
  // SPEC-032 §4.8: only while the override is on.
  { id: 'settings-service', key: 'serviceMode', section: 'data', label: 'Service', control: 'toggle', shown: 'service' },
];

/**
 * §4.2: the settings with no control — what the game itself records. Every
 * other key of `defaultSettings()` has a row (`tests/ui/settings.test.ts`).
 */
export const BOOKKEEPING_KEYS: readonly (keyof Settings)[] = [
  'version',
  'lastSlot',
  'persistGranted',
  'installHintShownAt',
  'benchmark',
  'tipsSeen',
  'zonesShown',
  'bestTimes',
  // SPEC-056 §4.6: the swatches the caves unlocked — the Locker reads them.
  'unlocks',
  // SPEC-059 §4.4.2, §4.6.5: the commendations this device earned, and
  // whether the app is installed — the Records panel and the install toast read them.
  'commendations',
  'installed',
];

function shownIn(row: SettingsRowDef, env: RowEnv): boolean {
  switch (row.shown ?? 'always') {
    case 'always':
      return true;
    case 'keyboard':
      // The gamepad scheme reads as the keyboard (PLAN R18 decision 12).
      return env.scheme !== 'touch';
    case 'touch':
      return env.scheme === 'touch';
    case 'touch-vibrate':
      return env.scheme === 'touch' && env.vibrate;
    case 'fullscreen':
      return env.fullscreen;
    case 'save':
      return env.saveBound;
    case 'service':
      return env.serviceMode;
  }
}

/** The rows `env` shows, in table order. */
export function visibleRows(env: RowEnv): readonly SettingsRowDef[] {
  return SETTINGS_ROWS.filter((row) => shownIn(row, env));
}

/** The note under `row` on `scheme`, or `null`. */
export function rowNote(row: SettingsRowDef, scheme: Scheme): string | null {
  if (scheme === 'touch' && row.touchNote !== undefined) return row.touchNote;
  return row.note ?? null;
}
