# Companion ZIP formats

The publisher accepts the legacy single-character format and the v2 collection
format. Archives are treated as untrusted input, validated before extraction,
and deterministically repacked before publication.

## Collection format v2

```text
collection.json
companions/blue-cat/companion.json
companions/blue-cat/frames/idle-01.png
companions/blue-cat/sounds/hello.wav
companions/orange-cat/companion.json
companions/orange-cat/frames/idle-01.png
```

Example `collection.json`:

```json
{
  "schemaVersion": 2,
  "id": "corner-friends",
  "name": { "en": "Corner Friends", "zh": "角落伙伴" },
  "maxVisible": 6,
  "mobileMaxVisible": 2,
  "companions": [
    {
      "id": "blue-cat",
      "manifest": "companions/blue-cat/companion.json",
      "enabled": true,
      "count": 2,
      "mobileCount": 1,
      "scale": 0.9,
      "behavior": "auto"
    }
  ]
}
```

Each nested `companion.json` uses schema version 2:

```json
{
  "schemaVersion": 2,
  "id": "blue-cat",
  "name": { "en": "Blue Cat", "zh": "蓝猫" },
  "canvas": { "width": 128, "height": 128 },
  "initialState": "idle",
  "states": {
    "idle": {
      "label": "Idle",
      "loop": true,
      "motion": "stay",
      "frames": [
        {
          "src": "frames/idle-01.png",
          "durationMs": 160,
          "anchor": [64, 128],
          "velocity": [0, 0],
          "sound": "sounds/hello.wav",
          "volume": -10
        }
      ]
    }
  },
  "behaviorPool": [{ "state": "idle", "weight": 100 }]
}
```

`behavior` is either `auto` or `click`. Automatic characters choose from their
weighted behavior pool after completing an animation cycle. Sound is optional
and only plays after a visitor interacts with a character, preserving browser
autoplay rules.

## Legacy single-character format v1

```text
companion.json
frames/idle-01.png
frames/idle-02.png
```

The v1 manifest keeps the original `schemaVersion`, `id`, bilingual `name`,
`canvas`, `initialState`, and `states` fields. It remains supported and is
rendered as one automatic companion.

## Limits

- compressed ZIP: 24 MiB
- expanded data: 64 MiB
- files: 1,024
- individual file: 4 MiB
- character types: 12
- visible instances: 8 desktop, 4 mobile
- unique PNG frames: 768
- states per character: 160
- references per character: 4,096
- PNG dimensions: 512×512 maximum
- frame timing: 40–10,000 ms
- WAV only for sound

Paths must be relative ASCII paths matching the documented layout. Scripts,
HTML, SVG, executable content, symlinks, traversal paths, external URLs,
unreferenced assets, encrypted ZIPs and unsafe compression ratios are rejected.

## Native Shijima imports

The administrator page can accept a ZIP containing one or more `.mascot`
directories. The browser-side importer reads English or Japanese action tags,
frame timing, anchors, numeric velocities, behavior weights and referenced WAV
sounds. It does not execute condition expressions or include the source XML in
the published pack. The generated v2 collection is validated again by the
server before publication.
