/*
 * Shared by every probe: one "XX name: value" line per fact, into #out
 * for the browser's --dump-dom and to the console for VitaSurf's log.
 */
function T(name, value) {
  var s = 'XX ' + name + ': ' + value;
  var o = document.getElementById('out');
  if (o) o.textContent += s + '\n';
  try { console.log(s); } catch (e) {}
}
/* The shape of a node's children, which is where a parser's decisions
   show: an element becomes its tag, a text node its length. */
function shape(n) {
  if (!n) return 'null';
  return Array.prototype.map.call(n.childNodes, function (c) {
    return c.nodeType === 1 ? c.tagName :
           c.nodeType === 3 ? '#text(' + c.textContent.length + ')' :
           c.nodeType === 8 ? '#comment' : '#' + c.nodeType;
  }).join(',');
}
