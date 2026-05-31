module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow TypeScript as type assertions",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      noAsCast:
        "Avoid `as` type assertions. Prefer type guards, parser helpers, or typed generics. If a cast is unavoidable, isolate it at the boundary.",
    },
  },
  create(context) {
    return {
      TSAsExpression(node) {
        if (
          node.typeAnnotation.type === "TSTypeReference" &&
          node.typeAnnotation.typeName.type === "Identifier" &&
          node.typeAnnotation.typeName.name === "const"
        ) {
          return
        }

        context.report({
          node,
          messageId: "noAsCast",
        })
      },
    }
  },
}
