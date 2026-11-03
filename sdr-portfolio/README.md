# Samuel Erkuye: SDR Portfolio

A single static page (`index.html`). There's no build step and nothing to install.

## Deploy to Vercel (about 2 minutes)

1. Go to <https://vercel.com/new> and click **Import** next to the `Sexy-Tools` GitHub repo.
   (If it isn't listed, click "Adjust GitHub App Permissions" and allow access to the repo.)
2. **Root Directory** → click *Edit* → choose `sdr-portfolio`.
3. **Framework Preset** → `Other`. Leave the build and output settings empty.
4. **Project Name** → something like `samuel-erkuye-sdr`. Your link becomes `https://samuel-erkuye-sdr.vercel.app`.
5. Click **Deploy**.

Every later push to the deployed branch redeploys automatically. In Vercel → Project → Settings → Git you can set the
Production Branch to `claude/serene-ptolemy-ucm7ij`, or merge it into `main` first.

**Without GitHub:** run `npx vercel` inside this folder and log in when it asks.

## Personalize (top of the `<script>` in index.html)

```js
const CONFIG = {
  calendlyUrl: "",  // your Calendly link. Empty = buttons open an email to you
  cvUrl: "",        // e.g. "Samuel-Erkuye-CV.pdf" after you copy the final PDF into this folder
  pitchVideo: "",   // Loom embed link of you doing a 60-sec cold call (strongly recommended)
  pitchAudio: ""    // or an .mp3 in this folder
};
```

Empty values are hidden on the page, so nothing looks broken.

If you name the Vercel project something other than `samuel-erkuye-sdr`, update the `og:image` URL in the
`<head>` so your photo shows in LinkedIn and Slack link previews.
