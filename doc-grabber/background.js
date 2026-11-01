// Clicking the toolbar icon opens the side panel. The panel stays open while you
// scroll the page, so lazy-loading document viewers keep rendering their pages.
function enablePanelOnClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
chrome.runtime.onInstalled.addListener(enablePanelOnClick);
chrome.runtime.onStartup.addListener(enablePanelOnClick);
