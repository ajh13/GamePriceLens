/** Describe an error without adding a second Error prefix. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Combine failures while retaining their original values and stacks. */
export function combineErrors(errors: readonly unknown[], message?: string): Error {
  if (errors.length === 1 && message === undefined && errors[0] instanceof Error) return errors[0]
  const combined = Object.assign(new Error(message ?? errors.map(errorMessage).join("; ")), {
    cause: errors[0],
    errors: errors.slice(),
  })
  const stacks = errors.map((error) => error instanceof Error ? error.stack : undefined).filter(Boolean)
  if (stacks.length) combined.stack = `${combined.stack}\nCaused by: ${stacks.join("\nCaused by: ")}`
  return combined
}
