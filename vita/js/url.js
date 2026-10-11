/*
 * URL and URLSearchParams (VitaSurf), the first part of the prelude after
 * the natives, so everything after it has them.
 *
 * A URL is the URL Standard's parser in C (vita/js/url.c, through
 * NV.__vitaURLParse and NV.__vitaURLSet), which hands back the parts a
 * URL object reads; the object keeps them in a private field and asks C
 * again when one is set. It was a regular expression here, slow (a tenth
 * of a page's script on the Vita, building URLs in a loop) and wrong
 * wherever the expression and the standard parted. URLSearchParams is
 * the standard's: its pairs in a private field, parsed and serialised as
 * application/x-www-form-urlencoded in C, and kept in step with its URL
 * both ways. Its pairs were the object's own _p, where a page could see
 * them.
 */
(function(){
'use strict';
var W=window,PARSE=NV.__vitaURLParse,SET=NV.__vitaURLSet,
 FORM=NV.__vitaURLForm,FORMSTR=NV.__vitaURLFormString;
['__vitaURLParse','__vitaURLSet','__vitaURLForm','__vitaURLFormString']
 .forEach(function(k){delete NV[k];});
if(typeof PARSE!=='function')return;
/* a USVString: a lone surrogate is U+FFFD */
var WF=String.prototype.toWellFormed;
function usv(v){var s=String(v);return WF?WF.call(s):s;}
function need(n,what,iface,args){
 if(args.length<n)throw new TypeError("Failed to execute '"+what+"' on '"+
  iface+"': "+n+" argument"+(n>1?'s':'')+" required, but only "+
  args.length+" present.");}
/* the parts' places in what C hands back */
var HREF=0,SCHEME=1,USER=2,PASS=3,HOST=4,PORT=5,PATH=6,QUERY=7,FRAG=8;
/* and the setters' numbers (enum url_part) */
var P_PROTOCOL=1,P_USERNAME=2,P_PASSWORD=3,P_HOST=4,P_HOSTNAME=5,P_PORT=6,
 P_PATHNAME=7,P_SEARCH=8,P_HASH=9;
var MAKE=Symbol();	/* a URL from parts already parsed */
var urlSetQuery,spReplace,spLink;

function originOf(r){
 var s=r[SCHEME],inner;
 if(s==='blob'){
  inner=PARSE(r[PATH]);
  return inner&&(inner[SCHEME]==='http'||inner[SCHEME]==='https'||
   inner[SCHEME]==='file')?originOf(inner):'null';}
 if(s==='http'||s==='https'||s==='ws'||s==='wss'||s==='ftp')
  return s+'://'+r[HOST]+(r[PORT]?':'+r[PORT]:'');
 /* a file URL's is the scheme alone, as Chrome serialises it */
 return s==='file'?'file://':'null';}

class URL{
 #r;#q=null;
 constructor(url,base){
  if(url===MAKE){this.#r=base;return;}
  var r=PARSE(usv(url),base===undefined?undefined:usv(base));
  if(!r)throw new TypeError("Failed to construct 'URL': Invalid URL");
  this.#r=r;}
 static canParse(url,base){
  need(1,'canParse','URL',arguments);
  return !!PARSE(usv(url),base===undefined?undefined:usv(base));}
 static parse(url,base){
  need(1,'parse','URL',arguments);
  var r=PARSE(usv(url),base===undefined?undefined:usv(base));
  return r?new URL(MAKE,r):null;}
 get href(){return this.#r[HREF];}
 set href(v){
  var r=PARSE(usv(v));
  if(!r)throw new TypeError("Failed to set the 'href' property on 'URL': Invalid URL");
  this.#r=r;
  if(this.#q)spReplace(this.#q,r[QUERY]||'');}
 get origin(){return originOf(this.#r);}
 get protocol(){return this.#r[SCHEME]+':';}
 set protocol(v){this.#set(P_PROTOCOL,v);}
 get username(){return this.#r[USER];}
 set username(v){this.#set(P_USERNAME,v);}
 get password(){return this.#r[PASS];}
 set password(v){this.#set(P_PASSWORD,v);}
 get host(){
  var r=this.#r;
  return r[HOST]===null?'':r[PORT]===''?r[HOST]:r[HOST]+':'+r[PORT];}
 set host(v){this.#set(P_HOST,v);}
 get hostname(){return this.#r[HOST]===null?'':this.#r[HOST];}
 set hostname(v){this.#set(P_HOSTNAME,v);}
 get port(){return this.#r[PORT];}
 set port(v){this.#set(P_PORT,v);}
 get pathname(){return this.#r[PATH];}
 set pathname(v){this.#set(P_PATHNAME,v);}
 get search(){var q=this.#r[QUERY];return q===null||q===''?'':'?'+q;}
 set search(v){
  this.#set(P_SEARCH,v);
  if(this.#q)spReplace(this.#q,this.#r[QUERY]||'');}
 get searchParams(){
  if(!this.#q){
   this.#q=new URLSearchParams(this.#r[QUERY]||'');
   spLink(this.#q,this);}
  return this.#q;}
 get hash(){var f=this.#r[FRAG];return f===null||f===''?'':'#'+f;}
 set hash(v){this.#set(P_HASH,v);}
 toString(){return this.#r[HREF];}
 toJSON(){return this.#r[HREF];}
 #set(part,v){
  var r=SET(this.#r[HREF],part,usv(v));
  if(r)this.#r=r;}
 static{
  /* URLSearchParams' update steps: an empty list is no query */
  urlSetQuery=function(u,s){
   var r=SET(u.#r[HREF],P_SEARCH,s===''?'':'?'+s);
   if(r)u.#r=r;};}
}

/* iterators over a URLSearchParams' pairs, which see changes made while
   they run, as the standard's do */
var ITER_PROTO=Object.create(Object.getPrototypeOf(
 Object.getPrototypeOf([][Symbol.iterator]())));
var ITER=new WeakMap();
Object.defineProperty(ITER_PROTO,'next',{writable:true,configurable:true,
 enumerable:true,value:function next(){
  var it=ITER.get(this),p;
  if(!it)throw new TypeError("Failed to execute 'next' on 'URLSearchParams Iterator': Illegal invocation");
  p=it.list()[it.i];
  if(p===undefined)return {value:undefined,done:true};
  it.i++;
  return {value:it.kind===0?[p[0],p[1]]:it.kind===1?p[0]:p[1],done:false};}});
Object.defineProperty(ITER_PROTO,Symbol.toStringTag,{configurable:true,
 value:'URLSearchParams Iterator'});

class URLSearchParams{
 #list=[];#url=null;
 constructor(init){
  var list=this.#list,keys,i,pair,it;
  if(init===undefined)return;
  if(init!==null&&(typeof init==='object'||typeof init==='function')){
   it=init[Symbol.iterator];
   if(it!==undefined&&it!==null){
    if(typeof it!=='function')throw new TypeError("Failed to construct 'URLSearchParams': The object must have a callable @@iterator property.");
    for(pair of init){
     if(pair===null||(typeof pair!=='object'&&typeof pair!=='function'))
      throw new TypeError("Failed to construct 'URLSearchParams': The provided value cannot be converted to a sequence.");
     pair=Array.from(pair);
     if(pair.length!==2)throw new TypeError("Failed to construct 'URLSearchParams': Sequence initializer must only contain pair elements");
     list.push([usv(pair[0]),usv(pair[1])]);}
    return;}
   keys=Reflect.ownKeys(init);
   for(i=0;i<keys.length;i++){
    var d=Object.getOwnPropertyDescriptor(init,keys[i]);
    if(typeof keys[i]==='string'&&d&&d.enumerable)
     list.push([usv(keys[i]),usv(init[keys[i]])]);}
   return;}
  init=usv(init);
  if(init.charCodeAt(0)===63)init=init.slice(1);
  this.#parse(init);}
 #parse(s){
  var a=FORM(s),i,list=[];
  for(i=0;i<a.length;i+=2)list.push([a[i],a[i+1]]);
  this.#list=list;}
 #update(){if(this.#url)urlSetQuery(this.#url,this.toString());}
 get size(){return this.#list.length;}
 append(name,value){
  need(2,'append','URLSearchParams',arguments);
  this.#list.push([usv(name),usv(value)]);
  this.#update();}
 delete(name,value){
  need(1,'delete','URLSearchParams',arguments);
  name=usv(name);
  if(value!==undefined)value=usv(value);
  this.#list=this.#list.filter(function(p){
   return !(p[0]===name&&(value===undefined||p[1]===value));});
  this.#update();}
 get(name){
  need(1,'get','URLSearchParams',arguments);
  name=usv(name);
  for(var i=0;i<this.#list.length;i++)if(this.#list[i][0]===name)return this.#list[i][1];
  return null;}
 getAll(name){
  need(1,'getAll','URLSearchParams',arguments);
  name=usv(name);
  return this.#list.filter(function(p){return p[0]===name;})
   .map(function(p){return p[1];});}
 has(name,value){
  need(1,'has','URLSearchParams',arguments);
  name=usv(name);
  if(value!==undefined)value=usv(value);
  return this.#list.some(function(p){
   return p[0]===name&&(value===undefined||p[1]===value);});}
 set(name,value){
  need(2,'set','URLSearchParams',arguments);
  name=usv(name);value=usv(value);
  var found=false;
  this.#list=this.#list.filter(function(p){
   if(p[0]!==name)return true;
   if(found)return false;
   found=true;p[1]=value;return true;});
  if(!found)this.#list.push([name,value]);
  this.#update();}
 sort(){
  /* by code units, keeping the order of equal names */
  this.#list.sort(function(a,b){return a[0]<b[0]?-1:a[0]>b[0]?1:0;});
  this.#update();}
 forEach(callback,thisArg){
  need(1,'forEach','URLSearchParams',arguments);
  if(typeof callback!=='function')throw new TypeError("Failed to execute 'forEach' on 'URLSearchParams': The callback provided as parameter 1 is not a function.");
  for(var i=0;i<this.#list.length;i++)
   callback.call(thisArg,this.#list[i][1],this.#list[i][0],this);}
 #iter(kind){
  var o=Object.create(ITER_PROTO),self=this;
  ITER.set(o,{i:0,kind:kind,list:function(){return self.#list;}});
  return o;}
 entries(){return this.#iter(0);}
 keys(){return this.#iter(1);}
 values(){return this.#iter(2);}
 toString(){
  var flat=[],i;
  for(i=0;i<this.#list.length;i++)flat.push(this.#list[i][0],this.#list[i][1]);
  return FORMSTR(flat);}
 static{
  spReplace=function(sp,s){sp.#parse(s);};
  spLink=function(sp,u){sp.#url=u;};}
}
Object.defineProperty(URLSearchParams.prototype,Symbol.iterator,
 {value:URLSearchParams.prototype.entries,writable:true,configurable:true});

/* WebIDL's members are enumerable; a class's are not */
[URL,URLSearchParams].forEach(function(C){
 [C.prototype,C].forEach(function(o){
  Reflect.ownKeys(o).forEach(function(k){
   if(typeof k!=='string'||k==='constructor'||k==='prototype'||
      k==='length'||k==='name')return;
   var d=Object.getOwnPropertyDescriptor(o,k);
   if(!d.enumerable){d.enumerable=true;Object.defineProperty(o,k,d);}});});});
W.URL=URL;W.URLSearchParams=URLSearchParams;
})();
