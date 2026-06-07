import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });
  app.use(helmet({ crossOriginResourcePolicy: false }));
  app.enableCors({ origin: true, allowedHeaders: '*', methods: '*' });
  const port = Number(process.env.PORT || 8787);
  await app.listen(port, '0.0.0.0');
  new Logger('Budgent').log(`REST + Policy backend listening on http://localhost:${port}`);
}
bootstrap();
