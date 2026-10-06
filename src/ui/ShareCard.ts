// The Selection card's picture and its share (SPEC-059 §4.5.3, §4.5.4). The
// model and the text are `systems/Share.ts`; this draws the model once on a
// 1200 × 630 2D canvas, in the game's monospace stack and palette, into a PNG
// `File`, and hands it to the phone's share sheet.
//
// The card is pre-rendered, and its button waits for it (§2): Safari only
// shares inside the gesture, and `toBlob` is asynchronous, so the click
// handler must reach `navigator.share` with nothing awaited before it. Where
// a browser cannot share files (desktop Firefox, 59-k), the press downloads
// the PNG and copies the text instead. The portraits are on the game's own
// origin, so the canvas is never tainted; a missing one draws its glyph (59-l).
import type { Save } from '@/core/Save';
import type { Settings } from '@/core/Settings';
import { RECORDS } from '@/systems/Records';
import {
  SHARE_CARD_HEIGHT,
  SHARE_CARD_WIDTH,
  SHARE_FILE_NAME,
  shareCardModel,
  shareText,
  type CardStamp,
  type ShareCardModel,
} from '@/systems/Share';
import { h, testId, type UiRoot } from '@/ui/dom';
import { portraitManifest, portraitSource } from '@/ui/portraits';

export interface PreparedCard {
  /** Resolves true once `file` is set, false when the canvas or `toBlob` failed. */
  readonly ready: Promise<boolean>;
  readonly file: File | null;
  readonly text: string;
}

/** §4.5.4: the fallback's toast, after the download and the clipboard write. */
export const SHARE_SAVED_TEXT = 'Card saved. The link is on your clipboard.';
/** …and when the clipboard refused, or there is none. */
export const SHARE_SAVED_NO_CLIPBOARD_TEXT = 'Card saved.';

/** The game's monospace stack (`src/style.css`). */
const FONT = "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, monospace";
/** §4.5.3: the field, inside the border's inset. */
const FIELD = '#0b0f14';
const INSET = 24;
const PORTRAIT_SIZE = 300;
const PORTRAIT_FRAME = 6;
const PORTRAIT_X = 70;
const PORTRAIT_Y = (SHARE_CARD_HEIGHT - PORTRAIT_SIZE) / 2;
const COLUMN_X = 430;
const MARGIN_RIGHT = 56;
/** The revoke waits this long after the download's click (§4.5.4). */
const REVOKE_MS = 10_000;

/** The palette's custom properties, each with the value `src/style.css` gives it. */
const PALETTE = {
  '--frame-edge': 'rgba(118, 158, 198, 0.5)',
  '--accent': '#4c9aff',
  '--ink': '#e6edf3',
  '--ink-dim': '#8a97a3',
  '--warn': '#f5a623',
  '--good': '#46c973',
  '--danger': '#e5484d',
  '--panel': '#111820',
} as const;
type PaletteKey = keyof typeof PALETTE;

/** The page's value of `name` — the colour-blind preset's, when it is on — or the stylesheet's. */
function colour(name: PaletteKey): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? PALETTE[name] : value;
}

const STAMP_COLOURS: Readonly<Record<CardStamp, PaletteKey>> = {
  SELECTED: '--good',
  DISCONNECTED: '--danger',
  'IN SERVICE': '--accent',
};

/** The portrait's glyph — what an empty manifest gives every index. */
function glyphFor(index: number): string {
  const source = portraitSource(index, new Set());
  return source.kind === 'glyph' ? source.glyph : '?';
}

/** The portrait as a decoded image, or its glyph for a glyph source or a file that would not decode (59-l). */
async function portraitImage(index: number): Promise<{ image: HTMLImageElement | null; glyph: string }> {
  const source = portraitSource(index, await portraitManifest());
  if (source.kind === 'glyph') return { image: null, glyph: source.glyph };
  const image = new Image();
  image.src = source.url;
  try {
    await image.decode();
    return { image, glyph: glyphFor(index) };
  } catch {
    return { image: null, glyph: glyphFor(index) };
  }
}

/** §4.5.3: the whole card on `ctx`. */
async function drawCard(ctx: CanvasRenderingContext2D, model: ShareCardModel): Promise<void> {
  const width = SHARE_CARD_WIDTH;
  const height = SHARE_CARD_HEIGHT;
  ctx.fillStyle = FIELD;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = colour('--frame-edge');
  ctx.lineWidth = 2;
  ctx.strokeRect(INSET + 1, INSET + 1, width - 2 * INSET - 2, height - 2 * INSET - 2);

  // The portrait, in a 6 px frame of the suit's primary colour.
  ctx.fillStyle = model.primary;
  ctx.fillRect(PORTRAIT_X - PORTRAIT_FRAME, PORTRAIT_Y - PORTRAIT_FRAME, PORTRAIT_SIZE + 2 * PORTRAIT_FRAME, PORTRAIT_SIZE + 2 * PORTRAIT_FRAME);
  ctx.fillStyle = colour('--panel');
  ctx.fillRect(PORTRAIT_X, PORTRAIT_Y, PORTRAIT_SIZE, PORTRAIT_SIZE);
  const { image, glyph } = await portraitImage(model.portrait);
  if (image !== null) {
    ctx.drawImage(image, PORTRAIT_X, PORTRAIT_Y, PORTRAIT_SIZE, PORTRAIT_SIZE);
  } else {
    ctx.fillStyle = colour('--ink');
    ctx.font = `160px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, PORTRAIT_X + PORTRAIT_SIZE / 2, PORTRAIT_Y + PORTRAIT_SIZE / 2);
  }

  // The stamp, across the portrait's lower third, rotated −8°.
  const stampColour = colour(STAMP_COLOURS[model.stamp]);
  ctx.save();
  ctx.translate(PORTRAIT_X + PORTRAIT_SIZE / 2, PORTRAIT_Y + (PORTRAIT_SIZE * 5) / 6);
  ctx.rotate((-8 * Math.PI) / 180);
  ctx.font = `bold 56px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const stampWidth = Math.min(ctx.measureText(model.stamp).width, PORTRAIT_SIZE + 40);
  ctx.fillStyle = 'rgba(11, 15, 20, 0.55)';
  ctx.fillRect(-stampWidth / 2 - 14, -38, stampWidth + 28, 76);
  ctx.strokeStyle = stampColour;
  ctx.lineWidth = 4;
  ctx.strokeRect(-stampWidth / 2 - 14, -38, stampWidth + 28, 76);
  ctx.fillStyle = stampColour;
  ctx.fillText(model.stamp, 0, 2, PORTRAIT_SIZE + 40);
  ctx.restore();

  // The right column, from x = 430.
  const column = width - COLUMN_X - MARGIN_RIGHT;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const line = (text: string, size: number, fill: PaletteKey, y: number, bold = false): void => {
    ctx.font = `${bold ? 'bold ' : ''}${size}px ${FONT}`;
    ctx.fillStyle = colour(fill);
    ctx.fillText(text, COLUMN_X, y, column);
  };
  line(model.header, 26, '--accent', 130);
  line(model.name, 60, '--ink', 210, true);
  model.lines.forEach((text, index) => line(text, 26, '--ink', 280 + index * 40));
  if (model.lineage !== null) line(model.lineage, 22, '--ink-dim', 420);
  if (model.mode !== null) line(model.mode, 22, '--warn', 460);

  // The URL, bottom right.
  ctx.font = `22px ${FONT}`;
  ctx.fillStyle = colour('--ink-dim');
  ctx.textAlign = 'right';
  ctx.fillText(model.url, width - MARGIN_RIGHT, height - MARGIN_RIGHT);
}

/** The canvas as a PNG blob, or `null` when there is no 2D context or `toBlob` yields nothing. */
async function render(model: ShareCardModel): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = SHARE_CARD_WIDTH;
  canvas.height = SHARE_CARD_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  await drawCard(ctx, model);
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    } catch {
      resolve(null);
    }
  });
}

/** §4.5.3: draws `model` now; `ready` says when — and whether — the file is there. */
export function prepareShareCard(model: ShareCardModel, text: string): PreparedCard {
  const card: { ready: Promise<boolean>; file: File | null; text: string } = { ready: Promise.resolve(false), file: null, text };
  card.ready = render(model).then(
    (blob) => {
      if (blob === null) return false;
      card.file = new File([blob], SHARE_FILE_NAME, { type: 'image/png' });
      return true;
    },
    () => false,
  );
  return card;
}

/**
 * §4.5.5: the card for `save` as this device and session would make it now —
 * its commendations, and `RECORDS.reason` (§4.3.2).
 */
export function prepareSaveCard(save: Save, earned: Settings['commendations']): PreparedCard {
  const mode = RECORDS.reason;
  return prepareShareCard(shareCardModel(save, { commendations: Object.keys(earned).length, mode }), shareText(save, mode));
}

/** §4.5.4 step 3: the download, the clipboard and the toast that says which landed. */
function saveAndCopy(file: File, text: string, ui: UiRoot): void {
  const url = URL.createObjectURL(file);
  const link = document.createElement('a');
  link.href = url;
  link.download = SHARE_FILE_NAME;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_MS);
  const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
  if (typeof clipboard?.writeText !== 'function') {
    ui.toast(SHARE_SAVED_NO_CLIPBOARD_TEXT, 'good');
    return;
  }
  clipboard.writeText(text).then(
    () => ui.toast(SHARE_SAVED_TEXT, 'good'),
    () => ui.toast(SHARE_SAVED_NO_CLIPBOARD_TEXT, 'good'),
  );
}

/**
 * §4.5.4: the click handler's body, synchronous — `navigator.share` is
 * called in the gesture, with nothing awaited before it, when
 * `navigator.canShare` accepts a file; a cancelled sheet does nothing (59-j)
 * and any other refusal falls back to the download (59-k).
 */
export function shareCard(card: PreparedCard, ui: UiRoot): void {
  const file = card.file;
  if (file === null) return;
  const data: ShareData = { files: [file], text: card.text };
  let canShare = false;
  try {
    canShare = typeof navigator.share === 'function' && navigator.canShare?.(data) === true;
  } catch {
    canShare = false;
  }
  if (!canShare) {
    saveAndCopy(file, card.text, ui);
    return;
  }
  navigator.share(data).catch((error: unknown) => {
    if ((error as { name?: unknown } | null)?.name === 'AbortError') return;
    saveAndCopy(file, card.text, ui);
  });
}

/**
 * §4.5.4: `Share card`, disabled until the card's file is ready, and gone if
 * it never will be (`hidden`, so a panel that re-renders leaves it out too).
 */
export function shareButton(id: 'ending-share' | 'interlude-share' | 'char-share', card: PreparedCard, ui: UiRoot): HTMLButtonElement {
  const button = testId(h('button', { class: 'ui-btn share-btn', type: 'button', disabled: true, click: () => shareCard(card, ui) }, 'Share card'), id);
  void card.ready.then((ok) => {
    if (ok) {
      button.disabled = false;
      return;
    }
    button.hidden = true;
    button.remove();
  });
  return button;
}
