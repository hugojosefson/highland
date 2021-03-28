import { Nil } from "./interfaces.ts";
import { StreamError } from "./stream-error.ts";

export interface Consumer<R> {
  write(x: StreamError | R | Nil | undefined): void;
}
