#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Write tests/dom/intl-numberformat.html: Intl.NumberFormat and
// Intl.PluralRules cases with what ICU in Node gives for them, for the
// browser to be checked against. The options are those Home Assistant
// uses, every option alone, and a spread of combinations, in a spread of
// locales: numbering systems other than Latin, Indian grouping, bidi
// marks, locales that group from five digits, plural rules with every
// category.
//
//   node scripts/gen-intl-number-tests.mjs > tests/dom/intl-numberformat.html
//
// Where VitaSurf follows ECMA-402 and Node's V8 does not yet, the case
// is left out or compared on what the two agree on; the list is in
// DIFFERS below.

export const LOCALES = ['en', 'en-US', 'en-GB', 'en-IN', 'de', 'de-CH', 'fr',
	'es', 'es-MX', 'it', 'pt', 'pt-PT', 'ru', 'pl', 'cs', 'ar', 'ar-EG',
	'he', 'fa', 'hi', 'bn', 'ja', 'zh', 'zh-TW', 'ko', 'th', 'tr', 'nl',
	'sv', 'nb', 'fi', 'da', 'uk', 'el', 'id', 'vi', 'sw', 'ga', 'cy', 'lt',
	'sl', 'mt', 'gd', 'my', 'ne', 'mr', 'ur', 'ps', 'kk', 'sr-Latn',
	'en-u-nu-arab', 'en-u-nu-thai', 'ar-u-nu-latn', 'und', 'xx-YY'];

export const VALUES = [0, -0, 1, -1, 2, 0.5, 1.5, 3, 5, 11, 21, 100, 101,
	1000, 1001, 1234.5678, -1234.5678, 12345, 123456.789, 1234567.891,
	-9876543.21, 1e9, 1.5e12, 1e15, 1e21, 0.000123, 1.005, 0.1 + 0.2, 999.95,
	999999, 1e-7, NaN, Infinity, -Infinity, 1n, -12345678901234567890n,
	'1.23456789012345678901234567', '-0', '1e400', '0x1F', ' 42 ', 'abc'];

const HA = [
	{},
	{ maximumFractionDigits: 2 },
	{ minimumFractionDigits: 2, maximumFractionDigits: 2 },
	{ maximumFractionDigits: 0 },
	{ style: 'percent' },
	{ style: 'percent', maximumFractionDigits: 1 },
	{ style: 'currency', currency: 'USD' },
	{ style: 'currency', currency: 'EUR' },
	{ style: 'currency', currency: 'JPY' },
	{ style: 'unit', unit: 'kilometer-per-hour' },
	{ style: 'unit', unit: 'bit', unitDisplay: 'long', notation: 'scientific' },
	{ notation: 'compact', minimumSignificantDigits: 3,
		maximumSignificantDigits: 3, minimumFractionDigits: 2,
		maximumFractionDigits: 2, roundingPriority: 'morePrecision' },
	{ notation: 'compact' },
	{ useGrouping: false },
	{ style: 'unit', unit: 'percent' },
	{ style: 'unit', unit: 'byte', unitDisplay: 'narrow' },
	{ style: 'unit', unit: 'celsius' },
	{ style: 'unit', unit: 'kilometer', unitDisplay: 'long' },
	{ style: 'unit', unit: 'liter-per-kilometer', unitDisplay: 'long' },
	{ style: 'unit', unit: 'megabyte-per-second' },
	{ style: 'unit', unit: 'kilobyte-per-gallon', unitDisplay: 'long' },
	{ style: 'unit', unit: 'hour', unitDisplay: 'long' },
	{ style: 'unit', unit: 'day', unitDisplay: 'narrow' },
];

// every option on its own
const SINGLE = [
	{ style: 'currency', currency: 'USD', currencyDisplay: 'code' },
	{ style: 'currency', currency: 'USD', currencyDisplay: 'name' },
	{ style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' },
	{ style: 'currency', currency: 'CAD', currencyDisplay: 'symbol' },
	{ style: 'currency', currency: 'EUR', currencySign: 'accounting' },
	{ style: 'currency', currency: 'CHF', currencyDisplay: 'name' },
	{ style: 'currency', currency: 'XYZ' },
	{ style: 'currency', currency: 'bhd' },
	{ style: 'currency', currency: 'USD', notation: 'compact' },
	{ style: 'currency', currency: 'EUR', notation: 'compact',
		compactDisplay: 'long' },
	{ style: 'percent', notation: 'compact' },
	{ style: 'percent', signDisplay: 'exceptZero' },
	{ minimumIntegerDigits: 3 },
	{ minimumFractionDigits: 3 },
	{ maximumFractionDigits: 1 },
	{ minimumSignificantDigits: 3 },
	{ maximumSignificantDigits: 2 },
	{ minimumSignificantDigits: 2, maximumSignificantDigits: 4 },
	{ maximumFractionDigits: 2, roundingIncrement: 5,
		minimumFractionDigits: 2 },
	{ maximumFractionDigits: 1, minimumFractionDigits: 1,
		roundingIncrement: 25 },
	{ maximumFractionDigits: 0, minimumFractionDigits: 0,
		roundingIncrement: 100 },
	{ roundingMode: 'ceil' }, { roundingMode: 'floor' },
	{ roundingMode: 'expand' }, { roundingMode: 'trunc' },
	{ roundingMode: 'halfCeil' }, { roundingMode: 'halfFloor' },
	{ roundingMode: 'halfTrunc' }, { roundingMode: 'halfEven' },
	{ roundingMode: 'halfEven', maximumFractionDigits: 0 },
	{ roundingPriority: 'lessPrecision', maximumSignificantDigits: 2,
		maximumFractionDigits: 2 },
	{ roundingPriority: 'morePrecision', maximumSignificantDigits: 2,
		maximumFractionDigits: 2 },
	{ trailingZeroDisplay: 'stripIfInteger', minimumFractionDigits: 2 },
	{ notation: 'scientific' }, { notation: 'engineering' },
	{ notation: 'compact', compactDisplay: 'long' },
	{ notation: 'scientific', maximumSignificantDigits: 3 },
	{ useGrouping: 'always' }, { useGrouping: 'min2' },
	{ useGrouping: 'auto' }, { useGrouping: true }, { useGrouping: 'true' },
	{ signDisplay: 'always' }, { signDisplay: 'never' },
	{ signDisplay: 'exceptZero' }, { signDisplay: 'negative' },
	{ numberingSystem: 'arab' }, { numberingSystem: 'latn' },
	{ numberingSystem: 'hanidec' }, { numberingSystem: 'roman' },
	{ style: 'unit', unit: 'mile-per-gallon', unitDisplay: 'narrow' },
	{ style: 'unit', unit: 'gigabyte', unitDisplay: 'long',
		notation: 'compact' },
	{ style: 'unit', unit: 'kilometer-per-byte', unitDisplay: 'long' },
	{ style: 'unit', unit: 'kilometer-per-byte', unitDisplay: 'short' },
	{ style: 'unit', unit: 'fahrenheit', unitDisplay: 'narrow' },
	{ style: 'unit', unit: 'fluid-ounce', unitDisplay: 'long' },
	{ style: 'unit', unit: 'mile-scandinavian', unitDisplay: 'long' },
	{ style: 'unit', unit: 'month', signDisplay: 'always' },
];

// options that must throw
const BAD = [
	{ style: 'currency' }, { style: 'unit' }, { currency: 'US' },
	{ currency: 'U$D' }, { unit: 'furlong' }, { unit: 'meter-per-furlong' },
	{ style: 'bogus' }, { minimumFractionDigits: 101 },
	{ minimumFractionDigits: 3, maximumFractionDigits: 1 },
	{ maximumSignificantDigits: 0 }, { minimumIntegerDigits: 22 },
	{ roundingIncrement: 3 }, { roundingIncrement: 5,
		maximumSignificantDigits: 2 },
	{ useGrouping: 'sometimes' }, { numberingSystem: 'latn-' },
	{ notation: 'compact', compactDisplay: 'tiny' },
	{ roundingMode: 'up' }, { signDisplay: 'yes' },
];

// a spread of others, the same every run
let seed = 11;
function rnd(n) {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed % n;
}
const PICK = {
	style: [undefined, undefined, 'percent', 'currency', 'unit'],
	notation: [undefined, undefined, undefined, 'scientific', 'engineering',
		'compact'],
	compactDisplay: [undefined, undefined, 'long'],
	signDisplay: [undefined, undefined, 'always', 'exceptZero', 'never',
		'negative'],
	maximumFractionDigits: [undefined, undefined, undefined, 0, 1, 2, 5],
	maximumSignificantDigits: [undefined, undefined, undefined, undefined, 1,
		3, 6],
	minimumIntegerDigits: [undefined, undefined, undefined, undefined, 2],
	useGrouping: [undefined, undefined, undefined, false, 'always', 'min2'],
	roundingMode: [undefined, undefined, undefined, 'floor', 'halfEven',
		'trunc'],
	roundingPriority: [undefined, undefined, undefined, undefined,
		'morePrecision', 'lessPrecision'],
	trailingZeroDisplay: [undefined, undefined, undefined, 'stripIfInteger'],
};
const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'INR', 'BRL', 'CHF', 'KWD',
	'CNY', 'RUB'];
const UNITS = ['meter', 'kilogram', 'liter', 'second', 'megabyte', 'percent',
	'kilometer-per-hour', 'foot', 'gallon', 'byte-per-second', 'acre'];

function randomOptions() {
	const o = {};

	for (const k in PICK) {
		const v = PICK[k][rnd(PICK[k].length)];

		if (v !== undefined)
			o[k] = v;
	}
	if (o.style === 'currency') {
		o.currency = CURRENCIES[rnd(CURRENCIES.length)];
		const d = [undefined, 'code', 'name', 'narrowSymbol'][rnd(4)];
		const s = [undefined, undefined, 'accounting'][rnd(3)];

		if (d)
			o.currencyDisplay = d;
		if (s)
			o.currencySign = s;
	}
	if (o.style === 'unit') {
		o.unit = UNITS[rnd(UNITS.length)];
		const d = [undefined, 'long', 'narrow'][rnd(3)];

		if (d)
			o.unitDisplay = d;
	}
	return o;
}

// where V8 in Node 22 is not yet what ECMA-402 says
export const DIFFERS = [
	// ES2023: an increment makes the default maximum the minimum
	o => o.roundingIncrement > 1 && o.maximumFractionDigits === undefined,
	// a numberingSystem option it does not have drops the locale's -u-nu-
	(o, loc) => o.numberingSystem === 'roman' && /-u-nu-/.test(loc),
	// it reports an accounting currencySign as standard under
	// signDisplay never, which is a skeleton it cannot read back
	o => o.currencySign === 'accounting' && o.signDisplay === 'never',
];

// V8 gives some parts of a range whose affixes collapse the wrong
// source: the first number's fraction "shared", the dash "endRange".
// The string is still compared.
function sourcesInOrder(parts) {
	const NUM = ['integer', 'group', 'decimal', 'fraction'];

	return parts.every(p => p[2] === 'shared') ||
		!parts.some(p => p[2] === 'shared' && NUM.includes(p[0]));
}

function differs(o, loc) {
	return DIFFERS.some(f => f(o, loc));
}

const enc = v => typeof v === 'bigint' ? { big: String(v) } : v !== v ?
	{ num: 'NaN' } : v === Infinity ? { num: 'Infinity' } :
	v === -Infinity ? { num: '-Infinity' } : Object.is(v, -0) ?
	{ num: '-0' } : v;

// all of them for a run under Node (gen-intl-tests style, against the
// implementation itself); a sample for the page, which a Vita has to
// load and run
export function cases(full) {
	const out = [];
	// the page's sample: every option set, in fewer locales and with
	// fewer values
	const SAMPLE_VALUES = [0, -0, 1, 2, 1.5, -1234.5678, 123456.789, 1e9,
		0.000123, 1.005, NaN, -Infinity, -12345678901234567890n,
		'1.23456789012345678901234567', '1e400'];
	const values = (loc, o, i) => full ? VALUES : ['en', 'de', 'ar-EG',
		'ru'].includes(loc) ? SAMPLE_VALUES.filter((v, j) => (i + j) % 3 ===
							      0) :
		[SAMPLE_VALUES[(i * 5) % SAMPLE_VALUES.length],
		 SAMPLE_VALUES[(i * 7 + 3) % SAMPLE_VALUES.length]];
	const locales = full ? LOCALES : ['en', 'en-IN', 'de', 'de-CH', 'fr',
		'es', 'ru', 'ar-EG', 'fa', 'hi', 'ja', 'zh-TW', 'pl',
		'en-u-nu-thai'];

	// one case per formatter: its resolved options, then each value
	// [value, string, parts] and each range [start, end, string, parts]
	function nf(loc, o, values, ranges) {
		let f;

		if (differs(o, loc))
			return;
		try {
			f = new Intl.NumberFormat(loc, o);
		} catch (e) {
			out.push({ k: 'nf', loc, o, err: e.constructor.name });
			return;
		}
		const c = { k: 'nf', loc, o, v: [], g: [] };

		// resolved options in full only for a sample on the page; they
		// barely change with the locale
		if (full || loc === 'en' || out.length % 6 === 0)
			c.r = f.resolvedOptions();

		for (const v of values)
			c.v.push([enc(v), f.format(v),
				  f.formatToParts(v).map(p => [p.type, p.value])]);
		for (const [a, b] of ranges || []) {
			let s, p;

			try {
				s = f.formatRange(a, b);
				p = f.formatRangeToParts(a, b).map(p =>
					[p.type, p.value, p.source]);
			} catch (e) {
				s = 'throws ' + e.constructor.name;
			}
			if (p && !sourcesInOrder(p))
				p = null;
			c.g.push([enc(a), enc(b), s, p]);
		}
		out.push(c);
	}
	const RANGES = [[1, 5], [3, 3], [-5, 3], [3, -5], [0, 0], [1000, 1001],
		[1, 1.0001], [0.5, 2], [1e6, 2e6], [-3, -3], [1000, 5000],
		[1, 'abc'], [1, Infinity]];

	for (const loc of locales) {
		const big = ['en', 'de', 'ar', 'ru', 'hi', 'ja'].includes(loc);
		const ranges = loc === 'en' ? RANGES : full && (loc === 'de' ||
			loc === 'ru') ? RANGES : [];

		HA.forEach((o, i) => nf(loc, o, full ? (big ? VALUES :
			VALUES.filter((v, j) => j % 3 === 0)) : values(loc, o, i),
			full || i % 3 === 0 ? ranges : []));
		SINGLE.forEach((o, i) => nf(loc, o, full ? (big ?
			VALUES.filter((v, j) => j % 2 === 0) :
			[-1234.5678, 0, 1, 2.5, 1e6, 0.000123]) :
			values(loc, o, i + 100), full || i % 4 === 0 ? ranges : []));
	}
	for (const o of BAD)
		nf('en', o, []);
	for (let i = 0; i < (full ? 300 : 60); i++) {
		const o = randomOptions();
		const loc = LOCALES[rnd(LOCALES.length)];
		const vs = [VALUES[rnd(VALUES.length)], VALUES[rnd(VALUES.length)],
			VALUES[rnd(VALUES.length)]];

		nf(loc, o, vs, i % 4 ? [] : [[vs[0], vs[1]]]);
	}
	// plural rules
	const PR_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12, 21, 22, 101, 111,
		1000000, 0.5, 1.5, 2.25, 1.0, 1e21, -1, NaN, Infinity];

	for (const loc of full ? LOCALES : LOCALES.filter((l, i) => i % 3 === 0)) {
		for (const o of [{}, { type: 'ordinal' }, { minimumFractionDigits: 2 },
				 { maximumSignificantDigits: 1 }]) {
			let pr;

			try {
				pr = new Intl.PluralRules(loc, o);
			} catch (e) {
				out.push({ k: 'pr', loc, o, err: e.constructor.name });
				continue;
			}
			const r = pr.resolvedOptions();

			r.pluralCategories = r.pluralCategories.slice().sort();
			out.push({ k: 'pro', loc, o, r });
			out.push({ k: 'pr', loc, o,
				s: PR_VALUES.map(v => pr.select(v)) });
			out.push({ k: 'prr', loc, o,
				s: [[1, 2], [0, 1], [1, 5], [2, 5], [5, 1], [21, 22]]
					.map(([a, b]) => pr.selectRange(a, b)) });
		}
	}
	out.push({ k: 'sv', s: ['currency', 'unit', 'numberingSystem'].map(
		k => Intl.supportedValuesOf(k)) });
	// supportedLocalesOf
	for (const l of [['en', 'es', 'xx'], ['de-CH-1996', 'zh-Hant-TW'],
			 ['tlh', 'und'], 'sr-Latn-RS'])
		out.push({ k: 'sup', l, s: Intl.NumberFormat.supportedLocalesOf(l),
			p: Intl.PluralRules.supportedLocalesOf(l) });
	return out;
}

function html() {
	const list = cases(false);

	return `<!DOCTYPE html>
<!-- Intl.NumberFormat and Intl.PluralRules against ICU (${process.versions.icu},
     CLDR ${process.versions.cldr}), written by
     scripts/gen-intl-number-tests.mjs: what Node gives for each case. -->
<html><head><meta charset="utf-8"><title>t</title></head><body><div id="out"></div>
<script>
var CASES = ${JSON.stringify(list)};
${CHECK.toString()}
var r = CHECK(CASES, Intl), m = (r.fails.length ? 'FAIL ' : 'PASS ') +
	(r.n - r.fails.length) + ' of ' + r.n + ' cases as ICU formats them';
r.fails.slice(0, 40).forEach(function (f) { console.log('FAIL ' + f); });
console.log(m);
document.getElementById('out').textContent = m;
</script></body></html>
`;
}

// the check, shared by the page and by a run under Node
export function CHECK(CASES, I) {
	var fails = [], n = 0;

	function dec(v) {
		if (v && typeof v === 'object') {
			if (v.big !== undefined)
				return BigInt(v.big);
			return Number(v.num);
		}
		return v;
	}
	function same(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	CASES.forEach(function (c) {
		var what = c.k + ' ' + c.loc + ' ' + JSON.stringify(c.o);
		var got;

		n++;
		try {
			if (c.k === 'sv') {
				got = ['currency', 'unit', 'numberingSystem'].map(
					function (k) {
						return I.supportedValuesOf(k);
					});
				if (!same(got, c.s))
					fails.push('supportedValuesOf: ' + JSON.stringify(got) +
						   ', ICU ' + JSON.stringify(c.s));
				return;
			}
			if (c.k === 'sup') {
				got = [I.NumberFormat.supportedLocalesOf(c.l),
					I.PluralRules.supportedLocalesOf(c.l)];
				if (!same(got, [c.s, c.p]))
					fails.push('sup ' + JSON.stringify(c.l) + ': ' +
						   JSON.stringify(got) + ', ICU ' +
						   JSON.stringify([c.s, c.p]));
				return;
			}
			if (c.k === 'pr' || c.k === 'pro' || c.k === 'prr') {
				var pr = new I.PluralRules(c.loc, c.o);

				if (c.err)
					return fails.push(what + ': constructs, ICU throws ' +
							  c.err);
				if (c.k === 'pro') {
					got = pr.resolvedOptions();
					got.pluralCategories = got.pluralCategories.slice()
						.sort();
				} else if (c.k === 'pr') {
					got = [0, 1, 2, 3, 4, 5, 6, 7, 11, 12, 21, 22, 101, 111,
						1000000, 0.5, 1.5, 2.25, 1.0, 1e21, -1, NaN,
						Infinity].map(function (v) {
						return pr.select(v);
					});
				} else {
					got = [[1, 2], [0, 1], [1, 5], [2, 5], [5, 1], [21, 22]]
						.map(function (x) {
							return pr.selectRange(x[0], x[1]);
						});
				}
				if (!same(got, c.k === 'pro' ? c.r : c.s))
					fails.push(what + ': ' + JSON.stringify(got) + ', ICU ' +
						   JSON.stringify(c.k === 'pro' ? c.r : c.s));
				return;
			}
			var f = new I.NumberFormat(c.loc, c.o);

			if (c.err)
				return fails.push(what + ': constructs, ICU throws ' + c.err);
			got = f.resolvedOptions();
			if (c.r && !same(got, c.r))
				fails.push(what + ' options: ' + JSON.stringify(got) +
					   ', ICU ' + JSON.stringify(c.r));
			c.v.forEach(function (x) {
				var w = what + ' ' + JSON.stringify(x[0]);

				n++;
				got = f.format(dec(x[0]));
				if (got !== x[1])
					return fails.push(w + ': ' + JSON.stringify(got) +
							  ', ICU ' + JSON.stringify(x[1]));
				got = f.formatToParts(dec(x[0])).map(function (p) {
					return [p.type, p.value];
				});
				if (!same(got, x[2]))
					fails.push(w + ' parts: ' + JSON.stringify(got) +
						   ', ICU ' + JSON.stringify(x[2]));
			});
			c.g.forEach(function (x) {
				var w = what + ' ' + JSON.stringify(x[0]) + '..' +
					JSON.stringify(x[1]);

				n++;
				try {
					got = f.formatRange(dec(x[0]), dec(x[1]));
				} catch (e) {
					got = 'throws ' + e.constructor.name;
				}
				if (got !== x[2])
					return fails.push(w + ': ' + JSON.stringify(got) +
							  ', ICU ' + JSON.stringify(x[2]));
				if (x[3]) {
					got = f.formatRangeToParts(dec(x[0]), dec(x[1])).map(
						function (p) {
							return [p.type, p.value, p.source];
						});
					if (!same(got, x[3]))
						fails.push(w + ' parts: ' + JSON.stringify(got) +
							   ', ICU ' + JSON.stringify(x[3]));
				}
			});
		} catch (e) {
			if (!c.err || e.constructor.name !== c.err)
				fails.push(what + ': ' + e);
		}
	});
	return { n: n, fails: fails };
}

if (import.meta.url === 'file://' + process.argv[1])
	process.stdout.write(html());
