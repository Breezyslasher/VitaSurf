/*
 * The performance timeline, part of the VitaSurf prelude.
 *
 * Performance and the entries it keeps, as the specifications make them:
 * PerformanceEntry and its subclasses, PerformanceObserver, User Timing
 * (mark and measure) and the navigation entry.
 *
 * Every member is on its interface's prototype, as a browser has it, and
 * an entry's values are kept where no page can see them (a WeakMap), so
 * an entry has no own properties and Object.keys(performance) is empty.
 * performance was a plain object whose methods were its own properties,
 * now() moved in whole milliseconds, and the entries carried their
 * fields as their own; a page that looks at what it is running in saw
 * all of that.
 *
 * now() is the native monotonic clock to 0.1 ms (__vitaNow), as a
 * browser that is not cross-origin isolated coarsens it. There are no
 * resource entries: nothing here records them.
 */
(function(){
'use strict';
var W = window;
var hrnow = NV.__vitaNow, hr0 = NV.__vitaHr0 || 0;
var t0 = NV.__vitaT0 || Date.now();
function now(){
 return typeof hrnow === 'function'
  ? Math.max(0, Math.round((hrnow() - hr0) * 10) / 10) : Date.now() - t0;
}

var SLOT = new WeakMap();	/* an entry's values, out of the page's sight */
function slot(o, what){
 var s = SLOT.get(o);
 if (!s) throw new TypeError("Failed to read the '" + what +
                             "' property: Illegal invocation");
 return s;
}
function named(f, n){
 Object.defineProperty(f, 'name', {value: n, configurable: true});
 return f;
}
function method(o, n, f){
 Object.defineProperty(o, n, {value: named(f, n), writable: true,
  enumerable: true, configurable: true});
}
function getter(o, n, f){
 Object.defineProperty(o, n, {get: named(f, 'get ' + n), enumerable: true,
  configurable: true});
}
function fields(proto, names){
 names.forEach(function(k){
  getter(proto, k, function(){ return slot(this, k)[k]; });
 });
}
function illegal(){ throw new TypeError('Illegal constructor'); }
function make(proto, values){
 var e = Object.create(proto);
 SLOT.set(e, values);
 return e;
}
function syntaxError(m){
 return W.DOMException ? new W.DOMException(m, 'SyntaxError')
                       : new SyntaxError(m);
}
function clone(v){
 if (v === undefined || v === null) return null;
 return typeof W.structuredClone === 'function' ? W.structuredClone(v) : v;
}

/* PerformanceTiming's attributes, in its order */
var TIMING = ['navigationStart', 'unloadEventStart', 'unloadEventEnd',
 'redirectStart', 'redirectEnd', 'fetchStart', 'domainLookupStart',
 'domainLookupEnd', 'connectStart', 'connectEnd', 'secureConnectionStart',
 'requestStart', 'responseStart', 'responseEnd', 'domLoading',
 'domInteractive', 'domContentLoadedEventStart', 'domContentLoadedEventEnd',
 'domComplete', 'loadEventStart', 'loadEventEnd'];

var entries = [];		/* every entry, in the order they were made */
var MAX_ENTRIES = 1000;		/* a page that marks in a loop must not grow */
/*
 * What performance.timing reports, in absolute milliseconds. Nothing
 * here times the fetch's own phases (lookup, connect, request), so they
 * are the navigation's start, which is what a browser reports for a
 * phase that took no time; the document's milestones are recorded as
 * they happen, and a milestone not reached yet is 0, as the spec has it.
 */
var TV = {};
TIMING.forEach(function(k){ TV[k] = 0; });
['navigationStart', 'fetchStart', 'domainLookupStart', 'domainLookupEnd',
 'connectStart', 'connectEnd', 'requestStart', 'responseStart',
 'responseEnd', 'domLoading'].forEach(function(k){ TV[k] = t0; });
var NAVV = {type: 0, redirectCount: 0};
var navigationType = NAVV.type === 1 ? 'reload' : 'navigate';
var observers = [];

/* --- the entries ------------------------------------------------------ */
function PerformanceEntry(){ illegal(); }
fields(PerformanceEntry.prototype, ['name', 'entryType', 'startTime',
                                    'duration']);
method(PerformanceEntry.prototype, 'toJSON', function(){
 var s = slot(this, 'toJSON'), o = {}, k;
 for (k in s) o[k] = s[k];
 return o;
});

/* new PerformanceMark(name, options) is a mark not in the timeline */
function PerformanceMark(name, options){
 if (!new.target) throw new TypeError("Failed to construct 'PerformanceMark': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
 if (arguments.length < 1) throw new TypeError("Failed to construct 'PerformanceMark': 1 argument required, but only 0 present.");
 name = `${name}`;
 if (TIMING.indexOf(name) >= 0)
  throw syntaxError("'" + name + "' is part of the PerformanceTiming interface, and cannot be used as a mark name.");
 var start = options && options.startTime !== undefined
           ? Number(options.startTime) : now();
 if (start < 0) throw new TypeError("'" + name + "' cannot have a negative start time.");
 SLOT.set(this, {name: name, entryType: 'mark', startTime: start,
                 duration: 0, detail: clone(options ? options.detail : null)});
}
PerformanceMark.prototype = Object.create(PerformanceEntry.prototype);
fields(PerformanceMark.prototype, ['detail']);

function PerformanceMeasure(){ illegal(); }
PerformanceMeasure.prototype = Object.create(PerformanceEntry.prototype);
fields(PerformanceMeasure.prototype, ['detail']);

function PerformanceResourceTiming(){ illegal(); }
PerformanceResourceTiming.prototype = Object.create(PerformanceEntry.prototype);
fields(PerformanceResourceTiming.prototype, ['initiatorType', 'deliveryType',
 'nextHopProtocol', 'workerStart', 'redirectStart', 'redirectEnd',
 'fetchStart', 'domainLookupStart', 'domainLookupEnd', 'connectStart',
 'connectEnd', 'secureConnectionStart', 'requestStart', 'responseStart',
 'responseEnd', 'transferSize', 'encodedBodySize', 'decodedBodySize',
 'responseStatus', 'renderBlockingStatus', 'contentType']);

/*
 * The navigation entry, built from the timings the browser actually
 * recorded rather than left empty. performance.timing holds them as
 * absolute milliseconds; every field here is relative to the start of
 * the navigation, which is what the timeline is measured in.
 *
 * notRestoredReasons is null because nothing here uses a back/forward
 * cache, and confidence is null because we do not estimate one -- both
 * are the value a browser gives when it has nothing to report, not a
 * placeholder standing in for a number we should have.
 */
function PerformanceNavigationTiming(){ illegal(); }
PerformanceNavigationTiming.prototype =
 Object.create(PerformanceResourceTiming.prototype);
fields(PerformanceNavigationTiming.prototype, ['unloadEventStart',
 'unloadEventEnd', 'domInteractive', 'domContentLoadedEventStart',
 'domContentLoadedEventEnd', 'domComplete', 'loadEventStart', 'loadEventEnd',
 'type', 'redirectCount', 'criticalCHRestart', 'activationStart',
 'notRestoredReasons', 'confidence']);
function navigationEntry(){
 var t = TV, base = t.navigationStart, v = {};
 function rel(x){ return typeof x === 'number' && x ? x - base : 0; }
 v.name = W.location ? String(W.location.href) : 'document';
 v.entryType = 'navigation';
 v.startTime = 0;
 v.duration = rel(t.loadEventEnd);
 v.initiatorType = 'navigation';
 v.deliveryType = '';
 v.nextHopProtocol = '';
 v.workerStart = 0;
 ['redirectStart', 'redirectEnd', 'fetchStart', 'domainLookupStart',
  'domainLookupEnd', 'connectStart', 'connectEnd', 'secureConnectionStart',
  'requestStart', 'responseStart', 'responseEnd', 'unloadEventStart',
  'unloadEventEnd', 'domInteractive', 'domContentLoadedEventStart',
  'domContentLoadedEventEnd', 'domComplete', 'loadEventStart',
  'loadEventEnd'].forEach(function(k){ v[k] = rel(t[k]); });
 v.transferSize = 0;
 v.encodedBodySize = 0;
 v.decodedBodySize = 0;
 v.responseStatus = 200;
 v.renderBlockingStatus = 'non-blocking';
 v.contentType = 'text/html';
 v.type = navigationType;
 v.redirectCount = NAVV.redirectCount;
 v.criticalCHRestart = 0;
 v.activationStart = 0;
 v.notRestoredReasons = null;
 v.confidence = null;
 return make(PerformanceNavigationTiming.prototype, v);
}

/*
 * Every list of entries comes back in chronological order of startTime,
 * not the order they were made. A mark taken now and a measure given an
 * explicit start of 0 are recorded in that order and reported in the
 * other one, which is what a browser does and what code that renders a
 * timeline depends on.
 */
function chronological(list){
 return list.slice().sort(function(a, b){
  return SLOT.get(a).startTime - SLOT.get(b).startTime;
 });
}
function ofType(list, t){
 t = `${t}`;
 return list.filter(function(e){ return SLOT.get(e).entryType === t; });
}
function ofName(list, n, t){
 n = `${n}`;
 return list.filter(function(e){
  var s = SLOT.get(e);
  return s.name === n && (t === undefined || s.entryType === `${t}`);
 });
}

/* --- PerformanceObserver ---------------------------------------------- */
var LIST = new WeakMap();
function PerformanceObserverEntryList(){ illegal(); }
method(PerformanceObserverEntryList.prototype, 'getEntries', function(){
 return LIST.get(this).slice();
});
method(PerformanceObserverEntryList.prototype, 'getEntriesByType',
       function(t){ return ofType(LIST.get(this), t); });
method(PerformanceObserverEntryList.prototype, 'getEntriesByName',
       function(n, t){ return ofName(LIST.get(this), n, t); });
function entryList(list){
 var l = Object.create(PerformanceObserverEntryList.prototype);
 LIST.set(l, chronological(list));
 return l;
}

var OBS = new WeakMap();
function deliver(o){
 var st = OBS.get(o);
 if (!st || st.buffer.length === 0) return;
 var list = st.buffer;
 st.buffer = [];
 try { st.callback.call(o, entryList(list), o); }
 catch (e) { if (NV.__vitaReportError) NV.__vitaReportError(e); }
}
function record(entry){
 entries.push(entry);
 if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
 var type = SLOT.get(entry).entryType;
 var matched = observers.filter(function(o){
  return OBS.get(o).types.indexOf(type) >= 0;
 });
 if (matched.length === 0) return;
 matched.forEach(function(o){ OBS.get(o).buffer.push(entry); });
 /* observer callbacks run as a task, not inline: a page that marks
    inside its own observer must not recurse. */
 Promise.resolve().then(function(){ matched.forEach(deliver); });
}

function PerformanceObserver(callback){
 if (!new.target) throw new TypeError("Failed to construct 'PerformanceObserver': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");
 if (typeof callback !== 'function')
  throw new TypeError("Failed to construct 'PerformanceObserver': The callback provided as parameter 1 is not a function.");
 OBS.set(this, {callback: callback, types: [], buffer: []});
}
method(PerformanceObserver.prototype, 'observe', function(options){
 var st = OBS.get(this);
 options = options || {};
 var types = options.entryTypes
           ? Array.prototype.map.call(options.entryTypes, String)
           : (options.type !== undefined ? [String(options.type)] : []);
 if (types.length === 0)
  throw new TypeError("Failed to execute 'observe' on 'PerformanceObserver': An observe() call must include either entryTypes or type arguments.");
 types.forEach(function(t){ if (st.types.indexOf(t) < 0) st.types.push(t); });
 if (observers.indexOf(this) < 0) observers.push(this);
 if (options.buffered) {
  var past = entries.filter(function(e){
   return types.indexOf(SLOT.get(e).entryType) >= 0;
  });
  if (past.length) {
   st.buffer = st.buffer.concat(past);
   var me = this;
   Promise.resolve().then(function(){ deliver(me); });
  }
 }
});
method(PerformanceObserver.prototype, 'disconnect', function(){
 var i = observers.indexOf(this), st = OBS.get(this);
 if (i >= 0) observers.splice(i, 1);
 st.types = [];
 st.buffer = [];
});
method(PerformanceObserver.prototype, 'takeRecords', function(){
 var st = OBS.get(this), list = st.buffer;
 st.buffer = [];
 return list;
});
Object.defineProperty(PerformanceObserver, 'supportedEntryTypes', {
 get: named(function(){ return ['mark', 'measure', 'navigation']; },
            'get supportedEntryTypes'),
 enumerable: true, configurable: true});

/* --- performance.timing and performance.navigation -------------------- */
function PerformanceTiming(){ illegal(); }
TIMING.forEach(function(k){
 getter(PerformanceTiming.prototype, k, function(){
  slot(this, k);
  return TV[k];
 });
});
method(PerformanceTiming.prototype, 'toJSON', function(){
 slot(this, 'toJSON');
 var o = {};
 TIMING.forEach(function(k){ o[k] = TV[k]; });
 return o;
});
var timing = make(PerformanceTiming.prototype, TV);

function PerformanceNavigation(){ illegal(); }
[['TYPE_NAVIGATE', 0], ['TYPE_RELOAD', 1], ['TYPE_BACK_FORWARD', 2],
 ['TYPE_RESERVED', 255]].forEach(function(c){
 var d = {value: c[1], enumerable: true};
 Object.defineProperty(PerformanceNavigation, c[0], d);
 Object.defineProperty(PerformanceNavigation.prototype, c[0], d);
});
['type', 'redirectCount'].forEach(function(k){
 getter(PerformanceNavigation.prototype, k, function(){
  slot(this, k);
  return NAVV[k];
 });
});
method(PerformanceNavigation.prototype, 'toJSON', function(){
 slot(this, 'toJSON');
 return {type: NAVV.type, redirectCount: NAVV.redirectCount};
});
var navigation = make(PerformanceNavigation.prototype, NAVV);

/* --- Performance itself ----------------------------------------------- */
function Performance(){ illegal(); }
Performance.prototype = Object.create(W.EventTarget ? W.EventTarget.prototype
                                                    : Object.prototype);
var P = Performance.prototype;

/** The time a mark name or a number refers to, for measure(). */
function toTimestamp(v){
 if (typeof v === 'number') {
  if (v < 0) throw new TypeError("'" + v + "' is a negative value.");
  return v;
 }
 var name = `${v}`, i, s;
 if (TIMING.indexOf(name) >= 0) {
  var t = TV[name];
  if (!t) throw W.DOMException
   ? new W.DOMException("'" + name + "' is empty: either the event hasn't happened yet, or it would provide cross-origin timing information.", 'InvalidAccessError')
   : new TypeError(name);
  return t - TV.navigationStart;
 }
 for (i = entries.length - 1; i >= 0; i--) {
  s = SLOT.get(entries[i]);
  if (s.entryType === 'mark' && s.name === name) return s.startTime;
 }
 throw syntaxError("The mark '" + name + "' does not exist.");
}

method(P, 'now', function(){ return now(); });
getter(P, 'timeOrigin', function(){ return t0; });
getter(P, 'timing', function(){ return timing; });
getter(P, 'navigation', function(){ return navigation; });
var onfull = null;
Object.defineProperty(P, 'onresourcetimingbufferfull', {
 get: named(function(){ return onfull; }, 'get onresourcetimingbufferfull'),
 set: named(function(v){
  onfull = typeof v === 'function' || (v !== null && typeof v === 'object')
         ? v : null;
 }, 'set onresourcetimingbufferfull'),
 enumerable: true, configurable: true});
method(P, 'toJSON', function(){
 return {timeOrigin: t0, timing: timing.toJSON(),
         navigation: navigation.toJSON()};
});
method(P, 'mark', function(name, options){
 if (arguments.length < 1) throw new TypeError("Failed to execute 'mark' on 'Performance': 1 argument required, but only 0 present.");
 var m = new PerformanceMark(name, options);
 record(m);
 return m;
});
method(P, 'measure', function(name, start, end){
 if (arguments.length < 1) throw new TypeError("Failed to execute 'measure' on 'Performance': 1 argument required, but only 0 present.");
 name = `${name}`;
 var opts = start !== null && typeof start === 'object' ? start : null, s, e;
 if (opts && (opts.start !== undefined || opts.end !== undefined ||
              opts.duration !== undefined || opts.detail !== undefined)) {
  if (end !== undefined) throw new TypeError("Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, |end_mark| must not be passed.");
  if (opts.start === undefined && opts.end === undefined) throw new TypeError("Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, at least one of its 'start' or 'end' properties must be present.");
  if (opts.start !== undefined && opts.end !== undefined && opts.duration !== undefined) throw new TypeError("Failed to execute 'measure' on 'Performance': If a non-empty PerformanceMeasureOptions object was passed, it must not have all of its 'start', 'duration', and 'end' properties defined");
 } else if (opts) {
  opts = null;
  start = undefined;
 }
 if (end !== undefined) e = toTimestamp(end);
 else if (opts && opts.end !== undefined) e = toTimestamp(opts.end);
 else if (opts && opts.start !== undefined && opts.duration !== undefined)
  e = toTimestamp(opts.start) + toTimestamp(opts.duration);
 else e = now();
 if (opts && opts.start !== undefined) s = toTimestamp(opts.start);
 else if (opts && opts.duration !== undefined && opts.end !== undefined)
  s = e - toTimestamp(opts.duration);
 else if (start !== undefined && !opts) s = toTimestamp(start);
 else s = 0;
 var m = make(PerformanceMeasure.prototype, {name: name, entryType: 'measure',
  startTime: s, duration: e - s, detail: clone(opts ? opts.detail : null)});
 record(m);
 return m;
});
function clearer(type){
 return function(name){
  entries = entries.filter(function(x){
   var d = SLOT.get(x);
   return d.entryType !== type || (name !== undefined && d.name !== `${name}`);
  });
 };
}
method(P, 'clearMarks', clearer('mark'));
method(P, 'clearMeasures', clearer('measure'));
method(P, 'clearResourceTimings', clearer('resource'));
method(P, 'setResourceTimingBufferSize', function(){});
method(P, 'getEntries', function(){ return chronological(entries); });
method(P, 'getEntriesByType', function(t){
 return chronological(ofType(entries, t));
});
method(P, 'getEntriesByName', function(n, t){
 return chronological(ofName(entries, n, t));
});

/*
 * The one object, made here rather than kept from the engine: QuickJS
 * gives the global a performance of its own whose now and timeOrigin
 * are its own properties and cannot be removed. The window's attribute
 * is [Replaceable], an accessor a page may assign over.
 */
var perf = Object.create(P);
Object.defineProperty(W, 'performance', {
 get: named(function(){ return perf; }, 'get performance'),
 set: named(function(v){
  Object.defineProperty(W, 'performance', {value: v, writable: true,
   enumerable: true, configurable: true});
 }, 'set performance'),
 enumerable: true, configurable: true});
if (NV.__vitaWatchPerformance) {
 NV.__vitaWatchPerformance(perf);
 delete NV.__vitaWatchPerformance;
}

/*
 * The document's milestones, from listeners added before any of the
 * page's: DOMContentLoaded is dispatched on the document as it becomes
 * interactive and reaches the window last, and load is dispatched on the
 * window as the document completes. The end of the load event is taken
 * once its listeners have run, and the navigation entry is made then,
 * when every timing it reports has happened. A page asking before then
 * gets one built from what is known so far, which is what a browser
 * gives too.
 */
function stamp(){ return t0 + now(); }
if (W.document) W.document.addEventListener('DOMContentLoaded', function(){
 if (!TV.domInteractive) TV.domInteractive = stamp();
 if (!TV.domContentLoadedEventStart) TV.domContentLoadedEventStart = stamp();
}, true);
W.addEventListener('DOMContentLoaded', function(){
 if (!TV.domContentLoadedEventEnd) TV.domContentLoadedEventEnd = stamp();
});
W.addEventListener('load', function(){
 if (!TV.domComplete) TV.domComplete = stamp();
 if (!TV.loadEventStart) TV.loadEventStart = TV.domComplete;
 Promise.resolve().then(function(){
  if (!TV.loadEventEnd) TV.loadEventEnd = stamp();
  record(navigationEntry());
 });
}, true);

W.Performance = Performance;
W.PerformanceEntry = PerformanceEntry;
W.PerformanceMark = PerformanceMark;
W.PerformanceMeasure = PerformanceMeasure;
W.PerformanceObserver = PerformanceObserver;
W.PerformanceObserverEntryList = PerformanceObserverEntryList;
W.PerformanceResourceTiming = PerformanceResourceTiming;
W.PerformanceTiming = PerformanceTiming;
W.PerformanceNavigation = PerformanceNavigation;
W.PerformanceNavigationTiming = PerformanceNavigationTiming;
})();
