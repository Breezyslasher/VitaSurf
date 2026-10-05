#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Write tests/dom/intl-datetimeformat.html: Intl.DateTimeFormat cases
// with what V8 and ICU in Node give for them, for the browser to be
// checked against. The options are those Home Assistant uses, the styles,
// and a spread of others, in a spread of locales (other numbering
// systems, 12- and 24-hour regions, locales without a bundle of their
// own, algorithmic numbers in patterns); every calendar; time zones and
// their names across daylight saving, zones off the hour and both
// hemispheres; formatRange; Intl.supportedValuesOf; and options V8
// refuses.
//
//   node scripts/gen-intl-tests.mjs > tests/dom/intl-datetimeformat.html
//
// Run it under a Node whose ICU is the version resources/intl.pak was
// made from. cases(true) is the full set, for a run under Node against
// the implementation itself (CHECK(cases(true), Intl)); the page has a
// sample, which a Vita has to load and run.
//
// V8 fails on formatToParts where a pattern has a field it has no part
// type for, the week year (Y) that some of CLDR's patterns have: Galician's
// full date in calendars other than the Gregorian one, and the Swiss
// German pattern an era-crossing range with a weekday falls back to
// (gd, ksh and sc have others, but no case here reaches them). Those
// cases are checked as text only.

export const LOCALES = ['en', 'en-US', 'en-GB', 'en-IN', 'en-CA', 'en-AU',
	'de', 'de-CH', 'fr', 'fr-CA', 'es', 'es-MX', 'it', 'pt', 'pt-BR', 'nl',
	'sv', 'fi', 'da', 'nb', 'pl', 'cs', 'ru', 'uk', 'el', 'tr', 'ar',
	'ar-EG', 'ar-SA', 'he', 'fa', 'ur', 'hi', 'bn', 'mr', 'ja', 'zh',
	'zh-TW', 'zh-HK', 'ko', 'th', 'vi', 'id', 'sw', 'am', 'my', 'ne', 'gl',
	'haw', 'ff-GH', 'ku-IQ', 'kk-CN', 'sr-ME', 'uz-AF', 'xx-YY',
	'en-u-nu-arab', 'en-u-hc-h23', 'ja-u-ca-japanese', 'he-u-ca-hebrew',
	'zh-u-ca-chinese', 'ar-u-ca-islamic-umalqura'];

const TIMES = [
	Date.UTC(2026, 2, 4, 5, 6, 7, 89),
	Date.UTC(2026, 8, 30, 19, 5, 0),
	Date.UTC(2026, 11, 31, 23, 59, 59, 999),
	Date.UTC(2026, 6, 15, 12, 0, 0),
	Date.UTC(1999, 0, 1, 0, 0, 0),
	Date.UTC(2041, 9, 27, 1, 30, 0),
	Date.UTC(2026, 2, 29, 1, 30, 0),	// Europe changes clocks
	Date.UTC(2026, 10, 1, 6, 30, 0),	// the US changes back
	Date.UTC(1500, 5, 1, 9, 0, 0),		// before the Gregorian calendar
	Date.UTC(-50, 4, 5, 3, 4, 5),		// BC
];
const ZONES = ['UTC', 'America/New_York', 'Europe/Berlin',
	'Australia/Sydney', 'Asia/Kolkata', 'America/St_Johns',
	'Pacific/Chatham', 'Asia/Kathmandu', 'Europe/London',
	'America/Sao_Paulo', 'Africa/Cairo', 'America/Los_Angeles',
	'Pacific/Honolulu', 'Asia/Tokyo', 'Europe/Dublin', 'Africa/Casablanca',
	'Antarctica/Troll', 'Asia/Calcutta', 'US/Eastern', 'Etc/GMT+5',
	'+05:30', '-03'];
const CALENDARS = ['buddhist', 'chinese', 'coptic', 'dangi', 'ethioaa',
	'ethiopic', 'gregory', 'hebrew', 'indian', 'islamic', 'islamic-civil',
	'islamic-rgsa', 'islamic-tbla', 'islamic-umalqura', 'iso8601',
	'japanese', 'persian', 'roc'];

// Home Assistant's own
const HA = [
	{ year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' },
	{ year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' },
	{ year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23' },
	{ year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' },
	{ year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
	{ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
	{ hour: 'numeric', minute: '2-digit' },
	{ hour: 'numeric', minute: '2-digit', hourCycle: 'h23' },
	{ hour: 'numeric', minute: '2-digit', hour12: false },
	{ hour: 'numeric', minute: '2-digit', second: '2-digit' },
	{ weekday: 'long', hour: 'numeric', minute: '2-digit' },
	{ weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' },
	{ weekday: 'short', month: 'short', day: 'numeric' },
	{ weekday: 'long', month: 'long', day: 'numeric' },
	{ weekday: 'short' }, { weekday: 'long' },
	{ month: 'long', year: 'numeric' }, { month: 'long' }, { month: 'short' },
	{ day: 'numeric', month: 'short' }, { year: 'numeric' },
	{ year: 'numeric', month: 'short', day: 'numeric' },
	{ year: 'numeric', month: 'long', day: 'numeric' },
	{ year: 'numeric', month: 'numeric', day: 'numeric' },
	{ year: 'numeric', month: '2-digit', day: '2-digit' },
];
const STYLES = [];
for (const d of [undefined, 'full', 'long', 'medium', 'short'])
	for (const t of [undefined, 'full', 'long', 'medium', 'short'])
		if (d || t)
			STYLES.push(Object.assign(d ? { dateStyle: d } : {},
						  t ? { timeStyle: t } : {}));
const OTHERS = [
	{}, { timeZoneName: 'short' }, { hour: 'numeric', timeZoneName: 'long' },
	{ hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset' },
	{ hour: 'numeric', minute: '2-digit', timeZoneName: 'longOffset' },
	{ hour: 'numeric', minute: '2-digit', timeZoneName: 'shortGeneric' },
	{ hour: 'numeric', minute: '2-digit', timeZoneName: 'longGeneric' },
	{ hour: 'numeric', dayPeriod: 'short' }, { hour: 'numeric', dayPeriod: 'long' },
	{ dayPeriod: 'narrow' },
	{ hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 },
	{ minute: '2-digit', second: '2-digit', fractionalSecondDigits: 1 },
	{ era: 'short', year: 'numeric' }, { era: 'long', year: 'numeric', month: 'long', day: 'numeric' },
	{ era: 'narrow', month: 'narrow', weekday: 'narrow' },
	{ hourCycle: 'h11', hour: 'numeric' }, { hourCycle: 'h24', hour: 'numeric', minute: '2-digit' },
	{ hour12: true, timeStyle: 'short' }, { hour12: false, timeStyle: 'medium' },
	{ hourCycle: 'h24', dateStyle: 'short', timeStyle: 'short' },
];

// a spread of others, the same every run
let seed = 7;
function rnd(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
}
const PICK = {
	weekday: [undefined, 'short', 'long', 'narrow'],
	era: [undefined, undefined, undefined, 'short', 'long'],
	year: [undefined, 'numeric', '2-digit'],
	month: [undefined, 'numeric', '2-digit', 'short', 'long', 'narrow'],
	day: [undefined, 'numeric', '2-digit'],
	dayPeriod: [undefined, undefined, undefined, 'short', 'long'],
	hour: [undefined, 'numeric', '2-digit'],
	minute: [undefined, 'numeric', '2-digit'],
	second: [undefined, 'numeric', '2-digit'],
	hourCycle: [undefined, undefined, 'h11', 'h12', 'h23', 'h24'],
	timeZoneName: [undefined, undefined, undefined, 'short', 'long',
		'shortOffset', 'longGeneric'],
};
const RANDOM = [];
for (let i = 0; i < 80; i++) {
	const o = {};

	for (const k in PICK) {
		const v = PICK[k][rnd(PICK[k].length)];

		if (v !== undefined)
			o[k] = v;
	}
	RANDOM.push(o);
}

const RANGES = [
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 2, 4, 5, 6, 0, 1)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 2, 4, 5, 6, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 2, 4, 7, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 2, 4, 17, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 2, 9, 7, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 4, 9, 7, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2027, 4, 9, 7, 30)],
	[Date.UTC(-50, 4, 5, 3, 4), Date.UTC(70, 3, 5, 3, 4)],
	[Date.UTC(2026, 2, 9, 7, 30), Date.UTC(2026, 2, 4, 5, 6)],
];
const RANGE_OPTIONS = [...HA.slice(0, 14), ...STYLES, { day: 'numeric' },
	{ month: 'long', minute: 'numeric' }, { hour: 'numeric', hourCycle: 'h11' },
	{ hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }];

// Galician's week year, where V8 fails on formatToParts
function weekYear(loc, o) {
	return /^gl\b/.test(loc) && o.calendar && o.calendar !== 'gregory' &&
		o.calendar !== 'iso8601' && (o.dateStyle === 'full');
}

// a constructor's case: what it resolves to and formats the times as
function fcase(loc, o, times) {
	let f;

	try {
		f = new Intl.DateTimeFormat(loc, o);
	} catch (e) {
		return { k: 'f', loc, o, err: e.constructor.name };
	}
	const text = weekYear(loc, o);

	return { k: 'f', loc, o, r: f.resolvedOptions(), v: times.map(t =>
		[t, f.format(t), text ? null : f.formatToParts(t)]) };
}

function rcase(loc, o, ranges) {
	const f = new Intl.DateTimeFormat(loc, o);
	const eras = (a, b) => (a < -62135596800000) !== (b < -62135596800000);

	return { k: 'r', loc, o, v: ranges.map(([a, b]) =>
		[a, b, f.formatRange(a, b), loc === 'de-CH' && eras(a, b) ? null :
		 f.formatRangeToParts(a, b)]) };
}

export function cases(full) {
	const out = [];
	// the page's sample: every option set in English, a third of them
	// elsewhere, at one time each
	const locales = full ? LOCALES : ['en', 'en-GB', 'de', 'ar-EG', 'he',
		'fa', 'hi', 'ja', 'zh-TW', 'th', 'ru', 'haw', 'ff-GH',
		'en-u-hc-h23', 'ja-u-ca-japanese'];
	const times = (i) => full ? TIMES : [TIMES[i % TIMES.length]];
	let i = 0;

	for (const loc of locales) {
		[...HA, ...STYLES, ...OTHERS].forEach((o, j) => {
			if (full || loc === 'en' || j % 3 === i % 3)
				out.push(fcase(loc, Object.assign({ timeZone:
					ZONES[i % ZONES.length] }, o), times(i)));
			i++;
		});
		for (const o of full ? RANDOM : RANDOM.slice(0, 4))
			out.push(fcase(loc, Object.assign({ timeZone:
				ZONES[(i * 7) % ZONES.length] }, o), times(i++)));
	}
	// every calendar, in locales with names for them
	for (const loc of full ? ['en', 'ar', 'he', 'zh', 'ja', 'fa', 'th',
			     'ko', 'am', 'hi', 'gl'] : ['en', 'ar', 'zh'])
		for (const calendar of CALENDARS)
			for (const o of [{ dateStyle: 'full' }, { dateStyle: 'medium' },
					 { era: 'short', year: 'numeric', month: 'long',
					   day: 'numeric' }, { year: 'numeric',
					   month: 'numeric', day: 'numeric' }])
				if (full || o.dateStyle === 'full' || loc === 'en')
					out.push(fcase(loc, Object.assign({ timeZone: 'UTC',
						calendar }, o), times(i++)));
	// every zone at every time, in names of each kind
	for (const loc of full ? ['en', 'de', 'ja', 'es-MX', 'ar'] : ['en'])
		for (const timeZone of ZONES)
			for (const timeZoneName of ['short', 'long', 'shortOffset',
				'longOffset', 'shortGeneric', 'longGeneric'])
				out.push(fcase(loc, { timeZone, timeZoneName, hour:
					'numeric' }, full ? TIMES : [TIMES[0], TIMES[3]]));
	// ranges
	for (const loc of full ? LOCALES : ['en', 'de', 'ja', 'ar-EG'])
		for (const o of full ? RANGE_OPTIONS : RANGE_OPTIONS.filter((x, j) =>
			j % 4 === 0))
			out.push(rcase(loc, Object.assign({ timeZone: 'America/New_York' },
				o), full ? RANGES : RANGES.slice(2, 7)));
	// what V8 refuses
	for (const o of [{ timeZone: 'Mars/Phobos' }, { timeZone: '+25:00' },
			 { calendar: 'gregory!' }, { numberingSystem: 'x' },
			 { timeStyle: 'short', hour: 'numeric' },
			 { dateStyle: 'tiny' }, { fractionalSecondDigits: 4 },
			 { hourCycle: 'h25' }, { timeZone: 'utc' },
			 { timeZone: 'etc/gmt-14' }, { timeZone: 'america/argentina/comodrivadavia' }])
		out.push(fcase('en', o, [TIMES[0]]));
	out.push({ k: 's', key: 'calendar', v: Intl.supportedValuesOf('calendar') });
	out.push({ k: 's', key: 'timeZone', v: Intl.supportedValuesOf('timeZone') });
	return out;
}

// checks the cases against an Intl, the page's or one under Node
export function CHECK(list, I) {
	var fails = [], n = 0;

	function same(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	function err(fn) {
		try {
			return fn();
		} catch (e) {
			return { err: e.constructor.name };
		}
	}
	list.forEach(function (c) {
		var what = c.loc + ' ' + JSON.stringify(c.o), f;

		if (c.k === 's') {
			n++;
			var got = err(function () {
				return I.supportedValuesOf(c.key);
			});
			if (!same(got, c.v))
				fails.push('supportedValuesOf ' + c.key + ': ' +
					   JSON.stringify(got).slice(0, 200));
			return;
		}
		n++;
		try {
			f = new I.DateTimeFormat(c.loc, c.o);
		} catch (e) {
			if (e.constructor.name !== c.err)
				fails.push(what + ': ' + e + ', V8 ' + (c.err || 'constructs'));
			return;
		}
		if (c.err)
			return fails.push(what + ': constructs, V8 throws ' + c.err);
		if (c.k === 'f' && !same(f.resolvedOptions(), c.r))
			fails.push(what + ' options: ' + JSON.stringify(f.resolvedOptions()) +
				   ', V8 ' + JSON.stringify(c.r));
		c.v.forEach(function (x) {
			var w, got;

			n++;
			if (c.k === 'f') {
				w = what + ' ' + new Date(x[0]).toISOString();
				got = err(function () {
					return f.format(x[0]);
				});
				if (!same(got, x[1]))
					return fails.push(w + ': ' + JSON.stringify(got) + ', V8 ' +
							  JSON.stringify(x[1]));
				if (x[2] === null)
					return;
				got = err(function () {
					return f.formatToParts(x[0]);
				});
				if (!same(got, x[2]))
					fails.push(w + ' parts: ' + JSON.stringify(got) + ', V8 ' +
						   JSON.stringify(x[2]));
				return;
			}
			w = what + ' ' + new Date(x[0]).toISOString() + '..' +
				new Date(x[1]).toISOString();
			got = err(function () {
				return f.formatRange(x[0], x[1]);
			});
			if (!same(got, x[2]))
				return fails.push(w + ': ' + JSON.stringify(got) + ', V8 ' +
						  JSON.stringify(x[2]));
			if (x[3] === null)
				return;
			got = err(function () {
				return f.formatRangeToParts(x[0], x[1]);
			});
			if (!same(got, x[3]))
				fails.push(w + ' parts: ' + JSON.stringify(got) + ', V8 ' +
					   JSON.stringify(x[3]));
		});
	});
	return { n: n, fails: fails };
}

function html() {
	const list = cases(false);

	return `<!DOCTYPE html>
<!-- Intl.DateTimeFormat against V8 and ICU (${process.versions.icu}, CLDR
     ${process.versions.cldr}, tz ${process.versions.tz}), written by
     scripts/gen-intl-tests.mjs: what Node gives for each case. -->
<html><head><meta charset="utf-8"><title>t</title></head><body><div id="out"></div>
<script>
var CASES = ${JSON.stringify(list)};
${CHECK.toString()}
var r = CHECK(CASES, Intl), m = (r.fails.length ? 'FAIL ' : 'PASS ') +
	(r.n - r.fails.length) + ' of ' + r.n + ' cases as V8 gives them';
r.fails.slice(0, 40).forEach(function (f) { console.log('FAIL ' + f); });
console.log(m);
document.getElementById('out').textContent = m;
</script></body></html>
`;
}

if (import.meta.url === 'file://' + process.argv[1])
	process.stdout.write(html());
