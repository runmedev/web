# Runs History And Run Details

## Purpose

The app includes dedicated routes for browsing historical runs and inspecting a
single run in detail.

## Routes

- `/runs`: paginated and searchable run list,
- `/runs/:runName`: run detail view.

## `/runs` behavior

The run list supports:

- refresh,
- search by run name prefix,
- pagination,
- last-updated timestamps.

## Run detail behavior

The run detail page renders the stored notebook for a run and can poll while the
run is still active.

Expected user-facing features:

- sticky run metadata header,
- refresh,
- scroll-to-bottom while runs are live,
- notebook rendering with markdown and output support,
- cell anchor targeting via URL hash.

## High-value facts for Codex

- The runs pages are read-oriented surfaces, not the main editing workflow.
- If a user wants to investigate a past run rather than edit a notebook, route
  them to `/runs` instead of the explorer.
