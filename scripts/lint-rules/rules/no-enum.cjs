module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow TypeScript enum declarations",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      noEnum: "Avoid TypeScript enums. Prefer string literal unions or `as const` objects.",
    },
  },
  create(context) {
    return {
      TSEnumDeclaration(node) {
        context.report({
          node,
          messageId: "noEnum",
        })
      },
    }
  },
}
