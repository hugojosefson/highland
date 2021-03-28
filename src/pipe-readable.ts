import { isFunction } from "./index.ts";
import { StreamError } from "./stream-error.ts";
import { StreamImpl } from "./stream-impl.ts";

export default <R>(
  xs,
  onFinish: (x: R, errorHandler: (error: Error) => void) => any,
  stream: StreamImpl<R>,
) => {
  const response = onFinish(xs, streamEndCb);
  let unbound: boolean = false;

  let cleanup: Function | null;
  let endOnError: boolean = true;

  if (isFunction(response)) {
    cleanup = response;
  } else if (response != null) {
    cleanup = response.onDestroy;
    endOnError = !response.continueOnError;
  }

  xs.pipe(stream);

  // TODO: Replace with onDestroy in v3.
  stream._destructors.push(unbind);

  function streamEndCb(error: Error) {
    if (stream._nil_pushed) {
      return;
    }

    if (error) {
      stream.write(new StreamError(error));
    }

    if (error == null || endOnError) {
      unbind();
      stream.end();
    }
  }

  function unbind() {
    if (unbound) {
      return;
    }

    unbound = true;

    if (cleanup) {
      cleanup();
    }

    if (xs.unpipe) {
      xs.unpipe(stream);
    }
  }
};
