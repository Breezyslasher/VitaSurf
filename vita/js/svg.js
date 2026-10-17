/*
 * SVG's DOM (VitaSurf), part of the prelude, run after nodes.js has made
 * each SVG element interface's prototype and before interfaces.js gives
 * the interface objects their shapes.
 *
 * Every SVG element had one prototype, SVGGraphicsElement's, with none
 * of its members: getBBox, getCTM and getScreenCTM, which charting and
 * icon code measures with, threw as not functions; a path had no
 * getTotalLength, which a line-drawing animation starts from; and an
 * svg's width was HTML's, a number, where d3-zoom reads
 * svg.width.baseVal.value. Each element now has its interface (nodes.js),
 * and the members here are on them as Chrome has them: the animated
 * values (SVGAnimatedLength, SVGAnimatedRect, SVGAnimatedTransformList
 * and the rest) read the element's attributes when asked and write them
 * when set, and the geometry is worked out from the attributes as SVG
 * says: a shape's box, a group's as the union of its children's through
 * their transforms, the matrices through each viewport's viewBox, and a
 * path's length and points along it.
 *
 * Not done: text is measured with the canvas's font metrics, a whole
 * run at a time, and CSS transforms on SVG elements are not followed.
 */
(function(){
'use strict';
var W=window,own=Object.prototype.hasOwnProperty;
var SVGNS='http://www.w3.org/2000/svg',XLINK='http://www.w3.org/1999/xlink';
function proto(n){
 var F=W[n];
 return typeof F==='function'&&F.prototype&&typeof F.prototype==='object'?
  F.prototype:null;}
function def(o,k,d){
 if(!o)return;
 d.configurable=true;
 if(!('enumerable' in d))d.enumerable=true;
 try{Object.defineProperty(o,k,d);}catch(e){}}
function getter(o,k,f){def(o,k,{get:f});}
function method(o,k,f){def(o,k,{value:f,writable:true});}
function illegal(){throw new TypeError('Illegal constructor');}
/* an interface the page cannot construct, with its members on its
   prototype and its state under a symbol */
function iface(name,members){
 var F=function(){illegal();};
 try{Object.defineProperty(F,'name',{value:name});}catch(e){}
 var p=F.prototype;
 Object.keys(members).forEach(function(k){
  var d=Object.getOwnPropertyDescriptor(members,k);
  def(p,k,d.get||d.set?{get:d.get,set:d.set}:{value:d.value,writable:true});});
 W[name]=F;
 return F;}
function make(F,state){var o=Object.create(F.prototype);o[S]=state;return o;}
var S=Symbol('svg');
function st(o){
 var s=o&&o[S];
 if(!s)throw new TypeError('Illegal invocation');
 return s;}
function ro(){throw new DOMException('The object is read-only.','NoModificationAllowedError');}

/* ---- numbers and lengths ---- */

var NUM=/^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([a-zA-Z%]*)\s*$/;
var UNITS=['','','%','em','ex','px','cm','mm','in','pt','pc'];
var PER={px:1,'':1,cm:96/2.54,mm:96/25.4,in:96,pt:4/3,pc:16};
/* a length as SVG writes one: its number and SVGLength unit type */
function parseLength(t){
 var m=NUM.exec(t==null?'':String(t)),u;
 if(!m)return null;
 u=UNITS.indexOf(m[2].toLowerCase());
 if(u<0||(u===0&&m[2]))return null;
 return {n:+m[1],u:m[2]===''?1:u};}
function fontSize(el){
 try{var f=parseFloat(W.getComputedStyle(el).fontSize);if(f>0)return f;}catch(e){}
 return 16;}
/* the size a percentage on an axis is of: the nearest viewport's
   coordinates, or for an outermost svg its own laid out size */
function percentBase(el,axis){
 var vp,wh=[0,0];
 if(el){
  vp=viewportAbove(el);
  wh=vp?coordSize(vp):el.localName==='svg'?viewportSize(el):[0,0];}
 return axis==='x'?wh[0]:axis==='y'?wh[1]:
  Math.sqrt((wh[0]*wh[0]+wh[1]*wh[1])/2);}
function userUnits(el,l,axis){
 if(!l)return 0;
 switch(UNITS[l.u]){
 case '%':return l.n/100*percentBase(el,axis);
 case 'em':return l.n*fontSize(el);
 case 'ex':return l.n*fontSize(el)/2;}
 return l.n*(PER[UNITS[l.u]]||1);}
function attrLength(el,a,axis,dflt){
 var l=parseLength(el.getAttribute(a));
 if(!l)l=parseLength(dflt||'0');
 return userUnits(el,l,axis);}
function numberAttr(el,a,d){
 var v=el.getAttribute(a),n;
 if(v===null||v==='')return d;
 n=parseFloat(v);
 /* a stop's offset may be written as a percentage */
 if(a==='offset'&&/%\s*$/.test(v))n/=100;
 return isFinite(n)?n:d;}
function numbers(t){
 var out=[],re=/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g,m;
 t=t==null?'':String(t);
 while((m=re.exec(t)))out.push(+m[0]);
 return out;}
/* as Chrome writes a float: six significant digits */
function fmt(n){
 var s=String(+(+n).toPrecision(6));
 return s==='-0'?'0':s;}
/* SVG's numbers are single precision, as Chrome keeps them */
var F=Math.fround;

/* ---- SVGLength, SVGAnimatedLength and the lists ---- */

var LENGTH_KINDS=['SVG_LENGTHTYPE_UNKNOWN','SVG_LENGTHTYPE_NUMBER',
 'SVG_LENGTHTYPE_PERCENTAGE','SVG_LENGTHTYPE_EMS','SVG_LENGTHTYPE_EXS',
 'SVG_LENGTHTYPE_PX','SVG_LENGTHTYPE_CM','SVG_LENGTHTYPE_MM',
 'SVG_LENGTHTYPE_IN','SVG_LENGTHTYPE_PT','SVG_LENGTHTYPE_PC'];
/* a length is an element's attribute (el, a) or a value of its own */
function lengthOf(s){
 if(!s.el)return s.v;
 return parseLength(s.el.getAttribute(s.a))||parseLength(s.d)||{n:0,u:1};}
function lengthSet(s,l){
 if(s.ro)ro();
 if(s.el)s.el.setAttribute(s.a,fmt(l.n)+UNITS[l.u]);
 else s.v=l;}
function lengthUser(s){
 var l=lengthOf(s);
 return s.el?userUnits(s.el,l,s.axis):userUnits(null,l.u===2?{n:0,u:1}:l,s.axis);}
var SVGLength=iface('SVGLength',{
 get unitType(){return lengthOf(st(this)).u;},
 get value(){return F(lengthUser(st(this)));},
 set value(v){var s=st(this),l=lengthOf(s),one=l.u===1?1:
   userUnits(s.el,{n:1,u:l.u},s.axis);
  v=+v;if(!isFinite(v))throw new TypeError("The provided float value is non-finite.");
  lengthSet(s,{n:one?v/one:v,u:one?l.u:1});},
 get valueInSpecifiedUnits(){return F(lengthOf(st(this)).n);},
 set valueInSpecifiedUnits(v){var s=st(this);lengthSet(s,{n:+v,u:lengthOf(s).u});},
 get valueAsString(){var l=lengthOf(st(this));return fmt(l.n)+UNITS[l.u];},
 set valueAsString(v){var s=st(this),l=parseLength(v);
  if(!l)throw new DOMException("The value provided ('"+v+"') is invalid.",'SyntaxError');
  lengthSet(s,l);},
 newValueSpecifiedUnits:function(u,v){var s=st(this);
  if(!(u>=1&&u<=10))throw new DOMException('Invalid unit type','NotSupportedError');
  lengthSet(s,{n:+v,u:u|0});},
 convertToSpecifiedUnits:function(u){var s=st(this),px=lengthUser(s),one;
  if(!(u>=1&&u<=10))throw new DOMException('Invalid unit type','NotSupportedError');
  one=userUnits(s.el,{n:1,u:u|0},s.axis)||1;
  lengthSet(s,{n:u===1?px:px/one,u:u|0});}});
LENGTH_KINDS.forEach(function(k,i){
 def(SVGLength,k,{value:i,writable:false,configurable:false});
 def(SVGLength.prototype,k,{value:i,writable:false,configurable:false});});
function newLength(el,a,axis,d,readonly){
 return make(SVGLength,{el:el,a:a,axis:axis,d:d,ro:!!readonly,v:{n:0,u:1}});}
var SVGAnimatedLength=iface('SVGAnimatedLength',{
 get baseVal(){var s=st(this);return s.b||(s.b=newLength(s.el,s.a,s.axis,s.d,false));},
 get animVal(){var s=st(this);return s.n||(s.n=newLength(s.el,s.a,s.axis,s.d,true));}});
/* the animated values an element has, made once each */
function animated(el,key,makeIt){
 var c=el[S]||(el[S]=Object.create(null));
 return c[key]||(c[key]=makeIt());}
function lengthProp(p,name,axis,d,attr){
 getter(p,name,function(){
  var el=this;
  return animated(el,'L'+name,function(){
   return make(SVGAnimatedLength,{el:el,a:attr||name,axis:axis,d:d});});});}
/* a list of values from an attribute, read again at each use */
function listIface(name,item,parse,write){
 return iface(name,{
  get numberOfItems(){return parse(st(this)).length;},
  get length(){return parse(st(this)).length;},
  getItem:function(i){var l=parse(st(this));
   i=+i;if(!(i>=0&&i<l.length))
    throw new DOMException('The index provided ('+i+') is greater than or equal to the maximum bound ('+l.length+').','IndexSizeError');
   return item(st(this),l,i|0);},
  clear:function(){var s=st(this);if(s.ro)ro();write(s,[]);},
  initialize:function(v){var s=st(this);if(s.ro)ro();write(s,[v]);return v;},
  appendItem:function(v){var s=st(this),l=parse(s);if(s.ro)ro();l.push(v);write(s,l);return v;},
  insertItemBefore:function(v,i){var s=st(this),l=parse(s);if(s.ro)ro();
   l.splice(Math.max(0,Math.min(i|0,l.length)),0,v);write(s,l);return v;},
  removeItem:function(i){var s=st(this),l=parse(s),v;if(s.ro)ro();
   v=item(s,l,i|0);l.splice(i|0,1);write(s,l);return v;},
  replaceItem:function(v,i){var s=st(this),l=parse(s);if(s.ro)ro();
   l[i|0]=v;write(s,l);return v;}});}
var SVGLengthList=listIface('SVGLengthList',function(s,l,i){
  return make(SVGLength,{el:null,v:l[i],axis:s.axis});},
 function(s){return String(s.el.getAttribute(s.a)||'').trim().split(/[\s,]+/)
  .map(parseLength).filter(Boolean);},
 function(s,l){s.el.setAttribute(s.a,l.map(function(x){
  x=x&&x[S]?lengthOf(x[S]):x;return fmt(x.n)+UNITS[x.u];}).join(' '));});
var SVGAnimatedLengthList=iface('SVGAnimatedLengthList',{
 get baseVal(){var s=st(this);return s.b||(s.b=make(SVGLengthList,{el:s.el,a:s.a,axis:s.axis}));},
 get animVal(){var s=st(this);return s.n||(s.n=make(SVGLengthList,{el:s.el,a:s.a,axis:s.axis,ro:true}));}});
var SVGNumber=iface('SVGNumber',{
 get value(){var s=st(this);return F(s.el?numberAttr(s.el,s.a,s.d):s.v);},
 set value(v){var s=st(this);if(s.ro)ro();v=+v;
  if(s.el)s.el.setAttribute(s.a,fmt(v));else s.v=v;}});
var SVGNumberList=listIface('SVGNumberList',function(s,l,i){
  return make(SVGNumber,{v:l[i]});},
 function(s){return numbers(s.el.getAttribute(s.a));},
 function(s,l){s.el.setAttribute(s.a,l.map(function(x){
  return fmt(x&&x[S]?st(x).v:+x);}).join(' '));});
var SVGAnimatedNumber=iface('SVGAnimatedNumber',{
 get baseVal(){var s=st(this);return F(numberAttr(s.el,s.a,s.d));},
 set baseVal(v){var s=st(this);s.el.setAttribute(s.a,fmt(+v));},
 get animVal(){var s=st(this);return F(numberAttr(s.el,s.a,s.d));}});
var SVGAnimatedNumberList=iface('SVGAnimatedNumberList',{
 get baseVal(){var s=st(this);return s.b||(s.b=make(SVGNumberList,{el:s.el,a:s.a}));},
 get animVal(){var s=st(this);return s.n||(s.n=make(SVGNumberList,{el:s.el,a:s.a,ro:true}));}});
function numberProp(p,name,d,attr){
 getter(p,name,function(){var el=this;
  return animated(el,'N'+name,function(){
   return make(SVGAnimatedNumber,{el:el,a:attr||name,d:d});});});}
var SVGAnimatedInteger=iface('SVGAnimatedInteger',{
 get baseVal(){var s=st(this);return numberAttr(s.el,s.a,s.d)|0;},
 set baseVal(v){var s=st(this);s.el.setAttribute(s.a,String(v|0));},
 get animVal(){var s=st(this);return numberAttr(s.el,s.a,s.d)|0;}});
var SVGAnimatedBoolean=iface('SVGAnimatedBoolean',{
 get baseVal(){var s=st(this);return s.el.getAttribute(s.a)==='true';},
 set baseVal(v){var s=st(this);s.el.setAttribute(s.a,v?'true':'false');},
 get animVal(){var s=st(this);return s.el.getAttribute(s.a)==='true';}});
/* an enumeration's attribute keywords, from 1 */
var SVGAnimatedEnumeration=iface('SVGAnimatedEnumeration',{
 get baseVal(){var s=st(this),i=s.k.indexOf(s.el.getAttribute(s.a));
  return i>=0?i+1:s.d;},
 set baseVal(v){var s=st(this),k=s.k[(v|0)-1];
  if(k===undefined)throw new TypeError('The enumeration value provided ('+v+') is invalid.');
  s.el.setAttribute(s.a,k);},
 get animVal(){return this.baseVal;}});
function enumProp(p,name,keys,d,attr){
 getter(p,name,function(){var el=this;
  return animated(el,'E'+name,function(){
   return make(SVGAnimatedEnumeration,{el:el,a:attr||name,k:keys,d:d});});});}
var SVGAnimatedString=iface('SVGAnimatedString',{
 get baseVal(){var s=st(this),v=s.el.getAttribute(s.a);
  if(v===null&&s.x)v=s.el.getAttributeNS(XLINK,'href');
  return v===null?'':v;},
 set baseVal(v){var s=st(this);s.el.setAttribute(s.a,String(v));},
 get animVal(){return this.baseVal;}});
function stringProp(p,name,attr,xlink){
 getter(p,name,function(){var el=this;
  return animated(el,'S'+name,function(){
   return make(SVGAnimatedString,{el:el,a:attr||name,x:!!xlink});});});}
var SVGStringList=listIface('SVGStringList',function(s,l,i){return l[i];},
 function(s){var v=s.el.getAttribute(s.a);return v?v.trim().split(/\s+/):[];},
 function(s,l){s.el.setAttribute(s.a,l.join(' '));});
function stringListProp(p,name){
 getter(p,name,function(){var el=this;
  return animated(el,'T'+name,function(){
   return make(SVGStringList,{el:el,a:name});});});}

/* ---- SVGRect, SVGPoint, SVGMatrix, SVGAngle ---- */

/* a rect is a viewBox attribute's (el) or one of its own */
function rectOf(s){
 if(!s.el)return s.v;
 var n=numbers(s.el.getAttribute('viewBox'));
 return n.length===4?n:[0,0,0,0];}
function rectSet(s,i,v){
 var r;
 if(s.ro)ro();
 if(!s.el){s.v[i]=+v;return;}
 r=rectOf(s).slice();r[i]=+v;
 s.el.setAttribute('viewBox',r.map(fmt).join(' '));}
var SVGRect=iface('SVGRect',{
 get x(){return F(rectOf(st(this))[0]);},set x(v){rectSet(st(this),0,v);},
 get y(){return F(rectOf(st(this))[1]);},set y(v){rectSet(st(this),1,v);},
 get width(){return F(rectOf(st(this))[2]);},set width(v){rectSet(st(this),2,v);},
 get height(){return F(rectOf(st(this))[3]);},set height(v){rectSet(st(this),3,v);}});
function newRect(x,y,w,h){return make(SVGRect,{v:[x||0,y||0,w||0,h||0]});}
var SVGAnimatedRect=iface('SVGAnimatedRect',{
 get baseVal(){var s=st(this);return s.b||(s.b=make(SVGRect,{el:s.el}));},
 get animVal(){var s=st(this);return s.n||(s.n=make(SVGRect,{el:s.el,ro:true}));}});
/* a matrix's six values: [a, b, c, d, e, f] */
var ID=[1,0,0,1,0,0];
function mul(m,n){
 return [m[0]*n[0]+m[2]*n[1],m[1]*n[0]+m[3]*n[1],
  m[0]*n[2]+m[2]*n[3],m[1]*n[2]+m[3]*n[3],
  m[0]*n[4]+m[2]*n[5]+m[4],m[1]*n[4]+m[3]*n[5]+m[5]];}
function inv(m){
 var d=m[0]*m[3]-m[1]*m[2];
 if(!d||!isFinite(d))return null;
 return [m[3]/d,-m[1]/d,-m[2]/d,m[0]/d,(m[2]*m[5]-m[3]*m[4])/d,(m[1]*m[4]-m[0]*m[5])/d];}
function apply(m,x,y){return [m[0]*x+m[2]*y+m[4],m[1]*x+m[3]*y+m[5]];}
function rotation(deg){
 var r=deg*Math.PI/180,c=Math.cos(r),s=Math.sin(r);
 /* exact at the quarter turns, as Chrome's are */
 if(deg%90===0){c=Math.round(c);s=Math.round(s);}
 return [c,s,-s,c,0,0];}
function matOf(s){
 if(s.t)return transformMatrix(s.t);
 return s.v;}
function matSet(s,i,v){
 if(s.ro)ro();
 if(s.t){var m=matOf(s).slice();m[i]=+v;setTransform(s.t,1,m,0,0,0);return;}
 s.v[i]=+v;}
function asMat(o){
 if(o&&o[S]&&o[S].v&&o[S].v.length===6||o&&o[S]&&o[S].t)return matOf(o[S]);
 if(o&&typeof o.a==='number')return [o.a,o.b,o.c,o.d,o.e,o.f];
 throw new TypeError("Failed to execute 'multiply' on 'SVGMatrix': parameter 1 is not of type 'SVGMatrix'.");}
function newMatrix(m){return make(SVGMatrix,{v:m.slice()});}
var SVGMatrix=iface('SVGMatrix',{
 get a(){return matOf(st(this))[0];},set a(v){matSet(st(this),0,v);},
 get b(){return matOf(st(this))[1];},set b(v){matSet(st(this),1,v);},
 get c(){return matOf(st(this))[2];},set c(v){matSet(st(this),2,v);},
 get d(){return matOf(st(this))[3];},set d(v){matSet(st(this),3,v);},
 get e(){return matOf(st(this))[4];},set e(v){matSet(st(this),4,v);},
 get f(){return matOf(st(this))[5];},set f(v){matSet(st(this),5,v);},
 multiply:function(o){return newMatrix(mul(matOf(st(this)),asMat(o)));},
 inverse:function(){var m=inv(matOf(st(this)));
  if(!m)throw new DOMException('The matrix is not invertible.','InvalidStateError');
  return newMatrix(m);},
 translate:function(x,y){return newMatrix(mul(matOf(st(this)),[1,0,0,1,+x,+y]));},
 scale:function(k){return newMatrix(mul(matOf(st(this)),[+k,0,0,+k,0,0]));},
 scaleNonUniform:function(x,y){return newMatrix(mul(matOf(st(this)),[+x,0,0,+y,0,0]));},
 rotate:function(a){return newMatrix(mul(matOf(st(this)),rotation(+a)));},
 rotateFromVector:function(x,y){
  if(!x||!y)throw new DOMException('Arguments cannot be zero.','InvalidAccessError');
  return newMatrix(mul(matOf(st(this)),rotation(Math.atan2(y,x)*180/Math.PI)));},
 flipX:function(){return newMatrix(mul(matOf(st(this)),[-1,0,0,1,0,0]));},
 flipY:function(){return newMatrix(mul(matOf(st(this)),[1,0,0,-1,0,0]));},
 skewX:function(a){return newMatrix(mul(matOf(st(this)),[1,0,Math.tan(a*Math.PI/180),1,0,0]));},
 skewY:function(a){return newMatrix(mul(matOf(st(this)),[1,Math.tan(a*Math.PI/180),0,1,0,0]));}});
var SVGPoint=iface('SVGPoint',{
 get x(){return F(st(this).x);},set x(v){var s=st(this);if(s.ro)ro();s.x=+v;},
 get y(){return F(st(this).y);},set y(v){var s=st(this);if(s.ro)ro();s.y=+v;},
 matrixTransform:function(m){var s=st(this),p=apply(asMat(m),s.x,s.y);
  return newPoint(p[0],p[1]);}});
function newPoint(x,y){return make(SVGPoint,{x:+x||0,y:+y||0});}
var ANGLE_UNITS=['','','deg','rad','grad'];
var SVGAngle=iface('SVGAngle',{
 get unitType(){return st(this).u;},
 get value(){var s=st(this);return s.u===3?s.n*180/Math.PI:s.u===4?s.n*0.9:s.n;},
 set value(v){var s=st(this);s.n=+v;s.u=s.u===1?1:2;},
 get valueInSpecifiedUnits(){return st(this).n;},
 set valueInSpecifiedUnits(v){st(this).n=+v;},
 get valueAsString(){var s=st(this);return fmt(s.n)+ANGLE_UNITS[s.u];},
 set valueAsString(v){var s=st(this),m=/^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(deg|rad|grad)?\s*$/i.exec(v);
  if(!m)throw new DOMException("The value provided ('"+v+"') is invalid.",'SyntaxError');
  s.n=+m[1];s.u=m[2]?ANGLE_UNITS.indexOf(m[2].toLowerCase()):1;},
 newValueSpecifiedUnits:function(u,v){var s=st(this);s.u=u|0;s.n=+v;},
 convertToSpecifiedUnits:function(u){var s=st(this),deg=this.value;
  s.u=u|0;s.n=u===3?deg*Math.PI/180:u===4?deg/0.9:deg;}});
['SVG_ANGLETYPE_UNKNOWN','SVG_ANGLETYPE_UNSPECIFIED','SVG_ANGLETYPE_DEG',
 'SVG_ANGLETYPE_RAD','SVG_ANGLETYPE_GRAD'].forEach(function(k,i){
 def(SVGAngle,k,{value:i,writable:false,configurable:false});
 def(SVGAngle.prototype,k,{value:i,writable:false,configurable:false});});
iface('SVGAnimatedAngle',{
 get baseVal(){var s=st(this);return s.b||(s.b=make(SVGAngle,{n:0,u:1}));},
 get animVal(){return this.baseVal;}});

/* ---- transforms ---- */

var T_KINDS=['SVG_TRANSFORM_UNKNOWN','SVG_TRANSFORM_MATRIX',
 'SVG_TRANSFORM_TRANSLATE','SVG_TRANSFORM_SCALE','SVG_TRANSFORM_ROTATE',
 'SVG_TRANSFORM_SKEWX','SVG_TRANSFORM_SKEWY'];
var T_NAMES=['','matrix','translate','scale','rotate','skewX','skewY'];
/* a transform list's items: {type, args} */
function parseTransforms(t){
 var out=[],re=/\s*,?\s*(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g,m,
  rest=t==null?'':String(t),at=0,type,a;
 while((m=re.exec(rest))){
  if(m.index!==at)return [];
  at=re.lastIndex;
  type=T_NAMES.indexOf(m[1]);a=numbers(m[2]);
  if(type===1&&a.length!==6||type===2&&(a.length<1||a.length>2)||
     type===3&&(a.length<1||a.length>2)||type===4&&a.length!==1&&a.length!==3||
     type>4&&a.length!==1)return [];
  out.push({type:type,args:a});}
 if(rest.slice(at).trim()!=='')return [];
 return out;}
function itemMatrix(it){
 var a=it.args;
 switch(it.type){
 case 1:return a.slice(0,6);
 case 2:return [1,0,0,1,a[0],a.length>1?a[1]:0];
 case 3:return [a[0],0,0,a.length>1?a[1]:a[0],0,0];
 case 4:{var r=rotation(a[0]);
  if(a.length===3)r=mul(mul([1,0,0,1,a[1],a[2]],r),[1,0,0,1,-a[1],-a[2]]);
  return r;}
 case 5:return [1,0,Math.tan(a[0]*Math.PI/180),1,0,0];
 case 6:return [1,Math.tan(a[0]*Math.PI/180),0,1,0,0];}
 return ID.slice();}
function serialise(it){return T_NAMES[it.type]+'('+it.args.map(fmt).join(' ')+')';}
/* an SVGTransform is an item of an element's list (el, i) or its own */
function tAttr(s){return s.a||'transform';}
function tItem(s){
 if(!s.el)return s.v;
 return parseTransforms(s.el.getAttribute(tAttr(s)))[s.i]||{type:1,args:ID.slice()};}
function transformMatrix(s){return itemMatrix(tItem(s));}
function setTransform(s,type,m,x,y,angle){
 var it;
 if(s.ro)ro();
 switch(type){
 case 1:it={type:1,args:m.slice(0,6)};break;
 case 2:it={type:2,args:[x,y]};break;
 case 3:it={type:3,args:[x,y]};break;
 case 4:it={type:4,args:x||y?[angle,x,y]:[angle]};break;
 default:it={type:type,args:[angle]};}
 if(!s.el){s.v=it;return;}
 var l=parseTransforms(s.el.getAttribute(tAttr(s)));
 l[s.i]=it;
 s.el.setAttribute(tAttr(s),l.map(serialise).join(' '));}
var SVGTransform=iface('SVGTransform',{
 get type(){return tItem(st(this)).type;},
 get matrix(){var s=st(this);return make(SVGMatrix,{t:s});},
 get angle(){var it=tItem(st(this));
  return it.type>=4?it.args[0]:0;},
 setMatrix:function(m){setTransform(st(this),1,asMat(m));},
 setTranslate:function(x,y){setTransform(st(this),2,null,+x,+y);},
 setScale:function(x,y){setTransform(st(this),3,null,+x,+y);},
 setRotate:function(a,x,y){setTransform(st(this),4,null,+x,+y,+a);},
 setSkewX:function(a){setTransform(st(this),5,null,0,0,+a);},
 setSkewY:function(a){setTransform(st(this),6,null,0,0,+a);}});
T_KINDS.forEach(function(k,i){
 def(SVGTransform,k,{value:i,writable:false,configurable:false});
 def(SVGTransform.prototype,k,{value:i,writable:false,configurable:false});});
function newTransform(it){return make(SVGTransform,{v:it});}
function itemOf(v){
 if(v&&v[S])return tItem(v[S]);
 throw new TypeError("parameter 1 is not of type 'SVGTransform'.");}
var SVGTransformList=listIface('SVGTransformList',function(s,l,i){
  return make(SVGTransform,{el:s.el,a:s.a,i:i,ro:s.ro});},
 function(s){return parseTransforms(s.el.getAttribute(tAttr(s)));},
 function(s,l){s.el.setAttribute(tAttr(s),l.map(function(v){
  return serialise(v&&v.type!==undefined&&v.args?v:itemOf(v));}).join(' '));});
method(SVGTransformList.prototype,'consolidate',function(){
 var s=st(this),l=parseTransforms(s.el.getAttribute(tAttr(s))),m=ID.slice();
 if(!l.length)return null;
 l.forEach(function(it){m=mul(m,itemMatrix(it));});
 if(s.ro)return newTransform({type:1,args:m});
 s.el.setAttribute(tAttr(s),serialise({type:1,args:m}));
 return make(SVGTransform,{el:s.el,a:s.a,i:0});});
method(SVGTransformList.prototype,'createSVGTransformFromMatrix',function(m){
 return newTransform({type:1,args:asMat(m)});});
var SVGAnimatedTransformList=iface('SVGAnimatedTransformList',{
 get baseVal(){var s=st(this);return s.b||(s.b=make(SVGTransformList,{el:s.el,a:s.a}));},
 get animVal(){var s=st(this);return s.n||(s.n=make(SVGTransformList,{el:s.el,a:s.a,ro:true}));}});

/* ---- preserveAspectRatio and points ---- */

var ALIGNS=['','none','xMinYMin','xMidYMin','xMaxYMin','xMinYMid','xMidYMid',
 'xMaxYMid','xMinYMax','xMidYMax','xMaxYMax'];
function parAttr(el){
 var t=String(el&&el.getAttribute('preserveAspectRatio')||'').trim().split(/\s+/),
  a=ALIGNS.indexOf(t[0]||'xMidYMid'),m=t[1]==='slice'?2:1;
 return {align:a>0?a:6,meet:a>0?m:1};}
var SVGPreserveAspectRatio=iface('SVGPreserveAspectRatio',{
 get align(){return parAttr(st(this).el).align;},
 set align(v){var s=st(this),p=parAttr(s.el);
  if(ALIGNS[v|0])s.el.setAttribute('preserveAspectRatio',ALIGNS[v|0]+(p.meet===2?' slice':''));},
 get meetOrSlice(){return parAttr(st(this).el).meet;},
 set meetOrSlice(v){var s=st(this),p=parAttr(s.el);
  s.el.setAttribute('preserveAspectRatio',ALIGNS[p.align]+((v|0)===2?' slice':''));}});
['SVG_PRESERVEASPECTRATIO_UNKNOWN','SVG_PRESERVEASPECTRATIO_NONE',
 'SVG_PRESERVEASPECTRATIO_XMINYMIN','SVG_PRESERVEASPECTRATIO_XMIDYMIN',
 'SVG_PRESERVEASPECTRATIO_XMAXYMIN','SVG_PRESERVEASPECTRATIO_XMINYMID',
 'SVG_PRESERVEASPECTRATIO_XMIDYMID','SVG_PRESERVEASPECTRATIO_XMAXYMID',
 'SVG_PRESERVEASPECTRATIO_XMINYMAX','SVG_PRESERVEASPECTRATIO_XMIDYMAX',
 'SVG_PRESERVEASPECTRATIO_XMAXYMAX'].forEach(function(k,i){
 def(SVGPreserveAspectRatio,k,{value:i,writable:false,configurable:false});
 def(SVGPreserveAspectRatio.prototype,k,{value:i,writable:false,configurable:false});});
['SVG_MEETORSLICE_UNKNOWN','SVG_MEETORSLICE_MEET','SVG_MEETORSLICE_SLICE'].forEach(function(k,i){
 def(SVGPreserveAspectRatio,k,{value:i,writable:false,configurable:false});
 def(SVGPreserveAspectRatio.prototype,k,{value:i,writable:false,configurable:false});});
var SVGAnimatedPreserveAspectRatio=iface('SVGAnimatedPreserveAspectRatio',{
 get baseVal(){var s=st(this);return s.b||(s.b=make(SVGPreserveAspectRatio,{el:s.el}));},
 get animVal(){return this.baseVal;}});
function pointsOf(s){
 var n=numbers(s.el.getAttribute('points')),out=[],i;
 for(i=0;i+1<n.length;i+=2)out.push([n[i],n[i+1]]);
 return out;}
var SVGPointList=listIface('SVGPointList',function(s,l,i){
  return newPoint(l[i][0],l[i][1]);},pointsOf,
 function(s,l){s.el.setAttribute('points',l.map(function(p){
  return p&&p[S]?fmt(p.x)+','+fmt(p.y):fmt(p[0])+','+fmt(p[1]);}).join(' '));});
iface('SVGUnitTypes',{});
['SVG_UNIT_TYPE_UNKNOWN','SVG_UNIT_TYPE_USERSPACEONUSE',
 'SVG_UNIT_TYPE_OBJECTBOUNDINGBOX'].forEach(function(k,i){
 def(W.SVGUnitTypes,k,{value:i,writable:false,configurable:false});
 def(W.SVGUnitTypes.prototype,k,{value:i,writable:false,configurable:false});});

/* ---- viewports and matrices ---- */

function isSvg(e){return !!e&&e.nodeType===1&&e.namespaceURI===SVGNS;}
function parentEl(e){
 var p=e.parentNode;
 return p&&p.nodeType===1?p:null;}
/* the nearest svg above (for an outermost svg, none) */
function viewportAbove(e){
 for(var p=parentEl(e);p;p=parentEl(p)){
  if(!isSvg(p))return null;
  if(p.localName==='svg'||p.localName==='symbol')return p;}
 return null;}
function outermost(e){
 var o=null;
 for(var p=e;p&&isSvg(p);p=parentEl(p))if(p.localName==='svg')o=p;
 return o;}
/* an svg's width and height: an outermost one's as laid out */
function viewportSize(svg){
 var r,up=viewportAbove(svg),wh,l,h;
 if(!up){
  try{r=svg.getBoundingClientRect();}catch(e){r=null;}
  if(r&&(r.width||r.height))return [r.width,r.height];
  l=parseLength(svg.getAttribute('width'));h=parseLength(svg.getAttribute('height'));
  return [l&&l.u!==2?userUnits(svg,l,'x'):300,h&&h.u!==2?userUnits(svg,h,'y'):150];}
 wh=coordSize(up);
 l=parseLength(svg.getAttribute('width'))||{n:100,u:2};
 h=parseLength(svg.getAttribute('height'))||{n:100,u:2};
 return [l.u===2?l.n/100*wh[0]:userUnits(svg,l,'x'),
  h.u===2?h.n/100*wh[1]:userUnits(svg,h,'y')];}
/* the size of the coordinates an svg gives what is in it */
function coordSize(svg){
 var vb=numbers(svg.getAttribute('viewBox'));
 if(vb.length===4&&vb[2]>0&&vb[3]>0)return [vb[2],vb[3]];
 return viewportSize(svg);}
/* what an svg's viewBox and its place in its parent make of its
   content's coordinates */
function viewBoxMatrix(svg){
 var vb=numbers(svg.getAttribute('viewBox')),wh=viewportSize(svg),
  p,sx,sy,ax,ay;
 if(vb.length!==4||!(vb[2]>0)||!(vb[3]>0))return ID.slice();
 p=parAttr(svg);
 sx=wh[0]/vb[2];sy=wh[1]/vb[3];
 if(p.align!==1){sx=sy=p.meet===2?Math.max(sx,sy):Math.min(sx,sy);}
 ax=p.align===1?0:[0,0.5,1][(p.align-2)%3];
 ay=p.align===1?0:[0,0.5,1][Math.floor((p.align-2)/3)];
 return [sx,0,0,sy,-vb[0]*sx+(wh[0]-vb[2]*sx)*ax,-vb[1]*sy+(wh[1]-vb[3]*sy)*ay];}
function ownTransform(e){
 var l=parseTransforms(e.getAttribute('transform')),m=ID.slice();
 l.forEach(function(it){m=mul(m,itemMatrix(it));});
 return m;}
/* an element's coordinates in its parent's */
function localMatrix(e){
 if(e.localName==='svg'){
  var vb=viewBoxMatrix(e);
  if(!viewportAbove(e))return vb;
  return mul([1,0,0,1,attrLength(e,'x','x'),attrLength(e,'y','y')],vb);}
 return ownTransform(e);}
function chainMatrix(from,to){
 var list=[],m=ID.slice(),e;
 for(e=to;e&&e!==from&&isSvg(e);e=parentEl(e))list.unshift(e);
 if(from)list.unshift(from);
 list.forEach(function(x){m=mul(m,localMatrix(x));});
 return m;}
function getCTM(e){
 if(!e.isConnected)return null;
 return chainMatrix(viewportAbove(e),e);}
function getScreenCTM(e){
 var o=outermost(e),r,cs,x=0,y=0;
 if(!o||!e.isConnected)return null;
 try{
  r=o.getBoundingClientRect();cs=W.getComputedStyle(o);
  x=r.left+(parseFloat(cs.borderLeftWidth)||0)+(parseFloat(cs.paddingLeft)||0);
  y=r.top+(parseFloat(cs.borderTopWidth)||0)+(parseFloat(cs.paddingTop)||0);
 }catch(err){}
 return mul([1,0,0,1,x,y],chainMatrix(o,e));}

/* ---- path geometry ---- */

/* a path's pieces, each a line [x0,y0,x1,y1] or a cubic of eight */
function pathPieces(d){
 var out=[],i=0,n,cmd='',x=0,y=0,sx=0,sy=0,cx=0,cy=0,last='',
  s=d==null?'':String(d);
 n=s.length;
 function ws(){while(i<n&&/[\s,]/.test(s.charAt(i)))i++;}
 function num(){
  ws();
  var m=/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i,i+40));
  if(!m)return NaN;
  i+=m[0].length;return +m[0];}
 function flag(){ws();var c=s.charAt(i);if(c==='0'||c==='1'){i++;return c==='1';}return null;}
 function line(x1,y1){out.push([x,y,x1,y1]);x=x1;y=y1;}
 function cubic(a,b,c2,d2,e,f){out.push([x,y,a,b,c2,d2,e,f]);x=e;y=f;}
 for(;;){
  ws();
  if(i>=n)break;
  var ch=s.charAt(i);
  if(/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)){cmd=ch;i++;}
  else if(!cmd||cmd==='z'||cmd==='Z')break;
  var rel=cmd===cmd.toLowerCase(),C=cmd.toUpperCase(),ox=rel?x:0,oy=rel?y:0,a,b,c,e,f,g;
  if(C==='Z'){
   if(x!==sx||y!==sy)line(sx,sy);
   x=sx;y=sy;last='Z';continue;}
  a=num();
  if(isNaN(a)&&C!=='Z')break;
  switch(C){
  case 'M':b=num();if(isNaN(b))return out;x=sx=a+ox;y=sy=b+oy;
   cmd=rel?'l':'L';last='M';continue;
  case 'L':b=num();if(isNaN(b))return out;line(a+ox,b+oy);break;
  case 'H':line(a+ox,y);break;
  case 'V':line(x,a+(rel?y:0));break;
  case 'C':b=num();c=num();e=num();f=num();g=num();
   if(isNaN(g))return out;cx=c+ox;cy=e+oy;cubic(a+ox,b+oy,cx,cy,f+ox,g+oy);break;
  case 'S':b=num();c=num();e=num();if(isNaN(e))return out;
   var rx1=last==='C'||last==='S'?2*x-cx:x,ry1=last==='C'||last==='S'?2*y-cy:y;
   cx=a+ox;cy=b+oy;cubic(rx1,ry1,cx,cy,c+ox,e+oy);break;
  case 'Q':b=num();c=num();e=num();if(isNaN(e))return out;
   cx=a+ox;cy=b+oy;quad(cx,cy,c+ox,e+oy);break;
  case 'T':b=num();if(isNaN(b))return out;
   cx=last==='Q'||last==='T'?2*x-cx:x;cy=last==='Q'||last==='T'?2*y-cy:y;
   quad(cx,cy,a+ox,b+oy);break;
  case 'A':{
   var ry=num(),rot=num(),large=flag(),sweep=flag(),ex=num(),ey=num();
   if(isNaN(ey)||large===null||sweep===null)return out;
   arc(Math.abs(a),Math.abs(ry),rot,large,sweep,ex+ox,ey+oy);break;}
  }
  last=C;}
 function quad(qx,qy,ex,ey){
  cubic(x+2/3*(qx-x),y+2/3*(qy-y),ex+2/3*(qx-ex),ey+2/3*(qy-ey),ex,ey);}
 /* an arc as cubics, from its centre */
 function arc(rx,ry,rot,large,sweep,ex,ey){
  if(x===ex&&y===ey)return;
  if(!rx||!ry){line(ex,ey);return;}
  var ph=rot*Math.PI/180,cp=Math.cos(ph),sp=Math.sin(ph),
   dx=(x-ex)/2,dy=(y-ey)/2,x1=cp*dx+sp*dy,y1=-sp*dx+cp*dy,
   L=x1*x1/(rx*rx)+y1*y1/(ry*ry);
  if(L>1){L=Math.sqrt(L);rx*=L;ry*=L;}
  var num2=rx*rx*ry*ry-rx*rx*y1*y1-ry*ry*x1*x1,den=rx*rx*y1*y1+ry*ry*x1*x1,
   k=Math.sqrt(Math.max(0,num2/den))*(large===sweep?-1:1),
   cxp=k*rx*y1/ry,cyp=-k*ry*x1/rx,
   ccx=cp*cxp-sp*cyp+(x+ex)/2,ccy=sp*cxp+cp*cyp+(y+ey)/2;
  function ang(ux,uy,vx,vy){
   var a2=Math.atan2(ux*vy-uy*vx,ux*vx+uy*vy);return a2;}
  var t1=ang(1,0,(x1-cxp)/rx,(y1-cyp)/ry),
   dt=ang((x1-cxp)/rx,(y1-cyp)/ry,(-x1-cxp)/rx,(-y1-cyp)/ry);
  if(!sweep&&dt>0)dt-=2*Math.PI;else if(sweep&&dt<0)dt+=2*Math.PI;
  /* pieces of at most an eighth of a turn, whose length is the arc's
     to a millionth */
  var segs=Math.max(1,Math.ceil(Math.abs(dt)/(Math.PI/4)-1e-9)),step=dt/segs,
   al=4/3*Math.tan(step/4),j;
  for(j=0;j<segs;j++){
   var a1=t1+j*step,a2=a1+step,c1=Math.cos(a1),s1=Math.sin(a1),
    c2=Math.cos(a2),s2=Math.sin(a2);
   var p1=[c1-al*s1,s1+al*c1],p2=[c2+al*s2,s2-al*c2],p3=[c2,s2];
   function pt(q){var u=q[0]*rx,v=q[1]*ry;return [cp*u-sp*v+ccx,sp*u+cp*v+ccy];}
   var A=pt(p1),B=pt(p2),E=j===segs-1?[ex,ey]:pt(p3);
   cubic(A[0],A[1],B[0],B[1],E[0],E[1]);}}
 return out;}
/* a shape's outline as path data */
function shapePath(el){
 var t=el.localName,x,y,w,h,rx,ry,cx,cy,p;
 switch(t){
 case 'path':return el.getAttribute('d')||'';
 case 'rect':
  x=attrLength(el,'x','x');y=attrLength(el,'y','y');
  w=attrLength(el,'width','x');h=attrLength(el,'height','y');
  if(!(w>0)||!(h>0))return '';
  rx=el.hasAttribute('rx')?attrLength(el,'rx','x'):null;
  ry=el.hasAttribute('ry')?attrLength(el,'ry','y'):null;
  if(rx===null)rx=ry===null?0:ry;
  if(ry===null)ry=rx;
  rx=Math.min(Math.max(rx,0),w/2);ry=Math.min(Math.max(ry,0),h/2);
  if(!rx||!ry)return 'M'+[x,y]+'H'+(x+w)+'V'+(y+h)+'H'+x+'Z';
  return 'M'+[x+rx,y]+'H'+(x+w-rx)+'A'+[rx,ry,0,0,1,x+w,y+ry]+'V'+(y+h-ry)+
   'A'+[rx,ry,0,0,1,x+w-rx,y+h]+'H'+(x+rx)+'A'+[rx,ry,0,0,1,x,y+h-ry]+
   'V'+(y+ry)+'A'+[rx,ry,0,0,1,x+rx,y]+'Z';
 case 'circle':case 'ellipse':
  cx=attrLength(el,'cx','x');cy=attrLength(el,'cy','y');
  if(t==='circle')rx=ry=attrLength(el,'r','');
  else{rx=attrLength(el,'rx','x');ry=attrLength(el,'ry','y');}
  if(!(rx>0)||!(ry>0))return '';
  return 'M'+[cx+rx,cy]+'A'+[rx,ry,0,0,1,cx,cy+ry]+'A'+[rx,ry,0,0,1,cx-rx,cy]+
   'A'+[rx,ry,0,0,1,cx,cy-ry]+'A'+[rx,ry,0,0,1,cx+rx,cy]+'Z';
 case 'line':
  return 'M'+[attrLength(el,'x1','x'),attrLength(el,'y1','y')]+
   'L'+[attrLength(el,'x2','x'),attrLength(el,'y2','y')];
 case 'polyline':case 'polygon':
  p=numbers(el.getAttribute('points'));
  if(p.length<2)return '';
  if(p.length%2)p.pop();
  return 'M'+p.slice(0,2)+(p.length>2?'L'+p.slice(2):'')+(t==='polygon'?'Z':'');}
 return '';}
/* a cubic's coordinate on one axis at t */
function bez(a,b,c,d,t){var u=1-t;return u*u*u*a+3*u*u*t*b+3*u*t*t*c+t*t*t*d;}
/* where a cubic turns on one axis, between 0 and 1 */
function turns(a,b,c,d){
 var A=-a+3*b-3*c+d,B=2*(a-2*b+c),C=b-a,out=[],q,r;
 if(Math.abs(A)<1e-12){if(Math.abs(B)>1e-12)out.push(-C/B);}
 else{q=B*B-4*A*C;
  if(q>=0){r=Math.sqrt(q);out.push((-B+r)/(2*A),(-B-r)/(2*A));}}
 return out.filter(function(t){return t>0&&t<1;});}
function grow(b,x,y){
 if(!b)return [x,y,x,y];
 if(x<b[0])b[0]=x;if(y<b[1])b[1]=y;if(x>b[2])b[2]=x;if(y>b[3])b[3]=y;
 return b;}
function piecesBox(ps,m){
 var b=null;
 ps.forEach(function(p){
  var q,t;
  if(m){
   /* through a matrix, a curve's control points move with it */
   q=[];for(var k=0;k<p.length;k+=2){var a=apply(m,p[k],p[k+1]);q.push(a[0],a[1]);}
   p=q;}
  b=grow(b,p[0],p[1]);b=grow(b,p[p.length-2],p[p.length-1]);
  if(p.length===8){
   turns(p[0],p[2],p[4],p[6]).forEach(function(t){
    b=grow(b,bez(p[0],p[2],p[4],p[6],t),bez(p[1],p[3],p[5],p[7],t));});
   turns(p[1],p[3],p[5],p[7]).forEach(function(t){
    b=grow(b,bez(p[0],p[2],p[4],p[6],t),bez(p[1],p[3],p[5],p[7],t));});}});
 return b;}
/* Gauss-Legendre over a cubic's speed */
var GX=[-0.9739065285171717,-0.8650633666889845,-0.6794095682990244,
 -0.4333953941292472,-0.1488743389816312,0.1488743389816312,0.4333953941292472,
 0.6794095682990244,0.8650633666889845,0.9739065285171717],
 GW=[0.0666713443086881,0.1494513491505806,0.2190863625159820,0.2692667193099963,
 0.2955242247147529,0.2955242247147529,0.2692667193099963,0.2190863625159820,
 0.1494513491505806,0.0666713443086881];
function speed(p,t){
 var u=1-t,dx=3*(u*u*(p[2]-p[0])+2*u*t*(p[4]-p[2])+t*t*(p[6]-p[4])),
  dy=3*(u*u*(p[3]-p[1])+2*u*t*(p[5]-p[3])+t*t*(p[7]-p[5]));
 return Math.sqrt(dx*dx+dy*dy);}
function cubicLength(p,t0,t1){
 var h=(t1-t0)/2,m=(t1+t0)/2,sum=0,i,half;
 /* a long or sharply bent curve is measured in halves */
 if(t1-t0>0.26){half=(t0+t1)/2;return cubicLength(p,t0,half)+cubicLength(p,half,t1);}
 for(i=0;i<GX.length;i++)sum+=GW[i]*speed(p,m+h*GX[i]);
 return sum*h;}
function pieceLength(p){
 if(p.length===4)return Math.sqrt((p[2]-p[0])*(p[2]-p[0])+(p[3]-p[1])*(p[3]-p[1]));
 return cubicLength(p,0,1);}
function pointAt(ps,d){
 var i,p,l,lo,hi,mid,k;
 if(!ps.length)return [0,0];
 if(d<0)d=0;
 for(i=0;i<ps.length;i++){
  p=ps[i];l=pieceLength(p);
  if(d<=l||i===ps.length-1){
   if(d>l)d=l;
   if(p.length===4){k=l?d/l:0;return [p[0]+(p[2]-p[0])*k,p[1]+(p[3]-p[1])*k];}
   lo=0;hi=1;
   for(k=0;k<40;k++){mid=(lo+hi)/2;if(cubicLength(p,0,mid)<d)lo=mid;else hi=mid;}
   mid=(lo+hi)/2;
   return [bez(p[0],p[2],p[4],p[6],mid),bez(p[1],p[3],p[5],p[7],mid)];}
  d-=l;}
 return [0,0];}
/* the outline as straight lines, for the fill and stroke tests */
function flatten(ps){
 var out=[];
 ps.forEach(function(p){
  if(p.length===4){out.push(p);return;}
  var px=p[0],py=p[1],k;
  for(k=1;k<=16;k++){var t=k/16,x=bez(p[0],p[2],p[4],p[6],t),y=bez(p[1],p[3],p[5],p[7],t);
   out.push([px,py,x,y]);px=x;py=y;}});
 return out;}
function inFill(el,x,y){
 var segs=flatten(pathPieces(shapePath(el))),wind=0,odd=false,evenodd;
 var rule=presentation(el,'fill-rule');
 if(rule===null)try{rule=W.getComputedStyle(el).fillRule;}catch(e){}
 evenodd=rule==='evenodd';
 /* each subpath closes for filling */
 segs=segs.concat(closers(pathPieces(shapePath(el))));
 segs.forEach(function(s){
  if((s[1]>y)!==(s[3]>y)){
   var xi=s[0]+(y-s[1])*(s[2]-s[0])/(s[3]-s[1]);
   if(xi>x){wind+=s[3]>s[1]?1:-1;odd=!odd;}}});
 return evenodd?odd:wind!==0;}
function closers(ps){
 var out=[],sx=null,sy=null,lx=null,ly=null;
 ps.forEach(function(p){
  if(lx===null||p[0]!==lx||p[1]!==ly){
   if(sx!==null&&(lx!==sx||ly!==sy))out.push([lx,ly,sx,sy]);
   sx=p[0];sy=p[1];}
  lx=p[p.length-2];ly=p[p.length-1];});
 if(sx!==null&&(lx!==sx||ly!==sy))out.push([lx,ly,sx,sy]);
 return out;}
function inStroke(el,x,y){
 var w=presentation(el,'stroke-width'),segs=flatten(pathPieces(shapePath(el)));
 w=w!==null?userUnits(el,parseLength(w)||{n:1,u:1},''):NaN;
 if(!(w>=0))try{w=parseFloat(W.getComputedStyle(el).strokeWidth);}catch(e){}
 if(!(w>=0))w=1;
 return segs.some(function(s){
  var dx=s[2]-s[0],dy=s[3]-s[1],l=dx*dx+dy*dy,t=l?((x-s[0])*dx+(y-s[1])*dy)/l:0;
  t=Math.max(0,Math.min(1,t));
  var px=s[0]+t*dx-x,py=s[1]+t*dy-y;
  return px*px+py*py<=w*w/4+1e-9;});}

/* ---- text ---- */

var CANVAS=null;
/* a presentation attribute (font-size="10") on the element or the
   nearest SVG element above it that has one, which the computed style
   here does not take in; a declaration in the element's own style
   attribute still wins */
function presentation(el,a){
 for(var e=el;e&&isSvg(e);e=parentEl(e)){
  var st=e.getAttribute('style');
  if(st&&new RegExp('(^|;)\\s*'+a+'\\s*:','i').test(st))return null;
  var v=e.getAttribute(a);
  if(v!==null&&v!=='')return v;}
 return null;}
function measure(el,text){
 var cs={},font,m,size,v;
 try{cs=W.getComputedStyle(el);}catch(e){}
 v=presentation(el,'font-size');
 size=v!==null?userUnits(parentEl(el),parseLength(v)||{n:16,u:1},''):
  parseFloat(cs.fontSize)||16;
 font=(presentation(el,'font-style')||cs.fontStyle||'normal')+' '+
  (presentation(el,'font-weight')||cs.fontWeight||'400')+' '+size+'px '+
  (presentation(el,'font-family')||cs.fontFamily||'sans-serif');
 try{
  if(!CANVAS)CANVAS=document.createElement('canvas').getContext('2d');
  CANVAS.font=font;m=CANVAS.measureText(text);
  return {w:m.width,a:m.fontBoundingBoxAscent,d:m.fontBoundingBoxDescent,size:size};}
 catch(e2){return {w:text.length*size/2,a:size*0.9,d:size*0.2,size:size};}}
function textOf(el){return String(el.textContent||'').replace(/\s+/g,' ').trim();}
function firstLength(el,a,axis){
 var n=String(el.getAttribute(a)||'').trim().split(/[\s,]+/)[0];
 return userUnits(el,parseLength(n)||{n:0,u:1},axis);}
function textBox(el){
 var t=textOf(el),m,x,y,anchor;
 if(!t)return null;
 m=measure(el,t);
 x=firstLength(el,'x','x')+firstLength(el,'dx','x');
 y=firstLength(el,'y','y')+firstLength(el,'dy','y');
 anchor=presentation(el,'text-anchor');
 if(anchor===null)try{anchor=W.getComputedStyle(el).textAnchor;}catch(e){anchor=null;}
 if(anchor==='middle')x-=m.w/2;else if(anchor==='end')x-=m.w;
 var asc=isFinite(m.a)&&m.a>0?m.a:m.size*0.9,desc=isFinite(m.d)&&m.d>=0?m.d:m.size*0.2;
 return [x,y-asc,x+m.w,y+desc];}

/* ---- bounding boxes ---- */

var NOT_DRAWN=' clipPath defs desc filter linearGradient marker mask metadata '+
 'pattern radialGradient script stop style symbol title view ';
function hidden(el){
 if(el.getAttribute('display')==='none')return true;
 try{return W.getComputedStyle(el).display==='none';}catch(e){return false;}}
function unionInto(b,c){
 if(!c)return b;
 if(!b)return c.slice();
 return [Math.min(b[0],c[0]),Math.min(b[1],c[1]),Math.max(b[2],c[2]),Math.max(b[3],c[3])];}
function boxThrough(m,b){
 if(!b)return null;
 var p=[apply(m,b[0],b[1]),apply(m,b[2],b[1]),apply(m,b[0],b[3]),apply(m,b[2],b[3])],
  out=null;
 p.forEach(function(q){out=grow(out,q[0],q[1]);});
 return out;}
function referenced(el){
 var h=el.getAttribute('href');
 if(h===null)h=el.getAttributeNS(XLINK,'href');
 if(!h||h.charAt(0)!=='#')return null;
 var d=el.ownerDocument;
 return d&&d.getElementById(h.slice(1));}
/* an element's box in its own coordinates, before its own transform */
function box(el,depth){
 var t=el.localName,b=null,c;
 if((depth|0)>32)return null;
 switch(t){
 case 'rect':case 'circle':case 'ellipse':case 'line':case 'polyline':
 case 'polygon':case 'path':
  return piecesBox(pathPieces(shapePath(el)),null);
 case 'image':case 'foreignObject':
  return [attrLength(el,'x','x'),attrLength(el,'y','y'),
   attrLength(el,'x','x')+attrLength(el,'width','x'),
   attrLength(el,'y','y')+attrLength(el,'height','y')];
 case 'text':case 'tspan':case 'textPath':
  return textBox(el);
 case 'use':{
  var r=referenced(el),x=attrLength(el,'x','x'),y=attrLength(el,'y','y');
  if(!r||r===el)return null;
  b=r.localName==='symbol'?childrenBox(r,depth+1):boxThrough(ownTransform(r),box(r,depth+1));
  return boxThrough([1,0,0,1,x,y],b);}}
 return childrenBox(el,depth);}
function childrenBox(el,depth){
 var b=null;
 for(var c=el.firstElementChild;c;c=c.nextElementSibling){
  if(!isSvg(c)||NOT_DRAWN.indexOf(' '+c.localName+' ')>=0||hidden(c))continue;
  b=unionInto(b,boxThrough(localMatrix(c),box(c,depth+1)));}
 return b;}

/* ---- the members ---- */

var EP=proto('SVGElement'),GP=proto('SVGGraphicsElement'),
 GEO=proto('SVGGeometryElement'),SV=proto('SVGSVGElement'),
 TC=proto('SVGTextContentElement'),TP=proto('SVGTextPositioningElement');
if(!EP||!GP)return;
getter(EP,'ownerSVGElement',function(){return viewportAbove(this);});
getter(EP,'viewportElement',function(){return viewportAbove(this);});
getter(GP,'nearestViewportElement',function(){return viewportAbove(this);});
getter(GP,'farthestViewportElement',function(){
 var o=outermost(parentEl(this)||this);return o===this?null:o;});
method(GP,'getBBox',function(){
 var b=this.isConnected?box(this,0):null;
 return b?newRect(b[0],b[1],b[2]-b[0],b[3]-b[1]):newRect(0,0,0,0);});
method(GP,'getCTM',function(){var m=getCTM(this);return m?newMatrix(m):null;});
method(GP,'getScreenCTM',function(){var m=getScreenCTM(this);return m?newMatrix(m):null;});
getter(GP,'transform',function(){var el=this;
 return animated(el,'transform',function(){return make(SVGAnimatedTransformList,{el:el});});});
stringListProp(GP,'requiredExtensions');
stringListProp(GP,'systemLanguage');
if(GEO){
 numberProp(GEO,'pathLength',0);
 method(GEO,'getTotalLength',function(){
  return F(pathPieces(shapePath(this)).reduce(function(s,p){return s+pieceLength(p);},0));});
 method(GEO,'getPointAtLength',function(d){
  var p=pointAt(pathPieces(shapePath(this)),+d||0);return newPoint(p[0],p[1]);});
 method(GEO,'isPointInFill',function(pt){
  pt=pt||{};return inFill(this,+pt.x||0,+pt.y||0);});
 method(GEO,'isPointInStroke',function(pt){
  pt=pt||{};return inStroke(this,+pt.x||0,+pt.y||0);});}
var LEN={x:'x',y:'y',width:'x',height:'y',cx:'x',cy:'y',r:'',rx:'x',ry:'y',
 x1:'x',y1:'y',x2:'x',y2:'y',fx:'x',fy:'y',fr:'',refX:'x',refY:'y',
 markerWidth:'x',markerHeight:'y',startOffset:'x',textLength:'x'};
function lengths(name,list,dflt){
 var p=proto(name);
 if(p)list.split(' ').forEach(function(k){
  lengthProp(p,k,LEN[k],dflt&&dflt[k],k);});}
lengths('SVGSVGElement','x y width height',{width:'100%',height:'100%'});
lengths('SVGRectElement','x y width height rx ry');
lengths('SVGCircleElement','cx cy r');
lengths('SVGEllipseElement','cx cy rx ry');
lengths('SVGLineElement','x1 y1 x2 y2');
lengths('SVGImageElement','x y width height');
lengths('SVGForeignObjectElement','x y width height');
lengths('SVGUseElement','x y width height');
lengths('SVGPatternElement','x y width height');
lengths('SVGMaskElement','x y width height',{x:'-10%',y:'-10%',width:'120%',height:'120%'});
lengths('SVGFilterElement','x y width height',{x:'-10%',y:'-10%',width:'120%',height:'120%'});
lengths('SVGLinearGradientElement','x1 y1 x2 y2',{x2:'100%'});
lengths('SVGRadialGradientElement','cx cy r fx fy fr',{cx:'50%',cy:'50%',r:'50%',fx:'50%',fy:'50%'});
lengths('SVGMarkerElement','refX refY markerWidth markerHeight',{markerWidth:'3',markerHeight:'3'});
lengths('SVGTextPathElement','startOffset');
if(TC)lengthProp(TC,'textLength','x',null,'textLength');
if(TP)['x','y','dx','dy'].forEach(function(k){
 getter(TP,k,function(){var el=this;
  return animated(el,'LL'+k,function(){
   return make(SVGAnimatedLengthList,{el:el,a:k,axis:k.slice(-1)});});});});
if(TP)getter(TP,'rotate',function(){var el=this;
 return animated(el,'NLrotate',function(){
  return make(SVGAnimatedNumberList,{el:el,a:'rotate'});});});
/* viewBox and preserveAspectRatio, where SVG has them */
['SVGSVGElement','SVGSymbolElement','SVGMarkerElement','SVGPatternElement',
 'SVGViewElement'].forEach(function(n){
 var p=proto(n);
 if(!p)return;
 getter(p,'viewBox',function(){var el=this;
  return animated(el,'viewBox',function(){return make(SVGAnimatedRect,{el:el});});});
 getter(p,'preserveAspectRatio',function(){var el=this;
  return animated(el,'par',function(){
   return make(SVGAnimatedPreserveAspectRatio,{el:el});});});});
var IMG=proto('SVGImageElement'),FEI=proto('SVGFEImageElement');
[IMG,FEI].forEach(function(p){
 if(p)getter(p,'preserveAspectRatio',function(){var el=this;
  return animated(el,'par',function(){
   return make(SVGAnimatedPreserveAspectRatio,{el:el});});});});
/* href, and xlink:href as SVG 1.1 wrote it */
['SVGAElement','SVGUseElement','SVGImageElement','SVGTextPathElement',
 'SVGMPathElement','SVGGradientElement','SVGPatternElement','SVGFilterElement',
 'SVGFEImageElement','SVGScriptElement','SVGAnimationElement'].forEach(function(n){
 var p=proto(n);if(p)stringProp(p,'href','href',true);});
var A=proto('SVGAElement');
if(A)stringProp(A,'target','target');
['SVGPolylineElement','SVGPolygonElement'].forEach(function(n){
 var p=proto(n);
 if(!p)return;
 getter(p,'points',function(){var el=this;
  return animated(el,'points',function(){return make(SVGPointList,{el:el});});});
 getter(p,'animatedPoints',function(){var el=this;
  return animated(el,'apoints',function(){return make(SVGPointList,{el:el,ro:true});});});});
var STOP=proto('SVGStopElement');
if(STOP)numberProp(STOP,'offset',0);
var GRAD=proto('SVGGradientElement');
if(GRAD){
 enumProp(GRAD,'gradientUnits',['userSpaceOnUse','objectBoundingBox'],2);
 enumProp(GRAD,'spreadMethod',['pad','reflect','repeat'],1);
 getter(GRAD,'gradientTransform',function(){var el=this;
  return animated(el,'gt',function(){
   return make(SVGAnimatedTransformList,{el:el,a:'gradientTransform'});});});}
['SVGClipPathElement'].forEach(function(n){var p=proto(n);
 if(p)enumProp(p,'clipPathUnits',['userSpaceOnUse','objectBoundingBox'],1);});
['SVGMaskElement'].forEach(function(n){var p=proto(n);
 if(p){enumProp(p,'maskUnits',['userSpaceOnUse','objectBoundingBox'],2);
  enumProp(p,'maskContentUnits',['userSpaceOnUse','objectBoundingBox'],1);}});
['SVGPatternElement'].forEach(function(n){var p=proto(n);
 if(p){enumProp(p,'patternUnits',['userSpaceOnUse','objectBoundingBox'],2);
  enumProp(p,'patternContentUnits',['userSpaceOnUse','objectBoundingBox'],1);}});
['SVGFilterElement'].forEach(function(n){var p=proto(n);
 if(p){enumProp(p,'filterUnits',['userSpaceOnUse','objectBoundingBox'],2);
  enumProp(p,'primitiveUnits',['userSpaceOnUse','objectBoundingBox'],1);}});
/* text */
if(TC){
 method(TC,'getNumberOfChars',function(){return textOf(this).length;});
 method(TC,'getComputedTextLength',function(){
  var t=textOf(this);return t?measure(this,t).w:0;});
 method(TC,'getSubStringLength',function(i,n){
  var t=String(this.textContent||'');
  i=i>>>0;n=n>>>0;
  if(i>t.length)throw new DOMException('The charnum provided is greater than or equal to the maximum bound.','IndexSizeError');
  return measure(this,t.substr(i,n)).w;});
 function charStart(el,i){
  var t=String(el.textContent||'');
  if(i>=t.length||i<0)throw new DOMException('The charnum provided is greater than or equal to the maximum bound.','IndexSizeError');
  var b=textBox(el)||[0,0,0,0];
  return [b[0]+measure(el,t.slice(0,i)).w,firstLength(el,'y','y')+firstLength(el,'dy','y')];}
 method(TC,'getStartPositionOfChar',function(i){var p=charStart(this,i>>>0);return newPoint(p[0],p[1]);});
 method(TC,'getEndPositionOfChar',function(i){var t=String(this.textContent||''),p=charStart(this,i>>>0);
  return newPoint(p[0]+measure(this,t.charAt(i>>>0)).w,p[1]);});
 method(TC,'getExtentOfChar',function(i){var t=String(this.textContent||''),p=charStart(this,i>>>0),
  b=textBox(this)||[0,0,0,0];
  return newRect(p[0],b[1],measure(this,t.charAt(i>>>0)).w,b[3]-b[1]);});
 method(TC,'getRotationOfChar',function(){return 0;});
 method(TC,'getCharNumAtPosition',function(pt){
  var t=String(this.textContent||''),b=textBox(this),x=pt?+pt.x:0,i;
  if(!b||x<b[0]||x>b[2])return -1;
  for(i=0;i<t.length;i++)if(b[0]+measure(this,t.slice(0,i+1)).w>=x)return i;
  return -1;});
 method(TC,'selectSubString',function(){});
 enumProp(TC,'lengthAdjust',['spacing','spacingAndGlyphs'],1);
 ['LENGTHADJUST_UNKNOWN','LENGTHADJUST_SPACING','LENGTHADJUST_SPACINGANDGLYPHS'].forEach(function(k,i){
  def(TC,k,{value:i,writable:false,configurable:false});});}
/* the svg element's own */
if(SV){
 method(SV,'createSVGPoint',function(){return newPoint(0,0);});
 method(SV,'createSVGMatrix',function(){return newMatrix(ID);});
 method(SV,'createSVGRect',function(){return newRect(0,0,0,0);});
 method(SV,'createSVGNumber',function(){return make(SVGNumber,{v:0});});
 method(SV,'createSVGLength',function(){return make(SVGLength,{el:null,v:{n:0,u:1}});});
 method(SV,'createSVGAngle',function(){return make(SVGAngle,{n:0,u:1});});
 method(SV,'createSVGTransform',function(){return newTransform({type:1,args:ID.slice()});});
 method(SV,'createSVGTransformFromMatrix',function(m){
  return newTransform({type:1,args:asMat(m)});});
 method(SV,'getElementById',function(id){
  id=String(id);
  var all=this.getElementsByTagName('*');
  for(var i=0;i<all.length;i++)if(all[i].id===id)return all[i];
  return null;});
 def(SV,'currentScale',{get:function(){var c=this[S];return c&&c.scale||1;},
  set:function(v){var c=this[S]||(this[S]=Object.create(null));c.scale=+v||1;}});
 getter(SV,'currentTranslate',function(){var el=this;
  return animated(el,'ct',function(){return newPoint(0,0);});});
 method(SV,'suspendRedraw',function(){return 1;});
 ['unsuspendRedraw','unsuspendRedrawAll','forceRedraw','pauseAnimations',
  'unpauseAnimations'].forEach(function(k){method(SV,k,function(){});});
 method(SV,'animationsPaused',function(){return false;});
 method(SV,'getCurrentTime',function(){return 0;});
 method(SV,'setCurrentTime',function(){});
 method(SV,'deselectAll',function(){
  var s=W.getSelection&&W.getSelection();if(s)s.removeAllRanges();});
 /* the graphics whose boxes, in this svg's coordinates, meet or lie in
    the rectangle */
 function inSvg(svg,el){
  var b=box(el,0);
  if(!b)return null;
  return boxThrough(mul(inv(localMatrix(svg))||ID,chainMatrix(svg,el)),b);}
 function meets(b,r){return b&&b[0]<=r.x+r.width&&b[2]>=r.x&&b[1]<=r.y+r.height&&b[3]>=r.y;}
 function within(b,r){return b&&b[0]>=r.x&&b[2]<=r.x+r.width&&b[1]>=r.y&&b[3]<=r.y+r.height;}
 method(SV,'checkIntersection',function(el,r){return meets(inSvg(this,el),r);});
 method(SV,'checkEnclosure',function(el,r){return within(inSvg(this,el),r);});
 function list(svg,r,ref,test){
  var out=[],all=(ref||svg).getElementsByTagName('*');
  for(var i=0;i<all.length;i++){
   var e=all[i];
   if(GEO&&GEO.isPrototypeOf(e)||/^(text|image|use|foreignObject)$/.test(e.localName))
    if(test(inSvg(svg,e),r))out.push(e);}
  return out;}
 method(SV,'getIntersectionList',function(r,ref){return list(this,r,ref,meets);});
 method(SV,'getEnclosureList',function(r,ref){return list(this,r,ref,within);});
 enumProp(SV,'zoomAndPan',['disable','magnify'],2);}
})();
