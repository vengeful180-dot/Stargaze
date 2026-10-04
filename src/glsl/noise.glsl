// Shared GPU noise. Integer hashing (PCG3D, Jarzynski & Olano 2020) so results do not depend on
// sin() precision, which differs between GPUs and would make seeds look different per machine.

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

// p must hold integer values.
vec3 hash33(vec3 p) {
  uvec3 h = pcg3d(uvec3(ivec3(p)));
  return vec3(h) * (1.0 / 4294967295.0);
}

float hash13(vec3 p) {
  return hash33(p).x;
}

vec3 grad3(vec3 i) {
  return hash33(i) * 2.0 - 1.0;
}

// Gradient noise, roughly [-1, 1].
float gnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float va = dot(grad3(i + vec3(0.0, 0.0, 0.0)), f - vec3(0.0, 0.0, 0.0));
  float vb = dot(grad3(i + vec3(1.0, 0.0, 0.0)), f - vec3(1.0, 0.0, 0.0));
  float vc = dot(grad3(i + vec3(0.0, 1.0, 0.0)), f - vec3(0.0, 1.0, 0.0));
  float vd = dot(grad3(i + vec3(1.0, 1.0, 0.0)), f - vec3(1.0, 1.0, 0.0));
  float ve = dot(grad3(i + vec3(0.0, 0.0, 1.0)), f - vec3(0.0, 0.0, 1.0));
  float vf = dot(grad3(i + vec3(1.0, 0.0, 1.0)), f - vec3(1.0, 0.0, 1.0));
  float vg = dot(grad3(i + vec3(0.0, 1.0, 1.0)), f - vec3(0.0, 1.0, 1.0));
  float vh = dot(grad3(i + vec3(1.0, 1.0, 1.0)), f - vec3(1.0, 1.0, 1.0));
  return va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va)
    + u.x * u.y * (va - vb - vc + vd) + u.y * u.z * (va - vc - ve + vg)
    + u.z * u.x * (va - vb - ve + vf) + u.x * u.y * u.z * (-va + vb + vc - vd + ve - vf - vg + vh);
}

// Gradient noise with analytic derivatives: .x value, .yzw gradient.
vec4 gnoised(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec3 ga = grad3(i + vec3(0.0, 0.0, 0.0));
  vec3 gb = grad3(i + vec3(1.0, 0.0, 0.0));
  vec3 gc = grad3(i + vec3(0.0, 1.0, 0.0));
  vec3 gd = grad3(i + vec3(1.0, 1.0, 0.0));
  vec3 ge = grad3(i + vec3(0.0, 0.0, 1.0));
  vec3 gf = grad3(i + vec3(1.0, 0.0, 1.0));
  vec3 gg = grad3(i + vec3(0.0, 1.0, 1.0));
  vec3 gh = grad3(i + vec3(1.0, 1.0, 1.0));
  float va = dot(ga, f - vec3(0.0, 0.0, 0.0));
  float vb = dot(gb, f - vec3(1.0, 0.0, 0.0));
  float vc = dot(gc, f - vec3(0.0, 1.0, 0.0));
  float vd = dot(gd, f - vec3(1.0, 1.0, 0.0));
  float ve = dot(ge, f - vec3(0.0, 0.0, 1.0));
  float vf = dot(gf, f - vec3(1.0, 0.0, 1.0));
  float vg = dot(gg, f - vec3(0.0, 1.0, 1.0));
  float vh = dot(gh, f - vec3(1.0, 1.0, 1.0));
  float k1 = vb - va, k2 = vc - va, k3 = ve - va;
  float k4 = va - vb - vc + vd, k5 = va - vc - ve + vg, k6 = va - vb - ve + vf;
  float k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  float v = va + u.x * k1 + u.y * k2 + u.z * k3 + u.x * u.y * k4 + u.y * u.z * k5 + u.z * u.x * k6 + u.x * u.y * u.z * k7;
  vec3 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga)
    + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg)
    + u.z * u.x * (ga - gb - ge + gf) + u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh);
  g += du * vec3(
    k1 + u.y * k4 + u.z * k6 + u.y * u.z * k7,
    k2 + u.z * k5 + u.x * k4 + u.z * u.x * k7,
    k3 + u.x * k6 + u.y * k5 + u.x * u.y * k7);
  return vec4(v, g);
}

// Rotating each octave hides the lattice alignment that makes fbm look "griddy".
const mat3 OCT_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

float fbm(vec3 p, int octaves, float lac, float gain) {
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 14; i++) {
    if (i >= octaves) break;
    s += a * gnoise(p);
    n += a;
    a *= gain;
    p = OCT_ROT * p * lac;
  }
  return s / n;
}

// fbm with accumulated analytic gradient (in the space of the input p). .x value, .yzw gradient.
vec4 fbmd(vec3 p, int octaves, float lac, float gain) {
  float s = 0.0, a = 0.5, n = 0.0;
  vec3 g = vec3(0.0);
  mat3 m = mat3(1.0);
  for (int i = 0; i < 14; i++) {
    if (i >= octaves) break;
    vec4 d = gnoised(p);
    s += a * d.x;
    g += a * (transpose(m) * d.yzw);
    n += a;
    a *= gain;
    p = OCT_ROT * p * lac;
    m = OCT_ROT * m * lac;
  }
  return vec4(s, g) / n;
}

// Ridged multifractal in [0, 1].
float ridged(vec3 p, int octaves, float lac, float gain) {
  float s = 0.0, a = 0.5, n = 0.0, prev = 1.0;
  for (int i = 0; i < 12; i++) {
    if (i >= octaves) break;
    float r = 1.0 - abs(gnoise(p));
    r *= r;
    s += r * a * prev;
    n += a;
    prev = r;
    a *= gain;
    p = OCT_ROT * p * lac;
  }
  return s / n;
}

// 3D cellular noise. .x = F1 distance, .y = F2 distance, .z = id hash of the nearest cell, .w unused.
vec4 voronoi3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int xx = -1; xx <= 1; xx++) {
    vec3 c = vec3(float(xx), float(y), float(z));
    vec3 h = hash33(i + c);
    vec3 r = c + h - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; id = h.z; }
    else if (d < d2) { d2 = d; }
  }
  return vec4(sqrt(d1), sqrt(d2), id, 0.0);
}

// Crater field: returns height offset (bowl + rim) for cells at scale freq. density in [0,1].
float craters(vec3 p, float density) {
  vec3 i = floor(p);
  vec3 f = p - i;
  float h = 0.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int xx = -1; xx <= 1; xx++) {
    vec3 c = vec3(float(xx), float(y), float(z));
    vec3 rnd = hash33(i + c + 17.0);
    if (rnd.x > density) continue;
    vec3 centre = c + hash33(i + c);
    float r = mix(0.18, 0.48, rnd.y * rnd.y);
    float d = length(f - centre) / r;
    if (d > 1.6) continue;
    float bowl = d * d - 1.0;                       // -1 at centre, 0 at rim
    float rim = exp(-pow((d - 1.0) * 3.2, 2.0)) * 0.35;
    float crater = d < 1.0 ? bowl * 0.6 + rim : rim * smoothstep(1.6, 1.0, d);
    h += crater * mix(0.4, 1.0, rnd.z);
  }
  return h;
}
