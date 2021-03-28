import { isUndefined } from "./index.ts";
import { nil } from "./interfaces.ts";
import { StreamImpl } from "./stream-impl.ts";
import { ValueGeneratorNext, ValueGeneratorPush } from "./value-generator.ts";

export default <R>(it: Iterator<R>) => {
  return new StreamImpl(
    (push: ValueGeneratorPush<R>, next: ValueGeneratorNext<R>) => {
      let iterElem: IteratorResult<R>;
      try {
        iterElem = it.next();
      } catch (err) {
        push(err);
        push(null, nil);
        return;
      }

      if (iterElem.done) {
        if (!isUndefined(iterElem.value)) {
          // generators can return a final
          // value on completion using return
          // keyword otherwise value will be
          // undefined
          push(null, iterElem.value);
        }
        push(null, nil);
        return;
      }

      push(null, iterElem.value);
      next();
    },
  );
};
