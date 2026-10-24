import { createTutorials } from './tutorials.js';

// The sidepanel owns authoritative state. No identity is inferred from a shop
// or a DOM element, and all requests use the existing worker transport.
const controller = createTutorials({
  surface:'extension',
  getContext:() => globalThis.mosTutorialContext(),
  request:(method,body) => globalThis.mosTutorialRequest(method,body),
});
globalThis.mosTutorialController = controller;
document.getElementById('tutorial-help-btn')?.addEventListener('click', () => controller.open());
document.getElementById('tutorial-context-btn')?.addEventListener('click', () => controller.open());
controller.sync();
