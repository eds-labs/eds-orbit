/** Stable, content-free error raised by the creative engine; `code` is the contract. */
export class CreativeError extends Error {
  code: string;
  // A plain field instead of a parameter property, so Node's type stripping
  // can run the engine directly (scripts/creative-demo.ts).
  constructor(code: string) {
    super(code);
    this.code = code;
    this.name = "CreativeError";
  }
}
