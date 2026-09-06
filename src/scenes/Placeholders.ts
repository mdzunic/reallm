// One placeholder scene per `SceneId` (SPEC-003 D-20), so the state machine is
// runnable and its memory behaviour is measurable before the real scenes exist.
// Each honours the whole `Scene` contract — a `THREE.Scene`, a camera, a
// `Disposer`, an id label in the UI layer — and each is replaced by its own
// spec: SPEC-012 (surface), SPEC-013 (flight), SPEC-014 (menu, creation,
// station, starmap).
//
// They are asset-free: nothing here reads the asset registry. `station` and
// `starmap` build a few meshes and textures of their own so that cycling
// between them exercises real GPU allocations (AC-13).
import * as THREE from 'three';
import { Disposer, disposeObject3D } from '@/core/Disposer';
import type { GameServices } from '@/core/Services';
import type { Renderer } from '@/core/Renderer';
import { ALLOWED_TRANSITIONS, type Scene, type SceneFactory, type SceneId, type SceneParams } from '@/core/StateMachine';
import { PauseMenu } from '@/ui/PauseMenu';

/** The DOM layer every scene mounts its own UI into (SPEC-001 shell). */
function uiRoot(): HTMLElement {
  const root = document.getElementById('ui');
  if (!root) throw new Error('index.html must carry <div id="ui">');
  return root;
}

/** Defaults for the navigation buttons; the real scenes pass real params. */
function goDefault(services: GameServices, id: SceneId): void {
  switch (id) {
    case 'menu':
      void services.go('menu', { reason: 'quit' });
      break;
    case 'creation':
      void services.go('creation', { slot: 0 });
      break;
    case 'station':
      void services.go('station', {});
      break;
    case 'starmap':
      void services.go('starmap', undefined);
      break;
    case 'flight':
      void services.go('flight', { destination: 'cinder4' });
      break;
    case 'surface':
      void services.go('surface', { planet: 'cinder4', firstLanding: true });
      break;
  }
}

/** A deterministic 8×8 RGBA texture: no asset behind it, and no randomness (SPEC-001 §7). */
function swatchTexture(tint: number): THREE.DataTexture {
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const shade = 40 + ((i * 7 + tint * 29) % 180);
    data[i * 4] = shade;
    data[i * 4 + 1] = (shade + tint * 17) % 256;
    data[i * 4 + 2] = (shade + tint * 53) % 256;
    data[i * 4 + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.needsUpdate = true;
  return texture;
}

class PlaceholderScene<K extends SceneId> implements Scene<K> {
  readonly id: K;
  readonly pausable: boolean;
  protected readonly services: GameServices;
  protected readonly disposer = new Disposer();
  protected readonly scene = new THREE.Scene();
  protected readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  /** How many own meshes this placeholder builds; two of them build some (D-20). */
  protected readonly props: number;
  #spin: THREE.Object3D | null = null;
  #pauseMenu: PauseMenu | null = null;
  #elapsed = 0;

  constructor(services: GameServices, id: K, options: { pausable?: boolean; props?: number } = {}) {
    this.services = services;
    this.id = id;
    this.pausable = options.pausable ?? false;
    this.props = options.props ?? 0;
  }

  enter(_params: SceneParams[K]): void {
    this.camera.position.set(0, 1.4, 4);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.AmbientLight(0x8899aa, 2));
    this.disposer.add(() => disposeObject3D(this.scene));
    this.#buildProps();
    this.#mountLayer();
    if (this.pausable) {
      const menu = new PauseMenu(uiRoot(), () => this.services.requestResume());
      this.#pauseMenu = menu;
      this.disposer.add(() => menu.dispose());
    }
  }

  exit(): void {
    // Synchronous by contract (D-21): the real scenes flush their save here.
  }

  update(dt: number): void {
    this.#elapsed += dt;
    if (this.#spin) this.#spin.rotation.y = this.#elapsed * 0.6;
  }

  render(renderer: Renderer): void {
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

  pause(): void {
    this.#pauseMenu?.show();
  }

  resume(): void {
    this.#pauseMenu?.hide();
  }

  debugInfo(): Record<string, number | string> {
    return { scene: this.id, props: this.props };
  }

  /** A few own meshes, each with its own geometry, material and texture. */
  #buildProps(): void {
    if (this.props === 0) return;
    const group = new THREE.Group();
    for (let i = 0; i < this.props; i++) {
      const geometry = new THREE.BoxGeometry(0.8, 0.8, 0.8, 2, 2, 2);
      const material = new THREE.MeshBasicMaterial({ map: swatchTexture(i + 1) });
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.x = (i - (this.props - 1) / 2) * 1.3;
      group.add(mesh);
    }
    this.scene.add(group);
    this.#spin = group;
  }

  /** The id label of D-20, plus a button per allowed transition so the machine is playable. */
  #mountLayer(): void {
    const root = uiRoot();
    const layer = document.createElement('div');
    layer.className = 'scene-layer';
    const label = document.createElement('p');
    label.className = 'scene-label';
    label.dataset['testid'] = 'scene-label';
    label.textContent = this.id;
    layer.append(label);
    const nav = document.createElement('div');
    nav.className = 'scene-nav';
    for (const target of ALLOWED_TRANSITIONS[this.id] as readonly SceneId[]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'scene-nav-button';
      button.dataset['testid'] = `go-${target}`;
      button.textContent = target;
      button.addEventListener('click', () => goDefault(this.services, target));
      nav.append(button);
    }
    layer.append(nav);
    root.append(layer);
    this.disposer.add(() => layer.remove());
  }
}

/**
 * The factory the composition root hands to `SceneManager` (D-17). `menu` enters
 * synchronously and loads nothing, which is what makes it a safe fallback after
 * a failed `enter()` (D-19).
 */
export const PLACEHOLDER_SCENES: SceneFactory = {
  menu: (services) => new PlaceholderScene(services, 'menu'),
  creation: (services) => new PlaceholderScene(services, 'creation'),
  station: (services) => new PlaceholderScene(services, 'station', { props: 3 }),
  starmap: (services) => new PlaceholderScene(services, 'starmap', { props: 4 }),
  flight: (services) => new PlaceholderScene(services, 'flight', { pausable: true }),
  surface: (services) => new PlaceholderScene(services, 'surface', { pausable: true }),
};
