/**
 * The default length of a replicaId, in characters.
 *
 * Rationale for value 11:
 * Each character of the replicaId gives us 7 bits of entropy,
 * for a total of 77 bits.  This gives a < 1%
 * probability that two replicas in the same conversation
 * will ever choose the same replicaId's, even if we
 * consider the total probability across 1 billion
 * conversations with 1 million replicaIds each
 * (= 100 users * 1000 days * 10 replicas/user/day).
 */
export const DEFAULT_REPLICA_ID_LENGTH = 11;

/**
 * @return A random replicaId made of ASCII characters
 * (char codes 0--127, inclusive).
 * Such replicaId's can be safely treated as either
 * byte arrays or UTF-8 strings.
 */
export function randomReplicaId(
  length: number = DEFAULT_REPLICA_ID_LENGTH
): string {
  const arr = new Array<number>(length);
  let randomValues = new Uint8Array(length);
  if (typeof window === "undefined") {
    // Use Node crypto library.
    // We use eval("require") to prevent Webpack from attempting
    // to bundle the crypto module and complaining.
    // In theory we should also be able to do this by
    // adding "browser": {"crypto": false} to package.json,
    // but that is not working, and besides, every user
    // of this package would have to remember to do so.
    // See https://github.com/webpack/webpack/issues/8826
    const crypto = eval("require")("crypto");
    const randomBuffer = crypto.randomBytes(length);
    randomValues = new Uint8Array(randomBuffer);
  } else {
    // Use browser crypto library.
    window.crypto.getRandomValues(randomValues);
  }
  for (let i = 0; i < length; i++) {
    // Here we exploit the fact that 128 divides 256.
    // This would be biased otherwise.
    arr[i] = randomValues[i] % 128;
  }
  return String.fromCharCode(...arr);
}