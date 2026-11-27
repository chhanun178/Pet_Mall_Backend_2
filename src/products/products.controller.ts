import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request } from 'express';
import type { AccessTokenPayload } from '../auth/auth.types.js';
import {
  RequireActiveVendor,
  Roles,
} from '../auth/decorators/roles.decorator.js';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import {
  ProductDto,
  ProductQueryDto,
  ProductStatusDto,
  UpdateProductDto,
} from './product.dto.js';
import {
  PRODUCT_IMAGE_LIMIT,
  type ProductImage,
} from './product-storage.service.js';
import { ProductsService } from './products.service.js';

type VendorRequest = Request & { user: AccessTokenPayload };
const ProductImageInterceptor = FileInterceptor('image', {
  limits: {
    fileSize: PRODUCT_IMAGE_LIMIT,
    files: 1,
    fields: 10,
    fieldSize: 20_000,
  },
});

@Controller('api/v1/vendor/products')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('VENDOR')
@RequireActiveVendor()
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  list(@Req() request: VendorRequest, @Query() query: ProductQueryDto) {
    return this.products.list(request.user.sub, query);
  }

  @Get(':id')
  get(@Req() request: VendorRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.products.get(request.user.sub, id);
  }

  @Post()
  @UseInterceptors(ProductImageInterceptor)
  create(
    @Req() request: VendorRequest,
    @Body() body: ProductDto,
    @UploadedFile() image?: ProductImage,
  ) {
    return this.products.create(request.user.sub, body, image);
  }

  @Put(':id')
  @UseInterceptors(ProductImageInterceptor)
  update(
    @Req() request: VendorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateProductDto,
    @UploadedFile() image?: ProductImage,
  ) {
    return this.products.update(request.user.sub, id, body, image);
  }

  @Patch(':id/status')
  setStatus(
    @Req() request: VendorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ProductStatusDto,
  ) {
    return this.products.setStatus(request.user.sub, id, body.isActive);
  }

  @Post(':id/duplicate')
  duplicate(
    @Req() request: VendorRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.duplicate(request.user.sub, id);
  }

  @Delete(':id')
  @HttpCode(204)
  delete(
    @Req() request: VendorRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.products.delete(request.user.sub, id);
  }
}
