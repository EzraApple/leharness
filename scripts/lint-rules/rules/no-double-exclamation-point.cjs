module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow double exclamation point boolean coercion",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      noDoubleExclamation:
        "Prefer Boolean() over double exclamation point (!!) for explicit boolean conversion.",
    },
  },
  create(context) {
    return {
      "UnaryExpression[operator='!'] > UnaryExpression[operator='!']"(node) {
        context.report({
          node: node.parent,
          messageId: "noDoubleExclamation",
        })
      },
    }
  },
}
