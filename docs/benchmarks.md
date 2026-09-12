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

## What a load reports

A finished page logs its total, then where the time went:

```
page: <url> loaded in N ms
page: of that, html parse N ms, css N ms, images N ms, boxes and styles N ms, layout N ms
qjs: load event, runtime memory N KB; N scripts of N KB compiled in N ms, ran in N ms
```

Those phases cover the processing side of a load. Whatever the total
exceeds their sum is network time.
