# TextStack Text Processing Rules

This document describes all transformation and lint rules in the text processing pipeline.

## Pipeline Order

```
1. SpellingProcessor.ModernizeSpelling()
2. HyphenationModernizer.ModernizeHyphenation()
3. TypographyProcessor.Typogrify()
   └── Contractions.FixArchaicContractions()
   └── Contractions.FixPossessivesAfterTags()
   └── Dashes.ProcessDashes()
   └── Fractions.ConvertFractions()
   └── Currency.NormalizeCurrency()
4. SemanticProcessor.Semanticate()
   └── Abbreviations.MarkupExtendedAbbreviations()
5. Linter (quality checks)
```

---

## 1. Spelling Modernization

**File:** `Spelling/SpellingProcessor.cs`

| Pattern | Replacement | Example | Note |
|---------|-------------|---------|------|
| `&c.` | `etc.` | "&c." → "etc." | Latin abbreviation |
| `connexion(s)` | `connection(s)` | "connexion" → "connection" | British archaic |
| `reflexion(s)` | `reflection(s)` | "reflexion" → "reflection" | British archaic |
| `inflexion(s)` | `inflection(s)` | "inflexion" → "inflection" | |
| `to-day` | `today` | "to-day" → "today" | Hyphenated compound |
| `to-morrow` | `tomorrow` | "to-morrow" → "tomorrow" | |
| `to-night` | `tonight` | "to-night" → "tonight" | |
| `now-a-days` | `nowadays` | "now-a-days" → "nowadays" | |
| `any-one` | `anyone` | "any-one" → "anyone" | |
| `every-one` | `everyone` | "every-one" → "everyone" | |
| `some-one` | `someone` | "some-one" → "someone" | |
| `no-one` | `no one` | "no-one" → "no one" | Note: not "noone" |
| `any-thing` | `anything` | "any-thing" → "anything" | |
| `every-thing` | `everything` | "every-thing" → "everything" | |
| `some-thing` | `something` | "some-thing" → "something" | |
| `any-where` | `anywhere` | "any-where" → "anywhere" | |
| `every-where` | `everywhere` | "every-where" → "everywhere" | |
| `some-where` | `somewhere` | "some-where" → "somewhere" | |
| `no-where` | `nowhere` | "no-where" → "nowhere" | |
| `mean-while` | `meanwhile` | "mean-while" → "meanwhile" | |
| `shew(n/ed/ing/s)` | `show(n/ed/ing/s)` | "shewn" → "shown" | Archaic |
| `gaol(er/s/ed)` | `jail(er/s/ed)` | "gaol" → "jail" | British archaic |
| `despatch(es/ed/ing)` | `dispatch(...)` | "despatch" → "dispatch" | British archaic |
| `behove(s/d)` | `behoove(s/d)` | "behoves" → "behooves" | US spelling |
| `waggon(s/er/ers)` | `wagon(...)` | "waggon" → "wagon" | |
| `clew(s/ed)` | `clue(s/ed)` | "clew" → "clue" | Nautical |
| `burthen(...)` | `burden(...)` | "burthen" → "burden" | Archaic |
| `Hindoo(s/ism)` | `Hindu(s/ism)` | "Hindoo" → "Hindu" | Outdated |
| `intrust(...)` | `entrust(...)` | "intrust" → "entrust" | |
| `dulness` | `dullness` | "dulness" → "dullness" | |
| `skilful(ly)` | `skillful(ly)` | "skilful" → "skillful" | US spelling |
| `wilful(ly/ness)` | `willful(...)` | "wilful" → "willful" | US spelling |
| `fulfil(...)` | `fulfill(...)` | "fulfil" → "fulfill" | US spelling |
| `instalment(s)` | `installment(s)` | "instalment" → "installment" | US spelling |

---

## 2. Hyphenation Modernization

**File:** `Spelling/HyphenationModernizer.cs`

Removes hyphens from compound words if the combined form exists in the dictionary.

| Pattern | Replacement | Condition |
|---------|-------------|-----------|
| `word-word` | `wordword` | Combined form in dictionary |

**Dictionary:** `Spelling/Data/words.txt` (200+ common compounds)

Examples:
- "care-taker" → "caretaker"
- "book-keeper" → "bookkeeper"
- "fire-place" → "fireplace"

---

## 3. Typography Processing

### 3.1 Smart Quotes

**File:** `Typography/TypographyProcessor.cs`

| Pattern | Replacement | Example |
|---------|-------------|---------|
| `"` after whitespace/tag | `"` (U+201C) | `"Hello` → `"Hello` |
| `"` before punctuation | `"` (U+201D) | `world"` → `world"` |
| `'` after whitespace + letter | `'` (U+2018) | `'twas` → `'twas` |
| `'` between letters | `'` (U+2019) | `don't` → `don't` |
| `` ` `` (backtick) | `'` | Gutenberg style |

### 3.2 Contractions

**File:** `Typography/Contractions.cs`

| Pattern | Replacement | Example |
|---------|-------------|---------|
| `(space)tis/twas/twere/...` | `'tis/'twas/'twere/...` | " tis" → " 'tis" |
| `"tis/"twas` (wrong quote) | `'tis/'twas` | ""tis" → "'tis" |
| `'tis` (left quote) | `'tis` (apostrophe) | "'tis" → "'tis" |
| `'ave/'ome/'im/...` | `'ave/'ome/'im/...` | Archaic contractions |
| `'20s/'90s` | `'20s/'90s` | Year abbreviations |
| `o'clock` | `o'clock` | Normalize apostrophe |
| `fo'c'sle` | `fo'c'sle` | Nautical (forecastle) |
| `bo's'n` | `bo's'n` | Nautical (boatswain) |
| `</i>'s` | `</i>'s` | Possessive after tag |
| `</abbr>'s` | `</abbr>'s` | Possessive after abbr |

### 3.3 Dashes

**File:** `Typography/Dashes.cs`

| Pattern | Replacement | Unicode | Example |
|---------|-------------|---------|---------|
| `―` (horizontal bar) | `—` | U+2014 | Em dash |
| `———` (3 em dashes) | `⸻` | U+2E3B | Three-em dash |
| `——` (2 em dashes) | `⸺` | U+2E3A | Two-em dash |
| `---` (3 hyphens) | `⸻` | U+2E3B | Three-em dash |
| `--` (2 hyphens) | `—` | U+2014 | Em dash |
| `X—` (before em dash) | `X⁠—` | + U+2060 | Word joiner prevents break |
| `N–N` (number range) | `N⁠–⁠N` | + U+2060 | Word joiner around en dash |

### 3.4 Fractions

**File:** `Typography/Fractions.cs`

| Pattern | Replacement | Unicode |
|---------|-------------|---------|
| `1/4` | `¼` | U+00BC |
| `1/2` | `½` | U+00BD |
| `3/4` | `¾` | U+00BE |
| `1/3` | `⅓` | U+2153 |
| `2/3` | `⅔` | U+2154 |
| `1/5` | `⅕` | U+2155 |
| `2/5` | `⅖` | U+2156 |
| `3/5` | `⅗` | U+2157 |
| `4/5` | `⅘` | U+2158 |
| `1/6` | `⅙` | U+2159 |
| `5/6` | `⅚` | U+215A |
| `1/7` | `⅐` | U+2150 |
| `1/8` | `⅛` | U+215B |
| `3/8` | `⅜` | U+215C |
| `5/8` | `⅝` | U+215D |
| `7/8` | `⅞` | U+215E |
| `1/9` | `⅑` | U+2151 |
| `1/10` | `⅒` | U+2152 |
| `N ½` | `N½` | Remove space before fraction |

### 3.5 Currency

**File:** `Typography/Currency.cs`

| Pattern | Replacement | Example |
|---------|-------------|---------|
| `L` + number | `£` + number | "L50" → "£50" |
| `£N. Ns. Nd.` | `£N.Ns.Nd.` | Normalize spacing |

### 3.6 Other Typography

| Pattern | Replacement | Note |
|---------|-------------|------|
| `...` (3 dots) | `…` (U+2026) | Ellipsis |
| `N-N` (number range) | `N–N` | En dash for ranges |
| `Mr. ` | `Mr. ` (+ nbsp) | Non-breaking space after title |
| `No. N` | `No. N` (+ nbsp) | Non-breaking space |
| `c/o` | `℅` (U+2105) | Care of symbol |
| `i.e.` / `e.g.` | `i.e.` / `e.g.` | Remove internal spaces |
| `A.D.` / `B.C.` | `AD` / `BC` | Remove periods |
| `"'` adjacent quotes | `" '` | Hair space between |
| `N unit` | `N unit` (+ nbsp) | Non-breaking space |
| `N a.m./p.m.` | `N a.m./p.m.` (+ nbsp) | Non-breaking space |
| `-N` (negative) | `−N` (U+2212) | Minus sign |
| `O.K.` | `OK` | Normalize |
| ` &` | ` &` (nbsp) | Non-breaking before ampersand |

---

## 4. Semantic Markup

### 4.1 Name Titles

**File:** `Typography/SemanticProcessor.cs`

| Pattern | Markup | Example |
|---------|--------|---------|
| `Mr./Mrs./Dr./...` | `<abbr epub:type="z3998:name-title">Mr.</abbr>` | Name titles |
| `Jr./Sr.` | `<abbr epub:type="z3998:name-title">Jr.</abbr>` | Junior/Senior |
| `Ph.D.` | `<abbr epub:type="z3998:name-title">Ph. D.</abbr>` | Degree |

### 4.2 Initialisms

| Pattern | Markup | Example |
|---------|--------|---------|
| `MP/HMS/SS/NB/WC/IOU` | `<abbr epub:type="z3998:initialism">M.P.</abbr>` | Formatted with periods |
| `RA/MA/MD/KC/QC` | `<abbr epub:type="z3998:initialism z3998:name-title">R.A.</abbr>` | Title + initialism |
| `USA` | `<abbr epub:type="z3998:initialism z3998:place">U.S.A.</abbr>` | Place |
| `i.e./e.g.` | `<abbr epub:type="z3998:initialism">i.e.</abbr>` | Latin |
| `N.B.` | `<abbr epub:type="z3998:initialism">N.B.</abbr>` | Nota bene |

### 4.3 Compass Directions

| Pattern | Markup |
|---------|--------|
| `NE/NW/SE/SW` | `<abbr epub:type="se:compass">N.E.</abbr>` |
| `NNE/NNW/SSE/SSW/ENE/ESE/WNW/WSW` | `<abbr epub:type="se:compass">N.N.E.</abbr>` |

### 4.4 Era Dates

| Pattern | Markup |
|---------|--------|
| `AD` | `<abbr epub:type="se:era">AD</abbr>` |
| `BC` | `<abbr epub:type="se:era">BC</abbr>` |

### 4.5 Measurements

| Pattern | Markup | Note |
|---------|--------|------|
| `N cm/kg/ml/...` | `N <abbr>cm</abbr>` | SI units |
| `N ft/yd/mi/oz/lb/...` | `N <abbr>ft.</abbr>` | Imperial units |
| `N mph` | `N <abbr>mph</abbr>` | Speed |
| `N hp` | `N <abbr>hp</abbr>` | Horsepower |

### 4.6 Roman Numerals

| Pattern | Markup | Note |
|---------|--------|------|
| `II/III/IV/...` | `<span epub:type="z3998:roman">III</span>` | 2+ chars |
| ` i ` | `<span epub:type="z3998:roman">i</span>` | Single lowercase |

**Excluded false positives:** MI, DI, MIX, ID, LI, MIC, VIM, DIV, DIM

### 4.7 Simple Abbreviations

| Pattern | Markup |
|---------|--------|
| `Bros./Mt./Vol./Chap./Co./Inc./Ltd./St./Gov./MSS./Viz./etc./cf./ed./vs./ff./lib./pp.` | `<abbr>Bros.</abbr>` |
| `Jan./Feb./.../Dec.` | `<abbr>Jan.</abbr>` | Months |
| `No./Nos.` | `<abbr>No.</abbr>` | Number |
| `P.S./P.P.S.` | `<abbr epub:type="z3998:initialism">P.S.</abbr>` | |
| `a.m./p.m.` | `<abbr>a.m.</abbr>` | Time |

### 4.8 Extended Abbreviations

**File:** `Semantic/Abbreviations.cs`

| Pattern | Markup | Note |
|---------|--------|------|
| `et al.` | `<abbr epub:type="z3998:initialism">et al.</abbr>` | Et alii |
| `ibid.` | `<abbr>ibid.</abbr>` | Ibidem |
| `op. cit.` | `<abbr>op. cit.</abbr>` | Opere citato |
| `loc. cit.` | `<abbr>loc. cit.</abbr>` | Loco citato |
| `ca./c.` (+ date) | `<abbr>ca.</abbr>` | Circa |
| `fl.` (+ date) | `<abbr>fl.</abbr>` | Floruit |
| `sc.` | `<abbr>sc.</abbr>` | Scilicet |
| `[sic]` | `<abbr>sic</abbr>` | |
| `q.v.` | `<abbr>q.v.</abbr>` | Quod vide |
| `Messrs.` | `<abbr epub:type="z3998:name-title">Messrs.</abbr>` | |
| `Assn./Assoc.` | `<abbr>Assn.</abbr>` | Association |
| `Dept.` | `<abbr>Dept.</abbr>` | Department |
| `Univ.` | `<abbr>Univ.</abbr>` | University |
| `approx.` | `<abbr>approx.</abbr>` | |
| `misc.` | `<abbr>misc.</abbr>` | |

### 4.9 End of Clause

Abbreviations at end of sentence get `class="eoc"`:

```html
<abbr class="eoc">etc.</abbr>
```

---

## 5. Lint Rules

### 5.1 Typography Rules

| Code | Severity | Description | Pattern |
|------|----------|-------------|---------|
| T001 | Warning | Straight quotes found | `"` or `'` outside HTML tags |
| T002 | Warning | Wrong dash type | Spaced hyphen or `--` |
| T003 | Info | Multiple spaces | 2+ consecutive spaces |

### 5.2 Markup Rules

| Code | Severity | Description | Pattern |
|------|----------|-------------|---------|
| X001 | Info | Empty tag | `<p></p>`, `<span></span>`, etc. |

### 5.3 Encoding Rules

| Code | Severity | Description | Pattern |
|------|----------|-------------|---------|
| M001 | Error | Mojibake detected | `â€™`, `Ã©`, `Â£`, etc. |
| U001 | Warning/Error | Unusual character | Control chars, PUA, zero-width |

**Mojibake patterns (UTF-8 as Latin-1):**
- `â€™` → apostrophe
- `â€œ` → left double quote
- `â€"` → em dash
- `Ã©` → é
- `Â£` → £
- `ï»¿` → BOM
- `�` (U+FFFD) → replacement character

**Unusual characters:**
- Control characters (U+0000-U+001F except tab/newline)
- Zero-width characters (U+200B, U+200C, U+200D, U+FEFF)
- Soft hyphen (U+00AD)
- Private Use Area (U+E000-U+F8FF)
- Various unusual spaces (U+2000-U+200A, U+202F, U+205F)

### 5.4 Spelling Rules

| Code | Severity | Description | Pattern |
|------|----------|-------------|---------|
| S001 | Info | Archaic/British spelling | connexion, shew, gaol, grey, etc. |

**Flagged spellings (not auto-fixed, need review):**
- connexion, reflexion, shew, gaol, despatch, burthen
- clew (nautical), waggon, behove
- grey, storey, gantlet, enquire
- encyclopaedia, aeon, foetus
- mould, smoulder, plough, draught

---

## Configuration

Currently all rules are always enabled. Future: add configuration to enable/disable individual rules.

---

## Source

Rules ported from [Standard Ebooks](https://standardebooks.org/) tools:
- `typography.py`
- `spelling.py`
- `formatting.py`

---

## Technical Notes

### ARM64 Compatibility

The `SpellingProcessor` and `HyphenationModernizer` use standard compiled `Regex` objects instead of source-generated regex (`[GeneratedRegex]`) due to SIGILL crashes on ARM64/Docker. The `.NET` JIT compiler generates invalid instructions for certain regex patterns when using source generation on ARM64 architecture.

Existing source-generated regex in other files (TypographyProcessor, SemanticProcessor, etc.) continue to work and are retained for their performance benefits.
