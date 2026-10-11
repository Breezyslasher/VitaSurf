/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Units of the prelude, run the first time a page uses them (VitaSurf).
 *
 * Intl (intl_core.js to intl.js) was a fifth of the prelude, and streams
 * (streams.js), IndexedDB (idb.js) and WebAssembly (wasm.js) another
 * sixth, read back and run on every page, frame and worker, and most
 * pages never format a date, read a stream, open a database or compile
 * a module. Each is now a unit of its own (prelude_units in
 * vita/js/qjs.c), and each property one installs starts as a lazy one
 * in its place: it looks like the property it stands for -- the same
 * attributes and the same place among its object's keys -- and the
 * first read, write, delete or redefinition of any of them runs the
 * unit, which installs everything as it always did (QuickJS's
 * JS_DefineLazyProperty). While a unit runs, a property it has not
 * reached yet reads as what was there before. The interfaces a unit
 * installs get their WebIDL shape when it has run (interfaces.js,
 * NV.__vitaShapeLater).
 *
 * Without the bindings' lazy properties, every unit runs at once, as
 * the prelude used to run them; Intl does too without its locale data.
 */
(function(){
var W=window,lazy=NV.__vitaLazy,load=NV.__vitaLoadUnit,isLazy=NV.__vitaIsLazy;
var N=NV.__vitaIntl,I=W.Intl;
if(typeof load!=='function')return;
/* QuickJS's property flags: configurable 1, writable 2, enumerable 4 */
var CW=3,CWE=7;
var canLazy=typeof lazy==='function'&&typeof isLazy==='function';
/* each unit: whether it has what it needs, and what it installs, with
   the attributes it leaves them with */
var UNITS={};
var KEYS=['index','aliases','k:meta','g:meta','l:und','dt:index','tz:index'];
UNITS.intl={lazy:!!I&&!!N&&typeof N.has==='function'&&
 KEYS.every(function(k){return N.has(k);}),props:function(){
 var p=[
  [I,'Collator',CWE],[I,'DateTimeFormat',CWE],[I,'DisplayNames',CWE],
  [I,'ListFormat',CWE],[I,'Locale',CWE],[I,'NumberFormat',CWE],
  [I,'PluralRules',CWE],[I,'RelativeTimeFormat',CWE],[I,'Segmenter',CWE],
  [I,'getCanonicalLocales',CWE],[I,'supportedValuesOf',CW],
  [I,'DurationFormat',CWE],
  [Date.prototype,'toLocaleString',CW],[Date.prototype,'toLocaleDateString',CW],
  [Date.prototype,'toLocaleTimeString',CW],
  [Number.prototype,'toLocaleString',CW],
  [String.prototype,'localeCompare',CW]];
 if(typeof BigInt==='function')p.push([BigInt.prototype,'toLocaleString',CW]);
 return p;}};
/* the interfaces end writable, configurable and not enumerable, as
   interfaces.js leaves every interface */
function onWindow(names,flags){
 return names.map(function(n){return [W,n,flags];});}
UNITS.streams={lazy:true,props:function(){
 return onWindow(['ReadableStream','ReadableStreamDefaultReader',
  'ReadableStreamDefaultController','ReadableStreamBYOBReader',
  'ReadableStreamBYOBRequest','WritableStream','WritableStreamDefaultWriter',
  'WritableStreamDefaultController','TransformStream',
  'TransformStreamDefaultController','CountQueuingStrategy',
  'ByteLengthQueuingStrategy','TextDecoderStream','TextEncoderStream'],CW)
  .concat(onWindow(['ReadableByteStreamController'],CWE));}};
UNITS.idb={lazy:!!NV.__vitaIdbNeeds,props:function(){
 return onWindow(['IDBFactory','IDBRequest','IDBOpenDBRequest','IDBDatabase',
  'IDBTransaction','IDBObjectStore','IDBIndex','IDBCursor',
  'IDBCursorWithValue','IDBKeyRange','IDBVersionChangeEvent'],CW)
  .concat(onWindow(['indexedDB'],CWE));}};
UNITS.wasm={lazy:!!NV.__vitaWasm,props:function(){
 return onWindow(['WebAssembly'],CW);}};

var LAZY=[];
Object.keys(UNITS).forEach(function(name){
 var u=UNITS[name];
 u.state=0;	/* 0 not run, 1 running, 2 run */
 if(!canLazy||!u.lazy){
  /* a unit that cannot do without its data still runs, to say so */
  if(u.lazy||name==='intl')run(name,'the prelude');
  else u.state=2;
  return;}
 u.props().forEach(function(p){
  var o=p[0],n=p[1],has=Object.prototype.hasOwnProperty.call(o,n);
  var e={unit:name,o:o,n:n,has:has,orig:has?o[n]:undefined};
  if(lazy(o,n,p[2],LAZY.length))LAZY.push(e);});});

/* run a unit, once; reason is what the page touched */
function run(name,reason){
 var u=UNITS[name];
 if(!u||u.state!==0)return;
 u.state=1;
 try{load(name,reason);}
 finally{
  u.state=2;
  if(typeof NV.__vitaShapeLater==='function')NV.__vitaShapeLater();}}
Object.defineProperty(NV,'__vitaRunUnit',{value:run});

/* the bindings call this with a lazy property's number; what it returns
   is the property's value, unless it has already been given another */
Object.defineProperty(NV,'__vitaLazyInit',{value:function(id){
 var e=LAZY[id],u;
 if(!e)return undefined;
 u=UNITS[e.unit];
 if(u.state===1)return e.orig;
 if(u.state===0)run(e.unit,e.n);
 if(!isLazy(e.o,e.n))return e.o[e.n];
 if(e.has)return e.orig;
 delete e.o[e.n];
 return undefined;}});
})();
