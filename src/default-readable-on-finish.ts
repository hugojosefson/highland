import Readable from "https://deno.land/std@0.91.0/node/_stream/readable.ts";
import { GenericFunction } from "https://deno.land/std@0.91.0/node/events.ts";

export default (
  readable: Readable,
  callback: GenericFunction,
) => {
  // It's possible that `close` is emitted *before* `end`, so we simply
  // cannot handle that case. See
  // https://github.com/caolan/highland/issues/490 for details.

  // pipe already pushes on end, so no need to bind to `end`.

  /** write any errors into the stream */
  readable.once("error", callback);

  return () => {
    readable.removeListener("error", callback);
  };
};
