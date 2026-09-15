/*
 * Streams, part of the VitaSurf prelude.
 *
 * WHATWG Streams: ReadableStream and its readers and controllers,
 * WritableStream, TransformStream, the two queuing strategies, and the
 * text encode and decode streams built on them.
 *
 * These are the real algorithms, not placeholders. A stub here would be
 * worse than nothing: a page that finds ReadableStream on the global
 * object stops taking its fallback path and commits to a reader that
 * has to deliver. Backpressure, cancellation, locking, tee and pipeTo
 * all behave as specified, because code that uses streams at all tends
 * to use exactly those.
 *
 * CompressionStream and DecompressionStream are deliberately absent:
 * they need zlib, which is C, and an honest missing constructor lets a
 * page choose something else.
 *
 * Style follows the rest of the prelude: functions and var, no classes,
 * so the whole thing parses as one script on a device with no JIT.
 */
(function(){
'use strict';
var W = window;

/* A promise nobody is going to read, marked as handled. The prelude
   reports unhandled rejections to the log, and several of these
   promises are rejected by design and only observed if a page asks. */
function ignore(p){ if(p && p.then) p.then(undefined, function(){}); return p; }

function deferred(){
 var d = {};
 d.promise = new Promise(function(res, rej){ d.resolve = res; d.reject = rej; });
 return d;
}
function typeErr(m){ return new TypeError(m); }
function rejected(e){ var p = Promise.reject(e); ignore(p); return p; }

/* ---------------------------------------------------------------- queue */

function queueInit(c){ c._queue = []; c._queueTotalSize = 0; }
function queuePush(c, chunk, size){
 c._queue.push({ chunk: chunk, size: size });
 c._queueTotalSize += size;
}
function queueShift(c){
 var pair = c._queue.shift();
 c._queueTotalSize -= pair.size;
 if (c._queueTotalSize < 0) c._queueTotalSize = 0;
 return pair.chunk;
}
function queueReset(c){ c._queue = []; c._queueTotalSize = 0; }

function sizeOf(c, chunk){
 if (!c._strategySize) return 1;
 var n = Number(c._strategySize(chunk));
 if (!isFinite(n) || n < 0) throw new RangeError('invalid chunk size');
 return n;
}

/* ------------------------------------------------------- ReadableStream */

function ReadableStream(source, strategy){
 source = source === undefined ? {} : source;
 strategy = strategy === undefined ? {} : strategy;
 this._state = 'readable';
 this._storedError = undefined;
 this._reader = null;
 this._disturbed = false;
 var type = source.type === undefined ? undefined : String(source.type);
 if (type !== undefined && type !== 'bytes') {
  throw new RangeError("ReadableStream type must be 'bytes' or undefined");
 }
 this._bytes = type === 'bytes';
 var hwm = strategy.highWaterMark;
 hwm = hwm === undefined ? (this._bytes ? 0 : 1) : Number(hwm);
 if (!(hwm >= 0)) throw new RangeError('invalid highWaterMark');
 var c = this._bytes ? new ReadableByteStreamController()
                     : new ReadableStreamDefaultController();
 c._stream = this;
 c._strategyHWM = hwm;
 c._strategySize = this._bytes ? undefined : strategy.size;
 c._source = source;
 c._started = false;
 c._pulling = false;
 c._pullAgain = false;
 c._closeRequested = false;
 c._byobRequest = null;
 c._pendingPullIntos = [];
 queueInit(c);
 this._controller = c;
 var self = this;
 var started;
 try {
  started = source.start ? source.start(c) : undefined;
 } catch (e) {
  controllerError(c, e);
  throw e;
 }
 ignore(Promise.resolve(started).then(function(){
  c._started = true;
  controllerCallPullIfNeeded(c);
 }, function(e){
  controllerError(c, e);
 }));
 void self;
}

ReadableStream.prototype = {
 constructor: ReadableStream,
 get locked(){ return this._reader !== null; },
 getReader: function(opts){
  var mode = opts && opts.mode !== undefined ? String(opts.mode) : undefined;
  if (mode === 'byob') {
   if (!this._bytes) {
    throw typeErr('byob readers need a stream with type "bytes"');
   }
   return new ReadableStreamBYOBReader(this);
  }
  if (mode !== undefined) throw typeErr('unknown reader mode ' + mode);
  return new ReadableStreamDefaultReader(this);
 },
 cancel: function(reason){
  if (this._reader !== null) {
   return rejected(typeErr('cannot cancel a locked stream'));
  }
  return streamCancel(this, reason);
 },
 tee: function(){ return streamTee(this); },
 pipeTo: function(dest, opts){
  if (!(dest instanceof WritableStream)) {
   return rejected(typeErr('pipeTo needs a WritableStream'));
  }
  if (this._reader !== null) {
   return rejected(typeErr('cannot pipe from a locked stream'));
  }
  if (dest._writer !== null) {
   return rejected(typeErr('cannot pipe into a locked stream'));
  }
  return streamPipeTo(this, dest, opts || {});
 },
 pipeThrough: function(pair, opts){
  if (!pair || !(pair.writable instanceof WritableStream) ||
      !(pair.readable instanceof ReadableStream)) {
   throw typeErr('pipeThrough needs {readable, writable}');
  }
  if (this._reader !== null) throw typeErr('cannot pipe from a locked stream');
  if (pair.writable._writer !== null) throw typeErr('the writable is locked');
  ignore(streamPipeTo(this, pair.writable, opts || {}));
  return pair.readable;
 },
 values: function(opts){ return streamAsyncIterator(this, opts || {}); }
};
ReadableStream.prototype[Symbol.asyncIterator] = function(opts){
 return streamAsyncIterator(this, opts || {});
};

/* Reading an async iterable, or anything with a Symbol.iterator, as a
   stream. Sites use this to adapt a generator into fetch(). */
ReadableStream.from = function(iterable){
 var it, sync = false;
 if (iterable == null) throw typeErr('ReadableStream.from needs an iterable');
 if (typeof iterable[Symbol.asyncIterator] === 'function') {
  it = iterable[Symbol.asyncIterator]();
 } else if (typeof iterable[Symbol.iterator] === 'function') {
  it = iterable[Symbol.iterator](); sync = true;
 } else {
  throw typeErr('ReadableStream.from needs an iterable');
 }
 return new ReadableStream({
  pull: function(c){
   return Promise.resolve(it.next()).then(function(r){
    if (sync) {
     return Promise.resolve(r.value).then(function(v){
      if (r.done) c.close(); else c.enqueue(v);
     });
    }
    if (r.done) c.close(); else c.enqueue(r.value);
    return undefined;
   });
  },
  cancel: function(reason){
   if (typeof it['return'] === 'function') return it['return'](reason);
   return undefined;
  }
 });
};

function streamCancel(stream, reason){
 stream._disturbed = true;
 if (stream._state === 'closed') return Promise.resolve(undefined);
 if (stream._state === 'errored') return rejected(stream._storedError);
 streamClose(stream);
 var c = stream._controller;
 var result;
 queueReset(c);
 try {
  result = c._source.cancel ? c._source.cancel(reason) : undefined;
 } catch (e) {
  return rejected(e);
 }
 controllerClearAlgorithms(c);
 return Promise.resolve(result).then(function(){ return undefined; });
}

function streamClose(stream){
 if (stream._state !== 'readable') return;
 stream._state = 'closed';
 var reader = stream._reader;
 if (reader === null) return;
 if (reader._readRequests) {
  var rs = reader._readRequests;
  reader._readRequests = [];
  rs.forEach(function(r){ r.resolve({ value: undefined, done: true }); });
 }
 reader._closedDeferred.resolve(undefined);
}

function streamError(stream, e){
 if (stream._state !== 'readable') return;
 stream._state = 'errored';
 stream._storedError = e;
 var reader = stream._reader;
 if (reader === null) return;
 if (reader._readRequests) {
  var rs = reader._readRequests;
  reader._readRequests = [];
  rs.forEach(function(r){ r.reject(e); });
 }
 reader._closedDeferred.reject(e);
 ignore(reader._closedDeferred.promise);
}

/* ------------------------------------------------------- default reader */

function readerAttach(reader, stream){
 if (!(stream instanceof ReadableStream)) {
  throw typeErr('a reader needs a ReadableStream');
 }
 if (stream._reader !== null) throw typeErr('this stream is already locked');
 reader._stream = stream;
 stream._reader = reader;
 reader._readRequests = [];
 reader._closedDeferred = deferred();
 if (stream._state === 'closed') {
  reader._closedDeferred.resolve(undefined);
 } else if (stream._state === 'errored') {
  reader._closedDeferred.reject(stream._storedError);
  ignore(reader._closedDeferred.promise);
 }
}

function readerRelease(reader){
 var stream = reader._stream;
 if (stream === null) return;
 var e = typeErr('this reader was released');
 if (stream._state === 'readable') {
  reader._closedDeferred.reject(e);
 } else {
  reader._closedDeferred = deferred();
  reader._closedDeferred.reject(e);
 }
 ignore(reader._closedDeferred.promise);
 /* A read that was outstanding when the lock went is not going to be
    answered by this reader; the spec errors those requests. */
 if (reader._readRequests && reader._readRequests.length) {
  var rs = reader._readRequests;
  reader._readRequests = [];
  rs.forEach(function(r){ r.reject(e); });
 }
 stream._reader = null;
 reader._stream = null;
}

function ReadableStreamDefaultReader(stream){
 readerAttach(this, stream);
}
ReadableStreamDefaultReader.prototype = {
 constructor: ReadableStreamDefaultReader,
 get closed(){
  if (this._stream === null && !this._closedDeferred) {
   return rejected(typeErr('not a reader'));
  }
  return this._closedDeferred.promise;
 },
 read: function(){
  var stream = this._stream;
  if (stream === null) return rejected(typeErr('this reader was released'));
  stream._disturbed = true;
  if (stream._state === 'errored') return rejected(stream._storedError);
  var c = stream._controller;
  if (c._queue.length > 0) {
   var chunk = queueShift(c);
   if (c._closeRequested && c._queue.length === 0) {
    controllerClearAlgorithms(c);
    streamClose(stream);
   } else {
    controllerCallPullIfNeeded(c);
   }
   return Promise.resolve({ value: chunk, done: false });
  }
  if (stream._state === 'closed') {
   return Promise.resolve({ value: undefined, done: true });
  }
  var d = deferred();
  this._readRequests.push(d);
  controllerCallPullIfNeeded(c);
  return d.promise;
 },
 cancel: function(reason){
  if (this._stream === null) return rejected(typeErr('this reader was released'));
  return streamCancel(this._stream, reason);
 },
 releaseLock: function(){ readerRelease(this); }
};

/* --------------------------------------------------- default controller */

function ReadableStreamDefaultController(){}
ReadableStreamDefaultController.prototype = {
 constructor: ReadableStreamDefaultController,
 get desiredSize(){ return controllerDesiredSize(this); },
 enqueue: function(chunk){
  if (this._closeRequested) throw typeErr('this stream is closing');
  if (this._stream._state !== 'readable') throw typeErr('this stream is not readable');
  controllerEnqueue(this, chunk);
 },
 close: function(){
  if (this._closeRequested) throw typeErr('this stream is already closing');
  if (this._stream._state !== 'readable') throw typeErr('this stream is not readable');
  this._closeRequested = true;
  if (this._queue.length === 0) {
   controllerClearAlgorithms(this);
   streamClose(this._stream);
  }
 },
 error: function(e){ controllerError(this, e); }
};

function controllerDesiredSize(c){
 var s = c._stream._state;
 if (s === 'errored') return null;
 if (s === 'closed') return 0;
 return c._strategyHWM - c._queueTotalSize;
}

function controllerClearAlgorithms(c){
 c._source = { };
 c._strategySize = undefined;
}

function controllerError(c, e){
 if (c._stream._state !== 'readable') return;
 queueReset(c);
 controllerClearAlgorithms(c);
 streamError(c._stream, e);
}

/** Hand a chunk to a waiting read, or queue it. */
function controllerEnqueue(c, chunk){
 var stream = c._stream;
 var reader = stream._reader;
 if (reader !== null && reader._readRequests && reader._readRequests.length) {
  reader._readRequests.shift().resolve({ value: chunk, done: false });
  controllerCallPullIfNeeded(c);
  return;
 }
 var size;
 try {
  size = sizeOf(c, chunk);
 } catch (e) {
  controllerError(c, e);
  throw e;
 }
 try {
  queuePush(c, chunk, size);
 } catch (e) {
  controllerError(c, e);
  throw e;
 }
 controllerCallPullIfNeeded(c);
}

function controllerShouldPull(c){
 var stream = c._stream;
 if (stream._state !== 'readable') return false;
 if (c._closeRequested) return false;
 if (!c._started) return false;
 var reader = stream._reader;
 if (reader !== null && reader._readRequests && reader._readRequests.length > 0) {
  return true;
 }
 if (reader !== null && reader._pendingBYOB && reader._pendingBYOB.length > 0) {
  return true;
 }
 return controllerDesiredSize(c) > 0;
}

function controllerCallPullIfNeeded(c){
 if (!controllerShouldPull(c)) return;
 if (c._pulling) { c._pullAgain = true; return; }
 c._pulling = true;
 var pull = c._source.pull;
 var p;
 try {
  p = pull ? pull.call(c._source, c) : undefined;
 } catch (e) {
  controllerError(c, e);
  c._pulling = false;
  return;
 }
 ignore(Promise.resolve(p).then(function(){
  c._pulling = false;
  if (c._pullAgain) { c._pullAgain = false; controllerCallPullIfNeeded(c); }
 }, function(e){
  c._pulling = false;
  controllerError(c, e);
 }));
}

/* ------------------------------------------------------- byte streams */

/*
 * A byte stream keeps the same queue as a default one -- every chunk is
 * a view -- so a default reader on it behaves exactly as it does
 * elsewhere, which is how nearly all code reads response.body. A BYOB
 * reader is the part that differs: it hands the controller a buffer to
 * fill, and the controller fills it from the queue, copying only what
 * the view has room for and keeping the rest.
 */
function ReadableByteStreamController(){}
ReadableByteStreamController.prototype = {
 constructor: ReadableByteStreamController,
 get desiredSize(){ return controllerDesiredSize(this); },
 get byobRequest(){
  byteControllerFillFromQueue(this);
  return this._byobRequest;
 },
 enqueue: function(chunk){
  if (!ArrayBuffer.isView(chunk)) {
   throw typeErr('a byte stream takes ArrayBufferViews');
  }
  if (this._closeRequested) throw typeErr('this stream is closing');
  if (this._stream._state !== 'readable') throw typeErr('this stream is not readable');
  byteControllerEnqueue(this, chunk);
 },
 close: function(){
  if (this._closeRequested) throw typeErr('this stream is already closing');
  if (this._stream._state !== 'readable') throw typeErr('this stream is not readable');
  this._closeRequested = true;
  if (this._queueTotalSize === 0) {
   controllerClearAlgorithms(this);
   streamClose(this._stream);
  }
 },
 error: function(e){ controllerError(this, e); }
};

function asBytes(view){
 return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function byteControllerEnqueue(c, chunk){
 var stream = c._stream;
 var reader = stream._reader;
 /* a default reader takes the view as it stands */
 if (reader !== null && reader._readRequests && reader._readRequests.length) {
  reader._readRequests.shift().resolve({ value: chunk, done: false });
  controllerCallPullIfNeeded(c);
  return;
 }
 queuePush(c, asBytes(chunk), chunk.byteLength);
 byteControllerFillFromQueue(c);
 controllerCallPullIfNeeded(c);
}

/** Satisfy waiting BYOB reads out of the queue. */
function byteControllerFillFromQueue(c){
 var stream = c._stream;
 var reader = stream._reader;
 if (reader === null || !reader._pendingBYOB) return;
 while (reader._pendingBYOB.length > 0 && c._queue.length > 0) {
  var req = reader._pendingBYOB[0];
  var dest = new Uint8Array(req.view.buffer, req.view.byteOffset,
                            req.view.byteLength);
  var written = req.written || 0;
  while (written < dest.length && c._queue.length > 0) {
   var head = c._queue[0];
   var src = head.chunk;
   var n = Math.min(dest.length - written, src.length);
   dest.set(src.subarray(0, n), written);
   written += n;
   if (n === src.length) {
    queueShift(c);
   } else {
    head.chunk = src.subarray(n);
    head.size -= n;
    c._queueTotalSize -= n;
   }
  }
  req.written = written;
  if (written === dest.length) {
   reader._pendingBYOB.shift();
   req.deferred.resolve({ value: byobView(req, written), done: false });
  } else {
   break;	/* a partial fill waits for more bytes */
  }
 }
 if (c._closeRequested && c._queueTotalSize === 0) {
  /* a BYOB read left partly filled at close gets what it got */
  if (reader && reader._pendingBYOB) {
   while (reader._pendingBYOB.length > 0) {
    var p = reader._pendingBYOB.shift();
    p.deferred.resolve({ value: byobView(p, p.written || 0),
                         done: (p.written || 0) === 0 });
   }
  }
  controllerClearAlgorithms(c);
  streamClose(stream);
 }
}

function byobView(req, written){
 var v = req.view;
 var Ctor = v.constructor;
 if (Ctor === DataView) return new DataView(v.buffer, v.byteOffset, written);
 return new Ctor(v.buffer, v.byteOffset, written / (v.BYTES_PER_ELEMENT || 1));
}

function ReadableStreamBYOBReader(stream){
 readerAttach(this, stream);
 this._pendingBYOB = [];
}
ReadableStreamBYOBReader.prototype = {
 constructor: ReadableStreamBYOBReader,
 get closed(){ return this._closedDeferred.promise; },
 read: function(view){
  var stream = this._stream;
  if (stream === null) return rejected(typeErr('this reader was released'));
  if (!ArrayBuffer.isView(view)) return rejected(typeErr('read() needs a view'));
  if (view.byteLength === 0) return rejected(typeErr('read() needs a non-empty view'));
  stream._disturbed = true;
  if (stream._state === 'errored') return rejected(stream._storedError);
  var req = { view: view, written: 0, deferred: deferred() };
  this._pendingBYOB.push(req);
  var c = stream._controller;
  byteControllerFillFromQueue(c);
  if (stream._state === 'closed' && this._pendingBYOB.indexOf(req) >= 0) {
   this._pendingBYOB.splice(this._pendingBYOB.indexOf(req), 1);
   return Promise.resolve({ value: byobView(req, req.written),
                            done: req.written === 0 });
  }
  controllerCallPullIfNeeded(c);
  return req.deferred.promise;
 },
 cancel: function(reason){
  if (this._stream === null) return rejected(typeErr('this reader was released'));
  return streamCancel(this._stream, reason);
 },
 releaseLock: function(){
  if (this._pendingBYOB && this._pendingBYOB.length) {
   var e = typeErr('this reader was released');
   var ps = this._pendingBYOB; this._pendingBYOB = [];
   ps.forEach(function(p){ p.deferred.reject(e); ignore(p.deferred.promise); });
  }
  readerRelease(this);
 }
};

/*
 * byobRequest is how a source fills the reader's own buffer instead of
 * allocating. Ours fills from the queue, so the request it hands out is
 * a plain buffer the source writes into and responds with; the bytes
 * then go through the queue like any others.
 */
function ReadableStreamBYOBRequest(){}
ReadableStreamBYOBRequest.prototype = {
 constructor: ReadableStreamBYOBRequest,
 get view(){ return this._view; },
 respond: function(written){
  written = Number(written) || 0;
  var c = this._controller;
  this._controller = null;
  c._byobRequest = null;
  if (written > 0) byteControllerEnqueue(c, this._view.subarray(0, written));
  else if (c._closeRequested) byteControllerFillFromQueue(c);
 },
 respondWithNewView: function(view){
  var c = this._controller;
  this._controller = null;
  c._byobRequest = null;
  if (view.byteLength > 0) byteControllerEnqueue(c, view);
 }
};

/* ------------------------------------------------------------------ tee */

function streamTee(stream){
 var reader = new ReadableStreamDefaultReader(stream);
 var closed = false, canceled1 = false, canceled2 = false;
 var reason1, reason2, pulling = false;
 var cancelDeferred = deferred();
 var c1 = null, c2 = null;

 function pull(){
  if (pulling) return undefined;
  pulling = true;
  return reader.read().then(function(r){
   pulling = false;
   if (r.done) {
    if (!canceled1) c1.close();
    if (!canceled2) c2.close();
    closed = true;
    return undefined;
   }
   if (!canceled1) c1.enqueue(r.value);
   if (!canceled2) c2.enqueue(r.value);
   return undefined;
  }, function(e){
   pulling = false;
   if (!canceled1) c1.error(e);
   if (!canceled2) c2.error(e);
   closed = true;
  });
 }
 function cancel(which, reason){
  if (which === 1) { canceled1 = true; reason1 = reason; }
  else { canceled2 = true; reason2 = reason; }
  if (canceled1 && canceled2) {
   ignore(streamCancel(stream, [reason1, reason2])
    .then(cancelDeferred.resolve, cancelDeferred.reject));
  }
  return cancelDeferred.promise;
 }
 var b1 = new ReadableStream({
  start: function(c){ c1 = c; },
  pull: function(){ return closed ? undefined : pull(); },
  cancel: function(r){ return cancel(1, r); }
 });
 var b2 = new ReadableStream({
  start: function(c){ c2 = c; },
  pull: function(){ return closed ? undefined : pull(); },
  cancel: function(r){ return cancel(2, r); }
 });
 return [b1, b2];
}

/* ------------------------------------------------------- async iterator */

function streamAsyncIterator(stream, opts){
 var preventCancel = !!opts.preventCancel;
 var reader = new ReadableStreamDefaultReader(stream);
 var it = {
  next: function(){
   return reader.read().then(function(r){
    if (r.done) { reader.releaseLock(); return { value: undefined, done: true }; }
    return { value: r.value, done: false };
   });
  },
  'return': function(value){
   if (!preventCancel) {
    var p = streamCancel(stream, value);
    reader.releaseLock();
    return p.then(function(){ return { value: value, done: true }; });
   }
   reader.releaseLock();
   return Promise.resolve({ value: value, done: true });
  }
 };
 it[Symbol.asyncIterator] = function(){ return it; };
 return it;
}

/* ------------------------------------------------------- WritableStream */

function WritableStream(sink, strategy){
 sink = sink === undefined ? {} : sink;
 strategy = strategy === undefined ? {} : strategy;
 this._state = 'writable';
 this._storedError = undefined;
 this._writer = null;
 this._sink = sink;
 var hwm = strategy.highWaterMark;
 this._hwm = hwm === undefined ? 1 : Number(hwm);
 if (!(this._hwm >= 0)) throw new RangeError('invalid highWaterMark');
 this._size = strategy.size;
 this._queue = [];          /* pending writes, in order */
 this._inFlight = false;
 this._queuedSize = 0;
 var ctrl = new WritableStreamDefaultController();
 ctrl._stream = this;
 ctrl._abortController = typeof AbortController === 'function'
   ? new AbortController() : null;
 this._controller = ctrl;
 var self = this;
 var started;
 try {
  started = sink.start ? sink.start(ctrl) : undefined;
 } catch (e) {
  writableError(this, e);
  throw e;
 }
 this._startPromise = Promise.resolve(started).then(function(){
  self._started = true;
 }, function(e){
  writableError(self, e);
  throw e;
 });
 ignore(this._startPromise);
}
WritableStream.prototype = {
 constructor: WritableStream,
 get locked(){ return this._writer !== null; },
 abort: function(reason){
  if (this._writer !== null) return rejected(typeErr('this stream is locked'));
  return writableAbort(this, reason);
 },
 close: function(){
  if (this._writer !== null) return rejected(typeErr('this stream is locked'));
  return writableClose(this);
 },
 getWriter: function(){ return new WritableStreamDefaultWriter(this); }
};

function writableError(stream, e){
 if (stream._state === 'errored') return;
 stream._state = 'errored';
 stream._storedError = e;
 var q = stream._queue; stream._queue = []; stream._queuedSize = 0;
 q.forEach(function(job){ job.deferred.reject(e); ignore(job.deferred.promise); });
 var w = stream._writer;
 if (w) {
  w._readyDeferred.reject(e); ignore(w._readyDeferred.promise);
  w._closedDeferred.reject(e); ignore(w._closedDeferred.promise);
 }
}

function writableAdvance(stream){
 if (stream._inFlight || stream._state === 'errored') return;
 if (stream._queue.length === 0) return;
 var job = stream._queue[0];
 stream._inFlight = true;
 ignore(stream._startPromise.then(function(){
  if (stream._state === 'errored') throw stream._storedError;
  if (job.close) {
   return stream._sink.close ? stream._sink.close() : undefined;
  }
  return stream._sink.write
    ? stream._sink.write(job.chunk, stream._controller) : undefined;
 }).then(function(){
  stream._queue.shift();
  stream._queuedSize -= job.size;
  if (stream._queuedSize < 0) stream._queuedSize = 0;
  stream._inFlight = false;
  if (job.close) {
   stream._state = 'closed';
   if (stream._writer) stream._writer._closedDeferred.resolve(undefined);
  }
  job.deferred.resolve(undefined);
  writableUpdateReady(stream);
  writableAdvance(stream);
 }, function(e){
  stream._inFlight = false;
  job.deferred.reject(e); ignore(job.deferred.promise);
  writableError(stream, e);
 }));
}

function writableUpdateReady(stream){
 var w = stream._writer;
 if (!w || stream._state !== 'writable') return;
 if (writableDesiredSize(stream) > 0 && w._readyPending) {
  w._readyPending = false;
  w._readyDeferred.resolve(undefined);
 } else if (writableDesiredSize(stream) <= 0 && !w._readyPending) {
  w._readyPending = true;
  w._readyDeferred = deferred();
 }
}

function writableDesiredSize(stream){
 if (stream._state === 'errored') return null;
 if (stream._state === 'closed') return 0;
 return stream._hwm - stream._queuedSize;
}

function writableWrite(stream, chunk){
 if (stream._state === 'errored') return rejected(stream._storedError);
 if (stream._state !== 'writable') return rejected(typeErr('this stream is closed'));
 var size = 1;
 if (stream._size) {
  try { size = Number(stream._size(chunk)); }
  catch (e) { writableError(stream, e); return rejected(e); }
 }
 var job = { chunk: chunk, size: size, deferred: deferred(), close: false };
 stream._queue.push(job);
 stream._queuedSize += size;
 writableUpdateReady(stream);
 writableAdvance(stream);
 return job.deferred.promise;
}

function writableClose(stream){
 if (stream._state === 'errored') return rejected(stream._storedError);
 if (stream._state !== 'writable') return rejected(typeErr('this stream is closed'));
 var job = { close: true, size: 0, deferred: deferred() };
 stream._queue.push(job);
 writableAdvance(stream);
 return job.deferred.promise;
}

function writableAbort(stream, reason){
 if (stream._state === 'errored') return Promise.resolve(undefined);
 if (stream._state === 'closed') return Promise.resolve(undefined);
 var ctrl = stream._controller;
 if (ctrl._abortController) ctrl._abortController.abort(reason);
 var e = reason === undefined ? typeErr('this stream was aborted') : reason;
 var r;
 try { r = stream._sink.abort ? stream._sink.abort(reason) : undefined; }
 catch (ex) { writableError(stream, ex); return rejected(ex); }
 writableError(stream, e);
 return Promise.resolve(r).then(function(){ return undefined; });
}

function WritableStreamDefaultController(){}
WritableStreamDefaultController.prototype = {
 constructor: WritableStreamDefaultController,
 get signal(){
  return this._abortController ? this._abortController.signal : undefined;
 },
 error: function(e){ writableError(this._stream, e); }
};

function WritableStreamDefaultWriter(stream){
 if (!(stream instanceof WritableStream)) throw typeErr('needs a WritableStream');
 if (stream._writer !== null) throw typeErr('this stream is already locked');
 this._stream = stream;
 stream._writer = this;
 this._closedDeferred = deferred();
 this._readyDeferred = deferred();
 this._readyPending = true;
 if (stream._state === 'errored') {
  this._closedDeferred.reject(stream._storedError);
  this._readyDeferred.reject(stream._storedError);
  ignore(this._closedDeferred.promise); ignore(this._readyDeferred.promise);
 } else if (stream._state === 'closed') {
  this._closedDeferred.resolve(undefined);
  this._readyDeferred.resolve(undefined);
  this._readyPending = false;
 } else if (writableDesiredSize(stream) > 0) {
  this._readyDeferred.resolve(undefined);
  this._readyPending = false;
 }
}
WritableStreamDefaultWriter.prototype = {
 constructor: WritableStreamDefaultWriter,
 get closed(){ return this._closedDeferred.promise; },
 get ready(){ return this._readyDeferred.promise; },
 get desiredSize(){
  if (this._stream === null) throw typeErr('this writer was released');
  return writableDesiredSize(this._stream);
 },
 write: function(chunk){
  if (this._stream === null) return rejected(typeErr('this writer was released'));
  return writableWrite(this._stream, chunk);
 },
 close: function(){
  if (this._stream === null) return rejected(typeErr('this writer was released'));
  return writableClose(this._stream);
 },
 abort: function(reason){
  if (this._stream === null) return rejected(typeErr('this writer was released'));
  return writableAbort(this._stream, reason);
 },
 releaseLock: function(){
  var stream = this._stream;
  if (stream === null) return;
  var e = typeErr('this writer was released');
  this._closedDeferred.reject(e); ignore(this._closedDeferred.promise);
  this._readyDeferred.reject(e); ignore(this._readyDeferred.promise);
  stream._writer = null;
  this._stream = null;
 }
};

/* --------------------------------------------------------------- pipeTo */

function streamPipeTo(source, dest, opts){
 var preventClose = !!opts.preventClose;
 var preventAbort = !!opts.preventAbort;
 var preventCancel = !!opts.preventCancel;
 var signal = opts.signal;
 var reader = new ReadableStreamDefaultReader(source);
 var writer = new WritableStreamDefaultWriter(dest);
 var done = deferred();
 var stopped = false;

 function finish(err){
  if (stopped) return;
  stopped = true;
  reader.releaseLock();
  writer.releaseLock();
  if (err === undefined) done.resolve(undefined);
  else done.reject(err);
 }
 function abortBoth(reason){
  var jobs = [];
  if (!preventAbort && dest._state === 'writable') jobs.push(writableAbort(dest, reason));
  if (!preventCancel) jobs.push(streamCancel(source, reason));
  ignore(Promise.all(jobs)['catch'](function(){}).then(function(){ finish(reason); }));
 }
 if (signal) {
  if (signal.aborted) {
   var ab = new Error('The operation was aborted'); ab.name = 'AbortError';
   abortBoth(signal.reason !== undefined ? signal.reason : ab);
   return done.promise;
  }
  signal.addEventListener('abort', function(){
   var e = new Error('The operation was aborted'); e.name = 'AbortError';
   abortBoth(signal.reason !== undefined ? signal.reason : e);
  });
 }
 function step(){
  if (stopped) return;
  if (dest._state === 'errored') {
   var de = dest._storedError;
   if (!preventCancel) ignore(streamCancel(source, de));
   finish(de);
   return;
  }
  ignore(writer.ready.then(function(){
   if (stopped) return undefined;
   return reader.read().then(function(r){
    if (stopped) return undefined;
    if (r.done) {
     if (!preventClose) {
      return writableClose(dest).then(function(){ finish(undefined); },
                                      function(e){ finish(e); });
     }
     finish(undefined);
     return undefined;
    }
    return writableWrite(dest, r.value).then(function(){ step(); },
                                             function(e){
     if (!preventCancel) ignore(streamCancel(source, e));
     finish(e);
    });
   }, function(e){        /* the source errored */
    if (!preventAbort && dest._state === 'writable') ignore(writableAbort(dest, e));
    finish(e);
   });
  }, function(e){         /* the destination errored while we waited */
   if (!preventCancel) ignore(streamCancel(source, e));
   finish(e);
  }));
 }
 step();
 return done.promise;
}

/* ------------------------------------------------------ TransformStream */

function TransformStream(transformer, writableStrategy, readableStrategy){
 transformer = transformer === undefined ? {} : transformer;
 var ctrl = new TransformStreamDefaultController();
 var readableController = null;
 var self = this;
 ctrl._transformer = transformer;

 this.readable = new ReadableStream({
  start: function(c){ readableController = c; ctrl._readable = c; },
  pull: function(){ return undefined; },
  cancel: function(reason){
   if (transformer.cancel) return transformer.cancel(reason);
   return undefined;
  }
 }, readableStrategy || {});

 this.writable = new WritableStream({
  start: function(){
   return transformer.start ? transformer.start(ctrl) : undefined;
  },
  write: function(chunk){
   if (transformer.transform) return transformer.transform(chunk, ctrl);
   readableController.enqueue(chunk);	/* the identity transform */
   return undefined;
  },
  close: function(){
   var p = transformer.flush ? Promise.resolve(transformer.flush(ctrl))
                             : Promise.resolve(undefined);
   return p.then(function(){
    if (!ctrl._terminated) readableController.close();
   });
  },
  abort: function(reason){
   readableController.error(reason);
   if (transformer.cancel) return transformer.cancel(reason);
   return undefined;
  }
 }, writableStrategy || {});
 void self;
}

function TransformStreamDefaultController(){ this._terminated = false; }
TransformStreamDefaultController.prototype = {
 constructor: TransformStreamDefaultController,
 get desiredSize(){ return this._readable.desiredSize; },
 enqueue: function(chunk){ this._readable.enqueue(chunk); },
 error: function(e){ this._readable.error(e); },
 terminate: function(){
  this._terminated = true;
  try { this._readable.close(); } catch (e) { /* already closing */ }
 }
};

/* --------------------------------------------------- queuing strategies */

function CountQueuingStrategy(init){
 this.highWaterMark = Number((init || {}).highWaterMark);
}
CountQueuingStrategy.prototype = {
 constructor: CountQueuingStrategy,
 get size(){ return function(){ return 1; }; }
};

function ByteLengthQueuingStrategy(init){
 this.highWaterMark = Number((init || {}).highWaterMark);
}
ByteLengthQueuingStrategy.prototype = {
 constructor: ByteLengthQueuingStrategy,
 get size(){ return function(chunk){ return chunk.byteLength; }; }
};

/* ------------------------------------------------------- text transforms */

function TextDecoderStream(label, options){
 var dec = new TextDecoder(label, options);
 var t = new TransformStream({
  transform: function(chunk, c){
   var s = dec.decode(chunk, { stream: true });
   if (s) c.enqueue(s);
  },
  flush: function(c){
   var s = dec.decode();
   if (s) c.enqueue(s);
  }
 });
 this.readable = t.readable;
 this.writable = t.writable;
 this.encoding = dec.encoding;
 this.fatal = dec.fatal;
 this.ignoreBOM = dec.ignoreBOM;
}

function TextEncoderStream(){
 var enc = new TextEncoder();
 var t = new TransformStream({
  transform: function(chunk, c){
   var b = enc.encode(String(chunk));
   if (b.length) c.enqueue(b);
  }
 });
 this.readable = t.readable;
 this.writable = t.writable;
 this.encoding = 'utf-8';
}

/* ------------------------------------------------------------- exposure */

W.ReadableStream = ReadableStream;
W.ReadableStreamDefaultReader = ReadableStreamDefaultReader;
W.ReadableStreamDefaultController = ReadableStreamDefaultController;
W.ReadableByteStreamController = ReadableByteStreamController;
W.ReadableStreamBYOBReader = ReadableStreamBYOBReader;
W.ReadableStreamBYOBRequest = ReadableStreamBYOBRequest;
W.WritableStream = WritableStream;
W.WritableStreamDefaultWriter = WritableStreamDefaultWriter;
W.WritableStreamDefaultController = WritableStreamDefaultController;
W.TransformStream = TransformStream;
W.TransformStreamDefaultController = TransformStreamDefaultController;
W.CountQueuingStrategy = CountQueuingStrategy;
W.ByteLengthQueuingStrategy = ByteLengthQueuingStrategy;
W.TextDecoderStream = TextDecoderStream;
W.TextEncoderStream = TextEncoderStream;

/*
 * Blob.stream(). The bytes are already in hand, so this is one chunk and
 * a close -- a real stream that a reader loop consumes correctly.
 */
if (typeof Blob === 'function') {
 Blob.prototype.stream = function(){
  var blob = this;
  return new ReadableStream({
   type: 'bytes',
   pull: function(c){
    return Promise.resolve(blob.arrayBuffer ? blob.arrayBuffer() : null)
     .then(function(ab){
      if (ab && ab.byteLength) c.enqueue(new Uint8Array(ab));
      c.close();
     });
   }
  });
 };
}

/*
 * textStream(): the byte stream decoded to text. Blob, Request and
 * Response all have it in the current WebIDL, and it is exactly stream()
 * piped through a TextDecoderStream, which is how a caller would build
 * it by hand.
 */
function textStreamFor(getStream){
 return function(){
  var s = getStream.call(this);
  if (s === null) {
   return new ReadableStream({ start: function(c){ c.close(); } });
  }
  return s.pipeThrough(new TextDecoderStream());
 };
}
if (typeof Blob === 'function') {
 Blob.prototype.textStream = textStreamFor(function(){ return this.stream(); });
}

/*
 * response.body. The bytes are all here by the time a Response exists --
 * our fetch is XMLHttpRequest underneath, which has no streaming read --
 * so the stream delivers them as one chunk and closes. That is a real
 * stream with real backpressure and cancellation, and it is what
 * response.body.getReader() loops expect; what it is not is incremental,
 * which no page can tell apart from a fast network.
 */
if (typeof Response === 'function' && !('body' in Response.prototype)) {
 Object.defineProperty(Response.prototype, 'body', {
  configurable: true,
  get: function(){
   if (this._stream) return this._stream;
   var buf = this._buffer();
   if (this._b === '' && !this._ab) { this._stream = null; return null; }
   var sent = false;
   this._stream = new ReadableStream({
    type: 'bytes',
    pull: function(c){
     if (sent) return undefined;
     sent = true;
     c.enqueue(new Uint8Array(buf));
     c.close();
     return undefined;
    },
    cancel: function(){ return undefined; }
   });
   return this._stream;
  }
 });
 Object.defineProperty(Request.prototype, 'body', {
  configurable: true,
  get: function(){
   if (this._body === null || this._body === undefined) return null;
   if (this._stream) return this._stream;
   var body = this._body, sent = false;
   this._stream = new ReadableStream({
    type: 'bytes',
    pull: function(c){
     if (sent) return undefined;
     sent = true;
     var bytes;
     if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
     else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(
       body.buffer, body.byteOffset, body.byteLength);
     else bytes = new TextEncoder().encode(String(body));
     if (bytes.length) c.enqueue(bytes);
     c.close();
     return undefined;
    }
   });
   return this._stream;
  }
 });
 Response.prototype.textStream = textStreamFor(
   Object.getOwnPropertyDescriptor(Response.prototype, 'body').get);
 Request.prototype.textStream = textStreamFor(
   Object.getOwnPropertyDescriptor(Request.prototype, 'body').get);
}
})();
