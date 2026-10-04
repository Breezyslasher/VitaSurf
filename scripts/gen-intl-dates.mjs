//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Intl.DateTimeFormat's data for resources/intl.pak (vita/js/intl.js), from
// ICU's own (the data release whose ICU Node has, icu4c-<version>-
// data.zip): each of ICU's locale bundles with only what DateFormatSymbols,
// DateTimePatternGenerator and DateIntervalInfo read from it, as ICU has
// it, aliases and all, so that vita/js/intl_pattern.js can look things up
// as ICU's resource bundles do, falling back and following aliases
// through the same bundles. A bundle keeps only what it says itself, so
// the whole is half a megabyte packed. The ICU data is under the Unicode
// licence, which is GPL-compatible. scripts/gen-intl-numbers.mjs calls
// dateEntries() when given the unpacked data directory.
//
// Entries:
//   dt:<bundle>  a bundle's calendar data and the field names it has
//   dt:index     the bundles, their parents and aliases (bundleEntries in
//                scripts/icu-res.mjs)
//   dt:periods   ICU's day period rules (misc/dayPeriods.txt) by locale
//   dt:hours     ICU's preferred hour cycle (timeData) by region or
//                language_region
//   dt:eras      each calendar's eras (supplementalData's calendarData):
//                the start of each as [year, month, day], or null for one
//                that only ends; tentative eras are left out, as ICU
//                leaves them out unless told otherwise
//   dt:rbnf      the algorithmic numbering systems date patterns name in
//                their number overrides (Hebrew numerals, Chinese days,
//                Roman months, the Japanese first year): { system: { s:
//                the rule set it starts from, r: { rule set: its rules,
//                as rbnf/*.txt writes them } } }, with only the rule
//                sets reached from the first

import path from 'path';
import { Tree, bundleEntries } from './icu-res.mjs';


// what is read from a calendar
const KEEP = new Set(['DateTimePatterns', 'DateTimePatterns%atTime',
	'availableFormats', 'appendItems', 'monthNames', 'dayNames', 'eras',
	'AmPmMarkers', 'AmPmMarkersAbbr', 'AmPmMarkersNarrow', 'dayPeriod',
	'monthPatterns', 'cyclicNameSets', 'intervalFormats']);
// DateTimePatternGenerator's field names
const FIELDS = ['era', 'year', 'quarter', 'month', 'week', 'weekOfMonth',
	'weekday', 'dayOfYear', 'weekdayOfMonth', 'day', 'dayperiod', 'hour',
	'minute', 'second', 'zone'];
// DayPeriodRules' periods, in its order
const PERIODS = ['midnight', 'noon', 'morning1', 'afternoon1',
	'evening1', 'night1', 'morning2', 'afternoon2', 'evening2', 'night2',
	'am', 'pm'];

function isAlias(v) {
	return v && typeof v === 'object' && !Array.isArray(v) &&
		typeof v.alias === 'string';
}

// a bundle's own date data
function bundleData(b) {
	const o = {};

	if (b.calendar) {
		o.calendar = {};
		for (const c in b.calendar) {
			const v = b.calendar[c];

			if (typeof v !== 'object' || isAlias(v)) {
				o.calendar[c] = v;
				continue;
			}
			const w = {};

			for (const k in v)
				if (KEEP.has(k))
					w[k] = v[k];
			if (Object.keys(w).length)
				o.calendar[c] = w;
		}
	}
	if (b.fields) {
		// the names, and what an alias among them points at
		const want = FIELDS.slice(), w = {};

		while (want.length) {
			const k = want.shift(), v = b.fields[k];

			if (v === undefined || k in w)
				continue;
			if (isAlias(v)) {
				w[k] = v;
				const m = /^\/LOCALE\/fields\/([^/]+)$/.exec(v.alias);

				if (m)
					want.push(m[1]);
			} else if (v.dn !== undefined) {
				w[k] = { dn: v.dn };
			}
		}
		if (Object.keys(w).length)
			o.fields = w;
	}
	return o;
}

// ICU's day period rules: per locale, the period of each hour and
// whether it has noon and midnight
function dayPeriods(dir) {
	const misc = new Tree(path.join(dir, 'misc'));
	const dp = misc.file('dayPeriods');
	const sets = {};

	for (const name in dp.rules) {
		const r = dp.rules[name], hours = new Array(24).fill(-1);
		const hour = s => +s.split(':')[0];

		for (const p in r) {
			if (r[p].at !== undefined)
				continue;
			let h = hour(r[p].from);
			const end = hour(r[p].before) % 24;

			do {
				hours[h] = PERIODS.indexOf(p);
				h = (h + 1) % 24;
			} while (h !== end);
		}
		sets[name] = { h: hours, noon: r.noon !== undefined ? 1 : 0,
			midnight: r.midnight !== undefined ? 1 : 0 };
	}
	return { locales: dp.locales, sets };
}

// ICU's timeData: the preferred hour symbol by region or language_region
function hours(dir) {
	const sup = new Tree(path.join(dir, 'misc')).file('supplementalData');
	const out = {};

	for (const k in sup.timeData) {
		const e = sup.timeData[k];
		let pref = e.preferred;

		if (pref === undefined)
			pref = Array.isArray(e.allowed) ? e.allowed[0] : e.allowed;
		out[k] = pref;
	}
	return out;
}

// each calendar's eras, by code
function eras(dir) {
	const cd = new Tree(path.join(dir, 'misc')).file('supplementalData')
		.calendarData;
	const out = {};

	for (const c in cd) {
		const e = cd[c].eras, list = [];

		if (!e)
			continue;
		for (const k in e) {
			if (e[k].named !== 'false')
				list[+k] = e[k].start || null;
		}
		for (let i = 0; i < list.length; i++)
			if (list[i] === undefined)
				list[i] = null;
		out[c] = list;
	}
	return out;
}

// the numbering systems the bundles' pattern overrides name ("hebr",
// "d=hanidays;y=..."), where they are algorithmic: the rule sets ICU's
// RuleBasedNumberFormat would format with
function rbnf(dir, entries) {
	const misc = new Tree(path.join(dir, 'misc'));
	const systems = misc.file('numberingSystems').numberingSystems;
	const rules = new Tree(path.join(dir, 'rbnf'));
	const named = new Set();
	// a pattern with an override is [pattern, override] in a calendar's
	// DateTimePatterns
	const walk = (v, inPatterns) => {
		if (Array.isArray(v)) {
			if (inPatterns && v.length === 2 &&
			    typeof v[0] === 'string' && typeof v[1] === 'string') {
				for (const part of v[1].split(';'))
					named.add(part.slice(part.indexOf('=') + 1));
			}
			v.forEach(e => walk(e, inPatterns));
		} else if (v && typeof v === 'object') {
			for (const k in v)
				walk(v[k], inPatterns || /^DateTimePatterns/.test(k));
		}
	};

	for (const k in entries) {
		if (k !== 'dt:index')
			walk(entries[k], false);
	}
	const out = {};

	for (const ns of [...named].sort()) {
		const sys = systems[ns];

		if (!sys || sys.algorithmic !== 1)
			continue;
		// "%hebrew" is root's numbering system rules,
		// "ja/SpelloutRules/%x" a locale's rules of a kind
		const desc = sys.desc.split('/');
		const start = desc[desc.length - 1];
		const list = desc.length === 3 ?
			rules.file(desc[0]).RBNFRules[desc[1]] :
			rules.file('root').RBNFRules.NumberingSystemRules;
		const sets = {};
		let cur = null;

		for (const line of list) {
			const m = /^(%%?[\w-]+):$/.exec(line);

			if (m)
				sets[cur = m[1]] = [];
			else
				sets[cur].push(line);
		}
		const keep = {}, todo = [start];

		while (todo.length) {
			const name = todo.pop();

			if (keep[name])
				continue;
			if (!sets[name])
				throw new Error(ns + ': no rule set ' + name);
			keep[name] = sets[name];
			for (const r of sets[name])
				for (const ref of r.match(/%%?[\w-]+/g) || [])
					todo.push(ref);
		}
		out[ns] = { s: start, r: keep };
	}
	return out;
}

export function dateEntries(icuDir, locales) {
	const entries = bundleEntries(path.join(icuDir, 'locales'), 'dt',
				      bundleData, locales);

	entries['dt:periods'] = dayPeriods(icuDir);
	entries['dt:hours'] = hours(icuDir);
	entries['dt:eras'] = eras(icuDir);
	entries['dt:rbnf'] = rbnf(icuDir, entries);
	return entries;
}
