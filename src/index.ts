/**
 * Highland: the high-level streams library
 *
 * Highland may be freely distributed under the Apache 2.0 license.
 * http://github.com/caolan/highland
 * Copyright (c) Caolan McMahon
 *
 */

import deprecate from "https://cdn.skypack.dev/util-deprecate";
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
    rest = Array.prototype.slice.call(arguments);
  } else {
    // got a stream as first argument, co-erce to Highland stream
    startHighland = _(start);
    rest = Array.prototype.slice.call(arguments, 1);
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
    if (Object.prototype.hasOwnProperty.call(obj, k)) {
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
    if (Object.prototype.hasOwnProperty.call(extensions, k)) {
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
    var args = Array.prototype.slice.call(arguments);
    return _(function (push) {
      var cb = function (err) {
        if (err) {
          push(err);
        } else {
          var cbArgs = Array.prototype.slice.call(arguments, 1);
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
