// Warp jump look: radial streaks + a soft tunnel of light, applied only to what is seen through the windows
// (cabin materials write alpha 0, space writes alpha 1, so alpha is the window mask).
import { BlendFunction, Effect, EffectAttribute } from 'postprocessing';
import { Uniform, Vector3 } from 'three';

const frag = /* glsl */ `
uniform float uAmount;
uniform float uWTime;
uniform vec3 uTint;
uniform float uDebug;

float wHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float wNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(wHash(i), wHash(i + vec2(1.0, 0.0)), f.x), mix(wHash(i + vec2(0.0, 1.0)), wHash(i + vec2(1.0, 1.0)), f.x), f.y);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  float space = clamp(inputColor.a, 0.0, 1.0);
  if (uDebug > 0.5) { outputColor = vec4(space, 0.0, uAmount, 1.0); return; }
  if (uAmount <= 0.001) { outputColor = inputColor; return; }
  if (space <= 0.0) { outputColor = inputColor; return; }
  vec2 c = vec2(0.5);
  vec2 d = uv - c;
  float r = length(d);
  // zoom streaks: stars smear outward from the centre
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 14; i++) {
    float t = float(i) / 13.0;
    float s = 1.0 - uAmount * 0.3 * t;
    // only smear what is outside: cabin pixels (alpha 0) must not bleed into the streaks
    vec4 smp = texture2D(inputBuffer, c + d * s);
    float w = (1.0 - t * 0.6) * clamp(smp.a, 0.0, 1.0);
    acc += smp.rgb * w;
    wsum += w;
  }
  vec3 streak = wsum > 1e-3 ? acc / wsum * (1.0 + uAmount * 0.25) : inputColor.rgb;
  // tunnel: rings of light rushing past in polar space
  float a = atan(d.y, d.x);
  float z = 0.18 / max(r, 0.02) + uWTime * 3.5;
  float n = wNoise(vec2(a * 8.0, z * 2.0)) * wNoise(vec2(a * 19.0 + 3.0, z * 0.9));
  float lines = pow(wNoise(vec2(a * 60.0, z * 0.6)), 6.0) * 3.0;
  float tunnel = (n * 0.5 + lines * 0.6) * smoothstep(0.03, 0.4, r) * uAmount * uAmount;
  vec3 col = mix(inputColor.rgb, streak, smoothstep(0.0, 0.4, uAmount)) + uTint * tunnel * 0.35;
  // a soft bloom of light at the very peak
  col += uTint * pow(uAmount, 10.0) * 0.25 * (1.0 - r);
  outputColor = vec4(mix(inputColor.rgb, col, space), 1.0);
}
`;

export class WarpEffect extends Effect {
  constructor() {
    super('WarpEffect', frag, {
      blendFunction: BlendFunction.SRC,
      attributes: EffectAttribute.CONVOLUTION,
      uniforms: new Map<string, Uniform>([
        ['uAmount', new Uniform(0)],
        ['uWTime', new Uniform(0)],
        ['uTint', new Uniform(new Vector3(0.55, 0.62, 1.0))],
        ['uDebug', new Uniform(new URLSearchParams(location.search).has('warpdebug') ? 1 : 0)],
      ]),
    });
  }

  set amount(v: number) {
    this.uniforms.get('uAmount')!.value = v;
  }
  get amount(): number {
    return this.uniforms.get('uAmount')!.value;
  }

  override update(_r: unknown, _i: unknown, dt?: number): void {
    const u = this.uniforms.get('uWTime')!;
    u.value = (u.value + (dt ?? 0.016)) % 1000;
  }
}
