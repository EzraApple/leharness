import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const plugin = {
  meta: {
    name: "leharness",
    version: "0.0.1",
  },
  rules: {
    "no-as-cast": require("./rules/no-as-cast.cjs"),
    "no-double-exclamation-point": require("./rules/no-double-exclamation-point.cjs"),
    "no-enum": require("./rules/no-enum.cjs"),
    "no-void-return-type": require("./rules/no-void-return-type.cjs"),
  },
}

export default plugin
