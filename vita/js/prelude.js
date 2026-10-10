/*
 * JavaScript side of the QuickJS bindings: shims that are simplest to
 * express in JS. CMake embeds this file as prelude_js.h and qjs.c runs it
 * once per page context, after the C bindings are installed. Node is a
 * good place to test it: mock Node, document and window and load it.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */
/* BEGIN regexp-split (VitaSurf)
 *
 * String.prototype.split with a regular expression, the way the
 * specification writes it: every call builds a new sticky RegExp from
 * the pattern -- compiling it again -- and then tries a match at every
 * position in turn, reading and writing lastIndex each time. That was
 * 36 % of Wikipedia's script on the device, in many small splits.
 *
 * For a plain RegExp nobody has changed, the result is the same when
 * the pattern is compiled once, kept, and searched forward with exec:
 * a search tries the same positions in the same order and stops at the
 * first that matches, which is where the sticky tries stop too. An
 * empty match where the last piece ended moves on one character, as
 * the specification's does. With the u or v flag a step is a code
 * point, so those, and any RegExp whose exec or constructor has been
 * replaced, go the specification's way. The flags are read as the
 * specification reads them, so a replaced flags counts.
 */
(function(){
var RP=RegExp.prototype,nativeSplit=RP[Symbol.split],nativeExec=RP.exec,
 getProto=Object.getPrototypeOf,
 sourceGet=Object.getOwnPropertyDescriptor(RP,'source').get,
 NativeRegExp=RegExp,cache=new Map(),lastSrc=null,lastFlags=null,lastRe=null;
/* the searching copy of a pattern, compiled once */
function searcher(src,flags){
 var key,re,f='',i,c;
 if(src===lastSrc&&flags===lastFlags)return lastRe;
 key=flags+'/'+src;re=cache.get(key);
 if(re===undefined){
  for(i=0;i<flags.length;i++){c=flags[i];if(c!=='g'&&c!=='y')f+=c;}
  re=new NativeRegExp(src,f+'g');
  if(cache.size>=64)cache.clear();
  cache.set(key,re);}
 lastSrc=src;lastFlags=flags;lastRe=re;
 return re;}
function split(string,limit){
 var rx=this,flags,S,lim,re,A,size,p,q,m,start,e,i,n;
 if(rx===null||typeof rx!=='object')
  return nativeSplit.call(rx,string,limit);
 S=String(string);
 /* Under 32 characters the native split's tries cost less than the
    checks and the loop here, run by the interpreter */
 if(S.length<32)return nativeSplit.call(rx,S,limit);
 /* a RegExp as made, its exec and constructor what they were, read the
    way the specification reads them */
 if(getProto(rx)!==RP||
    rx.constructor!==NativeRegExp||rx.exec!==nativeExec||
    NativeRegExp[Symbol.species]!==NativeRegExp)
  return nativeSplit.call(rx,S,limit);
 flags=String(rx.flags);
 if(flags.indexOf('u')>=0||flags.indexOf('v')>=0)
  return nativeSplit.call(rx,S,limit);
 re=searcher(sourceGet.call(rx),flags);
 A=[];
 lim=(limit===undefined)?4294967295:(limit>>>0);
 if(lim===0)return A;
 size=S.length;
 if(size===0){
  re.lastIndex=0;
  if(nativeExec.call(re,S)!==null)return A;
  A.push(S);return A;}
 p=0;q=0;
 while(q<size){
  re.lastIndex=q;
  m=nativeExec.call(re,S);
  if(m===null)break;
  start=m.index;
  if(start>=size)break;
  e=start+m[0].length;
  if(e>size)e=size;
  if(e===p){q=start+1;continue;}
  A.push(S.substring(p,start));
  if(A.length===lim)return A;
  p=e;
  for(i=1,n=m.length;i<n;i++){A.push(m[i]);if(A.length===lim)return A;}
  q=p;}
 A.push(S.substring(p,size));
 return A;}
Object.defineProperty(RP,Symbol.split,{value:split,writable:true,
 enumerable:false,configurable:true});
Object.defineProperty(split,'name',{value:'[Symbol.split]'});
})();
/* END regexp-split */
(function(){
var P=Node.prototype;
function priv(o,k,make){if(!Object.prototype.hasOwnProperty.call(o,k))Object.defineProperty(o,k,{value:make(),writable:true});return o[k];}
/*
 * Every property below is on Node.prototype, because every node here
 * shares one prototype. A component that keeps its own state in a
 * property whose name happens to match an HTML attribute -- data, list,
 * label, index, mode, clear -- would have that state stringified into an
 * attribute and read back as a string, and then fail somewhere else
 * entirely when it called what it had stored. So a reflected property
 * that is handed a function or an object stops reflecting on that node
 * and becomes an ordinary own property, which is what the component
 * meant. Strings, numbers and booleans still reflect, which is every use
 * the attribute itself has.
 */
function shadowProp(o,k,v){
 Object.defineProperty(o,k,{configurable:true,writable:true,enumerable:true,value:v});
 return v;}
function isOwnState(v){return typeof v==='function'||(v!==null&&typeof v==='object');}
/*
 * The other half of the same problem. A reflected property belongs to
 * the elements the specification gives it to, and a custom element is
 * not one of them: <x-thing>.label is the component's own property, and
 * a browser makes it an ordinary one. Here every property sits on the
 * one shared prototype, so label on a custom element was writing an
 * attribute and reading a string back -- and a framework that rescues
 * the properties set before its definition loaded found nothing to
 * rescue, because hasOwnProperty said the value was never there.
 *
 * So the reflected properties apply on the HTML elements that have them
 * and behave as ordinary properties everywhere else. The global
 * attributes -- the ones HTMLElement itself defines -- keep applying
 * everywhere, custom elements included, because that is where the
 * specification puts them too.
 */
var HTML_TAGS=(' A ABBR ACRONYM ADDRESS APPLET AREA ARTICLE ASIDE AUDIO B BASE '+
 'BASEFONT BDI BDO BIG BLOCKQUOTE BODY BR BUTTON CANVAS CAPTION CENTER CITE '+
 'CODE COL COLGROUP DATA DATALIST DD DEL DETAILS DFN DIALOG DIR DIV DL DT EM '+
 'EMBED FIELDSET FIGCAPTION FIGURE FONT FOOTER FORM FRAME FRAMESET H1 H2 H3 H4 '+
 'H5 H6 HEAD HEADER HGROUP HR HTML I IFRAME IMG INPUT INS ISINDEX KBD KEYGEN '+
 'LABEL LEGEND LI LINK MAIN MAP MARK MARQUEE MENU META METER NAV NOBR NOFRAMES '+
 'NOSCRIPT OBJECT OL OPTGROUP OPTION OUTPUT P PARAM PICTURE PLAINTEXT PRE '+
 'PROGRESS Q RP RT RUBY S SAMP SCRIPT SEARCH SECTION SELECT SLOT SMALL SOURCE '+
 'SPAN STRIKE STRONG STYLE SUB SUMMARY SUP TABLE TBODY TD TEMPLATE TEXTAREA '+
 'TFOOT TH THEAD TIME TITLE TR TRACK TT U UL VAR VIDEO WBR XMP ');
var GLOBAL_ATTRS=(' accessKey autocapitalize autocorrect autofocus contentEditable '+
 'dir draggable enterKeyHint hidden inert inputMode lang nonce popover slot '+
 'spellcheck tabIndex title translate writingSuggestions itemScope ');
/* A call the engine only pretends to answer is counted and named in the
   log, so a page that comes out wrong says what it wanted rather than
   leaving it to be guessed at. */
function GAP(name,fn){return function(){
 try{if(typeof __vitaGap==='function')__vitaGap(name);}catch(e){}
 return fn?fn.apply(this,arguments):undefined;};}
function reflectsOn(el,prop){
 if(GLOBAL_ATTRS.indexOf(' '+prop+' ')>=0)return true;
 var t=el.tagName;
 return t!==undefined&&HTML_TAGS.indexOf(' '+t+' ')>=0;}
Object.defineProperty(P,'style',{configurable:true,get:function(){return priv(this,'__style',function(){return {getPropertyValue:function(){return '';},setProperty:function(){},removeProperty:function(){},cssText:''};});}});
Object.defineProperty(P,'dataset',{configurable:true,get:function(){return priv(this,'__dataset',function(){return {};});}});
Object.defineProperty(P,'classList',{configurable:true,get:function(){var el=this;return {contains:function(c){return (' '+el.className+' ').indexOf(' '+c+' ')>=0;},add:function(){for(var i=0;i<arguments.length;i++){if(!this.contains(arguments[i]))el.className=(el.className?el.className+' ':'')+arguments[i];}},remove:function(){for(var i=0;i<arguments.length;i++){el.className=(' '+el.className+' ').split(' '+arguments[i]+' ').join(' ').trim();}},toggle:function(c,f){var h=this.contains(c);if(f===undefined)f=!h;if(f&&!h)this.add(c);else if(!f&&h)this.remove(c);return f;},get length(){return el.className?el.className.split(/\s+/).length:0;}};}});
Object.defineProperty(P,'children',{configurable:true,get:function(){return this.childNodes.filter(function(n){return n.nodeType===1;});}});
Object.defineProperty(P,'firstElementChild',{configurable:true,get:function(){var c=this.children;return c.length?c[0]:null;}});
Object.defineProperty(P,'lastElementChild',{configurable:true,get:function(){var c=this.children;return c.length?c[c.length-1]:null;}});
Object.defineProperty(P,'parentElement',{configurable:true,get:function(){var p=this.parentNode;return p&&p.nodeType===1?p:null;}});
Object.defineProperty(P,'innerText',{configurable:true,get:function(){return this.textContent;},set:function(v){this.textContent=v;}});
Object.defineProperty(P,'outerHTML',{configurable:true,get:function(){return '';}});
/* A canvas, an image and a video report width and height as numbers,
   and a charting library does arithmetic with them: as strings every
   size it worked out came out as text joined together (VitaSurf). */
var NUMERIC_SIZE=' CANVAS IMG VIDEO ';
['width','height'].forEach(function(a){Object.defineProperty(P,a,{configurable:true,
 get:function(){if(NUMERIC_SIZE.indexOf(' '+this.tagName+' ')<0)return undefined;
  var v=this.getAttribute(a);
  if(v===null||v==='')return this.tagName==='CANVAS'?(a==='width'?300:150):0;
  var n=parseInt(v,10);return isNaN(n)?0:n;},
 set:function(v){if(NUMERIC_SIZE.indexOf(' '+this.tagName+' ')<0)
   return shadowProp(this,a,v);
  this.setAttribute(a,String(Math.max(0,Math.round(Number(v))||0)));}});});
['value','type','name','title','alt','rel','target','method','placeholder','lang','dir','htmlFor','content','charset','width','height'].forEach(function(a){var attr=a==='htmlFor'?'for':a;
 /* width and height on a canvas, an image or a video are numbers, and
    the accessors above already answer for those elements */
 var numeric=(a==='width'||a==='height');
 Object.defineProperty(P,a,{configurable:true,get:function(){
  if(numeric&&NUMERIC_SIZE.indexOf(' '+this.tagName+' ')>=0){
   var nv=this.getAttribute(a);
   if(nv===null||nv==='')return this.tagName==='CANVAS'?(a==='width'?300:150):0;
   var nn=parseInt(nv,10);return isNaN(nn)?0:nn;}
  if(!reflectsOn(this,a))return undefined;var v=this.getAttribute(attr);return v===null?'':v;},set:function(v){if(isOwnState(v)||!reflectsOn(this,a))return shadowProp(this,a,v);this.setAttribute(attr,String(v));}});});
/* The URL-valued attributes reflect as resolved absolute URLs, not as
 * written. getAttribute still gives what the document said. Code tests
 * these against a scheme -- webpack decides its public path by matching
 * a script's src against /^https?:/ -- and a relative one fails that
 * test where the browser it was written for would have passed. */
['href','src','action','formaction','poster','cite','data','background','longdesc'].forEach(function(a){
 Object.defineProperty(P,a,{configurable:true,get:function(){
  if(!reflectsOn(this,a))return undefined;
  var v=this.getAttribute(a);
  if(v===null||v==='')return '';
  try{return new URL(v,D.baseURI).href;}catch(e){return v;}
 },set:function(v){if(isOwnState(v)||!reflectsOn(this,a))return shadowProp(this,a,v);this.setAttribute(a,String(v));}});});
['disabled','checked','hidden','readOnly','selected','multiple','required'].forEach(function(a){var attr=a.toLowerCase();Object.defineProperty(P,a,{configurable:true,get:function(){if(!reflectsOn(this,a))return undefined;return this.hasAttribute(attr);},set:function(v){if(isOwnState(v)||!reflectsOn(this,a))return shadowProp(this,a,v);if(v)this.setAttribute(attr,'');else this.removeAttribute(attr);}});});
/* Layout geometry. __vitaBox(node) (qjs.c) returns the element's laid-out
   box as [x,y,width,height,clientWidth,clientHeight,clientLeft,clientTop,
   scrollWidth,scrollHeight,scrollLeft,scrollTop] in CSS px, document
   coordinates, border box; null when the element has no box. viewport()
   returns [scrollX,scrollY,viewportWidth,viewportHeight]. */
function boxOf(el){var b=__vitaBox(el);return b||[0,0,0,0,0,0,0,0,0,0,0,0];}
function viewport(){return __vitaScroll()||[0,0,960,544];}
function isViewportEl(el){return el===D.documentElement;}
var BOXIDX={offsetWidth:2,offsetHeight:3,clientLeft:6,clientTop:7,scrollWidth:8,scrollHeight:9};
Object.keys(BOXIDX).forEach(function(a){var i=BOXIDX[a];Object.defineProperty(P,a,{configurable:true,get:function(){return boxOf(this)[i];}});});
['clientWidth','clientHeight'].forEach(function(a,n){Object.defineProperty(P,a,{configurable:true,get:function(){if(isViewportEl(this)){return viewport()[2+n];}return boxOf(this)[4+n];}});});
Object.defineProperty(P,'offsetParent',{configurable:true,get:function(){var n=this.parentNode;while(n&&n.nodeType===1&&n!==D.body&&n!==D.documentElement)n=n.parentNode;return n&&n.nodeType===1?n:null;}});
['offsetTop','offsetLeft'].forEach(function(a,n){Object.defineProperty(P,a,{configurable:true,get:function(){var b=__vitaBox(this);if(!b)return 0;var p=this.offsetParent,pb=p?__vitaBox(p):null;return b[1-n]-(pb?pb[1-n]:0);}});});
['scrollTop','scrollLeft'].forEach(function(a,n){Object.defineProperty(P,a,{configurable:true,get:function(){if(isViewportEl(this)||this===D.body){return viewport()[1-n];}return boxOf(this)[11-n];},set:function(v){if(isViewportEl(this)||this===D.body){var s=viewport();__vitaScrollTo(n===1?Number(v)||0:s[0],n===1?s[1]:Number(v)||0);}
 /* a box that scrolls its own content (VitaSurf) */
 else if(typeof __vitaScrollElement==='function')__vitaScrollElement(this,n===1?Number(v)||0:null,n===1?null:Number(v)||0);}});});
P.tabIndex=0;
['onclick','onchange','onsubmit','oninput','onkeydown','onkeyup','onkeypress','onmousedown','onmouseup','onmouseover','onmouseout','onfocus','onblur','onload','onerror','ontouchstart','ontouchend'].forEach(function(h){Object.defineProperty(P,h,{configurable:true,get:function(){return this['__'+h]||null;},set:function(f){this['__'+h]=f;if(typeof f==='function')this.addEventListener(h.slice(2),function(e){return f.call(this,e);});}});});
P.getBoundingClientRect=function(){var b=__vitaBox(this);if(!b)return {top:0,left:0,right:0,bottom:0,width:0,height:0,x:0,y:0};var s=b[12]?[0,0]:viewport(),x=b[0]-s[0],y=b[1]-s[1];return {x:x,y:y,left:x,top:y,width:b[2],height:b[3],right:x+b[2],bottom:y+b[3]};};
P.getClientRects=function(){var r=this.getBoundingClientRect();return r.width||r.height?[r]:[];};
P.focus=P.blur=P.select=function(){};
P.scrollIntoView=function(arg){var b=__vitaBox(this);if(!b)return;var s=viewport(),toEnd=(arg===false)||(arg&&(arg.block==='end'||arg.block==='nearest'&&b[1]<s[1]));__vitaScrollTo(s[0],toEnd?b[1]+b[3]-s[3]:b[1]);};
/* A disabled form control is not clickable: click() on one dispatches
   nothing at all. Dispatching a click at it explicitly still works,
   which is the difference the tests turn on. */
/* The events this browser fires itself are trusted, as a browser's are,
   and the ones a page makes are not (VitaSurf). isTrusted said false for
   every event, so a page that only answers the browser -- the claude.ai
   challenge's widget takes no message a page could have forged -- heard
   nothing. Kept here, where no page can add to it. */
var TRUSTED=new WeakSet();
function uaEvent(e){try{TRUSTED.add(e);}catch(x){}return e;}
/* each event's own, and not to be redefined, as [LegacyUnforgeable] has
   it: a page cannot make its own event claim to be the browser's */
function trustedGet(){return TRUSTED.has(this);}
function ownTrust(e){
 try{Object.defineProperty(e,'isTrusted',{get:trustedGet,enumerable:true,
  configurable:false});}catch(x){}}

var FORM_CONTROLS=' BUTTON INPUT SELECT TEXTAREA FIELDSET OPTGROUP OPTION ';
function isDisabledControl(el){
 return !!el&&el.nodeType===1&&
  FORM_CONTROLS.indexOf(' '+el.tagName+' ')>=0&&!!el.disabled;}
P.click=function(){
 if(isDisabledControl(this))return true;
 var e=new MouseEvent('click',{bubbles:true,cancelable:true,composed:true});
 return this.dispatchEvent(e);};
P.contains=function(n){
 var f=typeof window.__vitaIsAncestor==='function'?window.__vitaIsAncestor(this,n):undefined;
 if(f!==undefined)return f;
 while(n){if(n===this)return true;n=n.parentNode;}return false;};
/* jQuery sorts selector results with this, so a missing one takes out
   every script that uses jQuery's own selector engine. */
P.compareDocumentPosition=function(other){
 if(other===this)return 0;
 if(!other||other.nodeType===undefined)return 1;
 var a=[],b=[],n,i;
 for(n=this;n;n=n.parentNode)a.unshift(n);
 for(n=other;n;n=n.parentNode)b.unshift(n);
 if(a[0]!==b[0])return 1+32;
 if(a.indexOf(other)>=0)return 8+2;
 if(b.indexOf(this)>=0)return 16+4;
 i=0;while(a[i]&&b[i]&&a[i]===b[i])i++;
 var pa=a[i],pb=b[i];
 if(!pa)return 16+4;
 if(!pb)return 8+2;
 for(n=pa;n;n=n.nextSibling)if(n===pb)return 4;
 return 2;};
P.hasChildNodes=function(){return this.firstChild!==null;};
P.remove=function(){var p=this.parentNode;if(p)p.removeChild(this);};
P.getElementsByClassName=function(c){return this.querySelectorAll('.'+c);};
/* Selector engine. Matching walks upwards from a candidate rather than
   down from the root, and the candidates come from getElementsByTagName,
   which is a single call into libdom. A tree walk in JavaScript over a
   document the size of a Wikipedia article costs seconds on the Vita. */
/* No pseudo part here on purpose. Matching a pseudo's optional nested
   parentheses inside a repeated group backtracks exponentially, and
   p:not(.y) was enough to exhaust the regexp engine. The compound is cut
   at its first pseudo below, and the pseudos are read separately. */
/* An identifier may carry CSS escapes: a backslash and up to six hex
   digits for a code point, or a backslash and any one character taken
   literally. Tailwind's own class names need this -- md:w-1/2 is written
   .md\:w-1\/2 in a selector -- and without it the whole compound failed
   to parse and matched nothing. */
/* Anything above ASCII is an identifier character in CSS with no escape
   needed, which is how a class name in another script is written. */
var ICH='(?:[\\w-]|[^\\x00-\\x7f]|'+
 '\\\\[0-9a-fA-F]{1,6}(?:\\r\\n|[ \\t\\r\\n\\f])?|\\\\[^\\n])';
/* How many characters the escape starting at i occupies. A hex escape
   swallows one whitespace character after its digits, and that space is
   part of the escape rather than a separator -- reading it as one split
   #\\30 nextIsWhiteSpace in half. */
function escLen(t,i){
 var j=i+1,n=0;
 while(j<t.length&&n<6&&/[0-9a-fA-F]/.test(t.charAt(j))){j++;n++;}
 if(n===0)return 2;
 if(j<t.length&&/[ \t\r\n\f]/.test(t.charAt(j))){
  if(t.charAt(j)==='\r'&&t.charAt(j+1)==='\n')j++;
  j++;}
 return j-i;}
var SIMPLE_RE=new RegExp('^([a-zA-Z]'+ICH+'*|\\*)?(#'+ICH+'+)?((?:\\.'+
 ICH+'+)*)((?:\\[[^\\]]*\\])*)$');
function unescapeIdent(t){
 if(String(t).indexOf('\\')<0)return String(t);
 return String(t).replace(
  /\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\n])/g,
  function(m,hex,ch){
   if(hex===undefined)return ch;
   var cp=parseInt(hex,16);
   if(cp===0||cp>0x10FFFF||(cp>=0xD800&&cp<=0xDFFF))return '�';
   return String.fromCodePoint?String.fromCodePoint(cp):String.fromCharCode(cp);});}
var ATTR_RE=/\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*("[^"]*"|'[^']*'|[^\]]*?)\s*)?\]/g;
/* The argument is matched as a run without parentheses rather than as an
   alternation inside a star: the nested form backtracks exponentially and
   took the regexp engine out on :not(.y). A pseudo whose argument itself
   carries parentheses is left to the default below. */
var PSEUDO_RE=/(::?)([\w-]+)(?:\(([^()]*)\))?/g;
/* A pseudo-element selects no element, so a selector carrying one matches
   nothing, which is what a browser returns for it. */
var PSEUDO_ELEMENTS=' before after marker placeholder selection backdrop '+
 'first-line first-letter file-selector-button ';
/* Where the pseudos start: the first colon outside brackets, parentheses
   and quotes, so [href="a:b"] and :not(:first-child) both survive. */
function pseudoStart(sel){
 var depth=0,quote=null,i,ch;
 for(i=0;i<sel.length;i++){
  ch=sel.charAt(i);
  if(ch==='\\'){i+=escLen(sel,i)-1;continue;}
  if(quote!==null){if(ch===quote)quote=null;continue;}
  if(ch==='"'||ch==="'"){quote=ch;continue;}
  if(ch==='['||ch==='(')depth++;
  else if(ch===']'||ch===')')depth--;
  else if(ch===':'&&depth===0)return i;}
 return -1;}
function parseSimple(sel){
 var cut=pseudoStart(sel);
 var head=cut<0?sel:sel.slice(0,cut);
 var tail=cut<0?'':sel.slice(cut);
 var m=SIMPLE_RE.exec(head);if(!m)return null;
 var attrs=[],a;ATTR_RE.lastIndex=0;
 while(m[4]&&(a=ATTR_RE.exec(m[4]))){attrs.push({name:unescapeIdent(a[1]),op:a[2]||null,
  val:a[3]===undefined?null:unescapeIdent(String(a[3]).replace(/^["']|["']$/g,''))});}
 /* Read every pseudo out first, then compile the ones that take a
    selector. PSEUDO_RE is shared and global, so recursing into compile
    from inside its own exec loop resets lastIndex and the loop never
    ends -- which is what :not(.y) did. */
 var pseudos=[],raw=[],pm;PSEUDO_RE.lastIndex=0;
 while(tail&&(pm=PSEUDO_RE.exec(tail))){
  raw.push([pm[1],pm[2].toLowerCase(),pm[3]===undefined?null:pm[3]]);}
 raw.forEach(function(r){
  var name=r[1],arg=r[2],sub=null;
  if(name==='not'||name==='is'||name==='matches'||name==='where'||name==='has'){
   sub=compile(arg||'');}
  pseudos.push({name:name,arg:arg,sub:sub,
   element:r[0]==='::'||PSEUDO_ELEMENTS.indexOf(' '+name+' ')>=0});});
 /* the class list is split on unescaped dots only */
 var classes=[];
 if(m[3]){
  var buf='',k,c;
  for(k=0;k<m[3].length;k++){
   c=m[3].charAt(k);
   if(c==='\\'){buf+=c+m[3].charAt(++k);continue;}
   if(c==='.'){if(buf!=='')classes.push(unescapeIdent(buf));buf='';continue;}
   buf+=c;}
  if(buf!=='')classes.push(unescapeIdent(buf));}
 /* A type selector is case insensitive only for HTML elements, so both
    spellings are kept: tagName is upper case for HTML and as written for
    foreign elements such as those inside an inline <svg>. */
 return {tag:m[1]&&m[1]!=='*'?unescapeIdent(m[1]):null,
  tagUpper:m[1]&&m[1]!=='*'?unescapeIdent(m[1]).toUpperCase():null,
  id:m[2]?unescapeIdent(m[2].slice(1)):null,
  classes:classes,attrs:attrs,pseudos:pseudos};}
var HTML_NS='http://www.w3.org/1999/xhtml';
function attrOk(el,q){var v=el.getAttribute(q.name);if(v===null)return false;if(!q.op)return true;
 switch(q.op){case '=':return v===q.val;case '^=':return v.indexOf(q.val)===0;
 case '$=':return q.val.length<=v.length&&v.indexOf(q.val,v.length-q.val.length)>=0;
 case '*=':return v.indexOf(q.val)>=0;
 case '~=':return (' '+v+' ').indexOf(' '+q.val+' ')>=0;
 case '|=':return v===q.val||v.indexOf(q.val+'-')===0;default:return false;}}
/* A class attribute is split on ASCII whitespace, not on the space
   character alone: a tab or a newline between two names separates them
   too. */
var CLASS_WS=/[ \t\r\n\f]+/;
function classSet(el){
 var cn=el.getAttribute?el.getAttribute('class'):null;
 return cn?String(cn).split(CLASS_WS).filter(function(x){return x!=='';}):[];}
function prevEl(n){for(n=n.previousSibling;n;n=n.previousSibling)if(n.nodeType===1)return n;return null;}
function nextEl(n){for(n=n.nextSibling;n;n=n.nextSibling)if(n.nodeType===1)return n;return null;}
function elIndex(el){var i=1,n=prevEl(el);while(n){i++;n=prevEl(n);}return i;}
function elIndexEnd(el){var i=1,n=nextEl(el);while(n){i++;n=nextEl(n);}return i;}
function typeIndex(el,back){var i=1,n=back?nextEl(el):prevEl(el);
 while(n){if(n.tagName===el.tagName)i++;n=back?nextEl(n):prevEl(n);}return i;}
/* an+b, and the odd and even that stand for 2n+1 and 2n. */
function nthOk(arg,i){
 arg=String(arg===null||arg===undefined?'':arg).replace(/\s+/g,'').toLowerCase();
 if(arg==='odd')return i%2===1;
 if(arg==='even')return i%2===0;
 var m=/^([+-]?\d*)n([+-]\d+)?$/.exec(arg);
 if(m){
  var a=(m[1]===''||m[1]==='+')?1:(m[1]==='-'?-1:parseInt(m[1],10));
  var b=m[2]?parseInt(m[2],10):0;
  if(a===0)return i===b;
  var k=(i-b)/a;
  return k>=0&&k===Math.floor(k);}
 var n=parseInt(arg,10);
 return !isNaN(n)&&i===n;}
function anyGroup(el,groups){
 for(var i=0;i<groups.length;i++)if(matchAt(el,groups[i],groups[i].length-1))return true;
 return false;}
function hasDescendant(el,groups){
 var c=el.childNodes,i;
 for(i=0;i<c.length;i++){
  if(c[i].nodeType!==1)continue;
  if(anyGroup(c[i],groups)||hasDescendant(c[i],groups))return true;}
 return false;}
/* Whether a popover is shown: the element's own state, kept in C where
   :popover-open in the style sheets reads it too (VitaSurf). */
var POPQ=typeof window!=='undefined'&&typeof window.__vitaPopover==='function'?
 window.__vitaPopover:null;
function focusIn(el,within){
 var f=typeof focused!=='undefined'?focused:null,n,p,h;
 if(!f||!ceInDoc(f))return false;
 if(f===el)return true;
 for(n=f;n;){
  p=n.parentNode;
  if(!p){h=shadowHost(n);if(h===el)return true;n=h;continue;}
  if(within&&p===el)return true;
  n=p;}
 return false;}
function popoverShown(el){
 return !!POPQ&&el.hasAttribute('popover')&&POPQ(el)===true;}
function pseudoOk(el,p){
 if(p.element)return false;
 switch(p.name){
 case 'not':return !anyGroup(el,p.sub);
 case 'is':case 'matches':case 'where':return anyGroup(el,p.sub);
 case 'has':return hasDescendant(el,p.sub);
 case 'first-child':return prevEl(el)===null;
 case 'last-child':return nextEl(el)===null;
 case 'only-child':return prevEl(el)===null&&nextEl(el)===null;
 case 'first-of-type':return typeIndex(el)===1;
 case 'last-of-type':return typeIndex(el,true)===1;
 case 'only-of-type':return typeIndex(el)===1&&typeIndex(el,true)===1;
 case 'nth-child':return nthOk(p.arg,elIndex(el));
 case 'nth-last-child':return nthOk(p.arg,elIndexEnd(el));
 case 'nth-of-type':return nthOk(p.arg,typeIndex(el));
 case 'nth-last-of-type':return nthOk(p.arg,typeIndex(el,true));
 case 'empty':
  for(var i=0,c=el.childNodes;i<c.length;i++){
   if(c[i].nodeType===1)return false;
   if(c[i].nodeType===3&&String(c[i].textContent)!=='')return false;}
  return true;
 case 'root':return el===D.documentElement;
 case 'checked':return el.hasAttribute('checked')||el.hasAttribute('selected');
 case 'disabled':return el.hasAttribute('disabled');
 case 'enabled':return !el.hasAttribute('disabled');
 case 'required':return el.hasAttribute('required');
 case 'optional':return !el.hasAttribute('required');
 case 'read-only':return el.hasAttribute('readonly')||el.hasAttribute('disabled');
 case 'read-write':return !el.hasAttribute('readonly')&&!el.hasAttribute('disabled');
 case 'link':case 'any-link':
  return (el.tagName==='A'||el.tagName==='AREA')&&el.hasAttribute('href');
 case 'defined':return true;
 case 'scope':return true;
 case 'popover-open':return popoverShown(el);
 case 'open':
  return (el.tagName==='DETAILS'||el.tagName==='DIALOG')&&el.hasAttribute('open');
 /* what has focus, which a shadow host matches :focus for while it is
    in its tree, as the style sheets have it */
 case 'focus':return focusIn(el,false);
 case 'focus-within':return focusIn(el,true);
 case 'focus-visible':
  return focusIn(el,false)&&focused===el&&(el.tagName==='TEXTAREA'||
   (el.tagName==='INPUT'&&!/^(button|submit|reset|checkbox|radio|image|file|range|color)$/i.test(el.type||'')));
 /* Nothing here has a pointer or a history. */
 case 'hover':
 case 'active':case 'visited':case 'target':case 'indeterminate':
  return false;
 default:return true;}}
function matchSimple(el,q){if(el.nodeType!==1)return false;
 if(q.tag){var ns=el.namespaceURI;
  if(ns===null||ns===undefined||ns===HTML_NS){
   if(el.tagName!==q.tagUpper)return false;
  }else if(el.tagName!==q.tag){return false;}}
 if(q.id&&el.id!==q.id)return false;
 if(q.classes.length){
  var set=classSet(el);
  if(!set.length)return false;
  for(var i=0;i<q.classes.length;i++)if(set.indexOf(q.classes[i])<0)return false;}
 for(var j=0;j<q.attrs.length;j++)if(!attrOk(el,q.attrs[j]))return false;
 for(var k=0;k<q.pseudos.length;k++)if(!pseudoOk(el,q.pseudos[k]))return false;
 return true;}
/* Does el match parts[0..i], with parts[i] applying to el? The walk goes
   right to left and backtracks, because a descendant or sibling step that
   matches the nearest candidate is not always the one that lets the rest
   of the selector match. */
function matchAt(el,parts,i){
 if(!matchSimple(el,parts[i].sel))return false;
 if(i===0)return true;
 var comb=parts[i].comb,n;
 if(comb==='>'){n=el.parentNode;return !!n&&n.nodeType===1&&matchAt(n,parts,i-1);}
 if(comb==='+'){n=prevEl(el);return !!n&&matchAt(n,parts,i-1);}
 if(comb==='~'){for(n=prevEl(el);n;n=prevEl(n))if(matchAt(n,parts,i-1))return true;return false;}
 for(n=el.parentNode;n&&n.nodeType===1;n=n.parentNode)if(matchAt(n,parts,i-1))return true;
 return false;}
/* A selector becomes a list of groups, each a list of compounds carrying
   the combinator that joins it to the one before. The combinator used to
   be split out and thrown away, so a child selector matched any
   descendant and a sibling selector matched nothing at all. */
/* Split on a character only where it is not inside brackets, parentheses
   or quotes: a regex split breaks [rel~="b"] at the ~ and :not(a,b) at
   the comma, and both are ordinary selectors. */
function splitTop(s,chars,keep){
 var out=[],buf='',depth=0,quote=null,i,ch;
 for(i=0;i<s.length;i++){
  ch=s.charAt(i);
  if(ch==='\\'){var el=escLen(s,i);buf+=s.substr(i,el);i+=el-1;continue;}
  if(quote!==null){buf+=ch;if(ch===quote)quote=null;continue;}
  if(ch==='"'||ch==="'"){quote=ch;buf+=ch;continue;}
  if(ch==='['||ch==='('){depth++;buf+=ch;continue;}
  if(ch===']'||ch===')'){depth--;buf+=ch;continue;}
  if(depth===0&&chars.indexOf(ch)>=0){
   if(buf.replace(/^\s+|\s+$/g,'')!=='')out.push(buf.replace(/^\s+|\s+$/g,''));
   if(keep&&ch!==' '&&ch!=='\t'&&ch!=='\n'&&ch!=='\r'&&ch!=='\f')out.push(ch);
   buf='';continue;}
  buf+=ch;}
 if(buf.replace(/^\s+|\s+$/g,'')!=='')out.push(buf.replace(/^\s+|\s+$/g,''));
 return out;}
/* Compiled selectors, by their text (VitaSurf). Every querySelector,
   matches and closest used to parse its selector afresh, and closest
   did so once per ancestor; a GitHub hydration job spent 7.8 seconds
   of its 20 in this parser and was stopped by the budget. Nothing
   writes into a compiled selector after compile returns, so one copy
   serves every call. Bounded, and simply emptied when full: a page
   uses a few hundred distinct selectors, not thousands. A selector
   that fails to parse is cached as its empty result too, so it keeps
   failing the same way. */
var compiled={},compiledCount=0,compiledHits=0;
/* Cache hits are counted here and handed to C in batches: a crossing
   per call was a real share of a call that finds its answer in C. */
function countHits(){
 if(compiledHits&&typeof __vitaSelector==='function')__vitaSelector(1,compiledHits);
 compiledHits=0;}
/* A selector the general path keeps being asked for is named in the
   log at 1024 uses and each doubling after, so the next fast path is
   chosen from a log rather than guessed (VitaSurf). */
function noteSlow(g,text){
 var n=g.slow=(g.slow|0)+1;
 if(n>=1024&&(n&(n-1))===0&&typeof __vitaSelector==='function')__vitaSelector(6,n,text);}
function compile(selector){
 var text=String(selector),hit=compiled[text];
 if(hit!==undefined){
  if(++compiledHits>=256)countHits();
  if(!hit.bare)noteSlow(hit,text);
  return hit;}
 countHits();
 if(typeof __vitaSelector==='function')__vitaSelector(0);
 if(compiledCount>=512){compiled={};compiledCount=0;}
 hit=compileUncached(text);
 hit.bare=bareTag(hit);
 compiled[text]=hit;compiledCount++;
 return hit;}
/* The one simple selector of a selector that is nothing but an ASCII
   tag name, or null. Those are answered by __vitaTagQuery in C. */
function bareTag(groups){
 if(groups.length!==1||groups[0].length!==1)return null;
 var q=groups[0][0].sel;
 if(!q.tag||q.tag==='*'||q.id||q.classes.length||q.attrs.length||q.pseudos.length)return null;
 return /^[A-Za-z][A-Za-z0-9_-]*$/.test(q.tag)?q:null;}
/* The C answer for a bare tag selector already compiled, or undefined
   to take the general path: mode 0 matches, 1 first, 2 all. */
var tagQuery=typeof __vitaTagQuery==='function'?__vitaTagQuery:null;
function tagFast(el,sel,mode){
 if(tagQuery===null)return undefined;
 var g=compiled[typeof sel==='string'?sel:String(sel)];
 if(g===undefined||!g.bare)return undefined;
 if(++compiledHits>=256)countHits();
 return tagQuery(el,g.bare.tag,mode);}
function compileUncached(selector){
 var out=[];
 splitTop(String(selector),',',false).forEach(function(s){
  var toks=splitTop(s,'>+~ \t\n\r\f',true),parts=[],comb=null,ok=true;
  toks.forEach(function(t){
   if(t==='>'||t==='+'||t==='~'){comb=t;return;}
   var q=parseSimple(t);
   if(q===null){ok=false;return;}
   parts.push({sel:q,comb:comb});
   comb=null;});
  if(ok&&parts.length)out.push(parts);});
 return out;}
function isInside(root,el){if(root.nodeType===9)return true;var n=el.parentNode;while(n){if(n===root)return true;n=n.parentNode;}return false;}
/* Whether the tree under root is the document's. getElementById and the
   C-side tree walk both search the document, so a detached subtree -- a
   template's content, a fragment a component is building -- has to be
   walked here instead, or querySelector on it finds nothing. */
function isPageRoot(n){
 return n===D||(!!n&&n.nodeType===9&&n.documentElement===D.documentElement);}
function inDocument(n){
 /* in C: the climb crossed into C once per ancestor (VitaSurf) */
 if(typeof __vitaConnected==='function')return __vitaConnected(n);
 while(n){
  if(n===D.documentElement)return true;
  if(n.nodeType===9)return isPageRoot(n);
  n=n.parentNode;}
 return false;}
function walkElements(root,out){var c=root.childNodes,i;
 for(i=0;i<c.length;i++){if(c[i].nodeType===1){out.push(c[i]);walkElements(c[i],out);}}
 return out;}
function select(root,sel,all){
 var groups=compile(String(sel)),out=[];
 if(!groups.length)return out;
 var live=isPageRoot(root)||inDocument(root);
 /* one group ending in an id: ask the document directly */
 if(live&&groups.length===1){var key=groups[0][groups[0].length-1].sel;
  if(key.id&&!key.classes.length&&!key.pseudos.length){
   var el=document.getElementById(key.id);
   if(el&&isInside(root,el)&&matchAt(el,groups[0],groups[0].length-1))out.push(el);
   return out;}}
 /* candidates for the right-hand simple selector of every group, found
    in one pass through the tree in C (qjs.c) */
 var keys=groups.map(function(g){return g[g.length-1].sel;});
 var cand=live?__vitaFind(root.nodeType===9?null:root,keys):walkElements(root,[]);
 for(var i=0;i<cand.length;i++){var c=cand[i];
  for(var g=0;g<groups.length;g++){
   if(matchAt(c,groups[g],groups[g].length-1)){out.push(c);break;}}
  if(!all&&out.length)return out;}
 return out;}
var selCount=typeof __vitaSelector==='function'?__vitaSelector:function(){};
P.querySelectorAll=function(sel){
 var f=tagFast(this,sel,2);if(f!==undefined)return f;
 selCount(2);return select(this,sel,true);};
P.querySelector=function(sel){
 var f=tagFast(this,sel,1);if(f!==undefined)return f;
 selCount(3);var r=select(this,sel,false);return r.length?r[0]:null;};
function matchesAny(el,groups){
 for(var g=0;g<groups.length;g++)if(matchAt(el,groups[g],groups[g].length-1))return true;
 return false;}
P.matches=P.webkitMatchesSelector=P.msMatchesSelector=function(sel){
 var f=tagFast(this,sel,0);if(f!==undefined)return f;
 selCount(4);return matchesAny(this,compile(String(sel)));};
/* closest compiles once and walks up in place (VitaSurf); it called
   matches per ancestor, a cache lookup and a crossing into C each. A
   bare tag -- closest('details'), GitHub's components asking for their
   own element -- is walked in C without a wrapper per ancestor. */
P.closest=function(sel){
 var groups=compile(String(sel)),n=this,steps=0;
 if(groups.bare&&typeof __vitaClosestTag==='function')
  return __vitaClosestTag(this,groups.bare.tag,groups.bare.tagUpper);
 while(n&&n.nodeType===1){steps++;if(matchesAny(n,groups)){selCount(5,steps);return n;}n=n.parentNode;}
 selCount(5,steps);
 return null;};
/* The rest of the modern node surface. Polyfills walk these names and
 * read a descriptor for each, so a missing one is not a shim gap to fill
 * later: it throws where the polyfill patches, and takes the page with
 * it. They are ordinary DOM besides. */
Object.defineProperty(P,'nextElementSibling',{configurable:true,get:function(){var n=this.nextSibling;while(n&&n.nodeType!==1)n=n.nextSibling;return n||null;}});
Object.defineProperty(P,'previousElementSibling',{configurable:true,get:function(){var n=this.previousSibling;while(n&&n.nodeType!==1)n=n.previousSibling;return n||null;}});
Object.defineProperty(P,'childElementCount',{configurable:true,get:function(){return this.children.length;}});
/* the four element steps in C when the bindings have them (VitaSurf);
   the getters above stay behind them for anything that is not a node */
if(typeof __vitaElementStep==='function')
 ['firstElementChild','lastElementChild','nextElementSibling',
  'previousElementSibling','parentElement'].forEach(function(k,i){
  var d=Object.getOwnPropertyDescriptor(P,k);
  Object.defineProperty(P,k,{configurable:true,
   get:__vitaElementStep(i,d.get)});});
/* localName, prefix and namespaceURI come from libdom now (qjs.c). An
   SVG clipPath keeps its capital P and an element made with a prefix
   keeps it, neither of which can be guessed from the tag name. These
   stand in only if the C side has no answer -- a node type that has no
   local name at all. */
/* HTML lower-cases ASCII letters and leaves everything else alone, so
   toLowerCase is too much: createElement("\u00c4") keeps its capital. */
function asciiLower(t){
 return String(t).replace(/[A-Z]/g,function(c){
  return String.fromCharCode(c.charCodeAt(0)+32);});}
(function(){
 ['prefix','namespaceURI'].forEach(function(k){
  var d=Object.getOwnPropertyDescriptor(P,k);
  if(!d||!d.get)return;
  Object.defineProperty(P,k,{configurable:true,get:function(){
   var v=d.get.call(this);
   if(v!==undefined&&v!==null)return v;
   if(k==='namespaceURI')
    return this.nodeType===1?'http://www.w3.org/1999/xhtml':null;
   return null;}});});
 /* The local name comes from libdom, which strips a prefix correctly
    but holds every element name upper-cased -- an SVG clipPath is
    stored as CLIPPATH and its capital P cannot be recovered here. Take
    the prefix stripping and lower-case the rest. */
 var dl=Object.getOwnPropertyDescriptor(P,'localName');
 Object.defineProperty(P,'localName',{configurable:true,get:function(){
  var v=(dl&&dl.get)?dl.get.call(this):null;
  if(v===undefined||v===null){
   var t=this.tagName;
   return t?asciiLower(t):'';}
  return this.nodeType===1?asciiLower(v):v;}});})();
Object.defineProperty(P,'baseURI',{configurable:true,get:function(){return D.baseURI;}});
Object.defineProperty(P,'assignedSlot',{configurable:true,get:function(){return null;}});
Object.defineProperty(P,'slot',{configurable:true,get:function(){var v=this.getAttribute('slot');return v===null?'':v;},set:function(v){this.setAttribute('slot',String(v));}});
/* Turn each argument into a node: a string becomes a text node. */
function toNodes(args){var out=[];for(var i=0;i<args.length;i++){var a=args[i];out.push(a&&a.nodeType?a:D.createTextNode(String(a)));}return out;}
P.append=function(){var n=toNodes(arguments);for(var i=0;i<n.length;i++)this.appendChild(n[i]);};
P.prepend=function(){var n=toNodes(arguments),f=this.firstChild;for(var i=0;i<n.length;i++){if(f)this.insertBefore(n[i],f);else this.appendChild(n[i]);}};
P.replaceChildren=function(){var c=this.childNodes.slice();for(var i=0;i<c.length;i++)this.removeChild(c[i]);P.append.apply(this,arguments);};
P.remove=function(){var p=this.parentNode;if(p)p.removeChild(this);};
P.before=function(){var p=this.parentNode;if(!p)return;var n=toNodes(arguments);for(var i=0;i<n.length;i++)p.insertBefore(n[i],this);};
P.after=function(){var p=this.parentNode;if(!p)return;var n=toNodes(arguments),ref=this.nextSibling;for(var i=0;i<n.length;i++){if(ref)p.insertBefore(n[i],ref);else p.appendChild(n[i]);}};
P.replaceWith=function(){P.before.apply(this,arguments);this.remove();};
/* Merge adjacent text nodes and drop empty ones. Code that walks text
 * nodes after building a subtree expects one node per run of text, and a
 * no-op here left it with as many nodes as there were appends. */
P.normalize=function(){
 var c=this.childNodes.slice(),i,n,prev=null;
 for(i=0;i<c.length;i++){
  n=c[i];
  if(n.nodeType===3){
   if(String(n.textContent)===''){n.remove();continue;}
   if(prev){prev.textContent=String(prev.textContent)+String(n.textContent);
    n.remove();continue;}
   prev=n;continue;}
  prev=null;
  if(n.nodeType===1)n.normalize();
 }};
function attrList(el){
 var m=el&&el.attributes,a=[],i;
 if(!m)return a;
 for(i=0;i<m.length;i++)a.push(m[i]);
 return a;}
P.hasAttributes=function(){return this.attributes.length>0;};
/* attributes, and every node list here, is a plain array from qjs.c, so
 * the NamedNodeMap and NodeList calls go on the array prototype. They
 * must be non-enumerable: an enumerable one would appear in every
 * for..in over an array on the page. */
[['item',function(i){return this[i]===undefined?null:this[i];}],
 ['getNamedItem',function(n){n=String(n).toLowerCase();for(var i=0;i<this.length;i++)if(this[i]&&String(this[i].name).toLowerCase()===n)return this[i];return null;}],
 ['namedItem',function(n){n=String(n);for(var i=0;i<this.length;i++){var e=this[i];if(e&&(e.id===n||e.name===n))return e;}return null;}]
].forEach(function(p){if(!(p[0] in Array.prototype))Object.defineProperty(Array.prototype,p[0],{value:p[1],writable:true,configurable:true,enumerable:false});});
P.getAttributeNode=function(n){var v=this.getAttribute(n);return v===null?null:{name:String(n),value:v,specified:true};};
/* getAttributeNS and the rest of the namespaced set come from the C
   side now, which asks libdom for the namespace it was given. */
P.getElementsByTagNameNS=function(ns,t){return this.getElementsByTagName(t);};
P.insertAdjacentElement=function(where,el){
 needArgs(arguments.length,2,'insertAdjacentElement');
 var w=String(where).toLowerCase(),parent=this.parentNode;
 if(w!=='beforebegin'&&w!=='afterbegin'&&w!=='beforeend'&&w!=='afterend')
  throw new DOMException("The value provided ('"+String(where)+
   "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or "+
   "'afterEnd'.",'SyntaxError');
 if(w==='beforebegin'||w==='afterend'){
  /* with no parent there is nowhere to put it, and the answer is null
     rather than an error */
  if(parent===null||parent===undefined)return null;
  if(w==='beforebegin')parent.insertBefore(el,this);
  else parent.insertBefore(el,this.nextSibling);
  return el;}
 if(w==='afterbegin')this.insertBefore(el,this.firstChild);
 else this.appendChild(el);
 return el;
};
P.insertAdjacentText=function(where,t){
 needArgs(arguments.length,2,'insertAdjacentText');
 P.insertAdjacentElement.call(this,where,D.createTextNode(String(t)));};
/* The rest of the element surface. Every one of these was reached by a
 * real page: catalyst calls toggleAttribute as the first thing in its
 * connectedCallback, and a missing method there is not a gap that
 * degrades, it is a TypeError that stops the component. */
/* Scrolling an element. There is one scrollable area here, the page, so
 * scrolling an element that is not the root scrolls what actually
 * scrolls rather than doing nothing. scrollIntoViewIfNeeded is the old
 * WebKit spelling of a method we already have. */
/* an element that scrolls its own content is scrolled; any other
   scrolls the page, as before (VitaSurf) */
function elScrollArgs(a,b){if(a&&typeof a==='object')return [a.left,a.top];return [a,b];}
P.scrollTo=P.scroll=function(a,b){var p=elScrollArgs(a,b);
 if(typeof __vitaScrollElement==='function'&&!isViewportEl(this)&&this!==D.body&&
  __vitaScrollElement(this,p[0]===undefined?null:Number(p[0])||0,p[1]===undefined?null:Number(p[1])||0))return;
 window.scrollTo(a,b);};
P.scrollBy=function(a,b){var p=elScrollArgs(a,b);
 if(typeof __vitaScrollElement==='function'&&!isViewportEl(this)&&this!==D.body&&
  __vitaScrollElement(this,p[0]===undefined?null:this.scrollLeft+(Number(p[0])||0),p[1]===undefined?null:this.scrollTop+(Number(p[1])||0)))return;
 window.scrollBy(a,b);};
P.scrollIntoViewIfNeeded=function(centre){return this.scrollIntoView(centre===false?{block:'nearest'}:true);};
P.toggleAttribute=function(n,force){
 checkAttrName(n);
 var has=this.hasAttribute(n);
 var on=force===undefined?!has:!!force;
 if(on){if(!has)this.setAttribute(n,'');}else if(has)this.removeAttribute(n);
 return on;
};
P.getAttributeNames=function(){return attrList(this).map(function(a){return a.name;});};
P.hasChildNodes=function(){return this.childNodes.length>0;};
P.isSameNode=function(o){return this===o;};
P.isEqualNode=function(o){
 if(this===o)return true;
 if(!o||o.nodeType!==this.nodeType)return false;
 if(this.nodeType===1)return this.tagName===o.tagName&&this.outerHTML===o.outerHTML;
 return this.textContent===o.textContent;
};
P.lookupPrefix=function(){return null;};
P.lookupNamespaceURI=function(){return 'http://www.w3.org/1999/xhtml';};
P.isDefaultNamespace=function(ns){return ns==='http://www.w3.org/1999/xhtml';};
P.checkVisibility=function(){return this.isConnected&&getComputedStyle(this).display!=='none';};
/* Pointer capture routes events to one element; ours already go to the
 * element under the touch, so there is nothing to redirect. */
P.setPointerCapture=function(){};P.releasePointerCapture=function(){};
P.hasPointerCapture=function(){return false;};
P.requestFullscreen=function(){return Promise.resolve();};
P.computedStyleMap=function(){var cs=getComputedStyle(this);
 return {get:function(n){return {value:cs.getPropertyValue(n),toString:function(){return cs.getPropertyValue(n);}};},
         has:function(n){return cs.getPropertyValue(n)!=='';},size:0,forEach:function(){}};};
/* Animations run to their end state immediately: there is no compositor
 * here, and code waits on finished before doing the thing that matters. */
function FinishedAnimation(){
 var self=this;
 this.playState='finished';this.currentTime=0;this.startTime=0;this.playbackRate=1;
 this.onfinish=null;this.oncancel=null;
 this.finished=Promise.resolve(this);this.ready=Promise.resolve(this);
 this.play=function(){};this.pause=function(){};this.reverse=function(){};
 this.cancel=function(){if(typeof self.oncancel==='function')self.oncancel({target:self});};
 this.finish=function(){};this.updatePlaybackRate=function(){};
 this.addEventListener=function(t,f){if(t==='finish')setTimeout(function(){f({target:self});},0);};
 this.removeEventListener=function(){};
 setTimeout(function(){if(typeof self.onfinish==='function')self.onfinish({target:self});},0);
}
P.animate=function(){return new FinishedAnimation();};
P.getAnimations=function(){return [];};
window.Animation=FinishedAnimation;

/* Parse in the context that will hold the markup, and insert the whole
 * fragment at once. Inserting the parsed children one at a time through
 * prepend or after put them in backwards, and parsing everything inside
 * a div lost a table row: <tr> outside a table is dropped by the HTML
 * parser. */
function parseInContext(host,html){
 /* Parse into the host's own document: a fragment built here and filled
  * with nodes from the page document cannot be inserted into a document
  * that DOMParser or createHTMLDocument made. */
 var tag=host&&host.tagName,tmp,f,wrap=null,HD=(host&&host.ownerDocument)||D;
 if(tag==='TABLE')wrap='table';
 else if(tag==='TBODY'||tag==='THEAD'||tag==='TFOOT')wrap='tbody';
 else if(tag==='TR')wrap='tr';
 else if(tag==='SELECT'||tag==='OPTGROUP')wrap='select';
 else if(tag==='COLGROUP')wrap='colgroup';
 f=HD.createDocumentFragment();
 if(wrap===null){
  tmp=HD.createElement(tag&&tag!=='HTML'?tag:'div');
  tmp.innerHTML=String(html);
 }else{
  /* the parser only keeps a row or a cell inside the table it belongs
     to, so build the table and dig back down to the same depth */
  var outer=HD.createElement('div'),path;
  if(wrap==='table'){outer.innerHTML='<table>'+String(html)+'</table>';path=['TABLE'];}
  else if(wrap==='tbody'){outer.innerHTML='<table><tbody>'+String(html)+
   '</tbody></table>';path=['TABLE','TBODY'];}
  else if(wrap==='tr'){outer.innerHTML='<table><tbody><tr>'+String(html)+
   '</tr></tbody></table>';path=['TABLE','TBODY','TR'];}
  else if(wrap==='colgroup'){outer.innerHTML='<table><colgroup>'+String(html)+
   '</colgroup></table>';path=['TABLE','COLGROUP'];}
  else{outer.innerHTML='<select>'+String(html)+'</select>';path=['SELECT'];}
  tmp=outer;
  for(var pi=0;pi<path.length;pi++){
   var next=null,cc=tmp.childNodes,ci;
   for(ci=0;ci<cc.length;ci++)
    if(cc[ci].nodeType===1&&cc[ci].tagName===path[pi]){next=cc[ci];break;}
   if(!next)break;
   tmp=next;}
 }
 while(tmp.firstChild)f.appendChild(tmp.firstChild);
 return f;}
P.insertAdjacentHTML=function(where,html){
 needArgs(arguments.length,2,'insertAdjacentHTML');
 var w=String(where).toLowerCase(),parent=this.parentNode,f;
 if(w!=='beforebegin'&&w!=='afterbegin'&&w!=='beforeend'&&w!=='afterend')
  throw new DOMException("The value provided ('"+String(where)+
   "') is not one of 'beforeBegin', 'afterBegin', 'beforeEnd', or "+
   "'afterEnd'.",'SyntaxError');
 if(w==='beforebegin'||w==='afterend'){
  if(parent===null||parent===undefined||parent.nodeType===9)
   throw new DOMException(
    'The element has no parent.','NoModificationAllowedError');
  f=parseInContext(parent,html);
  if(w==='beforebegin')parent.insertBefore(f,this);
  else parent.insertBefore(f,this.nextSibling);
  return;}
 f=parseInContext(this,html);
 if(w==='afterbegin')this.insertBefore(f,this.firstChild);
 else this.appendChild(f);
};
/* --- what a click does to a form control ---------------------------------
 * A click on a checkbox toggles it and then fires input and change; on
 * a radio it checks that one and clears the rest of its group. None of
 * that happened here, so element.click() on a checkbox left it exactly
 * as it was and no listener heard anything.
 *
 * This runs for a click dispatched from script. A click from the user
 * goes through NetSurf's own form handling, which already does it, and
 * doing it here as well would toggle twice.
 */
function radioGroup(el){
 var name=el.getAttribute('name'),root=el.form||D,all,out=[],i;
 if(!name)return [el];
 all=root.getElementsByTagName?root.getElementsByTagName('input'):[];
 for(i=0;i<all.length;i++)
  if(String(all[i].type||'').toLowerCase()==='radio'&&
     all[i].getAttribute('name')===name&&all[i].form===el.form)out.push(all[i]);
 return out.length?out:[el];}
function preActivate(el){
 var t;
 if(!el||el.nodeType!==1||el.tagName!=='INPUT')return null;
 t=String(el.type||'').toLowerCase();
 if(t==='checkbox'){
  var was={kind:'checkbox',el:el,checked:!!el.checked,
           indeterminate:!!el.indeterminate};
  el.indeterminate=false;
  el.checked=!was.checked;
  return was;}
 if(t==='radio'){
  var group=radioGroup(el),before=[],i;
  for(i=0;i<group.length;i++)before.push(!!group[i].checked);
  if(el.checked)return {kind:'radio',el:el,group:group,before:before,
                        fired:false};
  for(i=0;i<group.length;i++)group[i].checked=group[i]===el;
  return {kind:'radio',el:el,group:group,before:before,fired:true};}
 return null;}
/* The rest of the activation behaviours: a submit or reset button acts
   on its form, and a summary opens and closes the details it heads.
   Only the innermost element being clicked has one run, which is what
   dispatching on that element already gives. */
function otherActivation(el){
 var tag,t,form,n;
 if(!el||el.nodeType!==1)return null;
 tag=el.tagName;
 if(tag==='INPUT'||tag==='BUTTON'){
  if(el.disabled)return null;
  t=String(el.type||'').toLowerCase();
  if(tag==='BUTTON'&&t==='')t='submit';
  form=el.form;
  /* a button that names a popover shows or hides it, unless it
     submits a form (VitaSurf) */
  if(el.hasAttribute('popovertarget')&&(tag==='BUTTON'||
     /^(button|submit|reset|image)$/.test(t))&&
     !(form&&(t==='submit'||t==='image'))){
   n=D.getElementById(el.getAttribute('popovertarget'));
   if(n&&n.hasAttribute('popover'))return {kind:'popover',el:el,target:n};}
  if(!form)return null;
  if(t==='submit'||t==='image')
   return {kind:'submit',form:form,submitter:el};
  if(t==='reset')return {kind:'reset',form:form,submitter:el};
  return null;}
 if(tag==='SUMMARY'){
  n=el.parentNode;
  if(n&&n.tagName==='DETAILS'&&n.firstElementChild===el)
   return {kind:'details',el:n};
  return null;}
 if(tag==='LABEL'){
  n=labelControl(el);
  return n?{kind:'label',el:el,control:n}:null;}
 if((tag==='A'||tag==='AREA')&&el.hasAttribute('href'))
  return {kind:'link',el:el};
 return null;}
/* The control a label is for: the one it names, or the first one it
   contains. */
function labelControl(label){
 var id=label.getAttribute('for'),c,all,i;
 if(id!==null&&id!==''){
  c=D.getElementById(id);
  return c&&LABELABLE.indexOf(' '+c.tagName+' ')>=0?c:null;}
 all=label.getElementsByTagName('*');
 for(i=0;i<all.length;i++)
  if(LABELABLE.indexOf(' '+all[i].tagName+' ')>=0)return all[i];
 return null;}
var LABELABLE=' BUTTON INPUT METER OUTPUT PROGRESS SELECT TEXTAREA ';
/* The element whose activation behaviour a click runs: the nearest one
   from the target upwards that has one. A click on a span inside a
   label activates the label; a click on a button inside that label
   activates the button and not the label, which is why this walks up
   rather than looking only at what was clicked. */
function activationTarget(target){
 var n=target,a;
 /* a text node, and a host's own child drawn in a slot, are activated
    through where they are drawn: the label text of a checkbox sits in
    a slot inside the component's label (VitaSurf) */
 if(n&&n.nodeType===3)n=n.__vsSlot||n.parentNode;
 while(n&&(n.nodeType===1||n.nodeType===11)){
  if(n.nodeType===11){n=shadowHost(n);continue;}
  a=otherActivation(n);
  if(a)return a;
  a=preActivate(n);
  if(a)return a;
  n=n.__vsSlot||n.parentNode;}
 return null;}
/* Following a link. A href that differs from where we are only in its
   fragment is a same-document navigation: the page does not reload, the
   hash changes, hashchange fires and the target is scrolled to. Anything
   else is a real navigation, deferred like a form submission so it does
   not tear the page down inside its own dispatch. */
function sameDocFragment(from,to){
 var i=from.indexOf('#'),j=to.indexOf('#');
 var a=i<0?from:from.slice(0,i),b=j<0?to:to.slice(0,j);
 return a===b&&j>=0;}
function goTo(url){
 var here,target;
 if(url===null||url===undefined)return;
 url=String(url);
 /* a javascript: link runs its script where it is; it is not a place to
    go to, and navigating to one tore the page down */
 if(/^\s*javascript:/i.test(url)){
  var src=url.replace(/^\s*javascript:/i,'');
  try{src=decodeURIComponent(src);}catch(e){}
  setTimeout(function(){
   try{(0,eval)(src);}catch(err){
    if(W.__vitaReportError)W.__vitaReportError(err,location.href);}},0);
  return;}
 try{here=location.href;}catch(e){return;}
 var abs,i;
 /* a fragment is resolved by hand: URL drops an empty one, so setting
    the hash to "" came out as a different document and navigated */
 if(url.charAt(0)==='#'){
  i=here.indexOf('#');
  abs=(i<0?here:here.slice(0,i))+url;
 }else{
  try{abs=new URL(url,D.baseURI||here).href;}catch(e){return;}}
 /* going where we already are changes nothing and fires nothing: a
    hashchange for a hash that did not change had the page's own
    handler set it again, and round it went */
 if(abs===here)return;
 if(sameDocFragment(here,abs)){
  var oldURL=here,hash=abs.slice(abs.indexOf('#'));
  W.__vitaHref=abs;
  try{target=hash.length>1?
   (D.getElementById(decodeURIComponent(hash.slice(1)))||null):null;}catch(e){}
  if(target&&target.scrollIntoView)try{target.scrollIntoView();}catch(e){}
  setTimeout(function(){
   var ev=uaEvent(new W.HashChangeEvent('hashchange',
    {bubbles:false,cancelable:false}));
   ev.oldURL=oldURL;ev.newURL=abs;
   try{W.dispatchEvent?W.dispatchEvent(ev):__vitaDispatch(null,ev);}catch(e){}
  },0);
  return;}
 setTimeout(function(){try{location.href=abs;}catch(e){}},0);}
/* location.href reads back what a same-document navigation left. */
(function(){
 var d=Object.getOwnPropertyDescriptor(location,'href');
 if(!d||!d.get)d=Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(location)||{},'href');
 if(!d||!d.get||!d.set)return;
 Object.defineProperty(location,'href',{configurable:true,
  get:function(){return W.__vitaHref||d.get.call(location);},
  set:function(v){
   var abs;
   try{abs=new URL(String(v),W.__vitaHref||d.get.call(location)).href;}
   catch(e){abs=String(v);}
   if(sameDocFragment(W.__vitaHref||d.get.call(location),abs)){goTo(abs);return;}
   W.__vitaHref=null;d.set.call(location,v);}});
 Object.defineProperty(location,'hash',{configurable:true,
  get:function(){var h=location.href,i=h.indexOf('#');return i<0?'':h.slice(i);},
  set:function(v){
   v=String(v);
   goTo(v.charAt(0)==='#'?v:'#'+v);}});})();

function runActivation(a){
 if(!a)return;
 if(a.kind==='submit'){
  /* the state is read again here, after the listeners have run: one of
     them may have disabled the button or changed what it is, and a form
     that is not in a document does not submit at all */
  if(a.submitter&&a.submitter.disabled)return;
  if(!inDocument(a.form))return;
  if(a.form.requestSubmit)a.form.requestSubmit(a.submitter);
  return;}
 if(a.kind==='reset'){
  if(a.submitter&&a.submitter.disabled)return;
  if(a.form.reset)a.form.reset();return;}
 if(a.kind==='details'){
  var open=!a.el.hasAttribute('open');
  if(open)a.el.setAttribute('open','');else a.el.removeAttribute('open');
  fireSimple(a.el,'toggle');return;}
 if(a.kind==='label'){
  /* the label passes the click on to the control it names */
  if(a.control&&a.control.click)a.control.click();return;}
 if(a.kind==='popover'){
  /* popovertargetaction: toggle, show or hide */
  var how=String(a.el.getAttribute('popovertargetaction')||'').toLowerCase(),
      shown=a.target.matches(':popover-open');
  if(how!=='show'&&how!=='hide')how='toggle';
  try{
   if(shown&&how!=='show')a.target.hidePopover();
   else if(!shown&&how!=='hide')a.target.showPopover();}
  catch(err){if(W.__vitaReportError)W.__vitaReportError(err);}
  return;}
 if(a.kind==='link')goTo(a.el.getAttribute('href'));}
function cancelActivate(was){
 var i;
 if(!was)return;
 if(was.kind==='checkbox'){
  was.el.checked=was.checked;was.el.indeterminate=was.indeterminate;return;}
 for(i=0;i<was.group.length;i++)was.group[i].checked=was.before[i];}
function fireAfterActivate(was){
 if(!was)return;
 if(was.kind==='radio'&&!was.fired)return;
 fireSimple(was.el,'input');
 fireSimple(was.el,'change');}
function fireSimple(el,type){
 var e=uaEvent(new Event(type,{bubbles:true,cancelable:false,composed:type==='input'}));
 try{el.dispatchEvent(e);}catch(err){}}
P.dispatchEvent=function(e){
 var act=null,r;
 if(e&&String(e.type)==='click'&&!e.__vitaActivated){
  shadowProp(e,'__vitaActivated',true);
  act=activationTarget(this);}
 r=__vitaDispatch(this,e);
 /* dispatchEvent answers false when the event was cancelled, which is
    how requestSubmit and every other caller learns it was. */
 if(e&&e.cancelable&&e.defaultPrevented)r=false;
 if(act&&(act.kind==='checkbox'||act.kind==='radio')){
  /* a cancelled click puts the control back, which is what the
     specification calls legacy-canceled-activation behaviour */
  if(e.defaultPrevented)cancelActivate(act);
  else fireAfterActivate(act);}
 else if(act&&!e.defaultPrevented)runActivation(act);
 return r;};
/* Where a tap was, as a pointer or mouse event's fields (VitaSurf): x
   and y come in document coordinates, and the client ones are taken
   from the view's scroll. */
function pointerInit(x,y,button,buttons,detail){
 var sx=W.scrollX||W.pageXOffset||0,sy=W.scrollY||W.pageYOffset||0;
 return {bubbles:true,cancelable:true,composed:true,view:W,detail:detail,
  clientX:x-sx,clientY:y-sy,screenX:x-sx,screenY:y-sy,
  button:button,buttons:buttons,pointerId:1,pointerType:'mouse',
  isPrimary:true,width:1,height:1,pressure:buttons?0.5:0};}
function pointerPlace(e,x,y){
 try{e.pageX=x;e.pageY=y;e.layerX=x;e.layerY=y;}catch(err){}
 return e;}
/* What a tap does once nothing cancelled its click, where NetSurf does
   nothing itself (VitaSurf). qjs.c calls this when the click's dispatch
   is over (js_activate), as a browser runs activation behaviour then:
   a label passes the click to its control as a click of the browser's
   own, or focuses it when it is a text field, and a summary or popover
   button does what a script's click of it does. Home Assistant's "Keep
   me logged in" is a label around a checkbox the page keeps invisible
   and untappable. */
Object.defineProperty(window,'__vitaActivate',{configurable:true,
 value:function(n,x,y){
  var a=activationTarget(n),c,t,ev;
  if(!a)return;
  if(a.kind==='details'||a.kind==='popover'){runActivation(a);return;}
  if(a.kind!=='label'||!(c=a.control)||c===n||c.disabled)return;
  t=String(c.type||'').toLowerCase();
  if(c.tagName==='TEXTAREA'||c.tagName==='SELECT'||(c.tagName==='INPUT'&&
     !/^(checkbox|radio|submit|reset|button|image|file|color|range)$/.test(t))){
   if(c.focus)c.focus();return;}
  ev=uaEvent(pointerPlace(new (W.PointerEvent||W.MouseEvent)('click',
   pointerInit(x|0,y|0,0,0,1)),x|0,y|0));
  P.dispatchEvent.call(c,ev);}});
/* The object an event the browser sends reaches its listeners as
   (VitaSurf): qjs.c reads the event and hands it here once per
   dispatch, and every listener gets what this returns. A click,
   auxclick or contextmenu is a PointerEvent as in Chrome, the mouse's
   own events MouseEvents, keys KeyboardEvents, focus FocusEvents. */
var NATIVE_POINTER=' click auxclick contextmenu pointerdown pointerup pointermove '+
 'pointerover pointerout pointerenter pointerleave pointercancel ';
var NATIVE_MOUSE=' dblclick mousedown mouseup mousemove mouseover mouseout '+
 'mouseenter mouseleave ';
var NATIVE_KEY=' keydown keyup keypress ';
var NATIVE_FOCUS=' focus blur focusin focusout ';
var NATIVE_INPUT=' input beforeinput ';
Object.defineProperty(window,'__vitaNativeEvent',{configurable:true,
 value:function(p){
  var t=String(p.type),k=' '+t+' ',q=p.__vsPointer,C,init,e,i,f;
  if(q&&(NATIVE_POINTER.indexOf(k)>=0||NATIVE_MOUSE.indexOf(k)>=0)){
   init=pointerInit(q.x,q.y,q.button,q.buttons,q.detail);
   C=NATIVE_POINTER.indexOf(k)>=0&&W.PointerEvent?W.PointerEvent:W.MouseEvent;
  }else{
   init={bubbles:!!p.bubbles,cancelable:!!p.cancelable,
    composed:NATIVE_KEY.indexOf(k)>=0||NATIVE_FOCUS.indexOf(k)>=0||
     NATIVE_INPUT.indexOf(k)>=0||NATIVE_MOUSE.indexOf(k)>=0||
     NATIVE_POINTER.indexOf(k)>=0};
   if(NATIVE_KEY.indexOf(k)>=0){
    C=W.KeyboardEvent;init.view=W;
    f=['key','code','keyCode','which','charCode','ctrlKey','shiftKey',
       'altKey','metaKey','repeat','isComposing'];
    for(i=0;i<f.length;i++)if(p[f[i]]!==undefined)init[f[i]]=p[f[i]];
   }else if(NATIVE_FOCUS.indexOf(k)>=0){C=W.FocusEvent;init.view=W;}
   else if(NATIVE_INPUT.indexOf(k)>=0&&W.InputEvent){C=W.InputEvent;init.view=W;}
   else if(NATIVE_POINTER.indexOf(k)>=0||NATIVE_MOUSE.indexOf(k)>=0){
    C=NATIVE_POINTER.indexOf(k)>=0&&W.PointerEvent?W.PointerEvent:W.MouseEvent;
    init.view=W;}
   else C=Event;}
  if(typeof C!=='function')C=Event;
  e=new C(t,init);
  if(q)pointerPlace(e,q.x,q.y);
  /* the legacy key numbers, which a KeyboardEvent built from a
     dictionary does not take */
  if(NATIVE_KEY.indexOf(k)>=0&&p.which!==undefined){
   try{e.which=p.which;}catch(err){}}
  if(p.target)e.target=p.target;
  return uaEvent(e);}});P.getContext=function(){return null;};
P.add=function(o,before){this.insertBefore(o,before||null);};
Object.defineProperty(P,'options',{configurable:true,get:function(){return this.getElementsByTagName('option');}});
Object.defineProperty(P,'selectedIndex',{configurable:true,get:function(){var o=this.options;for(var i=0;i<o.length;i++)if(o[i].hasAttribute('selected'))return i;return o.length?0:-1;},set:function(i){var o=this.options;for(var j=0;j<o.length;j++){if(j===i)o[j].setAttribute('selected','');else o[j].removeAttribute('selected');}}});
Object.defineProperty(P,'selectedOptions',{configurable:true,get:function(){return listOf(this.options).filter(function(o){return o.hasAttribute('selected');});}});
var D=document;
/* A search from the document includes the document element itself,
   which a search from inside it does not: document.querySelector('html')
   was null. */
D.querySelectorAll=function(s){
 var r=D.documentElement,out;
 if(!r)return [];
 out=r.querySelectorAll(s);
 try{if(r.matches(s))out=[r].concat(out);}catch(e){}
 return out;};
D.querySelector=function(s){
 var r=D.documentElement;
 if(!r)return null;
 try{if(r.matches(s))return r;}catch(e){}
 return r.querySelector(s);};
D.getElementsByClassName=function(c){return D.querySelectorAll('.'+c);};
/* the root's first head child, as the specification has it: this was a
   walk of the whole document on every read, and Lit and card-mod read
   document.head as they go (VitaSurf) */
Object.defineProperty(D,'head',{configurable:true,get:function(){var r=D.documentElement,c;if(!r)return null;for(c=r.firstElementChild;c;c=c.nextElementSibling)if(c.localName==='head'&&!c.namespaceURI||c.namespaceURI==='http://www.w3.org/1999/xhtml'&&c.localName==='head')return c;return null;}});
Object.defineProperty(D,'forms',{configurable:true,get:function(){return D.getElementsByTagName('form');}});
Object.defineProperty(D,'images',{configurable:true,get:function(){return D.getElementsByTagName('img');}});
/* links is defined further down: it is the a and area elements that
   have an href, not every a. */
Object.defineProperty(D,'scripts',{configurable:true,get:function(){return D.getElementsByTagName('script');}});
D.defaultView=window;D.nodeType=9;D.nodeName='#document';D.documentMode=undefined;D.compatMode='CSS1Compat';D.hidden=false;D.visibilityState='visible';
/* createEvent takes a fixed set of legacy names, case insensitively, and
   refuses everything else. It used to answer every name with a plain
   Event, so a page that made a MouseEvent this way and then called
   initMouseEvent on it stopped there. */
var EVENT_ALIASES={
 beforeunloadevent:'BeforeUnloadEvent',compositionevent:'CompositionEvent',
 customevent:'CustomEvent',devicemotionevent:'DeviceMotionEvent',
 deviceorientationevent:'DeviceOrientationEvent',dragevent:'DragEvent',
 event:'Event',events:'Event',focusevent:'FocusEvent',
 hashchangeevent:'HashChangeEvent',htmlevents:'Event',
 keyboardevent:'KeyboardEvent',messageevent:'MessageEvent',
 mouseevent:'MouseEvent',mouseevents:'MouseEvent',
 storageevent:'StorageEvent',svgevents:'Event',textevent:'TextEvent',
 touchevent:'TouchEvent',uievent:'UIEvent',uievents:'UIEvent'};
D.createEvent=function(t){
 needArgs(arguments.length,1,'createEvent');
 var iface=EVENT_ALIASES[String(t).toLowerCase()],C=iface?W[iface]:null,ev;
 if(typeof C!=='function')throw new DOMException(
  "The provided event type ('"+String(t)+"') is invalid.",'NotSupportedError');
 ev=new C('');
 /* an event made this way is uninitialised until initEvent is called */
 ev.type='';ev.target=null;ev.currentTarget=null;ev.eventPhase=0;
 ev.bubbles=false;ev.cancelable=false;ev.defaultPrevented=false;
 return ev;};D.dispatchEvent=function(e){return __vitaDispatch(D,e);};
/* window.event: undefined outside a dispatch; the listener call sets it */
if(!Object.prototype.hasOwnProperty.call(window,'event'))window.event=undefined;
D.hasFocus=function(){return true;};
/* The qualified name has to satisfy the same namespace rules as an
   attribute's before an element is made from it. */
/* createElement takes a Name, in which a colon is an ordinary name
   character: "f:o:o" and "foo:" are element names, not qualified ones.
   createElementNS takes a QName and splits on the colon first. */
function badName(){
 return new DOMException('The string contains invalid characters.',
                         'InvalidCharacterError');}
function checkLocalName(q){
 q=String(q);
 if(q===''||!(nameStartOk(q.charCodeAt(0))||q.charCodeAt(0)===0x3a))
  throw badName();
 for(var i=1;i<q.length;i++)
  if(!(namePartOk(q.charCodeAt(i))||q.charCodeAt(i)===0x3a))throw badName();}
function checkElementName(q){
 var parts=String(q).split(':');
 if(parts.length===1){
  if(!nameOk(parts[0]))throw badName();
  return;}
 if(parts.length>2||!nameOk(parts[0])||!nameOk(parts[1]))throw badName();}
(function(){
 var real=D.createElementNS,plain=D.createElement;
 D.createElementNS=function(ns,t){
  needArgs(arguments.length,2,'createElementNS');
  checkElementName(t);
  nsExtract(ns,t,'createElementNS');
  var el=typeof real==='function'?real.call(D,ns,t):null;
  return el||plain.call(D,t);};
 D.createElement=function(t,o){
  needArgs(arguments.length,1,'createElement');
  checkLocalName(t);
  return plain.apply(D,arguments);};})();
D.createRange=function(){var r={startContainer:D.body,endContainer:D.body,startOffset:0,endOffset:0,collapsed:true,
 commonAncestorContainer:D.body,
 setStart:function(n,o){this.startContainer=n;this.startOffset=o;},setEnd:function(n,o){this.endContainer=n;this.endOffset=o;},
 setStartBefore:function(n){this.startContainer=n.parentNode;},setStartAfter:function(n){this.startContainer=n.parentNode;},
 setEndBefore:function(n){this.endContainer=n.parentNode;},setEndAfter:function(n){this.endContainer=n.parentNode;},
 selectNode:function(n){this.commonAncestorContainer=n;},selectNodeContents:function(n){this.commonAncestorContainer=n;},
 collapse:function(){this.collapsed=true;},cloneRange:function(){return D.createRange();},detach:function(){},
 deleteContents:function(){},extractContents:function(){return D.createDocumentFragment();},
 cloneContents:function(){return D.createDocumentFragment();},
 insertNode:function(n){if(this.startContainer)this.startContainer.appendChild(n);},
 surroundContents:function(){},getBoundingClientRect:function(){return {x:0,y:0,top:0,left:0,right:0,bottom:0,width:0,height:0};},
 getClientRects:function(){return [];},toString:function(){return '';}};
 return r;};
D.open=function(){return D;};D.close=function(){};D.writeln=D.writeln||function(){};
/* No hit testing is exposed here. Null is what a browser returns for a
 * point with nothing at it, so callers already handle it. */
/* The hit test a tap uses, so a sheet marked pointer-events: none is
   seen through here as a finger would see through it. The point is
   given in client coordinates, so the scroll offset goes back on. */
/* The element hit, as the tree asked sees it: in a shadow tree, its
   host in the document's own tree (VitaSurf). */
function hitAt(x,y){
 if(!W.__vitaElementFromPoint)return null;
 var s=viewport(),e=W.__vitaElementFromPoint(Math.round(x)+s[0],Math.round(y)+s[1])||null;
 while(e&&e.nodeType!==1)e=e.parentNode||shadowHost(e);
 return e;}
function fromPoint(scope,x,y){
 var e=hitAt(x,y);
 if(!e)return null;
 e=retarget(e,scope);
 return treeRoot(e)===scope?e:null;}
D.elementFromPoint=function(x,y){return fromPoint(D,x,y);};
D.elementsFromPoint=function(x,y){var e=D.elementFromPoint(x,y);return e?[e]:[];};
P.elementFromPoint=function(x,y){
 return this.nodeType===11&&shadowHost(this)?fromPoint(this,x,y):null;};
P.elementsFromPoint=function(x,y){var e=this.elementFromPoint(x,y);return e?[e]:[];};
D.importNode=function(n,deep){return n&&n.cloneNode?n.cloneNode(!!deep):n;};
D.adoptNode=function(n){return n;};
D.execCommand=function(){return false;};
function emptySelection(){return {anchorNode:null,focusNode:null,anchorOffset:0,focusOffset:0,isCollapsed:true,rangeCount:0,type:'None',
 getRangeAt:function(){return D.createRange();},addRange:function(){},removeAllRanges:function(){},removeRange:function(){},
 collapse:function(){},collapseToStart:function(){},collapseToEnd:function(){},selectAllChildren:function(){},
 containsNode:function(){return false;},deleteFromDocument:function(){},toString:function(){return '';}};}
D.getSelection=function(){return emptySelection();};
window.getSelection=function(){return emptySelection();};
window.reportError=function(e){try{console.error(e);}catch(x){}};
/* A page posting to itself is how some code defers work; deliver it as a
 * message event, asynchronously and in order, like a real one. */
window.postMessage=function(data){
 setTimeout(function(){
  var e=uaEvent(new Event('message'));e.data=data;e.origin=location.origin||'';e.source=window;e.ports=[];
  __vitaDispatch(null,e);
 },0);
};
D.createAttribute=function(n){return new Attr(null,String(n).toLowerCase(),'');};
function scratchDocument(title){var html=D.createElement('html'),head=D.createElement('head'),body=D.createElement('body');html.appendChild(head);html.appendChild(body);var doc={nodeType:9,nodeName:'#document',documentElement:html,head:head,body:body,title:title||'',defaultView:null,implementation:D.implementation,createElement:function(t){return D.createElement(t);},createElementNS:function(ns,t){return D.createElement(t);},createTextNode:function(t){return D.createTextNode(t);},createDocumentFragment:function(){return D.createDocumentFragment();},createComment:function(){return D.createTextNode('');},getElementsByTagName:function(t){return html.getElementsByTagName(t);},getElementById:function(id){return html.querySelector('#'+id);},querySelector:function(s){return html.querySelector(s);},querySelectorAll:function(s){return html.querySelectorAll(s);},addEventListener:function(){},removeEventListener:function(){},write:function(){},open:function(){},close:function(){}};return doc;}
D.implementation={
 createHTMLDocument:function(t){
  var d=W.__vitaParseDocument?W.__vitaParseDocument(
   '<!DOCTYPE html><html><head><title>'+
   String(t===undefined?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;')+
   '</title></head><body></body></html>'):null;
  return d||scratchDocument(t);},
 createDocument:function(ns,qname,doctype){
  if(qname!==undefined&&qname!==null&&String(qname)!==''){
   checkElementName(qname);
   nsExtract(ns,qname,'createDocument');}
  var d=D.__vitaCreateDocument?
   D.__vitaCreateDocument(ns,qname,doctype||null):null;
  return d||scratchDocument('');},
 hasFeature:function(){return true;}};
D.characterSet=D.charset='UTF-8';D.referrer='';D.domain='';
window.NodeFilter={FILTER_ACCEPT:1,FILTER_REJECT:2,FILTER_SKIP:3,SHOW_ALL:0xFFFFFFFF,SHOW_ELEMENT:1,SHOW_TEXT:4,SHOW_COMMENT:128,SHOW_DOCUMENT:256};
D.createTreeWalker=function(root,what,filter){
 what=what===undefined?0xFFFFFFFF:what;
 var fn=filter&&(typeof filter==='function'?filter:filter.acceptNode);
 /* 1 accept, 2 reject the node and everything under it, 3 skip the node
    but keep walking into it. Rejecting used to skip only the node, so a
    filter written to prune a subtree saw all of it anyway. */
 function verdict(n){
  if(n.nodeType===9)return 2;
  if(!((1<<(n.nodeType-1))&what))return 3;
  if(!fn)return 1;
  var v=fn(n);
  return v===2?2:(v===3?3:1);}
 function next(n,skipKids){
  if(!skipKids&&n.firstChild)return n.firstChild;
  while(n&&n!==root){
   if(n.nextSibling)return n.nextSibling;
   n=n.parentNode;}
  return null;}
 return {root:root,currentNode:root,whatToShow:what,filter:filter||null,
  nextNode:function(){
   var n=this.currentNode,v;
   for(;;){
    n=next(n,false);
    if(!n)return null;
    v=verdict(n);
    if(v===1){this.currentNode=n;return n;}
    if(v===2){n=next(n,true);if(!n)return null;
     v=verdict(n);
     if(v===1){this.currentNode=n;return n;}}}},
  previousNode:function(){
   var n=this.currentNode.previousSibling||this.currentNode.parentNode;
   if(!n||n===this.root.parentNode)return null;
   this.currentNode=n;return n;},
  firstChild:function(){
   var n=this.currentNode.firstChild;
   while(n&&verdict(n)!==1)n=n.nextSibling;
   if(n)this.currentNode=n;return n||null;},
  lastChild:function(){
   var n=this.currentNode.lastChild;
   while(n&&verdict(n)!==1)n=n.previousSibling;
   if(n)this.currentNode=n;return n||null;},
  nextSibling:function(){
   var n=this.currentNode.nextSibling;
   while(n&&verdict(n)!==1)n=n.nextSibling;
   if(n)this.currentNode=n;return n||null;},
  previousSibling:function(){
   var n=this.currentNode.previousSibling;
   while(n&&verdict(n)!==1)n=n.previousSibling;
   if(n)this.currentNode=n;return n||null;},
  parentNode:function(){
   var n=this.currentNode.parentNode;
   if(n&&n!==root&&verdict(n)===1){this.currentNode=n;return n;}
   return null;}};};
/* createNodeIterator is defined further down, with the filter and the
   starting position the specification gives it. */
/* The base every relative URL in the document resolves against: the
 * first <base href>, or the document's own address. Read with
 * getAttribute, never through the href property, which resolves against
 * this and would call straight back into it. */
Object.defineProperty(D,'baseURI',{configurable:true,get:function(){
 var b=D.getElementsByTagName('base');
 for(var i=0;i<b.length;i++){var h=b[i].getAttribute('href');
  if(h){try{return new URL(h,location.href).href;}catch(e){}}}
 /* the document's own base: a srcdoc or blank frame's is its parent's */
 var n=W.__vitaDocBase?W.__vitaDocBase():'';
 return n||location.href;
}});
Object.defineProperty(D,'URL',{configurable:true,get:function(){return location.href;}});Object.defineProperty(D,'documentURI',{configurable:true,get:function(){return location.href;}});
Object.defineProperty(D,'activeElement',{configurable:true,get:function(){return D.body;}});
/* createComment is a real comment node from qjs.c now. */D.write=D.writeln=function(){};
/* document.open, write and close on a document that is not being parsed
   (VitaSurf): what a page does to fill a blank iframe. What is written
   is kept until close, or the next task, then parsed into the document,
   and its scripts run as a browser runs written ones. A write from the
   document's own script while it is still being parsed belongs in the
   parser's input, which is not supported: it does nothing, as before. */
(function(){
 var buf=null,pending=false;
 function parsing(){
  var s=D.readyState==='loading'?D.currentScript:null;
  return !!s&&s.ownerDocument===D;}
 function clear(el){while(el&&el.firstChild)el.removeChild(el.firstChild);}
 function attrs(from,to){
  if(!from||!to)return;
  Array.prototype.slice.call(to.attributes).forEach(function(a){
   to.removeAttribute(a.name);});
  Array.prototype.slice.call(from.attributes).forEach(function(a){
   to.setAttribute(a.name,a.value);});}
 function live(el){
  Array.prototype.slice.call(el.getElementsByTagName('script')).forEach(
   function(old){
    var n=D.createElement('script');
    Array.prototype.slice.call(old.attributes).forEach(function(a){
     n.setAttribute(a.name,a.value);});
    n.textContent=old.textContent;
    /* insertBefore runs an inserted script; replaceChild does not */
    if(old.parentNode){old.parentNode.insertBefore(n,old);
     old.parentNode.removeChild(old);}});}
 function flush(){
  var src=buf,p;
  buf=null;
  if(src===null)return;
  p=W.__vitaParseDocument?W.__vitaParseDocument(src):null;
  if(!p||!D.documentElement)return;
  attrs(p.documentElement,D.documentElement);
  if(D.head){D.head.innerHTML=p.head?p.head.innerHTML:'';}
  if(D.body){attrs(p.body,D.body);D.body.innerHTML=p.body?p.body.innerHTML:'';}
  if(D.head)live(D.head);
  if(D.body)live(D.body);}
 D.open=function(){
  /* the three-argument form is window.open */
  if(arguments.length>2)return W.open.apply(W,arguments);
  if(parsing())return D;
  buf='';
  clear(D.head);clear(D.body);
  return D;};
 D.write=function(){
  var i;
  if(buf===null){if(parsing())return;D.open();}
  for(i=0;i<arguments.length;i++)buf+=String(arguments[i]);
  if(!pending){pending=true;
   setTimeout(function(){pending=false;flush();},0);}};
 D.writeln=function(){
  D.write.apply(D,Array.prototype.slice.call(arguments).concat(['\n']));};
 D.close=function(){flush();};
})();
D.getElementsByName=function(n){return D.querySelectorAll('[name='+n+']').filter(function(e){return e.getAttribute('name')===n;});};
D.contains=function(n){var r=D.documentElement;return r?r.contains(n):false;};
['onload','onreadystatechange','onclick','onkeydown','onkeyup','onmousemove','ontouchstart'].forEach(function(h){Object.defineProperty(D,h,{configurable:true,get:function(){return D['__'+h]||null;},set:function(f){D['__'+h]=f;if(typeof f==='function')D.addEventListener(h.slice(2),f);}});});
var W=window;
/* storage.js fires the storage and IndexedDB events, and takes this away
   before any page script runs */
Object.defineProperty(W,'__vitaUaEvent',{configurable:true,value:uaEvent});
/* The tree generation, read straight out of the C counter through a
   typed array over it (VitaSurf): __vitaDomGen() was a call into C on
   every read, and the attribute cache reads it once per attribute. */
var GEN=null;
try{if(W.__vitaGenBuf)GEN=new Uint32Array(W.__vitaGenBuf);delete W.__vitaGenBuf;}catch(e){}
/* -1 when there is no counter to read: nothing is then kept */
function domGen(){return GEN?GEN[0]:-1;}
/* the tree's shape alone, which attribute writes leave (VitaSurf) */
function treeGen(){return GEN&&GEN.length>1?GEN[1]:-1;}
['onload','onerror','onresize','onscroll','onhashchange','onpopstate','onunload','onbeforeunload','onmessage','onpageshow','onclick','onkeydown','onkeyup','ontouchstart'].forEach(function(h){Object.defineProperty(W,h,{configurable:true,get:function(){return W['__'+h]||null;},set:function(f){W['__'+h]=f;if(typeof f==='function'&&h!=='onerror')W.addEventListener(h.slice(2),f);}});});
W.dispatchEvent=function(e){return __vitaDispatch(null,e);};
/* Viewport and scroll position come from the window itself, so a script
   that measures the page sees what is really on screen. */
/* Replaceable, as a browser's are: enumerable, configurable, and a
   page's assignment puts its own value in their place. They could not
   be taken off a worker's global, which has none of them. */
[['innerWidth',2],['outerWidth',2],['innerHeight',3],['outerHeight',3],['scrollX',0],['pageXOffset',0],['scrollY',1],['pageYOffset',1]].forEach(function(e){Object.defineProperty(W,e[0],{configurable:true,enumerable:true,get:function(){return viewport()[e[1]];},set:function(v){Object.defineProperty(W,e[0],{configurable:true,enumerable:true,writable:true,value:v});}});});
W.devicePixelRatio=1;
/* Frame relationships. Scripts test self !== top to find out whether they
   are framed, and a missing top is a ReferenceError that takes the script
   out: Google's page header does exactly that. */
W.frames=W;W.opener=null;
try{Object.defineProperty(W,'length',{configurable:true,get:function(){return D.getElementsByTagName('iframe').length;},configurable:true});}catch(e){}
W.screen={width:960,height:544,availWidth:960,availHeight:544,colorDepth:32,pixelDepth:32,orientation:{type:'landscape-primary'}};
W.focus=W.blur=W.stop=W.print=W.close=function(){};W.open=function(){return null;};
function scrollArgs(a,b){if(a&&typeof a==='object')return [Number(a.left)||0,Number(a.top)||0];return [Number(a)||0,Number(b)||0];}
W.scrollTo=W.scroll=function(a,b){var p=scrollArgs(a,b);__vitaScrollTo(p[0],p[1]);};
W.scrollBy=function(a,b){var p=scrollArgs(a,b),s=viewport();__vitaScrollTo(s[0]+p[0],s[1]+p[1]);};
W.confirm=function(){return false;};W.prompt=function(){return null;};
W.requestAnimationFrame=function(f){return setTimeout(function(){f(Date.now());},16);};W.cancelAnimationFrame=function(h){clearTimeout(h);};
W.requestIdleCallback=function(f){return setTimeout(function(){f({didTimeout:false,timeRemaining:function(){return 10;}});},50);};W.cancelIdleCallback=function(h){clearTimeout(h);};
/* getComputedStyle. The values are mostly defaults -- there is no style
 * resolution exposed here beyond what __vitaStyle reports and what the
 * box geometry says -- but the shape is the point: a real declaration
 * answers every CSS property with a string, and ours used to answer
 * undefined for all but a handful. Reading one and calling a string
 * method on it, which is what a page doing its own rem arithmetic does,
 * threw instead of getting a wrong-but-harmless number. */
/* Indexed by the libcss enum, which starts its values at 1. */
var CS_DISPLAY=['','inline','block','list-item','run-in','inline-block','table','inline-table',
 'table-row-group','table-header-group','table-footer-group','table-row','table-column-group',
 'table-column','table-cell','table-caption','none','flex','inline-flex','grid','inline-grid','contents',
 'flow-root','-webkit-box','-webkit-inline-box'];
var CS_VIS=['','visible','hidden','collapse'];
var CS_DEFAULTS={
 display:'block',visibility:'visible',opacity:'1',position:'static',float:'none',clear:'none',
 direction:'ltr',fontSize:'16px',fontFamily:'sans-serif',fontStyle:'normal',fontWeight:'400',
 fontVariant:'normal',lineHeight:'normal',color:'rgb(0, 0, 0)',backgroundColor:'rgba(0, 0, 0, 0)',
 backgroundImage:'none',textAlign:'start',textDecoration:'none',textTransform:'none',
 whiteSpace:'normal',overflow:'visible',overflowX:'visible',overflowY:'visible',
 boxSizing:'content-box',zIndex:'auto',transform:'none',transition:'all 0s ease 0s',
 animationName:'none',cursor:'auto',pointerEvents:'auto',borderStyle:'none',borderCollapse:'separate',
 listStyleType:'disc',verticalAlign:'baseline',tableLayout:'auto',resize:'none',
 top:'auto',right:'auto',bottom:'auto',left:'auto'};
['margin','padding','border'].forEach(function(b){
 ['Top','Right','Bottom','Left'].forEach(function(e){
  CS_DEFAULTS[b+e+(b==='border'?'Width':'')]='0px';});
 if(b!=='border')CS_DEFAULTS[b]='0px';});
var CS_PROTO={};
/* the dashed names a declaration also answers to, cs['padding-left']
   beside cs.paddingLeft, as accessors on the prototype made once for
   each name met (VitaSurf): they read undefined */
var CS_DASHED={};
function csDashed(k){
 var d;
 CS_DASHED[k]=1;
 if(!/[A-Z]/.test(k)&&k!=='cssFloat')return;
 d=k==='cssFloat'?'float':k.replace(/[A-Z]/g,function(m){return '-'+m.toLowerCase();});
 if(/^(webkit|moz|ms)-/.test(d))d='-'+d;
 if(Object.prototype.hasOwnProperty.call(CS_PROTO,d))return;
 Object.defineProperty(CS_PROTO,d,{configurable:true,
  get:function(){return this[k];},set:function(v){this[k]=v;}});}
function dashToCamel(n){return String(n).replace(/-([a-z])/g,function(m,c){return c.toUpperCase();});}
/* What the user agent stylesheet says an element is, for when libcss has
   no computed style to give -- a detached element, or one with no box.
   Reporting block for everything told code that an inline element was a
   block, which is the kind of thing a layout script branches on. */
var UA_DISPLAY={SPAN:'inline',A:'inline',B:'inline',I:'inline',EM:'inline',
 STRONG:'inline',SMALL:'inline',BIG:'inline',CODE:'inline',KBD:'inline',
 SAMP:'inline',VAR:'inline',CITE:'inline',ABBR:'inline',DFN:'inline',
 Q:'inline',S:'inline',U:'inline',SUB:'inline',SUP:'inline',MARK:'inline',
 TIME:'inline',LABEL:'inline',IMG:'inline',BR:'inline',WBR:'inline',
 OBJECT:'inline',IFRAME:'inline',EMBED:'inline',CANVAS:'inline',
 VIDEO:'inline',AUDIO:'inline',FONT:'inline',TT:'inline',
 INPUT:'inline-block',BUTTON:'inline-block',SELECT:'inline-block',
 TEXTAREA:'inline-block',METER:'inline-block',PROGRESS:'inline-block',
 LI:'list-item',TABLE:'table',THEAD:'table-header-group',
 TBODY:'table-row-group',TFOOT:'table-footer-group',TR:'table-row',
 TD:'table-cell',TH:'table-cell',CAPTION:'table-caption',
 COL:'table-column',COLGROUP:'table-column-group',
 HEAD:'none',SCRIPT:'none',STYLE:'none',TITLE:'none',META:'none',
 LINK:'none',TEMPLATE:'none',BASE:'none',PARAM:'none',SOURCE:'none',
 TRACK:'none',AREA:'none',DATALIST:'none',DIALOG:'none'};
/* A colour from __vitaStyle: the RGB and its alpha arrive apart, because
   0xff000000 does not fit the int the binding hands back on a 32-bit
   target. A browser answers rgb() when the colour is opaque and rgba()
   when it is not, and code compares the string it gets. */
/* Properties __vitaStyle resolves, so the style attribute must not
   overwrite them with the author's own spelling. */
var RESOLVED={fontSize:1,display:1,visibility:1,color:1,backgroundColor:1};
var BOX_RESOLVED=/^(margin|padding)(Top|Right|Bottom|Left)?$|^border(Top|Right|Bottom|Left)?Width$/;
function cssColour(rgb,a){
 if(typeof rgb!=='number'||rgb<0||typeof a!=='number'||a<0)return '';
 var r=(rgb>>16)&255,g=(rgb>>8)&255,b=rgb&255;
 if(a>=255)return 'rgb('+r+', '+g+', '+b+')';
 /* Alpha reads as the shortest fraction that comes back to the same
    byte: rgba(255,0,0,0.5) stores 128, and 128/255 printed plainly is
    0.498, which is not the string the page wrote or the one a browser
    reports. Two places first, three only if two do not round-trip. */
 var f=Math.round(a/255*100)/100;
 if(Math.round(f*255)!==a)f=Math.round(a/255*1000)/1000;
 return 'rgba('+r+', '+g+', '+b+', '+f+')';
}
function computedStyle(el,pseudo){
 /* rules put in with insertRule are written back to their sheet in a
    microtask, so many come to one rewrite; a read wants them now */
 if(sheetsDirty.length)sheetsWrite();
 /* A browser reports nothing for an element that is not in the document,
    and code tests the value it gets back. */
 if(el&&el.nodeType===1&&el.isConnected===false){
  var empty={getPropertyValue:function(){return '';},
   getPropertyPriority:function(){return '';},
   setProperty:function(){},removeProperty:function(){return '';},
   item:function(){return '';},length:0,cssText:''};
  for(var k in CS_DEFAULTS)empty[k]='';
  empty.width='';empty.height='';
  return empty;}
 var st=(el&&el.nodeType===1&&typeof __vitaStyle==='function')?__vitaStyle(el):null;
 var cs=Object.create(CS_PROTO);
 for(var k in CS_DEFAULTS)cs[k]=CS_DEFAULTS[k];
 if(el&&el.nodeType===1&&UA_DISPLAY[el.tagName])cs.display=UA_DISPLAY[el.tagName];
 if(st){
  cs.fontSize=st[0]+'px';
  if(CS_DISPLAY[st[1]])cs.display=CS_DISPLAY[st[1]];
  if(CS_VIS[st[2]])cs.visibility=CS_VIS[st[2]];
  var c=cssColour(st[3],st[5]);if(c)cs.color=c;
  var b=cssColour(st[4],st[6]);if(b)cs.backgroundColor=b;
  /* the margins, padding and border widths layout used */
  if(st.length>18)[['margin',7,''],['padding',11,''],['border',15,'Width']].forEach(function(g){
   var v=[];
   ['Top','Right','Bottom','Left'].forEach(function(e,i){
    v.push(cs[g[0]+e+g[2]]=st[g[1]+i]+'px');});
   cs[g[0]+g[2]]=v[0]===v[1]&&v[0]===v[2]&&v[0]===v[3]?v[0]:
    v[1]===v[3]?(v[0]===v[2]?v[0]+' '+v[1]:v[0]+' '+v[1]+' '+v[2]):v.join(' ');});
 }
 /* The rest of the cascade's answers, and a pseudo element's own: what
    the element is positioned and laid out with, its font, borders and
    text, as a browser reports them. */
 var more=(el&&el.nodeType===1&&typeof __vitaStyleMore==='function')?
  __vitaStyleMore(el,typeof pseudo==='string'&&pseudo?pseudo:null):null;
 if(more)for(var mk in more){cs[mk]=more[mk];if(!CS_DASHED[mk])csDashed(mk);}
 /* a ::before or ::after that is not there still answers, with no content */
 if(typeof pseudo==='string'&&/^::?(before|after)$/i.test(pseudo)&&
  (!more||more.content===undefined))cs.content='none';
 /* Whatever the element says inline wins over the defaults, for the
    properties nothing else here can answer: a declaration the page
    wrote on the element itself is the one value that is certain, and
    code that sets a style and reads it back through getComputedStyle
    used to get the default instead of what it had just written.
    Properties libcss did answer are left alone -- the cascade has
    already taken the inline declaration into account, and it reports a
    resolved value where the attribute is whatever the author typed. */
 if(el&&el.nodeType===1&&typeof el.getAttribute==='function'){
  var inline=el.getAttribute('style');
  if(inline)parseDecl(inline).forEach(function(d){
   var k=dashToCamel(d[0]);
   if(st&&(RESOLVED[k]||(st.length>18&&BOX_RESOLVED.test(k))))return;
   if(more&&more[k]!==undefined)return;
   /* the used size is layout's, which the getters below ask for */
   if(k==='width'||k==='height')return;
   cs[k]=d[1];if(!CS_DASHED[k])csDashed(k);});
 }
 /* the methods are the prototype's and the names are listed when
    asked for (VitaSurf): made for every call, with every property's
    name turned to its dashed form by a regular expression, they were
    nine tenths of a call, and lazysizes asks for an element's
    visibility for each image near the view on every scroll check */
 Object.defineProperty(cs,'__vitaEl',{value:el});
 return cs;
}
function csNames(cs){
 if(!Object.prototype.hasOwnProperty.call(cs,'__vitaNames'))
  Object.defineProperty(cs,'__vitaNames',{configurable:true,value:
   Object.keys(cs).concat(['width','height'].filter(function(k){
    return !Object.prototype.hasOwnProperty.call(cs,k);})).filter(function(k){return typeof cs[k]==='string';}).map(function(k){
    return k==='cssFloat'?'float':k.replace(/[A-Z]/g,function(m){return '-'+m.toLowerCase();});})});
 return cs.__vitaNames;
}
/* width and height are the used sizes layout gives, asked for only when
   read (VitaSurf): a read lays the page out first when it has changed,
   as a browser's does, and a style read that never looks at them does
   not. A length the element has with no box to measure is its own
   property, set from the cascade, and answers before these. */
function csSize(cs,i){
 var el=cs.__vitaEl,b;
 if(!el||el.nodeType!==1||typeof __vitaBox!=='function')return 'auto';
 b=__vitaBox(el);
 return b?b[i]+'px':'auto';}
['width','height'].forEach(function(k,i){
 Object.defineProperty(CS_PROTO,k,{configurable:true,
  get:function(){return csSize(this,4+i);},
  set:function(v){Object.defineProperty(this,k,{configurable:true,
   enumerable:true,writable:true,value:v});}});});
Object.defineProperties(CS_PROTO,{
 getPropertyValue:{configurable:true,writable:true,value:function(n){n=String(n);var el=this.__vitaEl;
  /* a custom property is the cascade's, read as the page wrote it */
  if(n.slice(0,2)==='--'){
   if(Object.prototype.hasOwnProperty.call(this,n))return String(this[n]);
   if(sheetsDirty.length)sheetsWrite();
   return (el&&el.nodeType===1&&typeof __vitaCustomProp==='function')?
    __vitaCustomProp(el,n):'';}
  var v=this[dashToCamel(n)];return v===undefined||typeof v==='function'?'':String(v);}},
 getPropertyPriority:{configurable:true,writable:true,value:function(){return '';}},
 setProperty:{configurable:true,writable:true,value:function(n,v){this[dashToCamel(n)]=String(v);delete this.__vitaNames;}},
 removeProperty:{configurable:true,writable:true,value:function(n){var c=dashToCamel(n),v=this[c];delete this[c];delete this.__vitaNames;return v===undefined?'':String(v);}},
 item:{configurable:true,writable:true,value:function(i){return csNames(this)[i]||'';}},
 cssText:{configurable:true,writable:true,value:''},
 length:{configurable:true,get:function(){return csNames(this).length;}}
});
for(var csk in CS_DEFAULTS)csDashed(csk);csDashed('width');csDashed('height');
W.getComputedStyle=function(el,pseudo){return computedStyle(el,pseudo);};
/* A media query evaluator over the real viewport. Handles the features
   responsive sites actually branch on; anything else is false. */
function mediaFeature(name,value){var s=viewport(),w=s[2],h=s[3],n=parseFloat(value);
 if(/em$/.test(value))n*=16;
 switch(name){
 case 'width':return w===n;case 'min-width':return w>=n;case 'max-width':return w<=n;
 case 'height':return h===n;case 'min-height':return h>=n;case 'max-height':return h<=n;
 case 'aspect-ratio':case 'min-aspect-ratio':case 'max-aspect-ratio':{var p=String(value).split('/'),r=parseFloat(p[0])/(parseFloat(p[1])||1),a=w/(h||1);return name==='min-aspect-ratio'?a>=r:name==='max-aspect-ratio'?a<=r:Math.abs(a-r)<0.001;}
 case 'orientation':return value===(w>=h?'landscape':'portrait');
 /* the same answer the stylesheets get: qjs.c sets __vitaDarkMode from
    the option the Start menu toggles, so matchMedia and the CSS
    cannot disagree about which theme a site should use */
 case 'prefers-color-scheme':
  if(value===''||value===undefined)return true;
  return W.__vitaDarkMode?value==='dark':
   (value==='light'||value==='no-preference');
 /* reduced motion is asked for, as the stylesheets are told: Home
    Assistant's login page animates a particle field on a canvas every
    frame unless it is, and the Vita ran it at 25 fps (VitaSurf) */
 case 'prefers-reduced-motion':return value==='reduce';
 case 'prefers-contrast':case 'forced-colors':case 'inverted-colors':return value==='no-preference'||value==='none';
 case 'pointer':case 'any-pointer':return value==='coarse';
 case 'hover':case 'any-hover':return value==='none';
 case 'display-mode':return value==='fullscreen'||value==='browser';
 case 'resolution':case 'min-resolution':return name==='min-resolution'?1>=n:n===1;
 case 'max-resolution':return 1<=n;
 case 'color':return true;case 'monochrome':return false;case 'grid':return false;
 case 'scripting':return value==='enabled';
 default:return false;}}
/* A feature written with no value asks whether it has a value at all:
   (hover) is true unless hover is none, (monochrome) unless it is zero.
   This used to be answered by asking for min-<feature>: 1, which means
   nothing for a feature that is not a range and so said no to all of
   them. YouTube gates its whole device theme on (prefers-color-scheme)
   matching before it ever asks for dark, so dark mode did nothing
   there however the browser was set. */
function mediaFeatureBool(name){
 switch(name){
 /* there is always one scheme or the other */
 case 'prefers-color-scheme':return true;
 /* reported as no-preference or none, so the bare query is false */
 case 'prefers-reduced-motion':return true;       /* reduce */
 case 'prefers-reduced-transparency':
 case 'prefers-contrast':case 'forced-colors':case 'inverted-colors':
  return false;
 case 'pointer':case 'any-pointer':return true;   /* coarse */
 case 'hover':case 'any-hover':return false;      /* none */
 case 'monochrome':return false;                  /* a colour screen */
 /* the size of a colour lookup table, which a true colour screen
    does not have */
 case 'color-index':return false;
 case 'grid':return false;                        /* not a grid device */
 case 'color':case 'orientation':case 'display-mode':
 case 'scripting':case 'update':case 'width':case 'height':
 case 'aspect-ratio':case 'resolution':case 'device-width':
 case 'device-height':case 'device-aspect-ratio':
  return true;
 default:return undefined;
 }
}
function mediaTerm(t){t=t.replace(/^\s+|\s+$/g,'');
 if(!t)return true;
 if(/^not\s/i.test(t))return !mediaTerm(t.slice(4));
 if(t.charAt(0)==='('){var m=/^\(\s*([\w-]+)\s*(?::\s*([^)]*?))?\s*\)$/.exec(t);if(!m)return false;
  if(m[2]===undefined){var bare=mediaFeatureBool(m[1].toLowerCase());
   if(bare!==undefined)return bare;
   return mediaFeature('min-'+m[1],'1')||m[1]==='color';}
  return mediaFeature(m[1].toLowerCase(),String(m[2]).replace(/^\s+|\s+$/g,''));}
 var type=t.toLowerCase();return type==='all'||type==='screen';}
function mediaMatches(q){q=String(q||'');if(!q)return true;
 return q.split(',').some(function(one){
  var neg=false;one=one.replace(/^\s+|\s+$/g,'');
  if(/^not\s/i.test(one)){neg=true;one=one.slice(4);}
  if(/^only\s/i.test(one))one=one.slice(5);
  var ok=one.split(/\s+and\s+/i).every(function(t){return mediaTerm(t);});
  return neg?!ok:ok;});}
W.matchMedia=function(q){var mql={media:String(q),onchange:null,_l:[],
 addListener:function(f){this._l.push(f);},removeListener:function(f){this._l=this._l.filter(function(g){return g!==f;});},
 addEventListener:function(t,f){if(t==='change')this.addListener(f);},removeEventListener:function(t,f){this.removeListener(f);},
 dispatchEvent:function(){return true;}};
 Object.defineProperty(mql,'matches',{configurable:true,get:function(){return mediaMatches(q);}});
 return mql;};
W.__vitaMediaMatches=mediaMatches;
function Storage(){var d={};this.getItem=function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null;};this.setItem=function(k,v){d[k]=String(v);};this.removeItem=function(k){delete d[k];};this.clear=function(){d={};};this.key=function(i){return Object.keys(d)[i]||null;};Object.defineProperty(this,'length',{configurable:true,get:function(){return Object.keys(d).length;}});}
W.localStorage=new Storage();W.sessionStorage=new Storage();
/* --- history ------------------------------------------------------------
 * Every page that routes on its own calls pushState and then reads the
 * location back to decide what to render. This was a set of empty
 * functions, so the url never moved, history.state stayed null and back()
 * did nothing: a single page app would log you in and then show you the
 * login page again, because that is still what the address said.
 *
 * Nothing here navigates. It moves the same __vitaHref that a fragment
 * navigation moves, which is what location.href and every part of it
 * read, and fires popstate when the page walks the stack. */
(function(){
 function here(){ try{ return location.href; }catch(e){ return ''; } }
 var stack=[{state:null,url:here()}], at=0;
 function resolve(url){
  if(url===undefined||url===null||url==='')return here();
  try{ return new URL(String(url), here()).href; }catch(e){ return here(); }
 }
 function clone(v){
  if(v===undefined)return null;
  try{ return JSON.parse(JSON.stringify(v)); }catch(e){ return v; }
 }
 /* the browser's own idea of the address: what it shows, records and
    reloads (VitaSurf). Home Assistant replaces its login callback
    address, code and all, once the code is spent; kept, a reload or
    the History page went back to a code that no longer worked. */
 var SU=typeof W.__vitaScriptURL==='function'?W.__vitaScriptURL:null;
 function tell(replace){
  if(!SU)return;
  try{SU(stack[at].url,replace);}catch(e){}}
 function apply(i,fire){
  var e=stack[i];
  at=i;
  W.__vitaHref=e.url;
  H.state=e.state;
  if(!fire)return;
  setTimeout(function(){
   var ev;
   try{ ev=new W.PopStateEvent('popstate',{bubbles:false,cancelable:false}); }
   catch(err){ ev=new Event('popstate'); }
   uaEvent(ev);
   try{ ev.state=e.state; }catch(err){}
   try{ W.dispatchEvent?W.dispatchEvent(ev):__vitaDispatch(null,ev); }catch(err){}
  },0);
 }
 var H={
  get length(){ return stack.length; },
  state:null,
  scrollRestoration:'auto',
  pushState:function(state,title,url){
   stack.length=at+1;
   stack.push({state:clone(state),url:resolve(url)});
   apply(stack.length-1,false);
   tell(false);
  },
  replaceState:function(state,title,url){
   stack[at]={state:clone(state),
              url:url===undefined?stack[at].url:resolve(url)};
   apply(at,false);
   tell(true);
  },
  go:function(n){
   n=(n===undefined||n===null)?0:(parseInt(n,10)||0);
   if(n===0){ try{ location.reload(); }catch(e){} return; }
   var i=at+n;
   if(i<0||i>=stack.length)return;
   apply(i,true);
   tell(true);
  },
  back:function(){ H.go(-1); },
  forward:function(){ H.go(1); }
 };
 W.history=H;
 if(!W.PopStateEvent){
  W.PopStateEvent=function(type,init){
   var e=new Event(type,init); e.state=(init&&init.state)||null; return e; };
 }
})();
var t0=Date.now();var perf=W.performance||{};W.performance=perf;if(!perf.now)perf.now=function(){return Date.now()-t0;};perf.timing={navigationStart:t0,unloadEventStart:0,unloadEventEnd:0,redirectStart:0,redirectEnd:0,secureConnectionStart:0,fetchStart:t0,domainLookupStart:t0,domainLookupEnd:t0,connectStart:t0,connectEnd:t0,requestStart:t0,responseStart:t0,responseEnd:t0,domLoading:t0,domInteractive:t0,domContentLoadedEventStart:t0,domContentLoadedEventEnd:t0,domComplete:t0,loadEventStart:t0,loadEventEnd:t0};perf.navigation={type:0,redirectCount:0};perf.mark=perf.measure=perf.clearMarks=perf.clearMeasures=function(){};perf.getEntries=perf.getEntriesByType=perf.getEntriesByName=function(){return [];};
(function(){var l=String(typeof __vitaLanguages==='function'?__vitaLanguages():'en-US,en').split(',').map(function(t){return t.trim();}).filter(Boolean);if(!l.length)l=['en-US','en'];navigator.language=l[0];navigator.languages=Object.freeze(l);})();navigator.cookieEnabled=true;navigator.onLine=true;navigator.doNotTrack=null;navigator.maxTouchPoints=1;navigator.vendor='';navigator.hardwareConcurrency=1;navigator.sendBeacon=function(){return false;};navigator.javaEnabled=function(){return false;};
location.reload=function(){location.href=location.href;};
['protocol','host','hostname','port','pathname','search','hash','origin'].forEach(function(k){Object.defineProperty(location,k,{configurable:true,get:function(){var m=location.href.match(/^([a-z][a-z0-9+.-]*:)\/\/(([^\/:?#]*)(?::(\d+))?)([^?#]*)(\?[^#]*)?(#.*)?/i)||[];return {protocol:m[1]||'',host:m[2]||'',hostname:m[3]||'',port:m[4]||'',pathname:m[5]||'/',search:m[6]||'',hash:m[7]||'',origin:m[1]?m[1]+'//'+(m[2]||''):'null'}[k];}});});
location.toString=function(){return location.href;};
function Event(type,init){ownTrust(this);this.type=String(type);this.bubbles=!!(init&&init.bubbles);this.cancelable=!!(init&&init.cancelable);this.defaultPrevented=false;this.target=null;this.currentTarget=null;this.timeStamp=Date.now();
 /* whether it leaves a shadow tree for the host (VitaSurf) */
 Object.defineProperty(this,'__vsComposed',{configurable:true,value:!!(init&&init.composed)});}
/* A passive listener cannot cancel: preventDefault from inside one does
   nothing at all, so defaultPrevented stays false even while it runs.
   The dispatch marks the event while a passive listener is on it. */
Event.prototype.preventDefault=function(){
 if(this.__vitaPassive)return;
 if(this.cancelable===false)return;
 this.defaultPrevented=true;};/* The C side reads cancelBubble back after a listener returns and stops
 * libdom's propagation with it, so this is what makes stopPropagation
 * stop anything. */
Event.prototype.stopPropagation=function(){this.cancelBubble=true;};
Event.prototype.stopImmediatePropagation=function(){this.cancelBubble=true;this.__stopNow=true;};Event.prototype.initEvent=function(t,b,c){this.type=t;this.bubbles=!!b;this.cancelable=!!c;};
function CustomEvent(type,init){Event.call(this,type,init);this.detail=init?init.detail:null;}CustomEvent.prototype=Object.create(Event.prototype);
CustomEvent.prototype.initCustomEvent=function(t,b,c,d){this.initEvent(t,b,c);this.detail=d;};
W.Event=Event;W.CustomEvent=CustomEvent;
/*
 * A constructible EventTarget. The C side had aliased the name to the
 * Node constructor, which refuses "new", so a page that builds a plain
 * event emitter -- github.com's performance timeline keeps one as a
 * class field -- rejected with "Illegal constructor". Nodes keep their
 * own listener methods on Node.prototype; this is the base under it,
 * so a node is still an instanceof EventTarget.
 */
function EventTarget(){}
function etOpts(o){return {cap:!!(o&&typeof o==='object'?o.capture:o),
 once:!!(o&&typeof o==='object'&&o.once)};}
EventTarget.prototype.addEventListener=function(type,fn,opts){
 if(fn===null||fn===undefined)return;
 var m=priv(this,'__etl',function(){return {};}),o=etOpts(opts),
  l=m[type]||(m[type]=[]),i;
 for(i=0;i<l.length;i++)if(l[i].fn===fn&&l[i].cap===o.cap)return;
 l.push({fn:fn,cap:o.cap,once:o.once});};
EventTarget.prototype.removeEventListener=function(type,fn,opts){
 var m=this.__etl,o=etOpts(opts);
 if(!m||!m[type])return;
 m[type]=m[type].filter(function(x){return !(x.fn===fn&&x.cap===o.cap);});};
EventTarget.prototype.dispatchEvent=function(e){
 if(!e||typeof e.type!=='string')
  throw new TypeError('EventTarget.dispatchEvent: argument is not an Event');
 var m=this.__etl,l=m&&m[e.type]?m[e.type].slice():[],i,x,self=this;
 try{e.target=this;}catch(x1){}
 try{e.currentTarget=this;}catch(x2){}
 for(i=0;i<l.length;i++){
  x=l[i];
  if(x.once)self.removeEventListener(e.type,x.fn,x.cap);
  try{
   if(typeof x.fn==='function')x.fn.call(self,e);
   else if(x.fn&&typeof x.fn.handleEvent==='function')x.fn.handleEvent(e);
  }catch(err){try{console.log('uncaught in listener: '+err);}catch(x3){}}
  if(e.__stopNow)break;}
 try{e.currentTarget=null;}catch(x4){}
 return !(e.cancelable&&e.defaultPrevented);};
try{Object.setPrototypeOf(P,EventTarget.prototype);}catch(e){}
W.EventTarget=EventTarget;
/* The event interfaces. A page names one to say what kind of event a
 * handler takes -- YouTube annotates a wheel handler with WheelEvent --
 * so the name has to exist even where nothing here will ever construct
 * one. They all behave as Event; what differs between them is fields we
 * do not produce. */
['FocusEvent','WheelEvent','PointerEvent','TouchEvent',
 'InputEvent','CompositionEvent','DragEvent','ClipboardEvent','ProgressEvent','ErrorEvent',
 'PopStateEvent','HashChangeEvent','PageTransitionEvent','StorageEvent','SubmitEvent',
 'BeforeUnloadEvent','MediaQueryListEvent','CloseEvent','MessageEvent','SecurityPolicyViolationEvent',
 'PromiseRejectionEvent','DeviceMotionEvent','DeviceOrientationEvent','GamepadEvent',
 'FormDataEvent','ToggleEvent','ContentVisibilityAutoStateChangeEvent'].forEach(function(n){W[n]=Event;});
/* Touch and gesture types a page constructs or tests for. */
W.Touch=function(init){init=init||{};this.identifier=init.identifier||0;this.target=init.target||null;
 this.clientX=init.clientX||0;this.clientY=init.clientY||0;this.pageX=init.pageX||0;this.pageY=init.pageY||0;
 this.screenX=init.screenX||0;this.screenY=init.screenY||0;this.radiusX=0;this.radiusY=0;this.force=1;};
W.TouchList=Array;W.DataTransfer=function(){this.items=[];this.files=[];this.types=[];
 this.getData=function(){return '';};this.setData=function(){};this.clearData=function(){};};
/* document and window need prototypes of their own. Both used to report
 * Object.prototype, because each is a plain object here and that is what
 * it inherits from. A polyfill that patches Document.prototype and
 * Window.prototype then writes its enumerable accessors straight onto
 * Object.prototype, after which every for..in on the page -- including
 * the polyfill's own walk over its descriptor tables -- yields those
 * names, reads undefined through an inherited getter, and dies on it.
 * Give each one an empty prototype in the chain instead. */
var DocumentProto={};Object.setPrototypeOf(D,DocumentProto);
/* new Document() makes an empty document; a document the parser or the
   implementation made is a node wrapper, which instanceof still knows */
function Document(){
 if(new.target===undefined)throw new TypeError("Failed to construct 'Document': Please use the 'new' operator");
 return D.implementation.createDocument(null,null,null);}
try{Object.defineProperty(Document,Symbol.hasInstance,{configurable:true,
 value:function(o){return !!o&&typeof o==='object'&&o.nodeType===9;}});}catch(e){}
function HTMLDocument(){throw new TypeError('Illegal constructor');}
W.Document=Document;W.HTMLDocument=HTMLDocument;
Document.prototype=DocumentProto;HTMLDocument.prototype=DocumentProto;
Object.defineProperty(DocumentProto,'constructor',
 {configurable:true,writable:true,value:HTMLDocument});
/* Set once the real ones are defined, further down. Anything that runs
   before that sees the array, which is what it used to be. */
W.NodeList=W.HTMLCollection=Array;
['CharacterData','Text','Comment','CDATASection','ProcessingInstruction','Attr','DocumentFragment','DocumentType','ShadowRoot','SVGElement','SVGSVGElement','HTMLUnknownElement','HTMLAnchorElement','HTMLAreaElement','HTMLAudioElement','HTMLBaseElement','HTMLBodyElement','HTMLBRElement','HTMLButtonElement','HTMLCanvasElement','HTMLDataElement','HTMLDataListElement','HTMLDetailsElement','HTMLDialogElement','HTMLDivElement','HTMLDListElement','HTMLEmbedElement','HTMLFieldSetElement','HTMLFontElement','HTMLFormElement','HTMLFrameElement','HTMLFrameSetElement','HTMLHeadElement','HTMLHeadingElement','HTMLHRElement','HTMLHtmlElement','HTMLIFrameElement','HTMLImageElement','HTMLInputElement','HTMLLabelElement','HTMLLegendElement','HTMLLIElement','HTMLLinkElement','HTMLMapElement','HTMLMarqueeElement','HTMLMediaElement','HTMLMenuElement','HTMLMetaElement','HTMLMeterElement','HTMLModElement','HTMLObjectElement','HTMLOListElement','HTMLOptGroupElement','HTMLOptionElement','HTMLOutputElement','HTMLParagraphElement','HTMLParamElement','HTMLPictureElement','HTMLPreElement','HTMLProgressElement','HTMLQuoteElement','HTMLScriptElement','HTMLSelectElement','HTMLSlotElement','HTMLSourceElement','HTMLSpanElement','HTMLStyleElement','HTMLTableCaptionElement','HTMLTableCellElement','HTMLTableColElement','HTMLTableElement','HTMLTableRowElement','HTMLTableSectionElement','HTMLTemplateElement','HTMLTextAreaElement','HTMLTimeElement','HTMLTitleElement','HTMLTrackElement','HTMLUListElement','HTMLVideoElement'].forEach(function(n){W[n]=Element;});
/* Interfaces that polyfills enumerate and read .prototype from. They
 * carry no behaviour here; what matters is that window[name] exists so a
 * feature-patching loop does not stop the page at its first entry. */
['DOMTokenList','NamedNodeMap','NodeIterator','TreeWalker','Range','StaticRange','AbstractRange',
 'StyleSheet','CSSStyleSheet','CSSStyleDeclaration','CSSRule','CSSRuleList','MediaList',
 'XMLDocument','DOMImplementation','DOMStringMap','MutationRecord','DOMRect','DOMRectReadOnly',
 'DOMPoint','DOMMatrix','Selection','XPathResult','AnimationEvent','TransitionEvent',
 'HTMLAllCollection','RadioNodeList','ValidityState'].forEach(function(n){if(W[n]===undefined)W[n]=function(){};});
var WindowProto={};Object.setPrototypeOf(W,WindowProto);
/* window.constructor.name is Window, which code reads to tell a window
   from a worker or an iframe's global. */
function Window(){throw new TypeError('Illegal constructor');}
Window.prototype=WindowProto;
Object.defineProperty(WindowProto,'constructor',
 {configurable:true,writable:true,value:Window});
W.Window=Window;
/* The event target calls belong on the prototype, not on window itself.
 * A polyfill reads an own descriptor off Window.prototype to wrap them,
 * finds nothing when they sit on the global, and then calls the wrapper
 * it never made. Moving them keeps window.addEventListener resolving
 * exactly as before, through the chain. */
['addEventListener','removeEventListener','dispatchEvent'].forEach(function(k){
 if(Object.prototype.hasOwnProperty.call(W,k)){WindowProto[k]=W[k];delete W[k];}
});
if(!WindowProto.dispatchEvent)WindowProto.dispatchEvent=function(e){return __vitaDispatch(null,e);};
W.Window=function(){};W.Window.prototype=WindowProto;W.Navigator=W.Location=W.History=W.Screen=W.Storage=Storage;
/* --- event handler properties -------------------------------------------
 * el.onclick = fn is how a great deal of code registers a handler, and
 * none of these existed. The names come from the WebIDL the specs are
 * written in, by way of the conformance page, rather than from whichever
 * one a site happened to use.
 *
 * Assignment cannot be implemented by adding and removing listeners,
 * because removeEventListener does not remove anything here. Register one
 * listener per name the first time and let it call whatever the property
 * currently holds, so reassigning swaps the target and assigning null
 * stops it. */
var EVENT_HANDLERS=('abort auxclick beforeinput beforematch beforetoggle blur cancel canplay '+
'canplaythrough change click close command contextlost contextmenu contextrestored copy cuechange '+
'cut dblclick drag dragend dragenter dragleave dragover dragstart drop durationchange emptied '+
'ended error focus formdata gotpointercapture input invalid keydown keypress keyup load '+
'loadeddata loadedmetadata loadstart lostpointercapture mousedown mouseenter mouseleave mousemove '+
'mouseout mouseover mouseup paste pause play playing pointercancel pointerdown pointerenter '+
'pointerleave pointermove pointerout pointerover pointerrawupdate pointerup progress ratechange '+
'reset resize scroll scrollend securitypolicyviolation seeked seeking select selectionchange '+
'selectstart slotchange stalled submit suspend timeupdate toggle touchcancel touchend touchmove '+
'touchstart volumechange waiting wheel').split(' ');
var WINDOW_HANDLERS=('afterprint beforeprint beforeunload hashchange languagechange message '+
'messageerror offline online pagehide pagereveal pageshow pageswap popstate rejectionhandled '+
'storage unhandledrejection unload').split(' ');
var DOCUMENT_HANDLERS=['readystatechange','visibilitychange'];
var HANDLER_NAMES={};
function defineHandler(obj,type){
 HANDLER_NAMES['on'+type]=true;
 var prop='on'+type, slot='__on_'+type, wrapped='__onw_'+type;
 /* enumerable, as an IDL attribute is: code walks an element with
    for..in to find the event surface, and these were invisible to it */
 Object.defineProperty(obj,prop,{configurable:true,enumerable:true,
  get:function(){return this[slot]||null;},
  set:function(f){
   var self=this;
   if(!Object.prototype.hasOwnProperty.call(this,wrapped)){
    var w=function(e){
     var h=self[slot];
     if(typeof h!=='function')return;
     var r=h.call(self,e);
     /* a handler property that returns false cancels the event, the
        same as an inline handler that does: form.onsubmit = () => false
        submitted anyway without this */
     if(r===false&&e&&e.preventDefault)e.preventDefault();
     return r;};
    Object.defineProperty(this,wrapped,{value:w,writable:true,enumerable:false,configurable:true});
    if(typeof this.addEventListener==='function')this.addEventListener(type,w);
   }
   Object.defineProperty(this,slot,
    {value:(typeof f==='function'?f:null),writable:true,enumerable:false,configurable:true});
  }});
}
EVENT_HANDLERS.forEach(function(t){defineHandler(P,t);defineHandler(D,t);defineHandler(W,t);});
WINDOW_HANDLERS.forEach(function(t){defineHandler(W,t);defineHandler(P,t);});
DOCUMENT_HANDLERS.forEach(function(t){defineHandler(D,t);});
/* An on-something content attribute set after parsing compiles into a
   handler too. Only the ones present at parse time were wired up, so
   el.setAttribute('onclick', '...') set a string and nothing else, and
   removing the attribute left the handler behind. */
function makeHandler(src){
 try{
  return new Function('event',
   'var __r=(function(event){'+src+'\n}).call(this,event);'+
   'if(__r===false&&event&&event.preventDefault)event.preventDefault();'+
   'return __r;');
 }catch(e){return null;}}
/* A clone carries its on-something attributes but not the handlers they
   stand for: those are wired when the page is parsed, and a copy is not
   parsed. A form cloned out of a template kept its onsubmit attribute
   and had no handler, so it submitted and the page navigated away. */
function wireHandlers(node){
 if(!node||node.nodeType!==1&&node.nodeType!==11)return node;
 var all=node.nodeType===1?[node]:[],kids,i,j,names,f;
 kids=node.getElementsByTagName?node.getElementsByTagName('*'):[];
 for(i=0;i<kids.length;i++)all.push(kids[i]);
 for(i=0;i<all.length;i++){
  if(!all[i].getAttributeNames)continue;
  names=all[i].getAttributeNames();
  for(j=0;j<names.length;j++){
   if(!HANDLER_NAMES[names[j]])continue;
   f=makeHandler(String(all[i].getAttribute(names[j])));
   if(f)all[i][names[j]]=f;}}
 return node;}
(function(){
 var setA=P.setAttribute,rmA=P.removeAttribute;
 P.setAttribute=function(n,v){
  var r=setA.apply(this,arguments),name=String(n).toLowerCase();
  if(HANDLER_NAMES[name]){
   var f=makeHandler(String(v));
   if(f)this[name]=f;}
  return r;};
 P.removeAttribute=function(n){
  var name=String(n).toLowerCase();
  if(HANDLER_NAMES[name])this[name]=null;
  return rmA.apply(this,arguments);};})();
/* The body's window-reflecting handlers are the window's: body.onload =
   f installs on the window, which is how a lot of pages register one,
   and reading it back gives what the window has. Only body and frameset
   forward; on any other element the property is its own. */
var FORWARDED=('blur error focus load resize scroll afterprint beforeprint '+
 'beforeunload hashchange languagechange message messageerror offline '+
 'online pagehide pageshow popstate rejectionhandled storage '+
 'unhandledrejection unload').split(' ');
FORWARDED.forEach(function(type){
 var prop='on'+type,d=Object.getOwnPropertyDescriptor(P,prop);
 if(!d||!d.get)return;
 function forwards(el){
  var t=el&&el.tagName;
  return t==='BODY'||t==='FRAMESET';}
 Object.defineProperty(P,prop,{configurable:true,enumerable:true,
  get:function(){return forwards(this)?W[prop]:d.get.call(this);},
  set:function(f){if(forwards(this))W[prop]=f;else d.set.call(this,f);}});});

/* --- the event interfaces, with the fields handlers read ---------------- */
function UIEventC(type,init){Event.call(this,type,init);init=init||{};
 this.detail=init.detail||0;
 /* the default view is null, not the window: a UIEvent nobody gave a
    view to has none */
 this.view=init.view!==undefined&&init.view!==null?init.view:null;
 this.which=init.which||0;}
UIEventC.prototype=Object.create(Event.prototype);
/* The fields these declare, so an interface built on one inherits them
   -- a FocusEvent has view and detail, and had neither. */
UIEventC.__vitaFields={view:null,detail:0,which:0};
UIEventC.prototype.initUIEvent=function(t,b,c,v,d){this.initEvent(t,b,c);this.view=v;this.detail=d;};
function MouseEventC(type,init){UIEventC.call(this,type,init);init=init||{};
 ['screenX','screenY','clientX','clientY','movementX','movementY'].forEach(function(k){
  this[k]=init[k]||0;},this);
 this.pageX=this.clientX;this.pageY=this.clientY;
 this.offsetX=this.clientX;this.offsetY=this.clientY;
 this.layerX=this.clientX;this.layerY=this.clientY;
 this.x=this.clientX;this.y=this.clientY;
 this.button=init.button||0;this.buttons=init.buttons||0;
 this.ctrlKey=!!init.ctrlKey;this.shiftKey=!!init.shiftKey;
 this.altKey=!!init.altKey;this.metaKey=!!init.metaKey;
 this.relatedTarget=init.relatedTarget||null;}
MouseEventC.prototype=Object.create(UIEventC.prototype);
MouseEventC.__vitaFields={view:null,detail:0,which:0,
 screenX:0,screenY:0,clientX:0,clientY:0,movementX:0,movementY:0,
 button:0,buttons:0,relatedTarget:null,
 ctrlKey:false,shiftKey:false,altKey:false,metaKey:false};
MouseEventC.prototype.getModifierState=function(k){
 return k==='Control'?this.ctrlKey:k==='Shift'?this.shiftKey:
        k==='Alt'?this.altKey:k==='Meta'?this.metaKey:false;};
MouseEventC.prototype.initMouseEvent=function(t,b,c){this.initEvent(t,b,c);};
function KeyboardEventC(type,init){UIEventC.call(this,type,init);init=init||{};
 this.key=init.key||'';this.code=init.code||'';
 this.keyCode=init.keyCode||0;this.charCode=init.charCode||0;
 this.location=init.location||0;this.repeat=!!init.repeat;this.isComposing=!!init.isComposing;
 this.ctrlKey=!!init.ctrlKey;this.shiftKey=!!init.shiftKey;
 this.altKey=!!init.altKey;this.metaKey=!!init.metaKey;}
KeyboardEventC.prototype=Object.create(UIEventC.prototype);
KeyboardEventC.__vitaFields={view:null,detail:0,which:0,
 key:'',code:'',keyCode:0,charCode:0,location:0,repeat:false,
 isComposing:false,
 ctrlKey:false,shiftKey:false,altKey:false,metaKey:false};
KeyboardEventC.prototype.getModifierState=MouseEventC.prototype.getModifierState;
KeyboardEventC.prototype.initKeyboardEvent=function(t,b,c){this.initEvent(t,b,c);};
/* Event itself: the members a handler reads that were not there. */
/* NONE until a dispatch puts the event in a phase. It used to read
   AT_TARGET always, so an untouched event claimed to be mid-dispatch. */
Object.defineProperty(Event.prototype,'eventPhase',{configurable:true,
 get:function(){return this._phase===undefined?0:this._phase;},
 set:function(v){shadowProp(this,'_phase',v|0);}});
Object.defineProperty(Event.prototype,'isTrusted',{configurable:true,
 get:function(){return TRUSTED.has(this);}});
/* one a script made says what it was made with; the browser's own
   events leave shadow trees */
Object.defineProperty(Event.prototype,'composed',{configurable:true,get:function(){
 return this.__vsComposed!==undefined?this.__vsComposed:true;}});
Object.defineProperty(Event.prototype,'srcElement',{configurable:true,get:function(){return this.target;}});
Object.defineProperty(Event.prototype,'returnValue',{configurable:true,
 get:function(){return !this.defaultPrevented;},set:function(v){if(!v)this.preventDefault();}});
/* A real flag, not a constant false: the C side reads it back after each
 * listener and stops libdom's propagation with it, so a stub here is
 * what made stopPropagation do nothing. Setting it false does not
 * restart propagation, which is what the specification says. */
Object.defineProperty(Event.prototype,'cancelBubble',{configurable:true,
 get:function(){return !!this.__cancelBubble;},
 set:function(v){if(v)this.__cancelBubble=true;}});
/* From the node the event was sent to, which a listener outside its
   shadow tree sees as the host, out through the shadow roots it leaves.
   A closed tree's nodes are left out for a listener outside it. */
Event.prototype.composedPath=function(){
 var out=[],n=this.__vsOrigin||this.target,ct=this.currentTarget,h,x;
 function inside(c,r){for(;c;c=c.parentNode||shadowHost(c))if(c===r)return true;return false;}
 while(n){
  out.push(n);
  if(n.nodeType===11&&(h=shadowHost(n))){
   if(!this.composed)break;
   if(SH_HOST(n,true)&&!inside(ct,n))out=[];
   n=h;}
  else n=n.parentNode;}
 if(out[out.length-1]!==D&&out[out.length-1]===D.documentElement)out.push(D);
 if(out[out.length-1]===D)out.push(W);
 return out;};

/* MessageChannel, which schedulers use to get a macrotask: React and
 * YouTube's player both post to a port instead of calling setTimeout(0),
 * because a real browser clamps nested timeouts and does not clamp this.
 * A timer is the honest equivalent here -- delivery stays asynchronous
 * and ordered, which is what the schedulers depend on. */
/* As the HTML standard has them (VitaSurf): what a port is sent waits in
 * its queue until the port is started, which setting onmessage does and
 * addEventListener does not, so a message sent before the other side
 * listens is not lost; ports can be handed on in a transfer list, and
 * arrive in the event's ports. */
function portList(t){
 var out=[],i;
 if(t&&typeof t.length==='number')
  for(i=0;i<t.length;i++)if(t[i]&&t[i].__vsPort)out.push(t[i]);
 return out;}
/* a transferred port arrives as a new port of the receiving realm, which
   takes over the old one's entanglement and queue; the old one is left
   neutered, as a transfer leaves it */
function portMove(list,Ctor){
 return list.map(function(o){
  var n=new Ctor();
  n._peer=o._peer;if(o._peer)o._peer._peer=n;
  n._q=o._q;o._peer=null;o._q=[];o._l=[];o._on=null;
  return n;});}
function MessagePort(){
 Object.defineProperties(this,{_peer:{value:null,writable:true},
  _l:{value:[],writable:true},_q:{value:[],writable:true},
  _on:{value:null,writable:true},_started:{value:false,writable:true},
  __vsPort:{value:true}});}
MessagePort.prototype._flush=function(){
 var p=this;
 if(!p._started||!p._q.length)return;
 setTimeout(function(){
  var m=p._q.shift(),e;
  if(!m)return;
  e={data:m.data,type:'message',target:p,currentTarget:p,source:null,origin:'',
   ports:m.ports,lastEventId:'',isTrusted:true,preventDefault:function(){},
   stopPropagation:function(){},stopImmediatePropagation:function(){}};
  if(typeof p._on==='function'){try{p._on.call(p,e);}catch(x){console.error(x);}}
  p._l.slice().forEach(function(f){
   try{typeof f==='function'?f.call(p,e):f.handleEvent(e);}catch(x){console.error(x);}});
  p._flush();},0);};
MessagePort.prototype.postMessage=function(data,transfer){
 var p=this._peer,ports;
 if(!p)return;
 ports=portList(transfer&&!Array.isArray(transfer)&&transfer.transfer?transfer.transfer:transfer);
 if(!ports.length){try{data=W.structuredClone(data);}catch(e){}}
 else ports=portMove(ports,p.constructor);
 p._q.push({data:data,ports:ports});
 p._flush();};
Object.defineProperty(MessagePort.prototype,'onmessage',{configurable:true,
 get:function(){return this._on;},
 set:function(f){this._on=typeof f==='function'?f:null;this.start();}});
MessagePort.prototype.addEventListener=function(t,f){
 if(t==='message'&&f&&this._l.indexOf(f)<0)this._l.push(f);};
MessagePort.prototype.removeEventListener=function(t,f){this._l=this._l.filter(function(g){return g!==f;});};
MessagePort.prototype.start=function(){this._started=true;this._flush();};
MessagePort.prototype.close=function(){
 if(this._peer)this._peer._peer=null;
 this._peer=null;this._q=[];};
MessagePort.prototype.dispatchEvent=function(){return true;};
function MessageChannel(){this.port1=new MessagePort();this.port2=new MessagePort();this.port1._peer=this.port2;this.port2._peer=this.port1;}
W.MessageChannel=MessageChannel;W.MessagePort=MessagePort;
W.MessageEvent=W.MessageEvent||Event;
/* The three with real fields; the aliases above stay plain Events. */
W.UIEvent=UIEventC;W.MouseEvent=MouseEventC;W.KeyboardEvent=KeyboardEventC;
/* their names, for Object.prototype.toString, as a browser's give */
[['Event',Event],['CustomEvent',CustomEvent],['UIEvent',UIEventC],
 ['MouseEvent',MouseEventC],['KeyboardEvent',KeyboardEventC]].forEach(function(p){
 if(!Object.prototype.hasOwnProperty.call(p[1].prototype,Symbol.toStringTag))
  Object.defineProperty(p[1].prototype,Symbol.toStringTag,{configurable:true,value:p[0]});});
/* These carry a mouse's or a key's fields, so give them those. */
W.WheelEvent=W.PointerEvent=W.DragEvent=MouseEventC;
W.FocusEvent=UIEventC;W.InputEvent=UIEventC;
if(!W.queueMicrotask)W.queueMicrotask=function(f){Promise.resolve().then(f);};
if(!W.structuredClone)W.structuredClone=function(v){try{return JSON.parse(JSON.stringify(v));}catch(e){return v;}};
/* MutationObserver is implemented further down, against the mutations
   qjs.c reports. */
W.ResizeObserver=W.PerformanceObserver=function(){};
W.ResizeObserver.prototype.observe=W.ResizeObserver.prototype.unobserve=
 W.ResizeObserver.prototype.disconnect=function(){};
W.PerformanceObserver.prototype=W.ResizeObserver.prototype;
/* IntersectionObserver is implemented further down, against the page's
   own geometry; it decides whether a lazily built list ever appears. */
/* atob by the forgiving-base64 rules (VitaSurf): padding may be left
   off, and anything else wrong throws. Home Assistant reads its login
   state from a query string whose parser drops the "=" padding, and the
   old decoder turned the missing padding into NUL bytes, so JSON.parse
   of the state threw and the app never asked for its token. */
/* the decoding and encoding are done in C where the natives are there
   (VitaSurf): this loop was a quarter of Cloudflare's challenge script
   on the Vita */
var ATOB=W.__vitaAtob,BTOA=W.__vitaBtoa;
try{delete W.__vitaAtob;delete W.__vitaBtoa;}catch(e){}
W.atob=function(s){
 if(arguments.length<1)
  throw new TypeError("Failed to execute 'atob' on 'Window': 1 argument required, but only 0 present.");
 if(typeof ATOB==='function'){
  var r=ATOB(String(s));
  if(r===null)
   throw new DOMException("Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded.",'InvalidCharacterError');
  return r;}
 var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
     o='',i,n=0,bits=0,c;
 s=String(s).replace(/[\t\n\f\r ]/g,'');
 if(s.length%4===0)s=s.replace(/==?$/,'');
 if(s.length%4===1||/[^A-Za-z0-9+\/]/.test(s))
  throw new DOMException("Failed to execute 'atob' on 'Window': The string to be decoded is not correctly encoded.",'InvalidCharacterError');
 for(i=0;i<s.length;i++){
  c=A.indexOf(s.charAt(i));
  n=(n<<6)|c;bits+=6;
  if(bits>=8){bits-=8;o+=String.fromCharCode((n>>bits)&255);}}
 return o;};
W.btoa=function(s){
 if(arguments.length<1)
  throw new TypeError("Failed to execute 'btoa' on 'Window': 1 argument required, but only 0 present.");
 s=String(s);
 if(typeof BTOA==='function'){
  var r=BTOA(s);
  if(r!==null)return r;}
 if(/[^\u0000-\u00ff]/.test(s))throw new DOMException("Failed to execute 'btoa' on 'Window': The string to be encoded contains characters outside of the Latin1 range.",'InvalidCharacterError');var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',o='',i=0;while(i<s.length){var a=s.charCodeAt(i++),b=s.charCodeAt(i++),c=s.charCodeAt(i++);var n=(a<<16)|((b||0)<<8)|(c||0);o+=A.charAt((n>>18)&63)+A.charAt((n>>12)&63)+(isNaN(b)?'=':A.charAt((n>>6)&63))+(isNaN(c)?'=':A.charAt(n&63));}return o;};
function Image(){return document.createElement('img');}W.Image=Image;
/* The other two legacy element constructors. new Audio() is how a page
   makes a sound without markup, and a page that calls it and gets a
   ReferenceError stops there: YouTube's player set-up did, so nothing
   after it ran. The argument is a source URL, as for <audio src>. */
function Audio(src){var a=document.createElement('audio');
 a.preload='auto';
 if(src!==undefined&&src!==null)a.setAttribute('src',String(src));
 return a;}
W.Audio=Audio;
function URLSearchParams(init){this._p=[];if(typeof init==='string'){init.replace(/^\?/,'').split('&').forEach(function(kv){if(!kv)return;var i=kv.indexOf('=');var k=i<0?kv:kv.slice(0,i),v=i<0?'':kv.slice(i+1);this._p.push([decodeURIComponent(k.replace(/\+/g,' ')),decodeURIComponent(v.replace(/\+/g,' '))]);},this);}else if(init&&typeof init==='object'){var self=this;(init._p?init._p:Object.keys(init).map(function(k){return [k,init[k]];})).forEach(function(kv){self._p.push([String(kv[0]),String(kv[1])]);});}}
URLSearchParams.prototype={get:function(k){for(var i=0;i<this._p.length;i++)if(this._p[i][0]===k)return this._p[i][1];return null;},getAll:function(k){return this._p.filter(function(p){return p[0]===k;}).map(function(p){return p[1];});},has:function(k){return this.get(k)!==null;},set:function(k,v){var d=false;this._p=this._p.filter(function(p){if(p[0]!==k)return true;if(d)return false;p[1]=String(v);d=true;return true;});if(!d)this._p.push([k,String(v)]);},append:function(k,v){this._p.push([k,String(v)]);},'delete':function(k){this._p=this._p.filter(function(p){return p[0]!==k;});},forEach:function(f,t){this._p.forEach(function(p){f.call(t,p[1],p[0]);});},keys:function(){return this._p.map(function(p){return p[0];})[Symbol.iterator]();},values:function(){return this._p.map(function(p){return p[1];})[Symbol.iterator]();},entries:function(){return this._p.map(function(p){return [p[0],p[1]];})[Symbol.iterator]();},toString:function(){return this._p.map(function(p){return encodeURIComponent(p[0])+'='+encodeURIComponent(p[1]);}).join('&');},sort:function(){this._p.sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0;});}};
URLSearchParams.prototype[Symbol.iterator]=URLSearchParams.prototype.entries;Object.defineProperty(URLSearchParams.prototype,'size',{get:function(){return this._p.length;}});
var URL_RE=/^([a-z][a-z0-9+.-]*:)?(?:\/\/(?:([^:@\/?#]*)(?::([^@\/?#]*))?@)?([^:\/?#]*)(?::(\d+))?)?([^?#]*)(\?[^#]*)?(#.*)?$/i;
function URL(url,base){url=String(url);var m=URL_RE.exec(url);if(!m)throw new TypeError('Invalid URL');if(!m[1]){if(base===undefined)throw new TypeError('Invalid URL');var b=new URL(String(base));var path=m[6];if(url.indexOf('//')===0){m[1]=b.protocol;m=URL_RE.exec(b.protocol+url);}else{m[1]=b.protocol;m[2]=b.username;m[3]=b.password;m[4]=b.hostname;m[5]=b.port;if(path===''){m[6]=b.pathname;if(!m[7])m[7]=b.search;}else if(path.charAt(0)!=='/'){var dir=b.pathname.replace(/[^\/]*$/,'');m[6]=dir+path;}var segs=[];m[6].split('/').forEach(function(sg){if(sg==='..')segs.pop();else if(sg!=='.')segs.push(sg);});m[6]=segs.join('/');if(m[6].charAt(0)!=='/')m[6]='/'+m[6];}}this.protocol=(m[1]||'').toLowerCase();this.username=m[2]||'';this.password=m[3]||'';this.hostname=(m[4]||'').toLowerCase();this.port=m[5]||'';this.pathname=m[6]||(this.hostname?'/':'');this.hash=m[8]&&m[8]!=='#'?m[8]:'';this.searchParams=new URLSearchParams(m[7]&&m[7]!=='?'?m[7]:'');}
/* search reads through searchParams rather than beside it: they used to
 * be two copies of the same thing, and setting one left the other to be
 * the one href was built from. Setting any part rewrites href. */
Object.defineProperties(URL.prototype,{
 search:{configurable:true,
  get:function(){var q=this.searchParams.toString();return q?'?'+q:'';},
  set:function(v){this.searchParams=new URLSearchParams(String(v));}},
 host:{configurable:true,
  get:function(){return this.hostname+(this.port?':'+this.port:'');},
  set:function(v){v=String(v);var i=v.indexOf(':');
   if(i<0){this.hostname=v.toLowerCase();this.port='';}
   else{this.hostname=v.slice(0,i).toLowerCase();this.port=v.slice(i+1);}}},
 /* A file URL has no host, and its origin serialises as the scheme
  * alone rather than as null. */
 origin:{configurable:true,get:function(){
  /* a blob URL's is the origin of the URL inside it */
  if(this.protocol==='blob:'){
   try{var in_=new URL(this.href.slice(5).replace(/#.*$/,''));
    return /^(https?|file):$/.test(in_.protocol)?in_.origin:'null';}
   catch(e){return 'null';}}
  if(this.hostname)return this.protocol+'//'+this.host;
  return this.protocol==='file:'?'file://':'null';}},
 href:{configurable:true,
  get:function(){var auth=this.username?this.username+(this.password?':'+this.password:'')+'@':'';
   return this.protocol+(this.hostname||this.protocol==='file:'?'//':'')+auth+this.host+this.pathname+this.search+this.hash;},
  set:function(v){var u=new URL(String(v));var self=this;
   ['protocol','username','password','hostname','port','pathname','hash'].forEach(function(k){self[k]=u[k];});
   this.searchParams=u.searchParams;}}});
URL.prototype.toString=URL.prototype.toJSON=function(){return this.href;};URL.createObjectURL=GAP('URL.createObjectURL',function(){return 'blob:';});URL.revokeObjectURL=function(){};URL.canParse=function(u,b){try{new URL(u,b);return true;}catch(e){return false;}};URL.parse=function(u,b){try{return new URL(u,b);}catch(e){return null;}};
W.URL=URL;W.URLSearchParams=URLSearchParams;
/* A dynamic import() in page code arrives here (qjs.c's import hook
 * passes the importing script's name as base). QuickJS loads modules
 * synchronously and can only compile source that has arrived, so wait
 * for the module first, then import it for real. */
W.__vitaImport=function(base,spec){
 return new Promise(function(res,rej){
  var t0=Date.now();
  function waitFor(b,sp,then){
   (function poll(){
    var st;
    try{st=W.__vitaModuleState(String(b),String(sp));}catch(e){rej(e);return;}
    if(st.state!=='arriving'){then(st.url);return;}
    if(Date.now()-t0>120000){rej(new TypeError('import of '+st.url+' timed out'));return;}
    setTimeout(poll,60);
   })();
  }
  waitFor(base,spec,function attempt(url){
   import(url).then(res,function(e){
    /* the module is here but one it imports is not: wait for that one
     * and try again, until the loader names nothing more */
    var m=/could not load module '([^']+)'/.exec(String(e&&e.message));
    if(m&&m[1]!==url&&Date.now()-t0<120000)waitFor(m[1],m[1],function(){attempt(url);});
    else rej(e);
   });
  });
 });
};
W.crypto={getRandomValues:function(a){for(var i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*4294967296);return a;},randomUUID:function(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16);});},subtle:{}};
function pad2(n){return (n<10?'0':'')+n;}
W.Intl={DateTimeFormat:function(loc,opt){opt=opt||{};this.format=function(d){d=d instanceof Date?d:new Date(d===undefined?Date.now():d);var s=d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());if(opt.hour||opt.minute||opt.timeStyle||opt.second)s=(opt.year||opt.month||opt.day||opt.dateStyle?s+' ':'')+pad2(d.getHours())+':'+pad2(d.getMinutes())+(opt.second||opt.timeStyle?':'+pad2(d.getSeconds()):'');return s;};this.formatToParts=function(d){return [{type:'literal',value:this.format(d)}];};this.resolvedOptions=function(){return {locale:'en-US',timeZone:opt.timeZone||'UTC',calendar:'gregory',numberingSystem:'latn'};};},NumberFormat:function(loc,opt){opt=opt||{};this.format=function(n){n=Number(n);var f=opt.maximumFractionDigits!==undefined?opt.maximumFractionDigits:(opt.style==='currency'?2:3);var s=n.toFixed(Math.min(f,20));if(s.indexOf('.')>=0&&opt.minimumFractionDigits===undefined)s=s.replace(/\.?0+$/,'');var parts=s.split('.');parts[0]=parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,',');s=parts.join('.');if(opt.style==='percent')s=(n*100).toFixed(0)+'%';if(opt.style==='currency')s=(opt.currency||'')+' '+s;return s;};this.formatToParts=function(n){return [{type:'integer',value:this.format(n)}];};this.resolvedOptions=function(){return {locale:'en-US'};};},Collator:function(){this.compare=function(a,b){a=String(a);b=String(b);return a<b?-1:a>b?1:0;};this.resolvedOptions=function(){return {locale:'en-US'};};},PluralRules:function(){this.select=function(n){return Number(n)===1?'one':'other';};},RelativeTimeFormat:function(){this.format=function(v,u){v=Number(v);var a=Math.abs(v);u=String(u).replace(/s$/,'');return v<0?a+' '+u+(a===1?'':'s')+' ago':'in '+a+' '+u+(a===1?'':'s');};},ListFormat:function(){this.format=function(l){return Array.prototype.join.call(l,', ');};},getCanonicalLocales:function(l){return [].concat(l||[]);},supportedValuesOf:function(){return [];}};
/* Immich's language picker names every locale through DisplayNames at
 * module load, and its layout builds a Locale; without them the whole
 * page was a rejected promise. English names for the common codes, the
 * code itself for the rest. */
var LANG_NAMES={af:'Afrikaans',ar:'Arabic',bg:'Bulgarian',bn:'Bengali',bs:'Bosnian',ca:'Catalan',cs:'Czech',cy:'Welsh',da:'Danish',de:'German',el:'Greek',en:'English',eo:'Esperanto',es:'Spanish',et:'Estonian',eu:'Basque',fa:'Persian',fi:'Finnish',fr:'French',fy:'Western Frisian',ga:'Irish',gl:'Galician',he:'Hebrew',hi:'Hindi',hr:'Croatian',hu:'Hungarian',hy:'Armenian',id:'Indonesian',is:'Icelandic',it:'Italian',ja:'Japanese',ka:'Georgian',kk:'Kazakh',km:'Khmer',ko:'Korean',lb:'Luxembourgish',lt:'Lithuanian',lv:'Latvian',mk:'Macedonian',ml:'Malayalam',mn:'Mongolian',mr:'Marathi',ms:'Malay',nb:'Norwegian Bokmål',ne:'Nepali',nl:'Dutch',nn:'Norwegian Nynorsk',no:'Norwegian',pl:'Polish',pt:'Portuguese',ro:'Romanian',ru:'Russian',si:'Sinhala',sk:'Slovak',sl:'Slovenian',sq:'Albanian',sr:'Serbian',sv:'Swedish',ta:'Tamil',te:'Telugu',th:'Thai',tr:'Turkish',uk:'Ukrainian',ur:'Urdu',vi:'Vietnamese',zh:'Chinese'};
var REGION_NAMES={US:'United States',GB:'United Kingdom',DE:'Germany',FR:'France',ES:'Spain',IT:'Italy',BR:'Brazil',PT:'Portugal',CN:'China',TW:'Taiwan',HK:'Hong Kong',JP:'Japan',KR:'South Korea',RU:'Russia',IN:'India',CA:'Canada',AU:'Australia',NL:'Netherlands',SE:'Sweden',NO:'Norway',DK:'Denmark',FI:'Finland',PL:'Poland',CZ:'Czechia',AT:'Austria',CH:'Switzerland',BE:'Belgium',MX:'Mexico',AR:'Argentina',TR:'Türkiye',UA:'Ukraine',GR:'Greece',IL:'Israel',IR:'Iran',SA:'Saudi Arabia',EG:'Egypt',ZA:'South Africa',NZ:'New Zealand',IE:'Ireland',HU:'Hungary',RO:'Romania',BG:'Bulgaria',HR:'Croatia',RS:'Serbia',SK:'Slovakia',SI:'Slovenia',LT:'Lithuania',LV:'Latvia',EE:'Estonia',ID:'Indonesia',MY:'Malaysia',TH:'Thailand',VN:'Vietnam',PH:'Philippines',SG:'Singapore',PK:'Pakistan',BD:'Bangladesh',NP:'Nepal',LK:'Sri Lanka',KH:'Cambodia',MN:'Mongolia',KZ:'Kazakhstan',GE:'Georgia',AM:'Armenia',IS:'Iceland',LU:'Luxembourg'};
W.Intl.DisplayNames=function(loc,opt){opt=opt||{};var type=opt.type||'language',fb=opt.fallback||'code';
 this.of=function(code){code=String(code);var out;
  if(type==='language'){var m=/^([A-Za-z]+)(?:[-_]([A-Za-z]{4}))?(?:[-_]([A-Za-z0-9]{2,3}))?/.exec(code);var l=m?m[1].toLowerCase():code.toLowerCase();out=LANG_NAMES[l];if(out&&m&&m[3]){var r=REGION_NAMES[m[3].toUpperCase()];out=out+' ('+(r||m[3].toUpperCase())+')';}else if(out&&m&&m[2]){out=out+' ('+(m[2]==='Hans'?'Simplified':m[2]==='Hant'?'Traditional':m[2])+')';}}
  else if(type==='region')out=REGION_NAMES[code.toUpperCase()];
  else if(type==='script')out={Latn:'Latin',Cyrl:'Cyrillic',Hans:'Simplified Han',Hant:'Traditional Han',Arab:'Arabic'}[code];
  else if(type==='currency')out={USD:'US Dollar',EUR:'Euro',GBP:'British Pound',JPY:'Japanese Yen'}[code.toUpperCase()];
  if(out===undefined)return fb==='none'?undefined:code;return out;};
 this.resolvedOptions=function(){return {locale:'en-US',style:opt.style||'long',type:type,fallback:fb};};};
W.Intl.Locale=function(tag,opt){tag=String(tag).replace(/_/g,'-');opt=opt||{};var p=tag.split('-');this.language=(opt.language||p[0]||'en').toLowerCase();var i=1;this.script=opt.script;this.region=opt.region;if(p[i]&&p[i].length===4){this.script=this.script||p[i];i++;}if(p[i]&&(p[i].length===2||p[i].length===3)){this.region=this.region||p[i].toUpperCase();i++;}this.baseName=this.language+(this.script?'-'+this.script:'')+(this.region?'-'+this.region:'');this.calendar=opt.calendar;this.numberingSystem=opt.numberingSystem;this.hourCycle=opt.hourCycle;this.toString=function(){return this.baseName;};this.maximize=function(){return this;};this.minimize=function(){return this;};this.getTextInfo=function(){return {direction:/^(ar|he|fa|ur|yi)$/.test(this.language)?'rtl':'ltr'};};this.getWeekInfo=function(){return {firstDay:1,weekend:[6,7],minimalDays:1};};};
W.Intl.Segmenter=function(loc,opt){var gran=(opt&&opt.granularity)||'grapheme';this.segment=function(str){str=String(str);var segs=[],i=0,re=gran==='word'?/(\s+|[^\s]+)/g:gran==='sentence'?/[^.!?]+[.!?]*\s*/g:/[\s\S]/gu;var m;while((m=re.exec(str))!==null){segs.push({segment:m[0],index:m.index,input:str,isWordLike:gran==='word'?!/^\s+$/.test(m[0]):undefined});if(m[0]==='')re.lastIndex++;}segs.containing=function(ix){for(var k=0;k<segs.length;k++)if(ix>=segs[k].index&&ix<segs[k].index+segs[k].segment.length)return segs[k];return undefined;};return segs;};this.resolvedOptions=function(){return {locale:'en-US',granularity:gran};};};
['DateTimeFormat','NumberFormat','Collator','PluralRules','RelativeTimeFormat','ListFormat','DisplayNames','Segmenter'].forEach(function(k){W.Intl[k].supportedLocalesOf=function(){return ['en-US'];};});
Date.prototype.toLocaleDateString=function(){return new Intl.DateTimeFormat(undefined,{year:1,month:1,day:1}).format(this);};Date.prototype.toLocaleTimeString=function(){return new Intl.DateTimeFormat(undefined,{hour:1,minute:1,second:1}).format(this);};Date.prototype.toLocaleString=function(){return new Intl.DateTimeFormat(undefined,{year:1,month:1,day:1,hour:1,minute:1,second:1}).format(this);};
function Option(t,v){var o=document.createElement('option');if(t!==undefined)o.textContent=t;if(v!==undefined)o.setAttribute('value',v);return o;}W.Option=Option;

/* A data: URL's media type and bytes, or null when it is not one. */
function dataURL(u){
 var m=/^data:([^,]*),([\s\S]*)$/i.exec(String(u)),meta,b64,body,out,i,c,s,enc;
 if(!m)return null;
 meta=m[1];b64=/;\s*base64\s*$/i.test(meta);
 if(b64)meta=meta.replace(/;\s*base64\s*$/i,'');
 meta=meta.replace(/^\s+|\s+$/g,'')||'text/plain;charset=US-ASCII';
 body=m[2];
 if(b64){
  try{s=W.atob(decodeURIComponent(body));}catch(e){return null;}
  out=new Uint8Array(s.length);
  for(i=0;i<s.length;i++)out[i]=s.charCodeAt(i)&255;}
 else{
  /* runs of text are encoded whole, so a character outside the basic
     plane is not split into two halves */
  var bytes=[],parts=body.split(/(%[0-9a-fA-F]{2})/),k,e;enc=new TextEncoder();
  for(i=0;i<parts.length;i++){
   c=parts[i];
   if(!c)continue;
   if(c.length===3&&c.charAt(0)==='%'&&/^%[0-9a-fA-F]{2}$/.test(c))bytes.push(parseInt(c.slice(1),16));
   else{e=enc.encode(c);for(k=0;k<e.length;k++)bytes.push(e[k]);}}
  out=new Uint8Array(bytes);}
 return {type:meta,bytes:out.buffer};}
/* --- XMLHttpRequest and fetch over __vitaFetch (qjs.c) --- */
function XMLHttpRequest(){this.readyState=0;this.status=0;this.statusText='';this.responseText='';this.response='';this.responseType='';this.responseURL='';this.timeout=0;this.withCredentials=false;this._h={};this._l={};this._id=0;this._rh='';this.upload={addEventListener:function(){},removeEventListener:function(){}};}
XMLHttpRequest.prototype={
UNSENT:0,OPENED:1,HEADERS_RECEIVED:2,LOADING:3,DONE:4,
open:function(m,u){this._m=String(m||'GET').toUpperCase();this._u=String(u);this._h={};this._set(1);},
setRequestHeader:function(k,v){k=String(k);v=String(v).trim();var l=k.toLowerCase();
 /* the browser's own: a page may not set them (the Fetch standard's
    forbidden request headers), and is not told */
 if(/^(accept-charset|accept-encoding|access-control-request-headers|access-control-request-method|connection|content-length|cookie|cookie2|date|dnt|expect|host|keep-alive|origin|referer|set-cookie|te|trailer|transfer-encoding|upgrade|via)$/.test(l)||/^(proxy-|sec-)/.test(l))return;
 for(var o in this._h)if(o.toLowerCase()===l){this._h[o]+=', '+v;return;}this._h[k]=v;},
_has:function(k){k=k.toLowerCase();for(var o in this._h)if(o.toLowerCase()===k)return true;return false;},
addEventListener:function(t,f){(this._l[t]=this._l[t]||[]).push(f);},
removeEventListener:function(t,f){if(this._l[t])this._l[t]=this._l[t].filter(function(g){return g!==f;});},
dispatchEvent:function(e){this._emit(e.type);return true;},
_emit:function(t){var e={type:t,target:this,currentTarget:this,lengthComputable:false,loaded:0,total:0,preventDefault:function(){},stopPropagation:function(){}};var f=this['on'+t];if(typeof f==='function')f.call(this,e);(this._l[t]||[]).forEach(function(g){if(typeof g==='function')g.call(this,e);else if(g&&g.handleEvent)g.handleEvent(e);},this);},
_set:function(s){this.readyState=s;this._emit('readystatechange');},
/* the body and the Content-Type it implies, as the Fetch standard
   extracts a body: text is text/plain, a blob its own type, bytes none;
   the page's own Content-Type wins */
_body:function(b){var type=null,data;
 if(b===undefined||b===null)data=null;
 else if(b instanceof URLSearchParams){type='application/x-www-form-urlencoded;charset=UTF-8';data=b.toString();}
 else if(b instanceof FormData){var mp=formMultipart(b._p);type=mp.type;data=mp.body;}
 /* bytes go to the network layer as an ArrayBuffer, every byte as it
    is; a string goes as its UTF-8 */
 else if(W.Blob&&b instanceof W.Blob){if(b.type)type=b.type;var u=b._u;data=u.buffer.slice(u.byteOffset,u.byteOffset+u.length);}
 else if(b instanceof ArrayBuffer)data=b.slice(0);
 else if(ArrayBuffer.isView(b))data=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
 else{type='text/plain;charset=UTF-8';data=String(b);}
 if(this._m!=='GET'&&this._m!=='HEAD'&&!this._has('Content-Type')){
  /* an empty value takes the network layer's own default away */
  this._h['Content-Type']=type||'';}
 return data;},
send:function(body){var self=this;if(this.readyState!==1)return;var data=this._body(body);var hs=[];for(var k in this._h)hs.push(this._h[k]===''?k+':':k+': '+this._h[k]);
 this._emit('loadstart');
 /* the body arrives as bytes; text is a decode of them, and a
    response that is not text keeps every byte it was sent */
 var done=function(status,headers,bytes,err,url){self._id=0;self._rh=headers||'';self.responseURL=url||self._u;
  if(err){self.status=0;self.statusText='';self.responseText='';self.response=null;self._bytes=null;self._set(4);self._emit(err==='timeout'?'timeout':'error');self._emit('loadend');return;}
  self.status=status;self.statusText=status===200?'OK':status===204?'No Content':status===404?'Not Found':'';self._set(2);self._set(3);
  self._bytes=bytes instanceof ArrayBuffer?bytes:new ArrayBuffer(0);
  var text=new TextDecoder().decode(self._bytes);
  self.responseText=text;
  var rt=self.responseType;if(rt==='json'){try{self.response=JSON.parse(text);}catch(e){self.response=null;}}
  else if(rt==='arraybuffer'){self.response=self._bytes;}
  else if(rt==='blob'){self.response=new Blob([self._bytes]);}
  else if(rt==='document'){self.response=null;}else self.response=text;
  self._set(4);self._emit('load');self._emit('loadend');};
 /* a data: URL is its own response (VitaSurf): Web Awesome's icons
    fetch their SVG from one, and the network layer refused them */
 if(/^data:/i.test(this._u)){
  var du=dataURL(this._u),u0=this._u;
  setTimeout(function(){
   if(!du)done(0,'',new ArrayBuffer(0),'bad data URL',u0);
   else done(200,'content-type: '+du.type,du.bytes,null,u0);},0);
  return;}
 this._id=__vitaFetch(this._u,this._m,hs,data,this.timeout|0,done);
 if(!this._id)setTimeout(function(){done(0,'',new ArrayBuffer(0),'request refused','');},0);},
abort:function(){if(this._id){__vitaFetchAbort(this._id);this._id=0;}if(this.readyState!==0&&this.readyState!==4){this.readyState=4;this.status=0;this._emit('readystatechange');this._emit('abort');this._emit('loadend');}this.readyState=0;},
getResponseHeader:function(n){var lines=this._rh.split('\n'),p=String(n).toLowerCase()+':';for(var i=0;i<lines.length;i++){if(lines[i].toLowerCase().indexOf(p)===0)return lines[i].slice(p.length).trim();}return null;},
getAllResponseHeaders:function(){return this._rh?this._rh.replace(/\n/g,'\r\n'):'';},
overrideMimeType:function(){}};
W.XMLHttpRequest=XMLHttpRequest;W.XMLHttpRequestUpload=function(){};W.XMLHttpRequestEventTarget=function(){};
/* WebSocket (VitaSurf), over curl's ws API in vita/js/websocket.c.
 * Home Assistant's whole interface talks to its server over one, and
 * the app stopped at "WebSocket is not defined" as soon as the login
 * went through. The connection runs in C; events come back through
 * __vitaWsEvent from the scheduler, never from inside a call here. */
(function(){
 if(typeof __vitaWsOpen!=='function')return;
 var OPEN_=__vitaWsOpen,SEND_=__vitaWsSend,CLOSE_=__vitaWsClose,
     BUF_=__vitaWsBuffered,socks=Object.create(null),
     /* the prototype as it is now: a later part replaces
        EventTarget.prototype, and listeners added through this one
        must be dispatched by this one */
     ETP=EventTarget.prototype;
 function dx(msg,name){return new DOMException(msg,name);}
 function fire(ws,e){
  var h=ws['on'+e.type];
  try{e.target=ws;e.currentTarget=ws;}catch(x){}
  if(typeof h==='function'){
   try{h.call(ws,e);}catch(err){if(W.__vitaReportError)W.__vitaReportError(err);}}
  ETP.dispatchEvent.call(ws,e);}
 function utf8len(s){
  var n=0,i,c;
  for(i=0;i<s.length;i++){c=s.charCodeAt(i);
   n+=c<0x80?1:c<0x800?2:(c>=0xd800&&c<0xdc00)?(i++,4):3;}
  return n;}
 function WebSocket(url,protocols){
  if(!(this instanceof WebSocket))
   throw new TypeError("Failed to construct 'WebSocket': Please use the 'new' operator");
  var u,list,i,st;
  try{u=new URL(String(url),location.href);}
  catch(e){throw dx("Failed to construct 'WebSocket': The URL '"+url+"' is invalid.",'SyntaxError');}
  if(u.protocol==='http:')u.protocol='ws:';
  else if(u.protocol==='https:')u.protocol='wss:';
  if(u.protocol!=='ws:'&&u.protocol!=='wss:')
   throw dx("Failed to construct 'WebSocket': The URL's scheme must be either "+
    "'http', 'https', 'ws', or 'wss'. '"+u.protocol.slice(0,-1)+"' is not allowed.",'SyntaxError');
  if(u.hash)u.hash='';
  list=protocols===undefined?[]:(typeof protocols==='string'?[protocols]:
   Array.prototype.slice.call(protocols).map(String));
  for(i=0;i<list.length;i++){
   if(!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(list[i])||list.indexOf(list[i])!==i)
    throw dx("Failed to construct 'WebSocket': The subprotocol '"+list[i]+
     "' is invalid.",'SyntaxError');}
  st={id:-1,state:0,protocol:'',binaryType:'blob',url:u.href,extra:0};
  Object.defineProperty(this,'__ws',{value:st});
  this.onopen=this.onmessage=this.onerror=this.onclose=null;
  st.id=OPEN_(u.href,list.join(', '),location.origin);
  if(st.id<0){
   var me=this;
   st.state=3;
   setTimeout(function(){
    fire(me,uaEvent(new Event('error')));
    fire(me,uaEvent(new CloseEvent('close',{wasClean:false,code:1006,reason:''})));},0);
   return;}
  socks[st.id]=this;}
 WebSocket.prototype=Object.create(ETP);
 WebSocket.prototype.constructor=WebSocket;
 ['CONNECTING','OPEN','CLOSING','CLOSED'].forEach(function(k,i){
  Object.defineProperty(WebSocket,k,{value:i,enumerable:true});
  Object.defineProperty(WebSocket.prototype,k,{value:i,enumerable:true});});
 function st(ws){
  if(!ws||!ws.__ws)throw new TypeError('Illegal invocation');
  return ws.__ws;}
 Object.defineProperties(WebSocket.prototype,{
  url:{configurable:true,get:function(){return st(this).url;}},
  readyState:{configurable:true,get:function(){return st(this).state;}},
  protocol:{configurable:true,get:function(){return st(this).protocol;}},
  extensions:{configurable:true,get:function(){st(this);return '';}},
  bufferedAmount:{configurable:true,get:function(){
   var s=st(this);return (s.id>0&&s.state<3?BUF_(s.id):0)+s.extra;}},
  binaryType:{configurable:true,get:function(){return st(this).binaryType;},
   set:function(v){if(v==='blob'||v==='arraybuffer')st(this).binaryType=v;}}});
 WebSocket.prototype.send=function(data){
  var s=st(this),me=this,n;
  if(arguments.length<1)
   throw new TypeError("Failed to execute 'send' on 'WebSocket': 1 argument required, but only 0 present.");
  if(s.state===0)
   throw dx("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",'InvalidStateError');
  if(W.Blob&&data instanceof W.Blob){
   if(s.state!==1){s.extra+=data.size||0;return;}
   data.arrayBuffer().then(function(b){if(s.state===1)SEND_(s.id,b);});
   return;}
  if(data instanceof ArrayBuffer||ArrayBuffer.isView(data)){
   n=data.byteLength;
   if(s.state!==1){s.extra+=n;return;}
   SEND_(s.id,data);return;}
  data=String(data);
  if(s.state!==1){s.extra+=utf8len(data);return;}
  SEND_(s.id,data);};
 WebSocket.prototype.close=function(code,reason){
  var s=st(this);
  if(code!==undefined){
   code=Number(code)|0;
   if(code!==1000&&(code<3000||code>4999))
    throw dx("Failed to execute 'close' on 'WebSocket': The close code must be either 1000, or between 3000 and 4999. "+code+' is neither.','InvalidAccessError');}
  reason=reason===undefined?'':String(reason);
  if(utf8len(reason)>123)
   throw dx("Failed to execute 'close' on 'WebSocket': The message must not be greater than 123 bytes.",'SyntaxError');
  if(s.state>=2)return;
  s.state=2;
  CLOSE_(s.id,code===undefined?(reason?1000:0):code,reason);};
 Object.defineProperty(W,'__vitaWsEvent',{configurable:true,writable:true,enumerable:false,
  value:function(id,kind,data,code){
   var ws=socks[id],s,d;
   if(!ws)return;
   s=ws.__ws;
   if(kind===1){
    if(s.state!==0)return;
    s.state=1;s.protocol=data||'';
    fire(ws,uaEvent(new Event('open')));}
   else if(kind===2||kind===3){
    if(s.state!==1)return;
    d=data;
    if(kind===3&&s.binaryType==='blob'&&W.Blob)d=new W.Blob([data]);
    fire(ws,uaEvent(new MessageEvent('message',{data:d,origin:new URL(s.url).origin})));}
   else if(kind===4){
    fire(ws,uaEvent(new Event('error')));}
   else if(kind===5){
    delete socks[id];
    s.state=3;
    fire(ws,uaEvent(new CloseEvent('close',{wasClean:code!==1006,code:code,reason:data||''})));}}});
 W.WebSocket=WebSocket;
})();

/* the entries form-associated custom elements give their form: a string,
   a File, or a FormData of their own (VitaSurf) */
function faceEntries(form){
 var out=[];
 listOf(form.getElementsByTagName('*')).forEach(function(e){
  if(e.localName.indexOf('-')<0)return;
  var v=W.__vitaFaceValue(e),n=e.getAttribute('name');
  if(v===undefined||v===null||e.hasAttribute('disabled'))return;
  if(v&&typeof v==='object'&&typeof v.forEach==='function'&&v._p){
   v.forEach(function(val,k){out.push([k,val]);});return;}
  if(n)out.push([n,typeof v==='object'?v:String(v)]);});
 return out;}
/* --- forms: the entry list and its encodings, as the HTML standard has
   them (VitaSurf). FormData holds strings and Files; a form's entries are
   its controls in tree order, the submitter alone of its buttons, and
   what the formdata event's listeners add. */
function FormData(form,submitter){
 this._p=[];
 if(form===undefined||form===null)return;
 if(!form||form.tagName!=='FORM')throw new TypeError("Failed to construct 'FormData': parameter 1 is not of type 'HTMLFormElement'.");
 if(submitter!==undefined&&submitter!==null){
  if(!isSubmitButton(submitter))throw new TypeError("Failed to construct 'FormData': The specified element is not a submit button.");
  if(submitter.form!==form)throw new DOMException("The specified element is not owned by this form element.",'NotFoundError');}
 var list=formEntryList(form,submitter||null);
 if(list===null)throw new DOMException('The form is already building its entry list.','InvalidStateError');
 this._p=list;}
function isSubmitButton(e){
 if(!e||!e.tagName)return false;
 var t=String(e.getAttribute('type')||'').toLowerCase();
 if(e.tagName==='BUTTON')return t===''||t==='submit'||(t!=='reset'&&t!=='button');
 return e.tagName==='INPUT'&&(t==='submit'||t==='image');}
/* a Blob is held as a File: its own name, the one given, or "blob" */
function formValue(v,filename){
 if(W.Blob&&v instanceof W.Blob){
  if(v instanceof W.File&&filename===undefined)return v;
  return new W.File([v],filename!==undefined?String(filename):
   (v instanceof W.File?v.name:'blob'),{type:v.type,lastModified:v.lastModified});}
 return String(v);}
FormData.prototype={
 append:function(k,v,filename){this._p.push([String(k),formValue(v,filename)]);},
 set:function(k,v,filename){k=String(k);var e=[k,formValue(v,filename)],at=-1;
  this._p=this._p.filter(function(p,i){if(p[0]!==k)return true;if(at<0){at=i;return true;}return false;});
  if(at<0)this._p.push(e);else this._p[at]=e;},
 get:function(k){k=String(k);for(var i=0;i<this._p.length;i++)if(this._p[i][0]===k)return this._p[i][1];return null;},
 getAll:function(k){k=String(k);return this._p.filter(function(p){return p[0]===k;}).map(function(p){return p[1];});},
 has:function(k){k=String(k);return this._p.some(function(p){return p[0]===k;});},
 'delete':function(k){k=String(k);this._p=this._p.filter(function(p){return p[0]!==k;});},
 forEach:function(f,t){this._p.slice().forEach(function(p){f.call(t,p[1],p[0],this);},this);},
 entries:function(){return this._p.map(function(p){return [p[0],p[1]];})[Symbol.iterator]();},
 keys:function(){return this._p.map(function(p){return p[0];})[Symbol.iterator]();},
 values:function(){return this._p.map(function(p){return p[1];})[Symbol.iterator]();},
 _urlencoded:function(){return formUrlencoded(this._p,false);}};
FormData.prototype[Symbol.iterator]=FormData.prototype.entries;
Object.defineProperty(FormData.prototype,Symbol.toStringTag,{configurable:true,value:'FormData'});
W.FormData=FormData;
function closestTag(e,tag){for(e=e.parentNode;e&&e.tagName;e=e.parentNode)if(e.tagName===tag)return e;return null;}
/* disabled itself, or in a disabled fieldset other than in its first
   legend */
function controlDisabled(e){
 if(e.hasAttribute('disabled'))return true;
 for(var c=e,f=e.parentNode;f&&f.tagName;c=f,f=f.parentNode){
  if(f.tagName==='FIELDSET'&&f.hasAttribute('disabled')){
   var lg=null,k;for(k=f.firstElementChild;k;k=k.nextElementSibling)if(k.tagName==='LEGEND'){lg=k;break;}
   if(!(lg&&(c===lg||lg.contains(c))))return true;}}
 return false;}
/* constructing the entry list: null while the form is already building
   one (a formdata listener that asks again) */
function formEntryList(form,submitter){
 if(form.__vsBuilding)return null;
 var out=[];
 listOf(form.elements).forEach(function(e){
  var tag=e.tagName,t=String(e.getAttribute('type')||'').toLowerCase(),n;
  if(!tag||tag==='FIELDSET'||tag==='OUTPUT'||tag==='OBJECT')return;
  if(e.localName.indexOf('-')>0)return;   /* form-associated custom elements: below */
  if(closestTag(e,'DATALIST')||controlDisabled(e))return;
  if(tag==='BUTTON'||(tag==='INPUT'&&(t==='submit'||t==='image'||t==='reset'||t==='button'))){
   if(e!==submitter||!isSubmitButton(e))return;}
  if(tag==='INPUT'&&(t==='checkbox'||t==='radio')&&!e.checked)return;
  if(tag==='INPUT'&&t==='image'){
   n=e.getAttribute('name')||'';var pre=n?n+'.':'';
   out.push([pre+'x','0'],[pre+'y','0']);return;}
  n=e.getAttribute('name');
  if(n===null||n==='')return;
  if(tag==='SELECT'){listOf(e.options).forEach(function(o){
    if(o.selected&&!o.disabled)out.push([n,o.value]);});return;}
  if(tag==='INPUT'&&(t==='checkbox'||t==='radio')){
   out.push([n,e.hasAttribute('value')?e.getAttribute('value'):'on']);return;}
  if(tag==='INPUT'&&t==='file'){
   var fl=listOf(e.files);
   if(!fl.length)out.push([n,new W.File([],'',{type:'application/octet-stream'})]);
   else fl.forEach(function(f){out.push([n,f]);});
   return;}
  if(tag==='INPUT'&&t==='hidden'&&n.toLowerCase()==='_charset_'){out.push([n,'UTF-8']);return;}
  out.push([n,String(e.value)]);
  var dn=e.getAttribute('dirname');
  if(dn&&(tag==='TEXTAREA'||(tag==='INPUT'&&/^(|text|search|tel|url|email|password)$/.test(t))))
   out.push([dn,'ltr']);});
 if(W.__vitaFaceSeen)faceEntries(form).forEach(function(p){
  out.push([p[0],formValue(p[1])]);});
 /* the formdata event: its listeners may add to what is sent */
 var fd=new FormData();fd._p=out;
 form.__vsBuilding=true;
 try{form.dispatchEvent(uaEvent(new W.FormDataEvent('formdata',{bubbles:true,formData:fd})));}
 finally{form.__vsBuilding=false;}
 return fd._p;}
/* newlines as CRLF, as each encoding has a form's names and values */
function formCRLF(s){return String(s).replace(/\r\n|\r|\n/g,'\r\n');}
/* application/x-www-form-urlencoded: UTF-8, spaces as +, and every byte
   but letters, digits and *-._ escaped; a File is its name */
function formUrlencoded(list,crlf){
 var enc=new TextEncoder(),hex='0123456789ABCDEF';
 function one(s){var b=enc.encode(crlf?formCRLF(s):s),o='',i,c;
  for(i=0;i<b.length;i++){c=b[i];
   if(c===0x20)o+='+';
   else if((c>=0x30&&c<=0x39)||(c>=0x41&&c<=0x5a)||(c>=0x61&&c<=0x7a)||c===0x2a||c===0x2d||c===0x2e||c===0x5f)o+=String.fromCharCode(c);
   else o+='%'+hex[c>>4]+hex[c&15];}
  return o;}
 return list.map(function(p){var v=p[1];
  return one(p[0])+'='+one(W.File&&v instanceof W.File?v.name:v);}).join('&');}
/* multipart/form-data, with a boundary as Chrome makes one */
function formMultipart(list){
 var chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789AB',
  r=new Uint8Array(16),bd='----WebKitFormBoundary',i,enc=new TextEncoder(),parts=[],total=0;
 try{W.crypto.getRandomValues(r);}catch(e){for(i=0;i<16;i++)r[i]=Math.random()*256|0;}
 for(i=0;i<16;i++)bd+=chars[r[i]&63];
 function esc(s){return s.replace(/\n/g,'%0A').replace(/\r/g,'%0D').replace(/"/g,'%22');}
 function add(u){parts.push(u);total+=u.length;}
 list.forEach(function(p){
  var v=p[1],h='--'+bd+'\r\nContent-Disposition: form-data; name="'+esc(formCRLF(p[0]))+'"';
  if(W.File&&v instanceof W.File){
   add(enc.encode(h+'; filename="'+esc(v.name)+'"\r\nContent-Type: '+
    (v.type||'application/octet-stream')+'\r\n\r\n'));
   add(v._u);add(enc.encode('\r\n'));}
  else add(enc.encode(h+'\r\n\r\n'+formCRLF(v)+'\r\n'));});
 add(enc.encode('--'+bd+'--\r\n'));
 var all=new Uint8Array(total),at=0;
 parts.forEach(function(u){all.set(u,at);at+=u.length;});
 return {body:all.buffer,type:'multipart/form-data; boundary='+bd};}
/* text/plain: name=value lines; a File is its name */
function formTextPlain(list){
 return list.map(function(p){var v=p[1];
  return formCRLF(p[0])+'='+formCRLF(W.File&&v instanceof W.File?v.name:v)+'\r\n';}).join('');}

/* HeadersInit as the Fetch standard reads it: anything iterable (an array,
   our Headers, another library's) is a list of name and value pairs, and
   any other object a record of its own keys, so a polyfill's methods and
   fields are not sent as headers */
function Headers(init){this._m={};if(init===undefined||init===null)return;
 if(typeof init!=='object'&&typeof init!=='function')throw new TypeError("Failed to construct 'Headers': The provided value is not of type 'HeadersInit'.");
 if(typeof init[Symbol.iterator]==='function'){
  for(var it=init[Symbol.iterator](),r=it.next();!r.done;r=it.next()){
   var p=r.value;if(p===null||typeof p!=='object'||typeof p[Symbol.iterator]!=='function')throw new TypeError("Failed to construct 'Headers': The provided value cannot be converted to a sequence.");
   p=Array.prototype.slice.call(Array.from(p));
   if(p.length!==2)throw new TypeError("Failed to construct 'Headers': Invalid value");
   this.append(p[0],p[1]);}}
 else Object.keys(init).forEach(function(k){this.append(k,init[k]);},this);}
Headers.prototype={append:function(k,v){k=String(k).toLowerCase();this._m[k]=(k in this._m)?this._m[k]+', '+String(v):String(v);},set:function(k,v){this._m[String(k).toLowerCase()]=String(v);},get:function(k){k=String(k).toLowerCase();return k in this._m?this._m[k]:null;},
has:function(k){return String(k).toLowerCase() in this._m;},'delete':function(k){delete this._m[String(k).toLowerCase()];},forEach:function(f,t){for(var k in this._m)f.call(t,this._m[k],k,this);},
keys:function(){return Object.keys(this._m)[Symbol.iterator]();},values:function(){var m=this._m;return Object.keys(m).map(function(k){return m[k];})[Symbol.iterator]();},entries:function(){var m=this._m;return Object.keys(m).map(function(k){return [k,m[k]];})[Symbol.iterator]();}};
Headers.prototype[Symbol.iterator]=Headers.prototype.entries;
function Response(body,init){init=init||{};this.status=init.status===undefined?200:init.status;this.ok=this.status>=200&&this.status<300;this.statusText=init.statusText||'';this.headers=new Headers(init.headers);this.url=init.url||'';this.type='basic';this.redirected=false;this.bodyUsed=false;
 /* bytes when we were given bytes: text() decodes them, and anything
    that is not text keeps every byte it was sent */
 if(body instanceof ArrayBuffer){this._ab=body;this._b=null;}
 else if(ArrayBuffer.isView&&ArrayBuffer.isView(body)){
  this._ab=body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength);
  this._b=null;}
 else{this._ab=null;this._b=body===undefined||body===null?'':String(body);}}
Response.prototype._text=function(){
 if(this._b===null||this._b===undefined)
  this._b=new TextDecoder().decode(this._ab||new ArrayBuffer(0));
 return this._b;};
Response.prototype._buffer=function(){
 if(this._ab)return this._ab;
 var e=new TextEncoder().encode(this._b||'');
 return e.buffer.slice(e.byteOffset,e.byteOffset+e.byteLength);};
(function(){
 var proto={
  text:function(){this.bodyUsed=true;return Promise.resolve(this._text());},
  json:function(){var b=this._text();this.bodyUsed=true;
   return new Promise(function(res,rej){
    try{res(JSON.parse(b));}catch(e){rej(e);}});},
  arrayBuffer:function(){this.bodyUsed=true;
   return Promise.resolve(this._buffer());},
  bytes:function(){this.bodyUsed=true;
   return Promise.resolve(new Uint8Array(this._buffer()));},
  blob:function(){var b=this._buffer(),ct=this.headers.get('content-type')||'';
   this.bodyUsed=true;return Promise.resolve(new Blob([b],{type:ct}));},
  formData:function(){var t=this._text();this.bodyUsed=true;
   var f=new FormData();
   new URLSearchParams(t).forEach(function(v,k){f.append(k,v);});
   return Promise.resolve(f);},
  clone:function(){
   return new Response(this._ab||this._b,
    {status:this.status,statusText:this.statusText,headers:this.headers,
     url:this.url});}};
 Object.keys(proto).forEach(function(k){Response.prototype[k]=proto[k];});})();
Response.error=function(){var r=new Response('',{status:0});r.type='error';return r;};Response.json=function(o,init){var r=new Response(JSON.stringify(o),init);if(!r.headers.has('content-type'))r.headers.set('content-type','application/json');return r;};
function Request(input,init){init=init||{};var from=input instanceof Request?input:null;this.url=from?from.url:String(input);this.method=String(init.method||(from?from.method:'GET')).toUpperCase();this.headers=new Headers(init.headers||(from?from.headers:undefined));this._body=init.body!==undefined?init.body:(from?from._body:null);this.credentials=init.credentials||'same-origin';this.mode=init.mode||'cors';this.cache=init.cache||'default';this.redirect=init.redirect||'follow';this.signal=init.signal||null;this.bodyUsed=false;}
Request.prototype={clone:function(){return new Request(this);},text:function(){return Promise.resolve(this._body==null?'':String(this._body));},json:function(){return this.text().then(JSON.parse);}};
W.fetch=function(input,init){var req=new Request(input,init);return new Promise(function(resolve,reject){var x=new XMLHttpRequest();x.open(req.method,req.url);req.headers.forEach(function(v,k){x.setRequestHeader(k,v);});
 x.onload=function(){var h=new Headers();x.getAllResponseHeaders().split('\r\n').forEach(function(l){var i=l.indexOf(':');if(i>0)h.append(l.slice(0,i),l.slice(i+1).trim());});var r=new Response(x._bytes||x.responseText,{status:x.status,statusText:x.statusText,headers:h,url:x.responseURL});r.redirected=x.responseURL!==req.url;resolve(r);};
 x.onerror=function(){reject(new TypeError('Failed to fetch'));};x.ontimeout=x.onerror;x.onabort=function(){var e=new Error('The operation was aborted');e.name='AbortError';reject(e);};
 if(req.signal){if(req.signal.aborted){x.onabort();return;}req.signal.addEventListener('abort',function(){x.abort();});}
 x.send(req._body);});};
W.Headers=Headers;W.Response=Response;W.Request=Request;
function AbortSignal(){this.aborted=false;this.reason=undefined;this.onabort=null;this._l=[];}
AbortSignal.prototype={addEventListener:function(t,f){if(t==='abort')this._l.push(f);},removeEventListener:function(t,f){this._l=this._l.filter(function(g){return g!==f;});},throwIfAborted:function(){if(this.aborted)throw this.reason;}};
AbortSignal.timeout=function(ms){var c=new AbortController();setTimeout(function(){c.abort();},ms);return c.signal;};
function AbortController(){this.signal=new AbortSignal();}
AbortController.prototype.abort=function(reason){var s=this.signal;if(s.aborted)return;s.aborted=true;s.reason=reason===undefined?new Error('aborted'):reason;var e={type:'abort',target:s};s._l.forEach(function(f){f(e);});if(typeof s.onabort==='function')s.onabort(e);};
W.AbortController=AbortController;W.AbortSignal=AbortSignal;
W.TextEncoder=function(){this.encoding='utf-8';};W.TextEncoder.prototype.encode=function(s){s=unescape(encodeURIComponent(String(s)));var a=new Uint8Array(s.length);for(var i=0;i<s.length;i++)a[i]=s.charCodeAt(i);return a;};
/* A real UTF-8 decoder. The old one built the string a character at a
 * time, wrapped the whole buffer whenever it was handed anything but a
 * Uint8Array -- a DataView or an Int8Array lost its byteOffset and
 * length, so the caller got the rest of the file as well -- and on
 * invalid input returned the bytes as Latin-1 instead of substituting
 * U+FFFD. three.js reads the JSON chunk of a .glb through this. */
W.TextDecoder=function(label){
 this.encoding=String(label===undefined?'utf-8':label).toLowerCase();
 this.fatal=false;this.ignoreBOM=false;};
W.TextDecoder.prototype.decode=function(b){
 if(b===undefined||b===null)return '';
 var v,out=[],i=0,n,c,cp,need;
 if(b instanceof Uint8Array)v=b;
 else if(b&&b.buffer instanceof ArrayBuffer)
  /* any other view: keep the window it describes */
  v=new Uint8Array(b.buffer,b.byteOffset,b.byteLength);
 else if(b instanceof ArrayBuffer)v=new Uint8Array(b);
 else return String(b);
 n=v.length;
 if(this.encoding==='utf-16le'||this.encoding==='utf-16'){
  for(;i+1<n;i+=2)out.push(v[i]|(v[i+1]<<8));
  return joinCodes(out);}
 if(this.encoding==='utf-16be'){
  for(;i+1<n;i+=2)out.push((v[i]<<8)|v[i+1]);
  return joinCodes(out);}
 if(this.encoding==='iso-8859-1'||this.encoding==='latin1'||
    this.encoding==='windows-1252'){
  for(;i<n;i++)out.push(v[i]);
  return joinCodes(out);}
 /* valid utf-8 is decoded in C in one go (VitaSurf); anything else
    comes back undefined and is decoded here */
 if(typeof __vitaUtf8Decode==='function'&&v instanceof Uint8Array){
  var fast=__vitaUtf8Decode(v);if(fast!==undefined)return fast;}
 /* utf-8, with a leading byte order mark dropped */
 if(n>=3&&v[0]===0xef&&v[1]===0xbb&&v[2]===0xbf)i=3;
 /* One U+FFFD per maximal subpart, as the encoding standard puts it:
    a sequence that goes wrong at its second byte gives one for the
    lead and then reconsiders the rest, rather than swallowing them.
    The bounds on the first continuation byte are what rule out an
    overlong form and a surrogate. */
 var lo,hi,j;
 for(;i<n;i++){
  c=v[i];
  if(c<0x80){out.push(c);continue;}
  if(c>=0xc2&&c<=0xdf){cp=c&0x1f;need=1;lo=0x80;hi=0xbf;}
  else if(c>=0xe0&&c<=0xef){cp=c&0x0f;need=2;
   lo=c===0xe0?0xa0:0x80;hi=c===0xed?0x9f:0xbf;}
  else if(c>=0xf0&&c<=0xf4){cp=c&0x07;need=3;
   lo=c===0xf0?0x90:0x80;hi=c===0xf4?0x8f:0xbf;}
  else{out.push(0xfffd);continue;}
  for(j=1;j<=need;j++){
   if(i+j>=n||v[i+j]<(j===1?lo:0x80)||v[i+j]>(j===1?hi:0xbf))break;
   cp=(cp<<6)|(v[i+j]&0x3f);}
  if(j<=need){out.push(0xfffd);i+=j-1;continue;}
  i+=need;
  if(cp>0xffff){cp-=0x10000;out.push(0xd800|(cp>>10),0xdc00|(cp&0x3ff));}
  else out.push(cp);}
 return joinCodes(out);};
/* fromCharCode takes the whole array, but not a million arguments at
   once: hand it blocks. */
function joinCodes(codes){
 var s='',i,n=codes.length,F=String.fromCharCode;
 for(i=0;i<n;i+=8192)s+=F.apply(null,codes.slice(i,i+8192));
 return s;}
/* --- custom elements ---------------------------------------------------
 * A registry, an upgrade path and the four reactions. Component sites
 * ship their whole UI as custom elements, so without this their script
 * defines classes that nothing ever instantiates and the page stays as
 * the server sent it.
 *
 * Upgrading works because Node.prototype is the prototype of every node
 * wrapper and wrappers are cached per DOM node in qjs.c, so an element
 * keeps its identity and its expandos. A custom element class extends
 * CEBase below; when its constructor calls super(), CEBase returns the
 * element being upgraded, which is what the derived constructor binds
 * `this` to. That is how a real browser's construction stack works.
 *
 * Everything here bails out on CEn (the number of definitions) so a page
 * that defines none pays one integer test per DOM call.
 */
var CE={},CEn=0,CEwait={},CEstack=[];
/* createElement without the upgrade step, for direct construction. */
var ceRawCreate=null;

function CEBase(){
 var e=CEstack.length?CEstack[CEstack.length-1]:undefined;
 if(e!==undefined)return e;
 /*
  * Direct construction: "new MyElement()" rather than the parser
  * upgrading a tag it met. The specification says to find the
  * definition whose constructor is new.target and make an element with
  * that definition's name; this used to throw for every case, and
  * github.com's header constructs its components that way, so the
  * component threw "Illegal constructor" and React drew its own error
  * box over the page.
  */
 var nt;
 try{nt=new.target;}catch(x){nt=undefined;}
 if(nt){
  for(var n in CE){
   var d=CE[n];
   if(!d||d.ctor!==nt)continue;
   var el=ceRawCreate?ceRawCreate.call(D,d.ext||n):D.createElement(d.ext||n);
   /* A customised built-in is the tag plus is="", as the parser writes it. */
   if(d.ext&&d.ext!==n)el.setAttribute('is',n);
   /* A class that does not extend HTMLElement would otherwise lose
    * every DOM method the moment its prototype is installed. */
   try{if(!P.isPrototypeOf(nt.prototype))Object.setPrototypeOf(nt.prototype,P);
       Object.setPrototypeOf(el,nt.prototype);}catch(x2){}
   /* Constructed, so inserting it must not run the constructor again --
    * but connectedCallback still has to fire, which state 2 allows. */
   ceSet(el,'__ceState',2);ceSet(el,'__ceDef',d);
   return el;
  }
 }
 throw new TypeError('Illegal constructor');
}
CEBase.prototype=P;
/* It is HTMLElement to the page, whatever it is called here. */
try{Object.defineProperty(CEBase,'name',
 {configurable:true,value:'HTMLElement'});}catch(e){}
W.HTMLElement=CEBase;
/* Every HTML*Element alias shares it, so `extends HTMLDivElement` works. */
Object.keys(W).forEach(function(k){if(k.indexOf('HTML')===0&&k!=='HTMLDocument'&&W[k]===Element)W[k]=CEBase;});

/* QuickJS puts only the frames in e.stack, so printing that alone loses
 * the error's type and message, which is the half worth reading. */
function ceErr(e){try{console.error('custom element: '+String(e)+(e&&e.stack?'\n'+e.stack:''));}catch(x){}}
function ceCall(el,name,args){var f=el[name];if(typeof f!=='function')return;try{f.apply(el,args||[]);}catch(e){ceErr(e);}}
/* In C, one call for the whole climb (VitaSurf): the parentNode walk
   here was a crossing into C per ancestor, and isConnected, which
   GitHub's components read from every attributeChangedCallback, was 8 %
   of its profile. The document object itself stays false, as it was. */
var ceConn=null;
function ceInDoc(n){
 if(!n||n===D)return false;
 if(ceConn===null)ceConn=typeof W.__vitaConnected==='function'?W.__vitaConnected:false;
 if(ceConn&&n.nodeType!==undefined)return ceConn(n);
 var r=D.documentElement;while(n){if(n===r)return true;n=n.parentNode;}return false;}

/* The definition an element would upgrade to, or null. */
function ceDefOf(el){
 if(!el||el.nodeType!==1)return null;
 var t=el.tagName;if(!t)return null;t=t.toLowerCase();
 if(t.indexOf('-')<0){var is=el.getAttribute('is');if(!is)return null;t=String(is).toLowerCase();}
 return CE[t]||null;
}

function ceSet(el,k,v){Object.defineProperty(el,k,{value:v,writable:true,enumerable:false,configurable:true});}

/* Elements waiting for their definition, by name (VitaSurf): what define()
   upgrades. Looking them up by tag in the document missed every one in a
   shadow tree, and Home Assistant's are nearly all in one. A browser
   keeps such a list too; this one forgets an element once it is
   upgraded, and stops growing at CE_PENDING_MAX. */
var CEpending=Object.create(null),CEpendingN=0,CE_PENDING_MAX=20000;
function cePend(el){
 if(el.__cePending||CEpendingN>=CE_PENDING_MAX)return;
 var t=el.tagName;if(!t)return;t=t.toLowerCase();
 if(t.indexOf('-')<0){var is=el.getAttribute('is');if(!is)return;t=String(is).toLowerCase();}
 (CEpending[t]||(CEpending[t]=[])).push(el);CEpendingN++;
 ceSet(el,'__cePending',true);}
function ceUpgrade(el,inDoc){
 if(el.__ceState)return;
 var d=ceDefOf(el);if(!d){cePend(el);return;}
 ceSet(el,'__ceState',1);ceSet(el,'__ceDef',d);
 try{
  /* A class that does not extend HTMLElement would otherwise lose every
   * DOM method the moment its prototype is installed. */
  if(!P.isPrototypeOf(d.ctor.prototype))Object.setPrototypeOf(d.ctor.prototype,P);
  Object.setPrototypeOf(el,d.ctor.prototype);
  CEstack.push(el);
  try{Reflect.construct(d.ctor,[],d.ctor);}finally{CEstack.pop();}
 }catch(e){el.__ceState=3;ceErr(e);return;}
 el.__ceState=2;
 var o=d.obs;
 for(var i=0;i<o.length;i++){
  if(el.hasAttribute(o[i]))ceCall(el,'attributeChangedCallback',[o[i],null,el.getAttribute(o[i]),null]);
 }
 if(inDoc===undefined?ceInDoc(el):inDoc){ceSet(el,'__ceConn',true);ceCall(el,'connectedCallback');}
}

/* Upgrade and connect every custom element in a subtree just inserted. */
function ceConnectTree(n,inDoc,skipSelf){
 if(!n)return;
 /* Only an element with a hyphen in its name or an is attribute can be
    a custom element, and C finds those without the walk wrapping every
    node of the subtree (VitaSurf). A callback that moves the tree about
    can take a later one out from under n; that one is passed over, as
    the walk would never have reached it. */
 if(typeof __vitaCECandidates==='function'){
  var l=__vitaCECandidates(n,!skipSelf),g=domGen(),k,e,up;
  for(k=0;k<l.length;k++){
   e=l[k];
   if(domGen()!==g){
    for(up=e;up&&up!==n;up=treeUp(up));
    if(!up)continue;}
   if(!e.__ceState)ceUpgrade(e,inDoc);
   else if(e.__ceState===2&&!e.__ceConn&&inDoc){ceSet(e,'__ceConn',true);ceCall(e,'connectedCallback');}}
  return;}
 if(!skipSelf&&n.nodeType===1){
  if(!n.__ceState)ceUpgrade(n,inDoc);
  else if(n.__ceState===2&&!n.__ceConn&&inDoc){ceSet(n,'__ceConn',true);ceCall(n,'connectedCallback');}
 }
 var c=n.childNodes;if(!c)return;
 for(var i=0;i<c.length;i++)ceConnectTree(c[i],inDoc,false);
}

function ceDisconnectTree(n,skipSelf){
 if(!n)return;
 /* the elements C finds that could be custom ones, as ceConnectTree
    does: the walk built a child list for every node of each subtree
    taken out, text included, and Home Assistant takes out thousands
    (VitaSurf) */
 if(typeof __vitaCECandidates==='function'){
  var l=__vitaCECandidates(n,!skipSelf),k,e;
  for(k=0;k<l.length;k++){
   e=l[k];
   if(e.__ceConn){ceSet(e,'__ceConn',false);ceCall(e,'disconnectedCallback');}}
  return;}
 if(!skipSelf&&n.nodeType===1&&n.__ceConn){ceSet(n,'__ceConn',false);ceCall(n,'disconnectedCallback');}
 var c=n.childNodes;if(!c)return;
 for(var i=0;i<c.length;i++)ceDisconnectTree(c[i],false);
}

W.customElements={
 define:function(name,ctor,opts){
  name=String(name).toLowerCase();
  if(typeof ctor!=='function')throw new TypeError('constructor is not a function');
  if(CE[name])throw new Error("the name \""+name+"\" has already been used");
  var obs=[];
  try{var a=ctor.observedAttributes;if(a)for(var i=0;i<a.length;i++)obs.push(String(a[i]).toLowerCase());}catch(e){}
  CE[name]={ctor:ctor,obs:obs,ext:opts&&opts['extends']?String(opts['extends']).toLowerCase():null};
  CEn++;
  /* upgrade what the parser already built, and what waits in a shadow
     tree or out of the page */
  var list=D.getElementsByTagName(CE[name].ext||name),j,wait=CEpending[name];
  for(j=0;j<list.length;j++)ceUpgrade(list[j]);
  if(wait){
   delete CEpending[name];CEpendingN-=wait.length;
   for(j=0;j<wait.length;j++){
    ceSet(wait[j],'__cePending',false);
    /* one made outside the page stays as it is until it goes in */
    if(ceInDoc(wait[j]))ceUpgrade(wait[j]);}}
  var w=CEwait[name];
  if(w){delete CEwait[name];for(var k=0;k<w.length;k++)w[k](ctor);}
 },
 /* by the name as given: a custom element's name is lower case, and a
    browser answers undefined for any other spelling. Lower-casing it on
    every call was 8 % of GitHub's profile, whose lazy loader asks for
    each tag it may load for every element it scans (VitaSurf). */
 get:function(name){var d=CE[name];return d&&d.ctor?d.ctor:undefined;},
 getName:function(c){for(var k in CE)if(CE[k].ctor===c)return k;return null;},
 whenDefined:function(name){
  name=String(name).toLowerCase();
  if(CE[name])return Promise.resolve(CE[name].ctor);
  return new Promise(function(res){(CEwait[name]=CEwait[name]||[]).push(res);});
 },
 upgrade:function(root){if(CEn)ceConnectTree(root,ceInDoc(root),false);}
};

/* Reactions on the DOM calls that move elements in and out of the tree. */
/* A fragment hands its children over and is empty once inserted, so
 * they are noted first: everything Lit renders arrives in one, and no
 * custom element in it was ever upgraded. */
function ceInserted(parent,n){
 var kids=n.nodeType===11?n.childNodes.slice():null;
 return function(){
  var inDoc=ceInDoc(parent),i;
  if(kids){for(i=0;i<kids.length;i++)ceConnectTree(kids[i],inDoc,false);}
  else ceConnectTree(n,inDoc,false);
 };
}
['appendChild','insertBefore'].forEach(function(m){
 var orig=P[m];
 P[m]=function(n){
  var after=(CEn&&n)?ceInserted(this,n):null;
  var r=orig.apply(this,arguments);if(after)after();return r;};
});
(function(){
 var orig=P.removeChild;
 P.removeChild=function(n){
  noteEdges(n);
  var r=orig.apply(this,arguments);if(CEn&&n)ceDisconnectTree(n,false);return r;};
})();
(function(){
 var orig=P.replaceChild;
 P.replaceChild=function(nw,old){
  noteEdges(old);
  var after=(CEn&&nw)?ceInserted(this,nw):null;
  var r=orig.apply(this,arguments);
  if(CEn){if(old)ceDisconnectTree(old,false);if(after)after();}return r;};
})();
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'innerHTML');
 Object.defineProperty(P,'innerHTML',{configurable:true,get:d.get,set:function(v){
  var old=CEn?this.childNodes.slice():null;
  d.set.call(this,v);
  if(CEn){for(var i=0;i<old.length;i++)ceDisconnectTree(old[i],false);ceConnectTree(this,ceInDoc(this),true);}
 }});
})();
(function(){
 var orig=P.setAttribute;
 P.setAttribute=function(n,v){
  var d=CEn?this.__ceDef:null;
  if(!d||d.obs.length===0)return orig.apply(this,arguments);
  var a=String(n).toLowerCase();
  if(d.obs.indexOf(a)<0)return orig.apply(this,arguments);
  var was=this.getAttribute(n),r=orig.apply(this,arguments),now=this.getAttribute(n);
  if(was!==now)ceCall(this,'attributeChangedCallback',[a,was,now,null]);
  return r;
 };
 var origRm=P.removeAttribute;
 P.removeAttribute=function(n){
  var d=CEn?this.__ceDef:null;
  if(!d||d.obs.length===0)return origRm.apply(this,arguments);
  var a=String(n).toLowerCase(),was=this.getAttribute(n),r=origRm.apply(this,arguments);
  if(was!==null&&d.obs.indexOf(a)>=0)ceCall(this,'attributeChangedCallback',[a,was,null,null]);
  return r;
 };
})();
(function(){
 var orig=D.createElement;
 /* CEBase needs this one: creating the element for "new MyElement()"
  * through the wrapper below would upgrade it, running the very
  * constructor that is already running. */
 ceRawCreate=orig;
 D.createElement=function(t,o){
  var el=orig.call(D,t);
  if(CEn&&el&&el.nodeType===1){if(o&&o.is)el.setAttribute('is',o.is);ceUpgrade(el,false);}
  return el;
 };
})();
/* The parser keeps adding elements after a define, so sweep once the
 * document is built. Both events reach document listeners (qjs.c). */
/*
 * A template's children are never in the document: they belong to its
 * content fragment from the moment the parser reads them. Here libdom
 * parses them into the template element and they move out the first time
 * content is read, so until some script asked, everything inside every
 * template was still in the page -- querySelectorAll('form') on GitHub's
 * saved front page found 43 forms where a browser finds 31, and the same
 * for the inputs and buttons inside them. Empty them once the parser is
 * done, and again at load for the ones added since.
 */
function sweepTemplates(){
 var t=D.getElementsByTagName('template'),i;
 for(i=0;i<t.length;i++)void t[i].content;}
/* qjs.c calls this before each script, because a script's first act is
   usually to query the document and the parser may have read a template
   since the last one. Touching content a second time costs nothing: the
   fragment is already there. */
/* Declarative shadow DOM (VitaSurf): a <template shadowrootmode> the
   parser read becomes its parent's shadow root, its content the root's,
   and the template leaves the tree, as the HTML standard's parser has
   it. libdom's parser counts the ones it makes, so the page is looked
   at only when there are new ones. One that cannot be attached (a host
   with a root already, or an element that takes none) stays a template. */
var SH_TPL=W.__vitaShadowTemplates,shTplSeen=0;
try{delete W.__vitaShadowTemplates;}catch(e){}
function declarativeShadows(root){
 var t=root.querySelectorAll('template[shadowrootmode]'),i;
 for(i=0;i<t.length;i++)declarativeShadow(t[i]);}
function declarativeShadow(t){
 var host=t.parentNode,mode=String(t.getAttribute('shadowrootmode')||'').toLowerCase(),r,f;
 if(mode!=='open'&&mode!=='closed')return;
 if(!host||host.nodeType!==1||SH_ROOT(host))return;
 try{r=host.attachShadow({mode:mode,
  delegatesFocus:t.hasAttribute('shadowrootdelegatesfocus'),
  clonable:t.hasAttribute('shadowrootclonable'),
  serializable:t.hasAttribute('shadowrootserializable'),
  slotAssignment:String(t.getAttribute('shadowrootslotassignment')||'').toLowerCase()==='manual'?'manual':'named'});}
 catch(e){return;}
 f=t.content;
 host.removeChild(t);
 r.appendChild(f);
 declarativeShadows(r);}
function beforeScript(){
 var n;
 if(typeof SH_TPL==='function'&&(n=SH_TPL())!==shTplSeen){
  shTplSeen=n;declarativeShadows(D);}
 sweepTemplates();}
W.__vitaBeforeScript=beforeScript;
/* setHTMLUnsafe and parseHTMLUnsafe take declarative shadow roots too;
   innerHTML leaves them as templates */
if(W.DOMParser&&W.Document&&!W.Document.parseHTMLUnsafe)
 W.Document.parseHTMLUnsafe=function(h){
  var d=new W.DOMParser().parseFromString(String(h),'text/html');
  try{declarativeShadows(d);}catch(e){}
  return d;};
W.addEventListener('DOMContentLoaded',function(){
 beforeScript();
 if(CEn)ceConnectTree(D.documentElement,true,false);});
W.addEventListener('load',function(){
 sweepTemplates();
 if(CEn)ceConnectTree(D.documentElement,true,false);});

/* Named access on the window (VitaSurf): window.foo is the element whose
 * id is foo, where the window has nothing of that name, as HTML says and
 * older scripts rely on ("myForm.submit()"). A getter is set for each id
 * once the document is parsed and again when it has loaded, looked up
 * afresh on each read; a script that assigns the name or declares it
 * gets an ordinary property instead. */
function namedAccess(){
 var all=D.querySelectorAll('[id]'),i,n=all.length<2000?all.length:2000;
 for(i=0;i<n;i++)(function(id){
  if(!id||id in W)return;
  try{Object.defineProperty(W,id,{configurable:true,enumerable:false,
   get:function(){return D.getElementById(id);},
   set:function(v){Object.defineProperty(W,id,{configurable:true,
    writable:true,enumerable:true,value:v});}});}catch(e){}
 })(all[i].id);}
W.addEventListener('DOMContentLoaded',namedAccess);
W.addEventListener('load',namedAccess);

/* Shadow DOM (VitaSurf). A shadow root is a document fragment its host
 * holds: a tree of its own, which the document's lookups do not enter,
 * drawn in the host's place, whose events go on to the host. It used to
 * be the host itself, so shadow content was the host's own children and
 * a root was no ShadowRoot: claude.ai's Turnstile checks that the root
 * it was given is one before every heartbeat, and dropped its widget. */
var SH_ATTACH=W.__vitaAttachShadow,SH_ROOT=W.__vitaShadowRoot,
 SH_HOST=W.__vitaShadowHost;
try{delete W.__vitaAttachShadow;delete W.__vitaShadowRoot;
 delete W.__vitaShadowHost;}catch(e){}
/* the host of a shadow root, or null for anything else */
function shadowHost(n){return n&&n.nodeType===11&&SH_HOST?SH_HOST(n):null;}
/* a node's parent, or for a shadow root its host */
function treeUp(n){return n.parentNode||shadowHost(n);}
/* the elements the specification lets have one, besides custom ones */
var SHADOW_TAGS=' article aside blockquote body div footer h1 h2 h3 h4 h5 h6 '+
 'header main nav p section span ';
var CE_RESERVED=' annotation-xml color-profile font-face font-face-src '+
 'font-face-uri font-face-format font-face-name missing-glyph ';
function ceValidName(n){
 return /^[a-z][a-z0-9._\u00b7\u00c0-\uffff-]*-[a-z0-9._\u00b7\u00c0-\uffff-]*$/.test(n)&&
  CE_RESERVED.indexOf(' '+n+' ')<0;}
var SH_NOTE=W.__vitaShadowNote;
try{delete W.__vitaShadowNote;}catch(e){}
function shNote(t){if(typeof SH_NOTE==='function')try{SH_NOTE(t);}catch(e){}}
P.attachShadow=function(init){
 if(this.nodeType!==1)throw new TypeError("Illegal invocation");
 var ok=false;
 try{var r0=attachShadowChecked.call(this,init);ok=true;return r0;}
 finally{if(!ok)shNote('<'+this.localName+'> was refused a shadow root'+
  (SH_ROOT(this)?', having one already':''));}};
function attachShadowChecked(init){
 var mode=init&&typeof init==='object'?init.mode:undefined,r,ln=this.localName;
 if(mode!=='open'&&mode!=='closed')
  throw new TypeError("Failed to execute 'attachShadow' on 'Element': "+
   (init&&typeof init==='object'?"Failed to read the 'mode' property from 'ShadowRootInit': The provided value '"+mode+
    "' is not a valid enum value of type ShadowRootMode.":
    "The provided value is not of type 'ShadowRootInit'."));
 if(this.namespaceURI!==HTML_NS||
    !(SHADOW_TAGS.indexOf(' '+ln+' ')>=0||ceValidName(ln)))
  throw new DOMException("Failed to execute 'attachShadow' on 'Element': "+
   "This element does not support attachShadow",'NotSupportedError');
 if(SH_ROOT(this))
  throw new DOMException("Failed to execute 'attachShadow' on 'Element': "+
   "Shadow root cannot be created on a host which already hosts a shadow tree.",
   'NotSupportedError');
 r=SH_ATTACH(this,mode==='closed');
 if(!r)throw new DOMException("Failed to execute 'attachShadow' on 'Element': "+
  "This element does not support attachShadow",'NotSupportedError');
 Object.defineProperty(r,'__vsInit',{configurable:true,value:{
  delegatesFocus:!!init.delegatesFocus,clonable:!!init.clonable,
  serializable:!!init.serializable,
  slotAssignment:init.slotAssignment==='manual'?'manual':'named'}});
 return r;};
P.getRootNode=function(o){
 var n=this,p;
 for(;;){
  while((p=n.parentNode))n=p;
  if(n===D.documentElement)return D;
  if(o&&o.composed&&(p=shadowHost(n))){n=p;continue;}
  return n;}};
/* the open one; a closed root is its host's own business */
Object.defineProperty(P,'shadowRoot',{configurable:true,get:function(){
 if(this.nodeType!==1)return undefined;
 var r=SH_ROOT(this);return r&&!SH_HOST(r,true)?r:null;}});
/* a shadow root's host; nothing else has one but a link (below) */
Object.defineProperty(P,'host',{configurable:true,get:function(){
 return this.nodeType===11?shadowHost(this)||undefined:undefined;}});
Object.defineProperty(P,'isConnected',{configurable:true,get:function(){return ceInDoc(this);}});
/* A shadow root's <style>, once per text (VitaSurf). With shadow DOM as
 * light DOM, every component that puts a style in its shadow root put a
 * <style> into the page, and NetSurf parsed each as its own sheet and
 * restyled the document for it: GitHub's contribution calendar has a
 * <tool-tip> for every day, and its 370 copies of the same sheet held
 * the page for seconds at a time. The first copy stays where the page
 * put it; later copies are left empty while it is still in the document,
 * and one comes back to life if it is not. A <style> with attributes,
 * a media query say, is left alone. */
(function(){
 var canon=Object.create(null);
 /* the copy kept for a text is live while it is in the document and
    still holds that text: a page may give it other text later */
 /* The text each kept copy was last given here (VitaSurf). Reading a
    style's text back makes a string of it; the check every half second
    below read every kept sheet's whole text that way, 6% of the script
    time of a Home Assistant load. A copy whose text is set any other
    way is no longer in it and is read as before. */
 var given=new WeakMap();
 function live(css){var c=canon[css];
  if(!c||!ceInDoc(c))return false;
  return given.get(c)===css||c.textContent===css;}
 function keep(n,css){canon[css]=n;given.set(n,css);}
 /* The emptied copies, by text (VitaSurf). If the kept copy leaves the
    document, the components still in it would lose their styles, so
    while any are parked a check every half second, doing nothing unless
    the tree has changed shape, gives the text back to the first parked
    copy still in the document and keeps that one instead. */
 var parked=Object.create(null),nparked=0,timer=null,lastShape=-1,
     rawText=null,si=W.setInterval,ci=W.clearInterval;
 var PARK_MAX=4000;
 function park(n,css){
  var l=parked[css]||(parked[css]=[]);
  if(l.length>=PARK_MAX){l.shift();nparked--;}
  l.push(n);nparked++;
  if(timer===null&&typeof si==='function')
   timer=si.call(W,revive,500);}
 function revive(){
  var g=treeGen(),css,l,i,n;
  if(g>=0&&g===lastShape)return;
  lastShape=g;
  for(css in parked){
   l=parked[css];
   if(!live(css)){
    for(i=0;i<l.length;i++){
     n=l[i];
     if(n.textContent===''&&ceInDoc(n)){
      l.splice(i,1);nparked--;
      if(rawText)rawText.call(n,css);else n.textContent=css;
      keep(n,css);
      break;}}}
   if(!l.length)delete parked[css];}
  if(nparked<=0&&timer!==null){ci.call(W,timer);timer=null;nparked=0;}}
 /* A plain <style>, or the one adoptedStyleSheets writes a shadow root's
    sheets into: its data-adopted is ours and means nothing to CSS. It
    was taken for a <style> with a media query and left alone, so every
    Lit component on a Home Assistant dashboard parsed its own copy of
    the same sheet, unscoped: 444 parses in one log (VitaSurf). */
 function styleNode(n){
  if(!(n&&n.nodeType===1&&n.tagName==='STYLE'))return false;
  var a=n.attributes;
  return !a||!a.length||(a.length===1&&n.hasAttribute('data-adopted'));}
 /* A shadow root's rules, kept to its host (VitaSurf). Without
  * scoping, the checkbox component on Home Assistant's login page
  * brought input{opacity:0;pointer-events:none;position:absolute}
  * into the page, and the username and password fields went
  * invisible to taps. Each selector is put under the host's tag:
  * :host is the tag, :host(X) the tag with X, :host-context(X) the
  * tag inside X, ::slotted(X) an X inside the tag, anything else a
  * descendant of the tag. Rules in @media and @supports are scoped
  * the same way; @keyframes, @font-face and the like are left as
  * they are. The tag, not the host, so every copy of a component
  * gets the same text and the folding below still works. */
 var scoped=Object.create(null),nscoped=0;
 function closeAt(t,i,open,close){
  /* index of the bracket closing the one at i, strings skipped */
  var d=0,c,q;
  for(;i<t.length;i++){
   c=t.charAt(i);
   if(c==='"'||c==="'"){q=c;for(i++;i<t.length&&t.charAt(i)!==q;i++)
    if(t.charAt(i)==='\\')i++;continue;}
   if(c===open)d++;
   else if(c===close&&--d===0)return i;}
  return -1;}
 function splitList(t){
  var out=[],d=0,st=0,i,c,q;
  for(i=0;i<t.length;i++){
   c=t.charAt(i);
   if(c==='"'||c==="'"){q=c;for(i++;i<t.length&&t.charAt(i)!==q;i++)
    if(t.charAt(i)==='\\')i++;continue;}
   if(c==='\\'){i++;continue;}
   if(c==='('||c==='[')d++;
   else if(c===')'||c===']')d--;
   else if(c===','&&d===0){out.push(t.slice(st,i));st=i+1;}}
  out.push(t.slice(st));
  return out;}
 function scopeSel(s,tag){
  var m,e,x;
  s=s.replace(/^\s+|\s+$/g,'');
  if(!s)return s;
  /* slot[name=a]::slotted(X): an X the page put in slot a, which is a
     child of the host with slot="a". Read as any X inside the tag, Home
     Assistant's slot[name=start]::slotted(*){margin-inline-end:4px}
     put a margin on every element in its buttons, the buttons too
     (VitaSurf). */
  if((x=s.indexOf('::slotted('))>=0&&
     (m=/slot\[name=["']?([^"'\]]+)["']?\]$/.exec(s.slice(0,x)))){
   e=closeAt(s,x+9,'(',')');
   if(e>0){
    var hp=/^:host(\([^)]*\))?/.exec(s),arg=s.slice(x+10,e).replace(/^\s+|\s+$/g,'')||'*';
    s=(hp?hp[0]:'')+' > '+arg+'[slot="'+m[1]+'"]'+s.slice(e+1);
    if(!hp)return tag+s;}}
  s=s.replace(/[^\s>+~]*::slotted\(/g,function(){return ' ::slotted(';});
  while((x=s.indexOf('::slotted('))>=0){
   e=closeAt(s,x+9,'(',')');
   if(e<0)break;
   s=s.slice(0,x)+s.slice(x+10,e)+s.slice(e+1);}
  s=s.replace(/^\s+/,'');
  if((m=/^:host-context\(/.exec(s))){
   e=closeAt(s,m[0].length-1,'(',')');
   if(e>0)return s.slice(m[0].length,e)+' '+tag+s.slice(e+1);}
  if((m=/^:host\(/.exec(s))){
   e=closeAt(s,m[0].length-1,'(',')');
   if(e>0){x=s.slice(m[0].length,e);
    if(/^[a-zA-Z*]/.test(x))x=':is('+x+')';
    return tag+x+s.slice(e+1);}}
  if(/^:host(?![\w-])/.test(s))return tag+s.slice(5);
  return tag+' '+s;}
 function scopeRules(t,tag){
  var out='',i=0,b,e,pre,at;
  while(i<t.length){
   b=-1;
   while(i<t.length&&/\s/.test(t.charAt(i)))out+=t.charAt(i++);
   for(e=i;e<t.length;e++){
    var c=t.charAt(e);
    if(c==='"'||c==="'"){var q=c;for(e++;e<t.length&&t.charAt(e)!==q;e++)
     if(t.charAt(e)==='\\')e++;continue;}
    if(c==='{'){b=e;break;}
    if(c===';'&&t.charAt(i)==='@'){break;}}
   if(b<0){out+=t.slice(i,e+1);i=e+1;continue;}
   e=closeAt(t,b,'{','}');
   if(e<0){out+=t.slice(i);break;}
   pre=t.slice(i,b);at=/^\s*@([\w-]+)/.exec(pre);
   if(at){
    if(/^(media|supports|container|layer|document|-moz-document)$/i.test(at[1]))
     out+=pre+'{'+scopeRules(t.slice(b+1,e),tag)+'}';
    else out+=t.slice(i,e+1);}
   else out+=splitList(pre).map(function(x){return scopeSel(x,tag);}).join(',')+
    t.slice(b,e+1);
   i=e+1;}
  return out;}
 function scope(css,host){
  var tag=host&&host.localName,k,r,kk;
  if(!css||!tag||tag==='html'||tag==='body')return css;
  /* the host as its shadow tree names it: only a rule naming one may
     reach from inside the tree to it, where a page's rules stop at
     the shadow root as in a browser. A custom element's tag is its
     component, every copy of which shares the sheet; a <div> or a
     <span> can host anything, so it is named by a key for the text
     instead, which the hosts holding that text carry (VitaSurf). */
  if(ceValidName(tag))tag+=':-vita-host';
  else{
   kk=keyOf[css];
   if(!kk){
    if(nkeys>=2000){keyOf=Object.create(null);nkeys=0;}
    kk=keyOf[css]='k'+(++nkey);nkeys++;}
   if(!(host.__vsKeys&&host.__vsKeys[kk]))hostTokens(host,kk,1);
   tag='[data-vs-s~="'+kk+'"]:-vita-host';}
  k=tag+'\n'+css;r=scoped[k];
  if(r!==undefined)return r;
  try{r=scopeRules(css.replace(/\/\*[\s\S]*?\*\//g,''),tag);}
  catch(x){r=css;}
  if(nscoped>=400){scoped=Object.create(null);nscoped=0;}
  scoped[k]=r;nscoped++;
  return r;}
 function take(host,n){
  var css=n.textContent,sc;
  if(!css)return;
  sc=scope(css,host);
  if(sc!==css){css=sc;if(rawText)rawText.call(n,css);else n.textContent=css;}
  if(live(css)){n.textContent='';park(n,css);return;}
  keep(n,css);}
 /* A <style> deeper in a shadow tree than the host's own children, or
  * one with attributes, an id say (VitaSurf). Neither was scoped, so its
  * rules reached the whole page: Bubble Card writes each card's own
  * styles: template into a <style id="bubble-styles"> inside the card,
  * and one card's "background-color: skyBlue !important" painted every
  * button on the dashboard. Such a style is usually one instance's own,
  * so its rules are kept to the nearest shadow host that holds it, by a
  * key for its text in that host's data-vs-s: hosts holding the same
  * text share the key, and the one sheet, as the tag scoping above
  * lets every copy of a component share its sheet. A selector may also
  * match the host itself, as the rules of an @scope match its root. */
 var keyOf=Object.create(null),nkey=0,nkeys=0;
 function owner(a){
  /* the host of the shadow tree a is in */
  for(;a;a=a.parentNode)if(a.nodeType===11)return shadowHost(a);
  return null;}
 function nested(p,n){
  return !!(p&&n&&n.nodeType===1&&n.tagName==='STYLE'&&
   !(shadowHost(p)&&styleNode(n))&&!n.hasAttribute('media')&&owner(p));}
 function hostTokens(h,k,d){
  var m=h.__vsKeys||(Object.defineProperty(h,'__vsKeys',{configurable:true,
   value:Object.create(null),writable:true,enumerable:false}),h.__vsKeys),
   out=[],x;
  m[k]=(m[k]||0)+d;
  if(m[k]<=0)delete m[k];
  for(x in m)out.push(x);
  if(typeof __vitaQuietAttr==='function')
   __vitaQuietAttr(h,'data-vs-s',out.length?out.join(' '):null);}
 function hostFirst(sel,at){
  /* the selector with at put on its first compound, so it can match
     the host itself */
  var i,c,d=0,q;
  if(/^:host/.test(sel)||!sel)return null;
  for(i=0;i<sel.length;i++){
   c=sel.charAt(i);
   if(c==='"'||c==="'"){q=c;for(i++;i<sel.length&&sel.charAt(i)!==q;i++);continue;}
   if(c==='('||c==='[')d++;
   else if(c===')'||c===']')d--;
   else if(d===0&&/[\s>+~]/.test(c))break;}
  return sel.slice(0,i)+at+sel.slice(i);}
 function scopeKeyed(css,k){
  var at='[data-vs-s~="'+k+'"]:-vita-host',r;
  try{
   r=scopeRules(css.replace(/\/\*[\s\S]*?\*\//g,''),at);
   /* and each rule again, matching the host itself */
   r=r.replace(/(^|\})([^{}@]+)\{/g,function(m,b,list){
    var parts=splitList(list),extra=[],i,x,y;
    for(i=0;i<parts.length;i++){
     x=parts[i].replace(/^\s+|\s+$/g,'');
     if(x.indexOf(at+' ')!==0)continue;
     y=hostFirst(x.slice(at.length+1),at);
     if(y)extra.push(y);}
    return b+list+(extra.length?','+extra.join(','):'')+'{';});}
  catch(x){r=css;}
  return r;}
 function takeNested(h,n,css){
  var k,sc,old=n.__vsKey;
  if(!css){
   if(old){hostTokens(h,old,-1);n.__vsKey=undefined;}
   return css;}
  k=keyOf[css];
  if(!k){
   if(nkeys>=2000){keyOf=Object.create(null);nkeys=0;}
   k=keyOf[css]='k'+(++nkey);nkeys++;}
  if(old!==k){
   if(old)hostTokens(h,old,-1);
   hostTokens(h,k,1);
   Object.defineProperty(n,'__vsKey',{configurable:true,value:k,
    writable:true,enumerable:false});}
  sc=scopeKeyed(css,k);
  return sc;}
 function fix(p,n){
  /* p is where n goes: a shadow root's own <style> is scoped to its
     host's tag */
  var c,host=shadowHost(p);
  if(!n)return;
  if(host&&styleNode(n)){take(host,n);return;}
  if(nested(p,n)&&n.textContent){
   c=takeNested(owner(p),n,n.textContent);
   if(rawText)rawText.call(n,c);else n.textContent=c;
   return;}
  if(n.nodeType===11&&host)
   for(c=n.firstChild;c;c=c.nextSibling)
    if(styleNode(c))take(host,c);}
 var app=P.appendChild,ins=P.insertBefore;
 P.appendChild=function(n){fix(this,n);return app.apply(this,arguments);};
 P.insertBefore=function(n,r){fix(this,n);return ins.apply(this,arguments);};
 var d=Object.getOwnPropertyDescriptor(P,'innerHTML');
 if(!d||!d.set)return;
 Object.defineProperty(P,'innerHTML',{configurable:true,get:d.get,set:function(v){
  var fresh=[],emptied=[];
  if(shadowHost(this)&&typeof v==='string'&&v.indexOf('<style')>=0)
   {var host=shadowHost(this);
   v=v.replace(/<style>([\s\S]*?)<\/style>/gi,function(m,css){
    var sc=scope(css,host);
    if(sc!==css){css=sc;m='<style>'+sc+'</style>';}
    if(css&&live(css)){emptied.push(css);return '<style></style>';}
    if(css)fresh.push(css);
    return m;});}
  var r=d.set.call(this,v);
  /* the empty ones it made, in order, when they can be told from any
     the page wrote empty itself */
  if(emptied.length){
   var es=this.getElementsByTagName('style'),k,e=[];
   for(k=0;k<es.length;k++)
    if(styleNode(es[k])&&es[k].textContent==='')e.push(es[k]);
   if(e.length===emptied.length)
    for(k=0;k<e.length;k++)park(e[k],emptied[k]);}
  if(fresh.length){
   var st=this.getElementsByTagName('style'),i,j;
   for(i=0;i<st.length;i++)for(j=0;j<fresh.length;j++)
    if(!canon[fresh[j]]||!live(fresh[j]))
     if(st[i].textContent===fresh[j])keep(st[i],fresh[j]);}
  return r;}});
 /* and the text given after the style is in: GitHub's <tool-tip>
  * appends an empty <style> to its shadow root and then sets its
  * textContent, so the checks above saw nothing to fold, and build 444
  * still parsed 399 sheets on a profile page, 5641 :host rules that
  * every element's style was matched against */
 var t=Object.getOwnPropertyDescriptor(P,'textContent');
 if(!t||!t.set)return;
 rawText=t.set;
 Object.defineProperty(P,'textContent',{configurable:true,get:t.get,set:function(v){
  var p;
  given.delete(this);
  if(typeof v==='string'&&v&&(p=this.parentNode)&&shadowHost(p)&&styleNode(this)){
   v=scope(v,shadowHost(p));
   if(live(v)){
    if(canon[v]!==this){t.set.call(this,'');park(this,v);}
    return;}
   t.set.call(this,v);keep(this,v);return;}
  if(typeof v==='string'&&(p=this.parentNode)&&nested(p,this)){
   t.set.call(this,takeNested(owner(p),this,v));return;}
  t.set.call(this,v);}});
})();
/* Slots (VitaSurf). A host's own children are drawn only through a
 * <slot> in its shadow tree: the first whose name matches their slot
 * attribute, or the first unnamed one for a child without one; a child
 * no slot takes is not drawn. Before boxes are built the engine calls
 * __vitaSlotPass, which works out where each goes and hands that to
 * __vitaSlots; box construction then walks the composed tree, the
 * host's shadow tree in its place and each slot's children in it. */
(function(){
 var HOSTS=[],last=-1,lastLen=-1,had=false,prev=[];
 function pass(){
  var g=domGen(),i,j,h,r,l,c,nodes=[],slots=[],ss,s,name,byName,live=[];
  if(g>=0&&g===last&&HOSTS.length===lastLen)return;
  last=g;
  for(i=0;i<HOSTS.length;i++){
   h=HOSTS[i];
   if(HOSTS.length<4096||ceInDoc(h))live.push(h);
   if(!ceInDoc(h))continue;
   r=SH_ROOT(h);
   if(!r)continue;
   l=[];
   for(c=h.firstChild;c;c=c.nextSibling)
    if(c.nodeType===1||c.nodeType===3)l.push(c);
   if(!l.length)continue;
   byName=Object.create(null);
   if(!manual(r)){
    ss=r.querySelectorAll('slot');
    for(j=0;j<ss.length;j++){
     name=ss[j].getAttribute('name')||'';
     if(!(name in byName))byName[name]=ss[j];}}
   for(j=0;j<l.length;j++){
    c=l[j];
    if(manual(r))s=manualSlot(c,r);
    else{
     name=c.nodeType===1?(c.getAttribute('slot')||''):'';
     s=byName[name]||null;}
    nodes.push(c);slots.push(s);
    if(c.__vsSlot!==s)Object.defineProperty(c,'__vsSlot',
     {configurable:true,writable:true,enumerable:false,value:s});}}
  HOSTS=live;lastLen=HOSTS.length;
  /* what was drawn in a slot and no longer is */
  if(prev.length){
   var now=new Set(nodes);
   for(i=0;i<prev.length;i++)
    if(!now.has(prev[i])&&prev[i].__vsSlot)prev[i].__vsSlot=null;}
  prev=nodes;
  if(nodes.length||had)__vitaSlots(nodes,slots);
  had=nodes.length>0;}
 if(typeof __vitaSlots==='function')
  Object.defineProperty(W,'__vitaSlotPass',{configurable:true,writable:true,
   enumerable:false,value:function(){try{pass();}catch(e){}}});
 function manual(r){return !!(r&&r.__vsInit&&r.__vsInit.slotAssignment==='manual');}
 /* the slot a child of a host in manual mode was assigned to, if that
    slot is in the host's tree and still lists it */
 function manualSlot(c,r){
  var s=c.__vsManualSlot;
  return s&&treeRoot(s)===r&&s.__vsManual&&s.__vsManual.indexOf(c)>=0?s:null;}
 /* slotchange (VitaSurf). A slot whose assigned nodes change hears it in
    the microtask after the change, as the DOM standard signals it. Only
    hosts a change touched are looked at, and only once some listener
    wants the event: Home Assistant has hundreds of hosts. */
 var dirty=new Set(),queued=false,watch=false;
 function touch(p){
  var r,h;
  if(!watch||!p)return;
  if(p.nodeType===1&&SH_ROOT(p))dirty.add(p);
  r=treeRoot(p);
  if(r&&r.nodeType===11&&(h=shadowHost(r)))dirty.add(h);
  if(!queued){queued=true;Promise.resolve().then(run);}}
 function same(a,b){
  if(a.length!==b.length)return false;
  for(var i=0;i<a.length;i++)if(a[i]!==b[i])return false;
  return true;}
 function run(){
  var hs=[],i,j,r,ss,now,old;
  queued=false;
  dirty.forEach(function(h){hs.push(h);});dirty.clear();
  for(i=0;i<hs.length;i++){
   r=SH_ROOT(hs[i]);
   if(!r)continue;
   ss=r.querySelectorAll('slot');
   for(j=0;j<ss.length;j++){
    now=ss[j].assignedNodes();old=ss[j].__vsSeen||[];
    if(same(now,old))continue;
    Object.defineProperty(ss[j],'__vsSeen',{configurable:true,writable:true,
     enumerable:false,value:now});
    try{ss[j].dispatchEvent(uaEvent(new Event('slotchange',{bubbles:true})));}catch(e){}}}}
 var ael=P.addEventListener;
 if(ael)P.addEventListener=function(t){
  if(t==='slotchange')watch=true;
  return ael.apply(this,arguments);};
 ['appendChild','insertBefore','removeChild','replaceChild'].forEach(function(k){
  var f=P[k];
  if(!f)return;
  P[k]=function(n){
   var from=n&&n.parentNode,r=f.apply(this,arguments);
   if(watch){touch(this);if(from&&from!==this)touch(from);
    if(k==='replaceChild'&&arguments[1])touch(this);}
   return r;};});
 var sa=P.setAttribute,ra=P.removeAttribute;
 P.setAttribute=function(n,v){
  var r=sa.apply(this,arguments);
  if(watch&&(n==='slot'||n==='name'))touch(this.parentNode||this);
  return r;};
 if(ra)P.removeAttribute=function(n){
  var r=ra.apply(this,arguments);
  if(watch&&(n==='slot'||n==='name'))touch(this.parentNode||this);
  return r;};
 var ih=Object.getOwnPropertyDescriptor(P,'innerHTML');
 if(ih&&ih.set)Object.defineProperty(P,'innerHTML',{configurable:true,get:ih.get,
  set:function(v){ih.set.call(this,v);if(watch)touch(this);}});
 /* slot.assign(...nodes), for a tree made with slotAssignment manual */
 P.assign=function(){
  if(this.tagName!=='SLOT')return;
  var list=[],i,n,o;
  for(i=0;i<arguments.length;i++){
   n=arguments[i];
   if(!n||(n.nodeType!==1&&n.nodeType!==3))
    throw new TypeError("Failed to execute 'assign' on 'HTMLSlotElement': parameter is not of type 'Element' or 'Text'.");
   if(list.indexOf(n)<0)list.push(n);}
  for(i=0;i<(this.__vsManual||[]).length;i++){
   o=this.__vsManual[i];
   if(list.indexOf(o)<0&&o.__vsManualSlot===this)o.__vsManualSlot=null;
   if(o.parentNode)touch(o.parentNode);}
  for(i=0;i<list.length;i++){
   n=list[i];o=n.__vsManualSlot;
   if(o&&o!==this&&o.__vsManual)o.__vsManual=o.__vsManual.filter(function(x){return x!==n;});
   Object.defineProperty(n,'__vsManualSlot',{configurable:true,writable:true,
    enumerable:false,value:this});
   if(n.parentNode)touch(n.parentNode);}
  Object.defineProperty(this,'__vsManual',{configurable:true,writable:true,
   enumerable:false,value:list});
  touch(this);};
 W.__vsManualSlot=manualSlot;W.__vsManualRoot=manual;
 /* the iframes in shadow trees, for the log: where each is and whether
    it has a box, a few seconds after a page makes shadow roots */
 var ifSeen=0,ifScans=0,ifPending=false;
 function iframeScan(){
  var i,j,r,fs,f,b,src,o,n=0;
  ifPending=false;
  for(i=0;i<HOSTS.length&&i<256;i++){
   r=SH_ROOT(HOSTS[i]);
   if(!r)continue;
   fs=r.querySelectorAll('iframe');
   for(j=0;j<fs.length;j++){
    f=fs[j];
    if(++n<=ifSeen)continue;
    b=f.getBoundingClientRect();src=f.getAttribute('src')||'';
    try{o=src?(new URL(src,location.href).origin===location.origin?
     'from this origin':'from another origin'):'with no src';}
    catch(e){o='with a src that is not a URL';}
    shNote('an <iframe> '+o+' in <'+HOSTS[i].localName+'>\'s '+
     (SH_HOST(r,true)?'closed':'open')+' tree, '+
     (ceInDoc(f)?'in the page':'not in the page')+', '+
     (b.width>0||b.height>0?Math.round(b.width)+'x'+Math.round(b.height):'no box')+
     (f.contentWindow?'':', no window'));}}
  if(n>ifSeen)ifSeen=n;}
 var att=P.attachShadow;
 P.attachShadow=function(){
  var r=att.apply(this,arguments);
  HOSTS.push(this);
  if(!ifPending&&ifScans<4){ifPending=true;ifScans++;setTimeout(iframeScan,4000);}
  return r;};
 Object.defineProperty(P,'assignedSlot',{configurable:true,
  get:function(){
   /* found when asked, as the DOM standard's "find a slot" is: the
      first slot in the host's tree with the name, or the pass's for
      manual assignment */
   var h=this.parentNode,r,s=null,name,ss,j;
   if(!h||h.nodeType!==1||(this.nodeType!==1&&this.nodeType!==3)||
      !(r=SH_ROOT(h)))return null;
   if(manual(r))s=manualSlot(this,r);
   else{
    name=this.nodeType===1?(this.getAttribute('slot')||''):'';
    ss=r.querySelectorAll('slot');
    for(j=0;j<ss.length;j++)
     if((ss[j].getAttribute('name')||'')===name){s=ss[j];break;}}
   /* a closed shadow tree's slot is its own business */
   if(s&&SH_HOST(r,true))return null;
   return s;}});
})();
/* <template>. libdom parses the children into the template element, so
 * content used to be the element itself -- and stamping a template then
 * put a <template> into the page instead of its children. Every Polymer
 * or lit component that stamps its own template rendered nothing and its
 * node lookups came back undefined, which is what YouTube's
 * this.guide.addEventListener was failing on.
 *
 * Move the children into a real fragment the first time content is read
 * and keep that fragment on the element: a component prepares its
 * template once, mutates the content, and stamps the same fragment over
 * and over, so handing back a fresh copy each time would lose the
 * preparation. Every other tag keeps the content attribute property,
 * which <meta> needs. */
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'content');
 Object.defineProperty(P,'content',{configurable:true,
  get:function(){
   if(this.tagName!=='TEMPLATE')return d.get.call(this);
   if(!Object.prototype.hasOwnProperty.call(this,'__content')){
    /* The template's own document, not the page's: a template that came
     * out of DOMParser or createHTMLDocument belongs to another
     * document, and its children cannot move into a fragment made
     * here. Polymer parses its templates that way, so every node
     * lookup came back undefined. */
    var f=(this.ownerDocument||D).createDocumentFragment(),
     c=this.childNodes.slice(),i;
    for(i=0;i<c.length;i++)f.appendChild(c[i]);
    Object.defineProperty(this,'__content',
     {configurable:true,writable:true,value:f});
   }
   return this.__content;},
  set:function(v){if(this.tagName!=='TEMPLATE')d.set.call(this,v);}});
})();
/* A template cloned before its content was read carries its children
 * with it, and after, it does not; give the clone the same fragment
 * treatment either way. */
(function(){
 var clone=P.cloneNode;
 P.cloneNode=function(deep){
  var c=clone.call(this,deep);
  if(this.tagName==='TEMPLATE'&&deep&&
     Object.prototype.hasOwnProperty.call(this,'__content')){
   var f=(c.ownerDocument||D).createDocumentFragment(),
    src=this.__content.childNodes,i;
   for(i=0;i<src.length;i++)f.appendChild(src[i].cloneNode(true));
   Object.defineProperty(c,'__content',
    {configurable:true,writable:true,value:f});
  }
  /* A copy of a defined custom element is upgraded as it is made, as
   * the specification has it, so a property set on it before it is
   * inserted (Lit binds its template's values that way) reaches the
   * class's accessor. It is connected later, when it is inserted. */
  if(CEn&&c)ceConnectTree(c,false,false);
  return c;};
})();
/* A shadow root is the one kind of fragment an element holds. Only those
 * are instances of ShadowRoot: when every element was, Alpine's tree
 * walk, which asks each node whether it is one and then visits only its
 * children, descended through the whole page without processing a
 * single directive. */
W.ShadowRoot=function ShadowRoot(){throw new TypeError('Illegal constructor');};
W.ShadowRoot.prototype=Object.create(P);
Object.defineProperty(W.ShadowRoot,Symbol.hasInstance,{configurable:true,
 value:function(v){return !!v&&typeof v==='object'&&v.nodeType===11&&
  !!shadowHost(v);}});

/* --- reflected content attributes ---------------------------------------
 * Most element properties in the HTML specification are nothing but a
 * reflection of a content attribute. Adding one each time a site reads
 * one that is not here never ends, so define the whole set the
 * specification lists, by kind: string, boolean, long, or enumeration.
 * Each definer skips a name that already has a property, so the
 * hand-written ones above win.
 */
function defProp(n,d){if(!Object.prototype.hasOwnProperty.call(P,n))Object.defineProperty(P,n,d);}
function attrName(p){return p.replace(/[A-Z]/g,function(c){return c.toLowerCase();});}
function each(list,f){list.forEach(function(e){var p=typeof e==='string'?e:e[0];f(p,(typeof e==='string'?attrName(p):e[1]),e);});}
function reflectString(list){each(list,function(p,a){defProp(p,{configurable:true,
 get:function(){if(!reflectsOn(this,p))return undefined;
  var v=this.getAttribute(a);return v===null?'':v;},
 set:function(v){if(isOwnState(v)||!reflectsOn(this,p))return shadowProp(this,p,v);
  this.setAttribute(a,String(v));}});});}
function reflectBool(list){each(list,function(p,a){defProp(p,{configurable:true,
 get:function(){if(!reflectsOn(this,p))return undefined;
  return this.hasAttribute(a);},
 set:function(v){if(isOwnState(v)||!reflectsOn(this,p))return shadowProp(this,p,v);
  if(v)this.setAttribute(a,'');else this.removeAttribute(a);}});});}
/* [property, attribute, default] */
function reflectLong(list){list.forEach(function(e){var p=e[0],a=e[1],d=e[2];defProp(p,{configurable:true,
 get:function(){if(!reflectsOn(this,p))return undefined;
  var v=this.getAttribute(a);if(v===null||v==='')return d;v=parseInt(v,10);return isNaN(v)?d:v;},
 set:function(v){if(isOwnState(v)||!reflectsOn(this,p))return shadowProp(this,p,v);
  this.setAttribute(a,String(parseInt(v,10)||0));}});});}
/* [property, attribute, keywords, default]. An absent or unrecognised
 * value reports the default, which is what the keyword tables say. */
function reflectEnum(list){list.forEach(function(e){var p=e[0],a=e[1],k=e[2],d=e[3];defProp(p,{configurable:true,
 get:function(){if(!reflectsOn(this,p))return undefined;
  var v=this.getAttribute(a);if(v===null)return d;v=String(v).toLowerCase();return k.indexOf(v)>=0?v:d;},
 set:function(v){if(isOwnState(v)||!reflectsOn(this,p))return shadowProp(this,p,v);
  this.setAttribute(a,String(v));}});});}

reflectString(['accessKey','autocapitalize','autocorrect','nonce','popover','slot',
 ['enterKeyHint','enterkeyhint'],['inputMode','inputmode'],['writingSuggestions','writingsuggestions'],
 'coords','shape','rev','charset','hreflang','download','ping','integrity','sizes','srcset','as','media',
 ['referrerPolicy','referrerpolicy'],['imageSizes','imagesizes'],['imageSrcset','imagesrcset'],
 ['useMap','usemap'],'lowsrc','align','summary','axis','headers','abbr','scope','profile','color','face',
 'accept',['acceptCharset','accept-charset'],'autocomplete',['dirName','dirname'],'pattern','min','max','step',
 ['formEnctype','formenctype'],['formMethod','formmethod'],['formTarget','formtarget'],
 'enctype','encoding','wrap','label','event','command','frameBorder','marginHeight','marginWidth',
 ['httpEquiv','http-equiv'],'scheme','code','codeBase','codeType','archive','standby','declare','frame','rules',
 'valign','ch','chOff','noResize','scrolling','vLink','aLink','link','text','bgColor','background',
 ['popoverTargetAction','popovertargetaction'],['commandFor','commandfor']]);

reflectBool(['autofocus','inert','reversed','open','loop','controls','muted','default','alpha','compact',
 ['noValidate','novalidate'],['formNoValidate','formnovalidate'],['noModule','nomodule'],
 ['isMap','ismap'],['noHref','nohref'],['itemScope','itemscope'],['noWrap','nowrap'],['noShade','noshade'],
 ['playsInline','playsinline'],['allowFullscreen','allowfullscreen'],['typeMustMatch','typemustmatch'],
 ['defaultChecked','checked'],['defaultSelected','selected'],'async','defer','seamless']);

reflectLong([['tabIndex','tabindex',0],['maxLength','maxlength',-1],['minLength','minlength',-1],
 ['size','size',0],['cols','cols',20],['rows','rows',2],['span','span',1],['colSpan','colspan',1],
 ['rowSpan','rowspan',1],['start','start',1],['hspace','hspace',0],['vspace','vspace',0],
 ['border','border',0],['headingOffset','headingoffset',0]]);

reflectEnum([['contentEditable','contenteditable',['true','false','plaintext-only'],'inherit'],
 ['loading','loading',['eager','lazy'],'eager'],
 ['decoding','decoding',['sync','async','auto'],'auto'],
 ['fetchPriority','fetchpriority',['high','low','auto'],'auto']]);

/* Three that reflect as booleans rather than as their keywords. */
Object.defineProperty(P,'draggable',{configurable:true,
 get:function(){return this.getAttribute('draggable')==='true';},
 set:function(v){this.setAttribute('draggable',v?'true':'false');}});
Object.defineProperty(P,'spellcheck',{configurable:true,
 get:function(){return this.getAttribute('spellcheck')!=='false';},
 set:function(v){this.setAttribute('spellcheck',v?'true':'false');}});
Object.defineProperty(P,'translate',{configurable:true,
 get:function(){return this.getAttribute('translate')!=='no';},
 set:function(v){this.setAttribute('translate',v?'yes':'no');}});
/* crossOrigin is null when the attribute is absent, and code tests it
 * against null rather than against the empty string. */
Object.defineProperty(P,'crossOrigin',{configurable:true,
 get:function(){var v=this.getAttribute('crossorigin');if(v===null)return null;
  return String(v).toLowerCase()==='use-credentials'?'use-credentials':'anonymous';},
 set:function(v){if(v===null)this.removeAttribute('crossorigin');else this.setAttribute('crossorigin',String(v));}});
Object.defineProperty(P,'isContentEditable',{configurable:true,get:function(){
 for(var n=this;n&&n.nodeType===1;n=n.parentNode){var v=n.getAttribute('contenteditable');
  if(v==='true'||v==='plaintext-only')return true;if(v==='false')return false;}
 return D.designMode==='on';}});
Object.defineProperty(P,'accessKeyLabel',{configurable:true,get:function(){return '';}});
Object.defineProperty(P,'outerText',{configurable:true,
 get:function(){return this.innerText;},set:function(v){this.innerText=v;}});
Object.defineProperty(P,'attributeStyleMap',{configurable:true,get:function(){return this.computedStyleMap();}});
Object.defineProperty(P,'currentCSSZoom',{configurable:true,get:function(){return 1;}});
Object.defineProperty(P,'scrollParent',{configurable:true,get:function(){return D.scrollingElement;}});
/* formAction reflects as a URL, and falls back to the form's action. */
Object.defineProperty(P,'formAction',{configurable:true,get:function(){
 var v=this.getAttribute('formaction');if(v===null||v==='')return D.baseURI;
 try{return new URL(v,D.baseURI).href;}catch(e){return v;}},
 set:function(v){this.setAttribute('formaction',String(v));}});
/* ElementInternals, for custom elements (VitaSurf). Everything is read
   when asked, not when the internals are made: a Web Awesome control
   (Home Assistant's login form) calls attachInternals() in its
   constructor and has its own form getter that reads this.internals.form,
   so reading the element's form while attaching found no internals yet,
   threw, and the control ran without them. */
(function(){
 var INTERNALS=new WeakMap(),FLAGS=['valueMissing','typeMismatch',
  'patternMismatch','tooLong','tooShort','rangeUnderflow','rangeOverflow',
  'stepMismatch','badInput','customError'];
 function notSupported(m){return new DOMException(m,'NotSupportedError');}
 function state(i){return INTERNALS.get(i._el);}
 function formAssociated(el){
  var C=W.customElements&&W.customElements.get(el.localName);
  return !!(C&&C.formAssociated);}
 function needForm(i,what){
  if(!formAssociated(i._el))throw notSupported("Failed to read the '"+what+
   "' property from 'ElementInternals': The target element is not a "+
   "form-associated custom element.");}
 function formOwner(el){
  var id=el.getAttribute('form'),n;
  if(id!==null){n=D.getElementById(id);return n&&n.tagName==='FORM'?n:null;}
  for(n=el.parentNode;n&&n.nodeType===1;n=n.parentNode)
   if(n.tagName==='FORM')return n;
  return null;}
 function disabled(el){
  var n;
  if(el.hasAttribute('disabled'))return true;
  for(n=el.parentNode;n&&n.nodeType===1;n=n.parentNode)
   if(n.tagName==='FIELDSET'&&n.hasAttribute('disabled'))return true;
  return false;}
 /* The states a custom element shows, for :state(); a set of strings */
 function CustomStateSet(){this._s=new Set();}
 CustomStateSet.prototype={constructor:CustomStateSet,
  add:function(v){this._s.add(String(v));return this;},
  'delete':function(v){return this._s['delete'](String(v));},
  has:function(v){return this._s.has(String(v));},
  clear:function(){this._s.clear();},
  forEach:function(f,t){var me=this;this._s.forEach(function(v){f.call(t,v,v,me);});},
  values:function(){return this._s.values();},
  keys:function(){return this._s.values();},
  entries:function(){return this._s.entries();},
  get size(){return this._s.size;}};
 CustomStateSet.prototype[Symbol.iterator]=CustomStateSet.prototype.values;
 W.CustomStateSet=CustomStateSet;
 function ElementInternals(){throw new TypeError('Illegal constructor');}
 var EP=ElementInternals.prototype;
 Object.defineProperties(EP,{
  shadowRoot:{configurable:true,get:function(){
   return SH_ROOT(this._el)||null;}},
  form:{configurable:true,get:function(){
   needForm(this,'form');return formOwner(this._el);}},
  labels:{configurable:true,get:function(){
   needForm(this,'labels');
   var out=[],el=this._el,id=el.id,n;
   if(id)out=listOf(D.querySelectorAll('label[for="'+id+'"]'));
   for(n=el.parentNode;n&&n.nodeType===1;n=n.parentNode)
    if(n.tagName==='LABEL'&&out.indexOf(n)<0)out.push(n);
   return out;}},
  willValidate:{configurable:true,get:function(){
   needForm(this,'willValidate');
   var el=this._el;
   return !disabled(el)&&!el.hasAttribute('readonly')&&
    !(el.closest&&el.closest('datalist'));}},
  validity:{configurable:true,get:function(){
   needForm(this,'validity');
   var f=state(this).flags,v=Object.create(ValidityState.prototype),ok=true;
   FLAGS.forEach(function(k){v[k]=!!f[k];if(f[k])ok=false;});
   v.valid=ok;return v;}},
  validationMessage:{configurable:true,get:function(){
   needForm(this,'validationMessage');return state(this).message;}},
  states:{configurable:true,get:function(){return state(this).states;}},
  [Symbol.toStringTag]:{configurable:true,value:'ElementInternals'}});
 EP.setFormValue=function(value,st){
  needForm(this,'setFormValue');
  var s=state(this);s.value=value===undefined?null:value;
  s.state=st===undefined?s.value:st;};
 EP.setValidity=function(flags,message,anchor){
  needForm(this,'setValidity');
  var s=state(this),f={},any=false;
  flags=flags||{};
  FLAGS.forEach(function(k){f[k]=!!flags[k];if(f[k])any=true;});
  if(any&&(message===undefined||message===''))
   throw new TypeError("Failed to execute 'setValidity' on 'ElementInternals': "+
    'The second argument should not be empty if one or more flags in the '+
    'first argument are true.');
  s.flags=f;s.message=any?String(message):'';s.anchor=anchor||null;};
 EP.checkValidity=function(){
  var el=this._el;
  if(!this.willValidate||this.validity.valid)return true;
  el.dispatchEvent(uaEvent(new Event('invalid',{bubbles:false,cancelable:true})));
  return false;};
 EP.reportValidity=function(){return this.checkValidity();};
 /* the ARIA a custom element sets on itself through its internals */
 ['role','ariaAtomic','ariaAutoComplete','ariaBusy','ariaChecked',
  'ariaColCount','ariaColIndex','ariaColSpan','ariaCurrent','ariaDescription',
  'ariaDisabled','ariaExpanded','ariaHasPopup','ariaHidden','ariaInvalid',
  'ariaKeyShortcuts','ariaLabel','ariaLevel','ariaLive','ariaModal',
  'ariaMultiLine','ariaMultiSelectable','ariaOrientation','ariaPlaceholder',
  'ariaPosInSet','ariaPressed','ariaReadOnly','ariaRequired',
  'ariaRoleDescription','ariaRowCount','ariaRowIndex','ariaRowSpan',
  'ariaSelected','ariaSetSize','ariaSort','ariaValueMax','ariaValueMin',
  'ariaValueNow','ariaValueText'].forEach(function(k){
  Object.defineProperty(EP,k,{configurable:true,enumerable:true,
   get:function(){var a=state(this).aria;return k in a?a[k]:null;},
   set:function(v){state(this).aria[k]=v===null?null:String(v);}});});
 W.ElementInternals=ElementInternals;
 P.attachInternals=function(){
  var el=this,name=el.localName||'',C;
  if(el.nodeType!==1)throw new TypeError('Illegal invocation');
  if(name.indexOf('-')<0)throw notSupported("Failed to execute 'attachInternals'"+
   " on 'HTMLElement': Unable to attach ElementInternals to non-custom elements.");
  C=W.customElements&&W.customElements.get(name);
  if(C&&C.disabledFeatures&&Array.prototype.indexOf.call(C.disabledFeatures,
   'internals')>=0)throw notSupported("Failed to execute 'attachInternals' on "+
   "'HTMLElement': ElementInternals is disabled by disabledFeature static field.");
  if(INTERNALS.has(el))throw notSupported("Failed to execute 'attachInternals' on"+
   " 'HTMLElement': ElementInternals for the specified element was already attached.");
  var i=Object.create(EP);
  Object.defineProperty(i,'_el',{value:el});
  var s={flags:{},message:'',anchor:null,value:null,state:null,aria:{},
   states:new CustomStateSet()};
  INTERNALS.set(el,s);INTERNALS.set(i,s);
  if(formAssociated(el))W.__vitaFaceSeen=true;
  return i;};
 /* what a form-associated custom element gives its form's data:
    undefined for any other element */
 W.__vitaFaceValue=function(el){
  var s=INTERNALS.get(el);
  return s&&formAssociated(el)?s.value:undefined;};
})();
/* Popovers (VitaSurf). Whether one is shown is the element's own state,
 * kept in C: :popover-open matches it, and the UA sheet's
 * [popover]:not(:popover-open) rule hides one that is not shown, as
 * GitHub's tooltips are until they are wanted. There is no top layer,
 * so a shown popover is drawn where its own styles put it. The steps
 * follow HTML's: the validity checks, a cancelable beforetoggle before
 * showing, and a toggle event queued after, merged with one still
 * pending (which fires even when it comes back to where it started, as
 * HTML has it and Chrome does). Light dismiss of popover=auto is not done. */
var POPN=typeof W.__vitaPopover==='function'?W.__vitaPopover:null;
try{delete W.__vitaPopover;}catch(e){}
function popShown(el){return !!POPN&&POPN(el)===true;}
function popValid(el,showing){
 if(!el.hasAttribute('popover'))
  throw new DOMException('Not supported on elements that do not have a valid value for the popover attribute','NotSupportedError');
 if(popShown(el)===showing)return false;
 if(!el.isConnected)
  throw new DOMException('Invalid on disconnected popover elements','InvalidStateError');
 if(el.tagName==='DIALOG'&&el.hasAttribute('open'))
  throw new DOMException('The dialog is already open as a dialog','InvalidStateError');
 return true;}
var POPTOGGLE=new WeakMap();
function popQueueToggle(el,oldS,newS){
 var t=POPTOGGLE.get(el);
 if(t){t.newState=newS;return;}
 t={oldState:oldS,newState:newS};POPTOGGLE.set(el,t);
 setTimeout(function(){
  POPTOGGLE.delete(el);
  try{el.dispatchEvent(uaEvent(new ToggleEvent('toggle',
   {oldState:t.oldState,newState:t.newState})));}catch(e){}},0);}
function popSet(el,open){if(POPN)POPN(el,open);}
P.showPopover=function(){
 if(!popValid(this,true))return;
 if(!this.dispatchEvent(uaEvent(new ToggleEvent('beforetoggle',
   {oldState:'closed',newState:'open',cancelable:true}))))return;
 /* a listener may have changed things */
 if(!popValid(this,true))return;
 popSet(this,true);
 popQueueToggle(this,'closed','open');};
P.hidePopover=function(){
 if(!popValid(this,false))return;
 this.dispatchEvent(uaEvent(new ToggleEvent('beforetoggle',
  {oldState:'open',newState:'closed'})));
 if(!popShown(this))return;
 popSet(this,false);
 popQueueToggle(this,'open','closed');};
P.togglePopover=function(opt){
 var force=opt!==null&&typeof opt==='object'?opt.force:opt;
 if(popShown(this)&&(force===undefined||!force))this.hidePopover();
 else if(force===undefined||force)this.showPopover();
 else popValid(this,false);
 return popShown(this);};
Object.defineProperty(P,'popoverTargetElement',{configurable:true,
 get:function(){var id=this.getAttribute('popovertarget');return id?D.getElementById(id):null;},
 set:function(v){if(v&&v.id)this.setAttribute('popovertarget',v.id);
  else shadowProp(this,'popoverTargetElement',v);}});
Object.defineProperty(P,'commandForElement',{configurable:true,
 get:function(){var id=this.getAttribute('commandfor');return id?D.getElementById(id):null;},
 set:function(v){if(v&&v.id)this.setAttribute('commandfor',v.id);
  else shadowProp(this,'commandForElement',v);}});

/* --- DOMTokenList -------------------------------------------------------
 * classList was an object literal with four methods. A real token list
 * is indexable, iterable and has replace and value, all of which code
 * uses, and relList, sandbox and part need the same thing.
 */
/* DOMException. There was none at all, so every call that the
 * specification says must throw returned quietly instead, and code that
 * branches on the name of what it caught never saw one. The web platform
 * tests for classList alone check this 405 times. */
function DOMException(message,name){
 var e=new Error(message===undefined?'':String(message));
 e.name=name===undefined?'Error':String(name);
 e.code=DOMException.CODES[e.name]||0;
 Object.setPrototypeOf(e,DOMException.prototype);
 return e;}
DOMException.prototype=Object.create(Error.prototype);
DOMException.prototype.constructor=DOMException;
DOMException.prototype.name='Error';
DOMException.prototype.message='';
DOMException.CODES={IndexSizeError:1,HierarchyRequestError:3,WrongDocumentError:4,
 InvalidCharacterError:5,NoModificationAllowedError:7,NotFoundError:8,
 NotSupportedError:9,InUseAttributeError:10,InvalidStateError:11,SyntaxError:12,
 InvalidModificationError:13,NamespaceError:14,InvalidAccessError:15,
 TypeMismatchError:17,SecurityError:18,NetworkError:19,AbortError:20,
 URLMismatchError:21,QuotaExceededError:22,TimeoutError:23,
 InvalidNodeTypeError:24,DataCloneError:25};
(function(){
 var names={INDEX_SIZE_ERR:1,DOMSTRING_SIZE_ERR:2,HIERARCHY_REQUEST_ERR:3,
  WRONG_DOCUMENT_ERR:4,INVALID_CHARACTER_ERR:5,NO_DATA_ALLOWED_ERR:6,
  NO_MODIFICATION_ALLOWED_ERR:7,NOT_FOUND_ERR:8,NOT_SUPPORTED_ERR:9,
  INUSE_ATTRIBUTE_ERR:10,INVALID_STATE_ERR:11,SYNTAX_ERR:12,
  INVALID_MODIFICATION_ERR:13,NAMESPACE_ERR:14,INVALID_ACCESS_ERR:15,
  VALIDATION_ERR:16,TYPE_MISMATCH_ERR:17,SECURITY_ERR:18,NETWORK_ERR:19,
  ABORT_ERR:20,URL_MISMATCH_ERR:21,QUOTA_EXCEEDED_ERR:22,TIMEOUT_ERR:23,
  INVALID_NODE_TYPE_ERR:24,DATA_CLONE_ERR:25};
 Object.keys(names).forEach(function(k){
  DOMException[k]=names[k];DOMException.prototype[k]=names[k];});})();
W.DOMException=DOMException;
/* QuotaExceededError is an interface of its own now, a DOMException that
   says how much was asked for and how much there is. crypto.getRandomValues
   throws one, and a test for it checks the constructor, not just the name. */
function QuotaExceededError(message,options){
 var e=DOMException(message,'QuotaExceededError'),q=null,r=null;
 if(options!==undefined&&options!==null){
  if(options.quota!==undefined)q=Number(options.quota);
  if(options.requested!==undefined)r=Number(options.requested);}
 if((q!==null&&!(q>=0))||(r!==null&&!(r>=0)))
  throw new RangeError('quota and requested must be finite and not negative');
 if(q!==null&&r!==null&&r<q)
  throw new RangeError('requested must not be less than quota');
 Object.setPrototypeOf(e,QuotaExceededError.prototype);
 Object.defineProperty(e,'quota',{configurable:true,value:q});
 Object.defineProperty(e,'requested',{configurable:true,value:r});
 return e;}
QuotaExceededError.prototype=Object.create(DOMException.prototype);
QuotaExceededError.prototype.constructor=QuotaExceededError;
QuotaExceededError.prototype.name='QuotaExceededError';
W.QuotaExceededError=QuotaExceededError;

/* --- DOMTokenList -------------------------------------------------------
 * An ordered set of tokens over an attribute. It used to split on
 * whitespace and write back whatever it was given: an empty token or one
 * containing a space went in as-is where the specification says to throw,
 * duplicates survived, and the attribute was rewritten even when nothing
 * had changed.
 */
var WS_RE=/[ \t\r\n\f]/;
function tokenCheck(t){
 t=String(t);
 if(t==='')throw new DOMException('The token provided must not be empty.','SyntaxError');
 if(WS_RE.test(t))throw new DOMException(
  'The token provided contains HTML space characters, which are not valid in tokens.',
  'InvalidCharacterError');
 return t;}
/* The private fields are hidden: a page that walks an object and calls
 * what it finds would otherwise call the helpers. */
function hide(o,k,v){try{Object.defineProperty(o,k,
 {value:v,writable:true,configurable:true,enumerable:false});}
 catch(e){o[k]=v;}}
function TokenList(el,attr){hide(this,'_e',el);hide(this,'_a',attr);
 var t=this._t();for(var i=0;i<t.length;i++)this[i]=t[i];
 Object.defineProperty(this,'length',{configurable:true,value:t.length,writable:true});}
/* Split on ASCII whitespace (VitaSurf): with nothing but spaces in it,
   which is nearly every class attribute, a plain string split, since a
   split on a regular expression goes through Symbol.split and its flags
   getter and was 3 % of GitHub's profile. Empty tokens are left for the
   caller, as the regular expression left them at the ends. */
function splitWS(v){
 if(v.indexOf('\t')<0&&v.indexOf('\n')<0&&v.indexOf('\r')<0&&v.indexOf('\f')<0)
  return v.split(' ');
 return v.split(/[ \t\r\n\f]+/);}
/* The attribute as an ordered set: split on whitespace, first occurrence
   of each token wins. */
TokenList.prototype._t=function(){
 if(!this._e)return this._own||(this._own=[]);
 var v=this._e.getAttribute(this._a);
 var out=[],seen={},parts=v?splitWS(String(v)):[],i;
 for(i=0;i<parts.length;i++){
  if(parts[i]===''||Object.prototype.hasOwnProperty.call(seen,parts[i]))continue;
  seen[parts[i]]=1;out.push(parts[i]);}
 return out;};
/* The update steps write the attribute whether or not the set changed,
   and an observer sees a record for each write. The one case that
   writes nothing is an element that has no such attribute and no tokens
   to put in one. Not writing when the value happened to match was the
   wrong reading: toggle with a force argument is the only operation
   that returns without updating. */
TokenList.prototype._w=function(t){
 var next=t.join(' ');
 if(this._e){
  var had=this._e.getAttribute(this._a);
  if(had===null&&next==='')return;
  this._e.setAttribute(this._a,next);}
 else this._own=t;
 for(var i=0;i<Math.max(t.length,this.length||0);i++){
  if(i<t.length)this[i]=t[i];else delete this[i];}
 this.length=t.length;};
TokenList.prototype.item=function(i){
 var t=this._t();i=Number(i)||0;return t[i]===undefined?null:t[i];};
TokenList.prototype.contains=function(c){return this._t().indexOf(String(c))>=0;};
TokenList.prototype.add=function(){
 var i,t;
 for(i=0;i<arguments.length;i++)tokenCheck(arguments[i]);
 t=this._t();
 for(i=0;i<arguments.length;i++){
  var c=String(arguments[i]);
  if(t.indexOf(c)<0)t.push(c);}
 this._w(t);};
TokenList.prototype.remove=function(){
 var drop=[],i;
 for(i=0;i<arguments.length;i++)drop.push(tokenCheck(arguments[i]));
 this._w(this._t().filter(function(c){return drop.indexOf(c)<0;}));};
TokenList.prototype.toggle=function(c,force){
 c=tokenCheck(c);
 var has=this.contains(c);
 if(has){
  if(force===undefined||force===false){this.remove(c);return false;}
  return true;}
 if(force===undefined||force===true){this.add(c);return true;}
 return false;};
TokenList.prototype.replace=function(a,b){
 a=tokenCheck(a);b=tokenCheck(b);
 var t=this._t(),i=t.indexOf(a);
 if(i<0)return false;
 var j=t.indexOf(b);
 if(j>=0&&j!==i){t.splice(i,1,b);t=t.filter(function(x,k){return x!==b||k===t.indexOf(b);});}
 else t[i]=b;
 this._w(t);
 return true;};
/* Three attributes have a defined set of valid tokens; every other token
   list has none and the specification says to throw for those. Throwing
   for all of them broke module loading outright: a bundler's preload
   helper asks link.relList whether it supports 'modulepreload' to choose
   between modulepreload and preload, and its `relList.supports &&` guard
   does not save it from a supports() that exists and throws. That threw
   out of the entry module, so claude.ai finished loading every one of its
   chunks and then mounted nothing. The sets below are the ones a browser
   reports, which is what a feature test is written against. */
var REL_TOKENS={
 LINK:('alternate canonical dns-prefetch icon apple-touch-icon manifest '+
  'modulepreload next preconnect prefetch preload prerender stylesheet')
  .split(' '),
 A:['noopener','noreferrer','opener'],
 AREA:['noopener','noreferrer','opener'],
 FORM:['noopener','noreferrer','opener']};
var SANDBOX_TOKENS=('allow-downloads allow-forms allow-modals '+
 'allow-orientation-lock allow-pointer-lock allow-popups '+
 'allow-popups-to-escape-sandbox allow-presentation allow-same-origin '+
 'allow-scripts allow-storage-access-by-user-activation '+
 'allow-top-navigation allow-top-navigation-by-user-activation').split(' ');
TokenList.prototype.supports=function(token){
 needArgs(arguments.length,1,'supports');
 var tag=this._e?String(this._e.tagName||'').toUpperCase():'',set=null;
 if(this._a==='rel')set=REL_TOKENS[tag]||null;
 else if(this._a==='sandbox'&&tag==='IFRAME')set=SANDBOX_TOKENS;
 if(set===null)throw new TypeError(
  'supports() is not supported for this attribute.');
 return set.indexOf(String(token).toLowerCase())>=0;};
TokenList.prototype.forEach=function(f,th){this._t().forEach(function(v,i){f.call(th,v,i,this);},this);};
TokenList.prototype.keys=function(){return this._t().map(function(_,i){return i;})[Symbol.iterator]();};
TokenList.prototype.values=function(){return this._t()[Symbol.iterator]();};
TokenList.prototype.entries=function(){return this._t().map(function(v,i){return [i,v];})[Symbol.iterator]();};
TokenList.prototype[Symbol.iterator]=TokenList.prototype.values;
TokenList.prototype.toString=function(){return this.value;};
hide(TokenList.prototype,'_t',TokenList.prototype._t);
hide(TokenList.prototype,'_w',TokenList.prototype._w);
Object.defineProperty(TokenList.prototype,'value',{configurable:true,
 get:function(){return this._e?(this._e.getAttribute(this._a)||''):this._t().join(' ');},
 set:function(v){if(this._e)this._e.setAttribute(this._a,String(v));
  else this._own=splitWS(String(v)).filter(function(x){return x;});}});
W.DOMTokenList=TokenList;
/* The same list on every read, as a browser hands back (VitaSurf). A
   fresh one per read cost an object, a split and a property per class,
   and Lit's classMap reads it for every class of every element it
   updates. Its indices are brought up to date on each read when the
   attribute has changed since, so they are no staler than a fresh
   list's would be; the methods read the attribute itself. */
TokenList.prototype._sync=function(){
 var t=this._t(),i;
 for(i=0;i<Math.max(t.length,this.length||0);i++){
  if(i<t.length)this[i]=t[i];else delete this[i];}
 this.length=t.length;};
hide(TokenList.prototype,'_sync',TokenList.prototype._sync);
Object.defineProperty(P,'classList',{configurable:true,
 get:function(){
  var v=this.getAttribute('class'),tl=this.__vsClassList;
  if(tl===undefined){
   tl=new TokenList(this,'class');
   hide(tl,'_v',v);
   hide(this,'__vsClassList',tl);
   return tl;}
  if(tl._v!==v){tl._sync();tl._v=v;}
  return tl;},
 set:function(v){this.setAttribute('class',String(v));}});
/* output.htmlFor is a token list; label.htmlFor is a string. Only
 * output's gets the list, which is what the specification says and what
 * a browser does -- a page that reads htmlFor almost always means the
 * label's. */
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'htmlFor');
 Object.defineProperty(P,'htmlFor',{configurable:true,
  get:function(){
   if(this.tagName==='OUTPUT')return new TokenList(this,'for');
   return d.get.call(this);},
  set:function(v){d.set.call(this,v);}});
})();
[['relList','rel'],['sandbox','sandbox'],['part','part'],['blocking','blocking']]
 .forEach(function(e){var a=e[1];
  Object.defineProperty(P,e[0],{configurable:true,get:function(){return new TokenList(this,a);}});});

/* --- the URL decomposition members --------------------------------------
 * a.hostname, a.pathname and the rest. Routers read them off a link
 * rather than parsing href themselves, so a link without them takes out
 * the router. They come from the already-resolved href.
 */
function isURLEl(el){var t=el.tagName;return t==='A'||t==='AREA';}
function urlOf(el){try{return new URL(el.getAttribute('href')||'',D.baseURI);}catch(e){return null;}}
/* On anything that is not a link these are the page's own property to
 * use, so an assignment keeps what it was given rather than vanishing. */
['protocol','username','password','hostname','port','pathname','search','hash'].forEach(function(k){
 Object.defineProperty(P,k,{configurable:true,
  get:function(){if(!isURLEl(this))return '';var u=urlOf(this);return u?u[k]:'';},
  set:function(v){
   if(!isURLEl(this))return shadowProp(this,k,v);
   var u=urlOf(this);
   if(!u)return shadowProp(this,k,v);
   u[k]=v;this.setAttribute('href',u.href);}});});
Object.defineProperty(P,'origin',{configurable:true,get:function(){
 if(!isURLEl(this))return '';var u=urlOf(this);return u?u.origin:'';}});
/* host is a link's URL host; no other element has one (see above). */
Object.defineProperty(P,'host',{configurable:true,
 get:function(){
  if(this.nodeType===11)return shadowHost(this)||undefined;
  if(!isURLEl(this))return undefined;
  var u=urlOf(this);return u?u.host:'';},
 set:function(v){
  if(!isURLEl(this))return shadowProp(this,'host',v);
  var u=urlOf(this);
  if(!u)return shadowProp(this,'host',v);
  u.host=v;this.setAttribute('href',u.href);}});
/* a.text is the link's text; every other tag keeps the text attribute. */
(function(){var d=Object.getOwnPropertyDescriptor(P,'text');
 Object.defineProperty(P,'text',{configurable:true,
  get:function(){var t=this.tagName;
   return (t==='A'||t==='SCRIPT'||t==='OPTION'||t==='TITLE')?this.textContent:d.get.call(this);},
  set:function(v){var t=this.tagName;
   if(t==='A'||t==='SCRIPT'||t==='OPTION'||t==='TITLE')this.textContent=v;else d.set.call(this,v);}});})();

/* --- form controls ------------------------------------------------------
 * The form association, the labels and the constraint validation API.
 * Validation here reports what the attributes say; there is no typed
 * value to check against, so a control with a value is valid.
 */
var CONTROLS='INPUT SELECT TEXTAREA BUTTON FIELDSET OBJECT OUTPUT IMG';
Object.defineProperty(P,'form',{configurable:true,get:function(){
 if(CONTROLS.indexOf(this.tagName)<0&&this.tagName!=='LABEL'&&this.tagName!=='OPTION')return null;
 var id=this.getAttribute('form');
 if(id)return D.getElementById(id);
 for(var n=this.parentNode;n&&n.nodeType===1;n=n.parentNode)if(n.tagName==='FORM')return n;
 return null;}});
Object.defineProperty(P,'labels',{configurable:true,get:function(){
 var out=[],id=this.id,n;
 if(id)out=D.querySelectorAll('label[for="'+id+'"]');
 for(n=this.parentNode;n&&n.nodeType===1;n=n.parentNode)
  if(n.tagName==='LABEL'&&out.indexOf(n)<0)out.push(n);
 return out;}});
function ValidityState(el){
 var missing=el.hasAttribute('required')&&!el.value;
 this.valueMissing=missing;this.typeMismatch=false;this.patternMismatch=false;
 this.tooLong=false;this.tooShort=false;this.rangeUnderflow=false;this.rangeOverflow=false;
 this.stepMismatch=false;this.badInput=false;
 this.customError=!!el.__customError;
 this.valid=!missing&&!el.__customError;}
W.ValidityState=ValidityState;
Object.defineProperty(P,'validity',{configurable:true,get:function(){return new ValidityState(this);}});
Object.defineProperty(P,'willValidate',{configurable:true,get:function(){
 return CONTROLS.indexOf(this.tagName)>=0&&this.tagName!=='FIELDSET'&&this.tagName!=='OBJECT'&&
  !this.disabled&&!this.readOnly&&this.type!=='hidden';}});
Object.defineProperty(P,'validationMessage',{configurable:true,get:function(){
 return this.__customError||(this.validity.valueMissing?'Please fill out this field.':'');}});
P.setCustomValidity=function(m){Object.defineProperty(this,'__customError',
 {configurable:true,writable:true,enumerable:false,value:String(m||'')});};
P.checkValidity=function(){
 if(this.tagName==='FORM')return listOf(this.elements).every(function(c){return c.checkValidity();});
 if(!this.willValidate)return true;
 if(this.validity.valid)return true;
 this.dispatchEvent(uaEvent(new Event('invalid',{bubbles:false,cancelable:true})));
 return false;};
P.reportValidity=function(){return this.checkValidity();};
/* Text selection inside a control. Nothing here has a caret, so the
 * selection is whatever a script last set, over the value it can see. */
['selectionStart','selectionEnd'].forEach(function(k){Object.defineProperty(P,k,{configurable:true,
 get:function(){return this['__'+k]===undefined?String(this.value||'').length:this['__'+k];},
 set:function(v){this['__'+k]=Number(v)||0;}});});
Object.defineProperty(P,'selectionDirection',{configurable:true,
 get:function(){return this.__selectionDirection||'none';},
 set:function(v){this.__selectionDirection=String(v);}});
P.setSelectionRange=function(s,e,d){this.selectionStart=s;this.selectionEnd=e;
 this.selectionDirection=d||'none';this.dispatchEvent(uaEvent(new Event('select')));};
P.setRangeText=function(rep,s,e){var v=String(this.value||'');
 if(s===undefined){s=this.selectionStart;e=this.selectionEnd;}
 this.value=v.slice(0,s)+String(rep)+v.slice(e);};
P.select=function(){this.setSelectionRange(0,String(this.value||'').length);};
P.showPicker=GAP('input.showPicker');
P.stepUp=function(n){this.value=(Number(this.value)||0)+(n===undefined?1:Number(n));};
P.stepDown=function(n){this.stepUp(-(n===undefined?1:Number(n)));};
Object.defineProperty(P,'valueAsNumber',{configurable:true,
 get:function(){var v=parseFloat(this.value);return isNaN(v)?NaN:v;},
 set:function(v){this.value=String(v);}});
Object.defineProperty(P,'valueAsDate',{configurable:true,
 get:function(){var d=new Date(this.value);return isNaN(d.getTime())?null:d;},
 set:function(v){this.value=v?new Date(v).toISOString().slice(0,10):'';}});
Object.defineProperty(P,'files',{configurable:true,get:function(){
 if(this.tagName!=='INPUT'||this.type!=='file')return null;
 var l=[];l.item=function(i){return this[i]||null;};return l;}});
Object.defineProperty(P,'indeterminate',{configurable:true,
 get:function(){return !!this.__indeterminate;},set:function(v){this.__indeterminate=!!v;}});
Object.defineProperty(P,'list',{configurable:true,get:function(){
 var id=this.getAttribute('list');var e=id?D.getElementById(id):null;
 return e&&e.tagName==='DATALIST'?e:null;}});
Object.defineProperty(P,'defaultValue',{configurable:true,
 get:function(){return this.tagName==='TEXTAREA'?this.textContent:(this.getAttribute('value')||'');},
 set:function(v){if(this.tagName==='TEXTAREA')this.textContent=v;else this.setAttribute('value',String(v));}});
Object.defineProperty(P,'textLength',{configurable:true,get:function(){return String(this.value||'').length;}});
Object.defineProperty(P,'colorSpace',{configurable:true,get:function(){return 'limited-srgb';}});

/* --- form, select and option --------------------------------------------
 * A GET form that a script submits navigates, because that is what a
 * search box on a page does and the page waits for it.
 */
Object.defineProperty(P,'elements',{configurable:true,get:function(){
 if(this.tagName!=='FORM'&&this.tagName!=='FIELDSET')return [];
 /* live, and it answers to a control's name, which is how a page
    reaches form.elements.username */
 var self=this;
 return liveCollection(function(){
  var sel='input,select,textarea,button,fieldset,object,output';
  if(!W.__vitaFaceSeen)return listOf(self.querySelectorAll(sel));
  /* and the form-associated custom elements, once a page has one */
  return listOf(self.getElementsByTagName('*')).filter(function(e){
   return e.matches(sel)||(e.localName.indexOf('-')>0&&
    W.__vitaFaceValue(e)!==undefined);});},
  FormControls.prototype,true);}});
Object.defineProperty(P,'length',{configurable:true,get:function(){
 /* On character data it is the number of characters, which is what code
    walking text reads before it slices. */
 if(this.nodeType===3||this.nodeType===8)return String(this.textContent||'').length;
 var t=this.tagName;
 if(t==='FORM')return this.elements.length;
 if(t==='SELECT')return this.options.length;
 return undefined;}});
Object.defineProperty(P,'options',{configurable:true,get:function(){
 if(this.tagName!=='SELECT'&&this.tagName!=='DATALIST')return undefined;
 /* the collection already answers to item and namedItem; attaching
    them here shadowed the real ones with a version that read the
    proxy's target and found nothing */
 var c=this.getElementsByTagName('option');
 /* HTMLOptionsCollection's selectedIndex is the select's, so the
    collection has to know which select it came from */
 if(c&&this.tagName==='SELECT'){
  try{Object.defineProperty(c,'__vitaOwner',
   {value:this,configurable:true});}catch(e){}
  try{Object.setPrototypeOf(c,W.HTMLOptionsCollection.prototype);}catch(e){}}
 return c;}});
Object.defineProperty(P,'selectedOptions',{configurable:true,get:function(){
 return listOf(this.options).filter(function(o){return o.selected;});}});
/* A select is itself an indexed collection of its options. */
P.item=function(i){
 if(this.tagName!=='SELECT')return shadowProp(this,'item',undefined);
 var o=this.options;i=Number(i)>>>0;return o&&i<o.length?o[i]:null;};
P.namedItem=function(n){
 if(this.tagName!=='SELECT')return shadowProp(this,'namedItem',undefined);
 var o=this.options,i;n=String(n);
 for(i=0;o&&i<o.length;i++){
  if(o[i].id===n||o[i].getAttribute('name')===n)return o[i];}
 return null;};
Object.defineProperty(P,'selectedIndex',{configurable:true,get:function(){
 if(this.tagName==='OPTION')return this.parentNode?this.parentNode.selectedIndex:-1;
 var o=this.options||[];for(var i=0;i<o.length;i++)if(o[i].selected)return i;
 return o.length?0:-1;},
 set:function(v){var o=this.options;
  if(!o)return shadowProp(this,'selectedIndex',v);
  for(var i=0;i<o.length;i++)o[i].selected=(i===Number(v));}});
Object.defineProperty(P,'index',{configurable:true,get:function(){
 if(this.tagName!=='OPTION')return undefined;
 var p=this.parentNode;while(p&&p.tagName==='OPTGROUP')p=p.parentNode;
 return p&&p.options?listOf(p.options).indexOf(this):0;}});
/* item and namedItem stay off the element prototype on purpose: code
 * tests for them to tell a collection from an element, and an element
 * that answers to both gets iterated as a collection. The collections
 * themselves carry them, above. */
/* select.value is the selected option's value, and option.value falls
 * back to its text; every other tag keeps the value attribute. */
(function(){var d=Object.getOwnPropertyDescriptor(P,'value');
 Object.defineProperty(P,'value',{configurable:true,
  get:function(){var t=this.tagName;
   if(t==='SELECT'){var i=this.selectedIndex,o=this.options;return i>=0&&o[i]?o[i].value:'';}
   if(t==='OPTION'){var v=this.getAttribute('value');return v===null?this.textContent:v;}
   if(t==='TEXTAREA')return this.textContent;
   return d.get.call(this);},
  set:function(v){var t=this.tagName;
   if(t==='SELECT'){var o=this.options;for(var i=0;i<o.length;i++)o[i].selected=(o[i].value===String(v));return;}
   if(t==='TEXTAREA'){this.textContent=String(v);return;}
   if(t==='INPUT'){
    /* value sanitization: a one-line field holds no line breaks, and an
       address none around it either (HTML standard) */
    var ty=String(this.getAttribute('type')||'text').toLowerCase();
    if(/^(text|search|tel|password|url|email)$/.test(ty)||
       !/^(hidden|checkbox|radio|file|submit|image|reset|button|number|range|color|date|month|week|time|datetime-local)$/.test(ty)){
     v=String(v).replace(/[\r\n]/g,'');
     if(ty==='url'||ty==='email')v=v.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g,'');}}
   d.set.call(this,v);}});})();
/* requestSubmit fires submit (a SubmitEvent naming its submitter) and
   goes on unless it is cancelled; submit() does neither */
P.requestSubmit=function(submitter){
 if(this.tagName!=='FORM')return;
 if(submitter!==undefined&&submitter!==null){
  if(!isSubmitButton(submitter))throw new TypeError("Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not a submit button.");
  if(submitter.form!==this)throw new DOMException("Failed to execute 'requestSubmit' on 'HTMLFormElement': The specified element is not owned by this form element.",'NotFoundError');}
 else submitter=null;
 formSubmit(this,submitter,false);};
/* The window a form or link target names (VitaSurf): _self, _parent,
   _top, or a frame by name, looked for here, then in the frames around
   this one. A name found nowhere, and _blank, stay here: there is one
   window on the Vita. */
function targetWindow(name){
 var n=String(name||'').trim(),l=n.toLowerCase(),w,seen=0;
 if(!n||l==='_self'||l==='_blank')return W;
 if(l==='_top')return W.top;
 if(l==='_parent')return W.parent;
 function find(win){
  var f,i;
  try{f=win.document.getElementsByTagName('iframe');}catch(e){return null;}
  for(i=0;i<f.length;i++){
   if(f[i].getAttribute('name')===n&&f[i].contentWindow)return f[i].contentWindow;}
  for(i=0;i<f.length;i++){
   var c=f[i].contentWindow,r=c&&c!==win?find(c):null;
   if(r)return r;}
  return null;}
 for(w=W;w&&seen<16;seen++){
  var r=find(w);if(r)return r;
  if(w===w.parent)break;w=w.parent;}
 return W;}
P.submit=function(){if(this.tagName==='FORM')formSubmit(this,null,true);};
/* The HTML standard's form submission (VitaSurf): the method, action,
   enctype and target, the submitter's own formmethod and the rest first;
   a GET puts the entries in the query, a POST to http or https sends
   them as the body its enctype names, and a dialog form closes its
   dialog. */
function formSubmit(form,submitter,fromMethod){
 if(!inDocument(form)||form.__vsBuilding)return;
 if(!fromMethod){
  if(form.__vsFiring)return;
  var go;form.__vsFiring=true;
  try{go=form.dispatchEvent(uaEvent(new W.SubmitEvent('submit',
   {bubbles:true,cancelable:true,submitter:submitter})));}
  finally{form.__vsFiring=false;}
  if(!go)return;}
 function attr(n,sn){return submitter&&submitter.hasAttribute(sn)?
  submitter.getAttribute(sn):form.getAttribute(n);}
 var method=String(attr('method','formmethod')||'').toLowerCase();
 if(method!=='post'&&method!=='dialog')method='get';
 if(method==='dialog'){
  var dlg=closestTag(form,'DIALOG');
  if(!dlg||typeof dlg.close!=='function')return;
  if(submitter&&!(submitter.tagName==='INPUT'&&
     String(submitter.getAttribute('type')).toLowerCase()==='image'))
   dlg.close(String(submitter.value));
  else dlg.close();
  return;}
 var list=formEntryList(form,submitter);
 if(list===null||!inDocument(form))return;
 var action=attr('action','formaction'),u;
 try{u=new URL(action===null||action===''?D.URL:action,D.baseURI);}catch(e){return;}
 var enctype=String(attr('enctype','formenctype')||'').toLowerCase();
 if(enctype!=='multipart/form-data'&&enctype!=='text/plain')
  enctype='application/x-www-form-urlencoded';
 var target=attr('target','formtarget');
 if(target===null||target===''){var bt=D.querySelector('base[target]');
  target=bt?bt.getAttribute('target'):'';}
 var win=targetWindow(target),scheme=u.protocol,href=u.href,body=null,type=null;
 if(method==='post'&&(scheme==='http:'||scheme==='https:')){
  if(enctype==='multipart/form-data'){var mp=formMultipart(list);body=mp.body;type=mp.type;}
  else if(enctype==='text/plain'){body=formTextPlain(list);type='text/plain';}
  else{body=formUrlencoded(list,true);type='application/x-www-form-urlencoded';}}
 else if(method==='get'&&/^(https?|ftp|data|file):$/.test(scheme)){
  /* the entries replace the action's query, whatever the enctype */
  var pre=href.split('#')[0],q=pre.indexOf('?');
  if(q>=0)pre=pre.slice(0,q);
  href=pre+'?'+formUrlencoded(list,true)+u.hash;}
 /* Navigating in the middle of a dispatch tears down the page the
    dispatch is walking; let the current task finish first. */
 setTimeout(function(){try{
  if(body!==null)win.__vitaNavigatePost(href,body,type);
  else win.location.href=href;}catch(e){}},0);}
P.reset=function(){
 if(this.tagName!=='FORM')return;
 if(!this.dispatchEvent(uaEvent(new Event('reset',{bubbles:true,cancelable:true}))))return;
 listOf(this.elements).forEach(function(c){
  if(c.tagName==='SELECT'){c.selectedIndex=0;return;}
  if(c.type==='checkbox'||c.type==='radio'){c.checked=c.defaultChecked;return;}
  c.value=c.defaultValue;});};

/* --- image, script and link ---------------------------------------------
 * An image that has not loaded reports complete false and zero natural
 * dimensions, which is what lazy-loading code branches on; one that has
 * laid out reports its box.
 */
Object.defineProperty(P,'complete',{configurable:true,get:function(){
 return this.tagName!=='IMG'||!!__vitaBox(this);}});
['naturalWidth','naturalHeight'].forEach(function(k,n){Object.defineProperty(P,k,{configurable:true,
 get:function(){var b=__vitaBox(this);return b?b[2+n]:0;}});});
Object.defineProperty(P,'currentSrc',{configurable:true,get:function(){return this.src||'';}});
['x','y'].forEach(function(k,n){Object.defineProperty(P,k,{configurable:true,
 get:function(){var b=__vitaBox(this);return b?b[n]:0;}});});
P.decode=function(){return Promise.resolve();};
Object.defineProperty(P,'sheet',{configurable:true,get:function(){return null;}});
/* --- frames -------------------------------------------------------------
 * An iframe's window and document (VitaSurf). An iframe NetSurf loads is
 * a window of its own whose scripts run in this page's runtime, so its
 * global is the real window: a same-origin frame's contentWindow is that
 * global and its contentDocument that document, and the frame sees this
 * page as its parent and its iframe as frameElement. A cross-origin frame
 * is seen through a window that has only what a browser allows across
 * origins -- postMessage, location to navigate, closed, focus -- and
 * refuses the rest. postMessage between windows carries a copy of the
 * data with the sender's origin and window.
 *
 * An iframe NetSurf has no window for -- one with no src, or hidden --
 * falls back to a stand-in: this window seen through the frame, with a
 * blank document of its own when same origin. A page that makes a blank
 * iframe to write into, or to take a clean copy of the built-ins from --
 * claude.ai's bundle among them -- had thrown on the first property it
 * read when both were null.
 */
(function(){
 var NF=W.__vitaFrameGlobal,NP=W.__vitaParentGlobal,NT=W.__vitaTopGlobal,
  NE=W.__vitaFrameElement,NX=W.__vitaEntryGlobal,NS=W.__vitaFrameStart,
  NO=W.__vitaFrameOf;
 ['__vitaFrameGlobal','__vitaParentGlobal','__vitaTopGlobal',
  '__vitaFrameElement','__vitaEntryGlobal','__vitaFrameStart',
  '__vitaFrameOf'].forEach(
  function(k){delete W[k];});
 function call(f,a){try{return f?f(a):null;}catch(e){return null;}}
 /* an iframe's page, its window made now if layout has not made it: a
    blank or srcdoc-less frame has its document at once, as in a browser,
    and anything else starts loading sooner */
 function frameGlobal(el){
  var g=call(NF,el);
  return g||el.tagName!=='IFRAME'?g:call(NS,el);}
 /* a new src or srcdoc navigates the frame at once, as in a browser */
 Object.defineProperty(P,'srcdoc',{configurable:true,
  get:function(){
   if(this.tagName!=='IFRAME')return undefined;
   var v=this.getAttribute('srcdoc');return v===null?'':v;},
  set:function(v){
   if(this.tagName!=='IFRAME'){Object.defineProperty(this,'srcdoc',
    {value:v,writable:true,configurable:true,enumerable:true});return;}
   this.setAttribute('srcdoc',String(v));}});
 ['setAttribute','removeAttribute'].forEach(function(m){
  var orig=P[m];
  P[m]=function(n){
   var r=orig.apply(this,arguments);
   if(this.tagName==='IFRAME'&&/^src(doc)?$/i.test(String(n))&&
      this.isConnected)call(NS,this);
   return r;};});
 /* origins, as keys to compare: a file page's is the scheme, as the
    frames of a local page are one site; about:blank and about:srcdoc
    have their maker's. Any other about: page is one of NetSurf's own,
    such as the error page a failed load leaves in a frame, and is
    opaque: a browser's error page is no site's either. */
 function hrefOf(g){try{return String(g.location.href);}catch(e){return '';}}
 function inherits(h){return /^about:(blank|srcdoc)([?#]|$)/i.test(h);}
 function keyOfHref(h){
  if(/^about:/i.test(h))return 'opaque '+h;
  try{var u=new URL(h);return u.protocol==='file:'?'file:':u.origin;}
  catch(e){return 'null';}}
 function myKey(){
  var h=hrefOf(W),p;
  if(inherits(h)&&(p=call(NP))){
   var ph=hrefOf(p);return inherits(ph)?'null':keyOfHref(ph);}
  return keyOfHref(h);}
 function keyOf(g){
  if(g===W)return myKey();
  var h=hrefOf(g);
  return inherits(h)?myKey():keyOfHref(h);}
 /* what event.origin says for a window */
 function originOf(g){
  var h=g===W?hrefOf(W):hrefOf(g),p;
  if(/^about:/i.test(h)&&!inherits(h))return 'null';
  if(inherits(h)){
   if(g!==W)return originOf(W);
   p=call(NP);return p?originOf(p):'null';}
  try{return new URL(h).origin;}catch(e){return 'null';}}
 var CROSS=new WeakMap();
 /* a raw global as this page may see it */
 /* A frame of another origin is seen through one window for as long as
    the frame lives, whatever page it shows, as a browser's WindowProxy
    is (VitaSurf): keyed by its iframe element and reaching the page it
    shows now. It was one per page, so the window a page took from the
    frame when it was made, still blank, was not the source of the
    messages its page later sent, and a page that matches the two --
    the claude.ai challenge's widget does -- never heard its frame. */
 var CROSS_EL=new WeakMap();
 function frameView(el){
  var r=CROSS_EL.get(el);
  if(!r){r=crossWindow(function(){return call(NF,el);},el);CROSS_EL.set(el,r);}
  return r;}
 function view(g){
  if(!g||g===W)return g?W:null;
  if(keyOf(g)===myKey())return g;
  var el=call(NO,g);
  if(el)return frameView(el);
  var r=CROSS.get(g);
  if(!r){r=crossWindow(function(){return g;},null);CROSS.set(g,r);}
  return r;}
 function deny(k){
  throw new DOMException('Blocked a frame from accessing a cross-origin frame'+
   (typeof k==='string'?' (property "'+k+'")':'')+'.','SecurityError');}
 /* cur() is the page the window shows now, or null before its frame has
    one; el its iframe, when it is one of this page's frames */
 function crossWindow(cur,el){
  function nav(v){
   var g=cur();
   if(g)g.location.href=String(v);
   else if(el)el.setAttribute('src',String(v));}
  var self,loc=Object.create(null),fns={
   postMessage:function postMessage(m,o,t){
    var g=cur();
    msgSent(m,el?'its frame':'another window');
    /* before its page is there the frame's blank start has no one
       listening, and the message goes nowhere */
    if(g)return g.postMessage.apply(g,arguments);},
   close:function close(){},focus:function focus(){},blur:function blur(){}};
  Object.defineProperty(loc,'href',{get:function(){deny('href');},
   set:function(v){nav(v);}});
  loc.replace=function(v){var g=cur();if(g)g.location.replace(String(v));else nav(v);};
  self=new Proxy(Object.create(null),{
   get:function(t,k){
    if(Object.prototype.hasOwnProperty.call(fns,k))return fns[k];
    if(k==='closed')return false;
    if(k==='window'||k==='self'||k==='frames')return self;
    if(k==='top')return view(call(NT)||W);
    if(k==='parent')return cur()===call(NP)?view(call(NT)||W):W;
    if(k==='opener')return null;
    if(k==='length')return 0;
    if(k==='location')return loc;
    if(k==='then'||typeof k==='symbol')return undefined;
    deny(k);},
   set:function(t,k,v){
    if(k==='location'){nav(v);return true;}
    deny(k);},
   has:function(t,k){return k in fns||k==='closed'||k==='location';},
   ownKeys:function(){return [];},
   getOwnPropertyDescriptor:function(t,k){deny(k);},
   defineProperty:function(t,k){deny(k);},
   deleteProperty:function(t,k){deny(k);},
   getPrototypeOf:function(){return null;},
   setPrototypeOf:function(){deny('prototype');}});
  return self;}
 Object.defineProperties(W,{
  parent:{configurable:true,get:function(){var p=call(NP);return p?view(p):W;},
   set:function(){}},
  top:{configurable:true,get:function(){var t=call(NT);return t?view(t):W;},
   set:function(){}},
  frameElement:{configurable:true,get:function(){
   var p=call(NP);
   if(!p||keyOf(p)!==myKey())return null;
   return call(NE);},set:function(){}}});
 /* window[n] is the nth frame's window */
 function frameEls(){return D.querySelectorAll('iframe,frame');}
 for(var n=0;n<10;n++)(function(n){
  Object.defineProperty(W,n,{configurable:true,get:function(){
   var e=frameEls()[n];return e?e.contentWindow:undefined;}});})(n);
 /*
  * postMessage from whichever window called it: the page whose script
  * the runtime entered is the sender, the data is copied here, into the
  * receiving window's own objects, and the event is queued here.
  */
 W.postMessage=function postMessage(message,options){
  if(arguments.length<1)
   throw new TypeError("Failed to execute 'postMessage' on 'Window': 1 argument required, but only 0 present.");
  var to=(options!==null&&typeof options==='object')?options.targetOrigin:options,
   src=call(NX)||W,data,ev,ports;
  /* the ports handed over: postMessage(m, origin, [port]) or
     postMessage(m, {targetOrigin, transfer: [port]}) */
  ports=portList(options!==null&&typeof options==='object'?options.transfer:arguments[2]);
  to=to===undefined?'/':String(to);
  if(to==='/')to=originOf(src);
  else if(to!=='*'){
   try{to=new URL(to).origin;}
   catch(e){throw new DOMException("Invalid target origin '"+to+"' in a call to 'postMessage'.",'SyntaxError');}}
  if(ports.length)data=message;
  else data=W.structuredClone(message);
  if(to!=='*'&&to!==originOf(W)){
   msgNote(src,message,'dropped: its target origin is not this window\'s');
   return;}
  if(ports.length)ports=portMove(ports,W.MessagePort);
  ev=uaEvent(new W.MessageEvent('message',{data:data,origin:src===W?originOf(W):originOf(src),
   source:view(src),ports:ports}));
  setTimeout(function(){
   var tr=msgTraceStart(src,ev,data,ports);
   msgNote(src,message,'delivered'+(to==='*'?' (to any origin)':''));
   __vitaDispatch(null,ev);
   if(tr)setTimeout(function(){msgTraceEnd(tr);},50);},0);};
 /* What a page did with the first few messages another window sent it
    (VitaSurf): which of the event's fields and which of the data's keys
    it read, and what it sent on in the next moment. Names only. The
    claude.ai challenge's widget sends its page "init" and asks for its
    parameters, and the page never answers; this says how far its
    handling got. */
 var TRACE_LEFT=4,SENT=null;
 function msgKind(m){
  try{var w=m&&typeof m==='object'?(typeof m.event==='string'?m.event:
   typeof m.type==='string'?m.type:''):'';
   return /^[\w.:-]{1,24}$/.test(w)?w:'';}catch(e){return '';}}
 function msgTraceStart(src,ev,data,ports){
  var tr,kind=msgKind(data);
  if(TRACE_LEFT<=0||src===W||!kind||ports.length||!data||typeof data!=='object'||
   Array.isArray(data))return null;
  if(kind==='meow'||kind==='food')return null;
  TRACE_LEFT--;
  tr={kind:kind,read:[],sent:[]};
  function note(n){if(tr.read.indexOf(n)<0&&tr.read.length<40)tr.read.push(n);}
  ['source','origin','data','ports','lastEventId'].forEach(function(k){
   var v=ev[k];
   try{Object.defineProperty(ev,k,{configurable:true,enumerable:true,
    get:function(){note('event.'+k);return v;}});}catch(e){}});
  Object.keys(data).forEach(function(k){
   var v=data[k];
   if(!/^[\w$-]{1,32}$/.test(k))return;
   try{Object.defineProperty(data,k,{configurable:true,enumerable:true,
    get:function(){note('data.'+k);return v;},
    set:function(x){v=x;}});}catch(e){}});
  SENT=tr.sent;
  return tr;}
 function msgTraceEnd(tr){
  if(SENT===tr.sent)SENT=null;
  if(typeof MN!=='function')return;
  try{MN('the page\'s handling of "'+tr.kind+'" read '+
   (tr.read.length?tr.read.join(', '):'nothing of it')+'; it sent '+
   (tr.sent.length?tr.sent.join(', '):'nothing')+' in the next 50 ms');}catch(e){}}
 function msgSent(m,where){
  if(!SENT||SENT.length>=8)return;
  var k=msgKind(m);
  SENT.push((k?'"'+k+'"':'a message')+' to '+where);}
 /* the log's line for a message: where from, and its kind when the data
    names one with a short word, as {event: "ready"} does; nothing else
    of the data is written */
 var MN=W.__vitaMessageNote;
 try{delete W.__vitaMessageNote;}catch(e){}
 function msgNote(src,m,what){
  var k='',w;
  if(typeof MN!=='function')return;
  try{
   if(m&&typeof m==='object'){
    w=typeof m.event==='string'?m.event:typeof m.type==='string'?m.type:'';
    if(/^[\w.:-]{1,24}$/.test(w))k=' "'+w+'"';}
   else if(typeof m==='string')k=' (a string of '+m.length+')';}
  catch(e){}
  try{MN('a message'+k+' '+(src===W?'from this window':
   keyOf(src)===myKey()?'from a window of this origin':
   'from a window of another origin')+', '+what);}catch(e){}}
 var FRAMES=new WeakMap();
 function sameOrigin(el){
  var src=el.getAttribute('src');
  if(el.hasAttribute('srcdoc')||src===null)return true;
  src=String(src).trim();
  if(src===''||/^(about:|javascript:)/i.test(src))return true;
  try{return new URL(src,D.baseURI).origin===location.origin;}
  catch(e){return false;}}
 function refuse(){
  throw new DOMException('Blocked a frame from accessing a cross-origin '+
   'frame.','SecurityError');}
 function frameWindow(el){
  var f=FRAMES.get(el);
  if(f)return f;
  var doc=null,listeners={},own,proxy;
  function document(){
   if(!sameOrigin(el))refuse();
   if(!doc){doc=D.implementation.createHTMLDocument('');
    try{Object.defineProperty(doc,'defaultView',{configurable:true,
     get:function(){return proxy;}});}catch(e){}}
   return doc;}
  own={
   frameElement:el,opener:null,closed:false,length:0,
   postMessage:function(data){
    var l=(listeners.message||[]).slice(),ev;
    if(!l.length)return;
    ev={type:'message',data:data,origin:location.origin,source:W,
     ports:[],lastEventId:''};
    setTimeout(function(){l.forEach(function(fn){
     try{fn.call(proxy,ev);}catch(e){reportError(e);}});},0);},
   addEventListener:function(t,fn){
    if(typeof fn!=='function')return;
    t=String(t);(listeners[t]=listeners[t]||[]);
    if(listeners[t].indexOf(fn)<0)listeners[t].push(fn);},
   removeEventListener:function(t,fn){
    var a=listeners[String(t)],i=a?a.indexOf(fn):-1;
    if(i>=0)a.splice(i,1);},
   dispatchEvent:function(ev){
    (listeners[ev&&ev.type]||[]).slice().forEach(function(fn){
     fn.call(proxy,ev);});
    return !(ev&&ev.defaultPrevented);}};
  Object.defineProperties(own,{
   document:{configurable:true,get:document},
   window:{configurable:true,get:function(){return proxy;}},
   self:{configurable:true,get:function(){return proxy;}},
   frames:{configurable:true,get:function(){return proxy;}},
   parent:{configurable:true,get:function(){return W;}},
   top:{configurable:true,get:function(){return W.top;}},
   name:{configurable:true,get:function(){return el.getAttribute('name')||'';}},
   location:{configurable:true,get:function(){
    var src=el.getAttribute('src');
    return {
     get href(){if(!sameOrigin(el))refuse();
      return src?new URL(src,D.baseURI).href:'about:blank';},
     set href(v){el.setAttribute('src',String(v));},
     assign:function(v){el.setAttribute('src',String(v));},
     replace:function(v){el.setAttribute('src',String(v));},
     reload:function(){},
     toString:function(){return this.href;}};}}});
  proxy=new Proxy(own,{
   get:function(t,k){
    if(k in t)return t[k];
    if(k===Symbol.toStringTag)return 'Window';
    return W[k];},
   has:function(t,k){return k in t||k in W;},
   set:function(t,k,v){t[k]=v;return true;}});
  FRAMES.set(el,proxy);
  return proxy;}
 function isFrame(el){return el.tagName==='IFRAME'||el.tagName==='FRAME';}
 Object.defineProperty(P,'contentWindow',{configurable:true,get:function(){
  if(!isFrame(this))return this.tagName==='OBJECT'?null:undefined;
  if(!this.isConnected)return null;
  var g=frameGlobal(this);
  /* another origin's frame is the same window before its page comes as
     after -- while the blank start made for script stands in, which is
     of this origin -- and through every page it goes on to show */
  if(!sameOrigin(this)||(g&&keyOf(g)!==myKey()))return frameView(this);
  return g?view(g):frameWindow(this);}});
 Object.defineProperty(P,'contentDocument',{configurable:true,get:function(){
  if(!isFrame(this))return this.tagName==='OBJECT'?null:undefined;
  if(!this.isConnected)return null;
  var g=frameGlobal(this);
  if(g)return keyOf(g)===myKey()?g.document:null;
  if(!sameOrigin(this))return null;
  return frameWindow(this).document;}});
})();

var SVG_NS='http://www.w3.org/2000/svg';
/* The SVG element an SVG element sits in (VitaSurf): null for the
   outermost one, and not there at all on an HTML element. */
['ownerSVGElement','viewportElement'].forEach(function(k){
 Object.defineProperty(P,k,{configurable:true,get:function(){
  if(this.namespaceURI!==SVG_NS)return undefined;
  for(var n=this.parentNode;n&&n.nodeType===1;n=n.parentNode)
   if(n.namespaceURI===SVG_NS&&n.localName==='svg')return n;
  return null;}});});
if(W.HTMLScriptElement)W.HTMLScriptElement.supports=function(t){
 return t==='classic'||t==='module'||t==='importmap';};

/* --- Range --------------------------------------------------------------
 * A real range: editors, sanitizers and every library that parses a
 * fragment with createContextualFragment need one that holds boundary
 * points rather than the placeholder that was here.
 */
function Range(){this.startContainer=D.body||D.documentElement;this.startOffset=0;
 this.endContainer=this.startContainer;this.endOffset=0;}
function nodeLen(n){return n.nodeType===3?String(n.textContent||'').length:n.childNodes.length;}
function ancestors(n){var a=[];for(;n;n=n.parentNode)a.unshift(n);return a;}
/* -1, 0 or 1 for (a,ao) against (b,bo) in tree order. */
function cmpPoint(a,ao,b,bo){
 if(a===b)return ao<bo?-1:ao>bo?1:0;
 var pa=ancestors(a),pb=ancestors(b);
 if(pa[0]!==pb[0])return 1;
 var i=0;while(pa[i]&&pb[i]&&pa[i]===pb[i])i++;
 if(!pa[i])return indexOfNode(pb[i])<ao?1:-1;   /* a is an ancestor of b */
 if(!pb[i])return indexOfNode(pa[i])<bo?-1:1;
 return indexOfNode(pa[i])<indexOfNode(pb[i])?-1:1;}
function indexOfNode(n){var p=n.parentNode;if(!p)return 0;
 var c=p.childNodes;for(var i=0;i<c.length;i++)if(c[i]===n)return i;return 0;}
Object.defineProperty(Range.prototype,'collapsed',{configurable:true,get:function(){
 return this.startContainer===this.endContainer&&this.startOffset===this.endOffset;}});
Object.defineProperty(Range.prototype,'commonAncestorContainer',{configurable:true,get:function(){
 var a=ancestors(this.startContainer),b=ancestors(this.endContainer),i=0;
 while(a[i]&&b[i]&&a[i]===b[i])i++;
 return a[i-1]||this.startContainer;}});
Range.prototype.setStart=function(n,o){this.startContainer=n;this.startOffset=o|0;
 if(cmpPoint(this.startContainer,this.startOffset,this.endContainer,this.endOffset)>0){
  this.endContainer=n;this.endOffset=o|0;}};
Range.prototype.setEnd=function(n,o){this.endContainer=n;this.endOffset=o|0;
 if(cmpPoint(this.startContainer,this.startOffset,this.endContainer,this.endOffset)>0){
  this.startContainer=n;this.startOffset=o|0;}};
Range.prototype.setStartBefore=function(n){this.setStart(n.parentNode,indexOfNode(n));};
Range.prototype.setStartAfter=function(n){this.setStart(n.parentNode,indexOfNode(n)+1);};
Range.prototype.setEndBefore=function(n){this.setEnd(n.parentNode,indexOfNode(n));};
Range.prototype.setEndAfter=function(n){this.setEnd(n.parentNode,indexOfNode(n)+1);};
Range.prototype.selectNode=function(n){this.setStartBefore(n);this.setEndAfter(n);};
Range.prototype.selectNodeContents=function(n){this.setStart(n,0);this.setEnd(n,nodeLen(n));};
Range.prototype.collapse=function(toStart){
 if(toStart){this.endContainer=this.startContainer;this.endOffset=this.startOffset;}
 else{this.startContainer=this.endContainer;this.startOffset=this.endOffset;}};
Range.prototype.cloneRange=function(){var r=new Range();r.startContainer=this.startContainer;
 r.startOffset=this.startOffset;r.endContainer=this.endContainer;r.endOffset=this.endOffset;return r;};
Range.prototype.detach=function(){};
Range.prototype.comparePoint=function(n,o){
 if(cmpPoint(n,o,this.startContainer,this.startOffset)<0)return -1;
 if(cmpPoint(n,o,this.endContainer,this.endOffset)>0)return 1;
 return 0;};
Range.prototype.isPointInRange=function(n,o){return this.comparePoint(n,o)===0;};
Range.prototype.intersectsNode=function(n){var p=n.parentNode;if(!p)return false;
 var i=indexOfNode(n);
 return cmpPoint(p,i,this.endContainer,this.endOffset)<0&&
  cmpPoint(p,i+1,this.startContainer,this.startOffset)>0;};
Range.prototype.compareBoundaryPoints=function(how,other){
 var a=how===0||how===1?[this.startContainer,this.startOffset]:[this.endContainer,this.endOffset];
 var b=how===0||how===3?[other.startContainer,other.startOffset]:[other.endContainer,other.endOffset];
 return cmpPoint(a[0],a[1],b[0],b[1]);};
/* The nodes wholly inside the range, topmost first. */
Range.prototype._nodes=function(){
 var out=[],root=this.commonAncestorContainer,self=this;
 (function walk(n){for(var i=0;i<n.childNodes.length;i++){var c=n.childNodes[i];
  var p=c.parentNode,idx=indexOfNode(c);
  if(cmpPoint(p,idx,self.startContainer,self.startOffset)>=0&&
     cmpPoint(p,idx+1,self.endContainer,self.endOffset)<=0){out.push(c);continue;}
  if(self.intersectsNode(c))walk(c);}})(root);
 return out;};
Range.prototype.extractContents=function(){var f=D.createDocumentFragment();
 this._nodes().forEach(function(n){f.appendChild(n);});this.collapse(true);return f;};
hide(Range.prototype,'_nodes',Range.prototype._nodes);
Range.prototype.deleteContents=function(){this._nodes().forEach(function(n){n.remove();});
 this.collapse(true);};
Range.prototype.cloneContents=function(){var f=D.createDocumentFragment();
 this._nodes().forEach(function(n){f.appendChild(n.cloneNode(true));});return f;};
Range.prototype.insertNode=function(n){var c=this.startContainer;
 if(c.nodeType===3){var p=c.parentNode;if(p)p.insertBefore(n,c.nextSibling);return;}
 var ref=c.childNodes[this.startOffset]||null;
 if(ref)c.insertBefore(n,ref);else c.appendChild(n);};
Range.prototype.surroundContents=function(wrap){var f=this.extractContents();
 wrap.appendChild(f);this.insertNode(wrap);};
Range.prototype.createContextualFragment=function(html){
 var d=D.createElement('div');d.innerHTML=String(html);
 var f=D.createDocumentFragment();
 while(d.firstChild)f.appendChild(d.firstChild);
 return f;};
Range.prototype.getBoundingClientRect=function(){
 var n=this.startContainer;
 while(n&&n.nodeType!==1)n=n.parentNode;
 return n?n.getBoundingClientRect():{top:0,left:0,right:0,bottom:0,width:0,height:0,x:0,y:0};};
Range.prototype.getClientRects=function(){var r=this.getBoundingClientRect();
 return r.width||r.height?[r]:[];};
Range.prototype.toString=function(){
 var s='';this._nodes().forEach(function(n){s+=n.textContent||'';});
 if(!s&&this.startContainer===this.endContainer&&this.startContainer.nodeType===3)
  s=String(this.startContainer.textContent).slice(this.startOffset,this.endOffset);
 return s;};
Range.START_TO_START=0;Range.START_TO_END=1;Range.END_TO_END=2;Range.END_TO_START=3;
W.Range=Range;W.AbstractRange=Range;
W.StaticRange=function(init){init=init||{};this.startContainer=init.startContainer||null;
 this.startOffset=init.startOffset||0;this.endContainer=init.endContainer||null;
 this.endOffset=init.endOffset||0;};
Object.defineProperty(W.StaticRange.prototype,'collapsed',{configurable:true,get:function(){
 return this.startContainer===this.endContainer&&this.startOffset===this.endOffset;}});
D.createRange=function(){return new Range();};

/* --- Selection ----------------------------------------------------------
 * There is no caret on the Vita, so the selection is empty until a
 * script sets one, and then it is exactly what the script set.
 */
function Selection(){this._r=[];}
Object.defineProperty(Selection.prototype,'rangeCount',{configurable:true,get:function(){return this._r.length;}});
Object.defineProperty(Selection.prototype,'isCollapsed',{configurable:true,get:function(){
 return !this._r.length||this._r[0].collapsed;}});
Object.defineProperty(Selection.prototype,'type',{configurable:true,get:function(){
 return !this._r.length?'None':(this._r[0].collapsed?'Caret':'Range');}});
['anchorNode','focusNode'].forEach(function(k,n){Object.defineProperty(Selection.prototype,k,{configurable:true,
 get:function(){var r=this._r[0];return r?(n?r.endContainer:r.startContainer):null;}});});
['anchorOffset','focusOffset'].forEach(function(k,n){Object.defineProperty(Selection.prototype,k,{configurable:true,
 get:function(){var r=this._r[0];return r?(n?r.endOffset:r.startOffset):0;}});});
Object.defineProperty(Selection.prototype,'direction',{configurable:true,get:function(){
 return this.isCollapsed?'none':'forward';}});
Selection.prototype.getRangeAt=function(i){if(!this._r[i])throw new Error('IndexSizeError');return this._r[i];};
Selection.prototype.addRange=function(r){this._r.push(r);};
Selection.prototype.removeRange=function(r){this._r=this._r.filter(function(x){return x!==r;});};
Selection.prototype.removeAllRanges=Selection.prototype.empty=function(){this._r=[];};
Selection.prototype.collapse=Selection.prototype.setPosition=function(n,o){
 if(!n){this._r=[];return;}var r=new Range();r.setStart(n,o||0);r.collapse(true);this._r=[r];};
Selection.prototype.collapseToStart=function(){if(this._r[0])this._r[0].collapse(true);};
Selection.prototype.collapseToEnd=function(){if(this._r[0])this._r[0].collapse(false);};
Selection.prototype.extend=function(n,o){if(this._r[0])this._r[0].setEnd(n,o||0);};
Selection.prototype.setBaseAndExtent=function(a,ao,f,fo){var r=new Range();
 r.setStart(a,ao);r.setEnd(f,fo);this._r=[r];};
Selection.prototype.selectAllChildren=function(n){var r=new Range();r.selectNodeContents(n);this._r=[r];};
Selection.prototype.containsNode=function(n){return this._r.some(function(r){return r.intersectsNode(n);});};
Selection.prototype.deleteFromDocument=function(){this._r.forEach(function(r){r.deleteContents();});};
Selection.prototype.getComposedRanges=function(){return this._r.slice();};
Selection.prototype.modify=GAP('Selection.modify');
Selection.prototype.toString=function(){return this._r.map(String).join('');};
W.Selection=Selection;
var theSelection=new Selection();
D.getSelection=W.getSelection=function(){return theSelection;};

/* --- document and window gaps ------------------------------------------- */
Object.defineProperty(D,'children',{configurable:true,get:function(){
 var e=D.documentElement;return e?[e]:[];}});
Object.defineProperty(D,'childElementCount',{configurable:true,get:function(){return D.children.length;}});
Object.defineProperty(D,'firstElementChild',{configurable:true,get:function(){return D.documentElement;}});
Object.defineProperty(D,'lastElementChild',{configurable:true,get:function(){return D.documentElement;}});
Object.defineProperty(D,'contentType',{configurable:true,get:function(){return 'text/html';}});
Object.defineProperty(D,'compatMode',{configurable:true,get:function(){return 'CSS1Compat';}});
Object.defineProperty(D,'doctype',{configurable:true,get:function(){
 return {name:'html',publicId:'',systemId:'',nodeType:10};}});
Object.defineProperty(D,'scrollingElement',{configurable:true,get:function(){return D.documentElement;}});
Object.defineProperty(D,'lastModified',{configurable:true,get:function(){return new Date().toString();}});
/* The document's encoding, as the parser settled it. __vitaEncoding is
   the one NetSurf actually decoded with; a page with no declaration is
   not UTF-8 just because we would like it to be. */
['characterSet','charset','inputEncoding'].forEach(function(k){
 Object.defineProperty(D,k,{configurable:true,get:function(){
  return (typeof __vitaEncoding==='function'&&__vitaEncoding())||'UTF-8';}});});
D.designMode='off';
D.dir='';
['anchors','applets','embeds','plugins','scripts','forms','images','links'].forEach(function(k){
 if(Object.prototype.hasOwnProperty.call(D,k))return;
 Object.defineProperty(D,k,{configurable:true,get:function(){
  switch(k){
  case 'anchors':return D.querySelectorAll('a[name]');
  case 'applets':return [];
  case 'embeds':case 'plugins':return D.getElementsByTagName('embed');
  case 'scripts':return D.getElementsByTagName('script');
  case 'forms':return D.getElementsByTagName('form');
  case 'images':return D.getElementsByTagName('img');
  default:return D.querySelectorAll('a[href],area[href]');}}});});
Object.defineProperty(D,'all',{configurable:true,get:function(){return D.getElementsByTagName('*');}});
Object.defineProperty(D,'styleSheets',{configurable:true,get:function(){
 var l=[];l.item=function(i){return this[i]||null;};return l;}});
D.timeline={currentTime:0};
['alinkColor','bgColor','fgColor','linkColor','vlinkColor'].forEach(function(k){D[k]='';});
D.append=P.append;D.prepend=P.prepend;D.replaceChildren=P.replaceChildren;
D.captureEvents=D.releaseEvents=D.clear=function(){};
D.caretPositionFromPoint=function(){return null;};
D.caretRangeFromPoint=function(){return null;};
['convertPointFromNode','convertQuadFromNode','convertRectFromNode'].forEach(function(k){
 D[k]=P[k]=function(p){return p;};});
P.getBoxQuads=function(){return [this.getBoundingClientRect()];};
P.getHTML=function(){return this.innerHTML;};
P.setHTML=function(h){this.innerHTML=String(h);};
P.setHTMLUnsafe=function(h){this.innerHTML=String(h);declarativeShadows(this);};
P.moveBefore=function(n,ref){return this.insertBefore(n,ref||null);};
/* An attribute node, which getAttributeNode used to fake with an object
 * literal. Sanitizers walk these and read ownerElement off them. */
function Attr(el,name,value){
 this._e=el;this._v=value===undefined?'':String(value);this._g=-1;
 this.name=String(name);this.localName=this.name;
 this.prefix=null;this.namespaceURI=null;this.specified=true;
 this.nodeType=2;this.nodeName=this.name;
 this.childNodes=[];this.parentNode=null;}
/* Live, like the thing it stands for: reading gives what the element
   says now and writing puts it back, rather than a copy taken once. */
(function(){
 /* _g is the tree generation _v was read at: until something writes
    an attribute, the value the map was filled with is still the one
    the element has, and Alpine reads .value off every attribute of
    every element it starts (VitaSurf). */
 function get(){
  if(!this._e)return this._v;
  var g=domGen();
  if(g>=0&&this._g===g)return this._v;
  var v=this.namespaceURI
   ?this._e.getAttributeNS(this.namespaceURI,this.localName)
   :this._e.getAttribute(this.name);
  if(v===null)return this._v;
  this._v=v;this._g=g;
  return v;}
 function set(v){
  this._v=String(v);this._g=-1;
  if(!this._e)return;
  if(this.namespaceURI)this._e.setAttributeNS(this.namespaceURI,this.name,this._v);
  else this._e.setAttribute(this.name,this._v);}
 ['value','nodeValue','textContent'].forEach(function(k){
  Object.defineProperty(Attr.prototype,k,{configurable:true,enumerable:true,
   get:get,set:set});});})();
Object.defineProperty(Attr.prototype,'ownerElement',{configurable:true,
 get:function(){return this._e||null;}});
Object.defineProperty(Attr.prototype,'ownerDocument',{configurable:true,
 get:function(){return D;}});
Attr.prototype.isEqualNode=function(o){
 return !!o&&o.nodeType===2&&o.name===this.name&&o.value===this.value;};
W.Attr=Attr;
/* One attribute node per element, namespace and local name, kept so
   identity holds: el.attributes[0], el.getAttributeNode(n) and
   getAttributeNodeNS all have to be the same object, and code compares
   them. */
var rawAttrs=null;
function attrMap(el){
 var m=el.__vitaAttrs;
 if(!m){m=Object.create(null);
  Object.defineProperty(el,'__vitaAttrs',{value:m,configurable:true});}
 return m;}
function attrKeyOf(ns,local){return (ns===null||ns===undefined?'':ns)+'|'+local;}
function attrNodeFor(el,raw,g){
 var m=attrMap(el),k=attrKeyOf(raw.namespace,raw.localName||raw.name),a=m[k];
 if(!a||a._e!==el){
  a=new Attr(el,raw.name,raw.value);
  a.namespaceURI=raw.namespace===undefined?null:raw.namespace;
  a.localName=raw.localName||raw.name;
  a.prefix=raw.prefix===undefined?null:raw.prefix;
  m[k]=a;}
 if(g!==undefined&&g>=0){a._v=String(raw.value);a._g=g;}
 return a;}
/* Removing the attribute leaves the node behind with the value it had
   and no owner, which is what the node's own removal means. */
function detachAttr(el,ns,local){
 var m=el.__vitaAttrs,k=attrKeyOf(ns,local),a=m&&m[k];
 if(a&&a._e===el){a._v=a.value;a._e=null;delete m[k];}}
/* An HTML element's attribute names are lower case however they were
   written, so the node for Foo and for foo is the one node. */
function attrKey(el,n){
 n=String(n);
 return el.namespaceURI&&el.namespaceURI!=='http://www.w3.org/1999/xhtml'
  ?n:n.toLowerCase();}
function rawAttrList(el){return rawAttrs?rawAttrs.call(el):[];}
function rawByName(el,n){
 var name=attrKey(el,n),raw=rawAttrList(el),i;
 for(i=0;i<raw.length;i++)if(raw[i].name===name)return raw[i];
 return null;}
function rawByNS(el,ns,local){
 var raw=rawAttrList(el),i,want=(ns===''||ns===undefined)?null:ns;
 local=String(local);
 for(i=0;i<raw.length;i++)
  if((raw[i].namespace||null)===want&&(raw[i].localName||raw[i].name)===local)
   return raw[i];
 return null;}
/* The one name browsers actually refuse: the empty string. Everything
   else the tests list -- ":", "0:a", "invalid^Name", a backslash -- is
   accepted, so a stricter reading of the Name production would be wrong
   here. */
function checkAttrName(n){
 if(String(n)==='')throw new DOMException(
  'The string contains invalid characters.','InvalidCharacterError');}
(function(){
 var orig=P.setAttribute;
 P.setAttribute=function(n,v){
  needArgs(arguments.length,2,'setAttribute');
  checkAttrName(n);
  return orig.apply(this,arguments);};})();
/* The namespace rules a qualified name has to satisfy before it can be
   set. Without them xmlns:x could be put in any namespace at all, and a
   prefix could be used with none. */
var XML_NS='http://www.w3.org/XML/1998/namespace',
    XMLNS_NS='http://www.w3.org/2000/xmlns/';
/* The XML Name production, relaxed the way browsers relax it: below
   U+00C0 only a letter or an underscore may start a name and only a
   letter, digit, hyphen, stop or underscore may continue it; from
   U+00C0 up everything is allowed. That is what makes "1foo", "-foo",
   ".foo" and "fo o" invalid and "\u0BC6foo" valid. A colon is handled
   by the caller, which splits the prefix off first. */
function nameStartOk(c){
 return (c>=0x61&&c<=0x7a)||(c>=0x41&&c<=0x5a)||c===0x5f||c>=0xc0;}
function namePartOk(c){
 return nameStartOk(c)||(c>=0x30&&c<=0x39)||c===0x2d||c===0x2e||c===0xb7;}
function nameOk(n){
 if(n==='')return false;
 if(!nameStartOk(n.charCodeAt(0)))return false;
 for(var i=1;i<n.length;i++)if(!namePartOk(n.charCodeAt(i)))return false;
 return true;}
function nsExtract(ns,qname,what){
 qname=String(qname);
 ns=(ns===''||ns===null||ns===undefined)?null:String(ns);
 if(qname===''||BAD_NAME.test(qname))throw new DOMException(
  'The string contains invalid characters.','InvalidCharacterError');
 var c=qname.indexOf(':'),prefix=null,local=qname;
 if(c>=0){
  prefix=qname.slice(0,c);local=qname.slice(c+1);
  if(prefix===''||local===''||local.indexOf(':')>=0)throw new DOMException(
   'The string contains invalid characters.','InvalidCharacterError');}
 if(prefix!==null&&ns===null)throw new DOMException(
  'A prefix needs a namespace.','NamespaceError');
 if(prefix==='xml'&&ns!==XML_NS)throw new DOMException(
  'The xml prefix belongs to the XML namespace.','NamespaceError');
 if((qname==='xmlns'||prefix==='xmlns')&&ns!==XMLNS_NS)throw new DOMException(
  'xmlns belongs to the XMLNS namespace.','NamespaceError');
 if(ns===XMLNS_NS&&qname!=='xmlns'&&prefix!=='xmlns')throw new DOMException(
  'The XMLNS namespace needs the xmlns prefix.','NamespaceError');
 return {ns:ns,prefix:prefix,localName:local,qname:qname};}
(function(){
 var orig=P.setAttributeNS;
 P.setAttributeNS=function(ns,qname,value){
  needArgs(arguments.length,3,'setAttributeNS');
  nsExtract(ns,qname,'setAttributeNS');
  return orig.call(this,ns,qname,value);};})();
P.getAttributeNode=function(n){
 var raw=rawByName(this,n);
 return raw?attrNodeFor(this,raw):null;};
P.getAttributeNodeNS=function(ns,n){
 var raw=rawByNS(this,ns,n);
 return raw?attrNodeFor(this,raw):null;};
P.setAttributeNode=function(a){
 if(!a||a.nodeType!==2)throw new TypeError('not an attribute');
 if(a._e&&a._e!==this)
  throw new DOMException('attribute is in use on another element',
                         'InUseAttributeError');
 var ns=a.namespaceURI||null,local=a.localName||a.name,
     raw=rawByNS(this,ns,local),
     old=raw?attrNodeFor(this,raw):null,value=a.value;
 if(old&&old!==a)detachAttr(this,ns,local);
 if(ns===null)this.setAttribute(a.name,value);
 else this.setAttributeNS(ns,a.name,value);
 a._e=this;attrMap(this)[attrKeyOf(ns,local)]=a;
 return old||null;};
P.setAttributeNodeNS=P.setAttributeNode;
P.removeAttributeNode=function(a){
 if(!a||a.nodeType!==2||a._e!==this)
  throw new DOMException('the attribute is not on this element',
                         'NotFoundError');
 var ns=a.namespaceURI||null,local=a.localName||a.name;
 detachAttr(this,ns,local);
 if(ns===null)this.removeAttribute(a.name);
 else this.removeAttributeNS(ns,local);
 return a;};
(function(){
 var origRm=P.removeAttribute,origRmNS=P.removeAttributeNS;
 P.removeAttribute=function(n){
  var raw=rawByName(this,n);
  if(raw)detachAttr(this,raw.namespace||null,raw.localName||raw.name);
  return origRm.apply(this,arguments);};
 P.removeAttributeNS=function(ns,n){
  detachAttr(this,(ns===''||ns===undefined)?null:ns,String(n));
  return origRmNS.apply(this,arguments);};})();
/* --- live collections ---------------------------------------------------
 * getElementsByTagName and friends return a collection that reflects the
 * document as it is now, not as it was when the call was made. Ours were
 * plain arrays taken once, so a page that kept document.forms, or
 * element.children, and looked at it again after changing the tree saw
 * the old answer. The specification is explicit about which are live:
 * getElementsBy*, children, forms, options and the rest are, and
 * querySelectorAll is not.
 *
 * A collection also answers to the id and the name of what it holds, so
 * document.forms.login is the form with that name. Those are properties
 * of the collection, and they come and go with the elements.
 */
function HTMLCollection(){throw new TypeError('Illegal constructor');}
Object.defineProperty(HTMLCollection.prototype,'length',{configurable:true,
 get:function(){return this.__vitaItems().length;}});
HTMLCollection.prototype.item=function(i){
 var a=this.__vitaItems();i=i>>>0;
 return i<a.length?a[i]:null;};
HTMLCollection.prototype.namedItem=function(n){
 var a=this.__vitaItems(),i,name=String(n);
 if(name==='')return null;
 for(i=0;i<a.length;i++)if(a[i].getAttribute&&a[i].getAttribute('id')===name)
  return a[i];
 for(i=0;i<a.length;i++)
  if(a[i].getAttribute&&NAMED_TAGS.indexOf(' '+a[i].tagName+' ')>=0&&
     a[i].getAttribute('name')===name)return a[i];
 return null;};
HTMLCollection.prototype[Symbol.iterator]=function(){
 var a=this.__vitaItems(),i=0;
 return {next:function(){
  return i<a.length?{value:a[i++],done:false}:{value:undefined,done:true};}};};
/* Only these tags answer to their name attribute in a collection. */
var NAMED_TAGS=(' A APPLET AREA EMBED FORM FRAME FRAMESET IFRAME IMG '+
 'OBJECT ');
function indexKey(k){
 if(typeof k!=='string')return -1;
 if(k==='0')return 0;
 if(!/^[1-9][0-9]*$/.test(k))return -1;
 var n=+k;
 return n<=0xfffffffe?n:-1;}
/* The collection is a proxy so that an index or a name is resolved when
   it is read, which is what makes it live. */
function liveCollection(items,proto,shapeOnly){
 var base=Object.create(proto||HTMLCollection.prototype),cache=null,gen=-1,
     now=shapeOnly?treeGen:domGen;
 /* Live, but not by asking again on every read: the answer is kept
    until the C side says the tree changed. A loop over a collection
    reads .length and [i] each step, and each read was a whole-document
    walk before this. */
 function cached(){
  var g=now();
  if(cache===null||g<0||g!==gen){cache=items();gen=g;}
  return cache;}
 Object.defineProperty(base,'__vitaItems',{value:cached,configurable:true});
 return new Proxy(base,{
  get:function(t,k,r){
   var i=indexKey(k),a;
   if(i>=0){a=t.__vitaItems();return i<a.length?a[i]:undefined;}
   if(typeof k==='string'&&!(k in t)&&k!=='__vitaItems'){
    var n=t.namedItem?t.namedItem(k):null;
    if(n)return n;}
   return Reflect.get(t,k,r);},
  has:function(t,k){
   var i=indexKey(k);
   if(i>=0)return i<t.__vitaItems().length;
   if(typeof k==='string'&&t.namedItem&&t.namedItem(k))return true;
   return Reflect.has(t,k);},
  set:function(t,k,v,r){
   /* an index, or a name the collection answers to, is not writable */
   if(indexKey(k)>=0)return false;
   if(typeof k==='string'&&t.namedItem&&t.namedItem(k))return false;
   return Reflect.set(t,k,v,r);},
  deleteProperty:function(t,k){
   if(indexKey(k)>=0)return false;
   if(typeof k==='string'&&t.namedItem&&t.namedItem(k))return false;
   return Reflect.deleteProperty(t,k);},
  defineProperty:function(t,k,d){
   if(indexKey(k)>=0)return false;
   return Reflect.defineProperty(t,k,d);},
  ownKeys:function(t){
   var a=t.__vitaItems(),out=[],seen={},i,n;
   for(i=0;i<a.length;i++)out.push(String(i));
   for(i=0;i<a.length;i++){
    if(!a[i].getAttribute)continue;
    n=a[i].getAttribute('id');
    if(n&&!seen[n]&&indexKey(n)<0){seen[n]=1;out.push(n);}
    if(NAMED_TAGS.indexOf(' '+a[i].tagName+' ')>=0){
     n=a[i].getAttribute('name');
     if(n&&!seen[n]&&indexKey(n)<0){seen[n]=1;out.push(n);}}}
   Reflect.ownKeys(t).forEach(function(k){
    if(typeof k==='string'&&out.indexOf(k)<0&&k!=='__vitaItems')out.push(k);});
   return out;},
  getOwnPropertyDescriptor:function(t,k){
   var i=indexKey(k),a;
   if(i>=0){
    a=t.__vitaItems();
    if(i>=a.length)return undefined;
    return {value:a[i],writable:false,enumerable:true,configurable:true};}
   if(typeof k==='string'&&t.namedItem){
    var n=t.namedItem(k);
    if(n)return {value:n,writable:false,enumerable:false,configurable:true};}
   return Reflect.getOwnPropertyDescriptor(t,k);}});}
/* A NodeList holds anything, answers to no name, and has the iteration
   helpers a collection does not. */
function NodeList(){throw new TypeError('Illegal constructor');}
/* what Object.prototype.toString calls them (VitaSurf) */
Object.defineProperty(HTMLCollection.prototype,Symbol.toStringTag,
 {configurable:true,value:'HTMLCollection'});
Object.defineProperty(NodeList.prototype,Symbol.toStringTag,
 {configurable:true,value:'NodeList'});
Object.defineProperty(NodeList.prototype,'length',{configurable:true,
 get:function(){return this.__vitaItems().length;}});
NodeList.prototype.item=function(i){
 var a=this.__vitaItems();i=i>>>0;
 return i<a.length?a[i]:null;};
NodeList.prototype.forEach=function(f,t){
 var a=this.__vitaItems(),i;
 for(i=0;i<a.length;i++)f.call(t,a[i],i,this);};
NodeList.prototype.keys=function(){
 var a=this.__vitaItems(),i=0;
 return {next:function(){return i<a.length?{value:i++,done:false}
                                          :{value:undefined,done:true};},
  __proto__:null};};
NodeList.prototype.values=function(){return this[Symbol.iterator]();};
NodeList.prototype.entries=function(){
 var a=this.__vitaItems(),i=0;
 return {next:function(){
  return i<a.length?{value:[i,a[i++]],done:false}:{value:undefined,done:true};}};};
NodeList.prototype[Symbol.iterator]=function(){
 var a=this.__vitaItems(),i=0;
 return {next:function(){
  return i<a.length?{value:a[i++],done:false}:{value:undefined,done:true};}};};
/* A form's controls answer to the name of any of them, not only the
   tags a plain collection names. */
function FormControls(){throw new TypeError('Illegal constructor');}
FormControls.prototype=Object.create(HTMLCollection.prototype);
FormControls.prototype.constructor=FormControls;
FormControls.prototype.namedItem=function(n){
 var a=this.__vitaItems(),i,name=String(n);
 if(name==='')return null;
 for(i=0;i<a.length;i++)if(a[i].getAttribute&&a[i].getAttribute('id')===name)
  return a[i];
 for(i=0;i<a.length;i++)if(a[i].getAttribute&&a[i].getAttribute('name')===name)
  return a[i];
 return null;};
function liveNodeList(items){return liveCollection(items,NodeList.prototype);}
/* A collection the code here wants to walk as an array. */
function listOf(c){
 var a=[],i,n;
 if(!c)return a;
 if(Array.isArray(c))return c.slice();
 n=c.length||0;
 for(i=0;i<n;i++)a.push(c[i]);
 return a;}


/* The other collection names. The real one is defined above; these used
   to be a stub whose length was always zero, and it was clobbering it. */
HTMLCollection.prototype.add=function(){};
HTMLCollection.prototype.remove=function(){};
/* HTMLOptionsCollection is the one that is not just another name for
   HTMLCollection: it carries selectedIndex, which belongs to the select
   the collection came from and not to collections in general. */
W.HTMLOptionsCollection=function HTMLOptionsCollection(){};
W.HTMLOptionsCollection.prototype=Object.create(HTMLCollection.prototype);
W.HTMLOptionsCollection.prototype.constructor=W.HTMLOptionsCollection;
Object.defineProperty(W.HTMLOptionsCollection.prototype,'selectedIndex',{
 configurable:true,
 get:function(){var o=this.__vitaOwner;return o?o.selectedIndex:-1;},
 set:function(v){var o=this.__vitaOwner;if(o)o.selectedIndex=v;}});
W.HTMLFormControlsCollection=HTMLCollection;W.HTMLAllCollection=HTMLCollection;

W.closed=false;
W.name=W.name||'';
W.status='';
W.external={AddSearchProvider:function(){},IsSearchProviderInstalled:function(){return false;}};
/* about:blank and about:srcdoc have the origin of the page that made
   them, which for a frame is its parent */
function inheritsOrigin(){
 return /^about:(blank|srcdoc)$/i.test(String(location.href))&&W.parent!==W;}
Object.defineProperty(W,'origin',{configurable:true,get:function(){
 if(inheritsOrigin()){try{return W.parent.origin;}catch(e){return 'null';}}
 try{return new URL(location.href).origin;}catch(e){return 'null';}}});
Object.defineProperty(W,'isSecureContext',{configurable:true,get:function(){
 if(inheritsOrigin()){try{return W.parent.isSecureContext;}catch(e){return false;}}
 return String(location.href).indexOf('https:')===0;}});
W.crossOriginIsolated=false;
W.originAgentCluster=false;
W.clientInformation=navigator;
['screenX','screenLeft'].forEach(function(k){W[k]=0;});
['screenY','screenTop'].forEach(function(k){W[k]=0;});
function BarProp(){this.visible=true;}
W.BarProp=BarProp;
['locationbar','menubar','personalbar','scrollbars','statusbar','toolbar'].forEach(function(k){
 W[k]=new BarProp();});
Object.defineProperty(W,'visualViewport',{configurable:true,get:function(){
 var s=viewport();
 return {offsetLeft:0,offsetTop:0,pageLeft:s[0],pageTop:s[1],width:s[2],height:s[3],
  scale:1,addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;},
  onresize:null,onscroll:null};}});
W.navigation={entries:function(){return [];},currentEntry:null,canGoBack:true,canGoForward:false,
 navigate:function(u){location.href=u;return {committed:Promise.resolve(),finished:Promise.resolve()};},
 back:function(){history.back();},forward:function(){history.forward();},
 addEventListener:function(){},removeEventListener:function(){}};
W.moveBy=W.moveTo=W.resizeBy=W.resizeTo=W.captureEvents=W.releaseEvents=function(){};
W.createImageBitmap=function(s){return Promise.resolve({width:0,height:0,close:function(){}});};
W.fetchLater=function(){return {activated:false};};

history.scrollRestoration='auto';
Object.defineProperty(location,'ancestorOrigins',{configurable:true,get:function(){
 var l=[];l.item=function(i){return this[i]||null;};l.contains=function(){return false;};return l;}});
navigator.appVersion=navigator.userAgent.replace(/^Mozilla\//,'');
navigator.oscpu='';
navigator.productSub='20030107';
navigator.vendorSub='';
navigator.pdfViewerEnabled=false;
navigator.mimeTypes=(function(){var l=[];l.item=function(i){return this[i]||null;};
 l.namedItem=function(){return null;};return l;})();
navigator.plugins=(function(){var l=[];l.item=function(i){return this[i]||null;};
 l.namedItem=function(){return null;};l.refresh=function(){};return l;})();
navigator.userActivation={hasBeenActive:true,isActive:false};
navigator.registerProtocolHandler=navigator.unregisterProtocolHandler=GAP('navigator.registerProtocolHandler');
navigator.taintEnabled=function(){return false;};

/* --- odds and ends the specifications list ------------------------------- */
/* The animation an element hands back: already finished, and now with
 * the members code reads off one. */
(function(){var f=W.Animation&&W.Animation.prototype;if(!f)return;
 f.id='';f.pending=false;f.replaceState='active';f.timeline=D.timeline;f.effect=null;
 f.onremove=null;f.commitStyles=function(){};f.persist=function(){};})();
if(W.AbortSignal&&!W.AbortSignal.any)W.AbortSignal.any=function(sigs){
 var c=new AbortController();
 [].forEach.call(sigs||[],function(s){
  if(s.aborted)c.abort(s.reason);
  else if(s.addEventListener)s.addEventListener('abort',function(){c.abort(s.reason);});});
 return c.signal;};
W.StorageEvent=function(type,init){init=init||{};this.type=type;this.key=init.key||null;
 this.oldValue=init.oldValue===undefined?null:init.oldValue;
 this.newValue=init.newValue===undefined?null:init.newValue;
 this.url=init.url||String(location.href);this.storageArea=init.storageArea||null;
 this.bubbles=!!init.bubbles;this.cancelable=!!init.cancelable;};
W.StorageEvent.prototype.initStorageEvent=function(t,b,c,k,o,n,u,s){this.type=t;this.bubbles=!!b;
 this.cancelable=!!c;this.key=k;this.oldValue=o;this.newValue=n;this.url=u;this.storageArea=s;};

/* --- inline style -------------------------------------------------------
 * style was a stub whose setters did nothing, so a menu that opens itself
 * with el.style.display stayed shut and a script that read the value back
 * saw an empty string. Back it with the element's style attribute
 * instead: setAttribute marks the page dirty, so the change restyles and
 * repaints the way the page expects it to.
 */
function cssName(p){return String(p)
 .replace(/^(webkit|moz|ms|epub)([A-Z])/,function(m,a,b){return '-'+a+'-'+b.toLowerCase();})
 .replace(/[A-Z]/g,function(c){return '-'+c.toLowerCase();});}
/* The declarations of a style text, split at the semicolons outside any
 * string or bracket (VitaSurf): a custom property may hold a block with
 * semicolons of its own. */
function splitDecls(t){
 /* most style text has no bracket, string or escape at all, and a walk
    over every character of it was 2% of a Home Assistant load's script
    time; the rest is searched from one special character to the next */
 if(!/[(\[{"'\\]/.test(t))return t.split(';');
 var out=[],st=0,depth=0,q='',re=/[;()[\]{}"'\\]/g,m,c;
 while((m=re.exec(t))){
  c=m[0];
  if(q){
   if(c==='\\')re.lastIndex++;
   else if(c===q)q='';
   continue;}
  if(c==='"'||c==="'")q=c;
  else if(c==='\\')re.lastIndex++;
  else if(c==='('||c==='['||c==='{')depth++;
  else if(c===';'){if(depth===0){out.push(t.slice(st,m.index));st=m.index+1;}}
  else if(depth>0)depth--;}
 out.push(t.slice(st));
 return out;}
/* A value as the style attribute can hold it (VitaSurf). A value set
 * through the CSSOM is parsed on its own, where the end closes whatever
 * it left open; the attribute holds every declaration in one text, and
 * there a bracket or string left open runs on over all the ones after
 * it. Home Assistant's dark theme sets a variable cut off at
 * "@layer wa-utilities{@supports (scrollbar-gutter", and the hundred
 * theme colours after it, the dark backgrounds among them, were lost.
 * So what is open is closed. A closing bracket with nothing open makes
 * the value invalid, and null is returned, as a browser drops it. */
function closeValue(v){
 var stack=[],q='',i,c,k;
 for(i=0;i<v.length;i++){
  c=v.charAt(i);
  if(q){if(c==='\\')i++;else if(c===q)q='';continue;}
  if(c==='"'||c==="'")q=c;
  else if(c==='\\')i++;
  else if(c==='(')stack.push(')');
  else if(c==='[')stack.push(']');
  else if(c==='{')stack.push('}');
  else if(c===')'||c===']'||c==='}'){
   if(!stack.length||stack[stack.length-1]!==c)return null;
   stack.pop();}}
 if(!q&&!stack.length)return v;
 if(q)v+=q;
 for(k=stack.length-1;k>=0;k--)v+=stack[k];
 return v;}
function parseDecl(t){var out=[];
 splitDecls(String(t||'')).forEach(function(d){
  var i=d.indexOf(':');if(i<0)return;
  var n=d.slice(0,i).trim().toLowerCase(),v=d.slice(i+1).trim(),pr='';
  if(!n||!v)return;
  if(/!\s*important$/i.test(v)){pr='important';v=v.replace(/!\s*important$/i,'').trim();}
  out.push([n,v,pr]);});
 return out;}
function serialDecl(list){return list.map(function(d){
 return declText(d);}).join(' ');}
function CSSStyleDeclaration(el){this._e=el;}
/* The parsed style attribute of each element, while the attribute still
 * reads the same. Home Assistant's theme sets some 600 variables on one
 * element through setProperty, and parsing and writing the whole
 * attribute for each of them took 14 s on the Vita. */
var STYLE_PARSED=new WeakMap();
function styleOf(e){
 var s=e.getAttribute('style')||'',c=STYLE_PARSED.get(e);
 if(c&&c.s===s)return c;
 var l=parseDecl(s),ix=new Map(),i;
 for(i=0;i<l.length;i++)ix.set(l[i][0],i);
 c={s:s,l:l,ix:ix};STYLE_PARSED.set(e,c);return c;}
function declText(d){var v=closeValue(d[1]);
 return d[0]+': '+(v===null?d[1]:v)+(d[2]?' !'+d[2]:'')+';';}
CSSStyleDeclaration.prototype._d=function(){
 return this._e?styleOf(this._e).l:(this._own||(this._own=[]));};
CSSStyleDeclaration.prototype._w=function(list){
 if(this._e)this._e.setAttribute('style',serialDecl(list));else this._own=list;};
CSSStyleDeclaration.prototype._find=function(n){
 if(this._e){var c=styleOf(this._e),i=c.ix.get(n);return i===undefined?null:c.l[i];}
 var d=this._d();
 for(var j=d.length-1;j>=0;j--)if(d[j][0]===n)return d[j];
 return null;};
CSSStyleDeclaration.prototype.getPropertyValue=function(n){
 var d=this._find(cssName(n));return d?d[1]:'';};
CSSStyleDeclaration.prototype.getPropertyPriority=function(n){
 var d=this._find(cssName(n));return d?d[2]:'';};
CSSStyleDeclaration.prototype.setProperty=function(n,v,pr){
 n=cssName(n);
 if(v===''||v===null||v===undefined)return this.removeProperty(n);
 var d=[n,String(v),pr||''];
 if(closeValue(d[1])===null)return;
 if(!this._e){
  var own=this._d(),i;
  for(i=0;i<own.length;i++)if(own[i][0]===n){own[i]=d;return;}
  own.push(d);return;}
 var e=this._e,c=styleOf(e),at=c.ix.get(n),s;
 if(at===undefined){
  /* a new one goes on the end, so the rest need not be written again */
  /* not /\s+$/: that tries every space in 30 KB of attribute */
  s=c.s;var k=s.length;
  while(k>0&&s.charCodeAt(k-1)<=32)k--;
  if(k<s.length)s=s.slice(0,k);
  if(s&&s.charAt(s.length-1)!==';')s+=';';
  s+=(s?' ':'')+declText(d);
  e.setAttribute('style',s);
  c.l.push(d);c.ix.set(n,c.l.length-1);c.s=s;
  return;}
 /* the value it has already: nothing is written, as the CSSOM says, and
    a theme put back on an element does not write out its 600 variables
    once for each of them */
 if(c.l[at][1]===d[1]&&c.l[at][2]===d[2])return;
 c.l[at]=d;
 s=serialDecl(c.l);
 e.setAttribute('style',s);c.s=s;};
CSSStyleDeclaration.prototype.removeProperty=function(n){
 n=cssName(n);var old=this.getPropertyValue(n);
 if(this._find(n))this._w(this._d().filter(function(x){return x[0]!==n;}));
 return old;};
CSSStyleDeclaration.prototype.item=function(i){var d=this._d();return d[i]?d[i][0]:'';};
Object.defineProperty(CSSStyleDeclaration.prototype,'length',{configurable:true,
 get:function(){return this._d().length;}});
Object.defineProperty(CSSStyleDeclaration.prototype,'cssText',{configurable:true,
 get:function(){return this._e?(this._e.getAttribute('style')||''):serialDecl(this._d());},
 set:function(v){this._w(parseDecl(v));}});
Object.defineProperty(CSSStyleDeclaration.prototype,'parentRule',{configurable:true,
 get:function(){return null;}});
CSSStyleDeclaration.prototype.toString=function(){return this.cssText;};
/* The camel-cased property names. Anything outside this list still works
 * through setProperty, which is what libraries that set unusual
 * properties use anyway. */
('align-content align-items align-self all animation animation-delay animation-direction '+
 'animation-duration animation-fill-mode animation-iteration-count animation-name '+
 'animation-play-state animation-timing-function appearance aspect-ratio backdrop-filter '+
 'backface-visibility background background-attachment background-clip background-color '+
 'background-image background-origin background-position background-repeat background-size '+
 'block-size border border-bottom border-bottom-color border-bottom-left-radius '+
 'border-bottom-right-radius border-bottom-style border-bottom-width border-collapse '+
 'border-color border-left border-left-color border-left-style border-left-width '+
 'border-radius border-right border-right-color border-right-style border-right-width '+
 'border-spacing border-style border-top border-top-color border-top-left-radius '+
 'border-top-right-radius border-top-style border-top-width border-width bottom box-shadow '+
 'box-sizing caption-side caret-color clear clip clip-path color column-count column-gap '+
 'columns content cursor direction display empty-cells filter flex flex-basis flex-direction '+
 'flex-flow flex-grow flex-shrink flex-wrap float font font-family font-size font-style '+
 'font-variant font-weight gap grid grid-area grid-auto-columns grid-auto-flow grid-auto-rows '+
 'grid-column grid-column-end grid-column-start grid-gap grid-row grid-row-end grid-row-start '+
 'grid-template grid-template-areas grid-template-columns grid-template-rows height inline-size '+
 'inset isolation justify-content justify-items justify-self left letter-spacing line-height '+
 'list-style list-style-image list-style-position list-style-type margin margin-bottom '+
 'margin-left margin-right margin-top mask max-height max-width min-height min-width '+
 'mix-blend-mode object-fit object-position opacity order outline outline-color outline-offset '+
 'outline-style outline-width overflow overflow-wrap overflow-x overflow-y padding '+
 'padding-bottom padding-left padding-right padding-top page-break-after page-break-before '+
 'perspective place-content place-items place-self pointer-events position quotes resize right '+
 'row-gap scroll-behavior scroll-margin scroll-padding table-layout text-align text-decoration '+
 'text-decoration-color text-decoration-line text-indent text-overflow text-shadow '+
 'text-transform top touch-action transform transform-origin transition transition-delay '+
 'transition-duration transition-property transition-timing-function unicode-bidi user-select '+
 'vertical-align visibility white-space width will-change word-break word-spacing word-wrap '+
 'writing-mode z-index zoom').split(' ').forEach(function(n){
 var camel=n.replace(/-([a-z])/g,function(_,c){return c.toUpperCase();});
 Object.defineProperty(CSSStyleDeclaration.prototype,camel,{configurable:true,enumerable:true,
  get:function(){return this.getPropertyValue(n);},
  set:function(v){this.setProperty(n,v);}});
 if(camel!==n)Object.defineProperty(CSSStyleDeclaration.prototype,n,{configurable:true,
  get:function(){return this.getPropertyValue(n);},
  set:function(v){this.setProperty(n,v);}});});
Object.defineProperty(CSSStyleDeclaration.prototype,'cssFloat',{configurable:true,
 get:function(){return this.getPropertyValue('float');},
 set:function(v){this.setProperty('float',v);}});
['webkitTransform','webkitTransition','webkitTransform','webkitUserSelect','webkitAppearance',
 'webkitBoxShadow','webkitFlex','webkitBorderRadius','webkitAnimation','webkitFilter','webkitBackfaceVisibility']
 .forEach(function(camel){var n=cssName(camel);
  Object.defineProperty(CSSStyleDeclaration.prototype,camel,{configurable:true,
   get:function(){return this.getPropertyValue(n)||this.getPropertyValue(n.slice(8));},
   set:function(v){this.setProperty(n.slice(8),v);}});});
W.CSSStyleDeclaration=CSSStyleDeclaration;
/* No caching: the state is the attribute, so a fresh declaration reads
 * and writes the same thing as one held from an earlier access. */
Object.defineProperty(P,'style',{configurable:true,
 get:function(){return new CSSStyleDeclaration(this);},
 set:function(v){this.setAttribute('style',String(v));}});

/* --- the style sheet interfaces ----------------------------------------- */
/* A sheet's rules as script sees them (VitaSurf). The rules are read from
 * the sheet's text when first asked for; insertRule(), deleteRule(),
 * replaceSync() and a rule's style change that list, and the list is
 * written back to the engine as text once the task that changed it ends,
 * so a library adding a thousand rules one at a time costs one parse.
 * Emotion, which MUI uses, and styled-components in production style a
 * page this way and nothing else: with insertRule doing nothing, those
 * pages had no styles at all. */
function cssStrip(t){
 /* comments out, strings kept */
 var o='',i=0,n=t.length;
 while(i<n){var c=t.charCodeAt(i);
  if(c===47&&t.charCodeAt(i+1)===42){var e=t.indexOf('*/',i+2);i=e<0?n:e+2;continue;}
  if(c===34||c===39){var s=i++;while(i<n&&t.charCodeAt(i)!==c){if(t.charCodeAt(i)===92)i++;i++;}
   o+=t.slice(s,++i);continue;}
  o+=t.charAt(i++);}
 return o;}
function cssSplit(t){
 /* the top-level rules of a sheet or a block, as text */
 var out=[],i=0,n=t.length,start=0,depth=0;
 while(i<n){var c=t.charCodeAt(i);
  if(c===34||c===39){i++;while(i<n&&t.charCodeAt(i)!==c){if(t.charCodeAt(i)===92)i++;i++;}i++;continue;}
  if(c===123)depth++;
  else if(c===125){if(depth>0)depth--;if(depth===0){var r=t.slice(start,i+1).trim();if(r)out.push(r);start=i+1;}}
  else if(c===59&&depth===0){var st=t.slice(start,i+1).trim();if(st.length>1)out.push(st);start=i+1;}
  i++;}
 return out;}
function cssDecls(body){
 /* declarations in order: [name, value, important] */
 var out=[],parts=[],i=0,n=body.length,start=0,depth=0;
 while(i<n){var c=body.charCodeAt(i);
  if(c===34||c===39){i++;while(i<n&&body.charCodeAt(i)!==c){if(body.charCodeAt(i)===92)i++;i++;}i++;continue;}
  if(c===40||c===123||c===91)depth++;else if(c===41||c===125||c===93)depth--;
  else if(c===59&&depth===0){parts.push(body.slice(start,i));start=i+1;}
  i++;}
 parts.push(body.slice(start));
 parts.forEach(function(p){var k=p.indexOf(':');if(k<0)return;
  var name=p.slice(0,k).trim(),v=p.slice(k+1).trim(),imp=false;
  if(!name)return;
  var m=/!\s*important\s*$/i.exec(v);if(m){imp=true;v=v.slice(0,m.index).trim();}
  if(name.slice(0,2)!=='--')name=name.toLowerCase();
  out.push([name,v,imp]);});
 return out;}
function camelToDash(p){return p==='cssFloat'?'float':p.replace(/[A-Z]/g,function(c){return '-'+c.toLowerCase();}).replace(/^(webkit|moz|ms)-/,'-$1-');}
function RuleStyle(rule,body){this._rule=rule;this._d=cssDecls(body||'');}
RuleStyle.prototype.getPropertyValue=function(p){p=String(p);
 for(var i=this._d.length-1;i>=0;i--)if(this._d[i][0]===p||this._d[i][0]===p.toLowerCase())return this._d[i][1];return '';};
RuleStyle.prototype.getPropertyPriority=function(p){
 for(var i=this._d.length-1;i>=0;i--)if(this._d[i][0]===String(p))return this._d[i][2]?'important':'';return '';};
RuleStyle.prototype.setProperty=function(p,v,pri){p=String(p);if(p.slice(0,2)!=='--')p=p.toLowerCase();
 v=v==null?'':String(v);
 if(v===''){this.removeProperty(p);return;}
 var imp=String(pri||'').toLowerCase()==='important';
 for(var i=0;i<this._d.length;i++)if(this._d[i][0]===p){this._d[i][1]=v;this._d[i][2]=imp;sheetDirty(this._rule);return;}
 this._d.push([p,v,imp]);sheetDirty(this._rule);};
RuleStyle.prototype.removeProperty=function(p){p=String(p);var old=this.getPropertyValue(p);
 var before=this._d.length;this._d=this._d.filter(function(d){return d[0]!==p;});
 if(this._d.length!==before)sheetDirty(this._rule);return old;};
RuleStyle.prototype.item=function(i){return this._d[i]?this._d[i][0]:'';};
Object.defineProperty(RuleStyle.prototype,'length',{configurable:true,get:function(){return this._d.length;}});
Object.defineProperty(RuleStyle.prototype,'cssText',{configurable:true,
 get:function(){return this._d.map(function(d){return d[0]+': '+d[1]+(d[2]?' !important':'')+';';}).join(' ');},
 set:function(v){this._d=cssDecls(String(v));sheetDirty(this._rule);}});
Object.defineProperty(RuleStyle.prototype,'parentRule',{configurable:true,get:function(){return this._rule;}});
function ruleStyleProxy(rs){
 /* style.color = 'red' on a rule, as on an element */
 return new Proxy(rs,{get:function(t,k){if(typeof k==='string'&&!(k in t)&&/^[a-zA-Z]+$/.test(k))return t.getPropertyValue(camelToDash(k));return t[k];},
  set:function(t,k,v){if(typeof k==='string'&&!(k in t)&&/^[a-zA-Z]+$/.test(k)){t.setProperty(camelToDash(k),v);return true;}t[k]=v;return true;}});}
function CSSRule(){this.parentRule=null;this.parentStyleSheet=null;}
CSSRule.STYLE_RULE=1;CSSRule.CHARSET_RULE=2;CSSRule.IMPORT_RULE=3;CSSRule.MEDIA_RULE=4;
CSSRule.FONT_FACE_RULE=5;CSSRule.PAGE_RULE=6;CSSRule.KEYFRAMES_RULE=7;CSSRule.KEYFRAME_RULE=8;
CSSRule.NAMESPACE_RULE=10;CSSRule.SUPPORTS_RULE=12;
['STYLE_RULE','CHARSET_RULE','IMPORT_RULE','MEDIA_RULE','FONT_FACE_RULE','PAGE_RULE','KEYFRAMES_RULE',
 'KEYFRAME_RULE','NAMESPACE_RULE','SUPPORTS_RULE'].forEach(function(k){CSSRule.prototype[k]=CSSRule[k];});
function CSSStyleRule(){CSSRule.call(this);}
CSSStyleRule.prototype=Object.create(CSSRule.prototype);CSSStyleRule.prototype.constructor=CSSStyleRule;
CSSStyleRule.prototype.type=1;
Object.defineProperty(CSSStyleRule.prototype,'cssText',{configurable:true,get:function(){
 var b=this.style.cssText;return this.selectorText+' {'+(b?' '+b+' ':' ')+'}';}});
function CSSGroupingRule(){CSSRule.call(this);}
CSSGroupingRule.prototype=Object.create(CSSRule.prototype);CSSGroupingRule.prototype.constructor=CSSGroupingRule;
CSSGroupingRule.prototype.insertRule=function(text,index){return rulesInsert(this.cssRules,this.parentStyleSheet,this,text,index);};
CSSGroupingRule.prototype.deleteRule=function(index){rulesDelete(this.cssRules,index);sheetDirty(this);};
Object.defineProperty(CSSGroupingRule.prototype,'cssText',{configurable:true,get:function(){
 return this._head+' {\n'+this.cssRules.map(function(r){return '  '+r.cssText;}).join('\n')+'\n}';}});
function CSSMediaRule(){CSSGroupingRule.call(this);}
CSSMediaRule.prototype=Object.create(CSSGroupingRule.prototype);CSSMediaRule.prototype.constructor=CSSMediaRule;
CSSMediaRule.prototype.type=4;
function CSSSupportsRule(){CSSGroupingRule.call(this);}
CSSSupportsRule.prototype=Object.create(CSSGroupingRule.prototype);CSSSupportsRule.prototype.constructor=CSSSupportsRule;
CSSSupportsRule.prototype.type=12;
function CSSOtherRule(){CSSRule.call(this);}
CSSOtherRule.prototype=Object.create(CSSRule.prototype);
Object.defineProperty(CSSOtherRule.prototype,'cssText',{configurable:true,get:function(){return this._text;}});
function CSSKeyframesRule(){CSSRule.call(this);}
CSSKeyframesRule.prototype=Object.create(CSSOtherRule.prototype);CSSKeyframesRule.prototype.type=7;
function CSSFontFaceRule(){CSSRule.call(this);}
CSSFontFaceRule.prototype=Object.create(CSSRule.prototype);CSSFontFaceRule.prototype.type=5;
Object.defineProperty(CSSFontFaceRule.prototype,'cssText',{configurable:true,get:function(){
 return '@font-face { '+this.style.cssText+' }';}});
function CSSImportRule(){CSSRule.call(this);}
CSSImportRule.prototype=Object.create(CSSOtherRule.prototype);CSSImportRule.prototype.type=3;
function makeRule(text,sheet,parent){
 var t=String(text).trim(),r,brace=t.indexOf('{');
 if(t.charAt(0)==='@'){
  var m=/^@(-?[\w-]+)/.exec(t),name=m?m[1].toLowerCase():'';
  var head=(brace<0?t.replace(/;\s*$/,''):t.slice(0,brace)).trim();
  var cond=head.slice(name.length+1).trim();
  if(brace>=0&&(name==='media'||name==='supports'||name==='container'||name==='layer'||name==='scope'||name==='document'||name==='starting-style')){
   r=name==='media'?new CSSMediaRule():name==='supports'?new CSSSupportsRule():new CSSGroupingRule();
   r._head=head;r.conditionText=cond;if(name==='media')r.media=new MediaList(cond);
   if(name==='layer')r.name=cond;
   r.parentStyleSheet=sheet;r.parentRule=parent;
   r.cssRules=cssSplit(t.slice(brace+1,t.lastIndexOf('}'))).map(function(x){return makeRule(x,sheet,r);});
   return r;}
  if(name==='font-face'&&brace>=0){r=new CSSFontFaceRule();
   r.style=ruleStyleProxy(new RuleStyle(r,t.slice(brace+1,t.lastIndexOf('}'))));}
  else if(/keyframes$/.test(name)){r=new CSSKeyframesRule();r.name=cond;}
  else if(name==='import'){r=new CSSImportRule();
   var h=/url\(\s*['"]?([^'")]*)['"]?\s*\)|['"]([^'"]*)['"]/.exec(cond);r.href=h?(h[1]||h[2]||''):'';}
  else{r=new CSSOtherRule();r.type=0;}
  r._text=t;r.parentStyleSheet=sheet;r.parentRule=parent;return r;}
 r=new CSSStyleRule();r.parentStyleSheet=sheet;r.parentRule=parent;
 r.selectorText=brace<0?t:t.slice(0,brace).trim();
 r.style=ruleStyleProxy(new RuleStyle(r,brace<0?'':t.slice(brace+1,t.lastIndexOf('}'))));
 return r;}
function rulesInsert(list,sheet,parent,text,index){
 index=index===undefined?0:index>>>0;
 if(index>list.length)throw new DOMException("Failed to execute 'insertRule' on 'CSSStyleSheet': The index provided ("+index+
  ") is larger than the maximum index ("+list.length+").",'IndexSizeError');
 var parts=cssSplit(cssStrip(String(text)));
 if(parts.length!==1)throw new DOMException("Failed to execute 'insertRule' on 'CSSStyleSheet': Failed to parse the rule '"+text+"'.",'SyntaxError');
 list.splice(index,0,makeRule(parts[0],sheet,parent));
 sheetDirty(parent||sheet);
 return index;}
function rulesDelete(list,index){index=index>>>0;
 if(index>=list.length)throw new DOMException("Failed to execute 'deleteRule' on 'CSSStyleSheet': The index provided ("+index+
  ") is outside the range [0, "+list.length+").",'IndexSizeError');
 list.splice(index,1);}
function MediaList(t){this._m=t?String(t).split(',').map(function(x){return x.trim();}).filter(Boolean):[];}
Object.defineProperty(MediaList.prototype,'mediaText',{configurable:true,
 get:function(){return this._m.join(', ');},set:function(v){this._m=String(v).split(',').map(function(x){return x.trim();}).filter(Boolean);}});
Object.defineProperty(MediaList.prototype,'length',{configurable:true,get:function(){return this._m.length;}});
MediaList.prototype.item=function(i){return this._m[i]===undefined?null:this._m[i];};
MediaList.prototype.appendMedium=function(m){this._m.push(String(m));};
MediaList.prototype.deleteMedium=function(m){this._m=this._m.filter(function(x){return x!==m;});};
MediaList.prototype.toString=function(){return this.mediaText;};
var SHEET_NEW={};
function CSSStyleSheet(opts){
 /* new CSSStyleSheet() makes a constructed sheet; an element's sheet is
    made with SHEET_NEW and its owner */
 var owner=opts===SHEET_NEW?arguments[1]:null;
 this.ownerNode=owner;this.ownerRule=null;this.parentStyleSheet=null;
 this.disabled=false;this.type='text/css';
 this.href=owner&&owner.tagName==='LINK'?owner.href:null;this.title=owner?owner.title||null:null;
 this.media=new MediaList(owner?owner.getAttribute('media'):(opts&&opts.media)||'');
 this._constructed=!owner;this._rules=owner?null:[];this._src=null;this._adopters=[];}
Object.defineProperty(CSSStyleSheet.prototype,'cssRules',{configurable:true,get:function(){
 var o=this.ownerNode;
 if(o&&o.tagName==='STYLE'){var t=o.textContent||'';
  /* the element's text, unless script has changed the rules since it
     was last read, and then only until the text itself changes */
  if(this._rules===null||t!==this._src){this._src=t;
   this._rules=cssSplit(cssStrip(t)).map(function(x){return makeRule(x,this,null);},this);}}
 else if(this._rules===null)this._rules=[];
 return this._rules;}});
Object.defineProperty(CSSStyleSheet.prototype,'rules',{configurable:true,get:function(){return this.cssRules;}});
CSSStyleSheet.prototype.insertRule=function(text,index){return rulesInsert(this.cssRules,this,null,text,index);};
CSSStyleSheet.prototype.deleteRule=function(index){rulesDelete(this.cssRules,index);sheetDirty(this);};
CSSStyleSheet.prototype.addRule=function(sel,style,index){
 this.insertRule(sel+' { '+(style||'')+' }',index===undefined?this.cssRules.length:index);return -1;};
CSSStyleSheet.prototype.removeRule=function(index){this.deleteRule(index===undefined?0:index);};
CSSStyleSheet.prototype.replaceSync=function(text){
 if(!this._constructed)throw new DOMException("Failed to execute 'replaceSync' on 'CSSStyleSheet': Can't call replaceSync on non-constructed CSSStyleSheets.",'NotAllowedError');
 /* @import is not allowed in a constructed sheet and is dropped */
 this._rules=cssSplit(cssStrip(String(text))).filter(function(x){return !/^@import\b/i.test(x);})
  .map(function(x){return makeRule(x,this,null);},this);
 sheetDirty(this);};
CSSStyleSheet.prototype.replace=function(text){var s=this;
 try{s.replaceSync(text);}catch(e){return Promise.reject(e);}
 return Promise.resolve(s);};
CSSStyleSheet.prototype._text=function(){
 return this.disabled?'':this.cssRules.map(function(r){return r.cssText;}).join('\n');};
var sheetsDirty=[],sheetsFlush=false;
function sheetDirty(r){
 /* a rule or a sheet: find the sheet and write it back soon */
 var s=r;while(s&&!(s instanceof CSSStyleSheet))s=s.parentStyleSheet||null;
 if(!s)return;
 if(s.ownerNode&&s.ownerNode.tagName==='STYLE')s._src=s.ownerNode.textContent||'';
 if(sheetsDirty.indexOf(s)<0)sheetsDirty.push(s);
 if(!sheetsFlush){sheetsFlush=true;Promise.resolve().then(sheetsWrite);}}
function sheetsWrite(){
 var list=sheetsDirty,seen=[];sheetsDirty=[];sheetsFlush=false;
 list.forEach(function(s){
  if(s.ownerNode&&s.ownerNode.tagName==='STYLE'&&W.__vitaSetSheetText)
   try{W.__vitaSetSheetText(s.ownerNode,s._text());}catch(e){}
  s._adopters.forEach(function(a){if(seen.indexOf(a)<0){seen.push(a);adoptWrite(a);}});});}
var sheetOf=new WeakMap();
function elementSheet(el){
 var s=sheetOf.get(el);
 if(!s){s=new CSSStyleSheet(SHEET_NEW,el);sheetOf.set(el,s);}
 return s;}
W.CSSRule=CSSRule;W.CSSStyleRule=CSSStyleRule;W.CSSGroupingRule=CSSGroupingRule;
W.CSSMediaRule=CSSMediaRule;W.CSSSupportsRule=CSSSupportsRule;W.CSSKeyframesRule=CSSKeyframesRule;
W.CSSFontFaceRule=CSSFontFaceRule;W.CSSImportRule=CSSImportRule;W.MediaList=MediaList;
W.CSSStyleSheet=CSSStyleSheet;W.StyleSheet=CSSStyleSheet;
W.CSSRuleList=W.CSSRuleList||function CSSRuleList(){};
/* connected, in the document's own tree or a shadow tree in it */
function inDoc(n){for(;n;n=n.parentNode||shadowHost(n))if(n===D)return true;return false;}
Object.defineProperty(D,'styleSheets',{configurable:true,get:function(){
 var l=D.querySelectorAll('style,link[rel~="stylesheet"]').map(elementSheet);
 l.item=function(i){return this[i]||null;};
 return l;}});
Object.defineProperty(P,'sheet',{configurable:true,get:function(){
 var t=this.tagName;
 if(t!=='STYLE'&&t!=='LINK')return undefined;
 if(t==='LINK'&&!/(^|\s)stylesheet(\s|$)/i.test(this.getAttribute('rel')||''))return null;
 return inDoc(this)?elementSheet(this):null;}});
/* adoptedStyleSheets (VitaSurf): the document's are one sheet the engine
   reads from a <style> that is never put in the document; a shadow
   root's are a <style> inside it, which is scoped as its own are. */
var adoptedOf=new WeakMap(),adoptEl=new WeakMap();
function adoptWrite(target){
 var list=adoptedOf.get(target)||[],text=list.map(function(s){return s._text();}).join('\n');
 var el=adoptEl.get(target);
 if(target===D){
  /* marked so the engine keeps it in the cascade though it is not
     in the document, as no other <style> out of it is */
  if(!el){el=D.createElement('style');el.setAttribute('data-adopted','document');adoptEl.set(target,el);}
  if(W.__vitaSetSheetText)try{W.__vitaSetSheetText(el,text);}catch(e){}
 }else{
  if(!el){el=D.createElement('style');el.setAttribute('data-adopted','');adoptEl.set(target,el);}
  el.textContent=text;
  if(el.parentNode!==target)try{target.appendChild(el);}catch(e){}}}
function adoptedAccessor(){return {configurable:true,
 get:function(){return (adoptedOf.get(this)||[]).slice();},
 set:function(v){var self=this,list=Array.prototype.slice.call(v||[]);
  list.forEach(function(s){if(!(s instanceof CSSStyleSheet)||!s._constructed)
   throw new TypeError("Failed to set the 'adoptedStyleSheets' property: Can't adopt non-constructed stylesheets.");});
  (adoptedOf.get(self)||[]).forEach(function(s){var i=s._adopters.indexOf(self);if(i>=0)s._adopters.splice(i,1);});
  list.forEach(function(s){if(s._adopters.indexOf(self)<0)s._adopters.push(self);});
  adoptedOf.set(self,list);adoptWrite(self);}};}
Object.defineProperty(D,'adoptedStyleSheets',adoptedAccessor());

/* --- attributes as a NamedNodeMap --------------------------------------- */
/* Not an array: the map's own properties are the indices and the
   attribute names, and nothing else, which is what code that walks it
   with getOwnPropertyNames expects to see. */
var NNM_OWNER=Symbol('ownerElement'),NNM_LEN=Symbol('length');
function NamedNodeMap(el){
 /* under a symbol: getOwnPropertyNames must show the indices and the
    attribute names and nothing else */
 this[NNM_OWNER]=el;}
/* The count is kept when the map is filled: counting own properties on
   every read made a for-of or Array.from over the map quadratic, and
   Alpine does that for every element it starts. */
Object.defineProperty(NamedNodeMap.prototype,'length',{configurable:true,
 get:function(){var n=this[NNM_LEN];if(n!==undefined)return n;
  n=0;while(Object.prototype.hasOwnProperty.call(this,n))n++;
  return n;}});
NamedNodeMap.prototype.item=function(i){
 i=i>>>0;return Object.prototype.hasOwnProperty.call(this,i)?this[i]:null;};
NamedNodeMap.prototype.getNamedItem=function(n){
 var el=this[NNM_OWNER];return el?el.getAttributeNode(n):null;};
NamedNodeMap.prototype.getNamedItemNS=function(ns,n){
 return this.getNamedItem(n);};
NamedNodeMap.prototype.setNamedItem=function(a){
 var el=this[NNM_OWNER];return el?el.setAttributeNode(a):null;};
NamedNodeMap.prototype.setNamedItemNS=NamedNodeMap.prototype.setNamedItem;
NamedNodeMap.prototype.removeNamedItem=function(n){
 var a=this.getNamedItem(n);
 if(!a)throw new DOMException('no such attribute','NotFoundError');
 return this[NNM_OWNER].removeAttributeNode(a);};
NamedNodeMap.prototype.removeNamedItemNS=function(ns,n){
 return this.removeNamedItem(n);};
/* An array-like's own iterator, which is what a browser gives the map,
   and native: Array.from(el.attributes) is how Alpine starts on every
   element, and the closure made two calls and an object per step. */
NamedNodeMap.prototype[Symbol.iterator]=Array.prototype.values;
W.NamedNodeMap=NamedNodeMap;
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'attributes');
 if(!d||!d.get)return;
 rawAttrs=d.get;
 Object.defineProperty(P,'attributes',{configurable:true,get:function(){
  var el=this,g=domGen(),c=el.__vitaAttrMap,
      st=el.__vitaAttrStamp?el.__vitaAttrStamp():-1,
      raw,map,i,a;
  /* The same map while nothing has written this element's attributes
     since (VitaSurf): el.attributes===el.attributes, as in a browser,
     and a page that reads it twice builds it once. It used to go stale
     on any change to the document, and Alpine, which writes attributes
     as it walks, had every element's map built again on each read. */
  if(c&&st>=0&&c.s===st)return c.m;
  raw=d.get.call(this);map=new NamedNodeMap(el);
  /* The C side hands back plain name-and-value pairs; an attribute is a
     node, and code reads nodeValue, ownerElement and localName off one. */
  for(i=0;i<raw.length;i++){
   a=attrNodeFor(el,raw[i],g);
   Object.defineProperty(map,i,{value:a,enumerable:true,configurable:true});
   if(!Object.prototype.hasOwnProperty.call(map,a.name))
    Object.defineProperty(map,a.name,
     {value:a,enumerable:false,configurable:true});}
  map[NNM_LEN]=raw.length;
  if(st>=0){
   if(c){c.s=st;c.m=map;}
   else Object.defineProperty(el,'__vitaAttrMap',
    {value:{s:st,m:map},configurable:true});}
  return map;}});
})();

/* --- the event interfaces, with the fields their handlers read ----------
 * A handler that reads e.deltaY, e.touches or e.data off an event that
 * has none of them throws inside the page's own listener.
 */
/* The fields an interface declares, and every one its parents declare:
   a FocusEvent has relatedTarget of its own and view and detail from
   UIEvent, and code that reads e.detail on one used to get undefined.
   The dictionary is flattened once, when the class is made. */
var EVENT_FIELDS={};
function eventClass(name,fields,base){
 var all={},k;
 if(base&&base.__vitaFields)
  for(k in base.__vitaFields)all[k]=base.__vitaFields[k];
 for(k in fields)all[k]=fields[k];
 var C=function(type,init){
  init=(init===undefined||init===null)?{}:init;
  ownTrust(this);
  this.type=String(type);
  this.bubbles=!!init.bubbles;this.cancelable=!!init.cancelable;
  Object.defineProperty(this,'__vsComposed',{configurable:true,value:!!init.composed});
  this.defaultPrevented=false;this.target=init.target||null;this.currentTarget=null;
  Object.keys(all).forEach(function(kk){
   this[kk]=init[kk]!==undefined?init[kk]:all[kk];},this);};
 C.prototype=Object.create((base||Event).prototype);
 C.prototype.constructor=C;
 /* what Object.prototype.toString calls it, as a browser's are named */
 Object.defineProperty(C.prototype,Symbol.toStringTag,{configurable:true,value:name});
 C.__vitaFields=all;
 EVENT_FIELDS[name]=all;
 W[name]=C;
 return C;}
eventClass('ErrorEvent',{message:'',filename:'',lineno:0,colno:0,error:null});
eventClass('ProgressEvent',{lengthComputable:false,loaded:0,total:0});
eventClass('MessageEvent',{data:null,origin:'',lastEventId:'',source:null,ports:[]})
 .prototype.initMessageEvent=function(t,b,c,d,o,l,s,p){this.type=t;this.bubbles=!!b;
  this.cancelable=!!c;this.data=d;this.origin=o||'';this.lastEventId=l||'';
  this.source=s||null;this.ports=p||[];};
eventClass('InputEvent',{data:null,inputType:'',isComposing:false},W.UIEvent);
eventClass('CompositionEvent',{data:''},W.UIEvent);
eventClass('ToggleEvent',{oldState:'closed',newState:'open',source:null});
eventClass('WheelEvent',{deltaX:0,deltaY:0,deltaZ:0,deltaMode:0,momentum:false},W.MouseEvent);
eventClass('DragEvent',{dataTransfer:null},W.MouseEvent);
eventClass('PopStateEvent',{state:null,hasUAVisualTransition:false});
eventClass('HashChangeEvent',{oldURL:'',newURL:''});
eventClass('PageTransitionEvent',{persisted:false});
eventClass('BeforeUnloadEvent',{returnValue:''});
eventClass('SubmitEvent',{submitter:null});
eventClass('FormDataEvent',{formData:null});
eventClass('CloseEvent',{wasClean:true,code:1000,reason:''});
eventClass('PromiseRejectionEvent',{promise:null,reason:undefined});
eventClass('ClipboardEvent',{clipboardData:null});
eventClass('SecurityPolicyViolationEvent',{documentURI:'',referrer:'',blockedURI:'',
 violatedDirective:'',effectiveDirective:'',originalPolicy:'',disposition:'enforce',
 sourceFile:'',statusCode:0,lineNumber:0,columnNumber:0,sample:''});
eventClass('AnimationEvent',{animationName:'',elapsedTime:0,pseudoElement:''});
/* createEvent names them, so they need interfaces of their own rather
   than sharing Event's. */
eventClass('DeviceMotionEvent',{acceleration:null,
 accelerationIncludingGravity:null,rotationRate:null,interval:0});
eventClass('DeviceOrientationEvent',{alpha:null,beta:null,gamma:null,
 absolute:false});
eventClass('TextEvent',{data:''},W.UIEvent);
eventClass('TransitionEvent',{propertyName:'',elapsedTime:0,pseudoElement:''});
eventClass('FocusEvent',{relatedTarget:null},W.UIEvent);
eventClass('TouchEvent',{touches:[],targetTouches:[],changedTouches:[],
 altKey:false,ctrlKey:false,shiftKey:false,metaKey:false},W.UIEvent)
 .prototype.getModifierState=function(k){return !!this[String(k).toLowerCase()+'Key'];};
eventClass('PointerEvent',{pointerId:1,width:1,height:1,pressure:0,tangentialPressure:0,
 tiltX:0,tiltY:0,twist:0,altitudeAngle:Math.PI/2,azimuthAngle:0,pointerType:'touch',
 isPrimary:true,persistentDeviceId:0},W.MouseEvent)
 .prototype.getCoalescedEvents=function(){return [this];};
W.PointerEvent.prototype.getPredictedEvents=function(){return [];};
/* Touch itself gains the fields a handler reads off one. */
(function(){var T=W.Touch;if(!T)return;
 var old=T;W.Touch=function(init){old.call(this,init);init=init||{};
  this.radiusX=init.radiusX||1;this.radiusY=init.radiusY||1;
  this.rotationAngle=init.rotationAngle||0;this.force=init.force||1;
  this.altitudeAngle=init.altitudeAngle||Math.PI/2;this.azimuthAngle=init.azimuthAngle||0;
  this.touchType=init.touchType||'direct';};
 W.Touch.prototype=old.prototype;})();

/* --- tree walking, XPath and the document odds and ends ------------------ */
(function(){
 var make=D.createTreeWalker;
 D.createTreeWalker=function(root,what,filter){
  var w=make.call(D,root,what,filter);
  w.whatToShow=what===undefined?0xFFFFFFFF:what;
  w.filter=filter||null;
  w.lastChild=function(){var n=this.currentNode.lastChild;if(n)this.currentNode=n;return n;};
  w.previousSibling=function(){var n=this.currentNode.previousSibling;
   if(n)this.currentNode=n;return n;};
  w.previousNode=function(){var n=this.currentNode.previousSibling||this.currentNode.parentNode;
   if(n&&n!==this.root.parentNode)this.currentNode=n;else return null;return n;};
  return w;};
 /* An iterator starts before the root, so its first nextNode is the root
    itself when the filter takes it -- a walker's first is the root's
    first child, and delegating skipped it. */
 D.createNodeIterator=function(root,what,filter){
  var w=D.createTreeWalker(root,what,filter);
  var started=false;
  what=what===undefined?0xFFFFFFFF:what;
  var fn=filter&&(typeof filter==='function'?filter:filter.acceptNode);
  function takes(n){
   if(!((1<<(n.nodeType-1))&what))return false;
   return fn?fn(n)===1:true;}
  return {root:root,whatToShow:w.whatToShow,filter:filter||null,
   referenceNode:root,pointerBeforeReferenceNode:true,
   nextNode:function(){
    if(!started){started=true;this.pointerBeforeReferenceNode=false;
     if(takes(root)){this.referenceNode=root;return root;}}
    var n=w.nextNode();if(n)this.referenceNode=n;return n;},
   previousNode:function(){var n=w.previousNode();if(n)this.referenceNode=n;return n;},
   detach:function(){}};};
})();
W.TreeWalker=function(){};W.NodeIterator=function(){};
W.MutationRecord=function(){this.type='';this.target=null;this.addedNodes=[];
 this.removedNodes=[];this.previousSibling=null;this.nextSibling=null;
 this.attributeName=null;this.attributeNamespace=null;this.oldValue=null;};
/* XPath, for the subset a page actually writes: a path of element names,
 * an id() call, and the // descendant step. Anything else gives an empty
 * result, which is what an unsupported expression gave before. */
function XPathResult(nodes,type){this.resultType=type||4;this._n=nodes;this._i=0;
 this.snapshotLength=nodes.length;this.invalidIteratorState=false;
 this.numberValue=nodes.length;this.booleanValue=nodes.length>0;
 this.stringValue=nodes.length?(nodes[0].textContent||''):'';
 this.singleNodeValue=nodes.length?nodes[0]:null;}
XPathResult.prototype.iterateNext=function(){return this._i<this._n.length?this._n[this._i++]:null;};
XPathResult.prototype.snapshotItem=function(i){return this._n[i]===undefined?null:this._n[i];};
['ANY_TYPE','NUMBER_TYPE','STRING_TYPE','BOOLEAN_TYPE','UNORDERED_NODE_ITERATOR_TYPE',
 'ORDERED_NODE_ITERATOR_TYPE','UNORDERED_NODE_SNAPSHOT_TYPE','ORDERED_NODE_SNAPSHOT_TYPE',
 'ANY_UNORDERED_NODE_TYPE','FIRST_ORDERED_NODE_TYPE'].forEach(function(k,i){XPathResult[k]=i;});
W.XPathResult=XPathResult;
function xpathToCss(x){
 x=String(x).trim();
 var m=/^id\(['"]([^'"]+)['"]\)$/.exec(x);
 if(m)return '#'+m[1];
 if(!/^[\/.]/.test(x))return null;
 if(/[()@\[\]|]/.test(x))return null;   /* predicates and functions: not here */
 return x.replace(/^\.?\/\//,' ').replace(/\/\//g,' ').replace(/\//g,' > ')
  .replace(/\s+/g,' ').trim().replace(/^> /,'');}
D.evaluate=function(expr,ctx,resolver,type){
 var css=xpathToCss(expr),nodes=[];
 if(css){try{nodes=(ctx&&ctx.querySelectorAll?ctx:D).querySelectorAll(css);}catch(e){nodes=[];}}
 return new XPathResult(nodes,type);};
D.createExpression=function(expr){return {evaluate:function(ctx,type){
 return D.evaluate(expr,ctx,null,type);}};};
D.createNSResolver=function(n){return function(){return null;};};
W.XPathEvaluator=function(){};
W.XPathEvaluator.prototype.evaluate=function(e,c,r,t){return D.evaluate(e,c,r,t);};
W.XPathEvaluator.prototype.createExpression=function(e){return D.createExpression(e);};
W.XPathEvaluator.prototype.createNSResolver=function(n){return D.createNSResolver(n);};
D.createAttributeNS=function(ns,n){
 var a=new Attr(null,String(n),''),q=String(n),c=q.indexOf(':');
 a.namespaceURI=(ns===''||ns===null||ns===undefined)?null:String(ns);
 a.prefix=c>0?q.slice(0,c):null;
 a.localName=c>0?q.slice(c+1):q;
 return a;};
D.createCDATASection=function(t){return D.createTextNode(t);};
D.createProcessingInstruction=function(t,d){return D.createComment('');};
D.getElementsByTagNameNS=function(ns,t){return D.getElementsByTagName(t);};
D.moveBefore=function(n,ref){var e=D.documentElement;return e?e.insertBefore(n,ref||null):n;};
D.getAnimations=function(){return [];};
D.getBoxQuads=function(){return [];};
['queryCommandEnabled','queryCommandIndeterm','queryCommandState','queryCommandSupported']
 .forEach(function(k){D[k]=function(){return false;};});
D.queryCommandValue=function(){return '';};
Object.defineProperty(D,'customElementRegistry',{configurable:true,get:function(){return W.customElements;}});
Object.defineProperty(P,'customElementRegistry',{configurable:true,get:function(){return W.customElements;}});
/* This used to hand the page's own document back for both of these,
   so anything a page built here was the page. The real ones are set up
   further down, once the parser global is known to exist; only the
   doctype maker belongs here. */
D.implementation.createDocumentType=function(n,p,s){
 return {name:n,publicId:p||'',systemId:s||'',nodeType:10};};
D.implementation.hasFeature=function(){return true;};
W.DOMImplementation=function(){};
/* --- documents of their own ---------------------------------------------
 * DOMParser handed back a div with the markup inside it, so
 * documentElement, head, body and every document method were missing
 * from something a page had every reason to treat as a document.
 * __vitaParseDocument parses into a real libdom document with the same
 * parser the browser uses for a page; what is left is the part of the
 * Document interface that a node does not already answer to, added to
 * the shared prototype and guarded on being a document. */
function isDoc(n){return !!n&&n.nodeType===9;}
function docElement(d){
 var c=d.childNodes,i;
 for(i=0;i<c.length;i++)if(c[i].nodeType===1)return c[i];
 return null;}
function docChild(d,tag){
 var de=docElement(d),c,i;
 if(!de)return null;
 c=de.childNodes;
 for(i=0;i<c.length;i++)if(c[i].nodeType===1&&c[i].tagName===tag)return c[i];
 return null;}
function docOverride(name,get,set){
 var d=Object.getOwnPropertyDescriptor(P,name);
 Object.defineProperty(P,name,{configurable:true,
  get:function(){
   if(isDoc(this))return get.call(this);
   return d&&d.get?d.get.call(this):(d?d.value:undefined);},
  set:function(v){
   if(isDoc(this)){if(set)set.call(this,v);return;}
   if(d&&d.set)d.set.call(this,v);
   else if(d&&!d.get)Object.defineProperty(this,name,
    {configurable:true,writable:true,enumerable:true,value:v});}});}
docOverride('documentElement',function(){return docElement(this);});
docOverride('head',function(){return docChild(this,'HEAD');});
docOverride('body',function(){
 return docChild(this,'BODY')||docChild(this,'FRAMESET');});
docOverride('title',function(){
 var t=docChild(this,'HEAD');
 t=t&&t.querySelector?t.querySelector('title'):null;
 return t?String(t.textContent):'';},
 function(v){
  var h=docChild(this,'HEAD'),t=h&&h.querySelector?h.querySelector('title'):null;
  if(!t&&h){t=D.createElement('title');h.appendChild(t);}
  if(t)t.textContent=String(v);});
/* A document delegates the search methods to its element, which is what
   the document's own tree amounts to. */
['querySelector','querySelectorAll','getElementsByTagName',
 'getElementsByClassName','getElementsByName'].forEach(function(m){
 var orig=P[m],mode=m==='querySelector'?1:m==='querySelectorAll'?2:-1;
 if(typeof orig!=='function')return;
 P[m]=function(){
  /* a bare tag on an element is answered in C before anything else;
     a document object is not a node wrapper, so it comes back here */
  if(mode>0){var f=tagFast(this,arguments[0],mode);if(f!==undefined)return f;}
  if(!isDoc(this))return orig.apply(this,arguments);
  var de=docElement(this);
  if(!de)return m==='querySelector'?null:[];
  /* the document element is in the document's own search, but not in
     its own subtree search */
  if(m==='querySelector'&&de.matches&&arguments[0]){
   try{if(de.matches(arguments[0]))return de;}catch(e){}}
  return orig.apply(de,arguments);};});
/* The four selector calls as native functions (VitaSurf): a selector of
   type, #id, .class and [attribute] tests is answered in C without a
   JavaScript frame, and anything else is handed to the function each
   replaces. GitHub made 400,000 of these calls in one load, and the
   frames around each, not the matching, filled a 20 s timer. */
if(typeof __vitaSelectorNative==='function'){
 P.matches=P.webkitMatchesSelector=P.msMatchesSelector=
  __vitaSelectorNative(0,P.matches);
 P.querySelector=__vitaSelectorNative(1,P.querySelector);
 P.querySelectorAll=__vitaSelectorNative(2,P.querySelectorAll);
 P.closest=__vitaSelectorNative(3,P.closest);}
function docById(root,id){
 /* in C where it can be: a walk in script read childNodes at every
    element (VitaSurf) */
 if(typeof __vitaFindById==='function')return __vitaFindById(root,String(id));
 var want=String(id),found=null;
 (function walk(n){
  var c=n.childNodes,i;
  for(i=0;i<c.length&&!found;i++){
   if(c[i].nodeType!==1)continue;
   if(c[i].getAttribute('id')===want){found=c[i];return;}
   walk(c[i]);}})(root);
 return found;}
/* Creating a node for another document: libdom ties a node to the
   document it was made in, so make it there. */
var DOC_MAKE={createElement:1,createTextNode:3,createComment:8,
 createDocumentFragment:11};
Object.keys(DOC_MAKE).forEach(function(m){
 P[m]=function(a){
  if(!isDoc(this))throw new TypeError(m+' is not a function');
  var n=W.__vitaCreateIn?W.__vitaCreateIn(this,DOC_MAKE[m],
   a===undefined?'':String(a)):null;
  return n||D[m](a);};});
P.createElementNS=function(ns,t){return this.createElement(t);};
/* Adoption: a node inserted into a fragment of this document becomes this
   document's (libdom adopts it in place), and leaves it again with no
   parent. importNode is that, on a copy. They handed back the node as it
   was, still another document's, which nothing could then insert. */
function adoptInto(doc,n){
 if(!n||typeof n!=='object'||n.nodeType===9)return n;
 if(n.ownerDocument===doc)return n;
 var f=doc.createDocumentFragment&&doc.createDocumentFragment();
 if(!f||!f.appendChild)return n;
 try{f.appendChild(n);f.removeChild(n);}catch(e){}
 return n;}
P.importNode=function(n,deep){
 var c=n&&n.cloneNode?n.cloneNode(!!deep):null;
 return isDoc(this)?adoptInto(this,c):c;};
P.adoptNode=function(n){return isDoc(this)?adoptInto(this,n):n;};
D.importNode=function(n,deep){
 return adoptInto(D,n&&n.cloneNode?n.cloneNode(!!deep):n);};
D.adoptNode=function(n){return adoptInto(D,n);};
/* A copy of a document: one of its kind, with copies of its children
   when deep. There was no cloneNode on the page's document, and a parsed
   document's gave null. */
function cloneDocument(src,deep){
 var html=src===D||src.contentType==='text/html';
 var d=html?D.implementation.createHTMLDocument(''):
  D.implementation.createDocument(null,null,null);
 /* guarded: a child that will not go must not loop forever */
 var guard=0,f;
 while((f=d.firstChild)&&guard++<64){d.removeChild(f);if(d.firstChild===f)break;}
 if(deep){
  /* the page's document object carries no childNodes of its own */
  var k=src.childNodes||(src.documentElement?[src.documentElement]:[]),i;
  for(i=0;i<k.length;i++){
   if(k[i].nodeType===10&&html)continue;
   try{d.appendChild(d.importNode(k[i],true));}catch(e){}}}
 return d;}
D.cloneNode=function(deep){return cloneDocument(D,!!deep);};
(function(){var c=P.cloneNode;
 P.cloneNode=function(deep){
  if(isDoc(this))return cloneDocument(this,!!deep);
  var k=c.apply(this,arguments);
  if(k&&this.nodeType===1)cloneShadows(this,k,!!deep);
  return k;};
 /* a shadow root made clonable goes with its host, and so do those of
    the hosts a deep clone copies */
 function cloneShadows(a,b,deep){
  var r=SH_ROOT(a),i,nr,x,y;
  if(r&&r.__vsInit&&r.__vsInit.clonable&&!SH_ROOT(b)){
   i=r.__vsInit;
   try{
    nr=b.attachShadow({mode:SH_HOST(r,true)?'closed':'open',
     delegatesFocus:i.delegatesFocus,slotAssignment:i.slotAssignment,
     clonable:true,serializable:i.serializable});
    for(x=r.firstChild;x;x=x.nextSibling)nr.appendChild(x.cloneNode(true));}
   catch(e){}}
  if(!deep)return;
  for(x=a.firstChild,y=b.firstChild;x&&y;x=x.nextSibling,y=y.nextSibling)
   if(x.nodeType===1)cloneShadows(x,y,true);}})();
/* Each document has its own implementation: what it creates belongs to
   it, and the tests check exactly that. */
Object.defineProperty(P,'implementation',{configurable:true,
 get:function(){
  if(!isDoc(this))return D.implementation;
  var owner=this;
  if(!Object.prototype.hasOwnProperty.call(this,'__vitaImpl'))
   Object.defineProperty(this,'__vitaImpl',{configurable:true,value:{
    createHTMLDocument:function(t){return D.implementation.createHTMLDocument(t);},
    createDocument:function(a,b,c){return D.implementation.createDocument(a,b,c);},
    createDocumentType:function(n,p,sy){
     return D.implementation.createDocumentType.call(owner,n,p,sy);},
    hasFeature:function(){return true;}}});
  return this.__vitaImpl;}});
Object.defineProperty(P,'defaultView',{configurable:true,
 get:function(){return isDoc(this)?null:undefined;}});
Object.defineProperty(P,'contentType',{configurable:true,
 get:function(){return isDoc(this)?'text/html':undefined;}});
/* A document made here (createHTMLDocument, DOMParser) has the metadata a
   document has: it was all undefined, and code that reads a parsed
   document's URL or characterSet took it for something else. */
(function(){
 /* for a document only: an element keeps what it had (charset reflects
    an attribute on script and meta) */
 function docProp(k,val){
  var d=Object.getOwnPropertyDescriptor(P,k);
  Object.defineProperty(P,k,{configurable:true,
   get:function(){
    if(isDoc(this))return val(this);
    return d?(d.get?d.get.call(this):d.value):undefined;},
   set:function(v){
    if(isDoc(this))return;
    if(d&&d.set)d.set.call(this,v);
    else Object.defineProperty(this,k,{value:v,writable:true,configurable:true,enumerable:true});}});}
 function url(doc){return doc.__vitaURL||'about:blank';}
 docProp('URL',url);docProp('documentURI',url);
 ['characterSet','charset','inputEncoding'].forEach(function(k){
  docProp(k,function(){return 'UTF-8';});});
 docProp('compatMode',function(){return 'CSS1Compat';});
 docProp('location',function(){return null;});
})();
Object.defineProperty(P,'name',{configurable:true,
 get:function(){
  if(this.nodeType===10)return String(this.nodeName);
  var v=this.getAttribute?this.getAttribute('name'):null;
  return v===null||v===undefined?'':v;},
 set:function(v){if(this.setAttribute)this.setAttribute('name',String(v));}});
Object.defineProperty(P,'doctype',{configurable:true,
 get:function(){
  if(!isDoc(this))return undefined;
  var c=this.childNodes,i;
  for(i=0;i<c.length;i++)if(c[i].nodeType===10)return c[i];
  return null;}});

W.DOMParser=W.DOMParser||function(){};
W.DOMParser.prototype.parseFromString=function(str,type){
 var d=W.__vitaParseDocument?W.__vitaParseDocument(String(str)):null;
 if(d)return d;
 /* the parser is not there: at least give back something with a body */
 var f=D.createElement('div');f.innerHTML=String(str);return f;};
W.Document.parseHTML=W.Document.parseHTMLUnsafe=function(str){
 return new W.DOMParser().parseFromString(String(str),'text/html');};

/* --- character data ----------------------------------------------------- */
P.substringData=function(o,c){return String(this.textContent||'').substr(o,c);};
P.appendData=function(s){this.textContent=String(this.textContent||'')+String(s);};
P.insertData=function(o,s){var t=String(this.textContent||'');
 this.textContent=t.slice(0,o)+String(s)+t.slice(o);};
P.deleteData=function(o,c){var t=String(this.textContent||'');
 this.textContent=t.slice(0,o)+t.slice(o+c);};
P.replaceData=function(o,c,s){this.deleteData(o,c);this.insertData(o,s);};
/* text.data is the text; every other tag keeps the data attribute, which
 * object elements resolve as a URL. */
(function(){var d=Object.getOwnPropertyDescriptor(P,'data');
 Object.defineProperty(P,'data',{configurable:true,
  get:function(){var t=this.nodeType;
   return (t===3||t===8)?String(this.textContent||''):d.get.call(this);},
  set:function(v){var t=this.nodeType;
   if(t===3||t===8)this.textContent=String(v);else d.set.call(this,v);}});})();
P.splitText=function(o){var t=String(this.textContent||'');
 var n=D.createTextNode(t.slice(o));this.textContent=t.slice(0,o);
 if(this.parentNode)this.parentNode.insertBefore(n,this.nextSibling);
 return n;};
Object.defineProperty(P,'wholeText',{configurable:true,get:function(){return this.textContent;}});

/* --- tables, dialogs, slots and media ----------------------------------- */
function rowsOf(el){return el.getElementsByTagName('tr');}
(function(){var d=Object.getOwnPropertyDescriptor(P,'rows');
 Object.defineProperty(P,'rows',{configurable:true,get:function(){
  var t=this.tagName;
  return (t==='TABLE'||t==='TBODY'||t==='THEAD'||t==='TFOOT')?rowsOf(this):d.get.call(this);},
  set:function(v){d.set.call(this,v);}});})();
Object.defineProperty(P,'cells',{configurable:true,get:function(){
 if(this.tagName!=='TR')return undefined;
 return listOf(this.children).filter(function(c){return c.tagName==='TD'||c.tagName==='TH';});}});
Object.defineProperty(P,'rowIndex',{configurable:true,get:function(){
 if(this.tagName!=='TR')return -1;
 var t=this;while(t&&t.tagName!=='TABLE')t=t.parentNode;
 return t?listOf(rowsOf(t)).indexOf(this):-1;}});
Object.defineProperty(P,'sectionRowIndex',{configurable:true,get:function(){
 if(this.tagName!=='TR')return -1;
 var s=this.parentNode;return s?listOf(rowsOf(s)).indexOf(this):-1;}});
['tHead','tFoot','caption'].forEach(function(k){
 var tag=k==='caption'?'CAPTION':k.toUpperCase();
 Object.defineProperty(P,k,{configurable:true,get:function(){
  if(this.tagName!=='TABLE')return null;
  var c=this.children;for(var i=0;i<c.length;i++)if(c[i].tagName===tag)return c[i];
  return null;}});});
Object.defineProperty(P,'tBodies',{configurable:true,get:function(){
 return this.tagName==='TABLE'?listOf(this.children).filter(function(c){return c.tagName==='TBODY';}):[];}});
function tableSection(el,tag,make){
 var e=listOf(el.children).filter(function(c){return c.tagName===tag;})[0];
 if(!e&&make){e=D.createElement(tag.toLowerCase());
  if(tag==='TFOOT')el.appendChild(e);else el.insertBefore(e,el.firstChild);}
 return e||null;}
P.createCaption=function(){return tableSection(this,'CAPTION',true);};
P.createTHead=function(){return tableSection(this,'THEAD',true);};
P.createTFoot=function(){return tableSection(this,'TFOOT',true);};
P.createTBody=function(){var e=D.createElement('tbody');this.appendChild(e);return e;};
P.deleteCaption=function(){var e=tableSection(this,'CAPTION');if(e)e.remove();};
P.deleteTHead=function(){var e=tableSection(this,'THEAD');if(e)e.remove();};
P.deleteTFoot=function(){var e=tableSection(this,'TFOOT');if(e)e.remove();};
P.insertRow=function(i){
 var host=this.tagName==='TABLE'?(tableSection(this,'TBODY')||this.createTBody()):this;
 var tr=D.createElement('tr'),rows=rowsOf(host);
 if(i===undefined||i<0||i>=rows.length)host.appendChild(tr);
 else host.insertBefore(tr,rows[i]);
 return tr;};
P.deleteRow=function(i){var rows=rowsOf(this);if(rows[i])rows[i].remove();};
P.insertCell=function(i){var td=D.createElement('td'),cells=this.cells||[];
 if(i===undefined||i<0||i>=cells.length)this.appendChild(td);
 else this.insertBefore(td,cells[i]);
 return td;};
P.deleteCell=function(i){var c=this.cells||[];if(c[i])c[i].remove();};
/* A dialog opens and closes by the open attribute, which is what its
 * default style keys off. */
P.show=function(){this.setAttribute('open','');};
P.showModal=function(){this.setAttribute('open','');
 this.dispatchEvent(uaEvent(new Event('beforetoggle')));};
P.close=function(v){if(v!==undefined)this.returnValue=String(v);
 this.removeAttribute('open');this.dispatchEvent(uaEvent(new Event('close')));};
P.requestClose=function(v){if(this.dispatchEvent(uaEvent(new Event('cancel',{cancelable:true}))))this.close(v);};
Object.defineProperty(P,'returnValue',{configurable:true,
 get:function(){return this.__returnValue||'';},set:function(v){this.__returnValue=String(v);}});
Object.defineProperty(P,'closedBy',{configurable:true,
 get:function(){return this.getAttribute('closedby')||'auto';},
 set:function(v){this.setAttribute('closedby',String(v));}});
/* A slot with no shadow tree shows whatever was assigned to it in the
 * light DOM, which here is the host's children with a matching slot. */
function slotAssigned(slot){
 var name=slot.getAttribute('name')||'',root=slot.getRootNode(),
  host=shadowHost(root),first;
 if(!host)return [];
 if(W.__vsManualRoot&&W.__vsManualRoot(root))
  return (slot.__vsManual||[]).filter(function(n){
   return n.parentNode===host&&W.__vsManualSlot(n,root)===slot;});
 /* only the first slot of a name takes what has that name */
 first=root.querySelectorAll('slot').filter(function(s){
  return (s.getAttribute('name')||'')===name;})[0];
 if(first!==slot)return [];
 return host.childNodes.filter(function(n){
  if(n.nodeType===3)return name==='';
  return n.nodeType===1&&(n.getAttribute('slot')||'')===name;});}
/* {flatten: true}: a slot with nothing assigned gives its own children,
   and a slot among what is given gives what it is given in turn */
function slotFlat(slot,out){
 var l=slotAssigned(slot),i,n;
 if(!l.length)l=slot.childNodes.filter(function(c){return c.nodeType===1||c.nodeType===3;});
 for(i=0;i<l.length;i++){
  n=l[i];
  if(n.nodeType===1&&n.tagName==='SLOT'&&shadowHost(n.getRootNode()))slotFlat(n,out);
  else out.push(n);}
 return out;}
P.assignedNodes=function(o){
 if(this.tagName!=='SLOT')return [];
 return o&&o.flatten?slotFlat(this,[]):slotAssigned(this);};
P.assignedElements=function(o){return this.assignedNodes(o).filter(function(n){return n.nodeType===1;});};
/* Media elements. There is no decoder here, so a play resolves and the
 * element reports that it ended: code that waits on a promise or on the
 * ended event keeps going rather than hanging on a video that never
 * starts. */
(function(){
 var num={currentTime:0,duration:NaN,playbackRate:1,defaultPlaybackRate:1,volume:1,
  networkState:3,readyState:0};
 Object.keys(num).forEach(function(k){Object.defineProperty(P,k,{configurable:true,
  get:function(){return this['__'+k]===undefined?num[k]:this['__'+k];},
  set:function(v){this['__'+k]=v;}});});
 var flag={paused:true,ended:false,seeking:false,defaultMuted:false,preservesPitch:true};
 Object.keys(flag).forEach(function(k){Object.defineProperty(P,k,{configurable:true,
  get:function(){return this['__'+k]===undefined?flag[k]:this['__'+k];},
  set:function(v){this['__'+k]=!!v;}});});
 ['buffered','played','seekable'].forEach(function(k){Object.defineProperty(P,k,{configurable:true,
  get:function(){return {length:0,start:function(){return 0;},end:function(){return 0;}};}});});
 ['audioTracks','videoTracks','textTracks'].forEach(function(k){
  Object.defineProperty(P,k,{configurable:true,get:function(){
   var l=[];l.item=function(i){return this[i]||null;};
   l.addEventListener=l.removeEventListener=function(){};
   l.getTrackById=function(){return null;};return l;}});});
 Object.defineProperty(P,'error',{configurable:true,get:function(){return this.__mediaError||null;}});
 Object.defineProperty(P,'srcObject',{configurable:true,
  get:function(){return this.__srcObject||null;},set:function(v){this.__srcObject=v;}});
 Object.defineProperty(P,'autoplay',{configurable:true,
  get:function(){return this.hasAttribute('autoplay');},
  set:function(v){if(v)this.setAttribute('autoplay','');else this.removeAttribute('autoplay');}});
 Object.defineProperty(P,'preload',{configurable:true,
  get:function(){return this.getAttribute('preload')||'metadata';},
  set:function(v){this.setAttribute('preload',String(v));}});
 P.load=function(){this.__ended=false;this.__paused=true;};
 P.play=function(){var self=this;self.__paused=false;
  setTimeout(function(){self.__paused=true;self.__ended=true;
   self.dispatchEvent(uaEvent(new Event('ended')));},0);
  return Promise.reject(new Error('NotSupportedError: no media decoder'));};
 P.pause=function(){this.__paused=true;this.dispatchEvent(uaEvent(new Event('pause')));};
 P.fastSeek=function(t){this.currentTime=t;};
 P.canPlayType=function(){return '';};
 P.getStartDate=function(){return new Date(NaN);};
 P.addTextTrack=function(kind,label,lang){
  return {kind:kind,label:label||'',language:lang||'',mode:'disabled',cues:[],activeCues:[],
   addCue:function(){},removeCue:function(){},addEventListener:function(){},
   removeEventListener:function(){}};};
 W.MediaError=function(code){this.code=code||4;this.message='';};
 W.TimeRanges=function(){this.length=0;};
})();

/* --- the shadow root, the template and the observers -------------------- */
Object.defineProperty(P,'mode',{configurable:true,get:function(){
 if(!shadowHost(this))return undefined;
 return SH_HOST(this,true)?'closed':'open';}});
/* --- focus ---------------------------------------------------------------
 * focus() did nothing and activeElement was always the body. A login page
 * that focuses its first field, a component that focuses its input when
 * its frame is tapped, and code that asks what has focus all went without.
 * The element with focus is kept here; a text field gets the caret as
 * well, which on the Vita opens the keyboard when a tap led to it. */
var focused=null;
/* the DOM standard's retargeting: a, or the host of the shadow tree it
   is in, outwards until b is in the same tree or one inside it */
function treeRoot(n){while(n&&n.parentNode)n=n.parentNode;return n;}
function retarget(a,b){
 var r,x;
 for(;;){
  r=treeRoot(a);
  if(!r||r.nodeType!==11||!shadowHost(r))return a;
  for(x=b;x;x=x.parentNode||shadowHost(x))if(x===r)return a;
  a=shadowHost(r);}}
/* the first focusable element in a shadow tree, trees inside it too */
function firstFocusable(root){
 var w=[root],n,c,r;
 while(w.length){
  n=w.shift();
  for(c=n.firstElementChild;c;c=c.nextElementSibling){
   if(focusable(c))return c;
   r=SH_ROOT(c);
   if(r)w.push(r);
   w.push(c);}}
 return null;}
function delegates(el){
 var r=el&&el.nodeType===1&&SH_ROOT(el);
 return !!(r&&r.__vsInit&&r.__vsInit.delegatesFocus);}
function focusable(el){
 if(!el||el.nodeType!==1||el.disabled)return false;
 var t=el.tagName;
 if(t==='INPUT')return String(el.type||'').toLowerCase()!=='hidden';
 if(t==='TEXTAREA'||t==='SELECT'||t==='BUTTON'||t==='IFRAME'||t==='SUMMARY')return true;
 if((t==='A'||t==='AREA')&&el.hasAttribute('href'))return true;
 if(el.hasAttribute('tabindex'))return true;
 var ce=el.getAttribute('contenteditable');
 return ce!==null&&ce!=='false';}
function focusEvent(el,type,bubbles,related){
 var e=uaEvent(new Event(type,{bubbles:bubbles,cancelable:false,composed:true}));
 try{e.relatedTarget=related||null;}catch(x){}
 try{el.dispatchEvent(e);}catch(x){}}
function moveFocus(el,caret){
 var prev=focused;
 if(prev===el)return;
 focused=el;
 /* :focus, :focus-within and :focus-visible in the style sheets */
 if(W.__vitaSetFocus)try{W.__vitaSetFocus(el||null);}catch(x){}
 if(prev&&ceInDoc(prev)){
  focusEvent(prev,'blur',false,el);focusEvent(prev,'focusout',true,el);}
 if(el){
  if(caret&&W.__vitaFocusControl&&(el.tagName==='INPUT'||el.tagName==='TEXTAREA'))
   try{W.__vitaFocusControl(el);}catch(x){}
  focusEvent(el,'focus',false,prev);focusEvent(el,'focusin',true,prev);}}
P.focus=function(){
 var el=this;
 /* a host whose tree takes focus for it */
 if(delegates(el)){
  if(focused&&ceInDoc(focused)&&retarget(focused,el)===el&&focused!==el)return;
  el=firstFocusable(SH_ROOT(el));
  if(!el)return;}
 if(focusable(el)&&ceInDoc(el))moveFocus(el,true);};
P.blur=function(){if(focused===this)moveFocus(null,false);};
/* what has focus as the document sees it: the host of the shadow tree
   it is in, and that host's host, out to the document's own tree */
function activeEl(){return focused&&ceInDoc(focused)?retarget(focused,D):D.body;}
Object.defineProperty(D,'activeElement',{configurable:true,get:activeEl});
Object.defineProperty(P,'activeElement',{configurable:true,
 get:function(){
  if(isDoc(this))return activeEl();
  if(this.nodeType!==11||!shadowHost(this))return undefined;
  if(!focused||!ceInDoc(focused))return null;
  var c=retarget(focused,this);
  return treeRoot(c)===this?c:null;}});
/* a tap on a control focuses it too, one inside a shadow tree as well:
   the path starts from what was tapped, not from its host */
W.addEventListener('click',function(e){
 var p=e&&e.composedPath?e.composedPath():[],n=p.length?p[0]:e&&e.target;
 while(n&&!(n.nodeType===1&&(focusable(n)||delegates(n))))
  n=n.parentNode||shadowHost(n);
 if(n&&n.nodeType===1&&delegates(n)&&!focusable(n)){
  n.focus();return;}
 if(n&&n.nodeType===1&&focused!==n)moveFocus(n,false);},true);
/* what a shadow root was made with */
['delegatesFocus','slotAssignment','clonable','serializable'].forEach(function(k){
 Object.defineProperty(P,k,{configurable:true,get:function(){
  if(this.nodeType!==11||!shadowHost(this))return undefined;
  var i=this.__vsInit;
  return i?i[k]:(k==='slotAssignment'?'named':false);}});});
/* a shadow root's own sheets: its <style> and stylesheet <link>
   elements, in tree order */
Object.defineProperty(P,'styleSheets',{configurable:true,get:function(){
 var l=[],e,i,sh;
 if(this.nodeType===11&&shadowHost(this)){
  e=this.querySelectorAll('style:not([data-adopted]),link[rel~="stylesheet"]');
  for(i=0;i<e.length;i++){sh=e[i].sheet;if(sh)l.push(sh);}}
 l.item=function(i){return this[i]||null;};return l;}});
Object.defineProperty(P,'adoptedStyleSheets',adoptedAccessor());
reflectString([['shadowRootMode','shadowrootmode'],['shadowRootSlotAssignment','shadowrootslotassignment']]);
reflectBool([['shadowRootDelegatesFocus','shadowrootdelegatesfocus'],
 ['shadowRootClonable','shadowrootclonable'],['shadowRootSerializable','shadowrootserializable']]);
Object.defineProperty(P,'shadowRootCustomElementRegistry',{configurable:true,
 get:function(){return W.customElements;}});
/* --- IntersectionObserver ------------------------------------------------
   A stub here meant a page built around "render it when it scrolls into
   view" rendered nothing: openmediavault's dashboard widgets and
   Audiobookshelf's shelves both wait on this, and both came up empty.
   It is answered from the same geometry the rest of the bindings use --
   the element's box against the viewport -- and re-checked when the
   page scrolls, when it is resized, and when its DOM changes, which
   between them cover every reason an element's visibility can change
   without a poll running all the time. */
(function(){
 var observers=[],timer=null,lastScroll='',lastGen=-1,lastLayout=-1;
 /* whether layout has caught up with the document, and its pass count:
    the observer reports after layout, as a browser does in its
    rendering update, and not from the layout before a change (VitaSurf).
    It reported a new target as zero sized and out of view, from before
    its first layout, and again once laid out. */
 var LS=W.__vitaLayoutState;
 try{delete W.__vitaLayoutState;}catch(e){}
 function layoutState(){try{return LS?LS():[false,0];}catch(e){return [false,0];}}
 /* how long a first report waits for layout: a page whose rebuild waits
    for its loading to finish still hears, from the layout it has */
 var FIRST_WAIT_MS=2000;

 function parseMargin(m){
  /* one to four lengths, as the CSS margin shorthand is written; a
     percentage is of the root's own size, which is the viewport */
  var parts=String(m==null?'0px':m).trim().split(/\s+/),v=[],i;
  for(i=0;i<4;i++)v.push(parts[Math.min(i,parts.length-1)]);
  if(parts.length===2)v=[parts[0],parts[1],parts[0],parts[1]];
  else if(parts.length===3)v=[parts[0],parts[1],parts[2],parts[1]];
  return v;}

 function marginPx(val,of){
  var n=parseFloat(val)||0;
  return /%/.test(val)?n*of/100:n;}

 function rootRect(o){
  var s=viewport();
  if(o.root&&o.root.nodeType===1){
   var b=__vitaBox(o.root,true);
   if(b)return {left:b[0]-s[0],top:b[1]-s[1],width:b[2],height:b[3]};}
  return {left:0,top:0,width:s[2],height:s[3]};}

 function rectOf(el){
  /* the layout as it is: the observer is told after layout, never
     the cause of one */
  var b=__vitaBox(el,true);
  if(!b)return null;
  var s=viewport();
  return {left:b[0]-s[0],top:b[1]-s[1],width:b[2],height:b[3]};}

 function box(r){
  return {x:r.left,y:r.top,left:r.left,top:r.top,width:r.width,
   height:r.height,right:r.left+r.width,bottom:r.top+r.height,
   toJSON:function(){return this;}};}

 function check(o,force){
  var root=rootRect(o),m=o.__margin,i,records=[];
  var rl=root.left-marginPx(m[3],root.width);
  var rt=root.top-marginPx(m[0],root.height);
  var rr=root.left+root.width+marginPx(m[1],root.width);
  var rb=root.top+root.height+marginPx(m[2],root.height);
  var bounds={left:rl,top:rt,width:rr-rl,height:rb-rt};

  for(i=0;i<o.__targets.length;i++){
   var t=o.__targets[i],r=rectOf(t.el),rb_=box(bounds);
   /* not in the document: no root to be in, as in Chrome; not
      rendered: an empty one */
   if(!t.el.isConnected)rb_=null;
   else if(!r)rb_=box({left:0,top:0,width:0,height:0});
   if(!r){ r={left:0,top:0,width:0,height:0}; }
   var ix=Math.max(r.left,rl),iy=Math.max(r.top,rt);
   var ax=Math.min(r.left+r.width,rr),ay=Math.min(r.top+r.height,rb);
   var iw=Math.max(0,ax-ix),ih=Math.max(0,ay-iy);
   var area=r.width*r.height;
   var ratio=area>0?(iw*ih)/area:(iw>0&&ih>0?1:0);
   var hit=iw>0&&ih>0;
   /* report only when a threshold has actually been crossed, so a
      scroll does not call the page back on every frame */
   var step=0,k;
   for(k=0;k<o.thresholds.length;k++){
    if(ratio>=o.thresholds[k])step=k+1;}
   if(!force&&t.step===step&&t.hit===hit)continue;
   t.step=step;t.hit=hit;
   records.push({target:t.el,time:(W.performance&&performance.now)?
     performance.now():Date.now(),
    rootBounds:rb_,boundingClientRect:box(r),
    intersectionRect:box({left:hit?ix:0,top:hit?iy:0,
     width:iw,height:ih}),
    intersectionRatio:ratio,isIntersecting:hit});}

  if(records.length===0)return;
  o.__queue=o.__queue.concat(records);
  try{o.__cb.call(o,records,o);}catch(e){
   if(W.console&&console.error)console.error('IntersectionObserver: '+e);}
  o.__queue=[];}

 function checkAll(force){
  for(var i=0;i<observers.length;i++){
   if(observers[i].__targets.length)check(observers[i],force);}}

 function tick(){
  var s=viewport(),key=s[0]+','+s[1]+','+s[2]+','+s[3];
  var g=domGen();
  var live=0,i;

  for(i=0;i<observers.length;i++)live+=observers[i].__targets.length;
  if(live===0){ if(timer!==null){clearInterval(timer);timer=null;} return; }
  /* a change still to be laid out is looked at once it has been */
  var ls=layoutState();
  if(ls[0])return;
  /* nothing that could move anything has happened */
  if(key===lastScroll&&g===lastGen&&ls[1]===lastLayout)return;
  lastScroll=key;lastGen=g;lastLayout=ls[1];
  checkAll(false);}

 function wake(){
  if(timer===null)timer=setInterval(tick,250);}

 function IntersectionObserver(cb,opts){
  if(typeof cb!=='function')
   throw new TypeError('IntersectionObserver needs a callback');
  opts=opts||{};
  var th=opts.threshold;
  if(th==null)th=[0];
  if(typeof th==='number')th=[th];
  th=Array.prototype.slice.call(th).map(Number).filter(function(n){
   return n>=0&&n<=1;}).sort(function(a,b){return a-b;});
  if(th.length===0)th=[0];
  this.root=opts.root||null;
  this.rootMargin=String(opts.rootMargin==null?'0px':opts.rootMargin);
  this.scrollMargin=String(opts.scrollMargin==null?'0px':opts.scrollMargin);
  this.thresholds=th;
  this.delay=Number(opts.delay)||0;
  this.trackVisibility=!!opts.trackVisibility;
  this.__cb=cb;this.__targets=[];this.__queue=[];
  this.__margin=parseMargin(this.rootMargin);
  observers.push(this);}

 IntersectionObserver.prototype.observe=function(el){
  if(!el||el.nodeType!==1)return;
  for(var i=0;i<this.__targets.length;i++)
   if(this.__targets[i].el===el)return;
  this.__targets.push({el:el,step:-1,hit:null});
  wake();
  /* the specification delivers a first record for a new target without
     waiting for anything to move, and a page that builds its list from
     that first call depends on it */
  var self=this,t0=Date.now();
  function first(){
   if(layoutState()[0]&&Date.now()-t0<FIRST_WAIT_MS){
    setTimeout(first,50);return;}
   check(self,false);}
  setTimeout(first,0);};

 IntersectionObserver.prototype.unobserve=function(el){
  for(var i=0;i<this.__targets.length;i++){
   if(this.__targets[i].el===el){this.__targets.splice(i,1);return;}}};

 IntersectionObserver.prototype.disconnect=function(){
  this.__targets.length=0;};

 IntersectionObserver.prototype.takeRecords=function(){
  var q=this.__queue;this.__queue=[];return q;};

 W.IntersectionObserver=IntersectionObserver;
 W.addEventListener('scroll',function(){tick();},true);
 W.addEventListener('resize',function(){lastScroll='';tick();});
})();

/* --- screen, fetch bodies and the rest ---------------------------------- */
(function(){var s=W.screen||{};W.screen=s;
 var v=viewport();
 if(s.width===undefined)s.width=v[2];
 if(s.height===undefined)s.height=v[3];
 s.availWidth=s.width;s.availHeight=s.height;s.colorDepth=32;s.pixelDepth=32;
 s.orientation=s.orientation||{type:'landscape-primary',angle:0,
  addEventListener:function(){},removeEventListener:function(){}};})();
(function(){
 var bodies={arrayBuffer:function(){return new TextEncoder().encode(this._b||'').buffer;},
  blob:function(){var t=this._b||'';
   return {size:t.length,type:'',text:function(){return Promise.resolve(t);}};},
  bytes:function(){return new TextEncoder().encode(this._b||'');},
  formData:function(){return new URLSearchParams(this._b||'');}};
 [W.Request,W.Response].forEach(function(C){
  if(!C)return;
  Object.keys(bodies).forEach(function(k){var f=bodies[k];
   if(!C.prototype[k])C.prototype[k]=function(){
    var self=this;return this.text().then(function(t){self._b=t;return f.call(self);});};});
  /* body and textStream used to be defined here as getters returning
     null, which is worse than leaving them out: a page that tests for
     response.body stops taking its fallback and then calls getReader()
     on null. streams.js gives Response a real ReadableStream. */});
 if(W.Request){var rp=W.Request.prototype;
  ['destination','referrer','referrerPolicy','integrity','duplex'].forEach(function(k){
   if(!(k in rp))rp[k]='';});
  rp.keepalive=false;rp.isHistoryNavigation=false;rp.isReloadNavigation=false;}
 if(W.Response&&!W.Response.redirect)W.Response.redirect=function(url,status){
  var r=new W.Response('',{status:status||302});r.headers.set('location',String(url));return r;};
})();
(function(){var X=W.XMLHttpRequest;if(!X)return;
 ['onabort','onerror','onload','onloadend','onloadstart','onprogress','ontimeout',
  'onreadystatechange'].forEach(function(k){if(!(k in X.prototype))X.prototype[k]=null;});
 W.XMLHttpRequestEventTarget.prototype=X.prototype;})();
(function(){var M=W.MessagePort;if(!M)return;M.prototype.onclose=null;M.prototype.onmessageerror=null;})();

/* --- canvas -------------------------------------------------------------
 * getContext returned null, so every script that drew without checking
 * threw on its first call. There is no canvas backend here, so the
 * context accepts everything and draws nothing; what matters is that the
 * script gets past its drawing code to the part that builds the page.
 */
function TextMetrics(w){this.width=w;this.actualBoundingBoxLeft=0;this.actualBoundingBoxRight=w;
 this.actualBoundingBoxAscent=0;this.actualBoundingBoxDescent=0;
 this.fontBoundingBoxAscent=0;this.fontBoundingBoxDescent=0;
 this.emHeightAscent=0;this.emHeightDescent=0;
 this.hangingBaseline=0;this.alphabeticBaseline=0;this.ideographicBaseline=0;}
function ImageData(w,h){
 if(typeof w==='object'){this.data=w;this.width=h||0;this.height=arguments[2]||0;}
 else{this.width=w|0;this.height=h|0;this.data=new Uint8ClampedArray(this.width*this.height*4);}
 this.colorSpace='srgb';}
/* A gradient carries its geometry in the user space of the context that
   made it, and its stops in source order; the rasteriser mixes them
   across the shape being filled. kind 1 is linear, 2 radial, 3 conic. */
function CanvasGradient(kind,g){this.__kind=kind;this.__g=g;this.__stops=[];}
CanvasGradient.prototype.addColorStop=function(o,c){
 o=parseFloat(o); if(!(o>=0))o=0; if(o>1)o=1;
 this.__stops.push([o,c]);
 this.__stops.sort(function(a,b){return a[0]-b[0];});};
function CanvasPattern(){}
CanvasPattern.prototype.setTransform=function(){};
function Path2D(){}
['addPath','closePath','moveTo','lineTo','bezierCurveTo','quadraticCurveTo','arc','arcTo',
 'ellipse','rect','roundRect'].forEach(function(k){Path2D.prototype[k]=function(){};});
/* The 2D context draws for real: it keeps the state a page sets, turns
   curves into line segments, applies its own transform, and hands the
   points to the rasteriser behind __vitaCanvasPath, which fills the
   bitmap the renderer paints for the element. Text, images and clipping
   are not drawn yet. */
var CANVAS_NAMES={black:0x000000,silver:0xc0c0c0,gray:0x808080,grey:0x808080,
 white:0xffffff,maroon:0x800000,red:0xff0000,purple:0x800080,fuchsia:0xff00ff,
 magenta:0xff00ff,green:0x008000,lime:0x00ff00,olive:0x808000,yellow:0xffff00,
 navy:0x000080,blue:0x0000ff,teal:0x008080,aqua:0x00ffff,cyan:0x00ffff,
 orange:0xffa500,pink:0xffc0cb,brown:0xa52a2a,gold:0xffd700,
 lightgray:0xd3d3d3,lightgrey:0xd3d3d3,darkgray:0xa9a9a9,darkgrey:0xa9a9a9,
 lightblue:0xadd8e6,darkblue:0x00008b,lightgreen:0x90ee90,darkgreen:0x006400,
 dimgray:0x696969,dimgrey:0x696969,whitesmoke:0xf5f5f5,gainsboro:0xdcdcdc};
function canvasColour(v,alpha){
 /* to 0xRRGGBBAA, the form the rasteriser takes */
 if(v&&typeof v==='object'){
  var st=v.__stops;
  v=(st&&st.length)?st[st.length-1][1]:'#000000';
 }
 var s=String(v==null?'#000000':v).trim();
 var r=0,g=0,b=0,a=1,m;
 if(s.charAt(0)==='#'){
  if(s.length===4||s.length===5){
   r=parseInt(s.charAt(1)+s.charAt(1),16);g=parseInt(s.charAt(2)+s.charAt(2),16);
   b=parseInt(s.charAt(3)+s.charAt(3),16);
   if(s.length===5)a=parseInt(s.charAt(4)+s.charAt(4),16)/255;
  }else if(s.length>=7){
   r=parseInt(s.substr(1,2),16);g=parseInt(s.substr(3,2),16);b=parseInt(s.substr(5,2),16);
   if(s.length>=9)a=parseInt(s.substr(7,2),16)/255;
  }
 }else if((m=/^rgba?\(([^)]*)\)$/i.exec(s))){
  var p=m[1].split(/[,\/\s]+/).filter(function(x){return x!=='';});
  r=parseFloat(p[0]);g=parseFloat(p[1]);b=parseFloat(p[2]);
  if(p.length>3)a=p[3].indexOf('%')>=0?parseFloat(p[3])/100:parseFloat(p[3]);
  if(String(p[0]).indexOf('%')>=0){r=r*255/100;g=g*255/100;b=b*255/100;}
 }else if(/^transparent$/i.test(s)){a=0;}
 else{var nc=CANVAS_NAMES[s.toLowerCase()];
  if(nc!=null){r=(nc>>16)&255;g=(nc>>8)&255;b=nc&255;}}
 if(!(a>=0))a=1;if(a>1)a=1;
 a*=(alpha==null?1:alpha);
 r=Math.max(0,Math.min(255,Math.round(r)));
 g=Math.max(0,Math.min(255,Math.round(g)));
 b=Math.max(0,Math.min(255,Math.round(b)));
 return ((r<<24)>>>0)+(g<<16)+(b<<8)+Math.round(Math.max(0,Math.min(255,a*255)));
}
function CanvasRenderingContext2D(canvas){
 this.canvas=canvas;this.fillStyle='#000000';this.strokeStyle='#000000';
 this.lineWidth=1;this.lineCap='butt';this.lineJoin='miter';this.miterLimit=10;
 this.lineDashOffset=0;this.font='10px sans-serif';this.textAlign='start';
 this.textBaseline='alphabetic';this.direction='inherit';this.letterSpacing='0px';
 this.wordSpacing='0px';this.fontKerning='auto';this.fontStretch='normal';
 this.fontVariantCaps='normal';this.textRendering='auto';
 this.globalAlpha=1;this.globalCompositeOperation='source-over';this.filter='none';
 this.imageSmoothingEnabled=true;this.imageSmoothingQuality='low';
 this.shadowBlur=0;this.shadowColor='rgba(0, 0, 0, 0)';this.shadowOffsetX=0;this.shadowOffsetY=0;
 this.__m=[1,0,0,1,0,0];      /* the current transform */
 this.__stack=[];             /* what save() put by */
 this.__subs=[];              /* the path, subpath by subpath */
 this.__cur=null;             /* the subpath being added to */
 this.__start=null;           /* where the current subpath began */
}
(function(){var C=CanvasRenderingContext2D.prototype;
 /* a point through the current transform */
 function tx(c,x,y){var m=c.__m;return [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];}
 /* roughly how much the transform scales lengths */
 function scaleOf(c){var m=c.__m;
  return Math.sqrt(Math.abs(m[0]*m[3]-m[1]*m[2]))||1;}
 function push(c,x,y){var p=tx(c,x,y);
  if(c.__cur===null){c.__cur=[];c.__subs.push(c.__cur);}
  c.__cur.push(p[0],p[1]);}
 C.save=function(){this.__stack.push({m:this.__m.slice(),fill:this.fillStyle,
  stroke:this.strokeStyle,lw:this.lineWidth,ga:this.globalAlpha,font:this.font,
  align:this.textAlign,base:this.textBaseline,cap:this.lineCap,join:this.lineJoin});
  if(this.__stack.length>64)this.__stack.shift();};
 C.restore=function(){var s=this.__stack.pop();if(!s)return;
  this.__m=s.m;this.fillStyle=s.fill;this.strokeStyle=s.stroke;this.lineWidth=s.lw;
  this.globalAlpha=s.ga;this.font=s.font;this.textAlign=s.align;
  this.textBaseline=s.base;this.lineCap=s.cap;this.lineJoin=s.join;};
 C.setTransform=function(a,b,c,d,e,f){
  if(a&&typeof a==='object'){this.__m=[a.a||0,a.b||0,a.c||0,a.d||0,a.e||0,a.f||0];}
  else this.__m=[a,b,c,d,e,f];};
 C.resetTransform=function(){this.__m=[1,0,0,1,0,0];};
 C.transform=function(a,b,c,d,e,f){var m=this.__m;
  this.__m=[m[0]*a+m[2]*b,m[1]*a+m[3]*b,m[0]*c+m[2]*d,m[1]*c+m[3]*d,
            m[0]*e+m[2]*f+m[4],m[1]*e+m[3]*f+m[5]];};
 C.translate=function(x,y){this.transform(1,0,0,1,x,y);};
 C.scale=function(x,y){this.transform(x,0,0,y,0,0);};
 C.rotate=function(r){var c=Math.cos(r),s=Math.sin(r);this.transform(c,s,-s,c,0,0);};
 C.getTransform=function(){var m=this.__m;
  return {a:m[0],b:m[1],c:m[2],d:m[3],e:m[4],f:m[5],is2D:true,
   isIdentity:m[0]===1&&m[1]===0&&m[2]===0&&m[3]===1&&m[4]===0&&m[5]===0};};
 C.beginPath=function(){this.__subs=[];this.__cur=null;this.__start=null;};
 C.moveTo=function(x,y){this.__cur=null;this.__start=[x,y];push(this,x,y);};
 C.lineTo=function(x,y){if(this.__cur===null&&this.__start===null)this.__start=[x,y];
  push(this,x,y);};
 C.closePath=function(){if(this.__cur&&this.__start)push(this,this.__start[0],this.__start[1]);
  this.__cur=null;};
 C.bezierCurveTo=function(x1,y1,x2,y2,x,y){
  var p=this.__cur?null:0,last=this.__cur&&this.__cur.length>=2?
   this.__cur.slice(this.__cur.length-2):null;
  /* the start of the curve is where the path is now, in user space:
     it is easier to keep the user-space cursor than to invert */
  var sx=this.__ux==null?0:this.__ux, sy=this.__uy==null?0:this.__uy;
  var n=16,i,t,mt;
  for(i=1;i<=n;i++){t=i/n;mt=1-t;
   push(this,mt*mt*mt*sx+3*mt*mt*t*x1+3*mt*t*t*x2+t*t*t*x,
             mt*mt*mt*sy+3*mt*mt*t*y1+3*mt*t*t*y2+t*t*t*y);}
  this.__ux=x;this.__uy=y;};
 C.quadraticCurveTo=function(cx,cy,x,y){
  var sx=this.__ux==null?0:this.__ux, sy=this.__uy==null?0:this.__uy;
  var n=12,i,t,mt;
  for(i=1;i<=n;i++){t=i/n;mt=1-t;
   push(this,mt*mt*sx+2*mt*t*cx+t*t*x, mt*mt*sy+2*mt*t*cy+t*t*y);}
  this.__ux=x;this.__uy=y;};
 C.arc=function(x,y,r,a0,a1,ccw){
  if(!(r>0))r=0;
  var span=a1-a0,i,n,step;
  if(ccw){ if(span>0)span-=Math.ceil(span/(2*Math.PI))*2*Math.PI;
   if(span<=-2*Math.PI)span=-2*Math.PI; }
  else { if(span<0)span+=Math.ceil(-span/(2*Math.PI))*2*Math.PI;
   if(span>=2*Math.PI)span=2*Math.PI; }
  n=Math.max(4,Math.ceil(Math.abs(span)*Math.max(4,Math.min(48,r*scaleOf(this)/2))/1.5));
  if(n>256)n=256;
  step=span/n;
  for(i=0;i<=n;i++)push(this,x+r*Math.cos(a0+step*i),y+r*Math.sin(a0+step*i));
  this.__ux=x+r*Math.cos(a1);this.__uy=y+r*Math.sin(a1);};
 C.ellipse=function(x,y,rx,ry,rot,a0,a1,ccw){
  var span=a1-a0,i,n,t,cx,cy,co=Math.cos(rot||0),si=Math.sin(rot||0);
  if(ccw&&span>0)span-=2*Math.PI; if(!ccw&&span<0)span+=2*Math.PI;
  n=Math.max(8,Math.min(128,Math.ceil(Math.abs(span)*12)));
  for(i=0;i<=n;i++){t=a0+span*i/n;cx=rx*Math.cos(t);cy=ry*Math.sin(t);
   push(this,x+cx*co-cy*si,y+cx*si+cy*co);}};
 C.arcTo=function(x1,y1,x2,y2,r){ this.lineTo(x1,y1); this.lineTo(x2,y2); };
 C.rect=function(x,y,w,h){this.__cur=null;this.__start=[x,y];
  push(this,x,y);push(this,x+w,y);push(this,x+w,y+h);push(this,x,y+h);
  push(this,x,y);this.__cur=null;this.__ux=x;this.__uy=y;};
 C.roundRect=function(x,y,w,h,r){this.rect(x,y,w,h);};
 function flatten(c){
  var subs=c.__subs,counts=[],total=0,i,j;
  for(i=0;i<subs.length;i++){if(subs[i].length>=4){counts.push(subs[i].length/2);
   total+=subs[i].length;}}
  if(counts.length===0)return null;
  var pts=new Float64Array(total),at=0;
  for(i=0;i<subs.length;i++){if(subs[i].length<4)continue;
   for(j=0;j<subs[i].length;j++)pts[at++]=subs[i][j];}
  return {pts:pts,counts:counts};}
 /* What the rasteriser is asked to lay down: a colour, or a gradient
    flattened to [kind,x0,y0,r0,x1,y1,r1,angle, offset,colour, ...] with
    its geometry put through the current transform, because a gradient
    is defined in the user space of the fill that uses it. A radius
    takes the transform's average scale, so a circle under a stretched
    transform stays a circle rather than becoming the ellipse it should
    be; charts scale evenly and do not notice. */
 function paintOf(c,style,alpha){
  if(!style||typeof style!=='object'||!style.__g)
   return canvasColour(style,alpha);
  var g=style.__g,sc=scaleOf(c),m=c.__m,i;
  var a=tx(c,g[0],g[1]),b=tx(c,g[3],g[4]);
  var out=[style.__kind,a[0],a[1],g[2]*sc,b[0],b[1],g[5]*sc,
           (g[6]||0)+Math.atan2(m[1],m[0])];
  for(i=0;i<style.__stops.length;i++){
   out.push(style.__stops[i][0],canvasColour(style.__stops[i][1],alpha));}
  return out;}
 function draw(c,mode){
  if(!c.canvas||typeof __vitaCanvasPath!=='function')return;
  var f=flatten(c);if(!f)return;
  var paint=paintOf(c,mode===2?c.strokeStyle:c.fillStyle,c.globalAlpha);
  __vitaCanvasPath(c.canvas,f.pts,f.counts,paint,mode,
   mode===2?Math.abs(c.lineWidth*scaleOf(c)):0);}
 C.fill=function(rule){draw(this,String(rule)==='evenodd'?1:0);};
 C.stroke=function(){draw(this,2);};
 C.clearRect=function(x,y,w,h){
  if(!this.canvas||typeof __vitaCanvasClear!=='function')return;
  var a=tx(this,x,y),b=tx(this,x+w,y+h);
  __vitaCanvasClear(this.canvas,Math.min(a[0],b[0]),Math.min(a[1],b[1]),
   Math.abs(b[0]-a[0]),Math.abs(b[1]-a[1]));};
 C.fillRect=function(x,y,w,h){var keep=this.__subs,kc=this.__cur,ks=this.__start;
  this.__subs=[];this.__cur=null;this.rect(x,y,w,h);draw(this,0);
  this.__subs=keep;this.__cur=kc;this.__start=ks;};
 C.strokeRect=function(x,y,w,h){var keep=this.__subs,kc=this.__cur,ks=this.__start;
  this.__subs=[];this.__cur=null;this.rect(x,y,w,h);draw(this,2);
  this.__subs=keep;this.__cur=kc;this.__start=ks;};
 C.reset=function(){this.__m=[1,0,0,1,0,0];this.beginPath();
  if(this.canvas&&typeof __vitaCanvasClear==='function')
   __vitaCanvasClear(this.canvas,0,0,this.canvas.width||300,this.canvas.height||150);};
 /* the font shorthand, as much of it as a chart uses: an optional
    style and weight, then the size, then the families */
 function fontOf(c){
  var f=String(c.font||'10px sans-serif');
  var size=parseFloat(f)||10;
  if(/\d(pt)\b/.test(f))size=size*96/72;
  if(/\dem\b/.test(f))size=size*16;
  var weight=/\b(bold|bolder|[6-9]00)\b/i.test(f)?700:400;
  var m=/\b([1-9]00)\b/.exec(f);if(m)weight=parseInt(m[1],10);
  var italic=/\b(italic|oblique)\b/i.test(f);
  var fam=0;
  if(/monospace|courier|consolas|menlo/i.test(f))fam=2;
  else if(/serif/i.test(f)&&!/sans-serif/i.test(f))fam=1;
  else if(/cursive/i.test(f))fam=3;
  else if(/fantasy/i.test(f))fam=4;
  return {size:size,weight:weight,italic:italic,family:fam};}
 function alignOf(c){var a=String(c.textAlign||'start');
  if(a==='center')return 1;
  if(a==='right'||a==='end')return 2;
  return 0;}
 function baselineOf(c){var b=String(c.textBaseline||'alphabetic');
  if(b==='top'||b==='hanging')return 1;
  if(b==='middle')return 2;
  if(b==='bottom'||b==='ideographic')return 3;
  return 0;}
 function text(c,str,x,y,colour){
  if(!c.canvas||typeof __vitaCanvasText!=='function')return;
  var f=fontOf(c),p=tx(c,x,y),sc=scaleOf(c);
  __vitaCanvasText(c.canvas,p[0],p[1],String(str),colour,f.size*sc,
   f.family,f.weight,f.italic?1:0,alignOf(c),baselineOf(c));}
 C.fillText=function(str,x,y){text(this,str,x,y,
  paintOf(this,this.fillStyle,this.globalAlpha));};
 C.strokeText=function(str,x,y){text(this,str,x,y,
  paintOf(this,this.strokeStyle,this.globalAlpha));};
 ('drawFocusIfNeeded scrollPathIntoView '+
  'setLineDash createImageBitmap').split(' ').forEach(function(k){
   C[k]=GAP('canvas.'+k);});
 C.clip=GAP('canvas.clip');
 /* drawImage(src, [sx, sy, sw, sh,] dx, dy [, dw, dh]): the source is
    another canvas, or an image the page has already loaded. The unit
    square of the destination is handed over as one matrix, so a
    rotated or scaled context draws a rotated or scaled image. */
 C.drawImage=function(src,a,b,c,d,e,f,g,h){
  if(!this.canvas||!src||typeof __vitaCanvasImage!=='function')return;
  if(typeof __vitaCanvasImageSize!=='function')return;
  var size=__vitaCanvasImageSize(src);
  if(!size)return;
  var sx=0,sy=0,sw=size[0],sh=size[1],dx,dy,dw,dh;
  if(arguments.length>=9){sx=+a;sy=+b;sw=+c;sh=+d;dx=+e;dy=+f;dw=+g;dh=+h;}
  else if(arguments.length>=5){dx=+a;dy=+b;dw=+c;dh=+d;}
  else {dx=+a;dy=+b;dw=sw;dh=sh;}
  if(!(sw>0)||!(sh>0)||!(dw!==0)||!(dh!==0))return;
  var m=this.__m;
  /* the context transform with translate(dx,dy) and scale(dw,dh)
     folded in, which is exactly the unit square the rasteriser wants */
  var mm=[m[0]*dw,m[1]*dw,m[2]*dh,m[3]*dh,
          m[0]*dx+m[2]*dy+m[4],m[1]*dx+m[3]*dy+m[5]];
  __vitaCanvasImage(this.canvas,src,sx,sy,sw,sh,mm,this.globalAlpha,
   this.imageSmoothingEnabled?1:0);};
 C.getImageData=function(x,y,w,h){
  x=Math.floor(+x||0);y=Math.floor(+y||0);
  w=Math.floor(+w||0);h=Math.floor(+h||0);
  if(w<0){x+=w;w=-w;} if(h<0){y+=h;h=-h;}
  var d=new ImageData(w,h);
  if(!this.canvas||w===0||h===0||typeof __vitaCanvasRead!=='function')return d;
  var buf=__vitaCanvasRead(this.canvas,x,y,w,h);
  if(buf)d.data=new Uint8ClampedArray(buf);
  return d;};
 C.putImageData=function(d,dx,dy,sx,sy,sw,sh){
  if(!this.canvas||!d||!d.data||typeof __vitaCanvasWrite!=='function')return;
  dx=Math.floor(+dx||0);dy=Math.floor(+dy||0);
  if(arguments.length<7){sx=0;sy=0;sw=d.width;sh=d.height;}
  else{sx=Math.floor(+sx||0);sy=Math.floor(+sy||0);
   sw=Math.floor(+sw||0);sh=Math.floor(+sh||0);
   if(sw<0){sx+=sw;sw=-sw;} if(sh<0){sy+=sh;sh=-sh;}}
  __vitaCanvasWrite(this.canvas,d.data,d.width,d.height,
   sx,sy,sw,sh,dx+sx,dy+sy);};
 C.isPointInPath=C.isPointInStroke=function(){return false;};
 C.getLineDash=function(){return [];};
 /* the width the glyphs actually take, so text a page centres or
    boxes it sizes by measuring lands where it should */
 C.measureText=function(t){var f=fontOf(this);
  if(typeof __vitaCanvasMeasure==='function'){
   return new TextMetrics(__vitaCanvasMeasure(String(t),f.size,f.family,
    f.weight,f.italic?1:0));}
  return new TextMetrics(String(t).length*f.size*0.5);};
 C.createLinearGradient=function(x0,y0,x1,y1){
  return new CanvasGradient(1,[+x0||0,+y0||0,0,+x1||0,+y1||0,0,0]);};
 C.createRadialGradient=function(x0,y0,r0,x1,y1,r1){
  return new CanvasGradient(2,[+x0||0,+y0||0,Math.max(0,+r0||0),
   +x1||0,+y1||0,Math.max(0,+r1||0),0]);};
 C.createConicGradient=function(a,x,y){
  return new CanvasGradient(3,[+x||0,+y||0,0,+x||0,+y||0,0,+a||0]);};
 C.createPattern=function(){return new CanvasPattern();};
 C.createImageData=function(w,h){return typeof w==='object'?
  new ImageData(w.width,w.height):new ImageData(w,h);};
 C.getContextAttributes=function(){return {alpha:true,desynchronized:false,
  colorSpace:'srgb',willReadFrequently:false};};})();
W.CanvasRenderingContext2D=CanvasRenderingContext2D;
W.OffscreenCanvasRenderingContext2D=CanvasRenderingContext2D;
W.CanvasGradient=CanvasGradient;W.CanvasPattern=CanvasPattern;W.Path2D=Path2D;
W.ImageData=ImageData;W.TextMetrics=TextMetrics;
W.ImageBitmap=function(){this.width=0;this.height=0;this.close=function(){};};
W.ImageBitmapRenderingContext=function(){this.transferFromImageBitmap=function(){};};
P.getContext=function(kind){
 if(this.tagName!=='CANVAS')return null;
 kind=String(kind||'2d');
 if(kind==='bitmaprenderer')return new W.ImageBitmapRenderingContext();
 /* No WebGL: a page that asks for it must take its fallback path, and a
    context that answers every call while drawing nothing would keep it
    from ever doing that. */
 if(kind.indexOf('webgl')===0||kind==='webgpu'){
  if(typeof __vitaGap==='function')__vitaGap('canvas.getContext('+kind+')');
  return null;}
 if(!this.__ctx2d)Object.defineProperty(this,'__ctx2d',
  {configurable:true,writable:true,value:new CanvasRenderingContext2D(this)});
 return this.__ctx2d;};
/* A 1x1 transparent PNG: a real image, so code that assigns it to an
   img src or measures it does not fail on a made-up string. */
var BLANK_PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA'+
 'C0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
P.toDataURL=function(){return this.tagName==='CANVAS'?BLANK_PNG:'';};
P.toBlob=function(cb){if(typeof cb==='function')setTimeout(function(){cb(null);},0);};
P.transferControlToOffscreen=function(){return this;};
P.getSVGDocument=function(){return null;};
W.OffscreenCanvas=function(w,h){this.width=w|0;this.height=h|0;
 this.getContext=function(k){return String(k)==='2d'?new CanvasRenderingContext2D(this):null;};
 this.convertToBlob=function(){return Promise.resolve(null);};
 this.transferToImageBitmap=function(){return new W.ImageBitmap();};};

/* --- files --------------------------------------------------------------
 * A blob holds its text, so FileReader reads it back and fetch resolves
 * an object URL from the table below rather than going to the network
 * with a blob: scheme it cannot handle.
 */
var blobURLs={},blobSeq=0;
/* Object URLs are one table for an origin's windows, as a browser keeps
 * them: one made in a frame of the page's origin -- a blank one among
 * them -- is fetched or started as a worker by the page, and the other
 * way round. Each window kept its own, so claude.ai's challenge, which
 * makes its worker's object URL with one window's URL and starts it with
 * another's Worker, was told "Failed to load the worker's script". The
 * table is the topmost same-origin window's. */
try{Object.defineProperty(W,'__vitaBlobURLs',{value:blobURLs});}catch(e){}
function blobTable(){
 var w=W,p,t;
 try{
  for(;;){p=w.parent;if(!p||p===w||p.origin!==W.origin)break;w=p;}
  t=w.__vitaBlobURLs;}catch(e){}
 return t||blobURLs;}
/* A blob holds bytes. It used to hold a string, so a blob made from a
   buffer was decoded as text on the way in and re-encoded on the way
   out, which does not survive anything that is not text. */
function Blob(parts,opts){
 opts=opts||{};
 var chunks=[],total=0;
 [].forEach.call(parts||[],function(p){
  var u;
  if(p&&p._u instanceof Uint8Array)u=p._u;
  else if(p instanceof ArrayBuffer)u=new Uint8Array(p);
  else if(ArrayBuffer.isView&&ArrayBuffer.isView(p))
   u=new Uint8Array(p.buffer,p.byteOffset,p.byteLength);
  else u=new TextEncoder().encode(String(p));
  chunks.push(u);total+=u.length;});
 var all=new Uint8Array(total),at=0,i;
 for(i=0;i<chunks.length;i++){all.set(chunks[i],at);at+=chunks[i].length;}
 this._u=all;this.type=String(opts.type||'');
 Object.defineProperty(this,'size',{configurable:true,value:total});}
Object.defineProperty(Blob.prototype,'_t',{configurable:true,
 get:function(){return new TextDecoder().decode(this._u);}});
Blob.prototype.text=function(){return Promise.resolve(this._t);};
Blob.prototype.arrayBuffer=function(){
 var u=this._u;
 return Promise.resolve(u.buffer.slice(u.byteOffset,u.byteOffset+u.length));};
Blob.prototype.bytes=function(){return Promise.resolve(new Uint8Array(this._u));};
Blob.prototype.slice=function(a,b,type){
 /* bytes, not characters: slicing the decoded text cut multi-byte
    sequences in half and made nonsense of anything binary */
 var u=this._u,n=u.length;
 a=a===undefined?0:(a<0?Math.max(n+a,0):Math.min(a,n));
 b=b===undefined?n:(b<0?Math.max(n+b,0):Math.min(b,n));
 return new Blob([u.subarray(a,Math.max(a,b))],{type:type||''});};
/* Blob.prototype.stream is a real ReadableStream; see streams.js. */
Object.defineProperty(Blob.prototype,Symbol.toStringTag,{configurable:true,value:'Blob'});
W.Blob=Blob;
function File(parts,name,opts){Blob.call(this,parts,opts);
 this.name=String(name);this.lastModified=(opts&&opts.lastModified)||Date.now();
 this.webkitRelativePath='';}
File.prototype=Object.create(Blob.prototype);File.prototype.constructor=File;
Object.defineProperty(File.prototype,Symbol.toStringTag,{configurable:true,value:'File'});
W.File=File;
W.FileList=function(){Object.defineProperty(this,'length',{configurable:true,value:0});};
W.FileList.prototype.item=function(i){return this[i]||null;};
function FileReader(){this.readyState=0;this.result=null;this.error=null;
 this.onload=null;this.onloadend=null;this.onerror=null;this.onabort=null;
 this.onloadstart=null;this.onprogress=null;this._l={};}
FileReader.EMPTY=0;FileReader.LOADING=1;FileReader.DONE=2;
FileReader.prototype.addEventListener=function(t,f){(this._l[t]=this._l[t]||[]).push(f);};
FileReader.prototype.removeEventListener=function(t,f){
 this._l[t]=(this._l[t]||[]).filter(function(g){return g!==f;});};
FileReader.prototype.dispatchEvent=function(){return true;};
FileReader.prototype._fire=function(t){var e={type:t,target:this};
 if(typeof this['on'+t]==='function')this['on'+t](e);
 (this._l[t]||[]).forEach(function(f){f(e);});};
FileReader.prototype._read=function(blob,make){
 var self=this;self.readyState=1;self._fire('loadstart');
 setTimeout(function(){
  self.result=make(blob&&blob._u?blob._u:new Uint8Array(0));
  self.readyState=2;
  self._fire('load');self._fire('loadend');},0);};
FileReader.prototype.readAsText=function(b){
 this._read(b,function(u){return new TextDecoder().decode(u);});};
FileReader.prototype.readAsDataURL=function(b){var type=(b&&b.type)||'application/octet-stream';
 this._read(b,function(u){
  var s='',i;
  for(i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);
  return 'data:'+type+';base64,'+W.btoa(s);});};
FileReader.prototype.readAsArrayBuffer=function(b){
 this._read(b,function(u){
  return u.buffer.slice(u.byteOffset,u.byteOffset+u.length);});};
FileReader.prototype.readAsBinaryString=function(b){
 this._read(b,function(u){
  var s='',i;
  for(i=0;i<u.length;i++)s+=String.fromCharCode(u[i]);
  return s;});};
FileReader.prototype.abort=function(){this.readyState=2;this._fire('abort');};
W.FileReader=FileReader;
W.FileReaderSync=function(){};
W.FileReaderSync.prototype.readAsText=function(b){return b?b._t||'':'';};
/* blob:, the origin and a UUID, as a browser makes it: the page's whole
   address with a counter was a URL whose origin read as null */
URL.createObjectURL=function(o){
 var c=W.crypto,id=c&&typeof c.randomUUID==='function'?c.randomUUID():
  String(++blobSeq);
 var u='blob:'+W.origin+'/'+id;
 blobTable()[u]=o;return u;};
URL.revokeObjectURL=function(u){delete blobTable()[String(u)];};
/* A module imported from an object URL or a data: URL has nothing to
   fetch: qjs.c asks here for its text, or null if there is none. */
W.__vitaLocalModule=function(u){
 u=String(u);
 if(u.indexOf('blob:')===0){
  var b=blobTable()[u];
  return b===undefined?null:(b._t!==undefined?b._t:String(b));}
 var m=/^data:([^,]*),/i.exec(u);
 if(!m)return null;
 try{
  var body=decodeURIComponent(u.slice(m[0].length));
  if(!/;base64$/i.test(m[1]))return body;
  var s=W.atob(body),a=new Uint8Array(s.length),i;
  for(i=0;i<s.length;i++)a[i]=s.charCodeAt(i);
  return new TextDecoder().decode(a);
 }catch(e){return null;}};
(function(){var F=W.FormData&&W.FormData.prototype;
 if(!F||F.append)return;
 F.append=function(k,v){this._p.push([String(k),v]);};
 F.set=function(k,v){this['delete'](k);this.append(k,v);};
 F.get=function(k){for(var i=0;i<this._p.length;i++)if(this._p[i][0]===k)return this._p[i][1];return null;};
 F.getAll=function(k){return this._p.filter(function(e){return e[0]===k;}).map(function(e){return e[1];});};
 F.has=function(k){return this.get(k)!==null;};
 F['delete']=function(k){this._p=this._p.filter(function(e){return e[0]!==k;});};
 F.forEach=function(f,t){this._p.forEach(function(e){f.call(t,e[1],e[0],this);},this);};
 F.keys=function(){return this._p.map(function(e){return e[0];})[Symbol.iterator]();};
 F.values=function(){return this._p.map(function(e){return e[1];})[Symbol.iterator]();};
 F.entries=function(){return this._p.map(function(e){return [e[0],e[1]];})[Symbol.iterator]();};
 F[Symbol.iterator]=F.entries;})();

/* --- the last of the element members ------------------------------------ */
reflectString([['vAlign','valign'],['cellPadding','cellpadding'],['cellSpacing','cellspacing'],
 ['dateTime','datetime'],['valueType','valuetype'],'version','clear','allow','srclang','kind',
 ['longDesc','longdesc'],'behavior','direction',['scrollAmount','scrollamount'],
 ['scrollDelay','scrolldelay']]);
reflectBool([['trueSpeed','truespeed']]);
['high','low','optimum'].forEach(function(k){Object.defineProperty(P,k,{configurable:true,
 get:function(){var v=parseFloat(this.getAttribute(k));return isNaN(v)?(k==='low'?0:1):v;},
 set:function(v){this.setAttribute(k,String(v));}});});
Object.defineProperty(P,'position',{configurable:true,get:function(){
 if(this.tagName!=='PROGRESS')return undefined;
 return this.hasAttribute('value')?
  (parseFloat(this.getAttribute('value'))||0)/(parseFloat(this.getAttribute('max'))||1):-1;}});
Object.defineProperty(P,'cellIndex',{configurable:true,get:function(){
 if(this.tagName!=='TD'&&this.tagName!=='TH')return -1;
 var c=this.parentNode?this.parentNode.cells:null;return c?c.indexOf(this):-1;}});
Object.defineProperty(P,'control',{configurable:true,get:function(){
 if(this.tagName!=='LABEL')return null;
 var f=this.getAttribute('for');
 if(f)return D.getElementById(f);
 return this.querySelector('input,select,textarea,button');}});
Object.defineProperty(P,'areas',{configurable:true,get:function(){
 return this.tagName==='MAP'?this.getElementsByTagName('area'):undefined;}});
['videoWidth','videoHeight'].forEach(function(k,n){Object.defineProperty(P,k,{configurable:true,
 get:function(){var b=__vitaBox(this);return b?b[2+n]:0;}});});
Object.defineProperty(P,'track',{configurable:true,get:function(){
 if(this.tagName!=='TRACK')return undefined;
 return {kind:this.kind,label:this.label,language:this.srclang,mode:'disabled',
  cues:[],activeCues:[],addCue:function(){},removeCue:function(){},
  addEventListener:function(){},removeEventListener:function(){}};}});
P.stop=function(){};
/* DocumentFragment.getElementById, and a document of its own, which
 * has to walk its tree rather than ask the page's index. An element
 * has no getElementById at all: code tells a document from an element
 * by asking whether it has one. */
P.getElementById=function(id){
 if(this.nodeType===9||this.nodeType===11)return docById(this,id);
 return null;};

/* --- the interfaces a feature-patching loop reads ----------------------- */
W.XMLSerializer=function(){};
W.XMLSerializer.prototype.serializeToString=function(n){
 return n&&n.outerHTML!==undefined?(n.outerHTML||n.innerHTML||''):String(n);};
W.Notification=function(title,opts){this.title=String(title);opts=opts||{};
 this.body=opts.body||'';this.icon=opts.icon||'';this.tag=opts.tag||'';this.data=opts.data;
 this.onclick=null;this.onclose=null;this.onerror=null;this.onshow=null;
 this.close=function(){};this.addEventListener=function(){};this.removeEventListener=function(){};};
W.Notification.permission='denied';
W.Notification.maxActions=0;
W.Notification.requestPermission=function(cb){
 if(typeof cb==='function')cb('denied');
 return Promise.resolve('denied');};
W.UserActivation=function(){this.hasBeenActive=true;this.isActive=false;};
W.External=function(){};
W.VisualViewport=function(){};
W.MediaQueryList=function(){};
W.MediaQueryListEvent=eventClass('MediaQueryListEvent',{media:'',matches:false});
W.StyleSheetList=function(){};
W.StyleSheetList.prototype.item=function(i){return this[i]||null;};
W.DOMStringList=function(){};
W.DOMStringList.prototype.item=function(i){return this[i]||null;};
W.DOMStringList.prototype.contains=function(){return false;};
W.CSSRuleList=function(){};
W.CSSRuleList.prototype.item=function(i){return this[i]||null;};
W.CSSStyleRule.prototype.styleMap=null;
['MimeType','MimeTypeArray','Plugin','PluginArray','TextTrack','TextTrackCue','TextTrackCueList',
 'TextTrackList','AudioTrack','AudioTrackList','VideoTrack','VideoTrackList','AnimationEffect',
 'KeyframeEffect','DocumentTimeline','ElementInternals','CustomElementRegistry', 'IntersectionObserverEntry','ResizeObserverEntry','ResizeObserverSize','CaretPosition',
 'CSSGroupingRule','CSSImportRule','CSSPageRule','CSSNamespaceRule','StylePropertyMap',
 'StylePropertyMapReadOnly','PerformanceNavigation','PerformanceTiming','XPathExpression',
 'XPathNSResolver','DataTransferItem','DataTransferItemList','NavigationHistoryEntry']
 .forEach(function(n){if(W[n]===undefined)W[n]=function(){};});
['CommandEvent','PageRevealEvent','PageSwapEvent','TrackEvent','TextEvent'].forEach(function(n){
 if(W[n]===undefined)eventClass(n,{});});
W.CompositionEvent.prototype.initCompositionEvent=function(t,b,c,v,d){
 this.type=t;this.bubbles=!!b;this.cancelable=!!c;this.view=v;this.data=d||'';};
(function(){var T=W.TimeRanges;if(T){T.prototype.start=function(){return 0;};
 T.prototype.end=function(){return 0;};}})();
(function(){var d=W.DataTransfer;if(!d)return;
 d.prototype.dropEffect='none';d.prototype.effectAllowed='uninitialized';
 d.prototype.setDragImage=function(){};})();
if(W.AbortSignal&&!W.AbortSignal.abort)W.AbortSignal.abort=function(reason){
 var c=new AbortController();c.abort(reason);return c.signal;};
if(W.Headers&&!W.Headers.prototype.getSetCookie)
 W.Headers.prototype.getSetCookie=function(){return [];};
W.TextEncoder.prototype.encodeInto=function(s,dest){
 var a=this.encode(s),n=Math.min(a.length,dest.length);
 for(var i=0;i<n;i++)dest[i]=a[i];
 return {read:s.length,written:n};};

Object.defineProperty(W.XMLHttpRequest.prototype,'responseXML',{configurable:true,
 get:function(){if(!this.responseText)return null;
  var d=D.createElement('div');d.innerHTML=this.responseText;return d;}});
if(W.performance&&!W.performance.toJSON)W.performance.toJSON=function(){
 return {timeOrigin:0,timing:this.timing,navigation:this.navigation};};
W.RadioNodeList=function(){};
Object.defineProperty(W.RadioNodeList.prototype,'value',{configurable:true,
 get:function(){return '';},set:function(){}});
W.DocumentType=function(){this.name='html';this.publicId='';this.systemId='';
 this.nodeType=10;this.nodeName='html';};
['before','after','replaceWith','remove'].forEach(function(k){
 W.DocumentType.prototype[k]=function(){};});
Object.defineProperty(D,'doctype',{configurable:true,get:function(){return new W.DocumentType();}});
if(!W.CSS)W.CSS={};
W.CSS.escape=W.CSS.escape||function(s){return String(s).replace(/([^\w-])/g,'\\$1');};
/* CSS.supports(property, value) and CSS.supports(condition), answered
   by the same parser that judges @supports in a style sheet (VitaSurf).
   A condition that does not parse is tried again in brackets, as the
   spec says, so "display: grid" works as well as "(display: grid)". */
W.CSS.supports=function(a,b){
 if(arguments.length===0)throw new TypeError("CSS.supports: at least 1 argument required");
 if(typeof __vitaCSSSupports!=='function')return false;
 if(arguments.length>=2){
  var p=String(a),v=String(b);
  /* a custom property takes any value that is not empty */
  if(/^--/.test(p))return /\S/.test(v);
  return __vitaCSSSupports('('+p+':'+v+')');}
 var c=String(a);
 return __vitaCSSSupports(c)||__vitaCSSSupports('('+c+')');};
/* fetch of an object URL comes from the table, not from the network. */
(function(){var real=W.fetch;
 W.fetch=function(input,init){
  var u=String((input&&input.url)||input||'');
  if(u.indexOf('blob:')===0){
   var b=blobTable()[u];
   if(b===undefined)return Promise.reject(new TypeError('Failed to fetch'));
   return Promise.resolve(new Response(b._t!==undefined?b._t:String(b),
    {status:200,statusText:'OK',url:u}));}
  return real.call(this,input,init);};})();

/* --- the last of the specification surface ------------------------------
 * Interfaces a page never constructs but does read members off, once it
 * has one from a callback or a collection. They carry the members the
 * specification lists and the values this port can honestly give.
 */
['webkitanimationstart','webkitanimationend','webkitanimationiteration','webkittransitionend']
 .forEach(function(t){defineHandler(P,t);defineHandler(D,t);defineHandler(W,t);});
reflectLong([['headingReset','headingreset',0]]);
function iface(name,proto){
 var C=W[name];
 if(typeof C!=='function')C=W[name]=function(){};
 Object.keys(proto).forEach(function(k){
  if(!(k in C.prototype))C.prototype[k]=proto[k];});
 return C;}
function trackList(){return {onaddtrack:null,onchange:null,onremovetrack:null,
 getTrackById:function(){return null;},item:function(i){return this[i]||null;}};}
iface('AnimationEffect',{getTiming:function(){return {delay:0,duration:0,fill:'auto',
  iterations:1,direction:'normal',easing:'linear'};},
 getComputedTiming:function(){return {delay:0,endTime:0,activeDuration:0,localTime:null,
  progress:null,currentIteration:null,duration:0,fill:'none',iterations:1};},
 updateTiming:function(){}});
iface('KeyframeEffect',{target:null,pseudoElement:null,composite:'replace',
 getKeyframes:function(){return [];},setKeyframes:function(){}});
iface('AudioTrack',{id:'',kind:'',label:'',language:'',enabled:false});
iface('VideoTrack',{id:'',kind:'',label:'',language:'',selected:false});
iface('AudioTrackList',trackList());
iface('VideoTrackList',(function(){var t=trackList();t.selectedIndex=-1;return t;})());
iface('TextTrackList',trackList());
iface('TextTrack',{id:'',kind:'subtitles',label:'',language:'',mode:'disabled',
 cues:null,activeCues:null,inBandMetadataTrackDispatchType:'',oncuechange:null,
 addCue:function(){},removeCue:function(){}});
iface('TextTrackCue',{id:'',startTime:0,endTime:0,pauseOnExit:false,track:null,
 onenter:null,onexit:null});
iface('TextTrackCueList',{getCueById:function(){return null;},
 item:function(i){return this[i]||null;}});
iface('MimeType',{type:'',description:'',suffixes:'',enabledPlugin:null});
iface('MimeTypeArray',{item:function(i){return this[i]||null;},
 namedItem:function(){return null;}});
iface('Plugin',{name:'',description:'',filename:'',length:0,
 item:function(i){return this[i]||null;},namedItem:function(){return null;}});
iface('PluginArray',{item:function(i){return this[i]||null;},
 namedItem:function(){return null;},refresh:function(){}});
iface('ElementInternals',{form:null,labels:[],shadowRoot:null,states:null,
 validity:null,validationMessage:'',willValidate:false,
 checkValidity:function(){return true;},reportValidity:function(){return true;},
 setFormValue:function(){},setValidity:function(){}});
iface('IntersectionObserverEntry',{time:0,rootBounds:null,boundingClientRect:null,
 intersectionRect:null,isIntersecting:false,isVisible:false,intersectionRatio:0,target:null});
iface('ResizeObserverSize',{inlineSize:0,blockSize:0});
iface('ResizeObserverEntry',{target:null,contentRect:null,borderBoxSize:[],
 contentBoxSize:[],devicePixelContentBoxSize:[]});
iface('CaretPosition',{offsetNode:null,offset:0,getClientRect:function(){return null;}});
iface('DataTransferItem',{kind:'',type:'',getAsFile:function(){return null;},
 getAsString:function(cb){if(typeof cb==='function')setTimeout(function(){cb('');},0);}});
iface('DataTransferItemList',{length:0,add:function(){return null;},
 remove:function(){},clear:function(){}});
iface('StylePropertyMapReadOnly',{size:0,get:function(){return undefined;},
 getAll:function(){return [];},has:function(){return false;},forEach:function(){}});
iface('StylePropertyMap',{set:function(){},append:function(){},clear:function(){},
 'delete':function(){}});
iface('CSSGroupingRule',{cssRules:[],insertRule:function(){return 0;},deleteRule:function(){}});
iface('CSSImportRule',{href:'',layerName:null,supportsText:null,media:null,styleSheet:null});
iface('CSSNamespaceRule',{namespaceURI:'',prefix:''});
iface('CSSPageRule',{selectorText:'',style:null});
iface('XPathExpression',{evaluate:function(ctx,type){return new XPathResult([],type);}});
iface('XPathNSResolver',{lookupNamespaceURI:function(){return null;}});
iface('FileReaderSync',{readAsArrayBuffer:function(b){
  return new TextEncoder().encode(b&&b._t||'').buffer;},
 readAsBinaryString:function(b){return b&&b._t||'';},
 readAsDataURL:function(b){return 'data:'+((b&&b.type)||'')+';base64,'+W.btoa(b&&b._t||'');}});
iface('CommandEvent',{command:'',source:null});
iface('TextEvent',{data:'',initTextEvent:function(t,b,c,v,d){this.type=t;this.bubbles=!!b;
 this.cancelable=!!c;this.view=v;this.data=d||'';}});
iface('PageRevealEvent',{viewTransition:null});
iface('PageSwapEvent',{viewTransition:null,activation:null});
iface('NavigationHistoryEntry',{url:null,key:'',id:'',index:-1,sameDocument:true,
 ondispose:null,getState:function(){return undefined;}});
W.NodeFilter.acceptNode=function(){return 1;};
/* customElements is the one instance of its interface, so name it. */
W.CustomElementRegistry=function(){};
if(W.customElements&&!W.customElements.initialize)W.customElements.initialize=function(){};
if(W.customElements)Object.setPrototypeOf(W.customElements,W.CustomElementRegistry.prototype);
/* The timing objects performance already hands out. */
W.PerformanceTiming=function(){};
if(W.performance&&W.performance.timing){
 W.performance.timing.toJSON=function(){var o={},k;for(k in this)if(typeof this[k]!=='function')o[k]=this[k];return o;};
 Object.setPrototypeOf(W.performance.timing,W.PerformanceTiming.prototype);}
W.PerformanceNavigation=function(){};
if(W.performance&&W.performance.navigation){
 W.performance.navigation.toJSON=function(){return {type:this.type,redirectCount:this.redirectCount};};
 Object.setPrototypeOf(W.performance.navigation,W.PerformanceNavigation.prototype);}
/* The navigation object gains the rest of its surface. */
(function(){var n=W.navigation;if(!n)return;
 n.activation=null;n.transition=null;
 n.oncurrententrychange=n.onnavigate=n.onnavigateerror=n.onnavigatesuccess=null;
 n.reload=function(){location.reload();return {committed:Promise.resolve(),finished:Promise.resolve()};};
 n.traverseTo=function(){return {committed:Promise.resolve(),finished:Promise.resolve()};};
 n.updateCurrentEntry=function(){};})();
(function(){var d=Object.getOwnPropertyDescriptor(W,'visualViewport');
 if(!d||!d.get)return;
 Object.defineProperty(W,'visualViewport',{configurable:true,get:function(){
  var v=d.get.call(this);v.onresize=v.onscroll=v.onscrollend=null;return v;}});})();
if(W.OffscreenCanvas){W.OffscreenCanvas.prototype.oncontextlost=null;
 W.OffscreenCanvas.prototype.oncontextrestored=null;}
CanvasRenderingContext2D.prototype.lang='inherit';
CanvasRenderingContext2D.prototype.isContextLost=function(){return false;};
ImageData.prototype.pixelFormat='rgba-unorm8';
/* Blob.prototype.textStream is a real ReadableStream; see streams.js. */
/* The rest of the console. Only log, warn, error, info and debug came
 * from the bindings, and a page that calls one of the others got
 * "not a function" -- claude.ai opens its entry chunk with
 * console.assert("__process_polyfill__"), so the whole application threw
 * on its first statement and mounted nothing. None of these needs to do
 * anything clever; they need to exist and to print what they are given. */
(function(){
 var C=W.console;
 if(!C)return;
 /* What an argument says, rather than what String() makes of it.
    An object goes to the log as "[object Object]", which is how
    claude.ai's "IndexedDB state read rejected [object Object]" told us
    nothing at all about which error it had caught. A browser shows the
    contents; this shows enough of them to name the fault. */
 function describe(v,depth){
  var t=typeof v;
  if(v===null||v===undefined||t==='string'||t==='number'||t==='boolean')
   return String(v);
  if(t==='function')return 'function '+(v.name||'');
  if(t==='symbol')return String(v);
  try{
   if(v instanceof Error||
      (v.name!==undefined&&v.message!==undefined&&typeof v.stack==='string')){
    var head=(v.name||'Error')+': '+(v.message||'');
    if(v.stack){var f=String(v.stack).split('\n')[1];
     if(f)head+=' | at'+f.replace(/^\s*at/,'');}
    return head;}
   if(v.name!==undefined&&v.message!==undefined)
    return String(v.name)+': '+String(v.message);
  }catch(e){}
  if(depth>2)return Array.isArray(v)?'[...]':'{...}';
  try{
   if(Array.isArray(v)){
    var parts=v.slice(0,8).map(function(x){return describe(x,depth+1);});
    if(v.length>8)parts.push('... '+v.length+' in all');
    return '['+parts.join(', ')+']';}
   if(v instanceof Date)return v.toISOString();
   var keys=Object.keys(v),body=keys.slice(0,8).map(function(k){
    return k+': '+describe(v[k],depth+1);});
   if(keys.length>8)body.push('... '+keys.length+' keys');
   var str=String(v);
   if(str!=='[object Object]'&&body.length===0)return str;
   return '{'+body.join(', ')+'}';
  }catch(e){return '[object]';}
 }
 ['log','warn','error','info','debug'].forEach(function(k){
  var real=C[k];
  if(typeof real!=='function')return;
  C[k]=function(){
   var a=Array.prototype.map.call(arguments,function(v){
    return typeof v==='string'?v:describe(v,0);});
   return real.apply(C,a);};});
 function out(kind,args){
  try{(C[kind]||C.log).apply(C,args);}catch(e){}}
 function def(n,f){if(typeof C[n]!=='function')C[n]=f;}
 def('assert',function(ok){
  if(ok)return;
  var a=Array.prototype.slice.call(arguments,1);
  a.unshift('Assertion failed:');
  out('error',a);});
 def('trace',function(){
  var a=Array.prototype.slice.call(arguments);
  a.unshift('console.trace');
  try{a.push('\n'+(new Error()).stack);}catch(e){}
  out('log',a);});
 var groups=0;
 function group(){
  out('log',Array.prototype.slice.call(arguments));
  groups++;}
 def('group',group);
 def('groupCollapsed',group);
 def('groupEnd',function(){if(groups>0)groups--;});
 def('dir',function(v){out('log',[v]);});
 def('dirxml',function(v){out('log',[v]);});
 def('table',function(v){out('log',[v]);});
 var timers={};
 def('time',function(label){timers[String(label===undefined?'default':label)]=Date.now();});
 def('timeLog',function(label){
  var k=String(label===undefined?'default':label);
  if(!(k in timers))return;
  out('log',[k+': '+(Date.now()-timers[k])+'ms']);});
 def('timeEnd',function(label){
  var k=String(label===undefined?'default':label);
  if(!(k in timers))return;
  out('log',[k+': '+(Date.now()-timers[k])+'ms']);
  delete timers[k];});
 var counts={};
 def('count',function(label){
  var k=String(label===undefined?'default':label);
  counts[k]=(counts[k]||0)+1;
  out('log',[k+': '+counts[k]]);});
 def('countReset',function(label){
  delete counts[String(label===undefined?'default':label)];});
 def('clear',function(){});
 def('timeStamp',function(){});
 def('profile',function(){});
 def('profileEnd',function(){});
})();
/* --- font loading, fullscreen, storage (VitaSurf) ------------------------
 * The first batch of what the spec surface list says is missing. None of
 * these can do what a browser does here -- there is no font loader to
 * wait for, no fullscreen to enter and no database to write to -- but
 * each has to exist and settle, because a page that awaits
 * document.fonts.ready or opens a database and waits for a callback
 * stops where it stands if the object is not there at all.
 */
(function(){
 /* FontFaceSet. Fonts are whatever FreeType already has, so the set is
    empty and ready at once; a page gates its first paint on this. */
 function FontFace(family,source,desc){
  this.family=String(family);this.style='normal';this.weight='normal';
  this.stretch='normal';this.unicodeRange='U+0-10FFFF';this.variant='normal';
  this.featureSettings='normal';this.variationSettings='normal';
  this.display='auto';this.ascentOverride='normal';
  this.features='normal';this.palettes='normal';this.variations='normal';
  this.descentOverride='normal';this.lineGapOverride='normal';
  this.status='loaded';
  if(desc)Object.keys(desc).forEach(function(k){this[k]=desc[k];},this);
  this.loaded=Promise.resolve(this);}
 FontFace.prototype.load=function(){return Promise.resolve(this);};
 W.FontFace=FontFace;
 var faces=[];
 var fontSet={
  onloading:null,onloadingdone:null,onloadingerror:null,
  status:'loaded',
  ready:Promise.resolve(undefined),
  add:function(f){if(faces.indexOf(f)<0)faces.push(f);return this;},
  delete:function(f){var i=faces.indexOf(f);if(i<0)return false;
   faces.splice(i,1);return true;},
  clear:function(){faces.length=0;},
  check:function(){return true;},
  load:function(){return Promise.resolve([]);},
  forEach:function(f,t){faces.slice().forEach(function(v){f.call(t,v,v,this);},this);},
  keys:function(){return faces.slice()[Symbol.iterator]();},
  values:function(){return faces.slice()[Symbol.iterator]();},
  entries:function(){return faces.map(function(v){return [v,v];})[Symbol.iterator]();},
  addEventListener:function(){},removeEventListener:function(){},
  dispatchEvent:function(){return true;}};
 Object.defineProperty(fontSet,'size',{configurable:true,
  get:function(){return faces.length;}});
 fontSet[Symbol.iterator]=fontSet.values;
 Object.defineProperty(D,'fonts',{configurable:true,
  get:function(){return fontSet;}});
 fontSet.ready.then(function(){});
})();

(function(){
 /* Fullscreen. Nothing can enter it, so the state is simply "not in it"
    and the request rejects rather than hanging. */
 function notAllowed(){
  return Promise.reject(new DOMException(
   'Fullscreen is not available.','NotAllowedError'));}
 Object.defineProperty(D,'fullscreenEnabled',{configurable:true,
  get:function(){return false;}});
 Object.defineProperty(D,'fullscreenElement',{configurable:true,
  get:function(){return null;}});
 Object.defineProperty(D,'fullscreen',{configurable:true,
  get:function(){return false;}});
 if(typeof D.exitFullscreen!=='function')D.exitFullscreen=notAllowed;
 D.onfullscreenchange=null;D.onfullscreenerror=null;
 if(!('onfullscreenchange' in P))P.onfullscreenchange=null;
 if(!('onfullscreenerror' in P))P.onfullscreenerror=null;
 if(W.ShadowRoot&&W.ShadowRoot.prototype&&
    !('fullscreenElement' in W.ShadowRoot.prototype)){
  try{Object.defineProperty(W.ShadowRoot.prototype,'fullscreenElement',
   {configurable:true,get:function(){return null;}});}catch(e){}}
})();

(function(){
 /* IndexedDB. There is no store behind this, so every request fails --
    but it fails the way a request fails, asynchronously and through
    onerror, so a page that opens a database and waits is told no
    instead of waiting for ever. Pages that keep their state here fall
    back to memory, which is what claude.ai already reports doing. */
 function Request(){
  this.readyState='pending';this.result=undefined;
  this.error=new DOMException('IndexedDB is not available here.',
   'UnknownError');
  this.source=null;this.transaction=null;
  this.onsuccess=null;this.onerror=null;this.onblocked=null;
  this.onupgradeneeded=null;
  var self=this;
  setTimeout(function(){
   self.readyState='done';
   var e={type:'error',target:self,currentTarget:self,
    preventDefault:function(){},stopPropagation:function(){}};
   if(typeof self.onerror==='function'){try{self.onerror(e);}catch(x){}}
  },0);}
 Request.prototype.addEventListener=function(t,f){
  if(t==='error')this.onerror=f;
  else if(t==='success')this.onsuccess=f;};
 Request.prototype.removeEventListener=function(){};
 Request.prototype.dispatchEvent=function(){return true;};
 function IDBFactory(){}
 IDBFactory.prototype.open=function(){return new Request();};
 IDBFactory.prototype.deleteDatabase=function(){return new Request();};
 IDBFactory.prototype.databases=function(){return Promise.resolve([]);};
 IDBFactory.prototype.cmp=function(a,b){return a<b?-1:a>b?1:0;};
 W.IDBFactory=IDBFactory;
 W.IDBRequest=Request;
 W.indexedDB=new IDBFactory();
})();

(function(){
 var n=W.navigator;
 if(!n)return;
 /* StorageManager: an estimate a page can read, and no persistence. */
 if(!n.storage)n.storage={
  estimate:function(){return Promise.resolve({quota:0,usage:0,
   usageDetails:{}});},
  persist:function(){return Promise.resolve(false);},
  persisted:function(){return Promise.resolve(false);},
  getDirectory:function(){return Promise.reject(new DOMException(
   'No origin private file system here.','SecurityError'));}};
 /* Clipboard: there is no clipboard to reach, so it refuses rather
    than pretending to have copied something. */
 if(!n.clipboard)n.clipboard={
  read:function(){return Promise.reject(new DOMException(
   'The clipboard is not available.','NotAllowedError'));},
  readText:function(){return Promise.reject(new DOMException(
   'The clipboard is not available.','NotAllowedError'));},
  write:function(){return Promise.reject(new DOMException(
   'The clipboard is not available.','NotAllowedError'));},
  writeText:function(){return Promise.reject(new DOMException(
   'The clipboard is not available.','NotAllowedError'));},
  addEventListener:function(){},removeEventListener:function(){},
  dispatchEvent:function(){return true;}};
})();
/* --- gamepads, battery, vibration, entry types (VitaSurf) ---------------
 * The second batch. The Vita has buttons and a battery, but neither is
 * wired to the web platform here: the buttons drive the browser itself
 * (see vita/input) and exposing them as a Gamepad would let a page take
 * them over. So these report "nothing connected" and "cannot vibrate",
 * which is what the specification says to report when there is nothing
 * to report, and a page that feature-tests them takes its other path.
 */
(function(){
 var n=W.navigator;
 if(n&&typeof n.getGamepads!=='function')
  n.getGamepads=function(){return [];};
 if(n&&typeof n.vibrate!=='function')
  n.vibrate=function(){return false;};
 if(n&&typeof n.getBattery!=='function'){
  n.getBattery=function(){return Promise.resolve({
   charging:true,chargingTime:0,dischargingTime:Infinity,level:1,
   onchargingchange:null,onchargingtimechange:null,
   ondischargingtimechange:null,onlevelchange:null,
   addEventListener:function(){},removeEventListener:function(){},
   dispatchEvent:function(){return true;}});};}
 ['ongamepadconnected','ongamepaddisconnected'].forEach(function(k){
  if(!(k in W))W[k]=null;
  if(!(k in P))P[k]=null;});
 if(W.GamepadEvent&&W.GamepadEvent.prototype&&
    !('gamepad' in W.GamepadEvent.prototype)){
  try{Object.defineProperty(W.GamepadEvent.prototype,'gamepad',
   {configurable:true,get:function(){return this.__vitaGamepad||null;}});}
  catch(e){}}
 if(W.PerformanceObserver&&
    !('supportedEntryTypes' in W.PerformanceObserver)){
  try{Object.defineProperty(W.PerformanceObserver,'supportedEntryTypes',
   {configurable:true,
    get:function(){return ['mark','measure','navigation','resource'];}});}
  catch(e){}}
})();
(function(){var N=W.Notification;if(!N)return;var p=N.prototype;
 p.actions=[];p.badge='';p.dir='auto';p.image='';p.lang='';p.navigate='';
 p.renotify=false;p.requireInteraction=false;p.silent=null;p.timestamp=0;p.vibrate=[];})();

/* --- serialising the tree ------------------------------------------------
 * innerHTML read back as an empty string and outerHTML always did, so
 * anything that reads its own markup -- a sanitiser, a template that
 * caches what it built, a test for a marker in the page -- got nothing.
 * Serialise from the tree here; the setters still go through libdom's
 * parser, which is the half that was working.
 */
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'innerHTML');
 var VOID=' area base br col embed hr img input link meta param source track wbr ';
 var RAW=' script style textarea title ';
 function esc(t){return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
 function escAttr(t){return String(t).replace(/&/g,'&amp;').replace(/"/g,'&quot;');}
 function inner(n){
  if(n.nodeType===1){
   var tag=String(n.tagName||'').toLowerCase();
   if(RAW.indexOf(' '+tag+' ')>=0)return String(n.textContent||'');
  }
  var c=n.childNodes||[],s='';
  for(var i=0;i<c.length;i++)s+=ser(c[i]);
  return s;}
 function ser(n){
  var t=n.nodeType;
  if(t===3)return esc(n.textContent);
  if(t===8)return '<!--'+String(n.textContent||'')+'-->';
  if(t!==1)return inner(n);
  var tag=String(n.tagName||'').toLowerCase(),s='<'+tag;
  attrList(n).forEach(function(a){s+=' '+a.name+'="'+escAttr(a.value)+'"';});
  s+='>';
  if(VOID.indexOf(' '+tag+' ')>=0)return s;
  return s+shadowPart(n)+inner(n)+'</'+tag+'>';}
 /* getHTML's options: a shadow root it may write out, as the
    declarative <template> that would make it again */
 var shOpt=null;
 function shadowPart(n){
  var r=shOpt&&SH_ROOT(n),i,s;
  if(!r)return '';
  i=r.__vsInit||{};
  if(!((shOpt.serializableShadowRoots&&i.serializable)||
     (shOpt.shadowRoots&&[].indexOf.call(shOpt.shadowRoots,r)>=0)))return '';
  s='<template shadowrootmode="'+(SH_HOST(r,true)?'closed':'open')+'"';
  if(i.delegatesFocus)s+=' shadowrootdelegatesfocus=""';
  if(i.serializable)s+=' shadowrootserializable=""';
  if(i.clonable)s+=' shadowrootclonable=""';
  return s+'>'+inner(r)+'</template>';}
 /* A template's innerHTML is its content's, not its own: the children
  * were moved into the content fragment, so serialising the element
  * gave the empty string and assigning to it left the content alone. */
 function isTemplate(n){return n&&n.tagName==='TEMPLATE';}
 Object.defineProperty(P,'innerHTML',{configurable:true,
  get:function(){
   if(isTemplate(this))return inner(this.content);
   var v=(d&&d.get)?d.get.call(this):'';return v?v:inner(this);},
  set:function(v){
   if(isTemplate(this)&&
      Object.prototype.hasOwnProperty.call(this,'__content')){
    var f=this.content,g;
    while(f.firstChild)f.removeChild(f.firstChild);
    g=parseInContext(this,v===null?'':String(v));
    while(g.firstChild)f.appendChild(g.firstChild);
    return;}
   if(d&&d.set)d.set.call(this,v);}});
 Object.defineProperty(P,'outerHTML',{configurable:true,
  get:function(){return ser(this);},
  set:function(h){
   var p=this.parentNode;
   if(p===null||p===undefined)throw new DOMException(
    'The element has no parent.','NoModificationAllowedError');
   if(p.nodeType===9)throw hierarchy(
    'The element is the document element.');
   /* null means the empty string here, not the word */
   var f=parseInContext(p,h===null?'':String(h));
   p.insertBefore(f,this);
   p.removeChild(this);}});
 P.getHTML=function(o){
  if(!o||(!o.serializableShadowRoots&&!(o.shadowRoots&&o.shadowRoots.length)))
   return this.innerHTML;
  var prev=shOpt;shOpt=o;
  try{return (this.nodeType===1?shadowPart(this):'')+inner(isTemplate(this)?this.content:this);}
  finally{shOpt=prev;}};
 W.XMLSerializer.prototype.serializeToString=function(n){
  return n&&n.nodeType!==undefined?ser(n):String(n);};
})();

/* --- assignment to a read-only property --------------------------------
 * The same problem from the other side. A getter with no setter drops
 * what it is given without a word, so a component that keeps state in
 * form, list, index, mode, position, label or error finds its own value
 * gone the next time it looks. Give every one of them a setter that
 * shadows the accessor on that node, which is what assigning to a plain
 * object does. The few the custom element machinery and the tree walk
 * depend on keep their own meaning.
 */
(function(){
 /*
  * Only the tree itself is held back. shadowRoot and host in particular
  * are assigned to: a shadow DOM polyfill builds its own root object and
  * writes the host onto it, and that write being dropped is why
  * YouTube's ShadyDOM read __shady off undefined.
  */
 var KEEP=' isConnected children parentElement firstElementChild '+
  'lastElementChild childNodes parentNode firstChild lastChild nextSibling '+
  'previousSibling nodeType nodeName tagName attributes classList ownerDocument ';
 Object.getOwnPropertyNames(P).forEach(function(k){
  if(KEEP.indexOf(' '+k+' ')>=0)return;
  var d=Object.getOwnPropertyDescriptor(P,k);
  if(!d||!d.get||d.set||!d.configurable)return;
  Object.defineProperty(P,k,{configurable:true,enumerable:d.enumerable,get:d.get,
   set:function(v){shadowProp(this,k,v);}});});
})();

/* --- what the browser comparison found ---------------------------------
 * tests/dom, run against Chromium by scripts/dom-compare.sh.
 */
/* dataset was an empty object that never saw an attribute, so every
 * el.dataset.foo read undefined and every write went nowhere. It is a
 * live view of the data-* attributes. */
function dataAttr(k){return 'data-'+String(k).replace(/[A-Z]/g,function(c){return '-'+c.toLowerCase();});}
function dataName(n){return n.slice(5).replace(/-([a-z])/g,function(_,c){return c.toUpperCase();});}
function dataKeys(el){return attrList(el).filter(function(a){
 return a.name.indexOf('data-')===0;}).map(function(a){return dataName(a.name);});}
Object.defineProperty(P,'dataset',{configurable:true,get:function(){
 var el=this;
 return priv(this,'__dataset',function(){
  if(typeof Proxy!=='function'){
   var o={};dataKeys(el).forEach(function(k){o[k]=el.getAttribute(dataAttr(k));});
   return o;}
  return new Proxy({},{
   get:function(t,k){if(typeof k!=='string')return undefined;
    var v=el.getAttribute(dataAttr(k));return v===null?undefined:v;},
   set:function(t,k,v){el.setAttribute(dataAttr(k),String(v));return true;},
   has:function(t,k){return typeof k==='string'&&el.hasAttribute(dataAttr(k));},
   deleteProperty:function(t,k){el.removeAttribute(dataAttr(k));return true;},
   ownKeys:function(){return dataKeys(el);},
   getOwnPropertyDescriptor:function(t,k){
    if(typeof k!=='string'||!el.hasAttribute(dataAttr(k)))return undefined;
    return {configurable:true,enumerable:true,writable:true,
     value:el.getAttribute(dataAttr(k))};}});});}});
/* tabIndex answered 0 for everything, so every element looked focusable
 * to code that tests it. Without the attribute it is 0 only for what the
 * specification makes focusable by default, and -1 otherwise. */
var TAB_DEFAULT_0=' BUTTON INPUT SELECT TEXTAREA IFRAME SUMMARY ';
Object.defineProperty(P,'tabIndex',{configurable:true,
 get:function(){
  var v=this.getAttribute('tabindex');
  if(v!==null&&v!==''){v=parseInt(v,10);if(!isNaN(v))return v;}
  var t=this.tagName;
  if(TAB_DEFAULT_0.indexOf(' '+t+' ')>=0)return 0;
  if((t==='A'||t==='AREA')&&this.hasAttribute('href'))return 0;
  if(this.isContentEditable)return 0;
  return -1;},
 set:function(v){
  if(isOwnState(v))return shadowProp(this,'tabIndex',v);
  this.setAttribute('tabindex',String(parseInt(v,10)||0));}});

/* --- the defaults a control reports ------------------------------------
 * type was the attribute or nothing, and an input with no type attribute
 * is a text input; code switches on it.
 */
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'type');
 Object.defineProperty(P,'type',{configurable:true,
  get:function(){
   var v=this.getAttribute('type');
   if(v!==null&&v!=='')return this.tagName==='INPUT'?String(v).toLowerCase():v;
   if(this.tagName==='INPUT')return 'text';
   if(this.tagName==='BUTTON')return 'submit';
   if(this.tagName==='OL')return '1';
   return '';},
  set:d.set});
})();
/* value on a control is the current value; the attribute is the default
 * the form resets to. Writing the attribute is what makes the new value
 * render here, so keep doing that, and remember the default the first
 * time it is overwritten so defaultValue and reset still mean something.
 */
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'value');
 Object.defineProperty(P,'value',{configurable:true,get:d.get,
  set:function(v){
   if(!isOwnState(v)&&(this.tagName==='INPUT'||this.tagName==='TEXTAREA')&&
      !Object.prototype.hasOwnProperty.call(this,'__defaultValue')){
    Object.defineProperty(this,'__defaultValue',{configurable:true,
     writable:true,value:this.tagName==='TEXTAREA'?
      String(this.textContent||''):(this.getAttribute('value')||'')});
   }
   d.set.call(this,v);}});
 var dv=Object.getOwnPropertyDescriptor(P,'defaultValue');
 Object.defineProperty(P,'defaultValue',{configurable:true,
  get:function(){
   return Object.prototype.hasOwnProperty.call(this,'__defaultValue')?
    this.__defaultValue:dv.get.call(this);},
  set:dv.set});
})();

/* --- reporting an error to the page -------------------------------------
 * qjs.c calls this for every uncaught exception. window.onerror and the
 * error event never fired, so a script that installs a handler to fall
 * back when something throws heard nothing at all.
 */
/* A diagnostic, not a shim, for one specific fault: a JSON body that
 * arrived with its bytes mangled. It says where the first byte that
 * cannot be in JSON is, with the bytes around it. Costs nothing until a
 * parse fails.
 *
 * Only mangled text is reported. A failed parse on its own is not a
 * fault: Polymer decides whether an attribute holds JSON by parsing it
 * and catching, so every "[[binding]]" in a template fails by design.
 * YouTube produced forty of those in a load, each one a line flushed to
 * the memory card, and none of them a problem. */
(function(){
 var real=JSON.parse,said=0;
 JSON.parse=function(text,reviver){
  try{return real(text,reviver);}
  catch(e){
   try{
    var s=String(text),i,bad=-1;
    for(i=0;i<s.length;i++)if(s.charCodeAt(i)>127){bad=i;break;}
    if(bad>=0&&said<3){
     var at=Math.max(0,bad-8),hex='',c;
     for(i=at;i<Math.min(s.length,at+24);i++){
      c=(s.charCodeAt(i)&0xffff).toString(16);
      hex+=(c.length<2?'0':'')+c+' ';}
     said++;
     console.log('json parse failed on text with a byte over 127: '+
      String(e).slice(0,60)+'; length '+s.length+', byte at '+bad+
      ', bytes '+hex+', text '+JSON.stringify(s.slice(at,at+40))+
      (said===3?' (further ones not logged)':''));}
   }catch(x){}
   throw e;}};})();
/* What was thrown, in one line: a message and the first stack frame.
   String(err) on a plain object is "[object Object]", which says
   nothing, so the name and message are pulled out by hand. */
function describeThrown(v){
 var out;
 try{
  if(v===null||v===undefined)return String(v);
  if(typeof v==='object'){
   var name=v.name?String(v.name):'',msg=v.message?String(v.message):'';
   out=(name&&msg)?name+': '+msg:(name||msg);
   if(!out){try{out=JSON.stringify(v).slice(0,200);}catch(e){out=String(v);}}
   if(v.stack){
    /* the first frames: one alone often names only a helper. A stack
       QuickJS made has no "Name: message" line ahead of them, and
       skipping one there lost the frame that threw. */
    var fr=String(v.stack).split('\n');
    if(fr.length&&!/^\s*at /.test(fr[0]))fr=fr.slice(1);
    fr=fr.filter(function(f){return f.trim();});
    /* and past the prelude's own frames to the page's: a DOM call that
       threw is three frames of the prelude before the code that made it */
    var shown=fr.slice(0,3),page=0,i;
    for(i=3;i<fr.length&&page<4;i++)
     if(!/<prelude>|\(native\)/.test(fr[i])){shown.push(fr[i]);page++;}
    if(shown.length)out+=' | '+shown.map(function(f){return f.replace(/^\s+/,'').slice(0,160);}).join(' | ');}
   return out;}
  return String(v);
 }catch(e2){return '(unprintable)';}
}
/* kept here and not left on window, where no browser has it */
var SRC_EXCERPT=null;
try{SRC_EXCERPT=W.__vitaSourceExcerpt||null;delete W.__vitaSourceExcerpt;}catch(e){}
/* The properties a page read on window, navigator, document, screen,
   location, history and performance that are not here (VitaSurf): an
   uncaught error's report lists the last of them, which is how a log
   says what a page wanted that this browser lacks. */
var MISSES=null;
try{
 MISSES=W.__vitaMisses||null;
 (function(watch){
  if(!watch)return;
  try{watch(W,'window');}catch(e){}
  try{watch(W.navigator,'navigator');}catch(e){}
  try{watch(W.document,'document');}catch(e){}
  try{watch(W.screen,'screen');}catch(e){}
  try{watch(W.location,'location');}catch(e){}
  try{watch(W.history,'history');}catch(e){}
  try{watch(W.performance,'performance');}catch(e){}
 })(W.__vitaWatchMisses);
 delete W.__vitaMisses;delete W.__vitaWatchMisses;
}catch(e){}
W.__vitaReportError=function(err,where){
 var msg='';
 try{msg=(err&&err.message)?String(err.message):String(err);}catch(e){msg='Script error.';}
 var file=where?String(where):String(location.href),line=0,col=0;
 /* QuickJS puts "  at f (url:line:col)" in the stack; the first frame
    with a position is the one the page wants. */
 try{
  var m=/\((.*):(\d+):(\d+)\)/.exec(String(err&&err.stack||''));
  if(m){file=m[1];line=Number(m[2])||0;col=Number(m[3])||0;}
 }catch(e2){}
 var ev;
 try{ev=new W.ErrorEvent('error',{message:msg,filename:file,lineno:line,
  colno:col,error:err,bubbles:false,cancelable:true});}
 catch(e3){ev={type:'error',message:msg,filename:file,lineno:line,colno:col,
  error:err,defaultPrevented:false,preventDefault:function(){this.defaultPrevented=true;}};}
 uaEvent(ev);
 var handled=false;
 try{
  if(typeof W.onerror==='function'){
   /* onerror takes the pieces, not the event, and returning true means
      the page has dealt with it. */
   if(W.onerror(msg,file,line,col,err)===true)handled=true;}
 }catch(e4){}
 try{__vitaDispatch(null,ev);}catch(e5){}
 if(!handled&&!ev.defaultPrevented){
  /* Where the caller said it came from, when that is a description
     rather than a URL. The stack frame below overwrites `file', so a
     caller that named a subsystem -- a database event handler, say --
     had its label thrown away and the error looked like any other. */
  var from='';
  try{var w=where?String(where):'';
   if(w&&w.indexOf('://')<0&&w.charAt(0)!=='/'&&w!==String(location.href))from=w;
  }catch(e7){}
  /* the code the position points into (VitaSurf), for an error from a
     timer or a handler, whose stack alone names only minified frames */
  var near='';
  try{if(line&&SRC_EXCERPT)near=SRC_EXCERPT(file,line,col);}catch(e8){}
  try{console.error('uncaught'+(from?' in '+from:'')+': '+describeThrown(err)+
   (file?' ('+file+':'+line+':'+col+')':''));}catch(e6){}
  /* a line of its own: a log line holds 512 characters, and a long
     stack of long URLs had already filled the one above */
  if(near)try{console.error('uncaught, the code at column '+col+': '+near);}catch(e9){}
  /* and what it looked for before, that was not here */
  try{var missed=MISSES?String(MISSES()):'';
   while(missed){
    console.error('uncaught, read before it and not here: '+missed.slice(0,400));
    missed=missed.slice(400);}}catch(e10){}}
 return handled;};
/* An unhandled promise rejection, reported the same way. QuickJS hands
 * these to the tracker qjs.c installs.
 *
 * Reported one turn later, not at once: a rejection with no handler yet
 * is not an unhandled rejection, it is a promise whose .catch() has not
 * been attached. Frameworks reject first and attach in the same tick all
 * the time, and reporting on the spot called every one of them an error.
 * qjs.c calls __vitaRejectionHandled() when a handler does turn up,
 * which takes it off the list before the list is read. */
var vitaPendingRejections=[];
function flushRejections(){
 var list=vitaPendingRejections;
 vitaPendingRejections=[];
 list.forEach(function(entry){
  var ev;
  try{ev=new W.PromiseRejectionEvent('unhandledrejection',
   {reason:entry.r,promise:entry.p,cancelable:true});}
  catch(e){ev={type:'unhandledrejection',reason:entry.r,promise:entry.p,
   defaultPrevented:false,preventDefault:function(){this.defaultPrevented=true;}};}
  uaEvent(ev);
  try{if(typeof W.onunhandledrejection==='function')W.onunhandledrejection(ev);}catch(e2){}
  try{__vitaDispatch(null,ev);}catch(e3){}
  /* Say so, as a browser does. A page whose async work fails and whose
     framework swallows the rejection into an error boundary showed
     nothing at all in the log: the screen said something went wrong and
     the device had no idea what. */
  if(!ev.defaultPrevented){
   try{console.error('unhandled rejection: '+describeThrown(entry.r));}catch(e4){}}
 });
}
W.__vitaReportRejection=function(reason,promise){
 vitaPendingRejections.push({p:promise,r:reason});
 if(vitaPendingRejections.length===1)setTimeout(flushRejections,0);
 return false;};
W.__vitaRejectionHandled=function(promise){
 for(var i=0;i<vitaPendingRejections.length;i++){
  if(vitaPendingRejections[i].p===promise){
   vitaPendingRejections.splice(i,1);
   return;}}};

/* --- MutationObserver ---------------------------------------------------
 * It was a constructor whose observe() did nothing, so every framework
 * that waits to be told the DOM changed -- Polymer and ShadyDOM for slot
 * and light-DOM changes, React and lit for their own trees -- waited for
 * ever. qjs.c reports each mutation here, and only once a page has asked
 * for one: a page that never uses an observer pays nothing.
 *
 * What it sees is the mutations made through the bindings, which is every
 * mutation a script makes. It does not see the parser building the page,
 * so an observer set up to wait for markup still streaming in will not
 * fire for it. That is written down rather than papered over.
 */
function MutationRecord(type,target){
 this.type=type;this.target=target;
 this.addedNodes=[];this.removedNodes=[];
 this.previousSibling=null;this.nextSibling=null;
 this.attributeName=null;this.attributeNamespace=null;this.oldValue=null;}
W.MutationRecord=MutationRecord;

var MOlist=[],MOqueued=false,MOid=0;
/* watch id -> [observer, watch], for the ids qjs.c hands __vitaMutation */
var MOby=new Map();
function MutationObserver(cb){
 if(typeof cb!=='function')throw new TypeError(
  'The callback provided as parameter 1 is not a function.');
 this._cb=cb;this._records=[];this._watch=[];}
/* Does this observer want to hear about a change to target? */
/* Takes the target's ancestor chain rather than walking it: every
   parentNode step crosses into C, and this used to walk the whole way
   to the root once for each watch entry of each observer, on every
   mutation. A GitHub load makes 2198 setAttribute calls at a depth of
   about thirty, which cost 1.13 ms each against Wikipedia's 0.093 ms
   for the same call on the same machine. __vitaMutation now walks it
   once and hands it here, so the chain is a plain array and finding a
   watched node in it is an array scan.

   chain[0] is the target, so its index is the depth the walk used to
   count, and the nearest match is still the one found. */
MutationObserver.prototype._wants=function(kind,target,name,chain){
 var i,w,depth;
 for(i=0;i<this._watch.length;i++){
  w=this._watch[i];
  depth=chain.indexOf(w.target);
  if(depth<0)continue;
  if(depth>0&&!w.subtree)continue;
  if(kind==='childList'&&!w.childList)continue;
  if(kind==='attributes'){
   if(!w.attributes)continue;
   if(w.filter&&w.filter.indexOf(String(name).toLowerCase())<0)continue;}
  if(kind==='characterData'&&!w.characterData)continue;
  return w;}
 return null;};
MutationObserver.prototype.observe=function(target,options){
 options=options||{};
 if(!target||target.nodeType===undefined)throw new TypeError(
  'parameter 1 is not of type Node.');
 /* The specification's own order: asking for old values or a filter
    turns the category on when it was not mentioned, and contradicts it
    when it was turned off explicitly. */
 var attrs=options.attributes,cdata=options.characterData;
 if(attrs===undefined&&
    (options.attributeOldValue!==undefined||options.attributeFilter!==undefined))
  attrs=true;
 if(cdata===undefined&&options.characterDataOldValue!==undefined)
  cdata=true;
 if(!options.childList&&!attrs&&!cdata)
  throw new TypeError(
   "The options object must set at least one of 'attributes', "+
   "'characterData', or 'childList' to true.");
 if(options.attributeOldValue&&!attrs)
  throw new TypeError(
   "The options object may only set 'attributeOldValue' to true when "+
   "'attributes' is true or not present.");
 if(options.attributeFilter!==undefined&&!attrs)
  throw new TypeError(
   "The options object may only set 'attributeFilter' when 'attributes' "+
   "is true or not present.");
 if(options.characterDataOldValue&&!cdata)
  throw new TypeError(
   "The options object may only set 'characterDataOldValue' to true when "+
   "'characterData' is true or not present.");
 var w={target:target,subtree:!!options.subtree,
  childList:!!options.childList,
  attributes:!!attrs,
  characterData:!!cdata,
  attributeOldValue:!!options.attributeOldValue,
  characterDataOldValue:!!options.characterDataOldValue,
  filter:options.attributeFilter?
   [].map.call(options.attributeFilter,function(x){return String(x).toLowerCase();}):null};
 /* observing the same node twice replaces the first */
 this._watch=this._watch.filter(function(o){
  if(o.target!==target)return true;
  if(typeof __vitaMOUnwatch==='function')__vitaMOUnwatch(o.id);
  MOby.delete(o.id);
  return false;});
 /* and C keeps a copy, so a change no observer wants never reaches
    this file (VitaSurf); see mo_wanted in qjs.c */
 w.id=++MOid;
 if(typeof __vitaMOWatch==='function')
  __vitaMOWatch(w.id,target,(w.subtree?1:0)|(w.attributes?2:0)|
   (w.childList?4:0)|(w.characterData?8:0),w.filter);
 this._watch.push(w);
 MOby.set(w.id,[this,w]);
 if(MOlist.indexOf(this)<0)MOlist.push(this);
 if(typeof __vitaWatchMutations==='function')__vitaWatchMutations(true);};
MutationObserver.prototype.disconnect=function(){
 for(var i=0;i<this._watch.length;i++){
  if(typeof __vitaMOUnwatch==='function')__vitaMOUnwatch(this._watch[i].id);
  MOby.delete(this._watch[i].id);}
 this._watch=[];this._records=[];
 MOlist=MOlist.filter(function(o){return o!==this;},this);
 if(!MOlist.length&&typeof __vitaWatchMutations==='function')
  __vitaWatchMutations(false);};
MutationObserver.prototype.takeRecords=function(){
 var r=this._records;this._records=[];return r;};
W.MutationObserver=MutationObserver;
W.WebKitMutationObserver=MutationObserver;

/* Deliver every observer's queue, once, after the current task. */
function MOdeliver(){
 MOqueued=false;
 var list=MOlist.slice(),i,o,recs;
 for(i=0;i<list.length;i++){
  o=list[i];
  if(!o._records.length)continue;
  recs=o._records;o._records=[];
  try{o._cb(recs,o);}catch(e){
   if(typeof W.__vitaReportError==='function')W.__vitaReportError(e);}}}
function MOqueue(o,rec){
 o._records.push(rec);
 if(!MOqueued){MOqueued=true;
  if(typeof queueMicrotask==='function')queueMicrotask(MOdeliver);
  else Promise.resolve().then(MOdeliver);}}

/* Called from qjs.c for each mutation. a and b carry different things
   per kind: the added and removed node for childList, the attribute name
   and its old value for attributes. */
/* previousSibling and nextSibling on a childList record are the nodes
   that bracket the change, taken from whichever list still holds it:
   the new children for an addition, the old ones for a removal. */
function edgeOf(list,nodes,rec){
 var first=nodes[0],last=nodes[nodes.length-1],i,at=-1,end=-1;
 for(i=0;i<list.length;i++){
  if(list[i]===first&&at<0)at=i;
  if(list[i]===last)end=i;}
 if(at<0)return false;
 if(end<at)end=at;
 rec.previousSibling=at>0?list[at-1]:null;
 rec.nextSibling=end+1<list.length?list[end+1]:null;
 return true;}
/* A node about to be removed still knows its siblings; once it is out
   they are gone, and the before-and-after snapshots do not always carry
   them, so note them on the way past. */
var MOedges=null;
function noteEdges(n){
 MOedges=n&&n.parentNode?
  {node:n,prev:n.previousSibling||null,next:n.nextSibling||null}:null;}
/* The siblings either side of a run of nodes still under target, from
   the nodes' own links (VitaSurf). This copied target's whole child
   list for every record of every observer, and GitHub moves rows
   within a parent of hundreds: one appendChild wrapped every child four
   times over. A node reported leaving before it has left still knows
   its siblings, which the old way never gave it. */
function edgeOfRun(nodes,target,rec){
 var first=nodes[0],last=nodes[nodes.length-1];
 if(!first||first.parentNode!==target)return false;
 rec.previousSibling=first.previousSibling||null;
 rec.nextSibling=(last.parentNode===target?last:first).nextSibling||null;
 return true;}
function siblingsOf(rec,target,after,before){
 if(rec.addedNodes.length&&edgeOfRun(rec.addedNodes,target,rec))return;
 if(!rec.removedNodes.length)return;
 if(edgeOfRun(rec.removedNodes,target,rec))return;
 if(before&&before.length!==undefined&&
    edgeOf([].slice.call(before),rec.removedNodes,rec))return;
 if(MOedges&&rec.removedNodes.indexOf(MOedges.node)>=0){
  rec.previousSibling=MOedges.prev;
  rec.nextSibling=MOedges.next;}}
/* The observers that want a change, each once, with whether any of its
   watches that want it asks for the old value, as the specification's
   interested observers are. */
function MOinterested(kind,target,a,matches){
 var out=[],i,j,e,o,w,old,chain;
 if(matches){
  /* C has already found the watches that want it, nearest first
     (VitaSurf): with an observer on every card of a Home Assistant
     dashboard, asking each observer in turn was 43% of script time */
  for(i=0;i<matches.length;i++){
   e=MOby.get(matches[i]);
   if(!e)continue;
   o=e[0];w=e[1];
   old=kind==='attributes'?w.attributeOldValue:
    kind==='characterData'?w.characterDataOldValue:false;
   for(j=0;j<out.length;j+=2)if(out[j]===o)break;
   if(j<out.length){if(old)out[j+1]=true;}
   else out.push(o,old);}
  return out;}
 chain=[];
 for(e=target;e;e=e.parentNode)chain.push(e);
 for(i=0;i<MOlist.length;i++){
  o=MOlist[i];
  w=o._wants(kind,target,kind==='attributes'?a:null,chain);
  if(!w)continue;
  out.push(o,kind==='attributes'?w.attributeOldValue:
   kind==='characterData'?w.characterDataOldValue:false);}
 return out;}
W.__vitaMutation=function(kind,target,a,b,ns,matches){
 if(!MOlist.length||!target)return;
 var i,o,old,rec,list=MOinterested(kind,target,a,matches);
 for(i=0;i<list.length;i+=2){
  o=list[i];old=list[i+1];
  rec=new MutationRecord(kind,target);
  if(kind==='attributes'){
   rec.attributeName=String(a);
   rec.attributeNamespace=(ns===undefined||ns===null)?null:String(ns);
   if(old)rec.oldValue=b===null?null:String(b);
  }else if(kind==='characterData'){
   if(old)rec.oldValue=b===null?null:String(b);
  }else{
   /* a and b are either single nodes or before-and-after child arrays */
   if(a&&a.nodeType!==undefined)rec.addedNodes=[a];
   else if(a&&a.length!==undefined)rec.addedNodes=[].slice.call(a);
   if(b&&b.nodeType!==undefined)rec.removedNodes=[b];
   else if(b&&b.length!==undefined)rec.removedNodes=[].slice.call(b);
   /* a replaced set is reported as what went and what came, not both */
   if(rec.addedNodes.length&&rec.removedNodes.length){
    var gone=rec.removedNodes,came=rec.addedNodes;
    rec.removedNodes=gone.filter(function(n){return came.indexOf(n)<0;});
    rec.addedNodes=came.filter(function(n){return gone.indexOf(n)<0;});
    if(!rec.addedNodes.length&&!rec.removedNodes.length)continue;}
   /* the siblings the change sat between, which is how an observer
      works out where in the list something happened */
   siblingsOf(rec,target,a,b);
  }
  MOqueue(o,rec);}};

/* --- what the web platform tests found ---------------------------------- */
/* A class attribute is split on ASCII whitespace, not on the space
 * character: a tab or a newline between two class names is a separator
 * too, and getElementsByClassName found nothing for either. */
function byClassName(root,names){
 var want=String(names).split(CLASS_WS).filter(function(x){return x!=='';});
 if(!want.length)return [];
 /* matched in C: the walk in JavaScript over a live '*' collection was
    two whole-document walks per element */
 return W.__vitaFind(root,[{classes:want}]);}
P.getElementsByClassName=function(n){return byClassName(this,n);};
D.getElementsByClassName=function(n){
 var r=D.documentElement;return r?byClassName(r,n):[];};

/* --- character data, by the specification's index rules ------------------
 * The methods took whatever number they were given and let String do the
 * rest, so a negative offset counted from the end instead of throwing and
 * a count past the end came back short.
 */
function toULong(v){
 v=Number(v);
 if(!isFinite(v))v=0;
 v=v<0?Math.ceil(v):Math.floor(v);
 v=v%4294967296;
 if(v<0)v+=4294967296;
 return v;}
function cdText(n){return String(n.textContent===null||n.textContent===undefined?'':n.textContent);}
function cdCheck(n,o){
 if(o>cdText(n).length)throw new DOMException(
  'The index is not in the allowed range.','IndexSizeError');}
function needArgs(got,want,name){
 /* A real TypeError: code catches these by constructor, and a
    DOMException that merely calls itself TypeError is not one. */
 if(got<want)throw new TypeError(
  "Failed to execute '"+name+"': "+want+" arguments required, but only "+
  got+' present.');}
P.substringData=function(offset,count){
 needArgs(arguments.length,2,'substringData');
 var t=cdText(this),o=toULong(offset),c=toULong(count);
 cdCheck(this,o);
 return t.slice(o,(o+c>t.length)?t.length:o+c);};
P.appendData=function(data){
 needArgs(arguments.length,1,'appendData');
 this.textContent=cdText(this)+String(data);};
P.insertData=function(offset,data){
 needArgs(arguments.length,2,'insertData');
 var t=cdText(this),o=toULong(offset);
 cdCheck(this,o);
 this.textContent=t.slice(0,o)+String(data)+t.slice(o);};
P.deleteData=function(offset,count){
 needArgs(arguments.length,2,'deleteData');
 var t=cdText(this),o=toULong(offset),c=toULong(count);
 cdCheck(this,o);
 if(o+c>t.length)c=t.length-o;
 this.textContent=t.slice(0,o)+t.slice(o+c);};
P.replaceData=function(offset,count,data){
 needArgs(arguments.length,3,'replaceData');
 var t=cdText(this),o=toULong(offset),c=toULong(count);
 cdCheck(this,o);
 if(o+c>t.length)c=t.length-o;
 this.textContent=t.slice(0,o)+String(data)+t.slice(o+c);};

/* textContent is null on a document and on a doctype, and setting it to
 * null or leaving it out means the empty string, not the word "null". */
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'textContent');
 if(!d||!d.get)return;
 Object.defineProperty(P,'textContent',{configurable:true,
  get:function(){
   var t=this.nodeType;
   if(t===9||t===10)return null;
   return d.get.call(this);},
  set:function(v){d.set.call(this,(v===null||v===undefined)?'':v);}});})();
D.textContent=null;

/* --- a doctype that is a node -------------------------------------------
 * createDocumentType handed back a plain object with a name on it, so
 * everything a doctype is asked for -- nodeName, nodeType, its owner --
 * was undefined.
 */
function DocumentType(name,publicId,systemId){
 this.name=String(name);
 this.publicId=publicId===undefined?'':String(publicId);
 this.systemId=systemId===undefined?'':String(systemId);
 this.nodeName=this.name;
 this.nodeType=10;
 this.nodeValue=null;
 this.textContent=null;
 this.childNodes=[];
 this.parentNode=null;
 this.ownerDocument=D;}
DocumentType.prototype.before=DocumentType.prototype.after=
 DocumentType.prototype.replaceWith=DocumentType.prototype.remove=function(){};
DocumentType.prototype.cloneNode=function(){
 return new DocumentType(this.name,this.publicId,this.systemId);};
DocumentType.prototype.isEqualNode=function(o){
 return !!o&&o.nodeType===10&&o.name===this.name&&
  o.publicId===this.publicId&&o.systemId===this.systemId;};
W.DocumentType=DocumentType;
/* a doctype the parser made is a node wrapper, not one of these */
try{Object.defineProperty(DocumentType,Symbol.hasInstance,{configurable:true,
 value:function(o){return !!o&&typeof o==='object'&&o.nodeType===10;}});}catch(e){}
Object.defineProperty(D,'doctype',{configurable:true,
 get:function(){return priv(D,'__doctype',function(){
  return new DocumentType('html','','');});}});
/* What the name may contain. Browsers are far looser here than the XML
   Name production reads: 1foo, @foo, ~ and } are all accepted, and only
   a character that could never appear in markup -- a space, an angle
   bracket, a quote -- is refused. The tests are the authority for this,
   not my reading of the grammar. */
var BAD_NAME=/[\s<>&"'\/=\u0000]/;
D.implementation.createDocumentType=function(qualifiedName,publicId,systemId){
 needArgs(arguments.length,3,'createDocumentType');
 var n=String(qualifiedName);
 if(n===''||BAD_NAME.test(n))throw new DOMException(
  'The string contains invalid characters.','InvalidCharacterError');
 var parts=n.split(':');
 if(parts.length>2||(parts.length===2&&(parts[0]===''||parts[1]==='')))
  throw new DOMException(
   'The qualified name provided has an invalid prefix.','NamespaceError');
 /* a real node, so a document can hold it and the tree methods work */
 var d=D.__vitaCreateDoctype?D.__vitaCreateDoctype(n,publicId,systemId):null;
 if(!d)return new DocumentType(n,publicId,systemId);
 /* it belongs to the document whose implementation made it; libdom's
    maker takes no document, so say so on the node itself */
 var owner=isDoc(this)?this:D;
 Object.defineProperty(d,'ownerDocument',{configurable:true,
  get:function(){return owner;}});
 return d;};

/* --- where before(), after() and replaceWith() put things ---------------
 * The reference point is the first sibling that is not itself one of the
 * nodes being inserted. Using the immediate sibling put an element that
 * was already there in the wrong place, because it was the reference and
 * the reference was about to move.
 */
function viableNext(node,nodes){
 var n=node.nextSibling;
 while(n&&nodes.indexOf(n)>=0)n=n.nextSibling;
 return n;}
function viablePrev(node,nodes){
 var n=node.previousSibling;
 while(n&&nodes.indexOf(n)>=0)n=n.previousSibling;
 return n;}
P.before=function(){
 var p=this.parentNode;
 if(!p)return;
 var n=toNodes(arguments),prev=viablePrev(this,n),f=D.createDocumentFragment(),i;
 /* into a fragment first: moving them out is what makes the reference
    point settle, and inserting one at a time against a reference that is
    itself moving put them in the wrong order. */
 for(i=0;i<n.length;i++)f.appendChild(n[i]);
 var ref=prev?prev.nextSibling:p.firstChild;
 if(ref)p.insertBefore(f,ref);else p.appendChild(f);};
P.after=function(){
 var p=this.parentNode;
 if(!p)return;
 var n=toNodes(arguments),ref=viableNext(this,n),f=D.createDocumentFragment(),i;
 for(i=0;i<n.length;i++)f.appendChild(n[i]);
 if(ref)p.insertBefore(f,ref);else p.appendChild(f);};
P.replaceWith=function(){
 var p=this.parentNode;
 if(!p)return;
 var n=toNodes(arguments),ref=viableNext(this,n),f=D.createDocumentFragment(),i;
 for(i=0;i<n.length;i++)f.appendChild(n[i]);
 if(this.parentNode===p)p.removeChild(this);
 if(ref)p.insertBefore(f,ref);else p.appendChild(f);};

/* --- what may go where ---------------------------------------------------
 * appendChild, insertBefore and replaceChild took anything they were
 * given. Inserting a node into its own descendant built a cycle the tree
 * walk then ran round for ever, and passing something that is not a node
 * at all did nothing quietly where a browser throws. The checks are the
 * specification's pre-insertion validity steps.
 */
function hierarchy(msg){return new DOMException(msg,'HierarchyRequestError');}
function isNode(v){return !!v&&typeof v==='object'&&typeof v.nodeType==='number';}
/* The message says what was passed as well as what was wanted: the
   value that reaches this from a minified bundle is the whole question,
   and a log that only says "not a Node" cannot answer it. */
function describe(v){
 var d;
 try{
  if(v===null)return 'null';
  if(v===undefined)return 'undefined';
  d=typeof v;
  if(d!=='object'&&d!=='function')return d+' '+String(v).slice(0,20);
  d='object';
  try{if(v.constructor&&v.constructor.name)d=String(v.constructor.name);}catch(e){}
  d+=' nodeType='+(typeof v.nodeType)+':'+v.nodeType;
  if(v.tagName!==undefined)d+=' tag='+v.tagName;
  if(v.nodeName!==undefined)d+=' name='+v.nodeName;
 }catch(e2){d='<unreadable>';}
 return d;}
function needNode(v,fn,which){
 if(!isNode(v))throw new TypeError(
  "Failed to execute '"+fn+"': parameter "+which+
  " is not of type 'Node'. Got "+describe(v)+".");}
/* A node cannot contain itself or anything it is inside. The climb is
   made in C where it can be (__vitaIsAncestor): in JavaScript it took a
   wrapper per ancestor on every insertion. */
var nativeAncestor=null;
function isAncestor(a,n){
 if(nativeAncestor===null)nativeAncestor=
  typeof W.__vitaIsAncestor==='function'?W.__vitaIsAncestor:false;
 if(nativeAncestor){var r=nativeAncestor(a,n);if(r!==undefined)return r;}
 for(;n;n=n.parentNode)if(n===a)return true;
 return false;}
function containsNode(parent,node){return isAncestor(node,parent);}
var CAN_HAVE_CHILDREN={1:true,9:true,11:true};
/* What an insertBefore that threw NotFoundError was given, for the log
   (VitaSurf): which page code makes the call is in the stack, and what
   the nodes were tells whether it is the page's own mistake or a place
   where a shadow root being its host here put a node somewhere a
   browser would not. Tag names and node kinds only. */
var insertMisses=0;
function missName(n){
 if(!n)return 'nothing';
 var t=n.nodeType===1?'<'+n.tagName+'>':n.nodeType===3?'text':
  n.nodeType===8?'comment':n.nodeType===11?'fragment':'node '+n.nodeType;
 if(n.nodeType===1&&SH_ROOT(n))t+=' (a shadow host)';
 if(n.nodeType===11&&shadowHost(n))t='a shadow root';
 return t;}
function insertMiss(parent,node,child){
 if(++insertMisses>8)return;
 try{
  var p=child.parentNode,o=parent.renderOptions,why=[];
  if(o&&typeof o==='object'&&o.renderBefore===child)why.push('it is the renderBefore of the parent\'s Lit render');
  console.warn('insertBefore missed: putting '+missName(node)+' into '+
   missName(parent)+' before '+missName(child)+', which is '+
   (p?'in '+missName(p):'in nothing')+
   (child.isConnected===false?' and not in the page':'')+
   (why.length?'; '+why.join(', '):''));
 }catch(e){}}
function preInsert(parent,node,child,fn,replacing){
 needNode(node,fn,1);
 if(!CAN_HAVE_CHILDREN[parent.nodeType])
  throw hierarchy('This node type does not support this method.');
 if(containsNode(parent,node))
  throw hierarchy('The new child element contains the parent.');
 if(child!==null&&child!==undefined&&child.parentNode!==parent){
  insertMiss(parent,node,child);
  throw new DOMException(
   'The node before which the new node is to be inserted is not a child '+
   'of this node.','NotFoundError');}
 if(node.nodeType===3&&parent.nodeType===9)
  throw hierarchy('Nodes of type Text may not be inserted inside a Document.');
 if(node.nodeType===9)
  throw hierarchy('Nodes of type Document may not be inserted.');
 if(node.nodeType===10&&parent.nodeType!==9)
  throw hierarchy('Nodes of type DocumentType may only be inserted inside '+
                  'a Document.');
 if(parent.nodeType===9)documentRules(parent,node,child,replacing);}
/* What a document will hold: one element and one doctype, the doctype
   first. A fragment counts as the children it is about to contribute,
   and a node being replaced does not count against its own replacement. */
function countKids(parent,type,skip){
 var c=parent.childNodes,n=0,i;
 for(i=0;i<c.length;i++)if(c[i]!==skip&&c[i].nodeType===type)n++;
 return n;}
function firstKid(parent,type,skip){
 var c=parent.childNodes,i;
 for(i=0;i<c.length;i++)if(c[i]!==skip&&c[i].nodeType===type)return c[i];
 return null;}
function indexOfKid(parent,node){
 var c=parent.childNodes,i;
 for(i=0;i<c.length;i++)if(c[i]===node)return i;
 return -1;}
function documentRules(parent,node,child,replacing){
 var skip=replacing||null,ref=replacing||child||null,
     elements=countKids(parent,1,skip),doctype=countKids(parent,10,skip),
     kids,i,e=0,t=0,at,de;
 if(node.nodeType===11){
  kids=node.childNodes;
  for(i=0;i<kids.length;i++){
   if(kids[i].nodeType===1)e++;
   else if(kids[i].nodeType===3)t++;}
  if(t>0||e>1)
   throw hierarchy('A document may hold one element and no text.');
  if(e===0)return;}
 else if(node.nodeType!==1&&node.nodeType!==10)return;
 if(node.nodeType===10){
  if(doctype>0)
   throw hierarchy('A document may hold only one doctype.');
  /* the doctype must come before the document element */
  at=ref?indexOfKid(parent,ref):parent.childNodes.length;
  de=firstKid(parent,1,skip);
  if(de&&(at<0||indexOfKid(parent,de)<at))
   throw hierarchy('A doctype may not follow the document element.');
  return;}
 /* an element, or a fragment holding exactly one */
 if(elements>0)
  throw hierarchy('A document may hold only one element.');
 if(child!==null&&child!==undefined&&child.nodeType===10)
  throw hierarchy('An element may not be inserted before the doctype.');
 if(ref){
  at=indexOfKid(parent,ref);
  de=firstKid(parent,10,skip);
  if(de&&at>=0&&indexOfKid(parent,de)>at)
   throw hierarchy('An element may not be inserted before the doctype.');}}
(function(){
 var append=P.appendChild,insert=P.insertBefore,replace=P.replaceChild,
     removeC=P.removeChild;
 P.appendChild=function(node){
  preInsert(this,node,null,'appendChild');
  return append.call(this,node);};
 P.insertBefore=function(node,child){
  preInsert(this,node,child===undefined?null:child,'insertBefore');
  return insert.call(this,node,child);};
 P.replaceChild=function(node,child){
  needNode(node,'replaceChild',1);
  needNode(child,'replaceChild',2);
  if(child.parentNode!==this)throw new DOMException(
   'The node to be replaced is not a child of this node.','NotFoundError');
  preInsert(this,node,null,'replaceChild',child);
  return replace.call(this,node,child);};
 P.removeChild=function(child){
  needNode(child,'removeChild',1);
  if(child.parentNode!==this)throw new DOMException(
   'The node to be removed is not a child of this node.','NotFoundError');
  return removeC.call(this,child);};
})();

/* --- instanceof, told apart ----------------------------------------------
 * Every interface name was the same constructor, so an anchor was an
 * HTMLInputElement and a DocumentFragment at the same time and nothing
 * that branches on instanceof could get the right answer. YouTube's
 * custom element polyfill takes a different path for a fragment than for
 * an element, and took the fragment one for everything.
 *
 * Each name gets its own function, still with Node.prototype as its
 * prototype -- a polyfill that patches HTMLAnchorElement.prototype is
 * still patching the one shared prototype, which is what the rest of
 * this file depends on -- and a hasInstance that asks what the node
 * actually is. HTMLElement itself stays CEBase, because a custom
 * element class extends it and would inherit any test put there.
 */
/* The node type and document position constants, which were missing
   from Node and from every node. Tests and pages alike write
   Node.TEXT_NODE rather than 3. */
var NODE_CONSTS={
 ELEMENT_NODE:1,ATTRIBUTE_NODE:2,TEXT_NODE:3,CDATA_SECTION_NODE:4,
 ENTITY_REFERENCE_NODE:5,ENTITY_NODE:6,PROCESSING_INSTRUCTION_NODE:7,
 COMMENT_NODE:8,DOCUMENT_NODE:9,DOCUMENT_TYPE_NODE:10,
 DOCUMENT_FRAGMENT_NODE:11,NOTATION_NODE:12,
 DOCUMENT_POSITION_DISCONNECTED:1,DOCUMENT_POSITION_PRECEDING:2,
 DOCUMENT_POSITION_FOLLOWING:4,DOCUMENT_POSITION_CONTAINS:8,
 DOCUMENT_POSITION_CONTAINED_BY:16,
 DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC:32};
function stampConsts(o){
 if(!o)return o;
 Object.keys(NODE_CONSTS).forEach(function(k){
  try{Object.defineProperty(o,k,{configurable:true,enumerable:true,
   value:NODE_CONSTS[k]});}catch(e){}});
 return o;}
stampConsts(P);
(function(){
 var NODE_TYPES=[1,2,3,4,7,8,9,10,11];
 /* Element is a global, and this loop replaces it, so hold the original
    to compare against or every name after the first is skipped. */
 var WAS=W.Element;
 /* The ones a page can construct directly. Everything else falls back
    to the custom element base, which refuses. */
 var MAKE={
  Text:function(d){return D.createTextNode(d===undefined?'':String(d));},
  Comment:function(d){return D.createComment(d===undefined?'':String(d));},
  CDATASection:function(d){return D.createTextNode(d===undefined?'':String(d));},
  DocumentFragment:function(){return D.createDocumentFragment();},
  Document:function(){
   var d=W.__vitaParseDocument?W.__vitaParseDocument(''):null;
   if(d){var de=d.documentElement;if(de)d.removeChild(de);return d;}
   return D.createDocumentFragment();}};
 /* What every interface built from one old constructor carries: its
    own properties, then the node type constants over them, as one set
    of descriptors made once (VitaSurf). Seventy interfaces copied them
    one call at a time, a few thousand calls on every page. */
 var CARRIED=[];
 function carried(from){
  var i,d,names,k;
  for(i=0;i<CARRIED.length;i++)if(CARRIED[i][0]===from)return CARRIED[i][1];
  d={};
  names=from?Object.getOwnPropertyNames(from):[];
  for(i=0;i<names.length;i++){k=names[i];
   if(k==='prototype'||k==='length'||k==='name'||k==='caller'||
      k==='arguments')continue;
   d[k]=Object.getOwnPropertyDescriptor(from,k);}
  /* as stampConsts would redefine them: a data property keeps whether
     it was writable */
  Object.keys(NODE_CONSTS).forEach(function(k){
   var was=d[k];
   d[k]={configurable:true,enumerable:true,value:NODE_CONSTS[k]};
   if(was&&'value' in was)d[k].writable=was.writable;});
  CARRIED.push([from,d]);
  return d;}
 function iface(name,test,from,make){
  var F=make?function(a){return make(a);}
            :function(){return CEBase.apply(this,arguments);};
  /* the interface's own name: code reads constructor.name, and an
     anonymous function reports the empty string */
  try{Object.defineProperty(F,'name',{configurable:true,value:name});}catch(e){}
  F.prototype=P;
  /* keep whatever the old constructor carried -- Node.ELEMENT_NODE and
     the rest of the node type constants live there, and code reads
     them by name */
  try{Object.defineProperties(F,carried(from));}
  catch(e){
   if(from)Object.getOwnPropertyNames(from).forEach(function(k){
    if(k==='prototype'||k==='length'||k==='name'||k==='caller'||
       k==='arguments')return;
    try{Object.defineProperty(F,k,
     Object.getOwnPropertyDescriptor(from,k));}catch(e2){}});
   stampConsts(F);}
  try{Object.defineProperty(F,Symbol.hasInstance,
   {configurable:true,value:test});}catch(e){}
  return F;}
 function ofType(types){
  /* in C when the bindings have it (VitaSurf) */
  if(typeof __vitaNodeTypeTest==='function'){
   var mask=0;types.forEach(function(t){mask|=1<<t;});
   return __vitaNodeTypeTest(mask);}
  return function(v){
   return !!v&&typeof v==='object'&&types.indexOf(v.nodeType)>=0;};}
 function ofTag(tags){
  tags=' '+tags+' ';
  return function(v){
   return !!v&&typeof v==='object'&&v.nodeType===1&&
    tags.indexOf(' '+v.tagName+' ')>=0;};}
 var byType={
  Node:NODE_TYPES,Element:[1],
  CharacterData:[3,4,7,8],Text:[3],Comment:[8],CDATASection:[4],
  ProcessingInstruction:[7],DocumentFragment:[11]};
 var byTag={
  SVGElement:' SVG CIRCLE CLIPPATH DEFS ELLIPSE FOREIGNOBJECT G IMAGE LINE '+
   'LINEARGRADIENT MARKER MASK PATH PATTERN POLYGON POLYLINE RADIALGRADIENT '+
   'RECT STOP SYMBOL TEXTPATH TSPAN USE ',
  SVGSVGElement:'SVG',
  HTMLAnchorElement:'A',HTMLAreaElement:'AREA',HTMLAudioElement:'AUDIO',
  HTMLBaseElement:'BASE',HTMLBodyElement:'BODY',HTMLBRElement:'BR',
  HTMLButtonElement:'BUTTON',HTMLCanvasElement:'CANVAS',HTMLDataElement:'DATA',
  HTMLDataListElement:'DATALIST',HTMLDetailsElement:'DETAILS',
  HTMLDialogElement:'DIALOG',HTMLDivElement:'DIV',HTMLDListElement:'DL',
  HTMLEmbedElement:'EMBED',HTMLFieldSetElement:'FIELDSET',
  HTMLFontElement:'FONT',HTMLFormElement:'FORM',HTMLFrameElement:'FRAME',
  HTMLFrameSetElement:'FRAMESET',HTMLHeadElement:'HEAD',
  HTMLHeadingElement:'H1 H2 H3 H4 H5 H6',HTMLHRElement:'HR',
  HTMLHtmlElement:'HTML',HTMLIFrameElement:'IFRAME',HTMLImageElement:'IMG',
  HTMLInputElement:'INPUT',HTMLLabelElement:'LABEL',HTMLLegendElement:'LEGEND',
  HTMLLIElement:'LI',HTMLLinkElement:'LINK',HTMLMapElement:'MAP',
  HTMLMarqueeElement:'MARQUEE',HTMLMediaElement:'AUDIO VIDEO',
  HTMLMenuElement:'MENU',HTMLMetaElement:'META',HTMLMeterElement:'METER',
  HTMLModElement:'DEL INS',HTMLObjectElement:'OBJECT',HTMLOListElement:'OL',
  HTMLOptGroupElement:'OPTGROUP',HTMLOptionElement:'OPTION',
  HTMLOutputElement:'OUTPUT',HTMLParagraphElement:'P',HTMLParamElement:'PARAM',
  HTMLPictureElement:'PICTURE',HTMLPreElement:'PRE LISTING XMP',
  HTMLProgressElement:'PROGRESS',HTMLQuoteElement:'BLOCKQUOTE Q',
  HTMLScriptElement:'SCRIPT',HTMLSelectElement:'SELECT',HTMLSlotElement:'SLOT',
  HTMLSourceElement:'SOURCE',HTMLSpanElement:'SPAN',HTMLStyleElement:'STYLE',
  HTMLTableCaptionElement:'CAPTION',HTMLTableCellElement:'TD TH',
  HTMLTableColElement:'COL COLGROUP',HTMLTableElement:'TABLE',
  HTMLTableRowElement:'TR',HTMLTableSectionElement:'TBODY TFOOT THEAD',
  HTMLTemplateElement:'TEMPLATE',HTMLTextAreaElement:'TEXTAREA',
  HTMLTimeElement:'TIME',HTMLTitleElement:'TITLE',HTMLTrackElement:'TRACK',
  HTMLUListElement:'UL',HTMLVideoElement:'VIDEO'};
 stampConsts(CEBase);
 /* Document keeps its own prototype, which polyfills patch, so it is
    not replaced -- but it can still answer instanceof honestly. */
 try{Object.defineProperty(W.Document,Symbol.hasInstance,
  {configurable:true,value:ofType([9])});
  stampConsts(W.Document);}catch(e){}
 var k;
 for(k in byType)if(W[k]===WAS||W[k]===CEBase)
  W[k]=iface(k,ofType(byType[k]),W[k],MAKE[k]);
 for(k in byTag)if(W[k]===WAS||W[k]===CEBase)
  W[k]=iface(k,ofTag(byTag[k]),W[k]);
 /* Which interface a node reports as its constructor. Every element
    shares one prototype here, so constructor came back the same for all
    of them -- code that reads el.constructor.name to tell a div from an
    input got one answer for both. Build the tag-to-interface map from
    the same table the instanceof tests use. */
 var BY_TAG={};
 for(k in byTag){
  if(k==='SVGElement'||k==='SVGSVGElement')continue;
  byTag[k].split(/\s+/).forEach(function(tag){
   if(tag&&!BY_TAG[tag])BY_TAG[tag]=k;});}
 var BY_TYPE={2:'Attr',3:'Text',4:'CDATASection',7:'ProcessingInstruction',
  8:'Comment',9:'HTMLDocument',10:'DocumentType',11:'DocumentFragment'};
 Object.defineProperty(P,'constructor',{configurable:true,
  get:function(){
   var t,n;
   /* the prototype object itself is not a node, and reading its
      constructor must answer rather than throw (VitaSurf) */
   try{t=this.nodeType;}catch(e){return W.HTMLElement||W.Node;}
   if(t===undefined)return W.HTMLElement||W.Node;
   if(t===1){
    n=BY_TAG[this.tagName];
    if(!n)n=HTML_TAGS.indexOf(' '+this.tagName+' ')>=0?'HTMLElement'
                                                      :'HTMLUnknownElement';
   }else n=t===11&&shadowHost(this)?'ShadowRoot':BY_TYPE[t];
   return (n&&W[n])||W.Node;},
  set:function(v){shadowProp(this,'constructor',v);}});
 /* What Object.prototype.toString says a node is (VitaSurf). It said
    [object Object] for every element, and code that tells a DOM node
    from a plain object, or an element from a window, by that string --
    React's and Sentry's among them -- took the wrong branch. The name
    is the constructor's; an SVG element gets its own interface's. */
 Object.defineProperty(P,Symbol.toStringTag,{configurable:true,
  get:function(){
   var t,ln,c;
   try{t=this.nodeType;}catch(e){return 'HTMLElement';}
   if(t===undefined)return 'HTMLElement';
   if(t===1&&this.namespaceURI===SVG_NS){
    ln=String(this.localName||'');
    return ln==='svg'?'SVGSVGElement':
     'SVG'+ln.charAt(0).toUpperCase()+ln.slice(1)+'Element';}
   try{c=this.constructor;}catch(e){c=null;}
   return (c&&c.name)||'Node';}});
 try{if(W.Document&&W.Document.prototype&&W.Document.prototype!==P)
  Object.defineProperty(W.Document.prototype,Symbol.toStringTag,
   {configurable:true,value:'HTMLDocument'});}catch(e){}
 /* An unknown element is one whose tag is not in the HTML vocabulary at
    all -- <section> and <strong> are plain HTMLElements, not unknown. */
 if(W.HTMLUnknownElement===WAS||W.HTMLUnknownElement===CEBase){
  W.HTMLUnknownElement=iface('HTMLUnknownElement',function(v){
   return !!v&&typeof v==='object'&&v.nodeType===1&&
    HTML_TAGS.indexOf(' '+v.tagName+' ')<0&&
    byTag.SVGElement.indexOf(' '+v.tagName+' ')<0;},W.HTMLUnknownElement);}
})();

W.HTMLCollection=HTMLCollection;W.NodeList=NodeList;

/* getElementsByTagName and friends, made live. The C side does the tree
   walk; the collection calls it again whenever it is read. */
(function(){
 function live(get,shapeOnly){
  return function(){
   var self=this,args=[].slice.call(arguments);
   return liveCollection(function(){
    return listOf(get.apply(self,args));},null,shapeOnly);};}
 /* a tag name never changes, so a tag's collection only moves with the
    tree; a class or a name moves with attribute writes too */
 ['getElementsByTagName','getElementsByClassName','getElementsByName',
  'getElementsByTagNameNS'].forEach(function(m){
  var shapeOnly=m.indexOf('TagName')>0;
  if(typeof P[m]==='function')P[m]=live(P[m],shapeOnly);
  if(typeof D[m]==='function')D[m]=live(D[m],shapeOnly);});
 /*
 * A DOM prototype chain with the shapes a framework looks for
 * (VitaSurf).
 *
 * Every interface here shares one prototype, so an element's immediate
 * prototype was Element.prototype itself. Svelte reads which properties
 * an element has a setter for by walking from the element up to
 * Element.prototype, and that walk ended before it saw anything: with
 * no setter found for disabled it fell back to setAttribute('disabled',
 * false), and a boolean attribute is true whatever its value, so every
 * field on an Immich login form was disabled and refused to be typed
 * into. The shared prototype is now the HTMLElement level, with an
 * Element, a Node and an EventTarget prototype above it, as a browser
 * has. The upper ones carry copies of the methods that belong to them,
 * so code that tests for a method on Element.prototype still finds it;
 * the copies are shadowed by the originals and nothing calls them.
 */
(function(){
 var ELEMENT_LEVEL=('setAttribute getAttribute removeAttribute hasAttribute '+
  'setAttributeNS getAttributeNS removeAttributeNS hasAttributeNS '+
  'getAttributeNames toggleAttribute matches closest querySelector '+
  'querySelectorAll getElementsByTagName getElementsByClassName '+
  'getBoundingClientRect getClientRects scrollIntoView attachShadow '+
  'insertAdjacentHTML insertAdjacentElement insertAdjacentText '+
  'requestFullscreen animate replaceChildren append prepend before '+
  'after remove '+
  'id className classList tagName attributes innerHTML outerHTML '+
  'children firstElementChild lastElementChild nextElementSibling '+
  'previousElementSibling childElementCount clientWidth clientHeight '+
  'clientTop clientLeft scrollTop scrollLeft scrollWidth scrollHeight '+
  'slot part shadowRoot namespaceURI localName prefix').split(' ');
 var NODE_LEVEL=('appendChild removeChild insertBefore replaceChild '+
  'cloneNode contains compareDocumentPosition hasChildNodes '+
  'normalize isEqualNode isSameNode lookupPrefix lookupNamespaceURI '+
  'getRootNode '+
  /* the properties too: Svelte reads the firstChild and nextSibling
     getters off Node.prototype and calls them on every node it walks */
  'firstChild lastChild nextSibling previousSibling parentNode '+
  'parentElement childNodes nodeType nodeName nodeValue textContent '+
  'ownerDocument isConnected baseURI').split(' ');
 var EVENT_LEVEL='addEventListener removeEventListener dispatchEvent'.split(' ');
 function level(names){
  var o=Object.create(null);
  o=Object.create(Object.prototype);
  names.forEach(function(k){
   var d=Object.getOwnPropertyDescriptor(P,k);
   if(d)try{Object.defineProperty(o,k,d);}catch(e){}});
  return o;}
 try{
  var T=level(EVENT_LEVEL);
  var N=level(NODE_LEVEL);
  var E=level(ELEMENT_LEVEL);
  Object.setPrototypeOf(N,T);
  Object.setPrototypeOf(E,N);
  Object.setPrototypeOf(P,E);
  if(W.EventTarget)W.EventTarget.prototype=T;
  if(W.Node)W.Node.prototype=N;
  if(W.Element)W.Element.prototype=E;
  /* each interface's prototype names it, as a browser's does; a node
     still answers its own through P's constructor getter */
  [[T,W.EventTarget],[N,W.Node],[E,W.Element]].forEach(function(p){
   if(p[1])Object.defineProperty(p[0],'constructor',{configurable:true,
    writable:true,value:p[1]});});
  if(W.CharacterData)W.CharacterData.prototype=N;
 }catch(e){}
})();
/* The document as a node (VitaSurf). The page's document is a plain
 * object with its own methods, and it had none of the node ones:
 * childNodes, firstChild, appendChild, getRootNode. Home Assistant's
 * custom element registry polyfill calls getRootNode on it for every
 * element it upgrades, and every one of them failed. The node bindings
 * take the document object as the document node now, so it borrows
 * them; what a document answers differently is set here. */
(function(){
 ['appendChild','removeChild','insertBefore','replaceChild',
  'compareDocumentPosition','hasChildNodes','normalize','isEqualNode',
  'isSameNode','lookupPrefix','lookupNamespaceURI','isDefaultNamespace',
  'firstChild','lastChild','childNodes','getRootNode'].forEach(function(k){
  if(Object.prototype.hasOwnProperty.call(D,k))return;
  var d=Object.getOwnPropertyDescriptor(P,k);
  if(d)try{Object.defineProperty(D,k,d);}catch(e){}});
 [['parentNode',null],['parentElement',null],['nextSibling',null],
  ['previousSibling',null],['nodeValue',null],['ownerDocument',null],
  ['isConnected',true]].forEach(function(p){
  if(Object.prototype.hasOwnProperty.call(D,p[0]))return;
  try{Object.defineProperty(D,p[0],{configurable:true,
   get:function(){return p[1];}});}catch(e){}});
})();

 var kids=Object.getOwnPropertyDescriptor(P,'children');
 if(kids&&kids.get)Object.defineProperty(P,'children',{configurable:true,
  get:function(){
   var self=this;
   return liveCollection(function(){return listOf(kids.get.call(self));},
    null,true);}});
 var dkids=Object.getOwnPropertyDescriptor(D,'children');
 if(dkids&&dkids.get)Object.defineProperty(D,'children',{configurable:true,
  get:function(){
   return liveCollection(function(){return listOf(dkids.get.call(D));},
    null,true);}});
})();

/* The document's interfaces in a browser's order (VitaSurf). The page's
 * document carried every one of its methods and accessors itself, over
 * an empty HTMLDocument.prototype that Document.prototype was the same
 * object as, with no Node or EventTarget in the chain. So
 * Document.prototype.querySelector was undefined where a browser has a
 * function, and claude.ai's Cloudflare check, which reads it and hands
 * it to new Proxy, stopped on "Cannot create proxy with a non-object as
 * target". The chain is now document > HTMLDocument.prototype >
 * Document.prototype > Node.prototype > EventTarget.prototype, and what
 * the document had of its own is on Document.prototype, except location,
 * which a browser keeps on the document. State the prelude keeps on the
 * document, which cannot be reconfigured, stays where it is. */
(function(){
 var HD=Object.getPrototypeOf(D),N=W.Node&&W.Node.prototype;
 if(!N||!W.Document||HD===Object.prototype)return;
 var DP=Object.create(N);
 Object.defineProperty(DP,'constructor',{configurable:true,writable:true,
  value:W.Document});
 Object.defineProperty(DP,Symbol.toStringTag,{configurable:true,
  value:'Document'});
 Object.defineProperty(HD,Symbol.toStringTag,{configurable:true,
  value:'HTMLDocument'});
 Reflect.ownKeys(D).forEach(function(k){
  if(k==='location')return;
  var d=Object.getOwnPropertyDescriptor(D,k);
  if(!d||!d.configurable)return;
  try{Object.defineProperty(DP,k,d);delete D[k];}catch(e){}});
 Object.setPrototypeOf(HD,DP);
 W.Document.prototype=DP;
})();

/* --- dedicated workers (VitaSurf) --------------------------------------
 * A worker is a realm of its own on the page's runtime, run by the same
 * scheduler as the page: messages cross between the two as clones, and
 * the worker has no document. The page's side is Worker below; the
 * worker's side is made by __vitaBecomeWorker, which the page calls in
 * the new realm's own copy of this prelude, so everything it defines is
 * the worker's. qjs.c makes the realm (__vitaWorkerNew), ends it
 * (__vitaWorkerClose) and fetches for importScripts (__vitaFetchSync).
 */
(function(){
 var NW=W.__vitaWorkerNew,NC=W.__vitaWorkerClose,FS=W.__vitaFetchSync;
 ['__vitaWorkerNew','__vitaWorkerClose','__vitaFetchSync'].forEach(
  function(k){delete W[k];});
 var geval=eval;
 /* listeners in script, for objects the DOM does not own */
 function listens(obj,onerr){
  var L={};
  obj.addEventListener=function(t,fn,o){
   if(!fn)return;t=String(t);
   var a=L[t]||(L[t]=[]),i;
   for(i=0;i<a.length;i++)if(a[i].fn===fn)return;
   a.push({fn:fn,once:!!(o&&typeof o==='object'&&o.once)});};
  obj.removeEventListener=function(t,fn){
   var a=L[String(t)],i;
   if(a)for(i=0;i<a.length;i++)if(a[i].fn===fn){a.splice(i,1);return;}};
  obj.dispatchEvent=function(ev){
   var h=obj['on'+ev.type],a=(L[ev.type]||[]).slice();
   try{ev.target=obj;ev.currentTarget=obj;}catch(e){}
   function run(fn){
    try{
     if(typeof fn==='function'){if(fn.call(obj,ev)===false&&ev.cancelable)ev.preventDefault();}
     else if(fn&&typeof fn.handleEvent==='function')fn.handleEvent(ev);}
    catch(e){onerr(e);}}
   if(typeof h==='function')run(h);
   a.forEach(function(l){
    if(l.once)obj.removeEventListener(ev.type,l.fn);
    run(l.fn);});
   return !ev.defaultPrevented;};}
 function errorFields(err,where){
  var msg,file=where||'',line=0,col=0,m;
  try{msg=(err&&err.message!==undefined)?String(err.message):String(err);}
  catch(e){msg='Script error.';}
  if(err&&err.name&&msg.indexOf(err.name)!==0)msg=err.name+': '+msg;
  try{m=/\((.*):(\d+):(\d+)\)/.exec(String(err&&err.stack||''));
   if(m){file=m[1];line=Number(m[2])||0;col=Number(m[3])||0;}}catch(e){}
  return {message:'Uncaught '+msg,filename:file,lineno:line,colno:col};}

 /* the page's side */
 function Worker(url,options){
  if(!(this instanceof Worker))throw new TypeError(
   "Failed to construct 'Worker': Please use the 'new' operator, this DOM "+
   "object constructor cannot be called as a function.");
  if(arguments.length<1)throw new TypeError("Failed to construct 'Worker': "+
   '1 argument required, but only 0 present.');
  options=options||{};
  var me=this,abs,type=options.type==='module'?'module':'classic',
   name=options.name===undefined?'':String(options.name),st,g=null;
  try{abs=new URL(String(url),D.baseURI).href;}
  catch(e){throw new DOMException("Failed to construct 'Worker': The URL '"+
   url+"' is invalid.",'SyntaxError');}
  /* a worker's script is the page's own, or a blob or data: URL */
  if(!/^(blob|data):/i.test(abs)){
   var mine=new URL(D.baseURI),theirs=new URL(abs);
   if(theirs.protocol!==mine.protocol||
      (theirs.protocol!=='file:'&&theirs.origin!==mine.origin))
    throw new DOMException("Failed to construct 'Worker': Script at '"+abs+
     "' cannot be accessed from origin '"+location.origin+"'.",'SecurityError');}
  listens(this,function(e){W.__vitaReportError(e);});
  this.onmessage=this.onmessageerror=this.onerror=null;
  st={dead:false,port:null,g:null};
  Object.defineProperty(this,'__vitaWorker',{value:st});
  /* a worker that could not start has no realm to keep */
  function fail(message){
   if(st.g&&NC)NC(st.g);
   st.g=null;st.port=null;
   setTimeout(function(){
    if(st.dead)return;
    var ev=uaEvent(new ErrorEvent('error',{message:message,filename:abs,cancelable:true}));
    if(me.dispatchEvent(ev))console.error('Worker '+abs+': '+message);},0);}
  try{g=NW?NW():null;}catch(e){g=null;}
  if(!g||typeof g.__vitaBecomeWorker!=='function'){
   fail('The worker could not be started');return;}
  st.g=g;
  st.port=g.__vitaBecomeWorker(abs,name,type,{
   message:function(data){
    if(st.dead)return;
    var d;
    try{d=W.structuredClone(data);}
    catch(e){setTimeout(function(){if(!st.dead)
     me.dispatchEvent(uaEvent(new MessageEvent('messageerror',{})));},0);return;}
    setTimeout(function(){if(!st.dead)
     me.dispatchEvent(uaEvent(new MessageEvent('message',{data:d})));},0);},
   error:function(f){
    setTimeout(function(){
     if(st.dead)return;
     var ev=uaEvent(new ErrorEvent('error',{message:f.message,filename:f.filename,
      lineno:f.lineno,colno:f.colno,cancelable:true}));
     if(me.dispatchEvent(ev))console.error(f.message+' ('+f.filename+':'+
      f.lineno+')');},0);},
   close:function(){me.terminate();},
   blobText:function(u){
    var b=blobTable()[u];
    return b===undefined?null:(b._t!==undefined?b._t:String(b));}});
  if(type==='module'){st.port.runModule();return;}
  /* fetch does not read files; the fetch importScripts uses does */
  if(abs.indexOf('file:')===0){
   setTimeout(function(){
    var r=FS?FS(abs):null;
    if(st.dead)return;
    if(r&&r[0]>=200&&r[0]<300)st.port.run(r[1]);
    else fail("Failed to load the worker's script");},0);
   return;}
  W.fetch(abs).then(function(r){
   if(!r.ok)throw new Error('status '+r.status);
   return r.text();}).then(function(src){
   if(!st.dead)st.port.run(src);},function(){
   fail("Failed to load the worker's script");});}
 Worker.prototype.postMessage=function(message,transfer){
  var st=this.__vitaWorker;
  if(arguments.length<1)throw new TypeError("Failed to execute 'postMessage' on "+
   "'Worker': 1 argument required, but only 0 present.");
  if(st&&!st.dead&&st.port)st.port.receive(message);};
 Worker.prototype.terminate=function(){
  var st=this.__vitaWorker;
  if(!st||st.dead)return;
  st.dead=true;
  if(st.g&&NC)NC(st.g);
  st.g=null;st.port=null;};
 Object.defineProperty(Worker.prototype,Symbol.toStringTag,
  {configurable:true,value:'Worker'});
 W.Worker=Worker;

 /* the worker's side, called by the page in this realm */
 W.__vitaBecomeWorker=function(url,name,type,owner){
  delete W.__vitaBecomeWorker;
  /* the page's object URLs are in the page's table, not this realm's */
  var ownLocal=W.__vitaLocalModule;
  W.__vitaLocalModule=function(m){
   var t=ownLocal(m);
   if(t===null&&String(m).indexOf('blob:')===0)t=owner.blobText(String(m));
   return t===undefined?null:t;};
  var started=false,queue=[],closing=false,reporting=false,u=new URL(url);
  /* what a worker's global does not have */
  ['document','window','parent','top','frames','frameElement','opener',
   'localStorage','sessionStorage','alert','confirm','prompt','print','open',
   'history','customElements','Worker','SharedWorker','external','screen',
   'visualViewport','scrollX','scrollY','innerWidth','innerHeight',
   'outerWidth','outerHeight','pageXOffset','pageYOffset'
  ].forEach(function(k){
   try{delete W[k];}catch(e){}
   if(k in W)try{Object.defineProperty(W,k,{value:undefined,
    configurable:true,writable:true});}catch(e){}});
  /* where it is */
  function WorkerLocation(){throw new TypeError('Illegal constructor');}
  var loc=Object.create(WorkerLocation.prototype);
  ['href','origin','protocol','host','hostname','port','pathname','search',
   'hash'].forEach(function(k){
   Object.defineProperty(loc,k,{enumerable:true,value:u[k]});});
  WorkerLocation.prototype.toString=function(){return this.href;};
  W.WorkerLocation=WorkerLocation;
  /* window.location cannot be redefined; what its getter hands back can */
  W.__vitaLocation=loc;
  Object.defineProperty(D,'baseURI',{configurable:true,
   get:function(){return url;}});
  W.name=name;
  /* its scope's interfaces */
  function WorkerGlobalScope(){throw new TypeError('Illegal constructor');}
  function DedicatedWorkerGlobalScope(){throw new TypeError('Illegal constructor');}
  WorkerGlobalScope.prototype=Object.create(Object.getPrototypeOf(W));
  WorkerGlobalScope.prototype.constructor=WorkerGlobalScope;
  DedicatedWorkerGlobalScope.prototype=Object.create(WorkerGlobalScope.prototype);
  DedicatedWorkerGlobalScope.prototype.constructor=DedicatedWorkerGlobalScope;
  Object.defineProperty(DedicatedWorkerGlobalScope.prototype,Symbol.toStringTag,
   {configurable:true,value:'DedicatedWorkerGlobalScope'});
  W.WorkerGlobalScope=WorkerGlobalScope;
  W.DedicatedWorkerGlobalScope=DedicatedWorkerGlobalScope;
  /* the global's prototype cannot be changed here, so the global
     answers instanceof and toString for both itself */
  try{Object.setPrototypeOf(W,DedicatedWorkerGlobalScope.prototype);}catch(e){}
  [WorkerGlobalScope,DedicatedWorkerGlobalScope].forEach(function(C){
   Object.defineProperty(C,Symbol.hasInstance,{configurable:true,
    value:function(v){return v===W||Object.prototype.isPrototypeOf.call(
     C.prototype,v);}});});
  Object.defineProperty(W,Symbol.toStringTag,{configurable:true,
   value:'DedicatedWorkerGlobalScope'});
  /* its events: an error it does not handle goes to its Worker */
  W.__vitaReportError=function(err,where){
   var f=errorFields(err,where||url),ev;
   if(reporting){console.error(f.message);return;}
   reporting=true;
   try{
    ev=uaEvent(new ErrorEvent('error',{message:f.message,filename:f.filename,
     lineno:f.lineno,colno:f.colno,error:err,cancelable:true}));
    if(W.dispatchEvent(ev))owner.error(f);}
   finally{reporting=false;}};
  listens(W,function(e){W.__vitaReportError(e);});
  /* plain handler properties: the window's also add a listener, and
     the handler then ran twice */
  ['onmessage','onmessageerror','onerror'].forEach(function(k){
   Object.defineProperty(W,k,{configurable:true,enumerable:true,writable:true,
    value:null});});
  W.postMessage=function(message){
   if(arguments.length<1)throw new TypeError("Failed to execute 'postMessage'"+
    " on 'DedicatedWorkerGlobalScope': 1 argument required, but only 0 present.");
   if(!closing)owner.message(message);};
  W.close=function(){if(closing)return;closing=true;owner.close();};
  W.importScripts=function(){
   var i,abs,src,r;
   for(i=0;i<arguments.length;i++){
    try{abs=new URL(String(arguments[i]),url).href;}
    catch(e){throw new DOMException("Failed to execute 'importScripts' on "+
     "'WorkerGlobalScope': The URL '"+arguments[i]+"' is invalid.",'SyntaxError');}
    if(abs.indexOf('blob:')===0)src=owner.blobText(abs);
    else if(abs.indexOf('data:')===0){
     var c=abs.indexOf(','),head=abs.slice(5,c),body=abs.slice(c+1);
     src=/;base64$/i.test(head)?atob(decodeURIComponent(body)):
      decodeURIComponent(body);}
    else{r=FS?FS(abs):null;src=r&&r[0]>=200&&r[0]<300?r[1]:null;}
    if(src===null||src===undefined)throw new DOMException(
     "Failed to execute 'importScripts' on 'WorkerGlobalScope': The script at '"+
     abs+"' failed to load.",'NetworkError');
    geval(src);}};
  function deliver(message){
   var d;
   try{d=structuredClone(message);}
   catch(e){setTimeout(function(){
    W.dispatchEvent(uaEvent(new MessageEvent('messageerror',{})));},0);return;}
   setTimeout(function(){
    if(!closing)W.dispatchEvent(uaEvent(new MessageEvent('message',{data:d})));},0);}
  function begin(){started=true;queue.splice(0).forEach(deliver);}
  return {
   receive:function(message){
    if(closing)return;
    if(started)deliver(message);else queue.push(message);},
   run:function(src){
    setTimeout(function(){
     try{geval(src);}catch(e){W.__vitaReportError(e,url);}
     begin();},0);},
   runModule:function(){
    setTimeout(function(){
     /* through the helper that waits for a module to arrive, as a
        page's own import() does */
     W.__vitaImport(url,url).then(begin,function(e){
      W.__vitaReportError(e,url);begin();});},0);}};};
})();
})();
