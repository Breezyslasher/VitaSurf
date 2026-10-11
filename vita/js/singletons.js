/*
 * The window's one-of-a-kind objects as their interfaces' instances
 * (VitaSurf), part of the prelude, before interfaces.js.
 *
 * navigator, screen, screen.orientation, crypto, visualViewport,
 * navigation and history were plain objects carrying their members as
 * their own properties: Object.prototype.toString said [object Object]
 * where a browser says [object Navigator], navigator was no instance of
 * Navigator, Object.keys(navigator) listed thirty names where a browser
 * lists none, and Navigator.prototype was empty, so a page that reads a
 * member's descriptor off the prototype, or asks what kind of object it
 * has, found what no browser has. Each is now an instance of its own
 * interface, whose prototype has the members: a method as it was, an
 * accessor as it was, and a value as a getter over a store the page
 * cannot reach, writable only where the interface's attribute is. Screen,
 * ScreenOrientation, VisualViewport and Navigation are EventTargets, as
 * WebIDL has them, and listen with EventTarget's own methods.
 */
(function(){
'use strict';
var W=window;
function define(o,k,d){try{Object.defineProperty(o,k,d);}catch(e){}}
function named(f,n){define(f,'name',{value:n,configurable:true});return f;}
var STORE=new WeakMap();
function store(o,k){
 var s=STORE.get(o);
 if(!s)throw new TypeError("Failed to read the '"+k+"' property: Illegal invocation");
 return s;}
/* an interface no page constructs, under its parent */
function iface(name,parent){
 var F=named(function(){throw new TypeError('Illegal constructor');},name);
 F.prototype=Object.create(parent?parent.prototype:Object.prototype);
 define(F.prototype,'constructor',{value:F,writable:true,configurable:true});
 define(W,name,{value:F,writable:true,enumerable:false,configurable:true});
 return F;}
function isHandler(k){return /^on[a-z]/.test(k);}
var ET=W.EventTarget,ETKEYS=' addEventListener removeEventListener dispatchEvent ';
/*
 * obj's own members onto F.prototype, and obj made F's instance. `set`
 * names the attributes a page may write (an event handler always may);
 * the rest are read-only, as WebIDL has them.
 */
function adopt(obj,F,set){
 var P=F.prototype,s,ev=ET&&ET.prototype.isPrototypeOf(P);
 if(!obj||typeof obj!=='object')return obj;
 s=STORE.get(obj)||Object.create(null);
 STORE.set(obj,s);
 set=' '+(set||'')+' ';
 Reflect.ownKeys(obj).forEach(function(k){
  var d=Object.getOwnPropertyDescriptor(obj,k),acc;
  if(typeof k!=='string'||!d||!d.configurable)return;
  delete obj[k];
  /* an EventTarget listens with EventTarget's methods, not with the
     do-nothing ones these carried */
  if(ev&&ETKEYS.indexOf(' '+k+' ')>=0)return;
  if(Object.prototype.hasOwnProperty.call(P,k))return;
  if(d.get||d.set){d.enumerable=true;define(P,k,d);return;}
  if(typeof d.value==='function'&&!isHandler(k)){
   define(P,k,{value:d.value,writable:true,enumerable:true,configurable:true});
   return;}
  s[k]=d.value;
  acc={enumerable:true,configurable:true,
   get:named(function(){return store(this,k)[k];},'get '+k)};
  if(isHandler(k)||set.indexOf(' '+k+' ')>=0)
   acc.set=named(function(v){
    store(this,k)[k]=isHandler(k)&&typeof v!=='function'&&
     (v===null||typeof v!=='object')?null:v;},'set '+k);
  define(P,k,acc);});
 Object.setPrototypeOf(obj,P);
 return obj;}
/* members an interface has that the object did not carry */
function extra(F,members){
 var P=F.prototype;
 Object.keys(members).forEach(function(k){
  if(Object.prototype.hasOwnProperty.call(P,k))return;
  var v=members[k];
  if(typeof v==='function')
   define(P,k,{value:named(v,k),writable:true,enumerable:true,configurable:true});
  else if(v&&typeof v==='object'&&(v.get||v.set)){
   if(v.get)named(v.get,'get '+k);
   if(v.set)named(v.set,'set '+k);
   define(P,k,{get:v.get,set:v.set,enumerable:true,configurable:true});}});}
function handler(k){
 return {get:function(){return store(this,k)[k]===undefined?null:store(this,k)[k];},
  set:function(v){store(this,k)[k]=typeof v==='function'||
   (v!==null&&typeof v==='object')?v:null;}};}

/* navigator, also window.clientInformation */
var nav=W.navigator;
if(nav&&typeof nav==='object'){
 adopt(nav,iface('Navigator'),'');
 if(W.clientInformation!==nav)W.clientInformation=nav;}

/* screen, and its orientation */
if(W.screen&&typeof W.screen==='object'&&ET){
 var orient=W.screen.orientation,SO,S=iface('Screen',ET);
 if(orient&&typeof orient==='object'){
  SO=iface('ScreenOrientation',ET);
  if(orient.angle===undefined)orient.angle=0;
  adopt(orient,SO,'');
  extra(SO,{onchange:handler('onchange'),
   lock:function(){return Promise.reject(W.DOMException
    ?new W.DOMException('screen.orientation.lock() is not available on this device.','NotSupportedError')
    :new Error('NotSupportedError'));},
   unlock:function(){}});}
 var sc=W.screen;
 ['availLeft','availTop'].forEach(function(k){if(sc[k]===undefined)sc[k]=0;});
 if(sc.isExtended===undefined)sc.isExtended=false;
 adopt(sc,S,'');
 extra(S,{onchange:handler('onchange')});}

/* location keeps its members as its own, which is what [LegacyUnforgeable]
   makes them in a browser, enumerable, and is a Location. Setting a part
   of the address navigates to the address with that part changed, as
   setting hash and href already did. */
if(W.location&&typeof W.location==='object'){
 var loc=W.location;
 try{Object.setPrototypeOf(loc,iface('Location').prototype);}catch(e){}
 ['protocol','host','hostname','port','pathname','search'].forEach(function(k){
  var d=Object.getOwnPropertyDescriptor(loc,k);
  if(!d||!d.get||d.set||!d.configurable||typeof W.URL!=='function')return;
  define(loc,k,{get:d.get,configurable:true,enumerable:true,
   set:named(function(v){
    var u=new W.URL(String(loc.href));
    u[k]=String(v);
    loc.href=u.href;},'set '+k)});});
 if(!Object.prototype.hasOwnProperty.call(loc,'valueOf'))
  define(loc,'valueOf',{value:Object.prototype.valueOf,writable:false,
   enumerable:false,configurable:true});
 Object.getOwnPropertyNames(loc).forEach(function(k){
  var d=Object.getOwnPropertyDescriptor(loc,k);
  if(d.configurable&&!d.enumerable&&k!=='valueOf'){
   d.enumerable=true;define(loc,k,d);}});}

/* crypto */
if(W.crypto&&typeof W.crypto==='object')adopt(W.crypto,iface('Crypto'),'');

/* visualViewport: one object, read live from the scroll position */
if(ET){
 var VV=iface('VisualViewport',ET),vv=Object.create(VV.prototype),
  scroll=NV.__vitaScroll;
 STORE.set(vv,Object.create(null));
 function at(i,dflt){
  return function(){store(this,'visualViewport');
   var s=typeof scroll==='function'?scroll():null;
   return s?s[i]:dflt;};}
 extra(VV,{offsetLeft:{get:function(){store(this,'offsetLeft');return 0;}},
  offsetTop:{get:function(){store(this,'offsetTop');return 0;}},
  pageLeft:{get:at(0,0)},pageTop:{get:at(1,0)},
  width:{get:at(2,960)},height:{get:at(3,544)},
  scale:{get:function(){store(this,'scale');return 1;}},
  onresize:handler('onresize'),onscroll:handler('onscroll'),
  onscrollend:handler('onscrollend')});
 define(W,'visualViewport',{configurable:true,enumerable:true,
  get:named(function(){return vv;},'get visualViewport'),
  set:named(function(v){define(W,'visualViewport',{value:v,writable:true,
   enumerable:true,configurable:true});},'set visualViewport')});}

/* navigation */
if(W.navigation&&typeof W.navigation==='object'&&ET)
 adopt(W.navigation,iface('Navigation',ET),'');

/* history: scrollRestoration is the one attribute a page writes */
if(W.history&&typeof W.history==='object'){
 var H=iface('History');
 adopt(W.history,H,'');
 var sr=Object.getOwnPropertyDescriptor(H.prototype,'scrollRestoration');
 if(sr&&sr.get)define(H.prototype,'scrollRestoration',{enumerable:true,
  configurable:true,get:sr.get,
  set:named(function(v){
   v=String(v);
   /* an enumeration: a value it does not have is ignored */
   if(v==='auto'||v==='manual')store(this,'scrollRestoration').scrollRestoration=v;},
   'set scrollRestoration')});}
})();
