/*
 * Storage, part of the VitaSurf prelude.
 *
 * The structured clone algorithm, localStorage and sessionStorage, and
 * IndexedDB, all on one store per origin that survives the run.
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
var load = W.__vitaStoreLoad, save = W.__vitaStoreSave;

/* ------------------------------------------------------- the backing store */

var DIRTY_DELAY = 400;		/* ms of quiet before writing */
var store = null;		/* {local: {...}, idb: {...}} */
var dirty = false, timer = null;

function readStore(){
 if (store !== null) return store;
 store = { local: {}, idb: {} };
 try {
  var text = load ? load() : null;
  if (text) {
   var got = JSON.parse(text);
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

/* ------------------------------------------------- the structured clone */

/*
 * IndexedDB stores values, not JSON: a Date comes back a Date, a
 * Uint8Array comes back a Uint8Array, and a value that refers to itself
 * is stored and read back still referring to itself. JSON alone loses
 * all three, so types it cannot carry are tagged and rebuilt.
 */
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
  if (v instanceof Date) {
   enc = { $: 'date', v: v.getTime() };
  } else if (v instanceof RegExp) {
   enc = { $: 'regexp', s: v.source, f: v.flags };
  } else if (typeof Blob === 'function' && v instanceof Blob) {
   /* a Blob's bytes are not reachable synchronously here, so it is
      stored as its text, which is what a page that stores one wants */
   enc = { $: 'blob', t: v.type || '', v: v._t === undefined ? '' : String(v._t) };
  } else if (v instanceof ArrayBuffer) {
   enc = { $: 'ab', v: bytesToString(new Uint8Array(v)) };
  } else if (ArrayBuffer.isView(v)) {
   enc = { $: 'view', n: v.constructor.name,
           v: bytesToString(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  } else if (v instanceof Map) {
   var pairs = [];
   v.forEach(function(val, key){ pairs.push([walk(key), walk(val)]); });
   enc = { $: 'map', v: pairs };
  } else if (v instanceof Set) {
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

W.structuredClone = function(value){ return decode(encode(value)); };

/* ------------------------------------------------------------- Storage */

function Storage(backing, persist){
 Object.defineProperty(this, '_d', { value: backing, enumerable: false });
 Object.defineProperty(this, '_p', { value: !!persist, enumerable: false });
}
Storage.prototype = {
 constructor: Storage,
 getItem: function(k){
  k = String(k);
  return Object.prototype.hasOwnProperty.call(this._d, k) ? this._d[k] : null;
 },
 setItem: function(k, v){
  var key = String(k), old = this.getItem(key), val = String(v);
  this._d[key] = val;
  if (this._p) touch();
  fireStorage(key, old, val);
 },
 removeItem: function(k){
  var key = String(k), old = this.getItem(key);
  delete this._d[key];
  if (this._p) touch();
  if (old !== null) fireStorage(key, old, null);
 },
 clear: function(){
  var self = this;
  Object.keys(this._d).forEach(function(k){ delete self._d[k]; });
  if (this._p) touch();
  fireStorage(null, null, null);
 },
 key: function(i){
  var keys = Object.keys(this._d);
  i = Number(i) || 0;
  return i >= 0 && i < keys.length ? keys[i] : null;
 }
};
Object.defineProperty(Storage.prototype, 'length', {
 configurable: true,
 get: function(){ return Object.keys(this._d).length; }
});

/* The storage event. A real browser sends it to other tabs; there is one
   page here, so it goes to this one, which is what a page listening for
   it to keep two views in step is doing. */
function fireStorage(key, oldValue, newValue){
 if (typeof StorageEvent !== 'function' && typeof Event !== 'function') return;
 try {
  var e = new Event('storage');
  e.key = key; e.oldValue = oldValue; e.newValue = newValue;
  e.url = W.location ? String(W.location.href) : '';
  e.storageArea = W.localStorage;
  W.dispatchEvent(e);
 } catch (err) { /* nothing listening is not a failure */ }
}

W.Storage = Storage;
Object.defineProperty(W, 'localStorage', {
 configurable: true,
 get: function(){
  if (!this._ls) this._ls = new Storage(readStore().local, true);
  return this._ls;
 }
});
W.sessionStorage = new Storage({}, false);	/* by design, not persisted */

/* ---------------------------------------------------------- IndexedDB */

/*
 * The shape on disk, under store.idb:
 *
 *   <database>: { version, stores: { <store>: {
 *       keyPath, autoIncrement, nextKey,
 *       indexes: { <index>: { keyPath, unique, multiEntry } },
 *       records: [ { k: <encoded key>, v: <encoded value> } ] } } }
 *
 * Records are kept in key order, which is the order a cursor walks and
 * the order a range is cut out of, so neither has to sort.
 */

function DOMEx(name, message){
 if (typeof DOMException === 'function') return new DOMException(message, name);
 var e = new Error(message); e.name = name; return e;
}

/* ---- keys ---- */

/* number < date < string < binary < array, as the specification orders
   them, so that cursors and ranges agree with every other browser. */
function keyType(k){
 if (typeof k === 'number') return 0;
 if (k instanceof Date) return 1;
 if (typeof k === 'string') return 2;
 if (k instanceof ArrayBuffer || ArrayBuffer.isView(k)) return 3;
 if (Array.isArray(k)) return 4;
 return -1;
}
function validKey(k){
 if (keyType(k) < 0) return false;
 if (typeof k === 'number' && k !== k) return false;
 if (k instanceof Date && isNaN(k.getTime())) return false;
 if (Array.isArray(k)) return k.every(validKey);
 return true;
}
function keyBytes(k){
 if (k instanceof ArrayBuffer) return new Uint8Array(k);
 return new Uint8Array(k.buffer, k.byteOffset, k.byteLength);
}
function cmpKeys(a, b){
 var ta = keyType(a), tb = keyType(b);
 if (ta !== tb) return ta < tb ? -1 : 1;
 switch (ta) {
  case 0: return a < b ? -1 : a > b ? 1 : 0;
  case 1: return a.getTime() < b.getTime() ? -1 : a.getTime() > b.getTime() ? 1 : 0;
  case 2: return a < b ? -1 : a > b ? 1 : 0;
  case 3: {
   var x = keyBytes(a), y = keyBytes(b), n = Math.min(x.length, y.length), i;
   for (i = 0; i < n; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
   return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
  }
  case 4: {
   var m = Math.min(a.length, b.length), j;
   for (j = 0; j < m; j++) {
    var c = cmpKeys(a[j], b[j]);
    if (c !== 0) return c;
   }
   return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }
 }
 return 0;
}

/** The value a key path picks out of a value, or undefined. */
function keyFromPath(value, path){
 if (Array.isArray(path)) {
  var parts = path.map(function(p){ return keyFromPath(value, p); });
  return parts.some(function(p){ return p === undefined; }) ? undefined : parts;
 }
 if (path === null || path === undefined || path === '') return undefined;
 var cur = value, bits = String(path).split('.'), i;
 for (i = 0; i < bits.length; i++) {
  if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
  cur = cur[bits[i]];
 }
 return cur;
}
function setKeyPath(value, path, key){
 var bits = String(path).split('.'), cur = value, i;
 for (i = 0; i < bits.length - 1; i++) {
  if (cur[bits[i]] === undefined || cur[bits[i]] === null) cur[bits[i]] = {};
  cur = cur[bits[i]];
 }
 cur[bits[bits.length - 1]] = key;
}

/* ---- IDBKeyRange ---- */

function IDBKeyRange(lower, upper, lowerOpen, upperOpen){
 this.lower = lower; this.upper = upper;
 this.lowerOpen = !!lowerOpen; this.upperOpen = !!upperOpen;
}
IDBKeyRange.prototype.includes = function(key){
 if (!validKey(key)) throw DOMEx('DataError', 'not a valid key');
 if (this.lower !== undefined) {
  var c = cmpKeys(key, this.lower);
  if (c < 0 || (c === 0 && this.lowerOpen)) return false;
 }
 if (this.upper !== undefined) {
  var d = cmpKeys(key, this.upper);
  if (d > 0 || (d === 0 && this.upperOpen)) return false;
 }
 return true;
};
IDBKeyRange.only = function(v){
 if (!validKey(v)) throw DOMEx('DataError', 'not a valid key');
 return new IDBKeyRange(v, v, false, false);
};
IDBKeyRange.lowerBound = function(v, open){
 if (!validKey(v)) throw DOMEx('DataError', 'not a valid key');
 return new IDBKeyRange(v, undefined, open, true);
};
IDBKeyRange.upperBound = function(v, open){
 if (!validKey(v)) throw DOMEx('DataError', 'not a valid key');
 return new IDBKeyRange(undefined, v, true, open);
};
IDBKeyRange.bound = function(l, u, lo, uo){
 if (!validKey(l) || !validKey(u)) throw DOMEx('DataError', 'not a valid key');
 if (cmpKeys(l, u) > 0) throw DOMEx('DataError', 'lower is above upper');
 return new IDBKeyRange(l, u, lo, uo);
};
function asRange(q){
 if (q === null || q === undefined) return new IDBKeyRange(undefined, undefined, false, false);
 if (q instanceof IDBKeyRange) return q;
 return IDBKeyRange.only(q);
}

/* ---- a small event target, since these are not DOM nodes ---- */

function Target(){ this._l = {}; }
Target.prototype = {
 addEventListener: function(t, f){
  if (typeof f !== 'function') return;
  (this._l[t] = this._l[t] || []).push(f);
 },
 removeEventListener: function(t, f){
  if (!this._l[t]) return;
  this._l[t] = this._l[t].filter(function(g){ return g !== f; });
 },
 dispatchEvent: function(e){
  var self = this;
  e.target = e.target || this;
  e.currentTarget = this;
  var on = this['on' + e.type];
  if (typeof on === 'function') {
   try { on.call(this, e); } catch (err) { report(err); }
  }
  (this._l[e.type] || []).slice().forEach(function(f){
   try { f.call(self, e); } catch (err) { report(err); }
  });
  return true;
 }
};
function report(err){
 if (W.__vitaReportError) W.__vitaReportError(err);
 else if (W.console && console.error) console.error(err);
}
function mkEvent(type){
 var e;
 try { e = new Event(type); } catch (x) { e = { type: type }; }
 return e;
}

/* ---- requests ---- */

function IDBRequest(source, transaction){
 Target.call(this);
 this.result = undefined; this.error = null;
 this.source = source || null;
 this.transaction = transaction || null;
 this.readyState = 'pending';
 this.onsuccess = null; this.onerror = null;
}
IDBRequest.prototype = Object.create(Target.prototype);
IDBRequest.prototype.constructor = IDBRequest;

function IDBOpenDBRequest(){
 IDBRequest.apply(this, arguments);
 this.onupgradeneeded = null; this.onblocked = null;
}
IDBOpenDBRequest.prototype = Object.create(IDBRequest.prototype);
IDBOpenDBRequest.prototype.constructor = IDBOpenDBRequest;

function succeed(req, result){
 req.readyState = 'done'; req.result = result; req.error = null;
 var e = mkEvent('success');
 req.dispatchEvent(e);
}
function fail(req, err){
 req.readyState = 'done'; req.result = undefined; req.error = err;
 var e = mkEvent('error');
 req.dispatchEvent(e);
 if (req.transaction && !req._handled) req.transaction._abort(err);
}

/* ---- transactions ---- */

function IDBTransaction(db, names, mode){
 Target.call(this);
 this.db = db;
 this.mode = mode || 'readonly';
 this.objectStoreNames = names.slice().sort();
 this.error = null;
 this.durability = 'default';
 this.oncomplete = null; this.onerror = null; this.onabort = null;
 this._stores = {};
 this._queue = [];
 this._state = 'active';	/* active | finishing | done */
 this._snapshot = null;
 if (this.mode !== 'readonly') {
  /* what to put back if this transaction is abandoned */
  this._snapshot = JSON.stringify(db._data.stores);
 }
 var self = this;
 /* The transaction is active for as long as script keeps adding to it,
    and finishes once a turn goes by with nothing left to do, which is
    what "no more requests in this task" comes to in practice. */
 Promise.resolve().then(function(){ self._drain(); });
}
IDBTransaction.prototype = Object.create(Target.prototype);
IDBTransaction.prototype.constructor = IDBTransaction;
IDBTransaction.prototype.objectStore = function(name){
 if (this._state === 'done') throw DOMEx('InvalidStateError', 'this transaction has finished');
 if (this.objectStoreNames.indexOf(String(name)) < 0) {
  throw DOMEx('NotFoundError', 'no store ' + name + ' in this transaction');
 }
 if (!this._stores[name]) this._stores[name] = new IDBObjectStore(this, String(name));
 return this._stores[name];
};
IDBTransaction.prototype._push = function(fn, req){
 if (this._state === 'done') throw DOMEx('TransactionInactiveError', 'this transaction has finished');
 this._queue.push({ fn: fn, req: req });
 var self = this;
 if (!this._scheduled) {
  this._scheduled = true;
  Promise.resolve().then(function(){ self._scheduled = false; self._drain(); });
 }
 return req;
};
IDBTransaction.prototype._drain = function(){
 if (this._state === 'done') return;
 while (this._queue.length) {
  var job = this._queue.shift();
  if (this._state === 'done') return;
  try {
   var out = job.fn();
   succeed(job.req, out);
  } catch (err) {
   job.req.error = err;
   fail(job.req, err);
   if (this._state === 'done') return;
  }
 }
 /* nothing left: give script one more turn to queue something */
 var self = this;
 if (this._state === 'active') {
  this._state = 'finishing';
  Promise.resolve().then(function(){
   if (self._state !== 'finishing') return;
   if (self._queue.length) { self._state = 'active'; self._drain(); return; }
   self._state = 'done';
   if (self.mode !== 'readonly') touch();
   self.dispatchEvent(mkEvent('complete'));
  });
 }
};
IDBTransaction.prototype._abort = function(err){
 if (this._state === 'done') return;
 this._state = 'done';
 this._queue = [];
 if (this._snapshot !== null) {
  try { this.db._data.stores = JSON.parse(this._snapshot); } catch (e) {}
  touch();
 }
 this.error = err || DOMEx('AbortError', 'this transaction was abandoned');
 /*
  * Not from here. abort() is usually called before onabort is set --
  * tx.abort(); tx.onabort = ... reads naturally and is what a browser
  * supports, because there the event comes in a later task. Fired from
  * inside abort() the handler does not exist yet and nothing is heard.
  */
 var self = this;
 Promise.resolve().then(function(){
  self.dispatchEvent(mkEvent('abort'));
 });
};
IDBTransaction.prototype.abort = function(){ this._abort(null); };
IDBTransaction.prototype.commit = function(){ this._drain(); };

/* ---- object stores ---- */

function IDBObjectStore(tx, name){
 this.transaction = tx;
 this.name = name;
 this._s = tx.db._data.stores[name];
 if (!this._s) throw DOMEx('NotFoundError', 'no store ' + name);
 this.keyPath = this._s.keyPath === undefined ? null : this._s.keyPath;
 this.autoIncrement = !!this._s.autoIncrement;
 this.indexNames = Object.keys(this._s.indexes || {}).sort();
}

function recordsOf(s){ return s.records; }
/* records are in key order, so a key is found by halving the range */
function findAt(s, key){
 var lo = 0, hi = s.records.length - 1;
 while (lo <= hi) {
  var mid = (lo + hi) >> 1, c = cmpKeys(decode(s.records[mid].k), key);
  if (c === 0) return mid;
  if (c < 0) lo = mid + 1; else hi = mid - 1;
 }
 return -(lo + 1);
}
function inRange(s, range, desc){
 var out = [], i;
 for (i = 0; i < s.records.length; i++) {
  var k = decode(s.records[i].k);
  if (range.includes(k)) out.push({ key: k, rec: s.records[i] });
 }
 if (desc) out.reverse();
 return out;
}

IDBObjectStore.prototype = {
 constructor: IDBObjectStore,
 _write: function(){
  if (this.transaction.mode === 'readonly') {
   throw DOMEx('ReadOnlyError', 'this transaction is read only');
  }
 },
 _key: function(value, explicit, adding){
  var s = this._s;
  if (this.keyPath !== null && this.keyPath !== undefined) {
   if (explicit !== undefined && explicit !== null) {
    throw DOMEx('DataError', 'this store takes its key from the value');
   }
   var k = keyFromPath(value, this.keyPath);
   if (k === undefined) {
    if (!s.autoIncrement) throw DOMEx('DataError', 'the value has no key');
    k = s.nextKey++;
    if (!Array.isArray(this.keyPath)) setKeyPath(value, this.keyPath, k);
   }
   if (!validKey(k)) throw DOMEx('DataError', 'not a valid key');
   return k;
  }
  if (explicit !== undefined && explicit !== null) {
   if (!validKey(explicit)) throw DOMEx('DataError', 'not a valid key');
   return explicit;
  }
  if (!s.autoIncrement) throw DOMEx('DataError', 'a key is needed');
  void adding;
  return s.nextKey++;
 },
 _store: function(value, explicit, adding){
  var s = this._s, self = this;
  var key = this._key(value, explicit, adding);
  if (typeof key === 'number' && s.autoIncrement && key >= s.nextKey) {
   s.nextKey = Math.floor(key) + 1;
  }
  var at = findAt(s, key);
  if (at >= 0 && adding) throw DOMEx('ConstraintError', 'that key is taken');
  checkUnique(self, key, value, at >= 0 ? at : -1);
  var rec = { k: encode(key), v: encode(value) };
  if (at >= 0) s.records[at] = rec;
  else s.records.splice(-at - 1, 0, rec);
  return key;
 },
 put: function(value, key){
  this._write();
  var self = this, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){ return self._store(value, key, false); }, req);
 },
 add: function(value, key){
  this._write();
  var self = this, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){ return self._store(value, key, true); }, req);
 },
 get: function(query){
  var s = this._s, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){
   var hits = inRange(s, asRange(query), false);
   return hits.length ? decode(hits[0].rec.v) : undefined;
  }, req);
 },
 getKey: function(query){
  var s = this._s, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){
   var hits = inRange(s, asRange(query), false);
   return hits.length ? hits[0].key : undefined;
  }, req);
 },
 getAll: function(query, count){
  var s = this._s, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){
   var hits = inRange(s, asRange(query), false);
   if (count > 0) hits = hits.slice(0, count);
   return hits.map(function(h){ return decode(h.rec.v); });
  }, req);
 },
 getAllKeys: function(query, count){
  var s = this._s, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){
   var hits = inRange(s, asRange(query), false);
   if (count > 0) hits = hits.slice(0, count);
   return hits.map(function(h){ return h.key; });
  }, req);
 },
 'delete': function(query){
  this._write();
  var s = this._s, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){
   var hits = inRange(s, asRange(query), false);
   hits.forEach(function(h){
    var at = s.records.indexOf(h.rec);
    if (at >= 0) s.records.splice(at, 1);
   });
   return undefined;
  }, req);
 },
 clear: function(){
  this._write();
  var s = this._s, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){ s.records = []; return undefined; }, req);
 },
 count: function(query){
  var s = this._s, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){
   return inRange(s, asRange(query), false).length;
  }, req);
 },
 /* key, primaryKey and value together, so a caller that wants all three
    does not have to walk a cursor for them. */
 getAllRecords: function(options){
  options = options || {};
  var s = this._s, req = new IDBRequest(this, this.transaction);
  return this.transaction._push(function(){
   var desc = options.direction === 'prev' || options.direction === 'prevunique';
   var hits = inRange(s, asRange(options.query), desc);
   if (options.count > 0) hits = hits.slice(0, options.count);
   return hits.map(function(h){
    return { key: h.key, primaryKey: h.key, value: decode(h.rec.v) };
   });
  }, req);
 },
 openCursor: function(query, direction){
  return openCursor(this, this._s, asRange(query), direction, true, null);
 },
 openKeyCursor: function(query, direction){
  return openCursor(this, this._s, asRange(query), direction, false, null);
 },
 createIndex: function(name, keyPath, options){
  options = options || {};
  if (!this.transaction._upgrade) {
   throw DOMEx('InvalidStateError', 'indexes are made while upgrading');
  }
  this._s.indexes = this._s.indexes || {};
  this._s.indexes[String(name)] = {
   keyPath: keyPath, unique: !!options.unique, multiEntry: !!options.multiEntry
  };
  this.indexNames = Object.keys(this._s.indexes).sort();
  touch();
  return new IDBIndex(this, String(name));
 },
 deleteIndex: function(name){
  if (!this.transaction._upgrade) {
   throw DOMEx('InvalidStateError', 'indexes are removed while upgrading');
  }
  delete this._s.indexes[String(name)];
  this.indexNames = Object.keys(this._s.indexes).sort();
  touch();
 },
 index: function(name){
  if (!this._s.indexes || !this._s.indexes[String(name)]) {
   throw DOMEx('NotFoundError', 'no index ' + name);
  }
  return new IDBIndex(this, String(name));
 }
};

function checkUnique(objStore, key, value, replacingAt){
 var s = objStore._s;
 if (!s.indexes) return;
 Object.keys(s.indexes).forEach(function(name){
  var idx = s.indexes[name];
  if (!idx.unique) return;
  var ikey = keyFromPath(value, idx.keyPath);
  if (ikey === undefined) return;
  var i;
  for (i = 0; i < s.records.length; i++) {
   if (i === replacingAt) continue;
   var other = decode(s.records[i].v);
   var okey = keyFromPath(other, idx.keyPath);
   if (okey !== undefined && cmpKeys(okey, ikey) === 0) {
    throw DOMEx('ConstraintError', 'index ' + name + ' must be unique');
   }
  }
 });
}

/* ---- indexes ---- */

function IDBIndex(objStore, name){
 this.objectStore = objStore;
 this.name = name;
 this._i = objStore._s.indexes[name];
 this.keyPath = this._i.keyPath;
 this.unique = !!this._i.unique;
 this.multiEntry = !!this._i.multiEntry;
}
/* the records an index sees, in index-key order */
function indexHits(objStore, idx, range, desc){
 var s = objStore._s, out = [];
 s.records.forEach(function(rec){
  var value = decode(rec.v), pk = decode(rec.k);
  var ik = keyFromPath(value, idx.keyPath);
  if (ik === undefined) return;
  if (idx.multiEntry && Array.isArray(ik)) {
   ik.forEach(function(one){
    if (validKey(one) && range.includes(one)) {
     out.push({ key: one, primaryKey: pk, rec: rec });
    }
   });
   return;
  }
  if (!validKey(ik) || !range.includes(ik)) return;
  out.push({ key: ik, primaryKey: pk, rec: rec });
 });
 out.sort(function(a, b){
  var c = cmpKeys(a.key, b.key);
  return c !== 0 ? c : cmpKeys(a.primaryKey, b.primaryKey);
 });
 if (desc) out.reverse();
 return out;
}
IDBIndex.prototype = {
 constructor: IDBIndex,
 get: function(query){
  var self = this, tx = this.objectStore.transaction;
  var req = new IDBRequest(this, tx);
  return tx._push(function(){
   var hits = indexHits(self.objectStore, self._i, asRange(query), false);
   return hits.length ? decode(hits[0].rec.v) : undefined;
  }, req);
 },
 getKey: function(query){
  var self = this, tx = this.objectStore.transaction;
  var req = new IDBRequest(this, tx);
  return tx._push(function(){
   var hits = indexHits(self.objectStore, self._i, asRange(query), false);
   return hits.length ? hits[0].primaryKey : undefined;
  }, req);
 },
 getAll: function(query, count){
  var self = this, tx = this.objectStore.transaction;
  var req = new IDBRequest(this, tx);
  return tx._push(function(){
   var hits = indexHits(self.objectStore, self._i, asRange(query), false);
   if (count > 0) hits = hits.slice(0, count);
   return hits.map(function(h){ return decode(h.rec.v); });
  }, req);
 },
 getAllKeys: function(query, count){
  var self = this, tx = this.objectStore.transaction;
  var req = new IDBRequest(this, tx);
  return tx._push(function(){
   var hits = indexHits(self.objectStore, self._i, asRange(query), false);
   if (count > 0) hits = hits.slice(0, count);
   return hits.map(function(h){ return h.primaryKey; });
  }, req);
 },
 count: function(query){
  var self = this, tx = this.objectStore.transaction;
  var req = new IDBRequest(this, tx);
  return tx._push(function(){
   return indexHits(self.objectStore, self._i, asRange(query), false).length;
  }, req);
 },
 getAllRecords: function(options){
  options = options || {};
  var self = this, tx = this.objectStore.transaction;
  var req = new IDBRequest(this, tx);
  return tx._push(function(){
   var desc = options.direction === 'prev' || options.direction === 'prevunique';
   var hits = indexHits(self.objectStore, self._i, asRange(options.query), desc);
   if (options.count > 0) hits = hits.slice(0, options.count);
   return hits.map(function(h){
    return { key: h.key, primaryKey: h.primaryKey, value: decode(h.rec.v) };
   });
  }, req);
 },
 openCursor: function(query, direction){
  return openCursor(this.objectStore, this.objectStore._s, asRange(query),
                    direction, true, this._i);
 },
 openKeyCursor: function(query, direction){
  return openCursor(this.objectStore, this.objectStore._s, asRange(query),
                    direction, false, this._i);
 }
};

/* ---- cursors ---- */

function IDBCursor(source, req, hits, withValue, tx){
 this.source = source;
 this.request = req;
 this.direction = 'next';
 this.key = undefined; this.primaryKey = undefined;
 if (withValue) this.value = undefined;
 this._hits = hits; this._at = -1; this._v = withValue; this._tx = tx;
}
IDBCursor.prototype = {
 constructor: IDBCursor,
 _step: function(n){
  this._at += (n === undefined ? 1 : n);
  if (this._at >= this._hits.length) {
   this.key = undefined; this.primaryKey = undefined;
   if (this._v) this.value = undefined;
   return false;
  }
  var h = this._hits[this._at];
  this.key = h.key !== undefined ? h.key : decode(h.rec.k);
  this.primaryKey = h.primaryKey !== undefined ? h.primaryKey : this.key;
  if (this._v) this.value = decode(h.rec.v);
  return true;
 },
 'continue': function(key){
  var self = this, req = this.request;
  this._tx._push(function(){
   if (key !== undefined) {
    while (self._at + 1 < self._hits.length) {
     var next = self._hits[self._at + 1];
     var nk = next.key !== undefined ? next.key : decode(next.rec.k);
     if (cmpKeys(nk, key) >= 0) break;
     self._at++;
    }
   }
   return self._step(1) ? self : null;
  }, req);
 },
 advance: function(n){
  n = Number(n);
  if (!(n > 0)) throw new TypeError('advance needs a positive count');
  var self = this, req = this.request;
  this._tx._push(function(){ return self._step(n) ? self : null; }, req);
 },
 /* For an index cursor, where one index key covers many records: skip to
    the first one at or past both keys. */
 continuePrimaryKey: function(key, primaryKey){
  if (!validKey(key) || !validKey(primaryKey)) {
   throw DOMEx('DataError', 'not a valid key');
  }
  var self = this, req = this.request;
  this._tx._push(function(){
   while (self._at + 1 < self._hits.length) {
    var next = self._hits[self._at + 1];
    var nk = next.key !== undefined ? next.key : decode(next.rec.k);
    var np = next.primaryKey !== undefined ? next.primaryKey : nk;
    var c = cmpKeys(nk, key);
    if (c > 0 || (c === 0 && cmpKeys(np, primaryKey) >= 0)) break;
    self._at++;
   }
   return self._step(1) ? self : null;
  }, req);
 },
 update: function(value){
  if (this._tx.mode === 'readonly') throw DOMEx('ReadOnlyError', 'this transaction is read only');
  var h = this._hits[this._at];
  var req = new IDBRequest(this.source, this._tx);
  var key = this.primaryKey;
  return this._tx._push(function(){
   h.rec.v = encode(value);
   return key;
  }, req);
 },
 'delete': function(){
  if (this._tx.mode === 'readonly') throw DOMEx('ReadOnlyError', 'this transaction is read only');
  var h = this._hits[this._at], s = this.source._s || this.source.objectStore._s;
  var req = new IDBRequest(this.source, this._tx);
  return this._tx._push(function(){
   var at = s.records.indexOf(h.rec);
   if (at >= 0) s.records.splice(at, 1);
   return undefined;
  }, req);
 }
};
function IDBCursorWithValue(){ IDBCursor.apply(this, arguments); }
IDBCursorWithValue.prototype = Object.create(IDBCursor.prototype);
IDBCursorWithValue.prototype.constructor = IDBCursorWithValue;

function openCursor(objStore, s, range, direction, withValue, idx){
 var tx = objStore.transaction;
 var req = new IDBRequest(idx ? new IDBIndex(objStore, '') : objStore, tx);
 direction = direction || 'next';
 var desc = direction === 'prev' || direction === 'prevunique';
 return tx._push(function(){
  var hits = idx ? indexHits(objStore, idx, range, desc) : inRange(s, range, desc);
  if (direction === 'nextunique' || direction === 'prevunique') {
   var seen = [], uniq = [];
   hits.forEach(function(h){
    if (!seen.some(function(k){ return cmpKeys(k, h.key) === 0; })) {
     seen.push(h.key); uniq.push(h);
    }
   });
   hits = uniq;
  }
  var Ctor = withValue ? IDBCursorWithValue : IDBCursor;
  var cur = new Ctor(idx ? objStore : objStore, req, hits, withValue, tx);
  cur.direction = direction;
  return cur._step(1) ? cur : null;
 }, req);
}

/* ---- databases ---- */

function IDBDatabase(name, data){
 Target.call(this);
 this.name = name;
 this._data = data;
 this.version = data.version;
 this.objectStoreNames = Object.keys(data.stores).sort();
 this.onversionchange = null; this.onclose = null;
 this._closed = false;
}
IDBDatabase.prototype = Object.create(Target.prototype);
IDBDatabase.prototype.constructor = IDBDatabase;
IDBDatabase.prototype.close = function(){ this._closed = true; };
IDBDatabase.prototype.transaction = function(names, mode){
 if (this._closed) throw DOMEx('InvalidStateError', 'this database is closed');
 var list = Array.isArray(names) ? names.map(String) : [String(names)];
 var self = this;
 list.forEach(function(n){
  if (!self._data.stores[n]) throw DOMEx('NotFoundError', 'no store ' + n);
 });
 if (list.length === 0) throw DOMEx('InvalidAccessError', 'name a store');
 return new IDBTransaction(this, list, mode || 'readonly');
};
IDBDatabase.prototype.createObjectStore = function(name, options){
 options = options || {};
 if (!this._upgradeTx) throw DOMEx('InvalidStateError', 'stores are made while upgrading');
 name = String(name);
 if (this._data.stores[name]) throw DOMEx('ConstraintError', 'that store exists');
 this._data.stores[name] = {
  keyPath: options.keyPath === undefined ? null : options.keyPath,
  autoIncrement: !!options.autoIncrement,
  nextKey: 1, indexes: {}, records: []
 };
 this.objectStoreNames = Object.keys(this._data.stores).sort();
 if (this._upgradeTx.objectStoreNames.indexOf(name) < 0) {
  this._upgradeTx.objectStoreNames.push(name);
  this._upgradeTx.objectStoreNames.sort();
 }
 touch();
 return this._upgradeTx.objectStore(name);
};
IDBDatabase.prototype.deleteObjectStore = function(name){
 if (!this._upgradeTx) throw DOMEx('InvalidStateError', 'stores are removed while upgrading');
 delete this._data.stores[String(name)];
 this.objectStoreNames = Object.keys(this._data.stores).sort();
 touch();
};

/* ---- the factory ---- */

function IDBVersionChangeEvent(type, init){
 init = init || {};
 var e = mkEvent(type);
 e.oldVersion = init.oldVersion || 0;
 e.newVersion = init.newVersion === undefined ? null : init.newVersion;
 return e;
}

function IDBFactory(){}
IDBFactory.prototype = {
 constructor: IDBFactory,
 open: function(name, version){
  name = String(name);
  var req = new IDBOpenDBRequest(null, null);
  var all = readStore().idb;
  if (version !== undefined) {
   version = Number(version);
   if (!(version >= 1) || version !== Math.floor(version)) {
    throw new TypeError('version must be a whole number of at least 1');
   }
  }
  /* opening is asynchronous even when nothing has to be read */
  Promise.resolve().then(function(){
   var data = all[name];
   var existed = !!data;
   var oldVersion = existed ? data.version : 0;
   if (!existed) {
    data = { version: version === undefined ? 1 : version, stores: {} };
    all[name] = data;
   }
   var want = version === undefined ? data.version : version;
   if (want < oldVersion) {
    fail(req, DOMEx('VersionError', 'version ' + want + ' is below ' +
                    oldVersion));
    return;
   }
   var db = new IDBDatabase(name, data);
   if (want > oldVersion || !existed) {
    data.version = want;
    db.version = want;
    var tx = new IDBTransaction(db, Object.keys(data.stores), 'versionchange');
    tx._upgrade = true;
    db._upgradeTx = tx;
    var ev = IDBVersionChangeEvent('upgradeneeded',
             { oldVersion: oldVersion, newVersion: want });
    ev.target = req;
    req.result = db;
    req.transaction = tx;
    req.dispatchEvent(ev);
    tx.addEventListener('complete', function(){
     db._upgradeTx = null;
     req.transaction = null;
     touch();
     succeed(req, db);
    });
    tx.addEventListener('abort', function(){
     db._upgradeTx = null;
     fail(req, tx.error);
    });
    tx._drain();
    return;
   }
   touch();
   succeed(req, db);
  });
  return req;
 },
 deleteDatabase: function(name){
  var req = new IDBOpenDBRequest(null, null);
  var all = readStore().idb;
  name = String(name);
  Promise.resolve().then(function(){
   var had = all[name] ? all[name].version : 0;
   delete all[name];
   touch();
   var ev = IDBVersionChangeEvent('success', { oldVersion: had, newVersion: null });
   req.readyState = 'done'; req.result = undefined;
   req.dispatchEvent(ev);
  });
  return req;
 },
 databases: function(){
  var all = readStore().idb;
  return Promise.resolve(Object.keys(all).map(function(n){
   return { name: n, version: all[n].version };
  }));
 },
 cmp: function(a, b){
  if (!validKey(a) || !validKey(b)) throw DOMEx('DataError', 'not a valid key');
  return cmpKeys(a, b);
 }
};

/*
 * Every one of these is set on the instance, which is what a page reads.
 * A browser also has them on the prototype, where the interface defines
 * them as getters, so 'version' in IDBDatabase.prototype is true there
 * and was false here. Declared with the value an instance that had none
 * would show, they make the shape match without changing any answer.
 */
(function(){
 function shape(Ctor, props){
  Object.keys(props).forEach(function(k){
   if (!(k in Ctor.prototype)) Ctor.prototype[k] = props[k];
  });
 }
 shape(IDBDatabase, { name: '', version: 0, objectStoreNames: [],
                      onabort: null, onclose: null, onerror: null,
                      onversionchange: null });
 shape(IDBTransaction, { db: null, durability: 'default', error: null,
                         mode: 'readonly', objectStoreNames: [],
                         onabort: null, oncomplete: null, onerror: null });
 shape(IDBObjectStore, { autoIncrement: false, indexNames: [], keyPath: null,
                         name: '', transaction: null });
 shape(IDBIndex, { keyPath: null, multiEntry: false, name: '',
                   objectStore: null, unique: false });
 shape(IDBCursor, { direction: 'next', key: undefined, primaryKey: undefined,
                    request: null, source: null });
 shape(IDBCursorWithValue, { value: undefined });
 shape(IDBRequest, { error: null, readyState: 'pending', result: undefined,
                     source: null, transaction: null,
                     onerror: null, onsuccess: null });
 shape(IDBOpenDBRequest, { onblocked: null, onupgradeneeded: null });
})();

W.IDBFactory = IDBFactory;
W.IDBRequest = IDBRequest;
W.IDBOpenDBRequest = IDBOpenDBRequest;
W.IDBDatabase = IDBDatabase;
W.IDBTransaction = IDBTransaction;
W.IDBObjectStore = IDBObjectStore;
W.IDBIndex = IDBIndex;
W.IDBCursor = IDBCursor;
W.IDBCursorWithValue = IDBCursorWithValue;
W.IDBKeyRange = IDBKeyRange;
W.IDBVersionChangeEvent = IDBVersionChangeEvent;
W.indexedDB = new IDBFactory();
})();
