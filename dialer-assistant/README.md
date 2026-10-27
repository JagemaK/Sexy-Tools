# Dialer Assistant (Edge extension)

Phone number → control number lookup, plus the automated "called in" disposition
passes on `proxy2.alliancedialer.com` / `69.10.47.54`.

## Install (Edge)
1. Go to `edge://extensions`, turn on **Developer mode**.
2. Click **Load unpacked** and pick this `dialer-assistant` folder.
3. Open the extension's **Settings** (click the toolbar icon on any non-dialer tab, or "Settings / import data" in the panel)
   and import `NEOS_Cellphones.xlsx`. It is a one-time import (about 30–60 s), and the data stays in the browser.

## Use
A **Dialer Assistant** panel appears in the bottom-right of the dialer pages (click its header or the toolbar icon to collapse it).

1. Type the caller's phone number and click **Find**. You'll see the control number(s) with **Copy** and **Run** buttons.
   With one match, it is copied automatically. If the file has no match, use **Search site by phone**.
2. **Run** does this:
   - search control # → Select → Finish → disposition **Shareholder called in** → Save
   - search again → Select → Finish → disposition **Endeavor letter** → Save
   - search again → Select → Finish → **stops on the disposition page** for the agent.
3. **Stop** halts the run at any point. If a step can't find something within 20 s, the run stops and the panel names the missing item.

The disposition names, the search path, and the timeouts can all be changed in Settings.
Disposition text has to match the name on the page (case and punctuation are ignored).

Spreadsheets and CSVs are git-ignored. Never commit shareholder data.
