import { MappingHint } from "./interfaces.ts";

export default (mappingHint: MappingHint | any) => {
  const mappingHintType = (typeof mappingHint);

  if (mappingHintType === "function") {
    return mappingHint;
  }

  if (mappingHintType === "number") {
    return (...args: Array<any>) => args.slice(0, mappingHint);
  }

  if (Array.isArray(mappingHint)) {
    return function (...args: Array<any>) {
      return mappingHint.reduce((ctx, hint, idx) => {
        ctx[hint] = args[idx];
        return ctx;
      }, {});
    };
  }

  return (x: any) => x;
};
