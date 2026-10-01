---
"@sedum-dev/core": patch
---

Check a control's state in a sentence. `verify the Save button is disabled` (or `enabled`), `verify the Email field contains {{email}}`, `verify the Search field is shown`, `is focused`, `is empty`, and `verify the Select all checkbox is checked` locate the control the way a click or type step does and read its state directly; page text carries no control state. A field's value is compared in the runner and never sent to the model, and password fields are never read.
