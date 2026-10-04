// Shared public types for the audio system.

export type Vec3 = [number, number, number];

export type StationStyle = 'dusty-keys' | 'sunday-tape' | 'night-drive' | 'drift' | 'cafe-boom-bap';

export const STATION_STYLES: readonly StationStyle[] = ['dusty-keys', 'sunday-tape', 'night-drive', 'drift', 'cafe-boom-bap'];

export const STYLE_LABELS: Record<StationStyle, string> = {
  'dusty-keys': 'Dusty Keys',
  'sunday-tape': 'Sunday Tape',
  'night-drive': 'Night Drive',
  drift: 'Drift',
  'cafe-boom-bap': 'Café Boom Bap',
};

export interface StationDef {
  seed: number;
  /** Dial frequency label in MHz, e.g. 94.3. */
  freq: number;
  name: string;
  style: StationStyle;
}

export type RadioBand = 'stations' | 'tape' | 'link';

export interface RadioInfo {
  band: RadioBand;
  on: boolean;
  /** Current dial position (MHz). */
  freq: number;
  /** Station name when tuned close to one, the file name on tape, the URL on link. */
  station: string | null;
  stationFreq: number | null;
  style: StationStyle | null;
  styleLabel: string | null;
  title: string | null;
  bpm: number | null;
  /** e.g. "E♭ major". */
  key: string | null;
  /** Seconds into the current track. */
  elapsed: number;
  /** Track length in seconds, null for live streams. */
  duration: number | null;
  /** 0..1 reception (1 = locked on a station, or always 1 on tape/link while playing). */
  signal: number;
  trackIndex: number;
  /** 'off' | 'tuning' | 'static' | 'playing' | 'loading' | 'no-cors' | 'error' | 'empty' */
  status: string;
  /** Tape playlist length (tape band). */
  tapeCount: number;
}

export type SfxName =
  | 'click'
  | 'switch'
  | 'knob'
  | 'button'
  | 'beep'
  | 'bump'
  | 'warp-spool'
  | 'warp-jump'
  | 'warp-exit'
  | 'seat'
  | 'telescope'
  | 'pour';

export const SFX_NAMES: readonly SfxName[] = [
  'click', 'switch', 'knob', 'button', 'beep', 'bump', 'warp-spool', 'warp-jump', 'warp-exit', 'seat', 'telescope', 'pour',
];

export interface ShipState {
  throttle: number;
  /** 0..1 normalised */
  speed: number;
  /** 0..1 */
  warp: number;
}

export interface Volumes {
  master?: number;
  music?: number;
  ambience?: number;
  sfx?: number;
}
