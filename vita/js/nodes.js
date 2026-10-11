/*
 * Each node's own interface (VitaSurf), part of the prelude, run after
 * everything else in it has set up the nodes' members and before
 * interfaces.js gives the interface objects their shapes.
 *
 * Every node, an anchor, an input, a text node or a fragment, had the
 * one prototype, which carried every member of every interface: a text
 * node had a value and a href, HTMLAnchorElement.prototype was the same
 * object as HTMLInputElement.prototype, and an element's prototype was
 * not its interface's, so a page that walks an element's chain, reads a
 * member's descriptor off the interface that has it, or patches one
 * interface's prototype, found what no browser has. Now each interface
 * has a prototype of its own, under its parent's as WebIDL has it, and
 * the members are moved to the interfaces Chrome has them on (ROWS, the
 * interfaces with their parents, parents first, and PLACE, which of them
 * each name is on in Chrome's prototypes; generated from Chrome). The
 * bindings give each node its prototype as they wrap it, by its type or,
 * for an element, by its namespace and name (__vitaNodeProtos,
 * node_proto_for in qjs.c).
 *
 * The shared prototype stays as HTMLElement.prototype, with what is
 * HTMLElement's, and what is not in Chrome (this browser's own) stays
 * there too. A document other than the window's keeps a prototype that
 * has everything it had before, since the window's document's members
 * are made for that document alone.
 */
(function(){
'use strict';
var W=window;
var ROWS='EventTarget<Object Node<EventTarget Element<Node HTMLElement<Element HTMLMediaElement<HTMLElement CharacterData<Node Text<CharacterData CDATASection<Text Comment<CharacterData Document<Node DocumentFragment<Node DocumentType<Node HTMLAnchorElement<HTMLElement HTMLAreaElement<HTMLElement HTMLAudioElement<HTMLMediaElement HTMLBRElement<HTMLElement HTMLBaseElement<HTMLElement HTMLBodyElement<HTMLElement HTMLButtonElement<HTMLElement HTMLCanvasElement<HTMLElement HTMLDListElement<HTMLElement HTMLDataElement<HTMLElement HTMLDataListElement<HTMLElement HTMLDetailsElement<HTMLElement HTMLDialogElement<HTMLElement HTMLDirectoryElement<HTMLElement HTMLDivElement<HTMLElement HTMLEmbedElement<HTMLElement HTMLFieldSetElement<HTMLElement HTMLFontElement<HTMLElement HTMLFormElement<HTMLElement HTMLFrameElement<HTMLElement HTMLFrameSetElement<HTMLElement HTMLHRElement<HTMLElement HTMLHeadElement<HTMLElement HTMLHeadingElement<HTMLElement HTMLHtmlElement<HTMLElement HTMLIFrameElement<HTMLElement HTMLImageElement<HTMLElement HTMLInputElement<HTMLElement HTMLLIElement<HTMLElement HTMLLabelElement<HTMLElement HTMLLegendElement<HTMLElement HTMLLinkElement<HTMLElement HTMLMapElement<HTMLElement HTMLMarqueeElement<HTMLElement HTMLMenuElement<HTMLElement HTMLMetaElement<HTMLElement HTMLMeterElement<HTMLElement HTMLModElement<HTMLElement HTMLOListElement<HTMLElement HTMLObjectElement<HTMLElement HTMLOptGroupElement<HTMLElement HTMLOptionElement<HTMLElement HTMLOutputElement<HTMLElement HTMLParagraphElement<HTMLElement HTMLParamElement<HTMLElement HTMLPictureElement<HTMLElement HTMLPreElement<HTMLElement HTMLProgressElement<HTMLElement HTMLQuoteElement<HTMLElement HTMLScriptElement<HTMLElement HTMLSelectElement<HTMLElement HTMLSlotElement<HTMLElement HTMLSourceElement<HTMLElement HTMLSpanElement<HTMLElement HTMLStyleElement<HTMLElement HTMLTableCaptionElement<HTMLElement HTMLTableCellElement<HTMLElement HTMLTableColElement<HTMLElement HTMLTableElement<HTMLElement HTMLTableRowElement<HTMLElement HTMLTableSectionElement<HTMLElement HTMLTemplateElement<HTMLElement HTMLTextAreaElement<HTMLElement HTMLTimeElement<HTMLElement HTMLTitleElement<HTMLElement HTMLTrackElement<HTMLElement HTMLUListElement<HTMLElement HTMLUnknownElement<HTMLElement HTMLVideoElement<HTMLMediaElement ProcessingInstruction<CharacterData SVGElement<Element SVGGraphicsElement<SVGElement SVGSVGElement<SVGGraphicsElement ShadowRoot<DocumentFragment'.split(' ').map(function(r){return r.split('<');});
/* each member's interfaces, as indexes into ROWS */
var PLACE=JSON.parse(`{
"addEventListener":[0],"dispatchEvent":[0],"removeEventListener":[0],
"when":[0],"ATTRIBUTE_NODE":[1],"CDATA_SECTION_NODE":[1],
"COMMENT_NODE":[1],"DOCUMENT_FRAGMENT_NODE":[1],"DOCUMENT_NODE":[1],
"DOCUMENT_POSITION_CONTAINED_BY":[1],"DOCUMENT_POSITION_CONTAINS":[1],
"DOCUMENT_POSITION_DISCONNECTED":[1],"DOCUMENT_POSITION_FOLLOWING":[1],
"DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC":[1],
"DOCUMENT_POSITION_PRECEDING":[1],"DOCUMENT_TYPE_NODE":[1],
"ELEMENT_NODE":[1],"ENTITY_NODE":[1],"ENTITY_REFERENCE_NODE":[1],
"NOTATION_NODE":[1],"PROCESSING_INSTRUCTION_NODE":[1],"TEXT_NODE":[1],
"appendChild":[1],"baseURI":[1],"childNodes":[1],"cloneNode":[1],
"compareDocumentPosition":[1],"contains":[1],"firstChild":[1],
"getRootNode":[1],"hasChildNodes":[1],"insertBefore":[1],
"isConnected":[1],"isDefaultNamespace":[1],"isEqualNode":[1],
"isSameNode":[1],"lastChild":[1],"lookupNamespaceURI":[1],
"lookupPrefix":[1],"nextSibling":[1],"nodeName":[1],"nodeType":[1],
"nodeValue":[1],"normalize":[1],"ownerDocument":[1],"parentElement":[1],
"parentNode":[1],"previousSibling":[1],"removeChild":[1],
"replaceChild":[1],"textContent":[1],"after":[2,5,11],"animate":[2],
"append":[2,9,10],"ariaActiveDescendantElement":[2],"ariaAtomic":[2],
"ariaAutoComplete":[2],"ariaBrailleLabel":[2],
"ariaBrailleRoleDescription":[2],"ariaBusy":[2],"ariaChecked":[2],
"ariaColCount":[2],"ariaColIndex":[2],"ariaColIndexText":[2],
"ariaColSpan":[2],"ariaControlsElements":[2],"ariaCurrent":[2],
"ariaDescribedByElements":[2],"ariaDescription":[2],
"ariaDetailsElements":[2],"ariaDisabled":[2],
"ariaErrorMessageElements":[2],"ariaExpanded":[2],
"ariaFlowToElements":[2],"ariaHasPopup":[2],"ariaHidden":[2],
"ariaInvalid":[2],"ariaKeyShortcuts":[2],"ariaLabel":[2],
"ariaLabelledByElements":[2],"ariaLevel":[2],"ariaLive":[2],
"ariaModal":[2],"ariaMultiLine":[2],"ariaMultiSelectable":[2],
"ariaNotify":[2,9],"ariaOrientation":[2],"ariaPlaceholder":[2],
"ariaPosInSet":[2],"ariaPressed":[2],"ariaReadOnly":[2],
"ariaRelevant":[2],"ariaRequired":[2],"ariaRoleDescription":[2],
"ariaRowCount":[2],"ariaRowIndex":[2],"ariaRowIndexText":[2],
"ariaRowSpan":[2],"ariaSelected":[2],"ariaSetSize":[2],"ariaSort":[2],
"ariaValueMax":[2],"ariaValueMin":[2],"ariaValueNow":[2],
"ariaValueText":[2],"assignedSlot":[2,6],"attachShadow":[2],
"attributes":[2],"before":[2,5,11],"checkVisibility":[2],
"childElementCount":[2,9,10],"children":[2,9,10],"classList":[2],
"className":[2,82],"clientHeight":[2],"clientLeft":[2],"clientTop":[2],
"clientWidth":[2],"closest":[2],"computedStyleMap":[2],
"currentCSSZoom":[2],"elementTiming":[2],"firstElementChild":[2,9,10],
"getAnimations":[2,9,85],"getAttribute":[2],"getAttributeNS":[2],
"getAttributeNames":[2],"getAttributeNode":[2],"getAttributeNodeNS":[2],
"getBoundingClientRect":[2],"getClientRects":[2],
"getElementsByClassName":[2,9],"getElementsByTagName":[2,9],
"getElementsByTagNameNS":[2,9],"getHTML":[2,85],"hasAttribute":[2],
"hasAttributeNS":[2],"hasAttributes":[2],"hasPointerCapture":[2],"id":[2],
"innerHTML":[2,85],"insertAdjacentElement":[2],"insertAdjacentHTML":[2],
"insertAdjacentText":[2],"lastElementChild":[2,9,10],"localName":[2],
"matches":[2],"moveBefore":[2,9,10],"namespaceURI":[2],
"nextElementSibling":[2,5],"onbeforecopy":[2,9],"onbeforecut":[2,9],
"onbeforepaste":[2,9],"onfullscreenchange":[2,9],
"onfullscreenerror":[2,9],"onsearch":[2,9],
"onwebkitfullscreenchange":[2,9],"onwebkitfullscreenerror":[2,9],
"outerHTML":[2],"part":[2],"prefix":[2],"prepend":[2,9,10],
"previousElementSibling":[2,5],"querySelector":[2,9,10],
"querySelectorAll":[2,9,10],"releasePointerCapture":[2],
"remove":[2,5,11,62],"removeAttribute":[2],"removeAttributeNS":[2],
"removeAttributeNode":[2],"replaceChildren":[2,9,10],
"replaceWith":[2,5,11],"requestFullscreen":[2],"requestPointerLock":[2],
"role":[2],"scroll":[2],"scrollBy":[2],"scrollHeight":[2],
"scrollIntoView":[2],"scrollIntoViewIfNeeded":[2],"scrollLeft":[2],
"scrollTo":[2],"scrollTop":[2],"scrollWidth":[2],"setAttribute":[2],
"setAttributeNS":[2],"setAttributeNode":[2],"setAttributeNodeNS":[2],
"setHTMLUnsafe":[2,85],"setPointerCapture":[2],"shadowRoot":[2],
"slot":[2],"tagName":[2],"toggleAttribute":[2],
"webkitMatchesSelector":[2],"webkitRequestFullScreen":[2],
"webkitRequestFullscreen":[2],"accessKey":[3],"attachInternals":[3],
"attributeStyleMap":[3,82],"autocapitalize":[3],"autofocus":[3,82],
"blur":[3,82],"click":[3],"contentEditable":[3],"dataset":[3,82],
"dir":[3,9],"draggable":[3],"editContext":[3],"enterKeyHint":[3],
"focus":[3,82],"hidden":[3,9],"hidePopover":[3],"inert":[3],
"innerText":[3],"inputMode":[3],"isContentEditable":[3],"lang":[3],
"nonce":[3,82],"offsetHeight":[3],"offsetLeft":[3],"offsetParent":[3],
"offsetTop":[3],"offsetWidth":[3],"onabort":[3,9,82],
"onanimationend":[3,9,82],"onanimationiteration":[3,9,82],
"onanimationstart":[3,9,82],"onauxclick":[3,9,82],
"onbeforeinput":[3,9,82],"onbeforematch":[3,9,82],
"onbeforetoggle":[3,9,82],"onbeforexrselect":[3,9,82],
"onblur":[3,9,17,32,82],"oncancel":[3,9,82],"oncanplay":[3,9,82],
"oncanplaythrough":[3,9,82],"onchange":[3,9,82],"onclick":[3,9,82],
"onclose":[3,9,82],"oncommand":[3,9,82],
"oncontentvisibilityautostatechange":[3,9,82],"oncontextlost":[3,9,82],
"oncontextmenu":[3,9,82],"oncontextrestored":[3,9,82],"oncopy":[3,9,82],
"oncuechange":[3,9,82],"oncut":[3,9,82],"ondblclick":[3,9,82],
"ondrag":[3,9,82],"ondragend":[3,9,82],"ondragenter":[3,9,82],
"ondragleave":[3,9,82],"ondragover":[3,9,82],"ondragstart":[3,9,82],
"ondrop":[3,9,82],"ondurationchange":[3,9,82],"onemptied":[3,9,82],
"onended":[3,9,82],"onerror":[3,9,17,32,82],"onfocus":[3,9,17,32,82],
"onformdata":[3,9,82],"ongotpointercapture":[3,9,82],"oninput":[3,9,82],
"oninvalid":[3,9,82],"onkeydown":[3,9,82],"onkeypress":[3,9,82],
"onkeyup":[3,9,82],"onload":[3,9,17,32,82],"onloadeddata":[3,9,82],
"onloadedmetadata":[3,9,82],"onloadstart":[3,9,82],
"onlostpointercapture":[3,9,82],"onmousedown":[3,9,82],
"onmouseenter":[3,9,82],"onmouseleave":[3,9,82],"onmousemove":[3,9,82],
"onmouseout":[3,9,82],"onmouseover":[3,9,82],"onmouseup":[3,9,82],
"onmousewheel":[3,9,82],"onpaste":[3,9,82],"onpause":[3,9,82],
"onplay":[3,9,82],"onplaying":[3,9,82],"onpointercancel":[3,9,82],
"onpointerdown":[3,9,82],"onpointerenter":[3,9,82],
"onpointerleave":[3,9,82],"onpointermove":[3,9,82],
"onpointerout":[3,9,82],"onpointerover":[3,9,82],
"onpointerrawupdate":[3,9,82],"onpointerup":[3,9,82],
"onprogress":[3,9,82],"onratechange":[3,9,82],"onreset":[3,9,82],
"onresize":[3,9,17,32,82],"onscroll":[3,9,17,32,82],
"onscrollend":[3,9,82],"onscrollsnapchange":[3,9,82],
"onscrollsnapchanging":[3,9,82],"onsecuritypolicyviolation":[3,9,82],
"onseeked":[3,9,82],"onseeking":[3,9,82],"onselect":[3,9,82],
"onselectionchange":[3,9,82],"onselectstart":[3,9,82],
"onslotchange":[3,9,82,85],"onstalled":[3,9,82],"onsubmit":[3,9,82],
"onsuspend":[3,9,82],"ontimeupdate":[3,9,82],"ontoggle":[3,9,82],
"ontransitioncancel":[3,9,82],"ontransitionend":[3,9,82],
"ontransitionrun":[3,9,82],"ontransitionstart":[3,9,82],
"onvolumechange":[3,9,82],"onwaiting":[3,9,82],
"onwebkitanimationend":[3,9,82],"onwebkitanimationiteration":[3,9,82],
"onwebkitanimationstart":[3,9,82],"onwebkittransitionend":[3,9,82],
"onwheel":[3,9,82],"outerText":[3],"popover":[3],"showPopover":[3],
"spellcheck":[3],"style":[3,82],"tabIndex":[3,82],"title":[3,9],
"togglePopover":[3],"translate":[3],"virtualKeyboardPolicy":[3],
"writingSuggestions":[3],"HAVE_CURRENT_DATA":[4],"HAVE_ENOUGH_DATA":[4],
"HAVE_FUTURE_DATA":[4],"HAVE_METADATA":[4],"HAVE_NOTHING":[4],
"NETWORK_EMPTY":[4],"NETWORK_IDLE":[4],"NETWORK_LOADING":[4],
"NETWORK_NO_SOURCE":[4],"addTextTrack":[4],"autoplay":[4],"buffered":[4],
"canPlayType":[4],"captureStream":[4,19],"controls":[4],
"controlsList":[4],"crossOrigin":[4,38,43,61],"currentSrc":[4,38],
"currentTime":[4],"defaultMuted":[4],"defaultPlaybackRate":[4],
"disableRemotePlayback":[4],"duration":[4],"ended":[4],"error":[4],
"load":[4],"loop":[4,45],"mediaKeys":[4],"muted":[4],"networkState":[4],
"onencrypted":[4],"onwaitingforkey":[4],"pause":[4],"paused":[4],
"play":[4],"playbackRate":[4],"played":[4],"preload":[4],
"preservesPitch":[4],"readyState":[4,9,77],"remote":[4],"seekable":[4],
"seeking":[4],"setMediaKeys":[4],"setSinkId":[4],"sinkId":[4],
"src":[4,27,31,37,38,39,61,64,77],"srcObject":[4],"textTracks":[4],
"volume":[4],"webkitAudioDecodedByteCount":[4],
"webkitVideoDecodedByteCount":[4],"appendData":[5],"data":[5,51],
"deleteData":[5],"insertData":[5],"length":[5,30,62],"replaceData":[5],
"substringData":[5],"splitText":[6],"wholeText":[6],"URL":[9],
"activeElement":[9,85],"adoptNode":[9],"adoptedStyleSheets":[9,85],
"alinkColor":[9],"all":[9],"anchors":[9],"applets":[9],
"bgColor":[9,17,45,68,70,71],"body":[9],"browsingTopics":[9,37,38],
"captureEvents":[9],"caretPositionFromPoint":[9],
"caretRangeFromPoint":[9],"characterSet":[9],"charset":[9,12,43,61],
"clear":[9,15],"close":[9,24],"compatMode":[9],"contentType":[9],
"cookie":[9],"createAttribute":[9],"createAttributeNS":[9],
"createCDATASection":[9],"createComment":[9],"createDocumentFragment":[9],
"createElement":[9],"createElementNS":[9],"createEvent":[9],
"createExpression":[9],"createNSResolver":[9],"createNodeIterator":[9],
"createProcessingInstruction":[9],"createRange":[9],"createTextNode":[9],
"createTreeWalker":[9],"currentScript":[9],"defaultView":[9],
"designMode":[9],"doctype":[9],"documentElement":[9],"documentURI":[9],
"domain":[9],"elementFromPoint":[9,85],"elementsFromPoint":[9,85],
"embeds":[9],"evaluate":[9],"execCommand":[9],"exitFullscreen":[9],
"exitPictureInPicture":[9],"exitPointerLock":[9],"featurePolicy":[9,37],
"fgColor":[9],"fonts":[9],"forms":[9],"fragmentDirective":[9],
"fullscreen":[9],"fullscreenElement":[9,85],"fullscreenEnabled":[9],
"getElementById":[9,10,84],"getElementsByName":[9],"getSelection":[9,85],
"hasFocus":[9],"hasPrivateToken":[9],"hasRedemptionRecord":[9],
"hasStorageAccess":[9],"hasUnpartitionedCookieAccess":[9],"head":[9],
"images":[9],"implementation":[9],"importNode":[9],"inputEncoding":[9],
"lastModified":[9],"linkColor":[9],"links":[9],"onfreeze":[9],
"onpointerlockchange":[9],"onpointerlockerror":[9],
"onprerenderingchange":[9],"onreadystatechange":[9],"onresume":[9],
"onvisibilitychange":[9],"open":[9,23,24],
"pictureInPictureElement":[9,85],"pictureInPictureEnabled":[9],
"plugins":[9],"pointerLockElement":[9,85],"prerendering":[9],
"queryCommandEnabled":[9],"queryCommandIndeterm":[9],
"queryCommandState":[9],"queryCommandSupported":[9],
"queryCommandValue":[9],"referrer":[9],"releaseEvents":[9],
"requestStorageAccess":[9],"requestStorageAccessFor":[9],
"rootElement":[9],"scripts":[9],"scrollingElement":[9],
"startViewTransition":[9],"styleSheets":[9,85],"timeline":[9],
"visibilityState":[9],"vlinkColor":[9],"wasDiscarded":[9],
"webkitCancelFullScreen":[9],"webkitCurrentFullScreenElement":[9],
"webkitExitFullscreen":[9],"webkitFullscreenElement":[9],
"webkitFullscreenEnabled":[9],"webkitHidden":[9],"webkitIsFullScreen":[9],
"webkitVisibilityState":[9],"write":[9],"writeln":[9],"xmlEncoding":[9],
"xmlStandalone":[9],"xmlVersion":[9],
"name":[11,12,18,23,27,28,30,31,37,38,39,44,47,51,54,56,62,63,74],
"publicId":[11],"systemId":[11],"attributionSrc":[12,13,38,61],
"coords":[12,13],"download":[12,13],"hash":[12,13],"host":[12,13,85],
"hostname":[12,13],"href":[12,13,16,43],"hreflang":[12,43],
"origin":[12,13],"password":[12,13],"pathname":[12,13],"ping":[12,13],
"port":[12,13],"protocol":[12,13],"referrerPolicy":[12,13,37,38,43,61],
"rel":[12,13,30,43],"relList":[12,13,30,43],"rev":[12,43],
"search":[12,13],"shape":[12,13],"target":[12,13,16,30,43,81],
"text":[12,17,53,61,76],"toString":[12,13],
"type":[12,18,27,28,39,40,43,50,51,54,56,61,62,64,66,74,78],
"username":[12,13],"alt":[13,38,39],"noHref":[13],"aLink":[17],
"background":[17],"link":[17],"onafterprint":[17,32],
"onbeforeprint":[17,32],"onbeforeunload":[17,32],"onhashchange":[17,32],
"onlanguagechange":[17,32],"onmessage":[17,32],"onmessageerror":[17,32],
"onoffline":[17,32],"ononline":[17,32],"onpagehide":[17,32],
"onpageshow":[17,32],"onpopstate":[17,32],"onrejectionhandled":[17,32],
"onstorage":[17,32],"onunhandledrejection":[17,32],"onunload":[17,32],
"vLink":[17],"checkValidity":[18,28,30,39,51,54,62,74],"command":[18],
"commandForElement":[18],"disabled":[18,28,39,43,52,53,62,66,74],
"form":[18,28,39,41,42,51,53,54,62,74],"formAction":[18,39],
"formEnctype":[18,39],"formMethod":[18,39],"formNoValidate":[18,39],
"formTarget":[18,39],"labels":[18,39,48,54,59,62,74],
"popoverTargetAction":[18,39],"popoverTargetElement":[18,39],
"reportValidity":[18,28,30,39,51,54,62,74],
"setCustomValidity":[18,28,39,51,54,62,74],
"validationMessage":[18,28,39,51,54,62,74],
"validity":[18,28,39,51,54,62,74],
"value":[18,21,39,40,48,53,54,56,59,62,74],
"willValidate":[18,28,39,51,54,62,74],"getContext":[19],
"height":[19,27,37,38,39,45,51,64,68,80,84],"toBlob":[19],
"toDataURL":[19],"transferControlToOffscreen":[19],
"width":[19,27,33,37,38,39,45,51,58,64,68,69,70,80,84],
"compact":[20,25,46,50,78],"options":[22,62],"closedBy":[24],
"requestClose":[24],"returnValue":[24],"show":[24],"showModal":[24],
"align":[26,27,33,35,37,38,39,42,51,55,67,68,69,70,71,72],
"getSVGDocument":[27,37,51],"elements":[28,30],"color":[29,33],
"face":[29],"size":[29,33,39,62],"acceptCharset":[30],"action":[30],
"autocomplete":[30,39,62,74],"encoding":[30],"enctype":[30],"method":[30],
"noValidate":[30],"requestSubmit":[30],"reset":[30],"submit":[30],
"contentDocument":[31,37,51],"contentWindow":[31,37,51],
"frameBorder":[31,37],"longDesc":[31,37,38],"marginHeight":[31,37],
"marginWidth":[31,37],"noResize":[31],"scrolling":[31,37],"cols":[32,74],
"rows":[32,70,72,74],"noShade":[33],"version":[36],
"adAuctionHeaders":[37],"allow":[37],"allowFullscreen":[37],
"allowPaymentRequest":[37],"credentialless":[37],"csp":[37],
"loading":[37,38],"privateToken":[37],"sandbox":[37],
"sharedStorageWritable":[37,38],"srcdoc":[37],"border":[38,51,70],
"complete":[38],"decode":[38],"decoding":[38],"fetchPriority":[38,43,61],
"hspace":[38,45,51],"isMap":[38],"lowsrc":[38],"naturalHeight":[38],
"naturalWidth":[38],"sizes":[38,43,64],"srcset":[38,64],
"useMap":[38,39,51],"vspace":[38,45,51],"x":[38,84],"y":[38,84],
"accept":[39],"checked":[39],"defaultChecked":[39],
"defaultValue":[39,54,74],"dirName":[39,74],"files":[39],
"incremental":[39],"indeterminate":[39],"list":[39],"max":[39,48,59],
"maxLength":[39,74],"min":[39,48],"minLength":[39,74],"multiple":[39,62],
"pattern":[39],"placeholder":[39,74],"readOnly":[39,74],
"required":[39,62,74],"select":[39,74],"selectionDirection":[39,74],
"selectionEnd":[39,74],"selectionStart":[39,74],"setRangeText":[39,74],
"setSelectionRange":[39,74],"showPicker":[39,62],"step":[39],
"stepDown":[39],"stepUp":[39],"valueAsDate":[39],"valueAsNumber":[39],
"webkitEntries":[39],"webkitdirectory":[39],"control":[41],
"htmlFor":[41,54,61],"as":[43],"blocking":[43,61,66],"imageSizes":[43],
"imageSrcset":[43],"integrity":[43,61],"media":[43,47,64,66],
"sheet":[43,66,81],"areas":[44],"behavior":[45],"direction":[45],
"scrollAmount":[45],"scrollDelay":[45],"start":[45,50],"stop":[45],
"trueSpeed":[45],"content":[47,73],"httpEquiv":[47],"scheme":[47],
"high":[48],"low":[48],"optimum":[48],"cite":[49,60],"dateTime":[49,75],
"reversed":[50],"archive":[51],"code":[51],"codeBase":[51],
"codeType":[51],"declare":[51],"standby":[51],"label":[52,53,77],
"defaultSelected":[53],"index":[53],"selected":[53],"valueType":[56],
"position":[59],"async":[61],"defer":[61],"event":[61],"noModule":[61],
"add":[62],"item":[62],"namedItem":[62],"selectedIndex":[62],
"selectedOptions":[62],"assign":[63],"assignedElements":[63],
"assignedNodes":[63],"abbr":[68],"axis":[68],"cellIndex":[68],
"ch":[68,69,71,72],"chOff":[68,69,71,72],"colSpan":[68],"headers":[68],
"noWrap":[68],"rowSpan":[68],"scope":[68],"vAlign":[68,69,71,72],
"span":[69],"caption":[70],"cellPadding":[70],"cellSpacing":[70],
"createCaption":[70],"createTBody":[70],"createTFoot":[70],
"createTHead":[70],"deleteCaption":[70],"deleteRow":[70,72],
"deleteTFoot":[70],"deleteTHead":[70],"frame":[70],"insertRow":[70,72],
"rules":[70],"summary":[70],"tBodies":[70],"tFoot":[70],"tHead":[70],
"cells":[71],"deleteCell":[71],"insertCell":[71],"rowIndex":[71],
"sectionRowIndex":[71],"shadowRootClonable":[73],
"shadowRootDelegatesFocus":[73],"shadowRootMode":[73],
"shadowRootSerializable":[73],"textLength":[74],"wrap":[74],"ERROR":[77],
"LOADED":[77],"LOADING":[77],"NONE":[77],"default":[77],"kind":[77],
"srclang":[77],"track":[77],"cancelVideoFrameCallback":[80],
"disablePictureInPicture":[80],"getVideoPlaybackQuality":[80],
"onenterpictureinpicture":[80],"onleavepictureinpicture":[80],
"playsInline":[80],"poster":[80],"requestPictureInPicture":[80],
"requestVideoFrameCallback":[80],"videoHeight":[80],"videoWidth":[80],
"webkitDecodedFrameCount":[80],"webkitDroppedFrameCount":[80],
"ownerSVGElement":[82],"viewportElement":[82],
"farthestViewportElement":[83],"getBBox":[83],"getCTM":[83],
"getScreenCTM":[83],"nearestViewportElement":[83],
"requiredExtensions":[83],"systemLanguage":[83],"transform":[83],
"SVG_ZOOMANDPAN_DISABLE":[84],"SVG_ZOOMANDPAN_MAGNIFY":[84],
"SVG_ZOOMANDPAN_UNKNOWN":[84],"animationsPaused":[84],
"checkEnclosure":[84],"checkIntersection":[84],"createSVGAngle":[84],
"createSVGLength":[84],"createSVGMatrix":[84],"createSVGNumber":[84],
"createSVGPoint":[84],"createSVGRect":[84],"createSVGTransform":[84],
"createSVGTransformFromMatrix":[84],"currentScale":[84],
"currentTranslate":[84],"deselectAll":[84],"forceRedraw":[84],
"getCurrentTime":[84],"getEnclosureList":[84],"getIntersectionList":[84],
"pauseAnimations":[84],"preserveAspectRatio":[84],"setCurrentTime":[84],
"suspendRedraw":[84],"unpauseAnimations":[84],"unsuspendRedraw":[84],
"unsuspendRedrawAll":[84],"viewBox":[84],"zoomAndPan":[84],
"clonable":[85],"delegatesFocus":[85],"mode":[85],"serializable":[85],
"slotAssignment":[85]
}`);
var T=W.EventTarget&&W.EventTarget.prototype,N=W.Node&&W.Node.prototype,
 E=W.Element&&W.Element.prototype,P=W.HTMLElement&&W.HTMLElement.prototype,
 setProtos=NV.__vitaNodeProtos,byTag=NV.__vitaByTag||{},
 HTML_TAGS=NV.__vitaHtmlTags||'';
delete NV.__vitaNodeProtos;delete NV.__vitaByTag;delete NV.__vitaHtmlTags;
if(!T||!N||!E||!P||typeof setProtos!=='function')return;
var own=Object.prototype.hasOwnProperty;
function define(o,k,d){try{Object.defineProperty(o,k,d);}catch(e){}}
var PROTO=Object.create(null),AT=Object.create(null);
PROTO.EventTarget=T;PROTO.Node=N;PROTO.Element=E;PROTO.HTMLElement=P;
ROWS.forEach(function(r,i){AT[r[0]]=i;});
function has(k,name){return own.call(PLACE,k)&&PLACE[k].indexOf(AT[name])>=0;}
/* a document other than the window's: what it had of P's that is a
   document's, or this browser's own, over Element's (place below) */
var DOCP=Object.create(E);
[Symbol.toStringTag,'constructor'].forEach(function(k){
 var d=Object.getOwnPropertyDescriptor(P,k);if(d)define(DOCP,k,d);});
/* the prototypes, parents first; one the prelude already gave an
   interface of its own (ShadowRoot's, DocumentType's) keeps what it has */
ROWS.forEach(function(r){
 var name=r[0],pp=PROTO[r[1]],F=W[name],was,o;
 /* the window's document has its own chain; a member that is only the
    document's leaves the elements */
 if(name==='Document')return;
 if(PROTO[name]||!pp)return;
 was=typeof F==='function'?F.prototype:null;
 if(was&&typeof was==='object'&&was!==P&&was!==E&&was!==N&&was!==T){
  o=was;
  try{Object.setPrototypeOf(o,pp);}catch(e){}
 }else o=Object.create(pp);
 PROTO[name]=o;
 if(typeof F==='function')try{F.prototype=o;}catch(e){}
 else{
  W[name]=F=function(){throw new TypeError('Illegal constructor');};
  define(F,'name',{value:name,configurable:true});}
 if(F.prototype!==o)define(F,'prototype',{value:o,writable:true});});
/* each member where Chrome has it: an interface's own goes to it, and one
   of a mixin goes to each interface that includes it */
function place(k){
 var at=own.call(PLACE,k)?PLACE[k]:null,
  d=Object.getOwnPropertyDescriptor(P,k),stay=false,i,o;
 if(!at||at.indexOf(AT.Document)>=0)define(DOCP,k,d);
 if(!at)return;
 /* WebIDL's attributes and operations are enumerable */
 if(d.configurable)d.enumerable=true;
 for(i=0;i<at.length;i++){
  if(at[i]===AT.HTMLElement){stay=true;continue;}
  o=PROTO[ROWS[at[i]][0]];
  if(o)define(o,k,d);}
 if(!stay)delete P[k];
 else if(d.configurable)define(P,k,d);}
Reflect.ownKeys(P).forEach(function(k){
 if(typeof k==='string'&&k!=='constructor')place(k);});
/* the levels above held copies, for code that looked there: what is not
   theirs in Chrome goes */
[[E,'Element'],[N,'Node'],[T,'EventTarget']].forEach(function(l){
 Reflect.ownKeys(l[0]).forEach(function(k){
  if(typeof k!=='string'||k==='constructor'||!own.call(PLACE,k))return;
  if(!has(k,l[1]))delete l[0][k];});});
/* EventTarget's methods serve every kind of target: a node through the
   bindings, and anything else (new EventTarget(), a class that extends
   it, screen, visualViewport) through the prelude's own listeners. They
   were the node ones alone, so a page's own emitter never heard a thing */
(function(){
 var J=NV.__vitaEventTargetJS,isNode=NV.__vitaIsNode;
 delete NV.__vitaEventTargetJS;
 if(!J||typeof isNode!=='function')return;
 [['addEventListener',2],['removeEventListener',2],['dispatchEvent',1]]
 .forEach(function(m){
  var k=m[0],n=T[k],j=J[k],f;
  if(typeof n!=='function'||typeof j!=='function')return;
  f={[k]:function(){return (isNode(this)?n:j).apply(this,arguments);}}[k];
  define(f,'length',{value:m[1],configurable:true});
  define(T,k,{value:f,writable:true,enumerable:true,configurable:true});});
})();
/* what each node is says its own prototype now, not P's getters; an SVG
   element still names its own kind */
var tag=Object.getOwnPropertyDescriptor(P,Symbol.toStringTag);
delete P.constructor;delete P[Symbol.toStringTag];
if(tag&&tag.get)['SVGElement','SVGGraphicsElement'].forEach(function(n){
 var o=PROTO[n];
 define(o,Symbol.toStringTag,{configurable:true,get:function(){
  return this===o?n:tag.get.call(this);}});});
/* a doctype is the parser's, or the document implementation's: the one
   the prelude makes when that cannot be is not a page's to construct */
(function(){
 var DT=function DocumentType(){throw new TypeError('Illegal constructor');};
 DT.prototype=PROTO.DocumentType;
 W.DocumentType=DT;})();
/* and those the levels above had of their own */
[[E,'Element'],[N,'Node'],[T,'EventTarget']].forEach(function(r){
 var o=r[0];
 Reflect.ownKeys(o).forEach(function(k){
  var d;
  if(typeof k!=='string'||k==='constructor'||!own.call(PLACE,k)||
     !has(k,r[1]))return;
  d=Object.getOwnPropertyDescriptor(o,k);
  if(d&&d.configurable&&!d.enumerable){d.enumerable=true;define(o,k,d);}});});
/*
 * ARIA's reflection (ARIAMixin), which Element has in a browser and
 * this did not: ariaLabel is the aria-label attribute, null when it is
 * not there, and setting null takes it away. The ones that are elements
 * rather than strings (ariaLabelledByElements) are not here.
 */
('ariaAtomic ariaAutoComplete ariaBrailleLabel ariaBrailleRoleDescription '+
 'ariaBusy ariaChecked ariaColCount ariaColIndex ariaColIndexText '+
 'ariaColSpan ariaCurrent ariaDescription ariaDisabled ariaExpanded '+
 'ariaHasPopup ariaHidden ariaInvalid ariaKeyShortcuts ariaLabel ariaLevel '+
 'ariaLive ariaModal ariaMultiLine ariaMultiSelectable ariaOrientation '+
 'ariaPlaceholder ariaPosInSet ariaPressed ariaReadOnly ariaRelevant '+
 'ariaRequired ariaRoleDescription ariaRowCount ariaRowIndex '+
 'ariaRowIndexText ariaRowSpan ariaSelected ariaSetSize ariaSort '+
 'ariaValueMax ariaValueMin ariaValueNow ariaValueText role').split(' ')
 .forEach(function(k){
  var attr=k==='role'?'role':'aria-'+k.slice(4).toLowerCase(),
   get=E.getAttribute,set=E.setAttribute,rm=E.removeAttribute;
  if(own.call(E,k)||typeof get!=='function')return;
  define(E,k,{enumerable:true,configurable:true,
   get:function(){return get.call(this,attr);},
   set:function(v){
    if(v===null)rm.call(this,attr);
    else set.call(this,attr,String(v));}});
  try{Object.defineProperty(Object.getOwnPropertyDescriptor(E,k).get,
   'name',{value:'get '+k});
   Object.defineProperty(Object.getOwnPropertyDescriptor(E,k).set,
   'name',{value:'set '+k});}catch(e){}});
/* each prototype names its interface; Image, Option and Audio make the
   elements they are named for, and have their prototypes */
ROWS.forEach(function(r){
 var o=PROTO[r[0]];
 if(!o)return;
 define(o,'constructor',{value:W[r[0]],writable:true,enumerable:false,
  configurable:true});
 if(!own.call(o,Symbol.toStringTag))
  define(o,Symbol.toStringTag,{value:r[0],configurable:true});});
[['Image','HTMLImageElement'],['Option','HTMLOptionElement'],
 ['Audio','HTMLAudioElement']].forEach(function(p){
 var F=W[p[0]];
 if(typeof F==='function'&&PROTO[p[1]])try{F.prototype=PROTO[p[1]];}catch(e){}});
/* instanceof is the chain's again; a document other than the window's
   is still one */
ROWS.forEach(function(r){
 var F=W[r[0]];
 if(!PROTO[r[0]])return;
 if(typeof F==='function'&&own.call(F,Symbol.hasInstance))
  try{delete F[Symbol.hasInstance];}catch(e){}});
/* the names that have an interface of their own, and the HTML ones that
   are plain HTMLElements */
var byName=Object.create(null),k;
HTML_TAGS.split(' ').forEach(function(t){if(t)byName[t]=P;});
for(k in byTag){
 if(k.indexOf('HTML')!==0||k==='HTMLMediaElement'||!PROTO[k])continue;
 byTag[k].split(/\s+/).forEach(function(t){if(t)byName[t]=PROTO[k];});}
byName['svg:svg']=PROTO.SVGSVGElement;
('a circle ellipse foreignObject g image line path polygon polyline rect '+
 'switch text textPath tspan use').split(' ').forEach(function(t){
 byName['svg:'+t]=PROTO.SVGGraphicsElement;});
setProtos({element:E,html:P,unknown:PROTO.HTMLUnknownElement,
 svg:PROTO.SVGElement,text:PROTO.Text,cdata:PROTO.CDATASection,
 comment:PROTO.Comment,pi:PROTO.ProcessingInstruction,
 fragment:PROTO.DocumentFragment,shadow:PROTO.ShadowRoot,
 doctype:PROTO.DocumentType,document:DOCP,byName:byName});
})();
