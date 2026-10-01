/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl.ListFormat and Intl.DurationFormat (VitaSurf).
 *
 * The prelude's ListFormat joined with commas in English and had no
 * formatToParts, and there was no DurationFormat, so Home Assistant
 * loaded FormatJS's DurationFormat with its own NumberFormat and
 * ListFormat underneath. These are ECMA-402's, for every locale ICU
 * has: the list patterns are CLDR's from resources/intl.pak
 * (scripts/gen-intl-numbers.mjs), with ICU's Spanish e and u and
 * Hebrew vav-dash, and a duration's numbers are written by
 * vita/js/intl_number.js's NumberFormat and joined as a unit list.
 *
 * Runs under Node too, to be held against ICU with the cases
 * scripts/gen-intl-list-tests.mjs makes: __vitaIntlList(W, C, X).
 */
var __vitaIntlList = function (W, C, X) {
	'use strict';

	var Intl = W.Intl, getOption = X.getOption, method = X.method;

	function optionsObject(o) {
		if (o === undefined)
			return Object.create(null);
		if (o === null || (typeof o !== 'object' && typeof o !== 'function'))
			throw new TypeError('Options must be an object');
		return o;
	}

	function slotsOf(map, name) {
		return function (obj, m) {
			var s = obj !== null && typeof obj === 'object' && map.get(obj);

			if (!s)
				throw new TypeError('Method Intl.' + name + '.prototype.' + m +
						    ' called on incompatible receiver');
			return s;
		};
	}

	/* ---- Intl.ListFormat ---- */

	var LF_SLOTS = new WeakMap(), lfSlots = slotsOf(LF_SLOTS, 'ListFormat');
	var NOLIST = null;

	/* a locale ListFormat offers: ICU's with list patterns of its own */
	function hasList(t) {
		var i, l;

		if (!NOLIST) {
			NOLIST = Object.create(null);
			l = X.index().nolist || [];
			for (i = 0; i < l.length; i++)
				NOLIST[l[i]] = true;
		}
		return X.hasLocale(t) && !NOLIST[t] ? t : null;
	}

	/* what a list is written with in a locale, type and width */
	function lister(tag, type, style) {
		return { patterns: patternsFor(tag, type, style),
			lang: C.splitTag(tag).base.split('-')[0] };
	}

	function ListFormat() {
		var s = {}, o, loc;

		if (!new.target)
			throw new TypeError('Constructor Intl.ListFormat requires \'new\'');
		var req = C.localeList(arguments[0]);

		o = optionsObject(arguments[1]);
		getOption(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
		loc = X.resolveLocale(req, undefined, false, hasList);
		s.locale = loc.locale;
		s.tag = loc.tag;
		s.type = getOption(o, 'type', ['conjunction', 'disjunction',
			'unit'], 'conjunction');
		s.style = getOption(o, 'style', ['long', 'short', 'narrow'], 'long');
		s.list = lister(s.tag, s.type, s.style);
		LF_SLOTS.set(this, s);
		return this;
	}

	/* the patterns of a type in a width, the narrower falling back to
	 * the wider, as in ICU */
	function patternsFor(tag, type, style) {
		var d = X.entry('l', X.dataTag(tag)), w = style === 'narrow' ?
			['narrow', 'short', 'long'] : style === 'short' ?
			['short', 'long'] : ['long'], i;

		for (i = 0; i < w.length; i++) {
			if (d[type + '-' + w[i]])
				return d[type + '-' + w[i]];
		}
		return ['{0}, {1}', '{0}, {1}', '{0}, {1}', '{0}, {1}'];
	}

	/* ICU's: y before an i sound is e, o before an o sound is u, and
	 * Hebrew's vav takes a dash before a word not in Hebrew */
	function changesToE(t) {
		var c = t.charAt(0).toLowerCase(), d = t.charAt(1).toLowerCase();

		if (c === 'h' && d === 'i')
			return t.length === 2 || !/[ae]/i.test(t.charAt(2));
		return c === 'i';
	}

	function changesToU(t) {
		var c = t.charAt(0).toLowerCase();

		if (c === 'o' || c === '8')
			return true;
		if (c === 'h' && t.charAt(1).toLowerCase() === 'o')
			return true;
		return t.slice(0, 2) === '11' && (t.length === 2 ||
						   t.charAt(2) === ' ');
	}

	function notHebrew(t) {
		var c = t.charCodeAt(0);

		if (!t.length)
			return false;
		return !((c >= 0x591 && c <= 0x5f4) || (c >= 0xfb1d && c <= 0xfb4f));
	}

	/* the pattern to put before element next, as ICU changes it */
	function contextual(s, pattern, next) {
		if (s.lang === 'es') {
			if (pattern === '{0} y {1}' && changesToE(next))
				return '{0} e {1}';
			if (pattern === '{0} o {1}' && changesToU(next))
				return '{0} u {1}';
		} else if (s.lang === 'he' || s.lang === 'iw') {
			if (pattern === '{0} \u05d5{1}' && notHebrew(next))
				return '{0} \u05d5-{1}';
		}
		return pattern;
	}

	/* a pattern applied to two lists of parts */
	function applyPattern(pattern, first, second) {
		var out = [], i = 0, a, b, j, k;

		a = pattern.indexOf('{0}');
		b = pattern.indexOf('{1}');
		var order = a < b ? [[a, first], [b, second]] :
			[[b, second], [a, first]];

		for (j = 0; j < 2; j++) {
			if (order[j][0] > i)
				out.push({ type: 'literal',
					value: pattern.slice(i, order[j][0]) });
			for (k = 0; k < order[j][1].length; k++)
				out.push(order[j][1][k]);
			i = order[j][0] + 3;
		}
		if (i < pattern.length)
			out.push({ type: 'literal', value: pattern.slice(i) });
		return out;
	}

	/* ECMA-402 CreatePartsFromList, with what lister() gave */
	function partsFromList(s, list) {
		var n = list.length, p = s.patterns, i, rest;
		var el = function (v) { return [{ type: 'element', value: v }]; };

		if (n === 0)
			return [];
		if (n === 1)
			return el(list[0]);
		if (n === 2)
			return applyPattern(contextual(s, p[3], list[1]), el(list[0]),
					    el(list[1]));
		rest = applyPattern(contextual(s, p[2], list[n - 1]),
				    el(list[n - 2]), el(list[n - 1]));
		for (i = n - 3; i > 0; i--)
			rest = applyPattern(p[1], el(list[i]), rest);
		return applyPattern(p[0], el(list[0]), rest);
	}

	/* ECMA-402 StringListFromIterable */
	function stringList(iterable) {
		var out = [], it, next;

		if (iterable === undefined)
			return out;
		it = iterable[Symbol.iterator]();
		while (!(next = it.next()).done) {
			if (typeof next.value !== 'string') {
				if (typeof it.return === 'function')
					it.return();
				throw new TypeError('Iterable yielded ' + String(next.value) +
						    ' which is not a string');
			}
			out.push(next.value);
		}
		return out;
	}

	var lfProto = ListFormat.prototype;

	method(lfProto, 'format', function format(list) {
		var s = lfSlots(this, 'format'), parts, out = '', i;

		parts = partsFromList(s.list, stringList(list));
		for (i = 0; i < parts.length; i++)
			out += parts[i].value;
		return out;
	});
	method(lfProto, 'formatToParts', function formatToParts(list) {
		var s = lfSlots(this, 'formatToParts');

		return partsFromList(s.list, stringList(list));
	});
	method(lfProto, 'resolvedOptions', function resolvedOptions() {
		var s = lfSlots(this, 'resolvedOptions');

		return { locale: s.locale, type: s.type, style: s.style };
	});
	Object.defineProperty(lfProto, Symbol.toStringTag, {
		configurable: true, value: 'Intl.ListFormat'
	});
	method(ListFormat, 'supportedLocalesOf',
	       function supportedLocalesOf(locales) {
		return X.supported(locales, arguments[1], hasList);
	});
	Object.defineProperty(ListFormat, 'prototype', { writable: false });

	/* ---- Intl.DurationFormat ---- */

	var DF_SLOTS = new WeakMap(), dfSlots = slotsOf(DF_SLOTS,
							'DurationFormat');
	/* the units in order: [name, styles, digital default, NumberFormat
	 * unit] */
	var UNITS = [
		['years', 0, 'short', 'year'], ['months', 0, 'short', 'month'],
		['weeks', 0, 'short', 'week'], ['days', 0, 'short', 'day'],
		['hours', 1, 'numeric', 'hour'], ['minutes', 1, 'numeric', 'minute'],
		['seconds', 1, 'numeric', 'second'],
		['milliseconds', 2, 'numeric', 'millisecond'],
		['microseconds', 2, 'numeric', 'microsecond'],
		['nanoseconds', 2, 'numeric', 'nanosecond']
	];
	var STYLES = [['long', 'short', 'narrow'],
		['long', 'short', 'narrow', 'numeric', '2-digit'],
		['long', 'short', 'narrow', 'numeric']];

	/* ECMA-402 GetDurationUnitOptions */
	function unitOptions(unit, o, base, styles, digitalBase, prev) {
		var style = getOption(o, unit, styles, undefined), display;
		var dflt = 'always', hms = unit === 'hours' || unit === 'minutes' ||
			unit === 'seconds';

		if (style === undefined) {
			if (base === 'digital') {
				if (!hms)
					dflt = 'auto';
				style = digitalBase;
			} else if (prev === 'fractional' || prev === 'numeric' ||
				   prev === '2-digit') {
				style = 'numeric';
				if (unit !== 'minutes' && unit !== 'seconds')
					dflt = 'auto';
			} else {
				dflt = 'auto';
				style = base;
			}
		}
		if (style === 'numeric' && (unit === 'milliseconds' ||
		    unit === 'microseconds' || unit === 'nanoseconds')) {
			style = 'fractional';
			dflt = 'auto';
		}
		display = getOption(o, unit + 'Display', ['auto', 'always'], dflt);
		if (display === 'always' && style === 'fractional')
			throw new RangeError('Invalid ' + unit + 'Display: always');
		if (prev === 'fractional' && style !== 'fractional')
			throw new RangeError('Invalid ' + unit + ' style: ' + style);
		if (prev === 'numeric' || prev === '2-digit') {
			if (style !== 'fractional' && style !== 'numeric' &&
			    style !== '2-digit')
				throw new RangeError('Invalid ' + unit + ' style: ' +
						     style);
			if (unit === 'minutes' || unit === 'seconds')
				style = '2-digit';
		}
		return { style: style, display: display };
	}

	function DurationFormat() {
		var s = {}, o, nu, loc, prev = '', i, u, r, fd;

		if (!new.target)
			throw new TypeError('Constructor Intl.DurationFormat requires ' +
					    '\'new\'');
		var req = C.localeList(arguments[0]);

		o = optionsObject(arguments[1]);
		getOption(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
		nu = getOption(o, 'numberingSystem', null, undefined);
		if (nu !== undefined && !/^[a-z\d]{3,8}(-[a-z\d]{3,8})*$/i.test(nu))
			throw new RangeError('Invalid numberingSystem : ' + nu);
		loc = X.resolveLocale(req, nu, true);
		s.locale = loc.locale;
		s.tag = loc.tag;
		s.nu = loc.nu;
		s.style = getOption(o, 'style', ['long', 'short', 'narrow',
			'digital'], 'short');
		s.units = {};
		for (i = 0; i < UNITS.length; i++) {
			u = UNITS[i];
			r = unitOptions(u[0], o, s.style, STYLES[u[1]], u[2], prev);
			s.units[u[0]] = r;
			if (i >= 4)
				prev = r.style;
		}
		fd = o.fractionalDigits;
		if (fd !== undefined) {
			fd = Number(fd);
			if (isNaN(fd) || fd < 0 || fd > 9)
				throw new RangeError('fractionalDigits value is out of ' +
						     'range.');
			fd = Math.floor(fd);
		}
		s.fd = fd;
		s.nfs = {};
		DF_SLOTS.set(this, s);
		return this;
	}

	/* ECMA-402 ToIntegerIfIntegral */
	function integral(v) {
		v = Number(v);
		if (!isFinite(v) || Math.floor(v) !== v)
			throw new RangeError('Invalid duration value: ' + v);
		return v === 0 ? 0 : v;
	}

	var FIELDS = ['days', 'hours', 'microseconds', 'milliseconds',
		'minutes', 'months', 'nanoseconds', 'seconds', 'weeks', 'years'];

	/* ECMA-402 ToDurationRecord, and IsValidDuration */
	function toDuration(input) {
		var d = {}, any = false, i, v, sign = 0, big, ns;

		if (input === null || (typeof input !== 'object' &&
		    typeof input !== 'function')) {
			if (typeof input === 'string')
				throw new RangeError('Invalid duration: ' + input);
			throw new TypeError('Duration must be an object');
		}
		for (i = 0; i < FIELDS.length; i++) {
			v = input[FIELDS[i]];
			d[FIELDS[i]] = 0;
			if (v !== undefined) {
				d[FIELDS[i]] = integral(v);
				any = true;
			}
		}
		if (!any)
			throw new TypeError('Invalid duration: no fields');
		for (i = 0; i < FIELDS.length; i++) {
			v = d[FIELDS[i]];
			if (v === 0)
				continue;
			if (sign && (v < 0) !== (sign < 0))
				throw new RangeError('Invalid duration: mixed signs');
			sign = v < 0 ? -1 : 1;
		}
		if (Math.abs(d.years) >= 4294967296 ||
		    Math.abs(d.months) >= 4294967296 ||
		    Math.abs(d.weeks) >= 4294967296)
			throw new RangeError('Invalid duration: out of range');
		big = typeof BigInt === 'function';
		if (big) {
			ns = BigInt(d.days) * 86400000000000n +
				BigInt(d.hours) * 3600000000000n +
				BigInt(d.minutes) * 60000000000n +
				BigInt(d.seconds) * 1000000000n +
				BigInt(d.milliseconds) * 1000000n +
				BigInt(d.microseconds) * 1000n + BigInt(d.nanoseconds);
			if (ns < 0n)
				ns = -ns;
			if (ns >= 9007199254740992000000000n)
				throw new RangeError('Invalid duration: out of range');
		}
		d.sign = sign;
		return d;
	}

	/* a NumberFormat for these options, kept on the DurationFormat */
	function nfFor(s, key, opts) {
		var nf = s.nfs[key];

		if (!nf) {
			opts.numberingSystem = s.nu;
			nf = s.nfs[key] = new Intl.NumberFormat(s.tag, opts);
		}
		return nf;
	}

	/* the value of a unit with the fractional units after it added, as
	 * an exact decimal string (ECMA-402 AddFractionalDigits): each
	 * fractional unit is a thousandth of the one before, and may be
	 * more than a thousand of them */
	function withFraction(s, d, unit, value) {
		var i, n = 0, digits = '0', whole, frac, at = -1;

		for (i = 0; i < UNITS.length; i++) {
			if (UNITS[i][0] === unit)
				at = i;
		}
		for (i = at + 1; i < UNITS.length; i++) {
			if (s.units[UNITS[i][0]].style !== 'fractional')
				break;
			digits = addDecimal(digits + '000',
					    String(Math.abs(d[UNITS[i][0]])));
			n++;
		}
		if (!n)
			return value;
		while (digits.length <= 3 * n)
			digits = '0' + digits;
		whole = digits.slice(0, digits.length - 3 * n);
		frac = digits.slice(-3 * n);
		whole = addDecimal(String(Math.abs(value)), whole);
		return (d.sign < 0 ? '-' : '') + whole + '.' + frac;
	}

	function addDecimal(a, b) {
		var out = '', c = 0, i = a.length - 1, j = b.length - 1, x;

		while (i >= 0 || j >= 0 || c) {
			x = (i >= 0 ? +a.charAt(i--) : 0) +
				(j >= 0 ? +b.charAt(j--) : 0) + c;
			out = (x % 10) + out;
			c = x >= 10 ? 1 : 0;
		}
		return out.replace(/^0+(?=\d)/, '');
	}

	function numberParts(nf, value, unit) {
		var parts = nf.formatToParts(value), out = [], i;

		for (i = 0; i < parts.length; i++)
			out.push({ type: parts[i].type, value: parts[i].value,
				unit: unit });
		return out;
	}

	function separator(s) {
		var e = X.entry('n', X.dataTag(s.tag)), S = e.S || {};

		return (S[s.nu] && S[s.nu].timeSeparator) ||
			(S.latn && S.latn.timeSeparator) || ':';
	}

	/* ECMA-402 FormatNumericHours, -Minutes and -Seconds */
	function numericPart(s, unit, value, sep, signShown) {
		var style = s.units[unit + 's'].style, out = [], o = {}, key;

		if (sep)
			out.push({ type: 'literal', value: separator(s) });
		if (style === '2-digit')
			o.minimumIntegerDigits = 2;
		if (!signShown)
			o.signDisplay = 'never';
		o.useGrouping = false;
		key = 'n' + unit + style + signShown;
		if (unit === 'second') {
			o.maximumFractionDigits = s.fd === undefined ? 9 : s.fd;
			o.minimumFractionDigits = s.fd === undefined ? 0 : s.fd;
			o.roundingMode = 'trunc';
		}
		return out.concat(numberParts(nfFor(s, key, o), value, unit));
	}

	/* ECMA-402 FormatNumericUnits */
	function numericUnits(s, d, first, signShown) {
		var out = [], h = d.hours, m = d.minutes, sec = d.seconds;
		var hShown = false, mShown = false, sShown;

		if (d.milliseconds || d.microseconds || d.nanoseconds)
			sec = withFraction(s, d, 'seconds', sec);
		if (first === 'hours' && (h !== 0 ||
		    s.units.hours.display === 'always'))
			hShown = true;
		sShown = Number(sec) !== 0 || s.units.seconds.display === 'always';
		if (first === 'hours' || first === 'minutes') {
			if (hShown && sShown)
				mShown = true;
			else if (m !== 0 || s.units.minutes.display === 'always')
				mShown = true;
		}
		if (hShown) {
			if (signShown && h === 0 && d.sign < 0)
				h = -0;
			out = out.concat(numericPart(s, 'hour', h, false, signShown));
			signShown = false;
		}
		if (mShown) {
			if (signShown && m === 0 && d.sign < 0)
				m = -0;
			out = out.concat(numericPart(s, 'minute', m, hShown,
						     signShown));
			signShown = false;
		}
		if (sShown) {
			if (signShown && Number(sec) === 0 && d.sign < 0)
				sec = typeof sec === 'string' ? sec : -0;
			out = out.concat(numericPart(s, 'second', sec, mShown,
						     signShown));
		}
		return out;
	}

	/* ECMA-402 PartitionDurationFormatPattern */
	function durationParts(s, d) {
		var result = [], signShown = true, i, u, style, display, value;
		var nextStyle, o, key, frac;

		for (i = 0; i < UNITS.length; i++) {
			u = UNITS[i];
			style = s.units[u[0]].style;
			display = s.units[u[0]].display;
			value = d[u[0]];
			if (style === 'numeric' || style === '2-digit') {
				result.push(numericUnits(s, d, u[0], signShown));
				break;
			}
			o = {};
			frac = false;
			if (u[0] === 'seconds' || u[0] === 'milliseconds' ||
			    u[0] === 'microseconds') {
				nextStyle = s.units[UNITS[i + 1][0]].style;
				if (nextStyle === 'fractional') {
					value = withFraction(s, d, u[0], value);
					o.maximumFractionDigits = s.fd === undefined ? 9 :
						s.fd;
					o.minimumFractionDigits = s.fd === undefined ? 0 :
						s.fd;
					o.roundingMode = 'trunc';
					frac = true;
				}
			}
			if (Number(value) !== 0 || display === 'always') {
				if (signShown) {
					signShown = false;
					if (Number(value) === 0 && d.sign < 0)
						value = typeof value === 'string' &&
							value.charAt(0) === '-' ? value : -0;
				} else {
					o.signDisplay = 'never';
				}
				o.style = 'unit';
				o.unit = u[3];
				o.unitDisplay = style;
				key = u[3] + style + (o.signDisplay || '') + frac;
				result.push(numberParts(nfFor(s, key, o), value, u[3]));
			}
			if (frac)
				break;
		}
		return listParts(s, result);
	}

	/* ECMA-402 ListFormatParts. The list is written in the
	 * DurationFormat's own locale, as ICU does, whether or not
	 * ListFormat offers it. */
	function listParts(s, partsList) {
		var lf = s.lf, strings = [], i, j, str, formatted, out = [], k = 0;

		if (!lf)
			lf = s.lf = lister(s.tag, 'unit', s.style === 'digital' ?
					   'short' : s.style);
		for (i = 0; i < partsList.length; i++) {
			str = '';
			for (j = 0; j < partsList[i].length; j++)
				str += partsList[i][j].value;
			strings.push(str);
		}
		formatted = partsFromList(lf, strings);
		for (i = 0; i < formatted.length; i++) {
			if (formatted[i].type === 'element') {
				for (j = 0; j < partsList[k].length; j++)
					out.push(partsList[k][j]);
				k++;
			} else {
				out.push(formatted[i]);
			}
		}
		return out;
	}

	var dfProto = DurationFormat.prototype;

	method(dfProto, 'format', function format(duration) {
		var s = dfSlots(this, 'format'), parts, out = '', i;

		parts = durationParts(s, toDuration(duration));
		for (i = 0; i < parts.length; i++)
			out += parts[i].value;
		return out;
	});
	method(dfProto, 'formatToParts', function formatToParts(duration) {
		var s = dfSlots(this, 'formatToParts'), parts, out = [], i, p;

		parts = durationParts(s, toDuration(duration));
		for (i = 0; i < parts.length; i++) {
			p = { type: parts[i].type, value: parts[i].value };
			if (parts[i].unit)
				p.unit = parts[i].unit;
			out.push(p);
		}
		return out;
	});
	method(dfProto, 'resolvedOptions', function resolvedOptions() {
		var s = dfSlots(this, 'resolvedOptions'), r = {
			locale: s.locale, numberingSystem: s.nu, style: s.style
		}, i, u, v;

		for (i = 0; i < UNITS.length; i++) {
			u = s.units[UNITS[i][0]];
			v = u.style === 'fractional' ? 'numeric' : u.style;
			r[UNITS[i][0]] = v;
			r[UNITS[i][0] + 'Display'] = u.display;
		}
		if (s.fd !== undefined)
			r.fractionalDigits = s.fd;
		return r;
	});
	Object.defineProperty(dfProto, Symbol.toStringTag, {
		configurable: true, value: 'Intl.DurationFormat'
	});
	method(DurationFormat, 'supportedLocalesOf',
	       function supportedLocalesOf(locales) {
		return X.supported(locales, arguments[1]);
	});
	Object.defineProperty(DurationFormat, 'prototype', { writable: false });

	Intl.ListFormat = ListFormat;
	Intl.DurationFormat = DurationFormat;
};

if (typeof window !== 'undefined' && window.__vitaIntl &&
    window.__vitaIntl.number && window.__vitaIntl.has &&
    window.__vitaIntl.has('l:und') && window.__vitaIntlCore)
	__vitaIntlList(window, window.__vitaIntlCore, window.__vitaIntl.number);

if (typeof module !== 'undefined')
	module.exports = __vitaIntlList;
