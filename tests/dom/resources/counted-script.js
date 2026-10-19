/* counts its runs, for script-load-events.html */
window.runs = (window.runs || 0) + 1;
window.ranBefore = window.ranBefore || [];
window.ranBefore.push(document.currentScript ? document.currentScript.id : "none");
