// The radio's other bands: a "tape" deck playing the player's own files, and a "link" for internet radio
// streams / audio URLs. Both go through the radio's speaker when the browser allows Web Audio access to
// the media (blob URLs always do; remote URLs need CORS). Without CORS a stream plays directly (no radio FX).

const AUDIO_EXT = /\.(mp3|ogg|oga|opus|wav|m4a|aac|flac|webm|weba|mp4)$/i;

function waitMedia(el: HTMLMediaElement, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      el.removeEventListener('canplay', onOk);
      el.removeEventListener('error', onErr);
      clearTimeout(timer);
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    el.addEventListener('canplay', onOk);
    el.addEventListener('error', onErr);
  });
}

export interface MediaInfo {
  title: string | null;
  elapsed: number;
  duration: number | null;
  status: string;
  index: number;
  count: number;
}

export class TapeDeck {
  private files: { name: string; url: string }[] = [];
  private index = 0;
  private el: HTMLAudioElement | null = null;
  private src: MediaElementAudioSourceNode | null = null;
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private want = false;
  status = 'empty';

  attach(ctx: BaseAudioContext, out: AudioNode) {
    if (!('createMediaElementSource' in ctx)) return;
    this.ctx = ctx as AudioContext;
    this.out = out;
  }

  get count() {
    return this.files.length;
  }

  load(files: File[]) {
    for (const f of this.files) URL.revokeObjectURL(f.url);
    this.files = files
      .filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name))
      .map((f) => ({ name: f.name.replace(/\.[^.]+$/, ''), url: URL.createObjectURL(f) }));
    this.index = 0;
    this.status = this.files.length ? 'loaded' : 'empty';
    if (this.want && this.files.length) this.play();
  }

  private ensureEl(): HTMLAudioElement | null {
    if (this.el) return this.el;
    if (typeof Audio === 'undefined' || !this.ctx || !this.out) return null;
    const el = new Audio();
    el.preload = 'auto';
    el.addEventListener('ended', () => this.next());
    el.addEventListener('error', () => {
      this.status = 'error';
      // skip unplayable files
      if (this.files.length > 1) setTimeout(() => this.next(), 300);
    });
    try {
      this.src = this.ctx.createMediaElementSource(el);
      this.src.connect(this.out);
    } catch {
      this.src = null;
    }
    this.el = el;
    return el;
  }

  play() {
    this.want = true;
    if (!this.files.length) {
      this.status = 'empty';
      return;
    }
    const el = this.ensureEl();
    if (!el) return;
    const f = this.files[this.index % this.files.length];
    if (el.src !== f.url) el.src = f.url;
    this.status = 'loading';
    el.play()
      .then(() => (this.status = 'playing'))
      .catch(() => (this.status = 'error'));
  }

  pause() {
    this.want = false;
    this.el?.pause();
    if (this.files.length) this.status = 'paused';
  }

  next() {
    if (!this.files.length) return;
    this.index = (this.index + 1) % this.files.length;
    if (this.want) this.play();
  }

  info(): MediaInfo {
    const f = this.files.length ? this.files[this.index % this.files.length] : null;
    const el = this.el;
    return {
      title: f?.name ?? null,
      elapsed: el ? el.currentTime || 0 : 0,
      duration: el && Number.isFinite(el.duration) ? el.duration : null,
      status: this.status,
      index: this.index,
      count: this.files.length,
    };
  }
}

export type LinkResult = 'ok' | 'no-cors' | 'error';

export class LinkPlayer {
  private el: HTMLAudioElement | null = null;
  private src: MediaElementAudioSourceNode | null = null;
  private ctx: AudioContext | null = null;
  private out: AudioNode | null = null;
  private token = 0;
  url: string | null = null;
  mode: 'webaudio' | 'direct' | null = null;
  status = 'idle';
  private directVolume = 0.5;

  attach(ctx: BaseAudioContext, out: AudioNode) {
    if (!('createMediaElementSource' in ctx)) return;
    this.ctx = ctx as AudioContext;
    this.out = out;
  }

  async play(url: string): Promise<LinkResult> {
    this.stop();
    const token = ++this.token;
    this.url = url;
    if (!this.ctx || !this.out || typeof Audio === 'undefined') {
      this.status = 'error';
      return 'error';
    }
    this.status = 'loading';
    // 1) CORS-enabled element routed through the radio
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.src = url;
    const ok = await waitMedia(el, 12000);
    if (token !== this.token) return 'error';
    if (ok) {
      try {
        const src = this.ctx.createMediaElementSource(el);
        src.connect(this.out);
        this.el = el;
        this.src = src;
        await el.play();
        this.mode = 'webaudio';
        this.status = 'playing';
        return 'ok';
      } catch {
        /* fall through to direct playback */
      }
    }
    el.removeAttribute('src');
    el.load();
    // 2) without CORS: play the element directly (the browser will not let Web Audio read it)
    const el2 = new Audio();
    el2.preload = 'auto';
    el2.src = url;
    const ok2 = await waitMedia(el2, 12000);
    if (token !== this.token) return 'error';
    if (!ok2) {
      this.status = 'error';
      return 'error';
    }
    try {
      el2.volume = this.directVolume;
      await el2.play();
      this.el = el2;
      this.mode = 'direct';
      this.status = 'no-cors';
      return 'no-cors';
    } catch {
      this.status = 'error';
      return 'error';
    }
  }

  /** Volume for direct (no-CORS) playback, which bypasses the audio graph. */
  setDirectVolume(v: number) {
    this.directVolume = Math.max(0, Math.min(1, v));
    if (this.el && this.mode === 'direct') this.el.volume = this.directVolume;
  }

  pause() {
    this.el?.pause();
  }

  resume() {
    if (this.el) this.el.play().catch(() => undefined);
  }

  stop() {
    this.token++;
    if (this.el) {
      this.el.pause();
      this.el.removeAttribute('src');
      this.el.load();
    }
    try {
      this.src?.disconnect();
    } catch {
      /* ignore */
    }
    this.el = null;
    this.src = null;
    this.mode = null;
    this.status = 'idle';
  }

  info(): MediaInfo {
    const el = this.el;
    return {
      title: this.url,
      elapsed: el ? el.currentTime || 0 : 0,
      duration: el && Number.isFinite(el.duration) ? el.duration : null,
      status: this.status,
      index: 0,
      count: this.url ? 1 : 0,
    };
  }
}
