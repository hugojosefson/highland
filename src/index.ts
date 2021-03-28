/**
 * Highland: the high-level streams library
 *
 * Highland may be freely distributed under the Apache 2.0 license.
 * http://github.com/caolan/highland
 * Copyright (c) Caolan McMahon
 *
 */

import deprecate from "https://cdn.skypack.dev/util-deprecate";
import Decoder from "https://deno.land/std@0.91.0/node/string_decoder.ts";
import {
  compose as seq,
  composeRight as compose,
} from "https://deno.land/x/compose@1.3.2/index.js";
import { HighlandStatic } from "./highland-static.ts";
import hintMapper from "./hint-mapper.ts";
import { Nil, nil } from "./interfaces.ts";
import { StreamError } from "./stream-error.ts";
import { StreamFactories } from "./stream-factories.ts";
import { StreamImpl } from "./stream-impl.ts";
import { StreamRedirect } from "./stream-redirect.ts";
import { Stream } from "./stream.ts";
import { ValueGenerator } from "./value-generator.ts";

type Underscore<R> =
  & HighlandStatic
  & StreamFactories<R>;

export const _: Underscore<R> = Object.assign(<R>(
  xs?: Stream<R> | Array<R>,
  secondArg?: any,
  mappingHint?: any,
): Stream<R> => {
  if (isStream(xs)) {
    // already a Stream
    return xs;
  }
  return new StreamImpl(xs, secondArg, mappingHint);
}, {
  isUndefined,
  isFunction,
  isValueGeneratorFunction,
  isIterator,
  isIterable,
  isReadableStream,
  isPromise,
  isObject,
  isString,
  curry,
  ncurry,
  partial,
  flip,
  compose,
  seq,
  isNil,
  isStream,
  isStreamError,
  isStreamRedirect,
});

export default _;

// Create quick slice reference variable for speed
const slice = Array.prototype.slice;
const hasOwn = Object.prototype.hasOwnProperty;

export const isUndefined = (x: any): x is undefined => typeof x === "undefined";

export const isFunction = (x: any): x is Function => typeof x === "function";

/** Not accurate, but to coerce TypeScript into believing us. */
export const isValueGeneratorFunction = <R>(x: any): x is ValueGenerator<R> =>
  isFunction(x) && x.length === 2;

/** Not accurate, but to coerce TypeScript into believing us. */
export const isIterator = <R>(x: any): x is Iterator<R> => isFunction(x?.next);

/** Not accurate, but to coerce TypeScript into believing us. */
export const isIterable = <R>(x: any): x is Iterable<R> =>
  Symbol.iterator in x && isIterator(x[Symbol.iterator]);

/** Not accurate, but to coerce TypeScript into believing us. */
export const isReadableStream = <R>(x: any): x is ReadableStream<R> =>
  isFunction(x?.on) && isFunction(x?.pipe);

export const isPromise = <T>(x: any): x is Promise<T> => isFunction(x?.then);

export const isObject = <K extends string | number | symbol, V>(
  x: any,
): x is Record<K, V> => typeof x === "object" && x !== null;

export const isString = (x: any): x is string => typeof x === "string";

/**
 * Transforms a function with specific arity (all arguments must be
 * defined) in a way that it can be called as a chain of functions until
 * the arguments list is saturated.
 *
 * This function is not itself curryable.
 *
 * @id curry
 * @name _.curry(fn, [*arguments])
 * @section Functions
 * @param {Function} fn - the function to curry
 * @param args.. - any number of arguments to pre-apply to the function
 * @returns Function
 * @api public
 *
 * fn = curry(function (a, b, c) {
 *     return a + b + c;
 * });
 *
 * fn(1)(2)(3) == fn(1, 2, 3)
 * fn(1, 2)(3) == fn(1, 2, 3)
 * fn(1)(2, 3) == fn(1, 2, 3)
 */
export const curry = (fn: Function, ...args: Array<unknown>) =>
  ncurry(fn.length, fn, ...args);

/**
 * Same as `curry` but with a specific number of arguments. This can be
 * useful when functions do not explicitly define all its parameters.
 *
 * This function is not itself curryable.
 *
 * @id ncurry
 * @name _.ncurry(n, fn, [args...])
 * @section Functions
 * @param {Number} n - the number of arguments to wait for before apply fn
 * @param {Function} fn - the function to curry
 * @param args... - any number of arguments to pre-apply to the function
 * @returns Function
 * @api public
 *
 * fn = ncurry(3, function () {
 *     return Array.prototype.join.call(arguments, '.');
 * });
 *
 * fn(1, 2, 3) == '1.2.3';
 * fn(1, 2)(3) == '1.2.3';
 * fn(1)(2)(3) == '1.2.3';
 */
export const ncurry = (n: number, fn: Function, ...args: Array<unknown>) => {
  if (args.length >= n) {
    return fn(...args.slice(0, n));
  }

  return partial(ncurry, n, fn, ...args);
};

/**
 * Partially applies the function (regardless of whether it has had curry
 * called on it). This will always postpone execution until at least the next
 * call of the partially applied function.
 *
 * @id partial
 * @name _.partial(fn, args...)
 * @section Functions
 * @param {Function} fn - function to partial apply
 * @param args... - the arguments to apply to the function
 * @api public
 *
 * var addAll = function () {
 *     var args = Array.prototype.slice.call(arguments);
 *     return foldl1(add, args);
 * };
 * var f = partial(addAll, 1, 2);
 * f(3, 4) == 10
 */
export const partial = (fn: Function, ...args: Array<unknown>) =>
  (...moreArgs: Array<unknown>) => fn(...args, ...moreArgs);

/**
 * Evaluates the function `fn` with the argument positions swapped. Only
 * works with functions that accept two arguments.
 *
 * @id flip
 * @name _.flip(fn, [x, y])
 * @section Functions
 * @param {Function} fn - function to flip argument application for
 * @param x - parameter to apply to the right hand side of f
 * @param y - parameter to apply to the left hand side of f
 * @api public
 *
 * div(2, 4) == 0.5
 * flip(div, 2, 4) == 2
 * flip(div)(2, 4) == 2
 */
export const flip = <X, Y, T>(x: X, y: Y): (y: Y, x: X) => T =>
  curry((fn: Function, x: X, y: Y) => fn(y, x));

/**
 * Creates a composite function, which is the application of function1 to
 * the results of function2. You can pass an arbitrary number of arguments
 * and have them composed. This means you can't partially apply the compose
 * function itself.
 *
 * @id compose
 * @name _.compose(fn1, fn2, ...)
 * @section Functions
 * @api public
 *
 * var add1 = add(1);
 * var mul3 = mul(3);
 *
 * var add1mul3 = compose(mul3, add1);
 * add1mul3(2) == 9
 */
export { compose };

/**
 * The reversed version of [compose](#compose). Where arguments are in the
 * order of application.
 *
 * @id seq
 * @name _.seq(fn1, fn2, ...)
 * @section Functions
 * @api public
 *
 * var add1 = add(1);
 * var mul3 = mul(3);
 *
 * var add1mul3 = seq(add1, mul3);
 * add1mul3(2) == 9
 */
export { seq };

// /**
//  * adds a top-level _.foo(mystream) style export for Stream methods
//  */
// function exposeMethod(name) {
//   var f = Stream.prototype[name];
//   var n = f.length;
//   _[name] = _.ncurry(n + 1, function () {
//     var args = slice.call(arguments);
//     var s = _(args.pop());
//     return f.apply(s, args);
//   });
// }

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

export const isStreamError = (x: any): x is Stream<any> & StreamError =>
  isObject(x) && !!x.__HighlandStreamError__;

export const isStreamRedirect = (
  x: any,
): x is Stream<any> & StreamRedirect<any> =>
  isObject(x) && !!x.__HighlandStreamRedirect__;

/** Hack our way around the fact that util.deprecate is all-or-nothing for a function. */
const warnMapWithValue = deprecate(
  () => {},
  "Highland: Calling Stream.map() with a non-function argument is deprecated.",
);

/** Hack our way around the fact that util.deprecate is all-or-nothing for a function. */
const warnForkAfterConsume = deprecate(
  () => {},
  "Highland: Calling Stream.fork() on a stream that has already been consumed is deprecated. Always call fork() on a stream that is meant to be forked.",
);

/**
 * The inverse of [filter](#filter).
 *
 * @id reject
 * @section Transforms
 * @name Stream.reject(f)
 * @param {Function} f - the truth test function
 * @api public
 *
 * var odds = _([1, 2, 3, 4]).reject(function (x) {
 *     return x % 2 === 0;
 * });
 */

Stream.prototype.reject = function (f) {
  return this.filter(_.compose(_.not, f));
};

/**
 * A convenient form of [filter](#filter), which returns the first object from a
 * Stream that passes the provided truth test.
 *
 * @id find
 * @section Transforms
 * @name Stream.find(f)
 * @param {Function} f - the truth test function which returns a Stream
 * @api public
 *
 * var docs = [
 *     {type: 'blogpost', title: 'foo'},
 *     {type: 'blogpost', title: 'bar'},
 *     {type: 'comment', title: 'foo'}
 * ];
 *
 * var f = function (x) {
 *     return x.type == 'blogpost';
 * };
 *
 * _(docs).find(f);
 * // => {type: 'blogpost', title: 'foo'}
 *
 * // example with partial application
 * var firstBlogpost = _.find(f);
 *
 * firstBlogpost(docs)
 * // => {type: 'blogpost', title: 'foo'}
 */

Stream.prototype.find = function (f) {
  return this.filter(f).take(1);
};

/**
 * A convenient form of [where](#where), which returns the first object from a
 * Stream that matches a set of property values. findWhere is to [where](#where) as [find](#find) is to [filter](#filter).
 *
 * @id findWhere
 * @section Transforms
 * @name Stream.findWhere(props)
 * @param {Object} props - the properties to match against
 * @api public
 *
 * var docs = [
 *     {type: 'blogpost', title: 'foo'},
 *     {type: 'blogpost', title: 'bar'},
 *     {type: 'comment', title: 'foo'}
 * ];
 *
 * _(docs).findWhere({type: 'blogpost'})
 * // => {type: 'blogpost', title: 'foo'}
 *
 * // example with partial application
 * var firstBlogpost = _.findWhere({type: 'blogpost'});
 *
 * firstBlogpost(docs)
 * // => {type: 'blogpost', title: 'foo'}
 */

Stream.prototype.findWhere = function (props) {
  return this.where(props).take(1);
};

/**
 * A convenient form of [reduce](#reduce), which groups items based on a function or property name
 *
 * @id group
 * @section Transforms
 * @name Stream.group(f)
 * @param {Function | String} f - the function or property name on which to group,
 *                              toString() is called on the result of a function.
 * @api public
 *
 * var docs = [
 *     {type: 'blogpost', title: 'foo'},
 *     {type: 'blogpost', title: 'bar'},
 *     {type: 'comment', title: 'foo'}
 * ];
 *
 * var f = function (x) {
 *     return x.type;
 * };
 *
 * _(docs).group(f); OR _(docs).group('type');
 * // => {
 * // =>    'blogpost': [{type: 'blogpost', title: 'foo'}, {type: 'blogpost', title: 'bar'}]
 * // =>    'comment': [{type: 'comment', title: 'foo'}]
 * // =>  }
 *
 */

Stream.prototype.group = function (f) {
  var lambda = isString(f) ? _.get(f) : f;
  return this.reduce({}, function (m, o) {
    var key = lambda(o);
    if (!hasOwn.call(m, key)) m[key] = [];
    m[key].push(o);
    return m;
  });
};

/**
 * Filters a Stream to drop all non-truthy values.
 *
 * @id compact
 * @section Transforms
 * @name Stream.compact()
 * @api public
 *
 * var compacted = _([0, 1, false, 3, null, undefined, 6]).compact();
 * // => 1, 3, 6
 */

Stream.prototype.compact = function () {
  return this.filter(function (x) {
    return x;
  });
};

/**
 * A convenient form of [filter](#filter), which returns all objects from a Stream
 * which match a set of property values.
 *
 * @id where
 * @section Transforms
 * @name Stream.where(props)
 * @param {Object} props - the properties to match against
 * @api public
 *
 * var docs = [
 *     {type: 'blogpost', title: 'foo'},
 *     {type: 'blogpost', title: 'bar'},
 *     {type: 'comment', title: 'foo'}
 * ];
 *
 * _(docs).where({title: 'foo'})
 * // => {type: 'blogpost', title: 'foo'}
 * // => {type: 'comment', title: 'foo'}
 *
 * // example with partial application
 * var getBlogposts = _.where({type: 'blogpost'});
 *
 * getBlogposts(docs)
 * // => {type: 'blogpost', title: 'foo'}
 * // => {type: 'blogpost', title: 'bar'}
 */

Stream.prototype.where = function (props) {
  return this.filter(function (x) {
    for (var k in props) {
      if (x[k] !== props[k]) {
        return false;
      }
    }
    return true;
  });
};

/**
 * Filters out all duplicate values from the stream and keeps only the first
 * occurence of each value, using the provided function to define equality.
 *
 * Note:
 *
 * - Memory: In order to guarantee that each unique item is chosen only once,
 *   we need to keep an internal buffer of all unique values. This may outgrow
 *   the available memory if you are not cautious about the size of your stream
 *   and the number of unique objects you may receive on it.
 * - Errors: The comparison function should never throw an error. However, if
 *   it does, this transform will emit an error for each all that throws. This
 *   means that one value may turn into multiple errors.
 *
 * @id uniqBy
 * @section Transforms
 * @name Stream.uniqBy(compare)
 * @param {Function} compare - custom equality predicate
 * @api public
 *
 * var colors = [ 'blue', 'red', 'red', 'yellow', 'blue', 'red' ]
 *
 * _(colors).uniqBy(function(a, b) { return a[1] === b[1]; })
 * // => 'blue'
 * // => 'red'
 *
 */

Stream.prototype.uniqBy = function (compare) {
  var uniques = [];
  return this.consume(function (err, x, push, next) {
    if (err) {
      push(err);
      next();
    } else if (x === nil) {
      push(err, x);
    } else {
      var seen = false;
      var hasErr;
      for (var i = 0, len = uniques.length; i < len; i++) {
        try {
          seen = compare(x, uniques[i]);
        } catch (e) {
          hasErr = e;
          seen = true;
        }
        if (seen) {
          break;
        }
      }
      if (!seen) {
        uniques.push(x);
        push(null, x);
      }
      if (hasErr) {
        push(hasErr);
      }
      next();
    }
  });
};

/**
 * Filters out all duplicate values from the stream and keeps only the first
 * occurence of each value, using `===` to define equality.
 *
 * Like [uniqBy](#uniqBy), this transform needs to store a buffer containing
 * all unique values that has been encountered. Be careful about using this
 * transform on a stream that has many unique values.
 *
 * @id uniq
 * @section Transforms
 * @name Stream.uniq()
 * @api public
 *
 * var colors = [ 'blue', 'red', 'red', 'yellow', 'blue', 'red' ]
 *
 * _(colors).uniq()
 * // => 'blue'
 * // => 'red'
 * // => 'yellow'
 */

Stream.prototype.uniq = function () {
  if (!isUndefined(_global.Set)) {
    var uniques = new _global.Set(),
      size = uniques.size;

    return this.consume(function (err, x, push, next) {
      if (err) {
        push(err);
        next();
      } else if (x === nil) {
        push(err, x);
      } // pass NaN through as Set does not respect strict
      // equality in this case.
      else if (x !== x) {
        push(null, x);
        next();
      } else {
        uniques.add(x);
        if (uniques.size > size) {
          size = uniques.size;
          push(null, x);
        }
        next();
      }
    });
  }
  return this.uniqBy(function (a, b) {
    return a === b;
  });
};

/**
 * Takes a *finite* stream of streams and returns a stream where the first
 * element from each separate stream is combined into a single data event,
 * followed by the second elements of each stream and so on until the shortest
 * input stream is exhausted.
 *
 * *Note:* This transform will be renamed `zipAll` in the next major version
 * release.
 *
 * @id zipAll0
 * @section Higher-order Streams
 * @name Stream.zipAll0()
 * @api public
 *
 * _([
 *     _([1, 2, 3]),
 *     _([4, 5, 6]),
 *     _([7, 8, 9]),
 *     _([10, 11, 12])
 * ]).zipAll0()
 * // => [1, 4, 7, 10], [2, 5, 8, 11], [3, 6, 9, 12]
 *
 * // shortest stream determines length of output stream
 * _([
 *     _([1, 2, 3, 4]),
 *     _([5, 6, 7, 8]),
 *     _([9, 10, 11, 12]),
 *     _([13, 14])
 * ]).zipAll0()
 * // => [1, 5, 9, 13], [2, 6, 10, 14]
 */

Stream.prototype.zipAll0 = function () {
  var returned = 0;
  var z = [];
  var finished = false;

  function nextValue(index, max, src, push, next) {
    src.pull(function (err, x) {
      if (err) {
        push(err);
        nextValue(index, max, src, push, next);
      } else if (x === nil) {
        if (!finished) {
          finished = true;
          push(null, nil);
        }
      } else {
        returned++;
        z[index] = x;
        if (returned === max) {
          push(null, z);
          next();
        }
      }
    });
  }

  return this.collect().flatMap(function (array) {
    if (!array.length) {
      return _([]);
    }

    return _(function (push, next) {
      returned = 0;
      z = [];
      for (var i = 0, length = array.length; i < length; i++) {
        nextValue(i, length, array[i], push, next);
      }
    });
  });
};

/**
 * Takes a stream and a *finite* stream of `N` streams
 * and returns a stream of the corresponding `(N+1)`-tuples.
 *
 * *Note:* This transform will be renamed `zipEach` in the next major version
 * release.
 *
 * @id zipAll
 * @section Higher-order Streams
 * @name Stream.zipAll(ys)
 * @param {Array | Stream} ys - the array of streams to combine values with
 * @api public
 *
 * _([1,2,3]).zipAll([[4, 5, 6], [7, 8, 9], [10, 11, 12]])
 * // => [1, 4, 7, 10], [2, 5, 8, 11], [3, 6, 9, 12]
 *
 * // shortest stream determines length of output stream
 * _([1, 2, 3, 4]).zipAll([[5, 6, 7, 8], [9, 10, 11, 12], [13, 14]])
 * // => [1, 5, 9, 13], [2, 6, 10, 14]
 */

Stream.prototype.zipAll = function (ys) {
  return _([this]).concat(_(ys).map(_)).zipAll0();
};

/**
 * Takes two Streams and returns a Stream of corresponding pairs. The size of
 * the resulting stream is the smaller of the two source streams.
 *
 * @id zip
 * @section Higher-order Streams
 * @name Stream.zip(ys)
 * @param {Array | Stream} ys - the other stream to combine values with
 * @api public
 *
 * _(['a', 'b', 'c']).zip([1, 2, 3])  // => ['a', 1], ['b', 2], ['c', 3]
 *
 * _(['a', 'b', 'c']).zip(_([1]))  // => ['a', 1]
 */

Stream.prototype.zip = function (ys) {
  return _([this, _(ys)]).zipAll0();
};

/**
 * Takes one Stream and batches incoming data into arrays of given length
 *
 * @id batch
 * @section Transforms
 * @name Stream.batch(n)
 * @param {Number} n - length of the array to batch
 * @api public
 *
 * _([1, 2, 3, 4, 5]).batch(2)  // => [1, 2], [3, 4], [5]
 */

Stream.prototype.batch = function (n) {
  return this.batchWithTimeOrCount(-1, n);
};

/**
 * Takes one Stream and batches incoming data within a maximum time frame
 * into arrays of a maximum length.
 *
 * @id batchWithTimeOrCount
 * @section Transforms
 * @name Stream.batchWithTimeOrCount(ms, n)
 * @param {Number} ms - the maximum milliseconds to buffer a batch
 * @param {Number} n - the maximum length of the array to batch
 * @api public
 *
 * _(function (push) {
 *     push(1);
 *     push(2);
 *     push(3);
 *     setTimeout(push, 20, 4);
 * }).batchWithTimeOrCount(10, 2)
 *
 * // => [1, 2], [3], [4]
 */

Stream.prototype.batchWithTimeOrCount = function (ms, n) {
  var batched = [],
    timeout;

  return this.consume(function (err, x, push, next) {
    if (err) {
      push(err);
      next();
    } else if (x === nil) {
      if (batched.length > 0) {
        push(null, batched);
        clearTimeout(timeout);
      }

      push(null, nil);
    } else {
      batched.push(x);

      if (batched.length === n) {
        push(null, batched);
        batched = [];
        clearTimeout(timeout);
      } else if (batched.length === 1 && ms >= 0) {
        timeout = setTimeout(function () {
          push(null, batched);
          batched = [];
        }, ms);
      }

      next();
    }
  });
};

/**
 * Creates a new Stream with the separator interspersed between the elements of the source.
 *
 * `intersperse` is effectively the inverse of [splitBy](#splitBy).
 *
 * @id intersperse
 * @section Transforms
 * @name Stream.intersperse(sep)
 * @param {String} sep - the value to intersperse between the source elements
 * @api public
 *
 * _(['ba', 'a', 'a']).intersperse('n')  // => 'ba', 'n', 'a', 'n', 'a'
 * _(['mississippi']).splitBy('ss').intersperse('ss')  // => 'mi', 'ss', 'i', 'ss', 'ippi'
 * _(['foo']).intersperse('bar')  // => 'foo'
 */

Stream.prototype.intersperse = function (separator) {
  var started = false;
  return this.consume(function (err, x, push, next) {
    if (err) {
      push(err);
      next();
    } else if (x === nil) {
      push(null, nil);
    } else {
      if (started) {
        push(null, separator);
      } else {
        started = true;
      }
      push(null, x);
      next();
    }
  });
};

/**
 * Splits the source Stream by a separator and emits the pieces in between, much like splitting a string.
 *
 * `splitBy` is effectively the inverse of [intersperse](#intersperse).
 *
 * @id splitBy
 * @section Transforms
 * @name Stream.splitBy(sep)
 * @param {String | RegExp} sep - the separator to split on
 * @api public
 *
 * _(['mis', 'si', 's', 'sippi']).splitBy('ss')  // => 'mi', 'i', 'ippi'
 * _(['ba', 'a', 'a']).intersperse('n').splitBy('n')  // => 'ba', 'a', 'a'
 * _(['foo']).splitBy('bar')  // => 'foo'
 */

Stream.prototype.splitBy = function (sep) {
  var decoder = new Decoder();
  var buffer = false;

  function drain(x, push) {
    buffer = (buffer || "") + decoder.write(x);
    var pieces = buffer.split(sep);
    buffer = pieces.pop();

    pieces.forEach(function (piece) {
      push(null, piece);
    });
  }

  return this.consume(function (err, x, push, next) {
    if (err) {
      push(err);
      next();
    } else if (x === nil) {
      if (isString(buffer)) {
        drain(decoder.end(), push);
        push(null, buffer);
      }
      push(null, nil);
    } else {
      drain(x, push);
      next();
    }
  });
};

/**
 * [splitBy](#splitBy) over newlines.
 *
 * @id split
 * @section Transforms
 * @name Stream.split()
 * @api public
 *
 * _(['a\n', 'b\nc\n', 'd', '\ne']).split()  // => 'a', 'b', 'c', 'd', 'e'
 * _(['a\r\nb\nc']]).split()  // => 'a', 'b', 'c'
 */

Stream.prototype.split = function () {
  return this.splitBy(/\r?\n/);
};

/**
 * Creates a new Stream with the values from the source in the range of `start` (inclusive) to `end` (exclusive).
 * `start` and `end` must be of type `Number`, if `start` is not a `Number` it will default to `0`
 * and, likewise, `end` will default to `Infinity`: this could result in the whole stream being be
 * returned.
 *
 * @id slice
 * @section Transforms
 * @name Stream.slice(start, end)
 * @param {Number} start - integer representing index to start reading from source (inclusive)
 * @param {Number} stop - integer representing index to stop reading from source (exclusive)
 * @api public
 *
 * _([1, 2, 3, 4]).slice(1, 3) // => 2, 3
 */

Stream.prototype.slice = function (start, end) {
  var index = 0;
  start = typeof start != "number" || start < 0 ? 0 : start;
  end = typeof end != "number" ? Infinity : end;

  if (start === 0 && end === Infinity) {
    return this;
  } else if (start >= end) {
    return _([]);
  }
  var s = this.consume(function (err, x, push, next) {
    var done = x === nil;
    if (err) {
      push(err);
    } else if (!done && index++ >= start) {
      push(null, x);
    }

    if (!done && index < end) {
      next();
    } else {
      push(null, nil);
    }
  });
  s.id = "slice:" + s.id;
  return s;
};

/**
 * Creates a new Stream with the first `n` values from the source. `n` must be of type `Number`,
 * if not the whole stream will be returned.
 *
 * @id take
 * @section Transforms
 * @name Stream.take(n)
 * @param {Number} n - integer representing number of values to read from source
 * @api public
 *
 * _([1, 2, 3, 4]).take(2) // => 1, 2
 */

Stream.prototype.take = function (n) {
  var s = this.slice(0, n);
  s.id = "take:" + s.id;
  return s;
};

/**
 * Acts as the inverse of [`take(n)`](#take) - instead of returning the first `n` values, it ignores the
 * first `n` values and then emits the rest. `n` must be of type `Number`, if not the whole stream will
 * be returned. All errors (even ones emitted before the nth value) will be emitted.
 *
 * @id drop
 * @section Transforms
 * @name Stream.drop(n)
 * @param {Number} n - integer representing number of values to read from source
 * @api public
 *
 * _([1, 2, 3, 4]).drop(2) // => 3, 4
 */

Stream.prototype.drop = function (n) {
  return this.slice(n, Infinity);
};

/**
 * Creates a new Stream with only the first value from the source.
 *
 * @id head
 * @section Transforms
 * @name Stream.head()
 * @api public
 *
 * _([1, 2, 3, 4]).head() // => 1
 */

Stream.prototype.head = function () {
  return this.take(1);
};

/**
 * Drops all values from the Stream apart from the last one (if any).
 *
 * @id last
 * @section Transforms
 * @name Stream.last()
 * @api public
 *
 * _([1, 2, 3, 4]).last()  // => 4
 */

Stream.prototype.last = function () {
  var nothing = {};
  var prev = nothing;
  return this.consume(function (err, x, push, next) {
    if (err) {
      push(err);
      next();
    } else if (x === nil) {
      if (prev !== nothing) {
        push(null, prev);
      }
      push(null, nil);
    } else {
      prev = x;
      next();
    }
  });
};

/**
 * Collects all values together then emits each value individually in sorted
 * order. The method for sorting the elements is defined by the comparator
 * function supplied as a parameter.
 *
 * The comparison function takes two arguments `a` and `b` and should return
 *
 * - a negative number if `a` should sort before `b`.
 * - a positive number if `a` should sort after `b`.
 * - zero if `a` and `b` may sort in any order (i.e., they are equal).
 *
 * This function must also define a [partial
 * order](https://en.wikipedia.org/wiki/Partially_ordered_set). If it does not,
 * the resulting ordering is undefined.
 *
 * @id sortBy
 * @section Transforms
 * @name Stream.sortBy(f)
 * @param {Function} f - the comparison function
 * @api public
 *
 * var sorts = _([3, 1, 4, 2]).sortBy(function (a, b) {
 *     return b - a;
 * }).toArray(_.log);
 *
 * //=> [4, 3, 2, 1]
 */

Stream.prototype.sortBy = function (f) {
  return this.collect().invoke("sort", [f]).sequence();
};

/**
 * Collects all values together then emits each value individually but in sorted order.
 * The method for sorting the elements is ascending lexical.
 *
 * @id sort
 * @section Transforms
 * @name Stream.sort()
 * @api public
 *
 * var sorted = _(['b', 'z', 'g', 'r']).sort().toArray(_.log);
 * // => ['b', 'g', 'r', 'z']
 */

Stream.prototype.sort = function () {
  return this.sortBy();
};

/**
 * Transforms a stream using an arbitrary target transform.
 *
 * If `target` is a function, this transform passes the current Stream to it,
 * returning the result.
 *
 * If `target` is a [Duplex
 * Stream](https://nodejs.org/api/stream.html#stream_class_stream_duplex_1),
 * this transform pipes the current Stream through it. It will always return a
 * Highland Stream (instead of the piped to target directly as in
 * [pipe](#pipe)). Any errors emitted will be propagated as Highland errors.
 *
 * **TIP**: Passing a function to `through` is a good way to implement complex
 * reusable stream transforms. You can even construct the function dynamically
 * based on certain inputs. See examples below.
 *
 * @id through
 * @section Higher-order Streams
 * @name Stream.through(target)
 * @param {Function | Duplex Stream} target - the stream to pipe through or a
 * function to call.
 * @api public
 *
 * // This is a static complex transform.
 * function oddDoubler(s) {
 *     return s.filter(function (x) {
 *         return x % 2; // odd numbers only
 *     })
 *     .map(function (x) {
 *         return x * 2;
 *     });
 * }
 *
 * // This is a dynamically-created complex transform.
 * function multiplyEvens(factor) {
 *     return function (s) {
 *         return s.filter(function (x) {
 *             return x % 2 === 0;
 *         })
 *         .map(function (x) {
 *             return x * factor;
 *         });
 *     };
 * }
 *
 * _([1, 2, 3, 4]).through(oddDoubler); // => 2, 6
 *
 * _([1, 2, 3, 4]).through(multiplyEvens(5)); // => 10, 20
 *
 * // Can also be used with Node Through Streams
 * _(filenames).through(jsonParser).map(function (obj) {
 *     // ...
 * });
 *
 * // All errors will be propagated as Highland errors
 * _(['zz{"a": 1}']).through(jsonParser).errors(function (err) {
 *   console.log(err); // => SyntaxError: Unexpected token z
 * });
 */

Stream.prototype.through = function (target) {
  var output;

  if (isFunction(target)) {
    return target(this);
  } else {
    output = _();
    this.on("error", writeErr);
    target.on("error", writeErr);

    // Intentionally bypass this.pipe so that through() and pipe() can
    // evolve independently of each other.
    return pipeStream(this, target, target.write, target.end, false)
      .pipe(output);
  }

  function writeErr(err) {
    output.write(new StreamError(err));
  }
};

/**
 * Creates a 'Through Stream', which passes data through a pipeline
 * of functions or other through Streams. This is particularly useful
 * when combined with partial application of Highland functions to expose a
 * Node-compatible Through Stream.
 *
 * This is not a method on a Stream, and it only exposed at the top-level
 * as `_.pipeline`. It takes an arbitrary number of arguments.
 *
 * @id pipeline
 * @section Higher-order Streams
 * @name _.pipeline(...)
 * @api public
 *
 * var through = _.pipeline(
 *     _.map(parseJSON),
 *     _.filter(isBlogpost),
 *     _.reduce(collectCategories)
 *     _.through(otherPipeline)
 * );
 *
 * readStream.pipe(through).pipe(outStream);
 *
 * // Alternatively, you can use pipeline to manipulate a stream in
 * // the chained method call style:
 *
 * var through2 = _.pipeline(function (s) {
 *     return s.map(parseJSON).filter(isBlogpost); // etc.
 * });
 */

_.pipeline = function (/*through...*/) {
  if (!arguments.length) {
    return _();
  }
  var start = arguments[0], rest, startHighland;
  if (!_.isStream(start) && !isFunction(start.resume)) {
    // not a Highland stream or Node stream, start with empty stream
    start = _();
    startHighland = start;
    rest = slice.call(arguments);
  } else {
    // got a stream as first argument, co-erce to Highland stream
    startHighland = _(start);
    rest = slice.call(arguments, 1);
  }

  var end = rest.reduce(function (src, dest) {
    return src.through(dest);
  }, startHighland);

  var wrapper = _(function (push, next) {
    end.pull(function (err, x) {
      push(err, x);
      if (x !== nil) {
        next();
      }
    });
  });

  wrapper.write = function (x) {
    return start.write(x);
  };

  wrapper.end = function () {
    return start.end();
  };

  start.on("drain", function () {
    wrapper.emit("drain");
  });

  return wrapper;
};

/**
 * Reads values from a Stream of Streams or Arrays, emitting them on a single
 * output Stream. This can be thought of as a [flatten](#flatten), just one
 * level deep, often used for resolving asynchronous actions such as a HTTP
 * request or reading a file.
 *
 * @id sequence
 * @section Higher-order Streams
 * @name Stream.sequence()
 * @api public
 *
 * var nums = _([
 *     _([1, 2, 3]),
 *     _([4, 5, 6])
 * ]);
 *
 * nums.sequence()  // => 1, 2, 3, 4, 5, 6
 *
 * // using sequence to read from files in series
 * var readFile = _.wrapCallback(fs.readFile);
 * filenames.map(readFile).sequence()
 */

Stream.prototype.sequence = function () {
  var original = this;
  var curr = this;
  return _(function (push, next) {
    curr.pull(function (err, x) {
      if (err) {
        push(err);
        next();
      } else if (_.isArray(x)) {
        if (onOriginalStream()) {
          // just send all values from array directly
          x.forEach(function (y) {
            push(null, y);
          });
        } else {
          push(null, x);
        }
        next();
      } else if (_.isStream(x)) {
        if (onOriginalStream()) {
          // switch to reading new stream
          curr = x;
          next();
        } else {
          // sequence only goes 1 level deep
          push(null, x);
          next();
        }
      } else if (x === nil) {
        if (onOriginalStream()) {
          push(null, nil);
        } else {
          // resume reading from original
          curr = original;
          next();
        }
      } else {
        if (onOriginalStream()) {
          // we shouldn't be getting non-stream (or array)
          // values from the top-level stream
          push(
            new Error(
              "Expected Stream, got " + (typeof x),
            ),
          );
          next();
        } else {
          push(null, x);
          next();
        }
      }
    });
  });

  function onOriginalStream() {
    return curr === original;
  }
};

/**
 * An alias for the [sequence](#sequence) method.
 *
 * @id series
 * @section Higher-order Streams
 * @name Stream.series()
 * @api public
 *
 * var readFile = _.wrapCallback(fs.readFile);
 * filenames.map(readFile).series()
 */

Stream.prototype.series = Stream.prototype.sequence;
_.series = _.sequence;

/**
 * Recursively reads values from a Stream which may contain nested Streams
 * or Arrays. As values or errors are encountered, they are emitted on a
 * single output Stream.
 *
 * @id flatten
 * @section Higher-order Streams
 * @name Stream.flatten()
 * @api public
 *
 * _([1, [2, 3], [[4]]]).flatten();  // => 1, 2, 3, 4
 *
 * var nums = _(
 *     _([1, 2, 3]),
 *     _([4, _([5, 6]) ])
 * );
 *
 * nums.flatten();  // => 1, 2, 3, 4, 5, 6
 */

Stream.prototype.flatten = function () {
  var curr = this;
  var stack = [];
  return _(function (push, next) {
    curr.pull(function (err, x) {
      if (err) {
        push(err);
        next();
        return;
      }
      if (_.isArray(x)) {
        x = _(x);
      }
      if (_.isStream(x)) {
        stack.push(curr);
        curr = x;
        next();
      } else if (x === nil) {
        if (stack.length) {
          curr = stack.pop();
          next();
        } else {
          push(null, nil);
        }
      } else {
        push(null, x);
        next();
      }
    });
  });
};

/**
 * Takes a Stream of Streams and reads from them in parallel, buffering
 * the results until they can be returned to the consumer in their original
 * order.
 *
 * @id parallel
 * @section Higher-order Streams
 * @name Stream.parallel(n)
 * @param {Number} n - the maximum number of concurrent reads/buffers
 * @api public
 *
 * var readFile = _.wrapCallback(fs.readFile);
 * var filenames = _(['foo.txt', 'bar.txt', 'baz.txt']);
 *
 * // read from up to 10 files at once
 * filenames.map(readFile).parallel(10);
 */

Stream.prototype.parallel = function (n) {
  var source = this;
  var running = [];
  var ended = false;
  var reading_source = false;

  if (typeof n !== "number") {
    throw new Error("Must specify a number to parallel().");
  }

  if (n <= 0) {
    throw new Error("The parallelism factor must be positive");
  }

  return _(function (push, next) {
    if (running.length < n && !ended && !reading_source) {
      // get another stream if not already waiting for one
      reading_source = true;
      source.pull(function (err, x) {
        reading_source = false;
        if (err) {
          push(err);
        } else if (x === nil) {
          ended = true;
        } else if (!_.isStream(x)) {
          push(new Error("Expected Stream, got " + (typeof x)));
        } else {
          // got a new source, add it to the running array
          var run = { stream: x, buffer: [] };
          running.push(run);
          x.consume(function (_err, y, _push, _next) {
            if (running[0] === run) {
              // current output stream
              if (y === nil) {
                // remove self from running and check
                // to see if we need to read from source again
                running.shift();
                flushBuffer();
                next();
              } else {
                // push directly onto parallel output stream
                push(_err, y);
              }
            } else {
              // we're reading ahead, buffer the output
              run.buffer.push([_err, y]);
            }
            if (y !== nil) {
              // keep reading until we hit nil
              _next();
            }
          }).resume();
        }
        // check if we need to get any more streams
        return next();
      });
    } else if (!running.length && ended) {
      // nothing more to do
      push(null, nil);
    }

    function flushBuffer() {
      while (running.length && running[0].buffer.length) {
        var buf = running[0].buffer;
        for (var i = 0; i < buf.length; i++) {
          if (buf[i][1] === nil) {
            // this stream has ended
            running.shift();
            break;
          } else {
            // send the buffered output
            push.apply(null, buf[i]);
          }
        }
        buf.length = 0;
      }
    }
    // else wait for more data to arrive from running streams
  });
};

/**
 * Switches source to an alternate Stream if the current Stream is empty.
 *
 * @id otherwise
 * @section Higher-order Streams
 * @name Stream.otherwise(ys)
 * @param {Stream | Function} ys - alternate stream (or stream-returning function) to use if this stream is empty
 * @api public
 *
 * _([1,2,3]).otherwise(['foo'])  // => 1, 2, 3
 * _([]).otherwise(['foo'])       // => 'foo'
 *
 * _.otherwise(_(['foo']), _([1,2,3]))    // => 1, 2, 3
 * _.otherwise(_(['foo']), _([]))         // => 'foo'
 */

Stream.prototype.otherwise = function (ys) {
  var xs = this;
  return xs.consume(function (err, x, push, next) {
    if (err) {
      // got an error, just keep going
      push(err);
      next();
    } else if (x === nil) {
      // hit the end without redirecting to xs, use alternative
      if (isFunction(ys)) {
        next(ys());
      } else {
        next(ys);
      }
    } else {
      // got a value, push it, then redirect to xs
      push(null, x);
      next(xs);
    }
  });
};

/**
 * Adds a value to the end of a Stream.
 *
 * @id append
 * @section Transforms
 * @name Stream.append(y)
 * @param y - the value to append to the Stream
 * @api public
 *
 * _([1, 2, 3]).append(4)  // => 1, 2, 3, 4
 */

Stream.prototype.append = function (y) {
  return this.consume(function (err, x, push, next) {
    if (x === nil) {
      push(null, y);
      push(null, nil);
    } else {
      push(err, x);
      next();
    }
  });
};

/**
 * Boils down a Stream to a single value. The memo is the initial state
 * of the reduction, and each successive step of it should be returned by
 * the iterator function. The iterator is passed two arguments:
 * the memo and the next value.
 *
 * If the iterator throws an error, the reduction stops and the resulting
 * stream will emit that error instead of a value.
 *
 * *Note:* The order of the `memo` and `iterator` arguments will be flipped in
 * the next major version release.
 *
 * @id reduce
 * @section Transforms
 * @name Stream.reduce(memo, iterator)
 * @param memo - the initial state of the reduction
 * @param {Function} iterator - the function which reduces the values
 * @api public
 *
 * var add = function (a, b) {
 *     return a + b;
 * };
 *
 * _([1, 2, 3, 4]).reduce(0, add)  // => 10
 */

Stream.prototype.reduce = function (z, f) {
  // This can't be implemented with scan(), because we don't know if the
  // errors that we see from the scan were thrown by the iterator or just
  // passed through from the source stream.
  return this.consume(function (err, x, push, next) {
    if (x === nil) {
      push(null, z);
      push(null, nil);
    } else if (err) {
      push(err);
      next();
    } else {
      try {
        z = f(z, x);
      } catch (e) {
        push(e);
        push(null, nil);
        return;
      }

      next();
    }
  });
};

/**
 * Same as [reduce](#reduce), but uses the first element as the initial
 * state instead of passing in a `memo` value.
 *
 * @id reduce1
 * @section Transforms
 * @name Stream.reduce1(iterator)
 * @param {Function} iterator - the function which reduces the values
 * @api public
 *
 * _([1, 2, 3, 4]).reduce1(add)  // => 10
 */

Stream.prototype.reduce1 = function (f) {
  var self = this;
  return _(function (push, next) {
    self.pull(function (err, x) {
      if (err) {
        push(err);
        next();
      } else if (x === nil) {
        push(null, nil);
      } else {
        next(self.reduce(x, f));
      }
    });
  });
};

/**
 * Groups all values into an Array and passes down the stream as a single
 * data event. This is a bit like doing [toArray](#toArray), but instead
 * of accepting a callback and consuming the stream, it passes the value on.
 *
 * @id collect
 * @section Transforms
 * @name Stream.collect()
 * @api public
 *
 * _(['foo', 'bar']).collect().toArray(function (xs) {
 *     // xs will be [['foo', 'bar']]
 * });
 */

Stream.prototype.collect = function () {
  var xs = [];
  return this.consume(function (err, x, push, next) {
    if (err) {
      push(err);
      next();
    } else if (x === nil) {
      push(null, xs);
      push(null, nil);
    } else {
      xs.push(x);
      next();
    }
  });
};

/**
 * Like [reduce](#reduce), but emits each intermediate value of the
 * reduction as it is calculated.
 *
 * If the iterator throws an error, the scan will stop and the stream will
 * emit that error. Any intermediate values that were produced before the
 * error will still be emitted.
 *
 * *Note:* The order of the `memo` and `iterator` arguments will be flipped in
 * the next major version release.
 *
 * @id scan
 * @section Transforms
 * @name Stream.scan(memo, iterator)
 * @param memo - the initial state of the reduction
 * @param {Function} iterator - the function which reduces the values
 * @api public
 *
 * _([1, 2, 3, 4]).scan(0, add)  // => 0, 1, 3, 6, 10
 */

Stream.prototype.scan = function (z, f) {
  var self = this;
  return _([z]).concat(
    self.consume(function (err, x, push, next) {
      if (x === nil) {
        push(null, nil);
      } else if (err) {
        push(err);
        next();
      } else {
        try {
          z = f(z, x);
        } catch (e) {
          push(e);
          push(null, nil);
          return;
        }

        push(null, z);
        next();
      }
    }),
  );
};

/**
 * Same as [scan](#scan), but uses the first element as the initial
 * state instead of passing in a `memo` value.
 *
 * @id scan1
 * @section Transforms
 * @name Stream.scan1(iterator)
 * @param {Function} iterator - the function which reduces the values
 * @api public
 *
 * _([1, 2, 3, 4]).scan1(add)  // => 1, 3, 6, 10
 */

Stream.prototype.scan1 = function (f) {
  var self = this;
  return _(function (push, next) {
    self.pull(function (err, x) {
      if (err) {
        push(err);
        next();
      } else if (x === nil) {
        push(null, nil);
      } else {
        next(self.scan(x, f));
      }
    });
  });
};

function HighlandTransform(push) {
  this.push = push;
}

HighlandTransform.prototype["@@transducer/init"] = function () {
  return this.push;
};

HighlandTransform.prototype["@@transducer/result"] = function (push) {
  // Don't push nil here. Otherwise, we can't catch errors from `result`
  // and propagate them. The `transduce` implementation will do it.
  return push;
};

HighlandTransform.prototype["@@transducer/step"] = function (push, input) {
  push(null, input);
  return push;
};

/**
 * Applies the transformation defined by the the given *transducer* to the
 * stream. A transducer is any function that follows the
 * [Transducer Protocol](https://github.com/cognitect-labs/transducers-js#transformer-protocol).
 * See
 * [transduce-js](https://github.com/cognitect-labs/transducers-js#transducers-js)
 * for more details on what transducers actually are.
 *
 * The `result` object that is passed in through the
 * [Transformer Protocol](https://github.com/cognitect-labs/transducers-js#transformer-protocol)
 * will be the `push` function provided by the [consume](#consume) transform.
 *
 * Like [scan](#scan), if the transducer throws an exception, the transform
 * will stop and emit that error. Any intermediate values that were produced
 * before the error will still be emitted.
 *
 * @id transduce
 * @section Transforms
 * @name Stream.transduce(xf)
 * @param {Function} xf - The transducer.
 * @api public
 *
 * var xf = require('transducer-js').map(_.add(1));
 * _([1, 2, 3, 4]).transduce(xf);
 * // => 2, 3, 4, 5
 */

Stream.prototype.transduce = function transduce(xf) {
  var transform = null,
    memo = null;

  return this.consume(function (err, x, push, next) {
    if (transform == null) {
      transform = xf(new HighlandTransform(push));
      memo = transform["@@transducer/init"]();
    }

    if (err) {
      // Pass through errors, like we always do.
      push(err);
      next();
    } else if (x === nil) {
      // Push may be different from memo depending on the transducer that
      // we get.
      runResult(push, memo);
    } else {
      var res = runStep(push, memo, x);

      if (!res) {
        return;
      }

      memo = res;
      if (memo["@@transducer/reduced"]) {
        runResult(memo["@@transducer/value"]);
      } else {
        next();
      }
    }
  });

  function runResult(push, _memo) {
    try {
      transform["@@transducer/result"](_memo);
    } catch (e) {
      push(e);
    }
    push(null, nil);
  }

  function runStep(push, _memo, x) {
    try {
      return transform["@@transducer/step"](_memo, x);
    } catch (e) {
      push(e);
      push(null, nil);
      return null;
    }
  }
};

/**
 * Concatenates a Stream to the end of this Stream.
 *
 * Be aware that in the top-level export, the args may be in the reverse
 * order to what you'd expect `_([a], [b]) => b, a`, as this follows the
 * convention of other top-level exported functions which do `x` to `y`.
 *
 * @id concat
 * @section Higher-order Streams
 * @name Stream.concat(ys)
 * @param {Stream | Array} ys - the values to concatenate onto this Stream
 * @api public
 *
 * _([1, 2]).concat([3, 4])  // => 1, 2, 3, 4
 * _.concat([3, 4], [1, 2])  // => 1, 2, 3, 4
 */

Stream.prototype.concat = function (ys) {
  ys = _(ys);
  return this.consume(function (err, x, push, next) {
    if (x === nil) {
      next(ys);
    } else {
      push(err, x);
      next();
    }
  });
};

/**
 * Takes a Stream of Streams and merges their values and errors into a
 * single new Stream. The merged stream ends when all source streams have
 * ended.
 *
 * Note that no guarantee is made with respect to the order in which
 * values for each stream end up in the merged stream. Values in the
 * merged stream will, however, respect the order they were emitted from
 * their respective streams.
 *
 * @id merge
 * @section Higher-order Streams
 * @name Stream.merge()
 * @api public
 *
 * var readFile = _.wrapCallback(fs.readFile);
 *
 * var txt = _(['foo.txt', 'bar.txt']).map(readFile)
 * var md = _(['baz.md']).map(readFile)
 *
 * _([txt, md]).merge();
 * // => contents of foo.txt, bar.txt and baz.txt in the order they were read
 */

Stream.prototype.merge = function () {
  var self = this;
  var srcs = [];

  var srcsNeedPull = [],
    first = true,
    async = false;

  return _(function (push, next) {
    if (first) {
      first = false;
      getSourcesSync(push, next);
    }

    if (srcs.length === 0) {
      push(null, nil);
    } else if (srcsNeedPull.length) {
      pullFromAllSources(push, next);
      next();
    } else {
      async = true;
    }
  });

  // Make a handler for the main merge loop.
  function srcPullHandler(push, next, src) {
    return function (err, x) {
      if (err) {
        push(err);
        srcsNeedPull.push(src);
      } else if (x === nil) {
        srcs = srcs.filter(function (s) {
          return s !== src;
        });
      } else {
        if (src === self) {
          srcs.push(x);
          srcsNeedPull.push(x);
          srcsNeedPull.unshift(self);
        } else {
          push(null, x);
          srcsNeedPull.push(src);
        }
      }

      if (async) {
        async = false;
        next();
      }
    };
  }

  function pullFromAllSources(push, next) {
    var _srcs = srcsNeedPull;
    srcsNeedPull = [];
    _srcs.forEach(function (src) {
      src.pull(srcPullHandler(push, next, src));
    });
  }

  // Pulls as many sources as possible from self synchronously.
  function getSourcesSync(push, next) {
    // Shadows the outer async variable.
    var asynchronous;
    var done = false;

    var pull_cb = function (err, x) {
      asynchronous = false;
      if (done) {
        // This means the pull was async. Handle like
        // regular async.
        srcPullHandler(push, next, self)(err, x);
      } else {
        if (err) {
          push(err);
        } else if (x === nil) {
          done = true;
        } else {
          srcs.push(x);
          srcsNeedPull.push(x);
        }
      }
    };

    while (!done) {
      asynchronous = true;
      self.pull(pull_cb);

      // Async behavior, record self as a src and return.
      if (asynchronous) {
        done = true;
        srcs.unshift(self);
      }
    }
  }
};

/**
 * Takes a Stream of Streams and merges their values and errors into a
 * single new Stream, limitting the number of unpaused streams that can
 * running at any one time.
 *
 * Note that no guarantee is made with respect to the order in which
 * values for each stream end up in the merged stream. Values in the
 * merged stream will, however, respect the order they were emitted from
 * their respective streams.
 *
 * @id mergeWithLimit
 * @section Higher-order Streams
 * @name Stream.mergeWithLimit(n)
 * @param {Number} n - the maximum number of streams to run in parallel
 * @api public
 *
 * var readFile = _.wrapCallback(fs.readFile);
 *
 * var txt = _(['foo.txt', 'bar.txt']).flatMap(readFile)
 * var md = _(['baz.md']).flatMap(readFile)
 * var js = _(['bosh.js']).flatMap(readFile)
 *
 * _([txt, md, js]).mergeWithLimit(2);
 * // => contents of foo.txt, bar.txt, baz.txt and bosh.js in the order
 * // they were read, but bosh.js is not read until either foo.txt and bar.txt
 * // has completely been read or baz.md has been read
 */

Stream.prototype.mergeWithLimit = function (n) {
  var self = this;
  var processCount = 0;
  var waiting = false;
  if (typeof n !== "number" || n < 1) {
    throw new Error("mergeWithLimit expects a positive number, but got: " + n);
  }

  if (n === Infinity) {
    return this.merge();
  }
  return _(function (push, next) {
    self.pull(function (err, x) {
      var done = x === nil;
      if (err) {
        push(err);
        next();
      } else if (x === nil) {
        push(null, nil);
      } else {
        processCount++;
        push(err, x);
        // console.log('start', x.id);
        x._destructors.push(() => {
          processCount--;
          // console.log('end', x.id);
          if (waiting) {
            // console.log('get more');
            waiting = false;
            next();
          }
        });
        if (!done && processCount < n) {
          next();
        } else {
          // console.log('wait till something ends');
          waiting = true;
        }
      }
    });
  }).merge();
};

/**
 * Calls a named method on each object from the Stream - returning
 * a new stream with the result of those calls.
 *
 * @id invoke
 * @section Transforms
 * @name Stream.invoke(method, args)
 * @param {String} method - the method name to call
 * @param {Array} args - the arguments to call the method with
 * @api public
 *
 * _(['foo', 'bar']).invoke('toUpperCase', [])  // => 'FOO', 'BAR'
 *
 * var readFile = _.wrapCallback(fs.readFile);
 * filenames.flatMap(readFile).invoke('toString', ['utf8']);
 */

Stream.prototype.invoke = function (method, args) {
  return this.map(function (x) {
    return x[method].apply(x, args);
  });
};

/**
 * Takes a Stream of callback-accepting node-style functions,
 * [wraps](#wrapCallback) each one into a stream-returning function,
 * calls them with the arguments provided, and returns the results
 * as a Stream.
 *
 * This can be used as a control flow shortcut and draws parallels
 * with some control flow functions from [async](https://github.com/caolan/async).
 * A few rough correspondences include:
 *
 * - `.nfcall([]).series()` to `async.series()`
 * - `.nfcall([]).parallel(n)` to `async.parallelLimit(n)`
 * - `.nfcall(args)` to `async.applyEach(..., args)`
 * - `.nfcall(args).series()` to `async.applyEachSeries(..., args)`
 *
 * @id nfcall
 * @section Transforms
 * @name Stream.nfcall(args)
 * @param {Array} args - the arguments to call each function with
 * @api public
 *
 * _([
 *   function (callback) {
 *     setTimeout(function () {
 *       callback(null, 'one');
 *     }, 200);
 *   },
 *   function (callback) {
 *     setTimeout(function () {
 *       callback(null, 'two');
 *     }, 100);
 *   }
 * ]).nfcall([]).parallel(2).toArray(function (xs) {
 *   // xs is ['one', 'two'] even though second function had a shorter timeout
 * });
 *
 * _([enableSearch, updateSchema]).nfcall(['bucket']).toArray(callback);
 * // does roughly the same as
 * async.applyEach([enableSearch, updateSchema], 'bucket', callback);
 *
 * _([
 *   fs.appendFile,
 *   fs.appendFile
 * ]).nfcall(['example.txt', 'hello']).series().toArray(function() {
 *   // example.txt now contains 'hellohello'
 * });
 *
 */

Stream.prototype.nfcall = function (args) {
  return this.map(function (x) {
    return _.wrapCallback(x).apply(x, args);
  });
};

/**
 * Ensures that only one data event is push downstream (or into the buffer)
 * every `ms` milliseconds, any other values are dropped.
 *
 * @id throttle
 * @section Transforms
 * @name Stream.throttle(ms)
 * @param {Number} ms - the minimum milliseconds between each value
 * @api public
 *
 * _('mousemove', document).throttle(1000);
 */

Stream.prototype.throttle = function (ms) {
  var last = 0 - ms;
  return this.consume(function (err, x, push, next) {
    var now = new Date().getTime();
    if (err) {
      push(err);
      next();
    } else if (x === nil) {
      push(null, nil);
    } else if (now - ms >= last) {
      last = now;
      push(null, x);
      next();
    } else {
      next();
    }
  });
};

/**
 * Holds off pushing data events downstream until there has been no more
 * data for `ms` milliseconds. Sends the last value that occurred before
 * the delay, discarding all other values.
 *
 * **Implementation Note**: This transform will will not wait the full `ms`
 * delay to emit a pending value (if any) once it see a `nil`, as that
 * guarantees that there will be no more values.
 *
 * @id debounce
 * @section Transforms
 * @name Stream.debounce(ms)
 * @param {Number} ms - the milliseconds to wait before sending data
 * @api public
 *
 * function delay(x, ms, push) {
 *     setTimeout(function () {
 *         push(null, x);
 *     }, ms);
 * }
 *
 * // sends last keyup event after user has stopped typing for 1 second
 * $('keyup', textbox).debounce(1000);
 *
 * // A nil triggers the emit immediately
 * _(function (push, next) {
 *     delay(0, 100, push);
 *     delay(1, 200, push);
 *     delay(nil, 250, push);
 * }).debounce(75);
 * // => after 175ms => 1
 * // => after 250ms (not 275ms!) => 1 2
 */

Stream.prototype.debounce = function (ms) {
  var t = null;
  var nothing = {};
  var last = nothing;

  return this.consume(function (err, x, push, next) {
    if (err) {
      // let errors through regardless
      push(err);
      next();
    } else if (x === nil) {
      if (t) {
        clearTimeout(t);
      }
      if (last !== nothing) {
        push(null, last);
      }
      push(null, nil);
    } else {
      last = x;
      if (t) {
        clearTimeout(t);
      }
      t = setTimeout(function () {
        push(null, x);
      }, ms);
      next();
    }
  });
};

/**
 * Creates a new Stream, which when read from, only returns the last
 * seen value from the source. The source stream does not experience
 * back-pressure. Useful if you're using a Stream to model a changing
 * property which you need to query periodically.
 *
 * @id latest
 * @section Transforms
 * @name Stream.latest()
 * @api public
 *
 * // slowThing will always get the last known mouse position
 * // when it asks for more data from the mousePosition stream
 * mousePosition.latest().map(slowThing)
 */

Stream.prototype.latest = function () {
  var nothing = {},
    latest = nothing,
    errors = [],
    ended = false,
    onValue = null;

  this.consume(function (err, x, push, next) {
    if (onValue != null) {
      var cb = onValue;
      onValue = null;
      cb(err, x);
    }

    if (err) {
      errors.push(err);
      next();
    } else if (x === nil) {
      ended = true;
    } else {
      latest = x;
      next();
    }
  }).resume();

  return _(function (push, next) {
    var oldErrors = errors;
    errors = [];

    if (!oldErrors.length && latest === nothing && !ended) {
      // We haven't gotten any data yet. We can't call next
      // because that might cause the stream to call the generator
      // again, resulting in an infinite loop. Thus, we stick a
      // a callback to be called whenever we get a value.
      onValue = function (err, x) {
        push(err, x);
        if (x !== nil) {
          next();
        }
      };
    } else {
      oldErrors.forEach(push);
      if (latest !== nothing) {
        push(null, latest);
      }
      if (ended) {
        push(null, nil);
      } else {
        next();
      }
    }
  });
};

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
 *
 * _.values({foo: 1, bar: 2, baz: 3})  // => 1, 2, 3
 */

_.values = function (obj) {
  return _.keys(obj).map(function (k) {
    return obj[k];
  });
};

/**
 * Returns keys from an Object as a Stream.
 *
 * @id keys
 * @section Objects
 * @name _.keys(obj)
 * @param {Object} obj - the object to return keys from
 * @api public
 *
 * _.keys({foo: 1, bar: 2, baz: 3})  // => 'foo', 'bar', 'baz'
 */

function keys(obj) {
  var keysArray = [];
  for (var k in obj) {
    if (hasOwn.call(obj, k)) {
      keysArray.push(k);
    }
  }
  return keysArray;
}

_.keys = function (obj) {
  return _(keys(obj));
};

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
 *
 * _.pairs({foo: 1, bar: 2})  // => ['foo', 1], ['bar', 2]
 */

_.pairs = function (obj) {
  return _.keys(obj).map(function (k) {
    return [k, obj[k]];
  });
};

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
 *
 * _.extend({name: 'bar'}, {name: 'foo', price: 20})
 * // => {name: 'bar', price: 20}
 *
 * // example of partial application
 * var publish = _.extend({published: true});
 *
 * publish({title: 'test post'})
 * // => {title: 'test post', published: true}
 */

_.extend = _.curry(function (extensions, target) {
  for (var k in extensions) {
    if (hasOwn.call(extensions, k)) {
      target[k] = extensions[k];
    }
  }
  return target;
});

/**
 * Returns a property from an object.
 *
 * @id get
 * @section Objects
 * @name _.get(prop, obj)
 * @param {String} prop - the property to return
 * @param {Object} obj - the object to read properties from
 * @api public
 *
 * var obj = {foo: 'bar', baz: 123};
 * _.get('foo', obj) // => 'bar'
 *
 * // making use of partial application
 * var posts = [
 *   {title: 'one'},
 *   {title: 'two'},
 *   {title: 'three'}
 * ];
 *
 * _(posts).map(_.get('title'))  // => 'one', 'two', 'three'
 */

_.get = _.curry(function (prop, obj) {
  return obj[prop];
});

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
 *
 * var obj = {foo: 'bar', baz: 123};
 * _.set('foo', 'wheeee', obj) // => {foo: 'wheeee', baz: 123}
 *
 * // making use of partial application
 * var publish = _.set('published', true);
 *
 * publish({title: 'example'})  // => {title: 'example', published: true}
 */

_.set = _.curry(function (prop, val, obj) {
  obj[prop] = val;
  return obj;
});

/**
 * Logs values to the console, a simple wrapper around `console.log` that
 * it suitable for passing to other functions by reference without having to
 * call `bind`.
 *
 * @id log
 * @section Utils
 * @name _.log(args..)
 * @api public
 *
 * _.log('Hello, world!');
 *
 * _([1, 2, 3, 4]).each(_.log);
 */

_.log = function () {
  console.log.apply(console, arguments);
};

/**
 * Wraps a node-style async function which accepts a callback, transforming
 * it to a function which accepts the same arguments minus the callback and
 * returns a Highland Stream instead. The wrapped function keeps its context,
 * so you can safely use it as a method without binding (see the second
 * example below).
 *
 * `wrapCallback` also accepts an optional `mappingHint`, which specifies how
 * callback arguments are pushed to the stream. This can be used to handle
 * non-standard callback protocols that pass back more than one value.
 *
 * `mappingHint` can be a function, number, or array. See the documentation on
 * [EventEmitter Stream Objects](#Stream Objects) for details on the mapping
 * hint. If `mappingHint` is a function, it will be called with all but the
 * first argument that is passed to the callback. The first is still assumed to
 * be the error argument.
 *
 * @id wrapCallback
 * @section Utils
 * @name _.wrapCallback(f)
 * @param {Function} f - the node-style function to wrap
 * @param {Array | Function | Number} mappingHint - (optional) how to pass the
 * arguments to the callback
 * @api public
 *
 * var fs = require('fs');
 *
 * var readFile = _.wrapCallback(fs.readFile);
 *
 * readFile('example.txt').apply(function (data) {
 *     // data is now the contents of example.txt
 * });
 *
 * function Reader(file) {
 *     this.file = file;
 * }
 *
 * Reader.prototype.read = function(cb) {
 *     fs.readFile(this.file, cb);
 * };
 *
 * Reader.prototype.readStream = _.wrapCallback(Reader.prototype.read);
 */

/*eslint-disable no-multi-spaces */
_.wrapCallback = function (f, /*optional*/ mappingHint) {
  /*eslint-enable no-multi-spaces */
  var mapper = hintMapper(mappingHint);

  return function () {
    var self = this;
    var args = slice.call(arguments);
    return _(function (push) {
      var cb = function (err) {
        if (err) {
          push(err);
        } else {
          var cbArgs = slice.call(arguments, 1);
          var v = mapper.apply(this, cbArgs);
          push(null, v);
        }
        push(null, nil);
      };
      f.apply(self, args.concat([cb]));
    });
  };
};

/**
 * Takes an object or a constructor function and returns that object or
 * constructor with streamified versions of its function properties.
 * Passed constructors will also have their prototype functions
 * streamified.  This is useful for wrapping many node style async
 * functions at once, and for preserving those functions' context.
 *
 * @id streamifyAll
 * @section Utils
 * @name _.streamifyAll(source)
 * @param {Object | Function} source - the function or object with
 * node-style function properties.
 * @api public
 *
 * var fs = _.streamifyAll(require('fs'));
 *
 * fs.readFileStream('example.txt').apply(function (data) {
 *     // data is now the contents of example.txt
 * });
 */

function isClass(fn) {
  if (!(typeof fn === "function" && fn.prototype)) return false;
  var allKeys = keys(fn.prototype);
  return allKeys.length > 0 && !(allKeys.length === 1 &&
    allKeys[0] === "constructor");
}

function inheritedKeys(obj) {
  var allProps = {};
  var curr = obj;
  var handleProp = function (prop) {
    allProps[prop] = true;
  };
  while (Object.getPrototypeOf(curr)) {
    var props = Object.getOwnPropertyNames(curr);
    props.forEach(handleProp);
    curr = Object.getPrototypeOf(curr);
  }
  return keys(allProps);
}

function streamifyAll(inp, suffix) {
  // will not streamify inherited functions in ES3
  var allKeys = keys(inp);

  for (var i = 0, len = allKeys.length; i < len; i++) {
    var key = allKeys[i];
    var val;

    // will skip context aware getters
    try {
      val = inp[key];
    } catch (e) {
      // Ignore
    }

    if (
      val && typeof val === "function" && !isClass(val) &&
      !val.__HighlandStreamifiedFunction__
    ) {
      var streamified = _.wrapCallback(val);
      streamified.__HighlandStreamifiedFunction__ = true;
      inp[key + suffix] = streamified;
    }
  }
  return inp;
}

_.streamifyAll = function (arg) {
  if (typeof arg !== "function" && typeof arg !== "object") {
    throw new TypeError("takes an object or a constructor function");
  }
  var suffix = "Stream";

  var ret = streamifyAll(arg, suffix);
  if (isClass(arg)) {
    ret.prototype = streamifyAll(arg.prototype, suffix);
  }
  return ret;
};

/**
 * Add two values. Can be partially applied.
 *
 * @id add
 * @section Operators
 * @name _.add(a, b)
 * @api public
 *
 * _.add(1, 2) === 3
 * _.add(1)(5) === 6
 */

_.add = _.curry(function (a, b) {
  return a + b;
});

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

_.not = function (x) {
  return !x;
};
export { Flattened } from "./flattened.ts";
export { PConstructor } from "./p-constructor.ts";
export { HighlandStatic } from "./highland-static.ts";
