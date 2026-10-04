// Cabin surfaces write alpha 0 so post effects can tell the cabin from the view outside the windows
// (the warp tunnel only streaks what is seen through the glass).
import type * as THREE from 'three';

export function markCabin<T extends THREE.Material>(m: T, alpha = 0): T {
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>\n  gl_FragColor.a = ${alpha.toFixed(3)};`,
    );
  };
  m.customProgramCacheKey = () => `cabin-${alpha}`;
  return m;
}
