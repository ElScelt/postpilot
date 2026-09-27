// Compares a presented secret with the expected one without revealing, through timing,
// how much of a guess was right. Written without node:crypto so it runs in the proxy too.
export function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}
