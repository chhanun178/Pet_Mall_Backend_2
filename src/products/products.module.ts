import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ProductStorageService } from './product-storage.service.js';
import { ProductsController } from './products.controller.js';
import { ProductsService } from './products.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ProductsController],
  providers: [ProductsService, ProductStorageService],
})
export class ProductsModule {}
