import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from './config/config.service';
import { LoggerService } from './logger/logger.service';

async function logLoadedOptions(
    configService: ConfigService,
    loggerService: LoggerService,
) {
    // Log the loaded configuration
    loggerService.info(
        {
            mode: configService.nodeEnv,
            globalConfig: configService.globalConfig,
            ambsConfig: Object.fromEntries(configService.ambsConfig),
            chainsConfig: Object.fromEntries(configService.chainsConfig),
            endpointsConfig: Object.fromEntries(configService.endpointsConfig)
        },
        `Underwriter initialized.`,
    );
}

async function bootstrap() {
    const app = await NestFactory.create(AppModule);

    const configService = app.get(ConfigService);
    const loggerService = app.get(LoggerService);

    await logLoadedOptions(configService, loggerService);

    await app.listen(configService.globalConfig.port);
}

void bootstrap();
