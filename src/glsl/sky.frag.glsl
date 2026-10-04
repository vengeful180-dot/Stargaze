// Sky cube map: the Milky Way traced through the same galaxy the systems live in, nearby nebulae,
// faint unresolved stars and a few distant galaxies. Rendered once per system (tiled over frames).
// Requires: noise.glsl, FACE_DIR_GLSL. Units: kly (1000 light-years), galactic frame.

uniform vec3 uPos;          // observer, kly
uniform int uSteps;
uniform float uBright;      // Milky Way brightness
uniform float uStarBright;  // faint star layer brightness
uniform vec3 uSeedOff;
uniform int uNebCount;
uniform vec4 uNebA[6];      // xyz centre (kly), w radius (kly)
uniform vec4 uNebB[6];      // x seed, y emissivity, z dust, w unused
uniform vec3 uNebC1[6];
uniform vec3 uNebC2[6];
uniform vec4 uGal[8];       // xyz direction, w angular radius (rad)
uniform vec4 uGalB[8];      // x axis ratio, y rotation, z brightness, w unused

const float PITCH = 0.22689;
const float TAU = 6.28318530718;

float armFactor(vec2 xz, float r) {
  float th = atan(xz.y, xz.x);
  float armTh = log(max(r, 0.5) / 3.0) / tan(PITCH);
  float sector = TAU / 4.0;
  float d = mod(th - armTh, sector);
  d = min(d, sector - d);
  float perp = d * r * sin(PITCH);
  return exp(-(perp / 1.5) * (perp / 1.5));
}

void galaxySample(vec3 p, out vec3 e, out float dust) {
  float r = length(p.xz);
  float hz = abs(p.y);
  float arm = armFactor(p.xz, r);
  float disc = exp(-(r - 26.0) / 12.0);
  float thin = exp(-hz / 0.35);
  float thick = exp(-hz / 1.4) * 0.04;
  float bulge = 10.0 * exp(-(r * r + 7.0 * p.y * p.y) / (2.0 * 3.6 * 3.6));
  float edge = smoothstep(58.0, 44.0, r);
  float env = (disc * (thin + thick) + bulge) * edge;
  e = vec3(0.0);
  dust = 0.0;
  if (env < 2e-4) return;
  // star clouds at two scales; contrasty so the band breaks into bright patches
  float n = fbm(p * 1.6 + uSeedOff, 3, 2.1, 0.55);
  float n2 = fbm(p * 5.3 + uSeedOff.yzx, 3, 2.0, 0.5);
  float clump = 0.12 + 1.7 * pow(smoothstep(-0.45, 0.65, n + 0.35 * n2), 1.6);
  float starsDisc = disc * (thin * (0.3 + 1.0 * arm) + thick) * clump;
  vec3 discCol = mix(vec3(1.0, 0.85, 0.68), vec3(0.66, 0.78, 1.0), arm);
  e = discCol * starsDisc + vec3(1.0, 0.76, 0.5) * bulge * (0.7 + 0.5 * clump);
  // pink HII knots along the arms
  float h2 = smoothstep(0.42, 0.8, n2 + 0.3 * n) * arm * thin * disc;
  e += vec3(1.0, 0.32, 0.46) * h2 * 0.7;
  // dust: a thin lane broken into dense filaments, with clear gaps between them
  // the lane wanders up and down and thickens in places, so it reads as rifts rather than a ruler line
  float wob = fbm(p * 0.45 + uSeedOff.yxz, 3, 2.0, 0.5);
  float hzd = abs(p.y + 0.12 * wob);
  float thick2 = 0.14 + 0.1 * smoothstep(-0.3, 0.5, fbm(p * 0.7 + uSeedOff, 2, 2.0, 0.5));
  float lane = exp(-hzd / thick2) * disc * (0.4 + 0.9 * arm) + exp(-(r * r + 18.0 * p.y * p.y) / (2.0 * 2.5 * 2.5)) * 1.4;
  if (lane > 1e-3) {
    float fil = ridged(p * 2.8 + uSeedOff * 0.7 + wob, 4, 2.0, 0.5);
    float patches = smoothstep(-0.25, 0.45, fbm(p * 1.1 + uSeedOff.zxy, 3, 2.0, 0.5));
    dust = lane * (0.04 + 2.4 * pow(fil, 3.0)) * (0.2 + patches) * 1.0;
  }
  e *= edge;
  dust *= edge;
}

vec3 starTint(float h) {
  // mostly white-yellow, some blue, some orange
  if (h < 0.18) return vec3(0.7, 0.8, 1.0);
  if (h < 0.62) return vec3(1.0, 0.96, 0.9);
  if (h < 0.86) return vec3(1.0, 0.86, 0.68);
  return vec3(1.0, 0.72, 0.5);
}

vec3 starLayer(vec3 d, float scale, float prob, float bright, float px) {
  vec3 p = d * scale;
  vec3 c0 = floor(p);
  vec3 acc = vec3(0.0);
  float sig = px * 0.8;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 cell = c0 + vec3(float(x), float(y), float(z));
    vec3 h = hash33(cell + uSeedOff * 13.0);
    if (h.x > prob) continue;
    vec3 sp = cell + 0.1 + 0.8 * hash33(cell + 71.0 + uSeedOff);
    vec3 sd = normalize(sp);
    vec3 cr = cross(d, sd);
    float a2 = dot(cr, cr);
    if (dot(d, sd) < 0.0) continue;
    float g = exp(-0.5 * a2 / (sig * sig));
    float mag = h.y * h.y * h.y * h.y;
    acc += starTint(h.z) * g * (0.12 + 2.2 * mag);
  }
  return acc * bright;
}

vec3 nebulae(vec3 d, vec3 col) {
  for (int k = 0; k < 6; k++) {
    if (k >= uNebCount) break;
    vec3 c = uNebA[k].xyz - uPos;
    float R = uNebA[k].w;
    float b = dot(d, c);
    float h = b * b - dot(c, c) + R * R;
    if (h <= 0.0) continue;
    h = sqrt(h);
    float ta = max(b - h, 0.0);
    float tb = b + h;
    if (tb <= 0.0) continue;
    const int NS = 28;
    float dt = (tb - ta) / float(NS);
    vec3 acc = vec3(0.0);
    vec3 trn = vec3(1.0);
    float seed = uNebB[k].x;
    for (int s = 0; s < NS; s++) {
      float t = ta + (float(s) + 0.5) * dt;
      vec3 q = (d * t - c) / R;
      if (dot(q, q) > 1.0) continue;
      vec3 w = q * 1.5 + seed;
      vec3 warp = vec3(fbm(w, 3, 2.0, 0.5), fbm(w + 5.2, 3, 2.0, 0.5), fbm(w + 9.7, 3, 2.0, 0.5));
      vec3 qq = q + warp * 0.7;
      float rr = length(qq);
      float shape = 1.0 - smoothstep(0.15, 0.9, rr);
      if (shape <= 0.0) continue;
      float base = fbm(qq * 2.3 + seed, 4, 2.1, 0.55);
      float fil = ridged(qq * 3.4 + seed * 1.7, 5, 2.05, 0.55);
      float dens = shape * (smoothstep(0.0, 0.6, base) * 0.16 + pow(fil, 3.0) * 2.2 * smoothstep(-0.3, 0.3, base));
      float dark = smoothstep(0.15, 0.55, fbm(qq * 3.7 + seed * 3.1, 4, 2.0, 0.5)) * shape;
      // ionised core in the second colour, outer filaments in the first
      vec3 nc = mix(uNebC2[k], uNebC1[k], smoothstep(0.15, 0.7, rr + warp.y * 0.3));
      nc *= 0.8 + 0.6 * pow(fil, 2.0);
      acc += trn * nc * dens * uNebB[k].y * dt / R;
      trn *= exp(-(dark * uNebB[k].z * 3.0 + dens * 0.4) * dt / R * vec3(0.8, 1.0, 1.3));
    }
    col = col * trn + acc;
  }
  return col;
}

vec3 galaxies(vec3 d) {
  vec3 acc = vec3(0.0);
  for (int g = 0; g < 8; g++) {
    vec3 gd = uGal[g].xyz;
    float size = uGal[g].w;
    if (size <= 0.0) continue;
    if (dot(d, gd) < cos(size * 4.0)) continue;
    vec3 tu = normalize(cross(gd, abs(gd.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 tv = cross(gd, tu);
    vec2 uv = vec2(dot(d, tu), dot(d, tv)) / size;
    float ro = uGalB[g].y;
    uv = mat2(cos(ro), -sin(ro), sin(ro), cos(ro)) * uv;
    uv.y /= uGalB[g].x;
    float rr = length(uv);
    float ang = atan(uv.y, uv.x);
    float core = exp(-rr * rr * 30.0);
    float disk = exp(-rr * 3.2) * (0.65 + 0.35 * sin(ang * 2.0 + log(rr + 0.05) * 5.0));
    vec3 gc = mix(vec3(1.0, 0.86, 0.7), vec3(0.72, 0.8, 1.0), clamp(rr * 1.6, 0.0, 1.0));
    acc += gc * (core * 2.5 + disk * 0.55) * uGalB[g].z;
  }
  return acc;
}

void main() {
  vec3 d = faceDir(gl_FragCoord.xy);
  vec3 col = vec3(0.0);
  vec3 tr = vec3(1.0);
  const vec3 EXT = vec3(0.75, 1.0, 1.35); // dust reddens what it lets through
  float t0 = 0.02, t1 = 75.0;
  float lr = log(t1 / t0);
  float prevT = t0;
  for (int i = 1; i <= 128; i++) {
    if (i > uSteps) break;
    float t = t0 * exp(lr * float(i) / float(uSteps));
    float dt = t - prevT;
    vec3 p = uPos + d * (prevT + 0.5 * dt);
    vec3 e;
    float du;
    galaxySample(p, e, du);
    col += tr * e * dt;
    tr *= exp(-du * dt * EXT);
    prevT = t;
    if (max(tr.r, max(tr.g, tr.b)) < 0.01) break;
    if (abs(p.y) > 4.0 && p.y * d.y > 0.0) break;
  }
  col *= uBright;
  // fine structure a 50-step march cannot resolve: direction-only, so it is the same for every observer
  float fine = fbm(d * 36.0 + uSeedOff, 4, 2.2, 0.55);
  float grain = fbm(d * 140.0 + uSeedOff.zxy, 3, 2.0, 0.5);
  float rift = ridged(d * 13.0 + uSeedOff.yzx, 4, 2.0, 0.5);
  col *= (0.45 + 1.0 * smoothstep(-0.5, 0.55, fine)) * (0.92 + 0.16 * smoothstep(-0.3, 0.6, grain)) * (1.0 - 0.45 * pow(rift, 3.0));
  float band = dot(col, vec3(0.2126, 0.7152, 0.0722));

  col = nebulae(d, col);
  col += galaxies(d);

  // a whisper of unresolved stars where the band is bright; resolved stars are points (starfield.ts)
  float px = 1.5707963 / uSize;
  // (only in the band's bright core: sprinkled everywhere and magnified from the cube map it read as grain)
  col += starLayer(d, 220.0, clamp((band - 0.012) * 18.0, 0.0, 0.4), uStarBright, px * 0.7);
  gl_FragColor = vec4(col, 1.0);
}
