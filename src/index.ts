/**
 * Highland: the high-level streams library
 *
 * Highland may be freely distributed under the Apache 2.0 license.
 * http://github.com/caolan/highland
 * Copyright (c) Caolan McMahon
 *
 */

import {
  compose as seq,
  composeRight as compose,
} from "https://deno.land/x/compose@1.3.2/index.js";
import { Nil, nil } from "./interfaces.ts";
import { Stream, ValueGenerator } from "./stream.ts";

/**
 * Returns true if `x` is the end of stream marker.
 *
 * @id isNil
 * @section Utils
 * @name isNil(x)
 * @param x - the object to test
 * @api public
 */
export const isNil = (x: any): x is Nil => x === nil;

export const isObject = <K extends string | number | symbol, V>(
  x: any,
): x is Record<K, V> => typeof x === "object" && x !== null;

export const isUndefined = (x: any): x is undefined => typeof x === "undefined";

export const isFunction = (x: any): x is Function => typeof x === "function";

/** Not accurate, but to coerce TypeScript into believing us. */
export const isValueGeneratorFunction = <R>(x: any): x is ValueGenerator<R> =>
  isFunction(x) && x.length === 2;

/**
 * Returns true if `x` is a Highland Stream.
 *
 * @id isStream
 * @section Utils
 * @name _.isStream(x)
 * @param x - the object to test
 * @returns {Boolean}
 * @api public
 *
 * _.isStream('foo')  // => false
 * _.isStream(_([1,2,3]))  // => true
 */
export const isStream = (x: any): x is Stream<any> =>
  isObject(x) && !!x.__HighlandStream__;

const _ = <R>(xs?: Stream<R> | Array<R>): Stream<R> =>
  isStream(xs) ? xs : new Stream(xs);

Object.assign(_, {
  compose,
  seq,
  isNil,
});
export default _;
