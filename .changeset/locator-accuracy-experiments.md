---
"@sedum-dev/core": minor
"@sedum-dev/provider-typesafe": minor
---

Find and choose page elements more reliably. The page script now reaches open
shadow roots, pointer-styled controls with no role, drawn checkboxes and radios,
and controls named only by an icon, image, placeholder, or nearby text, and it
tells the model where each control sits. The locator resolves ordinals, prices,
row references, and named sections in code, asks the model one yes/no question
per item for references it cannot match, and gives up on steps that name only a
kind of control or fit two near-namesakes. Among repeated elements it now acts on
the model's pick by default (`repeatedMember: {}` restores the strict rule).
A TypeSafe 402 (no credits) is reported as a configuration error.
