window.__late = { state: document.readyState, dclBefore: window.__dcl === true };
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { window.__late.gotDcl = true; });
} else {
  window.__late.gotDcl = 'not needed';
}
