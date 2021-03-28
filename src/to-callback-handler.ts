import { nil } from "./interfaces.ts";

/**
 *
 * @id toCallbackHandler
 * @param {string} transformName Description to compose user-friendly error messages
 * @param {function} cb Node.js style callback
 * @return {function} Function passed to .consume
 * @private
 */
export default <R>(
  transformName: string,
  cb: (err?: Error | null, value?: R) => void,
) => {
  let value: R | undefined;
  let hasValue = false; // In case an emitted value === null or === undefined.
  return (err?: Error, x, push, next) => {
    if (err) {
      push(null, nil);
      if (hasValue) {
        cb(
          new Error(
            transformName + " called on stream emitting multiple values",
          ),
        );
      } else {
        cb(err);
      }
    } else if (x === nil) {
      if (hasValue) {
        cb(null, value);
      } else {
        cb();
      }
    } else {
      if (hasValue) {
        push(null, nil);
        cb(
          new Error(
            transformName + " called on stream emitting multiple values",
          ),
        );
      } else {
        value = x;
        hasValue = true;
        next();
      }
    }
  };
};
