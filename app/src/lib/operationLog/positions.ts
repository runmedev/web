import type { PositionComponent, PositionId } from './types'

const MAX_DIGIT = 0xffffffff
const textEncoder = new TextEncoder()

function compareUtf8(left: string, right: string): number {
  const leftBytes = textEncoder.encode(left)
  const rightBytes = textEncoder.encode(right)
  const length = Math.min(leftBytes.length, rightBytes.length)
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) {
      return leftBytes[index] < rightBytes[index] ? -1 : 1
    }
  }
  return leftBytes.length < rightBytes.length
    ? -1
    : leftBytes.length > rightBytes.length
      ? 1
      : 0
}

export function comparePositionComponents(
  left: PositionComponent,
  right: PositionComponent
): number {
  if (left[0] !== right[0]) return left[0] < right[0] ? -1 : 1
  const actorOrder = compareUtf8(left[1], right[1])
  if (actorOrder !== 0) return actorOrder
  return left[2] < right[2] ? -1 : left[2] > right[2] ? 1 : 0
}

export function comparePositionIds(
  left: PositionId,
  right: PositionId
): number {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const order = comparePositionComponents(left[index], right[index])
    if (order !== 0) return order
  }
  return left.length < right.length ? -1 : left.length > right.length ? 1 : 0
}

export function validatePositionId(position: PositionId): void {
  if (!Array.isArray(position) || position.length === 0) {
    throw new Error('PositionId must contain at least one component')
  }
  for (const component of position) {
    if (
      !Array.isArray(component) ||
      component.length !== 3 ||
      !Number.isInteger(component[0]) ||
      component[0] < 0 ||
      component[0] > MAX_DIGIT ||
      typeof component[1] !== 'string' ||
      component[1].length === 0 ||
      !Number.isSafeInteger(component[2]) ||
      component[2] <= 0
    ) {
      throw new Error('Invalid PositionId component')
    }
  }
}

export type PositionDigitChooser = (
  lowerExclusive: number,
  upperExclusive: number
) => number

const chooseMiddleDigit: PositionDigitChooser = (
  lowerExclusive,
  upperExclusive
) => lowerExclusive + Math.floor((upperExclusive - lowerExclusive) / 2)

/** Allocate an immutable dense position between two observed neighbors. */
export function allocatePositionBetween({
  left,
  right,
  actorId,
  actorSequence,
  chooseDigit = chooseMiddleDigit,
}: {
  left: PositionId | null
  right: PositionId | null
  actorId: string
  actorSequence: number
  chooseDigit?: PositionDigitChooser
}): PositionId {
  if (left) validatePositionId(left)
  if (right) validatePositionId(right)
  if (left && right && comparePositionIds(left, right) >= 0) {
    throw new Error('Left PositionId must sort before right PositionId')
  }
  if (!actorId || !Number.isSafeInteger(actorSequence) || actorSequence <= 0) {
    throw new Error('Position allocation requires a valid actor and sequence')
  }

  const prefix: PositionComponent[] = []
  let depth = 0
  let rightSharesPrefix = true

  while (depth < 1024) {
    const leftComponent = left?.[depth]
    const rightComponent = rightSharesPrefix ? right?.[depth] : undefined
    const lowerDigit = leftComponent?.[0] ?? 0
    const upperDigit = rightComponent?.[0] ?? MAX_DIGIT

    if (upperDigit - lowerDigit > 1) {
      const digit = chooseDigit(lowerDigit, upperDigit)
      if (
        !Number.isInteger(digit) ||
        digit <= lowerDigit ||
        digit >= upperDigit
      ) {
        throw new Error(
          'Position digit chooser returned a value outside the gap'
        )
      }
      const result: PositionId = [
        ...prefix,
        [digit, actorId, actorSequence] as const,
      ]
      if (
        (left && comparePositionIds(left, result) >= 0) ||
        (right && comparePositionIds(result, right) >= 0)
      ) {
        throw new Error('Allocated PositionId is not inside the requested gap')
      }
      return result
    }

    if (leftComponent) {
      prefix.push(leftComponent)
      if (
        rightComponent &&
        comparePositionComponents(leftComponent, rightComponent) !== 0
      ) {
        rightSharesPrefix = false
      }
      depth += 1
      continue
    }

    if (rightComponent && rightComponent[0] > 0) {
      const result: PositionId = [
        ...prefix,
        [rightComponent[0] - 1, actorId, actorSequence] as const,
      ]
      if (!right || comparePositionIds(result, right) < 0) return result
    }
    throw new Error('Unable to allocate a PositionId at the numeric boundary')
  }

  throw new Error('PositionId exceeded the maximum supported depth')
}
