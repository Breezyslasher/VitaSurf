/*
 * Copyright 2026 VitaSurf contributors
 *
 * This file is part of VitaSurf, a PS Vita port of NetSurf.
 * Licensed under the GNU General Public License version 2.
 */

/*
 * Intl.Segmenter (VitaSurf).
 *
 * The prelude's Segmenter split words at spaces and sentences at full
 * stops. This one finds the boundaries ICU finds: its break rules
 * (char, word and sent, compiled by scripts/gen-intl-segmenter.mjs into
 * state tables in resources/intl.pak) run here as ICU's
 * RuleBasedBreakIterator runs them, and the runs of Thai, Lao, Khmer,
 * Burmese, Chinese and Japanese the word rules leave whole are divided
 * by ICU's dictionary engines (dictbe.cpp) over ICU's word lists, read
 * from the pack a block of first characters at a time.
 *
 * Runs under Node too, to be held against ICU with the cases
 * scripts/gen-intl-segmenter-tests.mjs makes:
 * __vitaIntlSegmenter(W, N, C, X).
 */
var __vitaIntlSegmenter = function (W, N, C, X) {
	'use strict';

	var Intl = W.Intl, getOption = X.getOption, method = X.method;
	var DATA = {};

	function data(name) {
		if (DATA[name] === undefined)
			DATA[name] = N.has(name) ? JSON.parse(N.pak(name)) : null;
		return DATA[name];
	}

	var META = data('g:meta');

	function cpLen(c) {
		return c > 0xffff ? 2 : 1;
	}

	/* code point at i, or -1 past the end */
	function cpAt(s, i) {
		return i < s.length ? s.codePointAt(i) : -1;
	}

	/* [start, end, start, end, ...], end exclusive */
	function rangeSet(list) {
		return Int32Array.from(list || []);
	}

	function inSet(set, c) {
		var lo = 0, hi = set.length;

		if (c < 0)
			return false;
		while (lo < hi) {
			var m = (lo + hi) >> 1;

			if (set[m] <= c)
				lo = m + 1;
			else
				hi = m;
		}
		return (lo & 1) === 1;
	}

	/* [start, value, start, value, ...]: the value at c */
	function runValue(starts, values, c) {
		var lo = 0, hi = starts.length - 1;

		while (lo < hi) {
			var m = (lo + hi + 1) >> 1;

			if (starts[m] <= c)
				lo = m;
			else
				hi = m - 1;
		}
		return values[lo];
	}

	/* ---- the rules ---- */

	var TABLES = {};

	function table(name) {
		var t = TABLES[name], d, i, n;

		if (t)
			return t;
		d = data('g:r:' + name);
		n = d.cats.length / 2;
		t = TABLES[name] = {
			starts: new Int32Array(n), cats: new Uint8Array(n),
			ascii: new Uint8Array(128), ncat: d.ncat, dict: d.dict,
			bof: d.bof, next: Uint16Array.from(d.next),
			acc: Int32Array.from(d.acc), la: Int32Array.from(d.la),
			tag: Int32Array.from(d.tag), slots: new Int32Array(d.slots)
		};
		for (i = 0; i < n; i++) {
			t.starts[i] = d.cats[2 * i];
			t.cats[i] = d.cats[2 * i + 1];
		}
		for (i = 0; i < 128; i++)
			t.ascii[i] = runValue(t.starts, t.cats, i);
		t.bmp = null;
		t.hasLa = d.slots > 2;
		return t;
	}

	/* the BMP's categories, 64 KB, made from the runs the first time a
	 * character past ASCII is looked up */
	function bmpOf(t) {
		var b = new Uint8Array(0x10000), i, end;

		for (i = 0; i < t.starts.length && t.starts[i] < 0x10000; i++) {
			end = i + 1 < t.starts.length ? Math.min(t.starts[i + 1], 0x10000) :
				0x10000;
			b.fill(t.cats[i], t.starts[i], end);
		}
		return (t.bmp = b);
	}

	function category(t, c) {
		if (c < 128)
			return t.ascii[c];
		if (c < 0x10000)
			return (t.bmp || bmpOf(t))[c];
		return runValue(t.starts, t.cats, c);
	}

	/*
	 * ICU's RuleBasedBreakIterator::handleNext: the boundary after pos,
	 * or -1 at the end of the text; out.tag is its rule status and
	 * out.dict how many dictionary characters the machine read.
	 */
	var START = 0, RUN = 1, END = 2;

	function handleNext(t, s, pos, out) {
		var state = 1, mode, cat = 0, c, i, result = pos, tag = 0;
		var dict = 0, a, l, k, ncat = t.ncat, next = t.next, acc = t.acc;
		var la = t.la, tags = t.tag, slots = t.slots, ascii = t.ascii;
		var bmp = t.bmp, dictStart = t.dict, len = s.length;

		if (pos >= len)
			return -1;
		if (t.hasLa)
			for (k = 0; k < slots.length; k++)
				slots[k] = -1;
		c = s.codePointAt(pos);
		i = pos + (c > 0xffff ? 2 : 1);
		mode = RUN;
		if (t.bof) {
			cat = 2;
			mode = START;
		}
		for (;;) {
			if (c < 0) {
				if (mode === END)
					break;
				mode = END;
				cat = 1;
			} else if (mode === RUN) {
				if (c < 128)
					cat = ascii[c];
				else if (c < 0x10000)
					cat = (bmp || (bmp = bmpOf(t)))[c];
				else
					cat = runValue(t.starts, t.cats, c);
				if (cat >= dictStart)
					dict++;
			}
			state = next[state * ncat + cat];
			a = acc[state];
			if (a === 1) {
				if (mode !== START)
					result = i;
				tag = tags[state];
			} else if (a > 1) {
				k = slots[a];
				if (k >= 0) {
					out.tag = tags[state];
					out.dict = dict;
					return k;
				}
			}
			l = la[state];
			if (l > 1)
				slots[l] = i;
			if (state === 0)
				break;
			if (mode === RUN) {
				if (i < len) {
					c = s.codePointAt(i);
					i += c > 0xffff ? 2 : 1;
				} else {
					c = -1;
				}
			} else if (mode === START) {
				mode = RUN;
			}
		}
		if (result === pos) {
			result = pos + (s.codePointAt(pos) > 0xffff ? 2 : 1);
			tag = 0;
		}
		out.tag = tag;
		out.dict = dict;
		return result;
	}

	/* ---- dictionaries ---- */

	var CHUNKS = {};

	/* the words of a dictionary that start in a block: sorted, a line
	 * each, after a cost character in a dictionary with costs */
	function chunk(name, block) {
		var key = name + ':' + block, ch = CHUNKS[key], d;

		if (ch !== undefined)
			return ch;
		d = data('g:d:' + key);
		return (CHUNKS[key] = d ? { text: d, skip: name === 'cj' ? 1 : 0 } :
			null);
	}

	/* where the first word not before key starts, in code unit order,
	 * by bisecting the text itself from from on */
	function lowerBound(ch, key, from) {
		var text = ch.text, skip = ch.skip, lo = from, hi = text.length;
		var mid, ls, le, k, d, n = key.length;

		while (lo < hi) {
			mid = (lo + hi) >> 1;
			ls = mid > lo ? text.lastIndexOf('\n', mid - 1) + 1 : lo;
			if (ls < lo)
				ls = lo;
			le = text.indexOf('\n', ls);
			d = 0;
			for (k = 0; ls + skip + k < le && k < n; k++) {
				d = text.charCodeAt(ls + skip + k) - key.charCodeAt(k);
				if (d)
					break;
			}
			if (!d)
				d = (le - ls - skip) - n;
			if (d < 0)
				lo = le + 1;
			else
				hi = ls;
		}
		return lo;
	}

	/* whether the word at p starts with key; its length in p.len */
	function wordAt(ch, p, key, out) {
		var text = ch.text, le;

		if (p >= text.length)
			return false;
		le = text.indexOf('\n', p);
		out.len = le - p - ch.skip;
		out.end = le + 1;
		return out.len >= key.length &&
			text.substr(p + ch.skip, key.length) === key;
	}

	/*
	 * ICU's DictionaryMatcher::matches over a sorted word list instead
	 * of a trie: the words that start s at start, up to maxLength code
	 * units and limit of them, their lengths in code units and code
	 * points and their costs; out.prefix is how many code points the
	 * trie walk read, the one that failed it included.
	 */
	var WORD = { len: 0, end: 0 };

	function matches(dict, s, start, maxLength, limit, cu, cp, values, out) {
		var off = dict.offset, i = start, c, key = '', count = 0, cps = 0;
		var ch = null, lb = 0, len;

		for (;;) {
			c = cpAt(s, i);
			if (c < 0)
				break;
			i += cpLen(c);
			/* a bytes trie's offset transform: what is out of its
			 * range reads as 0xFF, which is ZWJ's byte */
			if (off >= 0 && c !== 0x200d && c !== 0x200c &&
			    (c - off < 0 || c - off > 0xfd))
				c = 0x200d;
			if (!cps)
				ch = chunk(dict.name, (c >> 8).toString(16).toUpperCase());
			key += String.fromCodePoint(c);
			cps++;
			len = i - start;
			if (!ch)
				break;
			/* a longer key's words come no sooner */
			lb = lowerBound(ch, key, lb);
			if (!wordAt(ch, lb, key, WORD))
				break;
			if (WORD.len === key.length) {
				if (count < limit) {
					if (values)
						values[count] = ch.text.charCodeAt(lb) - 0x20;
					if (cu)
						cu[count] = len;
					if (cp)
						cp[count] = cps;
					count++;
				}
				if (!wordAt(ch, WORD.end, key, WORD))
					break;
			}
			if (len >= maxLength)
				break;
		}
		if (out)
			out.prefix = cps;
		return count;
	}

	/* ---- the Southeast Asian engines (Thai, Lao, Burmese, Khmer) ---- */

	/* a UText's index over a string */
	function Text(s, i) {
		this.s = s;
		this.i = i;
	}
	Text.prototype.current = function () {
		return cpAt(this.s, this.i);
	};
	Text.prototype.next = function () {
		var c = cpAt(this.s, this.i);

		if (c >= 0)
			this.i += cpLen(c);
		return c;
	};
	Text.prototype.previous = function () {
		var s = this.s, i = this.i;

		if (i <= 0)
			return -1;
		i--;
		if (i > 0 && (s.charCodeAt(i) & 0xfc00) === 0xdc00 &&
		    (s.charCodeAt(i - 1) & 0xfc00) === 0xd800)
			i--;
		this.i = i;
		return s.codePointAt(i);
	};

	var POSSIBLE_WORD_LIST_MAX = 20;

	function PossibleWord() {
		this.count = 0;
		this.prefix = 0;
		this.offset = -1;
		this.mark = 0;
		this.current = 0;
		this.cu = [];
		this.cp = [];
	}
	PossibleWord.prototype.candidates = function (text, dict, rangeEnd) {
		var start = text.i;

		if (start !== this.offset) {
			this.offset = start;
			this.count = matches(dict, text.s, start, rangeEnd - start,
					     POSSIBLE_WORD_LIST_MAX, this.cu, this.cp,
					     null, this);
			if (this.count <= 0)
				text.i = start;
		}
		if (this.count > 0)
			text.i = start + this.cu[this.count - 1];
		this.current = this.count - 1;
		this.mark = this.current;
		return this.count;
	};
	PossibleWord.prototype.acceptMarked = function (text) {
		text.i = this.offset + this.cu[this.mark];
		return this.cu[this.mark];
	};
	PossibleWord.prototype.backUp = function (text) {
		if (this.current > 0) {
			text.i = this.offset + this.cu[--this.current];
			return true;
		}
		return false;
	};

	var LOOKAHEAD = 3, ROOT_COMBINE_THRESHOLD = 3;
	var PREFIX_COMBINE_THRESHOLD = 3, MIN_WORD_SPAN = 4;
	var PAIYANNOI = 0x0e2f, MAIYAMOK = 0x0e46;

	function SeaEngine(name) {
		var e = META.engines[name];

		this.dict = { name: name, offset: META.offsets[name] };
		this.set = rangeSet(e.set);
		this.markSet = rangeSet(e.mark);
		this.endSet = rangeSet(e.end);
		this.beginSet = rangeSet(e.begin);
		this.thai = !!e.suffix;
	}
	SeaEngine.prototype.handles = function (c) {
		return inSet(this.set, c);
	};
	SeaEngine.prototype.findBreaks = function (s, i, end, breaks) {
		var start = i;

		while (i < end && inSet(this.set, cpAt(s, i)))
			i += cpLen(s.codePointAt(i));
		this.divide(new Text(s, start), start, i, breaks);
		return i;
	};
	/* ICU's ThaiBreakEngine (and Lao, Burmese and Khmer, the same but
	 * for the suffixes) divideUpDictionaryRange */
	SeaEngine.prototype.divide = function (text, rangeStart, rangeEnd, found) {
		var dict = this.dict, words, wordsFound = 0, cp, cu, current, n;
		var w, uc, pc, remaining, chars, pcIndex, pcSize, num, currPos, k;

		if (this.thai) {
			text.i = rangeStart;
			for (k = 0; k < MIN_WORD_SPAN; k++)
				text.next();
			if (text.i >= rangeEnd)
				return 0;
		} else if (rangeEnd - rangeStart < MIN_WORD_SPAN) {
			return 0;
		}
		words = [new PossibleWord(), new PossibleWord(), new PossibleWord()];
		text.i = rangeStart;
		while ((current = text.i) < rangeEnd) {
			cp = 0;
			cu = 0;
			w = words[wordsFound % LOOKAHEAD];
			n = w.candidates(text, dict, rangeEnd);
			if (n === 1) {
				cu = w.acceptMarked(text);
				cp = w.cp[w.mark];
				wordsFound++;
			} else if (n > 1) {
				best: {
					if (text.i >= rangeEnd)
						break best;
					do {
						if (words[(wordsFound + 1) % LOOKAHEAD]
						    .candidates(text, dict, rangeEnd) > 0) {
							w.mark = w.current;
							if (text.i >= rangeEnd)
								break best;
							do {
								if (words[(wordsFound + 2) % LOOKAHEAD]
								    .candidates(text, dict, rangeEnd)) {
									w.mark = w.current;
									break best;
								}
							} while (words[(wordsFound + 1) % LOOKAHEAD]
								 .backUp(text));
						}
					} while (w.backUp(text));
				}
				cu = w.acceptMarked(text);
				cp = w.cp[w.mark];
				wordsFound++;
			}
			uc = 0;
			if (text.i < rangeEnd && cp < ROOT_COMBINE_THRESHOLD) {
				w = words[wordsFound % LOOKAHEAD];
				if (w.candidates(text, dict, rangeEnd) <= 0 &&
				    (cu === 0 || w.prefix < PREFIX_COMBINE_THRESHOLD)) {
					remaining = rangeEnd - (current + cu);
					chars = 0;
					for (;;) {
						pcIndex = text.i;
						pc = text.next();
						pcSize = text.i - pcIndex;
						chars += pcSize;
						remaining -= pcSize;
						if (remaining <= 0)
							break;
						uc = text.current();
						if (inSet(this.endSet, pc) && inSet(this.beginSet, uc)) {
							num = words[(wordsFound + 1) % LOOKAHEAD]
								.candidates(text, dict, rangeEnd);
							text.i = current + cu + chars;
							if (num > 0)
								break;
						}
					}
					if (cu <= 0)
						wordsFound++;
					cu += chars;
				} else {
					text.i = current + cu;
				}
			}
			/* never stop before a combining mark */
			while ((currPos = text.i) < rangeEnd &&
			       inSet(this.markSet, text.current())) {
				text.next();
				cu += text.i - currPos;
			}
			/* Thai's suffixes, when a dictionary word does not follow */
			if (this.thai && text.i < rangeEnd && cu > 0) {
				if (words[wordsFound % LOOKAHEAD]
				    .candidates(text, dict, rangeEnd) <= 0 &&
				    ((uc = text.current()) === PAIYANNOI ||
				     uc === MAIYAMOK)) {
					if (uc === PAIYANNOI) {
						k = text.previous();
						if (k !== PAIYANNOI && k !== MAIYAMOK) {
							text.next();
							pcIndex = text.i;
							text.next();
							cu += text.i - pcIndex;
							uc = text.current();
						} else {
							text.next();
						}
					}
					if (uc === MAIYAMOK) {
						if (text.previous() !== MAIYAMOK) {
							text.next();
							pcIndex = text.i;
							text.next();
							cu += text.i - pcIndex;
						} else {
							text.next();
						}
					}
				} else {
					text.i = current + cu;
				}
			}
			if (cu > 0)
				found.push(current + cu);
		}
		if (found.length && found[found.length - 1] >= rangeEnd) {
			found.pop();
			wordsFound--;
		}
		return wordsFound;
	};

	/* ---- Chinese and Japanese ---- */

	var KATAKANA_COST = [8192, 984, 408, 240, 204, 252, 300, 372, 480];
	var MAX_KATAKANA_GROUP = 20, MAX_SNLP = 255, UINT32_MAX = 4294967295;

	function isKatakana(c) {
		return (c >= 0x30a1 && c <= 0x30fe && c !== 0x30fb) ||
			(c >= 0xff66 && c <= 0xff9f);
	}

	function CjEngine() {
		this.dict = { name: 'cj', offset: -1 };
		this.set = rangeSet(META.engines.cj.set);
		this.noBoundary = rangeSet(META.engines.cj.nb);
	}
	CjEngine.prototype.handles = SeaEngine.prototype.handles;
	CjEngine.prototype.findBreaks = function (s, i, end, breaks) {
		var start = i;

		while (i < end && inSet(this.set, cpAt(s, i)))
			i += cpLen(s.codePointAt(i));
		this.divide(s, start, i, breaks);
		return i;
	};
	/* ICU's CjkBreakEngine::divideUpDictionaryRange, without phrase
	 * breaking, which Intl.Segmenter has no way to ask for */
	CjEngine.prototype.divide = function (s, rangeStart, rangeEnd, found) {
		var str, map = null, norm, nmap, i, j, c, frag, fragStart, numCp;
		var best, prev, values = [], lengths = [], ix, count, snlp, ln;
		var prevKatakana = false, kat, run, t, numBreaks, cpPos, pos;
		var prevPos = -1, corrected = 0, had;

		if (rangeStart >= rangeEnd)
			return 0;
		str = s.slice(rangeStart, rangeEnd);
		if (str.normalize('NFKC') !== str) {
			norm = '';
			nmap = [];
			for (i = 0; i < str.length;) {
				frag = '';
				fragStart = i;
				c = str.codePointAt(i);
				for (;;) {
					frag += String.fromCodePoint(c);
					i += cpLen(c);
					if (i === str.length)
						break;
					c = str.codePointAt(i);
					if (!inSet(this.noBoundary, c))
						break;
				}
				norm += frag.normalize('NFKC');
				while (nmap.length < norm.length)
					nmap.push(map ? map[fragStart] : fragStart + rangeStart);
			}
			nmap.push(map ? map[str.length] : str.length + rangeStart);
			map = nmap;
			str = norm;
		}
		numCp = 0;
		for (i = 0; i < str.length; i += cpLen(str.codePointAt(i)))
			numCp++;
		if (numCp !== str.length) {
			had = map !== null;
			if (!had)
				map = [];
			for (i = 0, j = 0; ; j += cpLen(str.codePointAt(j))) {
				if (had)
					map[i] = map[j];
				else
					map.push(j + rangeStart);
				i++;
				if (j >= str.length)
					break;
			}
		}
		best = [0];
		prev = [];
		for (i = 1; i <= numCp; i++)
			best.push(UINT32_MAX);
		for (i = 0; i <= numCp; i++)
			prev.push(-1);
		for (i = 0, ix = 0; i < numCp; i++, ix += cpLen(str.codePointAt(ix))) {
			if (best[i] === UINT32_MAX)
				continue;
			count = matches(this.dict, str, ix, 20, numCp, null, lengths,
					values, null);
			c = str.codePointAt(ix);
			if ((count === 0 || lengths[0] !== 1) &&
			    !(c >= 0xac00 && c <= 0xd7a3)) {
				values[count] = MAX_SNLP;
				lengths[count++] = 1;
			}
			for (j = 0; j < count; j++) {
				snlp = best[i] + values[j];
				ln = lengths[j] + i;
				if (snlp < best[ln]) {
					best[ln] = snlp;
					prev[ln] = i;
				}
			}
			/* a run of katakana is a word, at a cost by its length */
			kat = isKatakana(c);
			run = 1;
			if (!prevKatakana && kat) {
				j = ix + cpLen(c);
				while (j < str.length && run < MAX_KATAKANA_GROUP &&
				       isKatakana(str.codePointAt(j))) {
					j += cpLen(str.codePointAt(j));
					run++;
				}
				if (run < MAX_KATAKANA_GROUP) {
					snlp = best[i] + (run > 8 ? 8192 : KATAKANA_COST[run]);
					if (snlp < best[i + run]) {
						best[i + run] = snlp;
						prev[i + run] = i;
					}
				}
			}
			prevKatakana = kat;
		}
		t = [];
		if (best[numCp] === UINT32_MAX) {
			t.push(numCp);
		} else {
			for (i = numCp; i > 0; i = prev[i])
				t.push(i);
		}
		if (!found.length || found[found.length - 1] < rangeStart)
			t.push(0);
		numBreaks = t.length;
		for (i = numBreaks - 1; i >= 0; i--) {
			cpPos = t[i];
			pos = map ? map[cpPos] : cpPos + rangeStart;
			if (pos > prevPos) {
				if (pos !== rangeStart) {
					found.push(pos);
					corrected++;
				}
			}
			prevPos = pos;
		}
		if (found.length && found[found.length - 1] === rangeEnd) {
			found.pop();
			corrected--;
		}
		return corrected;
	};

	/* ---- what has no engine ---- */

	var SCRIPTS = null;

	function scriptOf(c) {
		var i, l;

		if (!SCRIPTS) {
			l = META.scripts;
			SCRIPTS = { starts: new Int32Array(l.length / 2),
				values: new Int32Array(l.length / 2) };
			for (i = 0; i < l.length / 2; i++) {
				SCRIPTS.starts[i] = l[2 * i];
				SCRIPTS.values[i] = l[2 * i + 1];
			}
		}
		i = runValue(SCRIPTS.starts, SCRIPTS.values, c);
		return i ? i : 'u' + c;
	}

	/* ICU's UnhandledEngine: skips the whole script of each character
	 * it is given */
	function Unhandled() {
		this.scripts = Object.create(null);
	}
	Unhandled.prototype.handles = function (c) {
		return c >= 0 && this.scripts[scriptOf(c)] === true;
	};
	Unhandled.prototype.add = function (c) {
		this.scripts[scriptOf(c)] = true;
	};
	Unhandled.prototype.findBreaks = function (s, i, end) {
		while (i < end && this.handles(cpAt(s, i)))
			i += cpLen(s.codePointAt(i));
		return i;
	};

	var ENGINES = null;

	/*
	 * The engine for a character. ICU's factory keeps the engines it has
	 * made for the whole process and gives a character to the first that
	 * takes it, so once Chinese or Japanese has been seen its engine also
	 * takes the Common characters in its set (U+30FC and the halfwidth
	 * marks); a browser has seen them, and so does this.
	 */
	function loadEngine(c) {
		var i, e;

		if (!ENGINES) {
			ENGINES = [];
			for (e in META.engines)
				ENGINES.push(e === 'cj' ? new CjEngine() : new SeaEngine(e));
		}
		for (i = 0; i < ENGINES.length; i++)
			if (ENGINES[i].handles(c))
				return ENGINES[i];
		return null;
	}

	/* ---- the boundaries of a text ---- */

	/*
	 * Boundaries found forward from the start, as ICU's BreakCache and
	 * DictionaryCache find them: a rule-based segment holding dictionary
	 * characters is divided by the engines, each break taking the rule
	 * status of the segment's end.
	 */
	function Breaks(t, s) {
		this.t = t;
		this.s = s;
		this.pos = [0];
		this.tags = [0];
		this.done = !s.length;
		this.out = { tag: 0, dict: 0 };
		this.dc = null;
		this.engines = [];
		this.unhandled = null;
	}
	Breaks.prototype.engineFor = function (c) {
		var i, e;

		for (i = this.engines.length - 1; i >= 0; i--)
			if (this.engines[i].handles(c))
				return this.engines[i];
		e = loadEngine(c);
		if (e) {
			this.engines.push(e);
			return e;
		}
		if (!this.unhandled) {
			this.unhandled = new Unhandled();
			this.engines.unshift(this.unhandled);
		}
		this.unhandled.add(c);
		return this.unhandled;
	};
	Breaks.prototype.populate = function (start, end, other) {
		var s = this.s, t = this.t, i = start, c, b = [];

		if (end - start <= 1)
			return;
		this.dc = null;
		c = cpAt(s, i);
		for (;;) {
			while (i < end && category(t, c) < t.dict) {
				i += cpLen(c);
				c = cpAt(s, i);
			}
			if (i >= end)
				break;
			i = this.engineFor(c).findBreaks(s, i, end, b);
			c = cpAt(s, i);
		}
		if (b.length) {
			if (start < b[0])
				b.unshift(start);
			if (end > b[b.length - 1])
				b.push(end);
			this.dc = { b: b, start: b[0], limit: b[b.length - 1],
				other: other };
		}
	};
	Breaks.prototype.dictFollowing = function (from) {
		var dc = this.dc, i;

		if (!dc || from >= dc.limit || from < dc.start)
			return false;
		for (i = 0; i < dc.b.length; i++) {
			if (dc.b[i] > from) {
				this.pos.push(dc.b[i]);
				this.tags.push(dc.other);
				return true;
			}
		}
		return false;
	};
	/* add the next boundary; false at the end */
	Breaks.prototype.more = function () {
		var from = this.pos[this.pos.length - 1], r, out = this.out;

		if (this.done)
			return false;
		if (this.dictFollowing(from))
			return true;
		r = handleNext(this.t, this.s, from, out);
		if (r < 0) {
			this.done = true;
			return false;
		}
		if (out.dict > 0) {
			this.populate(from, r, out.tag);
			if (this.dictFollowing(from))
				return true;
		}
		this.pos.push(r);
		this.tags.push(out.tag);
		return true;
	};
	/* the index of the first boundary after n */
	Breaks.prototype.after = function (n) {
		var lo, hi, m;

		while (this.pos[this.pos.length - 1] <= n && this.more())
			;
		lo = 0;
		hi = this.pos.length - 1;
		while (lo < hi) {
			m = (lo + hi) >> 1;
			if (this.pos[m] <= n)
				lo = m + 1;
			else
				hi = m;
		}
		return lo;
	};

	/* ---- Intl.Segmenter ---- */

	var SLOTS = new WeakMap(), SEGMENTS = new WeakMap();
	var ITERATORS = new WeakMap(), NOSEG = null;

	/* a locale Segmenter offers: one of ICU's locales */
	function hasSegmenter(t) {
		var i;

		if (!NOSEG) {
			NOSEG = Object.create(null);
			for (i = 0; i < (META.noseg || []).length; i++)
				NOSEG[META.noseg[i]] = 1;
			for (i = 0; i < (META.seg || []).length; i++)
				NOSEG[META.seg[i]] = 2;
		}
		return NOSEG[t] === 2 || (X.hasLocale(t) && !NOSEG[t]) ? t : null;
	}

	function slots(map, o, m, what) {
		var s = o !== null && typeof o === 'object' && map.get(o);

		if (!s)
			throw new TypeError('Method ' + what + '.prototype.' + m +
					    ' called on incompatible receiver');
		return s;
	}

	function Segmenter() {
		var s = {}, o, req, loc, kw = {}, i, sp, found = null, rules;

		if (!new.target)
			throw new TypeError('Constructor Intl.Segmenter requires \'new\'');
		req = C.localeList(arguments[0]);
		o = arguments[1];
		if (o === undefined)
			o = Object.create(null);
		else if (o === null || (typeof o !== 'object' && typeof o !== 'function'))
			throw new TypeError('Options must be an object');
		getOption(o, 'localeMatcher', ['lookup', 'best fit'], 'best fit');
		s.granularity = getOption(o, 'granularity',
			['grapheme', 'word', 'sentence'], 'grapheme');
		for (i = 0; i < req.length && !found; i++) {
			sp = C.splitTag(req[i]);
			found = C.lookup(sp.base, hasSegmenter);
			if (found)
				kw = sp.kw;
		}
		loc = found || (W.navigator && W.navigator.language) || 'en-US';
		s.locale = loc;
		/* the rules a locale has its own of: en-US-POSIX's words, by
		 * its -u-va-posix, and Greek's sentences */
		rules = C.lookup(kw.va === 'posix' ? loc + '-POSIX' : loc,
				 function (t) {
			return META.locales[t] && META.locales[t][s.granularity] ?
				t : null;
		});
		rules = rules ? META.locales[rules][s.granularity] :
			META.rules[s.granularity];
		s.rules = rules;
		SLOTS.set(this, s);
		return this;
	}

	var proto = Segmenter.prototype;

	method(proto, 'resolvedOptions', function resolvedOptions() {
		var s = slots(SLOTS, this, 'resolvedOptions', 'Intl.Segmenter');

		return { locale: s.locale, granularity: s.granularity };
	});

	var segmentsProto = {};

	method(proto, 'segment', function segment(string) {
		var s = slots(SLOTS, this, 'segment', 'Intl.Segmenter');
		var str = String(string), seg = Object.create(segmentsProto);

		SEGMENTS.set(seg, { seg: s, str: str,
			breaks: new Breaks(table(s.rules), str) });
		return seg;
	});
	Object.defineProperty(proto, Symbol.toStringTag, {
		configurable: true, value: 'Intl.Segmenter'
	});
	method(Segmenter, 'supportedLocalesOf',
	       function supportedLocalesOf(locales) {
		return X.supported(locales, arguments[1], hasSegmenter);
	});
	Object.defineProperty(Segmenter, 'prototype', { writable: false });

	/* CreateSegmentDataObject */
	function segmentData(g, k) {
		var b = g.breaks, start = b.pos[k - 1], end = b.pos[k];
		var r = { segment: g.str.slice(start, end), index: start,
			input: g.str };

		if (g.seg.granularity === 'word')
			r.isWordLike = b.tags[k] >= 100 && b.tags[k] < 500;
		return r;
	}

	method(segmentsProto, 'containing', function containing(index) {
		var g = slots(SEGMENTS, this, 'containing', '%Segments%');
		var n = Number(index), k;

		n = isNaN(n) ? 0 : Math.trunc(n);
		if (n < 0 || n >= g.str.length)
			return undefined;
		k = g.breaks.after(n);
		return segmentData(g, k);
	});

	var iterProto = Object.create(Object.getPrototypeOf(
		Object.getPrototypeOf([][Symbol.iterator]())));

	Object.defineProperty(segmentsProto, Symbol.iterator, {
		configurable: true, writable: true,
		value: { '[Symbol.iterator]': function () {
			var g = slots(SEGMENTS, this, '[Symbol.iterator]', '%Segments%');
			var it = Object.create(iterProto);

			ITERATORS.set(it, { g: g, k: 0 });
			return it;
		} }['[Symbol.iterator]']
	});
	method(iterProto, 'next', function next() {
		var st = slots(ITERATORS, this, 'next', '%SegmentIterator%');
		var g = st.g, b = g.breaks, k = st.k + 1;

		if (b.pos[st.k] >= g.str.length)
			return { value: undefined, done: true };
		while (k >= b.pos.length && b.more())
			;
		st.k = k;
		return { value: segmentData(g, k), done: false };
	});
	Object.defineProperty(iterProto, Symbol.toStringTag, {
		configurable: true, value: 'Segmenter String Iterator'
	});

	Intl.Segmenter = Segmenter;
};

if (typeof window !== 'undefined' && window.__vitaIntl &&
    window.__vitaIntl.number && window.__vitaIntl.has &&
    window.__vitaIntl.has('g:meta') && window.__vitaIntlCore)
	__vitaIntlSegmenter(window, window.__vitaIntl, window.__vitaIntlCore,
			    window.__vitaIntl.number);

if (typeof module !== 'undefined')
	module.exports = __vitaIntlSegmenter;
