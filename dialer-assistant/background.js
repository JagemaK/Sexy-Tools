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

// ---------- Time clock keep-alive ----------
// The clicking happens in a dialer tab. With the screen off / Edge in the
// background, the browser slows timers in hidden tabs and may put tabs to
// sleep, and Windows may go to sleep. So:
//  - keep the system awake (screen may still turn off) while the schedule or an away timer is on,
//  - stop Edge from sleeping/discarding dialer tabs (and reload one that was),
//  - wake the tab with alarms: every 30 s, plus one at the exact next event time,
//  - open a dialer tab if none is open shortly before an event.
function setAwake(on) {
  if (!chrome.power) return;
  if (on) chrome.power.requestKeepAwake('system'); // both calls are idempotent
  else chrome.power.releaseKeepAwake();
}

async function pokeTabs(reason) {
  const tabs = await chrome.tabs.query({ url: DIALER_URLS });
  for (const t of tabs) {
    if (t.autoDiscardable) chrome.tabs.update(t.id, { autoDiscardable: false }).catch(() => {});
    if (t.discarded) { chrome.tabs.reload(t.id).catch(() => {}); continue; }
    chrome.tabs.sendMessage(t.id, { type: 'clockTick', reason }).catch(() => {});
  }
  return tabs;
}

async function clockHeartbeat(reason) {
  const state = await daGetClock();
  const away = state.breakState && state.breakState.on && state.breakState.plannedEnd;
  setAwake(!!((state.cfg.enabled || away) && state.cfg.keepAwake !== false));
  if (!state.cfg.enabled && !away) return;

  const plan = daClockPlan(state);
  const upcoming = plan.today.filter(e => ['upcoming', 'warn', 'due'].includes(e.status)).map(e => e.at);
  if (away) upcoming.push(state.breakState.plannedEnd);
  if (plan.next) upcoming.push(plan.next.at);
  const nextAt = Math.min(...upcoming.filter(t => t > Date.now() - 60000), Infinity);
  if (nextAt !== Infinity) chrome.alarms.create('clock-exact', { when: Math.max(nextAt, Date.now() + 1000) + 500 });

  const tabs = await pokeTabs(reason);
  if (!tabs.length && nextAt - Date.now() < 3 * 60000) {
    const { lastOrigin, settings } = await chrome.storage.local.get(['lastOrigin', 'settings']);
    const path = (settings && settings.searchPath) || DA_DEFAULTS.searchPath;
    chrome.tabs.create({ url: (lastOrigin || 'http://proxy2.alliancedialer.com') + path, active: false });
    daLog('clock', 'Opened a dialer tab for an upcoming scheduled action.');
  }
}

chrome.alarms.create('clock-check', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'clock-check' || alarm.name === 'clock-exact') clockHeartbeat(alarm.name);
});
chrome.storage.onChanged.addListener(ch => {
  if (ch.clock || ch.breakState) clockHeartbeat('changed');
});
chrome.runtime.onStartup.addListener(() => clockHeartbeat('startup'));
chrome.runtime.onInstalled.addListener(() => clockHeartbeat('installed'));
clockHeartbeat('loaded');

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
