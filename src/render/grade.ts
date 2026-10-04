// Final colour grade: exposure, AgX tone mapping with a gentle "look", vignette, film grain and dither.
// One effect so the order is explicit and nothing else touches the tone curve.
import { BlendFunction, Effect } from 'postprocessing';
import { Uniform, Vector2, Vector3 } from 'three';

const frag = /* glsl */ `
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform vec3 uWhite;
uniform float uVignette;
uniform float uGrain;
uniform float uTime;
uniform vec2 uAspect;

// AgX after three.js / Filament (MIT), identifiers renamed to avoid clashes inside the merged EffectPass shader.
const mat3 gR2020_TO_SRGB = mat3(
  vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 gSRGB_TO_R2020 = mat3(
  vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 gAgxInset = mat3(
  vec3(0.856627153315983, 0.137318972929847, 0.11189821299995),
  vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903),
  vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 gAgxOutset = mat3(
  vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826),
  vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294),
  vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));

vec3 gAgxCurve(vec3 x) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

vec3 gAgx(vec3 c) {
  const float minEv = -12.47393;
  const float maxEv = 4.026069;
  c = gSRGB_TO_R2020 * c;
  c = gAgxInset * c;
  c = max(c, 1e-10);
  c = clamp((log2(c) - minEv) / (maxEv - minEv), 0.0, 1.0);
  c = gAgxCurve(c);
  // look: contrast (power) and saturation, applied in the AgX log domain like Blender's looks
  c = pow(max(c, 0.0), vec3(uContrast));
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = l + uSaturation * (c - l);
  c = gAgxOutset * c;
  c = pow(max(vec3(0.0), c), vec3(2.2));
  c = gR2020_TO_SRGB * c;
  return clamp(c, 0.0, 1.0);
}

float gHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb * uExposure * uWhite;
  c = gAgx(c);
  // vignette: soft, slightly oval, darkens toward the corners
  vec2 q = (uv - 0.5) * uAspect;
  float v = smoothstep(0.95, 0.2, length(q) * 1.15);
  c *= mix(1.0 - uVignette, 1.0, v);
  // grain: luminance-weighted so shadows stay clean-ish, animated
  float g = gHash(uv * 1733.0 + fract(uTime * 7.31) * 113.0) + gHash(uv * 977.0 - fract(uTime * 3.17) * 71.0) - 1.0;
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += g * uGrain * (0.35 + 0.65 * sqrt(lum)) * 0.06;
  // dither to break 8-bit banding in the dark gradients of space and the cabin
  c += (gHash(uv * 4096.0 + uTime) - 0.5) / 255.0;
  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', frag, {
      blendFunction: BlendFunction.SRC,
      uniforms: new Map<string, Uniform>([
        ['uExposure', new Uniform(1)],
        ['uContrast', new Uniform(1.12)],
        ['uSaturation', new Uniform(1.12)],
        ['uWhite', new Uniform(new Vector3(1, 1, 1))],
        ['uVignette', new Uniform(0.38)],
        ['uGrain', new Uniform(0.3)],
        ['uTime', new Uniform(0)],
        ['uAspect', new Uniform(new Vector2(1, 1))],
      ]),
    });
  }

  set exposure(v: number) {
    this.uniforms.get('uExposure')!.value = v;
  }
  get exposure(): number {
    return this.uniforms.get('uExposure')!.value;
  }

  setLook(contrast: number, saturation: number) {
    this.uniforms.get('uContrast')!.value = contrast;
    this.uniforms.get('uSaturation')!.value = saturation;
  }

  setWhiteBalance(r: number, g: number, b: number) {
    (this.uniforms.get('uWhite')!.value as Vector3).set(r, g, b);
  }

  setVignette(v: number) {
    this.uniforms.get('uVignette')!.value = v;
  }

  setGrain(v: number) {
    this.uniforms.get('uGrain')!.value = v;
  }

  override setSize(width: number, height: number): void {
    const a = width / Math.max(1, height);
    (this.uniforms.get('uAspect')!.value as Vector2).set(a > 1 ? a : 1, a > 1 ? 1 : 1 / a);
  }

  override update(_r: unknown, _i: unknown, dt?: number): void {
    const u = this.uniforms.get('uTime')!;
    u.value = (u.value + (dt ?? 0.016)) % 1000;
  }
}
