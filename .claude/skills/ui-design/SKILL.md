---
name: ui-design
description: subsmith UI design system — tokens, components, icons and the visual check loop. Use before any change to static/*.html, static/css/*.css or UI markup built in static/js/*.js (new controls, layout, colors, icons, states).
---

# subsmith UI design system

The goal is a calm, consistent, "tool-like" dark UI. Subtitles on the video are the colorful part; the chrome around them stays quiet.

## Tokens — the only allowed values

All tokens live in `:root` at the top of `static/css/style.css`. Component styles use `var(--…)` only.

| Group | Tokens | Use |
|---|---|---|
| Surfaces | `--stage` < `--bg` < `--surface-1` < `--surface-2` < `--surface-3` | page → cards → controls → hover. Never invent an in-between gray. |
| Borders | `--border`, `--border-strong` | default / hover |
| Text | `--text`, `--text-muted`, `--text-subtle` | body / labels & secondary / placeholders & rulers |
| Accent | `--accent`, `--accent-hover`, `--accent-ink`, `--accent-soft`, `--accent-line`, `--accent-text` | see "Accent rules" |
| Status | `--danger`, `--danger-ink`, `--overlay` | destructive / error toast / scrims over video |
| Tints | `--tint`, `--tint-strong` | neutral white wash over any surface (hover handles, secondary chips) |
| Radius | `--r-xs` 4, `--r-sm` 6, `--r-md` 8, `--r-lg` 12, `--r-full` | checkboxes & swatches / chips & small buttons / controls & inputs / cards, tiles, panels / pills |
| Type | `--fs-xs` 11, `--fs-sm` 12, `--fs-md` 13, `--fs-base` 14, `--fs-lg` 16, `--fs-xl` 20 | rulers & meta / labels / buttons & controls / body / page titles / rare |
| Heights | `--h-sm` 28, `--h-md` 36, `--h-lg` 42 | small buttons & inline inputs / default controls / full-width CTAs |
| Motion | `--ease` (.15s) | every hover/focus transition |

Spacing uses a 4px grid: 4, 8, 12, 16, 24, 32. Gaps between controls are 8; card padding 16 (12 for `.compact`); gaps between cards 12.

Need a value that isn't here? Add a token to `:root` with a comment, don't hardcode it.

**Allowed raw values (exceptions):** `#000`/`#fff` and black scrims on video surfaces (the editor stage, the prompter screen in `teleprompter.css`, render previews); subtitle rendering — `.sub-*` in the SVG overlay, `.look-pv`/`.look-svg` look cards (that's subtitle content, not UI); the 2px logo bars; keyframes.

## Accent rules

One accent hue (amber `#ff7a33`). It means "primary action, selected, focused, playing" — nothing else.
- Max **one** `.btn.primary` visible per panel/region.
- Selected state = accent border (+ `--accent-soft` fill for chips; a 2px accent ring for swatches).
- Text on an accent fill uses `--accent-ink` (dark), never white.
- No gradients, glows or colored shadows in UI chrome. No second accent color.

## Components (reuse, don't re-style)

- Buttons: `.btn` + one of `primary` / default / `ghost`, sizes `small` / default / `wide`, `icon` for square icon-only. Icon-only buttons must have `title`.
- Inputs: native `input/select/textarea` are already styled; checkboxes are custom via `appearance: none`.
- Cards: `.card` with an `<h3>` title as first child. Optional helper text under the title: `<p class="hint">`; helper text at the end of a card: `.hint.hint-after`.
- Label-left rows: `.slider` (label / range / value) and `.tool-row` + `.tool-label`.
- Color choice: `.swatches` > `.swatch` (`--c` custom property) next to native color inputs in `.colors.two`.
- Tiles: `.look` (subtitle style cards with a live layout preview), `.project` (project cards).
- Word chips: `.chips` > `.chip` (`.role-1` = accent word).
- Tabs: `.tabs` + `.tab`.

## Icons

Lucide SVGs via `static/js/icons.js`. Never use emoji or Unicode symbols (✕ ▶ ✎ ⬇ …) as icons.
- Static HTML: `<i data-icon="name"></i>` (hydrated by `hydrateIcons()` at startup).
- JS templates: `${icon("name")}`; button with label: `setIcon(el, "name", "Label")`.
- New icon: copy the path data from lucide.dev into the `P` map in `icons.js`. 24×24, stroke 2, round caps — no filled or other-set icons except the existing `play`/`pause`/`record`.
- Sizes: 16px default, 14px in `.btn.small`, 20–22px for hero spots.

## No inline styles

No `style="…"` in HTML or JS-built markup except values that are computed at runtime (positions, sizes, user-chosen colors). Add a class instead.

## Every interactive element has all states

hover (`--border-strong` / `--surface-3` or text → `--text`), `:focus-visible` (global accent outline — don't remove it), `:disabled` (opacity .4), and selected/active where relevant. New screens also need empty, loading and error states.

## Visual check loop (required)

CSS changes are not done until seen.
1. Run the app: `./run.sh` (port 8000). If it's already running, reuse it.
2. Open it with the Claude in Chrome tools. Static files are cached: after editing CSS/JS, refetch with `fetch(url, {cache: 'reload'})` then `location.reload()`.
3. Screenshot every screen you touched plus its neighbours: home, editor Text / Style / Export tabs, custom style editor, teleprompter setup and prompter mode.
4. Compare against the rules above: alignment, equal heights in a row, one primary per region, no wrapping labels, no raw colors.
5. Check the console for errors.
6. Opening the custom style editor autosaves the project: always close it with Cancel. Restore any localStorage you changed (teleprompter settings).

## Quick audit

```bash
# raw colors outside :root (review each hit against the exceptions above)
awk '/^}/{f=1;next} f' static/css/style.css | grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(' | grep -vE '\.(sub|look)|@keyframes|#000|#fff'
# hardcoded font sizes / radii
grep -nE 'font-size: [0-9]+px|border-radius: [0-9]+px' static/css/style.css | grep -vE '\.(sub|look|logo)'
# glyph icons that should be SVG
grep -nP '[←↶↷▶❚⤡⤢✥✂⤒⤓＋✕⌖✎↵⬇🎙⟲●▾]' static/*.html static/js/app.js static/js/teleprompter.js
```
