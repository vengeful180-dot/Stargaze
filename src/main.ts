import '@fontsource-variable/fraunces';
import '@fontsource-variable/inter';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './styles.css';
import { App } from './app';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;

const app = new App(canvas, ui);
app.start().catch((err) => {
  console.error(err);
  ui.innerHTML = `<div class="fatal"><h1>Stargaze could not start</h1><p>${String(err?.message ?? err)}</p>
  <p>It needs a browser with WebGL 2 (recent Chrome, Edge, Firefox or Safari).</p></div>`;
});

// handy in the console and for automated screenshots
(window as unknown as { stargaze: App }).stargaze = app;
