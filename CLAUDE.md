# Cornerpin — working notes

Browser projection mapping: warp video, images and shader effects onto flat surfaces and boxes, then export the mapped result as MP4. Static, no build.

Served at **https://pin.lab980.com** from the lab980 droplet.

How work lands here — branch, PR, and the fact that merging is not deploying —
is in `.claude/rules/lab980-conventions.md`, which Claude Code loads
automatically every session. That file is owned by the lab980 scaffold and is
overwritten by it; **this** file is the site's own, and everything below is
about this site rather than about the platform. For the box itself, read the
`ivjames/lab980.com` repo's `CLAUDE.md`.

## Shape

Fully **static**: the site is files served straight by nginx. No build step,
no app process, no local port, no pm2, no database. nginx serving the git
checkout *is* the deployment, so "what's on `main`" and "what's live" differ
only by a `git reset` on the droplet.

- Repo: `ivjames/pin` · droplet checkout: `/var/www/pin` (the web root)
- Operate CLI: `bin/pin`, symlinked to `/usr/local/bin/pin`
- vhost: generated from `deploy/nginx.conf.template` by `pin setup`

## Deploying

On the droplet, as root:

```bash
pin deploy      # git fetch + reset --hard origin/main (+ build stamp)
pin status      # HEAD, live probe, cert days remaining
```

Full runbook, including first-time bring-up: `DEPLOY.md`.

Checking what is actually live, concretely for this site — `pin status`
on the box, or from anywhere:

```bash
curl -s -o /dev/null -w 'HTTP %{http_code}\n' https://pin.lab980.com/
curl -s https://pin.lab980.com/ | grep -o "const BUILD = '[^']*'" | head -1
```

(The second line reports nothing if the page carries no `BUILD` constant — see
the deploy stamp note in `DEPLOY.md`. `head -1` because a page that polls its
own build stamp carries a matching regex literal, which grep otherwise reports
as a phantom second build.)

## Things worth knowing

- The droplet checkout is the web root, so anything committed here is public
  except dotfiles and `*.md` (the vhost denies both). That includes `bin/pin`
  and `deploy/`. Don't commit secrets; there is no `.env` on a static site.
- **Everything runs in the visitor's browser.** Imported media and the project
  autosave live in that browser's IndexedDB for this origin; nothing is
  uploaded and the droplet stores nothing. Changing the fqdn changes the
  origin, which strands every user's saved media and project.
- **Chrome only, and HTTPS only.** Offline MP4 export uses WebCodecs
  (`VideoEncoder`), which needs a secure context; over plain HTTP the export
  and persistent storage do not work. Real-time recording (MediaRecorder) is
  the fallback. No other browser is supported or tested.
- **Two outputs, one renderer.** `Open output` is in-page: `#present` in
  `index.html` covers the editor and asks for fullscreen inside the click
  (`openOutput()` / `closeOutput()`); if fullscreen is refused it still fills
  the window. While it is up the key handler runs only Esc, Space and G, so
  nothing edits blind. `Second window` is the older path: `output.html`,
  opened with `window.open`, which the editor draws into directly, so that
  page does nothing useful on its own and a pop-up blocker stops it. Both are
  fed from `presentOutput()` each frame.
- **The vhost template is not the unmodified scaffold.** It revalidates every
  `.html`, `.js` and `.css` (unhashed ES modules; a stale `js/main.js` beside
  a fresh `index.html` is the failure it prevents), and its dotfile deny is
  the `(?!well-known)` form. `pin setup` leaves an existing vhost alone, so a
  later change to the template reaches the box only by editing the installed
  file there or removing it and re-running setup.
- **`index.html` carries `const BUILD = 'dev'`**, which `pin deploy` rewrites
  to the deployed short SHA; the editor shows it in the status bar. `dev` on
  the live site means no deploy has run since the first clone.
- `vendor/mp4-muxer.js` is a vendored copy of mp4-muxer 5.2.2 (MIT). It is not
  installed by anything; update it by replacing the file.
- **No test suite in this repo.** Changes are verified in headless Chrome
  (editing, tools, zoom, warp accuracy, frame-accurate MP4 export,
  persistence) from scripts that are not committed. Trackpad pinch and real
  fullscreen cannot be driven from there.
- Coordinates in the project model are normalized to the output (0..1).
  `setOutputSize` rescales every shape uniformly about the centre, by the ratio
  of the shorter sides, so a change of aspect ratio does not stretch the layout
  and swapping width and height twice is lossless.
- **Each shape has a quad and a mask.** `pts` is the mask (N points, what is
  visible); `frame` is the quad (4 corners the content is warped to).
  `frame: null` on a 4-point shape means they are linked: the mask *is* the
  quad. `outline()`, `unlink()` and `relink()` in `js/main.js` are the only
  places that should decide which array a handle writes to. Projects saved by
  v1 load unchanged; the reverse is not true once a 4-point mask has its own
  quad, because v1 dropped `frame` on 4-point shapes.
- **Quad and mask are locked together unless the shape is unlocked.**
  `lockQuad` is true on every new shape and on any saved shape that lacks the
  field; `Edit separately` (`toggleSeparate()`) flips it. While it is true
  nothing may write to one outline alone: `app.target` is a getter that turns
  `quad`/`mask` into `transform` (or into `quad` where the mask is the quad),
  `setTarget()`, the point tools and `weldedWith()` refuse, and the inspector
  hides or disables the quad-only controls. A new control that edits the quad
  or the mask by itself has to honour the flag the same way.
- **No control may be scrolled out of view.** `#bar`, `#inspector` and `#rail`
  must never get `overflow: auto` or a fixed height: the first two wrap and
  take their height from the canvas row, the rail is sized to fit. The only
  scrolling elements are the Layers and Media lists (`.scroll`). When adding
  a control, check it at 1000x600 as well as on a large window.
- **The layout has four arrangements and picks one by measuring.** `arrange()`
  in `js/main.js` sets `data-rail` (`left`/`top`) and `data-lists`
  (`right`/`bottom`) on `<body>`, reads the stage size for each of the four
  combinations, and keeps the one with the largest canvas scale, rejecting any
  in which the rail overflows or the lists are squeezed flat. A new panel has
  to work in all four; the CSS for them is the last block of `css/app.css`.
- **Anything that must not skew is done in output pixels, in the shape's own
  frame.** `localFrame()` rotates into the frame where the quad's top edge is
  +x. Aspect presets, the transform box, scaling and rotation all go through
  it. Doing the same maths in normalized coordinates is wrong on any
  non-square output: a rotation would shear.
- **SVG shape import never inserts the uploaded file into the page.**
  `js/svgimport.js` parses it with DOMParser and copies only numeric geometry,
  transform attributes and hex fills into clean elements in a hidden `<svg>`
  for measuring. Keep it that way: inserting the parsed nodes would run the
  file's event-handler attributes. SVG *media* goes through an `<img>`, which
  runs no scripts.
- **The page never scrolls or zooms; only the canvas does.** `html` and `body`
  are `position: fixed`, and a window-level `wheel` listener cancels every
  ctrl+wheel (what a trackpad pinch sends) and turns the ones over `#stage`
  into canvas zoom. Anything new that needs to scroll has to live inside a
  `.scroll` list in the sidebar.
- **Output size follows the display.** When the output window enters
  fullscreen, the editor reads its pixel size and adopts it (undoable).
  `output.html` letterboxes with `object-fit: contain`, so a mismatch shows
  bars and never distortion. In tests fullscreen is simulated by defining
  `document.fullscreenElement` on the output page. The in-page output's
  fullscreen is real in headless Chrome; a real second-window fullscreen
  transition has not been exercised.
