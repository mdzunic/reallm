// SPEC-017 §6 — the render seam, as a test. Two rules, both of them the kind a
// code review forgets and a grep never does.
//
// 1. `Renderer.render()` is the only main-pass draw in the app (SPEC-002 §3.2).
//    With a post chain behind that seam, a scene that reaches past it to
//    `renderer.gl.render(...)` would draw straight to the canvas with no bloom,
//    no grade and no tone curve — and, worse, look fine on `low`, where there is
//    no chain to miss. The facade call `renderer.render(scene, camera)` is what
//    every scene keeps using; the scissored portrait goes through
//    `renderer.renderOverlay(...)`, which lives in `core/Renderer.ts` with the
//    rest of the GL.
// 2. Nothing under `src/` builds a `MeshLambertMaterial` any more (§4.7):
//    Lambert has no roughness, no metalness and no environment response, so one
//    left behind would be a matte hole in an otherwise PBR scene.
//
// Only *code* counts: a comment naming the banned shape — this file's own prose
// included — must not trip the rule, so the scanner blanks comments first, the
// way `noMathRandom.test.ts` does.
import { describe, expect, it } from 'vitest';
import { stripComments } from './source';

/** The two modules that may own a raw `WebGLRenderer` (PLAN R6-2, SPEC-001 §4). */
const RENDER_OWNERS = /(?:^|\/)src\/core\/(?:Renderer|PostChain)\.ts$/;

/** A draw on the raw context, or a second renderer — never a facade call. */
const RAW_RENDER = [/\bgl\s*\.\s*render\s*\(/, /\.\s*gl\s*\.\s*render\s*\(/, /new\s+WebGLRenderer\b/];
const LAMBERT = /\bMeshLambertMaterial\b/;

/** Files that draw on the raw context outside the two modules allowed to. */
export function rawRenderOffenders(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([file, source]) => {
      if (RENDER_OWNERS.test(file)) return false;
      const code = stripComments(source);
      return RAW_RENDER.some((pattern) => pattern.test(code));
    })
    .map(([file]) => file);
}

/** Files that still build a Lambert material. */
export function lambertOffenders(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([, source]) => LAMBERT.test(stripComments(source)))
    .map(([file]) => file);
}

const SRC = import.meta.glob<string>('../../src/**/*.ts', { query: '?raw', import: 'default', eager: true });

describe('the render seam (SPEC-017 §4.2, AC-50)', () => {
  it('only core/Renderer.ts and core/PostChain.ts touch the raw context', () => {
    expect(rawRenderOffenders(SRC)).toEqual([]);
  });

  it('every file under src/ was actually read', () => {
    // A glob that matched nothing would make the assertions above vacuous.
    expect(Object.keys(SRC).length).toBeGreaterThan(20);
    expect(Object.keys(SRC).some((file) => file.endsWith('/src/core/PostChain.ts'))).toBe(true);
    expect(Object.keys(SRC).some((file) => file.endsWith('/src/scenes/CreationScene.ts'))).toBe(true);
  });

  it('reports a scene that draws past the seam, and allows the facade call', () => {
    expect(
      rawRenderOffenders({
        'src/scenes/CreationScene.ts': 'const gl = renderer.gl;\ngl.render(preview, camera);',
        'src/scenes/MenuScene.ts': 'renderer.gl.render(this.scene, this.camera);',
        'src/scenes/StationScene.ts': 'renderer.render(this.scene, this.camera);',
        'src/views/SurfaceView.ts': 'view.render(frame);',
        'src/core/Renderer.ts': 'this.gl.render(scene, camera);',
        'src/core/PostChain.ts': 'this.composer.render();',
      }),
    ).toEqual(['src/scenes/CreationScene.ts', 'src/scenes/MenuScene.ts']);
  });

  it('reports a second WebGLRenderer wherever it is built', () => {
    expect(
      rawRenderOffenders({
        'src/ui/Thumbnail.ts': 'const preview = new WebGLRenderer({ canvas });',
        'src/core/Renderer.ts': 'this.gl = new WebGLRenderer({ canvas });',
      }),
    ).toEqual(['src/ui/Thumbnail.ts']);
  });

  it('a mention in a comment is not a use', () => {
    expect(
      rawRenderOffenders({
        'src/scenes/base.ts': '// never gl.render(...) here — use the facade\nrenderer.render(s, c);',
      }),
    ).toEqual([]);
  });
});

describe('materials (SPEC-017 §4.7, AC-51)', () => {
  it('nothing under src/ builds a Lambert material', () => {
    expect(lambertOffenders(SRC)).toEqual([]);
  });

  it('reports one wherever it appears, and ignores a comment about it', () => {
    expect(
      lambertOffenders({
        'src/views/SurfaceView.ts': 'const m = new THREE.MeshLambertMaterial();',
        'src/views/ProceduralMeshes.ts': '// MeshLambertMaterial was replaced in SPEC-017\nconst m = new THREE.MeshStandardMaterial();',
      }),
    ).toEqual(['src/views/SurfaceView.ts']);
  });
});
