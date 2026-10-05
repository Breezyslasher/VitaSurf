/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl.DateTimeFormat (VitaSurf), for every locale ICU has.
 *
 * V8's DateTimeFormat, step by step from its js-date-time-format.cc: the
 * options read as ECMA-402 reads them, the hour cycle chosen as V8
 * chooses it, the pattern from ICU's DateTimePatternGenerator or the
 * locale's date and time styles, and the time written as ICU's
 * SimpleDateFormat writes it, with ICU's names and numbering systems.
 * The generator, the names and the resource lookups behind them are
 * vita/js/intl_pattern.js, over ICU's own locale data in
 * resources/intl.pak; time zones, their offsets and names are
 * vita/js/intl_zone.js's, calendars other than the Gregorian one
 * vita/js/intl_calendar.js's, and formatRange vita/js/intl_range.js's.
 * Where V8 and ICU write something, so does this, ICU's failures and
 * all, except where V8 itself fails.
 *
 * Runs under Node too, to be held against V8: __vitaIntlDate(W, N, C, X,
 * P, Z, K, R) builds DateTimeFormat onto W.Intl from the pack reader (N),
 * vita/js/intl_core.js (C), what __vitaIntlNumber returned (X), the
 * pattern, zone and calendar modules, and the range module's factory.
 */
var __vitaIntlDate = function (W, N, C, X, P, Z, K, R) {
	'use strict';

	var Intl = W.Intl, getOption = X.getOption, method = X.method;
	var own = function (o, k) {
		return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
	};

	/* ---- calendars ---- */

	var CALENDARS = ['buddhist', 'chinese', 'coptic', 'dangi', 'ethioaa',
		'ethiopic', 'gregory', 'hebrew', 'indian', 'islamic',
		'islamic-civil', 'islamic-rgsa', 'islamic-tbla', 'islamic-umalqura',
		'iso8601', 'japanese', 'persian', 'roc'];
	var TO_ICU = { gregory: 'gregorian', ethioaa: 'ethiopic-amete-alem' };
	var TO_BCP = { gregorian: 'gregory', 'ethiopic-amete-alem': 'ethioaa' };

	function icuCalendar(bcp) {
		return TO_ICU[bcp] || bcp;
	}

	function bcpCalendar(icu) {
		return TO_BCP[icu] || icu;
	}

	/* days from 1970-01-01 to a proleptic Gregorian date */
	function daysFromCivil(y, m, d) {
		y -= m <= 2 ? 1 : 0;
		var era = Math.floor(y / 400), yoe = y - era * 400;
		var doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
		var doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) +
			doy;

		return era * 146097 + doe - 719468;
	}

	function civilFromDays(z) {
		z += 719468;
		var era = Math.floor(z / 146097), doe = z - era * 146097;
		var yoe = Math.floor((doe - Math.floor(doe / 1460) +
			Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
		var y = yoe + era * 400, doy = doe - (365 * yoe + Math.floor(yoe / 4) -
			Math.floor(yoe / 100)), mp = Math.floor((5 * doy + 2) / 153);
		var d = doy - Math.floor((153 * mp + 2) / 5) + 1;
		var m = mp + (mp < 10 ? 3 : -9);

		return [y + (m <= 2 ? 1 : 0), m, d];
	}

	/*
	 * A moment's calendar fields, as ICU's Calendar has them: era, year
	 * (of the era), extended year, month (0 first), leap month, day of
	 * the month, related Gregorian year. V8 makes the Gregorian calendar
	 * proleptic; the others are vita/js/intl_calendar.js's.
	 */
	function dateFields(type, days, utc, week) {
		if (type !== 'gregorian' && type !== 'iso8601')
			return K.fields(type, days, utc, week);
		var c = civilFromDays(days);

		return { era: c[0] > 0 ? 1 : 0, year: c[0] > 0 ? c[0] : 1 - c[0],
			ext: c[0], month: c[1] - 1, leap: 0, day: c[2], related: c[0],
			dayOfYear: days - daysFromCivil(c[0], 1, 1) + 1 };
	}

	/* ---- locales ---- */

	/* the ICU locale ID of a tag: its language, script, region and
	 * variants as ICU writes them */
	function icuId(tag) {
		var p = tag.split('-'), out = [p[0].toLowerCase()], i = 1;

		if (p[i] && p[i].length === 4 && /^[a-z]/i.test(p[i]))
			out.push(p[i].charAt(0).toUpperCase() +
				 p[i++].slice(1).toLowerCase());
		if (p[i] && /^([a-z]{2}|\d{3})$/i.test(p[i]))
			out.push(p[i++].toUpperCase());
		for (; i < p.length; i++)
			out.push(p[i].toUpperCase());
		return out[0] === 'und' && out.length === 1 ? 'root' :
			out.join('_');
	}

	/* ECMA-402 ResolveLocale over ca, nu and hc: the locale, and the
	 * keywords it keeps */
	function resolve(requested) {
		var i, found = null, kw = {};

		for (i = 0; i < requested.length && !found; i++) {
			var s = C.splitTag(requested[i]);

			found = C.lookup(s.base, X.hasLocale);
			if (found)
				kw = s.kw;
		}
		if (!found) {
			found = C.lookup((W.navigator && W.navigator.language) ||
					 'en-US', X.hasLocale) || 'en-US';
			kw = {};
		}
		var ext = {};

		if (kw.ca !== undefined && CALENDARS.indexOf(kw.ca) >= 0)
			ext.ca = kw.ca;
		if (kw.nu !== undefined && own(X.index().ns, kw.nu))
			ext.nu = kw.nu;
		if (kw.hc !== undefined && HC_CHAR[kw.hc])
			ext.hc = kw.hc;
		return { locale: found, ext: ext };
	}

	function localeString(base, ext) {
		var s = '';

		if (ext.ca)
			s += '-ca-' + ext.ca;
		if (ext.hc)
			s += '-hc-' + ext.hc;
		if (ext.nu)
			s += '-nu-' + ext.nu;
		return s ? base + '-u' + s : base;
	}

	/* the language and region ICU takes a locale's preferences by: its
	 * own, or its likely ones where it has none */
	var LIKELY = {};

	function langRegion(tag) {
		if (LIKELY[tag])
			return LIKELY[tag];
		var p = icuId(tag).split('_'), lang = p[0], region = null, i;

		for (i = 1; i < p.length; i++) {
			if (/^([A-Z]{2}|\d{3})$/.test(p[i]))
				region = p[i];
		}
		if (!region || !lang) {
			var m = X.likely ? X.likely(tag) : null;

			if (m) {
				lang = m.lang;
				region = m.region;
			}
		}
		return (LIKELY[tag] = { lang: lang, region: region || '001' });
	}

	/* Calendar::getCalendarTypeForLocale: the keyword's, else the first
	 * the region prefers */
	var INFO = null;

	function calendarOf(tag, ca) {
		if (ca)
			return icuCalendar(ca);
		if (!INFO)
			INFO = JSON.parse(N.pak('locinfo'));
		var prefs = own(INFO.cal, langRegion(tag).region) ||
			INFO.cal['001'];

		return icuCalendar(prefs[0]);
	}

	/* the calendar's week: its first day (1 for Sunday) and the days
	 * the first week needs, by the locale's region */
	function weekData(tag) {
		if (!INFO)
			INFO = JSON.parse(N.pak('locinfo'));
		var r = langRegion(tag).region;
		var first = own(INFO.first, r), min = own(INFO.min, r);

		return { first: (first === undefined ? INFO.first['001'] : first) %
			7 + 1, min: min === undefined ? INFO.min['001'] : min };
	}

	var HC_CHAR = { h11: 'K', h12: 'h', h23: 'H', h24: 'k' };
	var CHAR_HC = { K: 'h11', h: 'h12', H: 'h23', k: 'h24' };
	var HOURS = null;

	/* getAllowedHourFormats: the hour symbol a locale prefers */
	function hourChar(tag, hc) {
		if (hc)
			return HC_CHAR[hc];
		if (!HOURS)
			HOURS = JSON.parse(N.pak('dt:hours'));
		var lr = langRegion(tag);
		var v = own(HOURS, lr.lang + '_' + lr.region) ||
			own(HOURS, lr.region);

		return v && HC_CHAR[CHAR_HC[v]] ? v : 'H';
	}

	/* the numbering system and its symbols */
	function numbering(tag, nu) {
		var data = X.entry('n', X.dataTag(tag));

		nu = nu || data.nu;
		var sym = (data.S && (data.S[nu] || data.S.latn)) || {};

		return { nu: nu, digits: Array.from(X.index().ns[nu] ||
			'0123456789'), decimal: sym.decimal || '.',
			minus: sym.minusSign || '-' };
	}

	/* ---- the pattern ---- */

	var GENERATORS = {};

	/* the DateTimePatternGenerator for an ICU locale */
	function generator(loc, noStd) {
		var key = loc.name + '/' + loc.cal + '/' + loc.calType + '/' +
			loc.hour + '/' + loc.decimal + (noStd ? '/n' : '');

		if (!GENERATORS[key]) {
			if (Object.keys(GENERATORS).length >= 8)
				GENERATORS = {};
			GENERATORS[key] = new P.Generator(loc, noStd);
		}
		return GENERATORS[key];
	}

	/* ReplaceHourCycleInPattern */
	function replaceHourCycle(pattern, hc) {
		if (!hc)
			return pattern;
		var to = HC_CHAR[hc], out = '', replace = true, last = '', i;

		for (i = 0; i < pattern.length; i++) {
			var c = pattern.charAt(i);

			if (c === "'") {
				replace = !replace;
				out += c;
			} else if (c === 'H' || c === 'h' || c === 'K' || c === 'k') {
				if (replace && last === 'd')
					out += ' ';
				out += replace ? to : c;
			} else {
				out += c;
			}
			last = c;
		}
		return out;
	}

	function hourCycleOfPattern(pattern) {
		var q = false, i;

		for (i = 0; i < pattern.length; i++) {
			var c = pattern.charAt(i);

			if (c === "'")
				q = !q;
			else if (!q && CHAR_HC[c])
				return CHAR_HC[c];
		}
		return null;
	}

	/* ReplaceSkeleton: the day period dropped, the hour made hc's */
	function replaceSkeleton(skel, hc) {
		return skel.replace(/[abB]/g, '').replace(/[hHKk]/g, HC_CHAR[hc]);
	}

	var TIME_SKELETONS = ['jmmsszzzz', 'jmmssz', 'jmmss', 'jmm'];
	var STYLES = ['full', 'long', 'medium', 'short'];

	function first(p) {
		return Array.isArray(p) ? p[0] : p;
	}

	/*
	 * Whether SimpleDateFormat::construct makes its time style with the
	 * generator: where the locale names an hour cycle, or the bundle
	 * found for it differs from it in language, or lacks its region.
	 */
	function timeFromGenerator(loc) {
		if (loc.hcKeyword)
			return true;
		var valid = P.opened(loc.name);

		if (valid === loc.name)
			return false;
		var a = loc.name.split('_'), b = valid.split('_');
		var region = function (p) {
			for (var i = 1; i < p.length; i++) {
				if (/^([A-Z]{2}|\d{3})$/.test(p[i]))
					return p[i];
			}
			return '';
		};
		var r = region(a);

		return (r !== '' && r !== region(b)) || a[0] !== b[0];
	}

	/*
	 * ICU's DateFormat::createDateTimeInstance, as SimpleDateFormat's
	 * construct builds it: the calendar's style patterns, a time one
	 * from the generator where timeFromGenerator says, joined by the
	 * date style's glue; and the number overrides that go with them.
	 */
	function stylePattern(loc, ds, ts) {
		var dtp = P.get(loc.name, ['calendar', loc.calType,
					   'DateTimePatterns']);

		if (!dtp)
			dtp = P.get(loc.name, ['calendar', 'gregorian',
					       'DateTimePatterns']);
		var r = { pattern: '', dateOverride: null, timeOverride: null };
		var timePattern = '';

		if (ts !== undefined && timeFromGenerator(loc))
			timePattern = generator(loc, true).bestPattern(
				TIME_SKELETONS[ts], 0);
		if (ds !== undefined && ts !== undefined) {
			var tp = timePattern, t = dtp[ts], d = dtp[4 + ds];

			if (!tp) {
				tp = first(t);
				if (Array.isArray(t))
					r.timeOverride = t[1];
			}
			if (Array.isArray(d))
				r.dateOverride = d[1];
			var at = loc.calType !== 'gregorian' ?
				P.get(loc.name, ['calendar', loc.calType,
						 'DateTimePatterns%atTime']) : null;

			if (!at)
				at = P.get(loc.name, ['calendar', 'gregorian',
						      'DateTimePatterns%atTime']);
			var glue = at && at.length >= 4 ? first(at[ds]) :
				first(dtp[dtp.length >= 13 ? 9 + ds : 8]);

			r.pattern = P.simpleFormat(glue, [tp, first(d)]);
		} else if (ts !== undefined) {
			r.pattern = timePattern || first(dtp[ts]);
			if (!timePattern && Array.isArray(dtp[ts]))
				r.dateOverride = dtp[ts][1];
		} else {
			r.pattern = first(dtp[4 + ds]);
			if (Array.isArray(dtp[4 + ds]))
				r.dateOverride = dtp[4 + ds][1];
		}
		return r;
	}

	/* ---- options ---- */

	/* Table 7: the components, the skeleton letters V8 asks for */
	var COMPONENTS = [
		['weekday', ['narrow', 'long', 'short'], { narrow: 'EEEEE',
			long: 'EEEE', short: 'EEE' }],
		['era', ['narrow', 'long', 'short'], { narrow: 'GGGGG',
			long: 'GGGG', short: 'GGG' }],
		['year', ['2-digit', 'numeric'], { '2-digit': 'yy', numeric: 'y' }],
		['month', ['narrow', 'long', 'short', '2-digit', 'numeric'],
			{ narrow: 'MMMMM', long: 'MMMM', short: 'MMM',
			  '2-digit': 'MM', numeric: 'M' }],
		['day', ['2-digit', 'numeric'], { '2-digit': 'dd', numeric: 'd' }],
		['dayPeriod', ['narrow', 'long', 'short'], { narrow: 'BBBBB',
			long: 'BBBB', short: 'B' }],
		['hour', ['2-digit', 'numeric'], null],
		['minute', ['2-digit', 'numeric'], { '2-digit': 'mm', numeric: 'm' }],
		['second', ['2-digit', 'numeric'], { '2-digit': 'ss', numeric: 's' }],
		['timeZoneName', ['long', 'short', 'longOffset', 'shortOffset',
			'longGeneric', 'shortGeneric'], { long: 'zzzz', short: 'z',
			longOffset: 'OOOO', shortOffset: 'O', longGeneric: 'vvvv',
			shortGeneric: 'v' }]
	];

	function toObject(o) {
		if (o === undefined)
			return Object.create(null);
		return Object(o);
	}

	var SLOTS = new WeakMap();

	function slots(dtf, name) {
		var s = SLOTS.get(dtf);

		if (!s)
			throw new TypeError('Method Intl.DateTimeFormat.prototype.' +
					    name + ' called on incompatible receiver');
		return s;
	}

	/*
	 * CreateDateTimeFormat. required and defaults are 'any'/'date'/'time'
	 * and 'date'/'time'/'all', as Date's toLocale*String pass them.
	 */
	function create(dtf, locales, options, required, defaults) {
		var req = C.localeList(locales), o = toObject(options), s = {};
		var i;

		required = required || 'any';
		defaults = defaults || 'date';
		getOption(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
		var cal = o.calendar;

		if (cal !== undefined) {
			cal = String(cal);
			if (!/^[a-z\d]{3,8}(-[a-z\d]{3,8})*$/i.test(cal))
				throw new RangeError('Invalid calendar : ' + cal);
			cal = cal.toLowerCase();
			if (cal === 'islamicc')
				cal = 'islamic-civil';
			else if (cal === 'ethiopic-amete-alem')
				cal = 'ethioaa';
		}
		var nu = o.numberingSystem;

		if (nu !== undefined) {
			nu = String(nu);
			if (!/^[a-z\d]{3,8}(-[a-z\d]{3,8})*$/i.test(nu))
				throw new RangeError('Invalid numberingSystem : ' + nu);
			nu = nu.toLowerCase();
		}
		var hour12 = o.hour12;

		if (hour12 !== undefined)
			hour12 = Boolean(hour12);
		var hourCycle = getOption(o, 'hourCycle',
					  ['h11', 'h12', 'h23', 'h24'], undefined);

		if (hour12 !== undefined)
			hourCycle = undefined;

		var r = resolve(req), ext = r.ext, icuExt = {};

		if (cal !== undefined && ext.ca !== undefined && ext.ca !== cal)
			delete ext.ca;
		if (nu !== undefined && ext.nu !== undefined && ext.nu !== nu)
			delete ext.nu;
		var resolvedExt = { ca: ext.ca, nu: ext.nu, hc: ext.hc };

		icuExt.ca = cal !== undefined && CALENDARS.indexOf(cal) >= 0 ?
			cal : ext.ca;
		icuExt.nu = nu !== undefined && own(X.index().ns, nu) ? nu :
			ext.nu;
		icuExt.hc = ext.hc;

		/* what ICU is given: the locale, its calendar, hour symbol and
		 * numbering system */
		var tag = r.locale, name = P.opened(icuId(tag));
		var num = numbering(tag, icuExt.nu);
		var loc = {
			name: icuId(tag),
			cal: icuExt.ca ? icuCalendar(icuExt.ca) :
				P.defaultCalendar(icuId(tag)),
			calType: calendarOf(tag, icuExt.ca),
			hour: hourChar(tag, icuExt.hc),
			decimal: num.decimal,
			hcKeyword: !!icuExt.hc
		};
		var gen = generator(loc);
		var hcDefault = gen.hourCycle(), hc = null;

		if (hourCycle === undefined && hour12 === undefined)
			hc = icuExt.hc || null;
		else if (hourCycle !== undefined)
			hc = hourCycle;
		if (hour12 !== undefined) {
			if (hour12)
				hc = hcDefault === 'h11' || hcDefault === 'h12' ?
					hcDefault : /_JP(_|$)/.test(loc.name) ? 'h11' :
					'h12';
			else
				hc = hcDefault === 'h23' || hcDefault === 'h24' ?
					hcDefault : 'h23';
		} else if (!hc) {
			hc = hcDefault;
		}

		var tz = o.timeZone;

		s.zone = tz === undefined ? defaultZone() : resolveZone(tz);

		/* the components, and the skeleton they make */
		var skeleton = '', explicit = {}, hasHour = false;

		for (i = 0; i < COMPONENTS.length; i++) {
			var c = COMPONENTS[i];

			if (c[0] === 'timeZoneName') {
				var fsd = o.fractionalSecondDigits;

				if (fsd !== undefined) {
					fsd = Number(fsd);
					if (isNaN(fsd) || fsd < 1 || fsd > 3)
						throw new RangeError('fractionalSecondDigits ' +
								     'value is out of range.');
					fsd = Math.floor(fsd);
					explicit.fractionalSecondDigits = fsd;
					skeleton += 'SSS'.slice(0, fsd);
				}
			}
			var v = getOption(o, c[0], c[1], undefined);

			if (v === undefined)
				continue;
			explicit[c[0]] = v;
			if (c[0] === 'hour') {
				hasHour = true;
				skeleton += v === '2-digit' ? HC_CHAR[hc] + HC_CHAR[hc] :
					HC_CHAR[hc];
			} else {
				skeleton += c[2][v];
			}
		}
		getOption(o, 'formatMatcher', ['basic', 'best fit'], 'best fit');
		var ds = getOption(o, 'dateStyle', STYLES, undefined);
		var ts = getOption(o, 'timeStyle', STYLES, undefined);
		var dtfHc = ts !== undefined ? hc : null, pat;

		if (ds !== undefined || ts !== undefined) {
			if (Object.keys(explicit).length)
				throw new TypeError('Invalid option : option');
			if (required === 'date' && ts !== undefined)
				throw new TypeError('Invalid option : timeStyle');
			if (required === 'time' && ds !== undefined)
				throw new TypeError('Invalid option : dateStyle');
			var di = ds === undefined ? undefined : STYLES.indexOf(ds);
			var ti = ts === undefined ? undefined : STYLES.indexOf(ts);

			pat = stylePattern(loc, di, ti);
			if (ti !== undefined && dtfHc !== hourCycleOfPattern(pat.pattern)) {
				pat = { pattern: replaceHourCycle(gen.bestPattern(
					replaceSkeleton(P.staticSkeleton(pat.pattern), dtfHc),
					P.MATCH_HOUR_FIELD_LENGTH), dtfHc) };
			}
			s.dateStyle = ds;
			s.timeStyle = ts;
		} else {
			var need = true;

			if (required !== 'time' && (explicit.weekday || explicit.year ||
			    explicit.month || explicit.day))
				need = false;
			if (required !== 'date' && (explicit.dayPeriod ||
			    explicit.hour || explicit.minute || explicit.second ||
			    explicit.fractionalSecondDigits))
				need = false;
			if (need && (defaults === 'date' || defaults === 'all'))
				skeleton += 'yMd';
			if (need && (defaults === 'time' || defaults === 'all'))
				skeleton += { h12: 'hms', h23: 'Hms', h11: 'Kms',
					h24: 'kms' }[hc];
			dtfHc = hasHour ? hc : null;
			pat = { pattern: replaceHourCycle(gen.bestPattern(skeleton,
				P.MATCH_HOUR_FIELD_LENGTH), dtfHc) };
		}

		/* hour12 and hourCycle drop an -hc- the result does not keep */
		if ((hour12 !== undefined || hourCycle !== undefined) &&
		    resolvedExt.hc !== undefined && dtfHc !== resolvedExt.hc)
			delete resolvedExt.hc;

		s.locale = localeString(tag, resolvedExt);
		s.hc = dtfHc;
		s.calendar = loc.calType;
		s.nu = num.nu;
		s.pattern = pat.pattern;
		s.fmt = formatter(loc, num, pat, tag);
		s.loc = loc;
		s.num = num;
		s.tag = tag;
		SLOTS.set(dtf, s);
		return dtf;
	}

	/* ---- time zones ---- */

	function resolveZone(tz) {
		var z = Z.fromOption(String(tz));

		if (!z)
			throw new RangeError('Invalid time zone specified: ' + tz);
		return z;
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
			name = 'Etc/GMT' + (off > 0 ? '-' : '+') + Math.abs(off / 60);
		} else {
			var a = Math.abs(off);

			name = (off < 0 ? '-' : '+') +
				('0' + Math.floor(a / 60)).slice(-2) + ':' +
				('0' + a % 60).slice(-2);
		}
		DEFAULT_ZONE = resolveZone(name);
		return DEFAULT_ZONE;
	}

	/* ---- SimpleDateFormat ---- */

	var PERIODS = null;

	/* DayPeriodRules::getInstance: the locale's rule set, by its name
	 * with subtags dropped until one has rules */
	function dayPeriodRules(tag) {
		if (!PERIODS)
			PERIODS = JSON.parse(N.pak('dt:periods'));
		var name = icuId(tag);

		while (name) {
			var set = own(PERIODS.locales, name);

			if (set)
				return PERIODS.sets[set];
			var cut = name.lastIndexOf('_');

			name = cut > 0 ? name.slice(0, cut) : '';
		}
		return null;
	}

	/* the digits a numbering system override names, "d=hanidec" or
	 * "hebr", by field; the name of one ICU spells out (hebr, jpanyear),
	 * which vita/js/intl_calendar.js writes */
	function overrides(str, dateFields) {
		var out = {}, parts = str ? str.split(';') : [], i;

		for (i = 0; i < parts.length; i++) {
			var eq = parts[i].indexOf('='), ns = eq < 0 ? parts[i] :
				parts[i].slice(eq + 1);
			var digits = X.index().ns[ns];
			var f = digits ? Array.from(digits) : ns;

			if (eq < 0) {
				dateFields.split('').forEach(function (c) {
					out[c] = f;
				});
			} else {
				out[parts[i].charAt(0)] = f;
			}
		}
		return out;
	}

	/* the fields an override without a field letter is for, as
	 * SimpleDateFormat's kDateFields and kTimeFields list them */
	var DATE_FIELDS = 'yMdDFwWYugcLQqUr', TIME_FIELDS = 'kHmsShKAZO';

	function formatter(loc, num, pat, tag) {
		var f = {
			pattern: pat.pattern,
			sym: P.symbols(P.opened(loc.name), loc.calType),
			calType: loc.calType,
			num: num,
			rules: dayPeriodRules(tag),
			tag: tag,
			name: loc.name,
			ovr: {},
			/* what TimeZoneFormat and TimeZoneGenericNames take from
			 * the locale: its zone names, the region whose metazone
			 * names it prefers, and its names for regions */
			zoneLocale: loc.name,
			targetRegion: langRegion(tag).region,
			regionName: function (code) {
				var d = X.entry('d', X.dataTag(tag));
				var n = d && d.T ? own(d.T, code) : undefined;

				return n !== undefined ? n : code;
			}
		};
		var unq = pat.pattern.replace(/'[^']*'/g, '');

		f.hasMinute = unq.indexOf('m') >= 0;
		f.hasSecond = unq.indexOf('s') >= 0;
		f.dateOverride = pat.dateOverride || null;
		/* ISO8601Calendar's weeks start on Monday and need four days */
		if (loc.calType === 'iso8601')
			f.week = { first: 2, min: 4 };
		else if (loc.calType === 'chinese' || loc.calType === 'dangi' ||
			 unq.indexOf('Y') >= 0)
			f.week = weekData(tag);
		/* ja@calendar=japanese writes the first year of an era 元年
		 * where the pattern has 年, quoted or not */
		f.hanYear = loc.calType === 'japanese' && /^ja\b/.test(tag);
		if (!f.dateOverride && f.hanYear && pat.pattern.indexOf('\u5e74') >= 0)
			f.dateOverride = 'y=jpanyear';
		if (f.dateOverride)
			Object.assign(f.ovr, overrides(f.dateOverride, DATE_FIELDS));
		if (pat.timeOverride)
			Object.assign(f.ovr, overrides(pat.timeOverride, TIME_FIELDS));
		return f;
	}

	/* zeroPaddingNumber: min digits at least, max at most */
	function number(f, ch, value, min, max) {
		var o = f.ovr[ch], digits = Array.isArray(o) ? o : f.num.digits;

		if (typeof o === 'string') {
			/* RuleBasedNumberFormat, which pads nothing */
			var spelt = K.spell(o, value);

			if (spelt !== null)
				return spelt;
		}
		var neg = value < 0, s = String(Math.abs(value)), out = '', i;

		if (s.length > max)
			s = s.slice(s.length - max);
		while (s.length < min)
			s = '0' + s;
		for (i = 0; i < s.length; i++)
			out += digits[s.charCodeAt(i) - 48];
		return neg ? f.num.minus + out : out;
	}

	var TYPES = {
		G: 'era', y: 'year', Y: 'year', u: 'year', U: 'yearName',
		r: 'relatedYear', M: 'month', L: 'month', d: 'day',
		E: 'weekday', c: 'weekday', e: 'weekday', a: 'dayPeriod',
		b: 'dayPeriod', B: 'dayPeriod', h: 'hour', H: 'hour', K: 'hour',
		k: 'hour', m: 'minute', s: 'second', S: 'fractionalSecond',
		z: 'timeZoneName', Z: 'timeZoneName', O: 'timeZoneName',
		v: 'timeZoneName', V: 'timeZoneName', X: 'timeZoneName',
		x: 'timeZoneName'
	};

	function symbol(list, i) {
		return list && i >= 0 && i < list.length && list[i] !== null &&
			list[i] !== undefined ? list[i] : '';
	}

	function withMonthPattern(name, pattern) {
		return pattern ? P.simpleFormat(pattern, [name]) : name;
	}

	/* subFormat: one field */
	function field(f, ch, count, t) {
		var sym = f.sym, v;

		switch (ch) {
		case 'G':
			if (f.calType === 'chinese' || f.calType === 'dangi')
				return number(f, ch, t.era, 1, 9);
			return symbol(count === 5 ? sym.G.n : count === 4 ? sym.G.w :
				      sym.G.a, t.era);
		case 'U':
			if (sym.yn && t.year <= sym.yn.length)
				return symbol(sym.yn, t.year - 1);
			/* falls through */
		case 'y':
		case 'Y':
			v = ch === 'Y' ? K.weekYear(f.calType, t, f.week ||
				(f.week = weekData(f.tag))) : t.year;
			if (f.dateOverride === 'hebr' && v > 5000 && v < 6000)
				v -= 5000;
			return count === 2 ? number(f, ch, v, 2, 2) :
				number(f, ch, v, count, 10);
		case 'u':
			return number(f, ch, t.ext, count, 10);
		case 'r':
			return number(f, ch, t.related, count, 10);
		case 'M':
		case 'L': {
			var m = t.month, lp = sym.lp && t.leap ? sym.lp : null;
			var form = ch === 'M' ? sym.M.f : sym.M.s;

			if (t.hebrewLeap !== undefined) {
				if (t.hebrewLeap && m === 6 && count >= 3)
					m = 13;
				if (!t.hebrewLeap && m >= 6 && count < 3)
					m--;
			}
			if (count === 5)
				return withMonthPattern(symbol(form.n, m), lp &&
					lp[ch === 'M' ? 2 : 5]);
			if (count === 4)
				return withMonthPattern(symbol(form.w, m), lp &&
					lp[ch === 'M' ? 0 : 3]);
			if (count === 3)
				return withMonthPattern(symbol(form.a, m), lp &&
					lp[ch === 'M' ? 1 : 4]);
			return withMonthPattern(number(f, ch, m + 1, count, 10),
						lp && lp[6]);
		}
		case 'd':
			return number(f, ch, t.day, count, 10);
		case 'E':
			return symbol(count === 5 ? sym.E.f.n : count === 4 ?
				sym.E.f.w : count === 6 ? sym.E.f.s : sym.E.f.a, t.dow - 1);
		case 'c':
			if (count < 3)
				return number(f, ch, t.localDow, 1, 10);
			return symbol(count === 5 ? sym.E.s.n : count === 4 ?
				sym.E.s.w : count === 6 ? sym.E.s.s : sym.E.s.a, t.dow - 1);
		case 'e':
			if (count < 3)
				return number(f, ch, t.localDow, count, 10);
			return symbol(count === 5 ? sym.E.f.n : count === 4 ?
				sym.E.f.w : count === 6 ? sym.E.f.s : sym.E.f.a, t.dow - 1);
		case 'a':
			return symbol(count === 4 ? sym.ap.w : count === 5 ? sym.ap.n :
				      sym.ap.a, t.hour >= 12 ? 1 : 0);
		case 'b':
			if (t.hour === 12 && (!f.hasMinute || t.minute === 0) &&
			    (!f.hasSecond || t.second === 0)) {
				var nb = periodName(sym, count, 1);

				if (nb !== null)
					return nb;
			}
			return field(f, 'a', count, t);
		case 'B':
			return flexiblePeriod(f, count, t);
		case 'h':
			v = t.hour % 12;
			return number(f, ch, v === 0 ? 12 : v, count, 10);
		case 'K':
			return number(f, ch, t.hour % 12, count, 10);
		case 'H':
			return number(f, ch, t.hour, count, 10);
		case 'k':
			return number(f, ch, t.hour === 0 ? 24 : t.hour, count, 10);
		case 'm':
			return number(f, ch, t.minute, count, 10);
		case 's':
			return number(f, ch, t.second, count, 10);
		case 'S': {
			v = t.ms;
			if (count === 1)
				v = Math.floor(v / 100);
			else if (count === 2)
				v = Math.floor(v / 10);
			var out = number(f, ch, v, count > 3 ? 3 : count, 10);

			if (count > 3)
				out += number(f, ch, 0, count - 3, 10);
			return out;
		}
		case 'z': case 'Z': case 'O': case 'v': case 'V': case 'X':
		case 'x':
			return Z.format(f, ch, count, t);
		case 'Q': case 'q':
			return number(f, ch, Math.floor(t.month / 3) + 1, count, 10);
		case 'D':
			return number(f, ch, t.dayOfYear || 0, count, 10);
		default:
			return '';
		}
	}

	function periodName(sym, count, i) {
		var list = count <= 3 ? sym.dp.f.a : count === 4 || count > 5 ?
			sym.dp.f.w : sym.dp.f.n;

		return list[i] === null || list[i] === undefined ? null : list[i];
	}

	/* 'B': the locale's rules' period for the hour, noon and midnight
	 * only when the time shown is exactly that, else AM or PM */
	function flexiblePeriod(f, count, t) {
		var rules = f.rules;

		if (!rules)
			return field(f, 'a', count, t);
		var minute = f.hasMinute ? t.minute : 0,
			second = f.hasSecond ? t.second : 0, p;

		if (t.hour === 0 && minute === 0 && second === 0 && rules.midnight)
			p = 0;
		else if (t.hour === 12 && minute === 0 && second === 0 && rules.noon)
			p = 1;
		else
			p = rules.h[t.hour];
		var name = null;

		if (p !== 10 && p !== 11 && p !== 0)
			name = periodName(f.sym, count, p);
		if (name === null && (p === 0 || p === 1)) {
			p = rules.h[t.hour];
			name = p === 10 || p === 11 ? null :
				periodName(f.sym, count, p);
		}
		if (p === 10 || p === 11 || name === null)
			return field(f, 'a', count, t);
		return name;
	}

	/* the fields of a moment in the formatter's zone and calendar */
	function moment(f, zone, x) {
		var o = zone.tz.offsets(x, false), off = o[0] + o[1], local = x + off;
		var days = Math.floor(local / 864e5), msDay = local - days * 864e5;
		var t = dateFields(f.calType, days, x, f.week);

		t.dow = ((days % 7) + 11) % 7 + 1;
		t.hour = Math.floor(msDay / 3600000);
		t.minute = Math.floor(msDay / 60000) % 60;
		t.second = Math.floor(msDay / 1000) % 60;
		t.ms = msDay % 1000;
		t.utc = x;
		t.offset = off;
		t.zone = zone;
		return t;
	}

	/*
	 * SimpleDateFormat::_format: the formatter's pattern for a moment,
	 * appended to acc.s, with each field written appended to acc.fields
	 * as { ch, start, end }
	 */
	function render(f, t, acc) {
		var p = f.pattern, n = p.length, i = 0;

		while (i < n) {
			var c = p.charAt(i);

			if (c === "'") {
				if (p.charAt(i + 1) === "'") {
					acc.s += "'";
					i += 2;
					continue;
				}
				var j = i + 1;

				while (j < n) {
					if (p.charAt(j) === "'") {
						if (p.charAt(j + 1) === "'") {
							acc.s += "'";
							j += 2;
							continue;
						}
						break;
					}
					acc.s += p.charAt(j++);
				}
				i = j + 1;
				continue;
			}
			if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
				var k = i + 1;

				while (k < n && p.charAt(k) === c)
					k++;
				var v = field(f, c, k - i, t);

				if (v) {
					acc.fields.push({ ch: c, start: acc.s.length,
						end: acc.s.length + v.length });
					acc.s += v;
				}
				i = k;
				continue;
			}
			acc.s += c;
			i++;
		}
	}

	/* the parts of what render wrote: its fields, and literal text
	 * between, with the fields formatToParts has no type for left in
	 * the literal text */
	function toParts(acc, source) {
		var parts = [], lit = '', prev = 0, i;

		function push(type, value) {
			var part = { type: type, value: value };

			if (source)
				part.source = source;
			parts.push(part);
		}
		for (i = 0; i < acc.fields.length; i++) {
			var e = acc.fields[i], type = TYPES[e.ch];

			lit += acc.s.slice(prev, e.start);
			prev = e.end;
			if (!type) {
				lit += acc.s.slice(e.start, e.end);
				continue;
			}
			if (lit)
				push('literal', lit);
			lit = '';
			push(type, acc.s.slice(e.start, e.end));
		}
		lit += acc.s.slice(prev);
		if (lit)
			push('literal', lit);
		return parts;
	}

	function formatParts(f, zone, x, source) {
		var acc = { s: '', fields: [] };

		render(f, moment(f, zone, x), acc);
		return toParts(acc, source);
	}

	/* SimpleDateFormat::applyPattern, for the formatter
	 * DateIntervalFormat keeps: the flags the pattern sets, and the
	 * Japanese first year where it has 年 */
	function applyPattern(f, p) {
		if (f.pattern === p)
			return;
		f.pattern = p;
		var unq = p.replace(/'[^']*'/g, '');

		f.hasMinute = unq.indexOf('m') >= 0;
		f.hasSecond = unq.indexOf('s') >= 0;
		if (f.hanYear) {
			if (f.dateOverride === 'y=jpanyear' && p.indexOf('\u5e74') < 0) {
				f.dateOverride = null;
				f.ovr = {};
			} else if (!f.dateOverride && p.indexOf('\u5e74') >= 0) {
				f.dateOverride = 'y=jpanyear';
				f.ovr = { y: 'jpanyear' };
			}
		}
	}

	/*
	 * What SimpleDateFormat::format has written when its calendar fails
	 * on the first field: the literal text before that field and the
	 * character after it, if that is literal too.
	 */
	function failedText(p) {
		var out = '', prev = '', count = 0, q = false, i;

		for (i = 0; i < p.length; i++) {
			var c = p.charAt(i), failed = false;

			if (c !== prev && count > 0)
				failed = true;
			if (c === "'") {
				if (p.charAt(i + 1) === "'") {
					out += "'";
					i++;
				} else {
					q = !q;
				}
			} else if (!q && /[A-Za-z]/.test(c)) {
				prev = c;
				count++;
			} else {
				out += c;
			}
			if (failed)
				break;
		}
		return out;
	}

	function timeValue(date) {
		var x = date === undefined ? Date.now() : Number(date);

		if (!isFinite(x) || Math.abs(x) > 8.64e15)
			throw new RangeError('Invalid time value');
		return x < 0 ? -Math.floor(-x) : Math.floor(x);
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
				/* V8 writes a plain space where ICU has a narrow
				 * no-break one, for the pages that split on it */
				s.bound = function (date) {
					return formatString(s, timeValue(date));
				};
			}
			return s.bound;
		}
	});

	/* FormatDateTime, which V8 has write a plain space where ICU has a
	 * narrow no-break one, for the pages that split on it */
	function formatString(s, x) {
		var acc = { s: '', fields: [] };

		try {
			render(s.fmt, moment(s.fmt, s.zone, x), acc);
		} catch (e) {
			if (!e.icu)
				throw e;
			return failedText(s.fmt.pattern);
		}
		return acc.s.replace(/\u202f/g, ' ');
	}

	function icuError(e) {
		return e.icu ? new TypeError('Internal error. Icu error.') : e;
	}

	method(proto, 'formatToParts', function formatToParts(date) {
		var s = slots(this, 'formatToParts'), x = timeValue(date);

		try {
			return formatParts(s.fmt, s.zone, x);
		} catch (e) {
			throw icuError(e);
		}
	});

	/* ---- ranges ---- */

	/* what vita/js/intl_range.js works with */
	var RANGE = R ? R({ P: P, generator: generator, formatter: formatter,
		moment: moment, render: render, applyPattern: applyPattern,
		HC_CHAR: HC_CHAR, TYPES: TYPES }) : null;

	/* PartitionDateTimeRangePattern's arguments, as V8 reads them */
	function rangeValues(start, end) {
		if (start === undefined || end === undefined)
			throw new TypeError('Invalid time value');
		var x = Number(start), y = Number(end);

		if (!isFinite(x) || Math.abs(x) > 8.64e15 || !isFinite(y) ||
		    Math.abs(y) > 8.64e15)
			throw new RangeError('Invalid time value');
		return [x < 0 ? -Math.floor(-x) : Math.floor(x),
			y < 0 ? -Math.floor(-y) : Math.floor(y)];
	}

	function rangeOf(s) {
		return s.range || (s.range = RANGE.create(s));
	}

	/* where the two dates look the same in every field shown, V8
	 * formats the first alone */
	method(proto, 'formatRange', function formatRange(startDate, endDate) {
		var s = slots(this, 'formatRange'), v = rangeValues(startDate, endDate);
		var r;

		try {
			r = RANGE.format(rangeOf(s), s, v[0], v[1]);
		} catch (e) {
			throw icuError(e);
		}
		return r === null ? formatString(s, v[0]) : r;
	});

	method(proto, 'formatRangeToParts',
	       function formatRangeToParts(startDate, endDate) {
		var s = slots(this, 'formatRangeToParts');
		var v = rangeValues(startDate, endDate), r;

		try {
			r = RANGE.formatToParts(rangeOf(s), s, v[0], v[1]);
			return r === null ? formatParts(s.fmt, s.zone, v[0], 'shared') : r;
		} catch (e) {
			throw icuError(e);
		}
	});

	/* V8's resolvedOptions reads the components off the pattern as it
	 * is written, quoted text and all */
	var PAIRS = [
		['weekday', [['EEEEE', 'narrow'], ['EEEE', 'long'], ['EEE', 'short'],
			['ccccc', 'narrow'], ['cccc', 'long'], ['ccc', 'short']]],
		['era', [['GGGGG', 'narrow'], ['GGGG', 'long'], ['GGG', 'short']]],
		['year', [['yy', '2-digit'], ['y', 'numeric']]],
		['month', [['MMMMM', 'narrow'], ['MMMM', 'long'], ['MMM', 'short'],
			['MM', '2-digit'], ['M', 'numeric'], ['LLLLL', 'narrow'],
			['LLLL', 'long'], ['LLL', 'short'], ['LL', '2-digit'],
			['L', 'numeric']]],
		['day', [['dd', '2-digit'], ['d', 'numeric']]],
		['dayPeriod', [['BBBBB', 'narrow'], ['bbbbb', 'narrow'],
			['BBBB', 'long'], ['bbbb', 'long'], ['B', 'short'],
			['b', 'short']]],
		['hour', [['HH', '2-digit'], ['H', 'numeric'], ['hh', '2-digit'],
			['h', 'numeric'], ['kk', '2-digit'], ['k', 'numeric'],
			['KK', '2-digit'], ['K', 'numeric']]],
		['minute', [['mm', '2-digit'], ['m', 'numeric']]],
		['second', [['ss', '2-digit'], ['s', 'numeric']]],
		['timeZoneName', [['zzzz', 'long'], ['z', 'short'],
			['OOOO', 'longOffset'], ['O', 'shortOffset'],
			['vvvv', 'longGeneric'], ['v', 'shortGeneric']]]
	];

	method(proto, 'resolvedOptions', function resolvedOptions() {
		var s = slots(this, 'resolvedOptions'), r = {
			locale: s.locale, calendar: bcpCalendar(s.calendar),
			numberingSystem: s.nu, timeZone: Z.resolvedName(s.zone)
		}, i, j;

		if (s.hc) {
			r.hourCycle = s.hc;
			r.hour12 = s.hc === 'h11' || s.hc === 'h12';
		}
		if (s.dateStyle === undefined && s.timeStyle === undefined) {
			for (i = 0; i < PAIRS.length; i++) {
				if (PAIRS[i][0] === 'timeZoneName') {
					var fsd = Math.min(3, (s.pattern.match(/S/g) || [])
							   .length);

					if (fsd)
						r.fractionalSecondDigits = fsd;
				}
				for (j = 0; j < PAIRS[i][1].length; j++) {
					if (s.pattern.indexOf(PAIRS[i][1][j][0]) >= 0) {
						r[PAIRS[i][0]] = PAIRS[i][1][j][1];
						break;
					}
				}
			}
		}
		if (s.dateStyle !== undefined)
			r.dateStyle = s.dateStyle;
		if (s.timeStyle !== undefined)
			r.timeStyle = s.timeStyle;
		return r;
	});

	Object.defineProperty(proto, Symbol.toStringTag, {
		configurable: true, value: 'Intl.DateTimeFormat'
	});
	method(DateTimeFormat, 'supportedLocalesOf',
	       function supportedLocalesOf(locales, options) {
		return X.supported(locales, options);
	});
	Object.defineProperty(DateTimeFormat, 'prototype', { writable: false });

	Intl.DateTimeFormat = DateTimeFormat;

	/* ---- Intl's own ---- */

	/* the collation types ICU has, under the names V8 lists them by */
	var COLLATIONS = ['compat', 'dict', 'emoji', 'eor', 'phonebk',
		'phonetic', 'pinyin', 'searchjl', 'stroke', 'trad', 'unihan',
		'zhuyin'];
	var values = Intl.supportedValuesOf;

	/* not enumerable, as an earlier module may have left it */
	Object.defineProperty(Intl, 'supportedValuesOf', { enumerable: false });
	method(Intl, 'supportedValuesOf', function supportedValuesOf(key) {
		key = String(key);
		switch (key) {
		case 'calendar':
			return CALENDARS.slice();
		case 'collation':
			return COLLATIONS.slice();
		case 'timeZone':
			return Z.zones();
		case 'currency':
		case 'numberingSystem':
		case 'unit':
			return values.call(Intl, key);
		}
		throw new RangeError('Invalid key : ' + key);
	});
	method(Intl, 'getCanonicalLocales', function getCanonicalLocales(locales) {
		return C.localeList(locales);
	});

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
			if (!(this instanceof Date))
				throw new TypeError('this is not a Date object.');
			var t = this.getTime();

			if (isNaN(t))
				return 'Invalid Date';
			return dateFormatter(kind, locales, options).format(t);
		};
	}

	method(Date.prototype, 'toLocaleString', toLocale('all'));
	method(Date.prototype, 'toLocaleDateString', toLocale('date'));
	method(Date.prototype, 'toLocaleTimeString', toLocale('time'));

	return { DateTimeFormat: DateTimeFormat, slots: slots,
		formatParts: formatParts, create: create };
};

if (typeof window !== 'undefined' && window.__vitaIntl &&
    window.__vitaIntl.number && window.__vitaIntl.has &&
    window.__vitaIntl.has('dt:index') && window.__vitaIntl.has('tz:index') &&
    window.__vitaIntlCore && typeof __vitaIntlPattern !== 'undefined' &&
    typeof __vitaIntlZone !== 'undefined' &&
    typeof __vitaIntlCalendar !== 'undefined') {
	(function (N) {
		var P = __vitaIntlPattern(N);

		N.date = __vitaIntlDate(window, N, window.__vitaIntlCore, N.number,
			P, __vitaIntlZone(N, P), __vitaIntlCalendar(N),
			typeof __vitaIntlRange !== 'undefined' ? __vitaIntlRange : null);
	})(window.__vitaIntl);
}

if (typeof module !== 'undefined')
	module.exports = __vitaIntlDate;
