// Pointer, touch and keyboard input. Drag to look; a press without much movement is a click.
export interface ClickEvent {
  x: number; // normalised device coords
  y: number;
  clientX: number;
  clientY: number;
}

export class Input {
  readonly keys = new Set<string>();
  lookDX = 0;
  lookDY = 0;
  wheel = 0;
  pinch = 0;
  pointerX = 0; // NDC, for hover
  pointerY = 0;
  hasPointer = false;
  dragging = false;
  private downX = 0;
  private downY = 0;
  private lastX = 0;
  private lastY = 0;
  private moved = 0;
  private activeId: number | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  onClick: ((e: ClickEvent) => void) | null = null;
  onKey: ((code: string, e: KeyboardEvent) => void) | null = null;

  constructor(private el: HTMLElement) {
    el.addEventListener('pointerdown', this.down);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
    window.addEventListener('pointercancel', this.up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY) * Math.min(3, Math.abs(e.deltaY) / 60);
    }, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      this.keys.add(e.code);
      this.onKey?.(e.code, e);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private down = (e: PointerEvent) => {
    this.el.focus?.();
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        this.pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
      }
    }
    if (this.activeId !== null) return;
    this.activeId = e.pointerId;
    this.downX = this.lastX = e.clientX;
    this.downY = this.lastY = e.clientY;
    this.moved = 0;
    this.dragging = true;
  };

  private move = (e: PointerEvent) => {
    this.pointerX = (e.clientX / innerWidth) * 2 - 1;
    this.pointerY = -(e.clientY / innerHeight) * 2 + 1;
    this.hasPointer = true;
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) {
        const [a, b] = [...this.touches.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.pinch += (this.pinchDist - d) / 120;
        this.pinchDist = d;
        this.moved += 100;
        return;
      }
    }
    if (e.pointerId !== this.activeId) return;
    const dx = e.clientX - this.lastX;
    const dy = e.clientY - this.lastY;
    this.lastX = e.clientX;
    this.lastY = e.clientY;
    this.moved += Math.abs(dx) + Math.abs(dy);
    this.lookDX += dx;
    this.lookDY += dy;
  };

  private up = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (e.pointerId !== this.activeId) return;
    this.activeId = null;
    this.dragging = false;
    if (this.moved < 6 && Math.hypot(e.clientX - this.downX, e.clientY - this.downY) < 6) {
      this.onClick?.({
        x: (e.clientX / innerWidth) * 2 - 1,
        y: -(e.clientY / innerHeight) * 2 + 1,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    }
  };

  /** Read and reset accumulated look deltas (pixels). */
  consumeLook(): [number, number] {
    const r: [number, number] = [this.lookDX, this.lookDY];
    this.lookDX = this.lookDY = 0;
    return r;
  }

  consumeZoom(): number {
    const z = this.wheel + this.pinch;
    this.wheel = this.pinch = 0;
    return z;
  }

  axis(neg: string[], pos: string[]): number {
    let v = 0;
    if (neg.some((k) => this.keys.has(k))) v -= 1;
    if (pos.some((k) => this.keys.has(k))) v += 1;
    return v;
  }
}
