import { setImmediate } from "https://deno.land/std@0.91.0/node/timers.ts";
import { isFunction } from "./index.ts";
import { nil } from "./interfaces.ts";
import { StreamImpl } from "./stream-impl.ts";
import { ValueGeneratorPush } from "./value-generator.ts";

export default <R>(promise: Promise<R>) => {
  let isNilScheduled: boolean = false;
  return new StreamImpl(
    (
      push: ValueGeneratorPush<R>,
    ) => {
      // We need to push asynchronously so that errors thrown from handling
      // these values are not caught by the promise. Also, return null so
      // that bluebird-based promises don't complain about handlers being
      // created but not returned. See
      // https://github.com/caolan/highland/issues/588.
      const nextPromise = promise.then((value) => {
        isNilScheduled = true;
        setImmediate(() => {
          push(null, value);
          push(null, nil);
        });
        return null;
      }, (err) => {
        isNilScheduled = true;
        setImmediate(() => {
          push(err);
          push(null, nil);
        });
        return null;
      });

      // Using finally also handles bluebird promise cancellation, so we do
      // it if we can.
      if (isFunction(nextPromise["finally"])) { // eslint-disable-line dot-notation
        nextPromise["finally"](() => { // eslint-disable-line dot-notation
          isNilScheduled || setImmediate(() => push(null, nil));
          return null;
        });
      }
    },
  );
};
