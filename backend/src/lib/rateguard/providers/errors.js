export class RateDataError extends Error {
  constructor(message, retry = true) { super(message); this.retry = retry; }
}
