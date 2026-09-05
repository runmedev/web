---
name: ipynb-notebooks
title: IPYNB Notebooks
order: 17
description: >-
  Use this guide to create, edit, save, and share Jupyter IPYNB notebooks in
  Runme Web. It explains extension-based format selection, conversion through
  the Runme protocol, preservation of Jupyter-only fields, Google Drive and
  Colab sharing, synchronization, and current compatibility boundaries.
---

# IPYNB Notebooks

## Purpose

Runme Web can read and write Jupyter notebook (`.ipynb`) files. This makes
notebooks easy to view and edit in Jupyter-compatible tools such as Google
Colab while preserving Runme's editing and execution experience.

Runme still uses the Runme protocol as its internal notebook model. On load,
the app converts IPYNB content into that model. On save, it converts the
current Runme notebook back to the Jupyter notebook format.

## Creating and opening IPYNB files

The filename extension selects the storage format:

- `.ipynb` uses the Jupyter notebook format,
- `.json` uses the native Runme JSON format.

In the workspace explorer, open a folder's context menu and choose **New
Jupyter Notebook (.ipynb)**. IPYNB notebooks can be created in Local Notebooks,
a mounted filesystem folder, or Google Drive. Existing `.ipynb` files in those
locations can be opened directly.

Changing only a filename extension does not perform a separate export step.
The app writes the notebook in the format selected by the resulting extension
the next time it saves.

## What is preserved

The Runme protocol represents the fields Runme needs for editing and
execution. IPYNB can also contain Jupyter-specific metadata, attachments,
outputs, and cell fields that do not have direct Runme equivalents.

To prevent those extra fields from disappearing during a Runme edit, the app
keeps a browser-local shadow of the original IPYNB document in the Origin
Private File System (OPFS). When saving, it merges the current Runme content
back into that shadow. This preserves compatible Jupyter-only content while
keeping the Runme protocol as the live internal model.

The IPYNB file in its selected storage backend remains the authoritative
shared document. The OPFS shadow belongs to the current browser profile and is
supporting preservation data, not a second user-visible notebook or Markdown
sidecar.

## Cell identity

Runme uses one canonical cell identifier in both notebook formats:

- Runme JSON stores it as `Cell.refId`.
- IPYNB stores the same value as `cell.id`.

The IPYNB codec does not duplicate that identity in the per-cell Runme metadata
envelope.

Cell IDs are opaque. Their value does not encode whether a cell is code or
markup, and changing a cell's kind does not change its identity. Canonical IDs
use Jupyter's cell-ID constraints: 1–64 ASCII letters, digits, hyphens, or
underscores, unique within the notebook.

When Runme opens legacy content with a missing, invalid, or duplicate ID, it
repairs the ID deterministically. Older Runme releases derived IDs such as
`code_<id>` and `markup_<id>` from IPYNB cells. Runme recognizes those values
as migration aliases for existing Drive comment anchors, but new files and
comments use only the canonical ID.

## Sharing through Google Colab

Google Colab can open an IPYNB file stored in Google Drive:

1. Open the `.ipynb` notebook in Runme.
2. Open the notebook tab's context menu.
3. Choose **Copy Google Colab Link**.
4. Send the copied link to collaborators.

The Colab action is shown only when the `.ipynb` notebook has a Google Drive
backing file. A browser-local or filesystem-only notebook must first be saved
or copied to Drive before Colab can open it through a Drive link.

The recipient still needs permission to access the Drive file. Changing a
file's sharing permissions is a separate Google Drive action; copying the
Colab link does not make the file public.

Use **Copy Shareable Link** when the recipient should open the notebook in
Runme Web instead.

## Synchronization and concurrent edits

### Automatically publish a Colab copy of a .runme notebook

Right-click a `.runme` notebook tab and choose **Notebook properties**. Enable
**Automatically save a Colab copy (.ipynb)**. The option is saved in the notebook
and defaults to off. Once the notebook is linked to Google Drive, Runme creates
a sibling `.ipynb` in the same folder and updates it in the background after
source saves. Notebook cells and outputs are included. Use **Open Colab copy**
in properties once the copy has been created.

The `.runme` save completes independently of the export. Properties shows export
errors; the next source save or successful Drive sync retries the copy. Keep
Runme open and signed in while background uploads complete. Turning the option
off keeps the last copy and stops updating it.

If creation in a Shared Drive cannot be confirmed, Runme stops issuing new
creates to avoid duplicates. Check Drive for an existing copy and sync again.
If the request never arrived, use **Retry unconfirmed creation** in properties.
This requires confirmation: an earlier request that is still in flight can
leave an extra copy. Retrying cannot clear a newer or already-confirmed copy.

Generated copies contain provenance metadata and a leading notice visible in
Colab. Runme also shows a source link and renders them read-only. Make durable
edits in the source `.runme` notebook: any changes made to the generated copy in
Colab will be overwritten by a later export. Drive permissions still determine
who can open the copy, and runtime compatibility remains subject to the
limitations below.

### Editing ordinary .ipynb notebooks

Edits made in Colab update the same Drive file. Runme's Drive synchronization
will detect the upstream change. If the notebook was also edited locally,
Runme may report a conflict instead of silently overwriting either version.
Use the notebook tab's **Compare with upstream** action to inspect differences
before deciding which content to keep.

Runme may also create a `.index.md` Drive sidecar for search and indexing. The
`.ipynb` file is the notebook shared with Jupyter or Colab; the Markdown
sidecar is not the preservation shadow and does not replace the notebook.

## Execution compatibility

IPYNB makes notebook content portable, but it does not make every runtime
identical:

- Runme executes cells through the runner selected in Runme.
- Colab executes code in a Colab Jupyter runtime.
- Dependencies, credentials, environment variables, working directories, and
  available hardware can differ.
- Runme-specific execution metadata may not affect how Colab runs a cell.

For a portable notebook, include setup cells for required dependencies and
avoid relying on files or credentials that exist only in one runtime.

## Key facts

- The extension determines the saved format.
- The Runme protocol remains the internal data model.
- Load and save convert between IPYNB and the Runme protocol.
- `Cell.refId` and IPYNB `cell.id` contain the same canonical value.
- OPFS preserves Jupyter-only fields that the Runme model cannot represent.
- Only Drive-backed IPYNB notebooks expose a Google Colab link.
- Drive permissions determine who can open the copied Colab link.
