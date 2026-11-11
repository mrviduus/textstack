# SYNTHETIC KF8 fixtures (#1182)

**Synthetic.** Made by Calibre from tiny EPUBs whose text was written for this repository (original, no
third-party content, no licence needed). They exercise foliate's KF8 reader; they do **not** establish
compatibility with real-world Kindle books (Amazon's tools, other producers, DRM-free retail files, fixed layout,
embedded fonts, RTL).

| File | What | SHA-256 | Bytes |
|---|---|---|---|
| `tssynthetic-src.epub` | the source: 3 sections, a CSS file, a PNG, an SVG, an internal link (`s1` → `s3#harbour`), a `<meta http-equiv="refresh">` in `s2` | `0cf5aa7d88be956cafe7cb89feac764ef0c931c7835099128a6735f58641cb94` | 3471 |
| `tssynthetic-kf8.azw3` | KF8 only (MOBI header v8; SKEL/FRAG/NCX INDX, FDST, uncompressed text) | `3729892f5b92657d111e584754aa86435b5b0b3f9d0df09702036495d92444d9` | 23993 |
| `tssynthetic-combo.mobi` | MOBI6 + KF8 combo (`--mobi-file-type both`; EXTH 121 → KF8 header at record 13) | `0dbb3e25f6a8a3e9b31c6fc9c2f93d513bd211ff4d7deab5d8a3b7db323b00e8` | 52497 |
| `tshostile-kf8.azw3` | `fixtures.mjs` `tshostile.epub` as KF8, with placeholder addresses (`kf8fixture.mjs` `HOSTILE_KF8`) the sandbox check swaps for its own | `a7d90fdae600e2c411dc274849cfaf9ac9e9882b4921d3420ee1771ecb15470a` | 17967 |

Recipe: `node kf8fixture.mjs synthetic` (needs `zip` and `ebook-convert`; made with calibre 9.18.0, macOS), with
the exact options in `convertArgs`. Calibre writes the PDB times, the MOBI unique id and a fresh UUID (EXTH 112/113)
differently on every run; `normalise()` overwrites those with fixed values, after which the output is
byte-identical run to run. Committed because CI has no Calibre; `formats.test.ts` checks these files against
`SYNTHETIC` in `kf8fixture.mjs`. Regenerate only on purpose and update both.
