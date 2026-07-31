# HumToKeys

A browser app that records a sung or hummed melody, estimates pitch with the Web Audio API, turns the result into a printable black-and-white score with eighth, quarter, half, dotted half, and whole notes, and plays it back on a full 3D piano inside an interactive music room.

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
- The piano playback is synthesized in the browser and animated on a Blender-generated GLB concert grand. Every MIDI key has a named pivot from `pivot_21_A0` through `pivot_108_C8`.

## 3D Room

The entire interface is a Three.js music room. The framed record painting changes between recording, stop, and playback states; the score and clear paintings open the score or reset a recording; and the music stand shows the current generated notation. The room is [assets/humtokeys-music-room.glb](assets/humtokeys-music-room.glb), with named anchors and interaction metadata in [assets/humtokeys-music-room.interactions.json](assets/humtokeys-music-room.interactions.json). Its Blender generator is [tools/generate_humtokeys_music_room.py](tools/generate_humtokeys_music_room.py).

## Piano Asset

The shipped piano model is [assets/concert-grand-piano.glb](assets/concert-grand-piano.glb). Its Blender generator lives at [tools/generate_concert_grand_piano.py](tools/generate_concert_grand_piano.py) and writes both the GLB and the key manifest in `assets/` when run with Blender 4.4 or later.
