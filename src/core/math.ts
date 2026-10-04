export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const saturate = (x: number) => clamp(x, 0, 1);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const invLerp = (a: number, b: number, x: number) => (x - a) / (b - a);
export const remap = (x: number, a: number, b: number, c: number, d: number) => c + ((x - a) / (b - a)) * (d - c);

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = saturate((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach: move a toward b with rate lambda (1/s). */
export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

/** Shortest signed angle difference b - a in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

export function dampAngle(a: number, b: number, lambda: number, dt: number): number {
  return a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));
}

/** Format a distance in metres for the HUD. */
export function formatDistance(m: number): string {
  const LY = 9.4607e15;
  const AU = 1.495978707e11;
  if (m >= 0.05 * LY) return `${(m / LY).toFixed(m < LY ? 2 : 1)} ly`;
  if (m >= 0.1 * AU) return `${(m / AU).toFixed(2)} AU`;
  if (m >= 1e6) return `${Math.round(m / 1000).toLocaleString('en-US')} km`;
  if (m >= 1e3) return `${(m / 1000).toFixed(1)} km`;
  return `${Math.round(m)} m`;
}

export function formatSpeed(ms: number): string {
  const C = 299792458;
  if (ms >= 0.01 * C) return `${(ms / C).toFixed(2)} c`;
  if (ms >= 1e3) return `${(ms / 1000).toFixed(ms < 1e4 ? 1 : 0)} km/s`;
  return `${ms.toFixed(ms < 10 ? 1 : 0)} m/s`;
}

export function formatDuration(s: number): string {
  if (!isFinite(s)) return '--';
  if (s < 60) return `${Math.max(0, Math.round(s))} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${Math.round(s - m * 60)} s`;
  const h = Math.floor(m / 60);
  return `${h} h ${m - h * 60} min`;
}
