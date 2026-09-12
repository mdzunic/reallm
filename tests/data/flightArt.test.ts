// PLAN R8: every file the flight scene asks for is committed under
// public/assets, every planet has its art, and none of it rides the boot
// manifest (the boot suites delay every boot request — README §3).
import { describe, expect, it } from 'vitest';
import { ASSETS, FLIGHT_ASSETS, HUB_ASSETS, PLANET_ART } from '@/data/assets';
import { PLANET_IDS } from '@/data/ids';

/** Paths as the game requests them (`assets/…`), found on disk by Vite's glob. */
const ON_DISK = new Set(
  Object.keys(import.meta.glob('../../public/assets/**/*.{glb,webp}')).map((path) => path.replace('../../public/', '')),
);

describe('flight art manifest (PLAN R8)', () => {
  it('gives every planet a sky window, a surface map and a relief map', () => {
    for (const id of PLANET_IDS) {
      const art = PLANET_ART[id];
      expect(art.sky).toBe(`assets/textures/flight/sky_${id}.webp`);
      expect(art.surface).toBe(`assets/textures/flight/planet_${id}.webp`);
      expect(art.normal).toBe(`assets/textures/flight/planet_${id}_nr.webp`);
    }
  });

  it('lists only files that ship', () => {
    const urls = [
      ...Object.values(FLIGHT_ASSETS.models),
      ...Object.values(FLIGHT_ASSETS.textures).map((entry) => entry.url),
      ...Object.values(PLANET_ART).flatMap((art) => [art.sky, art.surface, art.normal, ...(art.emissive ? [art.emissive] : [])]),
    ];
    for (const url of urls) expect(ON_DISK.has(url), url).toBe(true);
  });

  it('keeps the flight models out of the boot manifest', () => {
    for (const id of Object.keys(FLIGHT_ASSETS.models)) expect(Object.keys(ASSETS.models)).not.toContain(id);
    for (const id of Object.keys(FLIGHT_ASSETS.textures)) expect(Object.keys(ASSETS.textures)).not.toContain(id);
  });
});

// SPEC-020 §4.4, §4.8. The hub set is the same bargain as the flight set: the
// files ship, the scenes fetch them on `enter()`, and PLAN R6-5's five-file
// boot manifest does not grow by two models and a texture.
describe('hub backdrop manifest (SPEC-020 §4.8)', () => {
  it('lists only files that ship', () => {
    const urls = [...Object.values(HUB_ASSETS.models), ...Object.values(HUB_ASSETS.textures).map((entry) => entry.url)];
    expect(urls).toHaveLength(3);
    for (const url of urls) expect(ON_DISK.has(url), url).toBe(true);
  });

  it('stays out of the boot manifest, which is still five files (PLAN R6-5)', () => {
    for (const id of Object.keys(HUB_ASSETS.models)) expect(Object.keys(ASSETS.models)).not.toContain(id);
    for (const id of Object.keys(HUB_ASSETS.textures)) expect(Object.keys(ASSETS.textures)).not.toContain(id);
    expect(Object.keys(ASSETS.models).length + Object.keys(ASSETS.textures).length).toBe(5);
  });

  it('ships the twelve portraits and the manifest the resolver reads (AC-28)', () => {
    for (let n = 1; n <= 12; n++) expect(ON_DISK.has(`assets/portraits/${String(n).padStart(2, '0')}.webp`), String(n)).toBe(true);
  });
});
