/*
 * The prelude, and each unit run later, is one function of NV: the
 * natives the bindings made and the functions the prelude leaves for C,
 * every __vita* name. qjs.c takes them off the global before the prelude
 * runs and calls this function with them, so a page finds none of them
 * on window, where no browser has any (VitaSurf). natives-close.js ends
 * it; CMake puts the two around the parts. Its this is the global, the
 * window every part means: a unit can run in a worker, whose global no
 * longer has window by then, and Intl installed nothing there.
 */
(function(NV){
var window=this;
