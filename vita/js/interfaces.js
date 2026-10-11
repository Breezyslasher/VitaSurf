/*
 * The interfaces as WebIDL makes them, part of the VitaSurf prelude, run
 * last of it.
 *
 * Much of what the prelude defines began as a stand-in: a plain function
 * that could be called and constructed, sometimes one function under
 * several names, a prototype with no constructor and no Symbol.toStringTag,
 * a global that was enumerable. Code that looks at an interface rather
 * than through it -- "is this a native constructor", "what does
 * Object.prototype.toString say", "does new X() throw", "what does X
 * inherit from" -- got answers no browser gives, and those answers are
 * exactly what a page checks when it asks what it is running in.
 *
 * TABLE holds, for every interface this prelude exposes and WebIDL
 * defines, what the specification makes of it, as Chromium reports it:
 * its parent interface, whether it constructs (c), only with arguments
 * (r) or never (i, "Illegal constructor"), its length (the arguments it
 * requires), its toStringTag (1 for its own name) and its constants.
 * Each one here then gets a public interface object of its own:
 *
 *  - it throws "Illegal constructor", or requires new and its arguments
 *    and then constructs through the implementation, so internal code
 *    that holds the implementation is unaffected;
 *  - its name and length are WebIDL's, and its [[Prototype]] is its
 *    parent interface object, as Object.getPrototypeOf(HTMLElement) is
 *    Element;
 *  - its prototype says constructor and toStringTag, inherits from the
 *    parent's prototype where it inherited from nothing, and has the
 *    constants;
 *  - the global is writable, configurable and not enumerable.
 *
 * Interfaces that are nodes keep their constructors, which tell nodes
 * apart (see "instanceof, told apart"): their prototype is one shared
 * object, and only what lies outside it is set here. Interfaces this
 * browser has no implementation of and no browser shows are removed.
 */
(function(){
var W=window;
/* 290 interfaces, parents first */
var TABLE='AbortController|Object|c|0|1|\n'+
'EventTarget|Object|c|0|1|\n'+
'AbortSignal|EventTarget|i|0|1|\n'+
'AbstractRange|Object|i|0|1|\n'+
'Animation|EventTarget|c|0|1|\n'+
'AnimationEffect|Object|i|0|1|\n'+
'AnimationTimeline|Object|i|0|1|\n'+
'Event|Object|r|1|1|NONE=0,CAPTURING_PHASE=1,AT_TARGET=2,BUBBLING_PHASE=3\n'+
'AnimationEvent|Event|r|1|1|\n'+
'Node|EventTarget|i|0|1|ELEMENT_NODE=1,ATTRIBUTE_NODE=2,TEXT_NODE=3,CDATA_SECTION_NODE=4,ENTITY_REFERENCE_NODE=5,ENTITY_NODE=6,PROCESSING_INSTRUCTION_NODE=7,COMMENT_NODE=8,DOCUMENT_NODE=9,DOCUMENT_TYPE_NODE=10,DOCUMENT_FRAGMENT_NODE=11,NOTATION_NODE=12,DOCUMENT_POSITION_DISCONNECTED=1,DOCUMENT_POSITION_PRECEDING=2,DOCUMENT_POSITION_FOLLOWING=4,DOCUMENT_POSITION_CONTAINS=8,DOCUMENT_POSITION_CONTAINED_BY=16,DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC=32\n'+
'Attr|Node|i|0|1|\n'+
'Element|Node|i|0|1|\n'+
'HTMLElement|Element|i|0|1|\n'+
'HTMLMediaElement|HTMLElement|i|0|1|NETWORK_EMPTY=0,NETWORK_IDLE=1,NETWORK_LOADING=2,NETWORK_NO_SOURCE=3,HAVE_NOTHING=0,HAVE_METADATA=1,HAVE_CURRENT_DATA=2,HAVE_FUTURE_DATA=3,HAVE_ENOUGH_DATA=4\n'+
'Audio|HTMLMediaElement|c|0|HTMLAudioElement|\n'+
'BarProp|Object|i|0|1|\n'+
'BeforeUnloadEvent|Event|i|0|1|\n'+
'Blob|Object|c|0|1|\n'+
'ByteLengthQueuingStrategy|Object|r|1|1|\n'+
'CharacterData|Node|i|0|1|\n'+
'Text|CharacterData|c|0|1|\n'+
'CDATASection|Text|i|0|1|\n'+
'CSSRule|Object|i|0|1|STYLE_RULE=1,CHARSET_RULE=2,IMPORT_RULE=3,MEDIA_RULE=4,FONT_FACE_RULE=5,PAGE_RULE=6,MARGIN_RULE=9,NAMESPACE_RULE=10,KEYFRAMES_RULE=7,KEYFRAME_RULE=8,COUNTER_STYLE_RULE=11,FONT_FEATURE_VALUES_RULE=14,SUPPORTS_RULE=12\n'+
'CSSFontFaceRule|CSSRule|i|0|1|\n'+
'CSSGroupingRule|CSSRule|i|0|1|\n'+
'CSSConditionRule|CSSGroupingRule|i|0|1|\n'+
'CSSImportRule|CSSRule|i|0|1|\n'+
'CSSKeyframesRule|CSSRule|i|0|1|\n'+
'CSSMediaRule|CSSConditionRule|i|0|1|\n'+
'CSSNamespaceRule|CSSRule|i|0|1|\n'+
'CSSPageRule|CSSGroupingRule|i|0|1|\n'+
'CSSRuleList|Object|i|0|1|\n'+
'CSSStyleDeclaration|Object|i|0|1|\n'+
'CSSStyleRule|CSSRule|i|0|1|\n'+
'StyleSheet|Object|i|0|1|\n'+
'CSSStyleSheet|StyleSheet|c|0|1|\n'+
'CSSSupportsRule|CSSConditionRule|i|0|1|\n'+
'CanvasGradient|Object|i|0|1|\n'+
'CanvasPattern|Object|i|0|1|\n'+
'CanvasRenderingContext2D|Object|i|0|1|\n'+
'CaretPosition|Object|i|0|1|\n'+
'ClipboardEvent|Event|r|1|1|\n'+
'CloseEvent|Event|r|1|1|\n'+
'CommandEvent|Event|r|1|1|\n'+
'Comment|CharacterData|c|0|1|\n'+
'UIEvent|Event|r|1|1|\n'+
'CompositionEvent|UIEvent|r|1|1|\n'+
'ContentVisibilityAutoStateChangeEvent|Event|r|1|1|\n'+
'CountQueuingStrategy|Object|r|1|1|\n'+
'CustomElementRegistry|Object|i|0|1|\n'+
'CustomEvent|Event|r|1|1|\n'+
'CustomStateSet|Object|i|0|1|\n'+
'DOMException|Error|c|0|1|INDEX_SIZE_ERR=1,DOMSTRING_SIZE_ERR=2,HIERARCHY_REQUEST_ERR=3,WRONG_DOCUMENT_ERR=4,INVALID_CHARACTER_ERR=5,NO_DATA_ALLOWED_ERR=6,NO_MODIFICATION_ALLOWED_ERR=7,NOT_FOUND_ERR=8,NOT_SUPPORTED_ERR=9,INUSE_ATTRIBUTE_ERR=10,INVALID_STATE_ERR=11,SYNTAX_ERR=12,INVALID_MODIFICATION_ERR=13,NAMESPACE_ERR=14,INVALID_ACCESS_ERR=15,VALIDATION_ERR=16,TYPE_MISMATCH_ERR=17,SECURITY_ERR=18,NETWORK_ERR=19,ABORT_ERR=20,URL_MISMATCH_ERR=21,QUOTA_EXCEEDED_ERR=22,TIMEOUT_ERR=23,INVALID_NODE_TYPE_ERR=24,DATA_CLONE_ERR=25\n'+
'DOMImplementation|Object|i|0|1|\n'+
'DOMMatrix|DOMMatrixReadOnly|c|0|1|\n'+
'DOMParser|Object|c|0|1|\n'+
'DOMPoint|DOMPointReadOnly|c|0|1|\n'+
'DOMRectReadOnly|Object|c|0|1|\n'+
'DOMRect|DOMRectReadOnly|c|0|1|\n'+
'DOMStringList|Object|i|0|1|\n'+
'DOMStringMap|Object|i|0|1|\n'+
'DOMTokenList|Object|i|0|1|\n'+
'DataTransfer|Object|c|0|1|\n'+
'DataTransferItem|Object|i|0|1|\n'+
'DataTransferItemList|Object|i|0|1|\n'+
'DeviceMotionEvent|Event|r|1|1|\n'+
'DeviceOrientationEvent|Event|r|1|1|\n'+
'Document|Node|c|0|1|\n'+
'DocumentFragment|Node|c|0|1|\n'+
'DocumentTimeline|AnimationTimeline|c|0|1|\n'+
'DocumentType|Node|i|0|1|\n'+
'MouseEvent|UIEvent|r|1|1|\n'+
'DragEvent|MouseEvent|r|1|1|\n'+
'ElementInternals|Object|i|0|1|\n'+
'ErrorEvent|Event|r|1|1|\n'+
'External|Object|i|0|1|\n'+
'File|Blob|r|2|1|\n'+
'FileList|Object|i|0|1|\n'+
'FileReader|EventTarget|c|0|1|EMPTY=0,LOADING=1,DONE=2\n'+
'FocusEvent|UIEvent|r|1|1|\n'+
'FontFace|Object|r|2|1|\n'+
'FormData|Object|c|0|1|\n'+
'FormDataEvent|Event|r|2|1|\n'+
'GamepadEvent|Event|r|1|1|\n'+
'HTMLAllCollection|Object|i|0|1|\n'+
'HTMLAnchorElement|HTMLElement|i|0|1|\n'+
'HTMLAreaElement|HTMLElement|i|0|1|\n'+
'HTMLAudioElement|HTMLMediaElement|i|0|1|\n'+
'HTMLBRElement|HTMLElement|i|0|1|\n'+
'HTMLBaseElement|HTMLElement|i|0|1|\n'+
'HTMLBodyElement|HTMLElement|i|0|1|\n'+
'HTMLButtonElement|HTMLElement|i|0|1|\n'+
'HTMLCanvasElement|HTMLElement|i|0|1|\n'+
'HTMLCollection|Object|i|0|1|\n'+
'HTMLDListElement|HTMLElement|i|0|1|\n'+
'HTMLDataElement|HTMLElement|i|0|1|\n'+
'HTMLDataListElement|HTMLElement|i|0|1|\n'+
'HTMLDetailsElement|HTMLElement|i|0|1|\n'+
'HTMLDialogElement|HTMLElement|i|0|1|\n'+
'HTMLDivElement|HTMLElement|i|0|1|\n'+
'HTMLDocument|Document|i|0|1|\n'+
'HTMLEmbedElement|HTMLElement|i|0|1|\n'+
'HTMLFieldSetElement|HTMLElement|i|0|1|\n'+
'HTMLFontElement|HTMLElement|i|0|1|\n'+
'HTMLFormControlsCollection|HTMLCollection|i|0|1|\n'+
'HTMLFormElement|HTMLElement|i|0|1|\n'+
'HTMLFrameElement|HTMLElement|i|0|1|\n'+
'HTMLFrameSetElement|HTMLElement|i|0|1|\n'+
'HTMLHRElement|HTMLElement|i|0|1|\n'+
'HTMLHeadElement|HTMLElement|i|0|1|\n'+
'HTMLHeadingElement|HTMLElement|i|0|1|\n'+
'HTMLHtmlElement|HTMLElement|i|0|1|\n'+
'HTMLIFrameElement|HTMLElement|i|0|1|\n'+
'HTMLImageElement|HTMLElement|i|0|1|\n'+
'HTMLInputElement|HTMLElement|i|0|1|\n'+
'HTMLLIElement|HTMLElement|i|0|1|\n'+
'HTMLLabelElement|HTMLElement|i|0|1|\n'+
'HTMLLegendElement|HTMLElement|i|0|1|\n'+
'HTMLLinkElement|HTMLElement|i|0|1|\n'+
'HTMLMapElement|HTMLElement|i|0|1|\n'+
'HTMLMarqueeElement|HTMLElement|i|0|1|\n'+
'HTMLMenuElement|HTMLElement|i|0|1|\n'+
'HTMLMetaElement|HTMLElement|i|0|1|\n'+
'HTMLMeterElement|HTMLElement|i|0|1|\n'+
'HTMLModElement|HTMLElement|i|0|1|\n'+
'HTMLOListElement|HTMLElement|i|0|1|\n'+
'HTMLObjectElement|HTMLElement|i|0|1|\n'+
'HTMLOptGroupElement|HTMLElement|i|0|1|\n'+
'HTMLOptionElement|HTMLElement|i|0|1|\n'+
'HTMLOptionsCollection|HTMLCollection|i|0|1|\n'+
'HTMLOutputElement|HTMLElement|i|0|1|\n'+
'HTMLParagraphElement|HTMLElement|i|0|1|\n'+
'HTMLParamElement|HTMLElement|i|0|1|\n'+
'HTMLPictureElement|HTMLElement|i|0|1|\n'+
'HTMLPreElement|HTMLElement|i|0|1|\n'+
'HTMLProgressElement|HTMLElement|i|0|1|\n'+
'HTMLQuoteElement|HTMLElement|i|0|1|\n'+
'HTMLScriptElement|HTMLElement|i|0|1|\n'+
'HTMLSelectElement|HTMLElement|i|0|1|\n'+
'HTMLSlotElement|HTMLElement|i|0|1|\n'+
'HTMLSourceElement|HTMLElement|i|0|1|\n'+
'HTMLSpanElement|HTMLElement|i|0|1|\n'+
'HTMLStyleElement|HTMLElement|i|0|1|\n'+
'HTMLTableCaptionElement|HTMLElement|i|0|1|\n'+
'HTMLTableCellElement|HTMLElement|i|0|1|\n'+
'HTMLTableColElement|HTMLElement|i|0|1|\n'+
'HTMLTableElement|HTMLElement|i|0|1|\n'+
'HTMLTableRowElement|HTMLElement|i|0|1|\n'+
'HTMLTableSectionElement|HTMLElement|i|0|1|\n'+
'HTMLTemplateElement|HTMLElement|i|0|1|\n'+
'HTMLTextAreaElement|HTMLElement|i|0|1|\n'+
'HTMLTimeElement|HTMLElement|i|0|1|\n'+
'HTMLTitleElement|HTMLElement|i|0|1|\n'+
'HTMLTrackElement|HTMLElement|i|0|1|NONE=0,LOADING=1,LOADED=2,ERROR=3\n'+
'HTMLUListElement|HTMLElement|i|0|1|\n'+
'HTMLUnknownElement|HTMLElement|i|0|1|\n'+
'HTMLVideoElement|HTMLMediaElement|i|0|1|\n'+
'HashChangeEvent|Event|r|1|1|\n'+
'Headers|Object|c|0|1|\n'+
'History|Object|i|0|1|\n'+
'IDBCursor|Object|i|0|1|\n'+
'IDBCursorWithValue|IDBCursor|i|0|1|\n'+
'IDBDatabase|EventTarget|i|0|1|\n'+
'IDBFactory|Object|i|0|1|\n'+
'IDBIndex|Object|i|0|1|\n'+
'IDBKeyRange|Object|i|0|1|\n'+
'IDBObjectStore|Object|i|0|1|\n'+
'IDBRequest|EventTarget|i|0|1|\n'+
'IDBOpenDBRequest|IDBRequest|i|0|1|\n'+
'IDBTransaction|EventTarget|i|0|1|\n'+
'IDBVersionChangeEvent|Event|r|1|1|\n'+
'Image|HTMLElement|c|0|HTMLImageElement|\n'+
'ImageBitmap|Object|i|0|1|\n'+
'ImageBitmapRenderingContext|Object|i|0|1|\n'+
'ImageData|Object|r|2|1|\n'+
'InputEvent|UIEvent|r|1|1|\n'+
'IntersectionObserver|Object|r|1|1|\n'+
'IntersectionObserverEntry|Object|i|0|1|\n'+
'KeyboardEvent|UIEvent|r|1|1|DOM_KEY_LOCATION_STANDARD=0,DOM_KEY_LOCATION_LEFT=1,DOM_KEY_LOCATION_RIGHT=2,DOM_KEY_LOCATION_NUMPAD=3\n'+
'KeyframeEffect|AnimationEffect|r|1|1|\n'+
'Location|Object|i|0|1|\n'+
'MediaError|Object|i|0|1|MEDIA_ERR_ABORTED=1,MEDIA_ERR_NETWORK=2,MEDIA_ERR_DECODE=3,MEDIA_ERR_SRC_NOT_SUPPORTED=4\n'+
'MediaList|Object|i|0|1|\n'+
'MediaQueryList|EventTarget|i|0|1|\n'+
'MediaQueryListEvent|Event|r|1|1|\n'+
'MessageChannel|Object|c|0|1|\n'+
'MessageEvent|Event|r|1|1|\n'+
'MessagePort|EventTarget|i|0|1|\n'+
'MimeType|Object|i|0|1|\n'+
'MimeTypeArray|Object|i|0|1|\n'+
'MutationObserver|Object|r|1|1|\n'+
'MutationRecord|Object|i|0|1|\n'+
'NamedNodeMap|Object|i|0|1|\n'+
'NavigationHistoryEntry|EventTarget|i|0|1|\n'+
'Navigator|Object|i|0|1|\n'+
'NodeIterator|Object|i|0|1|\n'+
'NodeList|Object|i|0|1|\n'+
'Notification|EventTarget|r|1|1|\n'+
'OffscreenCanvas|EventTarget|r|2|1|\n'+
'OffscreenCanvasRenderingContext2D|Object|i|0|1|\n'+
'Option|HTMLElement|c|0|HTMLOptionElement|\n'+
'PageRevealEvent|Event|r|1|1|\n'+
'PageSwapEvent|Event|r|1|1|\n'+
'PageTransitionEvent|Event|r|1|1|\n'+
'Path2D|Object|c|0|1|\n'+
'Performance|EventTarget|i|0|1|\n'+
'PerformanceEntry|Object|i|0|1|\n'+
'PerformanceMark|PerformanceEntry|r|1|1|\n'+
'PerformanceMeasure|PerformanceEntry|i|0|1|\n'+
'PerformanceNavigation|Object|i|0|1|TYPE_NAVIGATE=0,TYPE_RELOAD=1,TYPE_BACK_FORWARD=2,TYPE_RESERVED=255\n'+
'PerformanceResourceTiming|PerformanceEntry|i|0|1|\n'+
'PerformanceNavigationTiming|PerformanceResourceTiming|i|0|1|\n'+
'PerformanceObserver|Object|r|1|1|\n'+
'PerformanceObserverEntryList|Object|i|0|1|\n'+
'PerformanceTiming|Object|i|0|1|\n'+
'Plugin|Object|i|0|1|\n'+
'PluginArray|Object|i|0|1|\n'+
'PointerEvent|MouseEvent|r|1|1|\n'+
'PopStateEvent|Event|r|1|1|\n'+
'ProcessingInstruction|CharacterData|i|0|1|\n'+
'ProgressEvent|Event|r|1|1|\n'+
'PromiseRejectionEvent|Event|r|2|1|\n'+
'QuotaExceededError|DOMException|c|0|1|\n'+
'RadioNodeList|NodeList|i|0|1|\n'+
'Range|AbstractRange|c|0|1|START_TO_START=0,START_TO_END=1,END_TO_END=2,END_TO_START=3\n'+
'ReadableByteStreamController|Object|i|0|1|\n'+
'ReadableStream|Object|c|0|1|\n'+
'ReadableStreamBYOBReader|Object|r|1|1|\n'+
'ReadableStreamBYOBRequest|Object|i|0|1|\n'+
'ReadableStreamDefaultController|Object|i|0|1|\n'+
'ReadableStreamDefaultReader|Object|r|1|1|\n'+
'Request|Object|r|1|1|\n'+
'ResizeObserver|Object|r|1|1|\n'+
'ResizeObserverEntry|Object|i|0|1|\n'+
'ResizeObserverSize|Object|i|0|1|\n'+
'Response|Object|c|0|1|\n'+
'SVGElement|Element|i|0|1|\n'+
'SVGSVGElement|SVGGraphicsElement|i|0|1|SVG_ZOOMANDPAN_UNKNOWN=0,SVG_ZOOMANDPAN_DISABLE=1,SVG_ZOOMANDPAN_MAGNIFY=2\n'+
'Screen|EventTarget|i|0|1|\n'+
'SecurityPolicyViolationEvent|Event|r|1|1|\n'+
'Selection|Object|i|0|1|\n'+
'ShadowRoot|DocumentFragment|i|0|1|\n'+
'StaticRange|AbstractRange|r|1|1|\n'+
'Storage|Object|i|0|1|\n'+
'StorageEvent|Event|r|1|1|\n'+
'StylePropertyMapReadOnly|Object|i|0|1|\n'+
'StylePropertyMap|StylePropertyMapReadOnly|i|0|1|\n'+
'StyleSheetList|Object|i|0|1|\n'+
'SubmitEvent|Event|r|1|1|\n'+
'TextDecoder|Object|c|0|1|\n'+
'TextDecoderStream|Object|c|0|1|\n'+
'TextEncoder|Object|c|0|1|\n'+
'TextEncoderStream|Object|c|0|1|\n'+
'TextEvent|UIEvent|i|0|1|\n'+
'TextMetrics|Object|i|0|1|\n'+
'TextTrack|EventTarget|i|0|1|\n'+
'TextTrackCue|EventTarget|i|0|1|\n'+
'TextTrackCueList|Object|i|0|1|\n'+
'TextTrackList|EventTarget|i|0|1|\n'+
'TimeRanges|Object|i|0|1|\n'+
'ToggleEvent|Event|r|1|1|\n'+
'Touch|Object|r|1|1|\n'+
'TouchEvent|UIEvent|r|1|1|\n'+
'TouchList|Object|i|0|1|\n'+
'TrackEvent|Event|r|1|1|\n'+
'TransformStream|Object|c|0|1|\n'+
'TransformStreamDefaultController|Object|i|0|1|\n'+
'TransitionEvent|Event|r|1|1|\n'+
'TreeWalker|Object|i|0|1|\n'+
'URL|Object|r|1|1|\n'+
'URLSearchParams|Object|c|0|1|\n'+
'UserActivation|Object|i|0|1|\n'+
'ValidityState|Object|i|0|1|\n'+
'VisualViewport|EventTarget|i|0|1|\n'+
'WebKitMutationObserver|Object|r|1|MutationObserver|\n'+
'WebSocket|EventTarget|r|1|1|CONNECTING=0,OPEN=1,CLOSING=2,CLOSED=3\n'+
'WheelEvent|MouseEvent|r|1|1|DOM_DELTA_PIXEL=0,DOM_DELTA_LINE=1,DOM_DELTA_PAGE=2\n'+
'Window||i|0|1|TEMPORARY=0,PERSISTENT=1\n'+
'Worker|EventTarget|r|1|1|\n'+
'WritableStream|Object|c|0|1|\n'+
'WritableStreamDefaultController|Object|i|0|1|\n'+
'WritableStreamDefaultWriter|Object|r|1|1|\n'+
'XMLDocument|Document|i|0|1|\n'+
'XMLHttpRequestEventTarget|EventTarget|i|0|1|\n'+
'XMLHttpRequest|XMLHttpRequestEventTarget|c|0|1|UNSENT=0,OPENED=1,HEADERS_RECEIVED=2,LOADING=3,DONE=4\n'+
'XMLHttpRequestUpload|XMLHttpRequestEventTarget|i|0|1|\n'+
'XMLSerializer|Object|c|0|1|\n'+
'XPathEvaluator|Object|c|0|1|\n'+
'XPathExpression|Object|i|0|1|\n'+
'XPathResult|Object|i|0|1|ANY_TYPE=0,NUMBER_TYPE=1,STRING_TYPE=2,BOOLEAN_TYPE=3,UNORDERED_NODE_ITERATOR_TYPE=4,ORDERED_NODE_ITERATOR_TYPE=5,UNORDERED_NODE_SNAPSHOT_TYPE=6,ORDERED_NODE_SNAPSHOT_TYPE=7,ANY_UNORDERED_NODE_TYPE=8,FIRST_ORDERED_NODE_TYPE=9';
var NODEP=W.Node&&W.Node.prototype;
var fromPrelude=NV.__vitaFromPrelude||function(){return false;};
var ORIG=Object.create(null);
NV.__vitaOrig=ORIG;
var DONE=Object.create(null),CLAIMED=new Map();
var SKIP={length:1,name:1,prototype:1,caller:1,arguments:1};
/* the language's own prototypes are never an interface's: TouchList was
   once Array itself, and giving Array.prototype TouchList's constructor
   made every array's slice() an illegal construction */
['Object','Function','Array','Error','Map','Set','WeakMap','WeakSet',
 'Promise','Date','RegExp','String','Number','Boolean','Symbol','BigInt',
 'ArrayBuffer','DataView','Uint8Array','Proxy'].forEach(function(n){
 var c=globalThis[n];if(c&&c.prototype)CLAIMED.set(c.prototype,n);});
/* the interfaces that are nodes, by WebIDL's inheritance or by sharing the
   nodes' prototype: their constructors and prototypes stay as they are */
var PARENT=Object.create(null);
TABLE.split('\n').forEach(function(r){var f=r.split('|');PARENT[f[0]]=f[1];});
function isNode(name,P){
 var n=name;
 if(P&&NODEP&&(P===NODEP||NODEP.isPrototypeOf(P)))return true;
 while(n){if(n==='Node')return true;n=PARENT[n];}
 return false;}
function define(o,k,d){try{Object.defineProperty(o,k,d);}catch(e){}}
function shape(row){
 var f=row.split('|'),name=f[0],parent=f[1],kind=f[2],len=+f[3],
  tag=f[4]==='1'?name:f[4]==='0'?'':f[4],consts=f[5],
  C=W[name],P,F,pF=parent&&DONE[parent],k,i,keys,d,pP;
 if(typeof C!=='function')return;
 P=C.prototype;
 ORIG[name]=C;
 if(isNode(name,P)){
  /* the interface object alone */
  F=C;
  define(F,'length',{value:len,configurable:true});
 }else{
  /* the prelude makes its own objects through the same names, and is
     let through what a page is refused (__vitaFromPrelude) */
  if(kind==='i'){
   F=function(){
    if(!fromPrelude())throw new TypeError("Failed to construct '"+name+
     "': Illegal constructor");
    return new.target?Reflect.construct(C,arguments,new.target)
                     :C.apply(this,arguments);};
  }else{
   F=function(){
    if(!new.target){
     if(fromPrelude())return C.apply(this,arguments);
     throw new TypeError("Failed to construct '"+name+
      "': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");}
    if(arguments.length<len&&!fromPrelude())
     throw new TypeError("Failed to construct '"+name+"': "+len+
      " argument"+(len>1?'s':'')+" required, but only "+
      arguments.length+" present.");
    return Reflect.construct(C,arguments,new.target);};
  }
  define(F,'name',{value:name,configurable:true});
  define(F,'length',{value:len,configurable:true});
  /* one prototype under two names: the second gets a prototype of its
     own, so each says its own constructor */
  if(!P||typeof P!=='object'||CLAIMED.has(P)){
   pP=pF?pF.prototype:Object.prototype;
   P=Object.create(pP);
  }
  CLAIMED.set(P,name);
  define(F,'prototype',{value:P,writable:false,enumerable:false,
   configurable:false});
  /* what the implementation carried: its statics */
  keys=Reflect.ownKeys(C);
  for(i=0;i<keys.length;i++){k=keys[i];
   if(typeof k==='string'&&SKIP[k])continue;
   d=Object.getOwnPropertyDescriptor(C,k);
   if(d)define(F,k,d);}
  /* under its parent: where it inherited from nothing, or from an
     interface further up that its parent sits below */
  if(pF&&P!==pF.prototype){
   var cur=Object.getPrototypeOf(P);
   if(cur!==pF.prototype&&(cur===Object.prototype||
      (cur&&cur.isPrototypeOf(pF.prototype))))
    try{Object.setPrototypeOf(P,pF.prototype);}catch(e){}}
  define(P,'constructor',{value:F,writable:true,enumerable:false,
   configurable:true});
  if(tag&&!Object.prototype.hasOwnProperty.call(P,Symbol.toStringTag))
   define(P,Symbol.toStringTag,{value:tag,configurable:true});
 }
 if(pF)try{Object.setPrototypeOf(F,pF);}catch(e){}
 if(consts)consts.split(',').forEach(function(c){
  var kv=c.split('='),v=+kv[1];
  define(F,kv[0],{value:v,writable:false,enumerable:true,configurable:false});
  if(!isNode(name,F.prototype))
   define(F.prototype,kv[0],{value:v,writable:false,enumerable:true,
    configurable:false});});
 define(W,name,{value:F,writable:true,enumerable:false,configurable:true});
 DONE[name]=F;}
/* parents WebIDL puts between interfaces this prelude has: they carry
   nothing of their own here, and are what the chain passes through */
['AnimationTimeline','CSSConditionRule'].forEach(function(n){
 if(typeof W[n]!=='function')W[n]=function(){};});
TABLE.split('\n').forEach(shape);
/* the same interface under its old name, as in a browser */
if(W.MutationObserver)define(W,'WebKitMutationObserver',{value:W.MutationObserver,
 writable:true,enumerable:false,configurable:true});
/* interfaces no browser shows on a window, and that do nothing here:
   media tracks (behind flags elsewhere), a callback interface that is
   not an object, the worker-only reader, and SharedArrayBuffer, which a
   page that is not cross-origin isolated does not get */
['AudioTrack','AudioTrackList','VideoTrack','VideoTrackList',
 'XPathNSResolver'].forEach(function(n){try{delete W[n];}catch(e){}});
/* a worker's realm runs this as a window first: it gets FileReaderSync
   back when it becomes a worker (__vitaBecomeWorker) */
if(W.FileReaderSync)ORIG.FileReaderSync=W.FileReaderSync;
try{delete W.FileReaderSync;}catch(e){}
if(!W.crossOriginIsolated)try{delete W.SharedArrayBuffer;}catch(e){}
})();
