#!/usr/bin/env node
//
// Copyright 2026 VitaSurf contributors
//
// This file is part of VitaSurf, a PS Vita port of NetSurf.
// Licensed under the GNU General Public License version 2.
//
// Write tests/dom/intl-locale.html: Intl.Locale and the canonical form
// of locale tags, with what ICU in Node gives for them, for the browser
// to be checked against.
//
//   node scripts/gen-intl-tags-tests.mjs > tests/dom/intl-locale.html
//
// cases(true) adds every alias and likely-subtags key in
// resources/intl.pak, for a run under Node.
//
// Node's V8 has the locale information only as the getters it had
// before Intl Locale Info settled (calendars, weekInfo...), and has no
// variants or firstDayOfWeek; the page checks the methods against what
// the getters give, and those two against what the spec gives. Where
// it departs from the spec the case holds the spec's answer: V8 gives
// no language for und, keeps -u-va-posix in the baseName of en-US-posix,
// and leaves nine und- tags unminimized (und-Hant, und-PH...) though
// UTS #35's Remove Likely Subtags, run on ICU's own maximize, gives
// zh-TW and fil; and a key with no value (en-u-ca) gives its list the
// getter's "true", where V8 gives ICU's "yes". A tag whose -u-rg- has
// no value (en-u-rg-uk, two keys) is left out: ICU writes the empty
// value as "yes" and takes YE from it, so V8 gives such a tag Yemen's
// week.

import fs from 'fs';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const TAGS = ['en', 'en-US', 'EN-us', 'en-Latn-US', 'zh', 'zh-TW', 'zh-HK',
	'zh-Hant', 'zh-Hans-HK', 'zh-MO', 'sr', 'sr-ME', 'sr-Latn', 'ar',
	'ar-EG', 'ar-SA', 'he', 'iw', 'in', 'ji', 'jw', 'mo', 'sh', 'tl', 'no',
	'nb', 'nn', 'no-bok', 'pa-PK', 'pa-Arab', 'uz-AF', 'ku', 'ckb', 'az-IR',
	'ms-Arab', 'und', 'und-Latn', 'und-Arab', 'und-Cyrl', 'und-US', 'und-150',
	'und-419', 'und-AQ', 'und-Thai', 'und-Hant', 'und-x-private', 'xx',
	'xx-YY', 'xx-Latn', 'en-ZZ', 'en-Zzzz', 'en-001', 'en-150', 'es-419',
	'pt', 'pt-PT', 'pt-AO', 'fr-CA', 'de-AT', 'de-CH-1996', 'de-1901',
	'en-GB-oxendict', 'ca-ES-valencia', 'hy-arevela', 'hy-arevmda',
	'sgn-BR', 'sgn-GR', 'zh-guoyu', 'zh-hakka', 'zh-xiang', 'zh-min-nan',
	'cmn', 'cmn-Hans', 'yue', 'aar', 'heb', 'en-polytoni', 'ja-heploc',
	'und-hepburn-heploc', 'ja-Latn-heploc-hepburn', 'el-polytoni',
	'und-SU', 'az-SU', 'ru-SU', 'hy-SU', 'und-YU', 'sr-YU', 'und-CS',
	'en-BU', 'und-DD', 'de-DD', 'und-NT', 'und-062', 'und-172', 'und-200',
	'und-AN', 'und-Qaai', 'und-Zinh', 'sl-rozaj-biske-1994',
	'sl-rozaj-1994-biske', 'fr-arevela', 'en-US-POSIX', 'en-posix',
	'en-u-ms-imperial', 'en-u-ks-primary', 'en-u-ks-tertiary',
	'en-u-tz-asmera', 'en-u-tz-cnckg', 'en-u-tz-eire',
	'en-u-ca-ethiopic-amete-alem', 'en-u-ca-islamicc', 'en-u-ca-islamic-civil',
	'en-u-ca-gregory', 'en-u-ca-gregorian', 'en-u-kn-true', 'en-u-kn-yes',
	'en-u-kn-false', 'en-u-kn', 'en-u-kb-yes', 'en-u-kf-yes',
	'en-u-co-phonebk', 'en-u-co-dict', 'en-u-co-trad', 'en-u-hc-h12',
	'en-u-nu-thai', 'en-u-nu-arab', 'en-u-ca-gregory-ca-buddhist',
	'en-u-rg-cn11', 'en-u-rg-gbzzzz', 'en-u-sd-cn11', 'en-u-sd-fi01',
	'en-u-attr-ca-gregory', 'en-u-bbb-aaa', 'en-u-aaa-aaa',
	'en-u-ca-gregory-co-phonebk-nu-latn', 'en-u-nu-latn-ca-gregory',
	'en-u-va-posix', 'en-u-dx-thai-hani', 'en-t-ja-m0-names',
	'en-t-iw', 'en-t-sh-latn', 'en-t-zh-hant-tw', 'en-t-m0-ungegn',
	'en-t-d0-fwidth-m0-alaloc', 'und-t-und-latn-m0-ungegn',
	'en-b-ccc-a-ddd', 'en-a-bbb-x-a-ccc', 'en-u-ca-gregory-t-ja',
	'en-z-zzz-u-ca-gregory-a-aaa', 'en-x-a-u-ca', 'de-u-co-phonebk-ka-shifted',
	'th-TH-u-nu-thai', 'ja-JP-u-ca-japanese', 'he-IL-u-ca-hebrew',
	'fa-IR', 'fa-AF', 'ps', 'ur-IN', 'dv', 'syr', 'yi', 'nqo', 'sd-Arab',
	'sd-Deva', 'ff-Adlm', 'hi-Latn', 'zh-Latn', 'en-Arab', 'ku-Arab', 'apc',
	'en-US-u-fw-mon', 'en-US-u-fw-sun', 'en-u-fw-xyz', 'en-u-ca-iso8601',
	'en-GB-u-ca-iso8601', 'ar-SA-u-ca-iso8601', 'fa-u-ca-iso8601-fw-thu',
	'en-u-ca-iso8601-rg-sazzzz', 'und-u-ca-iso8601', 'en-u-rg-ilzzzz',
	'en-u-rg-xxzzzz', 'en-GB-u-ca-iso8601-fw-sun', 'ar-AE', 'ar-MA',
	'und-001', 'und-ZZ', 'und-999', 'und-AQ', 'und-Arab-001', 'und-150',
	'und-US', 'und-IN', 'und-CN', 'und-RU', 'und-u-rg-gbzzzz',
	'und-u-rg-zzzzzz', 'en-u-rg-xazzzz', 'fr-u-rg-euzzzz', 'fr-u-rg-qozzzz',
	'fr-Latn-AX-u-rg-xazzzz', 'en-u-sd-zzzzzz', 'de-u-rg-unzzzz',
	'ars', 'ars-SA', 'ars-u-co-compat', 'zh-Latn', 'sr-Latn', 'en-Arab',
	'yue-Hans', 'zh-Hant-HK', 'ja-Kore', 'de-AT-u-co-phonebk',
	'und-Adlm', 'und-Aran', 'und-Rohg', 'und-Yezi', 'ff-Adlm', 'pa-PK',
	'ks-Deva', 'az-IR', 'sd-Deva', 'ar-Latn', 'he-Latn', 'en-Arab',
	'und-IL', 'und-PK', 'ru-Arab', 'fa-Cyrl', 'ug', 'dv', 'syr', 'nqo',
	'ar-DZ', 'fa-IR-u-fw-sat', 'en-IR', 'ps-AF', 'en-MV', 'en-BR', 'pt-BR',
	'en-ES', 'es', 'es-MX', 'es-US', 'ca-ES', 'gl', 'eu', 'ast', 'en-GB',
	'en-AU', 'en-CA', 'fr-CH', 'it-CH', 'de', 'de-LI', 'lt', 'lv', 'et',
	'fi', 'sv', 'da', 'is', 'fo', 'kl', 'ru', 'uk', 'be', 'kk', 'ky', 'tg',
	'tk', 'mn', 'mn-Mong', 'ja', 'ko', 'ko-KP', 'vi', 'th', 'lo', 'km',
	'my', 'si', 'ta', 'te', 'kn', 'ml', 'mr', 'gu', 'bn', 'or', 'as', 'ne',
	'dz', 'bo', 'ug', 'am', 'ti', 'om', 'so', 'sw', 'zu', 'xh', 'af', 'yo',
	'ig', 'ha', 'ha-Arab', 'el', 'cy', 'ga', 'gd', 'br', 'kw', 'mt', 'sq',
	'mk', 'bg', 'hr', 'bs', 'bs-Cyrl', 'cnr', 'tr', 'az', 'az-Cyrl', 'ka',
	'hy', 'chr', 'iu', 'haw', 'mi', 'sm', 'to', 'fj', 'en-AS', 'en-GU',
	'en-PH', 'en-IN', 'en-SG', 'en-HK', 'en-IL', 'en-ZA', 'en-NZ', 'en-IE',
	'zh-SG', 'zh-Hant-MO', 'yue-Hans', 'wuu', 'hak', 'nan', 'en-AE', 'en-BH',
	'en-QA', 'en-001-u-hc-h23', 'en-DE', 'en-JP', 'en-KR', 'en-TW', 'en-CN'];

// tags that are not structurally valid, or that ICU refuses
const BAD = ['', 'e', 'en_US', 'root', 'en-gb-oed', 'no-nyn', 'i-klingon',
	'zh-cmn-Hant', 'x-private', 'en-US-', '-en', 'en--US', 'en-u',
	'en-u-ca', 'en-t', 'en-a', 'en-x', 'en-u-co-phonebook', 'en-u-x0-abc',
	'en-US-posix-posix', 'en-u-ca-gregory-u-nu-latn', 'en-a-aaa-a-bbb',
	'abcdefghi', 'en-Latn-Latn', 'en-US-US', '123', 'en-123456789',
	'en-t-en-latn-latn', 'en-t-x0', 'en-t-x0-a', 'en-u-a', 'en-u-ca-a',
	'enx-US', 'en-US-1', 'en-US-12', 'en-US-abcd', 'de-1901-1901',
	'en-\u00e9', 'en-\u0130', 'tlh-a-b-foo', 'en-u-0a'];

// [tag, options]
const OPTIONS = [
	['en', { region: 'GB' }], ['en', { script: 'latn' }],
	['en-US', { language: 'fr' }], ['en', { language: 'iw' }],
	['en', { language: 'zh', script: 'Hant', region: 'tw' }],
	['en', { region: 'SU' }], ['en', { calendar: 'buddhist' }],
	['en', { calendar: 'islamicc' }], ['en', { calendar: 'gregorian' }],
	['en', { calendar: 'ethiopic-amete-alem' }],
	['en-u-ca-gregory', { calendar: 'japanese' }],
	['en', { collation: 'phonebk', caseFirst: 'upper', numeric: true }],
	['en', { caseFirst: 'false', numeric: false }],
	['en', { caseFirst: 'lower', numeric: 0 }], ['en', { numeric: 'yes' }],
	['en', { hourCycle: 'h11' }], ['en-u-hc-h23', { hourCycle: 'h24' }],
	['en', { numberingSystem: 'arab' }], ['en', { numberingSystem: 'ARAB' }],
	['en', { calendar: 'Japanese' }], ['en', { collation: 'trad' }],
	['en-US-u-ca-gregory', { region: 'GB', numberingSystem: 'thai' }],
	['en-x-a', { region: 'GB' }], ['en-u-attr', { calendar: 'roc' }],
	['und', { language: 'sh' }], ['sh', { script: 'Cyrl' }],
	['en', { language: 'en-US' }], ['en', { language: 'root' }],
	['en', { language: 'x' }], ['en', { script: 'Lat' }],
	['en', { region: 'USA' }], ['en', { region: '4' }],
	['en', { calendar: 'a' }], ['en', { calendar: 'gregory-' }],
	['en', { collation: 'a-b' }], ['en', { hourCycle: 'h25' }],
	['en', { hourCycle: 'H23' }], ['en', { caseFirst: 'yes' }],
	['en', { numberingSystem: 'latn-' }], ['en', { calendar: '' }],
	['en', {}], ['en', null], ['en', 'str']
];

function pakReader(file) {
	const b = fs.readFileSync(file), n = b.readUInt32LE(4), ix = {};
	let o = 8;

	for (let i = 0; i < n; i++) {
		const l = b[o], name = b.toString('utf8', o + 1, o + 1 + l);

		o += 1 + l;
		ix[name] = [b.readUInt32LE(o), b.readUInt32LE(o + 4)];
		o += 12;
	}
	return name => JSON.parse(zlib.inflateSync(
		b.subarray(ix[name][0], ix[name][0] + ix[name][1])).toString());
}

function err(f) {
	try {
		return f();
	} catch (e) {
		return { err: e.constructor.name };
	}
}

// UTS #35's Remove Likely Subtags, on ICU's maximize, favouring the
// region as ICU does
function minimize(l) {
	const lsr = x => [x.language || 'und', x.script, x.region]
		.filter(Boolean).join('-');
	const max = l.maximize(), key = lsr(max);
	const trials = [max.language, max.language + '-' + max.region,
		max.language + '-' + max.script];
	let base = key;

	if (!max.script || !max.region || !max.language)
		return String(l.minimize());
	for (const t of trials) {
		if (lsr(new Intl.Locale(t).maximize()) === key) {
			base = t;
			break;
		}
	}
	return base + String(l).slice(lsr(l).length);
}

// what ICU gives for a Locale: [toString, baseName, language, script,
// region, calendar, caseFirst, collation, hourCycle, numberingSystem,
// numeric, maximize, minimize, info]
function locale(tag, o, info) {
	return err(() => {
		const l = o === undefined ? new Intl.Locale(tag) :
			new Intl.Locale(tag, o);

		return [String(l), l.baseName.replace(/-u-.*/, ''),
			l.language || 'und', l.script || null,
			l.region || null, l.calendar || null, l.caseFirst || null,
			l.collation || null, l.hourCycle || null,
			l.numberingSystem || null, l.numeric, String(l.maximize()),
			minimize(l), info ? [l.calendars, l.collations,
				l.hourCycles, l.numberingSystems, l.timeZones || null,
				l.textInfo, l.weekInfo] : null];
	});
}

export function cases(full) {
	const out = [];
	let tags = TAGS.slice();

	if (full) {
		const R = pakReader(process.env.PAK ||
				    path.join(ROOT, 'resources/intl.pak'));
		const a = R('aliases'), L = R('likely');

		for (const k of ['l', 's', 'r', 'v']) {
			for (const t of Object.keys(a[k])) {
				tags.push(k === 'l' ? t : k === 's' ? 'und-' + t :
					  k === 'r' ? 'en-' + t : 'en-' + t);
				if (k === 'r')
					tags.push('und-' + t);
			}
		}
		for (const k of ['u', 't']) {
			for (const key in a[k]) {
				for (const v in a[k][key])
					tags.push('en-' + k + '-' + key + '-' + v);
			}
		}
		for (const t of Object.keys(a.d))
			tags.push('en-u-rg-' + t, 'en-u-sd-' + t);
		tags = tags.concat(Object.keys(L));
		// every locale ICU has a collation bundle for
		tags = tags.concat(Object.keys(R('k:meta').locales).filter(t =>
			t !== 'root' && !/-POSIX$/.test(t)));
	}
	tags = [...new Set(tags)];
	for (const t of tags) {
		out.push({ k: 'can', t, c: err(() => Intl.getCanonicalLocales(t)),
			l: locale(t, undefined, !full || out.length % 4 === 0) });
	}
	// every locale's preferences, numbering system among them
	if (full) {
		const R = pakReader(process.env.PAK ||
				    path.join(ROOT, 'resources/intl.pak'));

		for (const t of Object.keys(R('index').locales))
			out.push({ k: 'loc', t, l: locale(t, undefined, true) });
	}
	// every region's time zones and preferences, and every region an rg
	// or sd keyword might name
	if (full) {
		const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', regions = [];

		for (const a of A) {
			for (const b of A)
				regions.push(a + b);
		}
		for (let i = 0; i < 1000; i++)
			regions.push(String(i).padStart(3, '0'));
		for (const r of regions) {
			const ts = ['und-' + r];

			if (/^[A-Z]/.test(r))
				ts.push('fr-u-rg-' + r.toLowerCase() + 'zzzz',
					'und-u-sd-' + r.toLowerCase() + 'zzzz');
			for (const t of ts)
				out.push({ k: 'loc', t, l: locale(t, undefined, true) });
		}
	}
	for (const t of BAD)
		out.push({ k: 'can', t, c: err(() => Intl.getCanonicalLocales(t)),
			l: locale(t) });
	for (const [t, o] of OPTIONS)
		out.push({ k: 'opt', t, o, l: locale(t, o, true) });
	out.push({ k: 'list', t: ['en-us', 'EN-US', 'iw', 'he', 'sh'],
		c: Intl.getCanonicalLocales(['en-us', 'EN-US', 'iw', 'he', 'sh']) });
	out.push({ k: 'sup', t: ['iw', 'en-SU', 'sh-YU', 'xx'],
		c: [Intl.NumberFormat.supportedLocalesOf(['iw', 'en-SU', 'sh-YU',
			'xx']), Intl.PluralRules.supportedLocalesOf(['iw'])] });
	out.push({ k: 'nf', t: 'iw-u-nu-arab',
		c: new Intl.NumberFormat('iw-u-nu-arab').resolvedOptions().locale });
	return out;
}

// the check, shared by the page and by a run under Node
export function CHECK(CASES, I) {
	var fails = [], n = 0, NAMES = ['toString', 'baseName', 'language',
		'script', 'region', 'calendar', 'caseFirst', 'collation',
		'hourCycle', 'numberingSystem', 'numeric', 'maximize', 'minimize'];
	var INFO = ['Calendars', 'Collations', 'HourCycles', 'NumberingSystems',
		'TimeZones', 'TextInfo', 'WeekInfo'];

	function same(a, b) {
		return JSON.stringify(a) === JSON.stringify(b);
	}
	function err(f) {
		try {
			return f();
		} catch (e) {
			return { err: e.constructor.name };
		}
	}
	function info(l, name) {
		var g = 'get' + name;

		if (typeof l[g] === 'function')
			return l[g]();
		return l[name.charAt(0).toLowerCase() + name.slice(1)];
	}
	function locale(tag, o, want) {
		return err(function () {
			var l = o === undefined ? new I.Locale(tag) :
				new I.Locale(tag, o);

			return [String(l), l.baseName, l.language, l.script || null,
				l.region || null, l.calendar || null, l.caseFirst || null,
				l.collation || null, l.hourCycle || null,
				l.numberingSystem || null, l.numeric,
				String(l.maximize()), String(l.minimize()),
				want ? INFO.map(function (x) {
					var v = info(l, x);

					return v === undefined ? null : v;
				}) : null];
		});
	}
	function check(what, got, want) {
		var i;

		n++;
		if (!Array.isArray(want) || !Array.isArray(got)) {
			if (!same(got, want))
				fails.push(what + ': ' + JSON.stringify(got) + ', ICU ' +
					   JSON.stringify(want));
			return;
		}
		for (i = 0; i < want.length; i++) {
			if (!same(got[i], want[i]))
				fails.push(what + ' ' + (NAMES[i] || 'info') + ': ' +
					   JSON.stringify(got[i]) + ', ICU ' +
					   JSON.stringify(want[i]));
		}
	}
	CASES.forEach(function (c) {
		var w = c.k + ' ' + JSON.stringify(c.t) +
			(c.o !== undefined ? ' ' + JSON.stringify(c.o) : '');

		if (c.k === 'can' || c.k === 'list')
			check(w + ' canonical', err(function () {
				return I.getCanonicalLocales(c.t);
			}), c.c);
		if (c.k === 'sup')
			check(w, [I.NumberFormat.supportedLocalesOf(c.t),
				I.PluralRules.supportedLocalesOf(['iw'])], c.c);
		if (c.k === 'nf')
			check(w, new I.NumberFormat(c.t).resolvedOptions().locale, c.c);
		if (c.l)
			check(w, locale(c.t, c.o, c.l && c.l[13]), c.l);
	});
	return { n: n, fails: fails };
}

// what the spec gives where Node's V8 has nothing to check against
export function SPEC(I) {
	var fails = [], n = 0;

	function is(what, got, want) {
		n++;
		if (JSON.stringify(got) !== JSON.stringify(want))
			fails.push(what + ': ' + JSON.stringify(got) + ', spec ' +
				   JSON.stringify(want));
	}
	function throws(what, f, type) {
		n++;
		try {
			f();
			fails.push(what + ': no ' + type.name);
		} catch (e) {
			if (!(e instanceof type))
				fails.push(what + ': ' + e);
		}
	}
	var L = I.Locale, p = L.prototype;

	is('variants', new L('sl-rozaj-biske-1994').variants, '1994-biske-rozaj');
	is('no variants', new L('en-US').variants, undefined);
	is('variants option', new L('en', { variants: 'POSIX' }).toString(),
	   'en-u-va-posix');
	is('variants option', new L('de', { variants: '1996' }).toString(),
	   'de-1996');
	throws('repeated variants', function () {
		return new L('en', { variants: 'fonipa-fonipa' });
	}, RangeError);
	throws('empty variants', function () {
		return new L('en', { variants: '' });
	}, RangeError);
	is('variants getter', typeof Object.getOwnPropertyDescriptor(p,
		'variants').get, 'function');
	is('firstDayOfWeek', new L('en-u-fw-mon').firstDayOfWeek, 'mon');
	is('firstDayOfWeek option', new L('en', { firstDayOfWeek: 1 })
		.toString(), 'en-u-fw-mon');
	is('firstDayOfWeek 0', new L('en', { firstDayOfWeek: 0 }).firstDayOfWeek,
	   'sun');
	is('firstDayOfWeek 7', new L('en', { firstDayOfWeek: '7' })
		.firstDayOfWeek, 'sun');
	is('firstDayOfWeek tue', new L('en-US', { firstDayOfWeek: 'tue' })
		.getWeekInfo().firstDay, 2);
	throws('firstDayOfWeek 8', function () {
		return new L('en', { firstDayOfWeek: 'ab' });
	}, RangeError);
	['getCalendars', 'getCollations', 'getHourCycles',
	 'getNumberingSystems', 'getTimeZones', 'getTextInfo',
	 'getWeekInfo'].forEach(function (m) {
		is(m, typeof p[m], 'function');
		throws(m + ' on a plain object', function () {
			return p[m].call({});
		}, TypeError);
	});
	is('fresh arrays', new L('en-US').getCalendars() !==
	   new L('en-US').getCalendars(), true);
	is('no region, no time zones', new L('en').getTimeZones(), undefined);
	// a key with no value: the getter's "true", which V8 gives as ICU's
	// "yes" (and its hourCycles throws for en-u-nu)
	is('ca with no value', new L('en-u-ca').getCalendars(), ['true']);
	is('co with no value', new L('en-u-co').getCollations(), ['true']);
	is('hc with no value', new L('en-u-hc').getHourCycles(), ['true']);
	is('nu with no value', new L('en-u-nu').getNumberingSystems(),
	   ['true']);
	is('nu with no value, hour cycles', new L('en-u-nu').getHourCycles(),
	   ['h12']);
	is('ca and nu with no value', new L('en-u-ca-nu').calendars, ['true']);
	is('toStringTag', Object.prototype.toString.call(new L('en')),
	   '[object Intl.Locale]');
	is('und-x-private', new L('und-x-private').toString(), 'und-x-private');
	throws('call', function () { return L('en'); }, TypeError);
	throws('no tag', function () { return new L(); }, TypeError);
	throws('null', function () { return new L(null); }, TypeError);
	throws('number', function () { return new L(5); }, TypeError);
	is('Locale as tag', new L(new L('en-US-u-ca-roc'), { region: 'GB' })
		.toString(), 'en-GB-u-ca-roc');
	is('Locale in a list', I.getCanonicalLocales([new L('iw')]), ['he']);
	is('NumberFormat on a Locale', new I.NumberFormat(new L('de-CH'))
		.resolvedOptions().locale, 'de-CH');
	return { n: n, fails: fails };
}

function html() {
	const list = cases(false);

	return `<!DOCTYPE html>
<!-- Intl.Locale and canonical locale tags against ICU
     (${process.versions.icu}, CLDR ${process.versions.cldr}), written by
     scripts/gen-intl-tags-tests.mjs: what Node gives for each case, and
     what the spec gives where Node has no answer. -->
<html><head><meta charset="utf-8"><title>t</title></head><body><div id="out"></div>
<script>
var CASES = ${JSON.stringify(list)};
${CHECK.toString()}
${SPEC.toString()}
var r = CHECK(CASES, Intl), s = SPEC(Intl), fails = r.fails.concat(s.fails);
var n = r.n + s.n, m = (fails.length ? 'FAIL ' : 'PASS ') +
	(n - fails.length) + ' of ' + n + ' cases as ICU and the spec give them';
fails.slice(0, 40).forEach(function (f) { console.log('FAIL ' + f); });
console.log(m);
document.getElementById('out').textContent = m;
</script></body></html>
`;
}

if (import.meta.url === 'file://' + process.argv[1])
	process.stdout.write(html());
