/*
 * The performance timeline, part of the VitaSurf prelude.
 *
 * PerformanceEntry and its subclasses, PerformanceObserver, and the
 * mark/measure half of the Performance object.
 *
 * What was here before was mark, measure, clearMarks and clearMeasures
 * as empty functions and getEntries returning an empty array. That is
 * enough for a page that only instruments itself, and wrong for one that
 * reads its own measurements back: a duration of undefined is not a
 * number, and code that divides by it or sorts on it gets NaN rather
 * than an error it can see.
 */
(function(){
'use strict';
var W = window;
var perf = W.performance;
if (!perf) return;

var entries = [];		/* every entry, in the order they were made */
var navigationId = 'n1';
var navigationType = perf.navigation && perf.navigation.type === 1
                   ? 'reload' : 'navigate';
var observers = [];
var MAX_ENTRIES = 1000;		/* a page that marks in a loop must not grow */

var nextId = 1;

function PerformanceEntry(name, type, start, duration){
 this.name = String(name);
 this.entryType = type;
 this.startTime = start;
 this.duration = duration;
 this.id = 'e' + (nextId++);
 this.navigationId = navigationId;
}
PerformanceEntry.prototype.toJSON = function(){
 return { name: this.name, entryType: this.entryType,
          startTime: this.startTime, duration: this.duration,
          id: this.id, navigationId: this.navigationId };
};

function PerformanceMark(name, options){
 options = options || {};
 var start = options.startTime !== undefined ? Number(options.startTime)
                                             : perf.now();
 if (start < 0) throw new TypeError('startTime cannot be negative');
 PerformanceEntry.call(this, name, 'mark', start, 0);
 this.detail = options.detail !== undefined ? options.detail : null;
}
PerformanceMark.prototype = Object.create(PerformanceEntry.prototype);
PerformanceMark.prototype.constructor = PerformanceMark;

function PerformanceMeasure(name, start, duration, detail){
 PerformanceEntry.call(this, name, 'measure', start, duration);
 this.detail = detail !== undefined ? detail : null;
}
PerformanceMeasure.prototype = Object.create(PerformanceEntry.prototype);
PerformanceMeasure.prototype.constructor = PerformanceMeasure;

function PerformanceResourceTiming(){}
PerformanceResourceTiming.prototype = Object.create(PerformanceEntry.prototype);
PerformanceResourceTiming.prototype.constructor = PerformanceResourceTiming;

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
function PerformanceNavigationTiming(){
 var t = perf.timing || {};
 var base = t.navigationStart || 0;
 function rel(v){ return typeof v === 'number' && v ? v - base : 0; }
 PerformanceEntry.call(this, W.location ? String(W.location.href) : 'document',
                       'navigation', 0, rel(t.loadEventEnd));
 this.initiatorType = 'navigation';
 this.deliveryType = '';
 this.nextHopProtocol = '';
 this.workerStart = 0;
 this.redirectStart = rel(t.redirectStart);
 this.redirectEnd = rel(t.redirectEnd);
 this.fetchStart = rel(t.fetchStart);
 this.domainLookupStart = rel(t.domainLookupStart);
 this.domainLookupEnd = rel(t.domainLookupEnd);
 this.connectStart = rel(t.connectStart);
 this.connectEnd = rel(t.connectEnd);
 this.secureConnectionStart = rel(t.secureConnectionStart);
 this.requestStart = rel(t.requestStart);
 this.responseStart = rel(t.responseStart);
 this.responseEnd = rel(t.responseEnd);
 this.transferSize = 0;
 this.encodedBodySize = 0;
 this.decodedBodySize = 0;
 this.responseStatus = 200;
 this.renderBlockingStatus = 'non-blocking';
 this.contentType = 'text/html';
 this.unloadEventStart = rel(t.unloadEventStart);
 this.unloadEventEnd = rel(t.unloadEventEnd);
 this.domInteractive = rel(t.domInteractive);
 this.domContentLoadedEventStart = rel(t.domContentLoadedEventStart);
 this.domContentLoadedEventEnd = rel(t.domContentLoadedEventEnd);
 this.domComplete = rel(t.domComplete);
 this.loadEventStart = rel(t.loadEventStart);
 this.loadEventEnd = rel(t.loadEventEnd);
 this.type = navigationType;
 this.redirectCount = (perf.navigation && perf.navigation.redirectCount) || 0;
 this.criticalCHRestart = 0;
 this.activationStart = 0;
 this.notRestoredReasons = null;
 this.confidence = null;
}
PerformanceNavigationTiming.prototype =
 Object.create(PerformanceResourceTiming.prototype);
PerformanceNavigationTiming.prototype.constructor = PerformanceNavigationTiming;

/*
 * Every list of entries comes back in chronological order of startTime,
 * not the order they were made. A mark taken now and a measure given an
 * explicit start of 0 are recorded in that order and reported in the
 * other one, which is what a browser does and what code that renders a
 * timeline depends on.
 */
function chronological(list){
 return list.slice().sort(function(a, b){ return a.startTime - b.startTime; });
}

function PerformanceObserverEntryList(list){ this._list = chronological(list); }
PerformanceObserverEntryList.prototype = {
 constructor: PerformanceObserverEntryList,
 getEntries: function(){ return this._list.slice(); },	/* already sorted */
 getEntriesByType: function(t){
  return this._list.filter(function(e){ return e.entryType === String(t); });
 },
 getEntriesByName: function(n, t){
  return this._list.filter(function(e){
   return e.name === String(n) && (t === undefined || e.entryType === String(t));
  });
 }
};

function record(entry){
 entries.push(entry);
 if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
 var matched = observers.filter(function(o){
  return o._types.indexOf(entry.entryType) >= 0;
 });
 if (matched.length === 0) return;
 matched.forEach(function(o){ o._buffer.push(entry); });
 /* observer callbacks run as a task, not inline: a page that marks
    inside its own observer must not recurse. */
 Promise.resolve().then(function(){
  matched.forEach(function(o){
   if (o._buffer.length === 0) return;
   var list = o._buffer; o._buffer = [];
   try { o._callback(new PerformanceObserverEntryList(list), o); }
   catch (e) { if (W.__vitaReportError) W.__vitaReportError(e); }
  });
 });
}

function PerformanceObserver(callback){
 if (typeof callback !== 'function') {
  throw new TypeError('PerformanceObserver needs a callback');
 }
 this._callback = callback;
 this._types = [];
 this._buffer = [];
}
PerformanceObserver.prototype = {
 constructor: PerformanceObserver,
 observe: function(options){
  options = options || {};
  var types = options.entryTypes ? options.entryTypes.map(String)
            : (options.type !== undefined ? [String(options.type)] : []);
  if (types.length === 0) {
   throw new TypeError('observe needs type or entryTypes');
  }
  var self = this;
  types.forEach(function(t){
   if (self._types.indexOf(t) < 0) self._types.push(t);
  });
  if (observers.indexOf(this) < 0) observers.push(this);
  if (options.buffered) {
   var past = entries.filter(function(e){ return types.indexOf(e.entryType) >= 0; });
   if (past.length) {
    this._buffer = this._buffer.concat(past);
    var me = this;
    Promise.resolve().then(function(){
     if (me._buffer.length === 0) return;
     var list = me._buffer; me._buffer = [];
     try { me._callback(new PerformanceObserverEntryList(list), me); }
     catch (e) { if (W.__vitaReportError) W.__vitaReportError(e); }
    });
   }
  }
 },
 disconnect: function(){
  var i = observers.indexOf(this);
  if (i >= 0) observers.splice(i, 1);
  this._types = [];
  this._buffer = [];
 },
 takeRecords: function(){
  var list = this._buffer; this._buffer = [];
  return list;
 }
};
PerformanceObserver.supportedEntryTypes = ['mark', 'measure', 'navigation'];

/** The time a mark name or a number refers to, for measure(). */
function timeFrom(v, what){
 if (v === undefined) return undefined;
 if (typeof v === 'number') return v;
 var name = String(v);
 for (var i = entries.length - 1; i >= 0; i--) {
  if (entries[i].entryType === 'mark' && entries[i].name === name) {
   return entries[i].startTime;
  }
 }
 /* the spec also allows a PerformanceTiming attribute name */
 if (perf.timing && typeof perf.timing[name] === 'number') {
  return perf.timing[name] - (perf.timing.navigationStart || 0);
 }
 var e = new Error("the mark '" + name + "' does not exist");
 e.name = 'SyntaxError';
 void what;
 throw e;
}

perf.mark = function(name, options){
 var m = new PerformanceMark(name, options);
 record(m);
 return m;
};
perf.measure = function(name, startOrOptions, endMark){
 var start, end, detail = null;
 if (startOrOptions !== null && typeof startOrOptions === 'object') {
  var o = startOrOptions;
  detail = o.detail !== undefined ? o.detail : null;
  start = timeFrom(o.start, 'start');
  end = timeFrom(o.end, 'end');
  if (o.duration !== undefined) {
   var d = Number(o.duration);
   if (start === undefined && end !== undefined) start = end - d;
   else if (end === undefined && start !== undefined) end = start + d;
  }
 } else {
  start = timeFrom(startOrOptions, 'start');
  end = timeFrom(endMark, 'end');
 }
 if (start === undefined) start = 0;
 if (end === undefined) end = perf.now();
 var m = new PerformanceMeasure(name, start, end - start, detail);
 record(m);
 return m;
};
perf.clearMarks = function(name){
 entries = entries.filter(function(e){
  return !(e.entryType === 'mark' &&
           (name === undefined || e.name === String(name)));
 });
};
perf.clearMeasures = function(name){
 entries = entries.filter(function(e){
  return !(e.entryType === 'measure' &&
           (name === undefined || e.name === String(name)));
 });
};
perf.clearResourceTimings = function(){
 entries = entries.filter(function(e){ return e.entryType !== 'resource'; });
};
perf.setResourceTimingBufferSize = function(){};
perf.getEntries = function(){ return chronological(entries); };
perf.getEntriesByType = function(t){
 return chronological(entries.filter(function(e){
  return e.entryType === String(t); }));
};
perf.getEntriesByName = function(n, t){
 return chronological(entries.filter(function(e){
  return e.name === String(n) && (t === undefined || e.entryType === String(t));
 }));
};
if (perf.toJSON === undefined) {
 perf.toJSON = function(){
  return { timeOrigin: perf.timeOrigin, timing: perf.timing,
           navigation: perf.navigation };
 };
}

/*
 * The navigation entry is made after load, when the timings it reports
 * have all happened. A page asking before then gets one built from what
 * is known so far, which is what a browser gives too.
 */
W.addEventListener('load', function(){
 Promise.resolve().then(function(){ record(new PerformanceNavigationTiming()); });
});

W.PerformanceEntry = PerformanceEntry;
W.PerformanceMark = PerformanceMark;
W.PerformanceMeasure = PerformanceMeasure;
W.PerformanceObserver = PerformanceObserver;
W.PerformanceObserverEntryList = PerformanceObserverEntryList;
W.PerformanceResourceTiming = PerformanceResourceTiming;
W.PerformanceNavigationTiming = PerformanceNavigationTiming;
})();
