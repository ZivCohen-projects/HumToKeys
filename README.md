# HumToKeys

A browser app that records a sung or hummed melody, estimates pitch with the Web Audio API, turns the result into a printable black-and-white score with eighth, quarter, half, dotted half, and whole notes, and plays it back on a canvas-rendered 3D piano with animated key presses.

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

- Pitch detection uses a YIN-style fundamental-frequency estimator with sub-sample lag interpolation, rather than a simple autocorrelation peak.
- Pitch capture filters out rumble and hiss, uses a confidence-weighted pitch lock with a generous note deadband, and runs a second pass to remove brief wrong-note blips before scoring.
- Recording waits for a half-second of clear pitch before writing notes, which helps ignore the first slide into a note.
- Natural-notes-only mode can snap recorded melodies away from sharps/flats.
- The sheet renderer is a lightweight SVG notation view with measure-safe line wrapping, full-score view, and browser-generated PDF export.
- The piano playback is synthesized in the browser and animated with a self-contained 3D 88-key piano renderer.
