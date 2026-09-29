# Modules

Module loading that depends on how a server answers, so these pages are
served over HTTP rather than opened as `file://` URLs and are not part of
the `tests/dom` run.

`redirect.html` checks a module import that is answered with a redirect,
the way unpkg answers a version range such as `lit-html@^1.1.1`. Serve
it with the server next to it and load it in the harness:

    python3 tests/modules/redirect-server.py 18770 tests/modules/redirect.html &
    (echo "WINDOW NEW"; echo "WINDOW GO 0 http://127.0.0.1:18770/page.html";
     sleep 4; echo QUIT) | deps/netsurf/nsmonkey --enable_javascript=1 |
     grep -E "PASS|FAIL"

The server counts the requests it gets, which the page reads back from
`/hits` to check that nothing was fetched twice.
