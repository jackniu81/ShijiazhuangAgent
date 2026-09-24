import { NestFactory } from '@nestjs/core';
import { existsSync } from 'fs';
import { join } from 'path';
import express from 'express';
import type { Request, Response } from 'express';
import { AppModule } from './app.module';

const clientDist = join(__dirname, '..', '..', 'client', 'dist');
const indexHtml = join(clientDist, 'index.html');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // All API endpoints live under /api
  app.setGlobalPrefix('api');
  app.enableCors();

  // Finalize Nest's routes first, then attach static hosting + SPA fallback
  // AFTER them, so /api is always matched by the API and never shadowed.
  await app.init();

  const server = app.getHttpAdapter().getInstance();
  if (existsSync(indexHtml)) {
    server.use(express.static(clientDist));
    // Deep links (e.g. a refresh on /about) -> serve the SPA shell
    server.get(/^(?!\/api).*/, (_req: Request, res: Response) => {
      res.sendFile(indexHtml);
    });
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🚀 Server ready at http://localhost:${port}`);
}
bootstrap();
