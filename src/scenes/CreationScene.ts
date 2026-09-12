// Character creation (SPEC-014 §4.2). One form over a starfield: name, three
// class cards, six portraits, two colour rows, the five-point allocation with
// its live `computePlayerStats` preview, the difficulty toggle — and the
// tinted Kenney model rendered by the *main* renderer through a scissor
// viewport that tracks a placeholder box in the form (AC-19).
//
// Confirm is disabled until a class is chosen; it then writes the save
// (`save.create`), enters the station and queues the `intro_command`
// dialogue once the transition has landed — the queue clears on
// `scene:transition` (14-d), so queueing earlier would erase it.
import * as THREE from 'three';
import { log } from '@/core/Log';
import { normalizeName, type CharacterCreation, type SlotId } from '@/core/Save';
import type { GameServices } from '@/core/Services';
import type { Renderer } from '@/core/Renderer';
import type { SceneParams } from '@/core/StateMachine';
import { ATTRIBUTE_MAX, CLASSES, CREATION_POINTS, type Attributes, type ClassId } from '@/data/index';
import { computePlayerStats, passiveText } from '@/systems/UiHelpers';
import { dialogueLayer } from '@/ui/DialogueUI';
import { el, h, testId } from '@/ui/dom';
import { portraitManifest, portraitSource } from '@/ui/portraits';
import type { Look } from '@/core/Quality';
import { tintSalvager } from '@/views/CharacterView';
import { NEUTRAL_SKY } from '@/views/Environment';
import { addHubLights, hubSkyMesh, loadHubSky } from '@/views/HubBackdrop';
import { UiScene } from '@/scenes/base';

const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
const ATTRIBUTES = ['might', 'vigor', 'agility', 'tech'] as const;

/** AC-16: eight swatches a side. Hex pairs the save schema stores verbatim. */
export const PRIMARY_SWATCHES = ['#b7472a', '#2a6db7', '#3e8e4f', '#8e3e8e', '#b7972a', '#7a7a7a', '#a0522d', '#20b2aa'] as const;
export const SECONDARY_SWATCHES = ['#2a3b4c', '#4c2a3b', '#3b4c2a', '#24243a', '#4c3b2a', '#2e4c4a', '#3d3d3d', '#552a2a'] as const;

/** AC-15: six faces — the class's own three, then three every class shares. */
const SHARED_PORTRAITS = [9, 10, 11] as const;

/** SPEC-017 §4.1 (*initial tuning*): creation shares the station's grade. */
const CREATION_LOOK: Partial<Look> = { vignette: 0.35, bloomStrength: 0.3, tint: [0.96, 1, 1.04] };
const HUB_ENVIRONMENT_INTENSITY = 0.9;

/** AC-18: the one-line explanation beside the toggle. */
const DIFFICULTY_LINES = {
  normal: 'Normal — the pressure the game was tuned for.',
  casual: 'Casual — softer hits and kinder deaths; the story is unchanged.',
} as const;

export class CreationScene extends UiScene<'creation'> {
  #slot: SlotId = 0;

  // Form state; the DOM is re-rendered from it on every change.
  #classId: ClassId | null = null;
  #portrait = 0;
  #primary: string = PRIMARY_SWATCHES[0];
  #secondary: string = SECONDARY_SWATCHES[0];
  #alloc: Record<(typeof ATTRIBUTES)[number], number> = { might: 0, vigor: 0, agility: 0, tech: 0 };
  #difficulty: 'casual' | 'normal' = 'normal';
  /** SPEC-020 §4.6: the portrait files that shipped; empty until the manifest lands. */
  #portraits: ReadonlySet<number> = new Set();
  #leaving = false;

  #root: HTMLDivElement | null = null;
  #form: HTMLDivElement | null = null;
  #nameField: HTMLInputElement | null = null;
  #previewBox: HTMLDivElement | null = null;

  /** §4.4: the backdrop's one group — the starfield, the lights, the window. */
  readonly #backdrop = new THREE.Group();

  // The scissor pass (AC-19): its own little scene, lit for a portrait.
  readonly #previewScene = new THREE.Scene();
  readonly #previewCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 20);
  #model: THREE.Object3D | null = null;
  #tintable: THREE.MeshStandardMaterial[] = [];
  /** The box in renderer pixels, measured outside the frame loop only. */
  #viewport: { x: number; y: number; w: number; h: number } | null = null;

  constructor(services: GameServices) {
    // No track named on purpose: creation sits between menu and station, and
    // re-stating the bed would restart a crossfade for nothing (SPEC-006).
    super(services, 'creation');
  }

  protected override look(): Partial<Look> {
    return CREATION_LOOK;
  }

  protected onEnter(params: SceneParams['creation']): void {
    this.#slot = params.slot;
    this.useEnvironment(NEUTRAL_SKY, HUB_ENVIRONMENT_INTENSITY);
    this.#buildBackdrop();
    this.#buildPreviewScene();
    this.#mountUi();
    // §4.6: the busts are optional art — the form goes up with glyphs and
    // re-renders once the manifest says which files shipped (20-d).
    let alive = true;
    this.disposer.add(() => {
      alive = false;
    });
    void portraitManifest().then((available) => {
      if (!alive || available.size === 0) return;
      this.#portraits = available;
      this.#renderForm();
    });
    this.disposer.add(this.services.events.on('renderer:resized', () => this.#measure(), this));
  }

  protected override onUpdate(_dt: number): void {
    if (this.#model) this.#model.rotation.y = this.elapsed * 0.5;
  }

  override render(renderer: Renderer): void {
    super.render(renderer);
    const box = this.#viewport;
    if (box === null || box.w < 8 || box.h < 8) return;
    if (this.#previewCamera.aspect !== box.w / box.h) {
      this.#previewCamera.aspect = box.w / box.h;
      this.#previewCamera.updateProjectionMatrix();
    }
    // AC-19, now through SPEC-017's seam (17-e): the one renderer, confined to
    // the form's preview box, drawn straight to the canvas after the post chain
    // has put the frame there. The portrait is tone-mapped by its materials and
    // takes no bloom and no grade, which is what a preview swatch wants.
    renderer.renderOverlay(this.#previewScene, this.#previewCamera, box);
  }

  override dispose(): void {
    super.dispose();
    // The tinted clones are this scene's own; the template's materials are
    // shared-marked and survive (SPEC-002 D-33).
    for (const material of this.#tintable.splice(0)) material.dispose();
    if (this.#model) this.#previewScene.remove(this.#model);
  }

  // ------------------------------------------------------------------ Three

  /**
   * A thin echo of the menu starfield, so the form floats over something —
   * SPEC-020 §4.4 puts it under one `Group` with the shared key + rim pair and
   * the station window behind it. `props` stays the 1 SPEC-014 pins.
   */
  #buildBackdrop(): void {
    const group = this.#backdrop;
    addHubLights(group);
    this.scene.add(group);
    let alive = true;
    this.disposer.add(() => {
      alive = false;
    });
    loadHubSky(this.services.assets, () => alive, (sky) => group.add(hubSkyMesh(sky)));
    const positions = new Float32Array(240 * 3);
    for (let i = 0; i < 240; i++) {
      const a = ((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1;
      const b = ((Math.sin(i * 78.233) * 12578.1459) % 1 + 1) % 1;
      const c = ((Math.sin(i * 39.425) * 26251.5439) % 1 + 1) % 1;
      positions[i * 3] = (a - 0.5) * 24;
      positions[i * 3 + 1] = (b - 0.5) * 14;
      positions[i * 3 + 2] = -3 - c * 18;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const stars = new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x5a7089, size: 0.04 }));
    group.add(stars);
    this.props = 1;
  }

  /** The tinted model (AC-19); its absence is a warning, never a wall. */
  #buildPreviewScene(): void {
    this.#previewScene.add(new THREE.AmbientLight(0xaabbcc, 1.6));
    // +15 % over the pre-SPEC-017 value, to offset ACES mid-tone compression.
    const key = new THREE.DirectionalLight(0xffffff, 2.53);
    key.position.set(1.5, 2.5, 2);
    this.#previewScene.add(key);
    // SPEC-020 §4.4: the portrait gets the hub's rim light and the same neutral
    // environment the scene behind it uses — one texture, owned by `base`'s
    // `useEnvironment`, borrowed here and let go first.
    const rim = new THREE.DirectionalLight(0x4c9aff, 0.6);
    rim.position.set(-3, 1.5, -4);
    this.#previewScene.add(rim);
    this.#previewScene.environment = this.scene.environment;
    this.#previewScene.environmentIntensity = this.scene.environmentIntensity;
    this.#previewCamera.position.set(0, 1.0, 2.6);
    this.#previewCamera.lookAt(0, 0.8, 0);
    this.disposer.add(() => {
      // Lights hold no GPU memory; the model's own clones are handled above.
      this.#previewScene.environment = null;
      this.#previewScene.clear();
    });
    if (!this.services.assets.loaded) return;
    try {
      const model = this.services.assets.model('character');
      model.position.set(0, 0, 0);
      // Own clones of the shared materials, so the tint never leaks into the
      // cached template or the menu's instance.
      model.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) return;
        const source = mesh.material;
        const clones = (Array.isArray(source) ? source : [source]).map((entry) => (entry as THREE.MeshStandardMaterial).clone());
        mesh.material = Array.isArray(source) ? clones : clones[0]!;
        this.#tintable.push(...clones);
      });
      this.#previewScene.add(model);
      this.#model = model;
      this.#applyTint();
    } catch (error) {
      log.warn('scene', 'the creation preview could not load the model; the form runs without it', error);
    }
  }

  /**
   * AC-16, through SPEC-019 §4.1's shared `tintSalvager`: primary is the body
   * colour, secondary the emissive cast rescaled to full brightness at
   * intensity 2 — the same call the surface view makes, so the preview
   * matches the planet exactly (SPEC-019 AC-24).
   */
  #applyTint(): void {
    for (const material of this.#tintable) tintSalvager(material, this.#primary, this.#secondary);
  }

  /** The preview box in renderer coordinates; measured outside the loop. */
  #measure(): void {
    const box = this.#previewBox;
    if (box === null) {
      this.#viewport = null;
      return;
    }
    const rect = box.getBoundingClientRect();
    this.#viewport = {
      x: Math.max(0, Math.round(rect.left)),
      y: Math.max(0, Math.round(this.services.renderer.height - rect.bottom)),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  // -------------------------------------------------------------------- DOM

  #mountUi(): void {
    this.#form = el('div', 'creation-form panel');
    // The preview box lives *beside* the opaque form panel: the scissor pass
    // draws on the canvas underneath, so nothing solid may cover the box.
    this.#previewBox = testId(el('div', 'creation-preview'), 'creation-preview');
    // A passive layout shift (font swap, a scrollbar appearing) moves the box
    // without a resize event; the observer keeps the scissor pass honest.
    const observer = new ResizeObserver(() => this.#measure());
    observer.observe(this.#previewBox);
    this.disposer.add(() => observer.disconnect());
    const side = el('div', 'creation-side');
    side.append(this.#previewBox, el('p', 'creation-preview-label', 'Preview'));
    this.#root = testId(el('div', 'creation-root'), 'creation-root');
    this.#root.append(this.#form, side);
    this.ui.mount(this.#root, 'panel');
    this.disposer.add(() => {
      if (this.#root) this.ui.unmount(this.#root);
      this.#root = null;
      this.#form = null;
      this.#nameField = null;
      this.#previewBox = null;
      this.#viewport = null;
    });
    this.#renderForm();
  }

  #spent(): number {
    return ATTRIBUTES.reduce((sum, attribute) => sum + this.#alloc[attribute], 0);
  }

  /** Base + allocation — what the save will actually store. */
  #totals(): Attributes {
    const base = this.#classId !== null ? CLASSES[this.#classId].baseAttributes : { might: 0, vigor: 0, agility: 0, tech: 0 };
    return {
      might: base.might + this.#alloc.might,
      vigor: base.vigor + this.#alloc.vigor,
      agility: base.agility + this.#alloc.agility,
      tech: base.tech + this.#alloc.tech,
    };
  }

  #renderForm(): void {
    if (this.#form === null) return;
    // The name field survives re-renders by value, not by node: keep the text.
    const nameValue = this.#nameField?.value ?? '';
    this.#nameField = testId(
      h('input', { class: 'creation-name', type: 'text', maxlength: 16, placeholder: 'Salvager', 'aria-label': 'Name', value: nameValue }),
      'creation-name',
    );
    this.#form.replaceChildren(
      h('p', { class: 'creation-title' }, 'New salvager'),
      h('label', { class: 'creation-row' }, h('span', {}, 'Name'), this.#nameField),
      this.#classCards(),
      this.#portraitRow(),
      this.#swatchRow('Primary', PRIMARY_SWATCHES, this.#primary, (colour) => {
        this.#primary = colour;
      }),
      this.#swatchRow('Secondary', SECONDARY_SWATCHES, this.#secondary, (colour) => {
        this.#secondary = colour;
      }),
      this.#attributeRows(),
      this.#statsPreview(),
      this.#difficultyRow(),
      this.#previewAndConfirm(),
    );
    this.#measure();
  }

  /** AC-14: three cards — name, blurb, passive, base attributes; tap selects. */
  #classCards(): HTMLDivElement {
    const cards = CLASS_IDS.map((id) => {
      const cls = CLASSES[id];
      const base = cls.baseAttributes;
      return testId(
        h(
          'button',
          {
            class: `class-card${this.#classId === id ? ' is-selected' : ''}`,
            type: 'button',
            'aria-pressed': String(this.#classId === id),
            click: () => {
              this.#classId = id;
              // The class brings its own faces; keep the pick if it is shared.
              if (!this.#portraitChoices().includes(this.#portrait)) this.#portrait = cls.portraits[0] ?? 0;
              this.#renderForm();
            },
          },
          h('span', { class: 'class-name' }, cls.name),
          h('span', { class: 'class-blurb' }, cls.blurb),
          h('span', { class: 'class-passive' }, passiveText(cls.passive)),
          h('span', { class: 'class-base' }, `MGT ${base.might} · VGR ${base.vigor} · AGI ${base.agility} · TEC ${base.tech}`),
        ),
        `class-${id}`,
      );
    });
    return h('div', { class: 'class-cards' }, ...cards) as HTMLDivElement;
  }

  /** AC-15: the class's three portraits plus the three shared ones. */
  #portraitChoices(): number[] {
    const own = this.#classId !== null ? CLASSES[this.#classId].portraits : CLASSES[CLASS_IDS[0]!].portraits;
    return [...own, ...SHARED_PORTRAITS];
  }

  #portraitRow(): HTMLDivElement {
    const tiles = this.#portraitChoices().map((index) => {
      const source = portraitSource(index, this.#portraits);
      return testId(
        h(
          'button',
          {
            class: `portrait${this.#portrait === index ? ' is-selected' : ''}`,
            type: 'button',
            'aria-label': `Portrait ${index + 1}`,
            'aria-pressed': String(this.#portrait === index),
            click: () => {
              this.#portrait = index;
              this.#renderForm();
            },
          },
          source.kind === 'image'
            ? h('img', { class: 'portrait-img', src: source.url, alt: '', 'aria-hidden': 'true' })
            : source.glyph,
        ),
        `portrait-${index}`,
      );
    });
    return h('div', { class: 'creation-row' }, h('span', {}, 'Portrait'), h('div', { class: 'portrait-row' }, ...tiles)) as HTMLDivElement;
  }

  #swatchRow(label: string, swatches: readonly string[], active: string, write: (colour: string) => void): HTMLDivElement {
    const tiles = swatches.map((colour) =>
      testId(
        h('button', {
          class: `swatch${active === colour ? ' is-selected' : ''}`,
          type: 'button',
          style: `background:${colour}`,
          'aria-label': `${label} colour ${colour}`,
          'aria-pressed': String(active === colour),
          click: () => {
            write(colour);
            this.#applyTint();
            this.#renderForm();
          },
        }),
        `swatch-${label.toLowerCase()}-${colour.slice(1)}`,
      ),
    );
    return h('div', { class: 'creation-row' }, h('span', {}, label), h('div', { class: 'swatch-row' }, ...tiles)) as HTMLDivElement;
  }

  /** AC-17: plus/minus per attribute against the five-point pool. */
  #attributeRows(): HTMLDivElement {
    const left = CREATION_POINTS - this.#spent();
    const rows = ATTRIBUTES.map((attribute) => {
      const total = this.#totals()[attribute];
      const minus = testId(
        h(
          'button',
          {
            class: 'ui-btn attr-btn',
            type: 'button',
            'aria-label': `Remove a point from ${attribute}`,
            disabled: this.#alloc[attribute] === 0,
            click: () => {
              this.#alloc[attribute]--;
              this.#renderForm();
            },
          },
          '−',
        ),
        `attr-${attribute}-minus`,
      );
      const plus = testId(
        h(
          'button',
          {
            class: 'ui-btn attr-btn',
            type: 'button',
            'aria-label': `Add a point to ${attribute}`,
            disabled: left === 0 || total >= ATTRIBUTE_MAX,
            click: () => {
              this.#alloc[attribute]++;
              this.#renderForm();
            },
          },
          '+',
        ),
        `attr-${attribute}-plus`,
      );
      return h(
        'div',
        { class: 'attr-row' },
        h('span', { class: 'attr-name' }, attribute),
        minus,
        testId(h('span', { class: 'attr-value' }, String(total)), `attr-${attribute}`),
        plus,
      );
    });
    return h(
      'div',
      { class: 'creation-attrs' },
      h('p', { class: 'creation-subtitle' }, `Attributes — ${left} point${left === 1 ? '' : 's'} left`),
      ...rows,
    ) as HTMLDivElement;
  }

  /** AC-17: HP / damage / speed, live off `computePlayerStats`. */
  #statsPreview(): HTMLDivElement {
    if (this.#classId === null) {
      return h('div', { class: 'creation-stats' }, h('span', { class: 'settings-note' }, 'Pick a class to see the numbers.')) as HTMLDivElement;
    }
    const stats = computePlayerStats(this.#classId, this.#totals(), 1);
    return testId(
      h(
        'div',
        { class: 'creation-stats' },
        h('span', {}, `♥ ${stats.hp} HP`),
        h('span', {}, `⚔ ${stats.damage} damage`),
        h('span', {}, `➤ ${stats.speed} m/s`),
      ),
      'creation-stats',
    ) as HTMLDivElement;
  }

  /** AC-18: two positions and one honest line. */
  #difficultyRow(): HTMLDivElement {
    const seg = (['normal', 'casual'] as const).map((choice) =>
      testId(
        h(
          'button',
          {
            class: `ui-btn seg${this.#difficulty === choice ? ' is-active' : ''}`,
            type: 'button',
            'aria-pressed': String(this.#difficulty === choice),
            click: () => {
              this.#difficulty = choice;
              this.#renderForm();
            },
          },
          choice.charAt(0).toUpperCase() + choice.slice(1),
        ),
        `difficulty-${choice}`,
      ),
    );
    return h(
      'div',
      { class: 'creation-difficulty' },
      h('div', { class: 'creation-row' }, h('span', {}, 'Difficulty'), h('div', { class: 'settings-seg' }, ...seg)),
      h('p', { class: 'settings-note' }, DIFFICULTY_LINES[this.#difficulty]),
    ) as HTMLDivElement;
  }

  #previewAndConfirm(): HTMLDivElement {
    const confirm = testId(
      h(
        'button',
        {
          class: 'ui-btn is-primary creation-confirm',
          type: 'button',
          // AC-20: no class, no button.
          disabled: this.#classId === null || this.#leaving,
          click: () => this.#confirm(),
        },
        'Confirm',
      ),
      'creation-confirm',
    );
    return h('div', { class: 'creation-foot' }, confirm) as HTMLDivElement;
  }

  /** AC-20: write the save, enter the station, then the intro speaks. */
  #confirm(): void {
    if (this.#classId === null || this.#leaving) return;
    this.#leaving = true;
    const creation: CharacterCreation = {
      name: normalizeName(this.#nameField?.value),
      classId: this.#classId,
      appearance: { portrait: this.#portrait, primary: this.#primary, secondary: this.#secondary },
      attributes: this.#totals(),
      difficulty: this.#difficulty,
    };
    // The store resolves the seed (the ?seed flag, else its own); passing none
    // here keeps SPEC-008's single seeding path.
    this.services.save.create(this.#slot, creation);
    const services = this.services;
    void services.go('station', {}).then((went) => {
      if (!went) {
        this.#leaving = false;
        return;
      }
      // Queued after the transition, or 14-d would clear it with the scene.
      void dialogueLayer(services.uiRoot, services.events, {
        input: services.input,
        saveKey: () => services.save.current,
      }).play('intro_command');
    });
  }
}
