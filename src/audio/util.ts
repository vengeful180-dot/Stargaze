// Small helpers shared by the audio modules.

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => 20 * Math.log10(Math.max(1e-12, g));
export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Perceptual slider curve for 0..1 volume controls. */
export const sliderGain = (v: number) => {
  const x = clamp(v, 0, 1);
  return x * x;
};

/** Smoothly move an AudioParam towards a value (no zipper noise). */
export function setParam(p: AudioParam, v: number, ctx: BaseAudioContext, tau = 0.03, at?: number) {
  const t = Math.max(at ?? 0, ctx.currentTime);
  if (!Number.isFinite(v)) return;
  try {
    p.setTargetAtTime(v, t, tau);
  } catch {
    p.value = v;
  }
}

/** Jump an AudioParam to a value now, cancelling pending automation. */
export function setNow(p: AudioParam, v: number, ctx: BaseAudioContext) {
  const t = ctx.currentTime;
  p.cancelScheduledValues(t);
  p.setValueAtTime(v, t);
}

export function safeStop(src: AudioScheduledSourceNode, when?: number) {
  try {
    src.stop(when);
  } catch {
    /* already stopped */
  }
}

export function safeDisconnect(n: AudioNode | null | undefined) {
  if (!n) return;
  try {
    n.disconnect();
  } catch {
    /* not connected */
  }
}

/** Detach a source node from a param it modulates. */
export function safeDisconnectParam(from: AudioNode, p: AudioParam | null | undefined) {
  if (!p) return;
  try {
    from.disconnect(p);
  } catch {
    /* not connected */
  }
}

/** A WaveShaper curve for a smooth symmetric soft clipper.
 * Linear below `knee` (fraction of full scale), then rounds off towards `ceiling`.
 * The curve spans input [-range, range]; feed it signal scaled by 1/range. */
export function softClipCurve(knee = 0.6, ceiling = 0.98, range = 2, n = 4096): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const span = ceiling - knee;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * range;
    const a = Math.abs(x);
    let y: number;
    if (a <= knee) y = a;
    else y = knee + span * Math.tanh((a - knee) / span);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

/** Warm asymmetric saturation curve (adds mostly 2nd harmonic), DC-compensated at rest. */
export function warmCurve(drive = 1.5, asym = 0.12, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const off = Math.tanh(drive * asym);
  const norm = 1 / Math.tanh(drive * (1 + asym));
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh(drive * (x + asym)) - off) * norm;
  }
  return c;
}

/** Plain tanh saturator normalised to unity small-signal gain. */
export function tanhCurve(drive = 1.2, n = 2048): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / drive;
  }
  return c;
}

/** Counts live audio nodes and voices so long runs can prove there are no leaks. */
export class NodeStats {
  nodesLive = 0;
  nodesMax = 0;
  nodesCreated = 0;
  voicesLive = 0;
  voicesMax = 0;
  voicesCreated = 0;
  voicesStolen = 0;
  bandsLive = 0;
  addNodes(n: number) {
    this.nodesLive += n;
    this.nodesCreated += n;
    if (this.nodesLive > this.nodesMax) this.nodesMax = this.nodesLive;
  }
  removeNodes(n: number) {
    this.nodesLive -= n;
  }
  addVoice() {
    this.voicesLive++;
    this.voicesCreated++;
    if (this.voicesLive > this.voicesMax) this.voicesMax = this.voicesLive;
  }
  removeVoice() {
    this.voicesLive--;
  }
  snapshot() {
    return {
      nodesLive: this.nodesLive,
      nodesMax: this.nodesMax,
      nodesCreated: this.nodesCreated,
      voicesLive: this.voicesLive,
      voicesMax: this.voicesMax,
      voicesCreated: this.voicesCreated,
      voicesStolen: this.voicesStolen,
      bandsLive: this.bandsLive,
    };
  }
}

export function vecSub(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
export function vecLen(a: readonly number[]) {
  return Math.hypot(a[0], a[1], a[2]);
}
export function vecNorm(a: readonly number[]): [number, number, number] {
  const l = vecLen(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
export function vecDot(a: readonly number[], b: readonly number[]) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
