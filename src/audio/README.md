# Stargaze audio

Everything you hear in the cabin is synthesised in the browser with the Web Audio API: a vintage
tabletop radio playing generative lofi (or your own files / an internet stream), a quiet ship ambience
and soft tactile sound effects. No audio assets are downloaded.

Priorities, in order: musical quality, the radio/cabin atmosphere, performance.

## Files

| File | What it does |
| --- | --- |
| `index.ts` | Public entry: `AudioSystem` (+ re-exports `Radio`, `Ambience`, `Sfx`, `makeStations`, types). |
| `types.ts` | Public types (`StationDef`, `StationStyle`, `RadioInfo`, `SfxName`, ...). |
| `engine.ts` | Master bus, limiter, cabin room (convolver), listener, volume groups, tick dispatch, quality mode. |
| `clock.ts` | Scheduler clock: an inline Web Worker ticking every 25 ms (keeps time in background tabs). |
| `radio.ts` | The radio: bands, dial/tuning, station players, speaker chain, HRTF panner, room send, info, levels. |
| `stations.ts` | `makeStations(systemSeed)` and `StationPlayer` (a station's "live" programme of tracks). |
| `tuner.ts` | Static, heterodyne whistle, AM chatter and the radio's hiss floor. |
| `speaker.ts` | `Glue` (broadcast bus compression + soft clip + 30 Hz HPF) and `Speaker` (vintage colouration). |
| `media.ts` | Tape deck (player's files via blob URLs) and link player (streams, with the no-CORS fallback). |
| `room.ts` | Procedural impulse responses: the wood-panelled cabin and the broadcast plate. |
| `ambience.ts` | Ship hum, harmonic drone, air vent, warp rumble, rare creaks/ticks. |
| `sfx.ts` | 12 synthesised SFX, positional through HRTF panners. |
| `dsp.ts` | Small offline DSP kit (RBJ biquads, noise, helpers) used to pre-render buffers. |
| `music/theory.ts` | Keys, chord qualities, voicing search with voice leading, melody pitch sets. |
| `music/progressions.ts` | Jazz/neo-soul progression library and loop-evolving substitutions. |
| `music/styles.ts` | Station style palettes (tempo, harmony, instruments, textures). |
| `music/drums.ts` | Boom-bap / brush / half-time grooves, variations and fills. |
| `music/melody.ts` | Motifs, variations, chord-aware realisation, clash checks. |
| `music/compose.ts` | `planTrack` / `composeTrack`: seed + style -> a fully arranged, timed score. |
| `music/inspect.ts` | Score dumps and automated music checks. |
| `synth/band.ts` | `Band`: performs one track (instrument buses, FX, voices, wow & flutter, sidechain). |
| `synth/samples.ts` | Pre-rendered drums, Karplus-Strong guitar, additive felt piano, crackle, hiss, chatter. |
| `synth/bank.ts` | Buffer cache with lazy, time-sliced rendering of multisamples. |
| `synth/voices.ts` | Voice pool: polyphony limit, stealing, guaranteed node cleanup. |
| `offline.ts` | Offline rendering through the same code path (used by the tools). |
| `lab.ts` + `/audio-lab.html` | Manual test bench and hooks for `tools/audio/render.mjs`. |

Tools: `tools/audio/score.mjs` (score dumps, theory survey), `tools/audio/render.mjs` (headless Chromium
offline renders to WAV/MP3), `tools/audio/analyze.py` (loudness and quality measurements).

## Using it in the game

```ts
import { AudioSystem, makeStations } from './audio';

const audio = AudioSystem.create();            // no AudioContext yet ({ quality: 'low' } for weak devices)
audio.radio.setStations(makeStations(systemSeed));
audio.radio.setPosition([0.55, 0.85, -0.75], [-0.55, 0.2, 0.8]); // the radio on the console, facing the pilot

boardButton.onclick = () => audio.unlock();     // must be inside the user gesture

// every frame (ship-local cabin frame, metres, +Y up, ship forward is -Z)
audio.setListener(camPos, camForward, camUp);
audio.ambience.setShipState({ throttle, speed, warp }); // 0..1, cheap to call every frame

// arriving in a new star system
audio.radio.setStations(makeStations(newSystemSeed));   // retunes through static

// warp sequence
audio.sfx.play('warp-spool');  // ~2.6 s, then
audio.sfx.play('warp-jump');   // while ambience warp goes 0 -> 1, and on arrival
audio.sfx.play('warp-exit');   // while warp goes back to 0

// cabin interactions (positional: pass the prop's position in the cabin frame)
audio.sfx.play('switch', radioPos); audio.radio.setPower(!audio.radio.on);
audio.sfx.play('knob', radioPos);   audio.radio.nextStation();
audio.radio.tune(dialMHz);          // while the player drags the dial
audio.radio.onInfo((i) => updateRadioDisplay(i)); // station, freq, title, bpm, key, time, signal
const { rms, peak } = audio.radio.getLevels();     // VU needle
audio.radio.getSpectrum(bins);                     // Uint8Array, e.g. 64..1024 bins for a tiny display

// settings / pause menu
audio.setVolumes({ master, music, ambience, sfx }); // 0..1
audio.suspend(); audio.resume();
```

`unlock()` creates and resumes the `AudioContext` synchronously inside the gesture (Safari needs that),
switches iOS to the "playback" audio session (plays through the mute switch), builds the graph and starts
the ambience and the radio (valve warm-up). Calls made before unlock are remembered.

## Signal flow

```
 StationPlayer ─ Band (one per track) ─┐ per band: instrument buses → sidechain duck → sub shelf
 StationPlayer ─ Band ─────────────────┤   → section filter → tape saturation → fade → reception
                                       │   (signal gain + weak-signal low-pass); sends → plate
 broadcast plate reverb (shared) ──────┤
                                       ▼
            stations sum ─▶ Glue (comp, soft clip, 30 Hz HPF) ─▶ [broadcast mix tap]
                                       │           tape / link (trim) ─┐   tuner (static, whistle,
                                       ▼                                ▼    chatter, hiss floor)
                         Speaker: mono downmix ─┬─ clean ───────────────────────┐
                                                └─ AGC → valve → HPF 180 → box 300 → presence 1.4k
                                                   → LP 5.8k/7.5k → make-up ────┤ equal-power
                                                                                ▼ crossfade
                         valve warm-up LP → power → volume knob → analyser
                                                                │
                                                     music volume
                                                 ┌──────────────┴───────────────┐
                                 distance/angle low-pass → HRTF panner      room send
                                                 │                             │
 ambience bed (+ positional creaks) ─ ambience vol ─┬────────────────────────▶ cabin room
 SFX (positional) ──────────────────── sfx vol ─────┤                           (convolver)
                                                     ▼                             │
                                master bus ◀────────────────────────────────────────┘
                                     └▶ master volume → limiter → soft clip → speakers
```

The radio is mono (it is a single speaker): the whole broadcast is downmixed at the speaker input and
placed in the cabin by an HRTF `PannerNode` (inverse distance, ref 0.6 m, gentle roll-off, a mild cone).
The direct path is dulled with distance and when you are behind the radio; the room send is constant, so
moving away makes the radio more reverberant and distant. Ambience and positional SFX share the room.

## The music

**Stations.** `makeStations(seed)` gives 2-4 stations with FM-style frequencies (88.1-107.9, odd tenths,
at least 1.6 MHz apart), warm names and distinct styles. Each station plays an endless sequence of tracks
(track seed = `hash(stationSeed, index)`), 2-3.5 minutes each with ~2.5 s of crackle between them. A
station keeps a virtual timeline, so tuning in joins the current track mid-song like real radio; audio is
only rendered while a station is audible.

**Styles.** Dusty Keys (Rhodes-led boom bap), Sunday Tape (nylon guitar + piano/vibes, brushes, walking
two-feel bass), Night Drive (slow, pads, breathy lead, half-time drums), Drift (beatless: pads, slow piano
or mallet arpeggios, glockenspiel/kalimba melodies), Café Boom Bap (felt-piano chops, crisp drums).

**Harmony.** ~30 progressions in major and minor (ii-V-I-vi, I-vi-ii-V, Imaj7-IVmaj7-iii7-vi7,
i9-iv9-bVImaj7-V7b9, IVmaj7-iv6-Imaj7, backdoor bVII9, "Just the two of us", tritone subs, chromatic
diminished passing chords, Andalusian and circle-of-fourths minor loops...). 4- or 8-bar loops evolve
instead of repeating: extension swaps (maj7/maj9/6-9, m7/m9/m11, 9/13/sus), secondary dominants with
key-aware alterations, tritone substitutions, inserted ii-V's, modal interchange (iv6), passing
diminished chords, sus resolutions, chromatic side-slips and passing inversions; turnarounds connect
sections. Outros resolve to the tonic.

**Voicings.** A small search over every octave placement of each rootless (or root-position for guitar
and pads) voicing set: no minor 2nds or minor 9ths inside a voicing, low-interval limits, compact spans,
register C3-A4, minimal voice movement from the previous chord (order-preserving DP matching), a smooth
top voice, plus a little seeded variety. The register widens upwards only if a chord cannot fit.
Comping patterns: sustained, rolled (15-45 ms), anticipated pushes, Charleston, halves, piano chops,
fingerpicked arpeggios and strums.

**Melody.** A 2-bar motif built from short note groups landing on longer notes, with contour turns and
no trills; it is repeated, varied (tail, rhythm, inversion, truncation, ornament, displacement) and
answered over the changes (call / response, long notes at phrase ends, plenty of rests). Strong beats
take chord tones (incl. 9ths); weak beats take chord-scale tones without avoid notes; every note is
checked against the voicing sounding at that moment (including anticipated chords and pads) so the line
never makes a minor 2nd / minor 9th. A final pass re-checks against the actual events. Second voices
answer in the rests of later sections, and the last melodic section may be doubled by a soft mallet.

**Bass and drums.** The bass follows the kick (roots, fifths, octaves), approaches the next chord
chromatically or by fifth, walks diatonically into new phrases, slides occasionally, and keeps at least
a fifth below the chord voicing. Drums are swung 16ths (53-64 %), humanised (±5-12 ms, laid-back
backbeat), with ghost notes, per-bar variations, fills on phrase ends, drop-outs before sections and
busier hats in later sections. Kicks pump the music bus a little (sidechain duck).

**Arrangement.** Intro (filtered, sparse) → A → B (melody, pads, counter-lines) → breakdown (drums out,
pad, filter dip) → A' / B' → outro (filter close, fade or tape stop), with noise risers into sections.

**Sound design.**
- Rhodes-style FM electric piano: 1:1 carrier/modulator with a velocity-scaled, decaying index, a short
  harmonic "tine" partial, pitch-dependent decay, damper release, stereo autopan, chorus, warm drive,
  low-shelf and a 4.6 kHz low-pass (Wurlitzer flavour in some tracks).
- Felt piano: additive, inharmonic partials, two-stage decay, detuned unison strings, hammer thump; two
  velocity layers; multisampled every 3 semitones and rendered lazily in time slices.
- Guitar: extended Karplus-Strong (allpass tuning, pick-position comb, nylon body resonances).
- Round bass (soft harmonics, plucky filter envelope, slides), warm detuned pads, breathy lead (vibrato,
  breath noise, legato glides), vibes / kalimba / glockenspiel / marimba mallets.
- Drums are synthesised one-shots (3 round-robin variants each), lightly bit/sample-rate reduced; the
  drum bus has a 6-8 kHz low-pass and gentle saturation.
- Texture: vinyl crackle (bounded clicks, rare soft pops, surface swish), tape hiss, and one shared
  wow & flutter bus per track (a `ConstantSourceNode` summing slow LFOs, connected to every source's
  `detune`, k-rate) so all instruments wobble together; the same bus performs tape stops.
- A shared plate reverb gives keys, pads, mallets and the lead some studio depth (~9 LU under the dry).

## The radio

- Speaker colouration: AGC, warm asymmetric "valve" saturation, 180 Hz high-pass, a small cabinet bump,
  +4.5 dB presence at 1.4 kHz, 5.8/7.5 kHz low-pass, level-matched make-up. `setCharacter(0..1)`
  equal-power crossfades clean ↔ vintage (with a taper so the default 0.7 is mostly the vintage set).
- Tuning: signal is 1 within 50 kHz of a station and fades out by ~250 kHz. Between stations: band-limited
  static with crackle bursts, faint murmuring AM voices at a few "phantom" frequencies, and a heterodyne
  whistle whose pitch follows the detuning. `next/prevStation()` sweep the dial out of the old station,
  through ~1.3 s of static and into the new one. A weak signal also muffles the station.
- Power: off ramps down with the valves cooling; on warms up over ~1.5 s with a little static.
- Tape band: the player's files (blob URLs → `HTMLAudioElement` → `MediaElementAudioSourceNode`) through
  the radio, with a level trim (mastered music is louder than the stations).
- Link band: tries a CORS-enabled element through the radio (`'ok'`); if the server forbids CORS the
  element plays directly without radio effects (`'no-cors'`), following the volumes; otherwise `'error'`.

## Robustness and performance

- The scheduler ticks from a Web Worker every 25 ms with a 200 ms look-ahead (1.6 s while the tab is
  hidden); everything is scheduled against `ctx.currentTime`; late events are skipped, not bunched.
- Voices are bounded (28 synth voices, 18 in low quality); the least important old voice is stolen with
  a 12 ms fade. Every source is stopped, every node disconnected and every modulation link removed;
  bands are only disposed after their fade has decayed (no cut-off clicks).
- All parameter changes use `setTargetAtTime` / ramps.
- `AudioSystem.create({ quality: 'low' })` (default on coarse-pointer devices): equal-power panning, a
  shorter room, no broadcast plate or EP chorus, fewer voices.
- Firefox (no listener AudioParams) and older Safari (no `positionX` on panners) use the legacy setters.
- Measured cost (Chromium, offline, one core): ~13 % of real time for the full system with a playing
  station, of which about half is the fixed graph (room, HRTF, compressors).

## Measurements (see `tools/audio/`)

Mix targets are measured on the broadcast mix (before the radio): integrated loudness -17 to -18.5 LUFS
per style, true peak below -3.5 dBTP, no clipped samples, DC < 1e-5, per-track loudness spread under
1 LU over 10 minutes. The radio output at the default knob (0.75) and listening position sits around
-17.5 to -18.5 LUFS. A 10-minute run keeps 87-237 live nodes with no growth (15k nodes created, all
released), at most 2 bands during handovers, ≤ 21 simultaneous synth voices and no voice steals. With
drums and textures muted there are no impulsive clicks at note boundaries. A 300-track survey of the
composer: 0 melody clashes, 0 off-scale or out-of-key notes, near-zero low-register crowding.

```
node tools/audio/score.mjs --style dusty-keys --seed 1234 --track 0 --drums    # readable score
node tools/audio/score.mjs --survey 40                                         # theory checks
node tools/audio/render.mjs --style drift --seed 4444 --seconds 90 --out /tmp/x/drift --mp3
python3 tools/audio/analyze.py /tmp/x/drift-radio.wav --skip 2 --png /tmp/x/drift.png   # needs numpy+scipy
```

## Known limitations / ideas

- The instruments are synthesised; they are pleasant and warm but not sample-library realistic (the felt
  piano and nylon guitar are the most "synthetic" sounding parts).
- The composer has no long-range memory across tracks (each track is independent; a station's tracks
  share only the style).
- No DJ voice or station idents; the AM chatter is abstract murmuring.
- Tape/link media are not pitch-wobbled (only the radio colouration applies).
- With more time: sampled one-shots for drums, a proper AudioWorklet tape/wow processor, per-station
  "personalities" (consistent keys/tempos), a few hand-written progressions per style.
