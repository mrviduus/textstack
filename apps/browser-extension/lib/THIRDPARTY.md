# Third-party code

## Mozilla Readability

- **Package:** `@mozilla/readability`
- **Repository:** https://github.com/mozilla/readability
- **Version / tag vendored:** `0.6.0`
- **File:** `lib/readability.js`
- **License:** Apache-2.0 (full text is in the file header)

Vendored verbatim (only a provenance header comment was prepended). When injected
as an MV3 classic content script, the top-level `function Readability(...)`
declaration exposes a global `Readability`, which `content.js` uses.

### Re-vendor / update

```sh
curl -fsSL \
  "https://raw.githubusercontent.com/mozilla/readability/0.6.0/Readability.js" \
  -o lib/readability.js
# then re-add the provenance header comment at the top of the file
```

To bump the version, change the tag in the URL above and update this file.
