// Vertex stage for sphere impostors. Inflates tiny spheres to a minimum screen footprint.
uniform vec3 uCamObj;
uniform float uMinPx;
uniform vec2 uViewport;
varying vec3 vObjPos;
varying float vRadiusPx;

void main() {
  vec4 cView = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
  float dist = length(cView.xyz);
  float scale = length(modelMatrix[0].xyz);
  float rPx = scale / max(dist, 1e-3) * projectionMatrix[1][1] * 0.5 * uViewport.y;
  vRadiusPx = rPx;
  float inflate = max(1.0, uMinPx / max(rPx, 1e-6));
  // cube corners sit at sqrt(3); the sphere fits inside the unit cube
  vec3 pos = position * inflate;
  vObjPos = pos;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
}
