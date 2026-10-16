/*
 * Geometry Interfaces (VitaSurf), part of the prelude, before nodes.js:
 * DOMPointReadOnly, DOMPoint, DOMRectReadOnly, DOMRect, DOMRectList,
 * DOMQuad, DOMMatrixReadOnly and DOMMatrix, as the specification has
 * them, with WebKitCSSMatrix the same as DOMMatrix, as in Chrome.
 *
 * They were empty functions, so new DOMMatrix(getComputedStyle(el)
 * .transform), which animation and drag libraries use to read where an
 * element has been moved to, gave an object with nothing on it, and
 * getBoundingClientRect() answered with a plain object that was no
 * DOMRect. A value lives in a private field, so an instance has no own
 * properties and a getter called on another object throws, as a
 * browser's does.
 */
(function(){
'use strict';
var W=window;
function num(v){return +v;}
function def(v,d){return v===undefined?d:+v;}
function syntax(m){
 return W.DOMException?new W.DOMException(m,'SyntaxError'):new SyntaxError(m);}

/* --- points --------------------------------------------------------- */
var setPoint;
class DOMPointReadOnly{
 #x;#y;#z;#w;
 constructor(x,y,z,w){this.#x=def(x,0);this.#y=def(y,0);this.#z=def(z,0);
  this.#w=def(w,1);}
 static fromPoint(o){return pointFrom(DOMPointReadOnly,o);}
 get x(){return this.#x;}
 get y(){return this.#y;}
 get z(){return this.#z;}
 get w(){return this.#w;}
 matrixTransform(m){return matrixFromInit(m).transformPoint(this);}
 toJSON(){return {x:this.#x,y:this.#y,z:this.#z,w:this.#w};}
 static{setPoint=function(o,k,v){
  if(k==='x')o.#x=v;else if(k==='y')o.#y=v;else if(k==='z')o.#z=v;else o.#w=v;};}
}
class DOMPoint extends DOMPointReadOnly{
 static fromPoint(o){return pointFrom(DOMPoint,o);}
 get x(){return super.x;} set x(v){setPoint(this,'x',num(v));}
 get y(){return super.y;} set y(v){setPoint(this,'y',num(v));}
 get z(){return super.z;} set z(v){setPoint(this,'z',num(v));}
 get w(){return super.w;} set w(v){setPoint(this,'w',num(v));}
}
function pointFrom(C,o){
 o=o==null?{}:o;
 return new C(o.x,o.y,o.z,o.w);}

/* --- rectangles ----------------------------------------------------- */
var setRect;
class DOMRectReadOnly{
 #x;#y;#w;#h;
 constructor(x,y,width,height){this.#x=def(x,0);this.#y=def(y,0);
  this.#w=def(width,0);this.#h=def(height,0);}
 static fromRect(o){return rectFrom(DOMRectReadOnly,o);}
 get x(){return this.#x;}
 get y(){return this.#y;}
 get width(){return this.#w;}
 get height(){return this.#h;}
 get top(){return Math.min(this.#y,this.#y+this.#h);}
 get right(){return Math.max(this.#x,this.#x+this.#w);}
 get bottom(){return Math.max(this.#y,this.#y+this.#h);}
 get left(){return Math.min(this.#x,this.#x+this.#w);}
 toJSON(){return {x:this.x,y:this.y,width:this.width,height:this.height,
  top:this.top,right:this.right,bottom:this.bottom,left:this.left};}
 static{setRect=function(o,k,v){
  if(k==='x')o.#x=v;else if(k==='y')o.#y=v;else if(k==='w')o.#w=v;else o.#h=v;};}
}
class DOMRect extends DOMRectReadOnly{
 static fromRect(o){return rectFrom(DOMRect,o);}
 get x(){return super.x;} set x(v){setRect(this,'x',num(v));}
 get y(){return super.y;} set y(v){setRect(this,'y',num(v));}
 get width(){return super.width;} set width(v){setRect(this,'w',num(v));}
 get height(){return super.height;} set height(v){setRect(this,'h',num(v));}
}
function rectFrom(C,o){
 o=o==null?{}:o;
 return new C(o.x,o.y,o.width,o.height);}

/* a list of them, which getClientRects gives */
var LIST=new WeakMap();
function DOMRectList(){throw new TypeError('Illegal constructor');}
Object.defineProperties(DOMRectList.prototype,{
 length:{enumerable:true,configurable:true,get:function length(){
  var l=LIST.get(this);
  if(!l)throw new TypeError("Failed to read the 'length' property from 'DOMRectList': Illegal invocation");
  return l.length;}},
 item:{enumerable:true,configurable:true,writable:true,value:function item(i){
  var l=LIST.get(this);
  if(!l)throw new TypeError("Failed to execute 'item' on 'DOMRectList': Illegal invocation");
  if(arguments.length<1)throw new TypeError("Failed to execute 'item' on 'DOMRectList': 1 argument required, but only 0 present.");
  i=i>>>0;return i<l.length?l[i]:null;}}});
DOMRectList.prototype[Symbol.iterator]=Array.prototype.values;
function rectList(rects){
 var o=Object.create(DOMRectList.prototype),i;
 LIST.set(o,rects);
 for(i=0;i<rects.length;i++)
  Object.defineProperty(o,i,{value:rects[i],enumerable:true});
 return o;}

/* --- quads ---------------------------------------------------------- */
class DOMQuad{
 #p;
 constructor(p1,p2,p3,p4){
  this.#p=[p1,p2,p3,p4].map(function(p){return DOMPoint.fromPoint(p);});}
 static fromRect(r){
  r=r==null?{}:r;
  var x=def(r.x,0),y=def(r.y,0),w=def(r.width,0),h=def(r.height,0);
  return new DOMQuad({x:x,y:y},{x:x+w,y:y},{x:x+w,y:y+h},{x:x,y:y+h});}
 static fromQuad(q){
  q=q==null?{}:q;
  return new DOMQuad(q.p1,q.p2,q.p3,q.p4);}
 get p1(){return this.#p[0];}
 get p2(){return this.#p[1];}
 get p3(){return this.#p[2];}
 get p4(){return this.#p[3];}
 getBounds(){
  var xs=this.#p.map(function(p){return p.x;}),
   ys=this.#p.map(function(p){return p.y;}),
   l=Math.min.apply(null,xs),t=Math.min.apply(null,ys);
  return new DOMRect(l,t,Math.max.apply(null,xs)-l,Math.max.apply(null,ys)-t);}
 toJSON(){return {p1:this.p1,p2:this.p2,p3:this.p3,p4:this.p4};}
}

/* --- matrices ------------------------------------------------------- */
/*
 * Sixteen values in the specification's order, m11 m12 m13 m14 m21 ...
 * m44, which is column-major: a point (x, y, z, w) goes to
 * (m11 x + m21 y + m31 z + m41 w, m12 x + ..., ...).
 */
var NAMES=['m11','m12','m13','m14','m21','m22','m23','m24',
 'm31','m32','m33','m34','m41','m42','m43','m44'];
var TWO_D={a:0,b:1,c:4,d:5,e:12,f:13};
function identity(){return [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];}
function mul(a,b){
 var r=new Array(16),c,row,k,s;
 for(c=0;c<4;c++)for(row=0;row<4;row++){
  s=0;for(k=0;k<4;k++)s+=a[k*4+row]*b[c*4+k];
  r[c*4+row]=s;}
 return r;}
function rad(deg){return deg*Math.PI/180;}
function translation(x,y,z){var m=identity();m[12]=x;m[13]=y;m[14]=z;return m;}
function scaling(x,y,z){var m=identity();m[0]=x;m[5]=y;m[10]=z;return m;}
/*
 * Sine and cosine of an angle in degrees, exact at the multiples of 90,
 * as Chrome takes them: rotate(90deg) is matrix(0, 1, -1, 0, 0, 0), not
 * one with 6e-17 where the zeros are.
 */
function sinCos(deg){
 var q=deg/90;
 if(q===Math.floor(q)&&isFinite(q))return [[0,1],[1,0],[0,-1],[-1,0]][((q%4)+4)%4];
 return [Math.sin(rad(deg)),Math.cos(rad(deg))];}
/* the rotation about the axis (x, y, z), by Rodrigues' formula */
function rotation(x,y,z,deg){
 var len=Math.sqrt(x*x+y*y+z*z),m=identity(),sc,s,c,C;
 if(len===0)return m;
 x/=len;y/=len;z/=len;
 sc=sinCos(deg);s=sc[0];c=sc[1];C=1-c;
 m[0]=x*x*C+c;m[1]=y*x*C+z*s;m[2]=z*x*C-y*s;
 m[4]=x*y*C-z*s;m[5]=y*y*C+c;m[6]=z*y*C+x*s;
 m[8]=x*z*C+y*s;m[9]=y*z*C-x*s;m[10]=z*z*C+c;
 return m;}
function skewing(ax,ay){var m=identity();m[4]=Math.tan(rad(ax));m[1]=Math.tan(rad(ay));return m;}
function invert(m){
 var inv=new Array(16),det,i;
 inv[0]=m[5]*m[10]*m[15]-m[5]*m[11]*m[14]-m[9]*m[6]*m[15]+m[9]*m[7]*m[14]+m[13]*m[6]*m[11]-m[13]*m[7]*m[10];
 inv[4]=-m[4]*m[10]*m[15]+m[4]*m[11]*m[14]+m[8]*m[6]*m[15]-m[8]*m[7]*m[14]-m[12]*m[6]*m[11]+m[12]*m[7]*m[10];
 inv[8]=m[4]*m[9]*m[15]-m[4]*m[11]*m[13]-m[8]*m[5]*m[15]+m[8]*m[7]*m[13]+m[12]*m[5]*m[11]-m[12]*m[7]*m[9];
 inv[12]=-m[4]*m[9]*m[14]+m[4]*m[10]*m[13]+m[8]*m[5]*m[14]-m[8]*m[6]*m[13]-m[12]*m[5]*m[10]+m[12]*m[6]*m[9];
 inv[1]=-m[1]*m[10]*m[15]+m[1]*m[11]*m[14]+m[9]*m[2]*m[15]-m[9]*m[3]*m[14]-m[13]*m[2]*m[11]+m[13]*m[3]*m[10];
 inv[5]=m[0]*m[10]*m[15]-m[0]*m[11]*m[14]-m[8]*m[2]*m[15]+m[8]*m[3]*m[14]+m[12]*m[2]*m[11]-m[12]*m[3]*m[10];
 inv[9]=-m[0]*m[9]*m[15]+m[0]*m[11]*m[13]+m[8]*m[1]*m[15]-m[8]*m[3]*m[13]-m[12]*m[1]*m[11]+m[12]*m[3]*m[9];
 inv[13]=m[0]*m[9]*m[14]-m[0]*m[10]*m[13]-m[8]*m[1]*m[14]+m[8]*m[2]*m[13]+m[12]*m[1]*m[10]-m[12]*m[2]*m[9];
 inv[2]=m[1]*m[6]*m[15]-m[1]*m[7]*m[14]-m[5]*m[2]*m[15]+m[5]*m[3]*m[14]+m[13]*m[2]*m[7]-m[13]*m[3]*m[6];
 inv[6]=-m[0]*m[6]*m[15]+m[0]*m[7]*m[14]+m[4]*m[2]*m[15]-m[4]*m[3]*m[14]-m[12]*m[2]*m[7]+m[12]*m[3]*m[6];
 inv[10]=m[0]*m[5]*m[15]-m[0]*m[7]*m[13]-m[4]*m[1]*m[15]+m[4]*m[3]*m[13]+m[12]*m[1]*m[7]-m[12]*m[3]*m[5];
 inv[14]=-m[0]*m[5]*m[14]+m[0]*m[6]*m[13]+m[4]*m[1]*m[14]-m[4]*m[2]*m[13]-m[12]*m[1]*m[6]+m[12]*m[2]*m[5];
 inv[3]=-m[1]*m[6]*m[11]+m[1]*m[7]*m[10]+m[5]*m[2]*m[11]-m[5]*m[3]*m[10]-m[9]*m[2]*m[7]+m[9]*m[3]*m[6];
 inv[7]=m[0]*m[6]*m[11]-m[0]*m[7]*m[10]-m[4]*m[2]*m[11]+m[4]*m[3]*m[10]+m[8]*m[2]*m[7]-m[8]*m[3]*m[6];
 inv[11]=-m[0]*m[5]*m[11]+m[0]*m[7]*m[9]+m[4]*m[1]*m[11]-m[4]*m[3]*m[9]-m[8]*m[1]*m[7]+m[8]*m[3]*m[5];
 inv[15]=m[0]*m[5]*m[10]-m[0]*m[6]*m[9]-m[4]*m[1]*m[10]+m[4]*m[2]*m[9]+m[8]*m[1]*m[6]-m[8]*m[2]*m[5];
 det=m[0]*inv[0]+m[1]*inv[4]+m[2]*inv[8]+m[3]*inv[12];
 if(det===0||!isFinite(det))return null;
 for(i=0;i<16;i++)inv[i]/=det;
 return inv;}

/*
 * A CSS transform list, as the constructor and setMatrixValue take it:
 * "none", or functions applied left to right. Lengths are px (or a bare
 * 0) and angles deg, rad, grad or turn, as a browser takes them here;
 * anything else is a SyntaxError.
 */
function parseTransform(text,what){
 var s=String(text).trim(),m=identity(),is2D=true,re=/\s*([a-zA-Z0-9]+)\(([^)]*)\)\s*/y,
  f,args,name,fail=function(){
   return syntax("Failed to "+what+": Failed to parse '"+text+"'.");};
 if(s===''||s==='none')return {m:m,is2D:true};
 re.lastIndex=0;
 while(re.lastIndex<s.length){
  f=re.exec(s);
  if(!f)throw fail();
  name=f[1].toLowerCase();
  args=f[2].trim()===''?[]:f[2].split(',').map(function(a){return a.trim();});
  function len(i){
   var a=args[i],v;
   if(a===undefined)throw fail();
   v=/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(px)?$/i.exec(a);
   if(!v||(!v[2]&&+v[1]!==0))throw fail();
   return +v[1];}
  function n(i){
   var a=args[i];
   if(a===undefined||!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(a))throw fail();
   return +a;}
  function ang(i){
   var a=args[i],v;
   if(a===undefined)throw fail();
   v=/^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)(deg|rad|grad|turn)?$/i.exec(a);
   if(!v||(!v[2]&&+v[1]!==0))throw fail();
   var u=(v[2]||'deg').toLowerCase(),x=+v[1];
   return u==='rad'?x*180/Math.PI:u==='grad'?x*0.9:u==='turn'?x*360:x;}
  function count(a,b){if(args.length<a||args.length>(b===undefined?a:b))throw fail();}
  var t;
  switch(name){
  case 'matrix':count(6);
   t=identity();t[0]=n(0);t[1]=n(1);t[4]=n(2);t[5]=n(3);t[12]=n(4);t[13]=n(5);break;
  case 'matrix3d':count(16);t=args.map(function(a,i){return n(i);});is2D=false;break;
  case 'translate':count(1,2);t=translation(len(0),args.length>1?len(1):0,0);break;
  case 'translatex':count(1);t=translation(len(0),0,0);break;
  case 'translatey':count(1);t=translation(0,len(0),0);break;
  case 'translatez':count(1);t=translation(0,0,len(0));is2D=false;break;
  case 'translate3d':count(3);t=translation(len(0),len(1),len(2));is2D=false;break;
  case 'scale':count(1,2);t=scaling(n(0),args.length>1?n(1):n(0),1);break;
  case 'scalex':count(1);t=scaling(n(0),1,1);break;
  case 'scaley':count(1);t=scaling(1,n(0),1);break;
  case 'scalez':count(1);t=scaling(1,1,n(0));is2D=false;break;
  case 'scale3d':count(3);t=scaling(n(0),n(1),n(2));is2D=false;break;
  case 'rotate':case 'rotatez':count(1);t=rotation(0,0,1,ang(0));
   if(name==='rotatez')is2D=false;break;
  case 'rotatex':count(1);t=rotation(1,0,0,ang(0));is2D=false;break;
  case 'rotatey':count(1);t=rotation(0,1,0,ang(0));is2D=false;break;
  case 'rotate3d':count(4);t=rotation(n(0),n(1),n(2),ang(3));is2D=false;break;
  case 'skew':count(1,2);t=skewing(ang(0),args.length>1?ang(1):0);break;
  case 'skewx':count(1);t=skewing(ang(0),0);break;
  case 'skewy':count(1);t=skewing(0,ang(0));break;
  case 'perspective':count(1);t=identity();
   if(len(0)!==0)t[11]=-1/len(0);is2D=false;break;
  default:throw fail();}
  m=mul(m,t);}
 return {m:m,is2D:is2D};}

var getM,setM;
class DOMMatrixReadOnly{
 #m;#is2D;
 constructor(init){
  var p;
  if(init===undefined){this.#m=identity();this.#is2D=true;return;}
  if(typeof init==='string'){
   p=parseTransform(init,"construct '"+new.target.name+"'");
   this.#m=p.m;this.#is2D=p.is2D;return;}
  if(init!==null&&typeof init==='object'&&typeof init[Symbol.iterator]==='function'){
   var a=Array.from(init,Number);
   if(a.length===6){this.#m=identity();
    this.#m[0]=a[0];this.#m[1]=a[1];this.#m[4]=a[2];this.#m[5]=a[3];
    this.#m[12]=a[4];this.#m[13]=a[5];this.#is2D=true;return;}
   if(a.length===16){this.#m=a;this.#is2D=false;return;}
   throw new TypeError("Failed to construct '"+new.target.name+"': The sequence must contain 6 elements for a 2D matrix or 16 elements for a 3D matrix.");}
  throw new TypeError("Failed to construct '"+new.target.name+"': The provided value cannot be converted to a sequence.");}
 static fromMatrix(o){return fromInit(DOMMatrixReadOnly,o);}
 static fromFloat32Array(a){return fromArray(DOMMatrixReadOnly,a,Float32Array);}
 static fromFloat64Array(a){return fromArray(DOMMatrixReadOnly,a,Float64Array);}
 get a(){return this.#m[0];} get b(){return this.#m[1];}
 get c(){return this.#m[4];} get d(){return this.#m[5];}
 get e(){return this.#m[12];} get f(){return this.#m[13];}
 get m11(){return this.#m[0];} get m12(){return this.#m[1];}
 get m13(){return this.#m[2];} get m14(){return this.#m[3];}
 get m21(){return this.#m[4];} get m22(){return this.#m[5];}
 get m23(){return this.#m[6];} get m24(){return this.#m[7];}
 get m31(){return this.#m[8];} get m32(){return this.#m[9];}
 get m33(){return this.#m[10];} get m34(){return this.#m[11];}
 get m41(){return this.#m[12];} get m42(){return this.#m[13];}
 get m43(){return this.#m[14];} get m44(){return this.#m[15];}
 get is2D(){return this.#is2D;}
 get isIdentity(){
  var m=this.#m,id=identity(),i;
  for(i=0;i<16;i++)if(m[i]!==id[i])return false;
  return true;}
 translate(x,y,z){return copy(this).translateSelf(x,y,z);}
 scale(sx,sy,sz,ox,oy,oz){return copy(this).scaleSelf(sx,sy,sz,ox,oy,oz);}
 scaleNonUniform(sx,sy){return copy(this).scaleSelf(def(sx,1),def(sy,1),1,0,0,0);}
 scale3d(s,ox,oy,oz){return copy(this).scale3dSelf(s,ox,oy,oz);}
 rotate(x,y,z){return copy(this).rotateSelf(x,y,z);}
 rotateFromVector(x,y){return copy(this).rotateFromVectorSelf(x,y);}
 rotateAxisAngle(x,y,z,a){return copy(this).rotateAxisAngleSelf(x,y,z,a);}
 skewX(a){return copy(this).skewXSelf(a);}
 skewY(a){return copy(this).skewYSelf(a);}
 multiply(o){return copy(this).multiplySelf(o);}
 flipX(){return copy(this).multiplySelf(new DOMMatrix([-1,0,0,1,0,0]));}
 flipY(){return copy(this).multiplySelf(new DOMMatrix([1,0,0,-1,0,0]));}
 inverse(){return copy(this).invertSelf();}
 transformPoint(p){
  p=p==null?{}:p;
  var m=this.#m,x=def(p.x,0),y=def(p.y,0),z=def(p.z,0),w=def(p.w,1);
  return new DOMPoint(m[0]*x+m[4]*y+m[8]*z+m[12]*w,m[1]*x+m[5]*y+m[9]*z+m[13]*w,
   m[2]*x+m[6]*y+m[10]*z+m[14]*w,m[3]*x+m[7]*y+m[11]*z+m[15]*w);}
 toFloat32Array(){return new Float32Array(this.#m);}
 toFloat64Array(){return new Float64Array(this.#m);}
 toJSON(){
  var o={},self=this;
  ['a','b','c','d','e','f'].concat(NAMES).forEach(function(k){o[k]=self[k];});
  o.is2D=this.#is2D;o.isIdentity=this.isIdentity;
  return o;}
 toString(){
  var m=this.#m;
  if(!m.every(isFinite))throw W.DOMException
   ?new W.DOMException('Cannot be serialized with NaN or Infinity values.','InvalidStateError')
   :new Error('InvalidStateError');
  return this.#is2D?'matrix('+[m[0],m[1],m[4],m[5],m[12],m[13]].join(', ')+')'
                   :'matrix3d('+m.join(', ')+')';}
 static{
  getM=function(o){return [o.#m,o.#is2D];};
  setM=function(o,m,is2D){o.#m=m;if(is2D!==undefined)o.#is2D=is2D;};}
}
function copy(o){var s=getM(o),r=new DOMMatrix();setM(r,s[0].slice(),s[1]);return r;}
function fromArray(C,a,T){
 if(!(a instanceof T))throw new TypeError("Failed to execute 'from"+T.name+"' on '"+C.name+"': parameter 1 is not of type '"+T.name+"'.");
 return new C(Array.from(a));}
/* a DOMMatrixInit, checked as the specification fills it in */
function fromInit(C,o){
 var r=new C(),m=identity(),is2D,k;
 o=o==null?{}:o;
 if(o instanceof DOMMatrixReadOnly){var s=getM(o);setM(r,s[0].slice(),s[1]);return r;}
 Object.keys(TWO_D).forEach(function(k2){
  var i=TWO_D[k2],a=o[k2],b=o[NAMES[i]];
  if(a!==undefined&&b!==undefined&&!Object.is(+a,+b))
   throw new TypeError("Failed to execute 'fromMatrix' on '"+C.name+"': Property mismatch on matrix initialization.");
  if(b!==undefined)m[i]=+b;else if(a!==undefined)m[i]=+a;});
 NAMES.forEach(function(n,i){
  if(i===0||i===1||i===4||i===5||i===12||i===13)return;
  if(o[n]!==undefined)m[i]=+o[n];});
 is2D=o.is2D;
 var three=[2,3,6,7,8,9,11,14].some(function(i){return m[i]!==0;})||m[10]!==1||m[15]!==1;
 if(is2D===true&&three)
  throw new TypeError("Failed to execute 'fromMatrix' on '"+C.name+"': The is2D member is set to true but the input matrix is a 3d matrix.");
 if(is2D===undefined)is2D=!three;
 setM(r,m,!!is2D);
 return r;}
function matrixFromInit(o){
 return o instanceof DOMMatrixReadOnly?o:fromInit(DOMMatrix,o);}

class DOMMatrix extends DOMMatrixReadOnly{
 static fromMatrix(o){return fromInit(DOMMatrix,o);}
 static fromFloat32Array(a){return fromArray(DOMMatrix,a,Float32Array);}
 static fromFloat64Array(a){return fromArray(DOMMatrix,a,Float64Array);}
 multiplySelf(o){
  var s=getM(this),t=getM(matrixFromInit(o));
  setM(this,mul(s[0],t[0]),s[1]&&t[1]);return this;}
 preMultiplySelf(o){
  var s=getM(this),t=getM(matrixFromInit(o));
  setM(this,mul(t[0],s[0]),s[1]&&t[1]);return this;}
 translateSelf(x,y,z){
  var s=getM(this);z=def(z,0);
  setM(this,mul(s[0],translation(def(x,0),def(y,0),z)),s[1]&&z===0);return this;}
 scaleSelf(sx,sy,sz,ox,oy,oz){
  var s=getM(this),m;
  sx=def(sx,1);sy=sy===undefined?sx:+sy;sz=def(sz,1);
  ox=def(ox,0);oy=def(oy,0);oz=def(oz,0);
  m=mul(s[0],translation(ox,oy,oz));m=mul(m,scaling(sx,sy,sz));
  m=mul(m,translation(-ox,-oy,-oz));
  setM(this,m,s[1]&&sz===1&&oz===0);return this;}
 scale3dSelf(sc,ox,oy,oz){sc=def(sc,1);return this.scaleSelf(sc,sc,sc,ox,oy,oz);}
 rotateSelf(rx,ry,rz){
  var s=getM(this),m;
  if(ry===undefined&&rz===undefined){rz=def(rx,0);rx=0;ry=0;}
  rx=def(rx,0);ry=def(ry,0);rz=def(rz,0);
  m=mul(s[0],rotation(0,0,1,rz));m=mul(m,rotation(0,1,0,ry));
  m=mul(m,rotation(1,0,0,rx));
  setM(this,m,s[1]&&rx===0&&ry===0);return this;}
 rotateFromVectorSelf(x,y){
  x=def(x,0);y=def(y,0);
  var s=getM(this),a=x===0&&y===0?0:Math.atan2(y,x)*180/Math.PI;
  setM(this,mul(s[0],rotation(0,0,1,a)),s[1]);return this;}
 rotateAxisAngleSelf(x,y,z,a){
  x=def(x,0);y=def(y,0);z=def(z,0);
  var s=getM(this);
  setM(this,mul(s[0],rotation(x,y,z,def(a,0))),s[1]&&x===0&&y===0);return this;}
 skewXSelf(a){var s=getM(this);setM(this,mul(s[0],skewing(def(a,0),0)),s[1]);return this;}
 skewYSelf(a){var s=getM(this);setM(this,mul(s[0],skewing(0,def(a,0))),s[1]);return this;}
 invertSelf(){
  var s=getM(this),inv=invert(s[0]);
  if(!inv){setM(this,NAMES.map(function(){return NaN;}),false);return this;}
  setM(this,inv,s[1]);return this;}
 setMatrixValue(text){
  var p=parseTransform(text,"execute 'setMatrixValue' on 'DOMMatrix'");
  setM(this,p.m,p.is2D);return this;}
}
/* a DOMMatrix's attributes write; one outside the 2D ones makes it 3D */
['a','b','c','d','e','f'].concat(NAMES).forEach(function(k){
 var i=k.length===1?TWO_D[k]:NAMES.indexOf(k),
  get=Object.getOwnPropertyDescriptor(DOMMatrixReadOnly.prototype,k).get;
 Object.defineProperty(DOMMatrix.prototype,k,{enumerable:true,configurable:true,
  get:get,
  set:function(v){
   var s=getM(this),dflt=(i===10||i===15)?1:0;v=+v;
   s[0][i]=v;
   if(s[1]&&[2,3,6,7,8,9,10,11,14,15].indexOf(i)>=0&&v!==dflt)setM(this,s[0],false);}});
 Object.defineProperty(Object.getOwnPropertyDescriptor(DOMMatrix.prototype,k).set,
  'name',{value:'set '+k});});

/* WebIDL's members are enumerable; a class's are not */
[DOMPointReadOnly,DOMPoint,DOMRectReadOnly,DOMRect,DOMQuad,DOMMatrixReadOnly,
 DOMMatrix].forEach(function(C){
 Reflect.ownKeys(C.prototype).forEach(function(k){
  if(k==='constructor')return;
  var d=Object.getOwnPropertyDescriptor(C.prototype,k);
  d.enumerable=true;Object.defineProperty(C.prototype,k,d);});
 Reflect.ownKeys(C).forEach(function(k){
  var d=Object.getOwnPropertyDescriptor(C,k);
  if(typeof d.value!=='function')return;
  d.enumerable=true;Object.defineProperty(C,k,d);});});

W.DOMPointReadOnly=DOMPointReadOnly;W.DOMPoint=DOMPoint;
W.DOMRectReadOnly=DOMRectReadOnly;W.DOMRect=DOMRect;W.DOMRectList=DOMRectList;
W.DOMQuad=DOMQuad;W.DOMMatrixReadOnly=DOMMatrixReadOnly;W.DOMMatrix=DOMMatrix;

/*
 * An element's and a range's boxes as DOMRects, and its fragments as a
 * DOMRectList, where they were plain objects and arrays (VitaSurf).
 */
function asRect(r){
 return r instanceof DOMRectReadOnly?r:new DOMRect(r.x!==undefined?r.x:r.left,
  r.y!==undefined?r.y:r.top,r.width,r.height);}
function wrapBoxes(proto){
 if(!proto)return;
 var g=proto.getBoundingClientRect,l=proto.getClientRects;
 if(typeof g==='function')
  Object.defineProperty(proto,'getBoundingClientRect',{configurable:true,writable:true,
   value:function getBoundingClientRect(){return asRect(g.call(this));}});
 if(typeof l==='function')
  Object.defineProperty(proto,'getClientRects',{configurable:true,writable:true,
   value:function getClientRects(){
    var a=l.call(this),out=[],i;
    for(i=0;a&&i<a.length;i++)out.push(asRect(a[i]));
    return rectList(out);}});}
wrapBoxes(W.HTMLElement&&W.HTMLElement.prototype);
wrapBoxes(W.Range&&W.Range.prototype);
})();
