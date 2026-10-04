// The console's three screens, drawn live into canvases: SHIP (lights, cabin), NAV (where we are and are going),
// RADIO (what's playing). Warm amber phosphor, soft scanlines; buttons on them are clickable through the 3D view.
import * as THREE from 'three';
import { formatDistance, formatDuration, formatSpeed } from '../core/math';

export interface ScreenData {
  system: string;
  starClass: string;
  target: string | null;
  targetKind: string;
  distance: number;
  eta: number;
  speed: number;
  mode: string;
  planets: { name: string; orbit: number; angle: number; ringed: boolean; selected: boolean; here: boolean }[];
  lamps: number;
  console: number;
  radio: { on: boolean; station: string; freq: string; freqMHz: number; title: string; band: string; levels: number[]; signal: number; status: string };
  catalogued: number;
  clock: Date;
}

interface Button {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const W = 640;
const H = 320;
const AMBER = '#ffb45c';
const AMBER_DIM = 'rgba(255, 180, 92, 0.42)';
const AMBER_FAINT = 'rgba(255, 180, 92, 0.14)';
const TEAL = '#7fe0cf';

const vert = /* glsl */ `
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_vertex>
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;

const frag = /* glsl */ `
uniform sampler2D map;
uniform float uBright;
uniform float uTime;
varying vec2 vUv;
#include <common>
#include <logdepthbuf_pars_fragment>
void main() {
  #include <logdepthbuf_fragment>
  vec2 uv = vUv;
  // a hint of tube curvature at the corners
  vec2 c = uv - 0.5;
  uv = 0.5 + c * (1.0 + 0.025 * dot(c, c));
  vec3 col = texture2D(map, uv).rgb;
  // phosphor bloom: a little of the neighbours bleeds in
  col += 0.18 * (texture2D(map, uv + vec2(0.0018, 0.0)).rgb + texture2D(map, uv - vec2(0.0018, 0.0)).rgb);
  float scan = 0.88 + 0.12 * sin(uv.y * 320.0 * 3.14159);
  float vig = smoothstep(0.75, 0.25, length(c * vec2(1.0, 1.3)));
  float flicker = 0.985 + 0.015 * sin(uTime * 6.0);
  vec3 glass = vec3(0.012, 0.010, 0.008);
  col = glass + col * scan * vig * flicker * uBright;
  gl_FragColor = vec4(col, 0.0);
}`;

export class Screen {
  readonly canvas = document.createElement('canvas');
  readonly ctx: CanvasRenderingContext2D;
  readonly texture: THREE.CanvasTexture;
  readonly material: THREE.ShaderMaterial;
  buttons: Button[] = [];
  hover: string | null = null;

  constructor(
    readonly name: string,
    readonly draw: (s: Screen, d: ScreenData) => void,
    readonly w = W,
    readonly h = H,
  ) {
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.ShaderMaterial({
      vertexShader: vert,
      fragmentShader: frag,
      uniforms: { map: { value: this.texture }, uBright: { value: 1.4 }, uTime: { value: 0 } },
    });
  }

  render(d: ScreenData) {
    const c = this.ctx;
    c.save();
    c.fillStyle = '#060403';
    c.fillRect(0, 0, this.w, this.h);
    this.buttons = [];
    this.draw(this, d);
    c.restore();
    this.texture.needsUpdate = true;
  }

  /** a rounded outline button; returns its rect */
  button(id: string, label: string, x: number, y: number, w: number, h: number, active = false) {
    const c = this.ctx;
    const hot = this.hover === id;
    c.lineWidth = 2;
    c.strokeStyle = active || hot ? AMBER : AMBER_DIM;
    c.fillStyle = active ? 'rgba(255, 180, 92, 0.22)' : hot ? 'rgba(255, 180, 92, 0.1)' : 'transparent';
    roundRect(c, x, y, w, h, 8);
    c.fill();
    c.stroke();
    c.fillStyle = active || hot ? AMBER : AMBER_DIM;
    c.font = '500 20px "IBM Plex Mono", monospace';
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(label, x + w / 2, y + h / 2 + 1);
    this.buttons.push({ id, x, y, w, h });
  }

  hit(u: number, v: number): string | null {
    const x = u * this.w;
    const y = (1 - v) * this.h;
    const b = this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
    return b ? b.id : null;
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function header(c: CanvasRenderingContext2D, title: string, right: string) {
  c.fillStyle = AMBER_DIM;
  c.font = '500 17px "IBM Plex Mono", monospace';
  c.textBaseline = 'alphabetic';
  c.textAlign = 'left';
  c.fillText(title, 26, 38);
  c.textAlign = 'right';
  c.fillText(right, W - 26, 38);
  c.fillStyle = AMBER_FAINT;
  c.fillRect(26, 50, W - 52, 2);
}

function bar(c: CanvasRenderingContext2D, x: number, y: number, w: number, value: number, label: string) {
  c.fillStyle = AMBER_DIM;
  c.font = '500 18px "IBM Plex Mono", monospace';
  c.textAlign = 'left';
  c.textBaseline = 'middle';
  c.fillText(label, x, y);
  const bx = x + 130;
  const segs = 14;
  for (let i = 0; i < segs; i++) {
    const on = i < Math.round((value / 1.5) * segs);
    c.fillStyle = on ? AMBER : AMBER_FAINT;
    c.fillRect(bx + i * ((w - 130) / segs), y - 9, (w - 130) / segs - 4, 18);
  }
}

export function drawShip(s: Screen, d: ScreenData) {
  const c = s.ctx;
  const time = d.clock.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  header(c, 'CABIN', time);
  bar(c, 26, 92, 400, d.lamps, 'LAMPS');
  s.button('lamps-', '–', 450, 74, 56, 38);
  s.button('lamps+', '+', 520, 74, 56, 38);
  bar(c, 26, 150, 400, d.console, 'GLOW');
  s.button('glow-', '–', 450, 132, 56, 38);
  s.button('glow+', '+', 520, 132, 56, 38);
  c.fillStyle = AMBER_DIM;
  c.font = '500 18px "IBM Plex Mono", monospace';
  c.textAlign = 'left';
  c.fillText('AIR 21.4°C   HUMIDITY 46%', 26, 214);
  c.fillText('HULL NOMINAL   KETTLE WARM', 26, 246);
  s.button('night', 'NIGHT', 26, 268, 130, 38, d.lamps < 0.35);
  s.button('cozy', 'COZY', 168, 268, 130, 38, d.lamps >= 0.35 && d.lamps <= 1.1);
  s.button('bright', 'BRIGHT', 310, 268, 130, 38, d.lamps > 1.1);
}

export function drawNav(s: Screen, d: ScreenData) {
  const c = s.ctx;
  header(c, `NAV · ${d.system.toUpperCase()}`, d.starClass);
  // orbit diagram on the left
  const cx = 150, cy = 188, R = 108;
  c.strokeStyle = AMBER_FAINT;
  c.lineWidth = 1.5;
  const maxOrbit = Math.max(1, ...d.planets.map((p) => p.orbit));
  c.fillStyle = AMBER;
  c.beginPath();
  c.arc(cx, cy, 6, 0, Math.PI * 2);
  c.fill();
  for (const p of d.planets) {
    const r = 18 + (Math.sqrt(p.orbit / maxOrbit)) * (R - 18);
    c.beginPath();
    c.arc(cx, cy, r, 0, Math.PI * 2);
    c.stroke();
    const px = cx + Math.cos(p.angle) * r, py = cy + Math.sin(p.angle) * r;
    c.fillStyle = p.here ? TEAL : p.selected ? AMBER : AMBER_DIM;
    c.beginPath();
    c.arc(px, py, p.here || p.selected ? 5.5 : 3.8, 0, Math.PI * 2);
    c.fill();
    if (p.ringed) {
      c.strokeStyle = AMBER_DIM;
      c.beginPath();
      c.ellipse(px, py, 9, 3.5, -0.4, 0, Math.PI * 2);
      c.stroke();
      c.strokeStyle = AMBER_FAINT;
    }
  }
  // text on the right
  const x = 300;
  c.textAlign = 'left';
  c.textBaseline = 'alphabetic';
  c.fillStyle = AMBER_DIM;
  c.font = '500 16px "IBM Plex Mono", monospace';
  c.fillText(d.target ? d.targetKind.toUpperCase() : 'NO TARGET', x, 88);
  c.fillStyle = AMBER;
  c.font = '500 30px "IBM Plex Mono", monospace';
  c.fillText(d.target ? d.target.slice(0, 16) : '—', x, 124);
  c.font = '500 19px "IBM Plex Mono", monospace';
  c.fillStyle = AMBER_DIM;
  c.fillText(d.target ? formatDistance(d.distance) : 'click a world', x, 160);
  c.fillText(isFinite(d.eta) && d.eta > 0 ? `ETA ${formatDuration(d.eta)}` : d.mode.toUpperCase(), x, 190);
  c.fillText(d.speed > 0.5 ? formatSpeed(d.speed) : 'AT REST', x, 220);
  s.button('map', 'MAP', x, 256, 140, 42);
  s.button(d.mode === 'autopilot' ? 'stop' : 'go', d.mode === 'autopilot' ? 'STOP' : 'ENGAGE', x + 154, 256, 160, 42, d.mode === 'autopilot');
}

export function drawRadio(s: Screen, d: ScreenData) {
  const c = s.ctx;
  header(c, 'RADIO', d.radio.on ? d.radio.band.toUpperCase() : 'OFF');
  c.textAlign = 'left';
  c.fillStyle = AMBER;
  c.font = '500 34px "IBM Plex Mono", monospace';
  c.fillText(d.radio.on ? d.radio.freq : '—', 26, 102);
  c.font = '500 19px "IBM Plex Mono", monospace';
  c.fillStyle = AMBER_DIM;
  c.fillText(d.radio.on ? d.radio.station.slice(0, 30) : 'switch on for some company', 26, 134);
  c.fillStyle = AMBER;
  c.font = '500 22px "IBM Plex Mono", monospace';
  c.fillText(d.radio.on ? `♪ ${d.radio.title}`.slice(0, 32) : '', 26, 172);
  // VU bars
  const lv = d.radio.levels;
  const n = 24;
  for (let i = 0; i < n; i++) {
    const v = d.radio.on ? (lv[Math.floor((i / n) * lv.length)] ?? 0) : 0;
    const h = 4 + v * 46;
    c.fillStyle = i % 2 ? AMBER_DIM : AMBER;
    c.fillRect(26 + i * 24, 236 - h, 16, h);
  }
  s.button('prev', '◀', 26, 258, 80, 44);
  s.button('power', d.radio.on ? 'OFF' : 'ON', 118, 258, 110, 44, d.radio.on);
  s.button('next', '▶', 240, 258, 80, 44);
  s.button('band', 'BAND', 334, 258, 120, 44);
  c.fillStyle = AMBER_DIM;
  c.font = '500 16px "IBM Plex Mono", monospace';
  c.textAlign = 'right';
  c.fillText(`LOG ${d.catalogued}`, W - 26, 288);
}

/** The radio's tuning window: a backlit scale 87.5-108.5 MHz with a red needle on the tuned frequency. */
export function drawDial(s: Screen, d: ScreenData) {
  const c = s.ctx;
  const w = s.w, h = s.h;
  const on = d.radio.on;
  // warm backlight, brighter in the middle like a bulb behind paper
  const g = c.createRadialGradient(w / 2, h * 0.6, 4, w / 2, h * 0.6, w * 0.6);
  g.addColorStop(0, on ? 'rgba(255, 196, 120, 0.95)' : 'rgba(60, 40, 22, 0.6)');
  g.addColorStop(1, on ? 'rgba(170, 96, 38, 0.85)' : 'rgba(26, 16, 9, 0.6)');
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
  const x0 = 18, x1 = w - 18;
  const fx = (f: number) => x0 + ((f - 87.5) / 21) * (x1 - x0);
  c.strokeStyle = 'rgba(40, 20, 8, 0.9)';
  c.fillStyle = 'rgba(40, 20, 8, 0.9)';
  c.lineWidth = 2;
  for (let f = 88; f <= 108; f += 1) {
    const x = fx(f);
    const major = f % 4 === 0;
    c.beginPath();
    c.moveTo(x, h * 0.62);
    c.lineTo(x, h * (major ? 0.36 : 0.48));
    c.stroke();
    if (major) {
      c.font = '600 19px "IBM Plex Mono", monospace';
      c.textAlign = 'center';
      c.fillText(String(f), x, h * 0.86);
    }
  }
  c.font = '600 14px "IBM Plex Mono", monospace';
  c.textAlign = 'left';
  c.fillText('FM', 8, 22);
  c.textAlign = 'right';
  c.fillText('MHz', w - 8, 22);
  // the needle
  const x = fx(Math.min(108.5, Math.max(87.5, d.radio.freqMHz || 94)));
  c.strokeStyle = '#b3160c';
  c.lineWidth = 3;
  c.beginPath();
  c.moveTo(x, 6);
  c.lineTo(x, h - 6);
  c.stroke();
}
