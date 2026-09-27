/* A worker for tests/dom/worker.html: it describes where it runs and
   answers each message. */
importScripts('lib.js', 'data:text/javascript,self.fromData%20%3D%207%3B');
var tick = 0;
onmessage = function (e) {
 if (e.data === 'tick') { setInterval(function () { postMessage('tick ' + (++tick)); }, 20); return; }
 if (e.data === 'close') { close(); postMessage('after close'); return; }
 postMessage({
  n: e.data.n + 1,
  isDate: e.data.d instanceof Date,
  time: e.data.d.getTime(),
  noDocument: typeof document === 'undefined' && typeof window === 'undefined',
  scope: self instanceof WorkerGlobalScope && self instanceof DedicatedWorkerGlobalScope,
  tag: Object.prototype.toString.call(self),
  href: location.href,
  name: self.name,
  lib: typeof double === 'function' ? double(21) : null,
  fromData: self.fromData,
  hasFetch: typeof fetch === 'function' && typeof setTimeout === 'function'
 });
};
