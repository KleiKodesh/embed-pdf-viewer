---
'@embedpdf/engine-services': minor
---

`PageTextObjectsReader.readPacked()` builds the packed snapshot directly, and the reader probes each font once per page, reading cell widths only for fonts whose glyph widths can't be probed.
