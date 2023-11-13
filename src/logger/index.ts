import { pino } from 'pino';

export class Logger {
  readonly logger: pino.Logger;

  constructor() {
    this.logger = pino();
  }

  error(message: string, stackTrace: string): void {
    this.logger.error({ error: stackTrace }, message);
  }

  warn(message: string): void {
    this.logger.warn(message);
  }

  info(message: string): void {
    this.logger.info(message);
  }

  debug(message: string): void {
    this.logger.debug(message);
  }
}
