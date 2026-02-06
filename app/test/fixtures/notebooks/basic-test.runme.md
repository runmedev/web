---
runme:
  id: test-basic
  version: v3
---
# Basic Test Notebook

Verifies basic rendering and execution.

## Echo Test

```bash {"name":"echo-test"}
echo "RUNME_TEST_OK"
```

## Formatting Test

**Bold**, *italic*, `inline code`, and [link](https://example.com).

```bash {"name":"date-test"}
echo "Current date: $(date +%Y-%m-%d)"
echo "Working dir: $(pwd)"
```
