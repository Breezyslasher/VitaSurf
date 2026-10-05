/* A module worker for tests/dom/worker.html: it imports what it uses. */
import { twice } from './module-lib.js';
onmessage = (e) => postMessage(twice(e.data));
