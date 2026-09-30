/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl.DateTimeFormat (VitaSurf).
 *
 * The options are read as ECMA-402 reads them, the pattern is chosen by
 * vita/js/intl_pattern.js as ICU would choose it, and the time is
 * formatted in C (vita/js/intl.c) in any IANA time zone. It replaces
 * the prelude's stand-in, which a page could tell apart from the real
 * thing -- no formatToParts on the prototype, no dateStyle, no time
 * zones -- and Home Assistant told apart and polyfilled, at the cost of
 * eight seconds of a cold load. Only English locales have data; a page
 * that asks for another gets English, and supportedLocalesOf says so.
 */
(function () {
	'use strict';
	var W = window, N = W.__vitaIntl, P = W.__vitaIntlPattern;

	if (!N || !P || !W.Intl)
		return;

	var TAGS = N.locales(), DATA = [];
	var FIELDS = ['weekday', 'era', 'year', 'month', 'day', 'dayPeriod',
		'hour', 'minute', 'second', 'fractionalSecondDigits',
		'timeZoneName'];
	var VALUES = {
		weekday: ['narrow', 'short', 'long'],
		era: ['narrow', 'short', 'long'],
		year: ['2-digit', 'numeric'],
		month: ['2-digit', 'numeric', 'narrow', 'short', 'long'],
		day: ['2-digit', 'numeric'],
		dayPeriod: ['narrow', 'short', 'long'],
		hour: ['2-digit', 'numeric'],
		minute: ['2-digit', 'numeric'],
		second: ['2-digit', 'numeric'],
		timeZoneName: ['short', 'long', 'shortOffset', 'longOffset',
			'shortGeneric', 'longGeneric']
	};
	var STYLES = ['full', 'long', 'medium', 'short'];
	var HC_CHAR = { h11: 'K', h12: 'h', h23: 'H', h24: 'k' };
	var UTC_NAMES = { 'Etc/UTC': 1, 'Etc/GMT': 1 };

	function data(i) {
		return DATA[i] || (DATA[i] = N.data(i));
	}

	/* ---- locales ---- */

	var LANGTAG = /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?(-([a-z\d]{5,8}|\d[a-z\d]{3}))*(-[a-wyz\d](-[a-z\d]{2,8})+)*(-x(-[a-z\d]{1,8})+)?$/i;

	function canonicalTag(tag) {
		if (typeof tag !== 'string' && (typeof tag !== 'object' ||
		    tag === null))
			throw new TypeError('Locale must be a string or object');
		tag = String(tag);
		if (!LANGTAG.test(tag))
			throw new RangeError('Incorrect locale information ' +
					     'provided');
		var p = tag.split('-'), i, ext = false;

		p[0] = p[0].toLowerCase();
		for (i = 1; i < p.length; i++) {
			if (p[i].length === 1)
				ext = true;
			if (ext)
				p[i] = p[i].toLowerCase();
			else if (p[i].length === 4 && /^[a-z]/i.test(p[i]))
				p[i] = p[i].charAt(0).toUpperCase() +
					p[i].slice(1).toLowerCase();
			else if (p[i].length === 2)
				p[i] = p[i].toUpperCase();
			else
				p[i] = p[i].toLowerCase();
		}
		return p.join('-');
	}

	function localeList(locales) {
		var out = [], i;

		if (locales === undefined)
			return out;
		if (typeof locales === 'string' ||
		    (W.Intl.Locale && locales instanceof W.Intl.Locale))
			locales = [String(locales)];
		locales = Object(locales);
		for (i = 0; i < (locales.length >>> 0); i++) {
			if (!(i in locales))
				continue;
			var t = canonicalTag(locales[i]);

			if (out.indexOf(t) < 0)
				out.push(t);
		}
		return out;
	}

	/* the tag without its extensions, and its -u- keywords */
	function splitTag(tag) {
		var m = /^(.*?)(-u(-[a-z\d]{2,8})+)?(-x-.*)?$/.exec(tag);
		var kw = {}, base = m[1], u = m[2];

		base = base.replace(/-[a-wyz\d](-[a-z\d]{2,8})+$/, '');
		if (u) {
			var p = u.slice(3).split('-'), key = null, i;

			for (i = 0; i < p.length; i++) {
				if (p[i].length === 2 && /^[a-z\d][a-z]$/.test(p[i])) {
					key = p[i];
					kw[key] = '';
				} else if (key) {
					kw[key] = kw[key] ? kw[key] + '-' + p[i] : p[i];
				}
			}
		}
		return { base: base, kw: kw };
	}

	/* the tag we have data for that a tag falls back to, by dropping
	 * subtags from the end */
	function available(base) {
		var t = base, i;

		while (t) {
			for (i = 0; i < TAGS.length; i++) {
				if (TAGS[i].toLowerCase() === t.toLowerCase())
					return { idx: i, tag: TAGS[i] };
			}
			if (t.toLowerCase() === 'en-us')
				return { idx: 0, tag: 'en-US' };
			var cut = t.lastIndexOf('-');

			t = cut > 0 ? t.slice(0, cut) : '';
			/* a single letter left behind is not a subtag */
			if (/-[a-z\d]$/i.test(t))
				t = t.slice(0, t.lastIndexOf('-'));
		}
		return null;
	}

	function defaultLocale() {
		var l = (W.navigator && W.navigator.language) || 'en-US';

		return available(l) ? l : 'en';
	}

	function resolveLocale(requested) {
		var i;

		for (i = 0; i < requested.length; i++) {
			var s = splitTag(requested[i]), a = available(s.base);

			if (a)
				return { idx: a.idx, tag: a.tag, kw: s.kw };
		}
		var d = available(defaultLocale());

		return { idx: d.idx, tag: d.tag, kw: {} };
	}

	function supported(locales, options) {
		var req = localeList(locales), out = [], i;

		if (options !== undefined) {
			options = Object(options);
			getOption(options, 'localeMatcher',
				  ['lookup', 'best fit'], 'best fit');
		}
		for (i = 0; i < req.length; i++) {
			if (available(splitTag(req[i]).base))
				out.push(req[i]);
		}
		return out;
	}

	function getOption(o, name, allowed, fallback) {
		var v = o[name];

		if (v === undefined)
			return fallback;
		v = String(v);
		if (allowed && allowed.indexOf(v) < 0)
			throw new RangeError('Value ' + v + ' out of range for ' +
					     'Intl.DateTimeFormat options ' +
					     'property ' + name);
		return v;
	}

	/* ---- time zones ---- */

	function resolveZone(tz) {
		var z;

		if (tz === undefined)
			return defaultZone();
		z = N.zone(String(tz));
		if (!z)
			throw new RangeError('Invalid time zone specified: ' + tz);
		/* every name of UTC goes by UTC */
		if (UTC_NAMES[z[0]] || z[0] === 'UTC')
			return { name: 'UTC', num: N.zone('Etc/UTC')[1] };
		return { name: z[0], num: z[1] };
	}

	var DEFAULT_ZONE = null;

	function defaultZone() {
		if (DEFAULT_ZONE)
			return DEFAULT_ZONE;
		/* the zone Date works in: the Vita's clock runs on UTC */
		var off = -new Date().getTimezoneOffset(), name;

		if (off === 0) {
			name = 'UTC';
		} else if (off % 60 === 0 && Math.abs(off) <= 14 * 60) {
			name = 'Etc/GMT' + (off > 0 ? '-' : '+') +
				Math.abs(off / 60);
		} else {
			var a = Math.abs(off);

			name = (off < 0 ? '-' : '+') +
				('0' + Math.floor(a / 60)).slice(-2) + ':' +
				('0' + a % 60).slice(-2);
		}
		DEFAULT_ZONE = resolveZone(name);
		return DEFAULT_ZONE;
	}

	/* ---- the formatter ---- */

	var SLOTS = new WeakMap();

	function slots(dtf, method) {
		var s = SLOTS.get(dtf);

		if (!s)
			throw new TypeError('Method Intl.DateTimeFormat.prototype.' +
					    method + ' called on incompatible ' +
					    'receiver');
		return s;
	}

	function skeletonOf(o, hc) {
		var s = '';

		if (o.era)
			s += { short: 'G', long: 'GGGG', narrow: 'GGGGG' }[o.era];
		if (o.year)
			s += o.year === '2-digit' ? 'yy' : 'y';
		if (o.month)
			s += { numeric: 'M', '2-digit': 'MM', short: 'MMM',
				long: 'MMMM', narrow: 'MMMMM' }[o.month];
		if (o.weekday)
			s += { short: 'EEE', long: 'EEEE', narrow: 'EEEEE' }[o.weekday];
		if (o.day)
			s += o.day === '2-digit' ? 'dd' : 'd';
		if (o.dayPeriod && !(o.hour && (hc === 'h23' || hc === 'h24')))
			s += { short: 'B', long: 'BBBB', narrow: 'BBBBB' }[o.dayPeriod];
		if (o.hour)
			s += o.hour === '2-digit' ? HC_CHAR[hc] + HC_CHAR[hc] :
				HC_CHAR[hc];
		if (o.minute)
			s += o.minute === '2-digit' ? 'mm' : 'm';
		if (o.second)
			s += o.second === '2-digit' ? 'ss' : 's';
		if (o.fractionalSecondDigits)
			s += 'SSS'.slice(0, o.fractionalSecondDigits);
		if (o.timeZoneName)
			s += { short: 'z', long: 'zzzz', shortOffset: 'O',
				longOffset: 'OOOO', shortGeneric: 'v',
				longGeneric: 'vvvv' }[o.timeZoneName];
		return s;
	}

	/* what resolvedOptions reports, read off the pattern */
	function optionsOfPattern(pattern) {
		var f = P.fieldsOf(pattern), o = {}, c, n;
		var TEXT = [null, 'short', 'short', 'short', 'long', 'narrow'];

		for (c in f) {
			n = f[c];
			switch (c) {
			case 'G': o.era = TEXT[n]; break;
			case 'y': case 'Y': case 'u':
				o.year = n === 2 ? '2-digit' : 'numeric'; break;
			case 'M': case 'L':
				o.month = n === 1 ? 'numeric' : n === 2 ? '2-digit' :
					TEXT[n]; break;
			case 'd': o.day = n === 2 ? '2-digit' : 'numeric'; break;
			case 'E': case 'c': case 'e':
				o.weekday = n === 4 ? 'long' : n === 5 ? 'narrow' :
					'short'; break;
			case 'B': o.dayPeriod = TEXT[n]; break;
			case 'h': case 'H': case 'K': case 'k':
				o.hour = n === 2 ? '2-digit' : 'numeric'; break;
			case 'm': o.minute = n === 2 ? '2-digit' : 'numeric'; break;
			case 's': o.second = n === 2 ? '2-digit' : 'numeric'; break;
			case 'S': o.fractionalSecondDigits = n; break;
			case 'z': o.timeZoneName = n === 4 ? 'long' : 'short'; break;
			case 'O': o.timeZoneName = n === 4 ? 'longOffset' :
				'shortOffset'; break;
			case 'v': o.timeZoneName = n === 4 ? 'longGeneric' :
				'shortGeneric'; break;
			}
		}
		return o;
	}

	/*
	 * ECMA-402 CreateDateTimeFormat. required and defaults are
	 * ToDateTimeOptions' for Date.prototype.toLocale*String:
	 * 'any'/'date'/'time' and 'date'/'time'/'all'.
	 */
	function create(dtf, locales, options, required, defaults) {
		var req = localeList(locales), o, s = {}, i, hc, hour12,
			hourCycle, ld, need, explicit = false;

		required = required || 'any';
		defaults = defaults || 'date';
		o = options === undefined ? Object.create(null) : Object(options);
		getOption(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
		var cal = o.calendar;

		if (cal !== undefined && !/^[a-z\d]{3,8}(-[a-z\d]{3,8})*$/i.test(
				String(cal)))
			throw new RangeError('Invalid calendar : ' + cal);
		var nu = o.numberingSystem;

		if (nu !== undefined && !/^[a-z\d]{3,8}(-[a-z\d]{3,8})*$/i.test(
				String(nu)))
			throw new RangeError('Invalid numberingSystem : ' + nu);
		hour12 = o.hour12;
		if (hour12 !== undefined)
			hour12 = Boolean(hour12);
		hourCycle = getOption(o, 'hourCycle', ['h11', 'h12', 'h23', 'h24'],
				      undefined);
		if (hour12 !== undefined)
			hourCycle = null;

		var loc = resolveLocale(req);

		s.idx = loc.idx;
		ld = data(loc.idx);
		s.data = ld;
		s.locale = loc.tag;
		/* -u-hc, where no option overrides it */
		if (hourCycle === undefined && hour12 === undefined &&
		    HC_CHAR[loc.kw.hc]) {
			hourCycle = loc.kw.hc;
			s.locale += '-u-hc-' + hourCycle;
		}
		s.zone = resolveZone(o.timeZone);

		var f = {};

		for (i = 0; i < FIELDS.length; i++) {
			var k = FIELDS[i], v;

			if (k === 'fractionalSecondDigits') {
				v = o[k];
				if (v !== undefined) {
					v = Number(v);
					if (!(v >= 1 && v <= 3) || isNaN(v))
						throw new RangeError(
							'fractionalSecondDigits ' +
							'value is out of range.');
					v = Math.floor(v);
				}
			} else {
				v = getOption(o, k, VALUES[k], undefined);
			}
			if (v !== undefined) {
				f[k] = v;
				explicit = true;
			}
		}
		getOption(o, 'formatMatcher', ['basic', 'best fit'], 'best fit');
		var ds = getOption(o, 'dateStyle', STYLES, undefined);
		var ts = getOption(o, 'timeStyle', STYLES, undefined);

		/* the hour cycle, for a pattern with an hour in it */
		if (hour12 === true)
			hc = 'h12';
		else if (hour12 === false)
			hc = 'h23';
		else
			hc = hourCycle || ld.hc;
		s.hcExplicit = hour12 !== undefined || !!hourCycle;

		if (ds || ts) {
			if (explicit)
				throw new TypeError("Can't set option " +
					Object.keys(f)[0] + ' when ' +
					(ds ? 'dateStyle' : 'timeStyle') +
					' is used');
			if (required === 'date' && ts)
				throw new TypeError('Invalid option : timeStyle');
			if (required === 'time' && ds)
				throw new TypeError('Invalid option : dateStyle');
			var tp = ts ? (s.hcExplicit ? ld.timeHc[ts][hc] :
				       ld.time[ts]) : null;
			var dp = ds ? ld.date[ds] : null;

			s.pattern = dp && tp ? ld.styleGlue[ds].replace('{1}', dp)
				.replace('{0}', tp) : dp || tp;
			s.dateStyle = ds;
			s.timeStyle = ts;
			s.skeleton = skeletonFromPattern(s.pattern);
		} else {
			need = true;
			if (required !== 'time' && (f.weekday || f.year ||
			    f.month || f.day))
				need = false;
			if (required !== 'date' && (f.dayPeriod || f.hour ||
			    f.minute || f.second || f.fractionalSecondDigits))
				need = false;
			if (need && (defaults === 'date' || defaults === 'all')) {
				f.year = f.month = f.day = 'numeric';
			}
			if (need && (defaults === 'time' || defaults === 'all')) {
				f.hour = f.minute = f.second = 'numeric';
			}
			s.skeleton = skeletonOf(f, hc);
			s.pattern = P.bestPattern(ld, s.skeleton);
		}
		s.hc = /[hHKk]/.test(s.pattern.replace(/'[^']*'/g, '')) ?
			hc : null;
		SLOTS.set(dtf, s);
		return dtf;
	}

	function skeletonFromPattern(p) {
		var f = P.fieldsOf(p), out = '', c;

		for (c in f) {
			if (/[GyMLEcdBhHKkmsSzOv]/.test(c))
				out += new Array(f[c] + 1).join(c === 'L' ? 'M' :
								c === 'c' ? 'E' : c);
		}
		return out;
	}

	function timeValue(date) {
		var x = date === undefined ? Date.now() : Number(date);

		if (!isFinite(x) || Math.abs(x) > 8.64e15)
			throw new RangeError('Invalid time value');
		return x;
	}

	function parts(flat, source) {
		var out = [], i;

		for (i = 0; i < flat.length; i += 2) {
			var p = { type: flat[i], value: flat[i + 1] };

			if (source)
				p.source = source;
			out.push(p);
		}
		return out;
	}

	/* ---- ranges ---- */

	/* the pattern's fields by how fine they are: era 0 to fraction 8 */
	var RANK = { G: 0, y: 1, M: 2, L: 2, d: 3, E: 3, c: 3, a: 4, B: 4,
		h: 5, H: 5, K: 5, k: 5, m: 6, s: 7, S: 8 };
	var DIFF = ['G', 'y', 'M', 'd', 'a', 'h', 'm', 's', 'S'];

	function finest(skel) {
		var r = -1, i;

		for (i = 0; i < skel.length; i++) {
			var k = RANK[skel.charAt(i)];

			if (k !== undefined && k > r)
				r = k;
		}
		return r;
	}

	function splitSkeleton(sk) {
		return {
			date: sk.replace(/[BhHKkmsSzOv]/g, ''),
			time: sk.replace(/[GyMLEcd]/g, '')
		};
	}

	/* a range pattern cut where its second date starts: at the first
	 * field that comes round again */
	function cut(pattern) {
		var seen = {}, i = 0, n = pattern.length;

		while (i < n) {
			var c = pattern.charAt(i), j = i + 1;

			if (c === "'") {
				while (j < n && pattern.charAt(j) !== "'")
					j++;
				i = j + 1;
				continue;
			}
			while (j < n && pattern.charAt(j) === c)
				j++;
			if (/[A-Za-z]/.test(c)) {
				var f = c === 'L' ? 'M' : c;

				if (seen[f])
					return [pattern.slice(0, i), pattern.slice(i)];
				seen[f] = 1;
			}
			i = j;
		}
		return null;
	}

	function letters(pattern) {
		var out = [], i = 0, n = pattern.length;

		while (i < n) {
			var c = pattern.charAt(i), j = i + 1;

			if (c === "'") {
				while (j < n && pattern.charAt(j) !== "'")
					j++;
				i = j + 1;
				continue;
			}
			while (j < n && pattern.charAt(j) === c)
				j++;
			if (/[A-Za-z]/.test(c))
				out.push(c === 'L' ? 'M' : c);
			i = j;
		}
		return out;
	}

	/* the parts of one half of a range: its fields that the other half
	 * has too, and what lies between them, are its own; the rest is
	 * shared */
	function halfParts(flat, pat, other, source) {
		var ps = parts(flat), mine = letters(pat), theirs = letters(other),
			fi = 0, first = -1, last = -1, i;

		for (i = 0; i < ps.length; i++) {
			if (ps[i].type === 'literal')
				continue;
			if (theirs.indexOf(mine[fi]) >= 0) {
				if (first < 0)
					first = i;
				last = i;
			}
			fi++;
		}
		for (i = 0; i < ps.length; i++)
			ps[i].source = i >= first && i <= last && first >= 0 ?
				source : 'shared';
		return ps;
	}

	function mergeLiterals(ps) {
		var out = [], i;

		for (i = 0; i < ps.length; i++) {
			var last = out[out.length - 1];

			if (last && last.type === 'literal' &&
			    ps[i].type === 'literal' && last.source === ps[i].source)
				last.value += ps[i].value;
			else
				out.push(ps[i]);
		}
		return out;
	}

	function formatRangeParts(s, x, y) {
		var z = s.zone.num, fa = N.fields(z, x), fb = N.fields(z, y),
			diff = -1, i, ld = s.data;

		for (i = 0; i < 9; i++) {
			if (fa[i] !== fb[i]) {
				diff = i;
				break;
			}
		}
		/* the era is told by the year, and a 24 hour clock tells AM
		 * from PM by the hour */
		if (diff === 0)
			diff = 1;
		var sk = s.skeleton, sp = splitSkeleton(sk);

		if (diff === 4 && !/[ahKB]/.test(s.pattern.replace(/'[^']*'/g, '')) &&
		    /[Hk]/.test(sk))
			diff = 5;
		if (diff < 0 || diff > finest(sk))
			return single(s, x, 'shared');

		var letter = DIFF[diff];

		if (sp.date && sp.time) {
			/* dates apart: each written out, with the date fields
			 * down to the one that changed */
			if (diff <= 3)
				return fallback(s, P.bestPattern(ld,
					withDate(sp.date, diff) + sp.time, true), x, y);
			var iv = rangePattern(ld, sp.time, letter);
			var dp = P.bestPattern(ld, sp.date);
			var g = ld.ivGlue.split(/\{([01])\}/), out = [], k;

			for (k = 0; k < g.length; k++) {
				if (k % 2 === 0) {
					if (g[k])
						out.push({ type: 'literal',
							value: unquote(g[k]),
							source: 'shared' });
				} else if (g[k] === '1') {
					out = out.concat(parts(N.format(s.idx, dp, z,
						x, true), 'shared'));
				} else if (iv) {
					out = out.concat(rangeHalves(s, iv, x, y));
				} else {
					/* no pattern for a range of these times:
					 * the two times in full */
					out = out.concat(fallback(s, P.bestPattern(ld,
						sp.time, true), x, y));
				}
			}
			return mergeLiterals(out);
		}
		if (sp.time) {
			if (diff <= 3)
				return fallback(s, P.bestPattern(ld, 'yMd' + sp.time,
								 true), x, y);
			var tv = rangePattern(ld, sp.time, letter);

			return tv ? mergeLiterals(rangeHalves(s, tv, x, y)) :
				fallback(s, P.bestPattern(ld, sk, true), x, y);
		}
		/* a date: what a year or a month apart needs to show it */
		var ext = sp.date;

		if (diff === 2 && /d/.test(ext) && !/M/.test(ext))
			ext = 'M' + ext;
		if (diff <= 1 && /d/.test(ext) && !/y/.test(ext))
			ext = 'y' + ext;
		/* one that has to be given fields to show the change is the
		 * two dates in full */
		var dv = ext === sp.date ? rangePattern(ld, ext, letter) : null;

		if (dv)
			return mergeLiterals(rangeHalves(s, dv, x, y));
		return fallback(s, P.bestPattern(ld, ext, true), x, y);
	}

	/* a date skeleton with the fields from the one a range changes in
	 * down to the day, where it has not got them */
	function withDate(date, diff) {
		var add = '';

		if (diff <= 1 && !/y/.test(date))
			add += 'y';
		if (diff <= 2 && !/[ML]/.test(date))
			add += 'M';
		if (diff <= 3 && !/d/.test(date))
			add += 'd';
		return add + date;
	}

	function unquote(t) {
		return t.replace(/'([^']*)'/g, function (m, q) {
			return q === '' ? "'" : q;
		});
	}

	function rangePattern(ld, skel, letter) {
		return P.intervalPattern(ld, skel, letter);
	}

	function rangeHalves(s, iv, x, y) {
		var c = cut(iv);

		if (!c)
			return single(s, x, 'shared');
		var a = halfParts(N.format(s.idx, c[0], s.zone.num, x, true),
				  c[0], c[1], 'startRange');
		var b = halfParts(N.format(s.idx, c[1], s.zone.num, y, true),
				  c[1], c[0], 'endRange');

		return a.concat(b);
	}

	function single(s, x, source) {
		return parts(N.format(s.idx, s.pattern, s.zone.num, x, true),
			     source);
	}

	function fallback(s, pattern, x, y) {
		var sep = unquote(s.data.ivSep);

		return mergeLiterals(parts(N.format(s.idx, pattern, s.zone.num,
						     x, true), 'startRange')
			.concat([{ type: 'literal', value: sep, source: 'shared' }])
			.concat(parts(N.format(s.idx, pattern, s.zone.num, y,
					       true), 'endRange')));
	}

	/* ---- the API ---- */

	function DateTimeFormat() {
		var dtf = this instanceof DateTimeFormat ? this :
			Object.create(DateTimeFormat.prototype);

		return create(dtf, arguments[0], arguments[1]);
	}

	var proto = DateTimeFormat.prototype;

	Object.defineProperty(proto, 'format', {
		configurable: true,
		get: function () {
			var s = slots(this, 'format');

			if (!s.bound) {
				/* ICU writes a narrow no-break space before AM
				 * and PM; format, and only format, gives a
				 * plain one, as V8 does for the pages that
				 * split on it */
				s.bound = function (date) {
					return N.format(s.idx, s.pattern, s.zone.num,
							timeValue(date)).replace(
						/\u202f/g, ' ');
				};
			}
			return s.bound;
		}
	});

	function method(name, fn) {
		Object.defineProperty(proto, name, {
			configurable: true, writable: true, value: fn
		});
	}

	method('formatToParts', function (date) {
		var s = slots(this, 'formatToParts');

		return parts(N.format(s.idx, s.pattern, s.zone.num,
				      timeValue(date), true));
	});

	function rangeArgs(a, b) {
		if (a === undefined || b === undefined)
			throw new TypeError('startDate and endDate are required');
		return [timeValue(a), timeValue(b)];
	}

	method('formatRange', function (a, b) {
		var s = slots(this, 'formatRange'), t = rangeArgs(a, b);
		var ps = formatRangeParts(s, t[0], t[1]), str = ps.map(function (p) {
			return p.value;
		}).join('');

		/* a range that comes to one date is written as format writes
		 * it, with a plain space before AM and PM */
		return ps.every(function (p) { return p.source === 'shared'; }) ?
			str.replace(/\u202f/g, ' ') : str;
	});

	method('formatRangeToParts', function (a, b) {
		var s = slots(this, 'formatRangeToParts'), t = rangeArgs(a, b);

		return formatRangeParts(s, t[0], t[1]);
	});

	method('resolvedOptions', function () {
		var s = slots(this, 'resolvedOptions'), r = {
			locale: s.locale, calendar: 'gregory',
			numberingSystem: 'latn', timeZone: s.zone.name
		};

		if (s.hc) {
			r.hourCycle = s.hc;
			r.hour12 = s.hc === 'h11' || s.hc === 'h12';
		}
		if (s.dateStyle || s.timeStyle) {
			if (s.dateStyle)
				r.dateStyle = s.dateStyle;
			if (s.timeStyle)
				r.timeStyle = s.timeStyle;
			return r;
		}
		var o = optionsOfPattern(s.pattern), i;

		for (i = 0; i < FIELDS.length; i++) {
			if (o[FIELDS[i]] !== undefined)
				r[FIELDS[i]] = o[FIELDS[i]];
		}
		return r;
	});

	Object.defineProperty(proto, Symbol.toStringTag, {
		configurable: true, value: 'Intl.DateTimeFormat'
	});
	Object.defineProperty(DateTimeFormat, 'supportedLocalesOf', {
		configurable: true, writable: true,
		value: function supportedLocalesOf(locales, options) {
			return supported(locales, options);
		}
	});
	Object.defineProperty(DateTimeFormat, 'prototype', { writable: false });

	W.Intl.DateTimeFormat = DateTimeFormat;

	/* ---- Date's own formatting ---- */

	var cache = {};

	function dateFormatter(kind, locales, options) {
		var req = kind === 'date' ? 'date' : kind === 'time' ? 'time' : 'any';
		var def = kind === 'date' ? 'date' : kind === 'time' ? 'time' : 'all';

		if (locales === undefined && options === undefined) {
			if (!cache[kind])
				cache[kind] = create(Object.create(proto), undefined,
						     undefined, req, def);
			return cache[kind];
		}
		return create(Object.create(proto), locales, options, req, def);
	}

	function toLocale(kind) {
		return function (locales, options) {
			var t = this instanceof Date ? this.getTime() : NaN;

			if (!(this instanceof Date))
				throw new TypeError('this is not a Date object.');
			if (isNaN(t))
				return 'Invalid Date';
			return dateFormatter(kind, locales, options).format(t);
		};
	}

	Object.defineProperty(Date.prototype, 'toLocaleString', {
		configurable: true, writable: true, value: toLocale('all')
	});
	Object.defineProperty(Date.prototype, 'toLocaleDateString', {
		configurable: true, writable: true, value: toLocale('date')
	});
	Object.defineProperty(Date.prototype, 'toLocaleTimeString', {
		configurable: true, writable: true, value: toLocale('time')
	});

	/* ---- Intl ---- */

	var values = W.Intl.supportedValuesOf;

	W.Intl.supportedValuesOf = function (key) {
		key = String(key);
		if (key === 'timeZone')
			return N.zones().sort();
		if (key === 'calendar')
			return ['gregory'];
		if (key === 'numberingSystem')
			return ['latn'];
		return values ? values(key) : [];
	};
	W.Intl.getCanonicalLocales = function (locales) {
		return localeList(locales);
	};
})();
