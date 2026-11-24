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
2. `Open output`, drag that window to the projector, click it (or press F) for fullscreen. The output size
   switches to that display's pixel size on its own, so the projection and every export match the device.
   If the sizes ever differ, the picture is letterboxed, never stretched.
3. Add a shape from the `Add` panel (Quad, Box, or a preset mask), then drag the corners until they sit on
   the real surface. `Guides` draws outlines and
   a crosshair on the projector while you align; `Test pattern` shows a grid.
4. Import video or images (button or drag and drop), select a shape, click a media item.
5. `Export` for MP4, SVG outlines, or the JSON layout.

## Quad and mask

Every shape has two outlines, and the `Editing` bar above the canvas picks which one the handles move:

- **Quad** (cyan, square handles): the 4 corners the content is warped to.
- **Mask** (amber, round handles): the outline that decides what part is visible. Any number of points.

On a new shape they are the same four points, and the bar says `Mask follows the quad`. Reshaping the mask,
or adding or deleting a mask point, separates them. `Reset mask to quad` joins them again.

`Add point`: click the button, then click where the point goes. It joins the nearest mask edge.
`Delete point`: click the button, then click the point. A mask keeps at least 3 points.

| Action | Input |
| --- | --- |
| Move a handle | Drag. Snaps to other corners and the output edges |
| Skip snapping | Hold Cmd while dragging |
| Move one quad corner of a shared set | Hold Option while dragging |
| Edit the quad / the mask / transform the shape | Q / M / T |
| Add point / delete point tool | A / D, Esc to cancel |
| Delete the selected mask point, or the shape | Delete |
| Nudge | Arrow keys, 1 px; with Shift, 10 px |
| Zoom the canvas | Pinch or Ctrl+scroll over the canvas; `+` `-` `0` (fit) |
| Pan the canvas | Two-finger scroll, or drag with the middle button |
| Undo / redo | Cmd+Z / Shift+Cmd+Z |
| Duplicate shape | Cmd+D |
| Play / pause | Space |
| Toggle projector guides | G |

Quad corners that sit exactly on each other move together; snapping one onto another joins them.
Pinch never zooms the page, only the canvas. Each layer has its own opacity slider in the Layers list.

## Shapes and SVG

The `Add` panel has Quad and Box plus preset masks: Triangle, Circle, Hexagon, Star and Arrow. A preset is a
mask with its own upright quad around it, and it is regular in output pixels, so a circle stays round on any
output size.

`SVG file` imports shapes: every closed outline in the file (`path`, `rect`, `circle`, `ellipse`, `polygon`,
`polyline`) becomes one mask, fitted to the output with its proportions kept. Curves are sampled and
simplified to at most 72 points. Plain hex fill colours carry over. Text, images, `use` references, open
lines and anything in `defs` are skipped, and a hole in a compound path becomes its own shape rather than a
hole. To use an SVG as artwork instead, import it under Media; it is drawn as an image.

## Shaping the quad

- `Set shape…` in the bar makes the quad a true rectangle: Square, 4:3, 3:2, 16:9, their portrait forms, the
  output's own shape, or the media's. It keeps the quad's centre and rotation and fits inside the space it had.
- `Transform` (or T) puts a box around the whole shape. Drag inside to move. Corners scale in proportion; hold
  Shift to scale freely. Side handles stretch one way. The round handle above the box rotates; Shift snaps to
  15 degree steps. Scaling and rotating happen in output pixels, so nothing skews on a non-square output.
- Quad and Mask modes still move single corners and points.

## Layout

Every control is on screen at all times. The bar under the top bar holds everything for the selected shape,
including Duplicate and Delete; it wraps onto more lines when the window is narrow and takes the room from
the canvas. Only the Layers and Media lists scroll, and only when they hold more rows than fit.

The tools arrange themselves around the canvas. The Add/Tool rail sits to the left or becomes a strip above the
canvas, and Layers/Media sit to the right or become a strip below it. Whenever the window or the output size
changes, the editor measures all four combinations and keeps the one that gives the largest canvas: a landscape
output in a tall window gets strips above and below, a portrait output in a wide window gets side panels.

`Test pattern` is always drawn behind every shape.

## Output size and orientation

The output size is the projector's pixel size, and it is also the size of every export. `Rotate` swaps width
and height for a portrait display; the size menu has portrait presets. Changing the size rescales the layout
uniformly by the shorter side and keeps it centred, so shapes are not stretched and Rotate is reversible. For media, `Fit` chooses between stretching to the
quad, cover, and contain; `Set shape…` > `Same as media` reshapes the quad to the media's own aspect ratio.

## Export

- **MP4, offline**: every frame is rendered and encoded in order (H.264, no audio), so it is frame-accurate
  regardless of machine speed. The mapping is baked in: play it back at the same resolution from the same
  projector position.
- **Real-time recording**: captures the live canvas. Pacing depends on the machine.
- **SVG**: mask outlines at output size, white on a black background layer, one named polygon per shape.
  Quads that differ from their mask are in a separate group.
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
