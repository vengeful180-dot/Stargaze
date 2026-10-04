// Planet surface bake. Writes a half-float cube map:
//   SURFACE: rgb = albedo (linear), a = height (noise units; sea level = uSea)
//   CLOUDS (#define BAKE_CLOUDS): r = cloud density
// Requires: noise.glsl, FACE_DIR_GLSL.

uniform int uKind;        // 0 terran 1 ocean 2 desert 3 arid 4 ice 5 lava 6 barren 7 toxic 8 exotic 9 gas 10 icegiant
uniform vec3 uSeed;
uniform vec3 uPal[5];
uniform vec3 uOcean;
uniform vec3 uShallow;
uniform float uSea;
uniform float uRough;
uniform float uCont;
uniform float uMount;
uniform float uCraters;
uniform float uIceCap;
uniform float uBands;
uniform float uTurb;
uniform int uStorms;
uniform vec4 uStorm[4];   // xyz centre (unit), w angular radius
uniform float uCover;     // cloud cover
uniform int uOct;         // detail octaves (grows with face size)

float terrain(vec3 p, out float mount, out float moist) {
  vec3 q = p * uCont + uSeed;
  vec3 w = vec3(fbm(q * 0.9, 4, 2.0, 0.5), fbm(q * 0.9 + 3.1, 4, 2.0, 0.5), fbm(q * 0.9 + 7.7, 4, 2.0, 0.5));
  float cont = fbm(q * 1.1 + w * 0.7, 5, 2.0, 0.5) * 1.6;
  float land = smoothstep(uSea - 0.08, uSea + 0.3, cont);
  mount = ridged(q * 2.6 + w * 1.3, uOct, 2.05, 0.5);
  float hills = fbm(q * 7.0 + w, uOct, 2.1, 0.5);
  moist = fbm(q * 1.9 + 11.0 + w * 0.5, 4, 2.0, 0.5);
  float h = cont + land * (mount * mount * uMount * 0.7 + hills * 0.12 * uRough) + (1.0 - land) * hills * 0.05;
  if (uCraters > 0.0) {
    h += craters(p * 3.5 + uSeed, uCraters) * 0.16;
    h += craters(p * 9.0 + uSeed.zxy, uCraters) * 0.07;
    h += craters(p * 23.0 + uSeed.yzx, uCraters) * 0.03;
  }
  return h;
}

vec3 rockyAlbedo(vec3 p, float h, float mount, float moist) {
  float e = h - uSea;
  float lat = abs(p.y);
  vec3 q = p * 3.0 + uSeed;
  float n1 = fbm(q * 4.0, 4, 2.0, 0.5);
  vec3 col;
  if (uKind == 5) {
    // lava world: dark basalt crust, glow handled at runtime from the "sea" (lava lakes)
    col = mix(uPal[0], uPal[1], smoothstep(-0.3, 0.4, n1));
    col = mix(col, uPal[2], smoothstep(0.4, 0.8, mount));
    if (e < 0.0) col = uPal[3];
    return col;
  }
  if (e < 0.0 && uSea > -1.5) {
    // water: deep to shallow, a little variation
    float sh = smoothstep(-0.28, 0.0, e);
    col = mix(uOcean, uShallow, sh * sh);
    col *= 0.9 + 0.2 * fbm(q * 2.0 + 30.0, 3, 2.0, 0.5);
    // sea ice near the poles
    float ice = smoothstep(uIceCap - 0.04, uIceCap + 0.06, lat + n1 * 0.06);
    return mix(col, uPal[4] * 0.95, ice);
  }
  float alt = max(e, 0.0);
  // lowland -> vegetation (wet) / dry ground, then rock, then snow on peaks
  float wet = smoothstep(-0.25, 0.35, moist + (0.5 - lat) * 0.4);
  col = mix(uPal[0], uPal[1], smoothstep(0.0, 0.04, alt));
  col = mix(col, uPal[2], wet * smoothstep(0.02, 0.1, alt) * (1.0 - smoothstep(0.35, 0.6, alt + mount * 0.3)));
  col = mix(col, uPal[3], smoothstep(0.32, 0.62, alt + mount * 0.35 + n1 * 0.08));
  if (uKind == 2 || uKind == 3) {
    // dunes and wind streaks
    float dunes = ridged(vec3(p.x * 30.0, p.y * 6.0, p.z * 30.0) + uSeed + n1 * 2.0, 3, 2.0, 0.5);
    col *= 0.9 + 0.18 * dunes;
    col = mix(col, uPal[2], smoothstep(0.2, 0.7, fbm(q * 1.3 + 5.0, 4, 2.0, 0.5)) * 0.5);
  }
  if (uKind == 4) {
    // ice: crevasse lines
    float cr = ridged(q * 6.0, 4, 2.1, 0.5);
    col = mix(col, uPal[3], smoothstep(0.75, 0.95, cr) * 0.7);
  }
  if (uKind == 6) {
    // barren: crater rays and maria
    float maria = smoothstep(0.1, 0.5, fbm(q * 0.8 + 40.0, 4, 2.0, 0.5));
    col = mix(col, uPal[3], maria * 0.7);
  }
  // snow line rises toward the equator
  float snow = smoothstep(0.05, 0.0, (0.7 - lat * 0.5) - alt - mount * 0.2) * step(0.5, uIceCap);
  col = mix(col, uPal[4], snow);
  float cap = smoothstep(uIceCap - 0.03, uIceCap + 0.05, lat + n1 * 0.05 + alt * 0.3);
  col = mix(col, uPal[4], cap);
  // fine albedo breakup
  col *= 0.88 + 0.24 * fbm(p * 40.0 + uSeed, 3, 2.0, 0.5);
  return col;
}

vec3 giantAlbedo(vec3 p) {
  float lat = p.y;
  vec3 q = p * 1.8 + uSeed;
  vec3 w = vec3(fbm(q * 1.4, 5, 2.0, 0.5), fbm(q * 1.4 + 4.0, 5, 2.0, 0.5), fbm(q * 1.4 + 8.0, 5, 2.0, 0.5));
  // turbulence mostly shears along latitude
  float lw = lat + uTurb * (0.05 * w.x + 0.02 * fbm(p * 14.0 + w * 3.0 + uSeed, 5, 2.0, 0.55));
  float wob = fbm(vec3(lw * 7.0, 0.0, 0.0) + uSeed, 3, 2.0, 0.5);
  float b = sin(lw * uBands * 3.14159 + wob * 2.5);
  float k = fract(lw * uBands * 0.31 + 0.5 * sin(lw * uBands * 0.83));
  vec3 col = mix(uPal[0], uPal[1], smoothstep(-0.55, 0.55, b));
  col = mix(col, uPal[2], smoothstep(0.55, 0.92, k) * 0.65);
  col = mix(col, uPal[4], smoothstep(0.82, 1.0, abs(b)) * smoothstep(0.3, 0.9, w.y) * 0.4);
  float streak = fbm(vec3(p.x * 3.0, lw * 70.0, p.z * 3.0) + uSeed, 4, 2.0, 0.5);
  col *= 0.9 + 0.2 * streak;
  for (int i = 0; i < 4; i++) {
    if (i >= uStorms) break;
    vec3 c = uStorm[i].xyz;
    float rad = uStorm[i].w;
    float a = acos(clamp(dot(p, c), -1.0, 1.0)) / rad;
    if (a < 2.2) {
      float sw = exp(-a * a * 1.6);
      float ring = exp(-pow((a - 0.75) * 3.0, 2.0));
      vec3 sc = mix(uPal[3], uPal[1] * 0.9, 0.35 + 0.3 * fbm(p * 40.0 + float(i), 3, 2.0, 0.5));
      col = mix(col, sc, sw * 0.85);
      col = mix(col, uPal[0] * 1.1, ring * 0.35);
    }
  }
  col *= mix(1.0, 0.72, smoothstep(0.78, 0.99, abs(lat)));
  return col;
}

float cloudDensity(vec3 p) {
  vec3 q = p * 2.0 + uSeed + 17.0;
  vec3 w = vec3(fbm(q, 4, 2.0, 0.5), fbm(q + 3.3, 4, 2.0, 0.5), fbm(q + 7.1, 4, 2.0, 0.5));
  float n = fbm(q * 1.7 + w * 1.4, uOct, 2.1, 0.5) * 0.5 + 0.5;
  float lat = abs(p.y);
  // tropical band, storm belts at mid latitudes, clearer sub-tropics
  float band = 0.75 + 0.25 * cos(lat * 10.0) + 0.15 * smoothstep(0.7, 0.9, lat);
  float c = smoothstep(1.0 - uCover - 0.12, 1.0 - uCover + 0.32, n * band);
  float wisps = fbm(vec3(p.x * 9.0, p.y * 30.0, p.z * 9.0) + w * 2.0, 4, 2.0, 0.5);
  c *= 0.7 + 0.3 * smoothstep(-0.4, 0.5, wisps);
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec3 p = faceDir(gl_FragCoord.xy);
#ifdef BAKE_CLOUDS
  gl_FragColor = vec4(cloudDensity(p), 0.0, 0.0, 1.0);
#else
  if (uKind >= 9) {
    gl_FragColor = vec4(giantAlbedo(p), 0.0);
  } else {
    float mount, moist;
    float h = terrain(p, mount, moist);
    gl_FragColor = vec4(rockyAlbedo(p, h, mount, moist), h);
  }
#endif
}
