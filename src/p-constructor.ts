/**
 * Describes a constructor for a particular promise library
 */
export interface PConstructor<T, P extends PromiseLike<T>> {
  new (
    executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: any) => void,
    ) => void,
  ): P;
}
