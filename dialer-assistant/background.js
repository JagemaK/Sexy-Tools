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
  if (msg.type === 'notify') {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon128.png', title: msg.title, message: msg.message || '', priority: 1
    });
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

// Time clock safety net: the clock in/out itself happens in a dialer tab, so
// make sure one is open shortly before a scheduled event.
chrome.alarms.create('clock-check', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'clock-check') return;
  const state = await daGetClock();
  if (!state.cfg.enabled) return;
  const soon = daClockPlan(state).today.find(e =>
    ['upcoming', 'warn', 'due'].includes(e.status) && e.at - Date.now() < 3 * 60000);
  if (!soon) return;
  const tabs = await chrome.tabs.query({ url: DIALER_URLS });
  if (tabs.length) return;
  const { lastOrigin, settings } = await chrome.storage.local.get(['lastOrigin', 'settings']);
  const path = (settings && settings.searchPath) || DA_DEFAULTS.searchPath;
  chrome.tabs.create({ url: (lastOrigin || 'http://proxy2.alliancedialer.com') + path, active: false });
  daLog('clock', `Opened a dialer tab for the scheduled clock ${soon.kind}.`);
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
