// Placeholder app shell; replaced by the full game loop as the space and cabin modules land.
export class App {
  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly ui: HTMLDivElement,
  ) {}

  async start(): Promise<void> {
    this.ui.innerHTML = '<div class="fatal"><h1>Stargaze</h1><p>Under construction.</p></div>';
  }
}
