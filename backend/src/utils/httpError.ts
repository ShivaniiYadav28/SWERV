export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public expose = false,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}
