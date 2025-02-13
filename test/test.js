/* eslint-disable no-unused-vars, no-shadow, no-redeclare */
var _,
  EventEmitter = require("events").EventEmitter,
  sinon = require("sinon"),
  Stream = require("stream"),
  streamify = require("stream-array"),
  concat = require("concat-stream"),
  RSVP = require("rsvp"),
  Promise = RSVP.Promise,
  transducers = require("transducers-js"),
  bluebird = require("bluebird");

if (global.highland != null) {
  _ = global.highland;
} else {
  _ = require("../lib/index");
}

// Use setTimeout. The default is process.nextTick, which sinon doesn't
// handle.
RSVP.configure("async", function (f, arg) {
  setTimeout(f.bind(this, arg), 1);
});

// Use bluebird cancellation. We want to test against it.
bluebird.config({
  cancellation: true,
});

/**
 * Useful function to use in tests.
 */

function valueEquals(test, expected) {
  return function (err, x) {
    // Must only run one test so that users can correctly
    // compute test.expect.
    if (err) {
      test.equal(err, null, "Expected a value to be emitted.");
    } else {
      test.deepEqual(x, expected, "Incorrect value emitted.");
    }
  };
}

function errorEquals(test, expectedMsg) {
  return function (err, x) {
    if (err) {
      test.strictEqual(
        err.message,
        expectedMsg,
        "Error emitted with incorrect message. " + err.message,
      );
    } else {
      test.ok(false, "No error emitted.");
    }
  };
}

function anyError(test) {
  return function (err, x) {
    test.notEqual(err, null, "No error emitted.");
  };
}

function noValueOnErrorTest(transform, expected) {
  return function (test) {
    test.expect(1);
    if (!expected) expected = [];
    var thrower = _([1]).map(function () {
      throw new Error("error");
    });
    transform(thrower).errors(function () {}).toArray(function (xs) {
      test.same(xs, expected, "Value emitted for error");
      test.done();
    });
  };
}

function catchEventLoopError(highland, cb) {
  var oldSetImmediate = highland.setImmediate;
  highland.setImmediate = function (fn) {
    oldSetImmediate(function () {
      try {
        fn();
      } catch (e) {
        cb(e);
      }
    });
  };
  return function () {
    highland.setImmediate = oldSetImmediate;
  };
}

function generatorStream(input, timeout) {
  return _(function (push, next) {
    for (var i = 0, len = input.length; i < len; i++) {
      setTimeout(push.bind(null, null, input[i]), timeout * i);
    }
    setTimeout(push.bind(null, null, _.nil), timeout * len);
  });
}

function takeNextCb(xs, times, array, cb) {
  if (!array) {
    array = [];
  }

  xs.pull(function (err, x) {
    array.push(x);
    if (x !== _.nil) {
      if (times - 1 > 0) {
        takeNextCb(xs, times - 1, array, cb);
      }
    }

    if (cb && (times <= 1 || x === _.nil)) {
      cb(array);
    }
  });
}

function takeNext(xs, times, array) {
  return new Promise(function (res, rej) {
    takeNextCb(xs, times, array, res);
  });
}

/*
 * Returns the Readable pipe destination (i.e., the one that is provided to
 * Readable#pipe). This is only relevant for streams constructed using the
 * Readable constructor.
 */
function getReadablePipeDest(stream) {
  return stream;
}

exports.ratelimit = {
  setUp: function (callback) {
    this.clock = sinon.useFakeTimers();
    callback();
  },
  tearDown: function (callback) {
    this.clock.restore();
    callback();
  },
  "invalid num per ms": function (test) {
    test.throws(function () {
      _([1, 2, 3]).ratelimit(-10, 0);
    });
    test.throws(function () {
      _([1, 2, 3]).ratelimit(0, 0);
    });
    test.done();
  },
  "async generator": function (test) {
    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    var source = _(function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 2);
      delay(push, 30, 3);
      delay(push, 40, 4);
      delay(push, 50, 5);
      delay(push, 60, _.nil);
    });
    var results = [];
    source.ratelimit(2, 100).each(function (x) {
      results.push(x);
    });
    this.clock.tick(10);
    test.same(results, [1]);
    this.clock.tick(89);
    test.same(results, [1, 2]);
    this.clock.tick(51);
    test.same(results, [1, 2, 3, 4]);
    this.clock.tick(1000);
    test.same(results, [1, 2, 3, 4, 5]);
    test.done();
  },
  "toplevel - async generator": function (test) {
    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    var source = _(function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 2);
      delay(push, 30, 3);
      delay(push, 40, 4);
      delay(push, 50, 5);
      delay(push, 60, _.nil);
    });
    var results = [];
    _.ratelimit(2, 100, source).each(function (x) {
      results.push(x);
    });
    this.clock.tick(10);
    test.same(results, [1]);
    this.clock.tick(89);
    test.same(results, [1, 2]);
    this.clock.tick(51);
    test.same(results, [1, 2, 3, 4]);
    this.clock.tick(1000);
    test.same(results, [1, 2, 3, 4, 5]);
    test.done();
  },
  "toplevel - partial application, async generator": function (test) {
    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    var source = _(function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 2);
      delay(push, 30, 3);
      delay(push, 40, 4);
      delay(push, 50, 5);
      delay(push, 60, _.nil);
    });
    var results = [];
    _.ratelimit(2)(100)(source).each(function (x) {
      results.push(x);
    });
    this.clock.tick(10);
    test.same(results, [1]);
    this.clock.tick(89);
    test.same(results, [1, 2]);
    this.clock.tick(51);
    test.same(results, [1, 2, 3, 4]);
    this.clock.tick(1000);
    test.same(results, [1, 2, 3, 4, 5]);
    test.done();
  },
  "noValueOnError": noValueOnErrorTest(_.ratelimit(1, 10)),
};

exports.curry = function (test) {
  var fn = _.curry(function (a, b, c, d) {
    return a + b + c + d;
  });
  test.equal(fn(1, 2, 3, 4), fn(1, 2)(3, 4));
  test.equal(fn(1, 2, 3, 4), fn(1)(2)(3)(4));
  var fn2 = function (a, b, c, d) {
    return a + b + c + d;
  };
  test.equal(_.curry(fn2)(1, 2, 3, 4), _.curry(fn2, 1, 2, 3, 4));
  test.equal(_.curry(fn2)(1, 2, 3, 4), _.curry(fn2, 1, 2)(3, 4));
  test.done();
};

exports.ncurry = function (test) {
  var fn = _.ncurry(3, function (a, b, c, d) {
    return a + b + c + (d || 0);
  });
  test.equal(fn(1, 2, 3, 4), 6);
  test.equal(fn(1, 2, 3, 4), fn(1, 2)(3));
  test.equal(fn(1, 2, 3, 4), fn(1)(2)(3));
  var fn2 = function () {
    var args = Array.prototype.slice(arguments);
    return args.reduce(function (a, b) {
      return a + b;
    }, 0);
  };
  test.equal(_.ncurry(3, fn2)(1, 2, 3, 4), _.ncurry(3, fn2, 1, 2, 3, 4));
  test.equal(_.ncurry(3, fn2)(1, 2, 3, 4), _.ncurry(3, fn2, 1, 2)(3, 4));
  test.done();
};

exports.compose = function (test) {
  function append(x) {
    return function (str) {
      return str + x;
    };
  }
  var fn1 = append(":one");
  var fn2 = append(":two");
  var fn = _.compose(fn2, fn1);
  test.equal(fn("zero"), "zero:one:two");
  fn = _.compose(fn1, fn2, fn1);
  test.equal(fn("zero"), "zero:one:two:one");
  test.done();
};

exports.partial = function (test) {
  var addAll = function () {
    var args = Array.prototype.slice.call(arguments);
    return args.reduce(function (a, b) {
      return a + b;
    }, 0);
  };
  var f = _.partial(addAll, 1, 2);
  test.equal(f(3, 4), 10);
  test.done();
};

exports.flip = function (test) {
  var subtract = function (a, b) {
    return a - b;
  };
  test.equal(subtract(4, 2), 2);
  test.equal(_.flip(subtract)(4, 2), -2);
  test.equal(_.flip(subtract, 4)(2), -2);
  test.equal(_.flip(subtract, 4, 2), -2);
  test.done();
};

exports.seq = function (test) {
  function append(x) {
    return function (str) {
      return str + x;
    };
  }
  var fn1 = append(":one");
  var fn2 = append(":two");
  var fn = _.seq(fn1, fn2);
  test.equal(fn("zero"), "zero:one:two");
  // more than two args
  test.equal(_.seq(fn1, fn2, fn1)("zero"), "zero:one:two:one");
  test.done();
};

exports.isNilTest = function (test) {
  test.ok(isNil(_.nil));
  test.ok(!isNil());
  test.ok(!isNil(undefined));
  test.ok(!isNil(null));
  test.ok(!isNil(123));
  test.ok(!isNil({}));
  test.ok(!isNil([]));
  test.ok(!isNil("foo"));
  test.ok(!isNil(_()));
  test.done();
};

exports.isStream = function (test) {
  test.ok(!_.isStream());
  test.ok(!_.isStream(undefined));
  test.ok(!_.isStream(null));
  test.ok(!_.isStream(123));
  test.ok(!_.isStream({}));
  test.ok(!_.isStream([]));
  test.ok(!_.isStream("foo"));
  test.ok(_.isStream(_()));
  test.ok(_.isStream(_().map(_.get("foo"))));
  test.done();
};

exports["nil defines end"] = function (test) {
  _([1, _.nil, 3]).toArray(function (xs) {
    test.same(xs, [1]);
    test.done();
  });
};

exports["nil should not equate to any empty object"] = function (test) {
  var s = [1, {}, 3];
  _(s).toArray(function (xs) {
    test.same(xs, s);
    test.done();
  });
};

exports.pull = {
  "pull should take one element - ArrayStream": function (test) {
    test.expect(2);
    var s = _([1, 2, 3]);
    s.pull(valueEquals(test, 1));
    s.toArray(function (xs) {
      test.same(xs, [2, 3]);
      test.done();
    });
  },
  "pull should take one element - GeneratorStream": function (test) {
    test.expect(2);
    var i = 1;
    var s = _(function (push, next) {
      push(null, i++);
      if (i < 4) {
        next();
      } else {
        push(null, _.nil);
      }
    });
    s.pull(valueEquals(test, 1));
    s.toArray(function (xs) {
      test.same(xs, [2, 3]);
      test.done();
    });
  },
  "pull should take one element - GeneratorStream next called first (issue #325)":
    function (test) {
      test.expect(2);
      var i = 1;
      var s = _(function (push, next) {
        if (i < 4) {
          next();
        }
        push(null, i++);
        if (i >= 4) {
          push(null, _.nil);
        }
      });
      s.pull(valueEquals(test, 1));
      s.toArray(function (xs) {
        test.same(xs, [2, 3]);
        test.done();
      });
    },
};

exports["async consume"] = function (test) {
  _([1, 2, 3, 4]).consume(function (err, x, push, next) {
    if (x === _.nil) {
      push(null, _.nil);
    } else {
      setTimeout(function () {
        push(null, x * 10);
        next();
      }, 10);
    }
  })
    .toArray(function (xs) {
      test.same(xs, [10, 20, 30, 40]);
      test.done();
    });
};

exports["consume - push nil async (issue #173)"] = function (test) {
  test.expect(1);
  _([1, 2, 3, 4]).consume(function (err, x, push, next) {
    if (err !== null) {
      push(err);
      next();
    } else if (x === _.nil) {
      _.setImmediate(push.bind(this, null, x));
    } else {
      push(null, x);
      next();
    }
  })
    .toArray(function (xs) {
      test.same(xs, [1, 2, 3, 4]);
      test.done();
    });
};

exports["consume - push nil async when x !== nil (issue #563)"] = function (
  test,
) {
  test.expect(1);
  _([1, 2, 3, 4]).consume(function (err, x, push, next) {
    if (err !== null) {
      push(err);
      next();
    } else if (x === _.nil) {
      push(null, _.nil);
    } else {
      _.setImmediate(push.bind(this, null, _.nil));
    }
  })
    .toArray(function (xs) {
      test.same(xs, []);
      test.done();
    });
};

exports["consume - fork after consume should not throw (issue #366)"] =
  function (test) {
    test.expect(2);
    var arr1, arr2;

    var s = _();
    var s1 = s.toArray(function (a) {
      arr1 = a;
      if (arr1 && arr2) {
        runTest();
      }
    });
    var s2 = s.fork().toArray(function (a) {
      arr2 = a;
      if (arr1 && arr2) {
        runTest();
      }
    });

    s.write(1);
    s.end();

    function runTest() {
      test.same(arr1, [1]);
      test.same(arr2, [1]);
      test.done();
    }
  };

exports.race = {
  setUp: function (callback) {
    this.clock = sinon.useFakeTimers();
    callback();
  },
  tearDown: function (callback) {
    this.clock.restore();
    callback();
  },
  "no re-entry of consume callback (issue #388)": function (test) {
    test.expect(1);
    // This triggers a race condition. Be careful about changing the source.
    var stream = _();
    var i = 0;

    function write() {
      var cont = false;
      while ((cont = stream.write(i++)) && i <= 10) {
        // Do nothing.
      }
      if (cont) {
        i++;
        stream.end();
      }
    }

    // This stream mimics the behavior of things like database
    // drivers.
    stream.on("drain", function () {
      if (i === 0) {
        // The initial read is async.
        setTimeout(write, 0);
      } else if (i > 0 && i < 10) {
        // The driver loads data in batches, so subsequent drains
        // are sync to mimic pulling from a pre-loaded buffer.
        write();
      } else if (i === 10) {
        i++;
        setTimeout(stream.end.bind(stream), 0);
      }
    });

    var done = false;
    stream
      // flatMap to disassociate from the source, since sequence
      // returns a new stream not a consume stream.
      .flatMap(function (x) {
        return _([x]);
      })
      // batch(2) to get a transform that sometimes calls next
      // without calling push beforehand.
      .batch(2)
      // Another flatMap to get an async transform.
      .flatMap(function (x) {
        return _(function (push) {
          setTimeout(function () {
            push(null, x);
            push(null, _.nil);
          }, 100);
        });
      })
      .done(function () {
        done = true;
      });

    // Manually drain the stream. This starts the whole process.
    stream.emit("drain");

    this.clock.tick(1000);
    test.ok(done, "The stream never completed.");
    test.done();
  },
};

exports.constructor = {
  setUp: function (callback) {
    this.createTestIterator = function (array, error, lastVal) {
      var count = 0,
        length = array.length;
      return {
        next: function () {
          if (count < length) {
            if (error && count === 2) {
              throw error;
            }
            var iterElem = {
              value: array[count],
              done: false,
            };
            count++;
            return iterElem;
          } else {
            return {
              value: lastVal,
              done: true,
            };
          }
        },
      };
    };
    this.tester = function (expected, test) {
      return function (xs) {
        test.same(xs, expected);
        test.done();
      };
    };
    callback();
  },
  "passing Stream to constructor returns original": function (test) {
    test.expect(1);
    var s = _([1, 2, 3]);
    test.strictEqual(s, _(s));
    test.done();
  },
  "from Readable with next function - issue #303": function (test) {
    test.expect(1);
    var Readable = Stream.Readable;

    var rs = new Readable();
    rs.next = function () {};
    rs.push("a");
    rs.push("b");
    rs.push("c");
    rs.push(null);
    _(rs).invoke("toString", ["utf8"])
      .toArray(this.tester(["a", "b", "c"], test));
  },
  "from Readable - unpipes on destroy": function (test) {
    test.expect(2);
    var rs = streamify([1, 2, 3]);

    var s = _(rs);
    var rsPipeDest = getReadablePipeDest(s);
    s.pull(function (err, x) {
      valueEquals(test, 1)(err, x);

      _.setImmediate(function () {
        s.destroy();

        var write = sinon.spy(rsPipeDest, "write");

        s.emit("drain");
        test.ok(!write.called, "Drain should not cause write to be called.");
        test.done();
      }, 0);
    });
  },
  "from Readable - emits 'close' not 'end' - issue #490": function (test) {
    test.expect(1);
    var rs = new Stream.Readable();
    rs._read = function (size) {
      this.emit("close");
    };
    var s = _(rs);

    var sawEnd = false;
    s.pull(function (err, x) {
      sawEnd = true;
    });

    setTimeout(function () {
      test.ok(!sawEnd, "Stream should not have ended.");
      test.done();
    }, 10);
  },
  "from Readable - emits 'close' before 'end' - issue #490": function (test) {
    test.expect(1);
    var rs = new Stream.Readable();
    rs._read = function (size) {
      this.push("1");
      this.emit("close");
      this.push("2");
      this.push(null);
    };
    rs.setEncoding("utf-8");
    var s = _(rs)
      .toArray(this.tester(["1", "2"], test));
  },
  "from Readable - emits 'close' and 'end' - issue #478": function (test) {
    test.expect(2);
    var rs = new Stream.Readable();
    rs._read = function (size) {
      this.push(null);
    };
    rs.on("end", function () {
      _.setImmediate(function () {
        rs.emit("close");
      });
    });
    var s = _(rs);
    var rsPipeDest = getReadablePipeDest(s);
    var end = sinon.spy(rsPipeDest, "end");
    rs.on("close", function () {
      // Wait for the rest of the close handlers to be called before
      // checking.
      _.setImmediate(function () {
        test.equal(end.callCount, 1, "end() should be called exactly once.");
        test.done();
      });
    });
    s.pull(valueEquals(test, _.nil));
  },
  "from Readable - emits 'error' - issue #478": function (test) {
    test.expect(2);
    var rs = new Stream.Readable();
    rs._read = function (size) {
      // Infinite stream!
    };
    var s = _(rs);
    rs.emit("error", new Error("error"));
    s.pull(errorEquals(test, "error"));
    s.pull(valueEquals(test, _.nil));
    test.done();
  },
  "from Readable - unbind and unpipe as soon as possible": function (test) {
    var rs = new Stream.Readable();
    rs._read = function (size) {
      this.push("1");
      this.push(null);
    };

    var error = new Error("error");
    var s = _(rs);
    var rsPipeDest = getReadablePipeDest(s);
    var oldWrite = rsPipeDest.write;

    // We need to catch the exception here
    // since pipe uses process.nextTick which
    // isn't mocked by sinon.
    rsPipeDest.write = function (x) {
      try {
        oldWrite.call(this, x);
      } catch (e) {
        // Ignore
      }
    };

    var write = sinon.spy(rsPipeDest, "write");
    rs.emit("error", error);

    _.setImmediate(function () {
      test.strictEqual(write.callCount, 2);
      test.strictEqual(write.args[0][0].error, error);
      test.strictEqual(write.args[1][0], _.nil);
      test.done();
    });
  },
  "from Readable - custom onFinish handler": function (test) {
    test.expect(2);
    var clock = sinon.useFakeTimers();
    var rs = new Stream.Readable();
    rs._read = function (size) {
      // Infinite stream!
    };

    var cleanup = sinon.spy();
    var s = _(rs, function (_rs, callback) {
      setTimeout(callback, 1000);
      return cleanup;
    });

    clock.tick(1000);
    clock.restore();

    s.pull(valueEquals(test, _.nil));

    test.strictEqual(cleanup.callCount, 1);
    test.done();
  },
  "from Readable - custom onFinish handler - emits error": function (test) {
    test.expect(2);
    var clock = sinon.useFakeTimers();
    var rs = new Stream.Readable();
    rs._read = function (size) {
      // Infinite stream!
    };

    var error = new Error("error");
    var s = _(rs, function (_rs, callback) {
      setTimeout(function () {
        callback(error);
      }, 1000);
    });

    clock.tick(1000);
    clock.restore();

    s.pull(errorEquals(test, "error"));
    s.pull(valueEquals(test, _.nil));

    test.done();
  },
  "from Readable - custom onFinish handler - handle multiple callback calls":
    function (test) {
      test.expect(2);
      var clock = sinon.useFakeTimers();
      var rs = new Stream.Readable();
      rs._read = function (size) {
        // Infinite stream!
      };

      var cleanup = sinon.spy();
      var error = new Error("error");
      var s = _(rs, function (_rs, callback) {
        setTimeout(function () {
          callback();
          callback(error);
        }, 1000);
        return cleanup;
      });

      clock.tick(1000);
      clock.restore();

      // Only the first one counts.
      s.pull(valueEquals(test, _.nil));
      test.strictEqual(cleanup.callCount, 1);
      test.done();
    },
  "from Readable - custom onFinish handler - default to end on error":
    function (test) {
      test.expect(2);
      var clock = sinon.useFakeTimers();
      var rs = new Stream.Readable();
      var firstTime = true;

      rs._read = function (size) {
        // Infinite stream!
      };

      var error1 = new Error("error1");
      var error2 = new Error("error2");
      var s = _(rs, function (_rs, callback) {
        setTimeout(function () {
          callback(error1);
        }, 1000);
        setTimeout(function () {
          callback(error2);
          callback();
        }, 2000);
      });

      clock.tick(2000);
      clock.restore();

      s.pull(errorEquals(test, "error1"));
      s.pull(valueEquals(test, _.nil));

      test.done();
    },
  "from Readable - custom onFinish handler - emits multiple errors": function (
    test,
  ) {
    test.expect(4);
    var clock = sinon.useFakeTimers();
    var rs = new Stream.Readable();
    var firstTime = true;

    rs._read = function (size) {
      // Infinite stream!
    };

    var onDestroy = sinon.spy();
    var error1 = new Error("error1");
    var error2 = new Error("error2");
    var s = _(rs, function (_rs, callback) {
      setTimeout(function () {
        callback(error1);
      }, 1000);
      setTimeout(function () {
        callback(error2);
        callback();
      }, 2000);

      return {
        onDestroy: onDestroy,
        continueOnError: true,
      };
    });

    clock.tick(2000);
    clock.restore();

    s.pull(errorEquals(test, "error1"));
    s.pull(errorEquals(test, "error2"));
    s.pull(valueEquals(test, _.nil));

    test.strictEqual(
      onDestroy.callCount,
      1,
      "On destroy should have been called.",
    );
    test.done();
  },
  "from Readable - does not emit drain prematurely (issue #670)": function (
    test,
  ) {
    test.expect(1);

    var readable = new Stream.Readable({ objectMode: true });
    readable._max = 6;
    readable._index = 1;
    readable._firstTime = true;

    readable._emitNext = function () {
      var i = this._index++;
      if (i > this._max) {
        this.push(null);
      } else {
        this.push(i);
      }
    };

    readable._read = function () {
      var self = this;
      if (this._firstTime) {
        // Delay the first item so that when it's emitted, Highland isn't in a
        // generator loop. This allows 'drain' to be emitted within write().
        this._firstTime = false;
        setTimeout(function () {
          self._emitNext();
        }, 0);
      } else {
        this._emitNext();
      }
    };

    _(readable)
      .batch(2)
      .consume(function (err, x, push, next) {
        // Delay the batch so that the write() -> emit('drain') -> write() stack
        // can unwind, causing multiple increments of awaitDrain.
        setTimeout(function () {
          if (x !== null) {
            next();
          }
          push(err, x);
        }, 0);
      })
      .toArray(function (result) {
        test.same(result, [[1, 2], [3, 4], [5, 6]]);
        test.done();
      });
  },
  "throws error for unsupported object": function (test) {
    test.expect(1);
    test.throws(
      function () {
        _({}).done(function () {});
      },
      Error,
      "Object was not a stream, promise, iterator or iterable: object",
    );
    test.done();
  },
  "from promise": function (test) {
    test.expect(1);
    _(Promise.resolve(3))
      .toArray(this.tester([3], test));
  },
  "from promise - errors": function (test) {
    test.expect(3);
    var errs = [];
    _(Promise.reject(new Error("boom")))
      .errors(function (err) {
        errs.push(err);
      })
      .toArray(function (xs) {
        test.equal(errs[0].message, "boom");
        test.equal(errs.length, 1);
        test.same(xs, []);
        test.done();
      });
  },
  "from promise - bluebird cancellation": function (test) {
    test.expect(1);
    var promise = new bluebird.Promise(function (resolve, reject) {
      setTimeout(function () {
        resolve(1);
      }, 10);
    });
    var stream = _(promise).toArray(this.tester([], test));
    promise.cancel();
  },
  "from promise - should not throw in promise onResolve handler (issue #589)":
    function (test) {
      test.expect(1);

      // Swallow the exception so the tests passes.
      var stopCatchingEventLoopError = catchEventLoopError(_, function (e) {
        if (e.message !== "Error thrown when handling value.") {
          throw e;
        }
      });

      var promise = bluebird.Promise.resolve("value");
      var oldThen = promise.then;
      promise.then = function (onResolve, onReject) {
        return oldThen.call(promise, function () {
          var threwError = false;
          try {
            onResolve.apply(this, arguments);
          } catch (e) {
            threwError = true;
          }

          test.ok(!threwError, "The onResolve callback synchronously threw!");
          test.done();
          stopCatchingEventLoopError();
        }, function () {
          // Won't be called.
          test.ok(false, "The onReject callback was called?!");
          test.done();
          stopCatchingEventLoopError();
        });
      };

      // Clear promise.finally to force the use of the vanilla promise code
      // path.
      promise.finally = null;
      _(promise)
        .map(function (x) {
          throw new Error("Error thrown when handling value.");
        })
        .done(function () {});
    },
  "from promise - should not throw in promise onReject handler (issue #589)":
    function (test) {
      test.expect(1);

      // Swallow the exception so the tests passes.
      var stopCatchingEventLoopError = catchEventLoopError(_, function (e) {
        if (e.message !== "Error from promise.") {
          throw e;
        }
      });

      var promise = bluebird.Promise.reject(new Error("Error from promise."));
      var oldThen = promise.then;
      promise.then = function (onResolve, onReject) {
        return oldThen.call(promise, function () {
          // Won't be called.
          test.ok(false, "The onResolve callback was called?!");
          test.done();
          stopCatchingEventLoopError();
        }, function () {
          var threwError = false;
          try {
            onReject.apply(this, arguments);
          } catch (e) {
            threwError = true;
          }

          test.ok(!threwError, "The onReject callback synchronously threw!");
          test.done();
          stopCatchingEventLoopError();
        });
      };

      // Clear promise.finally to force the use of the vanilla promise code
      // path.
      promise.finally = null;
      _(promise).done(function () {});
    },
  "from iterator": function (test) {
    test.expect(1);
    _(this.createTestIterator([1, 2, 3, 4, 5]))
      .toArray(this.tester([1, 2, 3, 4, 5], test));
  },
  "from iterator - error": function (test) {
    test.expect(2);
    _(this.createTestIterator([1, 2, 3, 4, 5], new Error("Error at index 2")))
      .errors(function (err) {
        test.equals(err.message, "Error at index 2");
      })
      .toArray(this.tester([1, 2], test));
  },
  "from iterator - final return falsy": function (test) {
    test.expect(1);
    _(this.createTestIterator([1, 2, 3, 4, 5], void 0, 0))
      .toArray(this.tester([1, 2, 3, 4, 5, 0], test));
  },
};

//ES6 iterators Begin
if (global.Map && global.Symbol) {
  exports["constructor from Map"] = function (test) {
    test.expect(1);
    var map = new global.Map();
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    _(map).toArray(function (xs) {
      test.same(xs, [["a", 1], ["b", 2], ["c", 3]]);
    });
    test.done();
  };

  exports["constructor from Map iterator"] = function (test) {
    test.expect(1);
    var map = new global.Map();
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    _(map.entries()).toArray(function (xs) {
      test.same(xs, [["a", 1], ["b", 2], ["c", 3]]);
    });
    test.done();
  };

  exports["constructor from empty Map iterator"] = function (test) {
    test.expect(1);
    var map = new global.Map();

    _(map.entries()).toArray(function (xs) {
      test.same(xs, []);
    });
    test.done();
  };
}

if (global.Set && global.Symbol) {
  exports["constructor from Set"] = function (test) {
    test.expect(1);
    var sett = new global.Set([1, 2, 2, 3, 4]);

    _(sett).toArray(function (xs) {
      test.same(xs, [1, 2, 3, 4]);
    });
    test.done();
  };

  exports["constructor from Set iterator"] = function (test) {
    test.expect(1);
    var sett = new global.Set([1, 2, 2, 3, 4]);

    _(sett.values()).toArray(function (xs) {
      test.same(xs, [1, 2, 3, 4]);
    });
    test.done();
  };

  exports["constructor from empty Map iterator"] = function (test) {
    test.expect(1);
    var sett = new global.Set();

    _(sett.values()).toArray(function (xs) {
      test.same(xs, []);
    });
    test.done();
  };
}
//ES6 iterators End

exports["if no consumers, buffer data"] = function (test) {
  var s = _();
  test.equal(s.paused, true);
  s.write(1);
  s.write(2);
  s.toArray(function (xs) {
    test.same(xs, [1, 2, 3]);
    test.done();
  });
  s.write(3);
  s.write(_.nil);
};

exports["if consumer paused, buffer data"] = function (test) {
  var map_calls = [];
  function doubled(x) {
    map_calls.push(x);
    return x * 2;
  }
  var s = _();
  var s2 = s.map(doubled);
  test.equal(s.paused, true);
  test.equal(s2.paused, true);
  s.write(1);
  s.write(2);
  test.same(map_calls, []);
  s2.toArray(function (xs) {
    test.same(xs, [2, 4, 6]);
    test.same(map_calls, [1, 2, 3]);
    test.done();
  });
  s.write(3);
  s.write(_.nil);
};

exports["write when paused adds to incoming buffer"] = function (test) {
  var s = _();
  test.ok(s.paused);
  test.same(s._incoming, []);
  test.strictEqual(s.write(1), false);
  test.same(s._incoming, [1]);
  test.strictEqual(s.write(2), false);
  test.same(s._incoming, [1, 2]);
  test.done();
};

exports["write when not paused sends to consumer"] = function (test) {
  var vals = [];
  var s1 = _();
  var s2 = s1.consume(function (err, x, push, next) {
    vals.push(x);
    next();
  });
  test.ok(s1.paused);
  test.ok(s2.paused);
  test.same(s1._incoming, []);
  test.same(s2._incoming, []);
  s2.resume();
  test.ok(!s1.paused);
  test.ok(!s2.paused);
  test.strictEqual(s1.write(1), true);
  test.strictEqual(s1.write(2), true);
  test.same(s1._incoming, []);
  test.same(s2._incoming, []);
  test.same(vals, [1, 2]);
  test.done();
};

exports["buffered incoming data released on resume"] = function (test) {
  var vals = [];
  var s1 = _();
  var s2 = s1.consume(function (err, x, push, next) {
    vals.push(x);
    next();
  });
  test.strictEqual(s1.write(1), false);
  test.same(s1._incoming, [1]);
  test.same(s2._incoming, []);
  s2.resume();
  test.same(vals, [1]);
  test.same(s1._incoming, []);
  test.same(s2._incoming, []);
  test.strictEqual(s1.write(2), true);
  test.same(vals, [1, 2]);
  test.done();
};

exports["restart buffering incoming data on pause"] = function (test) {
  var vals = [];
  var s1 = _();
  var s2 = s1.consume(function (err, x, push, next) {
    vals.push(x);
    next();
  });
  s2.resume();
  test.strictEqual(s1.write(1), true);
  test.strictEqual(s1.write(2), true);
  test.same(s1._incoming, []);
  test.same(s2._incoming, []);
  test.same(vals, [1, 2]);
  s2.pause();
  test.strictEqual(s1.write(3), false);
  test.strictEqual(s1.write(4), false);
  test.same(s1._incoming, [3, 4]);
  test.same(s2._incoming, []);
  test.same(vals, [1, 2]);
  s2.resume();
  test.same(s1._incoming, []);
  test.same(s2._incoming, []);
  test.same(vals, [1, 2, 3, 4]);
  test.done();
};

exports["redirect from consumer"] = function (test) {
  var s = _([1, 2, 3]);
  var s2 = s.consume(function (err, x, push, next) {
    next(_([4, 5, 6]));
  });
  s2.toArray(function (xs) {
    test.same(xs, [4, 5, 6]);
    test.done();
  });
};

exports["async next from consumer"] = function (test) {
  test.expect(5);
  var calls = 0;
  var s = _(function (push, next) {
    calls++;
    setTimeout(function () {
      push(null, calls);
      next();
    }, 10);
  });
  s.id = "s";
  var s2 = s.consume(function (err, x, push, next) {
    if (x <= 3) {
      setTimeout(function () {
        // no further values should have been read
        test.equal(calls, x);
        next();
      }, 50);
    } else {
      push(null, _.nil);
    }
  });
  s2.id = "s2";
  s2.toArray(function (xs) {
    test.same(xs, []);
    test.equal(calls, 4);
    test.done();
  });
};

exports["generator throws error if next called after nil"] = function (test) {
  test.expect(1);
  var nil_seen = false;
  var s = _(function (push, next) {
    // Ensure that next after nil is only called once
    if (nil_seen) {
      return;
    }
    push(null, 1);
    nil_seen = true;
    push(null, _.nil);
    next();
  });
  test.throws(function () {
    s.resume();
  });
  test.done();
};

exports["generator throws error if push called after nil"] = function (test) {
  test.expect(1);
  var s = _(function (push, next) {
    push(null, 1);
    push(null, _.nil);
    push(null, 2);
  });
  test.throws(function () {
    s.resume();
  });
  test.done();
};

exports.of = {
  "creates stream of one item": function (test) {
    test.expect(2);
    _.of(1)
      .toCallback(function (err, result) {
        test.ifError(err);
        test.same(result, 1);
        test.done();
      });
  },
};

exports.fromError = {
  "creates stream of one error": function (test) {
    var error = new Error("This is an error");
    test.expect(2);
    _.fromError(error)
      .toCallback(function (err, result) {
        test.strictEqual(err, error);
        test.strictEqual(result, void 0);
        test.done();
      });
  },
};

exports["consume - throws error if push called after nil"] = function (test) {
  test.expect(1);
  var s = _([1, 2, 3]);
  var s2 = s.consume(function (err, x, push, next) {
    push(null, x);
    if (x === _.nil) {
      push(null, 4);
    } else {
      next();
    }
  });
  test.throws(function () {
    s2.resume();
  });
  test.done();
};

exports["consume - throws error if next called after nil"] = function (test) {
  test.expect(1);
  var s = _([1, 2, 3]);
  var nil_seen = false;
  var s2 = s.consume(function (err, x, push, next) {
    // ensure we only call `next` after nil once
    if (nil_seen) {
      return;
    }
    if (x === _.nil) {
      nil_seen = true;
    }
    push(null, x);
    next();
  });
  test.throws(function () {
    s2.resume();
  });
  test.done();
};

exports["consume - call handler once without next() (issue #570)"] = function (
  test,
) {
  test.expect(1);
  var clock = sinon.useFakeTimers();
  var consumedCalledNum = 0;
  _([1, 2, 3])
    .consume(function (err, x, push, next) {
      consumedCalledNum++;
    })
    .resume();
  clock.tick(10000);
  clock.restore();
  test.equal(consumedCalledNum, 1);
  test.done();
};

exports[
  "consume - consume resumed stream - call handler once without next() (issue #570)"
] = function (test) {
  test.expect(1);
  var clock = sinon.useFakeTimers();
  var consumedCalledNum = 0;
  var s = _([1, 2, 3])
    .consume(function (err, x, push, next) {
      consumedCalledNum++;
    });
  s.resume();
  s.consume(function (err, x, push, next) {
    if (x !== _.nil) {
      next();
    }
  }).resume();
  clock.tick(10000);
  clock.restore();
  test.equal(consumedCalledNum, 1);
  test.done();
};

exports.errors = function (test) {
  var errs = [];
  var err1 = new Error("one");
  var err2 = new Error("two");
  var s = _(function (push, next) {
    push(err1);
    push(null, 1);
    push(err2);
    push(null, 2);
    push(null, _.nil);
  });
  var f = function (err, rethrow) {
    errs.push(err);
  };
  _.errors(f, s).toArray(function (xs) {
    test.same(xs, [1, 2]);
    test.same(errs, [err1, err2]);
    test.done();
  });
};

exports["errors - rethrow"] = function (test) {
  var errs = [];
  var err1 = new Error("one");
  var err2 = new Error("two");
  var s = _(function (push, next) {
    push(err1);
    push(null, 1);
    push(err2);
    push(null, 2);
    push(null, _.nil);
  });
  var f = function (err, rethrow) {
    errs.push(err);
    if (err.message === "two") {
      rethrow(err);
    }
  };
  test.throws(function () {
    _.errors(f)(s).toArray(function () {
      test.ok(false, "should not be called");
    });
  }, "two");
  test.done();
};

exports["errors - rethrows + forwarding different stream"] = function (test) {
  test.expect(1);
  var err1 = new Error("one");
  var s = _(function (push, next) {
    push(err1);
    push(null, _.nil);
  }).errors(function (err, push) {
    push(err);
  });

  var s2 = _(function (push, next) {
    s.pull(function (err, val) {
      push(err, val);
      if (val !== _.nil) {
        next();
      }
    });
  });

  test.throws(function () {
    s2.toArray(function () {
      test.ok(false, "should not be called");
    });
  }, "one");
  test.done();
};

exports["errors - ArrayStream"] = function (test) {
  var errs = [];
  var f = function (err, rethrow) {
    errs.push(err);
  };
  // kinda pointless
  _([1, 2]).errors(f).toArray(function (xs) {
    test.same(xs, [1, 2]);
    test.same(errs, []);
    test.done();
  });
};

exports["errors - GeneratorStream"] = function (test) {
  var errs = [];
  var err1 = new Error("one");
  var err2 = new Error("two");
  var s = _(function (push, next) {
    push(err1);
    push(null, 1);
    setTimeout(function () {
      push(err2);
      push(null, 2);
      push(null, _.nil);
    }, 10);
  });
  var f = function (err, rethrow) {
    errs.push(err);
  };
  s.errors(f).toArray(function (xs) {
    test.same(xs, [1, 2]);
    test.same(errs, [err1, err2]);
    test.done();
  });
};

exports.stopOnError = function (test) {
  var errs = [];
  var err1 = new Error("one");
  var err2 = new Error("two");
  var s = _(function (push, next) {
    push(null, 1);
    push(err1);
    push(null, 2);
    push(err2);
    push(null, _.nil);
  });
  var f = function (err, rethrow) {
    errs.push(err);
  };
  _.stopOnError(f, s).toArray(function (xs) {
    test.same(xs, [1]);
    test.same(errs, [err1]);
    test.done();
  });
};

exports["stopOnError - rethrows + forwarding different stream"] = function (
  test,
) {
  test.expect(1);
  var err1 = new Error("one");
  var s = _(function (push, next) {
    push(err1);
    push(null, _.nil);
  }).stopOnError(function (err, push) {
    push(err);
  });

  var s2 = _(function (push, next) {
    s.pull(function (err, val) {
      push(err, val);
      if (val !== _.nil) {
        next();
      }
    });
  });

  test.throws(function () {
    s2.toArray(function () {
      test.ok(false, "should not be called");
    });
  }, "one");
  test.done();
};

exports["stopOnError - ArrayStream"] = function (test) {
  var errs = [];
  var f = function (err, rethrow) {
    errs.push(err);
  };
  _([1, 2, 3, 4]).stopOnError(f).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
    test.same(errs, []);
    test.done();
  });
};

exports["stopOnError - GeneratorStream"] = function (test) {
  var errs = [];
  var err1 = new Error("one");
  var err2 = new Error("two");
  var s = _(function (push, next) {
    push(null, 1);
    setTimeout(function () {
      push(err1);
      push(null, 2);
      push(err2);
      push(null, _.nil);
    }, 10);
  });
  var f = function (err, rethrow) {
    errs.push(err);
  };
  s.stopOnError(f).toArray(function (xs) {
    test.same(xs, [1]);
    test.same(errs, [err1]);
    test.done();
  });
};

exports.apply = function (test) {
  test.expect(8);
  var fn = function (a, b, c) {
    test.equal(arguments.length, 3);
    test.equal(a, 1);
    test.equal(b, 2);
    test.equal(c, 3);
  };
  _.apply(fn, [1, 2, 3]);
  // partial application
  _.apply(fn)([1, 2, 3]);
  test.done();
};

exports["apply - ArrayStream"] = function (test) {
  _([1, 2, 3]).apply(function (a, b, c) {
    test.equal(arguments.length, 3);
    test.equal(a, 1);
    test.equal(b, 2);
    test.equal(c, 3);
    test.done();
  });
};

exports["apply - varargs"] = function (test) {
  _([1, 2, 3, 4]).apply(function (a, b) {
    test.equal(arguments.length, 4);
    test.equal(a, 1);
    test.equal(b, 2);
    test.done();
  });
};

exports["apply - GeneratorStream"] = function (test) {
  var s = _(function (push, next) {
    push(null, 1);
    setTimeout(function () {
      push(null, 2);
      push(null, 3);
      push(null, _.nil);
    }, 10);
  });
  s.apply(function (a, b, c) {
    test.equal(arguments.length, 3);
    test.equal(a, 1);
    test.equal(b, 2);
    test.equal(c, 3);
    test.done();
  });
};

exports.take = function (test) {
  test.expect(3);
  var s = _([1, 2, 3, 4]).take(2);
  s.pull(function (err, x) {
    test.equal(x, 1);
  });
  s.pull(function (err, x) {
    test.equal(x, 2);
  });
  s.pull(function (err, x) {
    test.equal(x, _.nil);
  });
  test.done();
};

exports.slice = {
  setUp: function (cb) {
    this.input = [1, 2, 3, 4, 5];
    this.expected = [3, 4, 5];
    this.tester = function (expected, test) {
      return function (xs) {
        test.same(xs, expected);
      };
    };
    cb();
  },
  "arrayStream": function (test) {
    test.expect(5);
    _(this.input).slice(2, 6).toArray(this.tester(this.expected, test));
    _(this.input).slice(2).toArray(this.tester(this.expected, test));
    _(this.input).slice().toArray(this.tester(this.input, test));
    _(this.input).slice(-1, 6).toArray(this.tester(this.input, test));
    _(this.input).slice(0).toArray(this.tester(this.input, test));
    test.done();
  },
  "partial application": function (test) {
    test.expect(1);
    var s = _(this.input);
    _.slice(1, 4)(s).toArray(this.tester([2, 3, 4], test));
    test.done();
  },
  "negative indicies": function (test) {
    test.expect(1);
    _.slice(-5, Infinity)(this.input).toArray(this.tester(this.input, test));
    test.done();
  },
  "error": function (test) {
    test.expect(2);
    var s = _(function (push, next) {
      push(null, 1);
      push(new Error("Slice error"));
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, 5);
      push(null, _.nil);
    });
    s.slice(2, 4).errors(errorEquals(test, "Slice error"))
      .toArray(this.tester([3, 4], test));
    test.done();
  },
  "noValueOnError": noValueOnErrorTest(_.slice(2, 3)),
};

exports["take - noValueOnError"] = noValueOnErrorTest(_.take(1));

exports["take - errors"] = function (test) {
  test.expect(4);
  var s = _(function (push, next) {
    push(null, 1);
    push(new Error("error"), 2);
    push(null, 3);
    push(null, 4);
    push(null, _.nil);
  });
  var f = s.take(2);
  f.pull(function (err, x) {
    test.equal(x, 1);
  });
  f.pull(function (err, x) {
    test.equal(err.message, "error");
  });
  f.pull(function (err, x) {
    test.equal(x, 3);
  });
  f.pull(function (err, x) {
    test.equal(x, _.nil);
  });
  test.done();
};

exports["take 1"] = function (test) {
  test.expect(2);
  var s = _([1]).take(1);
  s.pull(function (err, x) {
    test.equal(x, 1);
  });
  s.pull(function (err, x) {
    test.equal(x, _.nil);
  });
  test.done();
};

exports.drop = {
  setUp: function (cb) {
    this.input = [1, 2, 3, 4, 5];
    this.expected = [3, 4, 5];
    this.tester = function (expected, test) {
      return function (xs) {
        test.same(xs, expected);
      };
    };
    cb();
  },
  "arrayStream": function (test) {
    test.expect(1);
    _(this.input).drop(2).toArray(this.tester(this.expected, test));
    test.done();
  },
  "partial application": function (test) {
    test.expect(1);
    var s = _(this.input);
    _.drop(2)(s).toArray(this.tester(this.expected, test));
    test.done();
  },
  "negative indicies": function (test) {
    test.expect(1);
    _.drop(-1)(this.input).toArray(this.tester(this.input, test));
    test.done();
  },
  "error": function (test) {
    test.expect(2);
    var s = _(function (push, next) {
      push(null, 1);
      push(new Error("Drop error"));
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, 5);
      push(null, _.nil);
    });
    s.drop(2).errors(errorEquals(test, "Drop error"))
      .toArray(this.tester(this.expected, test));
    test.done();
  },
  "noValueOnError": noValueOnErrorTest(_.drop(2)),
};

exports.head = function (test) {
  test.expect(2);
  var s = _([2, 1]).head();
  s.pull(function (err, x) {
    test.equal(2, x);
  });
  s.pull(function (err, x) {
    test.equal(x, _.nil);
  });
  test.done();
};

exports["head - noValueOnError"] = noValueOnErrorTest(_.head());

exports.each = function (test) {
  var calls = [];
  _.each(function (x) {
    calls.push(x);
  }, [1, 2, 3]);
  test.same(calls, [1, 2, 3]);
  // partial application
  _.each(function (x) {
    calls.push(x);
  })([1, 2, 3]);
  test.same(calls, [1, 2, 3, 1, 2, 3]);
  test.done();
};

exports["each - ArrayStream"] = function (test) {
  var calls = [];
  _([1, 2, 3]).each(function (x) {
    calls.push(x);
  });
  test.same(calls, [1, 2, 3]);
  test.done();
};

exports["each - GeneratorStream"] = function (test) {
  var s = _(function (push, next) {
    push(null, 1);
    push(null, 2);
    push(null, 3);
    push(null, _.nil);
  });
  var calls = [];
  s.each(function (x) {
    calls.push(x);
  });
  test.same(calls, [1, 2, 3]);
  test.done();
};

exports["each - throw error if consumed"] = function (test) {
  var e = new Error("broken");
  var s = _(function (push, next) {
    push(null, 1);
    push(e);
    push(null, 2);
    push(null, _.nil);
  });
  test.throws(function () {
    s.each(function (x) {
      // do nothing
    });
  });
  test.done();
};

exports.done = function (test) {
  test.expect(3);

  var calls = [];
  _.map(function (x) {
    calls.push(x);
    return x;
  }, [1, 2, 3]).done(function () {
    test.same(calls, [1, 2, 3]);
  });

  calls = [];
  _.each(function (x) {
    calls.push(x);
  }, [1, 2, 3]).done(function () {
    test.same(calls, [1, 2, 3]);
  });

  // partial application
  calls = [];
  _.each(function (x) {
    calls.push(x);
  })([1, 2, 3]).done(function () {
    test.same(calls, [1, 2, 3]);
  });

  test.done();
};

exports["done - ArrayStream"] = function (test) {
  var calls = [];
  _([1, 2, 3]).each(function (x) {
    calls.push(x);
  }).done(function () {
    test.same(calls, [1, 2, 3]);
    test.done();
  });
};

exports["done - GeneratorStream"] = function (test) {
  function delay(push, ms, x) {
    setTimeout(function () {
      push(null, x);
    }, ms);
  }
  var source = _(function (push, next) {
    delay(push, 10, 1);
    delay(push, 20, 2);
    delay(push, 30, 3);
    delay(push, 40, _.nil);
  });

  var calls = [];
  source.each(function (x) {
    calls.push(x);
  }).done(function () {
    test.same(calls, [1, 2, 3]);
    test.done();
  });
};

exports["done - throw error if consumed"] = function (test) {
  var e = new Error("broken");
  var s = _(function (push, next) {
    push(null, 1);
    push(e);
    push(null, 2);
    push(null, _.nil);
  });
  test.throws(function () {
    s.done(function () {});
  });
  test.done();
};

exports["toCallback - ArrayStream"] = function (test) {
  test.expect(2);
  _([1, 2, 3, 4]).collect().toCallback(function (err, result) {
    test.same(result, [1, 2, 3, 4]);
    test.same(err, null);
    test.done();
  });
};

exports["toCallback - GeneratorStream"] = function (test) {
  test.expect(2);
  _(function (push, next) {
    push(null, 1);
    push(null, 2);
    setTimeout(function () {
      push(null, 3);
      push(null, _.nil);
    }, 40);
  }).collect().toCallback(function (err, result) {
    test.same(result, [1, 2, 3]);
    test.same(err, null);
    test.done();
  });
};

exports["toCallback - returns error for streams with multiple values"] =
  function (test) {
    test.expect(1);
    var s = _([1, 2]).toCallback(function (err, result) {
      test.same(
        err.message,
        "toCallback called on stream emitting multiple values",
      );
      test.done();
    });
  };

exports["toCallback - calls back without arguments for empty stream"] =
  function (test) {
    test.expect(1);
    _([]).toCallback(function () {
      test.same(arguments.length, 0);
      test.done();
    });
  };

exports["toCallback - returns error when stream emits error"] = function (
  test,
) {
  test.expect(2);
  _(function (push, next) {
    push(null, 1);
    push(null, 2);
    setTimeout(function () {
      push(new Error("Test error"));
      push(null, 3);
      push(null, _.nil);
    }, 40);
  }).collect().toCallback(function (err, result) {
    test.same(err.message, "Test error");
    test.same(result, undefined);
    test.done();
  });
};

exports["toCallback - error handling edge cases"] = function (test) {
  test.expect(4);
  _(function (push, next) {
    push(null, 1);
    push(new Error("Test error"));
    push(null, _.nil);
  }).toCallback(function (err, result) {
    test.same(
      err.message,
      "toCallback called on stream emitting multiple values",
    );
    test.same(result, undefined);
  });

  _(function (push, next) {
    push(null, 1);
    push(null, 2);
    push(new Error("Test error"));
    push(null, _.nil);
  }).toCallback(function (err, result) {
    test.same(
      err.message,
      "toCallback called on stream emitting multiple values",
    );
    test.same(result, undefined);
  });
  test.done();
};

exports.toPromise = {
  "ArrayStream": function (test) {
    test.expect(1);
    _([1, 2, 3, 4]).collect().toPromise(Promise).then(function (result) {
      test.same(result, [1, 2, 3, 4]);
      test.done();
    });
  },
  "GeneratorStream": function (test) {
    test.expect(1);
    _(function (push, next) {
      push(null, 1);
      push(null, 2);
      setTimeout(function () {
        push(null, 3);
        push(null, _.nil);
      }, 40);
    }).collect().toPromise(Promise).then(function (result) {
      test.same(result, [1, 2, 3]);
      test.done();
    });
  },
  "returns error for streams with multiple values": function (test) {
    test.expect(1);
    _([1, 2]).toPromise(Promise).catch(function (err) {
      test.same(
        err.message,
        "toPromise called on stream emitting multiple values",
      );
      test.done();
    });
  },
  "returns error when stream emits error": function (test) {
    test.expect(1);
    _(function (push, next) {
      push(null, 1);
      push(null, 2);
      setTimeout(function () {
        push(new Error("Test error"));
        push(null, 3);
        push(null, _.nil);
      }, 40);
    }).collect().toPromise(Promise).catch(function (err) {
      test.same(err.message, "Test error");
      test.done();
    });
  },
  "error handling edge cases": function (test) {
    test.expect(2);
    _(function (push, next) {
      push(null, 1);
      push(new Error("Test error"));
      push(null, _.nil);
    }).toPromise(Promise).catch(function (err) {
      test.same(
        err.message,
        "toPromise called on stream emitting multiple values",
      );
    }).then(function () {
      return _(function (push, next) {
        push(null, 1);
        push(null, 2);
        push(new Error("Test error"));
        push(null, _.nil);
      }).toPromise(Promise).catch(function (err) {
        test.same(
          err.message,
          "toPromise called on stream emitting multiple values",
        );
      });
    }).then(function () {
      test.done();
    });
  },
};

exports.toNodeStream = {
  "non-object stream of buffer": function (test) {
    test.expect(1);
    var buf = new Buffer("aaa", "utf8");
    var s = _.of(buf).toNodeStream();
    s.on("end", function () {
      test.done();
    });
    s.on("data", function (val) {
      test.same(val, buf);
    });
  },
  "non-object stream of string": function (test) {
    test.expect(1);
    var s = _.of("aaa").toNodeStream({ objectMode: true });
    s.on("end", function () {
      test.done();
    });
    s.on("data", function (val) {
      test.same(val, "aaa");
    });
  },
  "object stream": function (test) {
    test.expect(1);
    var s = _.of({ a: 1 }).toNodeStream({ objectMode: true });
    s.on("end", function (val) {
      test.done();
    });
    s.on("data", function (val) {
      test.same(val, { a: 1 });
    });
  },
  "object stream no objectmode": function (test) {
    test.expect(0);
    var s = _.of({ a: 1 }).toNodeStream();
    s.on("end", function (val) {
      test.done();
    });
    s.on("data", function (val) {
      test.ok(false, "data event should not be fired");
    });
  },
  "object stream but stream error": function (test) {
    test.expect(1);
    var err = new Error("ohno");
    var s = _.fromError(err).toNodeStream({ objectMode: true });
    s.on("error", function (e) {
      test.same(e, err);
      test.done();
    });
    s.on("data", function (x) {
      test.ok(false, "data event should not be fired.");
      test.done();
    });
  },
};

exports["calls generator on read"] = function (test) {
  var gen_calls = 0;
  var s = _(function (push, next) {
    gen_calls++;
    push(null, 1);
    push(null, _.nil);
  });
  test.equal(gen_calls, 0);
  s.take(1).toArray(function (xs) {
    test.equal(gen_calls, 1);
    test.same(xs, [1]);
    s.take(1).toArray(function (ys) {
      test.equal(gen_calls, 1);
      test.same(ys, []);
      test.done();
    });
  });
};

exports["generator consumers are sent values eagerly until pause"] = function (
  test,
) {
  var s = _(function (push, next) {
    push(null, 1);
    push(null, 2);
    push(null, 3);
    push(null, _.nil);
  });
  var calls = [];
  var consumer = s.consume(function (err, x, push, next) {
    calls.push(x);
    if (x !== 2) {
      next();
    }
  });
  consumer.resume();
  test.same(JSON.stringify(calls), JSON.stringify([1, 2]));
  consumer.resume();
  test.same(calls, [1, 2, 3, _.nil]);
  test.done();
};

exports["check generator loops on next call without push"] = function (test) {
  var count = 0;
  var s = _(function (push, next) {
    count++;
    if (count < 5) {
      next();
    } else {
      push(null, count);
      push(null, _.nil);
    }
  });
  s.toArray(function (xs) {
    test.equal(count, 5);
    test.same(xs, [5]);
    test.done();
  });
};

exports["calls generator multiple times if paused by next"] = function (test) {
  var gen_calls = 0;
  var vals = [1, 2];
  var s = _(function (push, next) {
    gen_calls++;
    if (vals.length) {
      push(null, vals.shift());
      next();
    } else {
      push(null, _.nil);
    }
  });
  test.equal(gen_calls, 0);
  s.take(1).toArray(function (xs) {
    test.equal(gen_calls, 1);
    test.same(xs, [1]);
    s.take(1).toArray(function (xs) {
      test.equal(gen_calls, 2);
      test.same(xs, [2]);
      s.take(1).toArray(function (xs) {
        test.equal(gen_calls, 3);
        test.same(xs, []);
        test.done();
      });
    });
  });
};

exports["adding multiple consumers should error"] = function (test) {
  var s = _([1, 2, 3, 4]);
  s.consume(function () {});
  test.throws(function () {
    s.consume(function () {});
  });
  test.done();
};

exports["switch to alternate stream using next"] = function (test) {
  var s2_gen_calls = 0;
  var s2 = _(function (push, next) {
    s2_gen_calls++;
    push(null, 2);
    push(null, _.nil);
  });
  s2.id = "s2";
  var s1_gen_calls = 0;
  var s1 = _(function (push, next) {
    s1_gen_calls++;
    push(null, 1);
    next(s2);
  });
  s1.id = "s1";
  test.equal(s1_gen_calls, 0);
  test.equal(s2_gen_calls, 0);
  s1.take(1).toArray(function (xs) {
    test.equal(s1_gen_calls, 1);
    test.equal(s2_gen_calls, 0);
    test.same(xs, [1]);
    s1.take(1).toArray(function (xs) {
      test.equal(s1_gen_calls, 1);
      test.equal(s2_gen_calls, 1);
      test.same(xs, [2]);
      s1.take(1).toArray(function (xs) {
        test.equal(s1_gen_calls, 1);
        test.equal(s2_gen_calls, 1);
        test.same(xs, []);
        test.done();
      });
    });
  });
};

exports["switch to alternate stream using next (async)"] = function (test) {
  var s2_gen_calls = 0;
  var s2 = _(function (push, next) {
    s2_gen_calls++;
    setTimeout(function () {
      push(null, 2);
      push(null, _.nil);
    }, 10);
  });
  s2.id = "s2";
  var s1_gen_calls = 0;
  var s1 = _(function (push, next) {
    s1_gen_calls++;
    setTimeout(function () {
      push(null, 1);
      next(s2);
    }, 10);
  });
  s1.id = "s1";
  test.equal(s1_gen_calls, 0);
  test.equal(s2_gen_calls, 0);
  s1.take(1).toArray(function (xs) {
    test.equal(s1_gen_calls, 1);
    test.equal(s2_gen_calls, 0);
    test.same(xs, [1]);
    s1.take(1).toArray(function (xs) {
      test.equal(s1_gen_calls, 1);
      test.equal(s2_gen_calls, 1);
      test.same(xs, [2]);
      s1.take(1).toArray(function (xs) {
        test.equal(s1_gen_calls, 1);
        test.equal(s2_gen_calls, 1);
        test.same(xs, []);
        test.done();
      });
    });
  });
};

exports["lazily evalute stream"] = function (test) {
  test.expect(2);
  var map_calls = [];
  function doubled(x) {
    map_calls.push(x);
    return x * 2;
  }
  var s = _([1, 2, 3, 4]);
  s.id = "s";
  s.map(doubled).take(2).toArray(function (xs) {
    test.same(xs, [2, 4]);
  });
  test.same(JSON.stringify(map_calls), JSON.stringify([1, 2]));
  test.done();
};

exports.pipe = {
  "old-style node stream to highland stream": function (test) {
    var xs = [];
    var src = streamify([1, 2, 3, 4]);
    var s1 = _();
    var s2 = s1.consume(function (err, x, push, next) {
      xs.push(x);
      next();
    });
    Stream.prototype.pipe.call(src, s1);
    setTimeout(function () {
      test.same(s1._incoming, [1]);
      test.same(s2._incoming, []);
      test.same(xs, []);
      s2.resume();
      setTimeout(function () {
        test.same(s1._incoming, []);
        test.same(s2._incoming, []);
        test.same(xs, [1, 2, 3, 4, _.nil]);
        test.done();
      }, 100);
    }, 100);
  },
  "node stream to highland stream": function (test) {
    var xs = [];
    var src = streamify([1, 2, 3, 4]);
    var s1 = _();
    var s2 = s1.consume(function (err, x, push, next) {
      xs.push(x);
      next();
    });
    src.pipe(s1);
    setTimeout(function () {
      test.same(s1._incoming, [1]);
      test.same(s2._incoming, []);
      test.same(xs, []);
      s2.resume();
      setTimeout(function () {
        test.same(s1._incoming, []);
        test.same(s2._incoming, []);
        test.same(xs, [1, 2, 3, 4, _.nil]);
        test.done();
      }, 100);
    }, 100);
  },
  "highland stream to node stream": function (test) {
    var src = _(["a", "b", "c"]);
    var dest = concat(function (data) {
      test.same(data, "abc");
      test.done();
    });
    src.pipe(dest);
  },
  "pipe to node stream with backpressure": function (test) {
    test.expect(3);
    var src = _([1, 2, 3, 4]);
    var xs = [];
    var dest = new EventEmitter();
    dest.writable = true;
    dest.write = function (x) {
      xs.push(x);
      if (xs.length === 2) {
        _.setImmediate(function () {
          test.same(xs, [1, 2]);
          test.ok(src.paused);
          dest.emit("drain");
        });
        return false;
      }
      return true;
    };
    dest.end = function () {
      test.same(xs, [1, 2, 3, 4]);
      test.done();
    };
    src.pipe(dest);
  },
  'emits "error" events on error': function (test) {
    test.expect(3);
    var src = _(function (push, next) {
      push(new Error("1"));
      push(new Error("2"));
      push(null, _.nil);
    });

    var dest = new Stream.Writable({ objectMode: true });
    dest._write = function (chunk, encoding, cb) {
      cb();
    };

    var numErrors = 0;
    src.on("error", function (error) {
      numErrors++;
      test.same(error.message, String(numErrors));
    });
    src.on("end", function () {
      test.same(numErrors, 2);
      test.done();
    });

    src.pipe(dest);
  },
  'emits "pipe" event when piping (issue #449)': function (test) {
    test.expect(1);

    var src = _();
    var dest = _();
    dest.on("pipe", function (_src) {
      test.strictEqual(_src, src);
      test.done();
    });
    src.pipe(dest);
  },
  "pipe with {end:false} option should not end": function (test) {
    test.expect(1);

    var clock = sinon.useFakeTimers();
    var dest = _();
    var ended = false;
    dest.end = function () {
      ended = true;
    };

    _([1, 2, 3]).pipe(dest);

    clock.tick(10000);
    clock.restore();
    test.ok(!ended, "The destination should not have been ended.");
    test.done();
  },
  "clean up drain handler when done": function (test) {
    test.expect(2);

    var clock = sinon.useFakeTimers();

    var dest = _();
    var boundListener = false;
    var unboundListener = false;

    dest.on("newListener", function (ev) {
      if (ev === "drain") {
        boundListener = true;
      }
    });

    dest.on("removeListener", function (ev) {
      if (ev === "drain") {
        unboundListener = true;
      }
    });

    _([1, 2, 3]).pipe(dest)
      .resume();

    clock.tick(100);
    clock.restore();
    test.ok(boundListener, "No drain listener was bound.");
    test.ok(unboundListener, "No drain listener was unbound.");
    test.done();
  },
  "does not emit data synchronously (issue #671)": function (test) {
    test.expect(1);

    var dest = new Stream.Writable({ objectMode: true });
    dest._write = function (chunk, encoding, callback) {
      callback();
    };

    var writeSpy = sinon.spy(dest, "write");
    _([1, 2, 3, 4]).pipe(dest);

    test.ok(
      writeSpy.notCalled,
      "pipe() should not synchronously write to the destination stream.",
    );
    test.done();
  },
};

// ignore these tests in non-node.js environments
if (typeof process !== "undefined" && process.stdout) {
  exports.pipe["highland stream to stdout"] = function (test) {
    test.expect(1);
    var src = _([""]);
    test.doesNotThrow(function () {
      src.pipe(process.stdout);
    });
    test.done();
  };

  exports.pipe["highland stream to stdout with {end:true}"] = function (test) {
    test.expect(1);
    var src = _([""]);
    test.doesNotThrow(function () {
      src.pipe(process.stdout, { end: true });
    });
    test.done();
  };
}

// ignore these tests in non-node.js environments
if (typeof process !== "undefined" && process.stderr) {
  exports.pipe["highland stream to stderr"] = function (test) {
    test.expect(1);
    var src = _([""]);
    test.doesNotThrow(function () {
      src.pipe(process.stderr);
    });
    test.done();
  };

  exports.pipe["highland stream to stderr with {end:true}"] = function (test) {
    test.expect(1);
    var src = _([""]);
    test.doesNotThrow(function () {
      src.pipe(process.stderr, { end: true });
    });
    test.done();
  };
}

exports["wrap node stream and pipe"] = function (test) {
  test.expect(7);
  function doubled(x) {
    return x * 2;
  }
  var xs = [];
  var readable = streamify([1, 2, 3, 4]);
  var ys = _(readable).map(doubled);

  var dest = new EventEmitter();
  dest.writable = true;
  dest.write = function (x) {
    xs.push(x);
    if (xs.length === 2) {
      _.setImmediate(function () {
        test.same(xs, [2, 4]);
        test.ok(ys.source.paused);
        test.equal(readable._readableState.readingMore, false);
        dest.emit("drain");
      });
      return false;
    }
    return true;
  };
  dest.end = function () {
    test.same(xs, [2, 4, 6, 8]);
    test.done();
  };
  // make sure nothing starts until we pipe
  test.same(xs, []);
  test.same(ys._incoming, []);
  test.same(ys.source._incoming, []);
  ys.pipe(dest);
};

exports["wrap node stream with error"] = function (test) {
  test.expect(1);
  var readable = streamify([1, 2, 3, 4]);
  var err = new Error("nope");
  var xs = _(readable);
  readable.emit("error", err);

  xs.stopOnError(function (e) {
    test.strictEqual(err, e);
    test.done();
  }).each(function () {});
};

exports["attach data event handler"] = function (test) {
  var s = _([1, 2, 3, 4]);
  var xs = [];
  s.on("data", function (x) {
    xs.push(x);
  });
  s.on("end", function () {
    test.same(xs, [1, 2, 3, 4]);
    test.done();
  });
};

exports["multiple pull calls on async generator"] = function (test) {
  var calls = 0;
  function countdown(n) {
    var s = _(function (push, next) {
      calls++;
      if (n === 0) {
        push(null, _.nil);
      } else {
        setTimeout(function () {
          push(null, n);
          next(countdown(n - 1));
        }, 10);
      }
    });
    s.id = "countdown:" + n;
    return s;
  }
  var s = countdown(3);
  var s2 = _(function (push, next) {
    s.pull(function (err, x) {
      if (err || x !== _.nil) {
        push(err, x);
        next();
      } else {
        push(null, _.nil);
      }
    });
  });
  s2.id = "s2";
  s2.toArray(function (xs) {
    test.same(xs, [3, 2, 1]);
    test.same(calls, 4);
    test.done();
  });
};

exports["wrap EventEmitter (or jQuery) on handler"] = function (test) {
  var calls = [];
  var ee = {
    on: function (name, f) {
      test.same(name, "myevent");
      f(1);
      f(2);
      setTimeout(function () {
        f(3);
        test.same(calls, [1, 2, 3]);
        test.done();
      }, 10);
    },
  };
  _("myevent", ee).each(function (x) {
    calls.push(x);
  });
};

exports[
  "removing EventEmitter (or jQuery) listener on destruction (issue #500)"
] = function (test) {
  test.expect(1);
  var ee = new EventEmitter();
  var s = _("myevent", ee);

  var removed = false;

  ee.on("removeListener", function () {
    removed = true;
  });

  s.destroy();
  test.ok(removed);
  test.done();
};

exports[
  "wrap EventEmitter (or jQuery) on handler with args wrapping by function"
] = function (test) {
  var ee = {
    on: function (name, f) {
      test.same(name, "myevent");
      f(1, 2, 3);
    },
  };
  function mapper() {
    return Array.prototype.slice.call(arguments);
  }
  _("myevent", ee, mapper).each(function (x) {
    test.same(x, [1, 2, 3]);
    test.done();
  });
};

exports[
  "wrap EventEmitter (or jQuery) on handler with args wrapping by number"
] = function (test) {
  var ee = {
    on: function (name, f) {
      test.same(name, "myevent");
      f(1, 2, 3);
    },
  };
  _("myevent", ee, 2).each(function (x) {
    test.same(x, [1, 2]);
    test.done();
  });
};

exports[
  "wrap EventEmitter (or jQuery) on handler with args wrapping by array"
] = function (test) {
  var ee = {
    on: function (name, f) {
      test.same(name, "myevent");
      f(1, 2, 3);
    },
  };
  _("myevent", ee, ["one", "two", "three"]).each(function (x) {
    test.same(x, { "one": 1, "two": 2, "three": 3 });
    test.done();
  });
};

exports["wrap EventEmitter default mapper discards all but first arg"] =
  function (test) {
    var ee = {
      on: function (name, f) {
        test.same(name, "myevent");
        f(1, 2, 3);
      },
    };
    _("myevent", ee).each(function (x) {
      test.same(x, 1);
      test.done();
    });
  };

exports.sequence = function (test) {
  _.sequence([[1, 2], [3], [[4], 5]]).toArray(function (xs) {
    test.same(xs, [1, 2, 3, [4], 5]);
  });
  test.done();
};

exports["sequence - noValueOnError"] = noValueOnErrorTest(_.sequence());

exports["sequence - ArrayStream"] = function (test) {
  _([[1, 2], [3], [[4], 5]]).sequence().toArray(function (xs) {
    test.same(xs, [1, 2, 3, [4], 5]);
    test.done();
  });
};

exports["sequence - GeneratorStream"] = function (test) {
  var calls = [];
  function countdown(name, n) {
    var s = _(function (push, next) {
      calls.push(name);
      if (n === 0) {
        push(null, _.nil);
      } else {
        setTimeout(function () {
          push(null, n);
          next(countdown(name, n - 1));
        }, 10);
      }
    });
    s.id = "countdown:" + name + ":" + n;
    return s;
  }
  var s1 = countdown("one", 3);
  var s2 = countdown("two", 3);
  var s3 = countdown("three", 3);
  _([s1, s2, s3]).sequence().take(8).toArray(function (xs) {
    test.same(xs, [3, 2, 1, 3, 2, 1, 3, 2]);
    test.same(calls, [
      "one",
      "one",
      "one",
      "one",
      "two",
      "two",
      "two",
      "two",
      "three",
      "three", // last call missed off due to take(8)
    ]);
    test.done();
  });
};

exports["sequence - nested GeneratorStreams"] = function (test) {
  var s2 = _(function (push, next) {
    push(null, 2);
    push(null, _.nil);
  });
  var s1 = _(function (push, next) {
    push(null, 1);
    push(null, s2);
    push(null, _.nil);
  });
  _([s1]).sequence().toArray(function (xs) {
    test.same(xs, [1, s2]);
    test.done();
  });
};

exports["sequence - series alias"] = function (test) {
  test.equal(_.sequence, _.series);
  var s1 = _([1, 2, 3]);
  var s2 = _(function (push, next) {});
  test.equal(s1.sequence, s1.series);
  test.equal(s2.sequence, s2.series);
  test.done();
};

exports["sequence - Streams of Streams of Arrays"] = function (test) {
  _([
    _([1, 2]),
    _([3]),
    _([[4], 5]),
  ]).sequence().toArray(function (xs) {
    test.same(xs, [1, 2, 3, [4], 5]);
    test.done();
  });
};

exports.fork = function (test) {
  var s = _([1, 2, 3, 4]);
  s.id = "s";
  var s2 = s.map(function (x) {
    return x * 2;
  });
  s2.id = "s2";
  var s3 = s.fork().map(function (x) {
    return x * 3;
  });
  s3.id = "s3";
  var s2_data = [];
  var s3_data = [];
  s2.take(1).each(function (x) {
    s2_data.push(x);
  });
  // don't start until both consumers resume
  test.same(s2_data, []);
  s3.take(2).each(function (x) {
    s3_data.push(x);
  });
  test.same(s2_data, [2]);
  test.same(s3_data, [3]);
  s2.take(1).each(function (x) {
    s2_data.push(x);
  });
  test.same(s2_data, [2, 4]);
  test.same(s3_data, [3, 6]);
  s3.take(2).each(function (x) {
    s3_data.push(x);
  });
  test.same(s2_data, [2, 4]);
  test.same(s3_data, [3, 6]);
  s2.take(2).each(function (x) {
    s2_data.push(x);
  });
  test.same(s2_data, [2, 4, 6, 8]);
  test.same(s3_data, [3, 6, 9, 12]);
  test.done();
};

exports.observe = function (test) {
  var s = _([1, 2, 3, 4]);
  s.id = "s";
  var s2 = s.map(function (x) {
    return x * 2;
  });
  s2.id = "s2";
  var s3 = s.observe().map(function (x) {
    return x * 3;
  });
  s3.id = "s3";
  var s2_data = [];
  var s3_data = [];
  s2.take(1).each(function (x) {
    s2_data.push(x);
  });
  test.same(s2_data, [2]);
  test.same(s3_data, []);
  test.same(s3.source._incoming, [1]);
  s3.take(2).each(function (x) {
    s3_data.push(x);
  });
  test.same(s2_data, [2]);
  test.same(s3_data, [3]);
  s2.take(1).each(function (x) {
    s2_data.push(x);
  });
  test.same(s2_data, [2, 4]);
  test.same(s3_data, [3, 6]);
  s3.take(2).each(function (x) {
    s3_data.push(x);
  });
  test.same(s2_data, [2, 4]);
  test.same(s3_data, [3, 6]);
  s2.take(2).each(function (x) {
    s2_data.push(x);
  });
  test.same(s2_data, [2, 4, 6, 8]);
  test.same(s3_data, [3, 6, 9, 12]);
  test.done();
};

exports["observe - paused observer should not block parent (issue #215)"] =
  function (test) {
    test.expect(4);
    var s = _([1, 2, 3]),
      o1 = s.observe(),
      o2 = s.observe();

    var pulled = false;

    // Pull once in o1. This will pause o1. It should not
    // put backpressure on s.
    o1.pull(_.compose(markPulled, valueEquals(test, 1)));
    test.same(pulled, false, "The pull should not have completed yet.");

    o2.toArray(function (arr) {
      pulled = true;
      test.same(arr, [1, 2, 3]);
    });
    test.same(pulled, false, "The toArray should not have completed yet.");

    s.resume();
    test.done();

    function markPulled() {
      pulled = true;
    }
  };

exports["observe - observers should see errors."] = function (test) {
  test.expect(2);
  var s = _(function (push, next) {
    push(new Error("error"));
    push(null, _.nil);
  });

  var o = s.observe();
  s.resume();

  o.pull(errorEquals(test, "error"));
  o.pull(valueEquals(test, _.nil));
  test.done();
};

exports["observe - observers should be destroyed (issue #208)"] = function (
  test,
) {
  test.expect(6);
  var s = _([]),
    o = s.observe();
  var o2 = o.observe();

  test.same(o2.source, o, "o2.source should not be null before destroy.");
  test.same(
    o._observers,
    [o2],
    "o._observers should not be empty before destroy.",
  );
  test.same(
    s._observers,
    [o],
    "source._observers should not be empty before destroy.",
  );

  o.destroy();

  test.same(o2.source, null, "o2.source should be null after destroy.");
  test.same(o._observers, [], "o._observers should be empty after destroy.");
  test.same(
    s._observers,
    [],
    "source._observers should be empty after destroy.",
  );
  test.done();
};

exports["observe - observe consume before source emit should not throw"] =
  function (test) {
    test.expect(2);
    var arr1, arr2;

    var s = _();
    var s1 = s.observe().toArray(function (a) {
      arr1 = a;
      if (arr1 && arr2) {
        runTest();
      }
    });
    var s2 = s.observe().toArray(function (a) {
      arr2 = a;
      if (arr1 && arr2) {
        runTest();
      }
    });

    s.write(1);
    s.end();
    s.resume();

    function runTest() {
      test.same(arr1, [1]);
      test.same(arr2, [1]);
      test.done();
    }
  };

// TODO: test redirect after fork, forked streams should transfer over
// TODO: test redirect after observe, observed streams should transfer over

exports.flatten = function (test) {
  _.flatten([1, [2, [3, 4], 5], [6]]).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4, 5, 6]);
    test.done();
  });
};

exports["flatten - noValueOnError"] = noValueOnErrorTest(_.flatten());

exports["flatten - ArrayStream"] = function (test) {
  _([1, [2, [3, 4], 5], [6]]).flatten().toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4, 5, 6]);
    test.done();
  });
};

exports["flatten - GeneratorStream"] = function (test) {
  var s3 = _(function (push, next) {
    setTimeout(function () {
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 200);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      push(null, 2);
      push(null, s3);
      push(null, 5);
      push(null, _.nil);
    }, 50);
  });
  var s1 = _(function (push, next) {
    push(null, 1);
    push(null, s2);
    push(null, [6]);
    push(null, _.nil);
  });
  s1.flatten().toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4, 5, 6]);
    test.done();
  });
};

exports["flatten - nested GeneratorStreams"] = function (test) {
  var s2 = _(function (push, next) {
    push(null, 2);
    push(null, _.nil);
  });
  var s1 = _(function (push, next) {
    push(null, 1);
    push(null, s2);
    push(null, _.nil);
  });
  s1.flatten().toArray(function (xs) {
    test.same(xs, [1, 2]);
    test.done();
  });
};

exports.otherwise = function (test) {
  test.expect(5);
  _.otherwise(_([4, 5, 6]), _([1, 2, 3])).toArray(function (xs) {
    test.same(xs, [1, 2, 3]);
  });
  _.otherwise(_([4, 5, 6]), _([])).toArray(function (xs) {
    test.same(xs, [4, 5, 6]);
  });
  _.otherwise(_([]), _([1, 2, 3])).toArray(function (xs) {
    test.same(xs, [1, 2, 3]);
  });
  _.otherwise(_([]), _([])).toArray(function (xs) {
    test.same(xs, []);
  });
  // partial application
  _.otherwise(_([4, 5, 6]))(_([1, 2, 3])).toArray(function (xs) {
    test.same(xs, [1, 2, 3]);
  });
  test.done();
};

exports["otherwise - noValueOnError"] = noValueOnErrorTest(_.otherwise(_([])));

exports["otherwise - ArrayStream"] = function (test) {
  test.expect(5);
  _([1, 2, 3]).otherwise([4, 5, 6]).toArray(function (xs) {
    test.same(xs, [1, 2, 3]);
  });
  _([]).otherwise([4, 5, 6]).toArray(function (xs) {
    test.same(xs, [4, 5, 6]);
  });
  _([4, 5, 6]).otherwise([]).otherwise([]).toArray(function (xs) {
    test.same(xs, [4, 5, 6]);
  });
  _([]).otherwise([4, 5, 6]).otherwise([]).toArray(function (xs) {
    test.same(xs, [4, 5, 6]);
  });
  _([]).otherwise([]).otherwise([4, 5, 6]).toArray(function (xs) {
    test.same(xs, [4, 5, 6]);
  });
  test.done();
};

exports["otherwise - Redirect"] = function (test) {
  test.expect(3);
  _(function (push, next) {
    next(_([1, 2, 3]));
  }).otherwise([]).toArray(function (xs) {
    test.same(xs, [1, 2, 3]);
  });
  _(function (push, next) {
    next(_([1, 2, 3]));
  }).otherwise([4, 5, 6]).toArray(function (xs) {
    test.same(xs, [1, 2, 3]);
  });
  _(function (push, next) {
    next(_([]));
  }).otherwise([4, 5, 6]).toArray(function (xs) {
    test.same(xs, [4, 5, 6]);
  });
  test.done();
};

exports["otherwise - GeneratorStream"] = function (test) {
  test.expect(2);
  var empty = _(function (push, next) {
    setTimeout(function () {
      push(null, _.nil);
    }, 10);
  });
  var xs = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, _.nil);
    }, 10);
  });
  var ys = _(function (push, next) {
    setTimeout(function () {
      push(null, 2);
      push(null, _.nil);
    }, 10);
  });
  xs.otherwise(ys).toArray(function (zs) {
    test.same(zs, [1]);
    empty.otherwise(ys).toArray(function (zs) {
      test.same(zs, [2]);
      test.done();
    });
  });
};

exports["otherwise - function"] = function (test) {
  test.expect(4);
  var calls = 0;
  _([1, 2, 3]).otherwise(function () {
    calls++;
    return _([4, 5, 6]);
  }).toArray(function (xs) {
    test.same(calls, 0);
    test.same(xs, [1, 2, 3]);
  });

  var calls2 = 0;
  _([]).otherwise(function () {
    calls2++;
    return _([4, 5, 6]);
  }).toArray(function (xs) {
    test.same(calls2, 1);
    test.same(xs, [4, 5, 6]);
  });

  test.done();
};

exports.append = function (test) {
  test.expect(2);
  _.append(4, [1, 2, 3]).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
  });
  // partial application
  _.append(4)([1, 2, 3]).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
  });
  test.done();
};

exports["append - noValueOnError"] = noValueOnErrorTest(_.append(1), [1]);

exports["append - ArrayStream"] = function (test) {
  _([1, 2, 3]).append(4).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
    test.done();
  });
};

exports["append - GeneratorStream"] = function (test) {
  var s = _(function (push, next) {
    push(null, 1);
    push(null, 2);
    push(null, 3);
    push(null, _.nil);
  });
  s.append(4).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
    test.done();
  });
};

exports.reduce = function (test) {
  test.expect(3);
  function add(a, b) {
    return a + b;
  }
  _.reduce(10, add, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [20]);
  });
  // partial application
  _.reduce(10, add)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [20]);
  });
  _.reduce(10)(add)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [20]);
  });
  test.done();
};

exports["reduce - noValueOnError"] = noValueOnErrorTest(_.reduce(0, _.add), [
  0,
]);

exports["reduce - argument function throws"] = function (test) {
  test.expect(2);
  var err = new Error("error");
  var s = _([1, 2, 3, 4, 5]).reduce(0, function (memo, x) {
    if (x === 3) throw err;
    return memo + x;
  });

  s.pull(errorEquals(test, "error"));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["reduce - ArrayStream"] = function (test) {
  function add(a, b) {
    return a + b;
  }
  _([1, 2, 3, 4]).reduce(10, add).toArray(function (xs) {
    test.same(xs, [20]);
    test.done();
  });
};

exports["reduce - GeneratorStream"] = function (test) {
  function add(a, b) {
    return a + b;
  }
  var s = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.reduce(10, add).toArray(function (xs) {
    test.same(xs, [20]);
    test.done();
  });
};

exports.reduce1 = function (test) {
  test.expect(3);
  function add(a, b) {
    return a + b;
  }
  _.reduce1(add, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [10]);
  });
  // partial application
  _.reduce1(add)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [10]);
  });
  // single argument
  _.reduce1(add, [1]).toArray(function (xs) {
    test.same(xs, [1]);
  });
  test.done();
};

exports["reduce1 - noValueOnError"] = noValueOnErrorTest(_.reduce1(_.add));

exports["reduce1 - argument function throws"] = function (test) {
  test.expect(2);
  var err = new Error("error");
  var s = _([1, 2, 3, 4, 5]).reduce1(function (memo, x) {
    if (x === 3) throw err;
    return memo + x;
  });

  s.pull(errorEquals(test, "error"));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["reduce1 - ArrayStream"] = function (test) {
  function add(a, b) {
    return a + b;
  }
  _([1, 2, 3, 4]).reduce1(add).toArray(function (xs) {
    test.same(xs, [10]);
    test.done();
  });
};

exports["reduce1 - GeneratorStream"] = function (test) {
  function add(a, b) {
    return a + b;
  }
  var s = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.reduce1(add).toArray(function (xs) {
    test.same(xs, [10]);
    test.done();
  });
};

exports.scan = function (test) {
  test.expect(3);
  function add(a, b) {
    return a + b;
  }
  _.scan(10, add, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [10, 11, 13, 16, 20]);
  });
  // partial application
  _.scan(10, add)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [10, 11, 13, 16, 20]);
  });
  _.scan(10)(add)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [10, 11, 13, 16, 20]);
  });
  test.done();
};

exports["scan - noValueOnError"] = noValueOnErrorTest(_.scan(0, _.add), [0]);

exports["scan - argument function throws"] = function (test) {
  test.expect(5);
  var err = new Error("error");
  var s = _([1, 2, 3, 4, 5]).scan(0, function (memo, x) {
    if (x === 3) throw err;
    return memo + x;
  });

  s.pull(valueEquals(test, 0));
  s.pull(valueEquals(test, 1));
  s.pull(valueEquals(test, 3));
  s.pull(errorEquals(test, "error"));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["scan - ArrayStream"] = function (test) {
  function add(a, b) {
    return a + b;
  }
  _([1, 2, 3, 4]).scan(10, add).toArray(function (xs) {
    test.same(xs, [10, 11, 13, 16, 20]);
    test.done();
  });
};

exports["scan - GeneratorStream"] = function (test) {
  function add(a, b) {
    return a + b;
  }
  var s = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.scan(10, add).toArray(function (xs) {
    test.same(xs, [10, 11, 13, 16, 20]);
    test.done();
  });
};

exports["scan - GeneratorStream lazy"] = function (test) {
  var calls = [];
  function add(a, b) {
    calls.push([a, b]);
    return a + b;
  }
  var s = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.scan(10, add).take(3).toArray(function (xs) {
    test.same(calls, [
      [10, 1],
      [11, 2],
    ]);
    test.same(xs, [10, 11, 13]);
    test.done();
  });
};

exports.scan1 = function (test) {
  test.expect(3);
  function add(a, b) {
    return a + b;
  }
  _.scan1(add, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [1, 3, 6, 10]);
  });
  // partial application
  _.scan1(add)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [1, 3, 6, 10]);
  });
  // single argument
  _.scan1(add, [1]).toArray(function (xs) {
    test.same(xs, [1]);
  });
  test.done();
};

exports["scan1 - noValueOnError"] = noValueOnErrorTest(_.scan1(_.add));

exports["scan1 - argument function throws"] = function (test) {
  test.expect(4);
  var err = new Error("error");
  var s = _([1, 2, 3, 4, 5]).scan1(function (memo, x) {
    if (x === 3) throw err;
    return memo + x;
  });

  s.pull(valueEquals(test, 1));
  s.pull(valueEquals(test, 3));
  s.pull(errorEquals(test, "error"));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["scan1 - ArrayStream"] = function (test) {
  function add(a, b) {
    return a + b;
  }
  _([1, 2, 3, 4]).scan1(add).toArray(function (xs) {
    test.same(xs, [1, 3, 6, 10]);
    test.done();
  });
};

exports["scan1 - GeneratorStream"] = function (test) {
  function add(a, b) {
    return a + b;
  }
  var s = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.scan1(add).toArray(function (xs) {
    test.same(xs, [1, 3, 6, 10]);
    test.done();
  });
};

exports["scan1 - GeneratorStream lazy"] = function (test) {
  var calls = [];
  function add(a, b) {
    calls.push([a, b]);
    return a + b;
  }
  var s = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.scan1(add).take(3).toArray(function (xs) {
    test.same(calls, [
      [1, 2],
      [3, 3],
    ]);
    test.same(xs, [1, 3, 6]);
    test.done();
  });
};

exports.collect = function (test) {
  _.collect([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [[1, 2, 3, 4]]);
    test.done();
  });
};

exports["collect - noValueOnError"] = noValueOnErrorTest(_.collect(), [[]]);

exports["collect - ArrayStream"] = function (test) {
  _([1, 2, 3, 4]).collect().toArray(function (xs) {
    test.same(xs, [[1, 2, 3, 4]]);
    test.done();
  });
};

exports["collect - GeneratorStream"] = function (test) {
  var s = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.collect().toArray(function (xs) {
    test.same(xs, [[1, 2, 3, 4]]);
    test.done();
  });
};

exports.transduce = {
  setUp: function (cb) {
    var self = this;
    this.xf = transducers.map(_.add(1));
    this.input = [1, 2, 3];
    this.expected = [2, 3, 4];
    this.tester = function (expected, test) {
      return function (xs) {
        test.same(xs, expected);
      };
    };
    cb();
  },
  "ArrayStream": function (test) {
    test.expect(1);
    _(this.input)
      .transduce(this.xf)
      .toArray(this.tester(this.expected, test));
    test.done();
  },
  "GeneratorStream": function (test) {
    test.expect(1);
    generatorStream(this.input, 10)
      .transduce(this.xf)
      .toArray(this.tester(this.expected, test));
    setTimeout(test.done.bind(test), 10 * (this.input.length + 2));
  },
  "partial application": function (test) {
    test.expect(1);
    _.transduce(this.xf)(this.input)
      .toArray(this.tester(this.expected, test));
    test.done();
  },
  "passThroughError": function (test) {
    test.expect(4);
    var s = _([1, 2, 3]).map(function (x) {
      if (x === 2) {
        throw new Error("error");
      }
      return x;
    }).transduce(this.xf);

    s.pull(valueEquals(test, 2));
    s.pull(errorEquals(test, "error"));
    s.pull(valueEquals(test, 4));
    s.pull(valueEquals(test, _.nil));
    test.done();
  },
  "stopOnStepError": function (test) {
    test.expect(3);
    var s = _([1, 2, 3]).transduce(xf);

    s.pull(valueEquals(test, 1));
    s.pull(errorEquals(test, "error"));
    s.pull(valueEquals(test, _.nil));
    test.done();

    function xf(transform) {
      return {
        "@@transducer/init": transform["@@transducer/init"].bind(transform),
        "@@transducer/result": transform["@@transducer/result"].bind(transform),
        "@@transducer/step": function (result, x) {
          if (x === 2) {
            throw new Error("error");
          }
          result = transform["@@transducer/step"](result, x);
          return result;
        },
      };
    }
  },
  "stopOnResultError": function (test) {
    test.expect(5);
    var s = _([1, 2, 3]).transduce(xf);

    s.pull(valueEquals(test, 1));
    s.pull(valueEquals(test, 2));
    s.pull(valueEquals(test, 3));
    s.pull(errorEquals(test, "error"));
    s.pull(valueEquals(test, _.nil));
    test.done();

    function xf(transform) {
      return {
        "@@transducer/init": transform["@@transducer/init"].bind(transform),
        "@@transducer/result": function (result) {
          transform["@@transducer/result"](result);
          throw new Error("error");
        },
        "@@transducer/step": transform["@@transducer/step"].bind(transform),
      };
    }
  },
  "early termination": function (test) {
    test.expect(1);
    var xf = transducers.take(1);
    _([1, 2, 3])
      .transduce(xf)
      .toArray(this.tester([1], test));
    test.done();
  },
  "wrapped memo": function (test) {
    test.expect(2);
    _(this.input)
      .transduce(transducers.comp(this.xf, wrap))
      .toArray(this.tester(this.expected, test));

    _(this.input)
      .transduce(transducers.comp(wrap, this.xf))
      .toArray(this.tester(this.expected, test));
    test.done();

    function wrap(transform) {
      return {
        "@@transducer/init": function () {
          return wrapMemo(transform["@@transducer/init"]());
        },
        "@@transducer/result": function (result) {
          return wrapMemo(transform["@@transducer/result"](result.memo));
        },
        "@@transducer/step": function (result, x) {
          var res = transform["@@transducer/step"](result.memo, x);
          if (res["@@transducer/reduced"]) {
            return {
              "@@transducer/reduced": true,
              "@@transducer/value": wrapMemo(res["@transducer/value"]),
            };
          } else {
            return wrapMemo(res);
          }
        },
      };
    }

    function wrapMemo(x) {
      return {
        memo: x,
      };
    }
  },
  "noValueOnError": function (test) {
    noValueOnErrorTest(_.transduce(this.xf))(test);
  },
};

exports.concat = function (test) {
  test.expect(2);
  _.concat([3, 4], [1, 2]).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
  });
  // partial application
  _.concat([3, 4])([1, 2]).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
  });
  test.done();
};

exports["concat - noValueOnError"] = noValueOnErrorTest(_.concat([1]), [1]);

exports["concat - ArrayStream"] = function (test) {
  _([1, 2]).concat([3, 4]).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
    test.done();
  });
};

exports["concat - piped ArrayStream"] = function (test) {
  _.concat(
    streamify([3, 4])
      .pipe(new Stream.PassThrough({ objectMode: true })),
    streamify([1, 2]),
  )
    .toArray(function (xs) {
      test.same(xs, [1, 2, 3, 4]);
      test.done();
    });
};

exports["concat - piped ArrayStream - paused"] = function (test) {
  var s1 = streamify([1, 2]);
  var s2 = streamify([3, 4]);
  s2.pause();
  s1.pause();

  test.strictEqual(s1._readableState.buffer.length, 0);
  test.strictEqual(s1._readableState.reading, false);
  test.strictEqual(s2._readableState.buffer.length, 0);
  test.strictEqual(s2._readableState.reading, false);

  var s3 = _.concat(s2, s1);
  test.ok(
    s1._readableState.buffer[0] === 1 || // node 0.11.x
      s1._readableState.buffer.length === 0, // node 0.10.x
  );
  test.strictEqual(s1._readableState.reading, false);
  test.ok(
    s2._readableState.buffer[0] === 3 || // node 0.11.x
      s2._readableState.buffer.length === 0, // node 0.10.x
  );
  test.strictEqual(s2._readableState.reading, false);

  s3.toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
    test.done();
  });
};

exports["concat - GeneratorStream"] = function (test) {
  var s1 = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, 2);
      push(null, _.nil);
    }, 10);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s1.concat(s2).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
    test.done();
  });
};

exports.merge = {
  setUp: function (callback) {
    this.clock = sinon.useFakeTimers();
    callback();
  },
  tearDown: function (callback) {
    this.clock.restore();
    callback();
  },
  "top-level": function (test) {
    var s1 = _(function (push, next) {
      push(null, 1);
      setTimeout(function () {
        push(null, 2);
      }, 20);
      setTimeout(function () {
        push(null, 3);
        push(null, _.nil);
      }, 40);
    });
    var s2 = _(function (push, next) {
      setTimeout(function () {
        push(null, 4);
      }, 10);
      setTimeout(function () {
        push(null, 5);
      }, 30);
      setTimeout(function () {
        push(null, 6);
        push(null, _.nil);
      }, 50);
    });
    _.merge([s1, s2]).toArray(function (xs) {
      test.same(xs, [1, 4, 2, 5, 3, 6]);
      test.done();
    });
    this.clock.tick(100);
  },
  "ArrayStream": function (test) {
    var s1 = _(function (push, next) {
      push(null, 1);
      setTimeout(function () {
        push(null, 2);
      }, 20);
      setTimeout(function () {
        push(null, 3);
        push(null, _.nil);
      }, 40);
    });
    var s2 = _(function (push, next) {
      setTimeout(function () {
        push(null, 4);
      }, 10);
      setTimeout(function () {
        push(null, 5);
      }, 30);
      setTimeout(function () {
        push(null, 6);
        push(null, _.nil);
      }, 50);
    });
    _([s1, s2]).merge().toArray(function (xs) {
      test.same(xs, [1, 4, 2, 5, 3, 6]);
      test.done();
    });
    this.clock.tick(100);
  },
  "GeneratorStream": function (test) {
    var s1 = _(function (push, next) {
      push(null, 1);
      setTimeout(function () {
        push(null, 2);
      }, 20);
      setTimeout(function () {
        push(null, 3);
        push(null, _.nil);
      }, 40);
    });
    var s2 = _(function (push, next) {
      setTimeout(function () {
        push(null, 4);
      }, 10);
      setTimeout(function () {
        push(null, 5);
      }, 30);
      setTimeout(function () {
        push(null, 6);
        push(null, _.nil);
      }, 50);
    });
    var s = _(function (push, next) {
      push(null, s1);
      setTimeout(function () {
        push(null, s2);
        push(null, _.nil);
      }, 5);
    });
    s.merge().toArray(function (xs) {
      test.same(xs, [1, 4, 2, 5, 3, 6]);
      test.done();
    });
    this.clock.tick(100);
  },
  "pull from all streams in parallel": function (test) {
    var s1 = _(function (push, next) {
      setTimeout(function () {
        push(null, 1);
      }, 40);
      setTimeout(function () {
        push(null, 2);
        push(null, _.nil);
      }, 80);
    });
    var s2 = _(function (push, next) {
      setTimeout(function () {
        push(null, 3);
      }, 10);
      setTimeout(function () {
        push(null, 4);
      }, 20);
      setTimeout(function () {
        push(null, 5);
        push(null, _.nil);
      }, 30);
    });
    _([s1, s2]).merge().toArray(function (xs) {
      test.same(xs, [3, 4, 5, 1, 2]);
      test.done();
    });
    this.clock.tick(100);
  },
  "consume lazily": function (test) {
    var counter1 = 0;
    var s1 = _(function (push, next) {
      counter1++;
      setTimeout(function () {
        push(null, counter1);
        next();
      }, 100);
    });
    var counter2 = 0;
    var s2 = _(function (push, next) {
      counter2++;
      setTimeout(function () {
        push(null, counter2);
        next();
      }, 240);
    });
    var self = this;
    _([s1, s2]).merge().take(4).toArray(function (xs) {
      test.same(xs, [1, 2, 1, 3]);
      setTimeout(function () {
        test.equal(counter1, 3);
        test.equal(counter2, 2);
        test.done();
      }, 1000);
    });
    this.clock.tick(2000);
  },
  "read from sources as soon as they are available": function (test) {
    test.expect(2);
    var s1 = _([1, 2, 3]);
    var s2 = _([4, 5, 6]);
    var srcs = _(function (push, next) {
      setTimeout(function () {
        push(null, s1);
      }, 100);
      setTimeout(function () {
        push(null, s2);
      }, 200);
      setTimeout(function () {
        push(null, _.nil);
      }, 300);
    });
    var xs = [];
    srcs.merge().each(function (x) {
      xs.push(x);
    });
    setTimeout(function () {
      test.same(xs.slice(), [1, 2, 3]);
    }, 150);
    setTimeout(function () {
      test.same(xs.slice(), [1, 2, 3, 4, 5, 6]);
      test.done();
    }, 400);
    this.clock.tick(400);
  },
  "generator generating sources synchronously": function (test) {
    var srcs = _(function (push, next) {
      push(null, _([1, 2, 3]));
      push(null, _([3, 4, 5]));
      push(null, _([6, 7, 8]));
      push(null, _([9, 10, 11]));
      push(null, _([12, 13, 14]));
      push(null, _.nil);
    });
    srcs.merge().toArray(function (xs) {
      test.same(xs, [1, 3, 6, 9, 12, 2, 4, 7, 10, 13, 3, 5, 8, 11, 14]);
      test.done();
    });
  },
  "github issue #124: detect late end of stream": function (test) {
    var s = _([1, 2, 3])
      .map(function (x) {
        return _([x]);
      })
      .merge();

    s.toArray(function (xs) {
      test.same(xs, [1, 2, 3]);
      test.done();
    });
  },
  "handle backpressure": function (test) {
    var s1 = _([1, 2, 3, 4]);
    var s2 = _([5, 6, 7, 8]);
    var s = _.merge([s1, s2]);
    s.take(5).toArray(function (xs) {
      test.same(xs, [1, 5, 2, 6, 3]);
      _.setImmediate(function () {
        test.equal(s._outgoing.length, 0);
        test.equal(s._incoming.length, 1);
        test.equal(s1._incoming.length, 2);
        test.equal(s2._incoming.length, 2);
        test.done();
      });
    });
    this.clock.tick(100);
  },
  "fairer merge algorithm": function (test) {
    // make sure one stream with many buffered values doesn't crowd
    // out another stream being merged
    var s1 = _([1, 2, 3, 4]);
    s1.id = "s1";
    var s2 = _(function (push, next) {
      setTimeout(function () {
        push(null, 5);
        push(null, 6);
        setTimeout(function () {
          push(null, 7);
          push(null, 8);
          push(null, _.nil);
        }, 100);
      }, 100);
    });
    s2.id = "s2";
    var s = _([s1, s2]).merge();
    s.id = "s";
    s.take(1).toArray(function (xs) {
      test.same(xs, [1]);
      setTimeout(function () {
        s.take(4).toArray(function (xs) {
          test.same(xs, [5, 2, 6, 3]);
          s.toArray(function (xs) {
            test.same(xs, [4, 7, 8]);
            test.done();
          });
        });
      }, 150);
    });
    this.clock.tick(400);
  },
  "noValueOnError": noValueOnErrorTest(_.merge()),
  "pass through errors (issue #141)": function (test) {
    test.expect(1);

    var s = _(function (push, next) {
      push(new Error());
      push(null, _.nil);
    });
    _([s])
      .merge()
      .errors(anyError(test))
      .each(test.ok.bind(test, false, "each should not be called"));
    test.done();
  },
};

exports.mergeWithLimit = {
  setUp: function (callback) {
    this.clock = sinon.useFakeTimers();
    this.__delay = function (n) {
      return _(function (push, next) {
        setTimeout(function () {
          push(null, n);
          push(null, _.nil);
        }, n * 10);
      });
    };
    callback();
  },
  tearDown: function (callback) {
    this.clock.restore();
    delete this.__delay;
    callback();
  },
  "run three at a time": function (test) {
    _.mergeWithLimit(3, [5, 3, 4, 4, 2].map(this.__delay)).toArray(
      function (xs) {
        test.same(xs, [3, 4, 5, 2, 4]);
        test.done();
      },
    );
    this.clock.tick(100);
  },
  "run two at a time": function (test) {
    _.mergeWithLimit(2, [4, 3, 2, 3, 1].map(this.__delay)).toArray(
      function (xs) {
        test.same(xs, [3, 4, 2, 1, 3]);
        test.done();
      },
    );
    this.clock.tick(100);
  },
  "run one at a time": function (test) {
    _.mergeWithLimit(1, [4, 3, 2, 3, 1].map(this.__delay)).toArray(
      function (xs) {
        test.same(xs, [4, 3, 2, 3, 1]);
        test.done();
      },
    );
    this.clock.tick(150);
  },
  "handle backpressure": function (test) {
    var s1 = _([1, 2, 3, 4]);
    var s2 = _([5, 6, 7, 8]);
    var s = _.mergeWithLimit(10, [s1, s2]);
    s.take(5).toArray(function (xs) {
      test.same(xs, [1, 5, 2, 6, 3]);
      _.setImmediate(function () {
        test.equal(s._outgoing.length, 0);
        test.equal(s._incoming.length, 1);
        test.equal(s1._incoming.length, 2);
        test.equal(s2._incoming.length, 2);
        test.done();
      });
    });
    this.clock.tick(100);
  },
  "correctly forwards errors - issue #475": function (test) {
    test.expect(2);
    var s1 = _([1, 2, 3, 4]);
    var s2 = _(function (push, next) {
      push(new Error("error"));
      push(null, _.nil);
    });
    _([s1, s2]).mergeWithLimit(2)
      .errors(function (err) {
        test.equal(err.message, "error");
      })
      .toArray(function (xs) {
        test.same(xs, [1, 2, 3, 4]);
        test.done();
      });
  },
  "noValueOnError": noValueOnErrorTest(_.mergeWithLimit(1)),
};

exports.invoke = function (test) {
  test.expect(2);
  _.invoke("toString", [], [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, ["1", "2", "3", "4"]);
  });
  // partial application
  _.invoke("toString")([])([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, ["1", "2", "3", "4"]);
  });
  test.done();
};

exports["invoke - noValueOnError"] = noValueOnErrorTest(
  _.invoke("toString", []),
);

exports["invoke - ArrayStream"] = function (test) {
  _([1, 2, 3, 4]).invoke("toString", []).toArray(function (xs) {
    test.same(xs, ["1", "2", "3", "4"]);
    test.done();
  });
};

exports["invoke - GeneratorStream"] = function (test) {
  var s = _(function (push, next) {
    push(null, 1);
    push(null, 2);
    setTimeout(function () {
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.invoke("toString", []).toArray(function (xs) {
    test.same(xs, ["1", "2", "3", "4"]);
    test.done();
  });
};

exports.nfcall = function (test) {
  test.expect(4);

  function add(n) {
    return function (state, push) {
      state.val += n;
      push(null, n);
    };
  }

  var state = { val: 0 };
  _.nfcall([state], [add(1), add(2)]).series().toArray(function (xs) {
    test.equals(state.val, 3);
    test.same(xs, [1, 2]);
  });
  // partial application
  _.nfcall([state])([add(3), add(4)]).series().toArray(function (xs) {
    test.equals(state.val, 10);
    test.same(xs, [3, 4]);
  });
  test.done();
};

exports["nfcall - noValueOnError"] = noValueOnErrorTest(_.nfcall([]));

exports["nfcall - ArrayStream"] = function (test) {
  function add(n) {
    return function (state, push) {
      state.val += n;
      return push(null, n);
    };
  }

  var state = { val: 0 };
  _([add(1), add(2)]).nfcall([state]).series().toArray(function (xs) {
    test.equals(state.val, 3);
    test.same(xs, [1, 2]);
    test.done();
  });
};

exports["nfcall - GeneratorStream"] = function (test) {
  function add(n) {
    return function (state, push) {
      state.val += n;
      return push(null, n);
    };
  }

  var s = _(function (push, next) {
    push(null, add(1));
    setTimeout(function () {
      push(null, add(2));
      push(null, _.nil);
    }, 10);
  });

  var state = { val: 0 };
  s.nfcall([state]).series().toArray(function (xs) {
    test.equals(state.val, 3);
    test.same(xs, [1, 2]);
    test.done();
  });
};

exports["nfcall - parallel result ordering"] = function (test) {
  _([
    function (callback) {
      setTimeout(function () {
        callback(null, "one");
      }, 20);
    },
    function (callback) {
      setTimeout(function () {
        callback(null, "two");
      }, 10);
    },
  ]).nfcall([]).parallel(2).toArray(function (xs) {
    test.same(xs, ["one", "two"]);
    test.done();
  });
};

exports.map = function (test) {
  test.expect(2);
  function doubled(x) {
    return x * 2;
  }
  _.map(doubled, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [2, 4, 6, 8]);
  });
  // partial application
  _.map(doubled)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [2, 4, 6, 8]);
  });
  test.done();
};

exports["map - noValueOnError"] = noValueOnErrorTest(_.map(function (x) {
  return x;
}));

exports["map - argument function throws"] = function (test) {
  test.expect(6);
  var err = new Error("error");
  var s = _([1, 2, 3, 4, 5]).map(function (x) {
    if (x === 3) throw err;
    return x + 1;
  });

  s.pull(valueEquals(test, 2));
  s.pull(valueEquals(test, 3));
  s.pull(errorEquals(test, "error"));
  s.pull(valueEquals(test, 5));
  s.pull(valueEquals(test, 6));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["map - ArrayStream"] = function (test) {
  function doubled(x) {
    return x * 2;
  }
  _([1, 2, 3, 4]).map(doubled).toArray(function (xs) {
    test.same(xs, [2, 4, 6, 8]);
    test.done();
  });
};

exports["map - GeneratorStream"] = function (test) {
  function doubled(x) {
    return x * 2;
  }
  var s = _(function (push, next) {
    push(null, 1);
    push(null, 2);
    setTimeout(function () {
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.map(doubled).toArray(function (xs) {
    test.same(xs, [2, 4, 6, 8]);
    test.done();
  });
};

exports["map to value"] = function (test) {
  test.expect(2);
  _.map("foo", [1, 2]).toArray(function (xs) {
    test.same(xs, ["foo", "foo"]);
  });
  _([1, 2, 3]).map(1).toArray(function (xs) {
    test.same(xs, [1, 1, 1]);
  });
  test.done();
};

exports.doto = function (test) {
  test.expect(4);

  var seen;
  function record(x) {
    seen.push(x * 2);
  }

  seen = [];
  _.doto(record, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
    test.same(seen, [2, 4, 6, 8]);
  });

  // partial application
  seen = [];
  _.doto(record)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [1, 2, 3, 4]);
    test.same(seen, [2, 4, 6, 8]);
  });
  test.done();
};

exports["doto - noValueOnError"] = noValueOnErrorTest(_.doto(function (x) {
  return x;
}));

exports["tap - doto alias"] = function (test) {
  test.expect(2);

  test.strictEqual(_.tap, _.doto);
  test.strictEqual(_([]).tap, _([]).doto);

  test.done();
};

exports.flatMap = function (test) {
  var f = function (x) {
    return _(function (push, next) {
      setTimeout(function () {
        push(null, x * 2);
        push(null, _.nil);
      }, 10);
    });
  };
  _.flatMap(f, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [2, 4, 6, 8]);
    test.done();
  });
};

exports["flatMap - noValueOnError"] = noValueOnErrorTest(
  _.flatMap(function (x) {
    return _();
  }),
);

exports["flatMap - argument function throws"] = function (test) {
  test.expect(4);
  var err = new Error("error");
  var s = _([1, 2, 3, 4]).flatMap(function (x) {
    if (x === 1) return _([x]);
    if (x === 2) throw err;
    if (x === 3) return _([]);
    return true;
  });

  s.pull(valueEquals(test, 1));
  s.pull(errorEquals(test, "error"));
  s.pull(anyError(test));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["flatMap - ArrayStream"] = function (test) {
  var f = function (x) {
    return _(function (push, next) {
      setTimeout(function () {
        push(null, x * 2);
        push(null, _.nil);
      }, 10);
    });
  };
  _([1, 2, 3, 4]).flatMap(f).toArray(function (xs) {
    test.same(xs, [2, 4, 6, 8]);
    test.done();
  });
};

exports["flatMap - GeneratorStream"] = function (test) {
  var f = function (x) {
    return _(function (push, next) {
      setTimeout(function () {
        push(null, x * 2);
        push(null, _.nil);
      }, 10);
    });
  };
  var s = _(function (push, next) {
    push(null, 1);
    push(null, 2);
    setTimeout(function () {
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.flatMap(f).toArray(function (xs) {
    test.same(xs, [2, 4, 6, 8]);
    test.done();
  });
};

exports["flatMap - map to Stream of Array"] = function (test) {
  test.expect(1);
  var f = function (x) {
    return _([[x]]);
  };
  var s = _([1, 2, 3, 4]).flatMap(f).toArray(function (xs) {
    test.same(xs, [[1], [2], [3], [4]]);
    test.done();
  });
};

exports.pluck = function (test) {
  var a = _([
    { type: "blogpost", title: "foo" },
    { type: "blogpost", title: "bar" },
    { type: "asdf", title: "baz" },
  ]);
  a.pluck("title").toArray(function (xs) {
    test.same(xs, ["foo", "bar", "baz"]);
    test.done();
  });
};

exports["pluck - noValueOnError"] = noValueOnErrorTest(_.pluck("foo"));

exports["pluck - non-object argument"] = function (test) {
  var a = _([1, { type: "blogpost", title: "foo" }]);
  test.throws(function () {
    a.pluck("title").toArray(function (xs) {
      test.ok(false, "shouldn't be called");
    });
  }, "Expected Object, got array");
  test.done();
};

exports.pick = function (test) {
  test.expect(2);
  var a = _([
    { breed: "chihuahua", name: "Princess", age: 5 },
    { breed: "labrador", name: "Rocky", age: 3 },
    { breed: "german-shepherd", name: "Waffles", age: 9 },
  ]);
  a.pick(["breed", "age"]).toArray(function (xs) {
    test.deepEqual(xs, [
      { breed: "chihuahua", age: 5 },
      { breed: "labrador", age: 3 },
      { breed: "german-shepherd", age: 9 },
    ]);
  });

  var b = _([
    Object.create({ breed: "chihuahua", name: "Princess", age: 5 }),
    { breed: "labrador", name: "Rocky", age: 3 },
    { breed: "german-shepherd", name: "Waffles", age: 9 },
  ]);

  b.pick(["breed", "age"]).toArray(function (xs) {
    test.deepEqual(xs, [
      { breed: "chihuahua", age: 5 },
      { breed: "labrador", age: 3 },
      { breed: "german-shepherd", age: 9 },
    ]);
  });

  test.done();
};

exports["pick - noValueOnError"] = noValueOnErrorTest(_.pick(["plug"]));

exports["pick - non-existant property"] = function (test) {
  test.expect(9);

  var a = [
    { breed: "labrador", name: "Rocky" }, // <- missing age
  ];

  _(a).pick(["breed", "age"]).toArray(function (xs) {
    test.equal(xs[0].breed, "labrador");
    test.ok(Object.keys(xs[0]).length === 1);
  });

  _(a).pick(["age"]).toArray(function (xs) {
    test.ok(Object.keys(xs[0]).length === 0);
  });

  var b = _([
    { breed: "labrador", age: void 0 },
  ]);

  b.pick(["breed", "age"]).toArray(function (xs) {
    test.equal(xs[0].breed, "labrador");
    test.ok(xs[0].hasOwnProperty("age"));
    test.ok(typeof (xs[0].age) === "undefined");
  });

  var c = _([
    {},
  ]);

  c.pick(["age"]).toArray(function (xs) {
    test.ok(Object.keys(xs[0]).length === 0);
  });

  var noProtoObj = Object.create(null);
  noProtoObj.breed = "labrador";
  noProtoObj.name = "Rocky";

  var d = _([
    noProtoObj,
  ]);

  d.pick(["breed", "age"]).toArray(function (xs) {
    test.equal(xs[0].breed, "labrador");
    test.ok(Object.keys(xs[0]).length === 1);
  });

  test.done();
};

exports["pick - non-enumerable properties"] = function (test) {
  test.expect(5);
  var aObj = {
    breed: "labrador",
    name: "Rocky",
    owner: "Adrian",
    color: "chocolate",
  };
  Object.defineProperty(aObj, "age", { enumerable: false, value: 12 });
  delete aObj.owner;
  aObj.name = undefined;

  var a = _([
    aObj, // <- owner delete, name undefined, age non-enumerable
  ]);

  a.pick(["breed", "age", "name", "owner"]).toArray(function (xs) {
    test.equal(xs[0].breed, "labrador");
    test.equal(xs[0].age, 12);
    test.ok(xs[0].hasOwnProperty("name"));
    test.ok(typeof (xs[0].name) === "undefined");
    // neither owner nor color was selected
    test.ok(Object.keys(xs[0]).length === 3);
  });

  test.done();
};

exports.pickBy = function (test) {
  test.expect(4);

  var objs = [{ a: 1, _a: 2 }, { a: 1, _c: 3 }];

  _(objs).pickBy(function (key, value) {
    return key.indexOf("_") === 0 && typeof value !== "function";
  }).toArray(function (xs) {
    test.deepEqual(xs, [{ _a: 2 }, { _c: 3 }]);
  });

  var objs2 = [{ a: 1, b: { c: 2 } }, { a: 1, b: { c: 4 } }, {
    d: 1,
    b: { c: 9 },
  }];

  _(objs2).pickBy(function (key, value) {
    if (key === "b" && typeof value.c !== "undefined") {
      return value.c > 3;
    }
    return false;
  }).toArray(function (xs) {
    test.deepEqual(xs, [{}, { b: { c: 4 } }, { b: { c: 9 } }]);
  });

  var noProtoObj = Object.create(null);
  noProtoObj.a = 1;
  noProtoObj.b = { c: 4 };

  var objs3 = _([{ a: 1, b: { c: 2 } }, noProtoObj, { d: 1, b: { c: 9 } }]);

  objs3.pickBy(function (key, value) {
    if (key === "b" && typeof value.c !== "undefined") {
      return value.c > 3;
    }
    return false;
  }).toArray(function (xs) {
    test.deepEqual(xs, [{}, { b: { c: 4 } }, { b: { c: 9 } }]);
  });

  var objs4 = [Object.create({ a: 1, _a: 2 }), { a: 1, _c: 3 }];

  _(objs4).pickBy(function (key, value) {
    return key.indexOf("_") === 0 && typeof value !== "function";
  }).toArray(function (xs) {
    test.deepEqual(xs, [{ _a: 2 }, { _c: 3 }]);
  });

  test.done();
};

exports["pickBy - noValueOnError"] = noValueOnErrorTest(_.pickBy(" "));

exports["pickBy - non-existant property"] = function (test) {
  test.expect(3);

  var objs = [{ a: 1, b: 2 }, { a: 1, d: 3 }];

  _(objs).pickBy(function (key, value) {
    return key.indexOf("_") === 0 && typeof value !== "function";
  }).toArray(function (xs) {
    test.deepEqual(xs, [{}, {}]);
  });

  var objs2 = [{ a: 1, b: { c: 2 } }, { a: 1, b: { c: 4 } }, {
    d: 1,
    b: { c: 9 },
  }];

  _(objs2).pickBy(function (key, value) {
    if (key === "b" && typeof value.c !== "undefined") {
      return value.c > 10;
    }
    return false;
  }).toArray(function (xs) {
    test.deepEqual(xs, [{}, {}, {}]);
  });

  var objs3 = [{}, {}];

  _(objs3).pickBy(function (key, value) {
    return key.indexOf("_") === 0 && typeof value !== "function";
  }).toArray(function (xs) {
    test.deepEqual(xs, [{}, {}]);
  });

  test.done();
};

var isES5 = (function () {
  "use strict";
  return Function.prototype.bind && !this;
}());

exports["pickBy - non-enumerable properties"] = function (test) {
  test.expect(5);
  var aObj = { a: 5, c: 5, d: 10, e: 10 };
  Object.defineProperty(aObj, "b", { enumerable: false, value: 15 });
  delete aObj.c;
  aObj.d = undefined;

  var a = _([
    aObj, // <- c delete, d undefined, b non-enumerable but valid
  ]);

  a.pickBy(function (key, value) {
    if (key === "b" || value === 5 || typeof value === "undefined") {
      return true;
    }
    return false;
  }).toArray(function (xs) {
    test.equal(xs[0].a, 5);
    if (isES5) {
      test.equal(xs[0].b, 15);
    } else {
      test.ok(typeof (xs[0].b) === "undefined");
    }
    test.ok(xs[0].hasOwnProperty("d"));
    test.ok(typeof (xs[0].d) === "undefined");
    // neither c nor e was selected, b is not selected by keys
    if (isES5) {
      test.ok(Object.keys(xs[0]).length === 3);
    } else {
      test.ok(Object.keys(xs[0]).length === 2);
    }
  });

  test.done();
};

exports["pickBy - overridden properties"] = function (test) {
  test.expect(7);
  var aObj = {
    a: 5,
    c: 5,
    d: 10,
    e: 10,
    valueOf: 10,
  };
  var bObj = Object.create(aObj);
  bObj.b = 10;
  bObj.c = 10;
  bObj.d = 5;

  var a = _([
    bObj,
  ]);

  a.pickBy(function (key, value) {
    if (value > 7) {
      return true;
    }
    return false;
  }).toArray(function (xs) {
    test.ok(typeof (xs[0].a) === "undefined");
    test.equal(xs[0].b, 10);
    test.equal(xs[0].c, 10);
    test.ok(typeof (xs[0].d) === "undefined");
    test.equal(xs[0].e, 10);
    test.equal(xs[0].valueOf, 10);
    test.ok(Object.keys(xs[0]).length === 4);
  });

  test.done();
};

exports.filter = function (test) {
  test.expect(2);
  function isEven(x) {
    return x % 2 === 0;
  }
  _.filter(isEven, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [2, 4]);
  });
  // partial application
  _.filter(isEven)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [2, 4]);
  });
  test.done();
};

exports["filter - noValueOnError"] = noValueOnErrorTest(_.filter(function (x) {
  return true;
}));

exports["filter - argument function throws"] = function (test) {
  test.expect(3);
  var err = new Error("error");
  var s = _([1, 2, 3]).filter(function (x) {
    if (x === 2) throw err;
    if (x === 3) return false;
    return true;
  });

  s.pull(valueEquals(test, 1));
  s.pull(errorEquals(test, "error"));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["filter - ArrayStream"] = function (test) {
  function isEven(x) {
    return x % 2 === 0;
  }
  _([1, 2, 3, 4]).filter(isEven).toArray(function (xs) {
    test.same(xs, [2, 4]);
    test.done();
  });
};

exports["filter - GeneratorStream"] = function (test) {
  function isEven(x) {
    return x % 2 === 0;
  }
  var s = _(function (push, next) {
    push(null, 1);
    push(null, 2);
    setTimeout(function () {
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.filter(isEven).toArray(function (xs) {
    test.same(xs, [2, 4]);
    test.done();
  });
};

exports.flatFilter = function (test) {
  var f = function (x) {
    return _([x % 2 === 0]);
  };
  _.flatFilter(f, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [2, 4]);
    test.done();
  });
};

exports["flatFilter - noValueOnError"] = noValueOnErrorTest(
  _.flatFilter(function (x) {
    return _([true]);
  }),
);

exports["flatFilter - argument function throws"] = function (test) {
  test.expect(4);
  var err = new Error("error");
  var s = _([1, 2, 3, 4]).flatFilter(function (x) {
    if (x === 1) return _([false]);
    if (x === 2) throw err;
    if (x === 3) return _([]);
    return true;
  });

  s.pull(errorEquals(test, "error"));
  s.pull(anyError(test));
  s.pull(anyError(test));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["flatFilter - ArrayStream"] = function (test) {
  var f = function (x) {
    return _(function (push, next) {
      setTimeout(function () {
        push(null, x % 2 === 0);
        push(null, _.nil);
      }, 10);
    });
  };
  _([1, 2, 3, 4]).flatFilter(f).toArray(function (xs) {
    test.same(xs, [2, 4]);
    test.done();
  });
};

exports["flatFilter - GeneratorStream"] = function (test) {
  var f = function (x) {
    return _(function (push, next) {
      setTimeout(function () {
        push(null, x % 2 === 0);
        push(null, _.nil);
      }, 10);
    });
  };
  var s = _(function (push, next) {
    push(null, 1);
    setTimeout(function () {
      push(null, 2);
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.flatFilter(f).toArray(function (xs) {
    test.same(xs, [2, 4]);
    test.done();
  });
};

exports.reject = function (test) {
  test.expect(2);
  function isEven(x) {
    return x % 2 === 0;
  }
  _.reject(isEven, [1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [1, 3]);
  });
  // partial application
  _.reject(isEven)([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [1, 3]);
  });
  test.done();
};

exports["reject - noValueOnError"] = noValueOnErrorTest(_.reject(function (x) {
  return false;
}));

exports["reject - ArrayStream"] = function (test) {
  function isEven(x) {
    return x % 2 === 0;
  }
  _([1, 2, 3, 4]).reject(isEven).toArray(function (xs) {
    test.same(xs, [1, 3]);
    test.done();
  });
};

exports["reject - GeneratorStream"] = function (test) {
  function isEven(x) {
    return x % 2 === 0;
  }
  var s = _(function (push, next) {
    push(null, 1);
    push(null, 2);
    setTimeout(function () {
      push(null, 3);
      push(null, 4);
      push(null, _.nil);
    }, 10);
  });
  s.reject(isEven).toArray(function (xs) {
    test.same(xs, [1, 3]);
    test.done();
  });
};

exports.find = function (test) {
  test.expect(2);
  var xs = [
    { type: "foo", name: "wibble" },
    { type: "foo", name: "wobble" },
    { type: "bar", name: "123" },
    { type: "bar", name: "asdf" },
    { type: "baz", name: "asdf" },
  ];
  var f = function (x) {
    return x.type === "bar";
  };
  _.find(f, xs).toArray(function (xs) {
    test.same(xs, [{ type: "bar", name: "123" }]);
  });

  // partial application
  _.find(f)(xs).toArray(function (xs) {
    test.same(xs, [{ type: "bar", name: "123" }]);
  });

  test.done();
};

exports["find - noValueOnError"] = noValueOnErrorTest(_.find(function (x) {
  return true;
}));

exports["find - argument function throws"] = function (test) {
  test.expect(4);
  var err = new Error("error");
  var s = _([1, 2, 3, 4, 5]).find(function (x) {
    if (x < 3) throw err;
    return true;
  });

  s.pull(errorEquals(test, "error"));
  s.pull(errorEquals(test, "error"));
  s.pull(valueEquals(test, 3));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["find - ArrayStream"] = function (test) {
  var xs = [
    { type: "foo", name: "wibble" },
    { type: "foo", name: "wobble" },
    { type: "bar", name: "123" },
    { type: "bar", name: "asdf" },
    { type: "baz", name: "asdf" },
  ];
  var f = function (x) {
    return x.type === "bar";
  };
  _(xs).find(f).toArray(function (xs) {
    test.same(xs, [{ type: "bar", name: "123" }]);
    test.done();
  });
};

exports["find - GeneratorStream"] = function (test) {
  var xs = _(function (push, next) {
    push(null, { type: "foo", name: "wibble" });
    push(null, { type: "foo", name: "wobble" });
    setTimeout(function () {
      push(null, { type: "bar", name: "123" });
      push(null, { type: "bar", name: "asdf" });
      push(null, { type: "baz", name: "asdf" });
      push(null, _.nil);
    }, 10);
  });
  var f = function (x) {
    return x.type === "baz";
  };
  _(xs).find(f).toArray(function (xs) {
    test.same(xs, [{ type: "baz", name: "asdf" }]);
    test.done();
  });
};

(function (exports) {
  var xs = [
    { type: "foo", name: "wibble" },
    { type: "foo", name: "wobble" },
    { type: "bar", name: "123" },
    { type: "bar", name: "asdf" },
    { type: "baz", name: "asdf" },
  ];

  var expected = {
    "foo": [{ type: "foo", name: "wibble" }, { type: "foo", name: "wobble" }],
    "bar": [{ type: "bar", name: "123" }, { type: "bar", name: "asdf" }],
    "baz": [{ type: "baz", name: "asdf" }],
  };

  var noProtoObj = Object.create(null);
  noProtoObj.type = "foo";
  noProtoObj.name = "wibble";

  var xsNoProto = [
    noProtoObj,
    { type: "foo", name: "wobble" },
    { type: "bar", name: "123" },
    { type: "bar", name: "asdf" },
    { type: "baz", name: "asdf" },
  ];

  var primatives = [1, 2, 3, "cat"];

  var pexpected = { 1: [1], 2: [2], 3: [3], "cat": ["cat"] };
  var pexpectedUndefined = { "undefined": [1, 2, 3, "cat"] };

  var f = function (x) {
    return x.type;
  };

  var pf = function (o) {
    return o;
  };

  var s = "type";

  exports.group = function (test) {
    test.expect(8);

    _.group(f, xs).toArray(function (xs) {
      test.same(xs, [expected]);
    });
    _.group(s, xs).toArray(function (xs) {
      test.same(xs, [expected]);
    });
    _.group(f, xsNoProto).toArray(function (xs) {
      test.same(xs, [expected]);
    });
    _.group(s, xsNoProto).toArray(function (xs) {
      test.same(xs, [expected]);
    });

    // partial application
    _.group(f)(xs).toArray(function (xs) {
      test.same(xs, [expected]);
    });
    _.group(s)(xs).toArray(function (xs) {
      test.same(xs, [expected]);
    });
    _.group(f)(xsNoProto).toArray(function (xs) {
      test.same(xs, [expected]);
    });
    _.group(s)(xsNoProto).toArray(function (xs) {
      test.same(xs, [expected]);
    });
    test.done();
  };

  exports["group - noValueOnError"] = noValueOnErrorTest(_.group("foo"), [{}]);

  exports["group - primatives"] = function (test) {
    test.expect(5);

    _.group(pf, primatives).toArray(function (xs) {
      test.same(xs, [pexpected]);
    });
    _.group(s, primatives).toArray(function (xs) {
      test.same(xs, [pexpectedUndefined]);
    });
    test.throws(function () {
      _.group(null, primatives).toArray(_.log);
    });

    // partial application
    _.group(pf)(primatives).toArray(function (xs) {
      test.same(xs, [pexpected]);
    });
    test.throws(function () {
      _.group(null)(primatives).toArray(_.log);
    });

    test.done();
  };

  exports["group - argument function throws"] = function (test) {
    test.expect(2);
    var err = new Error("error");
    var s = _([1, 2, 3, 4, 5]).group(function (x) {
      if (x === 5) throw err;
      return x % 2 === 0 ? "even" : "odd";
    });

    s.pull(errorEquals(test, "error"));
    s.pull(valueEquals(test, _.nil));
    test.done();
  };

  exports["group - ArrayStream"] = function (test) {
    test.expect(2);

    _(xs).group(f).toArray(function (xs) {
      test.same(xs, [expected]);
    });
    _(xs).group(s).toArray(function (xs) {
      test.same(xs, [expected]);
    });
    test.done();
  };

  exports["group - GeneratorStream"] = function (test) {
    var generator = _(function (push, next) {
      push(null, xs[0]);
      push(null, xs[1]);
      setTimeout(function () {
        push(null, xs[2]);
        push(null, xs[3]);
        push(null, xs[4]);
        push(null, _.nil);
      }, 10);
    });

    _(generator).group(f).toArray(function (result) {
      test.same(result, [expected]);
      test.done();
    });
  };
}(exports));

exports.compact = function (test) {
  test.expect(1);
  _.compact([0, 1, false, 3, undefined, null, 6]).toArray(function (xs) {
    test.same(xs, [1, 3, 6]);
  });
  test.done();
};

exports["compact - noValueOnError"] = noValueOnErrorTest(_.compact());

exports["compact - ArrayStream"] = function (test) {
  _([0, 1, false, 3, undefined, null, 6]).compact().toArray(function (xs) {
    test.same(xs, [1, 3, 6]);
    test.done();
  });
};

exports.where = function (test) {
  test.expect(2);
  var xs = [
    { type: "foo", name: "wibble" },
    { type: "foo", name: "wobble" },
    { type: "bar", name: "123" },
    { type: "bar", name: "asdf" },
    { type: "baz", name: "asdf" },
  ];

  _.where({ type: "foo" }, xs).toArray(function (xs) {
    test.same(xs, [
      { type: "foo", name: "wibble" },
      { type: "foo", name: "wobble" },
    ]);
  });

  // partial application
  _.where({ type: "bar", name: "asdf" })(xs).toArray(function (xs) {
    test.same(xs, [
      { type: "bar", name: "asdf" },
    ]);
  });

  test.done();
};

exports["where - noValueOnError"] = noValueOnErrorTest(
  _.where({ "foo": "bar" }),
);

exports["where - ArrayStream"] = function (test) {
  test.expect(2);
  var xs = [
    { type: "foo", name: "wibble" },
    { type: "foo", name: "wobble" },
    { type: "bar", name: "123" },
    { type: "bar", name: "asdf" },
    { type: "baz", name: "asdf" },
  ];
  _(xs).where({ type: "foo" }).toArray(function (xs) {
    test.same(xs, [
      { type: "foo", name: "wibble" },
      { type: "foo", name: "wobble" },
    ]);
  });
  _(xs).where({ type: "bar", name: "asdf" }).toArray(function (xs) {
    test.same(xs, [
      { type: "bar", name: "asdf" },
    ]);
  });
  test.done();
};

exports["where - GeneratorStream"] = function (test) {
  var xs = _(function (push, next) {
    push(null, { type: "foo", name: "wibble" });
    push(null, { type: "foo", name: "wobble" });
    setTimeout(function () {
      push(null, { type: "bar", name: "123" });
      push(null, { type: "bar", name: "asdf" });
      push(null, { type: "baz", name: "asdf" });
      push(null, _.nil);
    }, 10);
  });
  _(xs).where({ name: "asdf" }).toArray(function (xs) {
    test.same(xs, [
      { type: "bar", name: "asdf" },
      { type: "baz", name: "asdf" },
    ]);
    test.done();
  });
};

exports.findWhere = function (test) {
  test.expect(2);
  var xs = [
    { type: "foo", name: "wibble" },
    { type: "foo", name: "wobble" },
    { type: "bar", name: "123" },
    { type: "bar", name: "asdf" },
    { type: "baz", name: "asdf" },
  ];
  _.findWhere({ type: "bar" }, xs).toArray(function (xs) {
    test.same(xs, [{ type: "bar", name: "123" }]);
  });
  // partial application
  _.findWhere({ type: "bar" })(xs).toArray(function (xs) {
    test.same(xs, [{ type: "bar", name: "123" }]);
  });
  test.done();
};

exports["findWhere - noValueOnError"] = noValueOnErrorTest(
  _.findWhere({ "foo": "bar" }),
);

exports["findWhere - ArrayStream"] = function (test) {
  test.expect(2);
  var xs = [
    { type: "foo", name: "wibble" },
    { type: "foo", name: "wobble" },
    { type: "bar", name: "123" },
    { type: "bar", name: "asdf" },
    { type: "baz", name: "asdf" },
  ];
  _(xs).findWhere({ type: "bar" }).toArray(function (xs) {
    test.same(xs, [{ type: "bar", name: "123" }]);
  });
  _(xs).findWhere({ type: "bar", name: "asdf" }).toArray(function (xs) {
    test.same(xs, [{ type: "bar", name: "asdf" }]);
  });
  test.done();
};

exports["findWhere - GeneratorStream"] = function (test) {
  var xs = _(function (push, next) {
    push(null, { type: "foo", name: "wibble" });
    push(null, { type: "foo", name: "wobble" });
    setTimeout(function () {
      push(null, { type: "bar", name: "123" });
      push(null, { type: "bar", name: "asdf" });
      push(null, { type: "baz", name: "asdf" });
      push(null, _.nil);
    }, 10);
  });
  _(xs).findWhere({ name: "asdf" }).toArray(function (xs) {
    test.same(xs, [{ type: "bar", name: "asdf" }]);
    test.done();
  });
};

exports.uniqBy = function (test) {
  test.expect(1);
  var xs = ["blue", "red", "red", "yellow", "blue", "red"];
  _.uniqBy(function (a, b) {
    return a[1] === b[1];
  }, xs).toArray(function (xs) {
    test.same(xs, ["blue", "red"]);
  });
  test.done();
};

exports["uniqBy - compare error"] = function (test) {
  test.expect(4);
  var xs = ["blue", "red", "red", "yellow", "blue", "red"];
  var s = _.uniqBy(function (a, b) {
    if (a === "yellow") {
      throw new Error("yellow");
    }
    return a === b;
  }, xs);
  s.pull(function (err, x) {
    test.equal(x, "blue");
  });
  s.pull(function (err, x) {
    test.equal(x, "red");
  });
  s.pull(function (err, x) {
    test.equal(err.message, "yellow");
  });
  s.pull(function (err, x) {
    test.equal(x, _.nil);
  });
  test.done();
};

exports["uniqBy - noValueOnError"] = noValueOnErrorTest(
  _.uniqBy(function (a, b) {
    return a === b;
  }),
);

exports.uniq = function (test) {
  test.expect(1);
  var xs = ["blue", "red", "red", "yellow", "blue", "red"];
  _.uniq(xs).toArray(function (xs) {
    test.same(xs, ["blue", "red", "yellow"]);
  });
  test.done();
};

exports["uniq - preserves Nan"] = function (test) {
  test.expect(5);
  var xs = ["blue", "red", NaN, "red", "yellow", "blue", "red", NaN];
  _.uniq(xs).toArray(function (xs) {
    test.equal(xs[0], "blue");
    test.equal(xs[1], "red");
    test.equal(xs[2] !== xs[2], true);
    test.equal(xs[3], "yellow");
    test.equal(xs[4] !== xs[4], true);
  });
  test.done();
};

exports["uniq - noValueOnError"] = noValueOnErrorTest(_.uniq());

exports.zip = function (test) {
  test.expect(2);
  _.zip([1, 2, 3], ["a", "b", "c"]).toArray(function (xs) {
    test.same(xs, [["a", 1], ["b", 2], ["c", 3]]);
  });
  // partial application
  _.zip([1, 2, 3, 4, 5])(["a", "b", "c"]).toArray(function (xs) {
    test.same(xs, [["a", 1], ["b", 2], ["c", 3]]);
  });
  test.done();
};

exports["zip - noValueOnError"] = noValueOnErrorTest(_.zip([1]));

exports["zip - source emits error"] = function (test) {
  test.expect(4);
  var err = new Error("error");
  var s1 = _([1, 2]);
  var s2 = _(function (push) {
    push(null, "a");
    push(err);
    push(null, "b");
    push(null, _.nil);
  });

  var s = s1.zip(s2);
  s.pull(function (err, x) {
    test.deepEqual(x, [1, "a"]);
  });
  s.pull(function (err, x) {
    test.equal(err.message, "error");
  });
  s.pull(function (err, x) {
    test.deepEqual(x, [2, "b"]);
  });
  s.pull(function (err, x) {
    test.equal(x, _.nil);
  });
  test.done();
};

exports["zip - ArrayStream"] = function (test) {
  _(["a", "b", "c"]).zip([1, 2, 3]).toArray(function (xs) {
    test.same(xs, [["a", 1], ["b", 2], ["c", 3]]);
    test.done();
  });
};

exports["zip - GeneratorStream"] = function (test) {
  var s1 = _(function (push, next) {
    push(null, "a");
    setTimeout(function () {
      push(null, "b");
      setTimeout(function () {
        push(null, "c");
        push(null, _.nil);
      }, 10);
    }, 10);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      push(null, 1);
      push(null, 2);
      setTimeout(function () {
        push(null, 3);
        push(null, _.nil);
      }, 50);
    }, 50);
  });
  s1.zip(s2).toArray(function (xs) {
    test.same(xs, [["a", 1], ["b", 2], ["c", 3]]);
    test.done();
  });
};

exports.zipAll = function (test) {
  test.expect(3);
  _.zipAll([[4, 5, 6], [7, 8, 9], [10, 11, 12]], [1, 2, 3]).toArray(
    function (xs) {
      test.same(xs, [[1, 4, 7, 10], [2, 5, 8, 11], [3, 6, 9, 12]]);
    },
  );
  _.zipAll([_([4, 5, 6]), _([7, 8, 9]), _([10, 11, 12])], [1, 2, 3]).toArray(
    function (xs) {
      test.same(xs, [[1, 4, 7, 10], [2, 5, 8, 11], [3, 6, 9, 12]]);
    },
  );
  // partial application
  _.zipAll([[4, 5, 6], [7, 8, 9], [10, 11, 12]])([1, 2, 3]).toArray(
    function (xs) {
      test.same(xs, [[1, 4, 7, 10], [2, 5, 8, 11], [3, 6, 9, 12]]);
    },
  );
  test.done();
};

exports["zipAll - noValueOnError"] = noValueOnErrorTest(_.zipAll([1]));

exports["zipAll - StreamOfStreams"] = function (test) {
  test.expect(1);
  _.zipAll(_([[4, 5, 6], [7, 8, 9], [10, 11, 12]]), [1, 2, 3]).toArray(
    function (xs) {
      test.same(xs, [[1, 4, 7, 10], [2, 5, 8, 11], [3, 6, 9, 12]]);
    },
  );
  test.done();
};

exports["zipAll - source emits error"] = function (test) {
  test.expect(2);
  var err = new Error("zip all error");
  var s1 = _([1, 2, 3]);
  var s2 = _(function (push) {
    push(null, [4, 5, 6]);
    push(err);
    push(null, [7, 8, 9]);
    push(null, [10, 11, 12]);
    push(null, _.nil);
  });

  s1.zipAll(s2).errors(function (err) {
    test.equal(err.message, "zip all error");
  }).toArray(function (xs) {
    test.same(xs, [[1, 4, 7, 10], [2, 5, 8, 11], [3, 6, 9, 12]]);
  });
  test.done();
};

exports["zipAll - GeneratorStream"] = function (test) {
  var s1 = _(function (push, next) {
    push(null, 1);
    setTimeout(function () {
      push(null, 2);
      setTimeout(function () {
        push(null, 3);
        push(null, _.nil);
      }, 10);
    }, 10);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      push(null, [4, 5, 6]);
      push(null, [7, 8, 9]);
      setTimeout(function () {
        push(null, [10, 11, 12]);
        push(null, _.nil);
      }, 50);
    }, 50);
  });

  s1.zipAll(s2).toArray(function (xs) {
    test.same(xs, [[1, 4, 7, 10], [2, 5, 8, 11], [3, 6, 9, 12]]);
    test.done();
  });
};

exports["zipAll - Differing length streams"] = function (test) {
  test.expect(1);
  _.zipAll([[5, 6, 7, 8], [9, 10, 11, 12], [13, 14]])([1, 2, 3, 4]).toArray(
    function (xs) {
      test.same(xs, [[1, 5, 9, 13], [2, 6, 10, 14]]);
    },
  );
  test.done();
};

exports.zipAll0 = {
  setUp: function (cb) {
    this.input = [
      _([1, 2, 3]),
      _([4, 5, 6]),
      _([7, 8, 9]),
      _([10, 11, 12]),
    ];
    this.expected = [
      [1, 4, 7, 10],
      [2, 5, 8, 11],
      [3, 6, 9, 12],
    ];
    this.tester = function (expected, test) {
      return function (xs) {
        test.same(xs, expected);
      };
    };
    this.clock = sinon.useFakeTimers();
    cb();
  },
  tearDown: function (cb) {
    this.clock.restore();
    cb();
  },
  "ArrayStream": function (test) {
    test.expect(1);
    _(this.input)
      .zipAll0()
      .toArray(this.tester(this.expected, test));
    test.done();
  },
  "partial application": function (test) {
    test.expect(1);
    _.zipAll0(this.input)
      .toArray(this.tester(this.expected, test));
    test.done();
  },
  "empty stream": function (test) {
    test.expect(1);
    _.zipAll0([]).toArray(this.tester([], test));
    test.done();
  },
  "noValueOnError": noValueOnErrorTest(_.zipAll0),
  "source emits error": function (test) {
    test.expect(5);
    var self = this;
    var err = new Error("zip all error");
    var s = _(function (push) {
      push(null, self.input[0]);
      push(null, self.input[1]);
      push(err);
      push(null, self.input[2]);
      push(null, self.input[3]);
      push(null, _.nil);
    }).zipAll0();

    s.pull(errorEquals(test, "zip all error"));
    s.pull(valueEquals(test, this.expected[0]));
    s.pull(valueEquals(test, this.expected[1]));
    s.pull(valueEquals(test, this.expected[2]));
    s.pull(valueEquals(test, _.nil));
    test.done();
  },
  "GeneratorStream": function (test) {
    var self = this;
    var s = _(function (push, next) {
      push(null, self.input[0]);
      setTimeout(function () {
        push(null, self.input[1]);
        push(null, self.input[2]);
        setTimeout(function () {
          push(null, self.input[3]);
          push(null, _.nil);
        }, 50);
      }, 50);
    });

    s.zipAll0().toArray(this.tester(this.expected, test));
    this.clock.tick(100);
    test.done();
  },
  "Differing length streams": function (test) {
    test.expect(1);
    _.zipAll0([
      this.input[0],
      this.input[1],
      this.input[2],
      this.input[3].take(2),
    ]).toArray(this.tester([
      this.expected[0],
      this.expected[1],
    ], test));
    test.done();
  },
};

exports.batch = function (test) {
  test.expect(5);
  _.batch(3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]).toArray(function (xs) {
    test.same(xs, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [0]]);
  });

  _.batch(3, [1, 2, 3]).toArray(function (xs) {
    test.same(xs, [[1, 2, 3]]);
  });

  _.batch(2, [1, 2, 3]).toArray(function (xs) {
    test.same(xs, [[1, 2], [3]]);
  });

  _.batch(1, [1, 2, 3]).toArray(function (xs) {
    test.same(xs, [[1], [2], [3]]);
  });

  _.batch(0, [1, 2, 3]).toArray(function (xs) {
    test.same(xs, [[1, 2, 3]]);
  });

  test.done();
};

exports["batch - noValueOnError"] = noValueOnErrorTest(_.batch(1));

exports["batch - ArrayStream"] = function (test) {
  test.expect(5);
  _([1, 2, 3, 4, 5, 6, 7, 8, 9, 0]).batch(3).toArray(function (xs) {
    test.same(xs, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [0]]);
  });

  _([1, 2, 3]).batch(4).toArray(function (xs) {
    test.same(xs, [[1, 2, 3]]);
  });

  _([1, 2, 3]).batch(2).toArray(function (xs) {
    test.same(xs, [[1, 2], [3]]);
  });

  _([1, 2, 3]).batch(1).toArray(function (xs) {
    test.same(xs, [[1], [2], [3]]);
  });

  _([1, 2, 3]).batch(0).toArray(function (xs) {
    test.same(xs, [[1, 2, 3]]);
  });

  test.done();
};

exports["batch - GeneratorStream"] = function (test) {
  var s1 = _(function (push, next) {
    push(null, 1);
    setTimeout(function () {
      push(null, 2);
      setTimeout(function () {
        push(null, 3);
        push(null, _.nil);
      }, 10);
    }, 10);
  });
  s1.batch(1).toArray(function (xs) {
    test.same(xs, [[1], [2], [3]]);
    test.done();
  });
};

exports.batchWithTimeOrCount = {
  setUp: function (callback) {
    this.clock = sinon.useFakeTimers();

    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    this.generator = function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 2);
      delay(push, 30, 3);
      delay(push, 100, 4);
      delay(push, 110, 5);
      delay(push, 120, 6);
      delay(push, 130, _.nil);
    };

    this.tester = function (stream, test) {
      var results = [];

      stream.each(function (x) {
        results.push(x);
      });

      this.clock.tick(10);
      test.same(results, []);
      this.clock.tick(50);
      test.same(results, [[1, 2]]);
      this.clock.tick(30);
      test.same(results, [[1, 2], [3]]);
      this.clock.tick(10);
      test.same(results, [[1, 2], [3]]);
      this.clock.tick(25);
      test.same(results, [[1, 2], [3], [4, 5]]);
      this.clock.tick(10);
      test.same(results, [[1, 2], [3], [4, 5], [6]]);
      test.done();
    };

    callback();
  },
  tearDown: function (callback) {
    this.clock.restore();
    callback();
  },
  "async generator": function (test) {
    this.tester(_(this.generator).batchWithTimeOrCount(50, 2), test);
  },
  "toplevel - partial application, async generator": function (test) {
    this.tester(_.batchWithTimeOrCount(50)(2)(this.generator), test);
  },
};

exports["batchWithTimeOrCount - noValueOnError"] = noValueOnErrorTest(
  _.batchWithTimeOrCount(10, 2),
);

exports.splitBy = function (test) {
  test.expect(3);
  _.splitBy("ss", ["mis", "si", "s", "sippi"]).toArray(function (xs) {
    test.same(xs, "mississippi".split("ss"));
  });
  _.splitBy("foo", ["bar", "baz"]).toArray(function (xs) {
    test.same(xs, ["barbaz"]);
  });
  // partial application
  _.splitBy("ss")(["mis", "si", "s", "sippi"]).toArray(function (xs) {
    test.same(xs, "mississippi".split("ss"));
  });
  test.done();
};

exports["splitBy - delimiter at end of stream"] = function (test) {
  test.expect(2);
  _.splitBy("s", ["ducks"]).toArray(function (xs) {
    test.same(xs, ["duck", ""]);
  });
  _.splitBy("\n", ["hello\n", "world", "\n"]).toArray(function (xs) {
    test.same(xs, ["hello", "world", ""]);
  });
  test.done();
};

exports["splitBy - noValueOnError"] = noValueOnErrorTest(_.splitBy(" "));

exports["splitBy - unicode"] = function (test) {
  // test case borrowed from 'split' by dominictarr
  var unicode = new Buffer("テスト試験今日とても,よい天気で");
  var parts = [unicode.slice(0, 20), unicode.slice(20)];
  _(parts).splitBy(/,/g).toArray(function (xs) {
    test.same(xs, ["テスト試験今日とても", "よい天気で"]);
    test.done();
  });
};

exports["splitBy - ArrayStream"] = function (test) {
  test.expect(2);
  _(["mis", "si", "s", "sippi"]).splitBy("ss").toArray(function (xs) {
    test.same(xs, "mississippi".split("ss"));
  });
  _(["bar", "baz"]).splitBy("foo").toArray(function (xs) {
    test.same(xs, ["barbaz"]);
  });
  test.done();
};

exports["splitBy - GeneratorStream"] = function (test) {
  function delay(push, ms, x) {
    setTimeout(function () {
      push(null, x);
    }, ms);
  }
  var source = _(function (push, next) {
    delay(push, 10, "mis");
    delay(push, 20, "si");
    delay(push, 30, "s");
    delay(push, 40, "sippi");
    delay(push, 50, _.nil);
  });
  source.splitBy("ss").toArray(function (xs) {
    test.same(xs, "mississippi".split("ss"));
    test.done();
  });
};

exports.split = function (test) {
  test.expect(3);
  _(["a\n", "b\nc\n", "d", "\ne"]).split().toArray(function (xs) {
    test.same(xs, "abcde".split(""));
  });
  _.split(["a\n", "b\nc\n", "d", "\ne"]).toArray(function (xs) {
    test.same(xs, "abcde".split(""));
  });
  // mixed CRLF + LF
  _(["a\r\nb\nc"]).split().toArray(function (xs) {
    test.same(xs, "abc".split(""));
  });
  test.done();
};

exports.intersperse = function (test) {
  test.expect(4);
  _.intersperse("n", ["ba", "a", "a"]).toArray(function (xs) {
    test.same(xs.join(""), "banana");
  });
  _.intersperse("bar", ["foo"]).toArray(function (xs) {
    test.same(xs, ["foo"]);
  });
  _.intersperse("bar", []).toArray(function (xs) {
    test.same(xs, []);
  });
  // partial application
  _.intersperse("n")(["ba", "a", "a"]).toArray(function (xs) {
    test.same(xs.join(""), "banana");
  });
  test.done();
};

exports["intersperse - noValueOnError"] = noValueOnErrorTest(_.intersperse(1));

exports["intersperse - ArrayStream"] = function (test) {
  test.expect(3);
  _(["ba", "a", "a"]).intersperse("n").toArray(function (xs) {
    test.same(xs.join(""), "banana");
  });
  _(["foo"]).intersperse("bar").toArray(function (xs) {
    test.same(xs, ["foo"]);
  });
  _([]).intersperse("bar").toArray(function (xs) {
    test.same(xs, []);
  });
  test.done();
};

exports["intersperse - GeneratorStream"] = function (test) {
  var s1 = _(function (push, next) {
    push(null, "ba");
    setTimeout(function () {
      push(null, "a");
      setTimeout(function () {
        push(null, "a");
        push(null, _.nil);
      }, 10);
    }, 10);
  });
  s1.intersperse("n").toArray(function (xs) {
    test.same(xs.join(""), "banana");
    test.done();
  });
};

exports.parallel = function (test) {
  var calls = [];
  var s1 = _(function (push, next) {
    setTimeout(function () {
      calls.push(1);
      push(null, 1);
      push(null, _.nil);
    }, 150);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      calls.push(2);
      push(null, 2);
      push(null, _.nil);
    }, 50);
  });
  var s3 = _(function (push, next) {
    setTimeout(function () {
      calls.push(3);
      push(null, 3);
      push(null, _.nil);
    }, 100);
  });
  _.parallel(4, [s1, s2, s3]).toArray(function (xs) {
    test.same(calls, [2, 3, 1]);
    test.same(xs, [1, 2, 3]);
    test.done();
  });
};

exports["parallel - noValueOnError"] = noValueOnErrorTest(_.parallel(1));

exports["parallel - partial application"] = function (test) {
  var calls = [];
  var s1 = _(function (push, next) {
    setTimeout(function () {
      calls.push(1);
      push(null, 1);
      push(null, _.nil);
    }, 100);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      calls.push(2);
      push(null, 2);
      push(null, _.nil);
    }, 50);
  });
  var s3 = _(function (push, next) {
    setTimeout(function () {
      calls.push(3);
      push(null, 3);
      push(null, _.nil);
    }, 150);
  });
  _.parallel(4)([s1, s2, s3]).toArray(function (xs) {
    test.same(calls, [2, 1, 3]);
    test.same(xs, [1, 2, 3]);
    test.done();
  });
};

exports["parallel - n === 1"] = function (test) {
  var calls = [];
  var s1 = _(function (push, next) {
    setTimeout(function () {
      calls.push(1);
      push(null, 1);
      push(null, _.nil);
    }, 100);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      calls.push(2);
      push(null, 2);
      push(null, _.nil);
    }, 50);
  });
  var s3 = _(function (push, next) {
    setTimeout(function () {
      calls.push(3);
      push(null, 3);
      push(null, _.nil);
    }, 150);
  });
  _.parallel(1, [s1, s2, s3]).toArray(function (xs) {
    test.same(calls, [1, 2, 3]);
    test.same(xs, [1, 2, 3]);
    test.done();
  });
};

exports["parallel - n === 2"] = function (test) {
  var calls = [];
  var s1 = _(function (push, next) {
    setTimeout(function () {
      calls.push(1);
      push(null, 1);
      push(null, _.nil);
    }, 150);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      calls.push(2);
      push(null, 2);
      push(null, _.nil);
    }, 100);
  });
  var s3 = _(function (push, next) {
    setTimeout(function () {
      calls.push(3);
      push(null, 3);
      push(null, _.nil);
    }, 50);
  });
  _.parallel(2, [s1, s2, s3]).toArray(function (xs) {
    test.same(calls, [2, 1, 3]);
    test.same(xs, [1, 2, 3]);
    test.done();
  });
};

exports["parallel - ArrayStream"] = function (test) {
  var calls = [];
  var s1 = _(function (push, next) {
    setTimeout(function () {
      calls.push(1);
      push(null, 1);
      push(null, _.nil);
    }, 150);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      calls.push(2);
      push(null, 2);
      push(null, _.nil);
    }, 100);
  });
  var s3 = _(function (push, next) {
    setTimeout(function () {
      calls.push(3);
      push(null, 3);
      push(null, _.nil);
    }, 50);
  });
  _([s1, s2, s3]).parallel(2).toArray(function (xs) {
    test.same(calls, [2, 1, 3]);
    test.same(xs, [1, 2, 3]);
    test.done();
  });
};

exports["parallel - GeneratorStream"] = function (test) {
  var calls = [];
  var s1 = _(function (push, next) {
    setTimeout(function () {
      calls.push(1);
      push(null, 1);
      push(null, _.nil);
    }, 150);
  });
  var s2 = _(function (push, next) {
    setTimeout(function () {
      calls.push(2);
      push(null, 2);
      push(null, _.nil);
    }, 100);
  });
  var s3 = _(function (push, next) {
    setTimeout(function () {
      calls.push(3);
      push(null, 3);
      push(null, _.nil);
    }, 50);
  });
  var s = _(function (push, next) {
    push(null, s1);
    setTimeout(function () {
      push(null, s2);
      push(null, s3);
      push(null, _.nil);
    }, 10);
  });
  s.parallel(2).toArray(function (xs) {
    test.same(calls, [2, 1, 3]);
    test.same(xs, [1, 2, 3]);
    test.done();
  });
};

exports["parallel consume from async generator"] = function (test) {
  function delay(push, ms, x) {
    setTimeout(function () {
      push(null, x);
    }, ms);
  }
  var source = _(function (push, next) {
    //console.log('source read');
    delay(push, 100, 1);
    delay(push, 200, 2);
    delay(push, 300, 3);
    delay(push, 400, 4);
    delay(push, 500, 5);
    delay(push, 600, _.nil);
  });
  var doubler = function (x) {
    //console.log(['doubler call', x]);
    return _(function (push, next) {
      //console.log('doubler read');
      delay(push, 50, x * 2);
      delay(push, 100, _.nil);
    });
  };
  source.map(doubler).parallel(3).toArray(function (xs) {
    test.same(xs, [2, 4, 6, 8, 10]);
    test.done();
  });
};

exports["parallel - behaviour of parallel with fork() - issue #234"] =
  function (test) {
    test.expect(1);

    function addTen(a) {
      return a + 10;
    }

    function addTwenty(a) {
      return a + 20;
    }

    var arr = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    var expected = [
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
      17,
      18,
      19,
      20,
      21,
      22,
      23,
      24,
      25,
      26,
      27,
      28,
      29,
    ];

    var baseRange = _(arr);
    var loRange = baseRange.fork();
    var midRange = baseRange.fork().map(addTen);
    var hiRange = baseRange.fork().map(addTwenty);

    _([loRange, midRange, hiRange])
      .parallel(3)
      .toArray(function (xs) {
        test.same(xs, expected);
        test.done();
      });
  };

exports["parallel consumption liveness - issue #302"] = function (test) {
  test.expect(3);
  var clock = sinon.useFakeTimers(),
    s3flag = false,
    expected = [1, 2, 10, 20, 30, 40, 100];

  function delay(push, ms, x) {
    setTimeout(function () {
      push(null, x);
    }, ms);
  }

  var s1 = _(function (push) {
    delay(push, 10, 1);
    delay(push, 15, 2);
    delay(push, 20, _.nil);
  });

  var s2 = _(function (push) {
    delay(push, 10, 10);
    delay(push, 20, 20);
    delay(push, 30, 30);
    delay(push, 40, 40);
    delay(push, 50, _.nil);
  });

  var s3 = _(function (push, next) {
    s3flag = true;
    push(null, 100);
    push(null, _.nil);
  });

  _([s1, s2, s3]).parallel(2)
    .toArray(function (xs) {
      test.same(xs, expected);
      test.done();
      clock.restore();
    });

  clock.tick(15);
  test.equal(s3flag, false);
  clock.tick(25);
  test.equal(s3flag, true);
  clock.tick(25);
};

exports["parallel - throw descriptive error on not-stream"] = function (test) {
  test.expect(2);
  var s = _([1]).parallel(2);
  s.pull(errorEquals(test, "Expected Stream, got number"));
  s.pull(valueEquals(test, _.nil));
  test.done();
};

exports["parallel - parallel should not drop data if paused (issue #328)"] =
  function (test) {
    test.expect(1);
    var s1 = _([1, 2, 3]);
    var s2 = _([11, 12, 13]);
    _([s1.fork(), s2, s1.fork()])
      .parallel(3)
      .consume(function (err, x, push, next) {
        push(err, x);
        if (x.buf === 21) {
          // Pause for a while.
          setTimeout(next, 1000);
        } else if (x !== _.nil) {
          next();
        }
      })
      .toArray(function (xs) {
        test.same(xs, [1, 2, 3, 11, 12, 13, 1, 2, 3]);
        test.done();
      });
  };

exports["parallel - should throw if arg is not a number (issue #420)"] =
  function (test) {
    test.expect(1);
    test.throws(function () {
      _([]).parallel();
    });
    test.done();
  };

exports["parallel - should throw if arg is not positive"] = function (test) {
  test.expect(1);
  test.throws(function () {
    _([]).parallel(-1);
  });
  test.done();
};

exports.throttle = {
  setUp: function (callback) {
    this.clock = sinon.useFakeTimers();
    callback();
  },
  tearDown: function (callback) {
    this.clock.restore();
    callback();
  },
  "top-level": function (test) {
    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    var s = _(function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 1);
      delay(push, 30, 1);
      delay(push, 40, 1);
      delay(push, 50, 1);
      delay(push, 60, 1);
      delay(push, 70, 1);
      delay(push, 80, 1);
      delay(push, 90, _.nil);
    });
    _.throttle(50, s).toArray(function (xs) {
      test.same(xs, [1, 1]);
      test.done();
    });
    this.clock.tick(90);
  },
  "let errors through regardless": function (test) {
    function delay(push, ms, err, x) {
      setTimeout(function () {
        push(err, x);
      }, ms);
    }
    var s = _(function (push, next) {
      delay(push, 10, null, 1);
      delay(push, 20, null, 1);
      delay(push, 30, null, 1);
      delay(push, 30, "foo");
      delay(push, 30, "bar");
      delay(push, 40, null, 1);
      delay(push, 50, null, 1);
      delay(push, 60, null, 1);
      delay(push, 70, null, 1);
      delay(push, 80, null, 1);
      delay(push, 90, null, _.nil);
    });
    var errs = [];
    s.throttle(50).errors(function (err) {
      errs.push(err);
    }).toArray(function (xs) {
      test.same(xs, [1, 1]);
      test.same(errs, ["foo", "bar"]);
      test.done();
    });
    this.clock.tick(90);
  },
  "GeneratorStream": function (test) {
    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    var s = _(function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 1);
      delay(push, 30, 1);
      delay(push, 40, 1);
      delay(push, 50, 1);
      delay(push, 60, 1);
      delay(push, 70, 1);
      delay(push, 80, 1);
      delay(push, 90, _.nil);
    });
    s.throttle(30).toArray(function (xs) {
      test.same(xs, [1, 1, 1]);
      test.done();
    });
    this.clock.tick(90);
  },
  "noValueOnError": noValueOnErrorTest(_.throttle(10)),
};

exports.debounce = {
  setUp: function (callback) {
    this.clock = sinon.useFakeTimers();
    callback();
  },
  tearDown: function (callback) {
    this.clock.restore();
    callback();
  },
  "top-level": function (test) {
    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    var s = _(function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 1);
      delay(push, 30, 1);
      delay(push, 40, 1);
      delay(push, 150, 1);
      delay(push, 160, 1);
      delay(push, 170, 1);
      delay(push, 180, "last");
      delay(push, 190, _.nil);
    });
    _.debounce(100, s).toArray(function (xs) {
      test.same(xs, [1, "last"]);
      test.done();
    });
    this.clock.tick(200);
  },
  "GeneratorStream": function (test) {
    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    var s = _(function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 1);
      delay(push, 30, 1);
      delay(push, 40, 1);
      delay(push, 150, 1);
      delay(push, 160, 1);
      delay(push, 170, 1);
      delay(push, 180, "last");
      delay(push, 190, _.nil);
    });
    s.debounce(100).toArray(function (xs) {
      test.same(xs, [1, "last"]);
      test.done();
    });
    this.clock.tick(200);
  },
  "let errors through regardless": function (test) {
    function delay(push, ms, err, x) {
      setTimeout(function () {
        push(err, x);
      }, ms);
    }
    var s = _(function (push, next) {
      delay(push, 10, null, 1);
      delay(push, 20, null, 1);
      delay(push, 30, null, 1);
      delay(push, 30, "foo");
      delay(push, 30, "bar");
      delay(push, 40, null, 1);
      delay(push, 150, null, 1);
      delay(push, 260, null, 1);
      delay(push, 270, null, 1);
      delay(push, 280, null, "last");
      delay(push, 290, null, _.nil);
    });
    var errs = [];
    s.debounce(100).errors(function (err) {
      errs.push(err);
    }).toArray(function (xs) {
      test.same(xs, [1, 1, "last"]);
      test.same(errs, ["foo", "bar"]);
      test.done();
    });
    this.clock.tick(300);
  },
  "noValueOnError": noValueOnErrorTest(_.debounce(10)),
};

exports.latest = {
  setUp: function (callback) {
    this.clock = sinon.useFakeTimers();
    callback();
  },
  tearDown: function (callback) {
    this.clock.restore();
    callback();
  },
  "top-level": function (test) {
    test.expect(1);
    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    var s = _(function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 1);
      delay(push, 30, 1);
      delay(push, 40, 1);
      delay(push, 50, 1);
      delay(push, 60, 1);
      delay(push, 70, 1);
      delay(push, 80, "last");
      delay(push, 90, _.nil);
    });
    var s2 = _.latest(s);
    var s3 = s2.consume(function (err, x, push, next) {
      push(err, x);
      if (x !== _.nil) {
        setTimeout(next, 60);
      }
    });
    s3.toArray(function (xs) {
      // values at 0s, 60s, 120s
      test.same(xs, [1, 1, "last"]);
    });
    this.clock.tick(1000);
    test.done();
  },
  "GeneratorStream": function (test) {
    test.expect(1);
    function delay(push, ms, x) {
      setTimeout(function () {
        push(null, x);
      }, ms);
    }
    var s = _(function (push, next) {
      delay(push, 10, 1);
      delay(push, 20, 1);
      delay(push, 30, 1);
      delay(push, 40, 1);
      delay(push, 50, 1);
      delay(push, 60, 1);
      delay(push, 70, 1);
      delay(push, 80, "last");
      delay(push, 90, _.nil);
    });
    var s2 = s.latest();
    var s3 = s2.consume(function (err, x, push, next) {
      push(err, x);
      if (x !== _.nil) {
        setTimeout(next, 60);
      }
    });
    s3.toArray(function (xs) {
      // values at 0s, 60s, 120s
      test.same(xs, [1, 1, "last"]);
    });
    this.clock.tick(1000);
    test.done();
  },
  "let errors pass through": function (test) {
    test.expect(2);
    function delay(push, ms, err, x) {
      setTimeout(function () {
        push(err, x);
      }, ms);
    }
    var s = _(function (push, next) {
      delay(push, 10, null, 1);
      delay(push, 20, null, 1);
      delay(push, 30, null, 1);
      delay(push, 30, "foo", 1);
      delay(push, 30, "bar", 1);
      delay(push, 40, null, 1);
      delay(push, 50, null, 1);
      delay(push, 60, null, 1);
      delay(push, 70, null, 1);
      delay(push, 80, null, "last");
      delay(push, 90, null, _.nil);
    });
    var errs = [];
    var s2 = s.latest().errors(function (err) {
      errs.push(err);
    });
    var s3 = s2.consume(function (err, x, push, next) {
      push(err, x);
      if (x !== _.nil) {
        setTimeout(next, 60);
      }
    });
    s3.toArray(function (xs) {
      // values at 0s, 60s, 120s
      test.same(xs, [1, 1, "last"]);
      test.same(errs, ["foo", "bar"]);
    });
    this.clock.tick(1000);
    test.done();
  },
};

exports.last = function (test) {
  test.expect(3);
  _([1, 2, 3, 4]).last().toArray(function (xs) {
    test.same(xs, [4]);
  });
  _.last([1, 2, 3, 4]).toArray(function (xs) {
    test.same(xs, [4]);
  });
  _.last([]).toArray(function (xs) {
    test.same(xs, []);
  });
  test.done();
};

exports["last - noValueOnError"] = noValueOnErrorTest(_.last());

exports.sortBy = {
  setUp: function (cb) {
    this.input = [5, 2, 4, 1, 3];
    this.reversed = [5, 4, 3, 2, 1];
    this.compDesc = function (a, b) {
      return b - a;
    };
    this.tester = function (expected, test) {
      return function (xs) {
        test.same(xs, expected);
      };
    };
    cb();
  },
  "arrayStream": function (test) {
    test.expect(1);
    _(this.input).sortBy(this.compDesc).toArray(
      this.tester(this.reversed, test),
    );
    test.done();
  },
  "partial application": function (test) {
    test.expect(1);
    var s = _(this.input);
    _.sortBy(this.compDesc)(s).toArray(this.tester(this.reversed, test));
    test.done();
  },
  "noValueOnError": noValueOnErrorTest(_.sortBy(this.compDesc)),
};

exports.sort = {
  setUp: function (cb) {
    this.input = ["e", "a", "d", "c", "b"];
    this.sorted = ["a", "b", "c", "d", "e"];
    this.tester = function (expected, test) {
      return function (xs) {
        test.same(xs, expected);
      };
    };
    cb();
  },
  "arrayStream": function (test) {
    test.expect(1);
    _(this.input).sort().toArray(this.tester(this.sorted, test));
    test.done();
  },
  "partial application": function (test) {
    test.expect(1);
    var s = _(this.input);
    _.sortBy(this.compDesc)(s).toArray(this.tester(this.sorted, test));
    test.done();
  },
  "noValueOnError": noValueOnErrorTest(_.sort()),
};

exports.through = {
  setUp: function (cb) {
    this.parser = new Stream.Transform({ objectMode: true });
    this.parser._transform = function (data, encoding, callback) {
      try {
        callback(null, JSON.parse(data));
      } catch (err) {
        callback(err);
      }
    };

    this.numArray = [1, 2, 3, 4];
    this.stringArray = ["1", "2", "3", "4"];
    this.tester = function (expected, test) {
      return function (xs) {
        test.same(xs, expected);
        test.done();
      };
    };
    cb();
  },
  "function": function (test) {
    test.expect(1);
    var s = _.through(function (s) {
      return s
        .filter(function (x) {
          return x % 2;
        })
        .map(function (x) {
          return x * 2;
        });
    }, this.numArray);
    s.toArray(this.tester([2, 6], test));
  },
  "function - ArrayStream": function (test) {
    test.expect(1);
    var s = _(this.numArray).through(function (s) {
      return s
        .filter(function (x) {
          return x % 2;
        })
        .map(function (x) {
          return x * 2;
        });
    }).through(function (s) {
      return s.map(function (x) {
        return x + 1;
      });
    });
    s.toArray(this.tester([3, 7], test));
  },
  "stream": function (test) {
    test.expect(1);
    var s = _.through(this.parser, this.stringArray);
    s.toArray(this.tester(this.numArray, test));
  },
  "stream - ArrayStream": function (test) {
    test.expect(1);
    var s = _(this.stringArray).through(this.parser);
    s.toArray(this.tester(this.numArray, test));
  },
  "stream and function": function (test) {
    test.expect(1);
    var s = _(this.stringArray)
      .through(this.parser)
      .through(function (s) {
        return s.map(function (x) {
          return x * 2;
        });
      });
    s.toArray(this.tester([2, 4, 6, 8], test));
  },
  "source stream throws error": function (test) {
    test.expect(2);
    var s = _(function (push) {
      push(new Error("Input error"));
      push(null, _.nil);
    }).through(this.parser);

    s.errors(errorEquals(test, "Input error"))
      .toArray(this.tester([], test));
  },
  "through stream throws error": function (test) {
    test.expect(2);
    var s = _(['zz{"a": 1}']).through(this.parser);
    s.errors(anyError(test))
      .toArray(this.tester([], test));
  },
  "through stream not paused (issue #671)": function (test) {
    test.expect(1);
    var otherDest = new Stream.Writable({ objectMode: true });
    otherDest._write = function (chunk, encoding, cb) {
      cb();
    };

    var throughStream = new Stream.PassThrough({ objectMode: true });

    // Pipe to another stream to unpause it.
    throughStream.pipe(otherDest);
    _([1, 2, 3]).through(throughStream)
      .toArray(this.tester([1, 2, 3], test));
  },
  "noValueOnError": function (test) {
    noValueOnErrorTest(_.through(function (x) {
      return x;
    }))(test);
  },
};

exports.pipeline = {
  "usage test": function (test) {
    var parser = new Stream.Transform({ objectMode: true });
    parser._transform = function (data, encoding, callback) {
      callback(null, JSON.parse(data));
    };

    var doubler = _.map(function (x) {
      return x * 2;
    });
    var parseDouble = _.pipeline(parser, doubler);
    var s = _(function (push, next) {
      push(null, 1);
      setTimeout(function () {
        push(null, 2);
      }, 10);
      setTimeout(function () {
        push(null, 3);
      }, 20);
      setTimeout(function () {
        push(null, 4);
      }, 30);
      setTimeout(function () {
        push(null, _.nil);
      }, 40);
    });
    s.pipe(parseDouble).toArray(function (xs) {
      test.same(xs, [2, 4, 6, 8]);
      test.done();
    });
  },
  "single through function": function (test) {
    var src = streamify([1, 2, 3, 4]);
    var through = _.pipeline(function (s) {
      return s
        .filter(function (x) {
          return x % 2;
        })
        .map(function (x) {
          return x * 2;
        })
        .map(function (x) {
          return x + 10;
        });
    });
    src.pipe(through).toArray(function (xs) {
      test.same(xs, [12, 16]);
      test.done();
    });
  },
  "no arguments": function (test) {
    var src = streamify([1, 2, 3, 4]);
    var through = _.pipeline();
    src.pipe(through).toArray(function (xs) {
      test.same(xs, [1, 2, 3, 4]);
      test.done();
    });
  },
  "should have backpressure": function (test) {
    test.expect(3);
    var arr = [];
    var pipeline1 = _.pipeline(_.map(function (x) {
      return x + 10;
    }));

    test.ok(pipeline1.paused, "pipeline should be paused.");
    test.strictEqual(
      pipeline1.write(1),
      false,
      "pipeline should return false for calls to write since it is paused.",
    );

    var pipeline2 = _.pipeline(_.map(function (x) {
      return x + 10;
    }));

    _([1, 2, 3])
      .doto(arr.push.bind(arr))
      .pipe(pipeline2)
      .each(arr.push.bind(arr))
      .done(function () {
        test.same(arr, [1, 11, 2, 12, 3, 13]);
        test.done();
      });
  },
  "drain should only be called when there is a need": function (test) {
    test.expect(14);
    var pipeline = _.pipeline(_.flatMap(function (x) {
      return _([x, x + 10]);
    }));

    var spy = sinon.spy();
    pipeline.on("drain", spy);

    var s = _([1, 2, 3]).pipe(pipeline);

    takeNext(s, 1)
      .then(expect(1, 0))
      .then(expect(11, 0))
      .then(expect(2, 1))
      .then(expect(12, 1))
      .then(expect(3, 2))
      .then(expect(13, 2))
      .then(expectDone(3));

    function expect(value, spyCount) {
      return function (arr) {
        test.strictEqual(spy.callCount, spyCount);
        test.deepEqual(arr, [value]);
        return takeNext(s, 1);
      };
    }

    function expectDone(spyCount) {
      return function (arr) {
        test.strictEqual(spy.callCount, spyCount);
        test.deepEqual(arr, [_.nil]);
        test.done();
        return [];
      };
    }
  },
};

// TODO: test lazy getting of values from obj keys (test using getters?)
exports.values = function (test) {
  var obj = {
    foo: 1,
    bar: 2,
    baz: 3,
  };
  _.values(obj).toArray(function (xs) {
    test.same(xs, [1, 2, 3]);
    test.done();
  });
};

exports["values - lazy property access"] = function (test) {
  var calls = [];
  var obj = {
    get foo() {
      calls.push("foo");
      return 1;
    },
    get bar() {
      calls.push("bar");
      return 2;
    },
    get baz() {
      calls.push("baz");
      return 3;
    },
  };
  _.values(obj).take(2).toArray(function (xs) {
    test.same(calls, ["foo", "bar"]);
    test.same(xs, [1, 2]);
    test.done();
  });
};

exports.keys = function (test) {
  test.expect(2);
  var obj = {
    foo: 1,
    bar: 2,
    baz: 3,
  };

  var objNoProto = Object.create(null);
  objNoProto.foo = 1;
  objNoProto.bar = 2;
  objNoProto.baz = 3;

  _.keys(obj).toArray(function (xs) {
    test.same(xs, ["foo", "bar", "baz"]);
  });

  _.keys(objNoProto).toArray(function (xs) {
    test.same(xs, ["foo", "bar", "baz"]);
  });
  test.done();
};

exports.pairs = function (test) {
  var obj = {
    foo: 1,
    bar: 2,
    baz: { qux: 3 },
  };
  _.pairs(obj).toArray(function (xs) {
    test.same(xs, [
      ["foo", 1],
      ["bar", 2],
      ["baz", { qux: 3 }],
    ]);
    test.done();
  });
};

exports["pairs - lazy property access"] = function (test) {
  var calls = [];
  var obj = {
    get foo() {
      calls.push("foo");
      return 1;
    },
    get bar() {
      calls.push("bar");
      return 2;
    },
    get baz() {
      calls.push("baz");
      return { qux: 3 };
    },
  };
  _.pairs(obj).take(2).toArray(function (xs) {
    test.same(calls, ["foo", "bar"]);
    test.same(xs, [
      ["foo", 1],
      ["bar", 2],
    ]);
    test.done();
  });
};

exports.extend = function (test) {
  test.expect(8);
  var a = { a: 1, b: { num: 2, test: "test" } };

  var b = Object.create(null);
  b.a = 1;
  b.b = { num: 2, test: "test" };

  test.equal(a, _.extend({ b: { num: "foo" }, c: 3 }, a));
  test.same(a, { a: 1, b: { num: "foo" }, c: 3 });
  test.equal(b, _.extend({ b: { num: "bar" }, c: 3 }, b));
  test.same(b, { a: 1, b: { num: "bar" }, c: 3 });

  // partial application
  test.equal(a, _.extend({ b: "baz" })(a));
  test.same(a, { a: 1, b: "baz", c: 3 });
  test.equal(b, _.extend({ b: "bar" })(b));
  test.same(b, { a: 1, b: "bar", c: 3 });

  test.done();
};

exports.get = function (test) {
  var a = { foo: "bar", baz: 123 };
  test.equal(_.get("foo", a), "bar");
  test.equal(_.get("baz")(a), 123);
  test.done();
};

exports.set = function (test) {
  var a = { foo: "bar", baz: 123 };
  test.equal(_.set("foo", "asdf", a), a);
  test.equal(a.foo, "asdf");
  test.equal(_.set("wibble", "wobble")(a), a);
  test.equal(a.wibble, "wobble");
  test.same(a, { foo: "asdf", baz: 123, wibble: "wobble" });
  test.done();
};

// TODO: failing case in another program - consume stream and switch to
// new async source using next, then follow the consume with flatten()
//
// in fact, a simple .consume().flatten() failed with async sub-source to be
// flattened, but curiously, it worked by doing .consume().map().flatten()
// where the map() was just map(function (x) { return x; })

exports.log = function (test) {
  var calls = [];
  var _log = console.log;
  console.log = function (x) {
    calls.push(x);
  };
  _.log("foo");
  _.log("bar");
  test.same(calls, ["foo", "bar"]);
  console.log = _log;
  test.done();
};

exports.wrapCallback = function (test) {
  var f = function (a, b, cb) {
    setTimeout(function () {
      cb(null, a + b);
    }, 10);
  };
  _.wrapCallback(f)(1, 2).toArray(function (xs) {
    test.same(xs, [3]);
    test.done();
  });
};

exports["wrapCallback - context"] = function (test) {
  var o = {
    f: function (a, b, cb) {
      test.equal(this, o);
      setTimeout(function () {
        cb(null, a + b);
      }, 10);
    },
  };
  o.g = _.wrapCallback(o.f);
  o.g(1, 2).toArray(function (xs) {
    test.same(xs, [3]);
    test.done();
  });
};

exports["wrapCallback - errors"] = function (test) {
  var f = function (a, b, cb) {
    cb(new Error("boom"));
  };
  test.throws(function () {
    _.wrapCallback(f)(1, 2).toArray(function () {
      test.ok(false, "this shouldn't be called");
    });
  });
  test.done();
};

exports["wrapCallback with args wrapping by function"] = function (test) {
  function f(cb) {
    cb(null, 1, 2, 3);
  }
  function mapper() {
    return Array.prototype.slice.call(arguments);
  }
  _.wrapCallback(f, mapper)().each(function (x) {
    test.same(x, [1, 2, 3]);
    test.done();
  });
};

exports["wrapCallback with args wrapping by number"] = function (test) {
  function f(cb) {
    cb(null, 1, 2, 3);
  }
  _.wrapCallback(f, 2)().each(function (x) {
    test.same(x, [1, 2]);
    test.done();
  });
};

exports["wrapCallback with args wrapping by array"] = function (test) {
  function f(cb) {
    cb(null, 1, 2, 3);
  }
  _.wrapCallback(f, ["one", "two", "three"])().each(function (x) {
    test.same(x, { "one": 1, "two": 2, "three": 3 });
    test.done();
  });
};

exports["wrapCallback default mapper discards all but first arg"] = function (
  test,
) {
  function f(cb) {
    cb(null, 1, 2, 3);
  }
  _.wrapCallback(f)().each(function (x) {
    test.same(x, 1);
    test.done();
  });
};

exports.streamifyAll = {
  "throws when passed a non-function non-object": function (test) {
    test.throws(function () {
      _.streamifyAll(1);
    }, TypeError);
    test.done();
  },
  "streamifies object methods": function (test) {
    var plainObject = {
      fn: function (a, b, cb) {
        cb(null, a + b);
      },
    };
    var obj = _.streamifyAll(plainObject);
    test.equal(typeof obj.fnStream, "function");
    obj.fnStream(1, 2).apply(function (res) {
      test.equal(res, 3);
      test.done();
    });
  },
  "streamifies constructor prototype methods": function (test) {
    function ExampleClass(a) {
      this.a = a;
    }
    ExampleClass.prototype.fn = function (b, cb) {
      cb(null, this.a + b);
    };
    var ExampleClass = _.streamifyAll(ExampleClass);
    var obj = new ExampleClass(1);
    test.equal(typeof obj.fnStream, "function");
    obj.fnStream(2).apply(function (res) {
      test.equal(res, 3);
      test.done();
    });
  },
  "streamifies constructor methods": function (test) {
    function ExampleClass(a) {
      this.a = a;
    }
    ExampleClass.a = 5;
    ExampleClass.fn = function (b, cb) {
      cb(null, this.a + b);
    };
    var ExampleClass = _.streamifyAll(ExampleClass);
    test.equal(typeof ExampleClass.fnStream, "function");
    ExampleClass.fnStream(2).apply(function (res) {
      test.equal(res, 7);
      test.done();
    });
  },
  "streamifies inherited methods": function (test) {
    function Grandfather() {}
    Grandfather.prototype.fn1 = function (b, cb) {
      cb(null, this.a * b);
    };
    function Father() {}
    Father.prototype = Object.create(Grandfather.prototype);
    Father.prototype.fn2 = function (b, cb) {
      cb(null, this.a / b);
    };
    function Child(a) {
      this.a = a;
    }
    Child.prototype = Object.create(Father.prototype);
    Child.prototype.fn3 = function (b, cb) {
      cb(null, this.a + b);
    };
    var Child = _.streamifyAll(Child);
    var child = new Child(3);

    test.equal(typeof child.fn1Stream, "function");
    test.equal(typeof child.fn2Stream, "function");
    test.equal(typeof child.fn3Stream, "function");
    _([child.fn1Stream(1), child.fn2Stream(2), child.fn3Stream(3)])
      .series()
      .toArray(function (arr) {
        test.deepEqual(arr, [3, 1.5, 6]);
        test.done();
      });
  },
  "does not re-streamify functions": function (test) {
    var plainObject = {
      fn: function (a, b, cb) {
        cb(null, a + b);
      },
    };
    var obj = _.streamifyAll(_.streamifyAll(plainObject));
    test.equal(typeof obj.fnStreamStream, "undefined");
    test.done();
  },
  "does not streamify constructors": function (test) {
    function ExampleClass() {}
    ExampleClass.prototype.fn = function (cb) {
      cb(null, "foo");
    };
    var obj = new (_.streamifyAll(ExampleClass))();
    test.equal(typeof obj.constructorStream, "undefined");
    test.done();
  },
  "does not streamify Object methods": function (test) {
    function ExampleClass() {}
    ExampleClass.prototype.fn = function (cb) {
      cb(null, "foo");
    };
    var obj1 = new (_.streamifyAll(ExampleClass))();
    var obj2 = _.streamifyAll(new ExampleClass());
    test.equal(typeof obj1.toStringStream, "undefined");
    test.equal(typeof obj1.keysStream, "undefined");
    test.equal(typeof obj2.toStringStream, "undefined");
    test.equal(typeof obj2.keysStream, "undefined");
    test.done();
  },
  "doesn't break when property has custom getter": function (test) {
    function ExampleClass(a) {
      this.a = { b: a };
    }
    Object.defineProperty(ExampleClass.prototype, "c", {
      get: function () {
        return this.a.b;
      },
    });

    test.doesNotThrow(function () {
      _.streamifyAll(ExampleClass);
    });
    test.done();
  },
};

exports.add = function (test) {
  test.equal(_.add(1, 2), 3);
  test.equal(_.add(3)(2), 5);
  return test.done();
};

exports.not = function (test) {
  test.equal(_.not(true), false);
  test.equal(_.not(123), false);
  test.equal(_.not("asdf"), false);
  test.equal(_.not(false), true);
  test.equal(_.not(0), true);
  test.equal(_.not(""), true);
  test.equal(_.not(null), true);
  test.equal(_.not(undefined), true);
  return test.done();
};
