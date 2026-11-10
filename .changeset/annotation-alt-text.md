---
'@embedpdf/engine-core': minor
'@embedpdf/engine-services': minor
'@embedpdf/engine': minor
---

Annotations read and write their alternate description as `altText`: the `/Alt` of the structure element that lists the annotation (ISO 32000-2 14.9.3), e.g. an image stamp's description. A create or update that sets it tags an untagged annotation as a `/Figure`; an update's `null` removes it. Needs the runtime's `EPDFAnnot_GetAltText` / `EPDFAnnot_SetAltText`.
