import { nil } from "./interfaces.ts";
import { StreamError } from "./stream-error.ts";

export default (src, dest, write, end, passAlongErrors) => {
  var resume = null;
  if (!passAlongErrors) {
    src._send_events = true;
  }

  var s = src.consume(function (err, x, push, next) {
    var canContinue;
    if (err) {
      if (passAlongErrors) {
        canContinue = write.call(dest, new StreamError(err));
      } else {
        canContinue = true;
      }
    } else if (x === nil) {
      end.call(dest);
      return;
    } else {
      canContinue = write.call(dest, x);
    }

    if (canContinue !== false) {
      next();
    } else {
      resume = next;
    }
  });

  dest.on("drain", onConsumerDrain);

  // Since we don't keep a reference to piped-to streams,
  // save a callback that will unbind the event handler.
  src._destructors.push(() => dest.removeListener("drain", onConsumerDrain));

  dest.emit("pipe", src);

  // Calling resume() may cause data to be synchronously pushed.
  // That can cause data loss if the destination is a through stream and it
  // is unpaused. That is, this chain won't work correctly:
  //   stream.pipe(unpaused).pipe(otherDest);
  setImmediate(function () {
    s.resume();
  });
  return dest;

  function onConsumerDrain() {
    if (resume) {
      var oldResume = resume;
      resume = null;
      oldResume();
    }
  }
};
