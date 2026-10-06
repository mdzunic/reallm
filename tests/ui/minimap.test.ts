// SPEC-012 §4.12 — the minimap's remaining pure rules: who sees the node
// layer, and how near an enemy has to be to register (AC-58, AC-59).
//
// The projection that used to live here moved with SPEC-026: both maps now
// turn with the camera, and `tests/ui/map.test.ts` pins `mapProject` /
// `mapAngle` and the icon table the painter strokes.
import { describe, expect, it } from 'vitest';
import { newSave, type CharacterCreation, type Save } from '@/core/Save';
import { MINIMAP_RANGE } from '@/systems/MapModel';
import { MINIMAP_ENEMY_RANGE, hasNodeRadar } from '@/systems/UiHelpers';
import { MapLayers, type TerrainLayout } from '@/ui/MapLayers';
import { drawMapIcon, Minimap, type MinimapFrame } from '@/ui/Minimap';

function save(classId: 'marine' | 'scout'): Save {
  const creation: CharacterCreation = {
    name: 'T',
    classId,
    appearance: { portrait: 0, primary: '#fff', secondary: '#000' },
    attributes: { might: 3, vigor: 3, agility: 3, tech: 3 },
    difficulty: 'normal',
  };
  return newSave(0, creation, 7, 1_700_000_000_000);
}

describe('hasNodeRadar (AC-58)', () => {
  it('is off for a fresh marine — nodes hidden until the drone learns to read ore', () => {
    expect(hasNodeRadar(save('marine'))).toBe(false);
  });

  it('is on for the scout class passive', () => {
    expect(hasNodeRadar(save('scout'))).toBe(true);
  });

  it('needs the scanner drone at level 2, enabled', () => {
    const s = save('marine');
    s.companions.push({ id: 'scanner_drone', level: 1, enabled: true });
    expect(hasNodeRadar(s)).toBe(false);
    (s.companions[s.companions.length - 1] as Save['companions'][number]).level = 2;
    expect(hasNodeRadar(s)).toBe(true);
    (s.companions[s.companions.length - 1] as Save['companions'][number]).enabled = false;
    expect(hasNodeRadar(s)).toBe(false);
  });
});

describe('minimap constants (§4.12, SPEC-026 §4.3)', () => {
  it('pins the 25 m enemy range inside the 70 m window', () => {
    expect(MINIMAP_ENEMY_RANGE).toBe(25);
    expect(MINIMAP_ENEMY_RANGE).toBeLessThan(MINIMAP_RANGE);
  });
});

describe('drawMapIcon hollow (SPEC-054 §4.10)', () => {
  // A small recording stand-in for the one shape that ever draws hollow
  // today (`chest`, the cache): just enough of the 2D context for `drawShape`
  // to run, logging which calls it made rather than rendering anything.
  class RecordingContext {
    fillStyle = '';
    strokeStyle = '';
    lineWidth = 1;
    readonly calls: string[] = [];
    save(): void {}
    restore(): void {}
    translate(): void {}
    rotate(): void {}
    moveTo(): void {}
    lineTo(): void {}
    arc(): void {}
    strokeRect(): void {
      this.calls.push('strokeRect');
    }
    fill(): void {
      this.calls.push('fill');
    }
    stroke(): void {
      this.calls.push('stroke');
    }
    beginPath(): void {
      this.calls.push('beginPath');
    }
  }

  it('strokes the cache latch instead of filling it once claimed', () => {
    const filled = new RecordingContext();
    drawMapIcon(filled as unknown as CanvasRenderingContext2D, 'cache', 0, 0, 1, false);
    // `chest` (§4.10): `strokeRect` (body) + `stroke` (lid line) + `fill` (latch).
    expect(filled.calls.filter((c) => c === 'fill')).toHaveLength(1);
    expect(filled.calls.filter((c) => c === 'stroke')).toHaveLength(1);

    const hollow = new RecordingContext();
    drawMapIcon(hollow as unknown as CanvasRenderingContext2D, 'cache', 0, 0, 1, true);
    // Hollow: the latch strokes its outline instead of filling — no `fill` at all.
    expect(hollow.calls.filter((c) => c === 'fill')).toHaveLength(0);
    expect(hollow.calls.filter((c) => c === 'stroke')).toHaveLength(2);
  });

  it('defaults to filled when `hollow` is omitted', () => {
    const ctx = new RecordingContext();
    drawMapIcon(ctx as unknown as CanvasRenderingContext2D, 'cache', 0, 0, 1);
    expect(ctx.calls.filter((c) => c === 'fill')).toHaveLength(1);
  });
});

describe('Minimap.setLayers (SPEC-054 §4.10)', () => {
  // `Minimap` and `MapLayers` both draw through the DOM canvas API, which
  // this suite's plain `node` environment does not have. `#layers` is a true
  // private field, so the only way to observe `setLayers` at all is through
  // `draw()`'s own canvas calls — this stands in enough of `document` and
  // `CanvasRenderingContext2D` for a full `draw()` to run, and watches
  // `drawImage` to see which `MapLayers`' terrain and fog actually got drawn.
  function permissiveContext(onDrawImage?: (image: unknown) => void): CanvasRenderingContext2D {
    const store: Record<string, unknown> = {
      drawImage: (image: unknown) => onDrawImage?.(image),
    };
    return new Proxy(store, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        // Everything else used by `draw()` — `save`, `clip`, `fillText`, the
        // rest — is a harmless no-op; this suite only asks what was drawn.
        return () => undefined;
      },
      set(target, prop: string, value) {
        target[prop] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
  }

  function fakeCanvas(onDrawImage?: (image: unknown) => void): HTMLCanvasElement {
    const ctx = permissiveContext(onDrawImage);
    const element = {
      width: 0,
      height: 0,
      getContext: () => ctx,
      getBoundingClientRect: () => ({ width: 70, height: 70, x: 0, y: 0, top: 0, left: 0, right: 70, bottom: 70 }),
      clientWidth: 70,
    };
    return element as unknown as HTMLCanvasElement;
  }

  function withFakeDocument<T>(run: () => T): T {
    (globalThis as { document?: unknown }).document = {
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error(`the stub only makes canvases, not ${tag}`);
        return fakeCanvas();
      },
    };
    try {
      return run();
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  }

  const EMPTY_FRAME: MinimapFrame = {
    playerX: 0,
    playerZ: 0,
    facing: 0,
    marks: [],
    enemies: [],
    arrows: [],
    target: null,
    route: null,
    routeLength: 0,
  };

  it('draws from the new layers after a swap, and never falls back to the old one', () => {
    withFakeDocument(() => {
      const layout: TerrainLayout = { halfSize: 48, obstacles: [], pois: [], shelters: [] };
      const palette = { ground: '#336644', accent: '#ffaa00' };
      const layersA = new MapLayers(layout, palette);
      const layersB = new MapLayers(layout, palette);
      expect(layersA.terrain).not.toBe(layersB.terrain);

      const drawn: unknown[] = [];
      const canvas = fakeCanvas((image) => drawn.push(image));
      const minimap = new Minimap(canvas, layersA);

      minimap.draw(EMPTY_FRAME);
      expect(drawn).toContain(layersA.terrain);
      expect(drawn).toContain(layersA.fog);
      expect(drawn).not.toContain(layersB.terrain);

      drawn.length = 0;
      minimap.setLayers(layersB);
      minimap.draw(EMPTY_FRAME);
      expect(drawn).toContain(layersB.terrain);
      expect(drawn).toContain(layersB.fog);
      expect(drawn).not.toContain(layersA.terrain);
      expect(drawn).not.toContain(layersA.fog);
    });
  });
});
