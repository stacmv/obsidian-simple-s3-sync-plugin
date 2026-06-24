---
name: pf-brd
description: Generate a Business Requirements Document (BRD) for the active issue via guided Q&A
version: 3.0.0
---

Read `docs/issues/open/[ISSUE-ID]/prompt.md` to understand the project description, where [ISSUE-ID] is the active issue folder found by scanning `docs/issues/open/`. If `brd.md` already exists in the same folder, stop and inform the user — BRD stage is already complete.

I want to build [read description from prompt.md]. I want you to help me brainstorm for the business requirement document (BRD) for this project. Focus on business logic and rules, user stories, and acceptance criteria.
IMPORTANT: DO NOT INCLUDE ANY TECHNICAL IMPLEMENTATION DETAILS.
Use the AskUserQuestion tool to ask me clarifying questions until you are 95% confident you can complete this task successfully. For each question, add your recommendation (with reason why) below the options. This would help me in making a better decision.

Save the BRD to `docs/issues/open/[ISSUE-ID]/brd.md`.
