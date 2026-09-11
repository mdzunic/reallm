// The post-processing chain (SPEC-017 §4.3), built behind `Renderer.render()`
// — the one seam every scene already draws through, so no scene knows this
// file exists. PLAN R6-1 authorises it and R6-2 puts `core/PostChain.ts` in
// SPEC-001 §4's `three` allow-list beside `Renderer`, `Assets`, `Disposer` and
// `Benchmark`.
//
// Order matters and is fixed: bloom thresholds linear HDR, so it runs before
// the encode; `OutputPass` is the only place ACES and the sRGB transfer happen
// on the composer path; FXAA needs display-referred pixels, so it comes after
// it; and the grade is last, because a vignette or grain fed into an edge
// detector would be sharpened rather than shown.
//
// Cost per frame (§4.3): bloom 13 quads (bright 1, five mips × two blur
// directions = 10, composite 1, blend 1) + output 1 + FXAA 1 + grade 1 = 16,
// or 15 when `high` takes the MSAA path and drops FXAA.
import {
  Camera,
  HalfFloatType,
  Scene,
  UniformsUtils,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import type { Look, PostPlan } from '@/core/Quality';

/** The grain's period: a minute of frames at 60 Hz, so `uTime` never drifts. */
const GRAIN_PERIOD_FRAMES = 3600;

interface GradeUniforms {
  uVignette: { value: number };
  uSaturation: { value: number };
  uContrast: { value: number };
  uGrain: { value: number };
  uTime: { value: number };
  uTint: { value: Vector3 };
  uAspect: { value: Vector2 };
}

/**
 * The grade (§4.3). Display-referred in, display-referred out — `OutputPass`
 * has already encoded, so this must never encode again. Lift / gamma / gain sit
 * at their neutral values in v1 and are the seam SPEC-018 grades through.
 */
const GRADE_SHADER = {
  name: 'ReallmGrade',
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.35 },
    uSaturation: { value: 1.05 },
    uContrast: { value: 1.03 },
    uGrain: { value: 0.025 },
    uTime: { value: 0 },
    uTint: { value: new Vector3(1, 1, 1) },
    uLift: { value: new Vector3(0, 0, 0) },
    uGamma: { value: new Vector3(1, 1, 1) },
    uGain: { value: new Vector3(1, 1, 1) },
    uAspect: { value: new Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uVignette, uSaturation, uContrast, uGrain, uTime;
    uniform vec3 uTint, uLift, uGamma, uGain;
    uniform vec2 uAspect;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c = pow(max(c * uGain + uLift * (1.0 - c), 0.0), 1.0 / uGamma);
      c = (c - 0.5) * uContrast + 0.5;
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation) * uTint;
      float r = length((vUv - 0.5) * uAspect);
      c *= mix(1.0 - uVignette, 1.0, smoothstep(0.85, 0.35, r));
      c += (hash(vUv * 1024.0 + fract(uTime) * 97.0) - 0.5) * uGrain * (1.0 - l);
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
};

/**
 * `UnrealBloomPass` halves whatever size it is handed for its bright pass, so
 * giving it `2 · scale · w` puts that pass at `scale` of the frame: ¼ on
 * `lite`, ½ on `full`, across the five mips three's implementation blurs.
 *
 * The brand check covers the one ordering hazard a subclass has: a private
 * field does not exist until after `super()` returns, so if a future `three`
 * ever called `setSize` from the base constructor, reading `#scale` there would
 * throw rather than fall back.
 */
class ScaledBloomPass extends UnrealBloomPass {
  readonly #scale: number;

  constructor(scale: number, strength: number, radius: number, threshold: number) {
    super(new Vector2(256, 256), strength, radius, threshold);
    this.#scale = scale;
  }

  override setSize(width: number, height: number): void {
    const scale = #scale in this ? this.#scale : 0.5;
    super.setSize(Math.max(1, Math.round(2 * scale * width)), Math.max(1, Math.round(2 * scale * height)));
  }
}

function positive(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export class PostChain {
  readonly #composer: EffectComposer;
  readonly #renderPass: RenderPass;
  readonly #bloom: ScaledBloomPass;
  readonly #output: OutputPass;
  readonly #fxaa: FXAAPass | null;
  readonly #grade: ShaderPass;
  readonly #uniforms: GradeUniforms;

  constructor(gl: WebGLRenderer, plan: PostPlan, width: number, height: number, dpr: number, look: Readonly<Look>) {
    const pixelRatio = positive(dpr);
    // Only the target the `RenderPass` draws into needs depth and MSAA, but the
    // composer builds its second buffer by cloning this one, so both end up
    // with the same configuration — which §4.3 explicitly allows and which
    // keeps the sample count correct whichever buffer the pass lands in.
    const target = new WebGLRenderTarget(
      Math.max(1, Math.round(width * pixelRatio)),
      Math.max(1, Math.round(height * pixelRatio)),
      { type: HalfFloatType, depthBuffer: true, stencilBuffer: false, samples: plan.samples },
    );
    target.texture.name = 'PostChain.scene';
    target.texture.generateMipmaps = false;

    this.#composer = new EffectComposer(gl, target);
    this.#composer.renderToScreen = true;

    // One `RenderPass` serves every scene: the scene and camera it draws are
    // rewritten per frame, which costs nothing and never rebuilds the chain.
    // The placeholders it is constructed with are replaced on the first frame.
    this.#renderPass = new RenderPass(new Scene(), new Camera());
    this.#bloom = new ScaledBloomPass(plan.bloomScale, look.bloomStrength, look.bloomRadius, look.bloomThreshold);
    this.#output = new OutputPass();
    this.#fxaa = plan.aa === 'fxaa' ? new FXAAPass() : null;
    // Uniforms cloned per instance, so two chains never share one (§4.3).
    this.#grade = new ShaderPass({
      name: GRADE_SHADER.name,
      uniforms: UniformsUtils.clone(GRADE_SHADER.uniforms),
      vertexShader: GRADE_SHADER.vertexShader,
      fragmentShader: GRADE_SHADER.fragmentShader,
    });
    this.#uniforms = this.#grade.uniforms as unknown as GradeUniforms;

    this.#composer.addPass(this.#renderPass);
    this.#composer.addPass(this.#bloom);
    this.#composer.addPass(this.#output);
    if (this.#fxaa !== null) this.#composer.addPass(this.#fxaa);
    // The composer flags the last enabled pass `renderToScreen` itself, which
    // is the grade and only the grade.
    this.#composer.addPass(this.#grade);

    this.setSize(width, height, pixelRatio);
    this.setLook(look);
  }

  render(scene: Object3D, camera: Camera, frame: number): void {
    this.#renderPass.scene = scene as Scene;
    this.#renderPass.camera = camera;
    // No clock, no `Date`, no `Math.random`: the renderer's frame counter is
    // the only time source the chain has.
    this.#uniforms.uTime.value = (frame % GRAIN_PERIOD_FRAMES) / 60;
    this.#composer.render();
  }

  /**
   * 17-k: a hidden tab measures 0×0 and the renderer clamps it to 1×1, so the
   * CSS size is floored high enough that every target is still at least one
   * pixel once the ratio is applied.
   */
  setSize(width: number, height: number, dpr: number): void {
    const pixelRatio = positive(dpr);
    const floor = Math.ceil(1 / pixelRatio);
    const w = Math.max(floor, Math.round(width));
    const h = Math.max(floor, Math.round(height));
    this.#composer.setPixelRatio(pixelRatio);
    this.#composer.setSize(w, h);
    this.#uniforms.uAspect.value.set(w / h, 1);
  }

  setLook(look: Readonly<Look>): void {
    this.#bloom.strength = look.bloomStrength;
    this.#bloom.radius = look.bloomRadius;
    this.#bloom.threshold = look.bloomThreshold;
    this.#uniforms.uVignette.value = look.vignette;
    this.#uniforms.uSaturation.value = look.saturation;
    this.#uniforms.uContrast.value = look.contrast;
    this.#uniforms.uGrain.value = look.grain;
    this.#uniforms.uTint.value.set(look.tint[0], look.tint[1], look.tint[2]);
  }

  dispose(): void {
    this.#renderPass.dispose();
    this.#bloom.dispose();
    this.#output.dispose();
    this.#fxaa?.dispose();
    this.#grade.dispose();
    // Both buffers, plus the composer's own internal copy pass.
    this.#composer.dispose();
  }
}
