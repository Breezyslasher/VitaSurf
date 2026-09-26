#!/usr/bin/env python3
"""Give each window-scope .any.js web platform test a page to run in.

A test written as foo.any.js runs in every global it names, and the WPT
server builds the page for it on the fly: the harness, the scripts listed
in "// META: script=" lines, then the test. The tests here run from files,
with no server, so the page is written next to the test once, as
foo.any.html. Only the window global is built; a test that runs only in
workers is left alone.

    ./scripts/wpt-wrap-any.py tests/wpt/WebCryptoAPI
"""
import os
import re
import sys

META = re.compile(r'^//\s*META:\s*(\w+)=(.*)$')


def wrap(path):
    scripts, title, globals_ = [], None, 'window'
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            m = META.match(line.strip())
            if not m:
                if line.strip() and not line.startswith('//'):
                    break
                continue
            key, value = m.group(1), m.group(2).strip()
            if key == 'script':
                scripts.append(value)
            elif key == 'title':
                title = value
            elif key == 'global':
                globals_ = value
    names = [g.strip() for g in globals_.split(',')]
    if not any(g in ('window', 'default') or g.startswith('window')
               for g in names):
        return None
    out = path[:-len('.js')] + '.html'
    base = os.path.basename(path)
    lines = ['<!DOCTYPE html>', '<meta charset="utf-8">',
             '<!-- generated from %s by scripts/wpt-wrap-any.py -->' % base]
    if title:
        lines.append('<title>%s</title>' % title)
    lines.append('<script src="/resources/testharness.js"></script>')
    lines.append('<script src="/resources/testharnessreport.js"></script>')
    for s in scripts:
        lines.append('<script src="%s"></script>' % s)
    lines.append('<div id="log"></div>')
    lines.append('<script src="%s"></script>' % base)
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    return out


def main(roots):
    made = 0
    for root in roots:
        for d, _, files in os.walk(root):
            for name in sorted(files):
                if not name.endswith('.any.js'):
                    continue
                if wrap(os.path.join(d, name)):
                    made += 1
    print('wrapped %d tests' % made)


if __name__ == '__main__':
    main(sys.argv[1:] or ['tests/wpt'])
