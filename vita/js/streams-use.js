/*
 * What the rest of the platform builds on streams, part of the VitaSurf
 * prelude: Blob.stream() and textStream(), and the body of a Request
 * and a Response.
 *
 * Streams themselves (streams.js) are a unit that runs the first time a
 * page uses them (see lazy.js); these stay with the prelude, so that
 * they are where a page looks for them, and run the unit when called.
 */
(function(){
'use strict';
var W = window;
function impl(){
 if (!NV.__vitaStreamsImpl && typeof NV.__vitaRunUnit === 'function')
  NV.__vitaRunUnit('streams', 'a body stream');
 return NV.__vitaStreamsImpl;
}
function newReadable(source){ return new (impl().ReadableStream)(source); }
function newTextDecoder(){ return new (impl().TextDecoderStream)(); }

/*
 * Blob.stream(). The bytes are already in hand, so this is one chunk and
 * a close -- a real stream that a reader loop consumes correctly.
 */
if (typeof Blob === 'function') {
 Blob.prototype.stream = function(){
  var blob = this;
  return newReadable({
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
   return newReadable({ start: function(c){ c.close(); } });
  }
  return s.pipeThrough(newTextDecoder());
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
   this._stream = newReadable({
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
   this._stream = newReadable({
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
