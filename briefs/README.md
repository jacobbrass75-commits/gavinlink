# Briefs

This directory is design and operating context, not executable truth.

## Layout

- `modules/`: implementation briefs and module notes
- `reports/`: point-in-time findings and status reports
- `prompts/`: audit or operator prompts

If a fact here needs to drive product behavior, move it into code, migrations, tests, `raw/`, or `wiki/` as appropriate.

`briefs/modules/` is planning/history context, not runtime truth. If those module briefs disagree with the current app, the code, tests, and top-level architecture docs win.
