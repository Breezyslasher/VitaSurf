/* --- Web Cryptography (VitaSurf) -----------------------------------------
 * crypto.subtle, crypto.getRandomValues and crypto.randomUUID, on the
 * primitives vita/js/subtle.c builds from mbedTLS.
 *
 * crypto.subtle was an empty object, so a page that hashed a password,
 * checked a signature or derived a key had nothing to call, and
 * getRandomValues handed out Math.random(), which is no source for a key
 * or a nonce. This follows the Web Cryptography specification: the same
 * algorithms, key formats, usages and errors a browser has, for digest,
 * HMAC, AES (GCM, CBC, CTR, KW), PBKDF2, HKDF, ECDSA and ECDH on the
 * NIST curves, and RSA (PKCS#1 v1.5, PSS, OAEP). Ed25519 and X25519 are
 * not in mbedTLS and are refused as NotSupportedError.
 *
 * The work is done synchronously and the promise settled with it; an
 * RSA key takes seconds to generate on the Vita, and holds the page for
 * that long.
 */
(function(){
var W=window,N=W.__vitaSubtle;
if(!N){delete W.__vitaRegisterKeyClone;return;}

function err(msg,name){return new DOMException(msg,name);}
function notSupported(what){return err(what+' is not supported','NotSupportedError');}

/* ---- bytes ---- */
function bytesOf(v,what){
 if(v instanceof ArrayBuffer)return v.slice(0);
 if(ArrayBuffer.isView(v))return v.buffer.slice(v.byteOffset,v.byteOffset+v.byteLength);
 throw new TypeError(what+' is not an ArrayBuffer or ArrayBufferView');}
function u8(ab){return new Uint8Array(ab);}
function b64uEncode(ab){
 var b=u8(ab),s='',i;
 for(i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);
 return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function b64uDecode(s,what){
 if(typeof s!=='string'||!/^[A-Za-z0-9_-]*$/.test(s))
  throw err('The JWK member "'+what+'" is not base64url','DataError');
 var t=s.replace(/-/g,'+').replace(/_/g,'/'),bin,out,i;
 while(t.length%4)t+='=';
 try{bin=atob(t);}catch(e){throw err('The JWK member "'+what+'" is not base64url','DataError');}
 out=new Uint8Array(bin.length);
 for(i=0;i<bin.length;i++)out[i]=bin.charCodeAt(i);
 return out.buffer;}
function concat(a,b){var o=new Uint8Array(a.byteLength+b.byteLength);
 o.set(u8(a),0);o.set(u8(b),a.byteLength);return o.buffer;}
function sameBytes(a,b){
 var x=u8(a),y=u8(b),d=0,i;
 if(x.length!==y.length)return false;
 for(i=0;i<x.length;i++)d|=x[i]^y[i];
 return d===0;}
function padLeft(ab,n){var b=u8(ab);if(b.length>=n)return ab;
 var o=new Uint8Array(n);o.set(b,n-b.length);return o.buffer;}

/* ---- randomness ---- */
var INT_ARRAYS=['Int8Array','Uint8Array','Uint8ClampedArray','Int16Array',
 'Uint16Array','Int32Array','Uint32Array','BigInt64Array','BigUint64Array'];
function random(n){var r=N.random(n);
 if(!r)throw err('No randomness is available','OperationError');return r;}
function getRandomValues(a){
 if(!ArrayBuffer.isView(a)||a instanceof DataView||
    !INT_ARRAYS.some(function(c){return W[c]&&a instanceof W[c];}))
  throw err("Failed to execute 'getRandomValues' on 'Crypto': The provided "+
   "ArrayBufferView is of type '"+(a&&a.constructor&&a.constructor.name)+
   "', which is not an integer array type.",'TypeMismatchError');
 if(a.byteLength>65536)
  throw new (W.QuotaExceededError||DOMException)("Failed to execute "+
   "'getRandomValues' on 'Crypto': The ArrayBufferView's byte length ("+
   a.byteLength+") exceeds the number of bytes of entropy available via "+
   "this API (65536).",W.QuotaExceededError?undefined:'QuotaExceededError');
 new Uint8Array(a.buffer,a.byteOffset,a.byteLength).set(u8(random(a.byteLength)));
 return a;}
function randomUUID(){
 var b=u8(random(16)),h=[],i;
 b[6]=(b[6]&0x0f)|0x40;b[8]=(b[8]&0x3f)|0x80;
 for(i=0;i<16;i++)h.push((b[i]+0x100).toString(16).slice(1));
 return h.slice(0,4).join('')+'-'+h.slice(4,6).join('')+'-'+h.slice(6,8).join('')+
  '-'+h.slice(8,10).join('')+'-'+h.slice(10).join('');}

/* ---- algorithm names ---- */
var NAMES=['SHA-1','SHA-256','SHA-384','SHA-512','HMAC','AES-GCM','AES-CBC',
 'AES-CTR','AES-KW','PBKDF2','HKDF','ECDSA','ECDH','RSASSA-PKCS1-v1_5',
 'RSA-PSS','RSA-OAEP','Ed25519','X25519'];
var UNSUPPORTED={'Ed25519':1,'X25519':1};
function canonical(name){
 var l=String(name).toUpperCase(),i;
 for(i=0;i<NAMES.length;i++)if(NAMES[i].toUpperCase()===l)return NAMES[i];
 return null;}
/* A number the IDL marks [EnforceRange]: out of range is a TypeError,
   not a value wrapped round into range. */
var OCTET=255,USHORT=65535,ULONG=4294967295;
function enforce(v,max,what){
 var n=Number(v);
 if(!isFinite(n))throw new TypeError(what+' is not a finite number');
 n=n<0?Math.ceil(n):Math.floor(n);
 if(n<0||n>max)throw new TypeError(what+' is outside the range [0, '+max+']');
 return n;}
/* The operations whose dictionary for an algorithm carries a hash. It is
   normalised with the algorithm, before anything about the key is looked
   at; where the dictionary has no hash, one given is ignored, as a
   member the IDL does not know is. */
var RSA_HASH=['generateKey','importKey'];
var HASHED={'HMAC':['generateKey','importKey','get key length'],
 'RSASSA-PKCS1-v1_5':RSA_HASH,'RSA-PSS':RSA_HASH,'RSA-OAEP':RSA_HASH,
 'ECDSA':['sign','verify'],'PBKDF2':['deriveBits'],'HKDF':['deriveBits']};
/* The algorithm dictionary, as an object with a canonical name. */
function normalize(alg,ops,op){
 var o,name;
 if(typeof alg==='string')o={name:alg};
 else if(alg&&typeof alg==='object'){
  if(!('name' in alg))throw new TypeError("Algorithm: name: Missing or not a string");
  o={};for(var k in alg)o[k]=alg[k];}
 else throw new TypeError('Algorithm: Not an object');
 name=canonical(o.name);
 if(!name||UNSUPPORTED[name]||ops.indexOf(name)<0)throw notSupported('Algorithm');
 o.name=name;
 if(HASHED[name]&&HASHED[name].indexOf(op)>=0&&o.hash!==undefined)
  o.hash=hashName(o.hash);
 return o;}
function hashName(h){
 if(h===undefined)throw new TypeError("Algorithm: hash: Missing");
 var n=canonical(typeof h==='string'?h:h&&h.name);
 if(!n||!/^SHA-/.test(n))throw notSupported('Hash');
 return n;}
var HASH_BLOCK_BITS={'SHA-1':512,'SHA-256':512,'SHA-384':1024,'SHA-512':1024};

/* ---- keys ---- */
var SLOTS=new WeakMap();
function CryptoKey(){throw new TypeError('Illegal constructor');}
function slot(k){var s=SLOTS.get(k);
 if(!s)throw new TypeError('Not a CryptoKey');return s;}
Object.defineProperties(CryptoKey.prototype,{
 type:{configurable:true,enumerable:true,get:function(){return slot(this).type;}},
 extractable:{configurable:true,enumerable:true,get:function(){return slot(this).extractable;}},
 algorithm:{configurable:true,enumerable:true,get:function(){return slot(this).algorithm;}},
 usages:{configurable:true,enumerable:true,get:function(){return slot(this).usages;}}});
Object.defineProperty(CryptoKey.prototype,Symbol.toStringTag,{configurable:true,value:'CryptoKey'});
var USAGE_ORDER=['encrypt','decrypt','sign','verify','deriveKey','deriveBits','wrapKey','unwrapKey'];
function orderUsages(list){
 return USAGE_ORDER.filter(function(u){return list.indexOf(u)>=0;});}
function makeKey(type,extractable,algorithm,usages,material){
 var k=Object.create(CryptoKey.prototype);
 SLOTS.set(k,{type:type,extractable:!!extractable,algorithm:algorithm,
  usages:orderUsages(usages),m:material});
 return k;}
function checkUsages(usages,allowed){
 if(!usages||typeof usages[Symbol.iterator]!=='function')
  throw new TypeError('keyUsages is not a sequence');
 var list=Array.prototype.slice.call(usages).map(String);
 list.forEach(function(u){
  if(USAGE_ORDER.indexOf(u)<0)throw new TypeError("'"+u+"' is not a valid KeyUsage");
  if(allowed.indexOf(u)<0)throw err('Cannot create a key using the specified key usages.','SyntaxError');});
 return list;}
function needUsages(list,type){
 if((type==='secret'||type==='private')&&list.length===0)
  throw err('Usages cannot be empty when creating a key.','SyntaxError');}
function useKey(key,name,usage){
 var s=slot(key);
 if(s.algorithm.name!==name)
  throw err('The requested operation is not valid for the provided key','InvalidAccessError');
 if(s.usages.indexOf(usage)<0)
  throw err('key.usages does not permit this operation','InvalidAccessError');
 return s;}

var USAGES={
 'HMAC':['sign','verify'],'AES-GCM':['encrypt','decrypt','wrapKey','unwrapKey'],
 'AES-CBC':['encrypt','decrypt','wrapKey','unwrapKey'],
 'AES-CTR':['encrypt','decrypt','wrapKey','unwrapKey'],'AES-KW':['wrapKey','unwrapKey'],
 'PBKDF2':['deriveKey','deriveBits'],'HKDF':['deriveKey','deriveBits'],
 'ECDSA':['sign','verify'],'ECDH':['deriveKey','deriveBits'],
 'RSASSA-PKCS1-v1_5':['sign','verify'],'RSA-PSS':['sign','verify'],
 'RSA-OAEP':['encrypt','decrypt','wrapKey','unwrapKey']};
var PUBLIC_USAGES={'ECDSA':['verify'],'ECDH':[],'RSASSA-PKCS1-v1_5':['verify'],
 'RSA-PSS':['verify'],'RSA-OAEP':['encrypt','wrapKey']};
var PRIVATE_USAGES={'ECDSA':['sign'],'ECDH':['deriveKey','deriveBits'],
 'RSASSA-PKCS1-v1_5':['sign'],'RSA-PSS':['sign'],'RSA-OAEP':['decrypt','unwrapKey']};
function split(list,allowed){return list.filter(function(u){return allowed.indexOf(u)>=0;});}

var AES={'AES-GCM':'GCM','AES-CBC':'CBC','AES-CTR':'CTR','AES-KW':'KW'};
var RSA={'RSASSA-PKCS1-v1_5':'RS','RSA-PSS':'PS','RSA-OAEP':'RSA-OAEP'};
var CURVE_BYTES={'P-256':32,'P-384':48,'P-521':66};
function curveOf(a){
 if(a.namedCurve===undefined)throw new TypeError('Algorithm: namedCurve: Missing');
 var c=String(a.namedCurve);
 if(!CURVE_BYTES[c])throw notSupported('Named curve '+c);
 return c;}
function hashAlgo(n){return {name:n};}
function jwkHashSuffix(h){return h==='SHA-1'?'1':h.slice(4);}
function rsaJwkAlg(name,hash){
 if(name==='RSA-OAEP')return hash==='SHA-1'?'RSA-OAEP':'RSA-OAEP-'+hash.slice(4);
 return RSA[name]+jwkHashSuffix(hash);}
function exponentInt(e){var b=u8(e),v=0,i;
 for(i=0;i<b.length;i++)v=v*256+b[i];return v;}
function rsaAlgorithm(name,hash,spki){
 var info=N.rsaImport('spki',spki);
 if(!info)throw err('The key is not a valid RSA key','DataError');
 return {name:name,modulusLength:info[2],
  publicExponent:new Uint8Array(info[3]),hash:hashAlgo(hash)};}

/* ---- generateKey ---- */
function generateKey(alg,extractable,usages){
 var a=normalize(alg,['HMAC','AES-GCM','AES-CBC','AES-CTR','AES-KW','ECDSA','ECDH',
  'RSASSA-PKCS1-v1_5','RSA-PSS','RSA-OAEP'],'generateKey');
 var list=checkUsages(usages,USAGES[a.name]);
 if(AES[a.name]){
  if(a.length===undefined)throw new TypeError('Algorithm: length: Missing');
  var len=enforce(a.length,USHORT,'length');
  if(len!==128&&len!==192&&len!==256)
   throw err('AES key length must be 128, 192 or 256 bits','OperationError');
  needUsages(list,'secret');
  return makeKey('secret',extractable,{name:a.name,length:len},list,{raw:random(len/8)});}
 if(a.name==='HMAC'){
  var h=hashName(a.hash),bits=a.length===undefined?HASH_BLOCK_BITS[h]:enforce(a.length,ULONG,'length');
  if(!bits)throw err('HMAC key length cannot be zero','OperationError');
  var raw=u8(random(Math.ceil(bits/8)));
  if(bits%8)raw[raw.length-1]&=(0xff<<(8-bits%8))&0xff;
  needUsages(list,'secret');
  return makeKey('secret',extractable,{name:'HMAC',hash:hashAlgo(h),length:bits},list,{raw:raw.buffer});}
 if(a.name==='ECDSA'||a.name==='ECDH'){
  var c=curveOf(a),kp=N.ecGenerate(c);
  if(!kp)throw err('Key generation failed','OperationError');
  var priv=split(list,PRIVATE_USAGES[a.name]);
  needUsages(priv,'private');
  var algo={name:a.name,namedCurve:c};
  return {publicKey:makeKey('public',true,algo,split(list,PUBLIC_USAGES[a.name]),{curve:c,d:null,pub:kp[1]}),
   privateKey:makeKey('private',extractable,algo,priv,{curve:c,d:kp[0],pub:kp[1]})};}
 /* RSA */
 if(a.modulusLength===undefined)throw new TypeError('Algorithm: modulusLength: Missing');
 var hash=hashName(a.hash),mod=enforce(a.modulusLength,ULONG,'modulusLength');
 if(!(a.publicExponent instanceof Uint8Array))throw new TypeError('Algorithm: publicExponent: Not a Uint8Array');
 var e=exponentInt(a.publicExponent.buffer.slice(a.publicExponent.byteOffset,
  a.publicExponent.byteOffset+a.publicExponent.byteLength));
 if(e!==3&&e!==65537)throw err('The public exponent must be 3 or 65537','OperationError');
 if(mod<1024||mod>8192||mod%8)throw err('The modulus length is not supported','OperationError');
 var privU=split(list,PRIVATE_USAGES[a.name]);
 needUsages(privU,'private');
 var pair=N.rsaGenerate(mod,e);
 if(!pair)throw err('Key generation failed','OperationError');
 var ra=rsaAlgorithm(a.name,hash,pair[1]);
 return {publicKey:makeKey('public',true,ra,split(list,PUBLIC_USAGES[a.name]),{pkcs8:null,spki:pair[1]}),
  privateKey:makeKey('private',extractable,ra,privU,{pkcs8:pair[0],spki:pair[1]})};}

/* ---- importKey ---- */
var JWK_USE={'HMAC':'sig','ECDSA':'sig','RSASSA-PKCS1-v1_5':'sig','RSA-PSS':'sig',
 'AES-GCM':'enc','AES-CBC':'enc','AES-CTR':'enc','AES-KW':'enc','ECDH':'enc','RSA-OAEP':'enc'};
function checkJwk(jwk,kty,extractable,list,alg,name){
 if(!jwk||typeof jwk!=='object')throw new TypeError('The JWK is not an object');
 if(jwk.kty!==kty)throw err('The JWK "kty" member was not "'+kty+'"','DataError');
 if(name&&list.length&&jwk.use!==undefined&&jwk.use!==JWK_USE[name])
  throw err('The JWK "use" member was not "'+JWK_USE[name]+'"','DataError');
 if(jwk.ext===false&&extractable)
  throw err('The JWK "ext" member was false but the key is to be extractable','DataError');
 if(jwk.key_ops!==undefined){
  if(!Array.isArray(jwk.key_ops))throw err('The JWK "key_ops" member is not an array','DataError');
  list.forEach(function(u){if(jwk.key_ops.indexOf(u)<0)
   throw err('The JWK "key_ops" member does not allow the requested usages','DataError');});}
 if(alg!==undefined&&jwk.alg!==undefined&&jwk.alg!==alg)
  throw err('The JWK "alg" member was inconsistent with that specified by the Web Crypto call','DataError');}
function importKey(format,keyData,alg,extractable,usages){
 format=String(format);
 if(['raw','jwk','spki','pkcs8'].indexOf(format)<0)
  throw new TypeError("'"+format+"' is not a valid KeyFormat");
 var a=normalize(alg,['HMAC','AES-GCM','AES-CBC','AES-CTR','AES-KW','PBKDF2','HKDF',
  'ECDSA','ECDH','RSASSA-PKCS1-v1_5','RSA-PSS','RSA-OAEP'],'importKey');
 var list,data,jwk=null;
 if(format==='jwk'){jwk=keyData;
  if(!jwk||typeof jwk!=='object'||jwk instanceof ArrayBuffer||ArrayBuffer.isView(jwk))
   throw new TypeError('Key data must be a JsonWebKey');}
 else data=bytesOf(keyData,'keyData');

 if(AES[a.name]){
  list=checkUsages(usages,USAGES[a.name]);
  if(format==='jwk'){
   checkJwk(jwk,'oct',extractable,list,undefined,a.name);
   data=b64uDecode(jwk.k,'k');
   var want='A'+(data.byteLength*8)+AES[a.name];
   if(jwk.alg!==undefined&&jwk.alg!==want)
    throw err('The JWK "alg" member was inconsistent with that specified by the Web Crypto call','DataError');}
  else if(format!=='raw')throw notSupported('This key format for '+a.name);
  if([16,24,32].indexOf(data.byteLength)<0)
   throw err('AES key data must be 128, 192 or 256 bits','DataError');
  needUsages(list,'secret');
  return makeKey('secret',extractable,{name:a.name,length:data.byteLength*8},list,{raw:data});}

 if(a.name==='HMAC'){
  list=checkUsages(usages,USAGES.HMAC);
  var h=hashName(a.hash);
  if(format==='jwk'){
   checkJwk(jwk,'oct',extractable,list,'HS'+jwkHashSuffix(h),'HMAC');
   data=b64uDecode(jwk.k,'k');}
  else if(format!=='raw')throw notSupported('This key format for HMAC');
  var bits=data.byteLength*8;
  if(bits===0)throw err('HMAC key data must not be empty','DataError');
  if(a.length!==undefined){var L=enforce(a.length,ULONG,'length');
   if(L>bits||L<=bits-8)throw err('The optional HMAC key length must be shorter than the key data, and by less than 8 bits.','DataError');
   bits=L;}
  needUsages(list,'secret');
  return makeKey('secret',extractable,{name:'HMAC',hash:hashAlgo(h),length:bits},list,{raw:data});}

 if(a.name==='PBKDF2'||a.name==='HKDF'){
  list=checkUsages(usages,USAGES[a.name]);
  if(format!=='raw')throw notSupported('This key format for '+a.name);
  if(extractable)throw err(a.name+' keys cannot be extractable','SyntaxError');
  needUsages(list,'secret');
  return makeKey('secret',false,{name:a.name},list,{raw:data});}

 if(a.name==='ECDSA'||a.name==='ECDH'){
  var c=curveOf(a),d=null,pub=null,w=CURVE_BYTES[c],type;
  if(format==='raw'){
   pub=N.ecPoint(c,data);type='public';}
  else if(format==='spki'||format==='pkcs8'){
   var got=N.ecImport(format,data);
   if(!got)throw err('The key is not a valid '+format.toUpperCase()+' EC key','DataError');
   if(got[0]!==c)throw err('The key\'s curve is not the one asked for','DataError');
   d=got[1];pub=got[2];type=format==='pkcs8'?'private':'public';}
  else{
   checkJwk(jwk,'EC',extractable,[]);
   if(jwk.crv!==c)throw err('The JWK "crv" member was inconsistent with that specified by the Web Crypto call','DataError');
   var x=b64uDecode(jwk.x,'x'),y=b64uDecode(jwk.y,'y');
   if(x.byteLength!==w||y.byteLength!==w)throw err('The JWK x or y member is the wrong length','DataError');
   if(jwk.d!==undefined){d=b64uDecode(jwk.d,'d');
    if(d.byteLength!==w)throw err('The JWK "d" member is the wrong length','DataError');}
   pub=N.ecCheck(c,d,concat(new Uint8Array([4]).buffer,concat(x,y)));
   type=d?'private':'public';}
  if(!pub)throw err('The key is not a valid EC key','DataError');
  var allowed=type==='private'?PRIVATE_USAGES[a.name]:PUBLIC_USAGES[a.name];
  list=checkUsages(usages,allowed);
  if(jwk)checkJwk(jwk,'EC',extractable,list,undefined,a.name);
  needUsages(list,type);
  return makeKey(type,extractable,{name:a.name,namedCurve:c},list,
   {curve:c,d:d,pub:pub});}

 /* RSA */
 var hash=hashName(a.hash),enc,priv;
 if(format==='spki'||format==='pkcs8'){
  enc=N.rsaImport(format,data);
  if(!enc)throw err('The key is not a valid '+format.toUpperCase()+' RSA key','DataError');
  priv=format==='pkcs8';}
 else if(format==='jwk'){
  checkJwk(jwk,'RSA',extractable,[],rsaJwkAlg(a.name,hash));
  priv=jwk.d!==undefined;
  var parts=['n','e','d','p','q','dp','dq','qi'].map(function(m,i){
   if(i>=2&&!priv)return null;
   return b64uDecode(jwk[m],m);});
  enc=N.rsaFromJwk(parts);
  if(!enc)throw err('The JWK does not hold a valid RSA key','DataError');}
 else throw notSupported('The raw format for RSA keys');
 list=checkUsages(usages,priv?PRIVATE_USAGES[a.name]:PUBLIC_USAGES[a.name]);
 if(jwk)checkJwk(jwk,'RSA',extractable,list,undefined,a.name);
 needUsages(list,priv?'private':'public');
 return makeKey(priv?'private':'public',extractable,rsaAlgorithm(a.name,hash,enc[1]),list,
  {pkcs8:priv?enc[0]:null,spki:enc[1]});}

/* ---- exportKey ---- */
function exportKey(format,key){
 format=String(format);
 if(['raw','jwk','spki','pkcs8'].indexOf(format)<0)
  throw new TypeError("'"+format+"' is not a valid KeyFormat");
 var s=slot(key),a=s.algorithm,m=s.m,jwk;
 if(!s.extractable)throw err('key is not extractable','InvalidAccessError');
 if(s.type==='secret'){
  if(format==='raw')return m.raw.slice(0);
  if(format!=='jwk')throw err('This key format is not valid for a secret key','InvalidAccessError');
  jwk={kty:'oct',k:b64uEncode(m.raw)};
  if(AES[a.name])jwk.alg='A'+a.length+AES[a.name];
  else if(a.name==='HMAC')jwk.alg='HS'+jwkHashSuffix(a.hash.name);
 }else if(a.namedCurve){
  if(format==='raw'){if(s.type!=='public')throw err('Only a public key has the raw format','InvalidAccessError');
   return m.pub.slice(0);}
  if(format==='spki'||format==='pkcs8'){
   if((format==='spki')!==(s.type==='public'))
    throw err('This key format does not fit a '+s.type+' key','InvalidAccessError');
   var der=N.ecExport(format,m.curve,m.d,m.pub);
   if(!der)throw err('Export failed','OperationError');return der;}
  var w=CURVE_BYTES[m.curve],p=m.pub;
  jwk={kty:'EC',crv:m.curve,x:b64uEncode(p.slice(1,1+w)),y:b64uEncode(p.slice(1+w,1+2*w))};
  if(m.d)jwk.d=b64uEncode(padLeft(m.d,w));
 }else{
  if(format==='raw')throw err('RSA keys have no raw format','InvalidAccessError');
  if(format==='spki'){if(s.type!=='public')throw err('Only a public key has the spki format','InvalidAccessError');
   return m.spki.slice(0);}
  if(format==='pkcs8'){if(s.type!=='private')throw err('Only a private key has the pkcs8 format','InvalidAccessError');
   return m.pkcs8.slice(0);}
  var priv=s.type==='private',v=N.rsaToJwk(priv?m.pkcs8:m.spki,priv);
  if(!v)throw err('Export failed','OperationError');
  jwk={kty:'RSA',alg:rsaJwkAlg(a.name,a.hash.name),n:b64uEncode(v[0]),e:b64uEncode(v[1])};
  if(priv)['d','p','q','dp','dq','qi'].forEach(function(n,i){jwk[n]=b64uEncode(v[i+2]);});
 }
 jwk.key_ops=s.usages.slice();jwk.ext=s.extractable;
 return jwk;}

/* ---- sign and verify ---- */
function signOrVerify(verify,alg,key,sig,data){
 var a=normalize(alg,['HMAC','ECDSA','RSASSA-PKCS1-v1_5','RSA-PSS'],verify?'verify':'sign');
 var s=useKey(key,a.name,verify?'verify':'sign'),m=s.m,d=bytesOf(data,'data'),r;
 if(a.name==='HMAC'){
  r=N.hmac(s.algorithm.hash.name,m.raw,d);
  if(!r)throw err('HMAC failed','OperationError');
  return verify?sameBytes(r,sig):r;}
 if(a.name==='ECDSA'){
  var h=hashName(a.hash);
  if(verify)return N.ecdsaVerify(m.curve,h,m.pub,sig,d);
  r=N.ecdsaSign(m.curve,h,m.d,d);}
 else{
  var scheme=a.name==='RSA-PSS'?'pss':'pkcs1',salt=0;
  if(scheme==='pss'){if(a.saltLength===undefined)throw new TypeError('Algorithm: saltLength: Missing');
   salt=enforce(a.saltLength,ULONG,'saltLength');}
  if(verify)return N.rsaVerify(scheme,s.algorithm.hash.name,m.spki,sig,d,salt);
  r=N.rsaSign(scheme,s.algorithm.hash.name,m.pkcs8,d,salt);}
 if(!r)throw err('Signing failed','OperationError');
 return r;}

/* ---- encrypt and decrypt ---- */
var GCM_TAGS=[32,64,96,104,112,120,128];
function cipher(enc,alg,key,data,usage){
 var a=normalize(alg,['AES-GCM','AES-CBC','AES-CTR','RSA-OAEP'],enc?'encrypt':'decrypt');
 var s=useKey(key,a.name,usage||(enc?'encrypt':'decrypt')),m=s.m,d=bytesOf(data,'data'),r;
 if(a.name==='AES-GCM'){
  if(a.iv===undefined)throw new TypeError('Algorithm: iv: Missing');
  var tag=a.tagLength===undefined?128:enforce(a.tagLength,OCTET,'tagLength');
  if(GCM_TAGS.indexOf(tag)<0)throw err('The tag length is not supported','OperationError');
  r=N.aesGcm(enc,m.raw,bytesOf(a.iv,'iv'),d,
   a.additionalData===undefined?null:bytesOf(a.additionalData,'additionalData'),tag);}
 else if(a.name==='AES-CBC'){
  if(a.iv===undefined)throw new TypeError('Algorithm: iv: Missing');
  var iv=bytesOf(a.iv,'iv');
  if(iv.byteLength!==16)throw err('The iv must be 16 bytes','OperationError');
  r=N.aesCbc(enc,m.raw,iv,d);}
 else if(a.name==='AES-CTR'){
  if(a.counter===undefined)throw new TypeError('Algorithm: counter: Missing');
  if(a.length===undefined)throw new TypeError('Algorithm: length: Missing');
  var ctr=bytesOf(a.counter,'counter'),len=enforce(a.length,OCTET,'length');
  if(ctr.byteLength!==16)throw err('The counter must be 16 bytes','OperationError');
  if(!(len>=1&&len<=128))throw err('The counter length must be between 1 and 128','OperationError');
  /* the counter may not come round to where it started */
  if(len<53&&Math.ceil(d.byteLength/16)>Math.pow(2,len))
   throw err('The counter would wrap around','DataError');
  r=N.aesCtr(m.raw,ctr,len,d);}
 else{
  r=N.rsaOaep(enc,s.algorithm.hash.name,enc?m.spki:m.pkcs8,d,
   a.label===undefined?null:bytesOf(a.label,'label'));}
 if(!r)throw err('The operation failed for an operation-specific reason','OperationError');
 return r;}

/* ---- deriveBits and deriveKey ---- */
function deriveBits(alg,key,length,usage){
 var a=normalize(alg,['PBKDF2','HKDF','ECDH'],'deriveBits');
 var s=useKey(key,a.name,usage||'deriveBits'),m=s.m,r;
 if(a.name==='ECDH'){
  var pub=a['public'];
  if(!pub||!SLOTS.get(pub))throw new TypeError('Algorithm: public: Not a CryptoKey');
  var ps=SLOTS.get(pub);
  if(ps.type!=='public'||ps.algorithm.name!=='ECDH')
   throw err('The public key is not an ECDH public key','InvalidAccessError');
  if(ps.algorithm.namedCurve!==s.algorithm.namedCurve)
   throw err('The keys are on different curves','InvalidAccessError');
  r=N.ecdh(m.curve,m.d,ps.m.pub);
  if(!r)throw err('Key agreement failed','OperationError');
  if(length===null||length===undefined)return r;
  length=Number(length)>>>0;
  if(length>r.byteLength*8)throw err('The length is larger than the shared secret','OperationError');
  var out=u8(r.slice(0,Math.ceil(length/8)));
  if(length%8)out[out.length-1]&=(0xff<<(8-length%8))&0xff;
  return out.buffer;}
 if(length===null||length===undefined)throw err('A length is required','OperationError');
 length=Number(length)>>>0;
 if(length%8)throw err('The length must be a multiple of 8','OperationError');
 if(length===0)return new ArrayBuffer(0);
 var h=hashName(a.hash);
 if(a.salt===undefined)throw new TypeError('Algorithm: salt: Missing');
 if(a.name==='PBKDF2'){
  if(a.iterations===undefined)throw new TypeError('Algorithm: iterations: Missing');
  var it=enforce(a.iterations,ULONG,'iterations');
  if(!it)throw err('The iteration count must not be zero','OperationError');
  r=N.pbkdf2(h,m.raw,bytesOf(a.salt,'salt'),it,length);}
 else{
  if(a.info===undefined)throw new TypeError('Algorithm: info: Missing');
  r=N.hkdf(h,m.raw,bytesOf(a.salt,'salt'),bytesOf(a.info,'info'),length);}
 if(!r)throw err('Derivation failed','OperationError');
 return r;}
function keyLength(alg){
 var a=normalize(alg,['AES-GCM','AES-CBC','AES-CTR','AES-KW','HMAC','HKDF','PBKDF2'],'get key length');
 if(AES[a.name]){
  if(a.length===undefined)throw new TypeError('Algorithm: length: Missing');
  var l=enforce(a.length,USHORT,'length');
  if(l!==128&&l!==192&&l!==256)throw err('AES key length must be 128, 192 or 256 bits','OperationError');
  return l;}
 if(a.name==='HMAC'){var h=hashName(a.hash);
  if(a.length===undefined)return HASH_BLOCK_BITS[h];
  var n=enforce(a.length,ULONG,'length');if(!n)throw new TypeError('HMAC length cannot be zero');return n;}
 return null;}
function deriveKey(alg,key,derived,extractable,usages){
 var len=keyLength(derived);
 var bits=deriveBits(alg,key,len,'deriveKey');
 return importKey('raw',bits,derived,extractable,usages);}

/* ---- wrapKey and unwrapKey ---- */
function wrapKey(format,key,wrappingKey,wrapAlg){
 var a=normalize(wrapAlg,['AES-GCM','AES-CBC','AES-CTR','AES-KW','RSA-OAEP'],'wrapKey');
 var exported=exportKey(format,key),bytes;
 if(String(format)==='jwk')bytes=new TextEncoder().encode(JSON.stringify(exported)).buffer;
 else bytes=exported;
 if(a.name==='AES-KW'){
  var s=useKey(wrappingKey,'AES-KW','wrapKey'),r=N.aesKw(true,s.m.raw,bytes);
  if(!r)throw err('The data is not a whole number of 64-bit blocks','OperationError');
  return r;}
 return cipher(true,a,wrappingKey,bytes,'wrapKey');}
function unwrapKey(format,wrapped,unwrappingKey,unwrapAlg,keyAlg,extractable,usages){
 var a=normalize(unwrapAlg,['AES-GCM','AES-CBC','AES-CTR','AES-KW','RSA-OAEP'],'unwrapKey'),bytes;
 if(a.name==='AES-KW'){
  var s=useKey(unwrappingKey,'AES-KW','unwrapKey');
  bytes=N.aesKw(false,s.m.raw,bytesOf(wrapped,'wrappedKey'));
  if(!bytes)throw err('The key could not be unwrapped','OperationError');}
 else bytes=cipher(false,a,unwrappingKey,wrapped,'unwrapKey');
 var data=bytes;
 if(String(format)==='jwk'){
  try{data=JSON.parse(new TextDecoder().decode(bytes));}
  catch(e){throw err('The unwrapped key is not a JWK','DataError');}}
 return importKey(format,data,keyAlg,extractable,usages);}

/* ---- the objects ---- */
function promised(fn){
 return function(){
  var args=arguments,self=this;
  return new Promise(function(resolve){
   if(!(self instanceof SubtleCrypto))throw new TypeError('Illegal invocation');
   resolve(fn.apply(null,args));});};}
function needArgs(n,name){return function(fn){return function(){
 if(arguments.length<n)return Promise.reject(new TypeError(
  "Failed to execute '"+name+"' on 'SubtleCrypto': "+n+" arguments required, but only "+
  arguments.length+" present."));
 return fn.apply(this,arguments);};};}
function SubtleCrypto(){throw new TypeError('Illegal constructor');}
/* The arguments that have to be CryptoKeys, checked first, as the
   bindings of a browser do before the algorithm is looked at. */
var KEY_ARGS={encrypt:[1],decrypt:[1],sign:[1],verify:[1],exportKey:[1],
 deriveBits:[1],deriveKey:[1],wrapKey:[1,2],unwrapKey:[2]};
function checkKeys(name,args){
 (KEY_ARGS[name]||[]).forEach(function(i){
  if(!SLOTS.get(args[i]))throw new TypeError("Failed to execute '"+name+
   "' on 'SubtleCrypto': parameter "+(i+1)+" is not of type 'CryptoKey'.");});}
var methods={
 digest:[2,function(alg,data){
  var a=normalize(alg,['SHA-1','SHA-256','SHA-384','SHA-512'],'digest');
  var r=N.digest(a.name,bytesOf(data,'data'));
  if(!r)throw err('Digest failed','OperationError');return r;}],
 generateKey:[3,generateKey],importKey:[5,importKey],exportKey:[2,exportKey],
 sign:[3,function(alg,key,data){return signOrVerify(false,alg,key,null,data);}],
 verify:[4,function(alg,key,sig,data){return signOrVerify(true,alg,key,bytesOf(sig,'signature'),data);}],
 encrypt:[3,function(alg,key,data){return cipher(true,alg,key,data);}],
 decrypt:[3,function(alg,key,data){return cipher(false,alg,key,data);}],
 deriveBits:[2,function(alg,key,length){return deriveBits(alg,key,length);}],
 deriveKey:[5,deriveKey],wrapKey:[4,wrapKey],unwrapKey:[7,unwrapKey]};
Object.keys(methods).forEach(function(k){
 var body=methods[k][1];
 var f=needArgs(methods[k][0],k)(promised(function(){
  checkKeys(k,arguments);return body.apply(null,arguments);}));
 Object.defineProperty(f,'name',{value:k});
 Object.defineProperty(SubtleCrypto.prototype,k,{configurable:true,writable:true,value:f});});
Object.defineProperty(SubtleCrypto.prototype,Symbol.toStringTag,{configurable:true,value:'SubtleCrypto'});
var subtle=Object.create(SubtleCrypto.prototype);

function Crypto(){throw new TypeError('Illegal constructor');}
Object.defineProperty(Crypto.prototype,'subtle',{configurable:true,enumerable:true,
 get:function(){return subtle;}});
Crypto.prototype.getRandomValues=getRandomValues;
Crypto.prototype.randomUUID=randomUUID;
Object.defineProperty(Crypto.prototype,Symbol.toStringTag,{configurable:true,value:'Crypto'});
var crypto=Object.create(Crypto.prototype);
Object.defineProperty(W,'crypto',{configurable:true,enumerable:true,
 get:function(){return crypto;},set:function(){}});
W.Crypto=Crypto;W.SubtleCrypto=SubtleCrypto;W.CryptoKey=CryptoKey;

/* structuredClone, postMessage and IndexedDB carry a key as a key; see
   storage.js. What is packed is the key's slot, material included. */
if(typeof W.__vitaRegisterKeyClone==='function')W.__vitaRegisterKeyClone({
 is:function(v){return !!v&&typeof v==='object'&&SLOTS.has(v);},
 pack:function(k){var s=SLOTS.get(k),a={},m={};
  Object.keys(s.algorithm).forEach(function(n){var x=s.algorithm[n];
   a[n]=x instanceof Uint8Array?Array.from(x):x&&typeof x==='object'?{name:x.name}:x;});
  Object.keys(s.m).forEach(function(n){m[n]=s.m[n];});
  return {type:s.type,extractable:s.extractable,algorithm:a,usages:s.usages.slice(),m:m};},
 unpack:function(p){
  if(!p||typeof p!=='object'||!p.algorithm||!p.m)return null;
  var a={};Object.keys(p.algorithm).forEach(function(n){var x=p.algorithm[n];
   a[n]=n==='publicExponent'?new Uint8Array(x):x;});
  return makeKey(p.type,p.extractable,a,p.usages||[],p.m);}});
})();
