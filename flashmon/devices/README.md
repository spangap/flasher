# Board photos

The pictures the **device box** shows when a detection run identifies a board.
Nothing here is required: a board with no photo just gets a text-only box.

Drop an image in beside this file and point the board's catalogue entry at it in
the catalogue's `builds.yaml`:

```yaml
builds:
  - name: hw-lilygo-tdeck
    image: devices/hw-lilygo-tdeck.jpg
```

The path is relative to the web root (this repo's `flashmon/` directory), and it
has to be a **local** file — the page loads nothing from a third-party CDN, so a
remote URL is not an option. Naming the file after the `hw-<straddle>` it shows
keeps the mapping obvious, but only the `image:` value decides what is loaded.

Any format the browser renders works (JPEG, PNG, WebP, SVG). The box scales the
picture to fit a 230 px-tall panel without cropping, so a wide shot of the board
on a plain background reads best. Keep it small — it is served on every
detection, from a deployment that may be the device's own web server.
