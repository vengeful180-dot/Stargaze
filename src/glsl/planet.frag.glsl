// Planet / moon surface, ray-traced on a unit sphere. Requires noise.glsl, impostor.glsl.
uniform vec3 uCamObj;
uniform vec3 uSunObj;        // unit direction to the star, object space
uniform vec3 uSunRad;        // star colour * irradiance at this body
uniform samplerCube uSurface;
uniform samplerCube uClouds;
uniform float uHasClouds;
uniform float uCloudRot;
uniform vec3 uCloudColor;
uniform int uKind;
uniform float uSea;
uniform float uHasOcean;
uniform float uRelief;
uniform float uFaceSize;
uniform vec3 uAtmoColor;
uniform float uAtmoDensity;
uniform float uCity;
uniform vec3 uSeedC;
uniform float uTime;
uniform float uFlowAmp;
uniform float uFlowPeriod;
uniform vec4 uRing;          // inner, outer (radii), opacity, has
uniform sampler2D uRingTex;
uniform vec2 uViewport;
uniform vec3 uPlanetShine;   // light bounced from a parent planet (moons), object-space dir in .xyz scaled by strength
uniform vec3 uPlanetShineCol;
varying vec3 vObjPos;
varying float vRadiusPx;

vec3 lavaGlow(vec3 p, float e) {
  // thin bright cracks in the crust, wider in the lowlands; lakes glow deep orange with hotter cores
  float r = ridged(p * 7.0 + uSeedC, 5, 2.1, 0.5);
  float cracks = smoothstep(0.88, 0.99, r) * (1.0 - smoothstep(-0.05, 0.2, e));
  float lake = 1.0 - smoothstep(-0.03, 0.0, e);
  float core = 1.0 - smoothstep(-0.12, -0.03, e);
  float churn = 0.75 + 0.25 * fbm(p * 30.0 + uSeedC + vec3(0.0, uTime * 0.01, 0.0), 3, 2.0, 0.5);
  vec3 c = vec3(0.9, 0.16, 0.02) * (lake * churn + cracks * 0.9) + vec3(1.0, 0.55, 0.12) * core * churn * 0.8;
  return c * 2.2;
}

float cityLights(vec3 p, float h) {
  float e = h - uSea;
  if (e < 0.004) return 0.0;
  float coast = 1.0 - smoothstep(0.0, 0.16, e);
  float n = fbm(p * 18.0 + uSeedC, 4, 2.0, 0.5);
  float clusters = smoothstep(0.18, 0.55, n);
  float pts = pow(max(gnoise(p * 220.0 + uSeedC), 0.0), 2.0) * 6.0;
  return clusters * (0.25 + coast) * (0.3 + pts) * uCity;
}

void main() {
  vec3 ro = uCamObj;
  vec3 rd = normalize(vObjPos - uCamObj);
  vec2 t = raySphere(ro, rd, 1.0);
  // silhouette coverage for alpha-to-coverage antialiasing
  float distC = length(ro);
  float pixelR = distC * 2.0 / (projectionMatrix[1][1] * uViewport.y); // one pixel, in radii, at the centre's distance
  float edge = rayCentreDist(ro, rd);
  float cover = clamp(0.5 + (1.0 - edge) / max(pixelR, 1e-6), 0.0, 1.0);
  if (cover <= 0.0) discard;
  vec3 p;
  if (t.x > 0.0) p = ro + rd * t.x;
  else {
    // just outside the silhouette: shade the limb point
    float b = dot(ro, rd);
    p = normalize(ro - b * rd);
  }
  vec3 n0 = normalize(p);

  vec4 s;
  vec3 albedo;
  float h = 0.0;
  if (uKind >= 9) {
    // zonal flow: two phase-shifted lookups cross-faded (flow-map style), so bands drift without endless shear
    float lat = n0.y;
    float spd = sin(lat * 7.0) * 0.6 + cos(lat * 13.0 + 1.0) * 0.4;
    float ph = uTime / uFlowPeriod;
    float f1 = fract(ph);
    float f2 = fract(ph + 0.5);
    vec3 a1 = texture(uSurface, rotY(n0, spd * f1 * uFlowAmp)).rgb;
    vec3 a2 = texture(uSurface, rotY(n0, spd * f2 * uFlowAmp)).rgb;
    float w = 1.0 - abs(2.0 * f1 - 1.0);
    albedo = mix(a2, a1, w);
  } else {
    s = texture(uSurface, n0);
    albedo = s.rgb;
    h = s.a;
  }

  // normal from the height channel; oceans are flat
  vec3 N = n0;
  bool ocean = uHasOcean > 0.5 && uKind < 9 && h < uSea;
  if (uKind < 9) {
    float eps = 1.5707963 / uFaceSize;
    vec3 t1 = normalize(cross(n0, abs(n0.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 t2 = cross(n0, t1);
    float floorH = uHasOcean > 0.5 ? uSea : -1e9;
    float hs = max(h, floorH);
    float h1 = max(texture(uSurface, normalize(n0 + t1 * eps)).a, floorH);
    float h2 = max(texture(uSurface, normalize(n0 + t2 * eps)).a, floorH);
    vec3 g = ((h1 - hs) * t1 + (h2 - hs) * t2) / eps;
    // close up the baked texels run out: add procedural detail that fades in as texels grow on screen
    float texelPx = vRadiusPx * 1.5707963 / uFaceSize;
    float detail = smoothstep(0.6, 2.5, texelPx) * (ocean ? 0.0 : 1.0);
    if (detail > 0.0) {
      vec4 dn = gnoised(n0 * uFaceSize * 2.2 + uSeedC);
      vec4 dn2 = gnoised(n0 * uFaceSize * 5.1 + uSeedC.yzx);
      g += (dn.yzw * 0.5 + dn2.yzw * 0.22) / (uFaceSize * 2.2) * 0.9 * detail;
      albedo *= 1.0 + (dn.x * 0.12 + dn2.x * 0.06) * detail;
    }
    N = normalize(n0 - g * uRelief);
  }

  float ndl0 = dot(n0, uSunObj);
  float ndl = dot(N, uSunObj);
  float term = smoothstep(-0.06, 0.08, ndl0);
  float diff = max(ndl, 0.0) * term;

  // clouds and their shadows
  float cl = 0.0, cls = 0.0;
  if (uHasClouds > 0.5) {
    cl = texture(uClouds, rotY(n0, uCloudRot)).r;
    cls = texture(uClouds, rotY(normalize(n0 + uSunObj * 0.015), uCloudRot)).r;
  }

  // ring shadow
  if (uRing.w > 0.5 && abs(uSunObj.y) > 1e-4) {
    float tr = -p.y / uSunObj.y;
    if (tr > 0.0) {
      vec3 hp = p + uSunObj * tr;
      float rr = length(hp.xz);
      if (rr > uRing.x && rr < uRing.y) {
        float u = (rr - uRing.x) / (uRing.y - uRing.x);
        diff *= 1.0 - texture(uRingTex, vec2(u, 0.5)).a * uRing.z * 0.85;
      }
    }
  }

  vec3 col = albedo * diff * (1.0 - cls * 0.6) * uSunRad;
  // faint fill: starlight + moon/planet shine so night sides are not pure black
  col += albedo * (0.0025 + uPlanetShineCol * max(dot(N, uPlanetShine), 0.0));

  if (ocean) {
    // wind-roughened water seen from orbit: a broad, dim GGX glint that brightens toward the limb
    vec3 H = normalize(uSunObj - rd);
    float nh = max(dot(n0, H), 0.0);
    float nv = max(dot(n0, -rd), 0.05);
    float nl = max(ndl0, 0.0);
    float vh = max(dot(-rd, H), 0.0);
    const float a2 = 0.045;
    float dd = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / (3.14159 * dd * dd);
    float F = 0.02 + 0.98 * pow(1.0 - vh, 5.0);
    float spec = D * F * 0.25 / nv * nl;
    col += uSunRad * min(spec, 4.0) * (1.0 - cl) * term;
  }

  // clouds: lit tops, soft terminator, slightly blue-grey in shadow
  if (uHasClouds > 0.5) {
    float cdiff = smoothstep(-0.12, 0.35, ndl0) * (0.75 + 0.25 * max(ndl0, 0.0));
    vec3 cloudCol = uCloudColor * cdiff * uSunRad + uCloudColor * 0.002;
    col = mix(col, cloudCol, cl);
  }

  // night-side emitters
  float night = 1.0 - smoothstep(-0.15, 0.05, ndl0);
  if (uCity > 0.0) col += vec3(1.0, 0.68, 0.32) * cityLights(n0, h) * night * (1.0 - cl * 0.85) * 0.8;
  if (uKind == 5) col += lavaGlow(n0, h - uSea) * (0.35 + 0.65 * night) * (1.0 - cl * 0.7);

  // aerial perspective toward the limb on the lit side (the shell adds the bright rim)
  if (uAtmoDensity > 0.0) {
    float mu = max(dot(n0, -rd), 0.0);
    float haze = uAtmoDensity * pow(1.0 - mu, 2.5) * 0.9;
    vec3 hazeCol = uAtmoColor * uSunRad * smoothstep(-0.2, 0.4, ndl0) * 0.55;
    col = mix(col, hazeCol, clamp(haze, 0.0, 0.8));
  }

  gl_FragDepth = writeDepth(p);
  gl_FragColor = vec4(col, cover);
}
