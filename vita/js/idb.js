/*
 * IndexedDB, a unit of the VitaSurf prelude that runs the first time a
 * page uses it (see lazy.js), on the store storage.js keeps for the
 * origin and with its structured clone.
 */
(function(){
'use strict';
var W = window, H = NV.__vitaIdbNeeds;
if (!H) return;
delete NV.__vitaIdbNeeds;
var readStore = H.readStore, touch = H.touch, encode = H.encode,
 decode = H.decode, stringList = H.stringList, uaEvent = H.uaEvent;
/* the prelude's EventTarget, which a page may since have replaced */
var EventTargetProto = typeof H.EventTarget === 'function' ?
 H.EventTarget.prototype : null;

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
 dispatchEvent: function(e, rethrow){
  var self = this, first = null;
  e.target = e.target || this;
  e.currentTarget = this;
  var on = this['on' + e.type];
  if (typeof on === 'function') {
   try { on.call(this, e); }
   catch (err) { if (!first) first = err; report(err, 'on' + e.type); }
  }
  (this._l[e.type] || []).slice().forEach(function(f){
   try { f.call(self, e); }
   catch (err) { if (!first) first = err; report(err, e.type + ' listener'); }
  });
  /* An upgrade handler that throws must take the transaction with it,
     as it does in a browser. Swallowed, it left a database registered
     with none of the stores it was about to make, and every later open
     saw a database that existed and skipped the upgrade: claude.ai got
     "NotFoundError: no store keyval" on six databases, on every load,
     for good. */
  if (rethrow && first) throw first;
  return true;
 }
};
/* under EventTarget, as WebIDL has IDBRequest, IDBTransaction and
   IDBDatabase: a request was no instance of EventTarget */
if (EventTargetProto) Object.setPrototypeOf(Target.prototype, EventTargetProto);
/*
 * Say where it came from. An error thrown by one of these handlers went
 * to the page's error reporter with no indication that it came from a
 * database event, and claude.ai's "TypeError: not a function" was
 * indistinguishable from an error in its own script. The second
 * argument is the script name the reporter shows.
 */
function report(err, where){
 var label = 'indexedDB ' + (where || 'event handler');
 if (NV.__vitaReportError) NV.__vitaReportError(err, label);
 else if (W.console && console.error) console.error(label, err);
}
function mkEvent(type){
 var e;
 try { e = uaEvent(new Event(type)); } catch (x) { e = { type: type, isTrusted: true }; }
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
 this.objectStoreNames = stringList(names.slice().sort());
 this.error = null;
 this.durability = 'default';
 this.oncomplete = null; this.onerror = null; this.onabort = null;
 this._stores = {};
 this._queue = [];
 this._state = 'active';	/* active | finishing | done */
 this._snapshot = null;
 if (this.mode !== 'readonly') {
  /* what to put back if this transaction is abandoned */
  if (this.mode === 'versionchange') {
   this._snapshot = JSON.stringify(db._data.stores);
  } else {
   /* only the stores it may write, and only their record lists:
      records are replaced, never changed in place, so a copy of the
      list is enough to put back, where serialising every store made
      each small write cost the whole database (VitaSurf) */
   this._lists = {};
   for (var i = 0; i < names.length; i++) {
    var st = db._data.stores[names[i]];
    if (st) this._lists[names[i]] = { records: st.records.slice(), nextKey: st.nextKey };
   }
  }
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
 } else if (this._lists) {
  var stores = this.db._data.stores, n;
  for (n in this._lists) {
   if (stores[n]) {
    stores[n].records = this._lists[n].records;
    stores[n].nextKey = this._lists[n].nextKey;
   }
  }
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
 this.indexNames = stringList(Object.keys(this._s.indexes || {}).sort());
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
/* the first record at or above key, or above it when open */
function lowerAt(s, key, open){
 var lo = 0, hi = s.records.length;
 while (lo < hi) {
  var mid = (lo + hi) >> 1, c = cmpKeys(decode(s.records[mid].k), key);
  if (c < 0 || (c === 0 && open)) lo = mid + 1; else hi = mid;
 }
 return lo;
}
/*
 * The records a range takes in, found by halving to its lower end and
 * walking to its upper one. Checking every record against the range made
 * a get() cost the whole store: Home Assistant's icon cache holds
 * thousands, and its icon lookups spent 32 seconds here (VitaSurf).
 */
function inRange(s, range, desc){
 var out = [], recs = s.records, i = 0;
 if (range.lower !== undefined) i = lowerAt(s, range.lower, range.lowerOpen);
 for (; i < recs.length; i++) {
  var k = decode(recs[i].k);
  if (range.upper !== undefined) {
   var d = cmpKeys(k, range.upper);
   if (d > 0 || (d === 0 && range.upperOpen)) break;
  }
  out.push({ key: k, rec: recs[i] });
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
  this.indexNames = stringList(Object.keys(this._s.indexes).sort());
  touch();
  return new IDBIndex(this, String(name));
 },
 deleteIndex: function(name){
  if (!this.transaction._upgrade) {
   throw DOMEx('InvalidStateError', 'indexes are removed while upgrading');
  }
  delete this._s.indexes[String(name)];
  this.indexNames = stringList(Object.keys(this._s.indexes).sort());
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
                    direction, true, this);
 },
 openKeyCursor: function(query, direction){
  return openCursor(this.objectStore, this.objectStore._s, asRange(query),
                    direction, false, this);
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
  var h = this._hits[this._at], st = this.source._s || this.source.objectStore._s;
  var req = new IDBRequest(this.source, this._tx);
  var key = this.primaryKey;
  return this._tx._push(function(){
   /* a new record rather than a change to this one, which an
      abandoned transaction's copy of the list still holds */
   var at = st.records.indexOf(h.rec);
   var rec = { k: h.rec.k, v: encode(value) };
   if (at >= 0) st.records[at] = rec;
   h.rec = rec;
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

/* index is the IDBIndex a cursor walks, which is its source and its
   request's, or null for the store's own records */
function openCursor(objStore, s, range, direction, withValue, index){
 var tx = objStore.transaction, idx = index ? index._i : null;
 var source = index || objStore;
 var req = new IDBRequest(source, tx);
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
  var cur = new Ctor(source, req, hits, withValue, tx);
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
 this.objectStoreNames = stringList(Object.keys(data.stores).sort());
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
 this.objectStoreNames = stringList(Object.keys(this._data.stores).sort());
 if (this._upgradeTx.objectStoreNames.indexOf(name) < 0) {
  this._upgradeTx.objectStoreNames.push(name);
  this._upgradeTx.objectStoreNames.sort();
 }
 /* not written here: the upgrade transaction completing is what makes
    any of this real, and an upgrade that fails should leave nothing */
 return this._upgradeTx.objectStore(name);
};
IDBDatabase.prototype.deleteObjectStore = function(name){
 if (!this._upgradeTx) throw DOMEx('InvalidStateError', 'stores are removed while upgrading');
 delete this._data.stores[String(name)];
 this.objectStoreNames = stringList(Object.keys(this._data.stores).sort());
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
   /*
    * A database with no object stores at all is one whose upgrade never
    * finished. A browser would not have created it; this did, and wrote
    * it to the card, so every later open found it, skipped the upgrade
    * and failed on the store that was never made. Treat it as absent so
    * the upgrade runs again -- which also recovers the cards already
    * carrying one.
    */
   if (existed && version === undefined &&
       Object.keys(data.stores).length === 0) {
    existed = false;
   }
   var oldVersion = existed ? data.version : 0;
   if (!existed) {
    data = { version: version === undefined ? 1 : version, stores: {} };
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
    /* in the store while the upgrade runs, so that a second open of the
       same name shares it, but not written to the card until it works */
    all[name] = data;
    try {
     req.dispatchEvent(ev, true);
    } catch (err) {
     if (!existed) delete all[name];
     db._upgradeTx = null;
     req.transaction = null;
     fail(req, err);
     return;
    }
    tx.addEventListener('complete', function(){
     db._upgradeTx = null;
     req.transaction = null;
     touch();			/* only a finished upgrade is written */
     succeed(req, db);
    });
    tx.addEventListener('abort', function(){
     if (!existed) delete all[name];
     db._upgradeTx = null;
     fail(req, tx.error);
    });
    tx._drain();
    return;
   }
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
 shape(IDBDatabase, { name: '', version: 0, objectStoreNames: stringList([]),
                      onabort: null, onclose: null, onerror: null,
                      onversionchange: null });
 shape(IDBTransaction, { db: null, durability: 'default', error: null,
                         mode: 'readonly', objectStoreNames: stringList([]),
                         onabort: null, oncomplete: null, onerror: null });
 shape(IDBObjectStore, { autoIncrement: false, indexNames: stringList([]), keyPath: null,
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
