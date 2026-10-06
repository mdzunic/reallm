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
//
// SPEC-044 §4.4: Back leaves for the menu — asking first once anything was
// changed, and saving nothing either way — and is the back-stack's root entry
// here, so Escape and the system Back do the same. Each attribute says what a
// point buys, the class cards spell their base attributes, and a disabled
// Confirm says why. The form re-renders through `keepFocus` (§4.2).
import * as THREE from 'three';
import { log } from '@/core/Log';
import { normalizeName, type CharacterCreation, type SlotId } from '@/core/Save';
import type { GameServices } from '@/core/Services';
import type { Renderer } from '@/core/Renderer';
import type { SceneParams } from '@/core/StateMachine';
import { GLYPHS } from '@/data/glossary';
import {
  ATTRIBUTE_MAX,
  CLASSES,
  CREATION_POINTS,
  KIN_ROW,
  PRIMARY_SWATCHES,
  SECONDARY_SWATCHES,
  SHARED_PORTRAITS,
  type Attributes,
  type ClassId,
  type Difficulty,
} from '@/data/index';
import {
  attributeEffectText,
  attributeLine,
  availableSwatches,
  computePlayerStats,
  DIFFICULTY_LINES,
  passiveText,
} from '@/systems/UiHelpers';
import { confirmSheet } from '@/ui/ConfirmSheet';
import { dialogueLayer } from '@/ui/DialogueUI';
import { el, h, keepFocus, testId } from '@/ui/dom';
import { portraitManifest, portraitSource } from '@/ui/portraits';
import type { Look } from '@/core/Quality';
import { tintSalvager } from '@/views/CharacterView';
import { NEUTRAL_SKY } from '@/views/Environment';
import { addHubLights, hubSkyMesh, loadHubSky } from '@/views/HubBackdrop';
import { UiScene, bindTouchScheme } from '@/scenes/base';
import { createScreen } from '@/ui/Screen';

const CLASS_IDS = Object.keys(CLASSES) as ClassId[];
const ATTRIBUTES = ['might', 'vigor', 'agility', 'tech'] as const;

/**
 * AC-16: eight swatches a side, and AC-15's three shared faces. SPEC-056 §4.6
 * moved them to `data/cosmetics.ts`, which the Locker reads too; the rows
 * render `availableSwatches` — these eight, then the device's unlocks.
 */
export { PRIMARY_SWATCHES, SECONDARY_SWATCHES };

/** SPEC-044 §4.4: the sheet Back opens over a form that was changed. */
export const LEAVE_TITLE = 'Leave without creating a salvager?';
/** SPEC-044 §4.4: what a disabled Confirm says beside itself. */
export const CONFIRM_REASON_TEXT = 'Choose a class to continue';

/** The form as the scene opens it — what Back compares against (§4.4). */
const START_PORTRAIT = 0;
const START_DIFFICULTY: Difficulty = 'normal';

/** SPEC-017 §4.1 (*initial tuning*): creation shares the station's grade. */
const CREATION_LOOK: Partial<Look> = { vignette: 0.35, bloomStrength: 0.3, tint: [0.96, 1, 1.04] };
const HUB_ENVIRONMENT_INTENSITY = 0.9;

export class CreationScene extends UiScene<'creation'> {
  #slot: SlotId = 0;

  // Form state; the DOM is re-rendered from it on every change.
  #classId: ClassId | null = null;
  #portrait = START_PORTRAIT;
  #primary: string = PRIMARY_SWATCHES[0];
  #secondary: string = SECONDARY_SWATCHES[0];
  #alloc: Record<(typeof ATTRIBUTES)[number], number> = { might: 0, vigor: 0, agility: 0, tech: 0 };
  #difficulty: Difficulty = START_DIFFICULTY;
  /** SPEC-044 §4.4: the leave sheet is up; a second Back waits for its answer. */
  #asking = false;
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
    // SPEC-044 §4.4: Back is this scene's root back-stack entry — Escape and
    // the system Back run it once nothing above it is open.
    this.disposer.add(this.ui.pushBack(() => this.#back()));
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

  /** SPEC-034 §4.16: the preview box's last measured viewport top, unclamped. */
  #previewTop = 0;

  /** SPEC-034 §4.16: the measured preview box, for the e2e scroll case. */
  override debugInfo(): Record<string, number | string> {
    const info = super.debugInfo();
    const box = this.#viewport;
    if (box !== null) {
      info['previewX'] = box.x;
      info['previewY'] = box.y;
      info['previewW'] = box.w;
      info['previewH'] = box.h;
      info['previewTop'] = this.#previewTop;
    }
    return info;
  }

  /** The preview box in renderer coordinates; measured outside the loop. */
  #measure(): void {
    const box = this.#previewBox;
    if (box === null) {
      this.#viewport = null;
      return;
    }
    const rect = box.getBoundingClientRect();
    // SPEC-034 §4.16: the raw top, before the clamp below, so the e2e scroll case
    // can see the box follow its frame even where the clamp pins the viewport.
    this.#previewTop = Math.round(rect.top);
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
    // SPEC-031 §4.4: one console frame; the form and preview are its body.
    const screen = createScreen({ id: 'creation' });
    bindTouchScheme(screen.root, this.services, this.disposer, this);
    screen.body.append(this.#root);
    // SPEC-034 §4.16: the preview is drawn with a scissor pass over the canvas
    // *underneath* the form, so it follows a DOM box that the form's scroll
    // moves — and a scrolled form used to leave it behind, floating over the
    // wrong part of the frame. Passive and capture, so a nested scroll counts
    // too; no DOM read is added to `update()`, the measure stays here.
    const onScroll = (): void => this.#measure();
    screen.body.addEventListener('scroll', onScroll, { passive: true, capture: true });
    this.disposer.add(() => screen.body.removeEventListener('scroll', onScroll, { capture: true }));
    this.ui.mount(screen.root, 'panel');
    this.disposer.add(() => {
      this.ui.unmount(screen.root);
      screen.dispose();
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

  /** SPEC-044 §4.2: every change re-renders the form; focus stays on the control pressed. */
  #renderForm(): void {
    const form = this.#form;
    if (form === null) return;
    keepFocus(form, () => this.#buildForm(form));
    this.#measure();
  }

  #buildForm(form: HTMLDivElement): void {
    // The name field survives re-renders by value, not by node: keep the text.
    const nameValue = this.#nameField?.value ?? '';
    this.#nameField = testId(
      h('input', {
        class: 'creation-name',
        type: 'text',
        maxlength: 16,
        placeholder: 'Salvager',
        'aria-label': 'Name',
        value: nameValue,
        // SPEC-037 §4.9: a callsign, not prose — no autofill or autocorrect, a
        // capital per word, no spellcheck underline, and a Done key; Enter
        // closes the phone keyboard by blurring the field.
        autocomplete: 'off',
        autocorrect: 'off',
        autocapitalize: 'words',
        spellcheck: 'false',
        enterkeyhint: 'done',
        keydown: (event: Event) => {
          if ((event as KeyboardEvent).key === 'Enter') (event.currentTarget as HTMLInputElement).blur();
        },
      }),
      'creation-name',
    );
    form.replaceChildren(
      h('p', { class: 'creation-title' }, 'New salvager'),
      h('label', { class: 'creation-row' }, h('span', {}, 'Name'), this.#nameField),
      this.#kinRow(),
      this.#classCards(),
      this.#portraitRow(),
      // SPEC-056 §4.6: the base eight, then the colours this device unlocked.
      this.#swatchRow('Primary', availableSwatches('primary', this.services.settings.get().unlocks), this.#primary, (colour) => {
        this.#primary = colour;
      }),
      this.#swatchRow('Secondary', availableSwatches('secondary', this.services.settings.get().unlocks), this.#secondary, (colour) => {
        this.#secondary = colour;
      }),
      this.#attributeRows(),
      this.#statsPreview(),
      this.#difficultyRow(),
      this.#previewAndConfirm(),
    );
  }

  /**
   * SPEC-049 §4.1: the personnel file's next of kin — the same for every class
   * and name, read-only: no control, nothing in the tab order, nothing saved.
   */
  #kinRow(): HTMLParagraphElement {
    const [label = '', value = ''] = KIN_ROW.split(' — ');
    return testId(
      h('p', { class: 'creation-row creation-kin' }, h('span', {}, label), ' — ', h('span', { class: 'creation-kin-value' }, value)),
      'creation-kin',
    );
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
          // SPEC-044 §4.4: the names spelled out — `Might 3 · Vigor 3 · Agility 1 · Tech 1`.
          h('span', { class: 'class-base' }, attributeLine(base)),
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
        { class: 'attr-item' },
        h(
          'div',
          { class: 'attr-row' },
          // SPEC-045 §4.5: capitalised in the source, so plain text keeps the capital.
          h('span', { class: 'attr-name' }, attribute.charAt(0).toUpperCase() + attribute.slice(1)),
          minus,
          testId(h('span', { class: 'attr-value' }, String(total)), `attr-${attribute}`),
          plus,
        ),
        // SPEC-044 §4.4: what a point buys, off the table the formulas read.
        testId(h('p', { class: 'attr-desc' }, attributeEffectText(attribute)), `attr-${attribute}-desc`),
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
        h('span', {}, `${GLYPHS.health} ${stats.hp} HP`),
        h('span', {}, `⚔ ${stats.damage} damage`),
        h('span', {}, `➤ ${stats.speed} m/s`),
      ),
      'creation-stats',
    ) as HTMLDivElement;
  }

  /** AC-18: three positions since SPEC-043 §4.4 added `hard`, and one honest line. */
  #difficultyRow(): HTMLDivElement {
    const seg = (['normal', 'casual', 'hard'] as const satisfies readonly Difficulty[]).map((choice) =>
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
    // SPEC-044 §4.4: the way back, left of Confirm — and, while no class is
    // chosen, the one reason the disabled Confirm would otherwise leave a puzzle.
    const back = testId(
      h('button', { class: 'ui-btn creation-back', type: 'button', disabled: this.#leaving, click: () => this.#back() }, 'Back'),
      'creation-back',
    );
    const reason =
      this.#classId === null ? testId(h('span', { class: 'creation-confirm-reason' }, CONFIRM_REASON_TEXT), 'creation-confirm-reason') : null;
    return h('div', { class: 'creation-foot' }, back, reason, confirm) as HTMLDivElement;
  }

  /**
   * SPEC-044 §4.4: whether anything differs from the form the scene opened
   * with — a name typed (and still there), a class, a face, either colour, a
   * point spent, the difficulty.
   */
  #changed(): boolean {
    return (
      (this.#nameField?.value ?? '').trim() !== '' ||
      this.#classId !== null ||
      this.#portrait !== START_PORTRAIT ||
      this.#primary !== PRIMARY_SWATCHES[0] ||
      this.#secondary !== SECONDARY_SWATCHES[0] ||
      this.#spent() > 0 ||
      this.#difficulty !== START_DIFFICULTY
    );
  }

  /**
   * SPEC-044 §4.4: `creation-back`, Escape and the system Back. A changed form
   * asks first, with Stay focused; an untouched one leaves at once (44-g).
   * Nothing is saved either way — the slot is only written by Confirm.
   */
  #back(): void {
    if (this.#leaving || this.#asking) return;
    if (!this.#changed()) {
      this.#leave();
      return;
    }
    this.#asking = true;
    void confirmSheet(this.ui, {
      title: LEAVE_TITLE,
      body: 'Nothing is saved.',
      confirmText: 'Leave',
      cancelText: 'Stay',
      focus: 'cancel',
    }).then((yes) => {
      this.#asking = false;
      if (yes) this.#leave();
    });
  }

  #leave(): void {
    if (this.#leaving) return;
    this.#leaving = true;
    void this.services.go('menu', { reason: 'quit' }).then((went) => {
      if (!went) this.#leaving = false;
    });
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
        typewriter: () => services.settings.get().typewriter,
        speed: () => services.settings.get().dialogueSpeed,
      }).play('intro_command');
    });
  }
}
