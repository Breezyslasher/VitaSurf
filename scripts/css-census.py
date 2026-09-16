#!/usr/bin/env python3
"""Count the CSS declarations real pages send that libcss throws away.

The property table libcss parses against is the one thing that decides
whether a declaration survives, so the known set is read out of the
parser's own enum rather than kept as a list here. Feed the script page
URLs; it downloads each page's stylesheets, counts every declaration and
prints what is not understood, largest first.
"""

import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

UA = 'Mozilla/5.0 (PlayStation Vita; Mobile) NetSurf/3.11'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


# --- the properties libcss knows -------------------------------------------

def enum_values(header):
    """Index every name in propstrings.h's enum, with C's own rules."""
    body = re.sub(r'/\*.*?\*/', ' ', header, flags=re.S)
    body = body[body.index('enum'):]
    values, counter = {}, 0
    for name, expr in re.findall(r'(\w+)\s*(?:=\s*([^,}]+))?\s*(?:,|\})', body):
        expr = expr.strip()
        if expr:
            counter = values[expr] if expr in values else int(expr, 0)
        values[name] = counter
        counter += 1
    return values


def known_properties():
    base = os.path.join(ROOT, 'deps', 'libcss', 'src', 'parse')
    header = open(os.path.join(base, 'propstrings.h')).read()
    source = open(os.path.join(base, 'propstrings.c')).read()
    values = enum_values(header)
    table = source[source.index('stringmap[LAST_KNOWN]'):]
    strings = re.findall(r'SMAP\("((?:[^"\\]|\\.)*)"\)', table)
    first, last = values['FIRST_PROP'], values['LAST_PROP']
    if last >= len(strings):
        sys.exit('propstrings.c has %d entries, enum wants %d' %
                 (len(strings), last + 1))
    return set(strings[first:last + 1])


# --- pulling declarations out of a stylesheet ------------------------------

def strip_comments(text):
    return re.sub(r'/\*.*?\*/', ' ', text, flags=re.S)


def split_top(text):
    """Split on ; and { } at the top level, respecting strings and ()."""
    out, buf, depth, quote = [], [], 0, None
    i = 0
    while i < len(text):
        c = text[i]
        if quote:
            buf.append(c)
            if c == '\\' and i + 1 < len(text):
                buf.append(text[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
        elif c in '"\'':
            quote = c
            buf.append(c)
        elif c == '(':
            depth += 1
            buf.append(c)
        elif c == ')':
            depth = max(0, depth - 1)
            buf.append(c)
        elif depth == 0 and c in ';{}':
            out.append((''.join(buf), c))
            buf = []
        else:
            buf.append(c)
        i += 1
    if ''.join(buf).strip():
        out.append((''.join(buf), ''))
    return out


PROP = re.compile(r'^(--[\w-]+|-?[A-Za-z_][\w-]*)$')


def declarations(css, into):
    """Walk a stylesheet, counting every property name it declares."""
    stack, chunks = [], split_top(strip_comments(css))
    i = 0
    while i < len(chunks):
        text, sep = chunks[i]
        if sep == '{':
            # A prelude: a selector or an at-rule. Its body is the rest,
            # up to the matching brace, and is walked the same way.
            depth, j = 1, i + 1
            while j < len(chunks) and depth:
                if chunks[j][1] == '{':
                    depth += 1
                elif chunks[j][1] == '}':
                    depth -= 1
                j += 1
            prelude = text.strip()
            body = ''.join(t + s for t, s in chunks[i + 1:j - 1])
            body += chunks[j - 1][0] if j - 1 < len(chunks) else ''
            if not prelude.startswith('@font-face') and \
               not prelude.startswith('@counter-style'):
                declarations(body, into)
            i = j
            continue
        if sep == '}':
            i += 1
            continue
        head, _, _rest = text.partition(':')
        name = head.strip().lower()
        if PROP.match(name):
            into[name] = into.get(name, 0) + 1
        i += 1
    return into


# --- fetching ---------------------------------------------------------------

def get(url):
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en'})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read().decode('utf-8', 'replace')


LINK = re.compile(r'<link\b[^>]*>', re.I)
HREF = re.compile(r'href\s*=\s*(["\'])(.*?)\1', re.I | re.S)
STYLE = re.compile(r'<style\b[^>]*>(.*?)</style>', re.I | re.S)


def page_css(url):
    """Every stylesheet a page uses: linked files and inline blocks."""
    html = get(url)
    sheets = [('inline', block) for block in STYLE.findall(html)]
    for tag in LINK.findall(html):
        if 'stylesheet' not in tag.lower():
            continue
        m = HREF.search(tag)
        if not m:
            continue
        href = urllib.parse.urljoin(url, m.group(2).replace('&amp;', '&'))
        try:
            sheets.append((href, get(href)))
        except (urllib.error.URLError, OSError, ValueError) as e:
            print('  ! %s: %s' % (href[:70], e))
    return sheets


def main(argv):
    urls = []
    for arg in argv[1:]:
        if os.path.exists(arg):
            urls += [l.strip() for l in open(arg)
                     if l.strip() and not l.startswith('#')]
        else:
            urls.append(arg)
    known = known_properties()
    print('libcss knows %d properties\n' % len(known))

    total, sites = {}, {}
    for url in urls:
        print('== %s' % url)
        try:
            sheets = page_css(url)
        except (urllib.error.URLError, OSError, ValueError) as e:
            print('  ! %s' % e)
            continue
        here = {}
        for name, css in sheets:
            declarations(css, here)
        n = sum(here.values())
        miss = {p: c for p, c in here.items()
                if p not in known and not p.startswith('--')}
        print('  %d sheets, %d declarations, %d of them dropped (%d%%)' % (
            len(sheets), n, sum(miss.values()),
            100 * sum(miss.values()) // max(n, 1)))
        for prop, count in miss.items():
            total[prop] = total.get(prop, 0) + count
            sites.setdefault(prop, set()).add(url)

    print('\n== dropped, most declarations first')
    print('%8s %6s  %s' % ('decls', 'sites', 'property'))
    for prop, count in sorted(total.items(), key=lambda kv: -kv[1]):
        vendor = prop.startswith(('-webkit-', '-moz-', '-ms-', '-o-'))
        print('%8d %6d  %s%s' % (count, len(sites[prop]), prop,
                                 '   (vendor)' if vendor else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
