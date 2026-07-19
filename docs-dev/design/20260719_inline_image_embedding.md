# Inline Image Embedding

Author: jlewi and Codex

Date: 2026-07-19

Status: Draft

## TL;DR

Runme will embed image bytes in an existing HTML notebook cell. The same domain
function will power:

- `await embed(source, options)` in App Console and WebMCP,
- `await notebooks.embed(source, options)`,
- an **Embed image** button beside **Add cell**, and
- image file drag and drop onto the notebook.

The first version accepts browser `File`/`Blob` values, image data URLs, HTTP(S)
URLs, and absolute local image paths when the Vite development server is
running. It validates the MIME type and size, converts the bytes to a base64 data
URL, and appends a non-runnable `CODE` cell with `languageId: "html"`.

This design does not add a protobuf cell kind or upload images to Google Drive.

## Motivation

Runme notebooks cannot currently preserve screenshots or other static images as
authored notebook content. Users must host an image elsewhere, emit it from a
runnable cell, or describe it in text. This makes runbooks and debugging notes
less useful, especially when a screenshot is the primary evidence.

Programmatic embedding is also required for Codex and WebMCP workflows. A
Codex task can create a screenshot on the local machine, but the notebook has no
API that can import that file and persist it with the document.

## Background

Runme already supports static HTML cells:

- HTML content uses `CellKind.CODE` with `languageId: "html"`.
- HTML cells are non-runnable.
- The editor renders their content in a sandboxed iframe without script
  permission.
- Notebook storage already preserves the HTML source.

The runtime architecture requires meaningful UI actions to call a domain
function that is also available from App Console and WebMCP. Image embedding
will follow that pattern instead of implementing file conversion inside React
event handlers.

Embedding increases serialized notebook size. Base64 encoding adds roughly
33% to the image payload before JSON escaping and metadata.

## Proposal

### Notebook representation

Each embedded image will be stored in one HTML cell:

```html
<figure style="margin:0">
  <img
    src="data:image/png;base64,..."
    alt="Screenshot"
    style="display:block;max-width:100%;height:auto"
  />
</figure>
```

The cell will have:

```ts
{
  kind: CellKind.CODE,
  languageId: "html",
  metadata: {
    "runme.dev/embeddedImage": "true",
    "runme.dev/embeddedImageMimeType": "image/png",
    "runme.dev/embeddedImageName": "screenshot.png"
  }
}
```

We will reuse HTML cells because they already provide the required persistence,
editing, rendering, and non-execution behavior. A new protobuf cell kind would
duplicate those paths and require a data migration.

### Domain API

The domain module will expose:

```ts
type ImageSource = string | Blob

type EmbedImageOptions = {
  alt?: string
  name?: string
  target?: unknown
}

async function embedImageInNotebook(
  notebook: NotebookDataLike,
  source: ImageSource,
  options?: EmbedImageOptions
): Promise<{ uri: string; cell: Cell }>
```

`source` supports:

- `File` and `Blob` objects from file pickers and drag and drop,
- `data:image/...` URLs,
- HTTP(S) URLs that permit browser fetches,
- `file://` URLs and absolute POSIX or Windows paths in local development.

The module will reject non-image MIME types and payloads larger than 10 MiB.
Remote servers must permit the browser request. We will return a clear error
when CORS blocks the fetch.

### Local development file endpoint

Browsers cannot read an arbitrary absolute path directly. The Vite development
server will add a development-only endpoint:

```text
GET /__runme-dev/local-image?path=/absolute/path/to/image.png
```

The endpoint will:

- require an absolute path,
- allow only known image filename extensions,
- reject files larger than 10 MiB,
- return the matching `image/*` content type, and
- remain unavailable in production builds.

This endpoint enables `embed("/tmp/screenshot.png")` during local Codex
development. Production users should use the file picker, drag and drop, a data
URL, or a fetchable HTTP(S) URL.

### App Console and WebMCP

The rich App Console runtime will expose:

```js
await embed('/tmp/screenshot.png', { alt: 'Settings dialog' })
await notebooks.embed('https://example.com/diagram.png')
```

The sandbox bridge will allow both forms. The host implementation will resolve
the target notebook once and call the same domain function used by the UI.

`notebooks.help("embed")`, `notebooks.help()`, and top-level `help()` will
document the command.

### File picker

An **Embed image** button will appear beside **Add cell**. It will open
`showOpenFilePicker` when available and fall back to an invisible
`<input type="file" accept="image/*">`.

The selected `File` will be passed to the domain function. React will own only
picker progress, errors, and toast presentation.

### Drag and drop

The notebook content area will accept image files from `DataTransfer.files`.
The drop handler will:

1. Ignore drags without image files.
2. Prevent the browser from navigating to the dropped image.
3. Append one image cell per dropped file in drop order.
4. Report unsupported files or failures with a toast.

A visible drop target will appear while an image is dragged over the notebook.
Read-only notebooks will not advertise or accept the action.

### Security

Embedded content is untrusted:

- only `image/*` payloads are accepted,
- generated HTML attributes are escaped,
- bytes are embedded as base64 instead of authored raw HTML,
- previews stay inside the existing sandboxed iframe, and
- the generated iframe does not receive script permission.

SVG images are accepted as image bytes. They remain inside an `<img>` element in
the sandboxed HTML preview rather than being injected into the application DOM.

### Persistence and sync

The image data lives inside the notebook JSON, so all existing local,
filesystem, and Google Drive notebook persistence paths continue to work. Drive
sync does not need a separate asset transaction.

The 10 MiB source limit bounds both browser memory use and Drive document
growth. A future Drive-asset mode can support larger images without embedding
their bytes in the notebook.

### Testing

Unit tests will cover:

- data URL, Blob, HTTP(S), and local-path input,
- MIME and size validation,
- HTML escaping and base64 encoding,
- HTML cell creation and metadata,
- picker cancellation and fallback behavior,
- App Console and sandbox bridge exposure.

Component tests will cover the button and drop handlers where existing test
infrastructure permits. The repository build and full test task remain the
required final validation:

```sh
runme run build test
```

## Alternatives

### Store image bytes in cell outputs

Code-cell outputs already support `image/png`. We rejected this representation
because the image is authored notebook content, not execution output. Output
lifecycles such as clear and rerun could delete or replace it.

### Add a protobuf image cell kind

A dedicated kind could model images explicitly. We rejected it for the first
version because HTML cells already provide static, persisted, non-runnable
content. A schema addition would require changes across parsing, serialization,
storage, rendering, and migration.

### Store every image as a Google Drive file

Drive assets avoid base64 growth and support independent reuse. We deferred this
mode because it requires authentication, folder selection, multi-file
transactions, sharing semantics, and offline behavior. It would also exclude
local-only notebooks.

### Embed Markdown image syntax

Markdown could render a data URL, but the current markdown authoring surface is
intended for prose and sanitizes raw content. Reusing HTML cells keeps the image
trust boundary explicit and matches the existing rich-content design.

## References

- [20260719_images](https://runme.gateway.unified-0.internal.api.openai.org/?doc=https%3A%2F%2Fdrive.google.com%2Ffile%2Fd%2F1EL5oknzwW75WmEjzQkOC3PgYCvJnu_gZ%2Fview) — source product goal.
- [HTML Cells](./20260513_html_cells.md) — existing authored HTML representation and sandbox policy.
- [UI Action Runtime Pattern](../architecture/ui.md) — required shared domain/UI/App Console/WebMCP architecture.
- [AppKernel Sandbox](./20260311_appkernel_sandbox.md) — sandbox-to-host bridge design.
- [App Console Cells](./20260502_app_console_cells.md) — App Console interaction model.
