# Benchmarks

Measured page load times on real hardware, against the browser Sony
shipped with the console. Both run on the same device over the same
network, so the comparison is fair even though the timings are taken by
hand.

Method: time from committing the URL to the page being readable, then
read `ux0:data/VitaSurf/log.txt` for the breakdown VitaSurf reports.

| Page | Sony's browser | VitaSurf | VitaSurf build |
|---|---|---|---|
| `en.wikipedia.org/wiki/PlayStation_Vita` | 13 s | 30 s | 93 |
| `m.youtube.com` search results | 20 s | not measured | |

Notes on the two pages above.

The Wikipedia article is the main target. Sony's browser fetches the
desktop site and lays out the infobox table and images correctly, so it
is not winning by rendering something simpler. The gap is speed, not
capability.

YouTube is a single page application, which `CLAUDE.md` lists as a
non-goal, and VitaSurf currently declines to run any script over
`SCRIPT_MAX_BYTES`, naming YouTube's bundle as the reason. That limit
was set before there was any measurement of what compiling costs.
Compiling runs at about 0.086 ms per KB natively, so roughly 2.2 ms per
KB on the device, which puts a two megabyte bundle near four and a half
seconds. Whether that is affordable, and what YouTube actually ships,
wants a log rather than an opinion: the skip is logged with the size.

## What a load reports

A finished page logs its total, then where the time went:

```
page: <url> loaded in N ms
page: of that, html parse N ms, css N ms, images N ms, boxes and styles N ms, layout N ms
qjs: load event, runtime memory N KB; N scripts of N KB compiled in N ms, ran in N ms
```

Those phases cover the processing side of a load. Whatever the total
exceeds their sum is network time.
