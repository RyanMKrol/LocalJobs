This task changes the dashboard's rendered surface. Passing tsc/tests/build is NOT enough — an
element can satisfy every structural check yet never be painted (the T223 padlock bug). You MUST:
  1. Build the dashboard, then capture screenshots:
        npm --prefix dashboard run build && node dashboard/scripts/visual-check.mjs
  2. READ the PNGs it writes to dashboard/scripts/visual-out/ (the script prints their paths) and
     confirm WITH YOUR OWN EYES that what you changed renders correctly — the thing you added is
     actually painted/visible, nothing is blank, overlapping, or clipped. Record what you observed
     in .harness/worklog/<TASK>.md.
  3. CAPTURE INTERACTIVE STATES — if the thing you changed only appears AFTER an interaction (an
     opened modal/popover, an expanded section, a clicked control, a multi-step flow), a baseline
     page screenshot will NOT show it. You MUST add (or update) a FLOWS entry in
     dashboard/scripts/_dashboard-harness.mjs — { name, path, actions(page) } that drives the click/
     open, with `viewport: true` for a modal/overlay so its backdrop frames the whole shot — AND any
     fixture the interacted state needs (e.g. a populated popup) — so visual-check produces a
     screenshot of that state. Then READ that screenshot too. If you can't SEE your change in a
     captured PNG, the visual confirmation is INCOMPLETE.
  4. LIVING ARTIFACT (non-negotiable): if you ADDED a page, ADDED/REMOVED a workflow or gate, ADDED
     an interactive state, or otherwise changed the UI surface, you MUST update
     dashboard/scripts/_dashboard-harness.mjs in THIS SAME commit — its PAGES list, fixtures, and/or
     FLOWS — so the check stays accurate and does not start failing on intentionally-removed UI. The
     visual-check/harness/mobile-check scripts are ALWAYS in-scope for a UI task; editing them never
     trips the scope gate.
