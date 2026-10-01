#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Write tests/dom/intl-list.html: Intl.ListFormat and Intl.DurationFormat
// cases with what ICU in Node gives for them, for the browser to be
// checked against.
//
//   node scripts/gen-intl-list-tests.mjs > tests/dom/intl-list.html
//
// Run it under a Node that has Intl.DurationFormat (24 or later) and
// whose ICU has the CLDR version resources/intl.pak was made from.
//
// Where VitaSurf follows ECMA-402 and Node's V8 does not, the case is
// left out, or checked as text only: V8 puts the time separator straight
// after a unit written as words ("1 day:00:00", "2 Min.:3") where the
// spec joins them as a list ("1 day, 00:00"), it leaves an empty string
// out of a list's parts where the spec has an empty element, and it
// formats { hours: 'x' } as nothing where the spec throws.

export const LOCALES = ['en', 'en-GB', 'de', 'fr', 'es', 'es-MX', 'it',
	'pt', 'nl', 'sv', 'fi', 'da', 'pl', 'ru', 'uk', 'tr', 'ar', 'ar-EG',
	'he', 'fa', 'hi', 'bn', 'ja', 'zh', 'zh-TW', 'ko', 'th', 'vi', 'id',
	'sw', 'cy', 'ga', 'mt', 'my', 'ur', 'sr-Latn', 'xx-YY',
	'en-u-nu-arab'];

const LISTS = [[], ['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd'],
	['one', 'two', 'three', 'four', 'five'], ['agua', 'hielo'],
	['agua', 'hierro'], ['agua', 'hiato'], ['siete', 'ocho'],
	['uno', 'once'], ['a', 'hora'], ['x', '11'], ['x', '11 y'],
	['x', '110'], ['\u05d0', 'B'], ['\u05d0', '\u05d1'], ['\u05d0', '1'],
	['', ''], ['a', '']];

const DURATIONS = [{ hours: 1, minutes: 2, seconds: 3 },
	{ hours: 1, minutes: 2, seconds: 3, milliseconds: 45 },
	{ years: 1, days: 2, hours: 3, milliseconds: 4 },
	{ years: -1, days: -2 }, { minutes: -1, seconds: 0, milliseconds: -5 },
	{ hours: 1, minutes: 2 }, { days: 1, hours: 1 },
	{ seconds: 1, milliseconds: 2, microseconds: 3, nanoseconds: 4 },
	{ hours: 3, minutes: 0, seconds: 0 }, { seconds: 0 },
	{ milliseconds: 1500 }, { microseconds: 2000001 },
	{ seconds: 59, milliseconds: 999, microseconds: 999, nanoseconds: 999 },
	{ days: 0 }, { years: 2, months: 3, weeks: 4, days: 5, hours: 6,
		minutes: 7, seconds: 8, milliseconds: 9, microseconds: 10,
		nanoseconds: 11 }, { hours: -0 }, { minutes: -5 },
	{ hours: 1234567, minutes: 5 }, { years: 4294967295 },
	{ seconds: 9007199254740991 }, { hours: 25, seconds: 61 }];

const OPTIONS = [{}, { style: 'long' }, { style: 'narrow' },
	{ style: 'digital' }, { style: 'digital', fractionalDigits: 2 },
	{ hours: 'numeric' }, { minutes: 'numeric' }, { seconds: 'numeric' },
	{ milliseconds: 'long' }, { style: 'digital', hours: 'long' },
	{ style: 'long', hoursDisplay: 'always' },
	{ yearsDisplay: 'always', style: 'narrow' },
	{ style: 'digital', fractionalDigits: 0 },
	{ milliseconds: 'numeric', fractionalDigits: 3 }, { hours: '2-digit' },
	{ style: 'digital', hoursDisplay: 'auto' },
	{ style: 'digital', secondsDisplay: 'auto', minutesDisplay: 'auto' },
	{ numberingSystem: 'arab' }, { style: 'short', days: 'long',
		hours: 'narrow' }];

const BAD_OPTIONS = [{ style: 'tiny' }, { hours: 'fractional' },
	{ style: 'digital', minutes: 'long' },
	{ milliseconds: '2-digit' }, { hours: 'numeric', minutes: 'long' },
	{ seconds: 'numeric', milliseconds: 'long' },
	{ millisecondsDisplay: 'always', milliseconds: 'numeric' },
	{ fractionalDigits: 10 }, { fractionalDigits: -1 },
	{ numberingSystem: 'a' }, { yearsDisplay: 'never' }, 'digital'];

const BAD_DURATIONS = [{}, { hours: 1.5 }, { hours: 1, minutes: -1 },
	{ hours: Infinity }, { years: 4294967296 },
	{ seconds: 9007199254740992 }, 'PT1H', 5, null,
	{ days: 104249991375 }];

let seed = 7;
function rnd(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
}

function err(f) {
	try {
		return f();
	} catch (e) {
		return { err: e.constructor.name };
	}
}

// V8's separator after a unit in words
function v8Quirk(parts) {
	if (!Array.isArray(parts))
		return false;
	const words = new Set(parts.filter(p => p.type === 'unit')
		.map(p => p.unit));

	return parts.some((p, i) => i > 0 && p.type === 'literal' && !p.unit &&
		/^[:.\u066b]$/.test(p.value) && words.has(parts[i - 1].unit));
}

// what JSON keeps of a value
function enc(v) {
	if (typeof v === 'number' && !isFinite(v))
		return { num: String(v) };
	if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
		const o = {};

		for (const k in v)
			o[k] = enc(v[k]);
		return o;
	}
	return v;
}

export function cases(full) {
	const out = [];
	const locales = full ? LOCALES : ['en', 'de', 'es', 'fi', 'he', 'ar',
		'ja', 'ru', 'zh-TW', 'xx-YY', 'en-u-nu-arab'];

	for (const loc of locales) {
		for (const type of ['conjunction', 'disjunction', 'unit']) {
			for (const style of ['long', 'short', 'narrow']) {
				const o = { type, style };
				const f = new Intl.ListFormat(loc, o);

				out.push({ k: 'lf', loc, o, r: f.resolvedOptions(),
					v: LISTS.filter((l, i) => full || i < 6 ||
						loc === 'es' || loc === 'he')
						.map(l => [l, l.indexOf('') >= 0 ?
							{ str: f.format(l) } :
							f.formatToParts(l)]) });
			}
		}
	}
	for (const o of [undefined, {}, { type: 'bogus' }, { style: 'tiny' },
			 null, 'unit']) {
		const f = err(() => new Intl.ListFormat('en', o));

		out.push(f.err ? { k: 'lf', loc: 'en', o, err: f.err, v: [] } :
			{ k: 'lf', loc: 'en', o, r: f.resolvedOptions(), v: [] });
	}
	for (const loc of locales) {
		for (const o of OPTIONS) {
			if (!full && rnd(3) === 0 && loc !== 'en')
				continue;
			const f = new Intl.DurationFormat(loc, o);
			const r = f.resolvedOptions();
			const v = DURATIONS.filter((d, i) => full || loc === 'en' ||
				i % 4 === 0).map(d =>
				[enc(d), err(() => f.formatToParts(d))])
				.filter(x => !v8Quirk(x[1]));

			out.push({ k: 'df', loc, o, r, v });
		}
	}
	for (const o of BAD_OPTIONS)
		out.push({ k: 'df', loc: 'en', o, err: err(() =>
			new Intl.DurationFormat('en', o)).err, v: [] });
	{
		const f = new Intl.DurationFormat('en');

		out.push({ k: 'df', loc: 'en', o: {}, r: f.resolvedOptions(),
			v: BAD_DURATIONS.map(d => [enc(d), err(() => f.format(d))]) });
	}
	for (let i = 0; i < (full ? 400 : 60); i++) {
		const loc = LOCALES[rnd(LOCALES.length)];
		const o = OPTIONS[rnd(OPTIONS.length)];
		const d = DURATIONS[rnd(DURATIONS.length)];
		const f = new Intl.DurationFormat(loc, o);
		const p = err(() => f.formatToParts(d));

		if (!v8Quirk(p))
			out.push({ k: 'df', loc, o, r: f.resolvedOptions(),
				v: [[enc(d), p]] });
	}
	for (const l of [['en', 'es', 'xx'], ['he', 'zh-Hant-TW'], 'sr-Latn-RS'])
		out.push({ k: 'sup', l,
			s: [Intl.ListFormat.supportedLocalesOf(l),
			    Intl.DurationFormat.supportedLocalesOf(l)] });
	return out;
}

// the check, shared by the page and by a run under Node
export function CHECK(CASES, I) {
	var fails = [], n = 0;

	function same(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	function dec(v) {
		var o, k;

		if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
			if ('num' in v && Object.keys(v).length === 1)
				return Number(v.num);
			o = {};
			for (k in v)
				o[k] = dec(v[k]);
			return o;
		}
		return v;
	}
	function err(f) {
		try {
			return f();
		} catch (e) {
			return { err: e.constructor.name };
		}
	}
	CASES.forEach(function (c) {
		var what = c.k + ' ' + c.loc + ' ' + JSON.stringify(c.o), f, got;

		n++;
		if (c.k === 'sup') {
			got = [I.ListFormat.supportedLocalesOf(c.l),
				I.DurationFormat.supportedLocalesOf(c.l)];
			if (!same(got, c.s))
				fails.push('sup ' + JSON.stringify(c.l) + ': ' +
					   JSON.stringify(got) + ', ICU ' +
					   JSON.stringify(c.s));
			return;
		}
		try {
			f = c.k === 'lf' ? new I.ListFormat(c.loc, c.o) :
				new I.DurationFormat(c.loc, c.o);
		} catch (e) {
			if (e.constructor.name !== c.err)
				fails.push(what + ': ' + e + ', ICU ' +
					   (c.err || 'constructs'));
			return;
		}
		if (c.err)
			return fails.push(what + ': constructs, ICU throws ' + c.err);
		got = f.resolvedOptions();
		if (!same(got, c.r))
			fails.push(what + ' options: ' + JSON.stringify(got) + ', ICU ' +
				   JSON.stringify(c.r));
		c.v.forEach(function (x) {
			var w = what + ' ' + JSON.stringify(x[0]);

			n++;
			got = err(function () {
				if (x[1] && x[1].str !== undefined)
					return { str: f.format(x[0]) };
				return c.k === 'lf' ? f.formatToParts(x[0]) :
					x[1] && x[1].err ? f.format(dec(x[0])) :
					f.formatToParts(dec(x[0]));
			});
			if (x[1] && x[1].err && !got.err)
				got = 'formats';
			if (!same(got, x[1]))
				fails.push(w + ': ' + JSON.stringify(got) + ', ICU ' +
					   JSON.stringify(x[1]));
		});
	});
	return { n: n, fails: fails };
}

function html() {
	const list = cases(false);

	return `<!DOCTYPE html>
<!-- Intl.ListFormat and Intl.DurationFormat against ICU
     (${process.versions.icu}, CLDR ${process.versions.cldr}), written by
     scripts/gen-intl-list-tests.mjs: what Node gives for each case. -->
<html><head><meta charset="utf-8"><title>t</title></head><body><div id="out"></div>
<script>
var CASES = ${JSON.stringify(list)};
${CHECK.toString()}
var r = CHECK(CASES, Intl), m = (r.fails.length ? 'FAIL ' : 'PASS ') +
	(r.n - r.fails.length) + ' of ' + r.n + ' cases as ICU gives them';
r.fails.slice(0, 40).forEach(function (f) { console.log('FAIL ' + f); });
console.log(m);
document.getElementById('out').textContent = m;
</script></body></html>
`;
}

if (import.meta.url === 'file://' + process.argv[1])
	process.stdout.write(html());
