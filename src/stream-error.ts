/**
 * Used as an Error marker when writing to a Stream's incoming buffer
 */
export class StreamError {
  __HighlandStreamError__ = true;
  error: Error;

  constructor(err: Error) {
    this.error = err;
  }
}
