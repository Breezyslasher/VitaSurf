#!/usr/bin/env bash
# Compare what a whole real page turns into, in a real browser and in
# VitaSurf's bindings.
#
# The probes in tests/dom check one thing each. A saved page checks the
# combination: its own scripts run, build the DOM they meant to build,
# and the summary below says whether the two engines ended up with the
# same page. A difference is a lead, not a verdict -- a real page has
# timing and network in it -- but a large one is a bug.
#
#   ./scripts/page-compare.sh saved/GitHub.html
#
# The page is copied next to the original with a summary script appended,
# so the relative paths to its assets still resolve, and then run through
# the probe harness.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
page="${1:?usage: page-compare.sh <saved page.html>}"
dir="$(cd "$(dirname "$page")" && pwd)"
base="$(basename "$page" .html)"
probe="$dir/$base.probe.html"

cleanup(){ rm -f "$probe"; }
trap cleanup EXIT

cp "$page" "$probe"
cat >> "$probe" <<'PROBE'
<pre id="out" style="display:none"></pre>
<script>
(function(){
  function T(n,v){var o=document.getElementById('out');
    if(o)o.textContent+='XX '+n+': '+v+'\n';
    try{console.log('XX '+n+': '+v);}catch(e){}}
  /* Let the page's own scripts settle first. */
  function report(){
    var all=document.querySelectorAll('*');
    T('elements', all.length);
    var tags={},i,t;
    for(i=0;i<all.length;i++){t=all[i].tagName;tags[t]=(tags[t]||0)+1;}
    var names=Object.keys(tags).sort();
    T('distinct tags', names.length);
    /* the ten commonest, which is stable enough to compare */
    names.sort(function(a,b){return tags[b]-tags[a]||(a<b?-1:1);});
    T('top tags', names.slice(0,10).map(function(n){return n+'='+tags[n];}).join(' '));
    T('with id', document.querySelectorAll('[id]').length);
    T('with class', document.querySelectorAll('[class]').length);
    T('links with href', document.querySelectorAll('a[href]').length);
    T('images', document.images.length);
    T('forms', document.forms.length);
    T('inputs', document.querySelectorAll('input,select,textarea').length);
    T('buttons', document.querySelectorAll('button').length);
    T('svg', document.querySelectorAll('svg').length);
    T('custom elements', (function(){var n=0;
      for(var i=0;i<all.length;i++)if(all[i].tagName.indexOf('-')>=0)n++;
      return n;})());
    T('title', document.title);
    T('body text length', String(document.body.textContent||'')
      .replace(/\s+/g,' ').trim().length);
    T('scripts', document.scripts.length);
    T('stylesheets', document.styleSheets.length);
    T('readyState', document.readyState);
  }
  /* On a timer, not on load: a page whose assets never all arrive never
     fires load, and the point is to see what it built regardless. */
  setTimeout(report, (window.__vitaPageWait || 6) * 1000);
})();
</script>
PROBE

WAIT="${WAIT:-20}" \
CHROME="${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}" \
NSMONKEY="${NSMONKEY:-$ROOT/deps/netsurf/nsmonkey}" \
    "$ROOT/scripts/dom-compare.sh" "$probe"
