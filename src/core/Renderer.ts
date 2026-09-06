// The renderer seam. SPEC-002 owns the real `core/Renderer.ts` (quality tiers,
// the benchmark, context-loss recovery); SPEC-003 only needs the slice its
// scenes and its state machine talk to, so that slice is an interface and the
// implementation below is the smallest thing that draws.
//
// One `WebGLRenderer` for the whole app — never one per scene (SPEC-001 §4).
import { WebGLRenderer, type Camera, type Object3D } from 'three';

export interface Renderer {
  /** The raw context, for `info.memory` in the `?debug` readout (D-41). */
  readonly gl: WebGLRenderer;
  /** CSS pixels of the drawing buffer, so scenes size cameras without a DOM read. */
  readonly width: number;
  readonly height: number;
  /** Re-read the canvas size; called after every scene enters (SPEC-003 §4.1). */
  resize(): void;
  render(scene: Object3D, camera: Camera): void;
  dispose(): void;
}

/** Device pixel ratio is capped: a 3× phone would otherwise render 9× the pixels. */
const MAX_PIXEL_RATIO = 2;

class CanvasRenderer implements Renderer {
  readonly gl: WebGLRenderer;
  readonly #canvas: HTMLCanvasElement;
  #width = 0;
  #height = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
    this.gl = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.resize();
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  resize(): void {
    this.#width = Math.max(1, this.#canvas.clientWidth);
    this.#height = Math.max(1, this.#canvas.clientHeight);
    this.gl.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    this.gl.setSize(this.#width, this.#height, false);
  }

  render(scene: Object3D, camera: Camera): void {
    this.gl.render(scene, camera);
  }

  dispose(): void {
    this.gl.dispose();
  }
}

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  return new CanvasRenderer(canvas);
}
