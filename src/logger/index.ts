import { pino } from 'pino';

export class Logger {
  readonly logger: pino.Logger;

  readonly loggerOptions: pino.LoggerOptions = {
    base: undefined,
  };

  constructor() {
    this.logger = pino(this.loggerOptions);
  }

  fatal(obj: any, msg?: string | undefined, ...args: any[]): void {
    this.logger.fatal(obj, msg, args);
  }

  error(obj: any, msg?: string | undefined, ...args: any[]): void {
    this.logger.error(obj, msg, args);
  }

  warn(obj: any, msg?: string | undefined, ...args: any[]): void {
    this.logger.warn(obj, msg, args);
  }

  info(obj: any, msg?: string | undefined, ...args: any[]): void {
    this.logger.info(obj, msg, args);
  }

  debug(obj: any, msg?: string | undefined, ...args: any[]): void {
    this.logger.debug(obj, msg, args);
  }
}
