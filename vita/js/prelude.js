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
['scrollTop','scrollLeft'].forEach(function(a,n){Object.defineProperty(P,a,{configurable:true,get:function(){if(isViewportEl(this)||this===D.body){return viewport()[1-n];}return boxOf(this)[11-n];},set:function(v){if(isViewportEl(this)||this===D.body){var s=viewport();__vitaScrollTo(n===1?Number(v)||0:s[0],n===1?s[1]:Number(v)||0);}}});});
P.tabIndex=0;
['onclick','onchange','onsubmit','oninput','onkeydown','onkeyup','onkeypress','onmousedown','onmouseup','onmouseover','onmouseout','onfocus','onblur','onload','onerror','ontouchstart','ontouchend'].forEach(function(h){Object.defineProperty(P,h,{configurable:true,get:function(){return this['__'+h]||null;},set:function(f){this['__'+h]=f;if(typeof f==='function')this.addEventListener(h.slice(2),function(e){return f.call(this,e);});}});});
P.getBoundingClientRect=function(){var b=__vitaBox(this);if(!b)return {top:0,left:0,right:0,bottom:0,width:0,height:0,x:0,y:0};var s=viewport(),x=b[0]-s[0],y=b[1]-s[1];return {x:x,y:y,left:x,top:y,width:b[2],height:b[3],right:x+b[2],bottom:y+b[3]};};
P.getClientRects=function(){var r=this.getBoundingClientRect();return r.width||r.height?[r]:[];};
P.focus=P.blur=P.select=function(){};
P.scrollIntoView=function(arg){var b=__vitaBox(this);if(!b)return;var s=viewport(),toEnd=(arg===false)||(arg&&(arg.block==='end'||arg.block==='nearest'&&b[1]<s[1]));__vitaScrollTo(s[0],toEnd?b[1]+b[3]-s[3]:b[1]);};
/* A disabled form control is not clickable: click() on one dispatches
   nothing at all. Dispatching a click at it explicitly still works,
   which is the difference the tests turn on. */
var FORM_CONTROLS=' BUTTON INPUT SELECT TEXTAREA FIELDSET OPTGROUP OPTION ';
function isDisabledControl(el){
 return !!el&&el.nodeType===1&&
  FORM_CONTROLS.indexOf(' '+el.tagName+' ')>=0&&!!el.disabled;}
P.click=function(){
 if(isDisabledControl(this))return true;
 var e=new MouseEvent('click',{bubbles:true,cancelable:true,composed:true});
 return this.dispatchEvent(e);};
P.contains=function(n){while(n){if(n===this)return true;n=n.parentNode;}return false;};
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
 /* Nothing here has a pointer, a focus ring or a history. */
 case 'hover':case 'focus':case 'focus-within':case 'focus-visible':
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
Object.defineProperty(P,'baseURI',{configurable:true,get:function(){return location.href;}});
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
P.scrollTo=P.scroll=function(a,b){window.scrollTo(a,b);};
P.scrollBy=function(a,b){window.scrollBy(a,b);};
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
 while(n&&n.nodeType===1){
  a=otherActivation(n);
  if(a)return a;
  a=preActivate(n);
  if(a)return a;
  n=n.parentNode;}
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
   var ev=new W.HashChangeEvent('hashchange',
    {bubbles:false,cancelable:false});
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
 var e=new Event(type,{bubbles:true,cancelable:false});
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
 return r;};P.getContext=function(){return null;};
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
Object.defineProperty(D,'head',{configurable:true,get:function(){var h=D.getElementsByTagName('head');return h.length?h[0]:null;}});
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
 ev.isTrusted=false;
 return ev;};D.dispatchEvent=function(e){return __vitaDispatch(null,e);};D.hasFocus=function(){return true;};
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
D.elementFromPoint=function(x,y){
 if(!W.__vitaElementFromPoint)return null;
 var s=viewport();
 return W.__vitaElementFromPoint(Math.round(x)+s[0],Math.round(y)+s[1])||null;};
D.elementsFromPoint=function(x,y){var e=D.elementFromPoint(x,y);return e?[e]:[];};
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
  var e=new Event('message');e.data=data;e.origin=location.origin||'';e.source=window;e.ports=[];
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
 return location.href;
}});
Object.defineProperty(D,'URL',{configurable:true,get:function(){return location.href;}});Object.defineProperty(D,'documentURI',{configurable:true,get:function(){return location.href;}});
Object.defineProperty(D,'activeElement',{configurable:true,get:function(){return D.body;}});
/* createComment is a real comment node from qjs.c now. */D.write=D.writeln=function(){};
D.getElementsByName=function(n){return D.querySelectorAll('[name='+n+']').filter(function(e){return e.getAttribute('name')===n;});};
D.contains=function(n){var r=D.documentElement;return r?r.contains(n):false;};
['onload','onreadystatechange','onclick','onkeydown','onkeyup','onmousemove','ontouchstart'].forEach(function(h){Object.defineProperty(D,h,{configurable:true,get:function(){return D['__'+h]||null;},set:function(f){D['__'+h]=f;if(typeof f==='function')D.addEventListener(h.slice(2),f);}});});
var W=window;
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
[['innerWidth',2],['outerWidth',2],['innerHeight',3],['outerHeight',3],['scrollX',0],['pageXOffset',0],['scrollY',1],['pageYOffset',1]].forEach(function(e){Object.defineProperty(W,e[0],{get:function(){return viewport()[e[1]];}});});
W.devicePixelRatio=1;
/* Frame relationships. Scripts test self !== top to find out whether they
   are framed, and a missing top is a ReferenceError that takes the script
   out: Google's page header does exactly that. */
W.top=W.parent=W.frames=W;W.opener=null;
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
 'table-column','table-cell','table-caption','none','flex','inline-flex','grid','inline-grid'];
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
function computedStyle(el){
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
 var box=(el&&el.nodeType===1&&typeof __vitaBox==='function')?__vitaBox(el):null;
 var cs={};
 for(var k in CS_DEFAULTS)cs[k]=CS_DEFAULTS[k];
 if(el&&el.nodeType===1&&UA_DISPLAY[el.tagName])cs.display=UA_DISPLAY[el.tagName];
 if(st){
  cs.fontSize=st[0]+'px';
  if(CS_DISPLAY[st[1]])cs.display=CS_DISPLAY[st[1]];
  if(CS_VIS[st[2]])cs.visibility=CS_VIS[st[2]];
  var c=cssColour(st[3],st[5]);if(c)cs.color=c;
  var b=cssColour(st[4],st[6]);if(b)cs.backgroundColor=b;
 }
 if(box){cs.width=box[4]+'px';cs.height=box[5]+'px';}
 else{cs.width='auto';cs.height='auto';}
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
   if(st&&RESOLVED[k])return;
   cs[k]=d[1];});
 }
 cs.getPropertyValue=function(n){var v=this[dashToCamel(n)];return v===undefined||typeof v==='function'?'':String(v);};
 cs.getPropertyPriority=function(){return '';};
 cs.setProperty=function(n,v){this[dashToCamel(n)]=String(v);};
 cs.removeProperty=function(n){var c=dashToCamel(n),v=this[c];delete this[c];return v===undefined?'':String(v);};
 cs.item=function(i){return Object.keys(CS_DEFAULTS)[i]||'';};
 Object.defineProperty(cs,'length',{configurable:true,get:function(){return Object.keys(CS_DEFAULTS).length;}});
 cs.cssText='';
 return cs;
}
W.getComputedStyle=function(el){return computedStyle(el);};
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
 case 'prefers-reduced-motion':return value==='reduce'||value==='no-preference';
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
 case 'prefers-reduced-motion':case 'prefers-reduced-transparency':
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
  },
  replaceState:function(state,title,url){
   stack[at]={state:clone(state),
              url:url===undefined?stack[at].url:resolve(url)};
   apply(at,false);
  },
  go:function(n){
   n=(n===undefined||n===null)?0:(parseInt(n,10)||0);
   if(n===0){ try{ location.reload(); }catch(e){} return; }
   var i=at+n;
   if(i<0||i>=stack.length)return;
   apply(i,true);
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
navigator.language='en-US';navigator.languages=['en-US','en'];navigator.cookieEnabled=true;navigator.onLine=true;navigator.doNotTrack=null;navigator.maxTouchPoints=1;navigator.vendor='';navigator.hardwareConcurrency=1;navigator.sendBeacon=function(){return false;};navigator.javaEnabled=function(){return false;};
location.reload=function(){location.href=location.href;};
['protocol','host','hostname','port','pathname','search','hash','origin'].forEach(function(k){Object.defineProperty(location,k,{configurable:true,get:function(){var m=location.href.match(/^([a-z][a-z0-9+.-]*:)\/\/(([^\/:?#]*)(?::(\d+))?)([^?#]*)(\?[^#]*)?(#.*)?/i)||[];return {protocol:m[1]||'',host:m[2]||'',hostname:m[3]||'',port:m[4]||'',pathname:m[5]||'/',search:m[6]||'',hash:m[7]||'',origin:(m[1]||'')+'//'+(m[2]||'')}[k];}});});
location.toString=function(){return location.href;};
function Event(type,init){this.type=String(type);this.bubbles=!!(init&&init.bubbles);this.cancelable=!!(init&&init.cancelable);this.defaultPrevented=false;this.target=null;this.currentTarget=null;this.timeStamp=Date.now();}
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
function Document(){throw new TypeError('Illegal constructor');}
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
Object.defineProperty(Event.prototype,'isTrusted',{configurable:true,get:function(){return false;}});
Object.defineProperty(Event.prototype,'composed',{configurable:true,get:function(){return false;}});
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
Event.prototype.composedPath=function(){
 var out=[],n=this.target;while(n){out.push(n);n=n.parentNode;}out.push(D);out.push(W);return out;};

/* MessageChannel, which schedulers use to get a macrotask: React and
 * YouTube's player both post to a port instead of calling setTimeout(0),
 * because a real browser clamps nested timeouts and does not clamp this.
 * A timer is the honest equivalent here -- delivery stays asynchronous
 * and ordered, which is what the schedulers depend on. */
function MessagePort(){this._peer=null;this._l=[];this.onmessage=null;}
MessagePort.prototype.postMessage=function(data){
 var p=this._peer;if(!p)return;
 setTimeout(function(){
  var e={data:data,type:'message',target:p,currentTarget:p,source:null,origin:'',ports:[],
         preventDefault:function(){},stopPropagation:function(){}};
  if(typeof p.onmessage==='function'){try{p.onmessage(e);}catch(x){console.error(x);}}
  p._l.slice().forEach(function(f){try{f.call(p,e);}catch(x){console.error(x);}});
 },0);
};
MessagePort.prototype.addEventListener=function(t,f){if(t==='message'&&typeof f==='function')this._l.push(f);};
MessagePort.prototype.removeEventListener=function(t,f){this._l=this._l.filter(function(g){return g!==f;});};
MessagePort.prototype.start=function(){};
MessagePort.prototype.close=function(){this._peer=null;this._l=[];this.onmessage=null;};
MessagePort.prototype.dispatchEvent=function(){return true;};
function MessageChannel(){this.port1=new MessagePort();this.port2=new MessagePort();this.port1._peer=this.port2;this.port2._peer=this.port1;}
W.MessageChannel=MessageChannel;W.MessagePort=MessagePort;
W.MessageEvent=W.MessageEvent||Event;
/* The three with real fields; the aliases above stay plain Events. */
W.UIEvent=UIEventC;W.MouseEvent=MouseEventC;W.KeyboardEvent=KeyboardEventC;
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
W.atob=function(s){s=String(s).replace(/[^A-Za-z0-9+\/=]/g,'');var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',o='',i=0;while(i<s.length){var a=A.indexOf(s.charAt(i++)),b=A.indexOf(s.charAt(i++)),c=A.indexOf(s.charAt(i++)),d=A.indexOf(s.charAt(i++));var n=(a<<18)|(b<<12)|((c&63)<<6)|(d&63);o+=String.fromCharCode((n>>16)&255);if(c!==64&&c>=0)o+=String.fromCharCode((n>>8)&255);if(d!==64&&d>=0)o+=String.fromCharCode(n&255);}return o;};
W.btoa=function(s){s=String(s);var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',o='',i=0;while(i<s.length){var a=s.charCodeAt(i++),b=s.charCodeAt(i++),c=s.charCodeAt(i++);var n=(a<<16)|((b||0)<<8)|(c||0);o+=A.charAt((n>>18)&63)+A.charAt((n>>12)&63)+(isNaN(b)?'=':A.charAt((n>>6)&63))+(isNaN(c)?'=':A.charAt(n&63));}return o;};
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
/* A dynamic import() in page code arrives here (qjs.c rewrites the call
 * with the importing script's name as base). QuickJS loads modules
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

/* --- XMLHttpRequest and fetch over __vitaFetch (qjs.c) --- */
function XMLHttpRequest(){this.readyState=0;this.status=0;this.statusText='';this.responseText='';this.response='';this.responseType='';this.responseURL='';this.timeout=0;this.withCredentials=false;this._h={};this._l={};this._id=0;this._rh='';this.upload={addEventListener:function(){},removeEventListener:function(){}};}
XMLHttpRequest.prototype={
UNSENT:0,OPENED:1,HEADERS_RECEIVED:2,LOADING:3,DONE:4,
open:function(m,u){this._m=String(m||'GET').toUpperCase();this._u=String(u);this._h={};this._set(1);},
setRequestHeader:function(k,v){this._h[String(k)]=String(v);},
addEventListener:function(t,f){(this._l[t]=this._l[t]||[]).push(f);},
removeEventListener:function(t,f){if(this._l[t])this._l[t]=this._l[t].filter(function(g){return g!==f;});},
dispatchEvent:function(e){this._emit(e.type);return true;},
_emit:function(t){var e={type:t,target:this,currentTarget:this,lengthComputable:false,loaded:0,total:0,preventDefault:function(){},stopPropagation:function(){}};var f=this['on'+t];if(typeof f==='function')f.call(this,e);(this._l[t]||[]).forEach(function(g){if(typeof g==='function')g.call(this,e);else if(g&&g.handleEvent)g.handleEvent(e);},this);},
_set:function(s){this.readyState=s;this._emit('readystatechange');},
_body:function(b){if(b===undefined||b===null)return null;if(typeof b==='string')return b;if(b instanceof URLSearchParams){if(!this._h['Content-Type'])this._h['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';return b.toString();}
 if(b instanceof FormData){if(!this._h['Content-Type'])this._h['Content-Type']='application/x-www-form-urlencoded;charset=UTF-8';return b._urlencoded();}
 if(b instanceof ArrayBuffer||ArrayBuffer.isView(b)){var v=new Uint8Array(b.buffer||b),s='';for(var i=0;i<v.length;i++)s+=String.fromCharCode(v[i]);return s;}return String(b);},
send:function(body){var self=this;if(this.readyState!==1)return;var data=this._body(body);var hs=[];for(var k in this._h)hs.push(k+': '+this._h[k]);
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
 this._id=__vitaFetch(this._u,this._m,hs,data,this.timeout|0,done);
 if(!this._id)setTimeout(function(){done(0,'',new ArrayBuffer(0),'request refused','');},0);},
abort:function(){if(this._id){__vitaFetchAbort(this._id);this._id=0;}if(this.readyState!==0&&this.readyState!==4){this.readyState=4;this.status=0;this._emit('readystatechange');this._emit('abort');this._emit('loadend');}this.readyState=0;},
getResponseHeader:function(n){var lines=this._rh.split('\n'),p=String(n).toLowerCase()+':';for(var i=0;i<lines.length;i++){if(lines[i].toLowerCase().indexOf(p)===0)return lines[i].slice(p.length).trim();}return null;},
getAllResponseHeaders:function(){return this._rh?this._rh.replace(/\n/g,'\r\n'):'';},
overrideMimeType:function(){}};
W.XMLHttpRequest=XMLHttpRequest;W.XMLHttpRequestUpload=function(){};W.XMLHttpRequestEventTarget=function(){};
function FormData(form){this._p=[];if(form&&form.getElementsByTagName){['input','select','textarea'].forEach(function(t){var els=form.getElementsByTagName(t);for(var i=0;i<els.length;i++){var e=els[i],n=e.getAttribute('name');if(!n||e.disabled)continue;var ty=(e.getAttribute('type')||'').toLowerCase();if(ty==='checkbox'||ty==='radio'){if(e.checked)this._p.push([n,e.value||'on']);}else if(ty!=='submit'&&ty!=='button'&&ty!=='file')this._p.push([n,e.value]);}},this);}}
FormData.prototype={append:function(k,v){this._p.push([String(k),String(v)]);},set:function(k,v){this['delete'](k);this.append(k,v);},get:function(k){for(var i=0;i<this._p.length;i++)if(this._p[i][0]===k)return this._p[i][1];return null;},
getAll:function(k){return this._p.filter(function(p){return p[0]===k;}).map(function(p){return p[1];});},has:function(k){return this.get(k)!==null;},'delete':function(k){this._p=this._p.filter(function(p){return p[0]!==k;});},
forEach:function(f,t){this._p.forEach(function(p){f.call(t,p[1],p[0]);});},entries:function(){return this._p.map(function(p){return [p[0],p[1]];})[Symbol.iterator]();},keys:function(){return this._p.map(function(p){return p[0];})[Symbol.iterator]();},values:function(){return this._p.map(function(p){return p[1];})[Symbol.iterator]();},
_urlencoded:function(){return this._p.map(function(p){return encodeURIComponent(p[0])+'='+encodeURIComponent(p[1]);}).join('&');}};
FormData.prototype[Symbol.iterator]=FormData.prototype.entries;W.FormData=FormData;
function Headers(init){this._m={};if(init){if(init instanceof Headers)init.forEach(function(v,k){this.append(k,v);},this);else if(Array.isArray(init))init.forEach(function(p){this.append(p[0],p[1]);},this);else for(var k in init)this.append(k,init[k]);}}
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

function ceUpgrade(el,inDoc){
 if(el.__ceState)return;
 var d=ceDefOf(el);if(!d)return;
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
    for(up=e;up&&up!==n;up=up.parentNode);
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
  /* upgrade what the parser already built */
  var list=D.getElementsByTagName(CE[name].ext||name);
  for(var j=0;j<list.length;j++)ceUpgrade(list[j]);
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
W.__vitaBeforeScript=sweepTemplates;
W.addEventListener('DOMContentLoaded',function(){
 sweepTemplates();
 if(CEn)ceConnectTree(D.documentElement,true,false);});
W.addEventListener('load',function(){
 sweepTemplates();
 if(CEn)ceConnectTree(D.documentElement,true,false);});

/* Shadow DOM, as light DOM. A shadow root is the element itself, so
 * there is no style or selector scoping, which is the point: content put
 * in a shadow root still lays out and still renders, where an
 * unimplemented attachShadow renders nothing at all. shadowRoot stays
 * null until attachShadow is called, because components test it to find
 * out whether they have already built themselves. */
P.attachShadow=function(){Object.defineProperty(this,'__shadow',{configurable:true,value:true,writable:true,enumerable:false});return this;};
P.getRootNode=function(){var n=this;while(n.parentNode)n=n.parentNode;return n===D.documentElement?D:n;};
Object.defineProperty(P,'shadowRoot',{configurable:true,get:function(){return this.__shadow?this:null;}});
Object.defineProperty(P,'host',{configurable:true,get:function(){return this.__shadow?this:undefined;}});
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
 function live(css){var c=canon[css];
  return !!c&&ceInDoc(c)&&c.textContent===css;}
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
      canon[css]=n;
      break;}}}
   if(!l.length)delete parked[css];}
  if(nparked<=0&&timer!==null){ci.call(W,timer);timer=null;nparked=0;}}
 function styleNode(n){
  return n&&n.nodeType===1&&n.tagName==='STYLE'&&
   !(n.attributes&&n.attributes.length);}
 function take(host,n){
  var css=n.textContent;
  if(!css)return;
  if(live(css)){n.textContent='';park(n,css);return;}
  canon[css]=n;}
 function fix(host,n){
  if(!host.__shadow||!n)return;
  if(styleNode(n))take(host,n);
  else if(n.nodeType===11)
   for(var c=n.firstChild;c;c=c.nextSibling)if(styleNode(c))take(host,c);}
 var app=P.appendChild,ins=P.insertBefore;
 P.appendChild=function(n){fix(this,n);return app.apply(this,arguments);};
 P.insertBefore=function(n,r){fix(this,n);return ins.apply(this,arguments);};
 var d=Object.getOwnPropertyDescriptor(P,'innerHTML');
 if(!d||!d.set)return;
 Object.defineProperty(P,'innerHTML',{configurable:true,get:d.get,set:function(v){
  var fresh=[],emptied=[];
  if(this.__shadow&&typeof v==='string'&&v.indexOf('<style')>=0)
   v=v.replace(/<style>([\s\S]*?)<\/style>/gi,function(m,css){
    if(css&&live(css)){emptied.push(css);return '<style></style>';}
    if(css)fresh.push(css);
    return m;});
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
     if(st[i].textContent===fresh[j])canon[fresh[j]]=st[i];}
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
  if(typeof v==='string'&&v&&(p=this.parentNode)&&p.__shadow&&styleNode(this)){
   if(live(v)){
    if(canon[v]!==this){t.set.call(this,'');park(this,v);}
    return;}
   t.set.call(this,v);canon[v]=this;return;}
  t.set.call(this,v);}});
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
/* No shadow tree exists here (attachShadow hands the host back), so
 * nothing may be an instance of ShadowRoot. When it was the base of every
 * element, Alpine's tree walk, which asks each node whether it is one and
 * then visits only its children, descended through the whole page without
 * processing a single directive. */
W.ShadowRoot=function ShadowRoot(){throw new TypeError('Illegal constructor');};
W.ShadowRoot.prototype=Object.create(P);

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
P.attachInternals=function(){var el=this;return {shadowRoot:el.shadowRoot,form:el.form,
 setFormValue:function(){},setValidity:function(){},checkValidity:function(){return true;},
 reportValidity:function(){return true;},validity:el.validity,validationMessage:'',
 willValidate:false,labels:el.labels,states:new TokenList(null,'')};};
/* Popovers, as a plain show and hide: there is no top layer here, so an
 * open popover is a visible element and a closed one is hidden. */
P.showPopover=function(){this.removeAttribute('hidden');this.__popopen=true;
 this.dispatchEvent(new Event('beforetoggle'));};
P.hidePopover=function(){this.setAttribute('hidden','');this.__popopen=false;
 this.dispatchEvent(new Event('beforetoggle'));};
P.togglePopover=function(force){var open=force===undefined?!this.__popopen:!!force;
 if(open)this.showPopover();else this.hidePopover();return open;};
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
/* A fresh list per read. A browser hands back the same object every time
   and code occasionally compares them, but caching it here means the
   indices go stale when the attribute is changed from elsewhere, and
   wrong contents are worse than a wrong identity. */
Object.defineProperty(P,'classList',{configurable:true,
 get:function(){return new TokenList(this,'class');},
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
/* host doubles as the shadow root's host, which wins when there is one. */
Object.defineProperty(P,'host',{configurable:true,
 get:function(){if(this.__shadow)return this;if(!isURLEl(this))return undefined;
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
 this.dispatchEvent(new Event('invalid',{bubbles:false,cancelable:true}));
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
 this.selectionDirection=d||'none';this.dispatchEvent(new Event('select'));};
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
  return listOf(self.querySelectorAll(
   'input,select,textarea,button,fieldset,object,output'));},
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
   d.set.call(this,v);}});})();
P.requestSubmit=function(submitter){
 if(!this.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))return;
 this.submit(submitter);};
P.submit=function(){
 if(this.tagName!=='FORM')return;
 var method=String(this.getAttribute('method')||'get').toLowerCase();
 var action=this.action||D.baseURI;
 if(method!=='get')return;   /* a navigation cannot carry a body here */
 var q=new URLSearchParams('');
 listOf(this.elements).forEach(function(c){
  var n=c.name;if(!n||c.disabled)return;
  var t=String(c.type||'').toLowerCase();
  if(t==='submit'||t==='button'||t==='reset'||t==='file')return;
  if((t==='checkbox'||t==='radio')&&!c.checked)return;
  q.append(n,c.value===undefined?'':c.value);});
 /* Navigating in the middle of a dispatch tears down the page the
    dispatch is walking; let the current task finish first. */
 try{var u=new URL(action,D.baseURI);u.searchParams=q;
  var href=u.href;
  setTimeout(function(){try{location.href=href;}catch(e){}},0);
 }catch(e){}};
P.reset=function(){
 if(this.tagName!=='FORM')return;
 if(!this.dispatchEvent(new Event('reset',{bubbles:true,cancelable:true})))return;
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
Object.defineProperty(P,'contentDocument',{configurable:true,get:function(){return null;}});
Object.defineProperty(P,'contentWindow',{configurable:true,get:function(){return null;}});
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
D.adoptedStyleSheets=[];
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
P.setHTML=P.setHTMLUnsafe=function(h){this.innerHTML=String(h);};
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
Object.defineProperty(W,'origin',{configurable:true,get:function(){
 try{return new URL(location.href).origin;}catch(e){return 'null';}}});
Object.defineProperty(W,'isSecureContext',{configurable:true,get:function(){
 return String(location.href).indexOf('https:')===0;}});
W.crossOriginIsolated=false;
W.originAgentCluster=false;
W.frameElement=null;
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
function parseDecl(t){var out=[];
 String(t||'').split(';').forEach(function(d){
  var i=d.indexOf(':');if(i<0)return;
  var n=d.slice(0,i).trim().toLowerCase(),v=d.slice(i+1).trim(),pr='';
  if(!n||!v)return;
  if(/!\s*important$/i.test(v)){pr='important';v=v.replace(/!\s*important$/i,'').trim();}
  out.push([n,v,pr]);});
 return out;}
function serialDecl(list){return list.map(function(d){
 return d[0]+': '+d[1]+(d[2]?' !'+d[2]:'')+';';}).join(' ');}
function CSSStyleDeclaration(el){this._e=el;}
CSSStyleDeclaration.prototype._d=function(){
 return this._e?parseDecl(this._e.getAttribute('style')):(this._own||(this._own=[]));};
CSSStyleDeclaration.prototype._w=function(list){
 if(this._e)this._e.setAttribute('style',serialDecl(list));else this._own=list;};
CSSStyleDeclaration.prototype.getPropertyValue=function(n){
 n=cssName(n);var d=this._d();
 for(var i=0;i<d.length;i++)if(d[i][0]===n)return d[i][1];
 return '';};
CSSStyleDeclaration.prototype.getPropertyPriority=function(n){
 n=cssName(n);var d=this._d();
 for(var i=0;i<d.length;i++)if(d[i][0]===n)return d[i][2];
 return '';};
CSSStyleDeclaration.prototype.setProperty=function(n,v,pr){
 n=cssName(n);
 if(v===''||v===null||v===undefined)return this.removeProperty(n);
 var d=this._d(),done=false;
 for(var i=0;i<d.length;i++)if(d[i][0]===n){d[i][1]=String(v);d[i][2]=pr||'';done=true;}
 if(!done)d.push([n,String(v),pr||'']);
 this._w(d);};
CSSStyleDeclaration.prototype.removeProperty=function(n){
 n=cssName(n);var old=this.getPropertyValue(n);
 this._w(this._d().filter(function(x){return x[0]!==n;}));
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
function CSSRule(){this.cssText='';this.parentRule=null;this.parentStyleSheet=null;this.type=1;
 this.style=new CSSStyleDeclaration(null);this.selectorText='';}
function MediaList(t){this._m=t?String(t).split(','):[];}
Object.defineProperty(MediaList.prototype,'mediaText',{configurable:true,
 get:function(){return this._m.join(', ');},set:function(v){this._m=String(v).split(',');}});
Object.defineProperty(MediaList.prototype,'length',{configurable:true,get:function(){return this._m.length;}});
MediaList.prototype.item=function(i){return this._m[i]===undefined?null:this._m[i];};
MediaList.prototype.appendMedium=function(m){this._m.push(String(m));};
MediaList.prototype.deleteMedium=function(m){this._m=this._m.filter(function(x){return x!==m;});};
MediaList.prototype.toString=function(){return this.mediaText;};
function CSSStyleSheet(owner){this.ownerNode=owner||null;this.ownerRule=null;
 this.parentStyleSheet=null;this.disabled=false;this.type='text/css';
 this.href=owner&&owner.href?owner.href:null;this.title=owner?owner.title:'';
 this.media=new MediaList(owner?owner.media:'');
 /* The rules are not exposed: libcss keeps the parsed sheet and there is
  * no serialisation back out of it. An empty list is what a cross-origin
  * sheet gives, which is the case code already handles. */
 this.cssRules=[];this.rules=this.cssRules;}
CSSStyleSheet.prototype.insertRule=function(){return 0;};
CSSStyleSheet.prototype.deleteRule=function(){};
CSSStyleSheet.prototype.addRule=function(){return -1;};
CSSStyleSheet.prototype.removeRule=function(){};
CSSStyleSheet.prototype.replace=function(){return Promise.resolve(this);};
CSSStyleSheet.prototype.replaceSync=GAP('CSSStyleSheet.replaceSync');
W.CSSRule=CSSRule;W.CSSStyleRule=CSSRule;W.MediaList=MediaList;
W.StyleSheet=W.CSSStyleSheet=CSSStyleSheet;
Object.defineProperty(D,'styleSheets',{configurable:true,get:function(){
 var l=D.querySelectorAll('style,link[rel~="stylesheet"]').map(function(n){
  return new CSSStyleSheet(n);});
 l.item=function(i){return this[i]||null;};
 return l;}});
Object.defineProperty(P,'sheet',{configurable:true,get:function(){
 var t=this.tagName;return (t==='STYLE'||t==='LINK')?new CSSStyleSheet(this):null;}});

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
  this.type=String(type);
  this.bubbles=!!init.bubbles;this.cancelable=!!init.cancelable;this.composed=!!init.composed;
  this.defaultPrevented=false;this.target=init.target||null;this.currentTarget=null;
  Object.keys(all).forEach(function(kk){
   this[kk]=init[kk]!==undefined?init[kk]:all[kk];},this);};
 C.prototype=Object.create((base||Event).prototype);
 C.prototype.constructor=C;
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
P.importNode=function(n,deep){
 var c=n&&n.cloneNode?n.cloneNode(!!deep):null;
 return c;};
P.adoptNode=function(n){return n;};
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
 this.dispatchEvent(new Event('beforetoggle'));};
P.close=function(v){if(v!==undefined)this.returnValue=String(v);
 this.removeAttribute('open');this.dispatchEvent(new Event('close'));};
P.requestClose=function(v){if(this.dispatchEvent(new Event('cancel',{cancelable:true})))this.close(v);};
Object.defineProperty(P,'returnValue',{configurable:true,
 get:function(){return this.__returnValue||'';},set:function(v){this.__returnValue=String(v);}});
Object.defineProperty(P,'closedBy',{configurable:true,
 get:function(){return this.getAttribute('closedby')||'auto';},
 set:function(v){this.setAttribute('closedby',String(v));}});
/* A slot with no shadow tree shows whatever was assigned to it in the
 * light DOM, which here is the host's children with a matching slot. */
P.assignedNodes=function(){
 if(this.tagName!=='SLOT')return [];
 var name=this.name||'',host=this.parentNode;
 if(!host)return [];
 return host.childNodes.filter(function(n){
  return n.nodeType!==1?name==='':(n.getAttribute('slot')||'')===name;});};
P.assignedElements=function(){return this.assignedNodes().filter(function(n){return n.nodeType===1;});};
P.assign=function(){};
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
   self.dispatchEvent(new Event('ended'));},0);
  return Promise.reject(new Error('NotSupportedError: no media decoder'));};
 P.pause=function(){this.__paused=true;this.dispatchEvent(new Event('pause'));};
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
Object.defineProperty(P,'mode',{configurable:true,get:function(){return this.__shadow?'open':undefined;}});
Object.defineProperty(P,'activeElement',{configurable:true,get:function(){return D.body;}});
Object.defineProperty(P,'delegatesFocus',{configurable:true,get:function(){return false;}});
Object.defineProperty(P,'slotAssignment',{configurable:true,get:function(){return 'named';}});
Object.defineProperty(P,'clonable',{configurable:true,get:function(){return false;}});
Object.defineProperty(P,'serializable',{configurable:true,get:function(){return false;}});
Object.defineProperty(P,'styleSheets',{configurable:true,get:function(){
 var l=[];l.item=function(i){return this[i]||null;};return l;}});
P.adoptedStyleSheets=[];
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
 var observers=[],timer=null,lastScroll='',lastGen=-1;

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
   var b=__vitaBox(o.root);
   if(b)return {left:b[0]-s[0],top:b[1]-s[1],width:b[2],height:b[3]};}
  return {left:0,top:0,width:s[2],height:s[3]};}

 function rectOf(el){
  var b=__vitaBox(el);
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
   var t=o.__targets[i],r=rectOf(t.el);
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
    rootBounds:box(bounds),boundingClientRect:box(r),
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
  /* nothing that could move anything has happened */
  if(key===lastScroll&&g===lastGen)return;
  lastScroll=key;lastGen=g;
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
  var self=this;
  setTimeout(function(){ check(self,false); },0);};

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
W.Blob=Blob;
function File(parts,name,opts){Blob.call(this,parts,opts);
 this.name=String(name);this.lastModified=(opts&&opts.lastModified)||Date.now();
 this.webkitRelativePath='';}
File.prototype=Object.create(Blob.prototype);File.prototype.constructor=File;
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
URL.createObjectURL=function(o){var u='blob:'+String(location.href)+'/'+(++blobSeq);
 blobURLs[u]=o;return u;};
URL.revokeObjectURL=function(u){delete blobURLs[u];};
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
 if(this.nodeType===9)return docById(this,id);
 if(this.nodeType!==11)return null;
 return docById(this,id);};

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
W.CSS.supports=W.CSS.supports||function(){return false;};
/* fetch of an object URL comes from the table, not from the network. */
(function(){var real=W.fetch;
 W.fetch=function(input,init){
  var u=String((input&&input.url)||input||'');
  if(u.indexOf('blob:')===0){
   var b=blobURLs[u];
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
  return s+inner(n)+'</'+tag+'>';}
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
 P.getHTML=function(){return this.innerHTML;};
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
    /* the first frames: one alone often names only a helper */
    var fr=String(v.stack).split('\n').slice(1,5).filter(function(f){return f.trim();});
    if(fr.length)out+=' | '+fr.map(function(f){return f.replace(/^\s+/,'').slice(0,160);}).join(' | ');}
   return out;}
  return String(v);
 }catch(e2){return '(unprintable)';}
}
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
  try{console.error('uncaught'+(from?' in '+from:'')+': '+describeThrown(err)+
   (file?' ('+file+':'+line+':'+col+')':''));}catch(e6){}}
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
MutationObserver.prototype._wants=function(kind,target,name,chain,pairs){
 var i,j,w,depth;
 for(i=0;i<this._watch.length;i++){
  w=this._watch[i];
  /* the watched nodes C found and their depths, a short dense list
     (VitaSurf): the sparse chain built from them was a slow array,
     and an indexOf on it for every watch of every observer was a
     real share of each appendChild and setAttribute on GitHub */
  if(pairs){depth=-1;
   for(j=0;j<pairs.length;j+=2)if(pairs[j]===w.target){depth=pairs[j+1];break;}}
  else depth=chain.indexOf(w.target);
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
  return false;});
 /* and C keeps a copy, so a change no observer wants never reaches
    this file (VitaSurf); see mo_wanted in qjs.c */
 w.id=++MOid;
 if(typeof __vitaMOWatch==='function')
  __vitaMOWatch(w.id,target,(w.subtree?1:0)|(w.attributes?2:0)|
   (w.childList?4:0)|(w.characterData?8:0),w.filter);
 this._watch.push(w);
 if(MOlist.indexOf(this)<0)MOlist.push(this);
 if(typeof __vitaWatchMutations==='function')__vitaWatchMutations(true);};
MutationObserver.prototype.disconnect=function(){
 if(typeof __vitaMOUnwatch==='function')
  for(var i=0;i<this._watch.length;i++)__vitaMOUnwatch(this._watch[i].id);
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
W.__vitaMutation=function(kind,target,a,b,ns,matches){
 if(!MOlist.length||!target)return;
 var i,o,w,rec,n;
 /* once for every observer, not once per watch entry of each */
 var chain=null;
 /* C has already walked it and found which watched nodes sit where
    (VitaSurf), and _wants reads those pairs; without them, the chain */
 if(!matches){chain=[];for(n=target;n;n=n.parentNode)chain.push(n);}
 for(i=0;i<MOlist.length;i++){
  o=MOlist[i];
  w=o._wants(kind,target,kind==='attributes'?a:null,chain,matches);
  if(!w)continue;
  rec=new MutationRecord(kind,target);
  if(kind==='attributes'){
   rec.attributeName=String(a);
   rec.attributeNamespace=(ns===undefined||ns===null)?null:String(ns);
   if(w.attributeOldValue)rec.oldValue=b===null?null:String(b);
  }else if(kind==='characterData'){
   if(w.characterDataOldValue)rec.oldValue=b===null?null:String(b);
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
/* A node cannot contain itself or anything it is inside. */
function containsNode(parent,node){
 for(var n=parent;n;n=n.parentNode)if(n===node)return true;
 return false;}
var CAN_HAVE_CHILDREN={1:true,9:true,11:true};
function preInsert(parent,node,child,fn,replacing){
 needNode(node,fn,1);
 if(!CAN_HAVE_CHILDREN[parent.nodeType])
  throw hierarchy('This node type does not support this method.');
 if(containsNode(parent,node))
  throw hierarchy('The new child element contains the parent.');
 if(child!==null&&child!==undefined&&child.parentNode!==parent)
  throw new DOMException(
   'The node before which the new node is to be inserted is not a child '+
   'of this node.','NotFoundError');
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
  if(from)Object.getOwnPropertyNames(from).forEach(function(k){
   if(k==='prototype'||k==='length'||k==='name'||k==='caller'||
      k==='arguments')return;
   try{Object.defineProperty(F,k,
    Object.getOwnPropertyDescriptor(from,k));}catch(e){}});
  try{Object.defineProperty(F,Symbol.hasInstance,
   {configurable:true,value:test});}catch(e){}
  stampConsts(F);
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
   }else n=BY_TYPE[t];
   return (n&&W[n])||W.Node;},
  set:function(v){shadowProp(this,'constructor',v);}});
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
  if(W.CharacterData)W.CharacterData.prototype=N;
 }catch(e){}
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
})();
