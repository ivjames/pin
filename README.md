# Cornerpin

Projection mapping in the browser. Static files, no build step, no backend. Chrome on macOS.

## Run

Needs HTTPS or `localhost` (WebCodecs and persistent storage require a secure context).

    cd cornerpin && python3 -m http.server 8080    # then open http://localhost:8080

## Deploy

Served at https://pin.lab980.com from the lab980 droplet. `DEPLOY.md` is the runbook; the short form, on the
droplet as root:

    pin deploy     # sync the checkout to origin/main and stamp the build
    pin status     # HEAD, live probe, cert days

## Use

1. Connect the projector over HDMI as an extended display (not mirrored).
2. `Open output`, drag that window to the projector, click it (or press F) for fullscreen.
3. Set the output size to the projector's native resolution, or choose `Match output window` while it is fullscreen.
4. `+ Quad` or `+ Box`, then drag corners until they sit on the real surface. `Guides` draws outlines and a crosshair on the projector while you align; `Test pattern` shows a grid.
5. Import video or images (button or drag and drop), select a shape, click a media item.
6. `Export` for MP4, SVG outlines, or the JSON layout.

| Action | Input |
| --- | --- |
| Move a point | Drag. Snaps to other corners and the output edges |
| Skip snapping | Hold Cmd while dragging |
| Move one corner of a shared set | Hold Option while dragging |
| Add a point | Click an edge of the selected shape |
| Remove a point | Select it, Delete (minimum 3) |
| Nudge | Arrow keys, 1 px; with Shift, 10 px |
| Undo / redo | Cmd+Z / Shift+Cmd+Z |
| Duplicate shape | Cmd+D |
| Play / pause | Space |
| Toggle projector guides | G |

Corners that sit exactly on each other move together. Snapping one corner onto another joins them.

## Content frame

A 4-point shape warps its content to its own corners. With any other point count the outline only masks, and
content is warped by a separate 4-corner frame (dashed). `Edit content frame` shows its handles.

## Export

- **MP4, offline**: every frame is rendered and encoded in order (H.264, no audio), so it is frame-accurate
  regardless of machine speed. The mapping is baked in: play it back at the same resolution from the same
  projector position.
- **Real-time recording**: captures the live canvas. Pacing depends on the machine.
- **SVG**: shape outlines at output size, white on a black background layer, one named polygon per shape.
  Content frames of non-quad shapes are in a separate group.
- **JSON**: layout only. Media is matched by file name on import.

## Storage

Media and the project autosave live in this browser's IndexedDB for this origin. Clearing site data removes
them. A different browser or machine starts empty: import the JSON layout and the media files again.

## Files

    index.html, output.html, css/app.css
    bin/pin, deploy/nginx.conf.template   operate CLI and vhost (see DEPLOY.md)
    js/main.js       editor, UI, output window
    js/renderer.js   WebGL2 renderer and built-in shaders
    js/geometry.js   homography, triangulation, snapping
    js/exporter.js   MP4, recording, SVG, JSON
    js/media.js, js/store.js, js/state.js
    vendor/mp4-muxer.js   MIT, see vendor/mp4-muxer.LICENSE
