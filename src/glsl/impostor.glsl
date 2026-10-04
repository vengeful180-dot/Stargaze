// Shared by the ray-traced sphere impostors (planets, atmospheres, stars).
// The mesh is a unit cube (BackSide) scaled to the sphere radius; each fragment intersects the true sphere.
// Object space is measured in sphere radii; uCamObj is the camera there (computed in double precision on the CPU).

uniform mat4 projectionMatrix;
uniform mat4 modelViewMatrix;
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
uniform float logDepthBufFC;
#endif

// Robust at huge distance ratios: works from the perpendicular foot instead of |o|^2 - r^2.
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  vec3 qc = ro - b * rd;
  float h = r * r - dot(qc, qc);
  if (h < 0.0) return vec2(-1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Perpendicular distance of the ray to the centre (in radii): coverage at silhouettes.
float rayCentreDist(vec3 ro, vec3 rd) {
  float b = dot(ro, rd);
  return length(ro - b * rd);
}

float writeDepth(vec3 objPos) {
  vec4 v = modelViewMatrix * vec4(objPos, 1.0);
  vec4 c = projectionMatrix * v;
#ifdef USE_LOGARITHMIC_DEPTH_BUFFER
  return log2(max(1e-6, 1.0 + c.w)) * logDepthBufFC * 0.5;
#else
  return clamp(c.z / c.w * 0.5 + 0.5, 0.0, 1.0);
#endif
}

vec3 rotY(vec3 v, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * v.x + s * v.z, v.y, -s * v.x + c * v.z);
}
