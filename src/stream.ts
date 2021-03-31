import { EventEmitter } from "https://deno.land/std@0.91.0/node/events.ts";
import { setImmediate } from "https://deno.land/std@0.91.0/node/timers.ts";
import { isUndefined } from "./index.ts";
import { nil } from "./interfaces.ts";
import { InternalValue } from "./internal-value.ts";

const bindContext = <T>(fn: () => T, context: any): () => T =>
  (...args: any) => fn.apply(context, args);

export type ValueGenerator<R> = (
  push: ValueGeneratorPush<R>,
  next: ValueGeneratorNext<R>,
) => void;

export type ValueGeneratorPush<R> = <R>(
  err: (Error | null | undefined),
  x: R,
) => void;

export type ValueGeneratorNext<R> = <R>(s?: Stream<R>) => void;

/**
 * Actual Stream constructor wrapped the the main exported function
 */
export class Stream<R> extends EventEmitter {
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
  private _destructors: Array<Function> = [];
  private _in_consume_cb: boolean = false;
  private _incoming: Array<InternalValue<R>> = [];
  private _is_consumer: boolean = false;
  private _is_observer: boolean = false;
  private _nil_pushed: boolean = false;
  private _outgoing: Array<void> = [];
  private _repeat_resume: boolean = false;
  private _resume_running: boolean = false;
  private _send_events: boolean = false;
  private ended: boolean = false;

  /**
     * used to detect Highland Streams using isStream(x), this
     * will work even in cases where npm has installed multiple
     * versions, unlike an instanceof check
     */
  readonly __HighlandStream__: boolean = true;
  _consumers: Array<Stream<R> | this> = [];
  _delegate?: Stream<R> | this;
  _observers: Array<Stream<R> | this> = [];
  id: string = ("" + Math.random()).substr(2, 6);
  paused: boolean = true;
  source?: Stream<R>;

  constructor(xs?: Array<R>) {
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

    throw new Error(
      "Unexpected argument type to Stream(): " + (typeof xs),
    );
  }

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

    // The check for _is_consumer is kind of a hack. Not needed in v3.0.
    if (x === nil && !this._is_consumer) {
      this._nil_pushed = true;
    }

    if (this.paused) {
      this._incoming.push(x);
    } else {
      this._send(null, x);
    }

    if (this.paused) {
      this._can_drain = true;
    }

    return !this.paused;
  }

  _resume(forceResumeSource: boolean) {
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
        } else {
          if (this._can_drain) {
            // perhaps a node stream is being piped in
            this._can_drain = false;
            this.emit("drain");
          }
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
     * Starts pull values out of the incoming buffer and sending them downstream,
     * this will exit early if this causes a downstream consumer to pause.
     */
  _readFromBuffer() {
    const len = this._incoming.length;
    let i = 0;

    while (i < len && !this.paused) {
      const x = this._incoming[i];
      this._send(null, x);
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
      Stream.prototype._send.call(this, null, x);
      i++;
    }
    // remove processed data from _outgoing buffer
    this._outgoing.splice(0, i);
  }

  /**
     * Sends errors / data to consumers, observers and event handlers
     */
  _send(err: Error | null | undefined, x?: InternalValue<R>) {
    if (x) {
      if (this._consumers.length) {
        const token = x;
        // this._consumers may be changed from under us, so we keep a copy.
        const consumers = [...this._consumers];
        consumers.forEach((consumer) => consumer.write(token));
      }
      if (this._observers.length) {
        const token = x;
        // this._observers may be changed from under us, so we keep a copy.
        const observers = [...this._observers];
        observers.forEach((observer) => observer.write(token));
      }
    }
    if (this._send_events) {
      if (x === nil) {
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
      .forEach((observer) => observer.source = undefined);

    this._destructors.forEach((destructor) => destructor.call(this));

    this.source = undefined;
    this._consumers = [];
    this._incoming = [];
    this._outgoing = [];
    this._delegate = undefined;
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

  // --------------------------------------------------------

  /**
     * Adds a new consumer Stream, which will accept data and provide backpressure
     * to this Stream. Adding more than one consumer will cause an exception to be
     * thrown as the backpressure strategy must be explicitly chosen by the
     * developer (through calling fork or observe).
     */
  _addConsumer(s: Stream<R>) {
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
  _removeConsumer(s: Stream<R>) {
    let src: Stream<R> | this = this;
    while (src._delegate) {
      src = src._delegate;
    }
    src._consumers = src._consumers.filter((c) => c !== s);
    if (s.source === src) {
      s.source = undefined;
    }
    src._checkBackPressure();
  }

  /**
     * Removes an observer from this Stream.
     */
  _removeObserver(observerToRemoveFromThis: this | Stream<R>) {
    this._observers = this._observers.filter((observer) =>
      observer !== observerToRemoveFromThis
    );
    if (observerToRemoveFromThis.source === this) {
      observerToRemoveFromThis.source = undefined;
    }
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
    const s = new Stream<R>();
    s.id = "observe:" + s.id;
    s.source = this;
    s._is_observer = true;
    this._observers.push(s);
    return s;
  }
}
