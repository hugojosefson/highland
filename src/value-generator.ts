import { Stream } from "./stream.ts";

export type ValueGenerator<R> = (
  push: ValueGeneratorPush<R>,
  next: ValueGeneratorNext<R>,
) => void;

export type ValueGeneratorPush<R> = <R>(
  err: (Error | null | undefined),
  x?: R,
) => void;

export type ValueGeneratorNext<R> = <R>(s?: Stream<R>) => void;
