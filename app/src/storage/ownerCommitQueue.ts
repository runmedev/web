/** Serialize short commits by notebook. A rejected commit never poisons its successor. */
export class OwnerCommitQueue {
  private tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.catch(() => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}
