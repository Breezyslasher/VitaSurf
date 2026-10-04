/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl, run the first time a page uses it (VitaSurf).
 *
 * The Intl files (intl_core.js to intl.js) were a fifth of the prelude,
 * read back and run on every page, and most pages never format a date
 * or a number. They are now a unit of their own (prelude_intl_js), and
 * each property they install starts as a lazy one in its place: it
 * looks like the property it stands for -- the same attributes and the
 * same place among its object's keys -- and the first read, write,
 * delete or redefinition of any of them runs the unit, which installs
 * everything as it always did (vita/js/qjs.c, QuickJS's
 * JS_DefineLazyProperty). While the unit runs, a property it has not
 * reached yet reads as what was there before, the prelude's own
 * fallback, which is what it read when it ran with the prelude.
 *
 * Without the bindings or the locale data, the unit runs at once, as
 * the prelude used to run it.
 */
(function(){
var W=window,lazy=W.__vitaLazy,load=W.__vitaLoadUnit,isLazy=W.__vitaIsLazy;
var N=W.__vitaIntl,I=W.Intl;
if(typeof load!=='function')return;
var KEYS=['index','aliases','k:meta','g:meta','l:und','dt:index','tz:index'];
if(typeof lazy!=='function'||typeof isLazy!=='function'||!I||!N||
   typeof N.has!=='function'||
   !KEYS.every(function(k){return N.has(k);})){
 load('intl','the prelude');
 return;}
/* QuickJS's property flags: configurable 1, writable 2, enumerable 4 */
var CW=3,CWE=7;
/* what the unit installs, with the attributes it leaves them with */
var PROPS=[
 [I,'Collator',CWE],[I,'DateTimeFormat',CWE],[I,'DisplayNames',CWE],
 [I,'ListFormat',CWE],[I,'Locale',CWE],[I,'NumberFormat',CWE],
 [I,'PluralRules',CWE],[I,'RelativeTimeFormat',CWE],[I,'Segmenter',CWE],
 [I,'getCanonicalLocales',CWE],[I,'supportedValuesOf',CW],
 [I,'DurationFormat',CWE],
 [Date.prototype,'toLocaleString',CW],[Date.prototype,'toLocaleDateString',CW],
 [Date.prototype,'toLocaleTimeString',CW],
 [Number.prototype,'toLocaleString',CW],
 [String.prototype,'localeCompare',CW]];
if(typeof BigInt==='function')PROPS.push([BigInt.prototype,'toLocaleString',CW]);
var LAZY=[],state=0;	/* 0 not run, 1 running, 2 run */
PROPS.forEach(function(p){
 var o=p[0],n=p[1],has=Object.prototype.hasOwnProperty.call(o,n);
 var e={o:o,n:n,has:has,orig:has?o[n]:undefined};
 if(lazy(o,n,p[2],LAZY.length))LAZY.push(e);});
/* the bindings call this with a lazy property's number; what it returns
   is the property's value, unless it has already been given another */
Object.defineProperty(W,'__vitaLazyInit',{value:function(id){
 var e=LAZY[id];
 if(!e)return undefined;
 if(state===1)return e.orig;
 if(state===0){
  state=1;
  try{load('intl',e.n);}finally{state=2;}}
 if(!isLazy(e.o,e.n))return e.o[e.n];
 if(e.has)return e.orig;
 delete e.o[e.n];
 return undefined;}});
})();
