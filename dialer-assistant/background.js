importScripts('common.js');

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'lookup') {
    daLookup(msg.phone)
      .then(r => sendResponse({ ok: true, ctrls: r.ctrls, names: r.names }))
      .catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'incomingCall') {
    forwardCall(msg.phone, sender.tab).then(sendResponse);
    return true;
  }
  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
  }
});

const DIALER_URLS = [
  'http://69.10.47.54/*', 'https://69.10.47.54/*',
  'http://proxy2.alliancedialer.com/*', 'https://proxy2.alliancedialer.com/*'
];

// Zoiper opens a new tab with the caller's number. If a dialer tab is already
// open, hand the number to it, bring it to the front and close the new tab.
async function forwardCall(phone, fromTab) {
  const tabs = (await chrome.tabs.query({ url: DIALER_URLS })).filter(t => t.id !== fromTab.id);
  if (!tabs.length) return { handleHere: true };
  tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  for (const t of tabs) {
    try {
      await chrome.tabs.sendMessage(t.id, { type: 'incomingCall', phone });
      await chrome.tabs.update(t.id, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      chrome.tabs.remove(fromTab.id);
      return { forwarded: true };
    } catch (e) {
      // tab without our content script (still loading, etc.): try the next one
    }
  }
  return { handleHere: true };
}

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
