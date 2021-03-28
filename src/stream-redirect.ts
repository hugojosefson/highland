import { Stream } from "./stream.ts";

/**
 * Used as a Redirect marker when writing to a Stream's incoming buffer
 */
export class StreamRedirect<R> {
  __HighlandStreamRedirect__ = true;
  to: Stream<R>;

  constructor(to: Stream<R>) {
    this.to = to;
  }
}
