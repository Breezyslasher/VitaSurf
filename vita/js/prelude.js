/*
 * JavaScript side of the QuickJS bindings: shims that are simplest to
 * express in JS. CMake embeds this file as prelude_js.h and qjs.c runs it
 * once per page context, after the C bindings are installed. Node is a
 * good place to test it: mock Node, document and window and load it.
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */
(function(){
var P=Node.prototype;
function priv(o,k,make){if(!Object.prototype.hasOwnProperty.call(o,k))Object.defineProperty(o,k,{value:make(),writable:true});return o[k];}
Object.defineProperty(P,'style',{get:function(){return priv(this,'__style',function(){return {getPropertyValue:function(){return '';},setProperty:function(){},removeProperty:function(){},cssText:''};});}});
Object.defineProperty(P,'dataset',{get:function(){return priv(this,'__dataset',function(){return {};});}});
Object.defineProperty(P,'classList',{get:function(){var el=this;return {contains:function(c){return (' '+el.className+' ').indexOf(' '+c+' ')>=0;},add:function(){for(var i=0;i<arguments.length;i++){if(!this.contains(arguments[i]))el.className=(el.className?el.className+' ':'')+arguments[i];}},remove:function(){for(var i=0;i<arguments.length;i++){el.className=(' '+el.className+' ').split(' '+arguments[i]+' ').join(' ').trim();}},toggle:function(c,f){var h=this.contains(c);if(f===undefined)f=!h;if(f&&!h)this.add(c);else if(!f&&h)this.remove(c);return f;},get length(){return el.className?el.className.split(/\s+/).length:0;}};}});
Object.defineProperty(P,'children',{get:function(){return this.childNodes.filter(function(n){return n.nodeType===1;});}});
Object.defineProperty(P,'firstElementChild',{get:function(){var c=this.children;return c.length?c[0]:null;}});
Object.defineProperty(P,'lastElementChild',{get:function(){var c=this.children;return c.length?c[c.length-1]:null;}});
Object.defineProperty(P,'parentElement',{get:function(){var p=this.parentNode;return p&&p.nodeType===1?p:null;}});
Object.defineProperty(P,'innerText',{get:function(){return this.textContent;},set:function(v){this.textContent=v;}});
Object.defineProperty(P,'outerHTML',{get:function(){return '';}});
Object.defineProperty(P,'ownerDocument',{get:function(){return document;}});
['href','src','value','type','name','title','alt','rel','target','action','method','placeholder','lang','dir','htmlFor','content','charset','width','height'].forEach(function(a){var attr=a==='htmlFor'?'for':a;Object.defineProperty(P,a,{configurable:true,get:function(){var v=this.getAttribute(attr);return v===null?'':v;},set:function(v){this.setAttribute(attr,String(v));}});});
['disabled','checked','hidden','readOnly','selected','multiple','required'].forEach(function(a){var attr=a.toLowerCase();Object.defineProperty(P,a,{get:function(){return this.hasAttribute(attr);},set:function(v){if(v)this.setAttribute(attr,'');else this.removeAttribute(attr);}});});
/* Layout geometry. __vitaBox(node) (qjs.c) returns the element's laid-out
   box as [x,y,width,height,clientWidth,clientHeight,clientLeft,clientTop,
   scrollWidth,scrollHeight,scrollLeft,scrollTop] in CSS px, document
   coordinates, border box; null when the element has no box. viewport()
   returns [scrollX,scrollY,viewportWidth,viewportHeight]. */
function boxOf(el){var b=__vitaBox(el);return b||[0,0,0,0,0,0,0,0,0,0,0,0];}
function viewport(){return __vitaScroll()||[0,0,960,544];}
function isViewportEl(el){return el===D.documentElement;}
var BOXIDX={offsetWidth:2,offsetHeight:3,clientLeft:6,clientTop:7,scrollWidth:8,scrollHeight:9};
Object.keys(BOXIDX).forEach(function(a){var i=BOXIDX[a];Object.defineProperty(P,a,{get:function(){return boxOf(this)[i];}});});
['clientWidth','clientHeight'].forEach(function(a,n){Object.defineProperty(P,a,{get:function(){if(isViewportEl(this)){return viewport()[2+n];}return boxOf(this)[4+n];}});});
Object.defineProperty(P,'offsetParent',{get:function(){var n=this.parentNode;while(n&&n.nodeType===1&&n!==D.body&&n!==D.documentElement)n=n.parentNode;return n&&n.nodeType===1?n:null;}});
['offsetTop','offsetLeft'].forEach(function(a,n){Object.defineProperty(P,a,{get:function(){var b=__vitaBox(this);if(!b)return 0;var p=this.offsetParent,pb=p?__vitaBox(p):null;return b[1-n]-(pb?pb[1-n]:0);}});});
['scrollTop','scrollLeft'].forEach(function(a,n){Object.defineProperty(P,a,{get:function(){if(isViewportEl(this)||this===D.body){return viewport()[1-n];}return boxOf(this)[11-n];},set:function(v){if(isViewportEl(this)||this===D.body){var s=viewport();__vitaScrollTo(n===1?Number(v)||0:s[0],n===1?s[1]:Number(v)||0);}}});});
P.tabIndex=0;
['onclick','onchange','onsubmit','oninput','onkeydown','onkeyup','onkeypress','onmousedown','onmouseup','onmouseover','onmouseout','onfocus','onblur','onload','onerror','ontouchstart','ontouchend'].forEach(function(h){Object.defineProperty(P,h,{get:function(){return this['__'+h]||null;},set:function(f){this['__'+h]=f;if(typeof f==='function')this.addEventListener(h.slice(2),function(e){return f.call(this,e);});}});});
P.getBoundingClientRect=function(){var b=__vitaBox(this);if(!b)return {top:0,left:0,right:0,bottom:0,width:0,height:0,x:0,y:0};var s=viewport(),x=b[0]-s[0],y=b[1]-s[1];return {x:x,y:y,left:x,top:y,width:b[2],height:b[3],right:x+b[2],bottom:y+b[3]};};
P.getClientRects=function(){var r=this.getBoundingClientRect();return r.width||r.height?[r]:[];};
P.focus=P.blur=P.select=function(){};
P.scrollIntoView=function(arg){var b=__vitaBox(this);if(!b)return;var s=viewport(),toEnd=(arg===false)||(arg&&(arg.block==='end'||arg.block==='nearest'&&b[1]<s[1]));__vitaScrollTo(s[0],toEnd?b[1]+b[3]-s[3]:b[1]);};
P.click=function(){var e=new MouseEvent('click',{bubbles:true,cancelable:true});return this.dispatchEvent(e);};
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
var SIMPLE_RE=/^([a-zA-Z][\w-]*|\*)?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]*\])*)(?::[\w-]+(?:\([^)]*\))?)*$/;
var ATTR_RE=/\[\s*([\w-]+)\s*(?:([~^$*|]?=)\s*("[^"]*"|'[^']*'|[^\]]*?)\s*)?\]/g;
function parseSimple(sel){var m=SIMPLE_RE.exec(sel);if(!m)return null;
 var attrs=[],a;ATTR_RE.lastIndex=0;
 while(m[4]&&(a=ATTR_RE.exec(m[4]))){attrs.push({name:a[1],op:a[2]||null,val:a[3]===undefined?null:String(a[3]).replace(/^["']|["']$/g,'')});}
 return {tag:m[1]&&m[1]!=='*'?m[1].toUpperCase():null,id:m[2]?m[2].slice(1):null,
  classes:m[3]?m[3].split('.').slice(1):[],attrs:attrs};}
function attrOk(el,q){var v=el.getAttribute(q.name);if(v===null)return false;if(!q.op)return true;
 switch(q.op){case '=':return v===q.val;case '^=':return v.indexOf(q.val)===0;
 case '$=':return q.val.length<=v.length&&v.indexOf(q.val,v.length-q.val.length)>=0;
 case '*=':return v.indexOf(q.val)>=0;
 case '~=':return (' '+v+' ').indexOf(' '+q.val+' ')>=0;
 case '|=':return v===q.val||v.indexOf(q.val+'-')===0;default:return false;}}
function matchSimple(el,q){if(el.nodeType!==1)return false;
 if(q.tag&&el.tagName!==q.tag)return false;
 if(q.id&&el.id!==q.id)return false;
 if(q.classes.length){var cn=el.className;if(!cn)return false;cn=' '+cn+' ';
  for(var i=0;i<q.classes.length;i++)if(cn.indexOf(' '+q.classes[i]+' ')<0)return false;}
 for(var j=0;j<q.attrs.length;j++)if(!attrOk(el,q.attrs[j]))return false;
 return true;}
function matchesCompound(el,parts){var i=parts.length-1;if(!matchSimple(el,parts[i]))return false;
 var n=el.parentNode;i--;
 while(i>=0&&n&&n.nodeType===1){if(matchSimple(n,parts[i]))i--;n=n.parentNode;}
 return i<0;}
function compile(selector){return selector.split(',').map(function(s){
 return s.replace(/^\s+|\s+$/g,'').split(/\s*>\s*|\s+/).map(parseSimple);})
 .filter(function(p){return p.length&&p.every(function(x){return x;});});}
function isInside(root,el){if(root.nodeType===9)return true;var n=el.parentNode;while(n){if(n===root)return true;n=n.parentNode;}return false;}
function select(root,sel,all){
 var groups=compile(String(sel)),out=[];
 if(!groups.length)return out;
 /* one group ending in an id: ask the document directly */
 if(groups.length===1){var key=groups[0][groups[0].length-1];
  if(key.id&&!key.classes.length){var el=document.getElementById(key.id);
   if(el&&isInside(root,el)&&matchesCompound(el,groups[0]))out.push(el);
   return out;}}
 /* candidates for the right-hand simple selector of every group, found
    in one pass through the tree in C (qjs.c) */
 var keys=groups.map(function(g){return g[g.length-1];});
 var cand=__vitaFind(root.nodeType===9?null:root,keys);
 for(var i=0;i<cand.length;i++){var c=cand[i];
  for(var g=0;g<groups.length;g++){if(matchesCompound(c,groups[g])){out.push(c);break;}}
  if(!all&&out.length)return out;}
 return out;}
P.querySelectorAll=function(sel){return select(this,sel,true);};
P.querySelector=function(sel){var r=select(this,sel,false);return r.length?r[0]:null;};
P.matches=P.webkitMatchesSelector=P.msMatchesSelector=function(sel){var el=this;return compile(String(sel)).some(function(g){return matchesCompound(el,g);});};
P.closest=function(sel){var n=this;while(n&&n.nodeType===1){if(n.matches(sel))return n;n=n.parentNode;}return null;};
P.dispatchEvent=function(e){return __vitaDispatch(this,e);};P.getContext=function(){return null;};
P.add=function(o,before){this.insertBefore(o,before||null);};
Object.defineProperty(P,'options',{get:function(){return this.getElementsByTagName('option');}});
Object.defineProperty(P,'selectedIndex',{get:function(){var o=this.options;for(var i=0;i<o.length;i++)if(o[i].hasAttribute('selected'))return i;return o.length?0:-1;},set:function(i){var o=this.options;for(var j=0;j<o.length;j++){if(j===i)o[j].setAttribute('selected','');else o[j].removeAttribute('selected');}}});
Object.defineProperty(P,'selectedOptions',{get:function(){return this.options.filter(function(o){return o.hasAttribute('selected');});}});
var D=document;
D.querySelectorAll=function(s){var r=D.documentElement;return r?r.querySelectorAll(s):[];};
D.querySelector=function(s){var r=D.documentElement;return r?r.querySelector(s):null;};
D.getElementsByClassName=function(c){return D.querySelectorAll('.'+c);};
Object.defineProperty(D,'head',{get:function(){var h=D.getElementsByTagName('head');return h.length?h[0]:null;}});
Object.defineProperty(D,'forms',{get:function(){return D.getElementsByTagName('form');}});
Object.defineProperty(D,'images',{get:function(){return D.getElementsByTagName('img');}});
Object.defineProperty(D,'links',{get:function(){return D.getElementsByTagName('a');}});
Object.defineProperty(D,'scripts',{get:function(){return D.getElementsByTagName('script');}});
D.defaultView=window;D.nodeType=9;D.nodeName='#document';D.documentMode=undefined;D.compatMode='CSS1Compat';D.hidden=false;D.visibilityState='visible';
D.createEvent=function(t){return /custom/i.test(t)?new CustomEvent(''):new Event('');};D.dispatchEvent=function(e){return __vitaDispatch(null,e);};D.hasFocus=function(){return true;};
D.createElementNS=function(ns,t){return D.createElement(t);};D.createAttribute=function(n){return {name:n,value:''};};
function scratchDocument(title){var html=D.createElement('html'),head=D.createElement('head'),body=D.createElement('body');html.appendChild(head);html.appendChild(body);var doc={nodeType:9,nodeName:'#document',documentElement:html,head:head,body:body,title:title||'',defaultView:null,implementation:D.implementation,createElement:function(t){return D.createElement(t);},createElementNS:function(ns,t){return D.createElement(t);},createTextNode:function(t){return D.createTextNode(t);},createDocumentFragment:function(){return D.createDocumentFragment();},createComment:function(){return D.createTextNode('');},getElementsByTagName:function(t){return html.getElementsByTagName(t);},getElementById:function(id){return html.querySelector('#'+id);},querySelector:function(s){return html.querySelector(s);},querySelectorAll:function(s){return html.querySelectorAll(s);},addEventListener:function(){},removeEventListener:function(){},write:function(){},open:function(){},close:function(){}};return doc;}
D.implementation={createHTMLDocument:function(t){return scratchDocument(t);},createDocument:function(){return scratchDocument('');},hasFeature:function(){return true;}};
D.characterSet=D.charset='UTF-8';D.referrer='';D.domain='';
window.NodeFilter={FILTER_ACCEPT:1,FILTER_REJECT:2,FILTER_SKIP:3,SHOW_ALL:0xFFFFFFFF,SHOW_ELEMENT:1,SHOW_TEXT:4,SHOW_COMMENT:128,SHOW_DOCUMENT:256};
D.createTreeWalker=function(root,what,filter){what=what===undefined?0xFFFFFFFF:what;var fn=filter&&(typeof filter==='function'?filter:filter.acceptNode);function ok(n){if(n.nodeType===9)return false;if(!((1<<(n.nodeType-1))&what))return false;return fn?fn(n)===1:true;}function next(n){if(n.firstChild)return n.firstChild;while(n&&n!==root){if(n.nextSibling)return n.nextSibling;n=n.parentNode;}return null;}return {root:root,currentNode:root,nextNode:function(){var n=next(this.currentNode);while(n&&!ok(n))n=next(n);if(n)this.currentNode=n;return n;},firstChild:function(){var n=this.currentNode.firstChild;while(n&&!ok(n))n=n.nextSibling;if(n)this.currentNode=n;return n;},nextSibling:function(){var n=this.currentNode.nextSibling;while(n&&!ok(n))n=n.nextSibling;if(n)this.currentNode=n;return n;},parentNode:function(){var n=this.currentNode.parentNode;if(n&&n!==root&&ok(n)){this.currentNode=n;return n;}return null;}};};
D.createNodeIterator=function(root,what,filter){var w=D.createTreeWalker(root,what,filter);return {nextNode:function(){return w.nextNode();},detach:function(){}};};
Object.defineProperty(D,'URL',{get:function(){return location.href;}});Object.defineProperty(D,'documentURI',{get:function(){return location.href;}});
Object.defineProperty(D,'activeElement',{get:function(){return D.body;}});
D.createComment=function(t){return D.createTextNode('');};D.write=D.writeln=function(){};
D.getElementsByName=function(n){return D.querySelectorAll('[name='+n+']').filter(function(e){return e.getAttribute('name')===n;});};
D.contains=function(n){var r=D.documentElement;return r?r.contains(n):false;};
['onload','onreadystatechange','onclick','onkeydown','onkeyup','onmousemove','ontouchstart'].forEach(function(h){Object.defineProperty(D,h,{get:function(){return D['__'+h]||null;},set:function(f){D['__'+h]=f;if(typeof f==='function')D.addEventListener(h.slice(2),f);}});});
var W=window;
['onload','onerror','onresize','onscroll','onhashchange','onpopstate','onunload','onbeforeunload','onmessage','onpageshow','onclick','onkeydown','onkeyup','ontouchstart'].forEach(function(h){Object.defineProperty(W,h,{get:function(){return W['__'+h]||null;},set:function(f){W['__'+h]=f;if(typeof f==='function'&&h!=='onerror')W.addEventListener(h.slice(2),f);}});});
W.dispatchEvent=function(e){return __vitaDispatch(null,e);};
/* Viewport and scroll position come from the window itself, so a script
   that measures the page sees what is really on screen. */
[['innerWidth',2],['outerWidth',2],['innerHeight',3],['outerHeight',3],['scrollX',0],['pageXOffset',0],['scrollY',1],['pageYOffset',1]].forEach(function(e){Object.defineProperty(W,e[0],{get:function(){return viewport()[e[1]];}});});
W.devicePixelRatio=1;
/* Frame relationships. Scripts test self !== top to find out whether they
   are framed, and a missing top is a ReferenceError that takes the script
   out: Google's page header does exactly that. */
W.top=W.parent=W.frames=W;W.opener=null;
try{Object.defineProperty(W,'length',{get:function(){return D.getElementsByTagName('iframe').length;},configurable:true});}catch(e){}
W.screen={width:960,height:544,availWidth:960,availHeight:544,colorDepth:32,pixelDepth:32,orientation:{type:'landscape-primary'}};
W.focus=W.blur=W.stop=W.print=W.close=function(){};W.open=function(){return null;};
function scrollArgs(a,b){if(a&&typeof a==='object')return [Number(a.left)||0,Number(a.top)||0];return [Number(a)||0,Number(b)||0];}
W.scrollTo=W.scroll=function(a,b){var p=scrollArgs(a,b);__vitaScrollTo(p[0],p[1]);};
W.scrollBy=function(a,b){var p=scrollArgs(a,b),s=viewport();__vitaScrollTo(s[0]+p[0],s[1]+p[1]);};
W.confirm=function(){return false;};W.prompt=function(){return null;};
W.requestAnimationFrame=function(f){return setTimeout(function(){f(Date.now());},16);};W.cancelAnimationFrame=function(h){clearTimeout(h);};
W.requestIdleCallback=function(f){return setTimeout(function(){f({didTimeout:false,timeRemaining:function(){return 10;}});},50);};W.cancelIdleCallback=function(h){clearTimeout(h);};
W.getComputedStyle=function(el){return el&&el.style?el.style:{getPropertyValue:function(){return '';}};};
/* A media query evaluator over the real viewport. Handles the features
   responsive sites actually branch on; anything else is false. */
function mediaFeature(name,value){var s=viewport(),w=s[2],h=s[3],n=parseFloat(value);
 if(/em$/.test(value))n*=16;
 switch(name){
 case 'width':return w===n;case 'min-width':return w>=n;case 'max-width':return w<=n;
 case 'height':return h===n;case 'min-height':return h>=n;case 'max-height':return h<=n;
 case 'aspect-ratio':case 'min-aspect-ratio':case 'max-aspect-ratio':{var p=String(value).split('/'),r=parseFloat(p[0])/(parseFloat(p[1])||1),a=w/(h||1);return name==='min-aspect-ratio'?a>=r:name==='max-aspect-ratio'?a<=r:Math.abs(a-r)<0.001;}
 case 'orientation':return value===(w>=h?'landscape':'portrait');
 case 'prefers-color-scheme':return value==='light'||value==='no-preference';
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
function mediaTerm(t){t=t.replace(/^\s+|\s+$/g,'');
 if(!t)return true;
 if(/^not\s/i.test(t))return !mediaTerm(t.slice(4));
 if(t.charAt(0)==='('){var m=/^\(\s*([\w-]+)\s*(?::\s*([^)]*?))?\s*\)$/.exec(t);if(!m)return false;
  if(m[2]===undefined)return mediaFeature('min-'+m[1],'1')||m[1]==='color';
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
 Object.defineProperty(mql,'matches',{get:function(){return mediaMatches(q);}});
 return mql;};
W.__vitaMediaMatches=mediaMatches;
function Storage(){var d={};this.getItem=function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null;};this.setItem=function(k,v){d[k]=String(v);};this.removeItem=function(k){delete d[k];};this.clear=function(){d={};};this.key=function(i){return Object.keys(d)[i]||null;};Object.defineProperty(this,'length',{get:function(){return Object.keys(d).length;}});}
W.localStorage=new Storage();W.sessionStorage=new Storage();
W.history={length:1,state:null,pushState:function(){},replaceState:function(){},back:function(){},forward:function(){},go:function(){}};
var t0=Date.now();var perf=W.performance||{};W.performance=perf;if(!perf.now)perf.now=function(){return Date.now()-t0;};perf.timing={navigationStart:t0,fetchStart:t0,domainLookupStart:t0,domainLookupEnd:t0,connectStart:t0,connectEnd:t0,requestStart:t0,responseStart:t0,responseEnd:t0,domLoading:t0,domInteractive:t0,domContentLoadedEventStart:t0,domContentLoadedEventEnd:t0,domComplete:t0,loadEventStart:t0,loadEventEnd:t0};perf.navigation={type:0,redirectCount:0};perf.mark=perf.measure=perf.clearMarks=perf.clearMeasures=function(){};perf.getEntries=perf.getEntriesByType=perf.getEntriesByName=function(){return [];};
navigator.language='en-US';navigator.languages=['en-US','en'];navigator.cookieEnabled=true;navigator.onLine=true;navigator.doNotTrack=null;navigator.maxTouchPoints=1;navigator.vendor='';navigator.hardwareConcurrency=1;navigator.sendBeacon=function(){return false;};navigator.javaEnabled=function(){return false;};
location.reload=function(){location.href=location.href;};
['protocol','host','hostname','port','pathname','search','hash','origin'].forEach(function(k){Object.defineProperty(location,k,{get:function(){var m=location.href.match(/^([a-z][a-z0-9+.-]*:)\/\/(([^\/:?#]*)(?::(\d+))?)([^?#]*)(\?[^#]*)?(#.*)?/i)||[];return {protocol:m[1]||'',host:m[2]||'',hostname:m[3]||'',port:m[4]||'',pathname:m[5]||'/',search:m[6]||'',hash:m[7]||'',origin:(m[1]||'')+'//'+(m[2]||'')}[k];}});});
location.toString=function(){return location.href;};
function Event(type,init){this.type=String(type);this.bubbles=!!(init&&init.bubbles);this.cancelable=!!(init&&init.cancelable);this.defaultPrevented=false;this.target=null;this.currentTarget=null;this.timeStamp=Date.now();}
Event.prototype.preventDefault=function(){this.defaultPrevented=true;};Event.prototype.stopPropagation=Event.prototype.stopImmediatePropagation=function(){};Event.prototype.initEvent=function(t,b,c){this.type=t;this.bubbles=!!b;this.cancelable=!!c;};
function CustomEvent(type,init){Event.call(this,type,init);this.detail=init?init.detail:null;}CustomEvent.prototype=Object.create(Event.prototype);
CustomEvent.prototype.initCustomEvent=function(t,b,c,d){this.initEvent(t,b,c);this.detail=d;};
W.Event=Event;W.CustomEvent=CustomEvent;W.UIEvent=W.MouseEvent=W.KeyboardEvent=W.FocusEvent=Event;
W.HTMLDocument=W.Document=function(){};W.Document.prototype=Object.getPrototypeOf(D);
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
W.Window=function(){};W.Window.prototype=Object.getPrototypeOf(W);W.Navigator=W.Location=W.History=W.Screen=W.Storage=Storage;
W.MutationObserver=function(){};W.MutationObserver.prototype.observe=W.MutationObserver.prototype.disconnect=function(){};W.MutationObserver.prototype.takeRecords=function(){return [];};
W.IntersectionObserver=W.ResizeObserver=W.PerformanceObserver=function(){};W.IntersectionObserver.prototype.observe=W.IntersectionObserver.prototype.unobserve=W.IntersectionObserver.prototype.disconnect=function(){};W.ResizeObserver.prototype=W.PerformanceObserver.prototype=W.IntersectionObserver.prototype;
W.atob=function(s){s=String(s).replace(/[^A-Za-z0-9+\/=]/g,'');var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',o='',i=0;while(i<s.length){var a=A.indexOf(s.charAt(i++)),b=A.indexOf(s.charAt(i++)),c=A.indexOf(s.charAt(i++)),d=A.indexOf(s.charAt(i++));var n=(a<<18)|(b<<12)|((c&63)<<6)|(d&63);o+=String.fromCharCode((n>>16)&255);if(c!==64&&c>=0)o+=String.fromCharCode((n>>8)&255);if(d!==64&&d>=0)o+=String.fromCharCode(n&255);}return o;};
W.btoa=function(s){s=String(s);var A='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',o='',i=0;while(i<s.length){var a=s.charCodeAt(i++),b=s.charCodeAt(i++),c=s.charCodeAt(i++);var n=(a<<16)|((b||0)<<8)|(c||0);o+=A.charAt((n>>18)&63)+A.charAt((n>>12)&63)+(isNaN(b)?'=':A.charAt((n>>6)&63))+(isNaN(c)?'=':A.charAt(n&63));}return o;};
function Image(){return document.createElement('img');}W.Image=Image;
function URLSearchParams(init){this._p=[];if(typeof init==='string'){init.replace(/^\?/,'').split('&').forEach(function(kv){if(!kv)return;var i=kv.indexOf('=');var k=i<0?kv:kv.slice(0,i),v=i<0?'':kv.slice(i+1);this._p.push([decodeURIComponent(k.replace(/\+/g,' ')),decodeURIComponent(v.replace(/\+/g,' '))]);},this);}else if(init&&typeof init==='object'){var self=this;(init._p?init._p:Object.keys(init).map(function(k){return [k,init[k]];})).forEach(function(kv){self._p.push([String(kv[0]),String(kv[1])]);});}}
URLSearchParams.prototype={get:function(k){for(var i=0;i<this._p.length;i++)if(this._p[i][0]===k)return this._p[i][1];return null;},getAll:function(k){return this._p.filter(function(p){return p[0]===k;}).map(function(p){return p[1];});},has:function(k){return this.get(k)!==null;},set:function(k,v){var d=false;this._p=this._p.filter(function(p){if(p[0]!==k)return true;if(d)return false;p[1]=String(v);d=true;return true;});if(!d)this._p.push([k,String(v)]);},append:function(k,v){this._p.push([k,String(v)]);},'delete':function(k){this._p=this._p.filter(function(p){return p[0]!==k;});},forEach:function(f,t){this._p.forEach(function(p){f.call(t,p[1],p[0]);});},keys:function(){return this._p.map(function(p){return p[0];})[Symbol.iterator]();},values:function(){return this._p.map(function(p){return p[1];})[Symbol.iterator]();},entries:function(){return this._p.map(function(p){return [p[0],p[1]];})[Symbol.iterator]();},toString:function(){return this._p.map(function(p){return encodeURIComponent(p[0])+'='+encodeURIComponent(p[1]);}).join('&');},sort:function(){this._p.sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0;});}};
URLSearchParams.prototype[Symbol.iterator]=URLSearchParams.prototype.entries;Object.defineProperty(URLSearchParams.prototype,'size',{get:function(){return this._p.length;}});
var URL_RE=/^([a-z][a-z0-9+.-]*:)?(?:\/\/(?:([^:@\/?#]*)(?::([^@\/?#]*))?@)?([^:\/?#]*)(?::(\d+))?)?([^?#]*)(\?[^#]*)?(#.*)?$/i;
function URL(url,base){url=String(url);var m=URL_RE.exec(url);if(!m)throw new TypeError('Invalid URL');if(!m[1]){if(base===undefined)throw new TypeError('Invalid URL');var b=new URL(String(base));var path=m[6];if(url.indexOf('//')===0){m[1]=b.protocol;m=URL_RE.exec(b.protocol+url);}else{m[1]=b.protocol;m[2]=b.username;m[3]=b.password;m[4]=b.hostname;m[5]=b.port;if(path===''){m[6]=b.pathname;if(!m[7])m[7]=b.search;}else if(path.charAt(0)!=='/'){var dir=b.pathname.replace(/[^\/]*$/,'');m[6]=dir+path;}var segs=[];m[6].split('/').forEach(function(sg){if(sg==='..')segs.pop();else if(sg!=='.')segs.push(sg);});m[6]=segs.join('/');if(m[6].charAt(0)!=='/')m[6]='/'+m[6];}}this.protocol=(m[1]||'').toLowerCase();this.username=m[2]||'';this.password=m[3]||'';this.hostname=(m[4]||'').toLowerCase();this.port=m[5]||'';this.pathname=m[6]||(this.hostname?'/':'');this.search=m[7]&&m[7]!=='?'?m[7]:'';this.hash=m[8]&&m[8]!=='#'?m[8]:'';this.searchParams=new URLSearchParams(this.search);}
Object.defineProperties(URL.prototype,{host:{get:function(){return this.hostname+(this.port?':'+this.port:'');}},origin:{get:function(){return this.hostname?this.protocol+'//'+this.host:'null';}},href:{get:function(){var q=this.searchParams.toString();var s=q?'?'+q:(this.search||'');var auth=this.username?this.username+(this.password?':'+this.password:'')+'@':'';return this.protocol+(this.hostname||this.protocol==='file:'?'//':'')+auth+this.host+this.pathname+s+this.hash;}}});
URL.prototype.toString=URL.prototype.toJSON=function(){return this.href;};URL.createObjectURL=function(){return 'blob:';};URL.revokeObjectURL=function(){};URL.canParse=function(u,b){try{new URL(u,b);return true;}catch(e){return false;}};
W.URL=URL;W.URLSearchParams=URLSearchParams;
W.crypto={getRandomValues:function(a){for(var i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*4294967296);return a;},randomUUID:function(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==='x'?r:(r&3|8)).toString(16);});},subtle:{}};
function pad2(n){return (n<10?'0':'')+n;}
W.Intl={DateTimeFormat:function(loc,opt){opt=opt||{};this.format=function(d){d=d instanceof Date?d:new Date(d===undefined?Date.now():d);var s=d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());if(opt.hour||opt.minute||opt.timeStyle||opt.second)s=(opt.year||opt.month||opt.day||opt.dateStyle?s+' ':'')+pad2(d.getHours())+':'+pad2(d.getMinutes())+(opt.second||opt.timeStyle?':'+pad2(d.getSeconds()):'');return s;};this.formatToParts=function(d){return [{type:'literal',value:this.format(d)}];};this.resolvedOptions=function(){return {locale:'en-US',timeZone:opt.timeZone||'UTC',calendar:'gregory',numberingSystem:'latn'};};},NumberFormat:function(loc,opt){opt=opt||{};this.format=function(n){n=Number(n);var f=opt.maximumFractionDigits!==undefined?opt.maximumFractionDigits:(opt.style==='currency'?2:3);var s=n.toFixed(Math.min(f,20));if(s.indexOf('.')>=0&&opt.minimumFractionDigits===undefined)s=s.replace(/\.?0+$/,'');var parts=s.split('.');parts[0]=parts[0].replace(/\B(?=(\d{3})+(?!\d))/g,',');s=parts.join('.');if(opt.style==='percent')s=(n*100).toFixed(0)+'%';if(opt.style==='currency')s=(opt.currency||'')+' '+s;return s;};this.formatToParts=function(n){return [{type:'integer',value:this.format(n)}];};this.resolvedOptions=function(){return {locale:'en-US'};};},Collator:function(){this.compare=function(a,b){a=String(a);b=String(b);return a<b?-1:a>b?1:0;};this.resolvedOptions=function(){return {locale:'en-US'};};},PluralRules:function(){this.select=function(n){return Number(n)===1?'one':'other';};},RelativeTimeFormat:function(){this.format=function(v,u){v=Number(v);var a=Math.abs(v);u=String(u).replace(/s$/,'');return v<0?a+' '+u+(a===1?'':'s')+' ago':'in '+a+' '+u+(a===1?'':'s');};},ListFormat:function(){this.format=function(l){return Array.prototype.join.call(l,', ');};},getCanonicalLocales:function(l){return [].concat(l||[]);},supportedValuesOf:function(){return [];}};
['DateTimeFormat','NumberFormat','Collator','PluralRules','RelativeTimeFormat','ListFormat'].forEach(function(k){W.Intl[k].supportedLocalesOf=function(){return ['en-US'];};});
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
 var done=function(status,headers,text,err,url){self._id=0;self._rh=headers||'';self.responseURL=url||self._u;
  if(err){self.status=0;self.statusText='';self.responseText='';self.response=null;self._set(4);self._emit(err==='timeout'?'timeout':'error');self._emit('loadend');return;}
  self.status=status;self.statusText=status===200?'OK':status===204?'No Content':status===404?'Not Found':'';self._set(2);self._set(3);self.responseText=text;
  var rt=self.responseType;if(rt==='json'){try{self.response=JSON.parse(text);}catch(e){self.response=null;}}
  else if(rt==='arraybuffer'){var b=new ArrayBuffer(text.length),v=new Uint8Array(b);for(var i=0;i<text.length;i++)v[i]=text.charCodeAt(i)&255;self.response=b;}
  else if(rt==='document'){self.response=null;}else self.response=text;
  self._set(4);self._emit('load');self._emit('loadend');};
 this._id=__vitaFetch(this._u,this._m,hs,data,this.timeout|0,done);
 if(!this._id)setTimeout(function(){done(0,'','','request refused','');},0);},
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
function Response(body,init){init=init||{};this.status=init.status===undefined?200:init.status;this.ok=this.status>=200&&this.status<300;this.statusText=init.statusText||'';this.headers=new Headers(init.headers);this.url=init.url||'';this.type='basic';this.redirected=false;this.bodyUsed=false;this._b=body===undefined||body===null?'':String(body);}
Response.prototype={text:function(){this.bodyUsed=true;return Promise.resolve(this._b);},json:function(){var b=this._b;this.bodyUsed=true;return new Promise(function(res,rej){try{res(JSON.parse(b));}catch(e){rej(e);}});},
arrayBuffer:function(){var t=this._b;this.bodyUsed=true;var b=new ArrayBuffer(t.length),v=new Uint8Array(b);for(var i=0;i<t.length;i++)v[i]=t.charCodeAt(i)&255;return Promise.resolve(b);},
blob:function(){var t=this._b;this.bodyUsed=true;return Promise.resolve({size:t.length,type:this.headers.get('content-type')||'',text:function(){return Promise.resolve(t);}});},
formData:function(){var t=this._b;this.bodyUsed=true;var f=new FormData();new URLSearchParams(t).forEach(function(v,k){f.append(k,v);});return Promise.resolve(f);},
clone:function(){return new Response(this._b,{status:this.status,statusText:this.statusText,headers:this.headers,url:this.url});}};
Response.error=function(){var r=new Response('',{status:0});r.type='error';return r;};Response.json=function(o,init){var r=new Response(JSON.stringify(o),init);if(!r.headers.has('content-type'))r.headers.set('content-type','application/json');return r;};
function Request(input,init){init=init||{};var from=input instanceof Request?input:null;this.url=from?from.url:String(input);this.method=String(init.method||(from?from.method:'GET')).toUpperCase();this.headers=new Headers(init.headers||(from?from.headers:undefined));this._body=init.body!==undefined?init.body:(from?from._body:null);this.credentials=init.credentials||'same-origin';this.mode=init.mode||'cors';this.cache=init.cache||'default';this.redirect=init.redirect||'follow';this.signal=init.signal||null;this.bodyUsed=false;}
Request.prototype={clone:function(){return new Request(this);},text:function(){return Promise.resolve(this._body==null?'':String(this._body));},json:function(){return this.text().then(JSON.parse);}};
W.fetch=function(input,init){var req=new Request(input,init);return new Promise(function(resolve,reject){var x=new XMLHttpRequest();x.open(req.method,req.url);req.headers.forEach(function(v,k){x.setRequestHeader(k,v);});
 x.onload=function(){var h=new Headers();x.getAllResponseHeaders().split('\r\n').forEach(function(l){var i=l.indexOf(':');if(i>0)h.append(l.slice(0,i),l.slice(i+1).trim());});var r=new Response(x.responseText,{status:x.status,statusText:x.statusText,headers:h,url:x.responseURL});r.redirected=x.responseURL!==req.url;resolve(r);};
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
W.TextDecoder=function(){this.encoding='utf-8';};W.TextDecoder.prototype.decode=function(b){if(!b)return '';var v=b instanceof Uint8Array?b:new Uint8Array(b.buffer||b),s='';for(var i=0;i<v.length;i++)s+=String.fromCharCode(v[i]);try{return decodeURIComponent(escape(s));}catch(e){return s;}};
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

function CEBase(){
 var e=CEstack.length?CEstack[CEstack.length-1]:undefined;
 if(e===undefined)throw new TypeError('Illegal constructor');
 return e;
}
CEBase.prototype=P;
W.HTMLElement=CEBase;
/* Every HTML*Element alias shares it, so `extends HTMLDivElement` works. */
Object.keys(W).forEach(function(k){if(k.indexOf('HTML')===0&&k!=='HTMLDocument'&&W[k]===Element)W[k]=CEBase;});

function ceErr(e){try{console.error('custom element: '+(e&&e.stack?e.stack:e));}catch(x){}}
function ceCall(el,name,args){var f=el[name];if(typeof f!=='function')return;try{f.apply(el,args||[]);}catch(e){ceErr(e);}}
function ceInDoc(n){var r=D.documentElement;while(n){if(n===r)return true;n=n.parentNode;}return false;}

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
 get:function(name){var d=CE[String(name).toLowerCase()];return d?d.ctor:undefined;},
 getName:function(c){for(var k in CE)if(CE[k].ctor===c)return k;return null;},
 whenDefined:function(name){
  name=String(name).toLowerCase();
  if(CE[name])return Promise.resolve(CE[name].ctor);
  return new Promise(function(res){(CEwait[name]=CEwait[name]||[]).push(res);});
 },
 upgrade:function(root){if(CEn)ceConnectTree(root,ceInDoc(root),false);}
};

/* Reactions on the DOM calls that move elements in and out of the tree. */
['appendChild','insertBefore'].forEach(function(m){
 var orig=P[m];
 P[m]=function(n){var r=orig.apply(this,arguments);if(CEn&&n)ceConnectTree(n,ceInDoc(this),false);return r;};
});
(function(){
 var orig=P.removeChild;
 P.removeChild=function(n){var r=orig.apply(this,arguments);if(CEn&&n)ceDisconnectTree(n,false);return r;};
})();
(function(){
 var orig=P.replaceChild;
 P.replaceChild=function(nw,old){var r=orig.apply(this,arguments);
  if(CEn){if(old)ceDisconnectTree(old,false);if(nw)ceConnectTree(nw,ceInDoc(this),false);}return r;};
})();
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'innerHTML');
 Object.defineProperty(P,'innerHTML',{get:d.get,set:function(v){
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
 D.createElement=function(t,o){
  var el=orig.call(D,t);
  if(CEn&&el&&el.nodeType===1){if(o&&o.is)el.setAttribute('is',o.is);ceUpgrade(el,false);}
  return el;
 };
})();
/* The parser keeps adding elements after a define, so sweep once the
 * document is built. Both events reach document listeners (qjs.c). */
W.addEventListener('DOMContentLoaded',function(){if(CEn)ceConnectTree(D.documentElement,true,false);});
W.addEventListener('load',function(){if(CEn)ceConnectTree(D.documentElement,true,false);});

/* Shadow DOM, as light DOM. A shadow root is the element itself, so
 * there is no style or selector scoping, which is the point: content put
 * in a shadow root still lays out and still renders, where an
 * unimplemented attachShadow renders nothing at all. shadowRoot stays
 * null until attachShadow is called, because components test it to find
 * out whether they have already built themselves. */
P.attachShadow=function(){Object.defineProperty(this,'__shadow',{value:true,writable:true,enumerable:false});return this;};
P.getRootNode=function(){var n=this;while(n.parentNode)n=n.parentNode;return n===D.documentElement?D:n;};
Object.defineProperty(P,'shadowRoot',{get:function(){return this.__shadow?this:null;}});
Object.defineProperty(P,'host',{get:function(){return this.__shadow?this:undefined;}});
Object.defineProperty(P,'isConnected',{get:function(){return ceInDoc(this);}});
/* Same reasoning for <template>: libdom parses its children into the
 * element, so content is the element. Every other tag keeps the content
 * attribute property, which <meta> needs. */
(function(){
 var d=Object.getOwnPropertyDescriptor(P,'content');
 Object.defineProperty(P,'content',{get:function(){return this.tagName==='TEMPLATE'?this:d.get.call(this);},set:d.set});
})();
W.ShadowRoot=CEBase;
})();
