---
# ── Identity (researched) ───────────────────────────────────────────────
name: "Perfume Name"
brand: "House / Brand"
year: 2020                 # release year (number); use null if genuinely unknown
perfumer: "Perfumer Name" # or "unknown"
concentration: "EDP"      # EDP | EDT | Parfum | Extrait | Cologne
family: "Woody Aromatic"  # primary olfactory family
accords: ["woody", "spicy", "citrus"]   # 3–6 dominant accords (lowercase)
# ── Notes pyramid (researched) ──────────────────────────────────────────
notes:
  top: ["bergamot", "pink pepper"]
  heart: ["lavender", "geranium"]
  base: ["cedar", "amber", "musk"]
# ── Wear profile (researched — informed by Fragrantica's "when to wear" voting) ──
season: ["spring", "autumn"]        # spring | summer | autumn | winter
time: ["day", "night"]              # day | night
occasion: ["office", "casual", "date", "formal", "outdoors"]
mood: ["fresh", "confident", "cozy"]   # vibe tags for "I feel like X today" queries
gender: "masculine"       # community lean (Fragrantica vote): feminine | unisex | masculine
longevity: "long"         # community vote: weak | moderate | long | very long
sillage: "moderate"       # community vote: intimate | moderate | strong | enormous
# ── Community signal (researched — Fragrantica / Parfumo aggregate) ──────
community_rating: "4.15 / 5 (2310 votes)"   # aggregate score + vote count; null if none found
fragrantica_status: "ok"   # was Fragrantica data actually used? ok | blocked | not-found
fragrantica_url: "https://www.fragrantica.com/perfume/Brand/Name-12345.html"   # page used, or null
# ── Personal (you fill these over time — may stay blank for now) ─────────
rating: null              # your own score, 1–10
status: "owned"           # owned | decant | sample | wishlist
# ── Provenance ──────────────────────────────────────────────────────────
sources:
  - "https://example.com/source-1"
---

# Perfume Name — Brand

## Overview
One short paragraph: what it is, the house context, and why it's notable.

## Olfactory Profile
How it actually smells — the opening, the development, the drydown. Describe the
character (e.g. dry vs. sweet, loud vs. skin-scent), and note real-world longevity
and sillage in prose, not just the frontmatter tags.

## Community Sentiment
What real wearers say. Lead with the Fragrantica aggregate rating + vote count, then the
themes from reviews/comments — who it suits, when people reach for it, common compliments
and complaints — and what the community voting bars say about longevity, sillage, gender,
and season/occasion. If little or no community data exists, say so explicitly and name
what you did find.

## Recommended Settings
When and where this shines — season, time of day, occasion, and the mood it suits.
Editorial judgement welcome; tie it back to the `season` / `occasion` / `mood` tags.

## Similar Fragrances
"If you like this, also try…" — a few comparable fragrances with a one-line reason
each (shared accords, similar vibe, a cheaper alternative, etc.).

## History & Background
Release story, the perfumer, the house, and any notable reformulations or context.

## Personal Notes
<!-- Your own thoughts over time — leave blank for now. -->

## Application
<!-- Your spray pattern, e.g. "2 to chest, 1 to each wrist, 1 to back of neck." Leave blank for now. -->

## Sources
1. https://example.com/source-1
2. https://example.com/source-2
