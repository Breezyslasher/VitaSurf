#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// scripts/icu-fallback.json: the two tables ICU's resource bundles fall
// back with when a locale has no bundle of its own (source/common/
// localefallback_data.h, which ICU's build generates from CLDR): each
// language's (or language_region's) default script, and CLDR's parent
// locales. scripts/gen-intl-dates.mjs puts them in resources/intl.pak.
// Take them from the ICU source whose version Node's ICU has; the ICU
// source is under the Unicode licence, which is GPL-compatible.
//
//   node scripts/gen-icu-fallback.mjs icu/source > scripts/icu-fallback.json

import fs from 'fs';
import path from 'path';

const h = fs.readFileSync(path.join(process.argv[2], 'common',
	'localefallback_data.h'), 'utf8');
const chars = name => new RegExp('const char ' + name +
	'\\[\\] =([\\s\\S]*?);').exec(h)[1].match(/"([^"]*)"/g)
	.map(s => s.slice(1, -1)).join('').replace(/\\0/g, '\0');
const ints = name => new RegExp('const int32_t ' + name +
	'\\[\\] = \\{([\\s\\S]*?)\\};').exec(h)[1].split(/[,\s]+/)
	.filter(Boolean).map(Number);
const at = (s, o) => s.slice(o, s.indexOf('\0', o));
const table = (keys, values, t) => {
	const out = {};

	for (let i = 0; i < t.length; i += 2)
		out[at(keys, t[i])] = at(values, t[i + 1]);
	return out;
};
const pl = chars('parentLocaleChars');

process.stdout.write(JSON.stringify({
	version: /U_ICU_VERSION\s+"([^"]+)"/.exec(fs.readFileSync(path.join(
		process.argv[2], 'common', 'unicode', 'uvernum.h'), 'utf8'))[1],
	script: table(chars('dsLocaleIDChars'), chars('scriptCodeChars'),
		      ints('defaultScriptTable')),
	parent: table(pl, pl, ints('parentLocaleTable'))
}) + '\n');
