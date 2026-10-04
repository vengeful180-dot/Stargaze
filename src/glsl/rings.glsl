// Planetary rings: a flat quad in the planet's equatorial plane (object space XZ, planet radii).
// VERTEX and FRAGMENT sections are split by the loader at the marker line.
//--VERTEX
varying vec3 vLocal;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
//--FRAGMENT
uniform vec4 uRing;          // inner, outer, opacity, unused
uniform sampler2D uRingTex;  // rgb colour, a density
uniform vec3 uSunObj;
uniform vec3 uSunRad;
uniform vec3 uCamObj;
varying vec3 vLocal;
#include <common>
#include <logdepthbuf_pars_fragment>

void main() {
  float r = length(vLocal.xz);
  if (r < uRing.x || r > uRing.y) discard;
  float u = (r - uRing.x) / (uRing.y - uRing.x);
  vec4 rt = texture2D(uRingTex, vec2(u, 0.5));
  float a = rt.a * uRing.z;
  if (a < 0.003) discard;
  // shadow of the planet (unit sphere) across the rings, with a soft edge
  float b = dot(vLocal, uSunObj);
  float perp = length(vLocal - b * uSunObj);
  float shadow = b < 0.0 ? smoothstep(0.97, 1.03, perp) : 1.0;
  vec3 V = normalize(uCamObj - vLocal);
  bool sameSide = (uSunObj.y * V.y) > 0.0;
  // icy particles scatter a lot: keep a floor so rings stay readable when the sun is low over them
  float elev = 0.22 + 0.9 * abs(uSunObj.y);
  float mu = dot(-V, uSunObj);
  float reflected = elev * (0.8 + 0.3 * a);
  // seen from the unlit side the ring glows by forward scattering through the thin parts
  float transmitted = (pow(max(mu, 0.0), 5.0) * 1.4 + 0.12) * elev * 2.0 * (1.0 - a * 0.6);
  float light = sameSide ? reflected : transmitted;
  vec3 col = rt.rgb * uSunRad * light * shadow + rt.rgb * 0.002;
  gl_FragColor = vec4(col, a);
  #include <logdepthbuf_fragment>
}
