// The star map (SPEC-014 §4.4). Six planets on a plane around the station,
// a fixed overhead camera, and one info panel. The nodes are Three spheres —
// lit when unlocked, dim when not — but the *touch targets* are DOM buttons
// projected over them: 56 px each (AC-52), real buttons for keyboard and
// screen readers (14-f), with the lock glyph riding the locked ones.
//
// Departing pays fuel up front (E5 keeps it on a recall) and enters flight;
// the button's disabled text comes from `departReason`, the confirm sheet
// re-validates through `payFuel` itself, and `transitioning` guards the
// double-tap (14-b).
import * as THREE from 'three';
import type { GameServices } from '@/core/Services';
import type { SceneParams } from '@/core/StateMachine';
import {
  ENEMIES,
  MISSIONS,
  PLANET_IDS,
  PLANETS,
  UPGRADES,
  type MissionId,
  type PlanetId,
  type ShipSystemDef,
} from '@/data/index';
import { Economy } from '@/systems/Economy';
import { Progression } from '@/systems/Progression';
import { departReason, formatTime, missionStatus, requirementText } from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { el, h, testId } from '@/ui/dom';
import { UiScene } from '@/scenes/base';

const MISSION_IDS = Object.keys(MISSIONS) as MissionId[];
const ENGINE: ShipSystemDef = UPGRADES.engine;

/** The circle the six planets sit on, in world units. */
const ORBIT_RADIUS = 3.1;

export class StarmapScene extends UiScene<'starmap'> {
  #economy: Economy | null = null;
  #selected: PlanetId = PLANET_IDS[0]!;
  #leaving = false;

  #root: HTMLDivElement | null = null;
  #nodesBox: HTMLDivElement | null = null;
  #info: HTMLDivElement | null = null;
  #ring: THREE.Mesh | null = null;
  readonly #nodeMeshes = new Map<PlanetId, THREE.Mesh>();

  constructor(services: GameServices) {
    // No track named: the station bed keeps playing across the map (SPEC-006).
    super(services, 'starmap');
  }

  protected onEnter(_params: SceneParams['starmap']): void {
    const data = this.services.save.current;
    if (data !== null) {
      const progression = new Progression(data, this.services.events);
      this.#economy = new Economy(data, this.services.events, progression, this.services.save);
    }
    this.#buildMap();
    this.#mountUi();
    this.disposer.add(this.services.events.on('renderer:resized', () => this.#layoutNodes(), this));
    const onKey = (event: KeyboardEvent): void => this.#onArrows(event);
    document.addEventListener('keydown', onKey);
    this.disposer.add(() => document.removeEventListener('keydown', onKey));
  }

  protected override onUpdate(_dt: number): void {
    if (this.#ring) this.#ring.rotation.z = this.elapsed * 0.8;
  }

  // ------------------------------------------------------------------ Three

  /** AC-50/52: overhead camera, six spheres, the station point, the ring. */
  #buildMap(): void {
    this.camera.position.set(0, 8, 0.001);
    this.camera.lookAt(0, 0, 0);
    const station = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xdfe8f3, emissive: 0x8899aa, emissiveIntensity: 0.7 }),
    );
    this.scene.add(station);
    PLANET_IDS.forEach((planet, index) => {
      const position = this.#worldOf(index);
      const unlocked = this.#economy?.isUnlocked(planet) ?? false;
      const accent = new THREE.Color(PLANETS[planet].surface.palette.accent);
      const material = new THREE.MeshStandardMaterial({
        color: accent,
        emissive: accent,
        // AC-50: lit against dim is a material state, not just DOM dressing.
        emissiveIntensity: unlocked ? 0.55 : 0.06,
      });
      if (!unlocked) material.color.multiplyScalar(0.45);
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12), material);
      mesh.position.copy(position);
      this.#nodeMeshes.set(planet, mesh);
      this.scene.add(mesh);
    });
    // AC-51: the selection ring, flat on the plane under the chosen node.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.44, 0.52, 32),
      new THREE.MeshBasicMaterial({ color: 0x4c9aff, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    ring.rotation.x = -Math.PI / 2;
    this.scene.add(ring);
    this.#ring = ring;
    this.props = PLANET_IDS.length + 2;
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 6, 1);
    this.scene.add(key);
    this.#moveRing();
  }

  #worldOf(index: number): THREE.Vector3 {
    const angle = (index / PLANET_IDS.length) * Math.PI * 2 - Math.PI / 2;
    return new THREE.Vector3(Math.cos(angle) * ORBIT_RADIUS, 0, Math.sin(angle) * ORBIT_RADIUS);
  }

  #moveRing(): void {
    const mesh = this.#nodeMeshes.get(this.#selected);
    if (mesh && this.#ring) this.#ring.position.set(mesh.position.x, 0.01, mesh.position.z);
  }

  // -------------------------------------------------------------------- DOM

  #mountUi(): void {
    this.#nodesBox = el('div', 'starmap-nodes');
    this.#info = el('div', 'starmap-info panel');
    const back = testId(
      h('button', { class: 'ui-btn starmap-back', type: 'button', click: () => this.#back() }, 'Back'),
      'starmap-back',
    );
    this.#root = testId(el('div', 'starmap-root'), 'starmap-root');
    this.#root.append(this.#nodesBox, this.#info, back);
    this.ui.mount(this.#root, 'panel');
    this.disposer.add(() => {
      if (this.#root) this.ui.unmount(this.#root);
      this.#root = null;
      this.#nodesBox = null;
      this.#info = null;
      this.#economy = null;
      this.#nodeMeshes.clear();
      this.#ring = null;
    });
    this.#layoutNodes();
    this.#renderInfo();
  }

  /**
   * The DOM hit areas over the projected node positions (AC-52): the camera is
   * fixed, so this runs on enter and on resize, never in the frame loop.
   */
  #layoutNodes(): void {
    const box = this.#nodesBox;
    if (box === null) return;
    const { width, height } = this.services.renderer;
    if (this.camera.aspect !== width / height) {
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    const buttons = PLANET_IDS.map((planet, index) => {
      const projected = this.#worldOf(index).project(this.camera);
      const x = (projected.x * 0.5 + 0.5) * width;
      const y = (-projected.y * 0.5 + 0.5) * height;
      const unlocked = this.#economy?.isUnlocked(planet) ?? false;
      return testId(
        h(
          'button',
          {
            class: `starmap-node${unlocked ? '' : ' is-locked'}${this.#selected === planet ? ' is-selected' : ''}`,
            type: 'button',
            style: `left:${Math.round(x)}px;top:${Math.round(y)}px`,
            'aria-label': `${PLANETS[planet].name}${unlocked ? '' : ' (locked)'}`,
            'aria-pressed': String(this.#selected === planet),
            click: () => this.#select(planet),
          },
          h('span', { class: 'starmap-node-name' }, PLANETS[planet].name),
          // AC-50: the lock glyph on dim nodes.
          unlocked ? null : h('span', { class: 'starmap-lock' }, '🔒'),
        ),
        `map-node-${planet}`,
      );
    });
    box.replaceChildren(...buttons);
  }

  #select(planet: PlanetId): void {
    this.#selected = planet;
    this.#moveRing();
    this.#layoutNodes();
    this.#renderInfo();
  }

  /** AC-52: arrows walk the circle. */
  #onArrows(event: KeyboardEvent): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    const at = PLANET_IDS.indexOf(this.#selected);
    this.#select(PLANET_IDS[(at + step + PLANET_IDS.length) % PLANET_IDS.length]!);
    event.preventDefault();
  }

  // ------------------------------------------------------------- info panel

  /** AC-53/54: everything the decision needs, on one panel. */
  #renderInfo(): void {
    const info = this.#info;
    if (info === null) return;
    const planet = PLANETS[this.#selected];
    const data = this.services.save.current;
    const economy = this.#economy;
    if (data === null || economy === null) {
      info.replaceChildren(h('p', { class: 'starmap-name' }, planet.name), h('p', { class: 'settings-note' }, 'No save loaded.'));
      return;
    }
    const fuel = economy.fuelCost(this.#selected);
    const oil = data.resources.oil;
    // Travel shortens as the engine speeds up: seconds / speedMult[tier].
    const speed = ENGINE.metrics['speedMult']?.[data.ship.engine] ?? 1;
    const travel = formatTime(Math.round(planet.travelSeconds / speed));
    const resources = [...new Set(planet.surface.nodes.map((node) => node.resource))].join(' · ') || '—';
    const threats = [...new Set(planet.surface.spawn.map((entry) => ENEMIES[entry.enemy].name))].join(' · ') || '—';
    const missing = economy.missingRequirements(planet.unlock);
    const requirements =
      planet.unlock.length === 0
        ? [h('li', { class: 'req-met' }, '✓ Open approach')]
        : planet.unlock.map((requirement) => {
            const met = !missing.includes(requirement);
            return h('li', { class: met ? 'req-met' : 'req-unmet' }, `${met ? '✓' : '✗'} ${requirementText(requirement)}`);
          });
    const missions = MISSION_IDS.filter((id) => MISSIONS[id].planet === this.#selected)
      .map((id) => ({ id, status: missionStatus(data, MISSIONS[id], 'station') }))
      .filter((entry) => entry.status === 'active' || entry.status === 'available');
    const result = economy.canDepart(this.#selected);
    const reason = departReason(result);
    const depart = testId(
      h(
        'button',
        {
          class: 'ui-btn is-primary starmap-depart',
          type: 'button',
          // 14-b/AC-56: disabled mid-transition; AC-54: or with the reason.
          disabled: !result.ok || this.#leaving,
          click: () => this.#depart(),
        },
        'Depart',
      ),
      'starmap-depart',
    );
    info.replaceChildren(
      testId(h('p', { class: 'starmap-name' }, planet.name), 'starmap-info-name'),
      h('p', { class: 'settings-note' }, `${planet.biome} · Chapter ${planet.chapter}`),
      h('p', { class: 'starmap-line' }, `Resources: ${resources}`),
      h('p', { class: 'starmap-line' }, `Threats: ${threats}`),
      testId(h('p', { class: `starmap-line${oil < fuel ? ' is-short' : ''}` }, `Fuel: ${fuel} oil (have ${oil})`), 'starmap-fuel'),
      h('p', { class: 'starmap-line' }, `Travel: ${travel}`),
      h('ul', { class: 'starmap-reqs' }, ...requirements),
      missions.length > 0
        ? h(
            'ul',
            { class: 'starmap-missions' },
            ...missions.map((entry) => h('li', {}, `${entry.status === 'active' ? '▶' : '○'} ${MISSIONS[entry.id].title}`)),
          )
        : h('p', { class: 'settings-note' }, 'No missions here right now.'),
      h('div', { class: 'starmap-depart-line' }, depart, reason === '' ? null : testId(h('span', { class: 'shop-reason' }, reason), 'depart-reason')),
    );
  }

  /** AC-55: fuel and the active missions on the sheet; pay, then fly. */
  #depart(): void {
    if (this.#leaving) return;
    const economy = this.#economy;
    const data = this.services.save.current;
    if (economy === null || data === null) return;
    const planet = this.#selected;
    const fuel = economy.fuelCost(planet);
    const active = data.progress.missionsActive
      .map((entry): string | undefined => MISSIONS[entry.id]?.title)
      .filter((title): title is string => title !== undefined);
    void confirmSheet(
      this.ui,
      {
        title: `Depart for ${PLANETS[planet].name}?`,
        body: `Fuel: ${fuel} oil, charged now — the return trip is free.${active.length > 0 ? `\nActive: ${active.join(', ')}` : ''}`,
        confirmText: 'Depart',
      },
      // Re-validated on the tap: the charge itself is the check (AC-44's twin).
      () => {
        if (!economy.payFuel(planet)) {
          this.ui.toast(departReason(economy.canDepart(planet)) || 'Cannot depart', 'error');
          return false;
        }
        return true;
      },
    ).then((paid) => {
      if (!paid) return;
      this.#leaving = true;
      this.#renderInfo(); // AC-56: Depart greys out for the ride
      void this.services.go('flight', { destination: planet }).then((went) => {
        if (!went) {
          this.#leaving = false;
          this.#renderInfo();
        }
      });
    });
  }

  /** AC-57. */
  #back(): void {
    if (this.#leaving) return;
    this.#leaving = true;
    void this.services.go('station', {}).then((went) => {
      if (!went) this.#leaving = false;
    });
  }
}
