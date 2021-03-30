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
    return this.consume((err: Error | undefined, x, push, next) => {
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
  reject(f) {
    return this.filter(_.compose(_.not, f));
  }

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
  find(f) {
    return this.filter(f).take(1);
  }

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
  findWhere(props) {
    return this.where(props).take(1);
  }

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
  group<R>(f: ((r: R) => string) | string) {
    const lambda = isString(f) ? _.get(f) : f;
    return this.reduce({}, (m, o) => {
      const key = lambda(o);
      if (!m.hasOwnProperty(key)) {
        m[key] = [];
      }
      m[key].push(o);
      return m;
    });
  }

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
  compact() {
    return this.filter((x) => !!x);
  }

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
  where(props) {
    return this.filter((x) => {
      for (const k in props) {
        if (x[k] !== props[k]) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Filters out all duplicate values from the stream and keeps only the first
   * occurrence of each value, using the provided function to define equality.
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

  uniqBy<R>(compare) {
    const uniques = [];
    return this.consume(
      (
        err: Error | undefined,
        x: InternalValue<R>,
        push: ValueGeneratorPush<R>,
        next: ValueGeneratorNext<R>,
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

        let seen = false;
        let hasErr;
        for (let i = 0, len = uniques.length; i < len; i++) {
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
      },
    );
  }

  /**
   * Filters out all duplicate values from the stream and keeps only the first
   * occurrence of each value, using `===` to define equality.
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
  uniq<R>() {
    const uniques: Set<R> = new Set<R>();
    let size = uniques.size;

    return this.consume(
      (
        err: Error | undefined,
        x: InternalValue<R>,
        push: ValueGeneratorPush<R>,
        next: ValueGeneratorNext<R>,
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

        // pass NaN through as Set does not respect strict equality in this case.
        if (x !== x) {
          push(null, x);
          next();
          return;
        }

        uniques.add(x);
        if (uniques.size > size) {
          size = uniques.size;
          push(null, x);
        }
        next();
      },
    );
  }

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
  zipAll0<R>() {
    let returned = 0;
    let z = [];
    let finished = false;

    const nextValue = (
      index: number,
      max: number,
      src: Stream<R>,
      push: ValueGeneratorPush<R>,
      next: ValueGeneratorNext<R>,
    ) => {
      src.pull((err: Error | undefined, x: R | Nil) => {
        if (err) {
          push(err);
          nextValue(index, max, src, push, next);
          return;
        }

        if (x === nil) {
          if (!finished) {
            finished = true;
            push(null, nil);
          }
          return;
        }

        returned++;
        z[index] = x;
        if (returned === max) {
          push(null, z);
          next();
        }
      });
    };

    return this.collect().flatMap((array) => {
      if (!array.length) {
        return _([]);
      }

      return _((push: ValueGeneratorPush<R>, next: ValueGeneratorNext<R>) => {
        returned = 0;
        z = [];
        const length = array.length;
        array.forEach((item) => nextValue(i, length, item, push, next));
      });
    });
  }

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

  zipAll(ys) {
    return _([this]).concat(_(ys).map(_)).zipAll0();
  }

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

  zip(ys) {
    return _([this, _(ys)]).zipAll0();
  }

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

  batch(n) {
    return this.batchWithTimeOrCount(-1, n);
  }

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
  batchWithTimeOrCount(ms, n) {
    let batched = [];
    let timeout;

    return this.consume(
      (
        err: Error | undefined,
        x,
        push: ValueGeneratorPush<R>,
        next: ValueGeneratorNext<R>,
      ) => {
        if (err) {
          push(err);
          next();
          return;
        }

        if (x === nil) {
          if (batched.length > 0) {
            push(null, batched);
            clearTimeout(timeout);
          }

          push(null, nil);
          return;
        }

        batched.push(x);

        if (batched.length === n) {
          push(null, batched);
          batched = [];
          clearTimeout(timeout);
        } else if (batched.length === 1 && ms >= 0) {
          timeout = setTimeout(() => {
            push(null, batched);
            batched = [];
          }, ms);
        }

        next();
      },
    );
  }

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

  intersperse(separator) {
    let started = false;
    return this.consume(
      (
        err: Error | undefined,
        x: R | Nil,
        push: ValueGeneratorPush<R>,
        next: ValueGeneratorNext<R>,
      ) => {
        if (err) {
          push(err);
          next();
          return;
        }

        if (x === nil) {
          push(null, nil);
          return;
        }

        if (started) {
          push(null, separator);
        } else {
          started = true;
        }
        push(null, x);
        next();
      },
    );
  }

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
  splitBy<R>(sep) {
    const decoder = new Decoder();
    let buffer = false;

    const drain = (x: R, push: ValueGeneratorPush<R>) => {
      buffer = (buffer || "") + decoder.write(x);
      const pieces = buffer.split(sep);
      buffer = pieces.pop();

      pieces.forEach((piece) => push(null, piece));
    };

    return this.consume(
      (
        err: Error | undefined,
        x: R | Nil,
        push: ValueGeneratorPush<R>,
        next: ValueGeneratorNext<R>,
      ) => {
        if (err) {
          push(err);
          next();
          return;
        }

        if (x === nil) {
          if (isString(buffer)) {
            drain(decoder.end(), push);
            push(null, buffer);
          }
          push(null, nil);
          return;
        }

        drain(x, push);
        next();
      },
    );
  }

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
  split() {
    return this.splitBy(/\r?\n/);
  }

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
   * @param {Number} end - integer representing index to stop reading from source (exclusive)
   * @api public
   *
   * _([1, 2, 3, 4]).slice(1, 3) // => 2, 3
   */
  slice<R>(start: number | undefined, end?: number) {
    start = (typeof start != "number" || start < 0) ? 0 : start;
    end = typeof end != "number" ? Infinity : end;

    if (start === 0 && end === Infinity) {
      return this;
    }

    if (start >= end) {
      return _([]);
    }

    let index = 0;
    const s = this.consume(
      (
        err: Error | undefined,
        x: R | Nil,
        push: ValueGeneratorPush<R>,
        next: ValueGeneratorNext<R>,
      ) => {
        let done = x === nil;
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
      },
    );
    s.id = "slice:" + s.id;
    return s;
  }

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
  take(n: number) {
    const s = this.slice(0, n);
    s.id = "take:" + s.id;
    return s;
  }

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
  drop(n: number) {
    return this.slice(n, Infinity);
  }

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
  head() {
    return this.take(1);
  }

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
  last<R>() {
    const nothing = {};
    let prev = nothing;
    return this.consume(
      (
        err: Error | undefined,
        x: R | Nil,
        push: ValueGeneratorPush<R>,
        next: ValueGeneratorNext<R>,
      ) => {
        if (err) {
          push(err);
          next();
          return;
        }

        if (x === nil) {
          if (prev !== nothing) {
            push(null, prev);
          }
          push(null, nil);
          return;
        }

        prev = x;
        next();
      },
    );
  }

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
  sortBy<R>(f?: (a: R, b: R) => number) {
    return this.collect().invoke("sort", [f]).sequence();
  }

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
  sort() {
    return this.sortBy();
  }

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
  through(target) {
    if (isFunction(target)) {
      return target(this);
    }

    const writeErr = (err: Error) => output.write(new StreamError(err));
    const output = _();
    this.on("error", writeErr);
    target.on("error", writeErr);

    // Intentionally bypass this.pipe so that through() and pipe() can
    // evolve independently of each other.
    return pipeStream(this, target, target.write, target.end, false).pipe(
      output,
    );
  }

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
  sequence<R>() {
    const original = this;
    let curr = this;
    const onOriginalStream = () => curr === original;

    return _((push: ValueGeneratorPush<R>, next: ValueGeneratorNext<R>) => {
      curr.pull((err: Error | undefined, x: R | Nil) => {
        if (err) {
          push(err);
          next();
          return;
        }

        if (_.isArray(x)) {
          if (onOriginalStream()) {
            // just send all values from array directly
            x.forEach(function (y) {
              push(null, y);
            });
          } else {
            push(null, x);
          }
          next();
          return;
        }

        if (_.isStream(x)) {
          if (onOriginalStream()) {
            // switch to reading new stream
            curr = x;
            next();
            return;
          }

          // sequence only goes 1 level deep
          push(null, x);
          next();
          return;
        }

        if (x === nil) {
          if (onOriginalStream()) {
            push(null, nil);
            return;
          }

          // resume reading from original
          curr = original;
          next();
          return;
        }

        if (onOriginalStream()) {
          // we shouldn't be getting non-stream (or array) values from the top-level stream
          push(new Error("Expected Stream, got " + (typeof x)));
          next();
          return;
        }

        push(null, x);
        next();
      });
    });
  }

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
  series = this.sequence;

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
  flatten<R>() {
    let curr = this;
    const stack = [];
    return _((push: ValueGeneratorPush<R>, next: ValueGeneratorNext<R>) => {
      curr.pull((err: Error | undefined, x: R | Nil) => {
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
          return;
        }

        if (x === nil) {
          if (stack.length) {
            curr = stack.pop();
            next();
          } else {
            push(null, nil);
          }
          return;
        }

        push(null, x);
        next();
      });
    });
  }

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
  parallel(n) {
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
  } /**
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

  otherwise(ys) {
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
  } /**
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

  append(y) {
    return this.consume(function (err, x, push, next) {
      if (x === nil) {
        push(null, y);
        push(null, nil);
      } else {
        push(err, x);
        next();
      }
    });
  } /**
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

  reduce(z, f) {
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
  } /**
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

  reduce1(f) {
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
  } /**
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

  collect() {
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
  } /**
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

  scan(z, f) {
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
  } /**
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

  scan1(f) {
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
  } /**
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

  transducetransduce(xf) {
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
  } /**
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

  concat(ys) {
    ys = _(ys);
    return this.consume(function (err, x, push, next) {
      if (x === nil) {
        next(ys);
      } else {
        push(err, x);
        next();
      }
    });
  } /**
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

  merge() {
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
  } /**
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

  mergeWithLimit(n) {
    var self = this;
    var processCount = 0;
    var waiting = false;
    if (typeof n !== "number" || n < 1) {
      throw new Error(
        "mergeWithLimit expects a positive number, but got: " + n,
      );
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
  } /**
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

  invoke(method, args) {
    return this.map(function (x) {
      return x[method].apply(x, args);
    });
  } /**
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

  nfcall(args) {
    return this.map(function (x) {
      return _.wrapCallback(x).apply(x, args);
    });
  } /**
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

  throttle(ms) {
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
  } /**
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

  debounce(ms) {
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
  } /**
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

  latest() {
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
  }
}
