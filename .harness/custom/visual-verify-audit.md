The text diff above is NOT sufficient to judge a UI task (an element can be in the diff yet never be
painted — the T223 padlock bug). Before deciding PASS/FAIL you MUST:
  1. Run:  npm --prefix dashboard run build && node dashboard/scripts/visual-check.mjs
  2. READ the screenshots it writes to dashboard/scripts/visual-out/ (the script prints their paths).
  3. Judge whether the rendered pages actually satisfy every "## Done when" item VISUALLY — the
     intended element is present AND painted/visible, not merely in the DOM. FAIL if a screenshot
     contradicts a "## Done when" claim, if the visual check exits non-zero, or if a "## Done when"
     visual requirement is not evidenced by what actually renders.
