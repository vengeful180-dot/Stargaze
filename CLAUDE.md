# Stargaze — notes for coding agents

A cozy spaceship cabin (built in Blender, lighting baked) drifting through a procedurally generated galaxy
(generated live in the browser with three.js), with a radio playing generative lofi. Static site, no server.

## Commands

- `npm run dev` — Vite dev server.
- `npm run build` — typecheck + production build into `dist/` (relative base, works on GitHub Pages and itch.io).
- `npm run typecheck`
- `npm run shots` — headless Chromium (SwiftShader WebGL2) screenshots of preset views into `shots/`; see `tools/shots.mjs`.

## Layout

- `src/core/` — seeded RNG (`rng.ts`), math, colour (blackbody), CPU noise, settings, input.
- `src/glsl/` — shared GLSL (`noise.glsl`: PCG3D-hashed gradient noise, fbm with analytic gradients, cellular, craters).
- `src/space/` — galaxy catalogue (`galaxy.ts`), system generator (`system.ts`), sky, star, planets, asteroids, dust.
- `src/ship/` — flight model, autopilot, warp.
- `src/cabin/` — cabin GLB, lightmaps, interactive props, diegetic screens.
- `src/audio/` — audio system: radio (generative lofi stations, tape, links), speaker colouration, room, ambience, SFX.
- `src/ui/` — HTML overlay (title, hints, settings, map).
- `blender/` — Blender 5.2 Python pipeline that builds, bakes and exports the cabin. Outputs go to `public/assets/`.

## Conventions

- **Determinism.** Everything persistent (galaxy, systems, planets, rocks, music) derives from `Rng`/`hash` in
  `src/core/rng.ts` and the universe seed. Never use `Math.random()` for generated content; it is fine for
  throwaway effects (sparkle, jitter).
- **Units and frames.** Metres everywhere. three.js convention: +Y up, the ship's forward is -Z.
  - Galactic frame: disc in XZ, +Y galactic north; galaxy catalogue positions are in light-years.
  - System frame: star at the origin, axes aligned with the galactic frame; orbits use `GAME_AU` (compressed).
  - Floating origin: the scene origin is the ship. Space objects are placed at `bodyPos - shipPos` each frame
    (doubles in JS, floats on the GPU). The cabin and camera live under the ship group (ship-local frame).
  - Blender: +Z up, front +Y; the glTF exporter maps that to three.js +Y up, front -Z.
- **Depth.** The renderer uses a logarithmic depth buffer; custom `ShaderMaterial`s must include the
  `logdepthbuf_*` chunks.
- **Shaders.** Write GLSL ES 3.00 through three's `ShaderMaterial` (it prefixes `#version 300 es`); import shared
  code with `?raw` and concatenate.
- **Audio.** No downloaded audio assets: everything is synthesised with the Web Audio API. Music always plays
  through the cabin radio (speaker colouration, room reverb, positioned at the radio).
- **Blender pipeline.** Follows the `blender-procedural-assets` skill: closed outward solids, mounts sunk into
  supports, checks that are proven able to fail, `--python-exit-code 1`, export uncompressed for the audit and
  compress only in a separate web step.

## Budgets

60 fps on a mid-range laptop at 1080p on the High preset; Low must run on integrated GPUs and phones.
Download under ~25 MB. Cabin under ~250k triangles and ~60 draw calls.
