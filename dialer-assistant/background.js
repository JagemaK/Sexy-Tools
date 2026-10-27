importScripts('common.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'lookup') {
    daLookup(msg.phone)
      .then(ctrls => sendResponse({ ok: true, ctrls }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
});

// Toolbar icon: toggle the in-page panel on dialer tabs, otherwise open settings.
chrome.action.onClicked.addListener(async tab => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' });
  } catch (e) {
    chrome.runtime.openOptionsPage();
  }
});
