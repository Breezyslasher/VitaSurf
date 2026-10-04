#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Write tests/dom/intl-names.html: Intl.DisplayNames and
// Intl.RelativeTimeFormat cases with what ICU in Node gives for them,
// for the browser to be checked against.
//
//   node scripts/gen-intl-names-tests.mjs > tests/dom/intl-names.html
//
// Where VitaSurf follows ECMA-402 and Node's V8 does not, the case is
// left out: V8 looks up a region or script code before fixing its case,
// so of('ca') and of('arab') find no name, where the spec gives Canada
// and Arabic; and it gives a calendar it has no name for by CLDR's key
// (ethiopic-amete-alem) where the spec gives its code (ethioaa), and a
// currency code in lower case with no name back as its code, though
// fallback is none.

export const LOCALES = ['en', 'en-GB', 'en-IN', 'de', 'de-CH', 'fr', 'es',
	'es-419', 'it', 'pt', 'pt-PT', 'nl', 'sv', 'pl', 'ru', 'uk', 'tr', 'ar',
	'ar-EG', 'he', 'fa', 'hi', 'bn', 'ja', 'zh', 'zh-TW', 'zh-HK', 'ko',
	'th', 'vi', 'id', 'sw', 'cy', 'ga', 'mt', 'ps', 'my', 'sr-Latn', 'und',
	'xx-YY', 'en-u-nu-arab', 'kgp', 'af-NA'];

const LANGUAGES = ['en', 'en-US', 'en-GB', 'en-AU', 'en-Latn', 'en-Latn-US',
	'en-US-posix', 'en-GB-oxendict', 'de', 'de-AT', 'de-CH', 'de-CH-1996',
	'fr-CA', 'fr-CH', 'es-419', 'es-MX', 'es-ES', 'pt-BR', 'pt-PT', 'nl-BE',
	'zh', 'zh-Hans', 'zh-Hant', 'zh-Hans-CN', 'zh-Hant-TW', 'zh-Hant-HK',
	'zh-TW', 'sr-Latn', 'sr-Latn-RS', 'sr-ME', 'sr-Cyrl-ME', 'ar-001',
	'ar-EG', 'hi-Latn', 'hi-Latn-IN', 'yue', 'tlh', 'und', 'und-US', 'xx',
	'xx-YY', 'xx-Latn', 'en-ZZ', 'en-Zzzz', 'ku-Arab', 'az-Arab', 'ca-ES',
	'sw-CD', 'ro-MD', 'nds-NL', 'fa-AF', 'EN-us', 'zh-hant-tw',
	'ca-ES-valencia', 'sl-rozaj', 'sl-rozaj-biske', 'sl-IT-rozaj-biske-1994'];
const REGIONS = ['CA', 'US', 'GB', 'DE', 'JP', '419', '001', '150', 'ZZ',
	'XA', 'HK', 'MO', 'CD', 'CG', 'PS', 'EU', 'UN', 'TW', 'QO', 'AQ',
	'UK', 'BU', 'SU', 'DD', 'YU', 'AN', 'ZR'];
const SCRIPTS = ['Latn', 'Arab', 'Hans', 'Hant', 'Cyrl', 'Zzzz', 'Cans',
	'Xsux', 'Qaaa', 'Zxxx', 'Jpan', 'Rohg', 'Brai'];
const CURRENCIES = ['USD', 'usd', 'EUR', 'JPY', 'GBP', 'CHF', 'XAU', 'XYZ',
	'BTC'];
const CALENDARS = ['gregory', 'buddhist', 'chinese', 'islamic',
	'islamic-civil', 'islamic-umalqura', 'ethioaa', 'ethiopic', 'japanese',
	'roc', 'iso8601', 'persian', 'hebrew', 'dangi', 'nocal', 'islamicc'];
const FIELDS = ['era', 'year', 'quarter', 'month', 'weekOfYear', 'weekday',
	'day', 'dayPeriod', 'hour', 'minute', 'second', 'timeZoneName'];
const BAD = {
	language: ['en_US', 'root', 'i-klingon', 'en-u-ca-gregory', 'en-US-x-a',
		'', 'e', 'en-US-posix-posix', '123'],
	region: ['C', 'CAN', '1234', 'C1'],
	script: ['Lat', 'Latin1', 'L4tn'],
	currency: ['US', 'USDD', 'U5D'],
	calendar: ['ca', 'gregory_', 'a-b'],
	dateTimeField: ['Year', 'week', 'weekdays', 'zone']
};
const CODES = {
	language: LANGUAGES, region: REGIONS, script: SCRIPTS,
	currency: CURRENCIES, calendar: CALENDARS, dateTimeField: FIELDS
};

const RTF_UNITS = ['second', 'seconds', 'minute', 'hour', 'day', 'days',
	'week', 'month', 'quarter', 'year', 'years'];
const RTF_VALUES = [-2, -1, -0, 0, 1, 2, 1.5, -3.25, 10, 1000, 21, 0.5,
	-1234.5678];

let seed = 5;
function rnd(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
}

export function cases(full) {
	const out = [];
	const locales = full ? LOCALES : ['en', 'en-GB', 'de', 'fr', 'es', 'ru',
		'ar-EG', 'ja', 'zh-TW', 'hi', 'xx-YY'];

	function dn(loc, o, codes) {
		let f;

		try {
			f = new Intl.DisplayNames(loc, o);
		} catch (e) {
			out.push({ k: 'dn', loc, o, err: e.constructor.name });
			return;
		}
		const c = { k: 'dn', loc, o, r: f.resolvedOptions(), v: [] };

		for (const code of codes) {
			let s;

			try {
				s = f.of(code);
				if (s === undefined)
					s = null;
			} catch (e) {
				s = { err: e.constructor.name };
			}
			// V8 gives a calendar without a name by CLDR's key, not
			// by its code
			if (o.type === 'calendar' && s !== code && s !== null &&
			    /^(gregorian|ethiopic-amete-alem|islamic-civil)$/.test(s))
				continue;
			// and a currency code in lower case it gives back in upper
			// case where it has no name, even with fallback none
			if (o.type === 'currency' && o.fallback === 'none' &&
			    code !== code.toUpperCase())
				continue;
			c.v.push([code, s]);
		}
		out.push(c);
	}
	function rtf(loc, o, values, units) {
		let f;

		try {
			f = new Intl.RelativeTimeFormat(loc, o);
		} catch (e) {
			out.push({ k: 'rtf', loc, o, err: e.constructor.name });
			return;
		}
		const c = { k: 'rtf', loc, o, r: f.resolvedOptions(), v: [] };

		for (const u of units) {
			for (const v of values) {
				let s, p;

				try {
					s = f.format(v, u);
					p = f.formatToParts(v, u).map(x => x.unit ?
						[x.type, x.value, x.unit] : [x.type, x.value]);
				} catch (e) {
					s = { err: e.constructor.name };
				}
				c.v.push([Object.is(v, -0) || !isFinite(v) ? String(
					Object.is(v, -0) ? '-0' : v) : v, u, s, p]);
			}
		}
		out.push(c);
	}
	for (const loc of locales) {
		for (const type in CODES) {
			for (const style of ['long', 'short', 'narrow']) {
				if (!full && style === 'narrow' && type !== 'dateTimeField')
					continue;
				dn(loc, { type, style }, full ? CODES[type] :
				   CODES[type].filter((c, i) => i % 2 === 0 ||
						      loc === 'en'));
			}
			dn(loc, { type, fallback: 'none' }, CODES[type].filter(
				(c, i) => full || i % 3 === 0));
		}
		dn(loc, { type: 'language', languageDisplay: 'standard' },
		   full || loc === 'en' ? LANGUAGES :
		   LANGUAGES.filter((c, i) => i % 3 === 0));
		dn(loc, { type: 'language', languageDisplay: 'standard',
			style: 'short' }, LANGUAGES.filter((c, i) => full ||
							   i % 4 === 0));
		for (const style of ['long', 'short', 'narrow']) {
			for (const numeric of ['always', 'auto']) {
				rtf(loc, { style, numeric }, full ? RTF_VALUES :
				    RTF_VALUES.filter((v, i) => i % 2 === 0 ||
						      numeric === 'auto' && i < 5),
				    full || loc === 'en' ? RTF_UNITS :
				    RTF_UNITS.filter((v, i) => i % 2 === 1));
			}
		}
	}
	for (const type in BAD)
		dn('en', { type }, BAD[type]);
	for (const o of [undefined, {}, { type: 'bogus' }, { type: 'region',
		style: 'tiny' }, { type: 'region', fallback: 'nothing' },
		{ type: 'language', languageDisplay: 'x' }, 'region'])
		dn('en', o, []);
	rtf('en', {}, [NaN, Infinity, 1], ['fortnight', 'day', 'Days', 'dayss']);
	rtf('en', { numberingSystem: 'arab' }, [3], ['day']);
	rtf('ar-EG', { numberingSystem: 'latn' }, [3], ['day']);
	for (const o of [{ style: 'tiny' }, { numeric: 'sometimes' },
		{ numberingSystem: 'x' }])
		rtf('en', o, [], []);
	for (let i = 0; i < (full ? 400 : 60); i++) {
		const loc = LOCALES[rnd(LOCALES.length)];
		const type = Object.keys(CODES)[rnd(6)];
		const codes = CODES[type];

		dn(loc, { type, style: ['long', 'short', 'narrow'][rnd(3)] },
		   [codes[rnd(codes.length)], codes[rnd(codes.length)]]);
	}
	for (const l of [['en', 'es', 'xx'], ['de-CH-1996', 'zh-Hant-TW'],
			 ['tlh', 'und'], 'sr-Latn-RS'])
		out.push({ k: 'sup', l,
			s: [Intl.DisplayNames.supportedLocalesOf(l),
			    Intl.RelativeTimeFormat.supportedLocalesOf(l)] });
	return out;
}

// the check, shared by the page and by a run under Node
export function CHECK(CASES, I) {
	var fails = [], n = 0;

	function same(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	CASES.forEach(function (c) {
		var what = c.k + ' ' + c.loc + ' ' + JSON.stringify(c.o), f, got;

		n++;
		if (c.k === 'sup') {
			got = [I.DisplayNames.supportedLocalesOf(c.l),
				I.RelativeTimeFormat.supportedLocalesOf(c.l)];
			if (!same(got, c.s))
				fails.push('sup ' + JSON.stringify(c.l) + ': ' +
					   JSON.stringify(got) + ', ICU ' +
					   JSON.stringify(c.s));
			return;
		}
		try {
			f = c.k === 'dn' ? new I.DisplayNames(c.loc, c.o) :
				new I.RelativeTimeFormat(c.loc, c.o);
		} catch (e) {
			if (e.constructor.name !== c.err)
				fails.push(what + ': ' + e + ', ICU ' + (c.err || 'constructs'));
			return;
		}
		if (c.err)
			return fails.push(what + ': constructs, ICU throws ' + c.err);
		got = f.resolvedOptions();
		if (!same(got, c.r))
			fails.push(what + ' options: ' + JSON.stringify(got) + ', ICU ' +
				   JSON.stringify(c.r));
		c.v.forEach(function (x) {
			var w = what + ' ' + JSON.stringify(x.slice(0, c.k === 'dn' ? 1 :
								   2));

			n++;
			if (c.k === 'dn') {
				try {
					got = f.of(x[0]);
					if (got === undefined)
						got = null;
				} catch (e) {
					got = { err: e.constructor.name };
				}
				if (!same(got, x[1]))
					fails.push(w + ': ' + JSON.stringify(got) + ', ICU ' +
						   JSON.stringify(x[1]));
				return;
			}
			var v = typeof x[0] === 'string' ? Number(x[0]) : x[0];

			try {
				got = f.format(v, x[1]);
			} catch (e) {
				got = { err: e.constructor.name };
			}
			if (!same(got, x[2]))
				return fails.push(w + ': ' + JSON.stringify(got) + ', ICU ' +
						  JSON.stringify(x[2]));
			if (x[3]) {
				got = f.formatToParts(v, x[1]).map(function (p) {
					return p.unit ? [p.type, p.value, p.unit] :
						[p.type, p.value];
				});
				if (!same(got, x[3]))
					fails.push(w + ' parts: ' + JSON.stringify(got) +
						   ', ICU ' + JSON.stringify(x[3]));
			}
		});
	});
	return { n: n, fails: fails };
}

function html() {
	const list = cases(false);

	return `<!DOCTYPE html>
<!-- Intl.DisplayNames and Intl.RelativeTimeFormat against ICU
     (${process.versions.icu}, CLDR ${process.versions.cldr}), written by
     scripts/gen-intl-names-tests.mjs: what Node gives for each case. -->
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
