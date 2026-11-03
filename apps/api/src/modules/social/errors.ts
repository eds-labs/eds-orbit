import { DomainError } from "../../shared.ts";

/**
 * A social error with a detail object the client needs to act on (the
 * suggested time of a gap, the issues of each account). The server's error
 * handler sends it as `{ error: { code, message, detail } }`.
 */
export class SocialDetailError extends DomainError {
  constructor(
    code: string,
    status: number,
    readonly detail: Record<string, unknown>,
  ) {
    super(code, status);
  }
}
