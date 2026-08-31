# Mural clipboard format — REAL, captured 2026-08-27

Captured from an actual Mural copy (app.mural.co, Chromium source). This replaces
all earlier guesses. The old `<html v="1">` sticky guess was WRONG.

## Clipboard envelope

A real Mural copy writes **8 formats**. The one that matters:

- `HTML Format` (CF_HTML) whose fragment is a single element:
  ```html
  <murally hiddenContent="mly://{BASE64}"></murally>
  ```
- Other formats present: `System.String`, `UnicodeText`, `Text`, `OEMText`,
  `Chromium internal source URL` (the mural URL), `Chromium internal source RFH token`, `Locale`.
- The visible text formats are essentially empty (whitespace) — all real data is
  in the `mly://` base64 blob.

The source URL confirms Mural, e.g.
`https://app.mural.co/t/{workspace}/m/{workspace}/{muralNum}/{hash}`.

## The `mly://` payload

`mly://` is followed by **base64** of a JSON envelope:

```jsonc
{
  "canvasLink": "https://app.mural.co/t/.../m/.../.../<hash>",
  "isAleActivated": false,
  "isTemplate": false,
  "labels": [],
  "muralId": "vgcs0959.1787916905066",   // "{workspace}.{muralNumber}"
  "tags": [],
  "zone": "eu",                           // deployment zone
  "widgets": [ /* array of widget objects */ ]
}
```

## Widget — common shape

Every widget has these top-level keys:

```jsonc
{
  "id": "0-1788106186312",     // "{n}-{timestampish}" unique id
  "type": "murally.widget.PhotoWidget",
  "x": 534.0025, "y": 22.0,    // canvas coords
  "width": 40, "height": 114,
  "rotation": 0,
  "invisible": false,
  "owner": "u354c7dd9116c6a30ee0d0350",
  "stackingOrder": 29,
  "properties": { /* common + type-specific */ }
}
```

### Common `properties` (all widget types)

```
appMetadataUpdatedAt, createdAt, hidden, hideEditor, hideOwner, instruction,
lastContentEdited, lastContentEditedBy, lastUpdate, lastUpdateBy,
lastUpdateWithAI, lastUpdateWithAIBy, locked, lockedByFacilitator, parentId,
partOf, presentationIndex, title, withAI
```

## Widget types observed

| type | count | purpose |
|------|-------|---------|
| `murally.widget.PhotoWidget` | 12 | an image/icon on the canvas |
| `murally.widget.arrow` | 4 | connector/arrow between widgets |
| `murally.widget.InkingWidget` | 2 | freehand pen strokes |

### PhotoWidget type-specific properties

```
aspectRatio, border, contentPrivate, dlpDownloadRestricted, footer, link,
mask, naturalHeight, naturalWidth, photoURL, privateImage, showCaption, tags,
thumbURL
```

- `photoURL`: server-relative, e.g.
  `/api/murals/vgcs0959/1787916905066/assets/vgcs0959/0-1788106115853.png`
  -> images are Mural-hosted assets; pasting a NEW image needs an upload, not
  just a URL we invent.

### arrow type-specific properties

```
arrowType, endRefId, endTipType, points, stackable, startRefId, startTipType,
strategy, strokeColor, strokeStyle, strokeWidth, tip
```

- `points`: array of `{x,y}` relative to the widget origin.
- `startRefId` / `endRefId`: ids of widgets the arrow connects (or null).
- `strategy`: `{ reattached:{end,start}, type:"straight" }`.
- `strokeColor` e.g. `#1f1f1f`, `strokeWidth` 3, `tip` 1.

### InkingWidget type-specific properties

- `paths`: `{ "<id>": { color, data (base64 stroke), maxWidth, minWidth, tipRounding, version, widthEasing } }`.

## Implications for the Mural PEN (rebuild)

1. Wrap payload as `<murally hiddenContent="mly://{base64}"></murally>` inside
   CF_HTML — NOT the old `<html v="1">` sticky guess.
2. Build the JSON envelope with `zone`, `muralId`, `canvasLink`, `widgets[]`.
   For a fresh paste into any mural, `muralId`/`canvasLink` may be ignored or
   must match target — TO VERIFY by pasting a generated payload.
3. Each widget needs id, type, x/y/w/h, owner, stackingOrder, full `properties`.
4. **Images are asset-hosted** (`photoURL` points to Mural's asset API). We
   cannot inject an arbitrary local PNG as a PhotoWidget via clipboard alone;
   that needs Mural's asset upload. A local icon is better delivered as a plain
   clipboard image (image pen) and let Mural ingest it as a new asset on paste.
5. Best pen targets we CAN synthesize confidently: **arrow** connectors and
   simple text-bearing widgets, plus **InkingWidget** is complex (skip).

## Open questions to validate by round-trip paste

- Does Mural accept a generated `mly://` with a different/blank `muralId`?
- Minimum required `properties` per widget (many may be optional/defaulted).
- Whether `owner`/`id` can be arbitrary or must be valid.

## Reference sample

Trimmed real sample saved at `tmp/mural-real-schema.json` (envelope + one
PhotoWidget + one arrow).
