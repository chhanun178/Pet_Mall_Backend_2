import { existsSync } from 'node:fs';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createObserveModule } from '@nestjs/observe';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module.js';

function createApp() {
  const appKey = process.env.OBSERVE_APP_KEY?.trim();
  const appSecret = process.env.OBSERVE_APP_SECRET?.trim();
  if (!appKey || !appSecret) return NestFactory.create(AppModule);

  const { ObserveModule, ObserveInstrument } = createObserveModule();
  return NestFactory.create(
    {
      module: AppModule,
      imports: [ObserveModule.forRoot({ appKey, appSecret, serviceId: 'pet_mall_backend' })],
    },
    { instrument: ObserveInstrument },
  );
}

async function bootstrap() {
  if (existsSync('.env')) {
    process.loadEnvFile('.env');
  }

  const app = await createApp();

  app.use(helmet());
  app.use(cookieParser());
  app.enableCors({
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(process.env.PORT ?? 4000);
}
await bootstrap();
