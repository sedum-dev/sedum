---
"sedum-cli": patch
"@sedum-dev/core": patch
---

Say that the model provider rejected the API key when a run uses a wrong `TYPESAFE_API_KEY`, as `sedum doctor` does, and point to `TYPESAFE_API_KEY` and `sedum doctor` in the fix. The step that hit the rejection is recorded with the `provider_authentication` error. Previously the run reported a vague provider failure, and before that an unresolved click with test-input advice.
