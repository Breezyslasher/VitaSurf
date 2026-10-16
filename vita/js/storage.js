/*
 * Storage, part of the VitaSurf prelude.
 *
 * The structured clone algorithm, localStorage and sessionStorage, and
 * IndexedDB (idb.js, a unit run on first use), all on one store per
 * origin that survives the run.
 *
 * What was here before: localStorage was a plain object that went away
 * with the page and was shared by every site, and IndexedDB was missing
 * altogether. claude.ai read its persisted state back as a rejection on
 * every load and reported no storage available for its session.
 *
 * Everything an origin holds is read once and written back as a whole,
 * deferred so that a burst of puts is one write. That is the wrong shape
 * for a database and the right one for a memory card, where the cost is
 * per file rather than per byte.
 */
(function(){
'use strict';
var W = window;
var load = NV.__vitaStoreLoad, save = NV.__vitaStoreSave;
/* the events this file fires are the browser's, so trusted (VitaSurf) */
var uaEvent = NV.__vitaUaEvent || function(e){ return e; };
try { delete NV.__vitaUaEvent; } catch (e) {}

/* ------------------------------------------------------- the backing store */

var DIRTY_DELAY = 400;		/* ms of quiet before writing */
var store = null;		/* {local: {...}, idb: {...}} */
var dirty = false, timer = null;

function readStore(){
 if (store !== null) return store;
 store = { local: {}, idb: {} };
 try {
  /* the bindings parse it (vita/js/qjs.c), so the log can time it */
  var got = load ? load() : null;
  if (typeof got === 'string') got = JSON.parse(got);
  if (got) {
   if (got && typeof got === 'object') {
    if (got.local && typeof got.local === 'object') store.local = got.local;
    if (got.idb && typeof got.idb === 'object') store.idb = got.idb;
   }
  }
 } catch (e) { /* unreadable is the same as empty */ }
 return store;
}

function flush(){
 timer = null;
 if (!dirty || !save) return;
 dirty = false;
 try { save(JSON.stringify(store)); } catch (e) { /* full, or no card */ }
}
function touch(){
 dirty = true;
 if (timer !== null) return;
 timer = setTimeout(flush, DIRTY_DELAY);
}
/* a page being left must not lose the last few hundred milliseconds */
W.addEventListener('pagehide', flush);
W.addEventListener('beforeunload', flush);
W.addEventListener('unload', flush);

/*
 * objectStoreNames and indexNames are DOMStringLists: an array to read,
 * with contains() and item() besides. They were plain arrays, and the
 * check every IndexedDB user makes before creating a store --
 * db.objectStoreNames.contains(name) -- threw "not a function" out of
 * the page's onsuccess on claude.ai.
 */
function stringList(names){
 Object.defineProperty(names, 'contains', { configurable: true, writable: true,
  value: function(n){ return this.indexOf(String(n)) >= 0; } });
 Object.defineProperty(names, 'item', { configurable: true, writable: true,
  value: function(i){ i = i >>> 0; return i < this.length ? this[i] : null; } });
 return names;
}
/* ------------------------------------------------- the structured clone */

/*
 * CryptoKeys clone and store as keys (VitaSurf): a page keeps a
 * non-extractable key in IndexedDB so that it cannot be read out, and
 * cloning one as an ordinary object lost it. The hooks come from
 * subtle.js through a registration the prelude takes away again before
 * any page script runs, because they read a key's material.
 */
var keyHooks = null;
Object.defineProperty(NV,'__vitaRegisterKeyClone', { configurable: true,
 value: function(h){ keyHooks = h; delete NV.__vitaRegisterKeyClone; } });

/*
 * IndexedDB stores values, not JSON: a Date comes back a Date, a
 * Uint8Array comes back a Uint8Array, and a value that refers to itself
 * is stored and read back still referring to itself. JSON alone loses
 * all three, so types it cannot carry are tagged and rebuilt.
 */
/*
 * What a value is, by its brand rather than by instanceof: a message from
 * a frame carries that frame's Dates and Maps, which are not instances of
 * this window's (VitaSurf).
 */
function brand(v){
 return Object.prototype.toString.call(v).slice(8, -1);
}

function encode(value){
 var seen = [], out = [];
 function walk(v){
  if (v === undefined) return { $: 'undef' };
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
   if (v !== v) return { $: 'nan' };
   if (v === Infinity) return { $: 'inf' };
   if (v === -Infinity) return { $: '-inf' };
   return v;
  }
  if (typeof v === 'bigint') return { $: 'bigint', v: v.toString() };
  if (typeof v === 'function' || typeof v === 'symbol') {
   throw new DOMException('cannot be cloned', 'DataCloneError');
  }
  var at = seen.indexOf(v);
  if (at >= 0) return { $: 'ref', i: at };
  seen.push(v); out.push(null);
  var slot = out.length - 1, enc;
  if (keyHooks && keyHooks.is(v)) {
   enc = { $: 'key', v: walk(keyHooks.pack(v)) };
  } else if (brand(v) === 'Date') {
   enc = { $: 'date', v: v.getTime() };
  } else if (brand(v) === 'RegExp') {
   enc = { $: 'regexp', s: v.source, f: v.flags };
  } else if (brand(v) === 'Blob' || brand(v) === 'File') {
   /* a Blob's bytes are not reachable synchronously here, so it is
      stored as its text, which is what a page that stores one wants */
   enc = { $: 'blob', t: v.type || '', v: v._t === undefined ? '' : String(v._t) };
  } else if (brand(v) === 'ArrayBuffer') {
   enc = { $: 'ab', v: bytesToString(new Uint8Array(v)) };
  } else if (ArrayBuffer.isView(v)) {
   enc = { $: 'view', n: v.constructor.name,
           v: bytesToString(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  } else if (brand(v) === 'Map') {
   var pairs = [];
   v.forEach(function(val, key){ pairs.push([walk(key), walk(val)]); });
   enc = { $: 'map', v: pairs };
  } else if (brand(v) === 'Set') {
   var items = [];
   v.forEach(function(item){ items.push(walk(item)); });
   enc = { $: 'set', v: items };
  } else if (Array.isArray(v)) {
   enc = { $: 'arr', v: v.map(walk) };
  } else {
   var o = {};
   Object.keys(v).forEach(function(k){ o[k] = walk(v[k]); });
   enc = { $: 'obj', v: o };
  }
  out[slot] = enc;
  return { $: 'ref', i: slot };
 }
 var root = walk(value);
 return { r: root, t: out };
}

function decode(packed){
 if (!packed || typeof packed !== 'object') return packed;
 var table = packed.t || [], built = [];
 function rebuild(i){
  if (built[i] !== undefined) return built[i];
  var e = table[i], v;
  switch (e && e.$) {
   case 'date': v = new Date(e.v); built[i] = v; return v;
   case 'key':
    v = keyHooks ? keyHooks.unpack(take(e.v)) : null; built[i] = v; return v;
   case 'regexp': v = new RegExp(e.s, e.f); built[i] = v; return v;
   case 'blob':
    v = typeof Blob === 'function' ? new Blob([e.v], { type: e.t }) : e.v;
    built[i] = v; return v;
   case 'ab': v = stringToBytes(e.v).buffer; built[i] = v; return v;
   case 'view': {
    var bytes = stringToBytes(e.v);
    var Ctor = W[e.n] || Uint8Array;
    v = e.n === 'DataView' ? new DataView(bytes.buffer)
                           : new Ctor(bytes.buffer);
    built[i] = v; return v;
   }
   case 'map':
    v = new Map(); built[i] = v;
    e.v.forEach(function(p){ v.set(take(p[0]), take(p[1])); });
    return v;
   case 'set':
    v = new Set(); built[i] = v;
    e.v.forEach(function(item){ v.add(take(item)); });
    return v;
   case 'arr':
    v = []; built[i] = v;
    e.v.forEach(function(item, n){ v[n] = take(item); });
    return v;
   case 'obj':
    v = {}; built[i] = v;
    Object.keys(e.v).forEach(function(k){ v[k] = take(e.v[k]); });
    return v;
   default: built[i] = e; return e;
  }
 }
 function take(x){
  if (x === null || typeof x !== 'object') return x;
  if (x.$ === 'ref') return rebuild(x.i);
  if (x.$ === 'undef') return undefined;
  if (x.$ === 'nan') return NaN;
  if (x.$ === 'inf') return Infinity;
  if (x.$ === '-inf') return -Infinity;
  if (x.$ === 'bigint') return typeof BigInt === 'function' ? BigInt(x.v) : x.v;
  return x;
 }
 return take(packed.r);
}

/* bytes as a string of code units 0-255, which JSON carries safely */
function bytesToString(u8){
 var s = '', i, n = u8.length;
 for (i = 0; i < n; i += 4096) {
  s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 4096, n)));
 }
 return s;
}
function stringToBytes(s){
 var u8 = new Uint8Array(s.length), i;
 for (i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
 return u8;
}

/*
 * structuredClone, and the copy postMessage makes, as the HTML standard's
 * serialisation has them (VitaSurf): straight from value to copy rather
 * than through the stored form above, which is JSON's shape and lost an
 * Error's type, a boxed primitive, an array's length and its other
 * properties, and a Blob's, a File's or an ImageData's kind; and which
 * copied what a browser refuses to: a node, an event, a promise, a URL.
 */
var CLONE_ERRORS = { Error: 1, EvalError: 1, RangeError: 1, ReferenceError: 1,
 SyntaxError: 1, TypeError: 1, URIError: 1 };
/* what an object the prelude implements is, for the clone: one of the
   serialisable kinds it rebuilds, or one a browser refuses to copy */
var CLONE_REFUSED = ['Node', 'Event', 'EventTarget', 'URL', 'URLSearchParams',
 'MessagePort', 'Location', 'History', 'Navigator', 'Storage', 'CSSStyleDeclaration',
 'Request', 'Response', 'Headers', 'AbortSignal', 'AbortController', 'FormData',
 'CSSStyleSheet', 'MediaQueryList', 'Worker', 'WebSocket', 'XMLHttpRequest'];
function platformBrand(v, b){
 var i, p;
 /* a plain object or one with no prototype is no platform object, and
    is nearly every object a clone copies: each had been tested against
    every interface below, a tenth of youtube.com's profile (VitaSurf) */
 if (b === 'Object') {
  try { p = Object.getPrototypeOf(v); } catch (e) { p = undefined; }
  if (p === Object.prototype || p === null) return b;
 }
 if (typeof W.DOMException === 'function' && v instanceof W.DOMException)
  return 'DOMException';
 if (typeof W.ImageData === 'function' && v instanceof W.ImageData)
  return 'ImageData';
 if (v === W || v === W.location || v === W.navigator) return 'Window';
 for (i = 0; i < CLONE_REFUSED.length; i++) {
  var C = W[CLONE_REFUSED[i]];
  if (typeof C === 'function' && C.prototype && v instanceof C)
   return CLONE_REFUSED[i];
 }
 /* a node from another frame's realm */
 if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string' &&
     typeof v.appendChild === 'function') return 'Node';
 return b;
}
function cloneFail(what){
 throw new DOMException(what + ' could not be cloned.', 'DataCloneError');
}
function clone(value){
 var seen = new Map();
 function walk(v){
  var t = typeof v;
  if (v === null || t === 'undefined' || t === 'boolean' || t === 'number' ||
      t === 'string' || t === 'bigint') return v;
  if (t === 'function') cloneFail(String(v).slice(0, 40));
  if (t === 'symbol') cloneFail(String(v));
  if (seen.has(v)) return seen.get(v);
  var b = brand(v), c, k, i;
  /* this browser's own platform objects mostly have no brand of their
     own, so ask what they are */
  if (b === 'Object' || b === 'Error') b = platformBrand(v, b);
  if (keyHooks && keyHooks.is(v)) {
   c = keyHooks.unpack(keyHooks.pack(v)); seen.set(v, c); return c;
  }
  switch (b) {
  case 'Boolean': c = Object(Boolean.prototype.valueOf.call(v)); break;
  case 'Number': c = Object(Number.prototype.valueOf.call(v)); break;
  case 'String': c = Object(String.prototype.valueOf.call(v)); break;
  case 'BigInt': c = Object(BigInt.prototype.valueOf.call(v)); break;
  case 'Date': c = new Date(Date.prototype.getTime.call(v)); break;
  case 'RegExp': c = new RegExp(v.source, v.flags); break;
  case 'ArrayBuffer': c = v.slice(0); break;
  case 'Map':
   c = new Map(); seen.set(v, c);
   Map.prototype.forEach.call(v, function(val, key){ c.set(walk(key), walk(val)); });
   return c;
  case 'Set':
   c = new Set(); seen.set(v, c);
   Set.prototype.forEach.call(v, function(item){ c.add(walk(item)); });
   return c;
  case 'Blob':
   c = new W.Blob([v], { type: v.type }); break;
  case 'File':
   c = new W.File([v], v.name, { type: v.type, lastModified: v.lastModified }); break;
  case 'ImageData':
   c = new W.ImageData(new Uint8ClampedArray(v.data), v.width, v.height); break;
  case 'DOMException':
   c = new W.DOMException(v.message, v.name); break;
  case 'Error':
   /* the standard's own error types keep theirs; any other is an Error */
   k = CLONE_ERRORS[v.name] ? v.name : 'Error';
   c = new W[k](v.message === undefined ? undefined : String(v.message));
   if (typeof v.stack === 'string') {
    try { Object.defineProperty(c, 'stack', { value: v.stack, writable: true,
     configurable: true }); } catch (e) {}
   }
   seen.set(v, c);
   if (v.cause !== undefined && Object.prototype.hasOwnProperty.call(v, 'cause'))
    c.cause = walk(v.cause);
   return c;
  case 'Window': case 'Node': case 'Event': case 'EventTarget': case 'URL':
  case 'URLSearchParams': case 'MessagePort': case 'Location': case 'History':
  case 'Navigator': case 'Storage': case 'CSSStyleDeclaration': case 'Request':
  case 'Response': case 'Headers': case 'AbortSignal': case 'AbortController':
  case 'FormData': case 'CSSStyleSheet': case 'MediaQueryList': case 'Worker':
  case 'WebSocket': case 'XMLHttpRequest':
   cloneFail(b);
  default:
   if (ArrayBuffer.isView(v)) {
    var buf = seen.has(v.buffer) ? seen.get(v.buffer) : v.buffer.slice(0);
    seen.set(v.buffer, buf);
    c = b === 'DataView' ? new DataView(buf, v.byteOffset, v.byteLength)
                         : new (W[b] || v.constructor)(buf, v.byteOffset, v.length);
    break;
   }
   if (Array.isArray(v)) {
    c = new Array(v.length); seen.set(v, c);
    for (k in v) {
     if (Object.prototype.hasOwnProperty.call(v, k)) c[k] = walk(v[k]);
    }
    return c;
   }
   /* an ordinary object, whatever its class; a platform object or one
      of the language's own that carries no data is refused */
   if (b !== 'Object' && b !== 'Arguments') cloneFail(b);
   c = {}; seen.set(v, c);
   var keys = Object.keys(v);
   for (i = 0; i < keys.length; i++) c[keys[i]] = walk(v[keys[i]]);
   return c;
  }
  seen.set(v, c);
  return c;
 }
 return walk(value);
}

W.structuredClone = function(value){
 if (arguments.length < 1)
  throw new TypeError("Failed to execute 'structuredClone' on 'Window': 1 argument required, but only 0 present.");
 return clone(value);
};

/* ------------------------------------------------------------- Storage */

/*
 * A Storage is what WebIDL makes of an interface with named properties:
 * localStorage.theme reads the item, localStorage.theme = 'dark' sets
 * it, delete removes it and Object.keys lists the keys. The object a page
 * holds is a proxy over the instance that does that (VitaSurf). The
 * items were not properties at all, so a page that stores with an
 * assignment, as many do, kept its value on the object until it was
 * gone, and the store and the flag that says whether it is saved were
 * the instance's own properties _d and _p, where a page could see them.
 */
var STORAGE = new WeakMap();	/* the instance or its proxy: { d, p } */
function backingOf(s, what){
 var b = STORAGE.get(s);
 if (!b) throw new TypeError("Failed to execute '" + what +
                             "' on 'Storage': Illegal invocation");
 return b;
}
function Storage(){ throw new TypeError('Illegal constructor'); }
function makeStorage(backing, persist){
 var self = Object.create(Storage.prototype), b = { d: backing, p: !!persist },
  has = Object.prototype.hasOwnProperty, px;
 STORAGE.set(self, b);
 function item(k){ return typeof k === 'string' && has.call(b.d, k); }
 px = new Proxy(self, {
  get: function(t, k){
   if (item(k) && !(k in t)) return b.d[k];
   return Reflect.get(t, k, px);
  },
  set: function(t, k, v){
   if (typeof k !== 'string') return Reflect.set(t, k, v, t);
   Storage.prototype.setItem.call(px, k, v);
   return true;
  },
  has: function(t, k){ return item(k) || k in t; },
  deleteProperty: function(t, k){
   if (item(k)) Storage.prototype.removeItem.call(px, k);
   else if (typeof k !== 'string') return Reflect.deleteProperty(t, k);
   return true;
  },
  ownKeys: function(t){ return Object.keys(b.d).concat(Reflect.ownKeys(t)); },
  getOwnPropertyDescriptor: function(t, k){
   if (item(k) && !(k in t))
    return { value: b.d[k], writable: true, enumerable: true,
             configurable: true };
   return Reflect.getOwnPropertyDescriptor(t, k);
  },
  defineProperty: function(t, k, d){
   if (typeof k !== 'string') return Reflect.defineProperty(t, k, d);
   Storage.prototype.setItem.call(px, k, d.value);
   return true;
  }
 });
 STORAGE.set(px, b);
 return px;
}
function method(name, length, f){
 Object.defineProperty(f, 'name', { value: name });
 Object.defineProperty(f, 'length', { value: length });
 Object.defineProperty(Storage.prototype, name, { value: f, writable: true,
  enumerable: true, configurable: true });
}
method('getItem', 1, function(k){
 var b = backingOf(this, 'getItem');
 k = String(k);
 return Object.prototype.hasOwnProperty.call(b.d, k) ? b.d[k] : null;
});
method('setItem', 2, function(k, v){
 var b = backingOf(this, 'setItem'), key = String(k),
  old = this.getItem(key), val = String(v);
 b.d[key] = val;
 if (b.p) touch();
 fireStorage(key, old, val);
});
method('removeItem', 1, function(k){
 var b = backingOf(this, 'removeItem'), key = String(k),
  old = this.getItem(key);
 delete b.d[key];
 if (b.p) touch();
 if (old !== null) fireStorage(key, old, null);
});
method('clear', 0, function(){
 var b = backingOf(this, 'clear');
 Object.keys(b.d).forEach(function(k){ delete b.d[k]; });
 if (b.p) touch();
 fireStorage(null, null, null);
});
method('key', 1, function(i){
 var keys = Object.keys(backingOf(this, 'key').d);
 i = Number(i) || 0;
 return i >= 0 && i < keys.length ? keys[i] : null;
});
Object.defineProperty(Storage.prototype, 'length', {
 configurable: true, enumerable: true,
 get: function length(){ return Object.keys(backingOf(this, 'length').d).length; }
});
Object.defineProperty(Storage.prototype, 'constructor', { value: Storage,
 writable: true, configurable: true });

/* The storage event. A real browser sends it to other tabs; there is one
   page here, so it goes to this one, which is what a page listening for
   it to keep two views in step is doing. */
function fireStorage(key, oldValue, newValue){
 if (typeof StorageEvent !== 'function' && typeof Event !== 'function') return;
 try {
  var e = uaEvent(new Event('storage'));
  e.key = key; e.oldValue = oldValue; e.newValue = newValue;
  e.url = W.location ? String(W.location.href) : '';
  e.storageArea = W.localStorage;
  W.dispatchEvent(e);
 } catch (err) { /* nothing listening is not a failure */ }
}

W.Storage = Storage;
/* The store is kept here, not on the window: it was window._ls, and Home
   Assistant's page defines a global function _ls to load its scripts, so
   localStorage came back as that function and the app stopped at
   "not a function" (VitaSurf). */
var localStore = null;
Object.defineProperty(W, 'localStorage', {
 configurable: true,
 get: function(){
  if (!localStore) localStore = makeStorage(readStore().local, true);
  return localStore;
 }
});
W.sessionStorage = makeStorage({}, false);	/* by design, not persisted */

/* IndexedDB is a unit of its own (idb.js), run the first time a page
   uses it; these are what it shares with the rest of this file */
NV.__vitaIdbNeeds = { readStore: readStore, touch: touch, encode: encode,
 decode: decode, stringList: stringList, uaEvent: uaEvent,
 EventTarget: W.EventTarget };
})();
