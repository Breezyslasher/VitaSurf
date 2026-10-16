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
/* 301 interfaces, parents first */
var TABLE=`AbortController|Object|c|0|1|
EventTarget|Object|c|0|1|
AbortSignal|EventTarget|i|0|1|
EventSource|EventTarget|r|1|1|CONNECTING=0,OPEN=1,CLOSED=2
AbstractRange|Object|i|0|1|
Animation|EventTarget|c|0|1|
AnimationEffect|Object|i|0|1|
AnimationTimeline|Object|i|0|1|
Event|Object|r|1|1|NONE=0,CAPTURING_PHASE=1,AT_TARGET=2,BUBBLING_PHASE=3
AnimationEvent|Event|r|1|1|
Node|EventTarget|i|0|1|ELEMENT_NODE=1,ATTRIBUTE_NODE=2,TEXT_NODE=3,CDATA_SECTION_NODE=4,ENTITY_REFERENCE_NODE=5,ENTITY_NODE=6,PROCESSING_INSTRUCTION_NODE=7,COMMENT_NODE=8,DOCUMENT_NODE=9,DOCUMENT_TYPE_NODE=10,DOCUMENT_FRAGMENT_NODE=11,NOTATION_NODE=12,DOCUMENT_POSITION_DISCONNECTED=1,DOCUMENT_POSITION_PRECEDING=2,DOCUMENT_POSITION_FOLLOWING=4,DOCUMENT_POSITION_CONTAINS=8,DOCUMENT_POSITION_CONTAINED_BY=16,DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC=32
Attr|Node|i|0|1|
Element|Node|i|0|1|
HTMLElement|Element|i|0|1|
HTMLMediaElement|HTMLElement|i|0|1|NETWORK_EMPTY=0,NETWORK_IDLE=1,NETWORK_LOADING=2,NETWORK_NO_SOURCE=3,HAVE_NOTHING=0,HAVE_METADATA=1,HAVE_CURRENT_DATA=2,HAVE_FUTURE_DATA=3,HAVE_ENOUGH_DATA=4
Audio|HTMLMediaElement|c|0|HTMLAudioElement|
BarProp|Object|i|0|1|
BeforeUnloadEvent|Event|i|0|1|
Blob|Object|c|0|1|
BroadcastChannel|EventTarget|r|1|1|
ByteLengthQueuingStrategy|Object|r|1|1|
CharacterData|Node|i|0|1|
Text|CharacterData|c|0|1|
CDATASection|Text|i|0|1|
CSSRule|Object|i|0|1|STYLE_RULE=1,CHARSET_RULE=2,IMPORT_RULE=3,MEDIA_RULE=4,FONT_FACE_RULE=5,PAGE_RULE=6,MARGIN_RULE=9,NAMESPACE_RULE=10,KEYFRAMES_RULE=7,KEYFRAME_RULE=8,COUNTER_STYLE_RULE=11,FONT_FEATURE_VALUES_RULE=14,SUPPORTS_RULE=12
CSSFontFaceRule|CSSRule|i|0|1|
CSSGroupingRule|CSSRule|i|0|1|
CSSConditionRule|CSSGroupingRule|i|0|1|
CSSImportRule|CSSRule|i|0|1|
CSSKeyframesRule|CSSRule|i|0|1|
CSSMediaRule|CSSConditionRule|i|0|1|
CSSNamespaceRule|CSSRule|i|0|1|
CSSPageRule|CSSGroupingRule|i|0|1|
CSSRuleList|Object|i|0|1|
CSSStyleDeclaration|Object|i|0|1|
CSSStyleRule|CSSRule|i|0|1|
StyleSheet|Object|i|0|1|
CSSStyleSheet|StyleSheet|c|0|1|
CSSSupportsRule|CSSConditionRule|i|0|1|
CanvasGradient|Object|i|0|1|
CanvasPattern|Object|i|0|1|
CanvasRenderingContext2D|Object|i|0|1|
CaretPosition|Object|i|0|1|
ClipboardEvent|Event|r|1|1|
CloseEvent|Event|r|1|1|
CommandEvent|Event|r|1|1|
Comment|CharacterData|c|0|1|
UIEvent|Event|r|1|1|
CompositionEvent|UIEvent|r|1|1|
ContentVisibilityAutoStateChangeEvent|Event|r|1|1|
CountQueuingStrategy|Object|r|1|1|
CustomElementRegistry|Object|i|0|1|
CustomEvent|Event|r|1|1|
CustomStateSet|Object|i|0|1|
DOMException|Error|c|0|1|INDEX_SIZE_ERR=1,DOMSTRING_SIZE_ERR=2,HIERARCHY_REQUEST_ERR=3,WRONG_DOCUMENT_ERR=4,INVALID_CHARACTER_ERR=5,NO_DATA_ALLOWED_ERR=6,NO_MODIFICATION_ALLOWED_ERR=7,NOT_FOUND_ERR=8,NOT_SUPPORTED_ERR=9,INUSE_ATTRIBUTE_ERR=10,INVALID_STATE_ERR=11,SYNTAX_ERR=12,INVALID_MODIFICATION_ERR=13,NAMESPACE_ERR=14,INVALID_ACCESS_ERR=15,VALIDATION_ERR=16,TYPE_MISMATCH_ERR=17,SECURITY_ERR=18,NETWORK_ERR=19,ABORT_ERR=20,URL_MISMATCH_ERR=21,QUOTA_EXCEEDED_ERR=22,TIMEOUT_ERR=23,INVALID_NODE_TYPE_ERR=24,DATA_CLONE_ERR=25
DOMImplementation|Object|i|0|1|
DOMMatrixReadOnly|Object|c|0|1|
DOMMatrix|DOMMatrixReadOnly|c|0|1|
DOMParser|Object|c|0|1|
DOMPointReadOnly|Object|c|0|1|
DOMPoint|DOMPointReadOnly|c|0|1|
DOMQuad|Object|c|0|1|
DOMRectReadOnly|Object|c|0|1|
DOMRect|DOMRectReadOnly|c|0|1|
DOMRectList|Object|i|0|1|
DOMStringList|Object|i|0|1|
DOMStringMap|Object|i|0|1|
DOMTokenList|Object|i|0|1|
DataTransfer|Object|c|0|1|
DataTransferItem|Object|i|0|1|
DataTransferItemList|Object|i|0|1|
DeviceMotionEvent|Event|r|1|1|
DeviceOrientationEvent|Event|r|1|1|
Document|Node|c|0|1|
DocumentFragment|Node|c|0|1|
DocumentTimeline|AnimationTimeline|c|0|1|
DocumentType|Node|i|0|1|
MouseEvent|UIEvent|r|1|1|
DragEvent|MouseEvent|r|1|1|
ElementInternals|Object|i|0|1|
ErrorEvent|Event|r|1|1|
External|Object|i|0|1|
File|Blob|r|2|1|
FileList|Object|i|0|1|
FileReader|EventTarget|c|0|1|EMPTY=0,LOADING=1,DONE=2
FocusEvent|UIEvent|r|1|1|
FontFace|Object|r|2|1|
FormData|Object|c|0|1|
FormDataEvent|Event|r|2|1|
GamepadEvent|Event|r|1|1|
HTMLAllCollection|Object|i|0|1|
HTMLAnchorElement|HTMLElement|i|0|1|
HTMLAreaElement|HTMLElement|i|0|1|
HTMLAudioElement|HTMLMediaElement|i|0|1|
HTMLBRElement|HTMLElement|i|0|1|
HTMLBaseElement|HTMLElement|i|0|1|
HTMLBodyElement|HTMLElement|i|0|1|
HTMLButtonElement|HTMLElement|i|0|1|
HTMLCanvasElement|HTMLElement|i|0|1|
HTMLCollection|Object|i|0|1|
HTMLDListElement|HTMLElement|i|0|1|
HTMLDataElement|HTMLElement|i|0|1|
HTMLDataListElement|HTMLElement|i|0|1|
HTMLDetailsElement|HTMLElement|i|0|1|
HTMLDialogElement|HTMLElement|i|0|1|
HTMLDirectoryElement|HTMLElement|i|0|1|
HTMLDivElement|HTMLElement|i|0|1|
HTMLDocument|Document|i|0|1|
HTMLEmbedElement|HTMLElement|i|0|1|
HTMLFieldSetElement|HTMLElement|i|0|1|
HTMLFontElement|HTMLElement|i|0|1|
HTMLFormControlsCollection|HTMLCollection|i|0|1|
HTMLFormElement|HTMLElement|i|0|1|
HTMLFrameElement|HTMLElement|i|0|1|
HTMLFrameSetElement|HTMLElement|i|0|1|
HTMLHRElement|HTMLElement|i|0|1|
HTMLHeadElement|HTMLElement|i|0|1|
HTMLHeadingElement|HTMLElement|i|0|1|
HTMLHtmlElement|HTMLElement|i|0|1|
HTMLIFrameElement|HTMLElement|i|0|1|
HTMLImageElement|HTMLElement|i|0|1|
HTMLInputElement|HTMLElement|i|0|1|
HTMLLIElement|HTMLElement|i|0|1|
HTMLLabelElement|HTMLElement|i|0|1|
HTMLLegendElement|HTMLElement|i|0|1|
HTMLLinkElement|HTMLElement|i|0|1|
HTMLMapElement|HTMLElement|i|0|1|
HTMLMarqueeElement|HTMLElement|i|0|1|
HTMLMenuElement|HTMLElement|i|0|1|
HTMLMetaElement|HTMLElement|i|0|1|
HTMLMeterElement|HTMLElement|i|0|1|
HTMLModElement|HTMLElement|i|0|1|
HTMLOListElement|HTMLElement|i|0|1|
HTMLObjectElement|HTMLElement|i|0|1|
HTMLOptGroupElement|HTMLElement|i|0|1|
HTMLOptionElement|HTMLElement|i|0|1|
HTMLOptionsCollection|HTMLCollection|i|0|1|
HTMLOutputElement|HTMLElement|i|0|1|
HTMLParagraphElement|HTMLElement|i|0|1|
HTMLParamElement|HTMLElement|i|0|1|
HTMLPictureElement|HTMLElement|i|0|1|
HTMLPreElement|HTMLElement|i|0|1|
HTMLProgressElement|HTMLElement|i|0|1|
HTMLQuoteElement|HTMLElement|i|0|1|
HTMLScriptElement|HTMLElement|i|0|1|
HTMLSelectElement|HTMLElement|i|0|1|
HTMLSlotElement|HTMLElement|i|0|1|
HTMLSourceElement|HTMLElement|i|0|1|
HTMLSpanElement|HTMLElement|i|0|1|
HTMLStyleElement|HTMLElement|i|0|1|
HTMLTableCaptionElement|HTMLElement|i|0|1|
HTMLTableCellElement|HTMLElement|i|0|1|
HTMLTableColElement|HTMLElement|i|0|1|
HTMLTableElement|HTMLElement|i|0|1|
HTMLTableRowElement|HTMLElement|i|0|1|
HTMLTableSectionElement|HTMLElement|i|0|1|
HTMLTemplateElement|HTMLElement|i|0|1|
HTMLTextAreaElement|HTMLElement|i|0|1|
HTMLTimeElement|HTMLElement|i|0|1|
HTMLTitleElement|HTMLElement|i|0|1|
HTMLTrackElement|HTMLElement|i|0|1|NONE=0,LOADING=1,LOADED=2,ERROR=3
HTMLUListElement|HTMLElement|i|0|1|
HTMLUnknownElement|HTMLElement|i|0|1|
HTMLVideoElement|HTMLMediaElement|i|0|1|
HashChangeEvent|Event|r|1|1|
Headers|Object|c|0|1|
History|Object|i|0|1|
Crypto|Object|i|0|1|
IDBCursor|Object|i|0|1|
IDBCursorWithValue|IDBCursor|i|0|1|
IDBDatabase|EventTarget|i|0|1|
IDBFactory|Object|i|0|1|
IDBIndex|Object|i|0|1|
IDBKeyRange|Object|i|0|1|
IDBObjectStore|Object|i|0|1|
IDBRequest|EventTarget|i|0|1|
IDBOpenDBRequest|IDBRequest|i|0|1|
IDBTransaction|EventTarget|i|0|1|
IDBVersionChangeEvent|Event|r|1|1|
Image|HTMLElement|c|0|HTMLImageElement|
ImageBitmap|Object|i|0|1|
ImageBitmapRenderingContext|Object|i|0|1|
ImageData|Object|r|2|1|
InputEvent|UIEvent|r|1|1|
IntersectionObserver|Object|r|1|1|
IntersectionObserverEntry|Object|i|0|1|
KeyboardEvent|UIEvent|r|1|1|DOM_KEY_LOCATION_STANDARD=0,DOM_KEY_LOCATION_LEFT=1,DOM_KEY_LOCATION_RIGHT=2,DOM_KEY_LOCATION_NUMPAD=3
KeyframeEffect|AnimationEffect|r|1|1|
Location|Object|i|0|1|
MediaError|Object|i|0|1|MEDIA_ERR_ABORTED=1,MEDIA_ERR_NETWORK=2,MEDIA_ERR_DECODE=3,MEDIA_ERR_SRC_NOT_SUPPORTED=4
MediaList|Object|i|0|1|
MediaQueryList|EventTarget|i|0|1|
MediaQueryListEvent|Event|r|1|1|
MessageChannel|Object|c|0|1|
MessageEvent|Event|r|1|1|
MessagePort|EventTarget|i|0|1|
MimeType|Object|i|0|1|
MimeTypeArray|Object|i|0|1|
MutationObserver|Object|r|1|1|
MutationRecord|Object|i|0|1|
NamedNodeMap|Object|i|0|1|
NavigationHistoryEntry|EventTarget|i|0|1|
Navigator|Object|i|0|1|
Navigation|EventTarget|i|0|1|
NodeIterator|Object|i|0|1|
NodeList|Object|i|0|1|
Notification|EventTarget|r|1|1|
OffscreenCanvas|EventTarget|r|2|1|
OffscreenCanvasRenderingContext2D|Object|i|0|1|
Option|HTMLElement|c|0|HTMLOptionElement|
PageRevealEvent|Event|r|1|1|
PageSwapEvent|Event|r|1|1|
PageTransitionEvent|Event|r|1|1|
Path2D|Object|c|0|1|
Performance|EventTarget|i|0|1|
PerformanceEntry|Object|i|0|1|
PerformanceMark|PerformanceEntry|r|1|1|
PerformanceMeasure|PerformanceEntry|i|0|1|
PerformanceNavigation|Object|i|0|1|TYPE_NAVIGATE=0,TYPE_RELOAD=1,TYPE_BACK_FORWARD=2,TYPE_RESERVED=255
PerformanceResourceTiming|PerformanceEntry|i|0|1|
PerformanceNavigationTiming|PerformanceResourceTiming|i|0|1|
PerformanceObserver|Object|r|1|1|
PerformanceObserverEntryList|Object|i|0|1|
PerformanceTiming|Object|i|0|1|
Plugin|Object|i|0|1|
PluginArray|Object|i|0|1|
PointerEvent|MouseEvent|r|1|1|
PopStateEvent|Event|r|1|1|
ProcessingInstruction|CharacterData|i|0|1|
ProgressEvent|Event|r|1|1|
PromiseRejectionEvent|Event|r|2|1|
QuotaExceededError|DOMException|c|0|1|
RadioNodeList|NodeList|i|0|1|
Range|AbstractRange|c|0|1|START_TO_START=0,START_TO_END=1,END_TO_END=2,END_TO_START=3
ReadableByteStreamController|Object|i|0|1|
ReadableStream|Object|c|0|1|
ReadableStreamBYOBReader|Object|r|1|1|
ReadableStreamBYOBRequest|Object|i|0|1|
ReadableStreamDefaultController|Object|i|0|1|
ReadableStreamDefaultReader|Object|r|1|1|
Request|Object|r|1|1|
ResizeObserver|Object|r|1|1|
ResizeObserverEntry|Object|i|0|1|
ResizeObserverSize|Object|i|0|1|
Response|Object|c|0|1|
SVGElement|Element|i|0|1|
SVGGraphicsElement|SVGElement|i|0|1|
SVGSVGElement|SVGGraphicsElement|i|0|1|SVG_ZOOMANDPAN_UNKNOWN=0,SVG_ZOOMANDPAN_DISABLE=1,SVG_ZOOMANDPAN_MAGNIFY=2
Screen|EventTarget|i|0|1|
ScreenOrientation|EventTarget|i|0|1|
SecurityPolicyViolationEvent|Event|r|1|1|
Selection|Object|i|0|1|
ShadowRoot|DocumentFragment|i|0|1|
StaticRange|AbstractRange|r|1|1|
Storage|Object|i|0|1|
StorageEvent|Event|r|1|1|
StylePropertyMapReadOnly|Object|i|0|1|
StylePropertyMap|StylePropertyMapReadOnly|i|0|1|
StyleSheetList|Object|i|0|1|
SubmitEvent|Event|r|1|1|
TextDecoder|Object|c|0|1|
TextDecoderStream|Object|c|0|1|
TextEncoder|Object|c|0|1|
TextEncoderStream|Object|c|0|1|
TextEvent|UIEvent|i|0|1|
TextMetrics|Object|i|0|1|
TextTrack|EventTarget|i|0|1|
TextTrackCue|EventTarget|i|0|1|
TextTrackCueList|Object|i|0|1|
TextTrackList|EventTarget|i|0|1|
TimeRanges|Object|i|0|1|
ToggleEvent|Event|r|1|1|
Touch|Object|r|1|1|
TouchEvent|UIEvent|r|1|1|
TouchList|Object|i|0|1|
TrackEvent|Event|r|1|1|
TransformStream|Object|c|0|1|
TransformStreamDefaultController|Object|i|0|1|
TransitionEvent|Event|r|1|1|
TreeWalker|Object|i|0|1|
URL|Object|r|1|1|
URLSearchParams|Object|c|0|1|
UserActivation|Object|i|0|1|
ValidityState|Object|i|0|1|
VisualViewport|EventTarget|i|0|1|
WebKitMutationObserver|Object|r|1|MutationObserver|
WebSocket|EventTarget|r|1|1|CONNECTING=0,OPEN=1,CLOSING=2,CLOSED=3
WheelEvent|MouseEvent|r|1|1|DOM_DELTA_PIXEL=0,DOM_DELTA_LINE=1,DOM_DELTA_PAGE=2
Window||i|0|1|TEMPORARY=0,PERSISTENT=1
Worker|EventTarget|r|1|1|
WritableStream|Object|c|0|1|
WritableStreamDefaultController|Object|i|0|1|
WritableStreamDefaultWriter|Object|r|1|1|
XMLDocument|Document|i|0|1|
XMLHttpRequestEventTarget|EventTarget|i|0|1|
XMLHttpRequest|XMLHttpRequestEventTarget|c|0|1|UNSENT=0,OPENED=1,HEADERS_RECEIVED=2,LOADING=3,DONE=4
XMLHttpRequestUpload|XMLHttpRequestEventTarget|i|0|1|
XMLSerializer|Object|c|0|1|
XPathEvaluator|Object|c|0|1|
XPathExpression|Object|i|0|1|
XPathResult|Object|i|0|1|ANY_TYPE=0,NUMBER_TYPE=1,STRING_TYPE=2,BOOLEAN_TYPE=3,UNORDERED_NODE_ITERATOR_TYPE=4,ORDERED_NODE_ITERATOR_TYPE=5,UNORDERED_NODE_SNAPSHOT_TYPE=6,ORDERED_NODE_SNAPSHOT_TYPE=7,ANY_UNORDERED_NODE_TYPE=8,FIRST_ORDERED_NODE_TYPE=9
TrustedHTML|Object|i|0|1|
TrustedScript|Object|i|0|1|
TrustedScriptURL|Object|i|0|1|
TrustedTypePolicy|Object|i|0|1|
TrustedTypePolicyFactory|Object|i|0|1|
Permissions|Object|i|0|1|
PermissionStatus|EventTarget|i|0|1|
Clipboard|EventTarget|i|0|1|
ClipboardItem|Object|r|1|1|`;
var NODEP=W.Node&&W.Node.prototype;
var fromPrelude=NV.__vitaFromPrelude||function(){return false;};
var SHAPE=NV.__vitaShapeInterfaces;
delete NV.__vitaShapeInterfaces;
if(typeof SHAPE!=='function')return;
var ORIG=Object.create(null);
NV.__vitaOrig=ORIG;
function define(o,k,d){try{Object.defineProperty(o,k,d);}catch(e){}}
/* each interface object that is not a node's: the prelude makes its own
   objects through the same names, and is let through what a page is
   refused (__vitaFromPrelude) */
function mk(C,name,len,kind){
 if(kind==='i')return function(){
  if(!fromPrelude())throw new TypeError("Failed to construct '"+name+
   "': Illegal constructor");
  return new.target?Reflect.construct(C,arguments,new.target)
                   :C.apply(this,arguments);};
 return function(){
  if(!new.target){
   if(fromPrelude())return C.apply(this,arguments);
   throw new TypeError("Failed to construct '"+name+
    "': Please use the 'new' operator, this DOM object constructor cannot be called as a function.");}
  if(arguments.length<len&&!fromPrelude())
   throw new TypeError("Failed to construct '"+name+"': "+len+
    " argument"+(len>1?'s':'')+" required, but only "+
    arguments.length+" present.");
  return Reflect.construct(C,arguments,new.target);};}
/*
 * The rest is done in C (__vitaShapeInterfaces, vita/js/ifaces.c), row by
 * row in TABLE's order, which the script here did and which cost a tenth
 * of the prelude's time:
 *
 *  - an interface that is a node, by WebIDL's inheritance or by sharing
 *    the nodes' prototype, keeps its constructor and prototype, and gets
 *    its length;
 *  - any other gets mk's wrapper, with its name and length, the
 *    implementation's statics, a prototype that says its constructor and
 *    toStringTag, under its parent's where it inherited from nothing or
 *    from an interface further up that its parent sits below;
 *  - a prototype already taken (by the language, or by an interface
 *    earlier in the table) is not shared: the second interface gets one
 *    of its own. One constructor under the names of an interface and one
 *    under it (StyleSheet and CSSStyleSheet) leaves the prototype with
 *    the name the function has, and failing that the one furthest down;
 *  - its interface object is under its parent's, its constants are on it
 *    and on its prototype, and the global is writable, configurable and
 *    not enumerable.
 *
 * The language's own prototypes are never an interface's: TouchList was
 * once Array itself, and giving Array.prototype TouchList's constructor
 * made every array's slice() an illegal construction. A global still
 * waiting for its unit (lazy.js) is not read, which would run the unit:
 * it is shaped when the unit has run.
 */
var ST={win:W,done:Object.create(null),orig:ORIG,claimed:[],nodeP:NODEP,
 mk:mk,later:Object.create(null)};
['Object','Function','Array','Error','Map','Set','WeakMap','WeakSet',
 'Promise','Date','RegExp','String','Number','Boolean','Symbol','BigInt',
 'ArrayBuffer','DataView','Uint8Array','Proxy'].forEach(function(n){
 var c=globalThis[n];if(c&&c.prototype)ST.claimed.push(c.prototype);});
/* parents WebIDL puts between interfaces this prelude has: they carry
   nothing of their own here, and are what the chain passes through */
['AnimationTimeline','CSSConditionRule'].forEach(function(n){
 if(typeof W[n]!=='function')W[n]=function(){};});
SHAPE(TABLE,ST);
/* the interfaces of a unit that has run since (lazy.js) */
if(Object.keys(ST.later).length)
 Object.defineProperty(NV,'__vitaShapeLater',{value:function(){
  if(Object.keys(ST.later).length)SHAPE(TABLE,ST,true);}});
/* the same interface under its old name, as in a browser */
if(W.MutationObserver)define(W,'WebKitMutationObserver',{value:W.MutationObserver,
 writable:true,enumerable:false,configurable:true});
if(W.DOMMatrix)define(W,'WebKitCSSMatrix',{value:W.DOMMatrix,
 writable:true,enumerable:false,configurable:true});
/* Document answers instanceof for every document (the prelude makes the
   others with a prototype of their own), and XMLDocument, under it,
   inherited that: none of them is an XMLDocument, as none is one in a
   browser that parses them, so it asks the ordinary way */
if(W.XMLDocument)define(W.XMLDocument,Symbol.hasInstance,{configurable:true,
 value:{[Symbol.hasInstance](v){
  return Function.prototype[Symbol.hasInstance].call(this,v);}}[Symbol.hasInstance]});
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
