/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Time zones for Intl.DateTimeFormat (VitaSurf), as V8 has them from ICU.
 *
 * ICU's zones from its own build of the IANA database (resources/intl.pak,
 * scripts/gen-intl-zones.mjs), with their whole history: OlsonTimeZone
 * and the SimpleTimeZone of its final rule, line by line from ICU, for
 * offsets and transitions; ZoneMeta's canonical IDs, regions and
 * metazones; and the zone names a locale has, as TimeZoneNamesImpl,
 * TimeZoneGenericNames and TimeZoneFormat find and write them, for the
 * z, v, O and V fields of vita/js/intl.js. V8's way of reading a time
 * zone option, and of writing the one it resolved, is here too.
 *
 * __vitaIntlZone(N, P) takes the pack reader and vita/js/intl_pattern.js
 * and has no browser dependencies, so that it runs under Node.
 */
var __vitaIntlZone = function (N, P) {
	'use strict';

	var DAY = 86400000, HOUR = 3600000, MINUTE = 60000;
	var INDEX = null, NAMES = null, META = null;

	function index() {
		if (!INDEX) {
			INDEX = JSON.parse(N.pak('tz:index'));
			NAMES = {};
			INDEX.n.split(' ').forEach(function (n) {
				NAMES[n] = 1;
			});
			INDEX.primary = {};
			INDEX.p.split(' ').forEach(function (n) {
				INDEX.primary[n] = 1;
			});
		}
		return INDEX;
	}

	function own(o, k) {
		return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
	}

	/* ---- Grego ---- */

	function floorDiv(a, b) {
		return Math.floor(a / b);
	}

	function fieldsToDay(y, m, d) {
		/* proleptic Gregorian, m 0 first */
		m += 1;
		y -= m <= 2 ? 1 : 0;
		var era = floorDiv(y, 400), yoe = y - era * 400;
		var doy = floorDiv(153 * (m + (m > 2 ? -3 : 9)) + 2, 5) + d - 1;
		var doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;

		return era * 146097 + doe - 719468;
	}

	function dayToFields(z) {
		z += 719468;
		var era = floorDiv(z, 146097), doe = z - era * 146097;
		var yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) -
			floorDiv(doe, 146096), 365);
		var y = yoe + era * 400, doy = doe - (365 * yoe + floorDiv(yoe, 4) -
			floorDiv(yoe, 100)), mp = floorDiv(5 * doy + 2, 153);
		var d = doy - floorDiv(153 * mp + 2, 5) + 1;
		var m = mp + (mp < 10 ? 3 : -9);

		return [y + (m <= 2 ? 1 : 0), m - 1, d];
	}

	function isLeap(y) {
		return (y % 4 === 0) && (y % 100 !== 0 || y % 400 === 0);
	}

	var MONTH_LENGTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

	function monthLength(y, m) {
		return m === 1 && isLeap(y) ? 29 : MONTH_LENGTH[m];
	}

	function prevMonthLength(y, m) {
		return m > 0 ? monthLength(y, m - 1) : 31;
	}

	/* Grego::timeToFields: [year, month, day, day of week (1 Sunday),
	 * ms of the day] */
	function timeToFields(date) {
		var days = Math.floor(date / DAY), f = dayToFields(days);

		f.push(((days % 7) + 11) % 7 + 1, date - days * DAY);
		return f;
	}

	function dayOfWeek(day) {
		return ((day % 7) + 11) % 7 + 1;
	}

	/* ---- SimpleTimeZone ---- */

	var DOM_MODE = 1, DOW_IN_MONTH_MODE = 2, DOW_GE_DOM_MODE = 3,
		DOW_LE_DOM_MODE = 4;
	var WALL_TIME = 0, STANDARD_TIME = 1, UTC_TIME = 2;

	/* from zoneinfo64's eleven numbers and a raw offset in ms */
	function Simple(raw, r) {
		this.raw = raw;
		this.startMonth = r[0];
		this.startDay = r[1];
		this.startDayOfWeek = r[2];
		this.startTime = r[3] * 1000;
		this.startTimeMode = r[4];
		this.endMonth = r[5];
		this.endDay = r[6];
		this.endDayOfWeek = r[7];
		this.endTime = r[8] * 1000;
		this.endTimeMode = r[9];
		this.dst = r[10] * 1000;
		this.startYear = 0;
		this.decode();
	}

	Simple.prototype.decode = function () {
		var self = this;

		this.useDaylight = this.startDay !== 0 && this.endDay !== 0;
		if (this.useDaylight && this.dst === 0)
			this.dst = HOUR;
		['start', 'end'].forEach(function (w) {
			var day = self[w + 'Day'], dow = self[w + 'DayOfWeek'], mode;

			if (day === 0)
				return;
			if (dow === 0) {
				mode = DOM_MODE;
			} else if (dow > 0) {
				mode = DOW_IN_MONTH_MODE;
			} else {
				self[w + 'DayOfWeek'] = -dow;
				if (day > 0) {
					mode = DOW_GE_DOM_MODE;
				} else {
					self[w + 'Day'] = -day;
					mode = DOW_LE_DOM_MODE;
				}
			}
			self[w + 'Mode'] = mode;
		});
	};

	Simple.prototype.compareToRule = function (month, monthLen, prevMonthLen,
						   dom, dow, millis, delta, mode,
						   ruleMonth, ruleDow, ruleDay,
						   ruleMillis) {
		millis += delta;
		while (millis >= DAY) {
			millis -= DAY;
			++dom;
			dow = 1 + (dow % 7);
			if (dom > monthLen) {
				dom = 1;
				++month;
			}
		}
		while (millis < 0) {
			millis += DAY;
			--dom;
			dow = 1 + ((dow + 5) % 7);
			if (dom < 1) {
				dom = prevMonthLen;
				--month;
			}
		}
		if (month < ruleMonth)
			return -1;
		if (month > ruleMonth)
			return 1;
		var ruleDom = 0;

		if (ruleDay > monthLen)
			ruleDay = monthLen;
		switch (mode) {
		case DOM_MODE:
			ruleDom = ruleDay;
			break;
		case DOW_IN_MONTH_MODE:
			if (ruleDay > 0)
				ruleDom = 1 + (ruleDay - 1) * 7 +
					(7 + ruleDow - (dow - dom + 1)) % 7;
			else
				ruleDom = monthLen + (ruleDay + 1) * 7 -
					(7 + (dow + monthLen - dom) - ruleDow) % 7;
			break;
		case DOW_GE_DOM_MODE:
			ruleDom = ruleDay + (49 + ruleDow - ruleDay - dow + dom) % 7;
			break;
		case DOW_LE_DOM_MODE:
			ruleDom = ruleDay - (49 - ruleDow + ruleDay + dow - dom) % 7;
			break;
		}
		if (dom < ruleDom)
			return -1;
		if (dom > ruleDom)
			return 1;
		return millis < ruleMillis ? -1 : millis > ruleMillis ? 1 : 0;
	};

	/* the eight-argument getOffset, AD always as TimeZone::getOffset
	 * calls it */
	Simple.prototype.offsetAt = function (year, month, dom, dow, millis) {
		var result = this.raw;

		if (!this.useDaylight || year < this.startYear)
			return result;
		var ml = monthLength(year, month), pml = prevMonthLength(year, month);
		var southern = this.startMonth > this.endMonth;
		var sc = this.compareToRule(month, ml, pml, dom, dow, millis,
			this.startTimeMode === UTC_TIME ? -this.raw : 0,
			this.startMode, this.startMonth, this.startDayOfWeek,
			this.startDay, this.startTime);
		var ec = 0;

		if (southern !== (sc >= 0))
			ec = this.compareToRule(month, ml, pml, dom, dow, millis,
				this.endTimeMode === WALL_TIME ? this.dst :
				this.endTimeMode === UTC_TIME ? -this.raw : 0,
				this.endMode, this.endMonth, this.endDayOfWeek,
				this.endDay, this.endTime);
		if ((!southern && sc >= 0 && ec < 0) ||
		    (southern && (sc >= 0 || ec < 0)))
			result += this.dst;
		return result;
	};

	/* TimeZone::getOffset: [raw, dst] */
	Simple.prototype.offsets = function (date, local) {
		var raw = this.raw, dst, pass;

		if (!local)
			date += raw;
		for (pass = 0; ; ++pass) {
			var f = timeToFields(date);

			dst = this.offsetAt(f[0], f[1], f[2], f[3], f[4]) - raw;
			if (pass !== 0 || !local || dst === 0)
				break;
			date -= dst;
		}
		return [raw, dst];
	};

	/* AnnualTimeZoneRule::getStartInYear for a rule of this zone */
	function startInYear(rule, year, prevRaw, prevDst) {
		if (year < rule.startYear)
			return null;
		var day, after = true;

		if (rule.mode === DOM_MODE) {
			day = fieldsToDay(year, rule.month, rule.day);
		} else {
			if (rule.mode === DOW_IN_MONTH_MODE) {
				if (rule.day > 0) {
					day = fieldsToDay(year, rule.month, 1) + 7 * (rule.day - 1);
				} else {
					after = false;
					day = fieldsToDay(year, rule.month,
						monthLength(year, rule.month)) + 7 * (rule.day + 1);
				}
			} else {
				var dom = rule.day;

				if (rule.mode === DOW_LE_DOM_MODE) {
					after = false;
					if (rule.month === 1 && dom === 29 && !isLeap(year))
						dom--;
				}
				day = fieldsToDay(year, rule.month, dom);
			}
			var delta = rule.dow - dayOfWeek(day);

			if (after)
				delta = delta < 0 ? delta + 7 : delta;
			else
				delta = delta > 0 ? delta - 7 : delta;
			day += delta;
		}
		var t = day * DAY + rule.millis;

		if (rule.timeType !== UTC_TIME)
			t -= prevRaw;
		if (rule.timeType === WALL_TIME)
			t -= prevDst;
		return t;
	}

	Simple.prototype.rules = function () {
		if (this._rules)
			return this._rules;
		var dstRule = { month: this.startMonth, day: this.startDay,
			dow: this.startDayOfWeek, millis: this.startTime,
			timeType: this.startTimeMode, mode: this.startMode,
			startYear: this.startYear, raw: this.raw, dst: this.dst };
		var stdRule = { month: this.endMonth, day: this.endDay,
			dow: this.endDayOfWeek, millis: this.endTime,
			timeType: this.endTimeMode, mode: this.endMode,
			startYear: this.startYear, raw: this.raw, dst: 0 };
		var firstDst = startInYear(dstRule, this.startYear, this.raw, 0);
		var firstStd = startInYear(stdRule, this.startYear, this.raw, this.dst);

		this._rules = { dst: dstRule, std: stdRule,
			first: firstStd < firstDst ? firstStd : firstDst };
		return this._rules;
	};

	function nextStart(rule, base, prevRaw, prevDst, inclusive) {
		var year = timeToFields(base)[0];

		if (year < rule.startYear)
			return startInYear(rule, rule.startYear, prevRaw, prevDst);
		var t = startInYear(rule, year, prevRaw, prevDst);

		if (t === null)
			return null;
		if (t < base || (!inclusive && t === base))
			return startInYear(rule, year + 1, prevRaw, prevDst);
		return t;
	}

	function previousStart(rule, base, prevRaw, prevDst, inclusive) {
		var year = timeToFields(base)[0];
		var t = startInYear(rule, year, prevRaw, prevDst);

		if (t === null)
			return null;
		if (t > base || (!inclusive && t === base))
			return startInYear(rule, year - 1, prevRaw, prevDst);
		return t;
	}

	/* a transition: { time, fromDst, toDst } in ms */
	Simple.prototype.next = function (base, inclusive) {
		if (!this.useDaylight)
			return null;
		var r = this.rules();
		var s = nextStart(r.std, base, r.dst.raw, r.dst.dst, inclusive);
		var d = nextStart(r.dst, base, r.std.raw, r.std.dst, inclusive);

		if (s !== null && (d === null || s < d))
			return { time: s, fromDst: r.dst.dst, toDst: 0 };
		if (d !== null && (s === null || d < s))
			return { time: d, fromDst: 0, toDst: r.dst.dst };
		return null;
	};

	Simple.prototype.previous = function (base, inclusive) {
		if (!this.useDaylight)
			return null;
		var r = this.rules();

		if (base < r.first || (!inclusive && base === r.first))
			return null;
		var s = previousStart(r.std, base, r.dst.raw, r.dst.dst, inclusive);
		var d = previousStart(r.dst, base, r.std.raw, r.std.dst, inclusive);

		if (s !== null && (d === null || s > d))
			return { time: s, fromDst: r.dst.dst, toDst: 0 };
		if (d !== null && (s === null || d > s))
			return { time: d, fromDst: 0, toDst: r.dst.dst };
		return null;
	};

	/* ---- OlsonTimeZone ---- */

	var K_STANDARD = 1, K_DAYLIGHT = 3, K_FORMER = 4, K_LATTER = 12;

	function Olson(d) {
		this.t = d.t;
		this.o = d.o;
		this.m = d.m;
		if (d.f) {
			this.final = new Simple(d.r * 1000, d.f);
			this.finalStartYear = d.y;
			this.finalStartMillis = fieldsToDay(d.y, 0, 1) * DAY;
		}
	}

	Olson.prototype.rawAt = function (i) {
		return this.o[i < 0 ? 0 : 2 * this.m[i]];
	};
	Olson.prototype.dstAt = function (i) {
		return this.o[i < 0 ? 1 : 2 * this.m[i] + 1];
	};

	Olson.prototype.historical = function (date, local, nonExisting,
					       duplicated) {
		var n = this.t.length, i;

		if (!n)
			return [this.o[0] * 1000, this.o[1] * 1000];
		var sec = Math.floor(date / 1000);

		if (!local && sec < this.t[0])
			return [this.o[0] * 1000, this.o[1] * 1000];
		for (i = n - 1; i >= 0; i--) {
			var tr = this.t[i];

			if (local && sec >= tr - 86400) {
				var before = this.rawAt(i - 1) + this.dstAt(i - 1),
					dstBefore = this.dstAt(i - 1) !== 0,
					after = this.rawAt(i) + this.dstAt(i),
					dstAfter = this.dstAt(i) !== 0;
				var dstToStd = dstBefore && !dstAfter,
					stdToDst = !dstBefore && dstAfter;

				if (after - before >= 0) {
					if (((nonExisting & 3) === K_STANDARD && dstToStd) ||
					    ((nonExisting & 3) === K_DAYLIGHT && stdToDst))
						tr += before;
					else if (((nonExisting & 3) === K_STANDARD && stdToDst) ||
						 ((nonExisting & 3) === K_DAYLIGHT && dstToStd))
						tr += after;
					else if ((nonExisting & 12) === K_LATTER)
						tr += before;
					else
						tr += after;
				} else {
					if (((duplicated & 3) === K_STANDARD && dstToStd) ||
					    ((duplicated & 3) === K_DAYLIGHT && stdToDst))
						tr += after;
					else if (((duplicated & 3) === K_STANDARD && stdToDst) ||
						 ((duplicated & 3) === K_DAYLIGHT && dstToStd))
						tr += before;
					else if ((duplicated & 12) === K_FORMER)
						tr += before;
					else
						tr += after;
				}
			}
			if (sec >= tr)
				break;
		}
		return [this.rawAt(i) * 1000, this.dstAt(i) * 1000];
	};

	/* getOffset: [raw, dst] in ms */
	Olson.prototype.offsets = function (date, local) {
		if (this.final && date >= this.finalStartMillis)
			return this.final.offsets(date, local);
		return this.historical(date, local, K_FORMER, K_LATTER);
	};

	Olson.prototype.rulesInit = function () {
		if (this._init)
			return;
		this._init = true;
		var n = this.t.length, i;

		this.firstIdx = 0;
		for (i = 0; i < n && this.m[i] === 0; i++)
			this.firstIdx++;
		this.hasHistoric = n > 0 && this.firstIdx < n;
		if (this.final) {
			var start = this.finalStartMillis, toDst = 0;

			if (this.final.useDaylight) {
				var withYear = new Simple(this.final.raw, [0]);

				for (var k in this.final)
					if (k !== '_rules')
						withYear[k] = this.final[k];
				withYear.startYear = this.finalStartYear;
				this.finalWithYear = withYear;
				var tz = withYear.next(start, false);

				start = tz.time;
				toDst = tz.toDst;
			}
			this.firstFinal = { time: start,
				fromDst: n ? this.dstAt(n - 1) * 1000 : this.o[1] * 1000,
				toDst: toDst };
		}
	};

	Olson.prototype.transitionAt = function (i) {
		return this.t[i] * 1000;
	};

	/* a type change that changes nothing is no transition */
	Olson.prototype.same = function (a, b) {
		return this.rawAt(a) === this.rawAt(b) &&
			this.dstAt(a) === this.dstAt(b);
	};

	Olson.prototype.next = function (base, inclusive) {
		this.rulesInit();
		var ff = this.firstFinal;

		if (this.final) {
			if (inclusive && base === ff.time)
				return ff;
			if (base >= ff.time)
				return this.final.useDaylight ?
					this.finalWithYear.next(base, inclusive) : null;
		}
		if (!this.hasHistoric)
			return null;
		var n = this.t.length, i;

		for (i = n - 1; i >= this.firstIdx; i--) {
			var t = this.transitionAt(i);

			if (base > t || (!inclusive && base === t))
				break;
		}
		if (i === n - 1)
			return ff || null;
		if (i < this.firstIdx)
			return { time: this.transitionAt(this.firstIdx),
				fromDst: this.o[1] * 1000,
				toDst: this.dstAt(this.firstIdx) * 1000 };
		if (this.same(i, i + 1))
			return this.next(this.transitionAt(i + 1), false);
		return { time: this.transitionAt(i + 1),
			fromDst: this.dstAt(i) * 1000, toDst: this.dstAt(i + 1) * 1000 };
	};

	Olson.prototype.previous = function (base, inclusive) {
		this.rulesInit();
		var ff = this.firstFinal;

		if (this.final) {
			if (inclusive && base === ff.time)
				return ff;
			if (base > ff.time)
				return this.final.useDaylight ?
					this.finalWithYear.previous(base, inclusive) : ff;
		}
		if (!this.hasHistoric)
			return null;
		var i;

		for (i = this.t.length - 1; i >= this.firstIdx; i--) {
			var t = this.transitionAt(i);

			if (base > t || (inclusive && base === t))
				break;
		}
		if (i < this.firstIdx)
			return null;
		if (i === this.firstIdx)
			return { time: this.transitionAt(i), fromDst: this.o[1] * 1000,
				toDst: this.dstAt(i) * 1000 };
		if (this.same(i - 1, i))
			return this.previous(this.transitionAt(i), false);
		return { time: this.transitionAt(i), fromDst: this.dstAt(i - 1) * 1000,
			toDst: this.dstAt(i) * 1000 };
	};

	/* a fixed offset (a custom ID), as a SimpleTimeZone without rules */
	function Fixed(offset) {
		this.raw = offset;
	}
	Fixed.prototype.offsets = function () {
		return [this.raw, 0];
	};
	Fixed.prototype.next = Fixed.prototype.previous = function () {
		return null;
	};

	/* ---- zones by ID ---- */

	var DATA = {};

	function zoneData(id) {
		var ix = index(), target = own(ix.l, id) || id;

		if (!DATA[target])
			DATA[target] = new Olson(JSON.parse(N.pak('tz:' + target)));
		return DATA[target];
	}

	/* ZoneMeta::getCanonicalCLDRID */
	function canonical(id) {
		var ix = index();

		if (!NAMES[id])
			return null;
		return own(ix.c, id) || id;
	}

	/* a custom ID, GMT+h[h][[:]mm[[:]ss]], as ICU normalizes it */
	function customOffset(id) {
		var m = /^GMT([+-])(\d{1,2})(?::?(\d{2})(?::?(\d{2}))?)?$/i.exec(id);

		if (!m)
			return null;
		var h = +m[2], mi = m[3] ? +m[3] : 0, s = m[4] ? +m[4] : 0;

		if (h > 23 || mi > 59 || s > 59)
			return null;
		return (m[1] === '-' ? -1 : 1) * (h * HOUR + mi * MINUTE + s * 1000);
	}

	function pad2(n) {
		return n < 10 ? '0' + n : String(n);
	}

	function customId(offset) {
		var a = Math.abs(offset), h = Math.floor(a / HOUR),
			m = Math.floor(a / MINUTE) % 60, s = Math.floor(a / 1000) % 60;

		return 'GMT' + (offset < 0 ? '-' : '+') + pad2(h) + ':' + pad2(m) +
			(s ? ':' + pad2(s) : '');
	}

	/* TimeZone::createTimeZone, and V8's check that it is a real one: a
	 * zone { id, canonical, tz }, or null */
	function create(id) {
		if (NAMES === null)
			index();
		if (NAMES[id]) {
			var c = canonical(id);

			if (!c || c === 'Etc/Unknown')
				return null;
			return { id: id, canonical: c, tz: zoneData(id) };
		}
		var off = customOffset(id);

		if (off === null)
			return null;
		var cid = customId(off);

		return { id: cid, canonical: cid, tz: new Fixed(off), custom: true };
	}

	/* ---- V8's reading of a time zone option ---- */

	var SPECIAL = ['America/Argentina/ComodRivadavia', 'America/Knox_IN',
		'Antarctica/DumontDUrville', 'Antarctica/McMurdo', 'Australia/ACT',
		'Australia/LHI', 'Australia/NSW', 'Brazil/DeNoronha',
		'Chile/EasterIsland', 'GB', 'GB-Eire', 'Mexico/BajaNorte',
		'Mexico/BajaSur', 'NZ', 'NZ-CHAT', 'W-SU'];

	/* GetOffsetTimeZone: +hh, +hhmm, +hh:mm as an ICU custom ID */
	function offsetZone(s) {
		if (s.length < 3)
			return null;
		var c = s.charAt(0), sign;

		if (c === '-' || c === '\u2212')
			sign = '-';
		else if (c === '+')
			sign = '+';
		else
			return null;
		if (!/^([01][0-9]|2[0-3])/.test(s.slice(1, 3)))
			return null;
		var tz = 'GMT' + sign + s.slice(1, 3);

		if (s.length === 3)
			return tz;
		var p = 3;

		if (s.charAt(p) === ':')
			p++;
		if (s.length - p !== 2 || !/^[0-5][0-9]$/.test(s.slice(p)))
			return null;
		return tz + s.slice(p);
	}

	/* ToTitleCaseTimezoneLocation */
	function titleCase(s) {
		var out = '', len = 0, i;

		for (i = 0; i < s.length; i++) {
			var c = s.charAt(i);

			if (/[A-Za-z]/.test(c)) {
				out += len === 0 ? c.toUpperCase() : c.toLowerCase();
				len++;
			} else if (c === '_' || c === '-' || c === '/') {
				if (len === 2) {
					var two = out.slice(-2);

					if (two === 'Of' || two === 'Es' || two === 'Au')
						out = out.slice(0, -2) + two.toLowerCase();
				}
				out += c;
				len = 0;
			} else {
				return '';
			}
		}
		return out;
	}

	/* CanonicalizeTimeZoneID */
	function canonicalizeId(input) {
		var up = input.replace(/[a-z]+/g, function (m) {
			return m.toUpperCase();
		});

		if (up.length === 3)
			return up === 'GMT' ? 'UTC' : up;
		if (up.length === 7 && up.charAt(3) >= '0' && up.charAt(3) <= '9')
			return up;
		if (up.length > 3) {
			if (up.slice(0, 3) === 'ETC') {
				if (up === 'ETC/UTC' || up === 'ETC/GMT' || up === 'ETC/UCT')
					return 'UTC';
				if (up.slice(0, 7) === 'ETC/GMT') {
					var m = /^ETC\/GMT(?:(0)|([+-][0-9])|([+-]1[0-4]))$/
						.exec(up);

					return m ? 'Etc/GMT' + up.slice(7) : '';
				}
			} else if (up.slice(0, 3) === 'GMT') {
				if (up === 'GMT0' || up === 'GMT+0' || up === 'GMT-0')
					return 'UTC';
			} else if (up.slice(0, 3) === 'US/') {
				var t = titleCase(input);

				return t.length >= 2 ? t.charAt(0) + 'S' + t.slice(2) : t;
			} else if (up.slice(0, 8) === 'SYSTEMV/') {
				return 'SystemV/' + up.slice(8);
			}
		}
		for (var i = 0; i < SPECIAL.length; i++) {
			if (SPECIAL[i].toUpperCase() === up)
				return SPECIAL[i];
		}
		return titleCase(input);
	}

	/* JSDateTimeFormat::CreateTimeZone: the zone, or null for one V8
	 * refuses */
	function fromOption(s) {
		var off = offsetZone(s);

		if (off !== null)
			return create(off);
		var id = canonicalizeId(s);

		return id ? create(id) : null;
	}

	/* TimeZoneIdToString of the zone's canonical ID */
	function resolvedName(zone) {
		var c = zone.canonical;

		if (c === 'Etc/UTC' || c === 'Etc/GMT')
			return 'UTC';
		if (zone.custom)
			return c.slice(3);
		return c;
	}

	/* ---- the zone names of a locale ---- */

	var TZN = null, LOCALES = {};

	/* TimeZoneNamesImpl, TimeZoneGenericNames and TimeZoneFormat's data
	 * for a locale (its ICU ID) */
	function locale(name) {
		if (LOCALES[name])
			return LOCALES[name];
		if (!TZN)
			TZN = P.tree('tzn');
		var get = function (k) {
			var v = TZN.get(name, [k]);

			return typeof v === 'string' && v ? v : null;
		};
		var hour = get('hourFormat'), l = {
			name: name, names: {},
			gmt: get('gmtFormat') || 'GMT{0}',
			region: get('regionFormat') || '{0}',
			fallback: get('fallbackFormat') || '{1} ({0})'
		};
		var sep = hour ? hour.indexOf(';') : -1;

		l.hm = sep >= 0 ? [hour.slice(0, sep), hour.slice(sep + 1)] :
			['+H:mm', '-H:mm'];
		l.gmtPrefix = unquote(l.gmt.slice(0, l.gmt.indexOf('{0}')));
		l.gmtSuffix = unquote(l.gmt.slice(l.gmt.indexOf('{0}') + 3));
		LOCALES[name] = l;
		return l;
	}

	function unquote(s) {
		return s.replace(/'([^']*)'/g, function (m, q) {
			return q === '' ? "'" : q;
		});
	}

	var TYPES = ['lg', 'ls', 'ld', 'sg', 'ss', 'sd', 'ec'];

	/* ZNamesLoader: each name type from the nearest bundle that has it,
	 * ∅∅∅ stopping the search with no name */
	function znames(l, key) {
		if (own(l.names, key))
			return l.names[key];
		var out = {}, its = TZN.items(l.name, [key], l.name), i, j;

		for (i = 0; i < its.length; i++) {
			var t = its[i].value;

			if (!t || typeof t !== 'object')
				continue;
			for (j = 0; j < TYPES.length; j++) {
				var k = TYPES[j];

				if (own(out, k) === undefined && typeof t[k] === 'string')
					out[k] = t[k] === '\u2205\u2205\u2205' ? '' : t[k];
			}
		}
		l.names[key] = out;
		return out;
	}

	function zoneName(l, tzid, type) {
		return znames(l, tzid.replace(/\//g, ':'))[type] || '';
	}

	function metaName(l, mz, type) {
		return mz ? znames(l, 'meta:' + mz)[type] || '' : '';
	}

	/* getDefaultExemplarLocationName */
	function defaultExemplar(tzid) {
		if (!tzid || /^(Etc|SystemV)\//.test(tzid) ||
		    tzid.indexOf('Riyadh8') > 0)
			return '';
		var sep = tzid.lastIndexOf('/');

		return sep > 0 && sep + 1 < tzid.length ?
			tzid.slice(sep + 1).replace(/_/g, ' ') : '';
	}

	function exemplar(l, tzid) {
		var ec = znames(l, tzid.replace(/\//g, ':')).ec;

		return ec || defaultExemplar(tzid);
	}

	/* ZoneMeta::getMetazoneID */
	function metazone(tzid, date) {
		if (!META)
			META = JSON.parse(N.pak('tz:meta'));
		var list = own(META.z, tzid) || [], i;

		for (i = 0; i < list.length; i++) {
			if (date >= list[i][1] && date < list[i][2])
				return list[i][0];
		}
		return '';
	}

	function referenceZone(mz, region) {
		if (!META)
			META = JSON.parse(N.pak('tz:meta'));
		var m = own(META.m, mz);

		return m ? own(m, region) || own(m, '001') || '' : '';
	}

	/* TimeZoneNames::getDisplayName */
	function displayName(l, tzid, type, date) {
		var n = zoneName(l, tzid, type);

		return n || metaName(l, metazone(tzid, date), type);
	}

	/* TZGNCore::getGenericLocationName */
	function genericLocation(f, l, tzid) {
		var country = own(index().r, tzid);

		if (!country)
			return '';
		var place = INDEX.primary[tzid] ? f.regionName(country) :
			exemplar(l, tzid);

		return P.simpleFormat(l.region, [place]);
	}

	/* TZGNCore::getPartialLocationName */
	function partialLocation(f, l, tzid, mz, mzName) {
		var country = own(index().r, tzid), location;

		if (country) {
			location = referenceZone(mz, country) === tzid ?
				f.regionName(country) : exemplar(l, tzid);
		} else {
			location = exemplar(l, tzid) || tzid;
		}
		return P.simpleFormat(l.fallback, [location, mzName]);
	}

	var DST_CHECK = 184 * DAY;

	/* TZGNCore::formatGenericNonLocationName */
	function genericNonLocation(f, l, zone, isLong, date) {
		var tzid = zone.canonical;
		var name = zoneName(l, tzid, isLong ? 'lg' : 'sg');

		if (name)
			return name;
		var mz = metazone(tzid, date);

		if (!mz)
			return '';
		var off = zone.tz.offsets(date, false), raw = off[0], sav = off[1];
		var useStandard = false;

		if (sav === 0) {
			useStandard = true;
			var before = zone.tz.previous(date, true);

			if (before && date - before.time < DST_CHECK &&
			    before.fromDst !== 0) {
				useStandard = false;
			} else {
				var after = zone.tz.next(date, false);

				if (after && after.time - date < DST_CHECK &&
				    after.toDst !== 0)
					useStandard = false;
			}
		}
		name = '';
		if (useStandard) {
			var std = displayName(l, tzid, isLong ? 'ls' : 'ss', date);

			if (std) {
				name = std;
				var gen = metaName(l, mz, isLong ? 'lg' : 'sg');

				if (std.toLowerCase() === gen.toLowerCase())
					name = '';
			}
		}
		if (!name) {
			var mzName = metaName(l, mz, isLong ? 'lg' : 'sg');

			if (mzName) {
				var golden = referenceZone(mz, f.targetRegion);

				if (golden && golden !== tzid) {
					var g = create(golden);
					var o1 = g.tz.offsets(date + raw + sav, true);

					name = raw !== o1[0] || sav !== o1[1] ?
						partialLocation(f, l, tzid, mz, mzName) : mzName;
				} else {
					name = mzName;
				}
			}
		}
		return name;
	}

	/* formatOffsetLocalizedGMT */
	function localizedGMT(f, l, offset, isShort) {
		var positive = offset >= 0, a = Math.abs(offset);
		var h = Math.floor(a / HOUR), m = Math.floor(a / MINUTE) % 60,
			s = Math.floor(a / 1000) % 60;
		var pat = l.hm[positive ? 0 : 1];

		if (s)
			pat = expand(pat);
		else if (!m && isShort)
			pat = truncate(pat);
		var out = '', i = 0, q = false, digits = f.num.digits;

		function dig(n, min) {
			var str = n < 10 ? (min === 2 ? digits[0] : '') + digits[n] :
				digits[Math.floor(n / 10)] + digits[n % 10];

			return str;
		}
		while (i < pat.length) {
			var c = pat.charAt(i);

			if (c === "'") {
				if (pat.charAt(i + 1) === "'") {
					out += "'";
					i += 2;
					continue;
				}
				q = !q;
				i++;
				continue;
			}
			if (!q && (c === 'H' || c === 'm' || c === 's')) {
				var j = i;

				while (j < pat.length && pat.charAt(j) === c)
					j++;
				out += c === 'H' ? dig(h, isShort ? 1 : 2) :
					dig(c === 'm' ? m : s, 2);
				i = j;
				continue;
			}
			out += c;
			i++;
		}
		return l.gmtPrefix + out + l.gmtSuffix;
	}

	/* expandOffsetPattern: H:mm to H:mm:ss */
	function expand(hm) {
		var mm = hm.indexOf('mm'), h = hm.slice(0, mm).lastIndexOf('H');
		var sep = h >= 0 ? hm.slice(h + 1, mm) : '';

		return hm.slice(0, mm + 2) + sep + 'ss' + hm.slice(mm + 2);
	}

	/* truncateOffsetPattern: H:mm to H */
	function truncate(hm) {
		var mm = hm.indexOf('mm'), head = hm.slice(0, mm);
		var hh = head.lastIndexOf('HH');

		if (hh >= 0)
			return hm.slice(0, hh + 2);
		return hm.slice(0, head.lastIndexOf('H') + 1);
	}

	/* TimeZoneFormat::format for a pattern field: z, zzzz, v, vvvv, O,
	 * OOOO, VVVV; f is vita/js/intl.js's formatter, t the moment */
	function format(f, ch, count, t) {
		var zone = t.zone, l = locale(f.zoneLocale), date = t.utc;
		var off = zone.tz.offsets(date, false), name = '', longForm;

		if (ch === 'z') {
			longForm = count >= 4;
			if (!zone.custom)
				name = displayName(l, zone.canonical, off[1] !== 0 ?
					(longForm ? 'ld' : 'sd') : (longForm ? 'ls' : 'ss'),
					date);
		} else if (ch === 'v') {
			longForm = count === 4;
			if (!zone.custom) {
				name = genericNonLocation(f, l, zone, longForm, date);
				if (!name)
					name = genericLocation(f, l, zone.canonical);
			}
		} else if (ch === 'V' && count === 4) {
			longForm = true;
			if (!zone.custom)
				name = genericLocation(f, l, zone.canonical);
		} else if (ch === 'O') {
			longForm = count === 4;
		} else {
			return '';
		}
		return name || localizedGMT(f, l, off[0] + off[1], !longForm);
	}

	function zones() {
		return Object.keys(index().r).sort();
	}

	return {
		create: create,
		fromOption: fromOption,
		resolvedName: resolvedName,
		format: format,
		zones: zones
	};
};

if (typeof module !== 'undefined')
	module.exports = __vitaIntlZone;
