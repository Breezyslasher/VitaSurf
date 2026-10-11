#!/usr/bin/env python3
"""Regenerate the interface tables from Chrome.

    scripts/gen-interface-tables.py DUMP [--check]

DUMP is the text of <pre id=out> that scripts/interface-dump.html writes
in Chrome (headless_shell --dump-dom). Two tables come from it:

  vita/js/interfaces.js  TABLE: for each interface already in it, in its
                         order (parents first), Chrome's parent, whether
                         it constructs (c), needs arguments (r) or is
                         illegal (i), its length, its toStringTag and its
                         constants.
  vita/js/nodes.js       ROWS and PLACE: the node interfaces with their
                         parents, and for every member of their
                         prototypes in Chrome, the interfaces that have it.

The set of interfaces is VitaSurf's: add a row to TABLE by hand (Name|
Parent|i|0|1|) and run this to fill it in. --check prints what would
change and writes nothing.
"""
import collections
import json
import re
import sys

ROOT = __file__.rsplit('/scripts/', 1)[0]
IFACES = ROOT + '/vita/js/interfaces.js'
NODES = ROOT + '/vita/js/nodes.js'
# interfaces whose prototype nodes.js does not build: the window's
# document has its own chain, Attr and DocumentType's fallback are the
# prelude's, and Image, Option and Audio share their elements'
NOT_NODES = ('Attr', 'Image', 'Option', 'Audio', 'HTMLDocument', 'XMLDocument')


def read_dump(path):
    ifaces, members, consts = {}, collections.defaultdict(list), \
        collections.defaultdict(list)
    for line in open(path, encoding='utf-8'):
        line = line.rstrip('\n')
        if line.startswith('IFACE | '):
            parts = [p.strip() for p in line.split(' | ')]
            ifaces[parts[1]] = dict(p.split('=', 1) for p in parts[2:] if '=' in p)
        elif line.startswith('M '):
            _, name, m = line.split(' ', 2)
            members[name].append(m.rpartition(':')[0])
        elif line.startswith('K '):
            _, name, key, value = line.split(' ')[:4]
            consts[name].append((key, value))
    return ifaces, members, consts


def table_rows(src):
    m = re.search(r'var TABLE=`([^`]*)`;', src)
    return m, [r.split('|') for r in m.group(1).split('\n')]


def row_for(old, chrome, consts):
    name = old[0]
    c = chrome.get(name)
    if c is None:
        return old
    parent = c['parent'] if re.match(r'^[A-Za-z0-9]+$', c['parent']) else old[1]
    kind = {'constructs': 'c', 'illegal': 'i'}.get(c['ctor'], 'r')
    tag = c['tag']
    tag = '1' if tag == name else '0' if tag == 'none' else tag
    k = ','.join('%s=%s' % kv for kv in consts.get(name, []))
    return [name, parent, kind, c['len'], tag, k]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    check = '--check' in sys.argv
    if len(args) != 1:
        sys.exit(__doc__)
    chrome, members, consts = read_dump(args[0])

    src = open(IFACES, encoding='utf-8').read()
    m, rows = table_rows(src)
    new_rows = [row_for(r, chrome, consts) for r in rows]
    for a, b in zip(rows, new_rows):
        if a != b:
            print('TABLE  %s\n    -> %s' % ('|'.join(a), '|'.join(b)))
    table = '\n'.join('|'.join(r) for r in new_rows)
    src = src[:m.start(1)] + table + src[m.end(1):]

    parent = {r[0]: r[1] for r in new_rows}

    def is_node(n):
        while n:
            if n == 'Node':
                return True
            n = parent.get(n)
        return False

    names = [r[0] for r in new_rows
             if (r[0] == 'EventTarget' or is_node(r[0])) and r[0] not in NOT_NODES]
    place = collections.OrderedDict()
    for i, n in enumerate(names):
        for k in sorted(members.get(n, [])):
            place.setdefault(k, []).append(i)
    rows_js = ' '.join('%s<%s' % (n, parent[n]) for n in names)
    lines, cur = [], ''
    for part in re.findall(r'"[^"]*":\[[0-9,]*\],?',
                           json.dumps(place, separators=(',', ':'))[1:-1]):
        if len(cur) + len(part) > 74:
            lines.append(cur)
            cur = ''
        cur += part
    lines.append(cur)
    block = ("var ROWS='" + rows_js + "'.split(' ').map(function(r){return r.split('<');});\n"
             "/* each member's interfaces, as indexes into ROWS, which C reads\n"
             "   (__vitaPlaceMembers, vita/js/ifaces.c) */\n"
             "var PLACE=`{\n" + '\n'.join(lines) + "\n}`;\n")
    nodes = open(NODES, encoding='utf-8').read()
    a = nodes.index("var ROWS='")
    b = nodes.index('}`;\n', a) + len('}`;\n')
    if nodes[a:b] != block:
        print('nodes.js: ROWS/PLACE change (%d interfaces, %d members)'
              % (len(names), len(place)))
    nodes = nodes[:a] + block + nodes[b:]
    if not check:
        open(IFACES, 'w', encoding='utf-8').write(src)
        open(NODES, 'w', encoding='utf-8').write(nodes)


if __name__ == '__main__':
    main()
