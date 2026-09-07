// One placeholder scene per `SceneId` (SPEC-003 D-20), so the state machine is
// runnable and its memory behaviour is measurable before the real scenes exist.
// Each honours the whole `Scene` contract — a `THREE.Scene`, a camera, a
// `Disposer`, an id label in the UI layer — and each is replaced by its own
// spec: SPEC-012 (surface), SPEC-013 (flight), SPEC-014 (menu, creation,
// station, starmap).
//
// They are asset-free with one exception: `menu` also carries SPEC-002's asset
// spike (§4.5, D-I) — a rigged character through `SkeletonUtils.clone` and an
// `AnimationMixer`, and a ship with its own sRGB colour map — guarded by
// `assets.loaded` so `menu` stays the safe fallback for a failed `enter()`
// (SPEC-003 D-19). `station` and `starmap` build a few meshes and textures of
// their own so that cycling between them exercises real GPU allocations (AC-13).
//
// `menu` also mounts SPEC-007's `SavePanel`: the storage banner and the corrupt
// slot's Import/Delete actions are that spec's own UI (E8), so they live in
// `ui/` and move to the real menu with SPEC-014 rather than being rebuilt.
import * as THREE from 'three';
import type { MusicId } from '@/core/Audio';
import { Disposer, disposeObject3D } from '@/core/Disposer';
import { log } from '@/core/Log';
import type { GameServices } from '@/core/Services';
import type { Renderer } from '@/core/Renderer';
import { ALLOWED_TRANSITIONS, type Scene, type SceneFactory, type SceneId, type SceneParams } from '@/core/StateMachine';
import { cargoCap, maxHp } from '@/core/Save';
import { cumulativeXp, xpToNext } from '@/systems/Progression';
import { DeathOverlay } from '@/ui/DeathOverlay';
import { uiLayers } from '@/ui/dom';
import { Hud } from '@/ui/Hud';
import { PauseMenu } from '@/ui/PauseMenu';
import { RotateOverlay } from '@/ui/RotateOverlay';
import { SavePanel } from '@/ui/SavePanel';
import { TouchControls } from '@/ui/TouchControls';

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
  /** The bed this scene asks for on enter; `undefined` keeps whatever is playing. */
  protected readonly music: MusicId | undefined;
  #spin: THREE.Object3D | null = null;
  #pauseMenu: PauseMenu | null = null;
  #hud: Hud | null = null;
  #elapsed = 0;
  #renders = 0;

  constructor(services: GameServices, id: K, options: { pausable?: boolean; props?: number; music?: MusicId } = {}) {
    this.services = services;
    this.id = id;
    this.pausable = options.pausable ?? false;
    this.props = options.props ?? 0;
    this.music = options.music;
  }

  enter(_params: SceneParams[K]): void {
    this.camera.position.set(0, 1.4, 4);
    this.camera.lookAt(0, 0, 0);
    this.scene.add(new THREE.AmbientLight(0x8899aa, 2));
    this.disposer.add(() => disposeObject3D(this.scene));
    this.#buildProps();
    this.#mountLayer();
    // SPEC-006 §4.3: the bed changes on `enter()`, so the crossfade runs across
    // the transition rather than after it. A scene that names no track leaves
    // the current one playing, which is what makes menu → creation → station a
    // single continuous piece.
    if (this.music !== undefined) this.services.audio.music(this.music);
    if (this.pausable) {
      const menu = new PauseMenu(this.services, () => this.services.requestResume());
      this.#pauseMenu = menu;
      this.disposer.add(() => menu.dispose());
      // Quitting straight out of the pause menu never calls `resume()`, so the
      // duck is released here too rather than surviving the scene.
      this.disposer.add(() => this.services.audio.duck(false));
      // The two pausable placeholders are the two gameplay scenes, so they are
      // the ones that own a touch layout (SPEC-005 AC-27). It mounts itself
      // only while the touch scheme is active (AC-20).
      const touch = new TouchControls(uiRoot(), this.services.input, this.services.settings);
      touch.show(this.id === 'flight' ? 'flight' : 'surface');
      this.disposer.add(() => touch.dispose());
      // SPEC-014 §4.5: the two gameplay scenes carry the HUD. The placeholder
      // feeds it the save's own numbers each update; SPEC-012/013 replace the
      // feed, not the component. Its flush runs from the frame loop's
      // `ui:flush` phase, never from here.
      const hud = new Hud(uiLayers(uiRoot()), this.id === 'flight' ? 'flight' : 'surface');
      this.#hud = hud;
      this.disposer.add(() => hud.dispose());
      this.disposer.add(this.services.events.on('player:damaged', () => hud.damageFlash(), this));
      // SPEC-014 §4.9: death and rotate overlays belong to the gameplay scenes.
      // The penalty numbers arrive with SPEC-012's death flow; the overlay
      // itself and its wiring are this spec's (AC-99, AC-101).
      const death = new DeathOverlay(uiRoot());
      this.disposer.add(() => death.dispose());
      this.disposer.add(this.services.events.on('player:died', () => death.show(), this));
      this.disposer.add(this.services.events.on('player:respawned', () => death.hide(), this));
      const rotate = new RotateOverlay(uiRoot(), this.services.events);
      this.disposer.add(() => rotate.dispose());
    }
  }

  exit(): void {
    // Synchronous by contract (D-21): the real scenes flush their save here.
  }

  update(dt: number): void {
    this.#elapsed += dt;
    if (this.#spin) this.#spin.rotation.y = this.#elapsed * 0.6;
    // SPEC-014 AC-82: the touch pause button pauses through the input action.
    // Keyboard Escape/P stay with the composition root's toggle — consuming
    // the action here too would re-pause on the same keypress that resumed.
    if (this.pausable && this.services.input.state.scheme === 'touch' && this.services.input.state.buttons.pause.justPressed) {
      this.services.scenes.pause();
    }
    this.#feedHud();
  }

  /** The save's numbers into the HUD model, in place (no allocations in update). */
  #feedHud(): void {
    const hud = this.#hud;
    const data = this.services.save.current;
    if (hud === null || data === null) return;
    const model = hud.model;
    const { player } = data;
    model.hp[0] = player.hp;
    model.hp[1] = maxHp(player.classId, player.attributes, player.level);
    model.xp[0] = player.xp - cumulativeXp(player.level);
    model.xp[1] = xpToNext(player.level);
    model.level = player.level;
    model.tokens = player.tokens;
    model.resources.oil = data.resources.oil;
    model.resources.wheat = data.resources.wheat;
    model.resources.water = data.resources.water;
    model.resources.lithium = data.resources.lithium;
    // The tier cap only; the quartermaster bonus is Economy's and arrives with
    // the scene that owns an Economy instance (SPEC-012).
    model.cargoCap = cargoCap(data.ship);
  }

  render(renderer: Renderer): void {
    // Reported by `debugInfo()`: it is how the 30 fps render skip of SPEC-002
    // §4.2 is observable from outside — updates keep their rate, draws halve.
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

  pause(): void {
    this.#pauseMenu?.show();
    // SPEC-006 AC-54: the menu holds a duck for as long as it is open, so the
    // bed sits under it instead of over it.
    this.services.audio.duck(true);
  }

  resume(): void {
    this.#pauseMenu?.hide();
    this.services.audio.duck(false);
  }

  /**
   * The pairs the stats overlay prints after the scene id (SPEC-002 §4.6.1,
   * AC-31). The id itself is not repeated here — the row already shows it.
   */
  debugInfo(): Record<string, number | string> {
    const info: Record<string, number | string> = { props: this.props, renders: this.#renders };
    if (this.#spin) info['spin'] = this.#spin.rotation.y;
    return info;
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

/** `''` when the model carries no colour map at all. */
function colourMapSpace(root: THREE.Object3D): string {
  let space = '';
  root.traverse((node) => {
    if (space !== '') return;
    const material = (node as THREE.Mesh).material;
    for (const entry of Array.isArray(material) ? material : [material]) {
      const map = (entry as THREE.MeshStandardMaterial | undefined)?.map;
      if (map) space = map.colorSpace === THREE.SRGBColorSpace ? 'srgb' : (map.colorSpace || 'none');
    }
  });
  return space;
}

/**
 * The menu placeholder, plus SPEC-002's asset spike (§4.5, D-I): the rotating
 * prop the M0 acceptance list looks for, a rigged character playing a named
 * clip, and a ship rendering with its own colour map.
 *
 * The spike is guarded and its failure is only a warning, because `menu` is
 * what the state machine falls back to when another scene's `enter()` throws
 * (SPEC-003 D-19) — it may never be the scene that fails.
 */
class MenuScene extends PlaceholderScene<'menu'> {
  #mixer: THREE.AnimationMixer | null = null;
  #action: THREE.AnimationAction | null = null;
  #clip = '';
  #shipMap = '';

  constructor(services: GameServices) {
    super(services, 'menu', { props: 1, music: 'menu' });
  }

  override enter(params: SceneParams['menu']): void {
    super.enter(params);
    // SPEC-006 AC-28: the menu warms both of the tracks it can crossfade into
    // next, so menu → station has no gap to click across. It resolves even when
    // a track fails to load, so nothing here has to be awaited.
    void this.services.audio.preloadMusic(['menu', 'station']);
    // SPEC-007 E8: the menu is where a memory-only session is told so (AC-17)
    // and where a slot with neither a readable save nor a readable backup gets
    // its Import and Delete actions (AC-20). The panel belongs to SPEC-007, so
    // SPEC-014's real menu mounts the same one.
    const saves = new SavePanel(uiRoot(), this.services.save);
    this.disposer.add(() => saves.dispose());
    if (!this.services.assets.loaded) return;
    try {
      this.#buildSpike();
    } catch (error) {
      log.warn('scene', 'the asset spike could not be built; the menu runs without it', error);
    }
  }

  override update(dt: number): void {
    super.update(dt);
    // AC-51: the clip is advanced from the scene's fixed update, never from a
    // clock of its own, so it stops with the loop and never runs while paused.
    this.#mixer?.update(dt);
  }

  override debugInfo(): Record<string, number | string> {
    const info = super.debugInfo();
    if (this.#clip !== '') {
      info['clip'] = this.#clip;
      info['clipTime'] = this.#action?.time ?? 0;
    }
    if (this.#shipMap !== '') info['shipMap'] = this.#shipMap;
    return info;
  }

  #buildSpike(): void {
    const assets = this.services.assets;
    // `Assets.model()` clones a rigged model with `SkeletonUtils.clone`, the
    // only clone that rebinds the skeleton to the cloned bones (AC-50).
    const character = assets.model('character');
    character.position.set(-1.7, -0.9, 0);
    this.scene.add(character);
    const clip = assets.animations('character')[0];
    if (clip) {
      const mixer = new THREE.AnimationMixer(character);
      this.#mixer = mixer;
      this.#action = mixer.clipAction(clip);
      this.#action.play();
      this.#clip = clip.name;
      this.disposer.add(() => {
        mixer.stopAllAction();
        mixer.uncacheRoot(character);
      });
    }

    const ship = assets.model('ship');
    ship.position.set(1.7, 0, 0);
    ship.rotation.y = -0.6;
    this.scene.add(ship);
    // AC-52: GLTFLoader tags a baseColorTexture as sRGB; this is that read-back.
    this.#shipMap = colourMapSpace(ship);
  }
}

/**
 * The factory the composition root hands to `SceneManager` (D-17). `menu` enters
 * synchronously and loads nothing of its own, which is what makes it a safe
 * fallback after a failed `enter()` (D-19).
 */
export const PLACEHOLDER_SCENES: SceneFactory = {
  menu: (services) => new MenuScene(services),
  // `creation` and `starmap` name no track on purpose: they sit between two
  // scenes that do, and re-stating the bed would restart a fade for nothing.
  creation: (services) => new PlaceholderScene(services, 'creation'),
  station: (services) => new PlaceholderScene(services, 'station', { props: 3, music: 'station' }),
  starmap: (services) => new PlaceholderScene(services, 'starmap', { props: 4 }),
  flight: (services) => new PlaceholderScene(services, 'flight', { pausable: true, music: 'flight' }),
  surface: (services) => new PlaceholderScene(services, 'surface', { pausable: true, music: 'surface_calm' }),
};
