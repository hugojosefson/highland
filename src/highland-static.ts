/**
 * Highland: the high-level streams library
 *
 * Highland may be freely distributed under the Apache 2.0 license.
 * https://github.com/caolan/highland
 * Copyright (c) Caolan McMahon
 *
 */
import { EventEmitter } from "https://deno.land/std@0.91.0/node/events.ts";
import { MappingHint, Nil } from "./interfaces.ts";
import { Stream } from "./stream.ts";

export interface HighlandStatic {
  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  // UTILS
  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

  /**
     * Returns true if `x` is the end of stream marker.
     *
     * @id isNil
     * @section Streams
     * @name isNil(x)
     * @param x - the object to test
     * @api public
     */
  isNil<R>(x: R | Nil): x is Nil;

  /**
     * Returns true if `x` is a Highland Stream.
     *
     * @id isStream
     * @section Streams
     * @name _.isStream(x)
     * @param x - the object to test
     * @api public
     */
  isStream(x: any): x is Stream<any>;

  isStreamError(x: any): x is Stream<any>;

  isStreamRedirect(x: any): x is Stream<any>;

  /**
     * Logs values to the console, a simple wrapper around `console.log` that
     * it suitable for passing to other functions by reference without having to
     * call `bind`.
     *
     * @id log
     * @section Utils
     * @name _.log(args..)
     * @api public
     */
  log(x: any, ...args: any[]): void;

  /**
     * The end of stream marker. This is sent along the data channel of a Stream
     * to tell consumers that the Stream has ended. See the following map code for
     * an example of detecting the end of a Stream:
     *
     * @id nil
     * @section Streams
     * @name _.nil
     * @api public
     */
  nil: Nil;

  /**
     * Wraps a node-style async function which accepts a callback, transforming
     * it to a function which accepts the same arguments minus the callback and
     * returns a Highland Stream instead. The wrapped function keeps its context,
     * so you can safely use it as a method without binding (see the second
     * example below).
     *
     * wrapCallback also accepts an optional mappingHint, which specifies how
     * callback arguments are pushed to the stream. This can be used to handle
     * non-standard callback protocols that pass back more than one value.
     *
     * mappingHint can be a function, number, or array. See the documentation on
     * EventEmitter Stream Objects for details on the mapping hint. If
     * mappingHint is a function, it will be called with all but the first
     * argument that is passed to the callback. The first is still assumed to be
     * the error argument.
     *
     * @id wrapCallback
     * @section Utils
     * @name _.wrapCallback(f)
     * @param {Function} f - the node-style function to wrap
     * @param {Array | Function | Number} [mappingHint] - how to pass the arguments to the callback
     * @api public
     */
  wrapCallback(
    f: Function,
    mappingHint?: MappingHint,
  ): (...args: any[]) => Stream<any>;

  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  // OBJECTS
  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

  /**
     * Extends one object with the properties of another. **Note:** The
     * arguments are in the reverse order of other libraries such as
     * underscore. This is so it follows the convention of other functions in
     * this library and so you can more meaningfully partially apply it.
     *
     * @id extend
     * @section Objects
     * @name _.extend(a, b)
     * @param {Object} a - the properties to extend b with
     * @param {Object} b - the original object to extend
     * @api public
     */
  extend(extensions: Object, target: Object): Object;

  extend(target: Object): (extensions: Object) => Object;

  /**
     * Returns a property from an object.
     *
     * @id get
     * @section Objects
     * @name _.get(prop, obj)
     * @param {String} prop - the property to return
     * @param {Object} obj - the object to read properties from
     * @api public
     */
  get(prop: string, obj: Object): string;

  get(prop: string): (obj: Object) => Object;

  /**
     * Returns keys from an Object as a Stream.
     *
     * @id keys
     * @section Objects
     * @name _.keys(obj)
     * @param {Object} obj - the object to return keys from
     * @api public
     */
  keys(obj: Object): Stream<string>;

  /**
     * Returns key/value pairs for an Object as a Stream. Reads properties
     * lazily, so if you don't read from all keys on an object, not
     * all properties will be read from (may have an effect where getters
     * are used).
     *
     * @id pairs
     * @section Objects
     * @name _.pairs(obj)
     * @param {Object} obj - the object to return key/value pairs from
     * @api public
     */
  pairs(obj: Object): Stream<any[]>;

  pairs(obj: any[]): Stream<any[]>;

  /**
     * Updates a property on an object, returning the updated object.
     *
     * @id set
     * @section Objects
     * @name _.set(prop, value, obj)
     * @param {String} prop - the property to return
     * @param value - the value to set the property to
     * @param {Object} obj - the object to set properties on
     * @api public
     */
  set(prop: string, val: any, obj: Object): Object;

  set(prop: string, val: any): (obj: Object) => Object;

  /**
     * Returns values from an Object as a Stream. Reads properties
     * lazily, so if you don't read from all keys on an object, not
     * all properties will be read from (may have an effect where getters
     * are used).
     *
     * @id values
     * @section Objects
     * @name _.values(obj)
     * @param {Object} obj - the object to return values from
     * @api public
     */
  values(obj: Object): Stream<any>;

  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  // FUNCTIONS
  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

  /**
     * Creates a composite function, which is the application of function1 to
     * the results of function2. You can pass an arbitrary number of arguments
     * and have them composed. This means you can't partially apply the compose
     * function itself.
     *
     * @id compose
     * @name compose(fn1, fn2, ...)
     * @section Functions
     * @api public
     */
  compose(...functions: Function[]): Function;

  /**
     * Transforms a function with specific arity (all arguments must be
     * defined) in a way that it can be called as a chain of functions until
     * the arguments list is saturated.
     *
     * This function is not itself curryable.
     *
     * @id curry
     * @name curry(fn, [*arguments])
     * @section Functions
     * @param {Function} fn - the function to curry
     * @param args.. - any number of arguments to pre-apply to the function
     * @returns Function
     * @api public
     */
  curry(fn: Function, ...args: any[]): Function;

  /**
     * Evaluates the function `fn` with the argument positions swapped. Only
     * works with functions that accept two arguments.
     *
     * @id flip
     * @name flip(fn, [x, y])
     * @section Functions
     * @param {Function} f - function to flip argument application for
     * @param x - parameter to apply to the right hand side of f
     * @param y - parameter to apply to the left hand side of f
     * @api public
     */
  flip(fn: Function, ...args: any[]): Function;

  /**
     * Same as `curry` but with a specific number of arguments. This can be
     * useful when functions do not explicitly define all its parameters.
     *
     * This function is not itself curryable.
     *
     * @id ncurry
     * @name ncurry(n, fn, [args...])
     * @section Functions
     * @param {Number} n - the number of arguments to wait for before apply fn
     * @param {Function} fn - the function to curry
     * @param args... - any number of arguments to pre-apply to the function
     * @returns Function
     * @api public
     */
  ncurry(n: number, fn: Function, ...args: any[]): Function;

  /**
     * Partially applies the function (regardless of whether it has had curry
     * called on it). This will always postpone execution until at least the next
     * call of the partially applied function.
     *
     * @id partial
     * @name partial(fn, args...)
     * @section Functions
     * @param {Function} fn - function to partial apply
     * @param args... - the arguments to apply to the function
     * @api public
     */
  partial(fn: Function, ...args: any[]): Function;

  /**
     * The reversed version of compose. Where arguments are in the order of
     * application.
     *
     * @id seq
     * @name seq(fn1, fn2, ...)
     * @section Functions
     * @api public
     */
  seq(...functions: Function[]): Function;

  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -
  // OPERATORS
  // - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - - -

  /**
     * Add two values. Can be partially applied.
     *
     * @id add
     * @section Operators
     * @name _.add(a, b)
     * @api public
     */
  add(a: number, b: number): number;

  add(a: number): (b: number) => number;

  /**
     * Perform logical negation on a value. If `x` is truthy then returns false,
     * otherwise returns true.
     *
     * @id not
     * @section Operators
     * @name _.not(x)
     * @param x - the value to negate
     * @api public
     *
     * _.not(true)   // => false
     * _.not(false)  // => true
     */
  not<R>(x: any): boolean;
}
