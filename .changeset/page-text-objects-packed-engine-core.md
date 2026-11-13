---
'@embedpdf/engine-core': minor
---

`page.text.objectsPacked()` returns `page.text.objects()` in typed-array columns (`PageTextObjectsPacked`): no object per glyph, and the local engine transfers the arrays from its worker instead of copying them. Meant for reads that walk every page, such as find or copy-all. `unpackPageTextObjects` gives the snapshot back; `runPageTextObjectsConformance` checks that both reads agree.
