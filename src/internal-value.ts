import { Nil } from "./interfaces.ts";
import { StreamError } from "./stream-error.ts";
import { StreamRedirect } from "./stream-redirect.ts";

export type InternalValue<R> = R | Nil | StreamError | StreamRedirect<R>;
