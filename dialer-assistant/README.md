# Dialer Assistant (Edge extension)

Phone number → control number lookup, plus the automated "called in" disposition
passes on `proxy2.alliancedialer.com` / `69.10.47.54`.

## Install (Edge)
1. Go to `edge://extensions`, turn on **Developer mode**.
2. Click **Load unpacked** and pick this `dialer-assistant` folder.
3. Open the extension's **Settings** (click the toolbar icon on any non-dialer tab, or "Settings / import data" in the panel)
   and import `NEOS_Cellphones.xlsx`. It is a one-time import (about 30–60 s), and the data stays in the browser.

## Use
A **Dialer Assistant** panel floats over the dialer pages.

- **Move it** by dragging the blue header. **Resize it** from any edge or corner. Double-click an edge to go back to automatic height.
  The position and size are remembered across tabs and reloads.
- **Minimize** it with the – button, by double-clicking the header, or with the toolbar icon. **Alt+Shift+F** focuses the phone box.

1. Paste the caller's phone number (it looks it up right away) or type it and press Enter.
   Every matching control number is shown as a card with **Copy** and **Run**. Click a number to copy it. With one match, it's copied automatically.
   The last 5 numbers you looked up appear as chips under the box.
2. If the file has no control number for that phone:
   - If the file has the owner's **name** for that phone, click **Search site for "NAME"**. That fills First/Last Name on the search page.
   - Otherwise, use **Search site by phone**.
3. **Run** shows a live checklist while it works:
   - search control # → Select → Finish → disposition **Shareholder called in** → Save
   - search again → Select → Finish → disposition **Endeavor letter** → Save
   - search again → Select → Finish → **stops on the disposition page** for the agent.
4. **Stop** halts a run. If a step can't find something within 20 s, the run stops and the panel names the missing item.

The disposition names, the search path, and the timeouts can all be changed in Settings.
Disposition text has to match the name on the page (case and punctuation are ignored).

Spreadsheets and CSVs are git-ignored. Never commit shareholder data.
