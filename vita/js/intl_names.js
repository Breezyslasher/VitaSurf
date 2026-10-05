/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl.RelativeTimeFormat and Intl.DisplayNames (VitaSurf).
 *
 * The prelude's RelativeTimeFormat knew English and had no
 * formatToParts, numeric: 'auto' or numberingSystem, and it had no
 * DisplayNames, so Home Assistant loaded FormatJS's for both, with
 * their locale data. These are ECMA-402's, for every locale ICU has,
 * with CLDR's data from resources/intl.pak (scripts/gen-intl-numbers.mjs)
 * read through vita/js/intl_number.js, whose NumberFormat and
 * PluralRules write the numbers. Where the spec leaves the words open
 * they are ICU's, and where ICU departs from the spec (it leaves
 * of('arab') and of('ca') uncased, so finds no name) the spec is
 * followed.
 *
 * Runs under Node too, to be held against ICU with the cases
 * scripts/gen-intl-names-tests.mjs makes: __vitaIntlNames(W, C, X)
 * builds the two constructors onto W.Intl from what
 * __vitaIntlNumber returned.
 */
var __vitaIntlNames = function (W, C, X) {
	'use strict';

	var Intl = W.Intl, getOption = X.getOption, method = X.method;

	function optionsObject(o) {
		if (o === undefined)
			return Object.create(null);
		if (o === null || (typeof o !== 'object' && typeof o !== 'function'))
			throw new TypeError('Options must be an object');
		return o;
	}

	function coerceOptions(o) {
		return o === undefined ? Object.create(null) : X.toObject(o);
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

	/* ---- Intl.RelativeTimeFormat ---- */

	var RTF_SLOTS = new WeakMap(), rtfSlots = slotsOf(RTF_SLOTS,
							 'RelativeTimeFormat');
	var UNITS = ['second', 'minute', 'hour', 'day', 'week', 'month',
		'quarter', 'year'];

	function RelativeTimeFormat() {
		var s = {}, o, nu, loc, nfo;

		if (!new.target)
			throw new TypeError('Constructor Intl.RelativeTimeFormat ' +
					    'requires \'new\'');
		var req = C.localeList(arguments[0]);

		o = coerceOptions(arguments[1]);
		getOption(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
		nu = getOption(o, 'numberingSystem', null, undefined);
		if (nu !== undefined && !/^[a-z\d]{3,8}(-[a-z\d]{3,8})*$/i.test(nu))
			throw new RangeError('Invalid numberingSystem : ' + nu);
		loc = X.resolveLocale(req, nu, true);
		s.locale = loc.locale;
		s.tag = loc.tag;
		s.nu = loc.nu;
		s.style = getOption(o, 'style', ['long', 'short', 'narrow'], 'long');
		s.numeric = getOption(o, 'numeric', ['always', 'auto'], 'always');
		nfo = { numberingSystem: s.nu };
		s.nf = new Intl.NumberFormat(s.tag, nfo);
		/* the plural goes by the locale's own rules, root's (all
		 * "other") where ICU has none, as ICU's formatter takes them;
		 * PluralRules would take the default locale's */
		s.rules = X.rulesFor(s.tag, 'c');
		s.plain = new Intl.NumberFormat(s.tag, { numberingSystem: 'latn',
			useGrouping: false });
		s.data = X.entry('r', X.dataTag(s.tag));
		RTF_SLOTS.set(this, s);
		return this;
	}

	/* a unit's words in a width, the narrower falling back to the wider,
	 * as in ICU */
	function fieldOf(data, field, style) {
		var w = style === 'narrow' ? ['narrow', 'short', 'long'] :
			style === 'short' ? ['short', 'long'] : ['long'], i, e;

		for (i = 0; i < w.length; i++) {
			e = data[field + '-' + w[i]];
			if (e)
				return e;
		}
		return null;
	}

	function rtfParts(s, value, unit) {
		var u, field, tl, parts, pattern, out = [], at, i, num, rel;

		value = Number(value);
		unit = String(unit);
		if (!isFinite(value))
			throw new RangeError('Invalid value: ' + value +
					     ' for Intl.RelativeTimeFormat');
		u = unit.replace(/s$/, '');
		if (UNITS.indexOf(u) < 0 || u + 's' !== unit && u !== unit)
			throw new RangeError('Invalid unit argument for ' +
					     'Intl.RelativeTimeFormat \'' + unit + '\'');
		field = fieldOf(s.data, u, s.style) || {};
		/* ICU has words for -2 to 2 only (UDateDirection), though
		 * CLDR has Scottish Gaelic's 3 */
		if (s.numeric === 'auto' && field.r && /^-?[0-2]$/.test(String(value))) {
			rel = field.r[String(value)];
			if (rel !== undefined)
				return [{ type: 'literal', value: rel }];
		}
		tl = value < 0 || (value === 0 && 1 / value < 0) ? 'p' : 'f';
		if (value < 0 || (value === 0 && 1 / value < 0))
			value = -value;
		parts = s.nf.formatToParts(value);
		num = '';
		for (i = 0; i < parts.length; i++)
			num += parts[i].value;
		var forms = field[tl] || {}, int = '', frac = '', p;

		p = s.plain.formatToParts(value);
		for (i = 0; i < p.length; i++) {
			if (p[i].type === 'integer')
				int += p[i].value;
			else if (p[i].type === 'fraction')
				frac += p[i].value;
		}
		pattern = forms[X.category(s.rules, X.operands(int, frac, 0))] ||
			forms.other || '{0}';
		at = pattern.indexOf('{0}');
		if (at < 0)
			return [{ type: 'literal', value: pattern }];
		if (at > 0)
			out.push({ type: 'literal', value: pattern.slice(0, at) });
		for (i = 0; i < parts.length; i++)
			out.push({ type: parts[i].type, value: parts[i].value,
				unit: u });
		if (at + 3 < pattern.length)
			out.push({ type: 'literal', value: pattern.slice(at + 3) });
		return out;
	}

	var rtfProto = RelativeTimeFormat.prototype;

	method(rtfProto, 'format', function format(value, unit) {
		var p = rtfParts(rtfSlots(this, 'format'), value, unit), str = '', i;

		for (i = 0; i < p.length; i++)
			str += p[i].value;
		return str;
	});
	method(rtfProto, 'formatToParts', function formatToParts(value, unit) {
		return rtfParts(rtfSlots(this, 'formatToParts'), value, unit);
	});
	method(rtfProto, 'resolvedOptions', function resolvedOptions() {
		var s = rtfSlots(this, 'resolvedOptions');

		return { locale: s.locale, style: s.style, numeric: s.numeric,
			numberingSystem: s.nu };
	});
	Object.defineProperty(rtfProto, Symbol.toStringTag, {
		configurable: true, value: 'Intl.RelativeTimeFormat'
	});
	method(RelativeTimeFormat, 'supportedLocalesOf',
	       function supportedLocalesOf(locales) {
		return X.supported(locales, arguments[1]);
	});
	Object.defineProperty(RelativeTimeFormat, 'prototype',
			      { writable: false });

	/* ---- Intl.DisplayNames ---- */

	var DN_SLOTS = new WeakMap(), dnSlots = slotsOf(DN_SLOTS, 'DisplayNames');
	var TYPES = ['language', 'region', 'script', 'currency', 'calendar',
		'dateTimeField'];
	var FIELD_NAMES = {
		era: 'era', year: 'year', quarter: 'quarter', month: 'month',
		weekOfYear: 'week', weekday: 'weekday', day: 'day',
		dayPeriod: 'dayperiod', hour: 'hour', minute: 'minute',
		second: 'second', timeZoneName: 'zone'
	};
	/* the BCP 47 calendar names CLDR names otherwise */
	var CALENDARS = {
		gregory: 'gregorian', ethioaa: 'ethiopic-amete-alem'
	};
	/* the region codes ICU's locales replace (uloc.cpp's
	 * DEPRECATED_COUNTRIES), which it names as their replacements */
	var OLD_REGIONS = {
		AN: 'CW', BU: 'MM', CS: 'RS', DD: 'DE', DY: 'BJ', FX: 'FR',
		HV: 'BF', NH: 'VU', RH: 'ZW', SU: 'RU', TP: 'TL', UK: 'GB',
		VD: 'VN', YD: 'YE', YU: 'RS', ZR: 'CD'
	};

	function DisplayNames() {
		var s = {}, o, loc;

		if (!new.target)
			throw new TypeError('Constructor Intl.DisplayNames requires ' +
					    '\'new\'');
		var req = C.localeList(arguments[0]);

		o = optionsObject(arguments[1]);
		getOption(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
		loc = X.resolveLocale(req, undefined, false);
		s.locale = loc.locale;
		s.tag = loc.tag;
		s.style = getOption(o, 'style', ['narrow', 'short', 'long'], 'long');
		s.type = getOption(o, 'type', TYPES, undefined);
		if (s.type === undefined)
			throw new TypeError('Intl.DisplayNames needs a type');
		s.fallback = getOption(o, 'fallback', ['code', 'none'], 'code');
		s.languageDisplay = getOption(o, 'languageDisplay',
					      ['dialect', 'standard'], 'dialect');
		DN_SLOTS.set(this, s);
		return this;
	}

	/* unicode_language_id, as BCP 47 writes it */
	var LANGUAGE_ID = /^([a-z]{2,3}|[a-z]{5,8})(-[a-z]{4})?(-([a-z]{2}|\d{3}))?((-([a-z\d]{5,8}|\d[a-z\d]{3}))*)$/i;

	function canonicalCode(type, code) {
		var m;

		switch (type) {
		case 'language':
			m = LANGUAGE_ID.exec(code);
			if (!m)
				throw new RangeError('invalid_argument');
			var v = m[5] ? m[5].slice(1).toLowerCase().split('-') : [], i;

			for (i = 0; i < v.length; i++) {
				if (v.indexOf(v[i]) !== i)
					throw new RangeError('invalid_argument');
			}
			/* the canonical form has POSIX as a keyword, which ICU
			 * names as the variant it was */
			return C.canonicalTag(code).replace(/-u-va-posix$/,
							    '-posix');
		case 'region':
			if (!/^([a-z]{2}|\d{3})$/i.test(code))
				throw new RangeError('invalid_argument');
			return code.toUpperCase();
		case 'script':
			if (!/^[a-z]{4}$/i.test(code))
				throw new RangeError('invalid_argument');
			return code.charAt(0).toUpperCase() +
				code.slice(1).toLowerCase();
		case 'currency':
			if (!/^[a-z]{3}$/i.test(code))
				throw new RangeError('invalid_argument');
			return code.toUpperCase();
		case 'calendar':
			if (!/^[a-z\d]{3,8}(-[a-z\d]{3,8})*$/i.test(code))
				throw new RangeError('invalid_argument');
			return code.toLowerCase();
		}
		if (!Object.prototype.hasOwnProperty.call(FIELD_NAMES, code))
			throw new RangeError('invalid_argument');
		return code;
	}

	function own(o, k) {
		return o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] :
			undefined;
	}

	function scriptName(d, code, style) {
		var n = style !== 'long' ? own(d.Ss, code) : undefined;

		return n !== undefined ? n : own(d.S, code);
	}

	function regionName(d, code, style) {
		var n = style !== 'long' ? own(d.Ts, code) : undefined;

		return n !== undefined ? n : own(d.T, code);
	}

	function languageEntry(d, code, style) {
		var n = style !== 'long' ? own(d.Ls, code) : undefined;

		return n !== undefined ? n : own(d.L, code);
	}

	/*
	 * ICU's LocaleDisplayNames: when dialects are wanted, the name of the
	 * whole of language-script-region if it has one, else of
	 * language-script or language-region when there is no third part
	 * (American English, but Chinese (Traditional, Taiwan)); else the
	 * language's name, and the rest in brackets, "English (United
	 * States)", with brackets in a part's own name made square.
	 */
	function languageName(s, d, code) {
		var p = code.split('-'), lang = p[0], script = null, region = null;
		var variants = [], i = 1, name, rest = [], n;

		if (i < p.length && /^[A-Z][a-z]{3}$/.test(p[i]))
			script = p[i++];
		if (i < p.length && /^([A-Z]{2}|\d{3})$/.test(p[i]))
			region = p[i++];
		for (; i < p.length; i++)
			variants.push(p[i]);
		/* und is ICU's root, which has no name but its own */
		if (lang === 'und')
			lang = 'root';
		if (s.languageDisplay === 'dialect') {
			if (script && region) {
				name = languageEntry(d, lang + '-' + script + '-' + region,
						     s.style);
				if (name !== undefined)
					script = region = null;
			} else if (script) {
				name = languageEntry(d, lang + '-' + script, s.style);
				if (name !== undefined)
					script = null;
			} else if (region) {
				name = languageEntry(d, lang + '-' + region, s.style);
				if (name !== undefined)
					region = null;
			}
		}
		if (name === undefined)
			name = languageEntry(d, lang, s.style);
		/* with no fallback, a part without a name is no name at all */
		var none = s.fallback === 'none', missing = false;

		if (name === undefined) {
			if (none)
				return undefined;
			name = lang;
		}
		var pattern = d.p[0] || '{0} ({1})', sep = d.p[1] || '{0}, {1}';
		var wide = pattern.indexOf('\uff08') >= 0;

		function bracket(x) {
			return wide ? x.replace(/\uff08/g, '\uff3b')
				.replace(/\uff09/g, '\uff3d') :
				x.replace(/\(/g, '[').replace(/\)/g, ']');
		}
		if (script) {
			n = scriptName(d, script, s.style);
			missing = missing || n === undefined;
			rest.push(bracket(n !== undefined ? n : script));
		}
		if (region) {
			n = regionName(d, region, s.style);
			missing = missing || n === undefined;
			rest.push(bracket(n !== undefined ? n : region));
		}
		/* ICU names the variants as one, so two or more have no
		 * name and show as their code */
		if (variants.length) {
			variants = variants.join('_').toUpperCase();
			n = own(d.V, variants);
			missing = missing || n === undefined;
			rest.push(bracket(n !== undefined ? n : variants));
		}
		if (none && missing)
			return undefined;
		if (!rest.length)
			return name;
		var joined = rest[0];

		for (i = 1; i < rest.length; i++)
			joined = sep.replace('{0}', joined).replace('{1}', rest[i]);
		return pattern.replace('{0}', name).replace('{1}', joined);
	}

	function nameOf(s, code) {
		var d, n, f, i, w;

		switch (s.type) {
		case 'language':
			return languageName(s, X.entry('d', X.dataTag(s.tag)), code);
		case 'region':
			/* ICU finds a replaced code's name under its
			 * replacement, but not its short name */
			n = own(OLD_REGIONS, code);
			return regionName(X.entry('d', X.dataTag(s.tag)), n || code,
					  n ? 'long' : s.style);
		case 'script':
			return scriptName(X.entry('d', X.dataTag(s.tag)), code, s.style);
		case 'calendar':
			d = X.entry('d', X.dataTag(s.tag));
			return own(d.K, own(CALENDARS, code) || code);
		case 'currency':
			n = own(X.entry('c', X.dataTag(s.tag)), code);
			return typeof n === 'string' ? n : n ? n[0] : undefined;
		}
		d = X.entry('r', X.dataTag(s.tag));
		w = s.style === 'narrow' ? ['narrow', 'short', 'long'] :
			s.style === 'short' ? ['short', 'long'] : ['long'];
		for (i = 0; i < w.length; i++) {
			f = own(d, FIELD_NAMES[code] + '-' + w[i]);
			if (f && f.n !== undefined)
				return f.n;
		}
		return undefined;
	}

	var dnProto = DisplayNames.prototype;

	method(dnProto, 'of', function of(code) {
		var s = dnSlots(this, 'of'), n;

		code = canonicalCode(s.type, String(code));
		n = nameOf(s, code);
		if (n === undefined && s.fallback === 'code')
			return code;
		return n;
	});
	method(dnProto, 'resolvedOptions', function resolvedOptions() {
		var s = dnSlots(this, 'resolvedOptions'), r = {
			locale: s.locale, style: s.style, type: s.type,
			fallback: s.fallback
		};

		if (s.type === 'language')
			r.languageDisplay = s.languageDisplay;
		return r;
	});
	Object.defineProperty(dnProto, Symbol.toStringTag, {
		configurable: true, value: 'Intl.DisplayNames'
	});
	method(DisplayNames, 'supportedLocalesOf',
	       function supportedLocalesOf(locales) {
		return X.supported(locales, arguments[1]);
	});
	Object.defineProperty(DisplayNames, 'prototype', { writable: false });

	Intl.RelativeTimeFormat = RelativeTimeFormat;
	Intl.DisplayNames = DisplayNames;
};

if (typeof window !== 'undefined' && window.__vitaIntl &&
    window.__vitaIntl.number && window.__vitaIntlCore)
	__vitaIntlNames(window, window.__vitaIntlCore, window.__vitaIntl.number);

if (typeof module !== 'undefined')
	module.exports = __vitaIntlNames;
