# Document Template Specification

Templates are free-form HTML files with `{{ }}` tags that get replaced at render time. You write normal HTML and CSS — fonts, colours, margins, tables, letterhead — and drop tags wherever you want live data from the engagement.

---

## Quick Start

```html
<div style="font-family: Georgia, serif; margin: 60px 80px;">
  <h1>{{entity_name}}</h1>
  <h2 style="font-weight: normal;">For the Year Ended {{year_end}}</h2>
  <p>Prepared by: {{prepared_by}}</p>
</div>
```

Save, hit **Preview**, and the tags are replaced with real values.

---

## Tag Reference

### Engagement Metadata

| Tag | Output |
|-----|--------|
| `{{entity_name}}` | Legal name of the client entity |
| `{{year_end}}` | Formatted year-end date — e.g. `December 31, 2024` |
| `{{year_end\|short}}` | ISO date — e.g. `2024-12-31` |
| `{{fiscal_year}}` | Year number — e.g. `2024` |
| `{{currency}}` | Currency code — e.g. `USD` |
| `{{prepared_date}}` | Today's date at render time |
| `{{prepared_by}}` | Your name from Settings (also works as `{{preparer_name}}`) |
| `{{preparer_initials}}` | Your initials from Settings |

---

### Financial Expressions

These pull live numbers from the trial balance, adjusted for AJEs.

| Tag | What it pulls |
|-----|--------------|
| `{{M:1000}}` | Balance of map number 1000 |
| `{{M:1000\|prior}}` | Same, prior year |
| `{{SUM(1000..1999)}}` | Sum of all map numbers in the range 1000–1999 |
| `{{SUM(4000..4999) * -1}}` | Arithmetic on a sum (e.g. revenue sign flip) |
| `{{SUM(1000..1999)\|prior}}` | Prior-year version of any expression |
| `{{G:42}}` | Sum of all accounts in grouping ID 42 |
| `{{A:1010}}` | Raw balance of account number 1010 |

Numbers are formatted with comma separators and parentheses for negatives — e.g. `1,234,567.89` or `(42,000.00)`. No currency prefix is included; type the symbol yourself or use `{{currency}}` inline.

**Tip:** map numbers are assigned in the Trial Balance page and configured in the Mapping page. `SUM(1000..1999)` covers every map code that sorts numerically in that range.

---

### Custom Variables

```
{{V:engagement_partner}}
{{V:tax_rate}}
```

`V:key` pulls a text value from the engagement's custom variable table. Custom variables also work inside financial expressions:

```
{{V:tax_rate * M:5000}}
```

---

### Images / Logos

Upload images on the **Documents → Assets** tab first, then reference them by name:

```
{{image:firm_logo}}
{{image:firm_logo|width=200px}}
{{image:partner_sig|width=120px|alt=Authorized Signature}}
```

Images are stored as base64 inside the engagement file — they survive folder moves, archive extraction, and roll-forward without any path changes.

**Size limit:** keep individual assets under 512 KB. A typical firm logo at web resolution is well under this.

---

### Note Cross-References

Notes are automatically numbered across the entire package in document order. You don't assign numbers — you assign **keys** (short slugs), and the engine handles numbering consistently across all documents in the package.

```
{{note_ref:cash}}                        → "Note 1"
{{note_ref:cash|inline}}                 → superscript "(1)"
{{note_def:cash|title=Cash and Cash Equivalents}}
                                         → "Note 1 — Cash and Cash Equivalents"
```

**Rules:**
- The same key always gets the same number within a package.
- The number is determined by the first appearance of the key across all items in the package (in sort order).
- A `note_ref` in a financial statement line label counts as an appearance — labels are scanned before any template is rendered, so a balance sheet line can say "Note 1" even though the notes section comes later in the package.
- Multiple `note_ref` tags with the same key all render the same number.
- If you reorder the notes section, all numbers update automatically on the next render.

**Inserting note refs into statement lines:**

Open the statement editor, edit a line, and click **+ note ref** next to the Label field. A picker appears showing all registered note keys with their current numbers. Click one to insert `{{note_ref:key}}` at the cursor, or type a new key manually.

The label ends up looking like:
```
Cash and cash equivalents {{note_ref:cash}}
```

Which renders as:
```
Cash and cash equivalents  Note 1
```

**Defining the note in a template:**

In a Notes template later in the package:

```html
<section>
  {{note_def:cash|title=Cash and Cash Equivalents}}
  <p>Cash includes deposits held at chartered banks with original maturities
  of three months or less. As at {{year_end}}, cash totalled {{M:1010}}.</p>
</section>

<section>
  {{note_def:receivables|title=Accounts Receivable}}
  <p>Accounts receivable are recorded at amortized cost.</p>
</section>
```

The note numbers (`Note 1`, `Note 2`, etc.) are assigned by document order across the whole package — reordering items in the package automatically renumbers everything on the next render. You never touch a number manually.

**Workflow summary:**

1. Define notes in a Notes template using `{{note_def:key|title=...}}`
2. Reference them in statement line labels using **+ note ref** in the statement editor
3. Render the package once — note keys are registered with their numbers
4. The **+ note ref** picker shows the registered keys and numbers for easy reuse

---

### Statement Embeds

Embed a structured financial statement inside any template:

```
{{statement:balance_sheet}}
{{statement:income_statement}}
{{statement:cash_flow}}
{{statement:equity}}
{{statement:id:42}}           (embed a CUSTOM statement by database ID)
```

The engine resolves the statement, expands any `note_ref` tags in line labels, and inserts a formatted HTML table. The surrounding template controls letterhead, margins, and page layout.

---

## Template Kinds

The kind is a label for organization — it doesn't change how rendering works.

| Kind | Intended use |
|------|-------------|
| `COVER` | Title page, table of contents |
| `LETTER` | Management letter, engagement letter, compilation report |
| `NOTES` | Notes to financial statements |
| `FS_EMBED` | A fragment intended to be embedded via `{{statement:…}}` |
| `CUSTOM` | Anything else |

---

## Packages

A **package** is an ordered list of items. Each item is either a template or a structured statement. Click **Preview All** to render every item in order into a single scrollable document.

Typical package order:
1. Cover page template
2. Balance sheet (statement item)
3. Income statement (statement item)
4. Notes to FS template
5. Management letter template

Note numbers are consistent across the entire package regardless of where a key first appears.

---

## Full Example — Management Letter

```html
<!DOCTYPE html>
<html>
<head>
<style>
  body { font-family: Arial, sans-serif; font-size: 11pt; margin: 0; }
  .page { padding: 60px 80px; max-width: 720px; margin: 0 auto; }
  .letterhead { border-bottom: 2px solid #1a3c6e; padding-bottom: 20px; margin-bottom: 32px; }
  h1 { font-size: 13pt; font-weight: bold; margin: 0 0 4px; }
  p { line-height: 1.6; margin: 0 0 12px; }
  .sig { margin-top: 48px; }
</style>
</head>
<body>
<div class="page">

  <div class="letterhead">
    {{image:firm_logo|width=180px}}
  </div>

  <p>{{prepared_date}}</p>

  <p>Management of<br>
  <strong>{{entity_name}}</strong></p>

  <h1>Re: Compilation Engagement — Year Ended {{year_end}}</h1>

  <p>We have compiled the accompanying financial statements of {{entity_name}}
  for the year ended {{year_end}}, which comprise the balance sheet as at
  {{year_end}} and the statements of income, retained earnings, and cash flows
  for the year then ended, and a summary of significant accounting policies and
  other explanatory information.</p>

  <p>Total assets as at {{year_end}} were {{SUM(1000..1999)}}.</p>

  <div class="sig">
    <p>Yours truly,</p>
    {{image:partner_sig|width=150px}}<br>
    <strong>{{V:firm_name}}</strong><br>
    {{V:firm_city}}, {{V:firm_province}}<br>
    {{prepared_date}}
  </div>

</div>
</body>
</html>
```

---

## Tips and Gotchas

**Tags are case-sensitive.** `{{Entity_Name}}` will not work; use `{{entity_name}}`.

**Whitespace inside tags is stripped.** `{{ entity_name }}` and `{{entity_name}}` are equivalent.

**The `|prior` modifier applies to the whole expression.** You cannot mix current and prior axes in a single tag — use two tags side by side.

**Financial expressions output plain numbers, no currency symbol.** Use `{{currency}}` inline if you need it, or type the symbol directly in the surrounding HTML.

**Note keys must be unique within a package.** If two `note_def` tags share a key, the second is treated as another reference to the same note. Use distinct slugs: `cash`, `receivables`, `capital_assets`, etc.

**Note numbers are assigned at render time.** The first time you render a package, keys are registered and the **+ note ref** picker in the statement editor will show the numbers. If you add or reorder notes, render again to update the registry.

**Images must be uploaded before they can be referenced.** A tag referencing an asset that hasn't been uploaded renders as an empty string, not an error.

**HTML in templates is sandboxed.** Scripts are permitted (for print triggers etc.), but the preview iframe cannot access the host application's storage or navigate the parent window.

**Map numbers must be assigned before financial tags return values.** If `{{M:1000}}` returns `0.00` unexpectedly, check that accounts are mapped in the Trial Balance page.
