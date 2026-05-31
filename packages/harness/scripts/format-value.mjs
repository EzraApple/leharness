/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatValue(value) {
  if (typeof value === "string") return value
  const json = JSON.stringify(value)
  return json === undefined ? String(value) : json
}
