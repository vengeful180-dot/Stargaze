// Star surface: limb-darkened, slowly boiling granulation. Requires noise.glsl, impostor.glsl.
uniform vec3 uCamObj;
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform vec3 uSeedC;
uniform vec2 uViewport;
varying vec3 vObjPos;
varying float vRadiusPx;

void main() {
  vec3 ro = uCamObj;
  vec3 rd = normalize(vObjPos - uCamObj);
  vec2 t = raySphere(ro, rd, 1.0);
  float distC = length(ro);
  float pixelR = distC * 2.0 / (projectionMatrix[1][1] * uViewport.y);
  float edge = rayCentreDist(ro, rd);
  float cover = clamp(0.5 + (1.0 - edge) / max(pixelR, 1e-6), 0.0, 1.0);
  if (cover <= 0.0) discard;
  vec3 p = t.x > 0.0 ? ro + rd * t.x : normalize(ro - dot(ro, rd) * rd);
  vec3 n = normalize(p);
  float mu = max(dot(n, -rd), 0.0);
  float limb = 0.4 + 0.6 * pow(mu, 0.55);
  vec3 q = n * 18.0 + uSeedC;
  float gran = voronoi3(q + vec3(0.0, uTime * 0.01, 0.0)).x;
  float boil = fbm(n * 6.0 + uSeedC + uTime * 0.004, 4, 2.0, 0.5);
  float spots = smoothstep(0.62, 0.78, fbm(n * 2.5 + uSeedC.zxy + uTime * 0.001, 3, 2.0, 0.5));
  float I = (0.82 + 0.25 * gran + 0.12 * boil) * (1.0 - 0.5 * spots);
  // limb reddens slightly
  vec3 c = mix(uColor * vec3(1.0, 0.82, 0.65), uColor, mu);
  gl_FragDepth = writeDepth(p);
  gl_FragColor = vec4(c * limb * I * uIntensity, cover);
}
