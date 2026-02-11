---
runme:
  id: test-long-output
  version: v3
---
# Long Output Test Notebook

Tests scrolling behavior, overflow handling, and output container sizing with large outputs.

## 100+ Lines Output

```bash {"name":"long-output"}
for i in $(seq 1 120); do
  printf "Line %03d: The quick brown fox jumps over the lazy dog (padding to make lines longer)\n" "$i"
done
```

## Wide Output (Long Lines)

```bash {"name":"wide-output"}
echo "SHORT: ok"
echo "MEDIUM: $(printf '%0.s=' $(seq 1 120))"
echo "LONG:   $(printf '%0.sABCDEFGHIJ' $(seq 1 30))"
echo "EXTRA:  $(printf '%0.s#' $(seq 1 300))"
echo "SHORT: done"
```

## Small Output (Contrast)

```bash {"name":"small-output"}
echo "Just two lines."
echo "Nothing more."
```

## Mixed Output Sizes

```bash {"name":"medium-output"}
echo "=== Medium Output Block ==="
for i in $(seq 1 25); do
  echo "  Item $i: status=ok value=$((i * 7))"
done
echo "=== End ==="
```

## Numbered Table Output

```bash {"name":"table-output"}
printf "%-6s %-20s %-10s\n" "ID" "Name" "Status"
printf "%-6s %-20s %-10s\n" "------" "--------------------" "----------"
for i in $(seq 1 50); do
  printf "%-6d %-20s %-10s\n" "$i" "item-$(printf '%04d' $i)" "active"
done
```

## Single Line Output

```bash {"name":"one-liner"}
echo "done"
```
