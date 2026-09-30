#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Write tests/dom/intl-datetimeformat.html: Intl.DateTimeFormat cases
// with what ICU in Node formats them as, for the browser to be checked
// against. The options are those Home Assistant uses and a spread of
// others; the times and zones take in daylight saving, zones off the
// hour and both hemispheres.
//
//   node scripts/gen-intl-tests.mjs > tests/dom/intl-datetimeformat.html

const LOCALES = (process.env.LOCS || 'en,en-GB,en-CA,en-AU,en-IN,en-IE,en-NZ,en-ZA').split(',');
const TIMES = [
	Date.UTC(2026, 2, 4, 5, 6, 7, 89),
	Date.UTC(2026, 8, 30, 19, 5, 0),
	Date.UTC(2026, 11, 31, 23, 59, 59, 999),
	Date.UTC(2026, 6, 15, 12, 0, 0),
	Date.UTC(1999, 0, 1, 0, 0, 0),
	Date.UTC(2041, 9, 27, 1, 30, 0),
	Date.UTC(2026, 2, 29, 1, 30, 0),	// Europe changes clocks
	Date.UTC(2026, 10, 1, 6, 30, 0),	// the US changes back
];
const ZONES = ['UTC', 'America/New_York', 'Europe/Berlin', 'Australia/Sydney',
	'Asia/Kolkata', 'America/St_Johns', 'Pacific/Chatham', 'Asia/Kathmandu',
	'Europe/London', 'America/Sao_Paulo', 'Africa/Cairo',
	'America/Los_Angeles', 'Pacific/Honolulu', 'Asia/Tokyo', '+05:30'];

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
	{ dateStyle: 'full' }, { dateStyle: 'long' }, { dateStyle: 'medium' }, { dateStyle: 'short' },
	{ timeStyle: 'full' }, { timeStyle: 'long' }, { timeStyle: 'medium' }, { timeStyle: 'short' },
	{ dateStyle: 'medium', timeStyle: 'short' }, { dateStyle: 'full', timeStyle: 'short' },
	{ dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23' },
	{ timeStyle: 'short', hour12: true },
	{}, { timeZoneName: 'short' }, { hour: 'numeric', timeZoneName: 'long' },
	{ hour: 'numeric', minute: '2-digit', timeZoneName: 'shortOffset' },
	{ hour: 'numeric', minute: '2-digit', timeZoneName: 'longOffset' },
	{ hour: 'numeric', minute: '2-digit', timeZoneName: 'shortGeneric' },
	{ hour: 'numeric', minute: '2-digit', timeZoneName: 'longGeneric' },
	{ hour: 'numeric', dayPeriod: 'short' }, { hour: 'numeric', dayPeriod: 'long' },
	{ hour: 'numeric', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 },
	{ era: 'short', year: 'numeric' }, { era: 'long', year: 'numeric', month: 'long', day: 'numeric' },
	{ hourCycle: 'h11', hour: 'numeric' }, { hourCycle: 'h24', hour: 'numeric', minute: '2-digit' },
];

// a spread of others, the same every run
let seed = 7;
function rnd(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
}
const PICK = {
	weekday: [undefined, 'short', 'long', 'narrow'],
	year: [undefined, 'numeric', '2-digit'],
	month: [undefined, 'numeric', '2-digit', 'short', 'long', 'narrow'],
	day: [undefined, 'numeric', '2-digit'],
	hour: [undefined, 'numeric', '2-digit'],
	minute: [undefined, 'numeric', '2-digit'],
	second: [undefined, 'numeric', '2-digit'],
	hourCycle: [undefined, undefined, 'h12', 'h23'],
	timeZoneName: [undefined, undefined, undefined, 'short', 'long', 'shortOffset'],
};
const RANDOM = [];
for (let i = 0; i < 60; i++) {
	const o = {};
	for (const k in PICK) {
		const v = PICK[k][rnd(PICK[k].length)];
		if (v !== undefined)
			o[k] = v;
	}
	RANDOM.push(o);
}

const cases = [];
function add(loc, o, tz, t, t2) {
	const opts = { ...o, timeZone: tz };
	let f;
	try {
		f = new Intl.DateTimeFormat(loc, opts);
	} catch (e) {
		cases.push([loc, opts, t, t2, 'throws ' + e.constructor.name]);
		return;
	}
	const r = f.resolvedOptions();
	// ICU writes some zones by old names; the spec asks for the zone's
	delete r.timeZone;
	// V8 reads the fields of the options it reports off the pattern,
	// letters in quoted text and all: a field it reports and does not
	// format is not one to compare
	const shown = new Set(f.formatToParts(t).map(p => p.type));
	const quirk = ['era', 'year', 'month', 'day', 'weekday', 'hour', 'minute', 'second']
		.some(k => r[k] && !(k in o) && !shown.has(k));
	if (t2 === undefined)
		cases.push([loc, opts, t, null, f.format(t),
			f.formatToParts(t).map(p => [p.type, p.value]), quirk ? null : r]);
	else
		cases.push([loc, opts, t, t2, f.formatRange(t, t2),
			f.formatRangeToParts(t, t2).map(p => [p.type, p.value, p.source])]);
}

for (const loc of LOCALES) {
	HA.forEach((o, i) => add(loc, o, ZONES[i % ZONES.length], TIMES[i % TIMES.length]));
	if (loc === 'en' || loc === 'en-GB')
		RANDOM.forEach((o, i) => add(loc, o, ZONES[(i * 7) % ZONES.length],
					      TIMES[(i * 3) % TIMES.length]));
}
// every zone at every time, one format
for (const tz of ZONES)
	for (const t of TIMES)
		add('en', { dateStyle: 'medium', timeStyle: 'full' }, tz, t);
// ranges
const RANGES = [
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 2, 4, 7, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 2, 4, 17, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 2, 9, 7, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 4, 9, 7, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2027, 4, 9, 7, 30)],
	[Date.UTC(2026, 2, 4, 5, 6), Date.UTC(2026, 2, 4, 5, 6, 30)],
];
for (const loc of ['en', 'en-GB'])
	for (const o of HA.slice(0, 26))
		for (const [a, b] of RANGES)
			add(loc, o, 'UTC', a, b);

process.stdout.write(`<!DOCTYPE html>
<!-- Intl.DateTimeFormat against ICU (${process.versions.icu}, CLDR
     ${process.versions.cldr}), written by scripts/gen-intl-tests.mjs: what
     Node formats each case as. -->
<html><head><meta charset="utf-8"><title>t</title></head><body><div id="out"></div>
<script>
var CASES = ${JSON.stringify(cases)};
var fails = 0, n = 0;
function fail(m) { fails++; console.log('FAIL ' + m); }
CASES.forEach(function (c) {
	var loc = c[0], o = c[1], t = c[2], t2 = c[3], want = c[4];
	var what = loc + ' ' + JSON.stringify(o) + ' ' + new Date(t).toISOString() +
		(t2 !== null ? '..' + new Date(t2).toISOString() : '');
	n++;
	try {
		var f = new Intl.DateTimeFormat(loc, o);
		if (/^throws /.test(want)) {
			fail(what + ': formats, where ICU ' + want);
			return;
		}
		if (t2 === null) {
			var got = f.format(t);
			if (got !== want)
				return fail(what + ': ' + JSON.stringify(got) + ', ICU ' + JSON.stringify(want));
			var parts = JSON.stringify(f.formatToParts(t).map(function (p) { return [p.type, p.value]; }));
			if (parts !== JSON.stringify(c[5]))
				return fail(what + ' parts: ' + parts + ', ICU ' + JSON.stringify(c[5]));
			var r = f.resolvedOptions();
			delete r.timeZone;
			if (c[6] && JSON.stringify(r) !== JSON.stringify(c[6]))
				return fail(what + ' options: ' + JSON.stringify(r) + ', ICU ' + JSON.stringify(c[6]));
		} else {
			var gr = f.formatRange(t, t2);
			if (gr !== want)
				return fail(what + ': ' + JSON.stringify(gr) + ', ICU ' + JSON.stringify(want));
			var rp = JSON.stringify(f.formatRangeToParts(t, t2).map(function (p) { return [p.type, p.value, p.source]; }));
			if (rp !== JSON.stringify(c[5]))
				return fail(what + ' parts: ' + rp + ', ICU ' + JSON.stringify(c[5]));
		}
	} catch (e) {
		if (!/^throws /.test(want) || want !== 'throws ' + e.constructor.name)
			fail(what + ': ' + e);
	}
});
var m = (fails ? 'FAIL ' : 'PASS ') + (n - fails) + ' of ' + n + ' cases as ICU formats them';
console.log(m);
document.getElementById('out').textContent = m;
</script></body></html>
`);
