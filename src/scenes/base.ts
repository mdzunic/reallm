// The shared base of SPEC-014's four real scenes (menu, creation, station,
// starmap). It keeps the whole `Scene` contract the placeholders honoured —
// a `THREE.Scene`, a camera, a `Disposer` that releases everything, the
// `scene-label` test hook the e2e fleet steers by, and a `debugInfo()` whose
// first pair is the scene's own mesh count — so the regression suites keep
// reading the same instruments while the screens underneath become real.
import * as THREE from 'three';
import type { MusicId } from '@/core/Audio';
import { Disposer, disposeObject3D } from '@/core/Disposer';
import type { GameServices } from '@/core/Services';
import type { Renderer } from '@/core/Renderer';
import type { Scene, SceneId, SceneParams } from '@/core/StateMachine';
import { el, testId, uiLayers, type UiRoot } from '@/ui/dom';

/** The DOM layer every scene mounts its own UI into (SPEC-001 shell). */
export function uiRootEl(): HTMLElement {
  const root = document.getElementById('ui');
  if (!root) throw new Error('index.html must carry <div id="ui">');
  return root;
}

export abstract class UiScene<K extends SceneId> implements Scene<K> {
  readonly id: K;
  readonly pausable: boolean = false;
  protected readonly services: GameServices;
  protected readonly disposer = new Disposer();
  protected readonly scene = new THREE.Scene();
  protected readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 200);
  /** How many own meshes the backdrop builds; `debugInfo()` prints it first. */
  protected props = 0;
  protected elapsed = 0;
  readonly #music: MusicId | undefined;
  #renders = 0;

  constructor(services: GameServices, id: K, music?: MusicId) {
    this.services = services;
    this.id = id;
    this.#music = music;
  }

  /** The shared `UiRoot` (layers, toasts, flush) every panel mounts into. */
  protected get ui(): UiRoot {
    return uiLayers(this.services.uiRoot);
  }

  enter(params: SceneParams[K]): void {
    this.camera.position.set(0, 1.4, 4);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.AmbientLight(0x8899aa, 2));
    this.disposer.add(() => disposeObject3D(this.scene));
    this.#mountTag();
    // SPEC-006 §4.3: the bed changes on `enter()` so the crossfade spans the
    // transition; a scene that names no track keeps the current one playing.
    if (this.#music !== undefined) this.services.audio.music(this.#music);
    this.onEnter(params);
  }

  protected abstract onEnter(params: SceneParams[K]): void;

  exit(): void {
    // Synchronous by contract (SPEC-003 D-21); scenes with a save flush here.
  }

  update(dt: number): void {
    this.elapsed += dt;
    this.onUpdate(dt);
  }

  protected onUpdate(_dt: number): void {}

  render(renderer: Renderer): void {
    this.#renders++;
    const aspect = renderer.width / renderer.height;
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposer.dispose();
  }

  debugInfo(): Record<string, number | string> {
    return { props: this.props, renders: this.#renders };
  }

  /**
   * The `scene-label` hook of SPEC-003 D-20, kept by the real scenes: the e2e
   * fleet awaits its text after every transition and its absence after a
   * teardown. Styled as a quiet corner tag rather than the placeholder banner.
   */
  #mountTag(): void {
    const tag = testId(el('p', 'scene-tag', this.id), 'scene-label');
    tag.setAttribute('aria-hidden', 'true');
    this.services.uiRoot.append(tag);
    this.disposer.add(() => tag.remove());
  }
}
