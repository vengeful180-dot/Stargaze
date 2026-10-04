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

## Cabin pipeline (`blender/`)

    B="blender -b --factory-startup --python-exit-code 1 -P"
    $B blender/build_cabin.py  -- --out blender/out/cabin_geo.blend --report blender/out/build.json
    $B blender/cabin_checks.py -- --blend blender/out/cabin_geo.blend --selftest
    $B blender/bake_cabin.py   -- --blend blender/out/cabin_geo.blend --out public/assets/cabin --tex 2048 --lm 1024
    $B blender/render_views.py -- --blend blender/out/cabin_geo.blend --out shots/clay/c --engine CYCLES --samples 12

- `cabin_layout.py` holds every dimension (one source); `build_props.py` the furniture and props; `build_cabin.py`
  the shell, canopy and console and the list of areas; `meshkit.py` the closed-solid builders.
- `cabin_look.py`: Cycles materials per face zone, and the practical lights (`LIGHTS`). Light powers are solved
  from the per-object irradiance report `bake_cabin.py` prints after each lightmap bake, not guessed.
- `cabin_checks.py` gates every build: closed solids, attachment (contact graph to the hull), containment in the
  hull, clearances, sweeps of every moving part, the pilot's eye. `--selftest` breaks the cabin on purpose and
  requires each break to be caught. Run it after any geometry change.
- The game reads `public/assets/cabin/cabin.json`: textures, lightmap encoding, emitters per node, pivots, radio
  position. Node names are an API: `Screen_L/C/R`, `Radio_Dial`, `Radio_Knob_*`, `Orrery_Arm_*` (extras
  `rest_angle`), `Switch_1..4`, `Throttle_Lever`, `Gauge_*_Needle`, `Spot_*` markers.

## Budgets

60 fps on a mid-range laptop at 1080p on the High preset; Low must run on integrated GPUs and phones.
Download under ~25 MB. Cabin under ~250k triangles and ~60 draw calls.
