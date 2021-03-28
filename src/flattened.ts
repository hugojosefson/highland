import { Stream } from "./stream.ts";

/**
 * Returns the type of a flattened stream.
 *
 * Uses trick described in https://github.com/microsoft/TypeScript/pull/33050#issuecomment-552218239
 * with string keys to support TS 2.8.
 * */
export type Flattened<R> = {
  value: R;
  stream: R extends Stream<infer U> ? Flattened<U> : never;
  array: R extends Array<infer U> ? Flattened<U> : never;
}[
  R extends Array<any> ? "array"
    : R extends Stream<any> ? "stream"
    : "value"
];
