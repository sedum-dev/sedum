---
"@sedum-dev/core": patch
---

Name bare counts on icon controls in the page text the judge reads. The "1" on a cart icon used to appear as a lone `1` ("Swag Labs 1 Products"), so `verify the shopping cart badge shows 1` failed although the badge showed 1. It now appears as `cart icon badge: 1` when the control shows only the count and its class, id or test hook names a known icon kind. The docs explain which visual states the judge can and cannot see.
