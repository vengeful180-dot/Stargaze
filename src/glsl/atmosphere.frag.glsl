// Single-scattering atmosphere shell, ray-traced, additive. Requires impostor.glsl.
// Object space in planet radii: planet surface r = 1, shell r = uRa.
uniform vec3 uCamObj;
uniform vec3 uSunObj;
uniform vec3 uSunRad;
uniform float uRa;
uniform vec3 uBetaR;   // per planet radius
uniform float uBetaM;
uniform float uH;      // scale height, planet radii
uniform float uIntensity;
uniform int uSteps;
varying vec3 vObjPos;
varying float vRadiusPx;

float sunDepth(vec3 x) {
  vec2 ts = raySphere(x, uSunObj, uRa);
  float L = max(ts.y, 0.0);
  float dt = L / 4.0;
  float od = 0.0;
  for (int i = 0; i < 4; i++) {
    vec3 y = x + uSunObj * (float(i) + 0.5) * dt;
    od += exp(-(length(y) - 1.0) / uH) * dt;
  }
  return od;
}

void main() {
  vec3 ro = uCamObj;
  vec3 rd = normalize(vObjPos - uCamObj);
  vec2 ta = raySphere(ro, rd, uRa);
  if (ta.y <= 0.0) discard;
  vec2 tp = raySphere(ro, rd, 1.0);
  float t0 = max(ta.x, 0.0);
  float t1 = ta.y;
  if (tp.x > 0.0) t1 = tp.x;
  if (t1 <= t0) discard;
  float dt = (t1 - t0) / float(uSteps);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  float odView = 0.0;
  for (int i = 0; i < 32; i++) {
    if (i >= uSteps) break;
    vec3 x = ro + rd * (t0 + (float(i) + 0.5) * dt);
    float dens = exp(-(length(x) - 1.0) / uH);
    float od = dens * dt;
    odView += od * 0.5;
    vec2 tps = raySphere(x, uSunObj, 1.0);
    if (tps.x <= 0.0) {
      float odSun = sunDepth(x);
      vec3 tau = uBetaR * (odView + odSun) + uBetaM * 1.1 * (odView + odSun);
      vec3 att = exp(-tau);
      sumR += att * od;
      sumM += att * od;
    }
    odView += od * 0.5;
  }
  float mu = dot(rd, uSunObj);
  float phaseR = 0.0596831 * (1.0 + mu * mu);
  const float g = 0.72;
  float phaseM = 0.0795775 * (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  vec3 col = uSunRad * (sumR * uBetaR * phaseR + sumM * uBetaM * phaseM) * uIntensity;
  // inside the shell, keep the depth well behind the cabin but in front of the ground
  float tw = ta.x > 0.0 ? t0 : 0.5 * t1;
  gl_FragDepth = writeDepth(ro + rd * tw);
  gl_FragColor = vec4(col, 1.0);
}
