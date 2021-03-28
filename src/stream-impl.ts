import { EventEmitter } from "https://deno.land/std@0.91.0/node/events.ts";
import { setImmediate } from "https://deno.land/std@0.91.0/node/timers.ts";
import { Consumer } from "./consumer.ts";
import defaultReadableOnFinish from "./default-readable-on-finish.ts";
import hintMapper from "./hint-mapper.ts";
import _, {
  curry,
  isFunction,
  isIterable,
  isIterator,
  isObject,
  isPromise,
  isReadableStream,
  isStreamError,
  isString,
  isUndefined,
  isValueGeneratorFunction,
} from "./index.ts";

import { MappingHint, Nil, nil } from "./interfaces.ts";
import { InternalValue } from "./internal-value.ts";
import iteratorStream from "./iterator-stream.ts";
import nop from "./nop.ts";
import { Observer } from "./observer.ts";
import pipeReadable from "./pipe-readable.ts";
import promiseStream from "./promise-stream.ts";
import { StreamConstructors } from "./stream-constructors.ts";
import { StreamError } from "./stream-error.ts";
import { StreamRedirect } from "./stream-redirect.ts";
import { Stream } from "./stream.ts";
import {
  ValueGenerator,
  ValueGeneratorNext,
  ValueGeneratorPush,
} from "./value-generator.ts";

const bindContext = <T>(fn: () => T, context: any): () => T =>
  (...args: any) => fn.apply(context, args);

const generatorPush = <R>(
  stream: Stream<R>,
): (err: Error | null | undefined, x: R) => void =>
  (err: Error | null | undefined, x: R) => {
    // This will set _nil_pushed if necessary.
    if (err) {
      stream.write(new StreamError(err));
    } else {
      stream.write(x);
    }
  };

/**
 * Actual Stream constructor wrapped the the main exported function
 */
export class StreamImpl<R> extends EventEmitter
  implements StreamConstructors<R> {
  /**
     * used to detect Highland Streams using isStream(x), this
     * will work even in cases where npm has installed multiple
     * versions, unlike an instanceof check
     */
  __HighlandStream__: boolean = true;
  id: string = ("" + Math.random()).substr(2, 6);
  paused: boolean = true;
  _incoming: Array<InternalValue<R>> = [];
  private _generator?: ValueGenerator<R>;
  private _outgoing: Array<void> = [];
  private _consumers: Array<Consumer<R>> = [];
  private _observers: Array<Observer<R>> = [];
  _destructors: Array<Function> = [];
  private _send_events: boolean = false;
  _nil_pushed: boolean = false;
  private _is_observer: boolean = false;
  private _is_consumer: boolean = false;
  private _in_consume_cb: boolean = false;
  private _repeat_resume: boolean = false;
  private _delegate: null = null;
  source: null = null;
  /** Old-style node Stream.pipe() checks for this */
  writable: boolean = true;
  /**
     * Signals whether or not a call to write() returned false, and thus we can drain.
     * This is only relevant for streams constructed with _().
     * @private
     */
  private _can_drain: boolean = false;
  /**
     * Used by consume() to signal that next() hasn't been called, so resume()
     * shouldn't ask for more data. Backpressure handling is getting fairly
     * complicated, and this is very much a hack to get consume() backpressure
     * to work correctly.
     */
  private _consume_waiting_for_next: boolean = false;
  private ended: boolean = false;
  private _generator_running: boolean = false;
  private _generator_push?: ValueGeneratorPush<R> = undefined;
  private _generator_next?: ValueGeneratorNext<R> = undefined;

  /**
     * Writes a value to the Stream. If the Stream is paused it will go into the
     * Stream's incoming buffer, otherwise it will be immediately processed and
     * sent to the Stream's consumers (if any). Returns false if the Stream is
     * paused, true otherwise. This lets Node's pipe method handle back-pressure.
     *
     * You shouldn't need to call this yourself, but it may be called by Node
     * functions which treat Highland Streams as a [Node Writable Stream](http://nodejs.org/api/stream.html#stream_class_stream_writable).
     *
     * Only call this function on streams that were constructed with no source
     * (i.e., with `_()`).

     * @id write
     * @section Stream Objects
     * @name Stream.write(x)
     * @param x - the value to write to the Stream
     * @api public
     *
     * var xs = _();
     * xs.write(1);
     * xs.write(2);
     * xs.end();
     *
     * xs.toArray(function (ys) {
     *     // ys will be [1, 2]
     * });
     *
     * // Do *not* do this.
     * var xs2 = _().toArray(_.log);
     * xs2.write(1); // This call is illegal.
     */
  write(x: InternalValue<R>): boolean {
    if (this._nil_pushed) {
      throw new Error("Cannot write to stream after nil");
    }

    // The check for _is_consumer is kind of a hack. Not
    // needed in v3.0.
    if (x === nil && !this._is_consumer) {
      this._nil_pushed = true;
    }

    if (this.paused) {
      this._incoming.push(x);
    } else {
      if (isStreamError(x)) {
        this.send(x.error);
      } else {
        this.send(null, x);
      }
    }

    if (this.paused) {
      this._can_drain = true;
    }

    return !this.paused;
  }

  constructor(
    xs?:
      | Stream<R>
      | ReadableStream
      | Array<R>
      | ValueGenerator<R>
      | Promise<R>
      | Iterable<R>
      | Iterator<R>
      | PromiseLike<Stream<R>>
      | string,
    secondArg?: any,
    mappingHint?: MappingHint,
  ) {
    super();

    this.on("newListener", (ev) => {
      if (ev === "data") {
        this._send_events = true;
        setImmediate(bindContext(this.resume, this));
      } else if (ev === "end") {
        // this property avoids us checking the length of the
        // listeners subscribed to each event on each _send() call
        this._send_events = true;
      }
    });

    // TODO: write test to cover this removeListener code
    this.on("removeListener", (ev) => {
      if (ev === "end" || ev === "data") {
        const end_listeners = this.listeners("end").length;
        const data_listeners = this.listeners("data").length;
        if (end_listeners + data_listeners === 0) {
          // stop emitting events
          this._send_events = false;
        }
      }
    });

    if (isUndefined(xs)) {
      // nothing else to do
      return;
    }

    if (Array.isArray(xs)) {
      this._incoming = [...xs, nil];
      return;
    }

    if (isValueGeneratorFunction(xs)) {
      this._generator = xs;
      this._generator_push = generatorPush(this);
      this._generator_next = (s?: Stream<R>) => {
        if (this._nil_pushed) {
          throw new Error("Cannot call next after nil");
        }

        if (s) {
          // We MUST pause to get the redirect object into the _incoming buffer.
          // Otherwise it would be passed directly to _send(), which does not
          // handle StreamRedirect objects!
          const _paused = this.paused;
          if (!_paused) {
            this.pause();
          }
          this.write(new StreamRedirect<R>(s));
          if (!_paused) {
            this._resume(false);
          }
        } else {
          this._generator_running = false;
        }
        if (!this.paused) {
          this._resume(false);
        }
      };

      return this;
    }

    if (isObject(xs)) {
      // check to see if we have a readable stream
      if (isReadableStream<R>(xs)) {
        const onFinish = isFunction(secondArg)
          ? secondArg
          : defaultReadableOnFinish;
        pipeReadable(xs, onFinish, this);
        return this;
      }

      if (isPromise<R>(xs)) {
        return promiseStream(xs);
      }

      if (isIterator<R>(xs)) {
        return iteratorStream(xs as Iterator<R>);
      }

      if (isIterable<R>(xs)) {
        //probably an iterable
        const iteratorGetter: () => Iterator<R> = xs[Symbol.iterator];
        const iterator: Iterator<R> = iteratorGetter();
        return iteratorStream(iterator);
      }

      throw new Error(
        "Object was not a stream, promise, iterator or iterable: " +
          (typeof xs),
      );
    }

    if (isString(xs)) {
      const eventName: string = xs;
      const eventEmitter: EventEmitter = secondArg as EventEmitter;
      const mapper = hintMapper(mappingHint);

      const callback_func = (...args: Array<any>) =>
        this.write(mapper(...args));

      eventEmitter.on(eventName, callback_func);

      if (eventEmitter.removeListener) {
        this._destructors.push(() =>
          eventEmitter.removeListener(xs, callback_func)
        );
      }

      return this;
    }

    throw new Error(
      "Unexpected argument type to Stream(): " + (typeof xs),
    );
  }

  /**
     * Creates a stream that sends a single value then ends.
     *
     * @id of
     * @section Utils
     * @name _.of(x)
     * @param x - the value to send
     * @returns Stream
     * @api public
     *
     * _.of(1).toArray(_.log); // => [1]
     */
  static of = <R>(x: R): Stream<R> => _([x]);

  /**
     * Creates a stream that sends a single error then ends.
     *
     * @id fromError
     * @section Utils
     * @name _.fromError(err)
     * @param error - the error to send
     * @returns Stream
     * @api public
     *
     * _.fromError(new Error('Single Error')).toCallback(function (err, result) {
     *     // err contains Error('Single Error') object
     * }
     */
  static fromError = (error: Error) =>
    new StreamImpl((push) => {
      push(error);
      push(null, nil);
    });

  /**
     * Sends errors / data to consumers, observers and event handlers
     */
  send(err: Error | null | undefined, x?: InternalValue<R>) {
    if (this._consumers.length) {
      const token = err ? new StreamError(err) : x;
      // this._consumers may be changed from under us, so we keep a copy.
      const consumers = [...this._consumers];
      consumers.forEach((consumer) => consumer.write(token));
    }
    if (this._observers.length) {
      const token = err ? new StreamError(err) : x;
      // this._observers may be changed from under us, so we keep a copy.
      const observers = [...this._observers];
      observers.forEach((observer) => observer.write(token));
    }
    if (this._send_events) {
      if (err) {
        this.emit("error", err);
      } else if (x === nil) {
        this.emit("end");
      } else {
        this.emit("data", x);
      }
    }

    if (x === nil) {
      this._onEnd();
    }
  }

  _onEnd() {
    if (this.ended) {
      return;
    }

    this.pause();
    this.ended = true;

    const source = this.source;
    if (source) {
      source._removeConsumer(this);
      source._removeObserver(this);
    }

    // _removeConsumer may modify this._consumers.
    const consumers = this._consumers;
    consumers.forEach((consumer) => this._removeConsumer(consumer));

    // Don't use _removeObserver for efficiency reasons.
    this._observers
      .filter((observer) => observer.source === this)
      .forEach((observer) => {
        observer.source = null;
      });

    this._destructors.forEach((destructor) => destructor.call(this));

    this.source = null;
    this._consumers = [];
    this._incoming = [];
    this._outgoing = [];
    this._delegate = null;
    this._generator = null;
    this._observers = [];
    this._destructors = [];
  }

  /**
     * Pauses the stream. All Highland Streams start in the paused state.
     *
     * It is unlikely that you will need to manually call this method.
     *
     * @id pause
     * @section Stream Objects
     * @name Stream.pause()
     * @api public
     *
     * var xs = _(generator);
     * xs.pause();
     */
  pause() {
    this.paused = true;
    const source = this.source;
    if (!this._is_observer && source) {
      source._checkBackPressure();
    }
  }

  /**
     * When there is a change in downstream consumers, it will often ask
     * the parent Stream to re-check its state and pause/resume accordingly.
     */
  _checkBackPressure() {
    if (
      this._consumers.length === 0 ||
      this._consumers.find((consumer) => consumer.paused)
    ) {
      this._repeat_resume = false;
      this.pause();
      return;
    }

    this._resume(false);
  }

  /**
     * Starts pull values out of the incoming buffer and sending them downstream,
     * this will exit early if this causes a downstream consumer to pause.
     */
  _readFromBuffer() {
    const len = this._incoming.length;
    let i = 0;

    while (i < len && !this.paused) {
      const x = this._incoming[i];
      if (isStreamError(x)) {
        this._send(x.error);
      } else if (_isStreamRedirect(x)) {
        this._redirect(x.to);
      } else {
        this._send(null, x);
      }
      i++;
    }
    // remove processed data from _incoming buffer
    this._incoming.splice(0, i);
  }

  /**
     * Starts pull values out of the incoming buffer and sending them downstream,
     * this will exit early if this causes a downstream consumer to pause.
     */
  _sendOutgoing() {
    const len = this._outgoing.length;
    let i = 0;
    while (i < len && !this.paused) {
      const x = this._outgoing[i];
      if (isStreamError(x)) {
        Stream.prototype._send.call(this, x.error);
      } else if (_._isStreamRedirect(x)) {
        this._redirect(x.to);
      } else {
        Stream.prototype._send.call(this, null, x);
      }
      i++;
    }
    // remove processed data from _outgoing buffer
    this._outgoing.splice(0, i);
  }

  _resume(forceResumeSource) {
    //console.log(['resume', this.id]);
    if (this._resume_running || this._in_consume_cb) {
      //console.log(['resume already processing _incoming buffer, ignore resume call']);
      // already processing _incoming buffer, ignore resume call
      this._repeat_resume = true;
      return;
    }
    this._resume_running = true;
    do {
      // use a repeat flag to avoid recursing resume() calls
      this._repeat_resume = false;
      this.paused = false;

      // send values from outgoing buffer first
      this._sendOutgoing();

      // send values from incoming buffer before reading from source
      this._readFromBuffer();

      // we may have paused while reading from buffer
      if (!this.paused && !this._is_observer) {
        // ask parent for more data
        if (this.source) {
          if (!this._consume_waiting_for_next || forceResumeSource) {
            //console.log(['ask parent for more data']);
            this.source._checkBackPressure();
          }
        } // run _generator to fill up _incoming buffer
        else if (this._generator) {
          //console.log(['run generator to fill up _incoming buffer']);
          this._runGenerator();
        } else if (this._can_drain) {
          // perhaps a node stream is being piped in
          this._can_drain = false;
          this.emit("drain");
        }
      }
    } while (this._repeat_resume);
    this._resume_running = false;
  }

  /**
     * Resumes a paused Stream. This will either read from the Stream's incoming
     * buffer or request more data from an upstream source. Never call this method
     * on a stream that has been consumed (via a call to [consume](#consume) or any
     * other transform).
     *
     * @id resume
     * @section Stream Objects
     * @name Stream.resume()
     * @api public
     *
     * var xs = _(generator);
     * xs.resume();
     */

  resume() {
    this._resume(true);
  }

  /**
     * Pipes a Highland Stream to a [Node Writable
     * Stream](http://nodejs.org/api/stream.html#stream_class_stream_writable).
     * This will pull all the data from the source Highland Stream and write it to
     * the destination, automatically managing flow so that the destination is not
     * overwhelmed by a fast source.
     *
     * Users may optionally pass an object that may contain any of these fields:
     *
     * - `end` - Ends the destination when this stream ends. Default: `true`. This
     *   option has no effect if the destination is either `process.stdout` or
     *   `process.stderr`. Those two streams are never ended.
     *
     * Like [Readable#pipe](https://nodejs.org/api/stream.html#stream_readable_pipe_destination_options),
     * this function will throw errors if there is no `error` handler installed on
     * the stream.
     *
     * This function returns the destination so you can chain together `pipe` calls.
     *
     * **NOTE**: While Highland streams created via `_()` and [pipeline](#pipeline)
     * support being piped to, it is almost never appropriate to `pipe` from a
     * Highland stream to another Highland stream. Those two cases are meant for
     * use when piping from *Node* streams. You might be tempted to use `pipe` to
     * construct reusable transforms. Do not do it. See [through](#through) for a
     * better way.
     *
     * @id pipe
     * @section Consumption
     * @name Stream.pipe(dest, options)
     * @param {Writable Stream} dest - the destination to write all data to
     * @param {Object} options - (optional) pipe options.
     * @api public
     *
     * var source = _(generator);
     * var dest = fs.createWriteStream('myfile.txt')
     * source.pipe(dest);
     *
     * // chained call
     * source.pipe(through).pipe(dest);
     *
     * // DO NOT do this! It will not work. The stream returned by oddDoubler does
     * // not support being piped to.
     * function oddDoubler() {
     *     return _()
     *         return x % 2; // odd numbers only
     *     })
     *     .map(function (x) {
     *         return x * 2;
     *     });
     * }
     *
     * _([1, 2, 3, 4]).pipe(oddDoubler()) // => Garbage
     */
  pipe(dest: WritableStream, options?: { end?: boolean }) {
    options = options || {};

    // stdout and stderr are special case writables that cannot be closed
    const canClose = dest !== process.stdout && dest !== process.stderr &&
      options.end !== false;

    const end = canClose ? dest.end : nop;
    return pipeStream(this, dest, dest.write, end, false);
  }

  /**
     * Ends a Stream. This is the same as sending a [nil](#nil) value as data.
     * You shouldn't need to call this directly, rather it will be called by
     * any [Node Readable Streams](http://nodejs.org/api/stream.html#stream_class_stream_readable)
     * you pipe in.
     *
     * Only call this function on streams that were constructed with no source
     * (i.e., with `_()`).
     *
     * @id end
     * @section Stream Objects
     * @name Stream.end()
     * @api public
     *
     * mystream.end();
     */
  end() {
    if (this._nil_pushed) {
      // Allow ending multiple times.
      return;
    }

    this.write(nil);
  }

  /**
     * Destroys a stream by unlinking it from any consumers and sources. This will
     * stop all consumers from receiving events from this stream and removes this
     * stream as a consumer of any source stream.
     *
     * This function calls end() on the stream and unlinks it from any piped-to streams.
     *
     * @id destroy
     * @section Stream Objects
     * @name Stream.destroy()
     * @api public
     */
  destroy() {
    if (this.ended) {
      return;
    }

    if (!this._nil_pushed) {
      this.end();
    }

    this._onEnd();
  }

  /**
     * Runs the generator function for this Stream. If the generator is already
     * running (it has been called and not called next() yet) then this function
     * will do nothing.
     */
  _runGenerator() {
    //console.log(['_runGenerator', this.id]);

    // if _generator already running, exit
    if (this._generator_running) {
      return;
    }

    // if not all functions are set, exit
    if (!(this._generator && this._generator_push && this._generator_next)) {
      return;
    }

    this._generator_running = true;
    this._generator(this._generator_push, this._generator_next);
  }

  /**
     * Performs the redirect from one Stream to another. In order for the
     * redirect to happen at the appropriate time, it is put on the incoming
     * buffer as a StreamRedirect object, and this function is called
     * once it is read from the buffer.
     */
  _redirect(to) {
    //console.log(['_redirect', this.id, '=>', to.id]);
    // coerce to Stream
    to = new Stream(to);

    while (to._delegate) {
      to = to._delegate;
    }

    to._consumers = this._consumers.map(function (c) {
      c.source = to;
      return c;
    });

    // TODO: copy _observers
    this._consumers = [];
    //[this.consume = function () {
    //    return to.consume.apply(to, arguments);
    //};
    //this._removeConsumer = function () {
    //    return to._removeConsumer.apply(to, arguments);
    //};

    // this will cause a memory leak as long as the root object is around
    to._delegate_source = this._delegate_source || this;
    to._delegate_source._delegate = to;

    if (this.paused) {
      to.pause();
    } else {
      this.pause();
      to._checkBackPressure();
    }
  }

  /**
     * Adds a new consumer Stream, which will accept data and provide backpressure
     * to this Stream. Adding more than one consumer will cause an exception to be
     * thrown as the backpressure strategy must be explicitly chosen by the
     * developer (through calling fork or observe).
     */
  _addConsumer(s) {
    if (this._consumers.length) {
      throw new Error(
        "This stream has already been transformed or consumed. Please " +
          "fork() or observe() the stream if you want to perform " +
          "parallel transformations.",
      );
    }
    s.source = this;
    this._consumers.push(s);
    this._checkBackPressure();
  }

  /**
     * Removes a consumer from this Stream.
     */
  _removeConsumer(s) {
    let src = this;
    while (src._delegate) {
      src = src._delegate;
    }
    src._consumers = src._consumers.filter((c) => c !== s);
    if (s.source === src) {
      s.source = null;
    }
    src._checkBackPressure();
  }

  /**
     * Removes an observer from this Stream.
     */
  _removeObserver(s) {
    this._observers = this._observers.filter((o) => o !== s);
    if (s.source === this) {
      s.source = null;
    }
  }

  /**
     * Consumes values from a Stream (once resumed) and returns a new Stream for
     * you to optionally push values onto using the provided push / next functions.
     *
     * This function forms the basis of many higher-level Stream operations.
     * It will not cause a paused stream to immediately resume, but behaves more
     * like a 'through' stream, handling values as they are read.
     *
     * @id consume
     * @section Transforms
     * @name Stream.consume(f)
     * @param {Function} f - the function to handle errors and values
     * @api public
     *
     * var filter = function (f, source) {
     *     return source.consume(function (err, x, push, next) {
     *         if (err) {
     *             // pass errors along the stream and consume next value
     *             push(err);
     *             next();
     *         }
     *         else if (x === nil) {
     *             // pass nil (end event) along the stream
     *             push(null, x);
     *         }
     *         else {
     *             // pass on the value only if the value passes the predicate
     *             if (f(x)) {
     *                 push(null, x);
     *             }
     *             next();
     *         }
     *     });
     * };
     */
  consume(f) {
    let self = this;
    while (self._delegate) {
      self = self._delegate;
    }
    const s = new Stream();

    // Hack. Not needed in v3.0.
    s._is_consumer = true;

    let is_async: boolean;
    let next_called;
    const _send = s._send;
    const push = (err: Error, x) => {
      //console.log(['push', err, x, s.paused]);
      if (s._nil_pushed) {
        throw new Error("Cannot write to stream after nil");
      }
      if (x === nil) {
        // ended, remove consumer from source
        s._nil_pushed = true;
        s._consume_waiting_for_next = false;
        self._removeConsumer(s);

        // We previously paused the stream, but since a nil was pushed,
        // next won't be called and we must manually resume.
        if (is_async) {
          s._resume(false);
        }
      }
      if (s.paused) {
        s._outgoing.push(err ? new StreamError(err) : x);
      } else {
        _send.call(s, err, x);
      }
    };
    const next = (s2) => {
      //console.log(['next', is_async]);
      s._consume_waiting_for_next = false;
      if (s._nil_pushed) {
        throw new Error("Cannot call next after nil");
      }
      if (s2) {
        // we MUST pause to get the redirect object into the _incoming
        // buffer otherwise it would be passed directly to _send(),
        // which does not handle StreamRedirect objects!
        var _paused = s.paused;
        if (!_paused) {
          s.pause();
        }
        s.write(new StreamRedirect(s2));
        if (!_paused) {
          s._resume(false);
        }
      } else if (is_async) {
        s._resume(false);
      } else {
        next_called = true;
      }
    };
    s._send = (err: Error, x) => {
      is_async = false;
      next_called = false;
      s._in_consume_cb = true;

      f(err, x, push, next);

      s._in_consume_cb = false;
      is_async = true;

      // Don't pause if x is nil -- as next will never be called after
      if (!next_called && x !== nil) {
        s._consume_waiting_for_next = true;
        s.pause();
      }

      if (s._repeat_resume) {
        s._repeat_resume = false;
        s._resume(false);
      }
    };
    self._addConsumer(s);
    self._already_consumed = true;
    return s;
  }

  /**
     * Consumes a single item from the Stream. Unlike consume, this function will
     * not provide a new stream for you to push values onto, and it will unsubscribe
     * as soon as it has a single error, value or nil from the source.
     *
     * You probably won't need to use this directly, but it is used internally by
     * some functions in the Highland library.
     *
     * @id pull
     * @section Consumption
     * @name Stream.pull(f)
     * @param {Function} f - the function to handle data
     * @api public
     *
     * xs.pull(function (err, x) {
     *     // do something
     * });
     */
  pull(f) {
    const s = this.consume((err: Error, x) => {
      s.source._removeConsumer(s);
      f(err, x);
    });
    s.id = "pull:" + s.id;
    s.resume();
  }

  /**
     * Forks a stream, allowing you to add additional consumers with shared
     * back-pressure. A stream forked to multiple consumers will pull values, *one
     * at a time*, from its source as only fast as the slowest consumer can handle
     * them.
     *
     * **NOTE**: Do not depend on a consistent execution order between the forks.
     * This transform only guarantees that all forks will process a value `foo`
     * before any will process a second value `bar`. It does *not* guarantee the
     * order in which the forks process `foo`.
     *
     * **TIP**: Be careful about modifying stream values within the forks (or using
     * a library that does so). Since the same value will be passed to every fork,
     * changes made in one fork will be visible in any fork that executes after it.
     * Add to that the inconsistent execution order, and you can end up with subtle
     * data corruption bugs. If you need to modify any values, you should make a
     * copy and modify the copy instead.
     *
     * *Deprecation warning:* It is currently possible to `fork` a stream after
     * [consuming](#consume) it (e.g., via a [transform](#Transforms)). This will
     * no longer be possible in the next major release. If you are going to `fork`
     * a stream, always call `fork` on it.
     *
     * @id fork
     * @section Higher-order Streams
     * @name Stream.fork()
     * @api public
     *
     * function delay(x, ms) {
     *   return _((push) => {
     *     setTimeout(() => {
     *       push(null, x);
     *       push(null, nil);
     *     }, ms);
     *   });
     * }
     *
     * const then = Date.now();
     *
     * const source = _([1, 2, 3, 4])
     *     .tap((x) => console.log(`source: ${x} (${Date.now() - then})`));
     * const fork1 = source.fork().flatMap((x) => delay(x, 1000));
     * const fork2 = source.fork().flatMap((x) => delay(x, 2000));
     *
     * // No values will be pulled from source until fork2 also starts consuming.
     * fork1.each((x) => console.log(`fork1 : ${x} (${Date.now() - then})`));
     *
     * // Now both fork1 and fork2 will get values from source as fast as they both
     * // can process them.
     * fork2.each((x) => console.log(`fork2 : ${x} (${Date.now() - then})`));
     *
     * // =>
     * // source: 1 (3)
     * // fork1 : 1 (1014)
     * // fork2 : 1 (2011)
     * // source: 2 (2011)
     * // fork1 : 2 (3012)
     * // fork2 : 2 (4012)
     * // source: 3 (4013)
     * // fork1 : 3 (5014)
     * // fork2 : 3 (6020)
     * // source: 4 (6020)
     * // fork1 : 4 (7024)
     * // fork2 : 4 (8032)
     */
  fork() {
    if (this._already_consumed) {
      // Trigger deprecation warning.
      warnForkAfterConsume();
    }

    const s = new Stream();
    s.id = "fork:" + s.id;
    s.source = this;
    this._consumers.push(s);
    this._checkBackPressure();
    return s;
  }

  /**
     * Observes a stream, allowing you to handle values as they are emitted,
     * without adding back-pressure or causing data to be pulled from the source.
     * Unlike [forks](#fork), observers are passive. They don't affect each other
     * or the source stream. They only observe data as the source stream emits
     * them.
     *
     * Observers will buffer data that it sees from the source, so an observer that
     * cannot process the data as fast as the source produces it can end up
     * consuming a lot of memory.
     *
     * @id observe
     * @section Higher-order Streams
     * @name Stream.observe()
     * @api public
     *
     * function delay(x, ms) {
     *   return _((push) => {
     *     setTimeout(() => {
     *       push(null, x);
     *       push(null, nil);
     *     }, ms);
     *   });
     * }
     *
     * const then = Date.now();
     *
     * const source = _([1, 2, 3, 4])
     *     .tap((x) => console.log(`source: ${x} (${Date.now() - then})`));
     * const obs = source.observe().flatMap((x) => delay(x, 1000));
     * const main = source.flatMap((x) => delay(x, 10));
     *
     * // obs will not receive any data yet, since it is only a passive
     * // observer.
     * obs.each((x) => console.log(`obs   : ${x} (${Date.now() - then})`));
     *
     * // Now both obs and main will receive data as fast as main can handle it.
     * // Even though since obs is very slow, main will still receive all of the
     * // source's data.
     * main.each((x) => console.log(`main  : ${x} (${Date.now() - then})`));
     *
     * // =>
     * // source: 1 (3)
     * // main  : 1 (21)
     * // source: 2 (22)
     * // main  : 2 (33)
     * // source: 3 (37)
     * // main  : 3 (47)
     * // source: 4 (47)
     * // main  : 4 (57)
     * // obs   : 1 (1010)
     * // obs   : 2 (2012)
     * // obs   : 3 (3018)
     * // obs   : 4 (4052)
     */
  observe() {
    const s = new Stream();
    s.id = "observe:" + s.id;
    s.source = this;
    s._is_observer = true;
    this._observers.push(s);
    return s;
  }

  /**
     * Extracts errors from a Stream and applies them to an error handler
     * function. Returns a new Stream with the errors removed (unless the error
     * handler chooses to rethrow them using `push`). Errors can also be
     * transformed and put back onto the Stream as values.
     *
     * @id errors
     * @section Transforms
     * @name Stream.errors(f)
     * @param {Function} f - the function to pass all errors to
     * @api public
     *
     * getDocument.errors(function (err, push) {
     *     if (err.statusCode === 404) {
     *         // not found, return empty doc
     *         push(null, {});
     *     }
     *     else {
     *         // otherwise, re-throw the error
     *         push(err);
     *     }
     * });
     */
  errors(f) {
    return this.consume((err, x, push, next) => {
      if (err) {
        f(err, push);
        next();
        return;
      }
      if (x === nil) {
        push(null, nil);
        return;
      }
      push(null, x);
      next();
    });
  }

  /**
     * Like the [errors](#errors) method, but emits a Stream end marker after
     * an Error is encountered.
     *
     * @id stopOnError
     * @section Transforms
     * @name Stream.stopOnError(f)
     * @param {Function} f - the function to handle an error
     * @api public
     *
     * brokenStream.stopOnError(function (err) {
     *     //console.error('Something broke: ' + err);
     * });
     */
  stopOnError(f) {
    return this.consume((err, x, push, next) => {
      if (err) {
        f(err, push);
        push(null, nil);
        return;
      }
      if (x === nil) {
        push(null, nil);
        return;
      }
      push(null, x);
      next();
    });
  }

  /**
     * Iterates over every value from the Stream, calling the iterator function
     * on each of them. This method consumes the Stream.
     *
     * If an error from the Stream reaches this call, it will emit an `error` event
     * (i.e., it will call `emit('error')` on the stream being consumed).  This
     * event will cause an error to be thrown if unhandled.
     *
     * While `each` consumes the stream, it is possible to chain [done](#done) (and
     * *only* `done`) after it.
     *
     * @id each
     * @section Consumption
     * @name Stream.each(f)
     * @param {Function} f - the iterator function
     * @api public
     *
     * _([1, 2, 3, 4]).each(function (x) {
     *     // will be called 4 times with x being 1, 2, 3 and 4
     * });
     */

  each(f) {
    const s = this.consume((err, x, push, next) => {
      if (err) {
        this.emit("error", err);
        return;
      }
      if (x === nil) {
        push(null, nil);
        return;
      }
      f(x);
      next();
    });

    s.resume();
    return s;
  }

  /**
     * Applies all values from a Stream as arguments to a function. This method consumes the stream.
     * `f` will always be called when the `nil` token is encountered, even when the stream is empty.
     *
     * @id apply
     * @section Consumption
     * @name Stream.apply(f)
     * @param {Function} f - the function to apply arguments to
     * @api public
     *
     * _([1, 2, 3]).apply(function (a, b, c) {
     *     // a === 1
     *     // b === 2
     *     // c === 3
     * });
     *
     * _([1, 2, 3]).apply(function (a) {
     *     // arguments.length === 3
     *     // a === 1
     * });
     */
  apply(f) {
    return this.toArray((args) => f(...args));
  }

  /**
     * Collects all values from a Stream into an Array and calls a function with
     * the result. This method consumes the stream.
     *
     * If an error from the Stream reaches this call, it will emit an `error` event
     * (i.e., it will call `emit('error')` on the stream being consumed).  This
     * event will cause an error to be thrown if unhandled.
     *
     * @id toArray
     * @section Consumption
     * @name Stream.toArray(f)
     * @param {Function} f - the callback to provide the completed Array to
     * @api public
     *
     * _([1, 2, 3, 4]).toArray(function (x) {
     *     // parameter x will be [1,2,3,4]
     * });
     */
  toArray<R>(f: (array: Array<R>) => void) {
    return this.collect().pull((err: Error, x: Array<R>) => {
      if (err) {
        this.emit("error", err);
      } else {
        f(x);
      }
    });
  }

  /**
     * Calls a function once the Stream has ended. This method consumes the stream.
     * If the Stream has already ended, the function is called immediately.
     *
     * If an error from the Stream reaches this call, it will emit an `error` event
     * (i.e., it will call `emit('error')` on the stream being consumed).  This
     * event will cause an error to be thrown if unhandled.
     *
     * As a special case, it is possible to chain `done` after a call to
     * [each](#each) even though both methods consume the stream.
     *
     * @id done
     * @section Consumption
     * @name Stream.done(f)
     * @param {Function} f - the callback
     * @api public
     *
     * var total = 0;
     * _([1, 2, 3, 4]).each(function (x) {
     *     total += x;
     * }).done(function () {
     *     // total will be 10
     * });
     */
  done<R>(f: Function) {
    if (this.ended) {
      f();
      return null;
    }
    return this.consume((err: Error, x: R | Nil, push, next: Function) => {
      if (err) {
        this.emit("error", err);
      } else if (x === nil) {
        f();
      } else {
        next();
      }
    }).resume();
  }

  /**
     * Returns the result of a stream to a nodejs-style callback function.
     *
     * If the stream contains a single value, it will call `cb`
     * with the single item emitted by the stream (if present).
     * If the stream is empty, `cb` will be called without any arguments.
     * If an error is encountered in the stream, this function will stop
     * consumption and call `cb` with the error.
     * If the stream contains more than one item, it will stop consumption
     * and call `cb` with an error.
     *
     * @id toCallback
     * @section Consumption
     * @name Stream.toCallback(cb)
     * @param {Function} cb - the callback to provide the error/result to
     * @api public
     *
     * _([1, 2, 3, 4]).collect().toCallback(function (err, result) {
     *     // parameter result will be [1,2,3,4]
     *     // parameter err will be null
     * });
     */
  toCallback(cb) {
    this.consume(toCallbackHandler("toCallback", cb)).resume();
  }

  /**
     * Converts the result of a stream to Promise.
     *
     * If the stream contains a single value, it will return
     * with the single item emitted by the stream (if present).
     * If the stream is empty, `undefined` will be returned.
     * If an error is encountered in the stream, this function will stop
     * consumption and call `cb` with the error.
     * If the stream contains more than one item, it will stop consumption
     * and reject with an error.
     *
     * @id toPromise
     * @section Consumption
     * @name Stream.toPromise(PromiseCtor)
     * @param {Function} PromiseCtor - Promises/A+ compliant constructor
     * @api public
     *
     * _([1, 2, 3, 4]).collect().toPromise(Promise).then(function (result) {
     *     // parameter result will be [1,2,3,4]
     * });
     */
  toPromise<R>(PromiseCtor = Promise) {
    const hasValue = <T>(err?: Error | null, value?: T): value is T => !err;

    return new PromiseCtor(
      (
        resolve: (value: (PromiseLike<R> | R)) => void,
        reject: (reason?: any) => void,
      ) => {
        this.consume(
          toCallbackHandler("toPromise", (err?: Error | null, res?: R) => {
            if (hasValue(err, res)) {
              resolve(res);
            } else {
              reject(err);
            }
          }),
        ).resume();
      },
    );
  }

  /**
     * Converts the stream to a node Readable Stream for use in methods
     * or pipes that depend on the native stream type.
     *
     * The options parameter can be an object passed into the [`Readable`
     * constructor](http://nodejs.org/api/stream.html#stream_class_stream_readable).
     *
     * @id toNodeStream
     * @section Consumption
     * @name Stream.toNodeStream(options)
     * @param {Object} options - (optional) [`Readable` constructor](http://nodejs.org/api/stream.html#stream_class_stream_readable) options
     * @api public
     *
     * _(fs.createReadStream('./abc')).toNodeStream()
     * _(fs.createReadStream('./abc')).toNodeStream({objectMode: false})
     * _([{a: 1}]).toNodeStream({objectMode: true})
     */
  toNodeStream(options?: ReadableOptions) {
    return new Readable(options).wrap(this);
  }

  /**
     * Creates a new Stream of transformed values by applying a function to each
     * value from the source. The transformation function can be replaced with
     * a non-function value for convenience, and it will emit that value
     * for every data event on the source Stream.
     *
     * *Deprecation warning:* The use of the convenience non-function argument for
     * `map` is deprecated and will be removed in the next major version.
     *
     * @id map
     * @section Transforms
     * @name Stream.map(f)
     * @param {Function} f - the transformation function or value to map to
     * @api public
     *
     * var doubled = _([1, 2, 3, 4]).map(function (x) {
     *     return x * 2;
     * });
     */
  map(f) {
    if (!isFunction(f)) {
      warnMapWithValue();
      const val = f;
      f = function () {
        return val;
      };
    }
    return this.consume((err?: Error, x, push, next) => {
      if (err) {
        push(err);
        next();
        return;
      }

      if (x === nil) {
        push(err, x);
        return;
      }

      let fnVal, fnErr;
      try {
        fnVal = f(x);
      } catch (e) {
        fnErr = e;
      }
      push(fnErr, fnVal);
      next();
    });
  }

  /**
     * Creates a new Stream which applies a function to each value from the source
     * and re-emits the source value. Useful when you want to mutate the value or
     * perform side effects
     *
     * @id doto
     * @section Transforms
     * @name Stream.doto(f)
     * @param {Function} f - the function to apply
     * @api public
     *
     * var appended = _([[1], [2], [3], [4]]).doto(function (x) {
     *     x.push(1);
     * });
     *
     * _([1, 2, 3]).doto(console.log)
     * // 1
     * // 2
     * // 3
     * // => 1, 2, 3
     */
  doto(f) {
    return this.map((x) => {
      f(x);
      return x;
    });
  }

  /**
     * An alias for the [doto](#doto) method.
     *
     * @id tap
     * @section Transforms
     * @name Stream.tap(f)
     * @param {Function} f - the function to apply
     * @api public
     *
     * _([1, 2, 3]).tap(console.log)
     */
  tap = this.doto;

  /**
     * Limits number of values through the stream to a maximum of number of values
     * per window. Errors are not limited but allowed to pass through as soon as
     * they are read from the source.
     *
     * @id ratelimit
     * @section Transforms
     * @name Stream.ratelimit(num, ms)
     * @param {Number} num - the number of operations to perform per window
     * @param {Number} ms - the window of time to limit the operations in (in ms)
     * @api public
     *
     * _([1, 2, 3, 4, 5]).ratelimit(2, 100);
     *
     * // after 0ms => 1, 2
     * // after 100ms => 1, 2, 3, 4
     * // after 200ms => 1, 2, 3, 4, 5
     */
  ratelimit(num: number, ms: number) {
    if (num < 1) {
      throw new Error("Invalid number of operations per ms: " + num);
    }

    let sent = 0;
    return this.consume((err?: Error, x, push, next) => {
      if (err) {
        push(err);
        next();
        return;
      }

      if (x === nil) {
        push(null, nil);
        return;
      }

      if (sent < num) {
        sent++;
        push(null, x);
        next();
        return;
      }

      setTimeout(() => {
        sent = 1;
        push(null, x);
        next();
      }, ms);
    });
  }

  /**
     * Creates a new Stream of values by applying each item in a Stream to an
     * iterator function which must return a (possibly empty) Stream. Each item on
     * these result Streams are then emitted on a single output Stream.
     *
     * This transform is functionally equivalent to `.map(f).sequence()`.
     *
     * @id flatMap
     * @section Higher-order Streams
     * @name Stream.flatMap(f)
     * @param {Function} f - the iterator function
     * @api public
     *
     * var readFile = _.wrapCallback(fs.readFile);
     * filenames.flatMap(readFile)
     */
  flatMap(f) {
    return this.map(f).sequence();
  }

  /**
     * Retrieves values associated with a given property from all elements in
     * the collection.
     *
     * @id pluck
     * @section Transforms
     * @name Stream.pluck(property)
     * @param {String} prop - the property to which values should be associated
     * @api public
     *
     * var docs = [
     *     {type: 'blogpost', title: 'foo'},
     *     {type: 'blogpost', title: 'bar'},
     *     {type: 'comment', title: 'baz'}
     * ];
     *
     * _(docs).pluck('title').toArray(function (xs) {
     *    // xs is now ['foo', 'bar', 'baz']
     * });
     */
  pluck<T>(prop: string) {
    return this.consume(
      (
        err: Error | undefined,
        x: Record<string, unknown> | Nil,
        push,
        next,
      ) => {
        if (err) {
          push(err);
          next();
          return;
        }

        if (x === nil) {
          push(err, x);
          return;
        }

        if (isObject(x)) {
          push(null, x[prop]);
          next();
          return;
        }

        push(
          new Error(
            "Expected Object, got " + (typeof x),
          ),
        );
        next();
      },
    );
  }

  /**
     * Only applies the transformation strategy on Objects.
     * This helper is used in `pick` and `pickBy`
     **/
  static objectOnly = curry((strategy, x) => {
    if (isObject(x)) {
      return strategy(x);
    } else {
      throw new Error(
        "Expected Object, got " + (typeof x),
      );
    }
  });

  /**
     *
     * Retrieves copies of all the elements in the collection
     * that satisfy a given predicate. Note: When using ES3,
     * only enumerable elements are selected. Both enumerable
     * and non-enumerable elements are selected when using ES5.
     *
     * @id pickBy
     * @section Transforms
     * @name Stream.pickBy(f)
     * @param {Function} f - the predicate function
     * @api public
     *
     *  var dogs = [
     *      {breed: 'chihuahua', name: 'Princess', age: 5},
     *      {breed: 'labrador', name: 'Rocky', age: 3},
     *      {breed: 'german-shepherd', name: 'Waffles', age: 9}
     *  ];

     *  _(dogs).pickBy(function (key, value) {
     *      return value > 4;
     *  }).toArray(function (xs) {
     *    // xs is now:
     *    [
     *      { age: 5 },
     *      {},
     *      { age: 9 }
     *    ]
     *  });
     */
  pickBy(f) {
    return this.map(objectOnly((x: Record<string, any>) => {
      const out: Record<string, any> = {};

      // prevents testing overridden properties multiple times.
      const seen = new Set<string>();
      const testAndAdd = (prop: string) => {
        if (!seen.has(prop) && f(prop, x[prop])) {
          out[prop] = x[prop];
          seen.add(prop);
        }
      };
      for (const k in x) {
        testAndAdd(k);
      }
      return out;
    }));
  }

  /**
     *
     * Retrieves copies of all elements in the collection,
     * with only the whitelisted keys. If one of the whitelisted
     * keys does not exist, it will be ignored.
     *
     * @id pick
     * @section Transforms
     * @name Stream.pick(properties)
     * @param {Array} properties - property names to white filter
     * @api public
     *
     * var dogs = [
     *      {breed: 'chihuahua', name: 'Princess', age: 5},
     *      {breed: 'labrador', name: 'Rocky', age: 3},
     *      {breed: 'german-shepherd', name: 'Waffles', age: 9}
     * ];
     *
     * _(dogs).pick(['breed', 'age']).toArray(function (xs) {
     *       // xs is now:
     *       [
     *           {breed: 'chihuahua', age: 5},
     *           {breed: 'labrador', age: 3},
     *           {breed: 'german-shepherd', age: 9}
     *       ]
     * });
     *
     * _(dogs).pick(['owner']).toArray(function (xs) {
     *      // xs is now:
     *      [
     *          {},
     *          {},
     *          {}
     *      ]
     * });*/
  pick(properties) {
    return this.map(
      objectOnly(
        (x) =>
          properties
            .filter((p) => (p in x))
            .map((p) => x[p]),
      ),
    );
  }

  /**
     * Creates a new Stream that includes only the values that pass a truth test.
     *
     * @id filter
     * @section Transforms
     * @name Stream.filter(f)
     * @param {Function} f - the truth test function
     * @api public
     *
     * var evens = _([1, 2, 3, 4]).filter(function (x) {
     *     return x % 2 === 0;
     * });
     */
  filter(f) {
    return this.consume((err?: Error, x, push, next) => {
      if (err) {
        push(err);
        next();
        return;
      }
      if (x === nil) {
        push(err, x);
        return;
      }

      let fnVal, fnErr;
      try {
        fnVal = f(x);
      } catch (e) {
        fnErr = e;
      }

      if (fnErr) {
        push(fnErr);
      } else if (fnVal) {
        push(null, x);
      }
      next();
    });
  }

  /**
     * Filters using a predicate which returns a Stream. If you need to check
     * against an asynchronous data source when filtering a Stream, this can
     * be convenient. The Stream returned from the filter function should have
     * a Boolean as its first value (all other values on the Stream will be
     * disregarded).
     *
     * @id flatFilter
     * @section Higher-order Streams
     * @name Stream.flatFilter(f)
     * @param {Function} f - the truth test function which returns a Stream
     * @api public
     *
     * var checkExists = _.wrapCallback(fs.access);
     *
     * filenames.flatFilter(checkExists)
     */
  flatFilter(f) {
    return this.flatMap((x) =>
      f(x)
        .take(1)
        .otherwise(errorStream())
        .flatMap((bool) => _(bool ? [x] : []))
    );

    function errorStream() {
      return _((push) => {
        push(new Error("Stream returned by function was empty."));
        push(null, nil);
      });
    }
  }
}
