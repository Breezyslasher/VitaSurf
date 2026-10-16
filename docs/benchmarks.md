# Benchmarks

Measured page load times on real hardware, against the browser Sony
shipped with the console. Both run on the same device over the same
network, so the comparison is fair even though the timings are taken by
hand.

Method: time from committing the URL to the page being readable, then
read `ux0:data/VitaSurf/log.txt` for the breakdown VitaSurf reports.

| Page | Sony's browser | VitaSurf | VitaSurf build |
|---|---|---|---|
| `en.wikipedia.org/wiki/PlayStation_Vita` | 13 s | 27 s | 101 |
| `m.youtube.com` search results | 20 s | not measured | |

Notes on the two pages above.

The Wikipedia article is the main target. Sony's browser fetches the
desktop site and lays out the infobox table and images correctly, so it
is not winning by rendering something simpler. The gap is speed, not
capability.

YouTube is a single page application, which `CLAUDE.md` lists as a
non-goal. VitaSurf used to decline any script over `SCRIPT_MAX_BYTES`,
which was two megabytes, naming YouTube's bundle as the reason. That
limit was set before there was any measurement of what compiling costs.
The Wikipedia load measures it: 1054 KB of script compiled in 1925 ms,
so 1.8 ms per KB on the device. At that rate the limit was rejecting
bundles that would have compiled in a handful of seconds, on a load
already taking twenty seven, and a skipped bundle leaves a blank page.
The limit is now eight megabytes, which is about fifteen seconds of
compiling at the worst case, and any script over 256 KB is logged with
its size and compile time whether or not verbose logging is on.

## Where a Wikipedia load goes (build 101, hardware)

```
page: https://en.wikipedia.org/wiki/PlayStation_Vita loaded in 27011 ms
page: of that, html parse 1665 ms, css 222 ms, images 558 ms,
      boxes and styles 8053 ms, layout 6462 ms
qjs: load event, 8 scripts of 1054 KB compiled in 1925 ms, ran in 145 ms
```

Building the box tree and selecting styles is 8.1 s and layout is 6.5 s:
between them 54 percent of the load. Script is 2.1 s, under 8 percent,
and nearly all of that is compiling rather than running. Parsing, CSS
and images together are 2.4 s. The 8.5 s the total exceeds the sum is
network and scheduler.

This overturns the earlier guess that most of the load was network
time. Box construction and layout are where the load is, so that is
where a faster load has to come from; a JavaScript bytecode cache would
be spending effort on the smallest of the three.

## Two more pages, measured on hardware (build 103)

```
page: https://www.youtube.com/ loaded in 42918 ms
page: of that, html parse 801 ms, css 39 ms, images 0 ms,
      boxes and styles 80 ms, layout 20 ms
qjs: skipping 10509 KB script (limit 8192 KB): .../kevlar_base_module...
qjs: 42 scripts of 1073 KB compiled in 943 ms, ran in 61 ms

page: https://github.com/ loaded in 20903 ms
page: of that, html parse 144 ms, css 738 ms, images 221 ms,
      boxes and styles 3578 ms, layout 2086 ms
qjs: 8 scripts of 2209 KB compiled in 5 ms, ran in 2 ms
```

Neither is limited by the same thing as Wikipedia. YouTube spends almost
nothing on boxes and layout because without its application bundle there
is nearly nothing to lay out, and the 43 seconds is fetching 42 scripts
over the network. Its desktop bundle is 10509 KB, which is where the
sixteen megabyte script ceiling comes from.

GitHub compiled 2209 KB in 5 ms because almost none of it compiled at
all: its scripts are ES modules, and export and import are syntax errors
in a classic script. Those five milliseconds are five failed parses.

## The site test, build 739 (hardware, 2026-10-16)

The Start menu's Site test loaded 27 public sites in turn, each given 60 s,
with the cache off and JavaScript on. 22 loaded, with a median of 13.0 s,
and 17 inside the 20 s goal; 5 did not finish in 60 s; none crashed. The
times are from the window starting to load until it stopped. The parts
overlap and leave out network waits, so they do not add up to the total.

| Site | Load (s) | Script | Layout | Styles | HTML parse | CSS | Images | Drawing |
|---|---|---|---|---|---|---|---|---|
| lite.cnn.com | 1.2 | 231 | 14 | 43 | 105 | 74 | 0 | 0 |
| www.w3.org | 1.8 | 158 | 181 | 87 | 25 | 172 | 0 | 0 |
| archive.org | 1.9 | 37 | 0 | 0 | 26 | 3 | 0 | 0 |
| www.bing.com | 2.2 | 573 | 10 | 27 | 74 | 140 | 0 | 1 |
| www.wikipedia.org | 2.4 | 264 | 168 | 204 | 274 | 84 | 0 | 0 |
| www.google.com | 3.1 | 864 | 12 | 50 | 54 | 126 | 1 | 21 |
| developer.mozilla.org/en-US/ | 5.4 | 983 | 92 | 294 | 56 | 216 | 1 | 12 |
| news.ycombinator.com | 6.1 | 91 | 89 | 338 | 160 | 23 | 17 | 27 |
| www.weather.gov | 8.1 | 5032 | 56 | 204 | 37 | 399 | 3 | 50 |
| www.imdb.com | 8.4 | 1458 | 1389 | 0 | 24 | 1 | 876 | 98 |
| www.craigslist.org | 8.9 | 3349 | 54 | 456 | 48 | 449 | 0 | 41 |
| www.apple.com | 13.0 | 7995 | 389 | 974 | 88 | 884 | 111 | 337 |
| en.m.wikipedia.org/wiki/PlayStation_Vita | 14.7 | 9208 | 1183 | 2897 | 1609 | 477 | 82 | 130 |
| www.theguardian.com/international | 15.5 | 1615 | 1514 | 3599 | 71 | 772 | 47 | 49 |
| github.com/vitasdk | 16.1 | 4575 | 1004 | 1950 | 74 | 2991 | 13 | 27 |
| duckduckgo.com | 17.8 | 12595 | 484 | 949 | 60 | 656 | 28 | 11 |
| www.amazon.com | 19.9 | 9502 | 461 | 1115 | 64 | 2822 | 307 | 311 |
| www.espn.com | 35.3 | 22670 | 533 | 1201 | 118 | 2699 | 177 | 122 |
| stackoverflow.com/questions | 40.0 | 19732 | 594 | 1647 | 81 | 1832 | 175 | 248 |
| www.youtube.com | 40.1 | 16915 | 38 | 210 | 57 | 4813 | 2 | 12 |
| www.cnn.com | 45.8 | 21797 | 4419 | 7151 | 3457 | 3082 | 66 | 191 |
| old.reddit.com/r/vita/ | 57.8 | 19104 | 27 | 210 | 130 | 4229 | 507 | 1772 |
| www.reddit.com/r/vita/ | over 60 | | | | | | | |
| www.bbc.com/news | over 60 | | | | | | | |
| www.nytimes.com | over 60 | | | | | | | |
| www.npr.org | over 60 | | | | | | | |
| www.ebay.com | over 60 | | | | | | | |

The parts are in milliseconds.

The five that ran out of time were loaded again by hand after the run:

| Site | Loaded by hand | What held it |
|---|---|---|
| www.reddit.com | 52.9 s | sent on to old.reddit's login page, slow in its own right |
| www.bbc.com | 57.7 s | script, in the page and its frames, and many large STYLE elements |
| www.nytimes.com | captcha at 25.8 s | DataDome's slider check, which needs a press and a drag (drags reach the page from build 745) |
| www.npr.org | 71.7 s, then 15.6 s and 24.1 s | its consent page first; near the goal once past it |
| www.ebay.com | 90.4 s | its sensor script, then redraws of 0.4 to 0.9 s each second |

### Sites retired from the run

The eleven above 8.9 s and below are well inside the goal and leave the
run, with the figures above as their last measurement: lite.cnn.com,
www.w3.org, archive.org, www.bing.com, www.wikipedia.org, www.google.com,
developer.mozilla.org, news.ycombinator.com, www.weather.gov,
www.imdb.com and www.craigslist.org. Eleven new sites take their places,
for frameworks and page shapes the run did not cover; none could be
checked from where the list was made, so any that shows a login wall or a
bot check should be swapped for another. The next run's
`ux0:data/VitaSurf/sitetest.txt`:

```
https://en.m.wikipedia.org/wiki/PlayStation_Vita
https://duckduckgo.com/
https://old.reddit.com/r/vita/
https://www.reddit.com/r/vita/
https://www.bbc.com/news
https://www.cnn.com/
https://www.theguardian.com/international
https://www.nytimes.com/
https://www.npr.org/
https://github.com/vitasdk
https://stackoverflow.com/questions
https://www.amazon.com/
https://www.ebay.com/
https://www.youtube.com/
https://www.espn.com/
https://www.apple.com/
https://www.yahoo.com/
https://www.theverge.com/
https://www.washingtonpost.com/
https://medium.com/
https://www.twitch.tv/
https://x.com/
https://www.target.com/
https://weather.com/
https://www.fandom.com/
https://www.pinterest.com/
https://open.spotify.com/
```

## What a load reports

A finished page logs its total, then where the time went:

```
page: <url> loaded in N ms
page: of that, html parse N ms, css N ms, images N ms, boxes and styles N ms, layout N ms
qjs: load event, runtime memory N KB; N scripts of N KB compiled in N ms, ran in N ms
```

Those phases cover the processing side of a load. Whatever the total
exceeds their sum is network time.
