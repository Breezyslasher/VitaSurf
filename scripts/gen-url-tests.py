#!/usr/bin/env python3
"""Write tests/js/url-standard.html from the web platform tests' URL data.

    scripts/gen-url-tests.py WPT_URL_RESOURCES_DIR

WPT_URL_RESOURCES_DIR is url/resources of a web-platform-tests checkout
(urltestdata.json, setters_tests.json). The page runs every parsing case
and every setter case through URL, with the expected parts embedded, and
prints a count of each and any case that differs. It runs from a file,
in VitaSurf's harness and in Chrome alike; vita/js/url.c passes them all
(the harness also runs url.c on its own: see the note in url.c).
"""
import json
import os
import sys

FIELDS = ('href', 'protocol', 'username', 'password', 'host', 'hostname',
          'port', 'pathname', 'search', 'hash', 'origin')


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    src = sys.argv[1]
    parsing = []
    for t in json.load(open(os.path.join(src, 'urltestdata.json'), encoding='utf-8')):
        if not isinstance(t, dict):
            continue
        case = [t['input'], t.get('base')]
        if t.get('failure'):
            case.append(None)
        else:
            case.append([t.get(k) for k in FIELDS])
        parsing.append(case)
    setters = []
    for part, tests in json.load(open(os.path.join(src, 'setters_tests.json'),
                                      encoding='utf-8')).items():
        if part == 'comment':
            continue
        for t in tests:
            setters.append([part, t['href'], t['new_value'], t['expected']])
    data = json.dumps({'fields': FIELDS, 'parsing': parsing, 'setters': setters},
                      ensure_ascii=True, separators=(',', ':'))
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out = os.path.join(root, 'tests', 'js', 'url-standard.html')
    with open(out, 'w', encoding='utf-8') as f:
        f.write(PAGE.replace('@DATA@', data.replace('</', '<\\/')))
    print('wrote %s: %d parsing cases, %d setter cases'
          % (out, len(parsing), len(setters)))


PAGE = r'''<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>URL against the URL Standard's tests</title></head>
<body><pre id="out"></pre>
<script>
/* Every parsing and setter case of the web platform tests' URL data
   (urltestdata.json, setters_tests.json), run through URL (VitaSurf:
   vita/js/url.c, vita/js/url.js). Written by scripts/gen-url-tests.py.
   Each line gives the standard's answer in brackets: every case passes. */
var o = document.getElementById('out');
function T(n, v){ o.textContent += 'XX ' + n + ': ' + v + '\n';
  try { console.log('XX ' + n + ': ' + v); } catch (e) {} }
var DATA = @DATA@;
var F = DATA.fields, bad = [], pass = 0;
DATA.parsing.forEach(function (c) {
  var u = null;
  try { u = c[1] === null ? new URL(c[0]) : new URL(c[0], c[1]); } catch (e) {}
  if (c[2] === null) { if (u === null) pass++; else bad.push('parse ' + JSON.stringify(c[0]) + ' should fail, gave ' + u.href); return; }
  if (u === null) { bad.push('parse ' + JSON.stringify(c[0]) + ' failed'); return; }
  var diff = F.filter(function (k, i) { return c[2][i] !== null && u[k] !== c[2][i]; });
  if (diff.length) bad.push('parse ' + JSON.stringify(c[0]) + ' ' + diff.map(function (k) { return k + '=' + JSON.stringify(u[k]); }).join(' '));
  else pass++;
});
T('parsing cases that pass (' + DATA.parsing.length + ')', pass);
pass = 0;
DATA.setters.forEach(function (c) {
  var u = new URL(c[1]);
  u[c[0]] = c[2];
  var diff = Object.keys(c[3]).filter(function (k) { return u[k] !== c[3][k]; });
  if (diff.length) bad.push('set ' + c[0] + ' of ' + c[1] + ' to ' + JSON.stringify(c[2]) + ': ' + diff.map(function (k) { return k + '=' + JSON.stringify(u[k]); }).join(' '));
  else pass++;
});
T('setter cases that pass (' + DATA.setters.length + ')', pass);
bad.slice(0, 40).forEach(function (b, i) { T('differs ' + i, b); });
</script>
</body></html>
'''

if __name__ == '__main__':
    main()
