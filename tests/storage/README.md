# Storage

`indexeddb.html` lives here rather than in `tests/dom` because it cannot
be compared the way those are. `scripts/dom-compare.sh` serves its pages
as `file://` URLs, and a `file://` page has an opaque origin that Chrome
gives no IndexedDB at all: the browser side of that comparison stops
after a dozen facts having never opened a database.

`scripts/idb-compare.sh` runs it over HTTP instead, driving a real
browser rather than a headless dump, because headless Chrome's
`--virtual-time-budget` does not advance the clock IndexedDB's work runs
on. It also checks the two things a comparison cannot: that what a page
stores is still there in the next run, and that another origin cannot
see it.

    ./scripts/idb-compare.sh
