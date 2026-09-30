#!/usr/bin/env python3
#
# Copyright 2026 VitaSurf contributors
#
# This file is part of VitaSurf, a PS Vita port of NetSurf.
# Licensed under the GNU General Public License version 2.
#
# Generate vita/js/intl_tz.h, the time zone database Intl.DateTimeFormat
# formats with, from the IANA data installed on the build host
# (/usr/share/zoneinfo). The IANA time zone database is in the public
# domain.
#
# Every zone keeps its transitions from 1970 up to the first one of those
# its POSIX rule (the footer of its TZif file) gives, and that rule for
# every one after. A time before 1970 takes the offset in force at the start of
# 1970. Links keep their own names and point at their zone.
#
#   python3 scripts/gen-tzdata.py [zoneinfo dir] > vita/js/intl_tz.h

import calendar
import os
import re
import struct
import sys

ZI = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/zoneinfo'
START = 0              # 1970-01-01T00:00:00Z
LIMIT = 2 ** 31 - 1    # transitions must fit an int32


def read_tzif(path):
    """Return (transitions, types, footer): transitions as (time, type),
    types as (utoff, isdst, abbr)."""
    data = open(path, 'rb').read()
    if data[:4] != b'TZif':
        raise ValueError(path)
    ver = data[4]

    def header(off):
        return struct.unpack('>6l', data[off + 20:off + 44])

    isutcnt, isstdcnt, leapcnt, timecnt, typecnt, charcnt = header(0)
    if ver == 0:
        raise ValueError('v1 TZif not supported: ' + path)
    # skip the v1 block
    off = 44 + timecnt * 4 + timecnt + typecnt * 6 + charcnt + \
        leapcnt * 8 + isstdcnt + isutcnt
    isutcnt, isstdcnt, leapcnt, timecnt, typecnt, charcnt = header(off)
    off += 44
    times = struct.unpack('>%dq' % timecnt, data[off:off + timecnt * 8])
    off += timecnt * 8
    idx = data[off:off + timecnt]
    off += timecnt
    types = []
    for i in range(typecnt):
        utoff, isdst, abbrind = struct.unpack('>lBB', data[off:off + 6])
        types.append([utoff, isdst, abbrind])
        off += 6
    chars = data[off:off + charcnt]
    off += charcnt + leapcnt * 12 + isstdcnt + isutcnt
    footer = data[off:].strip(b'\n').decode()
    for t in types:
        end = chars.index(b'\0', t[2])
        t[2] = chars[t[2]:end].decode()
    return list(zip(times, idx)), [tuple(t) for t in types], footer


# --- the POSIX TZ rule, as the C side evaluates it ---

def parse_posix(s):
    """Return (std_off, dst_off, start, end) in seconds east of UTC, or
    dst_off None for a zone without summer time."""
    pos = 0

    def name():
        nonlocal pos
        if s[pos] == '<':
            pos = s.index('>', pos) + 1
        else:
            m = re.match(r'[A-Za-z]+', s[pos:])
            pos += m.end()

    def offset():
        nonlocal pos
        m = re.match(r'([+-]?)(\d+)(?::(\d+))?(?::(\d+))?', s[pos:])
        pos += m.end()
        v = int(m.group(2)) * 3600 + int(m.group(3) or 0) * 60 + \
            int(m.group(4) or 0)
        return -v if m.group(1) == '-' else v

    def rule():
        nonlocal pos
        m = re.match(r'M(\d+)\.(\d)\.(\d)|J(\d+)|(\d+)', s[pos:])
        pos += m.end()
        when = 7200
        if pos < len(s) and s[pos] == '/':
            pos += 1
            when = offset()
        if m.group(1):
            return ('M', int(m.group(1)), int(m.group(2)), int(m.group(3)),
                    when)
        if m.group(4):
            return ('J', int(m.group(4)), 0, 0, when)
        return ('N', int(m.group(5)), 0, 0, when)

    name()
    std = -offset()
    if pos >= len(s):
        return std, None, None, None
    name()
    dst = std + 3600
    if pos < len(s) and s[pos] not in ',':
        dst = -offset()
    pos += 1
    start = rule()
    pos += 1
    end = rule()
    return std, dst, start, end


def rule_time(year, r, prev_off):
    """UTC time of a POSIX rule's transition in year, given the offset in
    force before it."""
    kind, a, b, c, when = r
    if kind == 'M':
        first = calendar.weekday(year, a, 1)  # Monday is 0
        wd = (c - 1) % 7                      # rule day, Monday 0
        day = 1 + (wd - first) % 7 + (b - 1) * 7
        if b == 5:
            last = calendar.monthrange(year, a)[1]
            while day > last:
                day -= 7
        days = (calendar.timegm((year, a, day, 0, 0, 0)) // 86400)
    elif kind == 'J':
        d = a - 1
        if calendar.isleap(year) and a >= 60:
            d += 1
        days = calendar.timegm((year, 1, 1, 0, 0, 0)) // 86400 + d
    else:
        days = calendar.timegm((year, 1, 1, 0, 0, 0)) // 86400 + a
    return days * 86400 + when - prev_off


def posix_transitions(footer, year):
    std, dst, start, end = parse_posix(footer)
    if dst is None:
        return []
    out = [(rule_time(year, start, std), dst), (rule_time(year, end, dst), std)]
    out.sort()
    return out


def offset_at(trans, types, t):
    lo = None
    for tt, ti in trans:
        if tt <= t:
            lo = ti
        else:
            break
    if lo is None:
        # the first standard time type, as TZif readers do
        for i, ty in enumerate(types):
            if not ty[1]:
                return i
        return 0
    return lo


def compile_zone(path):
    trans, types, footer = read_tzif(path)
    start_type = offset_at(trans, types, START)
    kept = [(t, i) for t, i in trans if START < t <= LIMIT]
    # drop the tail the POSIX rule reproduces: from a transition on, the
    # rule must give exactly the transitions the data has, none missing
    # (a country that stopped changing its clocks for a while) and none
    # extra
    if footer and kept:
        std, dst, _, _ = parse_posix(footer)
        last = kept[-1][0]
        cut = len(kept)
        if dst is not None:
            import time as _t
            first_year = _t.gmtime(kept[0][0]).tm_year
            last_year = _t.gmtime(last).tm_year
            rule = []
            for y in range(first_year, last_year + 1):
                rule += posix_transitions(footer, y)
            rule.sort()
            data = [(t, types[i][0]) for t, i in kept]
            j = len(data) - 1
            while j >= 0:
                t0 = data[j][0]
                want = [r for r in rule if t0 <= r[0] <= last]
                if want != data[j:]:
                    break
                j -= 1
            cut = j + 1
        # keep the first change the rule makes too: until then the
        # offset of the last irregular one holds, not the rule's
        kept = kept[:cut + 1]
    return start_type, kept, types, footer


def cstr(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'


def main():
    zi = open(os.path.join(ZI, 'tzdata.zi')).read().splitlines()
    version = zi[0].split()[-1] if zi and zi[0].startswith('#') else '?'
    zones = [l.split()[1] for l in zi if l.startswith('Z ')]
    links = [(l.split()[2], l.split()[1]) for l in zi if l.startswith('L ')]
    names = sorted(set(zones) | set(n for n, _ in links), key=str.lower)

    compiled = {}
    for z in zones:
        compiled[z] = compile_zone(os.path.join(ZI, z))

    # shared tables
    off_types = []      # (utoff, isdst)
    type_index = {}
    trans_time = []
    trans_type = []
    footers = []
    footer_index = {}
    zone_rows = {}
    for z in zones:
        start_type, kept, types, footer = compiled[z]

        def tid(i):
            key = (types[i][0], types[i][1])
            if key not in type_index:
                type_index[key] = len(off_types)
                off_types.append(key)
            return type_index[key]

        first = len(trans_time)
        for t, i in kept:
            trans_time.append(t)
            trans_type.append(tid(i))
        if footer not in footer_index:
            footer_index[footer] = len(footers)
            footers.append(footer)
        zone_rows[z] = (tid(start_type), first, len(kept),
                        footer_index[footer])

    target = dict(links)
    out = []
    w = out.append
    w('/* generated by scripts/gen-tzdata.py from IANA tzdata %s; the */' %
      version)
    w('/* IANA time zone database is in the public domain */')
    w('#define TZ_VERSION "%s"' % version)
    w('static const int32_t tz_type_off[] = {%s};' %
      ','.join(str(t[0]) for t in off_types))
    w('static const uint8_t tz_type_dst[] = {%s};' %
      ','.join(str(t[1]) for t in off_types))
    w('static const int32_t tz_trans_time[] = {')
    for i in range(0, len(trans_time), 8):
        w(','.join(str(t) for t in trans_time[i:i + 8]) + ',')
    w('};')
    w('static const uint8_t tz_trans_type[] = {')
    for i in range(0, len(trans_type), 24):
        w(','.join(str(t) for t in trans_type[i:i + 24]) + ',')
    w('};')
    w('static const char *const tz_footer[] = {')
    for f in footers:
        w('\t%s,' % cstr(f))
    w('};')
    w('struct tz_zone {')
    w('\tconst char *name;')
    w('\tint16_t zone;      /* index of the zone a link names, or -1 */')
    w('\tuint8_t start;     /* offset type in force at 1970 */')
    w('\tuint16_t first;    /* first transition */')
    w('\tuint16_t count;    /* transitions */')
    w('\tuint16_t footer;   /* POSIX rule after the last one */')
    w('};')
    w('/* sorted by name, ignoring case */')
    w('static const struct tz_zone tz_zones[] = {')
    pos = {n: i for i, n in enumerate(names)}
    for n in names:
        if n in zone_rows:
            s, f, c, ft = zone_rows[n]
            w('\t{%s, -1, %d, %d, %d, %d},' % (cstr(n), s, f, c, ft))
        else:
            tz = target[n]
            while tz in target:
                tz = target[tz]
            w('\t{%s, %d, 0, 0, 0, 0},' % (cstr(n), pos[tz]))
    w('};')
    sys.stdout.write('\n'.join(out) + '\n')
    sys.stderr.write('%d names, %d zones, %d transitions, %d types, '
                     '%d rules\n' % (len(names), len(zones), len(trans_time),
                                     len(off_types), len(footers)))


main()
