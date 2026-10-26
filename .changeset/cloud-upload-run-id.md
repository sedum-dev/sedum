---
"sedum-cli": patch
---

After an automatic Cloud upload, `sedum run` now prints the Cloud run UUID that `sedum runs show` accepts, next to the local run ID. Upload warnings name the likely cause: an unset or malformed `SEDUM_UPLOAD_TOKEN`, `SEDUM_PROJECT_ID` or `SEDUM_CLOUD_URL`, missing Git context, an unreachable host, or an HTTP 401 for a token that is revoked or issued for another project. `runs show` with a local run ID now says the run was not found instead of reporting a membership problem. Uploads still never change the exit code.
