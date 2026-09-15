# Script time budget

Two pages that loop forever while reaching back into the browser, which
is the shape that used to get past the budget: a script that mutates the
DOM (`mutate.html`) and one that dispatches an event (`dispatch.html`).
Each pass goes out to C and comes back, and each of those returns used to
be a place where the abort could be dropped or the deadline re-armed.

Both have a backstop that leaves the loop after 90 seconds, so a failure
ends the test rather than hanging it. The backstop firing *is* the
failure: the budget is 20 seconds.

Run them with the native harness, which takes `script_timeout` from the
same option NetSurf uses:

    cd deps/netsurf
    { echo "WINDOW NEW"
      echo "WINDOW GO 0 file://$PWD/../../tests/budget/mutate.html"
      sleep 55; echo "QUIT"; } | ./nsmonkey --enable_javascript=1

A pass looks like this, with the script stopping on its own deadline and
the page's own `catch` never running:

    qjs: script exceeded its time budget: ?inline script?
    qjs: script 0 KB compiled in 0 ms, ran in 20001 ms, ...

A failure prints the page's own "left the loop" line, or a second
"still over budget" line, or both.
