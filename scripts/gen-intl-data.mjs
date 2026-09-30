#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Generate vita/js/intl_locale.h, the locale data Intl.DateTimeFormat
// formats with, from the ICU in Node (CLDR data, under the Unicode
// licence). Every pattern, name and joiner is read back from what ICU
// formats, so the tables say what a browser would, and then
// vita/js/intl_pattern.js is run over every combination of options
// against ICU; a skeleton where the two differ is recorded with ICU's
// answer.
//
//   node scripts/gen-intl-data.mjs > vita/js/intl_locale.h
//
// Needs a Node built with full ICU (the default); the ICU and CLDR
// versions go into the header.

import { createRequire } from 'module';
import { readFileSync } from 'fs';
const require = createRequire(import.meta.url);
const P = require('../vita/js/intl_pattern.js');

const LOCALES = (process.env.LOCS || 'en,en-GB,en-CA,en-AU,en-IN,en-IE,en-NZ,en-ZA').split(',');
const PROBE = Date.UTC(2026, 2, 4, 5, 6, 7, 89);	// Wed 4 Mar 2026
const WIDTHS = ['long', 'short', 'narrow'];
const log = (...a) => process.stderr.write(a.join(' ') + '\n');

// CLDR availableFormats skeletons: those of the locales Home Assistant
// ships formats for, which cover the English ones
const KEYS = ['Bh', 'Bhm', 'Bhms', 'E', 'EBh', 'EBhm', 'EBhms', 'EEEEd',
	'EHm', 'EHms', 'Ed', 'Eh', 'Ehm', 'Ehms', 'Gy', 'GyM', 'GyMEd',
	'GyMMM', 'GyMMMEEEEd', 'GyMMMEd', 'GyMMMM', 'GyMMMMEd', 'GyMMMMd',
	'GyMMMd', 'GyMd', 'H', 'Hm', 'Hms', 'Hmsv', 'Hmsvvvv', 'Hmv',
	'Hmvvvv', 'Hv', 'M', 'MEEEEd', 'MEd', 'MMM', 'MMMEEEEd', 'MMMEd',
	'MMMM', 'MMMMEEEEd', 'MMMMEd', 'MMMMd', 'MMMMdd', 'MMMd', 'MMMdd',
	'MMd', 'MMdd', 'Md', 'Mdd', 'd', 'h', 'hm', 'hms', 'hmsv',
	'hmsvvvv', 'hmv', 'hmvvvv', 'hv', 'mmss', 'ms', 'y', 'yM',
	'yMEEEEd', 'yMEd', 'yMM', 'yMMM', 'yMMMEEEEd', 'yMMMEd', 'yMMMM',
	'yMMMMEEEEd', 'yMMMMEd', 'yMMMMd', 'yMMMd', 'yMMdd', 'yMd'];

const HC_CHAR = { h11: 'K', h12: 'h', h23: 'H', h24: 'k' };

// skeleton letters -> Intl options
function optionsOf(skel, hcDefault) {
	const o = { timeZone: 'UTC' };
	const re = /(.)\1*/g;
	let m;
	while ((m = re.exec(skel))) {
		const c = m[1], n = m[0].length;
		switch (c) {
		case 'G': o.era = n <= 3 ? 'short' : n === 4 ? 'long' : 'narrow'; break;
		case 'y': o.year = n === 2 ? '2-digit' : 'numeric'; break;
		case 'M': case 'L':
			o.month = ['numeric', '2-digit', 'short', 'long', 'narrow'][n - 1];
			break;
		case 'd': o.day = n === 2 ? '2-digit' : 'numeric'; break;
		case 'E': case 'c':
			o.weekday = n <= 3 ? 'short' : n === 4 ? 'long' : 'narrow';
			break;
		case 'B': o.dayPeriod = n <= 3 ? 'short' : n === 4 ? 'long' : 'narrow'; break;
		case 'h': case 'H': case 'K': case 'k':
			o.hour = n === 2 ? '2-digit' : 'numeric';
			o.hourCycle = { h: 'h12', H: 'h23', K: 'h11', k: 'h24' }[c];
			break;
		case 'm': o.minute = n === 2 ? '2-digit' : 'numeric'; break;
		case 's': o.second = n === 2 ? '2-digit' : 'numeric'; break;
		case 'S': o.fractionalSecondDigits = n; break;
		case 'z': o.timeZoneName = n === 4 ? 'long' : 'short'; break;
		case 'O': o.timeZoneName = n === 4 ? 'longOffset' : 'shortOffset'; break;
		case 'v': o.timeZoneName = n === 4 ? 'longGeneric' : 'shortGeneric'; break;
		default: return null;
		}
	}
	return o;
}

function names(loc) {
	const n = { month: {}, monthAlone: {}, weekday: {}, era: {}, dayPeriod: {} };
	for (const w of WIDTHS) {
		const fm = new Intl.DateTimeFormat(loc, { month: w, day: 'numeric', timeZone: 'UTC' });
		const sm = new Intl.DateTimeFormat(loc, { month: w, timeZone: 'UTC' });
		n.month[w] = [];
		n.monthAlone[w] = [];
		for (let i = 0; i < 12; i++) {
			const d = Date.UTC(2026, i, 15);
			n.month[w].push(fm.formatToParts(d).find(p => p.type === 'month').value);
			n.monthAlone[w].push(sm.format(d));
		}
		const fw = new Intl.DateTimeFormat(loc, { weekday: w, timeZone: 'UTC' });
		n.weekday[w] = [];
		for (let i = 0; i < 7; i++)	// 4 Jan 2026 is a Sunday
			n.weekday[w].push(fw.format(Date.UTC(2026, 0, 4 + i)));
		const fe = new Intl.DateTimeFormat(loc, { era: w, year: 'numeric', timeZone: 'UTC' });
		n.era[w] = [-2e12 * 50, 0].map(t =>
			fe.formatToParts(t).find(p => p.type === 'era').value);
		const fd = new Intl.DateTimeFormat(loc, { hour: 'numeric', hourCycle: 'h12', dayPeriod: w, timeZone: 'UTC' });
		const per = [];
		for (let h = 0; h < 24; h++) {
			const v = fd.formatToParts(Date.UTC(2026, 0, 1, h, 30))
				.find(p => p.type === 'dayPeriod').value;
			per.push(v);
		}
		per.push(fd.formatToParts(Date.UTC(2026, 0, 1, 12, 0))
			.find(p => p.type === 'dayPeriod').value);	// noon
		n.dayPeriod[w] = per;
	}
	const dn = new Intl.DisplayNames(loc, { type: 'dateTimeField' });
	n.fields = [];
	for (const [f, k] of [[0, 'era'], [1, 'year'], [3, 'month'], [6, 'weekday'],
			      [9, 'day'], [10, 'dayPeriod'], [11, 'hour'], [12, 'minute'],
			      [13, 'second'], [15, 'timeZoneName']])
		n.fields[f] = dn.of(k);
	const fa = new Intl.DateTimeFormat(loc, { hour: 'numeric', hourCycle: 'h12', timeZone: 'UTC' });
	n.ampm = [5, 17].map(h => fa.formatToParts(Date.UTC(2026, 0, 1, h))
		.find(p => p.type === 'dayPeriod').value);
	const ff = new Intl.DateTimeFormat(loc, { second: 'numeric', fractionalSecondDigits: 1, timeZone: 'UTC' });
	const parts = ff.formatToParts(PROBE);
	n.dec = parts[parts.findIndex(p => p.type === 'second') + 1].value;
	return n;
}

// what ICU formatted, as the pattern that formats it
function toPattern(parts, opts, nm, hc) {
	let out = '';
	for (const p of parts) {
		const v = p.value;
		switch (p.type) {
		case 'literal':
			out += /[A-Za-z']/.test(v) ? "'" + v.replace(/'/g, "''") + "'" : v;
			break;
		case 'era':
			out += { short: 'G', long: 'GGGG', narrow: 'GGGGG' }[opts.era] ||
				(nm.era.long.includes(v) ? 'GGGG' : nm.era.narrow.includes(v) &&
				 !nm.era.short.includes(v) ? 'GGGGG' : 'G');
			break;
		case 'year': case 'relatedYear':
			out += v.length === 2 ? 'yy' : 'y';
			break;
		case 'month':
			if (/^\d+$/.test(v))
				out += v.length === 2 ? 'MM' : 'M';
			else
				out += nm.month.long.includes(v) && opts.month === 'long' ? 'MMMM' :
					opts.month === 'narrow' ? 'MMMMM' :
					nm.month.short.includes(v) ? 'MMM' :
					nm.month.long.includes(v) ? 'MMMM' : 'MMMMM';
			break;
		case 'day': out += v.length === 2 ? 'dd' : 'd'; break;
		case 'weekday':
			out += opts.weekday === 'long' ? 'EEEE' : opts.weekday === 'narrow' ?
				'EEEEE' : nm.weekday.long.includes(v) ? 'EEEE' : 'EEE';
			break;
		case 'dayPeriod':
			if (nm.ampm.includes(v) && !(opts.dayPeriod && !opts.hour))
				out += 'a';
			else
				out += { short: 'B', long: 'BBBB', narrow: 'BBBBB' }[opts.dayPeriod || 'short'];
			break;
		case 'hour': out += HC_CHAR[hc].repeat(v.length === 2 ? 2 : 1); break;
		case 'minute': out += v.length === 2 ? 'mm' : 'm'; break;
		case 'second': out += v.length === 2 ? 'ss' : 's'; break;
		case 'fractionalSecond': out += 'S'.repeat(v.length); break;
		case 'timeZoneName':
			out += opts.timeZoneName ? { short: 'z', long: 'zzzz', shortOffset: 'O',
				longOffset: 'OOOO', shortGeneric: 'v', longGeneric: 'vvvv' }[opts.timeZoneName] :
				opts.timeStyle === 'full' ? 'zzzz' : 'z';
			break;
		default:
			throw new Error('part ' + p.type);
		}
	}
	return out;
}

function icuPattern(loc, opts, nm) {
	const f = new Intl.DateTimeFormat(loc, opts);
	return toPattern(f.formatToParts(PROBE), opts, nm, f.resolvedOptions().hourCycle || 'h12');
}

const STYLES = ['full', 'long', 'medium', 'short'];

function localeData(loc) {
	const nm = names(loc);
	const hcDefault = new Intl.DateTimeFormat(loc, { hour: 'numeric' }).resolvedOptions().hourCycle;
	const d = { hc: hcDefault, dec: nm.dec, fields: nm.fields, skel: {}, date: {}, time: {},
		timeHc: {}, styleGlue: {}, glue: [] };
	for (const k of KEYS) {
		const o = optionsOf(k);
		if (o)
			d.skel[k] = icuPattern(loc, o, nm);
	}
	for (const s of STYLES) {
		d.date[s] = icuPattern(loc, { dateStyle: s, timeZone: 'UTC' }, nm);
		d.time[s] = icuPattern(loc, { timeStyle: s, timeZone: 'UTC' }, nm);
		d.timeHc[s] = {};
		for (const hc of ['h11', 'h12', 'h23', 'h24'])
			d.timeHc[s][hc] = icuPattern(loc, { timeStyle: s, hourCycle: hc,
				timeZone: 'UTC' }, nm);
	}
	// the glue between a date style and a time style
	for (const s of STYLES) {
		const both = new Intl.DateTimeFormat(loc, { dateStyle: s, timeStyle: 'short', timeZone: 'UTC' }).format(PROBE);
		const dt = new Intl.DateTimeFormat(loc, { dateStyle: s, timeZone: 'UTC' }).format(PROBE);
		const tm = new Intl.DateTimeFormat(loc, { timeStyle: 'short', timeZone: 'UTC' }).format(PROBE);
		d.styleGlue[s] = gluePattern(both, dt, tm);
	}
	// the glue between a date and a time a skeleton asks for, by the
	// length of the month in it (ICU's full, long, medium, short)
	const base = { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' };
	const dates = [{ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' },
		{ year: 'numeric', month: 'long', day: 'numeric' },
		{ year: 'numeric', month: 'short', day: 'numeric' },
		{ year: 'numeric', month: 'numeric', day: 'numeric' }];
	for (const dd of dates) {
		const both = new Intl.DateTimeFormat(loc, { ...dd, ...base }).format(PROBE);
		const dt = new Intl.DateTimeFormat(loc, { ...dd, timeZone: 'UTC' }).format(PROBE);
		const tm = new Intl.DateTimeFormat(loc, base).format(PROBE);
		d.glue.push(gluePattern(both, dt, tm));
	}
	return { d, nm };
}

function gluePattern(both, dt, tm) {
	if (!both.startsWith(dt) || !both.endsWith(tm))
		throw new Error('glue: ' + both);
	const mid = both.slice(dt.length, both.length - tm.length);
	return '{1}' + (/[A-Za-z']/.test(mid) ? "'" + mid.replace(/'/g, "''") + "'" : mid) + '{0}';
}

// the skeleton a set of options makes, in the order intl.js builds it
function skeletonOf(o, hcDefault) {
	let s = '';
	if (o.era) s += { short: 'G', long: 'GGGG', narrow: 'GGGGG' }[o.era];
	if (o.year) s += o.year === '2-digit' ? 'yy' : 'y';
	if (o.month) s += { numeric: 'M', '2-digit': 'MM', short: 'MMM', long: 'MMMM', narrow: 'MMMMM' }[o.month];
	if (o.weekday) s += { short: 'EEE', long: 'EEEE', narrow: 'EEEEE' }[o.weekday];
	if (o.day) s += o.day === '2-digit' ? 'dd' : 'd';
	// a day period means nothing beside a 24 hour clock
	if (o.dayPeriod && !(o.hour && /h2[34]/.test(o.hourCycle || hcDefault)))
		s += { short: 'B', long: 'BBBB', narrow: 'BBBBB' }[o.dayPeriod];
	if (o.hour) s += HC_CHAR[o.hourCycle || hcDefault].repeat(o.hour === '2-digit' ? 2 : 1);
	if (o.minute) s += o.minute === '2-digit' ? 'mm' : 'm';
	if (o.second) s += o.second === '2-digit' ? 'ss' : 's';
	if (o.fractionalSecondDigits) s += 'S'.repeat(o.fractionalSecondDigits);
	if (o.timeZoneName) s += { short: 'z', long: 'zzzz', shortOffset: 'O', longOffset: 'OOOO', shortGeneric: 'v', longGeneric: 'vvvv' }[o.timeZoneName];
	return s;
}

function* combos() {
	const Y = [undefined, 'numeric', '2-digit'];
	const M = [undefined, 'numeric', '2-digit', 'short', 'long', 'narrow'];
	const D = [undefined, 'numeric', '2-digit'];
	const E = [undefined, 'short', 'long', 'narrow'];
	const H = [undefined, 'numeric', '2-digit'];
	const HC = [undefined, 'h12', 'h23', 'h11'];
	const MI = [undefined, 'numeric', '2-digit'];
	const S = [undefined, 'numeric', '2-digit'];
	const Z = [undefined, 'short', 'long', 'shortOffset', 'longGeneric'];
	for (const year of Y) for (const month of M) for (const day of D)
	for (const weekday of E) for (const hour of H)
	for (const hourCycle of hour ? HC : [undefined])
	for (const minute of MI) for (const second of S)
	for (const timeZoneName of Z) {
		const o = { year, month, day, weekday, hour, hourCycle, minute, second, timeZoneName };
		for (const k in o) if (o[k] === undefined) delete o[k];
		if (Object.keys(o).filter(k => k !== 'hourCycle' && k !== 'timeZoneName').length === 0)
			continue;
		yield o;
	}
	// eras, day periods and fractions of a second with a smaller set
	for (const era of ['short', 'long', 'narrow'])
	for (const year of Y) for (const month of M) for (const day of D) {
		const o = { era, year, month, day };
		for (const k in o) if (o[k] === undefined) delete o[k];
		yield o;
	}
	for (const dayPeriod of ['short', 'long', 'narrow'])
	for (const hour of H) for (const minute of MI) for (const second of S)
	for (const weekday of E) {
		const o = { dayPeriod, hour, minute, second, weekday };
		for (const k in o) if (o[k] === undefined) delete o[k];
		yield o;
	}
	for (const fractionalSecondDigits of [1, 2, 3])
	for (const hour of H) for (const minute of MI) for (const second of S) {
		const o = { fractionalSecondDigits, hour, minute, second };
		for (const k in o) if (o[k] === undefined) delete o[k];
		yield o;
	}
}

// a pattern as the literals and fields it formats, however it quotes
function norm(p) {
	const out = [];
	let lit = '', i = 0;
	while (i < p.length) {
		const c = p[i];
		if (c === "'") {
			if (p[i + 1] === "'") {
				lit += "'";
				i += 2;
				continue;
			}
			let j = i + 1;
			while (j < p.length && !(p[j] === "'" && p[j + 1] !== "'"))
				lit += p[j] === "'" ? (j++, "'") : p[j], j++;
			i = j + 1;
			continue;
		}
		if (/[A-Za-z]/.test(c)) {
			let j = i;
			while (p[j] === c)
				j++;
			if (lit)
				out.push(lit), lit = '';
			out.push('%' + p.slice(i, j));
			i = j;
			continue;
		}
		lit += c;
		i++;
	}
	if (lit)
		out.push(lit);
	return JSON.stringify(out);
}

// ICU's pattern for every skeleton the combinations make, once
function icuTable(loc, d, nm) {
	const t = new Map();
	for (const o of combos()) {
		// ToDateTimeOptions: nothing to show a date or a time with
		// asks for the date
		if (!['weekday', 'year', 'month', 'day', 'dayPeriod', 'hour', 'minute',
		      'second', 'fractionalSecondDigits'].some(k => k in o))
			Object.assign(o, { year: 'numeric', month: 'numeric', day: 'numeric' });
		const skel = skeletonOf(o, d.hc);
		if (t.has(skel))
			continue;
		try {
			t.set(skel, norm(icuPattern(loc, { ...o, timeZone: 'UTC' }, nm)));
		} catch (e) {
			// options ICU refuses
		}
	}
	return t;
}

function mismatches(d, table, keys) {
	const bad = [];
	delete d._cand;
	for (const skel of keys || table.keys())
		if (norm(P.bestPattern(d, skel)) !== table.get(skel))
			bad.push(skel);
	delete d._cand;
	return bad;
}

// A key the locale does not have still answers a probe, with the
// pattern ICU builds for it; kept, it wins where ICU would have chosen
// another. Drop each key whose pattern the rest give anyway, where that
// makes no more skeletons come out wrong.
function prune(loc, d, table) {
	const sample = [...table.keys()];
	let base = mismatches(d, table, sample).length;
	for (const k of Object.keys(d.skel)) {
		const pat = d.skel[k];
		delete d.skel[k];
		delete d._cand;
		const derived = norm(P.bestPattern(d, k)) === norm(pat);
		const now = derived ? mismatches(d, table, sample).length : Infinity;
		if (now <= base) {
			base = now;
		} else {
			d.skel[k] = pat;
		}
		delete d._cand;
	}
	log(loc + ': ' + Object.keys(d.skel).length + ' skeleton keys kept');
}

function validate(loc, d, nm) {
	const table = icuTable(loc, d, nm);
	prune(loc, d, table);
	d.over = {};
	const bad = mismatches(d, table);
	for (const skel of bad)
		d.over[skel] = P.bestPattern(Object.assign({}, d, { over: {} }), skel) &&
			denorm(table.get(skel));
	log(loc + ': ' + table.size + ' skeletons, ' + bad.length + ' recorded from ICU');
	delete d._cand;
}

// a normalized pattern back as a pattern
function denorm(n) {
	return JSON.parse(n).map(t => t[0] === '%' ? t.slice(1) :
		/[A-Za-z']/.test(t) ? "'" + t.replace(/'/g, "''") + "'" : t).join('');
}

// CLDR intervalFormats skeletons, and the field each pattern is for
const IV_KEYS = ['Bh', 'Bhm', 'Gy', 'GyM', 'GyMEd', 'GyMMM', 'GyMMMEEEEd',
	'GyMMMEd', 'GyMMMM', 'GyMMMMEd', 'GyMMMMd', 'GyMMMd', 'GyMd', 'H', 'Hm',
	'Hmv', 'Hmvvvv', 'Hv', 'Hvvvv', 'M', 'MEd', 'MMM', 'MMMEEEEd', 'MMMEd',
	'MMMM', 'MMMMEd', 'MMMMd', 'MMMd', 'Md', 'd', 'h', 'hm', 'hmv',
	'hmvvvv', 'hv', 'hvvvv', 'y', 'yM', 'yMEd', 'yMMM', 'yMMMEEEEd',
	'yMMMEd', 'yMMMM', 'yMMMMEEEEd', 'yMMMMEd', 'yMMMMd', 'yMMMd', 'yMd'];
// a second date differing from PROBE first in each field
const IV_DIFF = {
	y: Date.UTC(2027, 3, 5, 7, 30, 9),
	M: Date.UTC(2026, 3, 5, 7, 30, 9),
	d: Date.UTC(2026, 2, 9, 7, 30, 9),
	a: Date.UTC(2026, 2, 4, 17, 30, 9),
	h: Date.UTC(2026, 2, 4, 7, 30, 9),
	m: Date.UTC(2026, 2, 4, 5, 30, 9),
};

// what ICU formats a range as, as a pattern; null when it formats one
// date
function rangePattern(loc, opts, nm, b) {
	const f = new Intl.DateTimeFormat(loc, opts);
	const hc = f.resolvedOptions().hourCycle || 'h12';
	const parts = f.formatRangeToParts(PROBE, b);
	if (!parts.some(p => p.source === 'endRange'))
		return null;
	return toPattern(parts, opts, nm, hc);
}

function intervals(loc, d, nm) {
	d.iv = {};
	for (const k of IV_KEYS) {
		const o = optionsOf(k);
		if (!o)
			continue;
		const e = {};
		for (const f in IV_DIFF) {
			const p = rangePattern(loc, o, nm, IV_DIFF[f]);
			if (p)
				e[f] = p;
		}
		if (Object.keys(e).length)
			d.iv[k] = e;
	}
}

function rangeJoiners(loc, d, nm) {
	const f = new Intl.DateTimeFormat(loc, { month: 'long', timeZone: 'UTC' });
	const r = f.formatRange(PROBE, Date.UTC(2027, 2, 4));
	const one = f.format(PROBE);
	d.ivSep = quoteLit(r.slice(one.length, r.length - one.length));
	// a date and a range of times within it
	const both = new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'long', day: 'numeric',
		hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
	const dt = new Intl.DateTimeFormat(loc, { year: 'numeric', month: 'long', day: 'numeric',
		timeZone: 'UTC' }).format(PROBE);
	const tr = new Intl.DateTimeFormat(loc, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
		.formatRange(PROBE, IV_DIFF.h);
	const rr = both.formatRange(PROBE, IV_DIFF.h);
	if (!rr.startsWith(dt) || !rr.endsWith(tr))
		throw new Error('range glue: ' + rr);
	d.ivGlue = '{1}' + quoteLit(rr.slice(dt.length, rr.length - tr.length)) + '{0}';
}

function quoteLit(t) {
	return /[A-Za-z']/.test(t) ? "'" + t.replace(/'/g, "''") + "'" : t;
}

// --- time zone names ---

function zoneList() {
	return readFileSync('/usr/share/zoneinfo/tzdata.zi', 'utf8').split('\n')
		.filter(l => l.startsWith('Z ')).map(l => l.split(' ')[1]);
}

function gmt(off, long) {
	if (off === 0)
		return long ? 'GMT+00:00' : 'GMT+0';
	const a = Math.abs(off), h = Math.floor(a / 60), m = a % 60;
	const sign = off < 0 ? '-' : '+';
	if (long)
		return 'GMT' + sign + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
	return 'GMT' + sign + h + (m ? ':' + String(m).padStart(2, '0') : '');
}

function zoneNames(loc, zones) {
	const out = {};
	const t = [Date.UTC(2026, 0, 15, 12), Date.UTC(2026, 6, 15, 12)];
	for (const z of zones) {
		let fs;
		try {
			fs = ['short', 'long', 'shortGeneric', 'longGeneric', 'longOffset'].map(n =>
				new Intl.DateTimeFormat(loc, { timeZone: z, timeZoneName: n }));
		} catch (e) {
			continue;
		}
		const name = (f, at) => f.formatToParts(at).find(p => p.type === 'timeZoneName').value;
		const off = t.map(at => {
			const v = name(fs[4], at);
			const m = /GMT([+-])(\d\d):(\d\d)/.exec(v);
			return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
		});
		const offAt = at => {
			const v = name(fs[4], at);
			const m = /GMT([+-])(\d\d):(\d\d)/.exec(v);
			return m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
		};
		let dstAt = off[0] === off[1] ? -1 : off[0] > off[1] ? 0 : 1;
		const stdAt = dstAt === 0 ? 1 : 0;
		let dstTime = dstAt < 0 ? null : t[dstAt], dso = dstAt < 0 ? null : off[dstAt];
		// one without summer time now may have had it: its name then,
		// where it was ahead of the time it keeps now
		for (let y = 2025; dstTime === null && y >= 1990; y--) {
			const a = Date.UTC(y, 0, 15, 12), b = Date.UTC(y, 6, 15, 12);
			const oa = offAt(a), ob = offAt(b);
			if (oa !== ob && Math.max(oa, ob) > off[stdAt]) {
				dstTime = oa > ob ? a : b;
				dso = Math.max(oa, ob);
			}
		}
		const e = [
			name(fs[0], t[stdAt]), dstTime === null ? null : name(fs[0], dstTime),
			name(fs[1], t[stdAt]), dstTime === null ? null : name(fs[1], dstTime),
			name(fs[2], t[stdAt]), name(fs[3], t[stdAt])];
		const so = off[stdAt];
		if (dso === null)
			dso = so;
		if (e[0] === gmt(so, false)) e[0] = null;
		if (e[1] === gmt(dso, false)) e[1] = null;
		if (e[2] === gmt(so, true)) e[2] = null;
		if (e[3] === gmt(dso, true)) e[3] = null;
		if (e[4] === gmt(so, false)) e[4] = null;
		if (e[5] === gmt(so, true)) e[5] = null;
		if (e.some(x => x !== null))
			out[z] = e;
	}
	return out;
}

// --- output ---

function cstr(s) {
	if (s === null || s === undefined)
		return 'NULL';
	let o = '"';
	for (const b of Buffer.from(s, 'utf8')) {
		if (b === 0x22) o += '\\"';
		else if (b === 0x5c) o += '\\\\';
		else if (b >= 0x20 && b < 0x7f && b !== 0x3f) o += String.fromCharCode(b);
		else o += '\\' + b.toString(8).padStart(3, '0');
	}
	return o + '"';
}

function list(a) {
	return '{' + a.map(cstr).join(', ') + '}';
}

const zones = zoneList();
const out = [];
let enNames = null;
for (const loc of LOCALES) {
	const { d, nm } = localeData(loc);
	validate(loc, d, nm);
	rangeJoiners(loc, d, nm);
	intervals(loc, d, nm);
	let tz = zoneNames(loc, zones);
	if (enNames) {
		// only what differs from English as a whole
		for (const z of Object.keys(tz))
			if (JSON.stringify(tz[z]) === JSON.stringify(enNames[z]))
				delete tz[z];
	} else {
		enNames = tz;
	}
	out.push({ loc, d, nm, tz });
	log(loc + ': ' + Object.keys(d.iv).length + ' range skeletons, ' +
	    Object.keys(tz).length + ' zone names');
}

const w = [];
w.push('/* generated by scripts/gen-intl-data.mjs from ICU ' + process.versions.icu +
       ' (CLDR ' + process.versions.cldr + ');');
w.push(' * CLDR data is under the Unicode licence: Copyright Unicode, Inc. */');
w.push('#define INTL_ICU_VERSION "' + process.versions.icu + '"');
w.push('#define INTL_CLDR_VERSION "' + process.versions.cldr + '"');
w.push('#define INTL_LOCALES ' + out.length);
for (const [i, x] of out.entries()) {
	const zs = Object.keys(x.tz).sort();
	w.push('static const struct intl_tzname intl_tz_' + i + '[] = {');
	for (const z of zs)
		w.push('\t{' + cstr(z) + ', ' + list(x.tz[z]) + '},');
	if (!zs.length)
		w.push('\t{NULL, {NULL}},');
	w.push('};');
}
w.push('static const struct intl_locale intl_locales[] = {');
for (const [i, x] of out.entries()) {
	const nm = x.nm;
	const json = { ...x.d };
	delete json._cand;
	w.push('\t{ ' + cstr(x.loc) + ',');
	w.push('\t  ' + cstr(JSON.stringify(json)) + ',');
	w.push('\t  {{' + WIDTHS.map(k => list(nm.month[k])).join(',\n\t    ') + '},');
	w.push('\t   {' + WIDTHS.map(k => list(nm.monthAlone[k])).join(',\n\t    ') + '}},');
	w.push('\t  {' + WIDTHS.map(k => list(nm.weekday[k])).join(',\n\t   ') + '},');
	w.push('\t  {' + WIDTHS.map(k => list(nm.era[k])).join(', ') + '},');
	w.push('\t  ' + list(nm.ampm) + ',');
	w.push('\t  {' + WIDTHS.map(k => list(nm.dayPeriod[k])).join(',\n\t   ') + '},');
	w.push('\t  intl_tz_' + i + ', ' + Object.keys(x.tz).length + ' },');
}
w.push('};');
process.stdout.write(w.join('\n') + '\n');
