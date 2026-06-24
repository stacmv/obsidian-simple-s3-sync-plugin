---
name: pf-spec
description: Write the technical spec (specs.md) for the active issue, based on its BRD
version: 3.0.0
---

Check that `docs/issues/open/[ISSUE-ID]/brd.md` exists. If it does not, stop and tell the user: "BRD is required before writing the spec. Run /pf-brd first."
If `specs.md` already exists, stop and inform the user — SPEC stage is already complete.

Based on the BRD, write the specs at `docs/issues/open/[ISSUE-ID]/specs.md` (place next to BRD file). Use ASCII diagrams where necessary to illustrate the UI/UX. Use the AskUserQuestion tool to ask me clarifying questions until you are 95% confident you can complete this task successfully. For each question, add your recommendation (with reason why) below the options. This would help me in making a better decision.

If this specs file will be too big (more than 1500 lines), please split it into 3 parts. Keep the original file as the index file that links to the 3 parts.

Where [ISSUE-ID] means: scan docs/issues/open/ and use the active issue folder name.
