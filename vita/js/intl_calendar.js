/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Calendars other than the Gregorian one for Intl.DateTimeFormat
 * (VitaSurf), as V8 has them from ICU.
 *
 * Each is ICU's handleComputeFields, line by line, so that a day falls in
 * the same month and year as it does in V8: the Buddhist, ROC and Japanese
 * calendars on ICU's Gregorian one with its Julian years before October
 * 1582 (V8 makes only the Gregorian and ISO calendars proleptic), the
 * Japanese eras from ICU's era rules, the Islamic calendars (the
 * astronomical one on ICU's CalendarAstronomer, civil, tabular and Umm
 * al-Qura with its table), Persian with ICU's leap corrections, Hebrew,
 * Indian, Coptic and Ethiopian, and the Chinese and Dangi calendars from
 * CalendarAstronomer's solar terms and new moons, in UTC+8 and in ICU's
 * Korean zone. ICU caches the years and months these find; so does this,
 * a bounded number of them.
 *
 * And the algorithmic numbering systems date patterns ask for in their
 * number overrides (Hebrew numerals, Chinese day names, Roman months, the
 * Japanese first year), with ICU's own rules from resources/intl.pak and
 * as much of RuleBasedNumberFormat as those rules use.
 *
 * __vitaIntlCalendar(N) takes the pack reader and has no browser
 * dependencies, so that it runs under Node.
 */
var __vitaIntlCalendar = function (N) {
	'use strict';

	var DAY = 86400000, EPOCH_JD = 2440588;
	var floor = Math.floor, trunc = Math.trunc;

	/* a cache of at most 256 entries, emptied when full */
	function Cache() {
		this.map = new Map();
	}
	Cache.prototype.get = function (k) {
		return this.map.get(k);
	};
	Cache.prototype.put = function (k, v) {
		if (this.map.size >= 256)
			this.map.clear();
		this.map.set(k, v);
		return v;
	};

	/* ---- Grego ---- */

	function isLeap(y) {
		return (y & 3) === 0 && (y % 100 !== 0 || y % 400 === 0);
	}

	/* proleptic Gregorian: days from 1970 to [year, month (0 first),
	 * day, day of the year (1 first)] and back */
	function fieldsToDay(y, m, d) {
		m += 1;
		var yy = y - (m <= 2 ? 1 : 0);
		var era = floor(yy / 400), yoe = yy - era * 400;
		var doy = floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;

		return era * 146097 + yoe * 365 + floor(yoe / 4) -
			floor(yoe / 100) + doy - 719468;
	}

	function dayToFields(z) {
		var days = z;

		z += 719468;
		var era = floor(z / 146097), doe = z - era * 146097;
		var yoe = floor((doe - floor(doe / 1460) + floor(doe / 36524) -
			floor(doe / 146096)) / 365);
		var y = yoe + era * 400, doy = doe - (365 * yoe + floor(yoe / 4) -
			floor(yoe / 100)), mp = floor((5 * doy + 2) / 153);
		var d = doy - floor((153 * mp + 2) / 5) + 1;
		var m = mp + (mp < 10 ? 3 : -9);

		y += m <= 2 ? 1 : 0;
		return [y, m - 1, d, days - fieldsToDay(y, 0, 1) + 1];
	}

	/* GregorianCalendar::handleComputeFields with its default change
	 * to the Gregorian calendar, 15 October 1582 */
	var NUM_DAYS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
	var LEAP_NUM_DAYS = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305,
		335];

	function gregorian(jd) {
		var eyear, month, dom, doy;

		if (jd >= 2299161) {
			var g = dayToFields(jd - EPOCH_JD);

			eyear = g[0];
			month = g[1];
			dom = g[2];
			doy = g[3];
			if (eyear === 1582)
				doy += floor((eyear - 1) / 400) -
					floor((eyear - 1) / 100) + 2;
		} else {
			var jed = jd - (1721426 - 2);

			eyear = floor((4 * jed + 1464) / 1461);
			var jan1 = 365 * (eyear - 1) + floor((eyear - 1) / 4);

			doy = jed - jan1;
			var leap = (eyear & 3) === 0, corr = 0;

			if (doy >= (leap ? 60 : 59))
				corr = leap ? 1 : 2;
			month = trunc((12 * (doy + corr) + 6) / 367);
			dom = doy - (leap ? LEAP_NUM_DAYS : NUM_DAYS)[month] + 1;
			doy++;
		}
		return { ext: eyear, month: month, day: dom, doy: doy };
	}

	function result(era, year, ext, month, day, doy, related) {
		return { era: era, year: year, ext: ext, month: month, leap: 0,
			day: day, dayOfYear: doy, related: related };
	}

	/* ---- eras ---- */

	var ERAS = null;

	/* EraRules::getEraCode for the Japanese calendar */
	function eraCode(type, y, m, d) {
		if (!ERAS)
			ERAS = JSON.parse(N.pak('dt:eras'));
		var list = ERAS[type], i;

		if (y < -32768)
			return 0;
		var date = y * 65536 + m * 256 + d;

		for (i = list.length - 1; i >= 0; i--) {
			var s = list[i];

			if (s && (y > 32767 || s[0] * 65536 + s[1] * 256 + s[2] <=
			    date))
				return i;
		}
		return 0;
	}

	/* ---- CalendarAstronomer ---- */

	var PI = 3.14159265358979323846, PI2 = PI * 2.0;
	var SYNODIC_MONTH = 29.530588853, TROPICAL_YEAR = 365.242191;
	var JULIAN_EPOCH_MS = -210866760000000.0, JD_EPOCH = 2447891.5;
	var SUN_ETA_G = 279.403303 * PI / 180, SUN_OMEGA_G = 282.768422 * PI / 180;
	var SUN_E = 0.016713;
	var MOON_L0 = 318.351648 * PI / 180, MOON_P0 = 36.340410 * PI / 180;
	var MOON_N0 = 318.510107 * PI / 180, MOON_I = 5.145366 * PI / 180;

	function normalize(value, range) {
		return value - range * floor(value / range);
	}

	function norm2PI(a) {
		return normalize(a, PI * 2.0);
	}

	function normPI(a) {
		return normalize(a + PI, PI * 2.0) - PI;
	}

	function trueAnomaly(meanAnomaly, e) {
		var delta, E = meanAnomaly;

		do {
			delta = E - e * Math.sin(E) - meanAnomaly;
			E = E - delta / (1 - e * Math.cos(E));
		} while (Math.abs(delta) > 1e-5);
		return 2.0 * Math.atan(Math.tan(E / 2) * Math.sqrt((1 + e) /
			(1 - e)));
	}

	/* the sun's longitude and mean anomaly at a time */
	function sun(time) {
		var day = (time - JULIAN_EPOCH_MS) / DAY - JD_EPOCH;
		var epochAngle = norm2PI(PI2 / TROPICAL_YEAR * day);
		var meanAnomaly = norm2PI(epochAngle + SUN_ETA_G - SUN_OMEGA_G);

		return [norm2PI(trueAnomaly(meanAnomaly, SUN_E) + SUN_OMEGA_G),
			meanAnomaly];
	}

	function sunLongitude(time) {
		return sun(time)[0];
	}

	/* getMoonAge: the moon's ecliptic longitude less the sun's */
	function moonAge(time) {
		var s = sun(time), sunLong = s[0], meanAnomalySun = s[1];
		var day = (time - JULIAN_EPOCH_MS) / DAY - JD_EPOCH;
		var meanLongitude = norm2PI(13.1763966 * PI / 180 * day + MOON_L0);
		var meanAnomalyMoon = norm2PI(meanLongitude - 0.1114041 * PI /
			180 * day - MOON_P0);
		var evection = 1.2739 * PI / 180 * Math.sin(2 * (meanLongitude -
			sunLong) - meanAnomalyMoon);
		var annual = 0.1858 * PI / 180 * Math.sin(meanAnomalySun);
		var a3 = 0.3700 * PI / 180 * Math.sin(meanAnomalySun);

		meanAnomalyMoon += evection - annual - a3;
		var center = 6.2886 * PI / 180 * Math.sin(meanAnomalyMoon);
		var a4 = 0.2140 * PI / 180 * Math.sin(2 * meanAnomalyMoon);
		var moonLongitude = meanLongitude + evection + center - annual + a4;
		var variation = 0.6583 * PI / 180 * Math.sin(2 * (moonLongitude -
			sunLong));

		moonLongitude += variation;
		var nodeLongitude = norm2PI(MOON_N0 - 0.0529539 * PI / 180 * day);

		nodeLongitude -= 0.16 * PI / 180 * Math.sin(meanAnomalySun);
		var y = Math.sin(moonLongitude - nodeLongitude);
		var x = Math.cos(moonLongitude - nodeLongitude);
		var eclipLong = Math.atan2(y * Math.cos(MOON_I), x) + nodeLongitude;

		return norm2PI(eclipLong - sunLong);
	}

	/* timeOfAngle: when func next (or last) reaches the angle */
	function timeOfAngle(func, time, desired, periodDays, epsilon, next) {
		var lastAngle = func(time);
		var deltaAngle = norm2PI(desired - lastAngle);
		var deltaT = (deltaAngle + (next ? 0.0 : -PI2)) *
			(periodDays * DAY) / PI2;
		var lastDeltaT = deltaT, startTime = time;

		time = time + Math.ceil(deltaT);
		do {
			var angle = func(time);
			var factor = Math.abs(deltaT / normPI(angle - lastAngle));

			deltaT = normPI(desired - angle) * factor;
			if (Math.abs(deltaT) > Math.abs(lastDeltaT)) {
				var delta = Math.ceil(periodDays * DAY / 8.0);

				return timeOfAngle(func, startTime + (next ? delta : -delta),
						   desired, periodDays, epsilon, next);
			}
			lastDeltaT = deltaT;
			lastAngle = angle;
			time = time + Math.ceil(deltaT);
		} while (Math.abs(deltaT) > epsilon);
		return time;
	}

	/* ---- Islamic calendars ---- */

	var HIJRA_MILLIS = -42521587200000.0;
	var CIVIL_EPOC = 1948440, ASTRONOMICAL_EPOC = 1948439;
	var UMALQURA_YEAR_START = 1300, UMALQURA_YEAR_END = 1600;
	var UMALQURA_MONTHLENGTH = [
		0x0AAA, 0x0D54, 0x0EC9, 0x06D4, 0x06EA, 0x036C, 0x0AAD, 0x0555,
		0x06A9, 0x0792, 0x0BA9, 0x05D4, 0x0ADA, 0x055C, 0x0D2D, 0x0695,
		0x074A, 0x0B54, 0x0B6A, 0x05AD, 0x04AE, 0x0A4F, 0x0517, 0x068B,
		0x06A5, 0x0AD5, 0x02D6, 0x095B, 0x049D, 0x0A4D, 0x0D26, 0x0D95,
		0x05AC, 0x09B6, 0x02BA, 0x0A5B, 0x052B, 0x0A95, 0x06CA, 0x0AE9,
		0x02F4, 0x0976, 0x02B6, 0x0956, 0x0ACA, 0x0BA4, 0x0BD2, 0x05D9,
		0x02DC, 0x096D, 0x054D, 0x0AA5, 0x0B52, 0x0BA5, 0x05B4, 0x09B6,
		0x0557, 0x0297, 0x054B, 0x06A3, 0x0752, 0x0B65, 0x056A, 0x0AAB,
		0x052B, 0x0C95, 0x0D4A, 0x0DA5, 0x05CA, 0x0AD6, 0x0957, 0x04AB,
		0x094B, 0x0AA5, 0x0B52, 0x0B6A, 0x0575, 0x0276, 0x08B7, 0x045B,
		0x0555, 0x05A9, 0x05B4, 0x09DA, 0x04DD, 0x026E, 0x0936, 0x0AAA,
		0x0D54, 0x0DB2, 0x05D5, 0x02DA, 0x095B, 0x04AB, 0x0A55, 0x0B49,
		0x0B64, 0x0B71, 0x05B4, 0x0AB5, 0x0A55, 0x0D25, 0x0E92, 0x0EC9,
		0x06D4, 0x0AE9, 0x096B, 0x04AB, 0x0A93, 0x0D49, 0x0DA4, 0x0DB2,
		0x0AB9, 0x04BA, 0x0A5B, 0x052B, 0x0A95, 0x0B2A, 0x0B55, 0x055C,
		0x04BD, 0x023D, 0x091D, 0x0A95, 0x0B4A, 0x0B5A, 0x056D, 0x02B6,
		0x093B, 0x049B, 0x0655, 0x06A9, 0x0754, 0x0B6A, 0x056C, 0x0AAD,
		0x0555, 0x0B29, 0x0B92, 0x0BA9, 0x05D4, 0x0ADA, 0x055A, 0x0AAB,
		0x0595, 0x0749, 0x0764, 0x0BAA, 0x05B5, 0x02B6, 0x0A56, 0x0E4D,
		0x0B25, 0x0B52, 0x0B6A, 0x05AD, 0x02AE, 0x092F, 0x0497, 0x064B,
		0x06A5, 0x06AC, 0x0AD6, 0x055D, 0x049D, 0x0A4D, 0x0D16, 0x0D95,
		0x05AA, 0x05B5, 0x02DA, 0x095B, 0x04AD, 0x0595, 0x06CA, 0x06E4,
		0x0AEA, 0x04F5, 0x02B6, 0x0956, 0x0AAA, 0x0B54, 0x0BD2, 0x05D9,
		0x02EA, 0x096D, 0x04AD, 0x0A95, 0x0B4A, 0x0BA5, 0x05B2, 0x09B5,
		0x04D6, 0x0A97, 0x0547, 0x0693, 0x0749, 0x0B55, 0x056A, 0x0A6B,
		0x052B, 0x0A8B, 0x0D46, 0x0DA3, 0x05CA, 0x0AD6, 0x04DB, 0x026B,
		0x094B, 0x0AA5, 0x0B52, 0x0B69, 0x0575, 0x0176, 0x08B7, 0x025B,
		0x052B, 0x0565, 0x05B4, 0x09DA, 0x04ED, 0x016D, 0x08B6, 0x0AA6,
		0x0D52, 0x0DA9, 0x05D4, 0x0ADA, 0x095B, 0x04AB, 0x0653, 0x0729,
		0x0762, 0x0BA9, 0x05B2, 0x0AB5, 0x0555, 0x0B25, 0x0D92, 0x0EC9,
		0x06D2, 0x0AE9, 0x056B, 0x04AB, 0x0A55, 0x0D29, 0x0D54, 0x0DAA,
		0x09B5, 0x04BA, 0x0A3B, 0x049B, 0x0A4D, 0x0AAA, 0x0AD5, 0x02DA,
		0x095D, 0x045E, 0x0A2E, 0x0C9A, 0x0D55, 0x06B2, 0x06B9, 0x04BA,
		0x0A5D, 0x052D, 0x0A95, 0x0B52, 0x0BA8, 0x0BB4, 0x05B9, 0x02DA,
		0x095A, 0x0B4A, 0x0DA4, 0x0ED1, 0x06E8, 0x0B6A, 0x056D, 0x0535,
		0x0695, 0x0D4A, 0x0DA8, 0x0DD4, 0x06DA, 0x055B, 0x029D, 0x062B,
		0x0B15, 0x0B4A, 0x0B95, 0x05AA, 0x0AAE, 0x092E, 0x0C8F, 0x0527,
		0x0695, 0x06AA, 0x0AD6, 0x055D, 0x029D
	];
	/* umAlQuraYrStartEstimateFix, from 1300 */
	var UMALQURA_FIX = [
		0, 0, -1, 0, -1, 0, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 0, -1, 0,
		1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
		0, 0, 1, 0, 0, -1, -1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1, 1, 0,
		0, 0, 0, 0, 0, 0, 0, -1, 0, 0, 0, 1, 1, 0, 0, -1, 0, 1, 0, 1,
		1, 0, 0, -1, 0, 1, 0, 0, 0, -1, 0, 1, 0, 1, 0, 0, 0, -1, 0, 0,
		0, 0, -1, -1, 0, -1, 0, 1, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0, 0,
		0, 1, 0, 0, -1, -1, 0, 0, 0, 1, 0, 0, -1, -1, 0, -1, 0, 0, -1, -1,
		0, -1, 0, -1, 0, 0, -1, -1, 0, 0, 0, 0, 0, 0, -1, 0, 1, 0, 1, 1,
		0, 0, -1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, -1, 0, 1, 0,
		0, -1, -1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0,
		1, 0, 0, -1, 0, 0, 0, 1, 1, 0, 0, -1, 0, 1, 0, 1, 1, 0, 0, 0,
		0, 1, 0, 0, 0, -1, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 0, 0, -1,
		0, -1, 0, 1, 0, 0, 0, -1, 0, 1, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0,
		-1, 0, 0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, 0, -1, -1, 0, -1, 0, 1,
		0, 0, -1, -1, 0, 0, 1, 1, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0,
		1
	];

	function civilLeapYear(y) {
		return (14 + 11 * y) % 30 < 11;
	}

	var MONTH_STARTS = new Cache();

	/* trueMonthStart: the day, from the Hijra, a lunar month starts */
	function trueMonthStart(month) {
		var start = MONTH_STARTS.get(month);

		if (start !== undefined)
			return start;
		var origin = HIJRA_MILLIS + floor(month * SYNODIC_MONTH) * DAY;
		var age = islamicMoonAge(origin);

		if (age >= 0) {
			do {
				origin -= DAY;
				age = islamicMoonAge(origin);
			} while (age >= 0);
		} else {
			do {
				origin += DAY;
				age = islamicMoonAge(origin);
			} while (age < 0);
		}
		return MONTH_STARTS.put(month, floor((origin - HIJRA_MILLIS) / DAY) +
			1);
	}

	function islamicMoonAge(time) {
		var age = moonAge(time) * 180 / PI;

		return age > 180 ? age - 360 : age;
	}

	/* IslamicCalendar::getRelatedYear */
	function islamicRelated(year) {
		var cycle, offset, shift = 0;

		if (year >= 1397) {
			cycle = trunc((year - 1397) / 67);
			offset = (year - 1397) % 67;
			shift = 2 * cycle + (offset >= 33 ? 1 : 0);
		} else {
			cycle = trunc((year - 1396) / 67) - 1;
			offset = -(year - 1396) % 67;
			shift = 2 * cycle + (offset <= 33 ? 1 : 0);
		}
		return year + 579 - shift;
	}

	function islamicResult(year, month, dom, doy) {
		return result(0, year, year, month, dom, doy, islamicRelated(year));
	}

	/* IslamicCalendar (astronomical, and islamic-rgsa, which is the
	 * same) */
	function islamic(jd, utc) {
		var days = jd - CIVIL_EPOC;
		var month = floor(days / SYNODIC_MONTH);
		var startDate = floor(month * SYNODIC_MONTH);

		if (days - startDate >= 25 && islamicMoonAge(utc) > 0)
			month++;
		while ((startDate = trueMonthStart(month)) > days)
			month--;
		var year = month >= 0 ? trunc(month / 12) + 1 :
			trunc((month + 1) / 12);

		month = ((month % 12) + 12) % 12;
		return islamicResult(year, month,
			days - trueMonthStart(12 * (year - 1) + month) + 1,
			days - trueMonthStart(12 * (year - 1)) + 1);
	}

	function civilYearStart(year) {
		return 354 * (year - 1) + floor((3 + 11 * year) / 30);
	}

	function civilMonthStart(year, month) {
		return Math.ceil(29.5 * month) + 354 * (year - 1) +
			floor((11 * year + 3) / 30);
	}

	function civilMonthLength(year, month) {
		var length = 29 + (month + 1) % 2;

		if (month === 11 && civilLeapYear(year))
			length++;
		return length;
	}

	/* IslamicCivilCalendar::handleComputeFields, over a calendar's
	 * year and month starts */
	function civilFields(days, yearStart, monthStart) {
		var year = floor((30 * days + 10646) / 10631);
		var month = Math.ceil((days - 29 - yearStart(year)) / 29.5) | 0;

		month = month < 11 ? month : 11;
		return islamicResult(year, month,
			days - monthStart(year, month) + 1,
			days - monthStart(year, 0) + 1);
	}

	function umalquraYearStart(year) {
		if (year < UMALQURA_YEAR_START || year > UMALQURA_YEAR_END)
			return civilYearStart(year);
		year -= UMALQURA_YEAR_START;
		return trunc(354.36720 * year + 460322.05 + 0.5) +
			UMALQURA_FIX[year];
	}

	function umalquraMonthLength(year, month) {
		if (year < UMALQURA_YEAR_START || year > UMALQURA_YEAR_END)
			return civilMonthLength(year, month);
		return UMALQURA_MONTHLENGTH[year - UMALQURA_YEAR_START] &
			(1 << (11 - month)) ? 30 : 29;
	}

	function umalquraMonthStart(year, month) {
		var ms = umalquraYearStart(year), i;

		for (i = 0; i < month; i++)
			ms += umalquraMonthLength(year, i);
		return ms;
	}

	function umalquraYearLength(year) {
		if (year < UMALQURA_YEAR_START || year > UMALQURA_YEAR_END)
			return 354 + (civilLeapYear(year) ? 1 : 0);
		var length = 0, i;

		for (i = 0; i < 12; i++)
			length += umalquraMonthLength(year, i);
		return length;
	}

	function umalqura(jd) {
		var days = jd - CIVIL_EPOC;

		if (days < umalquraYearStart(UMALQURA_YEAR_START))
			return civilFields(days, umalquraYearStart, umalquraMonthStart);
		var year = trunc((days - (460322.05 + 0.5)) / 354.36720) +
			UMALQURA_YEAR_START - 1;
		var month = 0, d = 1;

		while (d > 0) {
			d = days - umalquraYearStart(++year) + 1;
			var length = umalquraYearLength(year);

			if (d === length) {
				month = 11;
				break;
			}
			if (d < length) {
				var monthLen = umalquraMonthLength(year, month);

				for (month = 0; d > monthLen;
				     monthLen = umalquraMonthLength(year, ++month))
					d -= monthLen;
				break;
			}
		}
		return islamicResult(year, month,
			days - umalquraMonthStart(year, month) + 1,
			days - umalquraMonthStart(year, 0) + 1);
	}

	/* ---- Persian ---- */

	var PERSIAN_NUM_DAYS = [0, 31, 62, 93, 124, 155, 186, 216, 246, 276,
		306, 336];
	var PERSIAN_NON_LEAP = {};

	[1502, 1601, 1634, 1667, 1700, 1733, 1766, 1799, 1832, 1865, 1898, 1931,
	 1964, 1997, 2030, 2059, 2063, 2096, 2129, 2158, 2162, 2191, 2195, 2224,
	 2228, 2257, 2261, 2290, 2294, 2323, 2327, 2356, 2360, 2389, 2393, 2422,
	 2426, 2455, 2459, 2488, 2492, 2521, 2525, 2554, 2558, 2587, 2591, 2620,
	 2624, 2653, 2657, 2686, 2690, 2719, 2723, 2748, 2752, 2756, 2781, 2785,
	 2789, 2818, 2822, 2847, 2851, 2855, 2880, 2884, 2888, 2913, 2917, 2921,
	 2946, 2950, 2954, 2979, 2983, 2987].forEach(function (y) {
		PERSIAN_NON_LEAP[y] = 1;
	});

	function persianFirstDay(year) {
		return 365 * (year - 1) + floor((8 * year + 21) / 33) -
			(PERSIAN_NON_LEAP[year - 1] ? 1 : 0);
	}

	function persian(jd) {
		var days = jd - 1948320;
		var year = floor((33 * days + 3) / 12053) + 1;
		var doy = days - persianFirstDay(year);

		if (doy === 365 && PERSIAN_NON_LEAP[year]) {
			year++;
			doy = 0;
		}
		var month = doy < 216 ? trunc(doy / 31) : trunc((doy - 6) / 30);

		doy++;
		return result(0, year, year, month, doy - PERSIAN_NUM_DAYS[month],
			      doy, year + 622);
	}

	/* ---- Hebrew ---- */

	var HOUR_PARTS = 1080, DAY_PARTS = 24 * HOUR_PARTS;
	var MONTH_FRACT = 12 * HOUR_PARTS + 793;
	var MONTH_PARTS = 29 * DAY_PARTS + MONTH_FRACT;
	var BAHARAD = 11 * HOUR_PARTS + 204;
	var MONTH_START = [[0, 0, 0], [30, 30, 30], [59, 59, 60], [88, 89, 90],
		[117, 118, 119], [147, 148, 149], [147, 148, 149], [176, 177, 178],
		[206, 207, 208], [235, 236, 237], [265, 266, 267], [294, 295, 296],
		[324, 325, 326], [353, 354, 355]];
	var LEAP_MONTH_START = [[0, 0, 0], [30, 30, 30], [59, 59, 60],
		[88, 89, 90], [117, 118, 119], [147, 148, 149], [177, 178, 179],
		[206, 207, 208], [236, 237, 238], [265, 266, 267], [295, 296, 297],
		[324, 325, 326], [354, 355, 356], [383, 384, 385]];
	var YEAR_STARTS = new Cache();

	function hebrewLeap(year) {
		var x = (year * 12 + 17) % 19;

		return x >= (x < 0 ? -7 : 12);
	}

	function startOfYear(year) {
		var day = YEAR_STARTS.get(year);

		if (day !== undefined)
			return day;
		var months = floor((235 * year - 234) / 19);
		var frac = months * MONTH_FRACT + BAHARAD;

		day = months * 29 + trunc(frac / DAY_PARTS);
		frac = frac % DAY_PARTS;
		var wd = day % 7;

		if (wd === 2 || wd === 4 || wd === 6)
			day += 1;
		else if (wd === 1 && frac > 15 * HOUR_PARTS + 204 && !hebrewLeap(year))
			day += 2;
		else if (wd === 0 && frac > 21 * HOUR_PARTS + 589 &&
			 hebrewLeap(year - 1))
			day += 1;
		return YEAR_STARTS.put(year, day);
	}

	function yearType(year) {
		var len = startOfYear(year + 1) - startOfYear(year);

		if (len > 380)
			len -= 30;
		return len === 353 ? 0 : len === 355 ? 2 : 1;
	}

	function hebrew(jd) {
		var d = jd - 347997;
		var m = floor(d * DAY_PARTS / MONTH_PARTS);
		var year = trunc(floor((19 * m + 234) / 235) + 1);
		var ys = startOfYear(year), doy = d - ys;

		while (doy < 1) {
			year--;
			ys = startOfYear(year);
			doy = d - ys;
		}
		var type = yearType(year), leap = hebrewLeap(year);
		var table = leap ? LEAP_MONTH_START : MONTH_START, month = 0;

		while (month < table.length && doy > table[month][type])
			month++;
		month--;
		year = Math.max(-5000000, Math.min(5000000, year));
		var r = result(0, year, year, month, doy - table[month][type], doy,
			       year - 3760);

		r.hebrewLeap = leap;
		return r;
	}

	/* ---- Indian ---- */

	function indian(jd) {
		var days = jd - EPOCH_JD, gy = dayToFields(days)[0];
		var year = gy - 78, yday = days - fieldsToDay(gy, 0, 1);
		var leapMonth, month, dom;

		if (yday < 80) {
			year -= 1;
			leapMonth = isLeap(gy - 1) ? 31 : 30;
			yday += leapMonth + 31 * 5 + 30 * 3 + 10;
		} else {
			leapMonth = isLeap(gy) ? 31 : 30;
			yday -= 80;
		}
		if (yday < leapMonth) {
			month = 0;
			dom = yday + 1;
		} else {
			var mday = yday - leapMonth;

			if (mday < 31 * 5) {
				month = trunc(mday / 31) + 1;
				dom = mday % 31 + 1;
			} else {
				mday -= 31 * 5;
				month = trunc(mday / 30) + 6;
				dom = mday % 30 + 1;
			}
		}
		return result(0, year, year, month, dom, yday + 1, year + 79);
	}

	/* ---- Coptic and Ethiopian ---- */

	function ce(jd, offset) {
		var j = jd - offset, c4 = floor(j / 1461), r4 = j - c4 * 1461;
		var doy = r4 === 1460 ? 365 : r4 % 365;

		return { year: 4 * c4 + (trunc(r4 / 365) - trunc(r4 / 1460)),
			month: trunc(doy / 30), day: doy % 30 + 1, doy: doy + 1 };
	}

	/* ---- Chinese and Dangi ---- */

	var CHINA_OFFSET = 8 * 3600000;
	/* DangiCalendar's zone: UTC+8, +7 in 1897, +8 to 1911, then +9 */
	var KOREA = [(1897 - 1970) * 365 * DAY - 8 * 3600000,
		(1898 - 1970) * 365 * DAY - 7 * 3600000,
		(1912 - 1970) * 365 * DAY - 8 * 3600000];

	function koreaOffset(ms) {
		return ms < KOREA[0] ? 8 * 3600000 : ms < KOREA[1] ? 7 * 3600000 :
			ms < KOREA[2] ? 8 * 3600000 : 9 * 3600000;
	}

	function chinaOffset() {
		return CHINA_OFFSET;
	}

	function Chinese(offset) {
		this.offset = offset;
		this.solstices = new Cache();
		this.newYears = new Cache();
	}

	Chinese.prototype.daysToMillis = function (days) {
		var millis = days * DAY;

		return millis - this.offset(millis);
	};

	Chinese.prototype.millisToDays = function (millis) {
		return floor((millis + this.offset(millis)) / DAY);
	};

	Chinese.prototype.winterSolstice = function (gyear) {
		var v = this.solstices.get(gyear);

		if (v !== undefined)
			return v;
		var ms = this.daysToMillis(fieldsToDay(gyear, 11, 1));

		return this.solstices.put(gyear, this.millisToDays(timeOfAngle(
			sunLongitude, ms, PI * 3 / 2, TROPICAL_YEAR, 60000, true)));
	};

	Chinese.prototype.newMoonNear = function (days, after) {
		return this.millisToDays(timeOfAngle(moonAge, this.daysToMillis(days),
			0, SYNODIC_MONTH, 60000, after));
	};

	function synodicMonthsBetween(day1, day2) {
		var r = (day2 - day1) / SYNODIC_MONTH;

		return trunc(r + (r >= 0 ? 0.5 : -0.5));
	}

	Chinese.prototype.majorSolarTerm = function (days) {
		var term = (trunc(6 * sunLongitude(this.daysToMillis(days)) / PI) +
			2) % 12;

		return term < 1 ? term + 12 : term;
	};

	Chinese.prototype.hasNoMajorSolarTerm = function (newMoon) {
		return this.majorSolarTerm(newMoon) ===
			this.majorSolarTerm(this.newMoonNear(newMoon + 25, true));
	};

	Chinese.prototype.isLeapMonthBetween = function (newMoon1, newMoon2) {
		while (newMoon2 >= newMoon1) {
			if (this.hasNoMajorSolarTerm(newMoon2))
				return true;
			newMoon2 = this.newMoonNear(newMoon2 - 25, false);
		}
		return false;
	};

	Chinese.prototype.newYear = function (gyear) {
		var v = this.newYears.get(gyear);

		if (v !== undefined)
			return v;
		var solsticeBefore = this.winterSolstice(gyear - 1);
		var solsticeAfter = this.winterSolstice(gyear);
		var newMoon1 = this.newMoonNear(solsticeBefore + 1, true);
		var newMoon2 = this.newMoonNear(newMoon1 + 25, true);
		var newMoon11 = this.newMoonNear(solsticeAfter + 1, false);

		if (synodicMonthsBetween(newMoon1, newMoon11) === 12 &&
		    (this.hasNoMajorSolarTerm(newMoon1) ||
		     this.hasNoMajorSolarTerm(newMoon2)))
			v = this.newMoonNear(newMoon2 + 25, true);
		else
			v = newMoon2;
		return this.newYears.put(gyear, v);
	};

	/* computeMonthInfo: the month (1 first), whether it is a leap one,
	 * and the new moon it starts with */
	Chinese.prototype.monthInfo = function (gyear, days) {
		var solsticeBefore, solsticeAfter = this.winterSolstice(gyear);

		if (days < solsticeAfter) {
			solsticeBefore = this.winterSolstice(gyear - 1);
		} else {
			solsticeBefore = solsticeAfter;
			solsticeAfter = this.winterSolstice(gyear + 1);
		}
		/* the astronomer's solstices drift out of order tens of
		 * thousands of years away, and ICU gives up */
		if (!(solsticeBefore <= days && days < solsticeAfter)) {
			var e = new RangeError('Chinese calendar out of range');

			e.icu = true;
			throw e;
		}
		var firstMoon = this.newMoonNear(solsticeBefore + 1, true);
		var lastMoon = this.newMoonNear(solsticeAfter + 1, false);
		var thisMoon = this.newMoonNear(days + 1, false);
		var hasLeap = synodicMonthsBetween(firstMoon, lastMoon) === 12;
		var month = synodicMonthsBetween(firstMoon, thisMoon);

		if (hasLeap && this.isLeapMonthBetween(firstMoon, thisMoon))
			month--;
		if (month < 1)
			month += 12;
		var isLeapMonth = hasLeap && this.hasNoMajorSolarTerm(thisMoon) &&
			!this.isLeapMonthBetween(firstMoon,
				this.newMoonNear(thisMoon - 25, false));

		return { month: month, leap: isLeapMonth, thisMoon: thisMoon };
	};

	/* handleComputeMonthStart for a year's first month, as a day from
	 * 1970: ICU works out the month its new moon starts, which can fail
	 * too */
	Chinese.prototype.yearStart = function (eyear) {
		var newMoon = this.newMoonNear(this.newYear(eyear), true);
		var info = this.monthInfo(dayToFields(newMoon)[0], newMoon);

		if (info.month - 1 !== 0 || info.leap)
			newMoon = this.newMoonNear(newMoon + 25, true);
		return newMoon - 1;
	};

	/*
	 * Calendar::computeWeekFields needs the length of the year, or of the
	 * one before when the day is in the last week of that, and each
	 * length is two years' starts. Those only fail beyond the year 60000,
	 * so nearer ones are not worked out.
	 */
	Chinese.prototype.checkWeekFields = function (r, dow, week) {
		var relDowJan1 = (dow - r.dayOfYear + 7001 - week.first) % 7;
		var woy = trunc((r.dayOfYear - 1 + relDowJan1) / 7);

		if (7 - relDowJan1 >= week.min)
			woy++;
		var y = woy === 0 ? r.ext - 1 : r.ext;

		this.yearStart(y + 1);
		this.yearStart(y);
	};

	Chinese.prototype.fields = function (jd, week) {
		var days = jd - EPOCH_JD, g = dayToFields(days);
		var gyear = g[0], gmonth = g[1];
		var info = this.monthInfo(gyear, days);
		var eyear = gyear - 1, cycleYear = gyear + 2636;

		if (info.month < 11 || gmonth >= 6) {
			eyear++;
			cycleYear++;
		}
		var cycle = floor((cycleYear - 1) / 60);
		var yearOfCycle = cycleYear - 1 - cycle * 60;
		var theNewYear = this.newYear(gyear);

		if (days < theNewYear)
			theNewYear = this.newYear(gyear - 1);
		eyear = Math.max(-5000000, Math.min(5000000, eyear));
		var r = result(cycle + 1, yearOfCycle + 1, eyear, info.month - 1,
			       days - info.thisMoon + 1, days - theNewYear + 1, eyear);

		r.leap = info.leap ? 1 : 0;
		if (gyear > 60000 || gyear < -60000)
			this.checkWeekFields(r, ((days % 7) + 11) % 7 + 1, week);
		return r;
	};

	var CHINESE = null, DANGI = null;

	function chinese(type) {
		if (type === 'dangi')
			return DANGI || (DANGI = new Chinese(koreaOffset));
		return CHINESE || (CHINESE = new Chinese(chinaOffset));
	}

	/* ---- the calendars ---- */

	/*
	 * A day's fields in an ICU calendar: era, year (of the era), extended
	 * year, month (0 first), leap month, day of the month, day of the
	 * year, related Gregorian year, and for the Hebrew calendar whether
	 * the year is a leap one. days counts from 1970-01-01 in local time;
	 * utc is the moment, which the astronomical Islamic calendar looks
	 * at too; week is the locale's first day of the week (1 for Sunday)
	 * and minimal days in the first week, which the Chinese calendar
	 * looks at for a day so far off that ICU may fail on it. Throws an
	 * error with icu set where ICU's calendar fails.
	 */
	function fields(type, days, utc, week) {
		var jd = days + EPOCH_JD, g, y, c;

		switch (type) {
		case 'buddhist':
			g = gregorian(jd);
			return result(0, g.ext + 543, g.ext, g.month, g.day, g.doy, g.ext);
		case 'roc':
			g = gregorian(jd);
			y = g.ext - 1911;
			return result(y > 0 ? 1 : 0, y > 0 ? y : 1 - y, g.ext, g.month,
				      g.day, g.doy, g.ext);
		case 'japanese': {
			g = gregorian(jd);
			var code = eraCode('japanese', g.ext, g.month + 1, g.day);

			return result(code, g.ext - ERAS.japanese[code][0] + 1, g.ext,
				      g.month, g.day, g.doy, g.ext);
		}
		case 'islamic':
		case 'islamic-rgsa':
			return islamic(jd, utc);
		case 'islamic-civil':
			return civilFields(jd - CIVIL_EPOC, civilYearStart,
					   civilMonthStart);
		case 'islamic-tbla':
			return civilFields(jd - ASTRONOMICAL_EPOC, civilYearStart,
					   civilMonthStart);
		case 'islamic-umalqura':
			return umalqura(jd);
		case 'persian':
			return persian(jd);
		case 'hebrew':
			return hebrew(jd);
		case 'indian':
			return indian(jd);
		case 'coptic':
			c = ce(jd, 1824665);
			return result(c.year <= 0 ? 0 : 1, c.year <= 0 ? 1 - c.year :
				      c.year, c.year, c.month, c.day, c.doy, c.year + 284);
		case 'ethiopic':
			c = ce(jd, 1723856);
			return result(c.year <= 0 ? 0 : 1, c.year <= 0 ? c.year + 5500 :
				      c.year, c.year, c.month, c.day, c.doy, c.year + 8);
		case 'ethiopic-amete-alem':
			c = ce(jd, -285019);
			return result(0, c.year, c.year, c.month, c.day, c.doy,
				      c.year + 8);
		case 'chinese':
		case 'dangi':
			return chinese(type).fields(jd, week);
		}
		g = dayToFields(days);
		return result(g[0] > 0 ? 1 : 0, g[0] > 0 ? g[0] : 1 - g[0], g[0],
			      g[1], g[2], g[3], g[0]);
	}

	/* handleGetYearLength: the days in a calendar's extended year */
	function yearLength(type, y) {
		switch (type) {
		case 'buddhist':
		case 'japanese':
		case 'roc':
			/* the Julian calendar's leap years before 1582 */
			return (y >= 1582 ? isLeap(y) : (y & 3) === 0) ? 366 : 365;
		case 'islamic':
		case 'islamic-rgsa':
			return trueMonthStart(12 * y) - trueMonthStart(12 * (y - 1));
		case 'islamic-civil':
		case 'islamic-tbla':
			return 354 + (civilLeapYear(y) ? 1 : 0);
		case 'islamic-umalqura':
			return umalquraYearLength(y);
		case 'persian':
			if (PERSIAN_NON_LEAP[y])
				return 365;
			if (PERSIAN_NON_LEAP[y - 1])
				return 366;
			return (y * 25 + 11) % 33 < 8 ? 366 : 365;
		case 'hebrew':
			return startOfYear(y + 1) - startOfYear(y);
		case 'indian':
			return isLeap(y + 78) ? 366 : 365;
		case 'coptic':
		case 'ethiopic':
		case 'ethiopic-amete-alem':
			return 365 + floor((y + 1) / 4) - floor(y / 4);
		case 'chinese':
		case 'dangi':
			return chinese(type).yearStart(y + 1) - chinese(type).yearStart(y);
		}
		return isLeap(y) ? 366 : 365;
	}

	/*
	 * Calendar::computeWeekFields' YEAR_WOY, the year of the week of the
	 * year, from a day's fields (fields() above, with dow the day of the
	 * week, 1 for Sunday) and the week the calendar has.
	 */
	function weekYear(type, t, week) {
		var dow = t.dow, doy = t.dayOfYear, eyear = t.ext;
		var relDow = (dow + 7 - week.first) % 7;
		var relDowJan1 = (dow - doy + 7001 - week.first) % 7;
		var woy = trunc((doy - 1 + relDowJan1) / 7);

		if (7 - relDowJan1 >= week.min)
			woy++;
		if (woy === 0) {
			yearLength(type, eyear - 1);
			return eyear - 1;
		}
		var lastDoy = yearLength(type, eyear);

		if (doy >= lastDoy - 5) {
			var lastRelDow = (relDow + lastDoy - doy) % 7;

			if (lastRelDow < 0)
				lastRelDow += 7;
			if (6 - lastRelDow >= week.min && doy + 7 - relDow > lastDoy)
				return eyear + 1;
		}
		return eyear;
	}

	/* ---- RuleBasedNumberFormat ---- */

	var RBNF = null, SYSTEMS = {};

	/* NFRule: a rule's base value, divisor and text, as parts */
	function parseRule(set, line, out) {
		var colon = line.indexOf(':'), desc = line.slice(0, colon).trim();
		var text = line.slice(colon + 1).replace(/^ +/, '')
			.replace(/;$/, '');

		if (text.charAt(0) === "'")
			text = text.slice(1);
		if (desc === '-x') {
			set.negative = { base: -1, divisor: 1,
				parts: substitutions(text) };
			return;
		}
		if (!/^\d/.test(desc))
			return;
		var slash = desc.indexOf('/');
		var base = parseInt((slash < 0 ? desc : desc.slice(0, slash))
				    .replace(/[ ,.]/g, ''), 10);
		var radix = slash < 0 ? 10 : parseInt(desc.slice(slash + 1), 10);
		var exp = base < 1 ? 0 : trunc(Math.log(base) / Math.log(radix));

		if (Math.pow(radix, exp + 1) <= base)
			exp++;
		var divisor = Math.pow(radix, exp);
		var b1 = text.indexOf('['), b2 = b1 < 0 ? -1 : text.indexOf(']');

		if (b1 < 0 || b2 < b1) {
			out.push({ base: base, divisor: divisor,
				parts: substitutions(text) });
			return;
		}
		var head = text.slice(0, b1), tail = text.slice(b2 + 1);
		var inner = text.slice(b1 + 1, b2), bar = inner.indexOf('|');

		/* a multiple of its divisor is two rules: the bracketed text
		 * left out for the multiple itself, kept from one above it */
		if (base > 0 && base % divisor === 0) {
			out.push({ base: base, divisor: divisor, parts: substitutions(
				head + (bar >= 0 ? inner.slice(bar + 1) : '') + tail) });
			base++;
		}
		out.push({ base: base, divisor: divisor, parts: substitutions(
			head + (bar >= 0 ? inner.slice(0, bar) : inner) + tail) });
	}

	/* the rule text's literal text and its substitutions, << >> == with
	 * a rule set or decimal pattern between, if any */
	function substitutions(text) {
		var parts = [], i = 0, lit = '';

		while (i < text.length) {
			var c = text.charAt(i);

			if (c === '<' || c === '>' || c === '=') {
				var end = text.indexOf(c, i + 1);

				if (end > 0) {
					if (lit) {
						parts.push(lit);
						lit = '';
					}
					var name = text.slice(i + 1, end);

					if (c === '>' && text.charAt(end + 1) === '>')
						end++;
					parts.push({ op: c, set: name.charAt(0) === '%' ?
						name : null, fmt: name && name.charAt(0) !== '%' ?
						name : null });
					i = end + 1;
					continue;
				}
			}
			lit += c;
			i++;
		}
		if (lit)
			parts.push(lit);
		return parts;
	}

	function system(name) {
		if (SYSTEMS[name] !== undefined)
			return SYSTEMS[name];
		if (!RBNF)
			RBNF = JSON.parse(N.pak('dt:rbnf') || '{}');
		var d = RBNF[name];

		if (!d)
			return (SYSTEMS[name] = null);
		var sets = {};

		Object.keys(d.r).forEach(function (k) {
			var set = { rules: [] };

			d.r[k].forEach(function (line) {
				parseRule(set, line, set.rules);
			});
			sets[k] = set;
		});
		return (SYSTEMS[name] = { start: d.s, sets: sets });
	}

	function hasModulus(rule) {
		return rule.parts.some(function (p) {
			return typeof p === 'object' && p.op === '>';
		});
	}

	/* NFRuleSet::findNormalRule */
	function findRule(set, n) {
		if (n < 0) {
			if (set.negative)
				return set.negative;
			n = -n;
		}
		var rules = set.rules, lo = 0, hi = rules.length;

		while (lo < hi) {
			var mid = (lo + hi) >> 1;

			if (rules[mid].base === n)
				return rules[mid];
			if (rules[mid].base > n)
				hi = mid;
			else
				lo = mid + 1;
		}
		if (hi === 0)
			return null;
		var r = rules[hi - 1];

		if (hasModulus(r) && n % r.divisor === 0 && r.base % r.divisor !== 0 &&
		    hi > 1)
			r = rules[hi - 2];
		return r;
	}

	/* a decimal pattern's integer: grouped by threes where it has a
	 * comma */
	function decimal(fmt, n) {
		var s = String(Math.abs(n));

		if (fmt.indexOf(',') >= 0)
			s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
		return n < 0 ? '-' + s : s;
	}

	function format(sys, set, n, depth) {
		var rule = findRule(set, n), out = '', i;

		if (!rule || depth > 50)
			return String(n);
		for (i = 0; i < rule.parts.length; i++) {
			var p = rule.parts[i];

			if (typeof p === 'string') {
				out += p;
				continue;
			}
			var v = rule === set.negative ? Math.abs(n) :
				p.op === '<' ? floor(n / rule.divisor) :
				p.op === '>' ? n % rule.divisor : n;

			out += p.fmt ? decimal(p.fmt, v) :
				format(sys, p.set ? sys.sets[p.set] : set, v, depth + 1);
		}
		return out;
	}

	/* a number in an algorithmic numbering system, or null for one
	 * there are no rules for */
	function spell(name, n) {
		var sys = system(name);

		return sys ? format(sys, sys.sets[sys.start], n, 0) : null;
	}

	return { fields: fields, weekYear: weekYear, spell: spell };
};

if (typeof module !== 'undefined')
	module.exports = __vitaIntlCalendar;
