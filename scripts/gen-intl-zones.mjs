//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Time zones for resources/intl.pak (vita/js/intl_zone.js), from ICU's own
// data (the data release whose ICU Node has, icu4c-<version>-data.zip),
// which V8 formats with: the zones and their history (misc/zoneinfo64.txt,
// ICU's build of the IANA database, rearguard, so that a summer offset is
// the one called daylight), their CLDR canonical IDs
// (misc/timezoneTypes.txt), metazones (misc/metaZones.txt) and every
// locale's names for them (zone/*.txt). The IANA database is in the public
// domain; ICU's data is under the Unicode licence, which is
// GPL-compatible. scripts/gen-intl-numbers.mjs calls zoneEntries() when
// given the unpacked data directory.
//
// Entries:
//   tz:index    { v: the tz version, n: every zone ID ICU knows, space
//               separated, l: { link: the zone it names }, c: { ID: its
//               CLDR canonical ID, where that is another }, r: { canonical
//               location zone: its region }, p: the canonical zones that
//               are their region's primary or only one, space separated }
//   tz:<zone>   a zone's history: { t: transition times in seconds, o:
//               [raw, dst] offsets in seconds by type, m: the type of each
//               transition, f: the final rule (SimpleTimeZone's eleven
//               numbers), r: its raw offset, y: the year it starts }
//   tz:meta     { z: { canonical zone: [[metazone, from ms, to ms]] }, m:
//               { metazone: { region: its reference zone } } }
//   tzn:<bundle>, tzn:index  each locale bundle's zone names
//               (zoneStrings), as scripts/icu-res.mjs bundleEntries keeps
//               them

import path from 'path';
import { Tree, bundleEntries } from './icu-res.mjs';

// a 64-bit time from two signed 32-bit halves
function join64(hi, lo) {
	return hi * 4294967296 + (lo >>> 0);
}

function utcMs(s) {
	const m = /^(\d+)-(\d+)-(\d+) (\d+):(\d+)$/.exec(s);

	return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
}

export function zoneEntries(icuDir, locales) {
	const misc = new Tree(path.join(icuDir, 'misc'));
	const zi = misc.file('zoneinfo64');
	const types = misc.file('timezoneTypes');
	const meta = misc.file('metaZones');
	const names = zi.Names, entries = {};
	const links = {}, data = {};

	// the zones and their links
	names.forEach((name, i) => {
		const z = zi.Zones[i];

		if (typeof z === 'number') {
			links[name] = z;
			return;
		}
		const t = [];
		const pre = z.transPre32 || [], post = z.transPost32 || [];

		for (let k = 0; k < pre.length; k += 2)
			t.push(join64(pre[k], pre[k + 1]));
		for (const x of z.trans || [])
			t.push(x);
		for (let k = 0; k < post.length; k += 2)
			t.push(join64(post[k], post[k + 1]));
		const d = { t, o: z.typeOffsets, m: [] };
		const hex = z.typeMap ? z.typeMap.bin : '';

		for (let k = 0; k < hex.length; k += 2)
			d.m.push(parseInt(hex.slice(k, k + 2), 16));
		if (d.m.length !== t.length)
			throw new Error(name + ': type map');
		if (z.finalRule !== undefined) {
			d.f = zi.Rules[z.finalRule];
			d.r = z.finalRaw;
			d.y = z.finalYear;
		}
		data[name] = d;
	});
	for (const name in links)
		links[name] = names[links[name]];

	// ZoneMeta::getCanonicalCLDRID: the ID timezoneTypes maps, its
	// alias's, the link's target's alias, or the target
	const typeMap = types.typeMap.timezone, typeAlias = types.typeAlias.timezone;
	const key = id => id.replace(/\//g, ':');
	const canonical = id => {
		if (typeMap[key(id)] !== undefined)
			return id;
		if (typeAlias[key(id)] !== undefined)
			return typeAlias[key(id)];
		const target = links[id] || (data[id] ? id : null);

		if (!target)
			return null;
		return typeAlias[key(target)] !== undefined ?
			typeAlias[key(target)] : target;
	};
	const canon = {}, region = {};

	names.forEach((name, i) => {
		const c = canonical(name);

		if (c && c !== name)
			canon[name] = c;
		const r = zi.Regions[i];

		if (c === name && r !== '001' && !/^Etc\//.test(name))
			region[name] = r;
	});
	// a region's primary zone: its only canonical location zone, or the
	// one metaZones names
	const byRegion = {};

	for (const z in region)
		(byRegion[region[z]] = byRegion[region[z]] || []).push(z);
	const primary = [];

	for (const r in byRegion) {
		if (byRegion[r].length === 1)
			primary.push(byRegion[r][0]);
		else if (meta.primaryZones[r])
			primary.push(meta.primaryZones[r]);
	}

	entries['tz:index'] = {
		v: zi.TZVersion, n: names.join(' '), l: links, c: canon, r: region,
		p: primary.sort().join(' ')
	};
	for (const name in data)
		entries['tz:' + name] = data[name];

	// metazones by zone, with their UTC spans
	const mz = {};

	for (const k in meta.metazoneInfo) {
		mz[k.replace(/:/g, '/')] = meta.metazoneInfo[k].map(e =>
			[e[0], e.length > 1 ? utcMs(e[1]) : utcMs('1970-01-01 00:00'),
			 e.length > 2 ? utcMs(e[2]) : utcMs('9999-12-31 23:59')]);
	}
	entries['tz:meta'] = { z: mz, m: meta.mapTimezones };

	Object.assign(entries, bundleEntries(path.join(icuDir, 'zone'), 'tzn',
		b => b.zoneStrings, locales));
	return entries;
}
