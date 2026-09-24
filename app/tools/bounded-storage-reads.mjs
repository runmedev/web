const bulkMethods = new Set([
  'toArray',
  'bulkGet',
  'sortBy',
  'primaryKeys',
  'keys',
  'each',
  'eachKey',
  'eachPrimaryKey',
  'getAll',
  'getAllKeys',
])
const payloadTables = new Set(['files', 'driveCreates'])

/** Resolve literal/computed names without depending on TypeScript type services. */
function name(node) {
  return node?.type === 'Identifier' ? node.name : node?.value
}

/** Follow query chains and local aliases back to a payload-bearing table. */
function isPayloadTable(node, source, visited = new Set()) {
  if (!node) return false
  if (
    node.type === 'ChainExpression' ||
    node.type === 'TSAsExpression' ||
    node.type === 'TSNonNullExpression'
  )
    return isPayloadTable(node.expression, source, visited)
  if (node.type === 'MemberExpression')
    return (
      payloadTables.has(name(node.property)) ||
      isPayloadTable(node.object, source, visited)
    )
  if (node.type === 'CallExpression') {
    if (
      name(node.callee.property) === 'table' &&
      payloadTables.has(name(node.arguments[0]))
    )
      return true
    return isPayloadTable(node.callee, source, visited)
  }
  if (node.type === 'Identifier') {
    if (payloadTables.has(node.name)) return true
    for (let scope = source.getScope(node); scope; scope = scope.upper) {
      const variable = scope.set.get(node.name)
      if (!variable) continue
      if (visited.has(variable)) return false
      visited.add(variable)
      return variable.defs.some((definition) =>
        isPayloadTable(definition.node.init, source, visited)
      )
    }
  }
  return false
}

/** Payload tables must use the central budgeted page or streaming scan helpers. */
export const boundedStorageReads = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      useHelper:
        'Use readTablePage() for bounded metadata pages or scanTable() for streaming file/creation reads; direct {{method}}() bypasses storage budgets.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const method = name(node.callee.property)
        if (
          bulkMethods.has(method) &&
          isPayloadTable(node.callee.object, context.sourceCode)
        )
          context.report({ node, messageId: 'useHelper', data: { method } })
      },
    }
  },
}

export default { rules: { 'bounded-storage-reads': boundedStorageReads } }
