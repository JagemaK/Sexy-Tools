# Samuel Erkuye: Software Engineer & AI Automation portfolio

A single static page (`index.html`). There's no build step.

## Deploy to Vercel
1. Go to <https://vercel.com/new> and import the `Sexy-Tools` repo again. It becomes a second project, separate from the SDR site.
2. Set **Root Directory** to `swe-portfolio` and **Framework Preset** to `Other`.
3. Set **Project Name** to `samuel-erkuye-dev`, so the address is `https://samuel-erkuye-dev.vercel.app`, the URL on the CV.
4. Click **Deploy**.

If you pick another name, update the `og:image` URL in `<head>` and the portfolio link in the CV.

## Personalize
At the top of the `<script>`: `cvUrl` (copy the PDF into this folder) and an optional `calendlyUrl`.
