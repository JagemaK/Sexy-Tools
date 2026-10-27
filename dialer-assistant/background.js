importScripts('common.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'lookup') {
    daLookup(msg.phone)
      .then(r => sendResponse({ ok: true, ctrls: r.ctrls, names: r.names }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'focus-phone' && tab) chrome.tabs.sendMessage(tab.id, { type: 'focusPhone' }).catch(() => {});
});

// Toolbar icon: toggle the in-page panel on dialer tabs, otherwise open settings.
chrome.action.onClicked.addListener(async tab => {
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'togglePanel' });
  } catch (e) {
    chrome.runtime.openOptionsPage();
  }
});
