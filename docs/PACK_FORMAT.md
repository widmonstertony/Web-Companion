# Companion ZIP format v1

The archive root contains `companion.json` and a `frames/` directory. No other
files are accepted.

```text
companion.json
frames/idle-01.png
frames/idle-02.png
frames/walk-01.png
frames/walk-02.png
```

Example manifest:

```json
{
  "schemaVersion": 1,
  "id": "blue-cat",
  "name": { "en": "Blue Cat", "zh": "蓝猫" },
  "canvas": { "width": 256, "height": 256 },
  "initialState": "idle",
  "states": {
    "idle": {
      "loop": true,
      "frames": [
        { "src": "frames/idle-01.png", "durationMs": 160 },
        { "src": "frames/idle-02.png", "durationMs": 160 }
      ]
    }
  }
}
```

Limits are deliberately conservative: ZIP at most 8 MiB, at most 128 files,
at most 24 MiB uncompressed, PNG only, frame dimensions at most 512×512, at
most 96 referenced frames, and frame duration between 40 and 2,000 ms. Paths
must be relative ASCII paths without traversal. Scripts, HTML, SVG, XML,
symlinks, network URLs, and executable content are rejected.
