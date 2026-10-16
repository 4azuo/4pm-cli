# EVIDENCE_GUIDE — How this project wants its AI evidences

The 4PM agents read this file before they analyse a request (mockups, sequence diagrams, data-model and
system-diagram change requests) and before they finish a task (screenshots, test reports). It holds this
project's **preferences** only — file names, folders and formats stay as 4PM defines them.

> This is a sample baseline. Replace it with your own rules, or regenerate it (or one section) from
> Evidences › Guide with a short description of what you want.

## General
- Write every evidence in the language the project's guide specifies (default English).
- Keep each evidence focused on the request it comes from; state assumptions explicitly.

## Mockups
- Follow the existing UI of the product where it can be seen; otherwise a clean, neutral layout.
- Show the main states: empty, filled, loading and error, and the key interactions.
- Use realistic sample data (names, amounts, dates) — never lorem ipsum.

## Sequence diagrams
- One diagram per task with an interaction flow; actors first, then the UI, the API and the stores.
- Show the main path and the important error branch; leave out trivial steps.

## Data model (ER)
- Entity names in UPPER_SNAKE_CASE, attributes in snake_case; every entity has a primary key.
- Name relationships with a short verb.

## System diagram
- Show deployable apps, services, stores, queues and external systems — not classes or modules.
- Label links with what flows (e.g. `order.created`, `REST /orders`).

## Task evidence
- A UI change: a screenshot of each changed screen (before / after when it helps).
- Always: the test command that was run and its result summary.
