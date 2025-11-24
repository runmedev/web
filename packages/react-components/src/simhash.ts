import { parser_pb } from './runme/client'

// SimHash utility functions for duplicate detection

/**
 * Simple hash function for string tokens
 */
function simpleHash(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash // Convert to 32-bit integer
  }
  return hash
}

/**
 * Computes a 64-bit SimHash fingerprint from text
 * @param text - The text to compute the hash for
 * @returns A 64-bit BigInt representing the SimHash fingerprint
 */
export function computeSimHash(text: string): bigint {
  if (!text || text.trim().length === 0) {
    return BigInt(0)
  }

  // Tokenize the text into words (simple whitespace-based tokenization)
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)

  if (tokens.length === 0) {
    return BigInt(0)
  }

  // Create a 64-bit fingerprint vector
  const fingerprint = new Array(64).fill(0)

  // For each token, create a hash and update the fingerprint
  for (const token of tokens) {
    // Create a 64-bit hash by hashing the token twice with different seeds
    const hash1 = simpleHash(token)
    const hash2 = simpleHash(token + '_seed2')

    // Combine into a 64-bit value (using 32 bits from each)
    const combinedHash =
      BigInt(hash1 >>> 0) | (BigInt(hash2 >>> 0) << BigInt(32))

    // Update fingerprint: for each bit position, increment if bit is set, decrement if not
    for (let i = 0; i < 64; i++) {
      const bit = (combinedHash >> BigInt(i)) & BigInt(1)
      if (bit === BigInt(1)) {
        fingerprint[i] += 1
      } else {
        fingerprint[i] -= 1
      }
    }
  }

  // Convert to binary: set bit i to 1 if fingerprint[i] > 0, else 0
  let result = BigInt(0)
  for (let i = 0; i < 64; i++) {
    if (fingerprint[i] > 0) {
      result |= BigInt(1) << BigInt(i)
    }
  }

  return result
}

/**
 * Calculates the Hamming distance between two SimHash values
 * @param hash1 - First SimHash value
 * @param hash2 - Second SimHash value
 * @returns The number of bits that differ between the two hashes
 */
export function hammingDistance(hash1: bigint, hash2: bigint): number {
  const xor = hash1 ^ hash2
  let distance = 0
  let temp = xor

  // Count the number of set bits (population count) - optimized for 64-bit
  // Since we're using 64-bit hashes, we can count bits efficiently
  while (temp > 0) {
    if (temp & BigInt(1)) {
      distance++
    }
    temp = temp >> BigInt(1)
  }

  return distance
}

/**
 * Determines if two cells are similar based on their SimHash values
 * @param cell1 - First cell to compare
 * @param cell2 - Second cell to compare
 * @param threshold - Hamming distance threshold (default: 3). Cells are considered similar if distance <= threshold
 * @returns true if the cells are similar, false otherwise
 */
export function areCellsSimilar(
  cell1: parser_pb.Cell,
  cell2: parser_pb.Cell,
  threshold: number
): boolean {
  if (!cell1.value || !cell2.value) {
    return false
  }

  const hash1 = computeSimHash(cell1.value)
  const hash2 = computeSimHash(cell2.value)
  const distance = hammingDistance(hash1, hash2)

  // If hamming distance is <= threshold, cells are considered similar
  return distance <= threshold
}
