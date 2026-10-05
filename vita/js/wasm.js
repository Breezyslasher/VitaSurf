/* --- WebAssembly (VitaSurf) ----------------------------------------------
 * The WebAssembly JS API on WAMR's interpreter, through the natives in
 * vita/js/wasm.c: WebAssembly.validate, compile, instantiate and their
 * streaming forms, Module, Instance, Memory, Table, Global and the three
 * error classes, as the WebAssembly JavaScript Interface specification
 * has them.
 *
 * The Vita has no JIT, so modules are interpreted: correct, and far
 * slower than in a desktop browser. Compiling happens when asked and the
 * promise settles after; there is no thread to do it on.
 *
 * Not yet: a Table or a mutable Global passed in as an import (a
 * LinkError says so), a funcref from one instance stored into another's
 * table or global (a TypeError), shared memory, SIMD, exception handling
 * (WebAssembly.Tag and Exception) and memory64.
 */
(function(){
var W=window,N=W.__vitaWasm;
delete W.__vitaWasm;
if(!N)return;

/* ---- errors ---- */
function makeError(name){
 var E=function(message){
  var o=Reflect.construct(Error,arguments,new.target||E);
  return o;};
 Object.defineProperty(E,'name',{value:name});
 E.prototype=Object.create(Error.prototype,{
  constructor:{value:E,writable:true,configurable:true},
  name:{value:name,writable:true,configurable:true},
  message:{value:'',writable:true,configurable:true}});
 Object.setPrototypeOf(E,Error);
 return E;}
var CompileError=makeError('CompileError'),LinkError=makeError('LinkError'),
 RuntimeError=makeError('RuntimeError');

/* ---- arguments ---- */
function enforce(v,what,max){
 var n=+v;
 if(!isFinite(n))throw new TypeError(what+' is not a finite number');
 n=n<0?Math.ceil(n):Math.floor(n);
 if(n<0||n>(max===undefined?4294967295:max))throw new TypeError(what+' is out of range');
 return n;}
function bytesOf(v){
 if(v instanceof ArrayBuffer)return new Uint8Array(v.slice(0));
 if(ArrayBuffer.isView(v))
  return new Uint8Array(v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength));
 throw new TypeError('The argument is not an ArrayBuffer or ArrayBufferView');}
function isObject(v){return v!==null&&(typeof v==='object'||typeof v==='function');}
/* members as WebIDL has them: methods and attributes enumerable, and an
   accessor's functions named "get x" and "set x" */
function members(proto,obj){
 Object.getOwnPropertyNames(obj).forEach(function(k){
  var d=Object.getOwnPropertyDescriptor(obj,k);
  d.enumerable=true;d.configurable=true;
  Object.defineProperty(proto,k,d);});}

/* ---- reading a module's header sections ---- */
var VALTYPE={0x7f:'i',0x7e:'I',0x7d:'f',0x7c:'d',0x7b:'v',0x70:'r',0x6f:'x'};
var KINDS=['function','table','memory','global','tag'];
function parse(b){
 var p=8,info={types:[],imports:[],funcs:[],tables:[],memories:[],globals:[],
  exports:[],customs:[]};
 function u8(){return b[p++];}
 function leb(){var r=0,s=0,x;do{x=b[p++];r+=(x&0x7f)*Math.pow(2,s);s+=7;}while(x&0x80);return r;}
 function name(){var n=leb(),s=new TextDecoder().decode(b.subarray(p,p+n));p+=n;return s;}
 function valtype(){var t=u8();return VALTYPE[t]||'?';}
 function limits(){var f=u8(),l={min:leb()};if(f&1)l.max=leb();l.shared=!!(f&2);l.is64=!!(f&4);return l;}
 function table(){var t=valtype(),l=limits();l.elem=t;return l;}
 while(p<b.length){
  var id=u8(),size=leb(),end=p+size,n,i;
  if(id===0){var cn=name();info.customs.push({name:cn,data:b.slice(p,end).buffer});}
  else if(id===1){n=leb();for(i=0;i<n;i++){
   u8(); /* 0x60 */
   var np=leb(),ps='',nr,rs='',j;
   for(j=0;j<np;j++)ps+=valtype();
   nr=leb();for(j=0;j<nr;j++)rs+=valtype();
   info.types.push(ps+':'+rs);}}
  else if(id===2){n=leb();for(i=0;i<n;i++){
   var im={module:name(),name:name(),kind:KINDS[u8()]};
   if(im.kind==='function'){im.sig=info.types[leb()];info.funcs.push(im.sig);}
   else if(im.kind==='table'){im.table=table();info.tables.push(im.table);}
   else if(im.kind==='memory'){im.memory=limits();info.memories.push(im.memory);}
   else if(im.kind==='global'){im.global={type:valtype(),mutable:u8()===1};info.globals.push(im.global);}
   else if(im.kind==='tag'){u8();leb();}
   info.imports.push(im);}}
  else if(id===3){n=leb();for(i=0;i<n;i++)info.funcs.push(info.types[leb()]);}
  else if(id===4){n=leb();for(i=0;i<n;i++){
   if(b[p]===0x40){p+=2;}
   info.tables.push(table());
   p=end;break;}}
  else if(id===5){n=leb();for(i=0;i<n;i++)info.memories.push(limits());}
  else if(id===6){n=leb();for(i=0;i<n;i++){
   info.globals.push({type:valtype(),mutable:u8()===1});
   /* skip the init expression; nothing here needs it */
   while(p<end&&b[p]!==0x0b){var op=b[p++];
    if(op===0x41||op===0x42||op===0x23||op===0xd2)leb();
    else if(op===0x43)p+=4;else if(op===0x44)p+=8;else if(op===0xd0)p++;}
   p++;}}
  else if(id===7){n=leb();for(i=0;i<n;i++)
   info.exports.push({name:name(),kind:KINDS[u8()],index:leb()});}
  p=end;}
 return info;}

/* ---- Module ---- */
var MODULES=new WeakMap();
function moduleSlot(m){var s=isObject(m)&&MODULES.get(m);
 if(!s)throw new TypeError('The argument is not a WebAssembly.Module');return s;}
function compileBytes(bytes){
 var h=N.compile(bytes);
 var m=Object.create(Module.prototype);
 MODULES.set(m,{h:h,info:parse(bytes)});
 return m;}
function Module(bytes){
 if(!new.target)throw new TypeError("Constructor WebAssembly.Module requires 'new'");
 if(arguments.length<1)throw new TypeError('WebAssembly.Module requires an argument');
 var b=bytesOf(bytes),h=N.compile(b),m=this;
 if(new.target!==Module)m=Object.create(new.target.prototype);
 MODULES.set(m,{h:h,info:parse(b)});
 return m;}
Object.defineProperties(Module,{
 imports:{writable:true,enumerable:true,configurable:true,value:function imports(m){
  if(arguments.length<1)throw new TypeError('WebAssembly.Module.imports requires an argument');
  return moduleSlot(m).info.imports.map(function(i){
   return {module:i.module,name:i.name,kind:i.kind};});}},
 exports:{writable:true,enumerable:true,configurable:true,value:function exports(m){
  if(arguments.length<1)throw new TypeError('WebAssembly.Module.exports requires an argument');
  return moduleSlot(m).info.exports.map(function(e){return {name:e.name,kind:e.kind};});}},
 customSections:{writable:true,enumerable:true,configurable:true,value:function customSections(m,sectionName){
  if(arguments.length<2)throw new TypeError('WebAssembly.Module.customSections requires 2 arguments');
  var s=moduleSlot(m),n=String(sectionName);
  return s.info.customs.filter(function(c){return c.name===n;})
   .map(function(c){return c.data.slice(0);});}}});
Object.defineProperty(Module.prototype,Symbol.toStringTag,{configurable:true,value:'WebAssembly.Module'});

/* ---- exported functions ---- */
/* handle -> {info, fns: [], imports: [what each imported function was]} */
var INSTANCES=new WeakMap();
/* exported function -> {h, index} */
var FUNCS=new WeakMap();
function funcFor(h,index){
 var r=INSTANCES.get(h),f;
 if(!r)throw new TypeError('Unknown instance');
 f=r.fns[index];
 if(f)return f;
 var imp=r.imports[index];
 if(imp&&FUNCS.has(imp)){r.fns[index]=imp;return imp;}
 f=N.func(h,index,r.info.funcs[index],String(index));
 FUNCS.set(f,{h:h,index:index});
 r.fns[index]=f;
 return f;}
function funcIndex(f,h){
 var s=isObject(f)&&FUNCS.get(f),r;
 if(!s)throw new TypeError('The value is not a WebAssembly function');
 if(s.h===h)return s.index;
 /* the same function imported into h */
 r=INSTANCES.get(h);
 if(r){var i=r.imports.indexOf(f);if(i>=0)return i;}
 throw new TypeError('A function of another instance cannot be stored here');}
N.init({CompileError:CompileError,LinkError:LinkError,RuntimeError:RuntimeError,
 funcFor:funcFor,funcIndex:funcIndex});

/* ---- Memory, Table and Global: one object per thing ---- */
var OBJECTS=new Map(),GONE=new FinalizationRegistry(function(key){
 var ref=OBJECTS.get(key);
 if(ref&&!ref.deref())OBJECTS.delete(key);});
function remember(key,o){OBJECTS.set(key,new WeakRef(o));GONE.register(o,key);}
function cached(kind,h,index,make){
 var key=kind+':'+N.key(h,kind==='table'?1:kind==='memory'?2:3,index);
 var ref=OBJECTS.get(key),o=ref&&ref.deref();
 if(o)return o;
 o=make();
 remember(key,o);
 return o;}
/* a module with one memory, table or global exported as "x" */
function oneThing(section,kind,body){
 var out=[0,0x61,0x73,0x6d,1,0,0,0];
 function leb(n,a){do{var x=n%128;n=Math.floor(n/128);a.push(n?x|0x80:x);}while(n);return a;}
 out.push(section);leb(body.length+1,out);out.push(1);out=out.concat(body);
 out.push(7,5,1,1,0x78,kind,0);
 return new Uint8Array(out);}
function limitsBytes(min,max){
 var a=[max===undefined?0:1],leb=function(n){do{var x=n%128;n=Math.floor(n/128);a.push(n?x|0x80:x);}while(n);};
 leb(min);if(max!==undefined)leb(max);return a;}
function standalone(bytes){
 var h=N.compile(bytes),i=N.instantiate(h,[],[],[],[],[],[],[],[],[]);
 INSTANCES.set(i,{info:parse(bytes),fns:[],imports:[]});
 return i;}

/* Memory */
var MEMORIES=new WeakMap();
function memSlot(m){var s=isObject(m)&&MEMORIES.get(m);
 if(!s)throw new TypeError('The object is not a WebAssembly.Memory');return s;}
function memObject(h,index){
 return cached('memory',h,index,function(){
  var m=Object.create(Memory.prototype);
  MEMORIES.set(m,{h:h,index:index,buffer:null});
  return m;});}
function Memory(desc){
 if(!new.target)throw new TypeError("Constructor WebAssembly.Memory requires 'new'");
 if(desc!==undefined&&desc!==null&&!isObject(desc))throw new TypeError('The descriptor is not an object');
 desc=desc||{};
 var initial=desc.initial,maximum,shared;
 if(initial===undefined)throw new TypeError("The descriptor has no 'initial'");
 initial=enforce(initial,'initial');
 maximum=desc.maximum;
 if(maximum!==undefined)maximum=enforce(maximum,'maximum');
 shared=!!desc.shared;
 if(initial>65536)throw new RangeError('initial is larger than 65536 pages');
 if(maximum!==undefined&&maximum>65536)throw new RangeError('maximum is larger than 65536 pages');
 if(maximum!==undefined&&initial>maximum)throw new RangeError('initial is larger than maximum');
 if(shared)throw new TypeError('Shared memory is not supported');
 var h;
 try{h=standalone(oneThing(5,2,limitsBytes(initial,maximum)));}
 catch(e){throw new RangeError('Could not allocate the memory');}
 var m=this;
 if(new.target!==Memory)m=Object.create(new.target.prototype);
 MEMORIES.set(m,{h:h,index:0,buffer:null});
 remember('memory:'+N.key(h,2,0),m);
 return m;}
function isDetached(b){return b.detached;}
members(Memory.prototype,{
 get buffer(){
  var s=memSlot(this);
  if(!s.buffer||isDetached(s.buffer))s.buffer=N.memBuffer(s.h,s.index);
  return s.buffer;},
 grow:function grow(delta){
  var s=memSlot(this);
  if(arguments.length<1)throw new TypeError('grow requires an argument');
  delta=enforce(delta,'delta');
  var old=N.memGrow(s.h,s.index,delta);
  if(old<0)throw new RangeError('WebAssembly.Memory.grow(): Maximum memory size exceeded');
  s.buffer=null;
  return old;}});
Object.defineProperty(Memory.prototype,Symbol.toStringTag,{configurable:true,value:'WebAssembly.Memory'});

/* Table */
var TABLES=new WeakMap();
function tabSlot(t){var s=isObject(t)&&TABLES.get(t);
 if(!s)throw new TypeError('The object is not a WebAssembly.Table');return s;}
/*
 * A funcref table holds function indexes of one instance, its space: the
 * instance that exports it, or for a table made here, the instance whose
 * functions go into it first. Functions of any other instance cannot.
 */
function tableObject(h,index,elem){
 return cached('table',h,index,function(){
  var t=Object.create(Table.prototype);
  TABLES.set(t,{h:h,index:index,elem:elem,space:elem==='r'?h:null});
  return t;});}
/* a function value about to go into a table: settle the table's space */
function claimSpace(s,v){
 if(s.elem!=='r'||s.space||!isObject(v))return;
 var f=FUNCS.get(v);
 if(f)s.space=f.h;}
function refType(s){
 if(s==='anyfunc'||s==='funcref')return 'r';
 if(s==='externref')return 'x';
 return null;}
function defaultRef(elem,given,v){
 if(given)return v;
 return elem==='x'?undefined:null;}
function Table(desc,value){
 if(!new.target)throw new TypeError("Constructor WebAssembly.Table requires 'new'");
 if(desc!==undefined&&desc!==null&&!isObject(desc))throw new TypeError('The descriptor is not an object');
 desc=desc||{};
 var element=desc.element,initial,maximum,elem;
 if(element===undefined)throw new TypeError("The descriptor has no 'element'");
 elem=refType(String(element));
 if(!elem)throw new TypeError("The descriptor's element is not 'anyfunc' or 'externref'");
 initial=desc.initial;
 if(initial===undefined)throw new TypeError("The descriptor has no 'initial'");
 initial=enforce(initial,'initial');
 maximum=desc.maximum;
 if(maximum!==undefined)maximum=enforce(maximum,'maximum');
 if(maximum!==undefined&&initial>maximum)throw new RangeError('initial is larger than maximum');
 if(initial>10000000)throw new RangeError('initial is larger than 10000000');
 var h;
 try{h=standalone(oneThing(4,1,[elem==='r'?0x70:0x6f].concat(limitsBytes(initial,maximum))));}
 catch(e){throw new RangeError('Could not allocate the table');}
 var t=this,slot={h:h,index:0,elem:elem,space:null};
 if(new.target!==Table)t=Object.create(new.target.prototype);
 var v=defaultRef(elem,arguments.length>1&&value!==undefined,value);
 claimSpace(slot,v);
 if(v!==null)for(var i=0;i<initial;i++)N.tableSet(h,0,i,v,slot.space);
 TABLES.set(t,slot);
 remember('table:'+N.key(h,1,0),t);
 return t;}
members(Table.prototype,{
 get length(){
  var s=tabSlot(this);return N.tableInfo(s.h,s.index)[0];},
 get:function get(index){
  var s=tabSlot(this);
  if(arguments.length<1)throw new TypeError('get requires an argument');
  index=enforce(index,'index');
  return N.tableGet(s.h,s.index,index,s.space);},
 set:function set(index){
  var s=tabSlot(this);
  if(arguments.length<1)throw new TypeError('set requires an argument');
  index=enforce(index,'index');
  var v=defaultRef(s.elem,arguments.length>1,arguments[1]);
  if(index>=N.tableInfo(s.h,s.index)[0])throw new RangeError('Table index out of bounds');
  claimSpace(s,v);
  N.tableSet(s.h,s.index,index,v,s.space);},
 grow:function grow(delta){
  var s=tabSlot(this);
  if(arguments.length<1)throw new TypeError('grow requires an argument');
  delta=enforce(delta,'delta');
  var v=defaultRef(s.elem,arguments.length>1,arguments[1]);
  claimSpace(s,v);
  var old=N.tableGrow(s.h,s.index,delta,v,s.space);
  if(old<0)throw new RangeError('WebAssembly.Table.grow(): failed to grow table');
  return old;}});
Object.defineProperty(Table.prototype,Symbol.toStringTag,{configurable:true,value:'WebAssembly.Table'});

/* Global */
var GLOBALS=new WeakMap();
var VALNAMES={i32:'i',i64:'I',f32:'f',f64:'d',externref:'x',anyfunc:'r',funcref:'r'};
function globSlot(g){var s=isObject(g)&&GLOBALS.get(g);
 if(!s)throw new TypeError('The object is not a WebAssembly.Global');return s;}
function globalObject(h,index,type,mutable){
 return cached('global',h,index,function(){
  var g=Object.create(Global.prototype);
  GLOBALS.set(g,{h:h,index:index,type:type,mutable:mutable});
  return g;});}
var ZERO_INIT={i:[0x41,0],I:[0x42,0],f:[0x43,0,0,0,0],d:[0x44,0,0,0,0,0,0,0,0],
 x:[0xd0,0x6f],r:[0xd0,0x70]};
var TYPE_BYTE={i:0x7f,I:0x7e,f:0x7d,d:0x7c,x:0x6f,r:0x70};
function Global(desc,v){
 if(!new.target)throw new TypeError("Constructor WebAssembly.Global requires 'new'");
 if(desc!==undefined&&desc!==null&&!isObject(desc))throw new TypeError('The descriptor is not an object');
 desc=desc||{};
 var mutable=!!desc.mutable,value=desc.value,type;
 if(value===undefined)throw new TypeError("The descriptor has no 'value'");
 type=VALNAMES[String(value)];
 if(!type)throw new TypeError("The descriptor's value is not a known type");
 var given=arguments.length>1&&v!==undefined;
 var init=given?(type==='x'||type==='r'?v:N.toValue(type,v)):
  (type==='x'?undefined:type==='r'?null:type==='I'?0n:0);
 var h=standalone(oneThing(6,3,[TYPE_BYTE[type],mutable?1:0].concat(ZERO_INIT[type],[0x0b])));
 var g=this;
 if(new.target!==Global)g=Object.create(new.target.prototype);
 GLOBALS.set(g,{h:h,index:0,type:type,mutable:mutable});
 remember('global:'+N.key(h,3,0),g);
 N.globalSet(h,0,type,init);
 return g;}
function globalValue(g){var s=globSlot(g);return N.globalGet(s.h,s.index,s.type);}
members(Global.prototype,{
 get value(){return globalValue(this);},
 set value(v){
  var s=globSlot(this);
  if(!s.mutable)throw new TypeError("Can't set the value of an immutable global");
  N.globalSet(s.h,s.index,s.type,v);},
 valueOf:function valueOf(){return globalValue(this);}});
Object.defineProperty(Global.prototype,Symbol.toStringTag,{configurable:true,value:'WebAssembly.Global'});

/* ---- Instance ---- */
var INSTANCE_EXPORTS=new WeakMap();
function sameLimits(have,want){
 /* an imported memory or table must be at least as large as asked, and
    no larger at its maximum */
 if(have.min<want.min)return false;
 if(want.max!==undefined){
  if(have.max===undefined||have.max>want.max)return false;}
 return true;}
/* several results come back from JavaScript as any iterable */
function iterableResults(f){
 return function(){
  var r=f.apply(undefined,arguments),it,iter,next,step,out=[];
  if(!isObject(r))throw new TypeError('The results are not iterable');
  it=r[Symbol.iterator];
  if(typeof it!=='function')throw new TypeError('The results are not iterable');
  iter=it.call(r);
  if(!isObject(iter))throw new TypeError('The iterator is not an object');
  next=iter.next;
  for(;;){
   step=next.call(iter);
   if(!isObject(step))throw new TypeError('The iterator result is not an object');
   if(step.done)break;
   out.push(step.value);}
  return out;};}
/* "read the imports": everything taken from the import object, checked */
function readImports(slot,importObject){
 var info=slot.info,funcs=[],calls=[],sigs=[],globals=[],gOwners=[],gIndexes=[],
  memOwners=[],memIndexes=[],tOwners=[],tIndexes=[],claim=[];
 if(info.imports.length&&importObject===undefined)
  throw new TypeError('An import object is required');
 info.imports.forEach(function(im){
  var o=importObject[im.module];
  if(!isObject(o))throw new TypeError("The import object's '"+im.module+"' is not an object");
  var v=o[im.name],what="import '"+im.module+'.'+im.name+"'";
  if(im.kind==='function'){
   if(typeof v!=='function')throw new LinkError(what+' is not a function');
   var fs=FUNCS.get(v);
   if(fs){var src=INSTANCES.get(fs.h);
    if(src&&src.info.funcs[fs.index]!==im.sig)
     throw new LinkError(what+' has the wrong type');}
   funcs.push(v);sigs.push(im.sig);
   calls.push(im.sig.length-im.sig.indexOf(':')-1>1&&!fs?iterableResults(v):v);}
  else if(im.kind==='global'){
   var g=im.global,gs=isObject(v)&&GLOBALS.get(v);
   if(gs){
    if(gs.type!==g.type||gs.mutable!==g.mutable)throw new LinkError(what+' has the wrong type');
    /* the same global, shared; the value is its current one, for the
       module's initializers */
    globals.push([g.type,g.type==='r'?null:N.globalGet(gs.h,gs.index,gs.type)]);
    gOwners.push(gs.h);gIndexes.push(gs.index);}
   else{
    if(g.type==='I'&&typeof v!=='bigint')throw new LinkError(what+' is not a BigInt');
    if((g.type==='i'||g.type==='f'||g.type==='d')&&typeof v!=='number')
     throw new LinkError(what+' is not a Number');
    if(g.type==='v')throw new LinkError(what+' cannot be a v128');
    if(g.mutable)throw new LinkError(what+' is not a mutable WebAssembly.Global');
    globals.push([g.type,v]);gOwners.push(null);gIndexes.push(0);}}
  else if(im.kind==='memory'){
   var ms=isObject(v)&&MEMORIES.get(v);
   if(!ms)throw new LinkError(what+' is not a WebAssembly.Memory');
   var mi=N.memInfo(ms.h,ms.index);
   if(!sameLimits({min:mi[0],max:MEM_MAX(ms)},im.memory))
    throw new LinkError(what+' has the wrong size');
   memOwners.push(ms.h);memIndexes.push(ms.index);}
  else if(im.kind==='table'){
   var ts=isObject(v)&&TABLES.get(v),ti;
   if(!ts)throw new LinkError(what+' is not a WebAssembly.Table');
   if(ts.elem!==im.table.elem)throw new LinkError(what+' has the wrong element type');
   ti=N.tableInfo(ts.h,ts.index);
   if(!sameLimits({min:ti[0],max:TABLE_MAX(ts)},im.table))
    throw new LinkError(what+' has the wrong size');
   /* its function indexes are then this instance's */
   if(ts.elem==='r'){
    if(ts.space)throw new LinkError(what+' holds functions of another instance, which is not supported yet');
    claim.push(ts);}
   tOwners.push(ts.h);tIndexes.push(ts.index);}
  else throw new LinkError(what+' is of a kind that is not supported');});
 return {funcs:funcs,calls:calls,sigs:sigs,globals:globals,gOwners:gOwners,
  gIndexes:gIndexes,memOwners:memOwners,memIndexes:memIndexes,tOwners:tOwners,
  tIndexes:tIndexes,claim:claim};}
function instantiateModule(slot,importObject){
 return link(slot,readImports(slot,importObject));}
function link(slot,im){
 var info=slot.info;
 var h=N.instantiate(slot.h,im.calls,im.sigs,im.globals,im.gOwners,im.gIndexes,
  im.memOwners,im.memIndexes,im.tOwners,im.tIndexes);
 var rec={info:info,fns:[],imports:im.funcs};
 INSTANCES.set(h,rec);
 im.claim.forEach(function(ts){ts.space=h;});
 var ex=Object.create(null);
 info.exports.forEach(function(e){
  var v;
  if(e.kind==='function')v=funcFor(h,e.index);
  else if(e.kind==='memory')v=memObject(h,e.index);
  else if(e.kind==='table')v=tableObject(h,e.index,info.tables[e.index].elem);
  else if(e.kind==='global'){var gt=info.globals[e.index];
   v=globalObject(h,e.index,gt.type,gt.mutable);}
  Object.defineProperty(ex,e.name,{value:v,enumerable:true,writable:true,configurable:true});});
 Object.freeze(ex);
 return {h:h,exports:ex};}
/* the maximum a memory or table can reach, as declared */
function MEM_MAX(ms){
 var r=INSTANCES.get(ms.h),m=r&&r.info.memories[ms.index];
 return m?m.max:undefined;}
function TABLE_MAX(ts){
 var r=INSTANCES.get(ts.h),t=r&&r.info.tables[ts.index];
 return t?t.max:undefined;}
function Instance(module,importObject){
 if(!new.target)throw new TypeError("Constructor WebAssembly.Instance requires 'new'");
 var s=moduleSlot(module);
 if(importObject!==undefined&&!isObject(importObject))
  throw new TypeError('The import object is not an object');
 var r=instantiateModule(s,importObject);
 var inst=this;
 if(new.target!==Instance)inst=Object.create(new.target.prototype);
 INSTANCE_EXPORTS.set(inst,r);
 return inst;}
members(Instance.prototype,{get exports(){
 var r=isObject(this)&&INSTANCE_EXPORTS.get(this);
 if(!r)throw new TypeError('The object is not a WebAssembly.Instance');
 return r.exports;}});
Object.defineProperty(Instance.prototype,Symbol.toStringTag,{configurable:true,value:'WebAssembly.Instance'});
function newInstance(module,importObject){
 return linkedInstance(moduleSlot(module),readImports(moduleSlot(module),importObject));}
function linkedInstance(s,im){
 var r=link(s,im),inst=Object.create(Instance.prototype);
 INSTANCE_EXPORTS.set(inst,r);
 return inst;}

/* ---- the namespace ---- */
function later(f){return Promise.resolve().then(f);}
function validate(bytes){
 if(arguments.length<1)throw new TypeError('WebAssembly.validate requires an argument');
 var b=bytesOf(bytes);
 try{N.compile(b);return true;}catch(e){return false;}}
function compile(bytes){
 var b;
 try{b=bytesOf(bytes);}catch(e){return Promise.reject(e);}
 return later(function(){return compileBytes(b);});}
function instantiate(source,importObject){
 if(importObject!==undefined&&!isObject(importObject))
  return Promise.reject(new TypeError('The import object is not an object'));
 if(isObject(source)&&MODULES.has(source)){
  /* the import object is read now; the instance is made after */
  var s=MODULES.get(source),im;
  try{im=readImports(s,importObject);}catch(e){return Promise.reject(e);}
  return later(function(){return linkedInstance(s,im);});}
 var b;
 try{b=bytesOf(source);}catch(e){return Promise.reject(e);}
 return later(function(){
  var m=compileBytes(b);
  return later(function(){return {module:m,instance:newInstance(m,importObject)};});});}
function responseBytes(source){
 return Promise.resolve(source).then(function(r){
  if(typeof W.Response!=='function'||!(r instanceof W.Response))
   throw new TypeError('The argument is not a Response');
  var ct=r.headers&&r.headers.get('Content-Type');
  if(!ct||ct.split(';')[0].trim().toLowerCase()!=='application/wasm')
   throw new TypeError("The response's MIME type is not application/wasm");
  if(!r.ok)throw new TypeError('The response is not ok');
  if(r.bodyUsed)throw new TypeError('The response body was already used');
  return r.arrayBuffer();});}
function compileStreaming(source){
 return responseBytes(source).then(function(ab){return compileBytes(new Uint8Array(ab));});}
function instantiateStreaming(source,importObject){
 if(importObject!==undefined&&!isObject(importObject))
  return Promise.reject(new TypeError('The import object is not an object'));
 return compileStreaming(source).then(function(m){
  return {module:m,instance:newInstance(m,importObject)};});}

var WA={};
function def(name,v,enumerable){Object.defineProperty(WA,name,{value:v,writable:true,
 enumerable:!!enumerable,configurable:true});}
[['validate',validate,1],['compile',compile,1],['instantiate',instantiate,1],
 ['compileStreaming',compileStreaming,1],['instantiateStreaming',instantiateStreaming,1]]
 .forEach(function(x){Object.defineProperty(x[1],'length',{value:x[2]});def(x[0],x[1],true);});
[Module,Instance,Memory,Table,Global,CompileError,LinkError,RuntimeError].forEach(function(C){
 Object.defineProperty(C,'prototype',{writable:false});});
def('Module',Module);def('Instance',Instance);def('Memory',Memory);def('Table',Table);
def('Global',Global);def('CompileError',CompileError);def('LinkError',LinkError);
def('RuntimeError',RuntimeError);
Object.defineProperty(Instance,'length',{value:1});
Object.defineProperty(Table,'length',{value:1});
Object.defineProperty(Global,'length',{value:1});
Object.defineProperty(Memory,'length',{value:1});
Object.defineProperty(Module,'length',{value:1});
Object.defineProperty(WA,Symbol.toStringTag,{configurable:true,value:'WebAssembly'});
Object.defineProperty(W,'WebAssembly',{value:WA,writable:true,configurable:true});
})();
