---
"@sedum-dev/core": patch
---

Click rows and the actions buttons that appear when a row is hovered. A clickable row (a pointer-cursor element) is now a target even when it holds icon-only controls, such as a list row with an actions menu, so `click the Alpha report row` works. A control that a stylesheet `:hover` rule reveals is offered too; Sedum rests the pointer on its row before clicking it, so `click the actions button on the Alpha report row` works. A control's name no longer includes the text or icons of a closed menu nested inside it, an icon button's context is bounded to its own row, and the button's hint lists what its menu offers.
