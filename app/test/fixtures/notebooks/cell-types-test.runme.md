---
runme:
  id: test-cell-types-md
  version: v3
---
# Cell Types Test Notebook

Tests multi-language code cells and rich markdown rendering.

## Bash Cell

```bash {"name":"bash-hello"}
echo "Hello from Bash"
echo "Shell: $SHELL"
echo "User: $(whoami)"
```

## Python Cell

```python {"name":"python-calc"}
import sys
import math

print("Python version:", sys.version_info.major, sys.version_info.minor)
print(f"Pi is approximately {math.pi:.6f}")
for i in range(5):
    print(f"  {i}^2 = {i**2}")
print("Sum of 1..100:", sum(range(1, 101)))
```

## JavaScript Cell

```javascript {"name":"js-objects"}
const items = ["hello", "world", "test"];
items.forEach((item, i) => console.log(`  ${i}: ${item}`));
console.log(`Total: ${items.length} items`);

const data = { name: "test", values: [1, 2, 3] };
console.log("Object:", JSON.stringify(data, null, 2));
console.log("Type:", typeof data);
```

## Rich Markdown Section

Here are various markdown features:

### Tables

| Language   | Extension | Type       |
|------------|-----------|------------|
| Bash       | .sh       | Shell      |
| Python     | .py       | Interpreted|
| JavaScript | .js       | Interpreted|
| Go         | .go       | Compiled   |

### Blockquotes

> This is a blockquote testing rendering.
>
> It has multiple paragraphs.

### Lists

**Ordered:**
1. First item
2. Second item
3. Third item

**Unordered:**
- Alpha
- Beta
  - Nested item one
  - Nested item two
- Gamma

### Inline Formatting

This paragraph has **bold**, *italic*, ***bold italic***, `inline code`, and ~~strikethrough~~ text.

## Final Verification

```bash {"name":"verify-all"}
echo "=== Cell Types Test Complete ==="
echo "Bash: OK"
echo "Python: OK"
echo "JavaScript: OK"
echo "Markdown: OK"
```
