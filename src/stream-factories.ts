import { Stream } from "./stream.ts";

export interface StreamFactories<R> {
  /**
     * The Stream constructor, accepts an array of values or a generator function
     * as an optional argument. This is typically the entry point to the Highland
     * APIs, providing a convenient way of chaining calls together.
     *
     * **Arrays -** Streams created from Arrays will emit each value of the Array
     * and then emit a [nil](#nil) value to signal the end of the Stream.
     *
     * **Generators -** These are functions which provide values for the Stream.
     * They are lazy and can be infinite, they can also be asynchronous (for
     * example, making a HTTP request). You emit values on the Stream by calling
     * `push(err, val)`, much like a standard Node.js callback. Once it has been
     * called, the generator function will not be called again unless you call
     * `next()`. This call to `next()` will signal you've finished processing the
     * current data and allow for the generator function to be called again. If the
     * Stream is still being consumed the generator function will then be called
     * again.
     *
     * You can also redirect a generator Stream by passing a new source Stream
     * to read from to next. For example: `next(other_stream)` - then any subsequent
     * calls will be made to the new source.
     *
     * **Node Readable Stream -** Pass in a Node Readable Stream object to wrap
     * it with the Highland API. Reading from the resulting Highland Stream will
     * begin piping the data from the Node Stream to the Highland Stream.
     *
     * A stream constructed in this way relies on `Readable#pipe` to end the
     * Highland Stream once there is no more data. Not all Readable Streams do
     * this. For example, `IncomingMessage` will only emit `close` when the client
     * aborts communications and will *not* properly call `end`. In this case, you
     * can provide an optional `onFinished` function with the signature
     * `onFinished(readable, callback)` as the second argument.
     *
     * This function will be passed the Readable and a callback that should called
     * when the Readable ends. If the Readable ended from an error, the error
     * should be passed as the first argument to the callback. `onFinished` should
     * bind to whatever listener is necessary to detect the Readable's completion.
     * If the callback is called multiple times, only the first invocation counts.
     * If the callback is called *after* the Readable has already ended (e.g., the
     * `pipe` method already called `end`), it will be ignored.
     *
     * The `onFinished` function may optionally return one of the following:
     *
     * - A cleanup function that will be called when the stream ends. It should
     * unbind any listeners that were added.
     * - An object with the following optional properties:
     *    - `onDestroy` - the cleanup function.
     *    - `continueOnError` - Whether or not to continue the stream when an
     *      error is passed to the callback. Set this to `true` if the Readable
     *      may continue to emit values after errors. Default: `false`.
     *
     * See [this issue](https://github.com/caolan/highland/issues/490) for a
     * discussion on why Highland cannot reliably detect stream completion for
     * all implementations and why the `onFinished` function is required.
     *
     * **EventEmitter / jQuery Elements -** Pass in both an event name and an
     * event emitter as the two arguments to the constructor and the first
     * argument emitted to the event handler will be written to the new Stream.
     *
     * You can pass a mapping hint as the third argument, which specifies how
     * event arguments are pushed into the stream. If no mapping hint is provided,
     * only the first value emitted with the event to the will be pushed onto the
     * Stream.
     *
     * If `mappingHint` is a number, an array of that length will be pushed onto
     * the stream, containing exactly that many parameters from the event. If it's
     * an array, it's used as keys to map the arguments into an object which is
     * pushed to the tream. If it is a function, it's called with the event
     * arguments, and the returned value is pushed.
     *
     * **Promise -** Accepts an ES6 / jQuery style promise and returns a
     * Highland Stream which will emit a single value (or an error). In case you use
     * [bluebird cancellation](http://bluebirdjs.com/docs/api/cancellation.html) Highland Stream will be empty for a cancelled promise.
     *
     * **Iterator -** Accepts an ES6 style iterator that implements the [iterator protocol](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols#The_.22iterator.22_protocol):
     * yields all the values from the iterator using its `next()` method and terminates when the
     * iterator's done value returns true. If the iterator's `next()` method throws, the exception will be emitted as an error,
     * and the stream will be ended with no further calls to `next()`.
     *
     * **Iterable -** Accepts an object that implements the [iterable protocol](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Iteration_protocols#The_.22iterable.22_protocol),
     * i.e., contains a method that returns an object that conforms to the iterator protocol. The stream will use the
     * iterator defined in the `Symbol.iterator` property of the iterable object to generate emitted values.
     *
     * @id _(source)
     * @section Stream Objects
     * @name _(source)
     * @param {Array | Function | Iterator | Iterable | Promise | Readable Stream | String} source - (optional) source to take values from from
     * @param {Function} onFinished - (optional) a function that detects when the readable completes. Second argument. Only valid if `source` is a Readable.
     * @param {EventEmitter | jQuery Element} eventEmitter - (optional) An event emitter. Second argument. Only valid if `source` is a String.
     * @param {Array | Function | Number} mappingHint - (optional) how to pass the
     * arguments to the callback. Only valid if `source` is a String.
     * @api public
     */
  (): Stream<R>;

  (source: Array<R>): Stream<R>;
}
