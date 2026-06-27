# HumToKeys

A browser app that records a sung or hummed melody, estimates pitch with the Web Audio API, turns the result into a simple generated sheet with eighth, quarter, half, dotted half, and whole notes, and plays it back on a canvas-rendered 3D piano with animated key presses.

Live app:

https://zivcohen-projects.github.io/HumToKeys/

## GitHub Pages

In the GitHub repo, go to **Settings -> Pages** and set:

- Source: **Deploy from a branch**
- Branch: **main**
- Folder: **/(root)**

After GitHub saves that setting, the app will be available at the live app URL above.

## Run locally

Because microphone access requires HTTPS or localhost, serve the folder instead of opening the HTML file directly.

```powershell
python -m http.server 4173
```

Then open:

```text
http://localhost:4173/HumToKeys/
```

## Notes

- Pitch detection is an autocorrelation prototype. It works best with one clear voice or hum and low background noise.
- The sheet renderer is a lightweight SVG notation view with score export.
- The piano playback is synthesized in the browser and animated with a self-contained 3D canvas renderer.
