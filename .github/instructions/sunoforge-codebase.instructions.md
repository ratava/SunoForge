---
applyTo: "index.html"
description: "Deep SunoForge codebase knowledge — function map, patterns, AI flow, data models. Auto-loaded when editing index.html."
---

# SunoForge index.html — Deep Code Reference

> Auto-loaded when editing `index.html`. Contains precise function locations and implementation patterns to avoid repeated code discovery.

---

## File Layout (line regions)

| Region | Lines | Notes |
|--------|-------|-------|
| License header | 1–6 | CC BY-NC 4.0 |
| `<head>` + CSP | 8–27 | CSP allows esm.sh, googleapis |
| `<style>` CSS | 29–~1800 | All CSS; CSS vars + dark theme |
| Header / API bar | ~1810–2025 | Logo, lang-select, version, API keys, model dropdown, storage provider, Drive sync |
| Settings tab | ~1965–2400 | Song language, genre, mood/goal/rhythm, tempo/duration, key/time-sig, verse/chorus |
| Vocal tab | ~2400–2480 | Lead vocal type tags, `#vocal-profiles-container`, `#choir-builder` |
| Structure tab | ~2480–2580 | Custom structure builder, `#structure-list` |
| Sound tab | ~2580–2880 | Era, Instruments, Bass, Spatial/FX, Production, Mix, Exclusions, Influences |
| Lyrics tab | ~2880–2920 | AI mode tags, `#lyrics-input` textarea |
| Right panel | ~2920–2980 | Action buttons, Output/Chords/History tabs |
| Modals | ~2980–3490 | All modal HTML |
| `window.I18N` IIFE | ~3495–3560 | i18n engine (plain `<script>`) |
| `<script type="module">` start | ~3561 | All app logic lives here |
| Utility functions | ~3560–4300 | escapeHtml, safeParseJSON, callAI, API key save, model fetch, Drive auth/storage helpers |
| Genre metadata + UI | ~4010–4640 | GENRE_METADATA constant, genre tag builders |
| Settings tag builders | ~4640–5240 | Tag rows: mood, goal, rhythm, groove, rhyme, pov, bass, spatial, production, mix |
| Vocal UI | ~5240–5780 | selectVocalType, buildChoirBuilder, buildVocalProfiles, getVocalProfiles, formatVocalProfilesForPrompt |
| Sound profile | ~5780–5830 | buildSoundProfile, soundProfilePromptText |
| Structure UI | ~6030–6340 | getStructuresForGenre, buildStructureList, applyCustomStructureBuilder |
| Tab switching | ~6335–6360 | switchLTab, switchRTab |
| AI analyzers | ~6700–7095 | applyUnifiedAnalysis (main), applyStyle |
| CSS helpers | ~7095–7130 | badgeClass, sectionClass |
| Text/meta utilities | ~7130–7295 | stripLeadingStyleMetaTag, stripAllLeadingMetaTags, collectSectionMetaTags, areSameMetaLine, applySunoStylePromptData |
| Lyrics assembly | ~7293–7545 | buildAssembledLyricsPrompt, parseLyricsPromptSections, shortenLyricsPromptWithAI |
| Merge/preserve | ~7795–8095 | mergePreservedLyricsSections, buildSubmissionSummary |
| History r/w | ~8200–8610 | captureCurrentSettingsSnapshot, applyHistorySettings, saveToHistory, loadFromHistory |
| Export/import | ~8610–8740 | exportHistoryBackup, importHistoryBackup, parseImportedSong |
| Export modal | ~9095–9310 | exportSong |
| Section regen | ~9310–9390 | regenSection, confirmCopyLyricsToTab |
| Output rendering | ~9390–9660 | applySettingsFromAIResult, renderSongCard, initSectionTextareas, renderChordsCard, normalizeLyricsText |
| Main generation | ~9750–end | generateSong (main orchestration) |

---

## Critical Patterns — Always Follow

### 1. JSON Parsing
```js
// ✅ CORRECT — AI responses can contain literal \n in strings
const data = safeParseJSON(raw);

// ❌ WRONG — will throw "Bad control character" for AI responses
const data = JSON.parse(raw);
```

### 2. DOM Insertion (XSS prevention)
```js
// For HTML context
el.innerHTML = escapeHtml(untrustedString);

// For attribute context
el.setAttribute("data-x", escapeAttr(val));
```

### 3. i18n — Never hardcode English strings in JS
```js
// ✅ Static string
const msg = _t('alert.some_key', 'Fallback text');

// ✅ Formatted with args
const msg = _fmt('status.saved_n', 'Saved {0} items', count);

// ❌ WRONG — not localizable
element.textContent = "Something went wrong";
```

### 4. AI Mode & Section Meta-Tag Round-Trip
When `section.metaTags[]` exists, `collectSectionMetaTags` uses it directly — do NOT bypass this. The round-trip is:
```
AI response → instructions cleanup (per-line bracket strip)
→ renderSongCard → collectSectionMetaTags → buildEditableText (displayed)
→ user edits → initSectionTextareas parses back → section.metaTags[] saved
→ buildAssembledLyricsPrompt → collectSectionMetaTags → normalizeLyricsText
```

---

## Function Signatures & Behavior

### `safeParseJSON(text)` ~3172
Char-by-char scanner. When inside a JSON string (`inString=true`), replaces bare `\n`, `\r`, `\t` with `\\n`, `\\r`, `\\t`. Safe to call on any AI response.

### `callAI(prompt)` ~3580
Returns a `string` (raw AI text). Handles all 3 providers. Strips markdown fences (` ```json ... ``` `) before returning.

### `escapeHtml(unsafe)` ~3755
Replaces `&`, `<`, `>`, `"`, `'` → entities. Use for any user/AI content inserted into innerHTML.

### `escapeAttr(unsafe)` ~3790
Replaces `"` and `'` for attribute context.

### `selectVocalType(el)` ~5240
Click handler for vocal type tags. On the `Choir/Ensemble` type:
- Hides `#vocal-builder-container` and choir checkbox
- Shows `#choir-builder` and calls `buildChoirBuilder()` directly
For all other types: shows vocal builder, hides choir builder, calls `buildVocalProfiles()`.

### `buildChoirBuilder()` ~5270
Replaces `#choir-builder` content with voice part rows (soprano, alto, tenor, bass etc). Choir does NOT use the regular `#vocal-profiles-container`.

### `getChoirConfig()` ~5350
```js
const enabled = isChoirEnsemble || document.getElementById("choir-enabled")?.checked || false;
```
Bypasses checkbox if the vocal type IS Choir/Ensemble.

### `buildVocalProfiles()` ~5385
Skips building for `"Instrumental"` and `"Choir/Ensemble"` types.

### `formatVocalProfilesForPrompt(vocalData)` ~5575
When `type === "Choir/Ensemble"` → formats choir config as primary block (no lead vocal lines).

### `collectSectionMetaTags(section)` ~7215
Returns `string[]` of tag values (WITHOUT brackets). Logic:
1. If `section.metaTags[]` exists → forEach through it (bypasses direction/instructions)
2. Otherwise → adds `direction`, then splits `instructions` by newline, adds each line
3. `addTag(raw)` strips brackets, deduplicates, and skips tags that match `section.type`

### `areSameMetaLine(a, b)` ~7220
Used by `collectSectionMetaTags.addTag` to prevent type duplication. Normalizes both to lowercase trimmed before comparing.

### `applySunoStylePromptData(song)` ~7265
Enforces 1000-char limit on `song.suno_style_prompt`. Also injects duration if set.

### `buildAssembledLyricsPrompt(song)` ~7293
For each section: `[type]\n[tags]\nbody` built via `collectSectionMetaTags`, then `normalizeLyricsText` applied per-section. Sections joined with `\n\n`.

### `normalizeLyricsText(text)` ~9650
Collapses multiple blank lines after any `[...]` meta tag line.

### `stripAllLeadingMetaTags(text)` ~7155
Removes all consecutive `[...]` lines at the start of `text`. Stops at first non-bracket line.

### `stripLeadingStyleMetaTag(text)` ~7130
Only strips if the first line matches `[Style: ...]`.

### `mergePreservedLyricsSections(gen, user, mode)` ~8040
Merges AI-generated sections with user-preserved sections. `mode`: `"keep"` | `"fit"` | `"match"`.

### `restoreVocalProfiles(vocalProfilesData)` ~8090
**Must call `selectVocalType(typeTag)`** — not manual class toggle — to ensure Choir/Ensemble gets the correct builder path. Uses `setTimeout` to defer DOM updates post-selectVocalType.

### `renderSongCard(song)` ~9500
Builds complete output card HTML. Calls `initSectionTextareas(song)` after inserting into DOM to wire textarea events.

### `initSectionTextareas(song)` ~9580
Wires `input` handler on each section textarea. On every input:
1. Parses all `[...]` lines (after type) → `section.metaTags[]`
2. Sets `section.direction = metaTags[0]` and `section.instructions = metaTags.slice(1).join("\n")` (backward compat)
3. Sets `section.lines = remaining text`
4. Auto-resizes textarea

### `generateSong()` ~9750
1. Collect form; validate genre/concept required
2. Keep-mode warning if no section identifiers
3. Pre-flight confirm modal (calls `buildSubmissionSummary`)
4. Build prompt string (~200 lines of prompt construction)
5. Influence descriptors → 4–6 word style phrases (Suno-safe)
6. `callAI()` → `safeParseJSON()` → apply to `currentSong`
7. Per-section: strip leading meta tags, apply structure instructions
8. `mergePreservedLyricsSections` if keep/fit/match mode
9. `applySunoStylePromptData`
10. `renderSongCard` + `renderChordsCard` + `saveToHistory`
11. Assembled lyrics > 5000 chars → `openLyricsTooLongModal`

### `applyUnifiedAnalysis()` ~6700
Calls AI with the unified analyzer schema → applies genre, style, sound, structure, vocal, chords, key_info all at once. Uses `applyVocalConfiguration(vocalConfig)` for vocal restore.

### `captureCurrentSettingsSnapshot()` ~8200
Reads all form state → returns a `SettingsSnapshot` object that is saved with each history item.

### `applyHistorySettings(song)` ~8300
Restores all UI from `song.settings` (SettingsSnapshot). Called by `loadFromHistory`.

---

## AI Response Schemas

### Main song generation
```json
{
  "title": "", "logline": "", "genre": "", "structureName": "",
  "concept": "", "mood": "", "rhyme": "",
  "suno_style_prompt": "(≤1000 chars)",
  "vocal_gender": "", "vocal_range": "",
  "instrument_exclusions": "", "suggested_influences": "",
  "goal": "", "rhythm": "", "grooveFeel": "",
  "key_info": { "key": "", "time_sig": "", "tempo": "", "feel": "" },
  "production": "",
  "chords": { "chords": [{"name":"","role":""}], "progression": "", "notes": "" },
  "sections": [{ "type": "", "direction": "", "instructions": "", "lines": "", "userProvided": false }]
}
```

### Unified analyzer
```json
{
  "genre_key": "", "genre_label": "", "mood": "", "rhyme": "", "tempo": "", "pov": "",
  "musical_key": "", "time_signature": "", "era_keys": [], "prodstyle_keys": [],
  "inst_keys": [], "mix_keys": [], "influences": [],
  "vocal_config": { "type": "", "profiles": [], "choir": {} },
  "goal": "", "rhythm": "", "groove_feel": "", "bass": "", "spatial_effects": "",
  "instruments_keys": [],
  "structure_name": "", "structure_flow": "", "structure_desc": "",
  "structure_tag": "",
  "structure_sequence": [{"name":"","chords":"","instructions":""}],
  "summary": ""
}
```

### Section regen
```json
{ "lines": "", "direction": "", "suno_style_prompt": "", "style_meta_tag": "" }
```

### AI shorten
```json
{ "shortened_lyrics_prompt": "", "character_count": 0 }
```

---

## Instructions Cleanup Convention

When AI returns `instructions` with multi-line bracket-formatted content like `"[Intro]\n[desc]\n[detail]"`, the cleanup is **per-line**:
```js
section.instructions = section.instructions
    .split("\n")
    .map((line) => line.trim().replace(/^\[|\]$/g, "").trim())
    .filter(Boolean)
    .join("\n");
```
**Never** apply `.replace(/^\[|\]$/g, "")` to the entire multi-line string — this strips only the first `[` and last `]` of the whole string, mangling content.

---

## Vocal Profile HTML Structure

```
#vocal-profiles-container     ← built by buildVocalProfiles()
  .vocal-profile-row          ← one per profile
    .gender-tags              ← Male/Female tag buttons
    .range-tags               ← soprano/alto/tenor/bass/etc
    .accent-tags              ← Neutral/British/etc
    .style-tags               ← Clean/Raspy/Breathy/etc

#choir-builder                ← shown only for Choir/Ensemble type
  (checkboxes for each voice part + style options)

#choir-toggle-row             ← the "Add Choir/Ensemble backing" checkbox row
                                 hidden for Choir/Ensemble type
```

---

## History Storage Format

`sunoforge_history` = JSON array of `song` objects. Each song includes the full `settings` snapshot. Max entries enforced in `saveToHistory`.

Drive-backed optional storage:
- Provider key: `sf_storage_provider` (`local` or `drive`)
- Drive config cache: `google_drive_client_id`, `google_drive_folder_id`
- Drive folder: visible `SunoForge` folder in My Drive root
- Drive files: `sunoforge-history.json`, `sunoforge-settings.json`
- Drive scope: `https://www.googleapis.com/auth/drive.file`
- API keys remain local-only; Drive sync covers history plus selected non-secret settings

Export format (`.txt`): `---BEGIN SUNOFORGE SONG---` / `---END SUNOFORGE SONG---` delimiters. Parsed back by `parseImportedSong`.

Storage flow:
- `persistHistory()` updates local cache first, then schedules Drive sync when Drive storage is active and authorized
- `buildSyncedSettingsPayload()` builds the Drive-synced settings payload
- `syncDriveAppState()` hydrates remote state, merges histories, and writes both JSON files back to Drive
- Song language custom input should use `saveSongLanguageCustom()` so custom language changes participate in synced settings persistence

---

## Common Bug Patterns to Avoid

| Bug | Root cause | Fix |
|-----|-----------|-----|
| `JSON.parse` on AI response fails | AI embeds literal `\n` in strings | Use `safeParseJSON()` |
| Section shows wrong content in textarea | `editableText` built from wrong source / instructions not round-tripped | Use `collectSectionMetaTags(sec)` to build display |
| `[Intro][Intro]` duplication in export | AI puts type tag inside `instructions` | `addTag` in `collectSectionMetaTags` deduplicates against `section.type` |
| Vocal styles not restored from history | `restoreVocalProfiles` bypassed `selectVocalType` path | Always call `selectVocalType(tag)` not manual class toggle |
| Choir/Ensemble shows wrong UI | `buildVocalProfiles` called for choir type | `selectVocalType` handles routing; `buildVocalProfiles` skips choir/instrumental |
| Inter-section blank lines eaten in copy | `normalizeLyricsText` called on whole joined string | Run `normalizeLyricsText` per-section before joining |
