/** Stable, content-free error raised by the creative engine; `code` is the contract. */
export class CreativeError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "CreativeError";
  }
}
