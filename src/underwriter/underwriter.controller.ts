import { Body, Controller, Post } from '@nestjs/common';
import { UnderwriterService } from './underwriter.service';
import { LoggerService } from 'src/logger/logger.service';

export interface EnableUnderwritingRequest {
    chainIds?: string[];
};

export interface DisableUnderwritingRequest {
    chainIds?: string[];
}

@Controller()
export class UnderwriterController {
    constructor(
        private readonly underwriterService: UnderwriterService,
        private readonly loggerService: LoggerService,
    ) {}

    @Post('enableUnderwriting')
    async enableUnderwriting(@Body() request: EnableUnderwritingRequest) {
        //TODO validate request object
        this.loggerService.info(
            { request },
            `'enableUnderwriting' order received.`
        );
        await this.underwriterService.enableUnderwriting(request);
    }

    @Post('disableUnderwriting')
    async disableUnderwriting(@Body() request: DisableUnderwritingRequest) {
        //TODO validate request object
        this.loggerService.info(
            { request },
            `'disableUnderwriting' order received.`
        );
        await this.underwriterService.disableUnderwriting(request);
    }
}
