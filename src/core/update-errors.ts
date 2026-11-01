/**
 * A cli self-update failure with a reason code: the English message stays for the log / `4pm update`
 * output, and the code goes to the server so the web / admin "Update" modal shows translated text.
 * @adr 0305
 */
import type { CliUpdateErrorCode } from "@4pm/dto";
import { ReleaseLoadError } from "./update-load-check";

/** An update failure the cli can name. */
export class CliUpdateFailure extends Error {
  /** Build a failure with its code; `cause` keeps the underlying error. */
  constructor(
    readonly code: CliUpdateErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CliUpdateFailure";
  }
}

/** The code of any error thrown by an update attempt (`unknown` for one the cli did not name). */
export function cliUpdateErrorCode(err: unknown): CliUpdateErrorCode {
  if (err instanceof CliUpdateFailure) return err.code;
  if (err instanceof ReleaseLoadError) return "loadFailed";
  return "unknown";
}
