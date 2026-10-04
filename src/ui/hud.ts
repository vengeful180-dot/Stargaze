// HTML overlay: title card, hints, target card, toasts. Warm and quiet; the cabin screens carry the rest.
import { formatDistance, formatDuration, formatSpeed } from '../core/math';

export interface TargetInfo {
  name: string;
  kind: string;
  detail: string;
  distance: number;
  eta: number;
  flying: boolean;
  parked: boolean;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}

export class Hud {
  readonly root: HTMLDivElement;
  private title: HTMLDivElement;
  private hints: HTMLDivElement;
  private card: HTMLDivElement;
  private cardName: HTMLDivElement;
  private cardKind: HTMLDivElement;
  private cardDetail: HTMLDivElement;
  private cardDist: HTMLSpanElement;
  private cardEta: HTMLSpanElement;
  private flyBtn: HTMLButtonElement;
  private status: HTMLDivElement;
  private toasts: HTMLDivElement;
  private speedEl: HTMLDivElement;
  private hintTimer = 0;
  onBoard: (() => void) | null = null;
  onFly: (() => void) | null = null;
  onStop: (() => void) | null = null;
  onMap: (() => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'hud');
    parent.appendChild(this.root);

    this.title = el(
      'div',
      'title-card',
      `<div class="title-inner">
        <div class="title-kicker">a small cabin among the stars</div>
        <h1>Stargaze</h1>
        <p class="title-sub">Drift between worlds. Make tea. Let the radio play.</p>
        <button class="board" type="button">Board the ship</button>
        <p class="title-foot">Headphones recommended &middot; drag to look around</p>
      </div>`,
    );
    this.title.querySelector('button')!.addEventListener('click', () => this.board());
    this.root.appendChild(this.title);

    this.hints = el(
      'div',
      'hints',
      `<span><kbd>drag</kbd> look around</span>
       <span><kbd>click</kbd> a planet to fly there</span>
       <span><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> steer</span>
       <span><kbd>M</kbd> galaxy map</span>`,
    );
    this.root.appendChild(this.hints);

    this.card = el('div', 'target-card');
    this.cardKind = el('div', 'target-kind');
    this.cardName = el('div', 'target-name');
    this.cardDetail = el('div', 'target-detail');
    const row = el('div', 'target-row');
    this.cardDist = el('span', 'mono');
    this.cardEta = el('span', 'mono dim');
    row.append(this.cardDist, this.cardEta);
    this.flyBtn = el('button', 'fly', 'Fly there') as HTMLButtonElement;
    this.flyBtn.type = 'button';
    this.flyBtn.addEventListener('click', () => (this.flyBtn.dataset.mode === 'stop' ? this.onStop?.() : this.onFly?.()));
    this.card.append(this.cardKind, this.cardName, this.cardDetail, row, this.flyBtn);
    this.root.appendChild(this.card);

    this.status = el('div', 'status');
    this.root.appendChild(this.status);
    this.speedEl = el('div', 'speed mono');
    this.root.appendChild(this.speedEl);
    this.toasts = el('div', 'toasts');
    this.root.appendChild(this.toasts);
    const mapBtn = el('button', 'corner-btn map-btn', 'Map') as HTMLButtonElement;
    mapBtn.type = 'button';
    mapBtn.title = 'Galaxy map (M)';
    mapBtn.addEventListener('click', () => this.onMap?.());
    this.root.appendChild(mapBtn);
  }

  get boarded(): boolean {
    return this.title.classList.contains('gone');
  }

  board() {
    if (this.boarded) return;
    this.title.classList.add('leaving');
    setTimeout(() => this.title.classList.add('gone'), 1200);
    this.root.classList.add('boarded');
    this.hintTimer = 28;
    this.onBoard?.();
  }

  skipTitle() {
    this.title.classList.add('gone');
    this.root.classList.add('boarded');
  }

  setStatus(system: string, star: string) {
    this.status.innerHTML = `<div class="status-name">${system}</div><div class="status-star">${star}</div>`;
  }

  setTarget(t: TargetInfo | null) {
    if (!t) {
      this.card.classList.remove('show');
      return;
    }
    this.card.classList.add('show');
    this.cardKind.textContent = t.kind;
    this.cardName.textContent = t.name;
    this.cardDetail.textContent = t.detail;
    this.cardDist.textContent = formatDistance(t.distance);
    this.cardEta.textContent = t.flying && isFinite(t.eta) ? `arriving in ${formatDuration(t.eta)}` : t.parked ? 'in orbit' : '';
    this.flyBtn.textContent = t.flying ? 'Stop' : t.parked ? 'In orbit' : 'Fly there';
    this.flyBtn.dataset.mode = t.flying ? 'stop' : 'fly';
    this.flyBtn.disabled = t.parked && !t.flying;
  }

  setSpeed(ms: number, mode: string) {
    this.speedEl.textContent = ms > 0.5 ? `${formatSpeed(ms)} · ${mode}` : mode;
  }

  toast(text: string, ms = 3200) {
    const t = el('div', 'toast', text);
    this.toasts.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 600);
    }, ms);
  }

  noteInteraction() {
    this.hintTimer = Math.min(this.hintTimer, 6);
  }

  update(dt: number) {
    if (this.hintTimer > 0) {
      this.hintTimer -= dt;
      this.hints.classList.toggle('show', this.hintTimer > 0);
    }
  }
}
