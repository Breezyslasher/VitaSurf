#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Write resources/intl.pak, the data Intl.NumberFormat and
// Intl.PluralRules format with (vita/js/intl_number.js), and
// Intl.RelativeTimeFormat and Intl.DisplayNames with
// (vita/js/intl_names.js), from CLDR's JSON release. The Unicode CLDR
// data is under the Unicode licence, which is GPL-compatible.
//
// Entries, by name: index (the locales and their parents), plurals, and
// for each CLDR locale n: (numbers), c: (currency names), d: (names of
// languages, regions, scripts, variants and calendars) and r: (relative
// times and the names of date fields).
//
// The pack holds one entry per CLDR locale, read only when a page asks
// for that locale. A locale's entry is what it changes from its CLDR
// parent, and every locale's last parent is root, as in ICU, so a
// regional locale costs a few bytes and a numbering system a locale has
// no symbols for takes root's. The locales are those ICU in Node offers,
// so Intl.NumberFormat.supportedLocalesOf answers as a browser's would;
// ICU's aliases (en-US, sr-RS, zh-TW) point at the CLDR locale they take
// their data from. Where ICU's data departs from CLDR's JSON, it is read
// off ICU itself: the Arabic numbering systems' symbols, the order of a
// currency's name and number, the list of currencies in use.
//
// Get the CLDR packages, at the version Node's ICU uses
// (node -p process.versions.cldr), then run this under that Node:
//
//   mkdir cldr && cd cldr
//   for p in cldr-core cldr-numbers-full cldr-units-full \
//            cldr-localenames-full cldr-dates-full; do
//     npm pack $p@48.0.0 && mkdir $p && tar xzf $p-48.0.0.tgz -C $p
//   done
//   node scripts/gen-intl-numbers.mjs cldr > resources/intl.pak
//
// Pack format, all integers little-endian:
//   "VSIP" u32 entries, then per entry: u8 name length, name,
//   u32 offset from the start of the file, u32 deflated length,
//   u32 inflated length; then the zlib streams, each a JSON text.

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const DIR = process.argv[2] || 'cldr';
const pkg = name => {
	for (const d of [name, name + '-48.0.0'])
		for (const p of [path.join(DIR, d, 'package'), path.join(DIR, d)])
			if (fs.existsSync(path.join(p, 'package.json')))
				return p;
	throw new Error('no ' + name + ' under ' + DIR);
};
const NAMES = pkg('cldr-localenames-full'), DATES = pkg('cldr-dates-full');
const CORE = pkg('cldr-core'), NUM = pkg('cldr-numbers-full'),
	UNITS = pkg('cldr-units-full');
const json = f => JSON.parse(fs.readFileSync(f, 'utf8'));
const SUP = f => json(path.join(CORE, 'supplemental', f)).supplemental;
const CLDR_VERSION = json(path.join(CORE, 'package.json')).version;

if (process.versions.cldr && !CLDR_VERSION.startsWith(process.versions.cldr
    .replace(/\.0$/, '')))
	process.stderr.write('warning: CLDR ' + CLDR_VERSION + ', Node\'s ICU ' +
			     'has ' + process.versions.cldr + '\n');

// ECMA-402's sanctioned single units
const UNIT_NAMES = ('acre bit byte celsius centimeter day degree ' +
	'fahrenheit fluid-ounce foot gallon gigabit gigabyte gram hectare ' +
	'hour inch kilobit kilobyte kilogram kilometer liter megabit ' +
	'megabyte meter microsecond mile mile-scandinavian milliliter ' +
	'millimeter millisecond minute month nanosecond ounce percent ' +
	'petabyte pound second stone terabit terabyte week yard year')
	.split(' ');
const SYMBOLS = ['decimal', 'group', 'currencyDecimal', 'currencyGroup',
	'percentSign', 'plusSign', 'minusSign',
	'exponential', 'perMille', 'infinity', 'nan', 'approximatelySign',
	'superscriptingExponent'];

const FOLDERS = fs.readdirSync(path.join(NUM, 'main'));
const parentMap = SUP('parentLocales.json').parentLocales.parentLocale;

// CLDR's parent; root, which CLDR's JSON calls und, is everyone's last
function parentOf(tag) {
	if (tag === 'und')
		return null;
	if (parentMap[tag])
		return parentMap[tag] === 'root' ? 'und' : parentMap[tag];
	const cut = tag.lastIndexOf('-');

	return cut > 0 ? tag.slice(0, cut) : 'und';
}

// ---- the locales ICU has, and where each takes its data from ----

function icuLocales() {
	const terr = new Set(Object.keys(SUP('territoryInfo.json').territoryInfo));
	const bases = new Set();

	for (const f of FOLDERS) {
		const p = f.split('-');

		for (const x of p.slice(1))
			if (/^([A-Z]{2}|\d{3})$/.test(x))
				terr.add(x);
		bases.add(p[0]);
		if (p[1] && /^[A-Z][a-z]{3}$/.test(p[1]))
			bases.add(p[0] + '-' + p[1]);
	}
	const cand = new Set(FOLDERS);

	for (const b of bases)
		for (const r of terr)
			cand.add(b + '-' + r);
	const out = [];

	for (const t of cand) {
		try {
			if (new Intl.NumberFormat(t).resolvedOptions().locale === t)
				out.push(t);
		} catch (e) {
		}
	}
	return out.sort();
}

const likely = SUP('likelySubtags.json').likelySubtags;

// the CLDR locale an ICU locale formats as
function source(tag) {
	if (FOLDERS.includes(tag))
		return tag;
	const p = tag.split('-'), lang = p[0];
	let script = p.length > 2 ? p[1] : null;
	const region = p[p.length - 1];
	const max = (likely[lang + '-' + region] || likely[lang] || '').split('-');

	if (!script)
		script = max[1];
	const tries = [lang + '-' + script + '-' + region, lang + '-' + region];
	const defScript = (likely[lang] || '').split('-')[1];

	if (script !== defScript)
		tries.push(lang + '-' + script);
	tries.push(lang);
	for (const t of tries)
		if (FOLDERS.includes(t))
			return t;
	throw new Error('no data for ' + tag);
}

// ---- one locale's data ----

function compactPatterns(o) {
	if (!o)
		return undefined;
	const out = {};

	for (const k in o) {
		const m = /^(\d+)-count-([a-z0-9]+)$/.exec(k);

		if (!m)
			continue;
		(out[m[1]] = out[m[1]] || {})[m[2]] = o[k];
	}
	return out;
}

function counts(o, prefix) {
	const out = {};

	for (const k in o) {
		if (k.startsWith(prefix + '-count-') && !/-case-|-gender-/.test(k))
			out[k.slice(prefix.length + 7)] = o[k];
	}
	return out;
}

function mainFile(pkgDir, tag, file) {
	const f = path.join(pkgDir, 'main', tag, file);

	return fs.existsSync(f) ? json(f).main[tag] : null;
}

// Intl.DisplayNames': languages, regions, scripts, variants and
// calendars, with their short and stand-alone forms, and how a
// locale's name is put together from its parts
function displayData(tag) {
	const ln = (file, key) => {
		const m = mainFile(NAMES, tag, file);

		return m ? m.localeDisplayNames[key] : {};
	};
	const split = (o) => {
		const out = { n: {}, short: {}, long: {} };

		for (const k in o) {
			const m = /^(.*?)-alt-(short|long)$/.exec(k);

			if (m)
				out[m[2]][m[1]] = o[k];
			else if (!/-alt-|-menu-/.test(k))
				out.n[k] = o[k];
		}
		return out;
	};
	const l = split(ln('languages.json', 'languages'));
	const t = split(ln('territories.json', 'territories'));
	const sc = split(ln('scripts.json', 'scripts'));
	const ldn = mainFile(NAMES, tag, 'localeDisplayNames.json');
	const d = ldn ? ldn.localeDisplayNames : {};
	const pat = d.localeDisplayPattern || {};

	return {
		L: l.n, Ls: l.short, Ll: l.long,
		T: t.n, Ts: t.short,
		S: sc.n, Ss: sc.short,
		V: ln('variants.json', 'variants'),
		K: d.types ? d.types.calendar : {},
		p: [pat.localePattern, pat.localeSeparator]
	};
}

// Intl.RelativeTimeFormat's, and Intl.DisplayNames' names of the date
// fields: for each field and width, its name, the words for -1, 0 and
// 1 (yesterday, today, tomorrow) and the patterns for the future and
// the past by plural
const FIELDS = ['era', 'year', 'quarter', 'month', 'week', 'weekday', 'day',
	'dayperiod', 'hour', 'minute', 'second', 'zone'];

function relativeData(tag) {
	const m = mainFile(DATES, tag, 'dateFields.json');
	const f = m ? m.dates.fields : {}, out = {};

	for (const field of FIELDS) {
		for (const w of ['', '-short', '-narrow']) {
			const e = f[field + w];

			if (!e)
				continue;
			const o = { n: e.displayName };
			const rel = {};

			for (const k in e) {
				const r = /^relative-type-(-?\d+)$/.exec(k);

				if (r)
					rel[r[1]] = e[k];
			}
			if (Object.keys(rel).length)
				o.r = rel;
			if (e['relativeTime-type-future'])
				o.f = counts(e['relativeTime-type-future'],
					     'relativeTimePattern');
			if (e['relativeTime-type-past'])
				o.p = counts(e['relativeTime-type-past'],
					     'relativeTimePattern');
			out[field + (w || '-long')] = o;
		}
	}
	return out;
}

function numberData(tag) {
	const n = json(path.join(NUM, 'main', tag, 'numbers.json')).main[tag].numbers;
	const c = json(path.join(NUM, 'main', tag, 'currencies.json')).main[tag]
		.numbers.currencies;
	const u = json(path.join(UNITS, 'main', tag, 'units.json')).main[tag].units;
	const d = { nu: n.defaultNumberingSystem, mgd: +n.minimumGroupingDigits,
		S: {}, P: {}, U: {}, C: {} };

	if (n.otherNumberingSystems && n.otherNumberingSystems.native)
		d.native = n.otherNumberingSystems.native;
	for (const k in n) {
		const m = /^symbols-numberSystem-(.*)$/.exec(k);

		if (!m)
			continue;
		const nu = m[1], sym = n[k];
		const df = n['decimalFormats-numberSystem-' + nu] || {};
		const pf = n['percentFormats-numberSystem-' + nu] || {};
		const sf = n['scientificFormats-numberSystem-' + nu] || {};
		const cf = n['currencyFormats-numberSystem-' + nu] || {};
		const mp = n['miscPatterns-numberSystem-' + nu] || {};
		const sp = cf.currencySpacing || {};

		d.S[nu] = {};
		for (const s of SYMBOLS)
			d.S[nu][s] = sym[s];
		d.P[nu] = {
			d: df.standard, p: pf.standard, e: sf.standard,
			c: cf.standard, a: cf.accounting,
			ca: cf['standard-alphaNextToNumber'],
			aa: cf['accounting-alphaNextToNumber'],
			cn: cf['standard-noCurrency'],
			an: cf['accounting-noCurrency'],
			sp: [sp.beforeCurrency && sp.beforeCurrency.insertBetween,
			     sp.afterCurrency && sp.afterCurrency.insertBetween],
			ds: compactPatterns(df.short && df.short.decimalFormat),
			dl: compactPatterns(df.long && df.long.decimalFormat),
			cs: compactPatterns(cf.short && cf.short.standard),
			cu: counts(cf, 'unitPattern'),
			r: mp.range, x: mp.approximately
		};
		// what a numbering system lacks is its Latin one's
		if (!Object.keys(d.P[nu].cu).length)
			delete d.P[nu].cu;
		if (!d.P[nu].sp[0] && !d.P[nu].sp[1])
			delete d.P[nu].sp;
	}
	for (const w of ['long', 'short', 'narrow']) {
		const src = u[w], out = d.U[w] = {};
		const keys = Object.keys(src);

		for (const k of keys) {
			const id = k.replace(/^[a-z]+-/, '');
			const m = /^(.*)-per-(.*)$/.exec(id);

			if (!UNIT_NAMES.includes(id) &&
			    !(m && UNIT_NAMES.includes(m[1]) &&
			      UNIT_NAMES.includes(m[2])))
				continue;
			const e = counts(src[k], 'unitPattern');

			if (src[k].perUnitPattern)
				e.per = src[k].perUnitPattern;
			out[id] = e;
		}
		out.per = src.per && src.per.compoundUnitPattern;
	}
	// every one, even a symbol that is the code: a parent's symbol
	// must not show through
	// [symbol, narrow symbol, then a pattern, decimal and group of the
	// currency's own where it has them, as the escudo has]
	for (const code in c) {
		const e = c[code], sym = e.symbol, nar = e['symbol-alt-narrow'];
		const v = [sym, nar && nar !== sym ? nar : null, e.pattern || null,
			e.decimal || null, e.group || null];

		while (v.length > 1 && v[v.length - 1] === null)
			v.pop();
		d.C[code] = v;
	}
	const names = {};

	for (const code in c) {
		const e = c[code], cn = counts(e, 'displayName');
		const v = [e.displayName];

		for (const k of ['zero', 'one', 'two', 'few', 'many', 'other'])
			v.push(cn[k] === undefined ? 0 : cn[k] === e.displayName ? 1 :
			       cn[k]);
		while (v.length > 1 && v[v.length - 1] === 0)
			v.pop();
		if (e.displayName !== undefined)
			names[code] = v.length === 1 ? v[0] : v;
	}
	return { num: d, names };
}

// what child changes from parent. What child lacks it inherits, as in
// CLDR, so nothing is ever deleted.
function diff(parent, child) {
	if (parent === undefined)
		return child;
	if (typeof child !== 'object' || child === null || Array.isArray(child) ||
	    typeof parent !== 'object' || parent === null || Array.isArray(parent))
		return JSON.stringify(parent) === JSON.stringify(child) ? undefined :
			child;
	const out = {};
	let any = false;

	for (const k in child) {
		const v = diff(parent[k], child[k]);

		if (v !== undefined) {
			out[k] = v;
			any = true;
		}
	}
	return any ? out : undefined;
}

// ---- plural rules ----

function plurals() {
	const card = SUP('plurals.json')['plurals-type-cardinal'];
	const ord = SUP('ordinals.json')['plurals-type-ordinal'];
	const ranges = SUP('pluralRanges.json').plurals;
	const strip = r => {
		const out = {};

		for (const k in r) {
			const rule = r[k].replace(/@.*$/, '').trim();

			out[k.replace('pluralRule-count-', '')] = rule;
		}
		return out;
	};
	const out = {};

	for (const l in card)
		(out[l] = out[l] || {}).c = strip(card[l]);
	for (const l in ord)
		(out[l] = out[l] || {}).o = strip(ord[l]);
	for (const l in ranges) {
		const r = {};

		for (const k in ranges[l]) {
			const m = /^pluralRange-start-(\w+)-end-(\w+)$/.exec(k);

			r[m[1] + ' ' + m[2]] = ranges[l][k];
		}
		(out[l] = out[l] || {}).r = r;
	}
	return out;
}

// ---- assemble ----

const ICU = icuLocales();
const ICU_SET = new Set(ICU);
const used = new Set();
const index = {};

for (const t of ICU) {
	const s = source(t);

	index[t] = s === t ? 0 : s;
	used.add(s);
}
// each locale's CLDR parents, so its diff has something to apply to
for (const s of [...used]) {
	for (let p = parentOf(s); p; p = parentOf(p))
		used.add(p);
}
// ICU has symbols for the Arabic numbering systems in locales whose
// CLDR JSON leaves them out (sv has its own minus and group for arab);
// read them off ICU itself. Other numbering systems a locale has no
// data for take its Latin symbols, in ICU and in vita/js/intl_number.js.
const BIDI_ONLY = /^[\u200e\u200f\u061c]+$/;

function probeSymbols(tag, ns) {
	const loc = (tag === 'und' ? 'en' : tag) + '-u-nu-' + ns;
	const parts = (o, v) => new Intl.NumberFormat(loc, o).formatToParts(v);
	const sym = (list, type) => {
		const i = list.findIndex(p => p.type === type);
		let s = list[i].value;

		for (let j = i - 1; j >= 0 && list[j].type === 'literal' &&
		     BIDI_ONLY.test(list[j].value); j--)
			s = list[j].value + s;
		for (let j = i + 1; j < list.length && list[j].type === 'literal' &&
		     BIDI_ONLY.test(list[j].value); j++)
			s += list[j].value;
		return s;
	};
	const n = parts({ signDisplay: 'always', useGrouping: 'always' },
			-1234.5);

	return {
		decimal: sym(n, 'decimal'), group: sym(n, 'group'),
		minusSign: sym(n, 'minusSign'),
		plusSign: sym(parts({ signDisplay: 'always' }, 1), 'plusSign'),
		percentSign: sym(parts({ style: 'percent' }, 1), 'percentSign'),
		exponential: sym(parts({ notation: 'scientific' }, 5),
				 'exponentSeparator'),
		infinity: sym(parts({}, Infinity), 'infinity'),
		nan: sym(parts({}, NaN), 'nan'),
		approximatelySign: sym(new Intl.NumberFormat(loc)
			.formatRangeToParts(1, 1), 'approximatelySign')
	};
}

function arabicSymbols(tag, d) {
	for (const ns of ['arab', 'arabext']) {
		if (tag !== 'und' && !ICU_SET.has(tag))
			continue;
		d.S[ns] = Object.assign({}, d.S[ns] || d.S.latn,
					probeSymbols(tag, ns));
	}
	// ICU's root patterns for arab (its root.txt); the rest of arab's,
	// and all of arabext's, are the locale's Latin ones
	if (tag === 'und') {
		d.P.arab = { c: '#,##0.00\u00a0\u00a4', a: '#,##0.00\u00a0\u00a4',
			cn: '#,##0.00', p: '#,##0%' };
	}
}

// what a child would have without its entry, as the runtime reads it: a
// numbering system's symbol or pattern is the parent's for that system,
// or else the child's own Latin one
function latnFor(parent, child) {
	const out = Object.assign({}, parent);

	for (const k of ['S', 'P']) {
		out[k] = Object.assign({}, parent[k]);
		for (const ns in child[k])
			if (ns !== 'latn')
				out[k][ns] = Object.assign({}, child[k].latn,
							   parent[k][ns] || {});
	}
	return out;
}

const entries = {};
const parents = {};
const cache = {};
// A currency's own format: a pattern or separators of its own (the
// Cape Verdean escudo's decimal sign is "$"; en-150 writes the euro
// "\u00a4#,##0.00"). ICU fills in what CLDR leaves out from the locale that
// gave the currency its format.
function currencyFormats(tag, d) {
	for (const code in d.C) {
		const v = d.C[code];

		if (!v[2] && !v[3] && !v[4])
			continue;
		let def = tag;
		const same = (a, b) => a && a[2] === b[2] && a[3] === b[3] &&
			a[4] === b[4];

		for (let p = parentOf(def); p; p = parentOf(p)) {
			if (!same(cldrCurrency(p, code), cldrCurrency(tag, code)))
				break;
			def = p;
		}
		const dd = def === tag ? d : get(def).num;

		v[1] = v[1] || null;
		v[2] = v[2] || dd.P.latn.c;
		v[3] = v[3] || dd.S.latn.decimal;
		v[4] = v[4] || dd.S.latn.group;
	}
}

// a currency's entry as CLDR gives it, before currencyFormats fills it in
const CLDR_CURRENCY = {};

function cldrCurrency(tag, code) {
	if (!CLDR_CURRENCY[tag])
		CLDR_CURRENCY[tag] = json(path.join(NUM, 'main', tag,
			'currencies.json')).main[tag].numbers.currencies;
	const e = CLDR_CURRENCY[tag][code];

	return e && [0, 0, e.pattern, e.decimal, e.group];
}

// each region's currency, as ICU's ucurr_forLocale finds it: a locale
// whose tag names a region writes every currency in that currency's
// format, if it has one of its own (en-BE writes dollars as euros)
function regionCurrencies() {
	const region = SUP('currencyData.json').currencyData.region, out = {};

	for (const r in region) {
		for (const e of region[r]) {
			const code = Object.keys(e)[0];

			if (!e[code]._to && e[code]._tender !== 'false') {
				out[r] = code;
				break;
			}
		}
	}
	return out;
}

// ICU's currency name pattern is its own, and puts the number first
// for two locales where CLDR's JSON puts the name first (my, ceb)
function nameOrder(tag, d) {
	if (!ICU_SET.has(tag))
		return;
	const parts = new Intl.NumberFormat(tag, { style: 'currency',
		currency: 'USD', currencyDisplay: 'name' }).formatToParts(5);
	const numFirst = parts.findIndex(p => p.type === 'integer') <
		parts.findIndex(p => p.type === 'currency');

	for (const nu in d.P) {
		const cu = d.P[nu].cu;

		for (const k in cu) {
			if (numFirst && cu[k].indexOf('{1}') < cu[k].indexOf('{0}'))
				cu[k] = '{0} {1}';
		}
	}
}

const get = t => {
	if (!cache[t]) {
		cache[t] = numberData(t);
		cache[t].display = displayData(t);
		cache[t].relative = relativeData(t);
		arabicSymbols(t, cache[t].num);
		currencyFormats(t, cache[t].num);
		nameOrder(t, cache[t].num);
	}
	return cache[t];
};

for (const t of [...used].sort()) {
	const p = parentOf(t), mine = get(t);

	parents[t] = p || 0;
	entries['n:' + t] = p ? diff(latnFor(get(p).num, mine.num),
				     mine.num) || {} : mine.num;
	// ICU's root has no long compact patterns; CLDR's JSON gives it its
	// short ones as long, and every locale under it those where it has
	// none of its own. Diffed against them, a locale keeps only its
	// own: one with none falls back to its short ones, as in ICU, and
	// one with a few, as Pashto has, gets those few.
	if (t === 'und') {
		entries['n:und'] = JSON.parse(JSON.stringify(mine.num));
		for (const ns in entries['n:und'].P)
			delete entries['n:und'].P[ns].dl;
	}
	entries['c:' + t] = p ? diff(get(p).names, mine.names) || {} : mine.names;
	entries['d:' + t] = p ? diff(get(p).display, mine.display) || {} :
		mine.display;
	entries['r:' + t] = p ? diff(get(p).relative, mine.relative) || {} :
		mine.relative;
}

// currency digits, and the numbering systems that are digits
const fractions = SUP('currencyData.json').currencyData.fractions;
const digits = {};

for (const code in fractions) {
	if (code !== 'DEFAULT' && fractions[code]._digits !== '2')
		digits[code] = +fractions[code]._digits;
}
const ns = SUP('numberingSystems.json').numberingSystems, nsDigits = {};

for (const k in ns) {
	if (ns[k]._type === 'numeric')
		nsDigits[k] = ns[k]._digits;
}

// Intl.supportedValuesOf('currency'): ICU's list of the currencies in
// use, which CLDR does not keep as one
entries.index = {
	cldr: CLDR_VERSION, locales: index, parents, digits, ns: nsDigits,
	rc: regionCurrencies(), currencies: Intl.supportedValuesOf('currency')
};
entries.plurals = plurals();

// ---- write ----

const names = Object.keys(entries).sort();
const blobs = names.map(n => {
	const raw = Buffer.from(JSON.stringify(entries[n]), 'utf8');

	return { name: n, raw: raw.length,
		z: zlib.deflateSync(raw, { level: 9 }) };
});
let off = 8;

for (const b of blobs)
	off += 1 + Buffer.byteLength(b.name) + 12;
const head = [Buffer.from('VSIP'), Buffer.alloc(4)];

head[1].writeUInt32LE(blobs.length);
for (const b of blobs) {
	const nb = Buffer.from(b.name), rec = Buffer.alloc(13);

	if (nb.length > 255)
		throw new Error(b.name);
	rec.writeUInt8(nb.length, 0);
	head.push(rec.subarray(0, 1), nb);
	rec.writeUInt32LE(off, 1);
	rec.writeUInt32LE(b.z.length, 5);
	rec.writeUInt32LE(b.raw, 9);
	head.push(rec.subarray(1));
	off += b.z.length;
}
const out = Buffer.concat([...head, ...blobs.map(b => b.z)]);

process.stdout.write(out);
const total = blobs.reduce((a, b) => a + b.raw, 0);

process.stderr.write(ICU.length + ' locales, ' + used.size + ' with data; ' +
		     blobs.length + ' entries, ' + total + ' bytes of JSON, ' +
		     out.length + ' packed; en ' +
		     blobs.find(b => b.name === 'n:en').raw + '+' +
		     blobs.find(b => b.name === 'c:en').raw + '\n');
