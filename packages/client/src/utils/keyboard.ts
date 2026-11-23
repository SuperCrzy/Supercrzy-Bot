/** Some IMEs report keyCode 229 even when isComposing is false. */
export function isComposingKey(event?: KeyboardEvent): boolean {
  return !!event && (event.isComposing || event.keyCode === 229)
}
