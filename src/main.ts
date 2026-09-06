// The entry point. SPEC-001 gives the repository its shell: the canvas, the UI
// overlay and the toolchain around them. The renderer, the fixed-step loop and
// the "tap to start" boot gate are SPEC-002's, which replaces the note below.
import './style.css';
import { log } from '@/core/Log';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) throw new Error('index.html must carry <canvas id="game">');
const ui = document.getElementById('ui');
if (!(ui instanceof HTMLDivElement)) throw new Error('index.html must carry <div id="ui">');

log.info('boot', `ReaLLM ${__APP_VERSION__} — M0 bootstrap (SPEC-001)`);

const note = document.createElement('p');
note.className = 'boot-note';
note.textContent = `ReaLLM ${__APP_VERSION__} · M0 bootstrap`;
ui.append(note);
