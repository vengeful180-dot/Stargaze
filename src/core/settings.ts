// Player settings (persisted) and the quality presets they select.

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualityPreset {
  pixelRatio: number; // cap on devicePixelRatio
  msaa: number; // 0 = off
  skyFace: number; // sky cubemap face size
  skySteps: number; // galaxy raymarch steps
  planetFace: number; // surface cubemap face for distant planets
  nearPlanetFace: number; // face size for the planet you are close to
  cloudFace: number;
  atmosphereSteps: number;
  shadowMap: number;
  stars: number; // catalogue stars drawn as points
  rocks: number; // max asteroid instances
  bloomLevels: number;
}

export const QUALITY: Record<QualityLevel, QualityPreset> = {
  low: {
    pixelRatio: 0.75, msaa: 0, skyFace: 1024, skySteps: 28, planetFace: 128, nearPlanetFace: 512, cloudFace: 256,
    atmosphereSteps: 8, shadowMap: 1024, stars: 2500, rocks: 300, bloomLevels: 5,
  },
  medium: {
    pixelRatio: 1, msaa: 2, skyFace: 1024, skySteps: 40, planetFace: 256, nearPlanetFace: 1024, cloudFace: 512,
    atmosphereSteps: 10, shadowMap: 2048, stars: 4500, rocks: 700, bloomLevels: 6,
  },
  high: {
    pixelRatio: 1.5, msaa: 4, skyFace: 1024, skySteps: 56, planetFace: 256, nearPlanetFace: 1024, cloudFace: 512,
    atmosphereSteps: 12, shadowMap: 2048, stars: 7000, rocks: 1200, bloomLevels: 7,
  },
  ultra: {
    pixelRatio: 2, msaa: 4, skyFace: 2048, skySteps: 72, planetFace: 512, nearPlanetFace: 2048, cloudFace: 1024,
    atmosphereSteps: 16, shadowMap: 4096, stars: 10000, rocks: 2000, bloomLevels: 8,
  },
};

export interface Settings {
  quality: QualityLevel | 'auto';
  master: number;
  music: number;
  ambience: number;
  sfx: number;
  radioCharacter: number;
  lookSensitivity: number;
  invertY: boolean;
  fov: number;
  reduceMotion: boolean;
  hints: boolean;
}

const DEFAULTS: Settings = {
  quality: 'auto',
  master: 0.85,
  music: 0.8,
  ambience: 0.6,
  sfx: 0.7,
  radioCharacter: 0.7,
  lookSensitivity: 1,
  invertY: false,
  fov: 68,
  reduceMotion: false,
  hints: true,
};

const KEY = 'stargaze.settings.v1';

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    // private mode or blocked storage: defaults are fine
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

/** First guess at a quality level from the device; refined by measuring frame times. */
export function guessQuality(): QualityLevel {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && innerWidth < 1100);
  if (mobile) return 'low';
  const cores = navigator.hardwareConcurrency ?? 4;
  return cores >= 8 ? 'high' : 'medium';
}
