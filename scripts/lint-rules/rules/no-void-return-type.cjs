function isVoidType(typeAnnotation) {
  return typeAnnotation?.type === "TSVoidKeyword"
}

function isPromiseVoidType(typeAnnotation) {
  if (
    typeAnnotation?.type !== "TSTypeReference" ||
    typeAnnotation.typeName?.type !== "Identifier" ||
    typeAnnotation.typeName.name !== "Promise"
  ) {
    return false
  }

  const typeParams = typeAnnotation.typeArguments ?? typeAnnotation.typeParameters
  return typeParams?.params?.length === 1 && typeParams.params[0].type === "TSVoidKeyword"
}

function getTypeName(typeAnnotation) {
  if (isVoidType(typeAnnotation)) return "void"
  if (isPromiseVoidType(typeAnnotation)) return "Promise<void>"
  return undefined
}

module.exports = {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow explicit void and Promise<void> return annotations on implementations",
      category: "Best Practices",
      recommended: true,
    },
    fixable: null,
    schema: [],
    messages: {
      noVoidReturnType:
        "Do not annotate implementation return types with `{{type}}`; TypeScript can infer it.",
    },
  },
  create(context) {
    function checkReturnType(returnTypeNode) {
      if (!returnTypeNode) return
      const typeAnnotation =
        returnTypeNode.type === "TSTypeAnnotation" ? returnTypeNode.typeAnnotation : returnTypeNode
      const typeName = getTypeName(typeAnnotation)
      if (!typeName) return
      context.report({
        node: returnTypeNode,
        messageId: "noVoidReturnType",
        data: { type: typeName },
      })
    }

    return {
      FunctionDeclaration(node) {
        checkReturnType(node.returnType)
      },
      ArrowFunctionExpression(node) {
        checkReturnType(node.returnType)
      },
      FunctionExpression(node) {
        checkReturnType(node.returnType)
      },
    }
  },
}
