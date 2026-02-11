---
runme:
  id: test-layout
  version: v3
---
# Layout & Border Test Notebook

Tests cell layout, borders, spacing, and edge cases for visual rendering.

## Single Cell Scenario

This notebook starts with a single cell to test the "add cell at bottom" button behavior.

```bash {"name":"single-cell"}
echo "This is the only code cell."
echo "The 'add cell' button should appear below."
```

## Tall Output Cell

```bash {"name":"tall-output"}
echo "=== Start of tall output ==="
for i in $(seq 1 40); do
  echo "Row $i: data_value=$(printf '%05d' $((i * 13)))"
done
echo "=== End of tall output ==="
```

## Empty Output Cell

```bash {"name":"empty-output"}
true
```

## Minimal Output Cell

```bash {"name":"tiny-output"}
echo "x"
```

## Multi-line Markdown Between Cells

This section has **rich markdown** content between code cells to test spacing:

- Bullet point one
- Bullet point two
- Bullet point three

> A blockquote to test visual separation from adjacent cells.

## Another Code Cell After Markdown

```bash {"name":"after-markdown"}
echo "Cell after rich markdown content"
echo "Borders should be consistent"
```

## Adjacent Code Cells (No Markdown Between)

```bash {"name":"adjacent-a"}
echo "Cell A - immediately before Cell B"
```

```bash {"name":"adjacent-b"}
echo "Cell B - immediately after Cell A"
```

## Final Cell

```bash {"name":"final-cell"}
echo "Last cell in notebook."
echo "Scroll and bottom padding should be correct."
```
