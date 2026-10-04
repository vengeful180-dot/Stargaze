// Camera-facing glow quad (star corona, distant beacons). Additive.
//--VERTEX
uniform float uSize;      // world radius of the glow
uniform float uMinPx;     // keep at least this many pixels across
uniform vec2 uViewport;
varying vec2 vUv;
varying float vScale;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = position.xy;
  vec4 c = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float dist = max(-c.z, 1e-3);
  float px = uSize / dist * projectionMatrix[1][1] * 0.5 * uViewport.y;
  float s = max(1.0, uMinPx / max(px, 1e-6));
  vScale = s;
  c.xy += position.xy * uSize * s;
  gl_Position = projectionMatrix * c;
  #include <logdepthbuf_vertex>
}
//--FRAGMENT
uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uCore;      // sphere radius / glow radius
uniform float uRays;
varying vec2 vUv;
varying float vScale;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float core = uCore / vScale;
  float x = max(r - core, 0.0) / max(1.0 - core, 1e-3);
  float a = atan(vUv.y, vUv.x);
  float rays = 0.0;
  if (uRays > 0.0) {
    float s1 = sin(a * 6.0 + uTime * 0.03) * sin(a * 11.0 - uTime * 0.021) * sin(a * 17.0 + 1.3);
    rays = max(s1, 0.0) * exp(-x * 4.0) * uRays;
  }
  float glow = exp(-x * 10.0) * 0.75 + exp(-x * 3.2) * 0.22 + exp(-x * 1.2) * 0.05 + rays * 0.3;
  glow *= smoothstep(1.0, 0.8, r);
  gl_FragColor = vec4(uColor * uIntensity * glow, 1.0);
  #include <logdepthbuf_fragment>
}
