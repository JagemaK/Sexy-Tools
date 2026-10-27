// Runs in the page's own JS world so it can auto-accept confirm()/alert()
// popups (e.g. "Are you sure?") while an automation run is in progress.
(() => {
  const active = () => document.documentElement && document.documentElement.dataset.daRunning === '1';
  const origConfirm = window.confirm.bind(window);
  const origAlert = window.alert.bind(window);
  window.confirm = msg => (active() ? true : origConfirm(msg));
  window.alert = msg => (active() ? undefined : origAlert(msg));
})();
